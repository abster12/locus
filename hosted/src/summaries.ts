import type { CitedItemV1, DeterministicBlockV1, SummarySnapshotV1 } from "../../core/summaries.ts";
import { excerptOf } from "../../core/summaries.ts";
import { all, first, inMarks } from "./sql.ts";

// Deterministic summaries for the hosted Worker. Same blocks and shape as the
// local `buildSummary` (core/library.ts), computed with bounded D1 queries.
// AI prose is a separate, later slice: until an approved Worker secret exists
// the pi status reports unavailable and prose generation is rejected (ADR 0002,
// product decision 8) instead of reading anything from a local machine.

export type SummaryScope = "day" | "collection" | "selection" | "item";

// Bounds keep a summary inside a few D1 queries even for large captured
// Libraries. Blocks keep the true counts within these bounds; local has no
// bound but also has no capture batches in the thousands yet.
const SCOPE_ROW_LIMIT = 500;
const CITED_LIMIT = 200;
const INBOX_ID_LIMIT = 40;
const CHUNK = 50;

export const HOSTED_PROSE_STATUS = {
  available: false,
  detail: "Locus AI isn't available on this deployment yet.",
} as const;

export function proseUnavailableMessage(): string {
  return HOSTED_PROSE_STATUS.detail;
}

// Mirrors the desk ITEM_SELECT source resolution: a source label from the
// capture provenance, when the Item has one.
const SOURCE_SQL = `(SELECT a.source FROM source_records r JOIN source_accounts a ON a.id = r.source_account_id
  WHERE r.item_id = i.id LIMIT 1)`;

interface ScopeRow {
  id: string;
  title: string | null;
  body: string | null;
  source: string | null;
  author_name: string | null;
  author_handle: string | null;
}

const SCOPE_SELECT = `
  SELECT i.id, i.title, i.body, i.author_name, i.author_handle, ${SOURCE_SQL} AS source
    FROM items i
    LEFT JOIN item_state s ON s.item_id = i.id
`;

function baseWhere(): { where: string[]; params: unknown[] } {
  // Same visibility as the local summary: archived and rejected saves are out.
  return { where: [`i.library_id = ?`, `COALESCE(s.status, 'inbox') NOT IN ('archived', 'rejected')`], params: [] };
}

async function scopeRows(
  db: D1Database,
  libraryId: string,
  scope: SummaryScope,
  ref: string,
): Promise<ScopeRow[]> {
  if (scope === "item") {
    return all<ScopeRow>(
      db,
      `${SCOPE_SELECT} WHERE i.library_id = ? AND i.id = ? AND COALESCE(s.status, 'inbox') NOT IN ('archived', 'rejected')`,
      libraryId,
      ref,
    );
  }
  if (scope === "day") {
    // The Worker formats days in UTC (core/dates.ts localDay), so the stored
    // ISO prefix is the calendar day.
    const base = baseWhere();
    return all<ScopeRow>(
      db,
      `${SCOPE_SELECT} WHERE ${base.where.join(" AND ")} AND substr(i.first_observed_at, 1, 10) = ?
       ORDER BY COALESCE(i.published_at, '') DESC, i.first_observed_at DESC, i.id DESC LIMIT ?`,
      libraryId,
      ...base.params,
      ref,
      SCOPE_ROW_LIMIT,
    );
  }
  if (scope === "collection") {
    const base = baseWhere();
    return all<ScopeRow>(
      db,
      `${SCOPE_SELECT} WHERE ${base.where.join(" AND ")}
         AND EXISTS (SELECT 1 FROM memberships m WHERE m.item_id = i.id AND m.target_kind = 'collection' AND m.target_id = ?)
       ORDER BY COALESCE(i.published_at, '') DESC, i.first_observed_at DESC, i.id DESC LIMIT ?`,
      libraryId,
      ...base.params,
      ref,
      SCOPE_ROW_LIMIT,
    );
  }
  // selection: explicit ids, chunked to stay under D1 bind limits. Ids that
  // belong to another Library simply match nothing here.
  const ids = ref.split(",").filter(Boolean);
  const rows: ScopeRow[] = [];
  for (let at = 0; at < ids.length && rows.length < SCOPE_ROW_LIMIT; at += CHUNK) {
    const chunk = ids.slice(at, at + CHUNK);
    const base = baseWhere();
    rows.push(
      ...await all<ScopeRow>(
        db,
        `${SCOPE_SELECT} WHERE ${base.where.join(" AND ")} AND i.id IN (${inMarks(chunk.length)})
           ORDER BY COALESCE(i.published_at, '') DESC, i.first_observed_at DESC, i.id DESC`,
        libraryId,
        ...base.params,
        ...chunk,
      ),
    );
  }
  return rows.slice(0, SCOPE_ROW_LIMIT);
}

