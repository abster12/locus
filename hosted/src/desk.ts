import { SHELVES, tagsForShelf, type ShelfKey } from "../../core/categories.ts";
import {
  MAX_BODY,
  MAX_HANDLE,
  MAX_MEDIA,
  MAX_TITLE,
  MAX_URL,
  RejectedPayload,
  inferHandleFromUrl,
  sanitizeItemDraft,
  sanitizeText,
  sanitizeUrl,
} from "../../core/sanitize.ts";
import { dateLabel, isItemStatus } from "../../core/types.ts";

export class MissingResource extends Error {
  readonly code = "not-found";

  constructor(resource: string) {
    super(`${resource} not found`);
    this.name = "MissingResource";
  }
}

const ALLOWED_FIELDS = new Set([
  "url",
  "title",
  "body",
  "authorName",
  "publishedAt",
  "media",
  "tagIds",
  "collectionIds",
  "newTags",
]);
const MAX_INTAKE_TAGS = 12;
const MAX_INTAKE_COLLECTIONS = 5;

export type ItemCard = {
  id: string;
  contentType: string;
  title: string | null;
  body: string | null;
  url: string;
  authorName: string | null;
  authorHandle: string | null;
  publishedAt: string | null;
  sourceSavedAt: string | null;
  firstObservedAt: string;
  capturedAt: string | null;
  media: { kind: string; url: string }[];
  source: string | null;
  status: string;
  snoozedUntil: string | null;
  tags: { id: string; name: string; color: string | null }[];
  collections: { id: string; name: string }[];
  notes: { id: string; body: string; createdAt: string }[];
  dateLabel: ReturnType<typeof dateLabel>;
  intakeActor: "user" | "agent" | null;
  classifications: { tagId: string; rationale: string; evidence: { field: string; text: string }[] }[];
};

export type ItemListFilter = {
  view?: "recent" | "inbox";
  source?: string;
  q?: string;
  collectionId?: string;
  shelf?: string;
};

export type ItemListCounts = {
  total: number;
  inbox: number;
  shelves: Record<string, number>;
};

type ItemRow = {
  id: string;
  content_type: string;
  title: string | null;
  body: string | null;
  url: string;
  author_name: string | null;
  author_handle: string | null;
  published_at: string | null;
  source_saved_at: string | null;
  first_observed_at: string;
  captured_at: string | null;
  media: string;
  status: string | null;
  snoozed_until: string | null;
  intake_actor: string | null;
  source: string | null;
};

type Cursor = { publishedAt: string; firstObservedAt: string; id: string };

export type Org = {
  collections: { id: string; name: string; description: string | null }[];
  tags: { id: string | null; name: string }[];
};

const ITEM_SELECT = `
  SELECT i.id, i.content_type, i.title, i.body, i.url, i.author_name, i.author_handle,
         i.published_at, i.source_saved_at, i.first_observed_at, i.captured_at, i.media,
         COALESCE(s.status, 'inbox') AS status, s.snoozed_until,
         (SELECT n.actor FROM item_intake n WHERE n.item_id = i.id) AS intake_actor,
         (SELECT a.source FROM source_records r JOIN source_accounts a ON a.id = r.source_account_id
           WHERE r.item_id = i.id LIMIT 1) AS source
    FROM items i
    LEFT JOIN item_state s ON s.item_id = i.id
`;

export function nowIso(now = new Date()): string {
  return now.toISOString();
}

export async function previewIntake(
  db: D1Database,
  libraryId: string,
  input: unknown,
  now = nowIso(),
): Promise<{
  item: {
    url: string;
    title: string | null;
    body: string | null;
    authorName: string | null;
    publishedAt: string | null;
    media: { kind: string; url: string }[];
  };
  missing: string[];
  collections: { id: string; name: string; description: string | null }[];
  tags: { id: string | null; name: string }[];
}> {
  const { rec, draft } = parseSource(input, now);
  const org = await resolveOrg(db, libraryId, rec, false);
  const missing: string[] = [];
  if (!draft.title) missing.push("title");
  if (!draft.body) missing.push("source text");
  if (!draft.authorName) missing.push("author");
  if (!draft.publishedAt) missing.push("publication date");
  if (draft.media.length === 0) missing.push("media");
  return {
    item: {
      url: draft.url,
      title: draft.title ?? null,
      body: draft.body ?? null,
      authorName: draft.authorName ?? null,
      publishedAt: draft.publishedAt ?? null,
      media: draft.media,
    },
    missing,
    collections: org.collections,
    tags: org.tags,
  };
}

