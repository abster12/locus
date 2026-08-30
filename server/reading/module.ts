import type { Db } from "../../db/open.ts";
import { newId, nowIso } from "../../db/open.ts";
import { getSetting, MissingResource, setSetting } from "../../core/commands.ts";
import { getItem } from "../../core/library.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import {
  collectText,
  contentHash,
  dropMissingImages,
  hasBlockId,
  MAX_SEARCH_TEXT,
  tocFrom,
  validateContent,
  type ReadingContent,
  type ReadingTocEntry,
} from "./blocks.ts";
import { cleanupUrl, discoverCandidates, hostOf, isChallengeTitle, LOCAL_LIBRARY_ID, type ReadingKind } from "./policy.ts";
import {
  cleanupExpiredRemovals,
  enrichDiagnostics,
  openReadingAsset,
  resetEnrichDiagnostics,
  retryReadingDocument as retryAndDrain,
  startReadingWorker,
  stopReadingWorker,
  wakeReadingWorker,
} from "./worker.ts";

export {
  LOCAL_LIBRARY_ID,
  cleanupExpiredRemovals,
  openReadingAsset,
  startReadingWorker,
  stopReadingWorker,
  wakeReadingWorker,
};
export const UNDO_WINDOW_MS = 30_000;
export const AGENT_READING_TEXT_LIMIT = 30_000;
export const AGENT_READING_LIST_LIMIT = 50;
const AGENT_QUERY_MAX = 200;
const AGENT_PROVENANCE_LIMIT = 5;
const AGENT_NOTE_LIMIT = 2;
const AGENT_NOTE_CHARS = 240;
const AGENT_TAG_LIMIT = 8;
const AGENT_TAG_CHARS = 80;
const AGENT_KINDS: ReadingKind[] = ["article", "documentation", "repository", "pdf", "unknown"];
const AGENT_SORTS: ReadingSort[] = ["recent", "oldest", "shortest", "longest", "publication"];
const BACKFILL_CURSOR = "reading.backfill.cursor";
const BACKFILL_DONE = "done";
const BACKFILL_BATCH = 50;

export type ReadingAvailability = "pending" | "ready" | "metadata_only" | "blocked" | "unsupported" | "error";
export type ReadingView = "queue" | "finished";
export type ReadingSort = "recent" | "oldest" | "shortest" | "longest" | "publication";

export interface ReadingListQuery {
  view?: ReadingView;
  kind?: string;
  source?: string;
  q?: string;
  sort?: ReadingSort;
  cursor?: string;
  limit?: number;
}

export interface ReadingSummary {
  id: string;
  canonicalUrl: string;
  title: string;
  subtitle: string | null;
  byline: string | null;
  publication: string | null;
  host: string;
  kind: ReadingKind;
  availability: ReadingAvailability;
  failureCode: string | null;
  originalStatus: string;
  excerpt: string | null;
  wordCount: number | null;
  readingMinutes: number | null;
  lastSavedAt: string;
  sources: string[];
  savedCount: number;
  heroAssetId: string | null;
  progress: { state: "reading" | "finished"; progress: number } | null;
}

export interface ReadingProgress {
  state: "reading" | "finished";
  progress: number;
  anchor: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  finishedAt: string | null;
}

export interface ReadingProvenance {
  itemId: string;
  observedUrl: string;
  title: string | null;
  body: string | null;
  source: string;
  authorName: string | null;
  authorHandle: string | null;
  permalink: string;
  firstObservedAt: string;
  sourceSavedAt: string | null;
  capturedAt: string | null;
  tags: { id: string; name: string }[];
  notes: { id: string; body: string }[];
}

export interface ReadingDocumentDetail {
  id: string;
  canonicalUrl: string;
  observedUrl: string;
  finalUrl: string | null;
  kind: ReadingKind;
  availability: ReadingAvailability;
  failureCode: string | null;
  originalStatus: string;
  originalCheckedAt: string | null;
  title: string;
  subtitle: string | null;
  byline: string | null;
  publication: string | null;
  publishedAt: string | null;
  language: string | null;
  excerpt: string | null;
  wordCount: number | null;
  readingMinutes: number | null;
  contentBlocks: ReadingContent | null;
  toc: ReadingTocEntry[];
  heroAssetId: string | null;
  lastSavedAt: string;
  fetchedAt: string | null;
  updatedAt: string;
  progress: { state: "reading" | "finished"; progress: number; anchor: string | null } | null;
  provenance: ReadingProvenance[];
  actions: { openOriginal: boolean; retry: boolean; remove: boolean };
}

export interface ReadingPageResult {
  view: ReadingView;
  preparing: { count: number; preview: ReadingSummary[] };
  unread: { items: ReadingSummary[]; nextCursor: string | null };
  items: ReadingSummary[];
  nextCursor: string | null;
  counts: {
    unread: number;
    reading: number;
    preparing: number;
    finished: number;
  };
}

export type AgentReadingState = "unread" | "reading" | "finished";

export interface AgentReadingSummary {
  id: string;
  title: string;
  publication: string | null;
  host: string;
  excerpt: string | null;
  kind: ReadingKind;
  availability: ReadingAvailability;
  hasStoredText: boolean;
  readingMinutes: number | null;
  lastSavedAt: string;
  sources: string[];
  readingState: AgentReadingState;
  canonicalUrl: string | null;
}

export interface AgentReadingProvenance {
  source: string;
  savedAt: string;
  tags: string[];
  notes: string[];
}

export interface AgentReadingDocument {
  id: string;
  title: string;
  byline: string | null;
  publication: string | null;
  host: string;
  excerpt: string | null;
  kind: ReadingKind;
  availability: ReadingAvailability;
  hasStoredText: boolean;
  readingMinutes: number | null;
  lastSavedAt: string;
  readingState: AgentReadingState;
  canonicalUrl: string | null;
  provenance: AgentReadingProvenance[];
  text: string | null;
  truncated: boolean;
  totalTextLength: number;
}

export interface AgentReadingPageResult {
  items: AgentReadingSummary[];
  nextCursor: string | null;
  counts: ReadingPageResult["counts"];
}

/**
 * The archive adapter's only view of Reading data. The archive format still
 * names the three durable Reading record kinds, but table layout, validation,
 * and snapshot sanitization stay behind this module's seam.
 */
export type ReadingArchiveRecord = Record<string, unknown>;

export interface ReadingArchiveCounts {
  readingDocument: number;
  readingProvenance: number;
  readingProgress: number;
}

export interface ReadingArchiveExport {
  counts: ReadingArchiveCounts;
  records: Iterable<ReadingArchiveRecord>;
}

export interface ReadingArchiveImport {
  documents: readonly ReadingArchiveRecord[];
  provenance: readonly ReadingArchiveRecord[];
  progress: readonly ReadingArchiveRecord[];
  itemIds: ReadonlySet<string>;
}

type DocumentRow = {
  id: string;
  library_id: string;
  canonical_url: string;
  observed_url: string;
  final_url: string | null;
  kind: string;
  availability: string;
  failure_code: string | null;
  original_status: string;
  original_checked_at: string | null;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  publication: string | null;
  published_at: string | null;
  language: string | null;
  excerpt: string | null;
  word_count: number | null;
  reading_minutes: number | null;
  last_saved_at: string;
  fetched_at: string | null;
  updated_at: string;
  removed_at: string | null;
  content_blocks: string | null;
  hero_asset_id: string | null;
  progress_state: string | null;
  progress_value: number | null;
  progress_anchor: string | null;
  has_stored_text?: number;
};

type Cursor = { sort: ReadingSort; k: string; id: string };

const diagnostics: { accepted: number; exclusions: Record<string, number>; malformedRows: number } = {
  accepted: 0,
  exclusions: {},
  malformedRows: 0,
};

