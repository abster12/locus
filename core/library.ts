import { rmSync } from "node:fs";
import { ownedLibraryId } from "../db/library-id.ts";
import { readingAssetsRoot, type Db } from "../db/open.ts";
import { localDay } from "./dates.ts";
export { localDay } from "./dates.ts";
import { dateLabel, type DateLabel, type ItemStatus, type SourceId } from "./types.ts";
import { inferHandleFromUrl } from "./sanitize.ts";
import { excerptOf, type CitedItemV1, type DeterministicBlockV1, type SummarySnapshotV1 } from "./summaries.ts";
import { SHELVES, tagsForShelf, type ShelfKey } from "./categories.ts";

export interface ItemCard {
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
  source: SourceId | string | null;
  status: ItemStatus;
  snoozedUntil: string | null;
  tags: { id: string; name: string; color: string | null }[];
  collections: { id: string; name: string }[];
  notes: { id: string; body: string; createdAt: string }[];
  dateLabel: DateLabel;
  intakeActor?: "user" | "agent" | null;
  classifications?: { tagId: string; rationale: string; evidence: { field: string; text: string }[] }[];
}

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
  source: string | null;
  intake_actor: string | null;
};

export interface ItemListFilter {
  view?: "recent" | "inbox";
  source?: string;
  q?: string;
  collectionId?: string;
  shelf?: string;
  searchRecipeDocuments?: boolean;
  searchRecipeLibraryId?: string;
}

export interface ItemListCounts {
  total: number;
  inbox: number;
  shelves: Record<string, number>;
}

export interface ItemPage {
  items: ItemCard[];
  nextCursor: string | null;
  counts: ItemListCounts;
}

type Cursor = { sortAt: string; firstObservedAt: string; id: string };

const ITEM_SORT_AT_SQL = "COALESCE(i.published_at, i.source_saved_at, i.captured_at, i.first_observed_at)";

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function decodeCursor(raw: string | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor>;
    if (typeof value.sortAt !== "string" || typeof value.firstObservedAt !== "string" || typeof value.id !== "string") return null;
    return { sortAt: value.sortAt, firstObservedAt: value.firstObservedAt, id: value.id };
  } catch {
    return null;
  }
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

function hydrate(db: Db, row: ItemRow): ItemCard {
  const tags = db
    .prepare(
      `SELECT t.id, t.name, t.color FROM memberships m JOIN tags t ON t.id = m.target_id
       WHERE m.item_id = ? AND m.target_kind = 'tag' ORDER BY t.name`,
    )
    .all(row.id) as { id: string; name: string; color: string | null }[];
  const collections = db
    .prepare(
      `SELECT c.id, c.name FROM memberships m JOIN collections c ON c.id = m.target_id
       WHERE m.item_id = ? AND m.target_kind = 'collection' ORDER BY c.name`,
    )
    .all(row.id) as { id: string; name: string }[];
  const notes = db
    .prepare(`SELECT id, body, created_at as createdAt FROM notes WHERE item_id = ? ORDER BY created_at`)
    .all(row.id) as { id: string; body: string; createdAt: string }[];
  const evidenceRows = db
    .prepare(`SELECT tag_id, rationale, evidence_json FROM intake_tag_evidence WHERE item_id = ? ORDER BY tag_id`)
    .all(row.id) as { tag_id: string; rationale: string; evidence_json: string }[];
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
    status: (row.status ?? "inbox") as ItemStatus,
    snoozedUntil: row.snoozed_until,
    tags,
    collections,
    notes,
    dateLabel: dateLabel(item),
    intakeActor: row.intake_actor === "user" || row.intake_actor === "agent" ? row.intake_actor : null,
    classifications: evidenceRows.map((entry) => ({
      tagId: entry.tag_id,
      rationale: entry.rationale,
      evidence: JSON.parse(entry.evidence_json) as { field: string; text: string }[],
    })),
  };
}

const ITEM_SELECT = `
  SELECT i.*, COALESCE(s.status, 'inbox') AS status, s.snoozed_until,
    (SELECT a.source FROM source_records r JOIN source_accounts a ON a.id = r.source_account_id
      WHERE r.item_id = i.id LIMIT 1) AS source,
    (SELECT n.actor FROM item_intake n WHERE n.item_id = i.id) AS intake_actor
  FROM items i
  LEFT JOIN item_state s ON s.item_id = i.id
`;