export async function commitIntake(
  db: D1Database,
  libraryId: string,
  input: unknown,
  now = nowIso(),
): Promise<{ item: ItemCard; outcome: "created" | "reused" }> {
  const { rec, draft } = parseSource(input, now);
  const org = await resolveOrg(db, libraryId, rec, true);
  const existingId = await findExistingItemId(db, libraryId, draft.url);
  let itemId: string;
  let outcome: "created" | "reused";
  if (existingId) {
    itemId = existingId;
    outcome = "reused";
  } else {
    const created = await insertItem(db, libraryId, draft, now);
    itemId = created.id;
    outcome = created.outcome;
  }
  await applyMemberships(db, itemId, org, now, "user");
  const item = await getLibraryItem(db, libraryId, itemId);
  if (!item) throw new RejectedPayload("intake item was not persisted");
  return { item, outcome };
}

export async function getLibraryItem(db: D1Database, libraryId: string, id: string): Promise<ItemCard | null> {
  const row = await first<ItemRow>(
    db,
    `${ITEM_SELECT} WHERE i.id = ? AND i.library_id = ?`,
    id,
    libraryId,
  );
  return row ? hydrate(db, row) : null;
}

/** Load many Item cards in a few queries. Atlas/Kitchen projections cannot call getLibraryItem per row. */
export async function getLibraryItems(
  db: D1Database,
  libraryId: string,
  ids: string[],
): Promise<Map<string, ItemCard>> {
  const unique = [...new Set(ids.filter(Boolean))];
  const out = new Map<string, ItemCard>();
  if (unique.length === 0) return out;
  const rows: ItemRow[] = [];
  for (const chunk of chunkIds(unique, 40)) {
    rows.push(
      ...(await all<ItemRow>(
        db,
        `${ITEM_SELECT} WHERE i.library_id = ? AND i.id IN (${chunk.map(() => "?").join(",")})`,
        libraryId,
        ...chunk,
      )),
    );
  }
  const tags = await loadTagsForItems(db, unique);
  for (const row of rows) {
    out.set(row.id, itemCardFrom(row, tags.get(row.id) ?? [], [], [], []));
  }
  return out;
}

export async function listItemsPage(
  db: D1Database,
  libraryId: string,
  filter: ItemListFilter,
  options: { cursor?: string; limit?: number } = {},
): Promise<{ items: ItemCard[]; nextCursor: string | null; counts: ItemListCounts }> {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const matched = matchingWhere(libraryId, filter);
  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    matched.where.push(`(
      COALESCE(i.published_at, '') < ?
      OR (COALESCE(i.published_at, '') = ? AND i.first_observed_at < ?)
      OR (COALESCE(i.published_at, '') = ? AND i.first_observed_at = ? AND i.id < ?)
    )`);
    matched.params.push(
      cursor.publishedAt,
      cursor.publishedAt,
      cursor.firstObservedAt,
      cursor.publishedAt,
      cursor.firstObservedAt,
      cursor.id,
    );
  }
  const rows = await all<ItemRow>(
    db,
    `${ITEM_SELECT} WHERE ${matched.where.join(" AND ")}
      ORDER BY COALESCE(i.published_at, '') DESC, i.first_observed_at DESC, i.id DESC
      LIMIT ?`,
    ...matched.params,
    limit + 1,
  );
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: await Promise.all(pageRows.map((row) => hydrate(db, row))),
    nextCursor:
      rows.length > limit && last
        ? encodeCursor({
            publishedAt: last.published_at ?? "",
            firstObservedAt: last.first_observed_at,
            id: last.id,
          })
        : null,
    counts: await itemCounts(db, libraryId, filter),
  };
}

export async function itemCounts(
  db: D1Database,
  libraryId: string,
  filter: ItemListFilter = {},
): Promise<ItemListCounts> {
  const selected = filter.shelf && isShelfKey(filter.shelf) ? shelfCondition(filter.shelf) : null;
  const shelves: Record<string, number> = {};
  for (const shelf of SHELVES) {
    const condition = shelfCondition(shelf.key);
    shelves[shelf.key] = await countMatching(db, libraryId, filter, condition.sql, condition.params);
  }
  return {
    total: selected
      ? await countMatching(db, libraryId, filter, selected.sql, selected.params)
      : await countMatching(db, libraryId, filter),
    inbox: selected
      ? await countMatching(db, libraryId, { ...filter, view: "inbox" }, selected.sql, selected.params)
      : await countMatching(db, libraryId, { ...filter, view: "inbox" }),
    shelves,
  };
}