export function readingDiagnostics(db?: Db): {
  accepted: number;
  exclusions: Record<string, number>;
  malformedRows: number;
  orphanedProvenance: number;
  merges: number;
  challenges: number;
  enrichments: Record<string, number>;
  availability?: Record<string, number>;
  kinds?: Record<string, number>;
  failureCodes?: Record<string, number>;
} {
  const extra = {
    accepted: diagnostics.accepted,
    exclusions: { ...diagnostics.exclusions },
    malformedRows: diagnostics.malformedRows,
    merges: enrichDiagnostics.merges,
    challenges: enrichDiagnostics.challenges,
    enrichments: { ...enrichDiagnostics.enrichments },
  };
  if (!db) return { ...extra, orphanedProvenance: 0 };
  const orphanedProvenance = Number(
    (db.prepare(
      `SELECT COUNT(*) AS n FROM reading_provenance rp
       LEFT JOIN reading_documents d ON d.id = rp.document_id AND d.library_id = rp.library_id
       LEFT JOIN items i ON i.id = rp.item_id
       WHERE d.id IS NULL OR i.id IS NULL`,
    ).get() as { n: number }).n,
  );
  const availability = Object.fromEntries(
    (db.prepare(`SELECT availability AS k, COUNT(*) AS n FROM reading_documents WHERE removed_at IS NULL GROUP BY availability`).all() as { k: string; n: number }[]).map(
      (row) => [row.k, Number(row.n)],
    ),
  );
  const kinds = Object.fromEntries(
    (db.prepare(`SELECT kind AS k, COUNT(*) AS n FROM reading_documents WHERE removed_at IS NULL GROUP BY kind`).all() as { k: string; n: number }[]).map(
      (row) => [row.k, Number(row.n)],
    ),
  );
  const failureCodes = Object.fromEntries(
    (
      db.prepare(`SELECT failure_code AS k, COUNT(*) AS n FROM reading_documents WHERE removed_at IS NULL AND failure_code IS NOT NULL GROUP BY failure_code`).all() as {
        k: string;
        n: number;
      }[]
    ).map((row) => [row.k, Number(row.n)]),
  );
  return { ...extra, orphanedProvenance, availability, kinds, failureCodes };
}

export function resetReadingDiagnostics(): void {
  diagnostics.accepted = 0;
  diagnostics.exclusions = {};
  diagnostics.malformedRows = 0;
  resetEnrichDiagnostics();
}

export async function retryReadingDocument(db: Db, libraryId: string, documentId: string) {
  await retryAndDrain(db, libraryId, documentId);
  return getReadingDocument(db, libraryId, documentId);
}

/** Desk preview is OG-only. When one succeeds, re-run local discovery for Items that contain that URL and requeue false negatives for the hardened fetch. */
export function absorbPreviewedUrl(db: Db, rawUrl: string, title?: string | null): void {
  if (!rawUrl || isChallengeTitle(title)) return;
  const cleaned = cleanupUrl(rawUrl);
  if (!cleaned) return;
  const items = db
    .prepare(`SELECT id FROM items WHERE instr(COALESCE(body, ''), ?) > 0 OR instr(COALESCE(body, ''), ?) > 0 LIMIT 20`)
    .all(rawUrl, cleaned.canonicalUrl) as { id: string }[];
  if (items.length === 0) return;
  for (const item of items) reconcileItem(db, LOCAL_LIBRARY_ID, item.id);
  db.prepare(
    `UPDATE reading_documents SET availability = 'pending', next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL
      WHERE removed_at IS NULL
        AND (canonical_url = ? OR observed_url = ? OR canonical_url = ? OR observed_url = ?)
        AND availability IN ('unsupported', 'error')
        AND failure_code IN ('not_article_like', 'empty_content')`,
  ).run(nowIso(), cleaned.canonicalUrl, cleaned.observedUrl, rawUrl, rawUrl);
  wakeReadingWorker(db);
}

/** Local candidate discovery. Callers must invoke this inside the Item write transaction. */
export function reconcileItem(db: Db, libraryId: string, itemId: string): void {
  const item = db
    .prepare(
      `SELECT id, title, body, url, first_observed_at, captured_at FROM items WHERE id = ?`,
    )
    .get(itemId) as
    | { id: string; title: string | null; body: string | null; url: string; first_observed_at: string; captured_at: string | null }
    | undefined;
  if (!item) return;

  const discovered = discoverCandidates(item.body, item.url);
  diagnostics.accepted += discovered.candidates.length;
  for (const [reason, n] of Object.entries(discovered.exclusions)) {
    if (!n) continue;
    diagnostics.exclusions[reason] = (diagnostics.exclusions[reason] ?? 0) + n;
    if (reason === "candidate_limit_exceeded") {
      console.info("reading: excluded candidate_limit_exceeded", { host: hostOf(item.url), n });
    }
  }

  const wanted = new Map(discovered.candidates.map((candidate) => [candidate.canonicalUrl, candidate]));
  const existing = db
    .prepare(`SELECT document_id, observed_url FROM reading_provenance WHERE library_id = ? AND item_id = ?`)
    .all(libraryId, itemId) as { document_id: string; observed_url: string }[];

  const savedAt = item.captured_at || item.first_observed_at;
  for (const row of existing) {
    const canonical = db
      .prepare(`SELECT canonical_url FROM reading_documents WHERE id = ? AND library_id = ?`)
      .get(row.document_id, libraryId) as { canonical_url: string } | undefined;
    const observedIdentity = cleanupUrl(row.observed_url)?.canonicalUrl;
    const matched = [observedIdentity, canonical?.canonical_url].find((identity) => identity && wanted.has(identity));
    if (matched) {
      wanted.delete(matched);
      db.prepare(
        `UPDATE reading_documents SET last_saved_at = MAX(last_saved_at, ?), updated_at = MAX(updated_at, ?)
         WHERE id = ? AND library_id = ?`,
      ).run(savedAt, savedAt, row.document_id, libraryId);
      continue;
    }
    db.prepare(`DELETE FROM reading_provenance WHERE library_id = ? AND document_id = ? AND item_id = ?`).run(
      libraryId,
      row.document_id,
      itemId,
    );
    maybeDeleteOrphan(db, libraryId, row.document_id);
  }

  for (const candidate of wanted.values()) {
    attachCandidate(db, libraryId, item, candidate, savedAt);
  }
}

/** One bounded local batch. Returns true when more Items remain. */
export function backfillReading(db: Db, libraryId = LOCAL_LIBRARY_ID): boolean {
  let cursor = getSetting(db, BACKFILL_CURSOR) ?? "";
  if (cursor === BACKFILL_DONE) return false;
  const rows = (
    cursor
      ? db.prepare(`SELECT id FROM items WHERE id > ? ORDER BY id LIMIT ?`).all(cursor, BACKFILL_BATCH)
      : db.prepare(`SELECT id FROM items ORDER BY id LIMIT ?`).all(BACKFILL_BATCH)
  ) as { id: string }[];
  if (rows.length === 0) {
    setSetting(db, BACKFILL_CURSOR, BACKFILL_DONE);
    return false;
  }
  for (const row of rows) {
    reconcileItem(db, libraryId, row.id);
    cursor = row.id;
    setSetting(db, BACKFILL_CURSOR, cursor);
  }
  if (rows.length < BACKFILL_BATCH) {
    setSetting(db, BACKFILL_CURSOR, BACKFILL_DONE);
    return false;
  }
  return true;
}