type ShelfPredicate = { sql: string; params: string[] };

function isShelfKey(value: string): value is ShelfKey {
  return SHELVES.some((shelf) => shelf.key === value);
}

/** Build the SQL predicate for one shelf, shared by list filters and counts. */
function shelfCondition(key: ShelfKey): ShelfPredicate {
  const known = [...new Set(SHELVES.flatMap((s) => tagsForShelf(s.key)))];
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

function matchingWhere(filter: ItemListFilter, includeShelf = true): { where: string[]; params: string[] } {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.view === "inbox") {
    where.push(`COALESCE(s.status, 'inbox') = 'inbox'`);
  } else if (filter.view === "recent") {
    // The normal Desk is a useful working surface, not an archive. Accepted
    // saves remain visible; archived and rejected saves leave it.
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
    where.push(`EXISTS (
      SELECT 1 FROM memberships m WHERE m.item_id = i.id AND m.target_kind = 'collection' AND m.target_id = ?
    )`);
    params.push(filter.collectionId);
  }
  if (filter.q && filter.q.trim()) {
    const like = `%${filter.q.trim()}%`;
    where.push(`(
      i.title LIKE ? OR i.body LIKE ? OR i.url LIKE ? OR i.author_name LIKE ? OR i.author_handle LIKE ?
      OR EXISTS (SELECT 1 FROM notes n WHERE n.item_id = i.id AND n.body LIKE ?)
      OR EXISTS (SELECT 1 FROM memberships m JOIN tags t ON t.id = m.target_id WHERE m.item_id = i.id AND t.name LIKE ?)
      ${filter.searchRecipeDocuments && filter.searchRecipeLibraryId ? `OR EXISTS (
        SELECT 1 FROM kitchen_recipe_documents kr
         WHERE kr.item_id = i.id AND kr.library_id = ? AND kr.draft_json LIKE ?
      )` : ""}
    )`);
    params.push(like, like, like, like, like, like, like);
    if (filter.searchRecipeDocuments && filter.searchRecipeLibraryId) params.push(filter.searchRecipeLibraryId, like);
  }
  if (includeShelf && filter.shelf && isShelfKey(filter.shelf)) {
    const condition = shelfCondition(filter.shelf);
    where.push(condition.sql);
    params.push(...condition.params);
  }
  return { where, params };
}

function countMatchingItems(db: Db, filter: ItemListFilter, extra?: string, extraParams: string[] = []): number {
  const matched = matchingWhere(filter, false);
  const where = extra ? [...matched.where, extra] : matched.where;
  const row = db
    .prepare(`SELECT COUNT(DISTINCT i.id) AS count FROM items i LEFT JOIN item_state s ON s.item_id = i.id ${where.length ? `WHERE ${where.join(" AND ")}` : ""}`)
    .get(...matched.params, ...extraParams) as { count: number };
  return Number(row?.count ?? 0);
}

export function itemCounts(db: Db, filter: ItemListFilter = {}): ItemListCounts {
  const selectedShelf = filter.shelf && isShelfKey(filter.shelf) ? shelfCondition(filter.shelf) : null;
  const shelves = Object.fromEntries(
    SHELVES.map((shelf) => {
      const condition = shelfCondition(shelf.key);
      return [shelf.key, countMatchingItems(db, filter, condition.sql, condition.params)];
    }),
  );
  return {
    total: selectedShelf ? countMatchingItems(db, filter, selectedShelf.sql, selectedShelf.params) : countMatchingItems(db, filter),
    inbox: selectedShelf
      ? countMatchingItems(db, { ...filter, view: "inbox" }, selectedShelf.sql, selectedShelf.params)
      : countMatchingItems(db, { ...filter, view: "inbox" }),
    shelves,
  };
}