export async function listLibraryOrg(
  db: D1Database,
  libraryId: string,
): Promise<{
  collections: { id: string; name: string; description: string | null; count: number }[];
  tags: { id: string; name: string }[];
}> {
  const collections = await all<{
    id: string;
    name: string;
    description: string | null;
    count: number;
  }>(
    db,
    `SELECT c.id, c.name, c.description,
            (SELECT COUNT(*) FROM memberships m
               JOIN items i ON i.id = m.item_id
              WHERE m.target_id = c.id AND m.target_kind = 'collection' AND i.library_id = c.library_id) AS count
       FROM collections c
      WHERE c.library_id = ?
      ORDER BY c.name`,
    libraryId,
  );
  const tags = await all<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM tags WHERE library_id = ? ORDER BY name`,
    libraryId,
  );
  return { collections, tags };
}

export async function setItemStatus(
  db: D1Database,
  libraryId: string,
  itemId: string,
  input: unknown,
  now = nowIso(),
): Promise<{ item: ItemCard }> {
  const rec = record(input, new Set(["status", "snoozedUntil"]));
  const status = typeof rec.status === "string" ? rec.status : "";
  if (!isItemStatus(status)) throw new RejectedPayload("invalid status");
  const snoozedUntil = optionalString(rec.snoozedUntil, "snoozedUntil", 64);
  const until = status === "snoozed" ? (snoozedUntil ?? new Date(Date.now() + 86400000).toISOString()) : null;
  await requireLibraryItem(db, libraryId, itemId);
  await db
    .prepare(
      `INSERT INTO item_state (item_id, status, snoozed_until, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET status = excluded.status, snoozed_until = excluded.snoozed_until, updated_at = excluded.updated_at`,
    )
    .bind(itemId, status, until, now)
    .run();
  return { item: await loadedItem(db, libraryId, itemId) };
}

export async function addItemTag(
  db: D1Database,
  libraryId: string,
  itemId: string,
  input: unknown,
  now = nowIso(),
): Promise<{ tag: { id: string; name: string }; item: ItemCard }> {
  const rec = record(input, new Set(["name", "color"]));
  const name = typeof rec.name === "string" ? rec.name : "";
  const color = optionalString(rec.color, "color", 40);
  await requireLibraryItem(db, libraryId, itemId);
  const tag = await ensureTag(db, libraryId, name, color);
  await db
    .prepare(
      `INSERT OR IGNORE INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES (?, ?, 'tag', 'user', ?)`,
    )
    .bind(itemId, tag.id, now)
    .run();
  return { tag, item: await loadedItem(db, libraryId, itemId) };
}

export async function removeItemTag(
  db: D1Database,
  libraryId: string,
  itemId: string,
  input: unknown,
): Promise<{ item: ItemCard }> {
  const rec = record(input, new Set(["tagId"]));
  const tagId = requiredId(rec.tagId, "tagId");
  await requireLibraryItem(db, libraryId, itemId);
  await requireLibraryTag(db, libraryId, tagId);
  await db
    .prepare(`DELETE FROM memberships WHERE item_id = ? AND target_id = ? AND target_kind = 'tag'`)
    .bind(itemId, tagId)
    .run();
  return { item: await loadedItem(db, libraryId, itemId) };
}

export async function addItemNote(
  db: D1Database,
  libraryId: string,
  itemId: string,
  input: unknown,
  now = nowIso(),
): Promise<{ item: ItemCard }> {
  const rec = record(input, new Set(["body"]));
  const body = typeof rec.body === "string" ? rec.body : "";
  const clean = sanitizeText(body, 4000);
  if (!clean) throw new RejectedPayload("note body required");
  await requireLibraryItem(db, libraryId, itemId);
  await db
    .prepare(
      `INSERT INTO notes (id, library_id, item_id, body, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .bind(crypto.randomUUID(), libraryId, itemId, clean, now, now)
    .run();
  return { item: await loadedItem(db, libraryId, itemId) };
}

export async function addItemToCollection(
  db: D1Database,
  libraryId: string,
  itemId: string,
  input: unknown,
  now = nowIso(),
): Promise<{ item: ItemCard }> {
  const rec = record(input, new Set(["collectionId"]));
  const collectionId = requiredId(rec.collectionId, "collectionId");
  await requireLibraryItem(db, libraryId, itemId);
  await requireLibraryCollection(db, libraryId, collectionId);
  await db
    .prepare(
      `INSERT OR IGNORE INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES (?, ?, 'collection', 'user', ?)`,
    )
    .bind(itemId, collectionId, now)
    .run();
  return { item: await loadedItem(db, libraryId, itemId) };
}

export async function removeItemFromCollection(
  db: D1Database,
  libraryId: string,
  itemId: string,
  input: unknown,
): Promise<{ item: ItemCard }> {
  const rec = record(input, new Set(["collectionId"]));
  const collectionId = requiredId(rec.collectionId, "collectionId");
  await requireLibraryItem(db, libraryId, itemId);
  await requireLibraryCollection(db, libraryId, collectionId);
  await db
    .prepare(`DELETE FROM memberships WHERE item_id = ? AND target_id = ? AND target_kind = 'collection'`)
    .bind(itemId, collectionId)
    .run();
  return { item: await loadedItem(db, libraryId, itemId) };
}

export async function createLibraryCollection(
  db: D1Database,
  libraryId: string,
  input: unknown,
  now = nowIso(),
): Promise<{
  collection: { id: string; name: string };
  collections: { id: string; name: string; description: string | null; count: number }[];
}> {
  const rec = record(input, new Set(["name", "description"]));
  const name = typeof rec.name === "string" ? rec.name : "";
  const clean = sanitizeText(name, 80);
  if (!clean) throw new RejectedPayload("collection name required");
  const descriptionRaw = optionalString(rec.description, "description", 400);
  const description = descriptionRaw ? sanitizeText(descriptionRaw, 400) || null : null;
  const id = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO collections (id, library_id, name, description, created_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(id, libraryId, clean, description, now)
    .run();
  const org = await listLibraryOrg(db, libraryId);
  return { collection: { id, name: clean }, collections: org.collections };
}

async function loadedItem(db: D1Database, libraryId: string, itemId: string): Promise<ItemCard> {
  const item = await getLibraryItem(db, libraryId, itemId);
  if (!item) throw new MissingResource("item");
  return item;
}

async function requireLibraryItem(db: D1Database, libraryId: string, itemId: string): Promise<void> {
  const row = await first<{ ok: number }>(db, `SELECT 1 AS ok FROM items WHERE id = ? AND library_id = ?`, itemId, libraryId);
  if (!row) throw new MissingResource("item");
}

async function requireLibraryTag(db: D1Database, libraryId: string, tagId: string): Promise<void> {
  const row = await first<{ ok: number }>(db, `SELECT 1 AS ok FROM tags WHERE id = ? AND library_id = ?`, tagId, libraryId);
  if (!row) throw new MissingResource("tag");
}

async function requireLibraryCollection(db: D1Database, libraryId: string, collectionId: string): Promise<void> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM collections WHERE id = ? AND library_id = ?`,
    collectionId,
    libraryId,
  );
  if (!row) throw new MissingResource("collection");
}

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string") throw new RejectedPayload(`${field} is required`);
  const id = value.trim();
  if (!id || id.length > 80) throw new RejectedPayload(`${field} is invalid`);
  return id;
}

export async function insertItem(
  db: D1Database,
  libraryId: string,
  draft: ReturnType<typeof sanitizeItemDraft>,
  now: string,
  intake: { actor: "user" | "agent"; observedJson: string } = { actor: "user", observedJson: "[]" },
): Promise<{ id: string; outcome: "created" | "reused" }> {
  const itemId = crypto.randomUUID();
  const activityId = crypto.randomUUID();
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO items (
            id, library_id, content_type, title, body, url, author_name, author_handle, published_at, source_saved_at,
            first_observed_at, captured_at, media, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          itemId,
          libraryId,
          draft.contentType,
          draft.title ?? null,
          draft.body ?? null,
          draft.url,
          draft.authorName ?? null,
          draft.authorHandle ?? null,
          draft.publishedAt ?? null,
          null,
          now,
          null,
          JSON.stringify(draft.media ?? []),
          now,
          now,
        ),
      db.prepare(`INSERT INTO item_state (item_id, status, snoozed_until, updated_at) VALUES (?, 'inbox', NULL, ?)`).bind(
        itemId,
        now,
      ),
      db
        .prepare(
          `INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source, capture_run_id)
           VALUES (?, ?, 'added', ?, 'locus', NULL)`,
        )
        .bind(activityId, itemId, now),
      db
        .prepare(
          `INSERT INTO item_intake (item_id, library_id, actor, created_at, observed_json) VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(itemId, libraryId, intake.actor, now, intake.observedJson),
    ]);
    return { id: itemId, outcome: "created" };
  } catch {
    const existing = await findExistingItemId(db, libraryId, draft.url);
    if (existing) return { id: existing, outcome: "reused" };
    throw new Error("Could not save Item");
  }
}

