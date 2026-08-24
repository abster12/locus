import type { Db } from "../db/open.ts";
import { dateLabel, type DateLabel, type ItemStatus, type SourceId } from "./types.ts";
import { inferHandleFromUrl } from "./sanitize.ts";
import { excerptOf, type CitedItemV1, type DeterministicBlockV1, type SummarySnapshotV1 } from "./summaries.ts";

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
  source: SourceId | string;
  status: ItemStatus;
  snoozedUntil: string | null;
  tags: { id: string; name: string; color: string | null }[];
  collections: { id: string; name: string }[];
  notes: { id: string; body: string; createdAt: string }[];
  dateLabel: DateLabel;
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
};

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
    source: (row.source ?? "x") as SourceId,
    status: (row.status ?? "inbox") as ItemStatus,
    snoozedUntil: row.snoozed_until,
    tags,
    collections,
    notes,
    dateLabel: dateLabel(item),
  };
}

const ITEM_SELECT = `
  SELECT i.*, COALESCE(s.status, 'inbox') AS status, s.snoozed_until,
    (SELECT a.source FROM source_records r JOIN source_accounts a ON a.id = r.source_account_id
      WHERE r.item_id = i.id LIMIT 1) AS source
  FROM items i
  LEFT JOIN item_state s ON s.item_id = i.id
`;

export function listItems(
  db: Db,
  filter: { view?: "recent" | "inbox"; source?: string; q?: string; collectionId?: string },
): ItemCard[] {
  const where: string[] = [];
  const params: string[] = [];
  if (filter.view === "inbox") {
    where.push(`COALESCE(s.status, 'inbox') = 'inbox'`);
  }
  if (filter.source) {
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
      i.title LIKE ? OR i.body LIKE ? OR i.author_name LIKE ? OR i.author_handle LIKE ?
      OR EXISTS (SELECT 1 FROM notes n WHERE n.item_id = i.id AND n.body LIKE ?)
      OR EXISTS (SELECT 1 FROM memberships m JOIN tags t ON t.id = m.target_id WHERE m.item_id = i.id AND t.name LIKE ?)
    )`);
    params.push(like, like, like, like, like, like);
  }
  const sql = `${ITEM_SELECT} ${where.length ? `WHERE ${where.join(" AND ")}` : ""} ORDER BY i.published_at DESC, i.first_observed_at DESC`;
  const rows = db.prepare(sql).all(...params) as ItemRow[];
  return rows.map((row) => hydrate(db, row));
}

export function getItem(db: Db, id: string): ItemCard | null {
  const row = db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id) as ItemRow | undefined;
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
        source: String(item.source),
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
    items = listItems(db, {}).filter((item) => item.firstObservedAt.slice(0, 10) === day);
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
    const src = String(item.source);
    bySource.set(src, [...(bySource.get(src) ?? []), item.id]);
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
      title: "New captures by source",
      rows: [...bySource.entries()].map(([source, itemIds]) => ({ source, count: itemIds.length, itemIds })),
    },
    {
      kind: "new-creators",
      title: "Newly discovered creators",
      rows: [...byCreator.entries()].map(([name, itemIds]) => ({ name, count: itemIds.length, itemIds })),
    },
    {
      kind: "common-tags",
      title: "Most common tags",
      rows: [...byTag.entries()]
        .sort((a, b) => b[1].length - a[1].length)
        .slice(0, 8)
        .map(([tag, itemIds]) => ({ tag, count: itemIds.length, itemIds })),
    },
    {
      kind: "collection-adds",
      title: "Items added to collections",
      rows: [...byCollection.entries()].map(([collection, itemIds]) => ({
        collection,
        count: itemIds.length,
        itemIds,
      })),
    },
    { kind: "inbox", title: "Unresolved inbox", count: inboxIds.length, itemIds: inboxIds.slice(0, 40) },
    { kind: "excerpts", title: "Selected excerpts", rows: excerpts },
    { kind: "citations", title: "Cited items", itemIds: items.map((item) => item.id) },
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

export function exportLibrary(db: Db): unknown {
  return {
    exportedAt: new Date().toISOString(),
    items: listItems(db, {}),
    collections: listCollections(db),
    tags: listTags(db),
    notes: db.prepare(`SELECT * FROM notes`).all(),
    activities: db.prepare(`SELECT * FROM activities`).all(),
    sourceAccounts: db.prepare(`SELECT id, source, external_id, display_name, created_at FROM source_accounts`).all(),
    sourceCollections: db.prepare(`SELECT * FROM source_collections`).all(),
    captureRuns: db
      .prepare(
        `SELECT id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status,
                seen_count, upserted_count, removed_count, error_code FROM capture_runs`,
      )
      .all(),
  };
}

export function wipeLibrary(db: Db): void {
  const tables = [
    "link_previews",
    "summaries",
    "notes",
    "memberships",
    "tags",
    "collections",
    "item_state",
    "activities",
    "source_memberships",
    "source_records",
    "items",
    "capture_seen",
    "capture_batches",
    "capture_sessions",
    "capture_runs",
    "capture_tokens",
    "source_collections",
    "source_accounts",
  ];
  for (const table of tables) db.exec(`DELETE FROM ${table}`);
}