export function listItemsPage(db: Db, filter: ItemListFilter = {}, options: { cursor?: string; limit?: number } = {}): ItemPage {
  const limit = Math.max(1, Math.min(100, Math.floor(options.limit ?? 50)));
  const matched = matchingWhere(filter);
  const cursor = decodeCursor(options.cursor);
  if (cursor) {
    matched.where.push(`(
      ${ITEM_SORT_AT_SQL} < ?
      OR (${ITEM_SORT_AT_SQL} = ? AND i.first_observed_at < ?)
      OR (${ITEM_SORT_AT_SQL} = ? AND i.first_observed_at = ? AND i.id < ?)
    )`);
    matched.params.push(cursor.sortAt, cursor.sortAt, cursor.firstObservedAt, cursor.sortAt, cursor.firstObservedAt, cursor.id);
  }
  const rows = db
    .prepare(`${ITEM_SELECT} ${matched.where.length ? `WHERE ${matched.where.join(" AND ")}` : ""}
      ORDER BY ${ITEM_SORT_AT_SQL} DESC, i.first_observed_at DESC, i.id DESC LIMIT ?`)
    .all(...matched.params, limit + 1) as ItemRow[];
  const pageRows = rows.slice(0, limit);
  const last = pageRows[pageRows.length - 1];
  return {
    items: pageRows.map((row) => hydrate(db, row)),
    nextCursor: rows.length > limit && last
      ? encodeCursor({
          sortAt: last.published_at ?? last.source_saved_at ?? last.captured_at ?? last.first_observed_at,
          firstObservedAt: last.first_observed_at,
          id: last.id,
        })
      : null,
    counts: itemCounts(db, filter),
  };
}

/** Return every matching item for exports, summaries, and existing callers. */
export function listItems(db: Db, filter: ItemListFilter = {}): ItemCard[] {
  const matched = matchingWhere(filter);
  const rows = db
    .prepare(`${ITEM_SELECT} ${matched.where.length ? `WHERE ${matched.where.join(" AND ")}` : ""}
      ORDER BY ${ITEM_SORT_AT_SQL} DESC, i.first_observed_at DESC, i.id DESC`)
    .all(...matched.params) as ItemRow[];
  return rows.map((row) => hydrate(db, row));
}

/** True when one Item matches the same filters as `listItemsPage`. */
export function itemMatchesFilter(db: Db, itemId: string, filter: ItemListFilter = {}): boolean {
  const matched = matchingWhere(filter);
  matched.where.push(`i.id = ?`);
  matched.params.push(itemId);
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM items i LEFT JOIN item_state s ON s.item_id = i.id ${matched.where.length ? `WHERE ${matched.where.join(" AND ")}` : ""} LIMIT 1`,
    )
    .get(...matched.params) as { ok: number } | undefined;
  return Boolean(row);
}

/** Distinct source ids among items matching the same filters as `listItemsPage`. */
export function listMatchingSources(db: Db, filter: ItemListFilter = {}): string[] {
  const matched = matchingWhere(filter);
  const rows = db
    .prepare(
      `SELECT DISTINCT a.source AS source
         FROM items i
         LEFT JOIN item_state s ON s.item_id = i.id
         JOIN source_records r ON r.item_id = i.id
         JOIN source_accounts a ON a.id = r.source_account_id
        ${matched.where.length ? `WHERE ${matched.where.join(" AND ")}` : ""}
        ORDER BY a.source`,
    )
    .all(...matched.params) as { source: string }[];
  return rows.map((row) => row.source);
}

export function getItem(db: Db, id: string): ItemCard | null {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as ItemRow | undefined;
  return row ? hydrate(db, row) : null;
}

/** Library-scoped Item lookup. Foreign ids are indistinguishable from unknown. */
export function getLibraryItem(db: Db, libraryId: string, id: string): ItemCard | null {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ? AND i.library_id = ?`).get(id, ownedLibraryId(libraryId)) as ItemRow | undefined;
  return row ? hydrate(db, row) : null;
}

export function listCollections(db: Db): { id: string; name: string; description: string | null; count: number }[] {
  return db
    .prepare(
      `SELECT c.id, c.name, c.description,
        (SELECT COUNT(*) FROM memberships m WHERE m.target_id = c.id AND m.target_kind = 'collection') AS count
       FROM collections c ORDER BY c.name`,
    )
    .all() as { id: string; name: string; description: string | null; count: number }[];
}

export function listTags(db: Db): { id: string; name: string; color: string | null }[] {
  return db.prepare(`SELECT id, name, color FROM tags ORDER BY name`).all() as {
    id: string;
    name: string;
    color: string | null;
  }[];
}

function cited(db: Db, ids: string[]): CitedItemV1[] {
  const unique = [...new Set(ids)];
  return unique.flatMap((id) => {
    const item = getItem(db, id);
    if (!item) return [];
    return [
      {
        id: item.id,
        title: item.title,
        body: item.body,
        url: item.url,
        authorName: item.authorName,
        authorHandle: item.authorHandle,
        source: item.source ?? "",
        contentType: item.contentType,
      },
    ];
  });
}