export async function findExistingItemId(db: D1Database, libraryId: string, url: string): Promise<string | null> {
  const row = await first<{ id: string }>(db, `SELECT id FROM items WHERE library_id = ? AND url = ?`, libraryId, url);
  return row?.id ?? null;
}

async function hydrate(db: D1Database, row: ItemRow): Promise<ItemCard> {
  const [tags, collections, notes] = await Promise.all([
    all<{ id: string; name: string; color: string | null }>(
      db,
      `SELECT t.id, t.name, t.color FROM memberships m JOIN tags t ON t.id = m.target_id
        WHERE m.item_id = ? AND m.target_kind = 'tag' ORDER BY t.name`,
      row.id,
    ),
    all<{ id: string; name: string }>(
      db,
      `SELECT c.id, c.name FROM memberships m JOIN collections c ON c.id = m.target_id
        WHERE m.item_id = ? AND m.target_kind = 'collection' ORDER BY c.name`,
      row.id,
    ),
    all<{ id: string; body: string; createdAt: string }>(
      db,
      `SELECT id, body, created_at AS createdAt FROM notes WHERE item_id = ? ORDER BY created_at`,
      row.id,
    ),
  ]);
  return itemCardFrom(row, tags, collections, notes, await loadClassifications(db, row.id));
}