/** Export durable Reading records without exposing the Reading tables to the archive adapter. */
export function exportReadingRecords(db: Db, libraryId = LOCAL_LIBRARY_ID): ReadingArchiveExport {
  const counts: ReadingArchiveCounts = {
    readingDocument: Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM reading_documents WHERE library_id = ?`).get(libraryId) as { n: number }).n,
    ),
    readingProvenance: Number(
      (db.prepare(`SELECT COUNT(*) AS n FROM reading_provenance WHERE library_id = ?`).get(libraryId) as { n: number }).n,
    ),
    readingProgress: Number(
      (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM reading_progress p
             JOIN reading_documents d ON d.id = p.document_id AND d.library_id = p.library_id
             WHERE p.library_id = ? AND d.removed_at IS NULL`,
          )
          .get(libraryId) as { n: number }
      ).n,
    ),
  };

  function* records(): Generator<ReadingArchiveRecord> {
    const documents = db.prepare(`SELECT * FROM reading_documents WHERE library_id = ?`).all(libraryId) as ReadingArchiveRow[];
    for (const row of documents) {
      const tombstone = typeof row.removed_at === "string";
      const base: ReadingArchiveRecord = {
        kind: "readingDocument",
        id: row.id,
        canonicalUrl: row.canonical_url,
        observedUrl: row.observed_url,
        kindName: row.kind,
        availability: row.availability,
        removedAt: row.removed_at,
        lastSavedAt: row.last_saved_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      };
      if (tombstone) {
        yield base;
        continue;
      }
      yield {
        ...base,
        finalUrl: row.final_url,
        failureCode: row.failure_code,
        originalStatus: row.original_status,
        originalCheckedAt: row.original_checked_at,
        title: row.title,
        subtitle: row.subtitle,
        byline: row.byline,
        publication: row.publication,
        publishedAt: row.published_at,
        language: row.language,
        excerpt: row.excerpt,
        searchText: typeof row.search_text === "string" ? row.search_text.slice(0, MAX_SEARCH_TEXT) : null,
        wordCount: row.word_count,
        readingMinutes: row.reading_minutes,
        contentBlocks: parseStoredBlocks(row.content_blocks),
        fetchedAt: row.fetched_at,
      };
    }

    const provenance = db
      .prepare(`SELECT document_id, item_id, observed_url, discovered_at FROM reading_provenance WHERE library_id = ?`)
      .all(libraryId) as ReadingArchiveProvenanceRow[];
    for (const row of provenance) {
      yield {
        kind: "readingProvenance",
        documentId: row.document_id,
        itemId: row.item_id,
        observedUrl: row.observed_url,
        discoveredAt: row.discovered_at,
      };
    }

    const progress = db
      .prepare(
        `SELECT p.document_id, p.state, p.progress, p.anchor, p.first_opened_at, p.last_opened_at, p.finished_at, p.updated_at
         FROM reading_progress p
         JOIN reading_documents d ON d.id = p.document_id AND d.library_id = p.library_id
         WHERE p.library_id = ? AND d.removed_at IS NULL`,
      )
      .all(libraryId) as ReadingArchiveProgressRow[];
    for (const row of progress) {
      yield {
        kind: "readingProgress",
        documentId: row.document_id,
        state: row.state,
        progress: row.progress,
        anchor: row.anchor,
        firstOpenedAt: row.first_opened_at,
        lastOpenedAt: row.last_opened_at,
        finishedAt: row.finished_at,
        updatedAt: row.updated_at,
      };
    }
  }

  return { counts, records: records() };
}

/** Categories intentionally omitted because they are rebuildable or operational rather than durable Reading data. */
export function readingArchiveExcluded(): readonly string[] {
  return ["reading_leases", "reading_undo_tokens", "reading_assets", "adapter_keys"];
}

export function readingBackfillSettingKey(): string {
  return BACKFILL_CURSOR;
}

/** Reading's part of the restore emptiness check, kept out of the generic archive adapter. */
export function readingLibraryIsEmpty(db: Db): boolean {
  const queries = [
    `SELECT COUNT(*) AS n FROM reading_documents`,
    `SELECT COUNT(*) AS n FROM reading_provenance`,
    `SELECT COUNT(*) AS n FROM reading_progress`,
    `SELECT COUNT(*) AS n FROM reading_assets`,
  ];
  for (const sql of queries) {
    if (Number((db.prepare(sql).get() as { n: number }).n) > 0) return false;
  }
  return true;
}

/**
 * Restore durable Reading records into an already-open restore transaction.
 * The caller owns the surrounding transaction so Reading insertion commits or
 * rolls back with the rest of the Library. Items are supplied only as ids so
 * provenance validation can remain inside this seam.
 */
export function importReadingRecords(
  db: Db,
  input: ReadingArchiveImport,
  libraryId = LOCAL_LIBRARY_ID,
): { documents: number; provenance: number; progress: number } {
  const documents = [...input.documents];
  const provenance = [...input.provenance];
  const progress = [...input.progress];
  validateReadingArchiveRecords(documents, provenance, progress, input.itemIds);

  const now = nowIso();
  const tombstones = new Set<string>();
  const insDoc = db.prepare(
    `INSERT INTO reading_documents (
      id, library_id, canonical_url, observed_url, final_url, kind, availability, failure_code, original_status,
      original_checked_at, title, subtitle, byline, publication, published_at, language, excerpt, search_text,
      word_count, reading_minutes, content_blocks, content_hash, last_saved_at, removed_at, fetched_at, created_at, updated_at,
      next_attempt_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  for (const row of documents) {
    const id = reqReadingId(row.id);
    const removedAt = optReading(row.removedAt, 40);
    if (removedAt) tombstones.add(id);
    const content = removedAt ? null : importedReadingBlocks(row.contentBlocks);
    const searchText = removedAt ? null : importedReadingSearch(row.searchText);
    const pending = !removedAt && row.availability === "pending";
    insDoc.run(
      id,
      libraryId,
      reqReadingPublicUrl(row.canonicalUrl),
      reqReadingPublicUrl(row.observedUrl),
      removedAt ? null : optReadingPublicUrl(row.finalUrl),
      reqReadingKind(row.kindName),
      reqReadingAvailability(row.availability),
      removedAt ? null : optReadingFailureCode(row.failureCode),
      removedAt ? "unknown" : reqReadingOriginalStatus(row.originalStatus),
      removedAt ? null : optReadingIso(row.originalCheckedAt),
      removedAt ? null : optReading(row.title, MAX_TITLE),
      removedAt ? null : optReading(row.subtitle, MAX_TITLE),
      removedAt ? null : optReading(row.byline, MAX_HANDLE),
      removedAt ? null : optReading(row.publication, MAX_NAME),
      removedAt ? null : optReading(row.publishedAt, 40),
      removedAt ? null : optReading(row.language, 40),
      removedAt ? null : optReading(row.excerpt, 2_000),
      searchText,
      removedAt ? null : intReadingOrNull(row.wordCount),
      removedAt ? null : intReadingOrNull(row.readingMinutes),
      content ? JSON.stringify(content) : null,
      content ? contentHash(content) : null,
      reqReadingIso(row.lastSavedAt),
      removedAt,
      removedAt ? null : optReadingIso(row.fetchedAt),
      reqReadingIso(row.createdAt),
      reqReadingIso(row.updatedAt),
      pending ? now : null,
    );
  }

  const insProv = db.prepare(
    `INSERT INTO reading_provenance (library_id, document_id, item_id, observed_url, discovered_at) VALUES (?, ?, ?, ?, ?)`,
  );
  for (const row of provenance) {
    insProv.run(
      libraryId,
      reqReadingId(row.documentId),
      reqReading(row.itemId, 128),
      reqReadingPublicUrl(row.observedUrl),
      reqReadingIso(row.discoveredAt),
    );
  }

  const insProgress = db.prepare(
    `INSERT INTO reading_progress (
      library_id, document_id, state, progress, anchor, first_opened_at, last_opened_at, finished_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of progress) {
    const documentId = reqReadingId(row.documentId);
    if (tombstones.has(documentId)) continue;
    const progressValue = Number(row.progress);
    insProgress.run(
      libraryId,
      documentId,
      reqReadingProgressState(row.state),
      progressValue,
      optReading(row.anchor, 400),
      optReading(row.firstOpenedAt, 40),
      optReading(row.lastOpenedAt, 40),
      optReading(row.finishedAt, 40),
      reqReadingIso(row.updatedAt),
    );
  }

  if (documents.length > 0) setSetting(db, BACKFILL_CURSOR, BACKFILL_DONE);
  else {
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(BACKFILL_CURSOR);
    backfillReading(db, libraryId);
  }
  return { documents: documents.length, provenance: provenance.length, progress: progress.length };
}

export function listReadingDocuments(db: Db, libraryId: string, query: ReadingListQuery = {}): ReadingPageResult {
  const view = query.view === "finished" ? "finished" : "queue";
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 50)));
  const counts = countReading(db, libraryId, query);
  const emptyPage: ReadingPageResult = {
    view,
    preparing: { count: 0, preview: [] },
    unread: { items: [], nextCursor: null },
    items: [],
    nextCursor: null,
    counts,
  };

  if (view === "queue") {
    const preparingRows = selectDocuments(db, libraryId, query, { availability: "pending" }, 8);
    const unread = pageDocuments(db, libraryId, query, { availability: "ready", unreadOnly: true }, limit);
    return {
      ...emptyPage,
      preparing: { count: counts.preparing, preview: preparingRows },
      unread,
    };
  }

  const page = pageDocuments(
    db,
    libraryId,
    query,
    view === "finished" ? { finishedOnly: true } : {},
    limit,
  );
  return { ...emptyPage, items: page.items, nextCursor: page.nextCursor };
}