export function buildSummary(
  db: Db,
  scope: "day" | "collection" | "selection" | "item",
  scopeRef: string,
): SummarySnapshotV1 {
  let items: ItemCard[] = [];
  if (scope === "day") {
    const day = scopeRef;
    items = listItems(db, {}).filter((item) => localDay(new Date(item.firstObservedAt)) === day);
  } else if (scope === "collection") {
    items = listItems(db, { collectionId: scopeRef });
  } else if (scope === "item") {
    const one = getItem(db, scopeRef);
    items = one ? [one] : [];
  } else {
    const ids = scopeRef.split(",").filter(Boolean);
    items = ids.flatMap((id) => {
      const item = getItem(db, id);
      return item ? [item] : [];
    });
  }

  const bySource = new Map<string, string[]>();
  const byCreator = new Map<string, string[]>();
  const byTag = new Map<string, string[]>();
  const byCollection = new Map<string, string[]>();
  const inboxIds: string[] = [];
  for (const item of items) {
    if (item.source) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item.id]);
    const creator = item.authorHandle || item.authorName;
    if (creator) byCreator.set(creator, [...(byCreator.get(creator) ?? []), item.id]);
    for (const tag of item.tags) byTag.set(tag.name, [...(byTag.get(tag.name) ?? []), item.id]);
    for (const col of item.collections) byCollection.set(col.name, [...(byCollection.get(col.name) ?? []), item.id]);
  }
  const inboxAll = listItems(db, { view: "inbox" });
  inboxIds.push(...inboxAll.map((item) => item.id));

  const excerpts = items.slice(0, 6).map((item) => ({
    itemId: item.id,
    excerpt: excerptOf(item.body, item.title),
  }));

  const blocks: DeterministicBlockV1[] = [
    {
      kind: "captures-by-source",
      title: "Saved by source",
      rows: [...bySource.entries()].map(([source, itemIds]) => ({ source, count: itemIds.length, itemIds })),
    },
    {
      kind: "new-creators",
      title: "Creators",
      rows: [...byCreator.entries()].map(([name, itemIds]) => ({ name, count: itemIds.length, itemIds })),
    },
    {
      kind: "common-tags",
      title: "Popular tags",
      rows: [...byTag.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8)
        .map(([tag, itemIds]) => ({ tag, count: itemIds.length, itemIds })),
    },
    {
      kind: "collection-adds",
      title: "Collections",
      rows: [...byCollection.entries()].map(([collection, itemIds]) => ({
        collection,
        count: itemIds.length,
        itemIds,
      })),
    },
    { kind: "inbox", title: "Inbox", count: inboxIds.length, itemIds: inboxIds.slice(0, 40) },
    { kind: "excerpts", title: "Highlights", rows: excerpts },
    { kind: "citations", title: "Links", itemIds: items.map((item) => item.id) },
  ];

  return {
    scope,
    scopeRef,
    generatedAt: new Date().toISOString(),
    blocks,
    items: cited(
      db,
      items.map((item) => item.id),
    ),
  };
}

export function wipeLibrary(db: Db): void {
  const tables = [
    "reading_assets",
    "reading_progress",
    "reading_provenance",
    "reading_documents",
    "atlas_attempts",
    "atlas_screenings",
    "atlas_assignments",
    "atlas_places",
    "kitchen_tonight_mutations",
    "kitchen_tonight_state",
    "kitchen_tonight_entries",
    "kitchen_recipe_documents",
    "link_previews",
    "summaries",
    "notes",
    "memberships",
    "tags",
    "collections",
    "item_state",
    "activities",
    "intake_batches",
    "intake_tag_evidence",
    "item_intake",
    "source_memberships",
    "source_records",
    "items",
    "capture_seen",
    "capture_batches",
    "capture_sessions",
    "capture_runs",
    "capture_tokens",
    "library_capabilities",
    "source_collections",
    "source_accounts",
  ];
  db.exec(`UPDATE atlas_places SET parent_id = NULL`);
  for (const table of tables) db.exec(`DELETE FROM ${table}`);
  db.prepare(
    `DELETE FROM settings WHERE key IN (
      'atlas.homePlaceId', 'atlas.backfill.cursor', 'atlas.backfill.version',
      'atlas.travel-override.cursor', 'atlas.travel-override.version'
    )`,
  ).run();
  rmSync(readingAssetsRoot(), { recursive: true, force: true });
}