function itemCardFrom(
  row: ItemRow,
  tags: { id: string; name: string; color: string | null }[],
  collections: { id: string; name: string }[],
  notes: { id: string; body: string; createdAt: string }[],
  classifications: ItemCard["classifications"],
): ItemCard {
  const item = {
    sourceSavedAt: row.source_saved_at,
    firstObservedAt: row.first_observed_at,
    capturedAt: row.captured_at,
    publishedAt: row.published_at,
  };
  return {
    id: row.id,
    contentType: row.content_type,
    title: row.title,
    body: row.body,
    url: row.url,
    authorName: row.author_name,
    authorHandle: row.author_handle || inferHandleFromUrl(row.url) || null,
    publishedAt: row.published_at,
    sourceSavedAt: row.source_saved_at,
    firstObservedAt: row.first_observed_at,
    capturedAt: row.captured_at,
    media: parseMedia(row.media),
    source: row.source,
    status: row.status ?? "inbox",
    snoozedUntil: row.snoozed_until,
    tags,
    collections,
    notes,
    dateLabel: dateLabel(item),
    intakeActor: row.intake_actor === "user" || row.intake_actor === "agent" ? row.intake_actor : null,
    classifications,
  };
}

async function loadTagsForItems(
  db: D1Database,
  ids: string[],
): Promise<Map<string, { id: string; name: string; color: string | null }[]>> {
  const out = new Map<string, { id: string; name: string; color: string | null }[]>();
  for (const id of ids) out.set(id, []);
  for (const chunk of chunkIds(ids, 40)) {
    const rows = await all<{ item_id: string; id: string; name: string; color: string | null }>(
      db,
      `SELECT m.item_id, t.id, t.name, t.color FROM memberships m JOIN tags t ON t.id = m.target_id
        WHERE m.target_kind = 'tag' AND m.item_id IN (${chunk.map(() => "?").join(",")})
        ORDER BY t.name`,
      ...chunk,
    );
    for (const row of rows) {
      const list = out.get(row.item_id);
      if (list) list.push({ id: row.id, name: row.name, color: row.color });
    }
  }
  return out;
}

function chunkIds(ids: string[], size: number): string[][] {
  const out: string[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

async function loadClassifications(
  db: D1Database,
  itemId: string,
): Promise<ItemCard["classifications"]> {
  const rows = await all<{ tag_id: string; rationale: string; evidence_json: string }>(
    db,
    `SELECT tag_id, rationale, evidence_json FROM intake_tag_evidence WHERE item_id = ? ORDER BY tag_id`,
    itemId,
  );
  return rows.map((row) => ({
    tagId: row.tag_id,
    rationale: row.rationale,
    evidence: parseEvidenceJson(row.evidence_json),
  }));
}

function parseEvidenceJson(raw: string): ItemCard["classifications"][number]["evidence"] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const rec = entry as { field?: unknown; text?: unknown };
      if (typeof rec.field !== "string" || typeof rec.text !== "string") return [];
      return [{ field: rec.field, text: rec.text }];
    });
  } catch {
    return [];
  }
}