export function listReadingDocumentsForAgent(
  db: Db,
  libraryId: string,
  query: ReadingListQuery = {},
): AgentReadingPageResult {
  const parsed = parseAgentListQuery(query);
  const counts = countReading(db, libraryId, parsed);
  const extra: ListExtra =
    parsed.view === "finished"
      ? { finishedOnly: true, includeHidden: true }
      : { unreadOnly: true, includeHidden: true };
  const page = loadDocumentPage(db, libraryId, parsed, extra, parsed.limit);
  const items: AgentReadingSummary[] = [];
  for (const row of page.rows) {
    const summary = toAgentSummary(db, libraryId, row);
    if (summary) items.push(summary);
  }
  return { items, nextCursor: page.nextCursor, counts };
}

export function getReadingDocument(db: Db, libraryId: string, documentId: string): ReadingDocumentDetail {
  const row = db
    .prepare(
      `${DOCUMENT_SELECT}
       WHERE d.library_id = ? AND d.id = ? AND d.removed_at IS NULL`,
    )
    .get(libraryId, documentId) as DocumentRow | undefined;
  if (!row || !isLiveDocument(row)) throw new MissingResource("document");
  const summary = toSummary(db, libraryId, row);
  if (!summary) throw new MissingResource("document");
  const provenance = loadProvenance(db, libraryId, row.id);
  const openOriginal = canOpenOriginal(row);
  const parsed = parseStoredBlocks(row.content_blocks);
  const unsupported = Boolean(row.content_blocks) && !parsed;
  const availability = unsupported ? "error" : (row.availability as ReadingAvailability);
  const failureCode = unsupported ? "parse_error" : row.failure_code;
  const retry =
    failureCode !== "gone" && row.original_status !== "gone" && row.availability !== "pending";
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    observedUrl: row.observed_url,
    finalUrl: row.final_url,
    kind: row.kind as ReadingKind,
    availability,
    failureCode,
    originalStatus: row.original_status,
    originalCheckedAt: row.original_checked_at,
    title: summary.title,
    subtitle: row.subtitle,
    byline: row.byline,
    publication: row.publication,
    publishedAt: row.published_at,
    language: row.language,
    excerpt: trustedExcerpt(row),
    wordCount: row.word_count,
    readingMinutes: row.reading_minutes,
    contentBlocks: parsed,
    toc: parsed ? tocFrom(parsed.blocks) : [],
    heroAssetId: row.hero_asset_id,
    lastSavedAt: row.last_saved_at,
    fetchedAt: row.fetched_at,
    updatedAt: row.updated_at,
    progress: row.progress_state === "reading" || row.progress_state === "finished"
      ? { state: row.progress_state, progress: Number(row.progress_value ?? 0), anchor: row.progress_anchor }
      : null,
    provenance,
    actions: { openOriginal, retry, remove: true },
  };
}

export function getAgentReadingDocument(db: Db, libraryId: string, documentId: string): AgentReadingDocument {
  const detail = getReadingDocument(db, libraryId, documentId);
  const fullText = detail.contentBlocks ? collectText(detail.contentBlocks.blocks) : null;
  const totalTextLength = fullText?.length ?? 0;
  const truncated = totalTextLength > AGENT_READING_TEXT_LIMIT;
  const text = fullText ? fullText.slice(0, AGENT_READING_TEXT_LIMIT) : null;
  return {
    id: detail.id,
    title: detail.title,
    byline: detail.byline,
    publication: detail.publication,
    host: hostOf(detail.canonicalUrl),
    excerpt: detail.excerpt,
    kind: detail.kind,
    availability: detail.availability,
    hasStoredText: detail.contentBlocks != null,
    readingMinutes: detail.readingMinutes,
    lastSavedAt: detail.lastSavedAt,
    readingState: detail.progress?.state ?? "unread",
    canonicalUrl: detail.actions.openOriginal ? detail.canonicalUrl : null,
    provenance: detail.provenance.slice(0, AGENT_PROVENANCE_LIMIT).map((entry) => ({
      source: entry.source,
      savedAt: entry.sourceSavedAt ?? entry.firstObservedAt,
      tags: entry.tags.slice(0, AGENT_TAG_LIMIT).map((tag) => tag.name.slice(0, AGENT_TAG_CHARS)),
      notes: entry.notes.slice(0, AGENT_NOTE_LIMIT).map((note) => note.body.slice(0, AGENT_NOTE_CHARS)),
    })),
    text,
    truncated,
    totalTextLength,
  };
}

export function updateReadingProgress(
  db: Db,
  libraryId: string,
  documentId: string,
  change: { op?: unknown; progress?: unknown; anchor?: unknown },
): ReadingProgress | null {
  const row = db
    .prepare(
      `SELECT id, content_blocks FROM reading_documents WHERE library_id = ? AND id = ? AND removed_at IS NULL`,
    )
    .get(libraryId, documentId) as { id: string; content_blocks: string | null } | undefined;
  if (!row) throw new MissingResource("document");
  const op = change.op;
  if (op !== "advance" && op !== "unread" && op !== "finished") {
    throw new RejectedPayload("invalid progress op");
  }
  const existing = db
    .prepare(
      `SELECT state, progress, anchor, first_opened_at, last_opened_at, finished_at
         FROM reading_progress WHERE library_id = ? AND document_id = ?`,
    )
    .get(libraryId, documentId) as
    | {
        state: string;
        progress: number;
        anchor: string | null;
        first_opened_at: string | null;
        last_opened_at: string | null;
        finished_at: string | null;
      }
    | undefined;
  const now = nowIso();
  if (op === "unread") {
    db.prepare(`DELETE FROM reading_progress WHERE library_id = ? AND document_id = ?`).run(libraryId, documentId);
    return null;
  }
  const blocks = parseStoredBlocks(row.content_blocks);
  const anchor = parseAnchor(change.anchor, blocks);
  if (op === "finished") {
    const progress = 1;
    const storedAnchor = anchor ?? existing?.anchor ?? null;
    db.prepare(
      `INSERT INTO reading_progress (
         library_id, document_id, state, progress, anchor, first_opened_at, last_opened_at, finished_at, updated_at
       ) VALUES (?, ?, 'finished', ?, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, document_id) DO UPDATE SET
         state = 'finished', progress = 1, anchor = excluded.anchor,
         last_opened_at = excluded.last_opened_at, finished_at = excluded.finished_at, updated_at = excluded.updated_at`,
    ).run(
      libraryId,
      documentId,
      progress,
      storedAnchor,
      existing?.first_opened_at ?? now,
      now,
      now,
      now,
    );
    return {
      state: "finished",
      progress,
      anchor: storedAnchor,
      firstOpenedAt: existing?.first_opened_at ?? now,
      lastOpenedAt: now,
      finishedAt: now,
    };
  }
  const current = Number(existing?.progress ?? 0);
  const next = parseProgress(change.progress) ?? current;
  if (next < current) throw new RejectedPayload("invalid progress");
  const state = existing?.state === "finished" ? "finished" : "reading";
  const storedAnchor = anchor ?? existing?.anchor ?? null;
  const firstOpenedAt = existing?.first_opened_at ?? now;
  const finishedAt = state === "finished" ? (existing?.finished_at ?? now) : existing?.finished_at ?? null;
  db.prepare(
    `INSERT INTO reading_progress (
       library_id, document_id, state, progress, anchor, first_opened_at, last_opened_at, finished_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(library_id, document_id) DO UPDATE SET
       state = excluded.state, progress = excluded.progress, anchor = excluded.anchor,
       last_opened_at = excluded.last_opened_at, updated_at = excluded.updated_at`,
  ).run(libraryId, documentId, state, next, storedAnchor, firstOpenedAt, now, finishedAt, now);
  return {
    state,
    progress: next,
    anchor: storedAnchor,
    firstOpenedAt,
    lastOpenedAt: now,
    finishedAt,
  };
}