interface MembershipRow {
  item_id: string;
  target_kind: string;
  tag_name: string | null;
  collection_name: string | null;
}

async function membershipsOf(db: D1Database, itemIds: string[]): Promise<Map<string, { tags: string[]; collections: string[] }>> {
  const map = new Map<string, { tags: string[]; collections: string[] }>();
  for (let at = 0; at < itemIds.length; at += CHUNK) {
    const chunk = itemIds.slice(at, at + CHUNK);
    const rows = await all<MembershipRow>(
      db,
      `SELECT m.item_id, m.target_kind,
              CASE WHEN m.target_kind = 'tag' THEN t.name END AS tag_name,
              CASE WHEN m.target_kind = 'collection' THEN c.name END AS collection_name
         FROM memberships m
         LEFT JOIN tags t ON t.id = m.target_id AND m.target_kind = 'tag'
         LEFT JOIN collections c ON c.id = m.target_id AND m.target_kind = 'collection'
        WHERE m.target_kind IN ('tag', 'collection') AND m.item_id IN (${inMarks(chunk.length)})`,
      ...chunk,
    );
    for (const row of rows) {
      const entry = map.get(row.item_id) ?? { tags: [], collections: [] };
      if (row.target_kind === "tag" && row.tag_name) entry.tags.push(row.tag_name);
      if (row.target_kind === "collection" && row.collection_name) entry.collections.push(row.collection_name);
      map.set(row.item_id, entry);
    }
  }
  return map;
}

async function citedItems(db: D1Database, libraryId: string, itemIds: string[]): Promise<CitedItemV1[]> {
  const unique = [...new Set(itemIds)].slice(0, CITED_LIMIT);
  const rows: CitedItemV1[] = [];
  for (let at = 0; at < unique.length; at += CHUNK) {
    const chunk = unique.slice(at, at + CHUNK);
    rows.push(
      ...(await all<CitedItemV1>(
        db,
        `SELECT i.id, i.title, i.body, i.url, i.content_type AS contentType, i.author_name AS authorName,
                i.author_handle AS authorHandle, COALESCE(${SOURCE_SQL}, '') AS source
           FROM items i WHERE i.library_id = ? AND i.id IN (${inMarks(chunk.length)})`,
        libraryId,
        ...chunk,
      )),
    );
  }
  return rows;
}

async function inboxBlock(db: D1Database, libraryId: string): Promise<DeterministicBlockV1> {
  const base = { kind: "inbox" as const, title: "Inbox" };
  const counted = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM items i LEFT JOIN item_state s ON s.item_id = i.id
      WHERE i.library_id = ? AND COALESCE(s.status, 'inbox') = 'inbox'`,
    libraryId,
  );
  const ids = (
    await all<{ id: string }>(
      db,
      `SELECT i.id FROM items i LEFT JOIN item_state s ON s.item_id = i.id
        WHERE i.library_id = ? AND COALESCE(s.status, 'inbox') = 'inbox'
        ORDER BY COALESCE(i.published_at, '') DESC, i.first_observed_at DESC, i.id DESC LIMIT ?`,
      libraryId,
      INBOX_ID_LIMIT,
    )
  ).map((row) => row.id);
  return { ...base, count: counted?.n ?? 0, itemIds: ids };
}

export async function buildSummary(
  db: D1Database,
  libraryId: string,
  scope: SummaryScope,
  scopeRef: string,
): Promise<SummarySnapshotV1> {
  const items = await scopeRows(db, libraryId, scope, scopeRef);
  const memberships = await membershipsOf(db, items.map((item) => item.id));

  const bySource = new Map<string, string[]>();
  const byCreator = new Map<string, string[]>();
  const byTag = new Map<string, string[]>();
  const byCollection = new Map<string, string[]>();
  for (const item of items) {
    if (item.source) bySource.set(item.source, [...(bySource.get(item.source) ?? []), item.id]);
    const creator = item.author_handle || item.author_name;
    if (creator) byCreator.set(creator, [...(byCreator.get(creator) ?? []), item.id]);
    for (const tag of memberships.get(item.id)?.tags ?? []) {
      byTag.set(tag, [...(byTag.get(tag) ?? []), item.id]);
    }
    for (const col of memberships.get(item.id)?.collections ?? []) {
      byCollection.set(col, [...(byCollection.get(col) ?? []), item.id]);
    }
  }

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
    await inboxBlock(db, libraryId),
    { kind: "excerpts", title: "Highlights", rows: excerpts },
    { kind: "citations", title: "Links", itemIds: items.map((item) => item.id) },
  ];

  return {
    scope,
    scopeRef,
    generatedAt: new Date().toISOString(),
    blocks,
    items: await citedItems(db, libraryId, items.map((item) => item.id)),
  };
}