function matchingWhere(libraryId: string, filter: ItemListFilter, includeShelf = true): { where: string[]; params: unknown[] } {
  const where = ["i.library_id = ?"];
  const params: unknown[] = [libraryId];
  if (filter.view === "inbox") {
    where.push(`COALESCE(s.status, 'inbox') = 'inbox'`);
  } else {
    where.push(`COALESCE(s.status, 'inbox') NOT IN ('archived', 'rejected')`);
  }
  if (filter.source === "you") {
    where.push(`EXISTS (SELECT 1 FROM item_intake n WHERE n.item_id = i.id AND n.actor = 'user')`);
  } else if (filter.source) {
    where.push(`EXISTS (
      SELECT 1 FROM source_records r JOIN source_accounts a ON a.id = r.source_account_id
      WHERE r.item_id = i.id AND a.source = ?
    )`);
    params.push(filter.source);
  }
  if (filter.collectionId) {
    where.push(
      `EXISTS (SELECT 1 FROM memberships m WHERE m.item_id = i.id AND m.target_kind = 'collection' AND m.target_id = ?)`,
    );
    params.push(filter.collectionId);
  }
  if (filter.q && filter.q.trim()) {
    const like = `%${filter.q.trim()}%`;
    where.push(`(
      i.title LIKE ? OR i.body LIKE ? OR i.author_name LIKE ? OR i.author_handle LIKE ?
      OR EXISTS (SELECT 1 FROM notes n WHERE n.item_id = i.id AND n.body LIKE ?)
      OR EXISTS (SELECT 1 FROM memberships m JOIN tags t ON t.id = m.target_id WHERE m.item_id = i.id AND t.name LIKE ?)
    )`);
    params.push(like, like, like, like, like, like);
  }
  if (includeShelf && filter.shelf && isShelfKey(filter.shelf)) {
    const condition = shelfCondition(filter.shelf);
    where.push(condition.sql);
    params.push(...condition.params);
  }
  return { where, params };
}

async function countMatching(
  db: D1Database,
  libraryId: string,
  filter: ItemListFilter,
  extra?: string,
  extraParams: string[] = [],
): Promise<number> {
  const matched = matchingWhere(libraryId, filter, false);
  const where = extra ? [...matched.where, extra] : matched.where;
  const row = await first<{ count: number }>(
    db,
    `SELECT COUNT(DISTINCT i.id) AS count
       FROM items i
       LEFT JOIN item_state s ON s.item_id = i.id
      WHERE ${where.join(" AND ")}`,
    ...matched.params,
    ...extraParams,
  );
  return Number(row?.count ?? 0);
}

function isShelfKey(value: string): value is ShelfKey {
  return SHELVES.some((shelf) => shelf.key === value);
}

function shelfCondition(key: ShelfKey): { sql: string; params: string[] } {
  const known = [...new Set(SHELVES.flatMap((shelf) => tagsForShelf(shelf.key)))];
  if (key === "else") {
    const marks = known.map(() => "?").join(", ");
    return {
      sql: `EXISTS (
        SELECT 1 FROM memberships mx JOIN tags tx ON tx.id = mx.target_id
        WHERE mx.item_id = i.id AND mx.target_kind = 'tag' AND lower(tx.name) NOT IN (${marks})
      )`,
      params: known,
    };
  }
  const tags = tagsForShelf(key);
  const marks = tags.map(() => "?").join(", ");
  return {
    sql: `EXISTS (
      SELECT 1 FROM memberships ms JOIN tags ts ON ts.id = ms.target_id
      WHERE ms.item_id = i.id AND ms.target_kind = 'tag' AND lower(ts.name) IN (${marks})
    )`,
    params: tags,
  };
}

function parseSource(input: unknown, now: string): {
  rec: Record<string, unknown>;
  draft: ReturnType<typeof sanitizeItemDraft>;
} {
  const rec = record(input, ALLOWED_FIELDS);
  return {
    rec,
    draft: sanitizeItemDraft({
      contentType: "link",
      url: requiredString(rec.url, "url", MAX_URL),
      title: optionalString(rec.title, "title", MAX_TITLE),
      body: optionalString(rec.body, "body", MAX_BODY),
      authorName: optionalString(rec.authorName, "authorName", MAX_HANDLE),
      publishedAt: optionalString(rec.publishedAt, "publishedAt", 40) || now.slice(0, 10),
      media: media(rec.media),
    }),
  };
}