export function removeReadingDocument(
  db: Db,
  libraryId: string,
  documentId: string,
): { undoToken: string; undoExpiresAt: string } {
  const row = db
    .prepare(`SELECT id FROM reading_documents WHERE library_id = ? AND id = ? AND removed_at IS NULL`)
    .get(libraryId, documentId) as { id: string } | undefined;
  if (!row) throw new MissingResource("document");
  const now = nowIso();
  const undoToken = newId();
  const undoExpiresAt = new Date(Date.now() + UNDO_WINDOW_MS).toISOString();
  db.prepare(
    `UPDATE reading_documents SET removed_at = ?, undo_token = ?, undo_expires_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, undoToken, undoExpiresAt, now, documentId);
  wakeReadingWorker(db);
  return { undoToken, undoExpiresAt };
}

export function undoRemoveReadingDocument(db: Db, libraryId: string, undoToken: string): ReadingSummary {
  const token = undoToken.trim();
  if (!token) throw new MissingResource("document");
  const now = nowIso();
  const row = db
    .prepare(
      `${LIST_SELECT}
       WHERE d.library_id = ? AND d.undo_token = ? AND d.removed_at IS NOT NULL
         AND d.undo_expires_at IS NOT NULL AND d.undo_expires_at > ?`,
    )
    .get(libraryId, token, now) as DocumentRow | undefined;
  if (!row) throw new MissingResource("document");
  db.prepare(
    `UPDATE reading_documents SET removed_at = NULL, undo_token = NULL, undo_expires_at = NULL, updated_at = ? WHERE id = ?`,
  ).run(now, row.id);
  const restored = { ...row, removed_at: null };
  const summary = toSummary(db, libraryId, restored);
  if (!summary) throw new MissingResource("document");
  return summary;
}

const DOCUMENT_SELECT = `
  SELECT d.id, d.library_id, d.canonical_url, d.observed_url, d.final_url, d.kind, d.availability, d.failure_code,
         d.original_status, d.original_checked_at, d.title, d.subtitle, d.byline, d.publication, d.published_at,
         d.language, d.excerpt, d.word_count, d.reading_minutes, d.last_saved_at, d.fetched_at, d.updated_at,
         d.removed_at, d.content_blocks, d.hero_asset_id,
         p.state AS progress_state, p.progress AS progress_value, p.anchor AS progress_anchor
    FROM reading_documents d
    LEFT JOIN reading_progress p ON p.library_id = d.library_id AND p.document_id = d.id
`;

const LIST_SELECT = `
  SELECT d.id, d.library_id, d.canonical_url, d.observed_url, d.final_url, d.kind, d.availability, d.failure_code,
         d.original_status, d.original_checked_at, d.title, d.subtitle, d.byline, d.publication, d.published_at,
         d.language, d.excerpt, d.word_count, d.reading_minutes, d.last_saved_at, d.fetched_at, d.updated_at,
         d.removed_at, (d.content_blocks IS NOT NULL AND length(d.content_blocks) > 0) AS has_stored_text,
         NULL AS content_blocks, d.hero_asset_id,
         p.state AS progress_state, p.progress AS progress_value, p.anchor AS progress_anchor
    FROM reading_documents d
    LEFT JOIN reading_progress p ON p.library_id = d.library_id AND p.document_id = d.id
`;

function attachCandidate(
  db: Db,
  libraryId: string,
  item: { id: string; title: string | null; body: string | null; url: string },
  candidate: { observedUrl: string; canonicalUrl: string; kind: "article" | "pdf" },
  savedAt: string,
): void {
  const now = nowIso();
  let doc = db
    .prepare(`SELECT * FROM reading_documents WHERE library_id = ? AND canonical_url = ?`)
    .get(libraryId, candidate.canonicalUrl) as
    | {
        id: string;
        availability: string;
        failure_code: string | null;
        title: string | null;
        removed_at: string | null;
        last_saved_at: string;
        updated_at: string;
      }
    | undefined;

  const hint = previewHint(db, candidate);
  const classified = classifyLocal(candidate, item, hint);

  if (!doc) {
    const id = newId();
    db.prepare(
      `INSERT INTO reading_documents (
        id, library_id, canonical_url, observed_url, final_url, kind, availability, failure_code,
        original_status, title, publication, last_saved_at, next_attempt_at, created_at, updated_at
      ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?)`,
    ).run(
      id,
      libraryId,
      candidate.canonicalUrl,
      candidate.observedUrl,
      classified.kind,
      classified.availability,
      classified.failureCode,
      classified.title,
      hostOf(candidate.canonicalUrl),
      savedAt,
      classified.availability === "pending" ? now : null,
      now,
      now,
    );
    doc = {
      id,
      availability: classified.availability,
      failure_code: classified.failureCode,
      title: classified.title,
      removed_at: null,
      last_saved_at: savedAt,
      updated_at: now,
    };
  } else if (!doc.removed_at) {
    const hasProgress = db
      .prepare(`SELECT 1 AS ok FROM reading_progress WHERE library_id = ? AND document_id = ?`)
      .get(libraryId, doc.id) as { ok: number } | undefined;
    if (!hasProgress && savedAt > doc.last_saved_at) {
      db.prepare(`UPDATE reading_documents SET last_saved_at = ?, updated_at = ? WHERE id = ?`).run(savedAt, now, doc.id);
    }
    if (doc.availability === "pending" && classified.availability === "blocked") {
      db.prepare(
        `UPDATE reading_documents SET availability = ?, failure_code = ?, title = ?, updated_at = ? WHERE id = ?`,
      ).run(classified.availability, classified.failureCode, classified.title, now, doc.id);
    }
  }

  db.prepare(
    `INSERT OR IGNORE INTO reading_provenance (library_id, document_id, item_id, observed_url, discovered_at)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(libraryId, doc.id, item.id, candidate.observedUrl, now);
}

function classifyLocal(
  candidate: { canonicalUrl: string; kind: "article" | "pdf" },
  item: { title: string | null },
  hint: { title: string | null; status: string | null },
): { kind: ReadingKind; availability: ReadingAvailability; failureCode: string | null; title: string } {
  const host = hostOf(candidate.canonicalUrl);
  const fallback = item.title?.trim() || host;
  if (candidate.kind === "pdf") {
    return { kind: "pdf", availability: "metadata_only", failureCode: null, title: fallback };
  }
  if (isChallengeTitle(hint.title)) {
    return { kind: "article", availability: "blocked", failureCode: "blocked_challenge", title: fallback };
  }
  const title = hint.status === "ok" && hint.title && !isChallengeTitle(hint.title) ? hint.title : fallback;
  return { kind: "article", availability: "pending", failureCode: null, title };
}

function previewHint(db: Db, candidate: { observedUrl: string; canonicalUrl: string }): { title: string | null; status: string | null } {
  const row = db
    .prepare(`SELECT title, status FROM link_previews WHERE url = ? OR url = ? LIMIT 1`)
    .get(candidate.observedUrl, candidate.canonicalUrl) as { title: string | null; status: string | null } | undefined;
  return row ?? { title: null, status: null };
}

function maybeDeleteOrphan(db: Db, libraryId: string, documentId: string): void {
  const doc = db
    .prepare(`SELECT removed_at FROM reading_documents WHERE id = ? AND library_id = ?`)
    .get(documentId, libraryId) as { removed_at: string | null } | undefined;
  if (!doc || doc.removed_at) return;
  const provenance = db
    .prepare(`SELECT 1 FROM reading_provenance WHERE library_id = ? AND document_id = ? LIMIT 1`)
    .get(libraryId, documentId);
  if (provenance) return;
  const progress = db
    .prepare(`SELECT 1 FROM reading_progress WHERE library_id = ? AND document_id = ? LIMIT 1`)
    .get(libraryId, documentId);
  if (progress) return;
  db.prepare(`DELETE FROM reading_documents WHERE id = ?`).run(documentId);
}

function countReading(db: Db, libraryId: string, query: ReadingListQuery = {}): ReadingPageResult["counts"] {
  const n = (extra: ListExtra): number => {
    const { sql, params } = matchingWhere(libraryId, query, extra, null);
    return Number((db.prepare(`SELECT COUNT(*) AS n FROM reading_documents d
      LEFT JOIN reading_progress p ON p.library_id = d.library_id AND p.document_id = d.id
      ${sql}`).get(...params) as { n: number }).n);
  };
  return {
    unread: n({ availability: "ready", unreadOnly: true }),
    reading: n({ openedOnly: true }),
    preparing: n({ availability: "pending" }),
    finished: n({ finishedOnly: true }),
  };
}

const HIDDEN_FROM_LIST = `(d.availability IN ('metadata_only', 'blocked', 'unsupported', 'error') OR (d.kind IN ('unknown', 'pdf') AND d.availability <> 'pending'))`;

type ListExtra = {
  availability?: string;
  unreadOnly?: boolean;
  finishedOnly?: boolean;
  openedOnly?: boolean;
  includeHidden?: boolean;
};

function loadDocumentPage(
  db: Db,
  libraryId: string,
  query: ReadingListQuery,
  extra: ListExtra,
  limit: number,
): { rows: DocumentRow[]; nextCursor: string | null } {
  const sort = query.sort ?? "recent";
  const cursor = decodeCursor(query.cursor, sort);
  const { sql, params } = matchingWhere(libraryId, query, extra, cursor);
  const order = orderSql(sort);
  const rows = db.prepare(`${LIST_SELECT} ${sql} ${order} LIMIT ?`).all(...params, limit + 1) as DocumentRow[];
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor({ sort, k: cursorKey(last, sort), id: last.id }) : null,
  };
}