export async function resolveOrg(
  db: D1Database,
  libraryId: string,
  rec: Record<string, unknown>,
  persist: boolean,
): Promise<Org> {
  const tagIds = idList(rec.tagIds, "tagIds", MAX_INTAKE_TAGS);
  const collectionIds = idList(rec.collectionIds, "collectionIds", MAX_INTAKE_COLLECTIONS);
  const newTags = stringList(rec.newTags, "newTags", MAX_INTAKE_TAGS);
  const collections: Org["collections"] = [];
  const seenCollections = new Set<string>();
  for (const id of collectionIds) {
    const row = await first<{ id: string; name: string; description: string | null }>(
      db,
      `SELECT id, name, description FROM collections WHERE id = ? AND library_id = ?`,
      id,
      libraryId,
    );
    if (!row) throw new RejectedPayload("unknown collection");
    if (seenCollections.has(row.id)) continue;
    seenCollections.add(row.id);
    collections.push(row);
  }
  const tags: Org["tags"] = [];
  const seenTagIds = new Set<string>();
  const seenTagNames = new Set<string>();
  for (const id of tagIds) {
    const row = await first<{ id: string; name: string }>(
      db,
      `SELECT id, name FROM tags WHERE id = ? AND library_id = ?`,
      id,
      libraryId,
    );
    if (!row) throw new RejectedPayload("unknown tag");
    if (seenTagIds.has(row.id)) continue;
    seenTagIds.add(row.id);
    seenTagNames.add(row.name.toLowerCase());
    tags.push(row);
  }
  for (const name of newTags) {
    const tag = persist ? await ensureTag(db, libraryId, name) : await peekTag(db, libraryId, name);
    if (tag.id ? seenTagIds.has(tag.id) : seenTagNames.has(tag.name.toLowerCase())) continue;
    if (tag.id) seenTagIds.add(tag.id);
    seenTagNames.add(tag.name.toLowerCase());
    tags.push(tag);
  }
  if (tags.length > MAX_INTAKE_TAGS) throw new RejectedPayload("tagIds exceeds 12");
  return { collections, tags };
}

export async function peekTag(db: D1Database, libraryId: string, name: string): Promise<{ id: string | null; name: string }> {
  const clean = sanitizeText(name, 40);
  if (!clean) throw new RejectedPayload("tag name required");
  const existing = await first<{ id: string; name: string }>(
    db,
    `SELECT id, name FROM tags WHERE library_id = ? AND name = ? COLLATE NOCASE`,
    libraryId,
    clean,
  );
  return existing ?? { id: null, name: clean };
}

export async function ensureTag(
  db: D1Database,
  libraryId: string,
  name: string,
  color?: string,
): Promise<{ id: string; name: string }> {
  const peeked = await peekTag(db, libraryId, name);
  if (peeked.id) return { id: peeked.id, name: peeked.name };
  const tag = { id: crypto.randomUUID(), name: peeked.name };
  try {
    await db
      .prepare(`INSERT INTO tags (id, library_id, name, color) VALUES (?, ?, ?, ?)`)
      .bind(tag.id, libraryId, tag.name, color ?? null)
      .run();
    return tag;
  } catch {
    const existing = await peekTag(db, libraryId, name);
    if (existing.id) return { id: existing.id, name: existing.name };
    throw new Error("Could not save tag");
  }
}

export async function applyMemberships(
  db: D1Database,
  itemId: string,
  org: Org,
  now: string,
  actor: "user" | "agent" = "user",
): Promise<{ added: { tagIds: string[]; collectionIds: string[] }; alreadyPresent: { tagIds: string[]; collectionIds: string[] } }> {
  const added = { tagIds: [] as string[], collectionIds: [] as string[] };
  const alreadyPresent = { tagIds: [] as string[], collectionIds: [] as string[] };
  for (const collection of org.collections) {
    const existing = await first<{ ok: number }>(
      db,
      `SELECT 1 AS ok FROM memberships WHERE item_id = ? AND target_id = ? AND target_kind = 'collection'`,
      itemId,
      collection.id,
    );
    if (existing) alreadyPresent.collectionIds.push(collection.id);
    else {
      await db
        .prepare(
          `INSERT OR IGNORE INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES (?, ?, 'collection', ?, ?)`,
        )
        .bind(itemId, collection.id, actor, now)
        .run();
      added.collectionIds.push(collection.id);
    }
  }
  for (const tag of org.tags) {
    if (!tag.id) throw new RejectedPayload("unknown tag");
    const existing = await first<{ ok: number }>(
      db,
      `SELECT 1 AS ok FROM memberships WHERE item_id = ? AND target_id = ? AND target_kind = 'tag'`,
      itemId,
      tag.id,
    );
    if (existing) alreadyPresent.tagIds.push(tag.id);
    else {
      await db
        .prepare(
          `INSERT OR IGNORE INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES (?, ?, 'tag', ?, ?)`,
        )
        .bind(itemId, tag.id, actor, now)
        .run();
      added.tagIds.push(tag.id);
    }
  }
  return { added, alreadyPresent };
}

function parseMedia(raw: string): { kind: string; url: string }[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.flatMap((entry) => {
      if (!entry || typeof entry !== "object") return [];
      const rec = entry as { kind?: unknown; url?: unknown };
      if (typeof rec.kind !== "string" || typeof rec.url !== "string") return [];
      return [{ kind: rec.kind, url: rec.url }];
    });
  } catch {
    return [];
  }
}

function encodeCursor(cursor: Cursor): string {
  const json = JSON.stringify(cursor);
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const pad = "=".repeat((4 - (raw.length % 4)) % 4);
    const json = atob(raw.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const value = JSON.parse(json) as Partial<Cursor>;
    if (
      typeof value.publishedAt !== "string" ||
      typeof value.firstObservedAt !== "string" ||
      typeof value.id !== "string"
    ) {
      return null;
    }
    return { publishedAt: value.publishedAt, firstObservedAt: value.firstObservedAt, id: value.id };
  } catch {
    return null;
  }
}

function record(input: unknown, allowed: Set<string>): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new RejectedPayload("invalid payload");
  const rec = input as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (!allowed.has(key)) throw new RejectedPayload(`unsupported field: ${key}`);
  }
  return rec;
}

function requiredString(value: unknown, field: string, max: number): string {
  const text = optionalString(value, field, max);
  if (!text) throw new RejectedPayload(`${field} is required`);
  return text;
}

function optionalString(value: unknown, field: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new RejectedPayload(`${field} must be a string`);
  if (value.length > max) throw new RejectedPayload(`${field} is too long`);
  assertSafeDisplay(field, value);
  return value;
}

function stringList(value: unknown, field: string, max: number): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new RejectedPayload(`${field} must be an array`);
  if (value.length > max) throw new RejectedPayload(`${field} exceeds ${max}`);
  return value.map((entry, index) => {
    if (typeof entry !== "string") throw new RejectedPayload(`${field} ${index} must be a string`);
    assertSafeDisplay(`${field} ${index}`, entry);
    return entry;
  });
}

function idList(value: unknown, field: string, max: number): string[] {
  return stringList(value, field, max).map((entry, index) => {
    const id = entry.trim();
    if (!id || id.length > 80) throw new RejectedPayload(`${field} ${index} is invalid`);
    return id;
  });
}

function media(value: unknown): { kind: string; url: string }[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) throw new RejectedPayload("media must be an array");
  if (value.length > MAX_MEDIA) throw new RejectedPayload("media exceeds 8 items");
  return value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new RejectedPayload(`media[${index}] is invalid`);
    const rec = entry as Record<string, unknown>;
    for (const key of Object.keys(rec)) {
      if (key !== "kind" && key !== "url") throw new RejectedPayload(`unsupported field: media.${key}`);
    }
    if (typeof rec.url !== "string") throw new RejectedPayload(`media[${index}].url is required`);
    if (rec.url.length > MAX_URL) throw new RejectedPayload(`media[${index}].url is too long`);
    assertSafeDisplay(`media[${index}].url`, rec.url);
    if (rec.kind !== undefined && typeof rec.kind !== "string") {
      throw new RejectedPayload(`media[${index}].kind must be a string`);
    }
    return { kind: typeof rec.kind === "string" ? rec.kind : "unknown", url: rec.url };
  });
}

function assertSafeDisplay(field: string, value: string): void {
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069]/.test(value)) {
    throw new RejectedPayload(`${field} contains control characters`);
  }
}

async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  return (await stmt.first<T>()) ?? null;
}

async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  const result = await stmt.all<T>();
  return result.results ?? [];
}