function pageDocuments(
  db: Db,
  libraryId: string,
  query: ReadingListQuery,
  extra: ListExtra,
  limit: number,
): { items: ReadingSummary[]; nextCursor: string | null } {
  const page = loadDocumentPage(db, libraryId, query, extra, limit);
  return { items: hydrateSummaries(db, libraryId, page.rows), nextCursor: page.nextCursor };
}

function selectDocuments(
  db: Db,
  libraryId: string,
  query: ReadingListQuery,
  extra: ListExtra,
  limit: number,
): ReadingSummary[] {
  const { sql, params } = matchingWhere(libraryId, query, extra, null);
  const rows = db.prepare(`${LIST_SELECT} ${sql} ${orderSql(query.sort)} LIMIT ?`).all(...params, limit) as DocumentRow[];
  return hydrateSummaries(db, libraryId, rows);
}

function matchingWhere(
  libraryId: string,
  query: ReadingListQuery,
  extra: ListExtra,
  cursor: Cursor | null,
): { sql: string; params: Array<string | number> } {
  const where = [`d.library_id = ?`, `d.removed_at IS NULL`];
  const params: Array<string | number> = [libraryId];
  if (extra.availability) {
    where.push(`d.availability = ?`);
    params.push(extra.availability);
  }
  if (!extra.includeHidden) where.push(`NOT (${HIDDEN_FROM_LIST})`);
  if (extra.unreadOnly) {
    where.push(`(p.document_id IS NULL OR p.state = 'reading')`);
    if (!extra.includeHidden) where.push(`d.kind NOT IN ('unknown', 'pdf')`);
  }
  if (extra.openedOnly) where.push(`d.availability = 'ready' AND p.state = 'reading' AND d.kind NOT IN ('unknown', 'pdf')`);
  if (extra.finishedOnly) where.push(`p.state = 'finished'`);
  if (query.kind) {
    where.push(`d.kind = ?`);
    params.push(query.kind);
  }
  if (query.source) {
    where.push(`EXISTS (
      SELECT 1 FROM reading_provenance rp
        JOIN source_records sr ON sr.item_id = rp.item_id
        JOIN source_accounts sa ON sa.id = sr.source_account_id
       WHERE rp.library_id = d.library_id AND rp.document_id = d.id AND sa.source = ?
    )`);
    params.push(query.source);
  }
  if (query.q?.trim()) {
    const like = `%${query.q.trim()}%`;
    where.push(`(
      d.title LIKE ? OR d.subtitle LIKE ? OR d.byline LIKE ? OR d.publication LIKE ? OR d.excerpt LIKE ?
      OR d.search_text LIKE ? OR d.canonical_url LIKE ?
      OR EXISTS (
        SELECT 1 FROM reading_provenance rp
          JOIN items i ON i.id = rp.item_id
          LEFT JOIN notes n ON n.item_id = i.id
          LEFT JOIN memberships m ON m.item_id = i.id AND m.target_kind = 'tag'
          LEFT JOIN tags t ON t.id = m.target_id
         WHERE rp.library_id = d.library_id AND rp.document_id = d.id
           AND (i.title LIKE ? OR i.body LIKE ? OR n.body LIKE ? OR t.name LIKE ?)
      )
    )`);
    params.push(like, like, like, like, like, like, like, like, like, like, like);
  }
  if (cursor) {
    const clause = cursorWhere(query.sort ?? "recent", cursor);
    where.push(clause.sql);
    params.push(...clause.params);
  }
  return { sql: `WHERE ${where.join(" AND ")}`, params };
}

function orderSql(sort: ReadingSort | undefined): string {
  switch (sort) {
    case "oldest":
      return `ORDER BY d.last_saved_at ASC, d.id ASC`;
    case "shortest":
      return `ORDER BY d.reading_minutes IS NULL, d.reading_minutes ASC, d.id ASC`;
    case "longest":
      return `ORDER BY d.reading_minutes IS NULL, d.reading_minutes DESC, d.id ASC`;
    case "publication":
      return `ORDER BY COALESCE(d.publication, '') ASC, d.id ASC`;
    default:
      return `ORDER BY d.last_saved_at DESC, d.id DESC`;
  }
}

function cursorKey(row: DocumentRow, sort: ReadingSort): string {
  if (sort === "shortest" || sort === "longest") return row.reading_minutes == null ? "" : String(row.reading_minutes);
  if (sort === "publication") return row.publication ?? "";
  return row.last_saved_at;
}

function cursorWhere(sort: ReadingSort, cursor: Cursor): { sql: string; params: Array<string | number> } {
  if (sort === "oldest") {
    return {
      sql: `(d.last_saved_at > ? OR (d.last_saved_at = ? AND d.id > ?))`,
      params: [cursor.k, cursor.k, cursor.id],
    };
  }
  if (sort === "publication") {
    return {
      sql: `(COALESCE(d.publication, '') > ? OR (COALESCE(d.publication, '') = ? AND d.id > ?))`,
      params: [cursor.k, cursor.k, cursor.id],
    };
  }
  if (sort === "shortest") {
    if (cursor.k === "") return { sql: `(d.reading_minutes IS NULL AND d.id > ?)`, params: [cursor.id] };
    const minutes = Number(cursor.k);
    return {
      sql: `(
        (d.reading_minutes IS NOT NULL AND d.reading_minutes > ?)
        OR (d.reading_minutes = ? AND d.id > ?)
        OR d.reading_minutes IS NULL
      )`,
      params: [minutes, minutes, cursor.id],
    };
  }
  if (sort === "longest") {
    if (cursor.k === "") return { sql: `(d.reading_minutes IS NULL AND d.id > ?)`, params: [cursor.id] };
    const minutes = Number(cursor.k);
    return {
      sql: `(
        (d.reading_minutes IS NOT NULL AND d.reading_minutes < ?)
        OR (d.reading_minutes = ? AND d.id > ?)
        OR d.reading_minutes IS NULL
      )`,
      params: [minutes, minutes, cursor.id],
    };
  }
  return {
    sql: `(d.last_saved_at < ? OR (d.last_saved_at = ? AND d.id < ?))`,
    params: [cursor.k, cursor.k, cursor.id],
  };
}

function hydrateSummaries(db: Db, libraryId: string, rows: DocumentRow[]): ReadingSummary[] {
  const summaries: ReadingSummary[] = [];
  for (const row of rows) {
    const summary = toSummary(db, libraryId, row);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

function toSummary(db: Db, libraryId: string, row: DocumentRow): ReadingSummary | null {
  if (!isLiveDocument(row)) {
    diagnostics.malformedRows += 1;
    return null;
  }
  const marks = db
    .prepare(
      `SELECT rp.item_id, sa.source
         FROM reading_provenance rp
         LEFT JOIN source_records sr ON sr.item_id = rp.item_id
         LEFT JOIN source_accounts sa ON sa.id = sr.source_account_id
        WHERE rp.library_id = ? AND rp.document_id = ?`,
    )
    .all(libraryId, row.id) as { item_id: string; source: string | null }[];
  const sources = [...new Set(marks.map((mark) => mark.source).filter((source): source is string => Boolean(source)))];
  const title = displayTitle(row);
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    title,
    subtitle: row.subtitle,
    byline: row.byline,
    publication: row.publication,
    host: hostOf(row.canonical_url),
    kind: row.kind as ReadingKind,
    availability: row.availability as ReadingAvailability,
    failureCode: row.failure_code,
    originalStatus: row.original_status,
    excerpt: trustedExcerpt(row),
    wordCount: row.word_count,
    readingMinutes: row.reading_minutes,
    lastSavedAt: row.last_saved_at,
    sources,
    savedCount: new Set(marks.map((mark) => mark.item_id)).size,
    heroAssetId: row.hero_asset_id,
    progress:
      row.progress_state === "reading" || row.progress_state === "finished"
        ? { state: row.progress_state, progress: Number(row.progress_value ?? 0) }
        : null,
  };
}

function toAgentSummary(db: Db, libraryId: string, row: DocumentRow): AgentReadingSummary | null {
  const summary = toSummary(db, libraryId, row);
  if (!summary) return null;
  return {
    id: summary.id,
    title: summary.title,
    publication: summary.publication,
    host: summary.host,
    excerpt: summary.excerpt,
    kind: summary.kind,
    availability: summary.availability,
    hasStoredText: Boolean(row.has_stored_text),
    readingMinutes: summary.readingMinutes,
    lastSavedAt: summary.lastSavedAt,
    sources: summary.sources,
    readingState: summary.progress?.state ?? "unread",
    canonicalUrl: canOpenOriginal(row) ? summary.canonicalUrl : null,
  };
}

function isLiveDocument(row: DocumentRow): boolean {
  const kinds: ReadingKind[] = ["article", "documentation", "repository", "pdf", "unknown"];
  const avail: ReadingAvailability[] = ["pending", "ready", "metadata_only", "blocked", "unsupported", "error"];
  return kinds.includes(row.kind as ReadingKind) && avail.includes(row.availability as ReadingAvailability);
}

function displayTitle(row: Pick<DocumentRow, "title" | "failure_code" | "canonical_url">): string {
  const title = row.title?.trim() ?? "";
  if (title && (row.failure_code !== "blocked_challenge" || !isChallengeTitle(title))) return title;
  return hostOf(row.canonical_url);
}

function trustedExcerpt(row: Pick<DocumentRow, "excerpt" | "availability" | "failure_code">): string | null {
  if (row.availability === "ready") return row.excerpt;
  if (row.failure_code === "paywall_or_consent") return row.excerpt;
  return null;
}

function canOpenOriginal(row: DocumentRow): boolean {
  if (row.failure_code === "gone" || row.original_status === "gone") return false;
  if (row.failure_code === "unsafe_target") return false;
  try {
    const u = new URL(row.canonical_url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function loadProvenance(db: Db, libraryId: string, documentId: string): ReadingProvenance[] {
  const rows = db
    .prepare(
      `SELECT item_id, observed_url FROM reading_provenance WHERE library_id = ? AND document_id = ? ORDER BY discovered_at`,
    )
    .all(libraryId, documentId) as { item_id: string; observed_url: string }[];
  return rows.flatMap((row) => {
    const item = getItem(db, row.item_id);
    if (!item) return [];
    return [
      {
        itemId: item.id,
        observedUrl: row.observed_url,
        title: item.title,
        body: item.body,
        source: String(item.source),
        authorName: item.authorName,
        authorHandle: item.authorHandle,
        permalink: item.url,
        firstObservedAt: item.firstObservedAt,
        sourceSavedAt: item.sourceSavedAt,
        capturedAt: item.capturedAt,
        tags: item.tags.map((tag) => ({ id: tag.id, name: tag.name })),
        notes: item.notes.map((note) => ({ id: note.id, body: note.body })),
      },
    ];
  });
}

const MAX_TITLE = 500;
const MAX_HANDLE = 200;
const MAX_NAME = 200;
const READING_ARCHIVE_ID = /^[A-Za-z0-9_-]{1,128}$/;
const READING_ARCHIVE_KINDS = new Set(["article", "documentation", "repository", "pdf", "unknown"]);
const READING_ARCHIVE_AVAILABILITY = new Set(["pending", "ready", "metadata_only", "blocked", "unsupported", "error"]);
const READING_ARCHIVE_FAILURES = new Set([
  "blocked_challenge",
  "authentication_required",
  "paywall_or_consent",
  "not_found",
  "gone",
  "unsupported_content_type",
  "not_article_like",
  "unsafe_target",
  "timeout",
  "network_error",
  "parse_error",
  "empty_content",
]);
const READING_ARCHIVE_ORIGINAL_STATUSES = new Set([
  "unknown",
  "reachable",
  "not_found",
  "gone",
  "blocked",
  "authentication_required",
  "paywall_or_consent",
  "error",
]);
const READING_ARCHIVE_ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;

type ReadingArchiveRow = {
  id: string;
  canonical_url: string;
  observed_url: string;
  kind: string;
  availability: string;
  removed_at: string | null;
  last_saved_at: string;
  created_at: string;
  updated_at: string;
  final_url: string | null;
  failure_code: string | null;
  original_status: string;
  original_checked_at: string | null;
  title: string | null;
  subtitle: string | null;
  byline: string | null;
  publication: string | null;
  published_at: string | null;
  language: string | null;
  excerpt: string | null;
  search_text: string | null;
  word_count: number | null;
  reading_minutes: number | null;
  content_blocks: string | null;
  fetched_at: string | null;
};

type ReadingArchiveProvenanceRow = {
  document_id: string;
  item_id: string;
  observed_url: string;
  discovered_at: string;
};

type ReadingArchiveProgressRow = {
  document_id: string;
  state: string;
  progress: number;
  anchor: string | null;
  first_opened_at: string | null;
  last_opened_at: string | null;
  finished_at: string | null;
  updated_at: string;
};

function validateReadingArchiveRecords(
  documents: readonly ReadingArchiveRecord[],
  provenance: readonly ReadingArchiveRecord[],
  progress: readonly ReadingArchiveRecord[],
  itemIds: ReadonlySet<string>,
): void {
  const documentIds = new Set<string>();
  const canonicalUrls = new Set<string>();
  const tombstones = new Set<string>();
  const liveDocuments = new Set<string>();
  for (const row of documents) {
    if (row.kind !== "readingDocument") throw new RejectedPayload("unknown reading archive record kind");
    const id = reqReadingId(row.id);
    if (documentIds.has(id)) throw new RejectedPayload("duplicate archive record");
    documentIds.add(id);
    const canonical = reqReadingPublicUrl(row.canonicalUrl);
    if (canonicalUrls.has(canonical)) throw new RejectedPayload("duplicate canonical URL");
    canonicalUrls.add(canonical);
    reqReadingPublicUrl(row.observedUrl);
    reqReadingKind(row.kindName);
    reqReadingAvailability(row.availability);
    optReadingPublicUrl(row.finalUrl);
    optReadingFailureCode(row.failureCode);
    if (row.originalStatus != null) reqReadingOriginalStatus(row.originalStatus);
    reqReadingIso(row.lastSavedAt);
    reqReadingIso(row.createdAt);
    reqReadingIso(row.updatedAt);
    const removedAt = optReadingIso(row.removedAt);
    optReadingIso(row.fetchedAt);
    optReadingIso(row.originalCheckedAt);
    optReadingIso(row.publishedAt);
    if (removedAt) tombstones.add(id);
    else liveDocuments.add(id);
  }
  const provenanceKeys = new Set<string>();
  for (const row of provenance) {
    if (row.kind !== "readingProvenance") throw new RejectedPayload("unknown reading archive record kind");
    const documentId = reqReadingId(row.documentId);
    const itemId = reqReading(row.itemId, 128);
    if (!documentIds.has(documentId) || !itemIds.has(itemId)) throw new RejectedPayload("missing related readingProvenance record");
    const key = `${documentId}\0${itemId}`;
    if (provenanceKeys.has(key)) throw new RejectedPayload("duplicate archive record");
    provenanceKeys.add(key);
    reqReadingPublicUrl(row.observedUrl);
    reqReadingIso(row.discoveredAt);
  }
  const progressKeys = new Set<string>();
  for (const row of progress) {
    if (row.kind !== "readingProgress") throw new RejectedPayload("unknown reading archive record kind");
    const documentId = reqReadingId(row.documentId);
    if (progressKeys.has(documentId)) throw new RejectedPayload("duplicate archive record");
    if (!tombstones.has(documentId) && !liveDocuments.has(documentId)) {
      throw new RejectedPayload("missing related readingProgress record");
    }
    progressKeys.add(documentId);
    reqReadingProgressState(row.state);
    const value = Number(row.progress);
    if (!Number.isFinite(value) || value < 0 || value > 1) throw new RejectedPayload("invalid reading progress");
    reqReadingIso(row.updatedAt);
    optReadingIso(row.firstOpenedAt);
    optReadingIso(row.lastOpenedAt);
    optReadingIso(row.finishedAt);
  }
}

function importedReadingBlocks(raw: unknown): ReadingContent | null {
  if (raw == null) return null;
  const content = validateContent(raw);
  if (!content) throw new RejectedPayload("unsafe reading content");
  return dropMissingImages(content, new Set());
}

function importedReadingSearch(raw: unknown): string | null {
  if (raw == null) return null;
  if (typeof raw !== "string") throw new RejectedPayload("invalid search text");
  if (raw.length > MAX_SEARCH_TEXT) throw new RejectedPayload("search text too long");
  return raw;
}

function reqReadingId(value: unknown): string {
  const id = reqReading(value, 128);
  if (!READING_ARCHIVE_ID.test(id)) throw new RejectedPayload("invalid archive id");
  return id;
}

function reqReadingPublicUrl(value: unknown): string {
  const raw = reqReading(value, 2_000);
  if (!cleanupUrl(raw)) throw new RejectedPayload("invalid archive url");
  return raw;
}

function optReadingPublicUrl(value: unknown): string | null {
  if (value == null || value === "") return null;
  return reqReadingPublicUrl(value);
}

function reqReadingKind(value: unknown): string {
  const kind = reqReading(value, 40);
  if (!READING_ARCHIVE_KINDS.has(kind)) throw new RejectedPayload("invalid reading kind");
  return kind;
}

function reqReadingAvailability(value: unknown): string {
  const availability = reqReading(value, 40);
  if (!READING_ARCHIVE_AVAILABILITY.has(availability)) throw new RejectedPayload("invalid reading availability");
  return availability;
}

function optReadingFailureCode(value: unknown): string | null {
  if (value == null || value === "") return null;
  const code = reqReading(value, 80);
  if (!READING_ARCHIVE_FAILURES.has(code)) throw new RejectedPayload("invalid reading failure");
  return code;
}

function reqReadingOriginalStatus(value: unknown): string {
  if (value == null || value === "") return "unknown";
  const status = reqReading(value, 80);
  if (!READING_ARCHIVE_ORIGINAL_STATUSES.has(status)) throw new RejectedPayload("invalid original status");
  return status;
}

function reqReadingProgressState(value: unknown): string {
  const state = reqReading(value, 40);
  if (state !== "reading" && state !== "finished") throw new RejectedPayload("invalid reading progress");
  return state;
}

function reqReadingIso(value: unknown): string {
  const raw = reqReading(value, 40);
  if (!READING_ARCHIVE_ISO.test(raw) || Number.isNaN(Date.parse(raw))) throw new RejectedPayload("invalid archive timestamp");
  return raw;
}

function optReadingIso(value: unknown): string | null {
  if (value == null || value === "") return null;
  return reqReadingIso(value);
}

function reqReading(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new RejectedPayload("invalid archive field");
  return value;
}

function optReading(value: unknown, max: number): string | null {
  if (value == null) return null;
  if (typeof value !== "string" || value.length > max) throw new RejectedPayload("invalid archive field");
  return value;
}

function intReadingOrNull(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new RejectedPayload("invalid archive field");
  return Math.floor(value);
}

function parseAgentListQuery(query: ReadingListQuery): ReadingListQuery & { view: ReadingView; sort: ReadingSort; limit: number } {
  const view = query.view;
  if (view != null && view !== "queue" && view !== "finished") throw new RejectedPayload("invalid view");
  const sort = query.sort;
  if (sort != null && !AGENT_SORTS.includes(sort)) throw new RejectedPayload("invalid sort");
  const kind = query.kind;
  if (kind != null && !AGENT_KINDS.includes(kind as ReadingKind)) throw new RejectedPayload("invalid kind");
  const source = query.source;
  if (source != null && (typeof source !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/i.test(source))) {
    throw new RejectedPayload("invalid source");
  }
  const q = query.q;
  if (q != null && (typeof q !== "string" || q.length > AGENT_QUERY_MAX)) throw new RejectedPayload("invalid query");
  const limit = query.limit;
  if (limit != null && (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > AGENT_READING_LIST_LIMIT)) {
    throw new RejectedPayload("invalid limit");
  }
  const resolvedSort = sort ?? "recent";
  if (query.cursor != null && !decodeCursor(query.cursor, resolvedSort)) throw new RejectedPayload("invalid cursor");
  return {
    ...query,
    view: view === "finished" ? "finished" : "queue",
    sort: resolvedSort,
    limit: limit ?? AGENT_READING_LIST_LIMIT,
  };
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

function parseStoredBlocks(raw: string | null): ReadingContent | null {
  if (!raw) return null;
  try {
    return validateContent(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

function decodeCursor(raw: string | undefined, sort: ReadingSort): Cursor | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Partial<Cursor> & { lastSavedAt?: string };
    const id = value.id;
    if (typeof id !== "string") return null;
    if (typeof value.k === "string") {
      const cursorSort = value.sort === "oldest" || value.sort === "shortest" || value.sort === "longest" || value.sort === "publication" || value.sort === "recent"
        ? value.sort
        : sort;
      if (cursorSort !== sort) return null;
      return { sort: cursorSort, k: value.k, id };
    }
    if (typeof value.lastSavedAt === "string" && (sort === "recent" || sort === "oldest")) {
      return { sort, k: value.lastSavedAt, id };
    }
    return null;
  } catch {
    return null;
  }
}

function parseProgress(raw: unknown): number | undefined {
  if (raw == null) return undefined;
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    throw new RejectedPayload("invalid progress");
  }
  return raw;
}

function parseAnchor(raw: unknown, blocks: ReadingContent | null): string | null {
  if (raw == null || raw === "") return null;
  let rec: { blockId?: unknown; offset?: unknown };
  if (typeof raw === "string") {
    if (raw.length > 500) throw new RejectedPayload("invalid anchor");
    try {
      rec = JSON.parse(raw) as { blockId?: unknown; offset?: unknown };
    } catch {
      throw new RejectedPayload("invalid anchor");
    }
  } else if (typeof raw === "object") {
    rec = raw as { blockId?: unknown; offset?: unknown };
  } else {
    throw new RejectedPayload("invalid anchor");
  }
  if (typeof rec.blockId !== "string" || rec.blockId.length === 0 || rec.blockId.length > 80) {
    throw new RejectedPayload("invalid anchor");
  }
  const offset = rec.offset == null ? 0 : rec.offset;
  if (typeof offset !== "number" || !Number.isFinite(offset) || offset < 0 || offset > 1) {
    throw new RejectedPayload("invalid anchor");
  }
  if (blocks && !hasBlockId(blocks.blocks, rec.blockId)) throw new RejectedPayload("invalid anchor");
  return JSON.stringify({ v: 1, blockId: rec.blockId, offset });
}
