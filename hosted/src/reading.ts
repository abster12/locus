import { MissingResource, nowIso } from "./desk.ts";
import { collectText, contentHash, hasBlockId, readingMinutes, remapAnchor, tocFrom, validateContent, wordCountOf, type ReadingContent } from "../../server/reading/blocks.ts";
import {
  classifyFetchedPage,
  isHtmlContentType,
  isPdfContentType,
  isTransient,
  originalStatusFor,
  type ReadingFailureCode,
} from "../../server/reading/classify.ts";
import { extractPage, qualifiesAsReadable } from "../../server/reading/extract-page.ts";
import {
  cleanupUrl,
  discoverCandidates,
  hostOf,
  isApprovedAlias,
  isChallengeTitle,
  itemUrlCandidate,
  type ReadingKind,
} from "../../server/reading/policy.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { fetchReadingPage, ReadingFetchError } from "./reading-fetch.ts";

export const UNDO_WINDOW_MS = 30_000;
const AGENT_READING_TEXT_LIMIT = 30_000;
const AGENT_READING_LIST_LIMIT = 50;
const AGENT_QUERY_MAX = 200;
const AGENT_PROVENANCE_LIMIT = 5;
const AGENT_NOTE_LIMIT = 2;
const AGENT_NOTE_CHARS = 240;
const AGENT_TAG_LIMIT = 8;
const AGENT_TAG_CHARS = 80;
const LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
const TRANSIENT_RETRIES = 3;
const RETRY_COOLDOWN_MS = 15_000;
const DRAIN_LIMIT = 8;
const BACKFILL_BATCH = 50;
const AGENT_KINDS: ReadingKind[] = ["article", "documentation", "repository", "pdf", "unknown"];
const AGENT_SORTS: ReadingSort[] = ["recent", "oldest", "shortest", "longest", "publication"];

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

export interface ReadingPageResult {
  view: ReadingView;
  preparing: { count: number; preview: ReadingSummary[] };
  unread: { items: ReadingSummary[]; nextCursor: string | null };
  items: ReadingSummary[];
  nextCursor: string | null;
  counts: { unread: number; reading: number; preparing: number; finished: number };
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
  toc: { id: string; level: 2 | 3 | 4; text: string }[];
  heroAssetId: string | null;
  lastSavedAt: string;
  fetchedAt: string | null;
  updatedAt: string;
  progress: { state: "reading" | "finished"; progress: number; anchor: string | null } | null;
  provenance: ReadingProvenance[];
  actions: { openOriginal: boolean; retry: boolean; remove: boolean };
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
  readingState: "unread" | "reading" | "finished";
  canonicalUrl: string | null;
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
  readingState: "unread" | "reading" | "finished";
  canonicalUrl: string | null;
  provenance: { source: string; savedAt: string; tags: string[]; notes: string[] }[];
  text: string | null;
  truncated: boolean;
  totalTextLength: number;
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
  has_stored_text: number | null;
  hero_asset_id: string | null;
  progress_state: string | null;
  progress_value: number | null;
  progress_anchor: string | null;
};

type ListExtra = {
  availability?: string;
  unreadOnly?: boolean;
  finishedOnly?: boolean;
  openedOnly?: boolean;
  includeHidden?: boolean;
};

type Cursor = { sort: ReadingSort; k: string; id: string };

type DocumentWork = {
  id: string;
  library_id: string;
  canonical_url: string;
  observed_url: string;
  final_url: string | null;
  kind: string;
  availability: string;
  failure_code: string | null;
  original_status: string;
  title: string | null;
  content_blocks: string | null;
  content_hash: string | null;
  attempt_count: number;
  fetched_at: string | null;
  lease_expires_at: string | null;
  removed_at: string | null;
};

const HIDDEN_FROM_LIST = `(d.availability IN ('metadata_only', 'blocked', 'unsupported', 'error') OR (d.kind IN ('unknown', 'pdf') AND d.availability <> 'pending'))`;

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

export async function reconcileItem(db: D1Database, libraryId: string, itemId: string): Promise<boolean> {
  const item = await first<{
    id: string;
    title: string | null;
    body: string | null;
    url: string;
    first_observed_at: string;
    captured_at: string | null;
  }>(db, `SELECT id, title, body, url, first_observed_at, captured_at FROM items WHERE id = ? AND library_id = ?`, itemId, libraryId);
  if (!item) return false;

  const discovered = discoverCandidates(item.body, item.url);
  const wanted = new Map(discovered.candidates.map((candidate) => [candidate.canonicalUrl, candidate]));
  const self = itemUrlCandidate(item.url);
  if (self) wanted.set(self.canonicalUrl, self);
  const existing = await all<{ document_id: string; observed_url: string }>(
    db,
    `SELECT document_id, observed_url FROM reading_provenance WHERE library_id = ? AND item_id = ?`,
    libraryId,
    itemId,
  );
  const savedAt = item.captured_at || item.first_observed_at;
  for (const row of existing) {
    const canonical = await first<{ canonical_url: string }>(
      db,
      `SELECT canonical_url FROM reading_documents WHERE id = ? AND library_id = ?`,
      row.document_id,
      libraryId,
    );
    const observedIdentity = cleanupUrl(row.observed_url)?.canonicalUrl;
    const matched = [observedIdentity, canonical?.canonical_url].find((identity) => identity && wanted.has(identity));
    if (matched) {
      wanted.delete(matched);
      await run(
        db,
        `UPDATE reading_documents SET last_saved_at = MAX(last_saved_at, ?), updated_at = MAX(updated_at, ?)
         WHERE id = ? AND library_id = ?`,
        savedAt,
        savedAt,
        row.document_id,
        libraryId,
      );
      continue;
    }
    await run(
      db,
      `DELETE FROM reading_provenance WHERE library_id = ? AND document_id = ? AND item_id = ?`,
      libraryId,
      row.document_id,
      itemId,
    );
    await maybeDeleteOrphan(db, libraryId, row.document_id);
  }

  let created = false;
  for (const candidate of wanted.values()) {
    await attachCandidate(db, libraryId, item, candidate, savedAt);
    created = true;
  }
  return created || discovered.candidates.length > 0;
}

export async function listReadingDocuments(
  db: D1Database,
  libraryId: string,
  query: ReadingListQuery = {},
): Promise<ReadingPageResult> {
  const view = query.view === "finished" ? "finished" : "queue";
  const limit = Math.max(1, Math.min(100, Math.floor(query.limit ?? 50)));
  const counts = await countReading(db, libraryId, query);
  const emptyPage: ReadingPageResult = {
    view,
    preparing: { count: 0, preview: [] },
    unread: { items: [], nextCursor: null },
    items: [],
    nextCursor: null,
    counts,
  };
  if (view === "queue") {
    const preparingRows = await selectDocuments(db, libraryId, query, { availability: "pending" }, 8);
    const unread = await pageDocuments(db, libraryId, query, { availability: "ready", unreadOnly: true }, limit);
    return { ...emptyPage, preparing: { count: counts.preparing, preview: preparingRows }, unread };
  }
  const page = await pageDocuments(db, libraryId, query, { finishedOnly: true }, limit);
  return { ...emptyPage, items: page.items, nextCursor: page.nextCursor };
}

export async function listReadingDocumentsForAgent(
  db: D1Database,
  libraryId: string,
  query: ReadingListQuery = {},
): Promise<{ items: AgentReadingSummary[]; nextCursor: string | null; counts: ReadingPageResult["counts"] }> {
  const parsed = parseAgentListQuery(query);
  const counts = await countReading(db, libraryId, parsed);
  const extra: ListExtra =
    parsed.view === "finished" ? { finishedOnly: true, includeHidden: true } : { unreadOnly: true, includeHidden: true };
  const page = await loadDocumentPage(db, libraryId, parsed, extra, parsed.limit);
  const items: AgentReadingSummary[] = [];
  for (const row of page.rows) {
    const summary = await toAgentSummary(db, libraryId, row);
    if (summary) items.push(summary);
  }
  return { items, nextCursor: page.nextCursor, counts };
}

export async function getReadingDocument(db: D1Database, libraryId: string, documentId: string): Promise<ReadingDocumentDetail> {
  const row = await first<DocumentRow>(
    db,
    `${DOCUMENT_SELECT} WHERE d.library_id = ? AND d.id = ? AND d.removed_at IS NULL`,
    libraryId,
    documentId,
  );
  if (!row || !isLiveDocument(row)) throw new MissingResource("document");
  const summary = await toSummary(db, libraryId, row);
  if (!summary) throw new MissingResource("document");
  const provenance = await loadProvenance(db, libraryId, row.id);
  const parsed = parseStoredBlocks(row.content_blocks);
  const unsupported = Boolean(row.content_blocks) && !parsed;
  const availability = unsupported ? "error" : (row.availability as ReadingAvailability);
  const failureCode = unsupported ? "parse_error" : row.failure_code;
  const retry = failureCode !== "gone" && row.original_status !== "gone" && row.availability !== "pending";
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
    progress:
      row.progress_state === "reading" || row.progress_state === "finished"
        ? { state: row.progress_state, progress: Number(row.progress_value ?? 0), anchor: row.progress_anchor }
        : null,
    provenance,
    actions: { openOriginal: canOpenOriginal(row), retry, remove: true },
  };
}

export async function getAgentReadingDocument(
  db: D1Database,
  libraryId: string,
  documentId: string,
): Promise<AgentReadingDocument> {
  const detail = await getReadingDocument(db, libraryId, documentId);
  const fullText = detail.contentBlocks ? collectText(detail.contentBlocks.blocks) : null;
  const totalTextLength = fullText?.length ?? 0;
  const truncated = totalTextLength > AGENT_READING_TEXT_LIMIT;
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
    text: fullText ? fullText.slice(0, AGENT_READING_TEXT_LIMIT) : null,
    truncated,
    totalTextLength,
  };
}

export async function updateReadingProgress(
  db: D1Database,
  libraryId: string,
  documentId: string,
  change: { op?: unknown; progress?: unknown; anchor?: unknown },
): Promise<{ state: string; progress: number; anchor: string | null } | null> {
  const row = await first<{ id: string; content_blocks: string | null }>(
    db,
    `SELECT id, content_blocks FROM reading_documents WHERE library_id = ? AND id = ? AND removed_at IS NULL`,
    libraryId,
    documentId,
  );
  if (!row) throw new MissingResource("document");
  const op = change.op;
  if (op !== "advance" && op !== "unread" && op !== "finished") throw new RejectedPayload("invalid progress op");
  const existing = await first<{
    state: string;
    progress: number;
    anchor: string | null;
    first_opened_at: string | null;
    last_opened_at: string | null;
    finished_at: string | null;
  }>(
    db,
    `SELECT state, progress, anchor, first_opened_at, last_opened_at, finished_at
       FROM reading_progress WHERE library_id = ? AND document_id = ?`,
    libraryId,
    documentId,
  );
  const now = nowIso();
  if (op === "unread") {
    await run(db, `DELETE FROM reading_progress WHERE library_id = ? AND document_id = ?`, libraryId, documentId);
    return null;
  }
  const blocks = parseStoredBlocks(row.content_blocks);
  const anchor = parseAnchor(change.anchor, blocks);
  if (op === "finished") {
    const storedAnchor = anchor ?? existing?.anchor ?? null;
    await run(
      db,
      `INSERT INTO reading_progress (
         library_id, document_id, state, progress, anchor, first_opened_at, last_opened_at, finished_at, updated_at
       ) VALUES (?, ?, 'finished', 1, ?, ?, ?, ?, ?)
       ON CONFLICT(library_id, document_id) DO UPDATE SET
         state = 'finished', progress = 1, anchor = excluded.anchor,
         last_opened_at = excluded.last_opened_at, finished_at = excluded.finished_at, updated_at = excluded.updated_at`,
      libraryId,
      documentId,
      storedAnchor,
      existing?.first_opened_at ?? now,
      now,
      now,
      now,
    );
    return { state: "finished", progress: 1, anchor: storedAnchor };
  }
  const current = Number(existing?.progress ?? 0);
  const next = parseProgress(change.progress) ?? current;
  if (next < current) throw new RejectedPayload("invalid progress");
  const state = existing?.state === "finished" ? "finished" : "reading";
  const storedAnchor = anchor ?? existing?.anchor ?? null;
  const firstOpenedAt = existing?.first_opened_at ?? now;
  const finishedAt = state === "finished" ? (existing?.finished_at ?? now) : existing?.finished_at ?? null;
  await run(
    db,
    `INSERT INTO reading_progress (
       library_id, document_id, state, progress, anchor, first_opened_at, last_opened_at, finished_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(library_id, document_id) DO UPDATE SET
       state = excluded.state, progress = excluded.progress, anchor = excluded.anchor,
       last_opened_at = excluded.last_opened_at, updated_at = excluded.updated_at`,
    libraryId,
    documentId,
    state,
    next,
    storedAnchor,
    firstOpenedAt,
    now,
    finishedAt,
    now,
  );
  return { state, progress: next, anchor: storedAnchor };
}

export async function removeReadingDocument(
  db: D1Database,
  libraryId: string,
  documentId: string,
): Promise<{ undoToken: string; undoExpiresAt: string }> {
  const row = await first<{ id: string }>(
    db,
    `SELECT id FROM reading_documents WHERE library_id = ? AND id = ? AND removed_at IS NULL`,
    libraryId,
    documentId,
  );
  if (!row) throw new MissingResource("document");
  const now = nowIso();
  const undoToken = crypto.randomUUID();
  const undoExpiresAt = new Date(Date.now() + UNDO_WINDOW_MS).toISOString();
  await run(
    db,
    `UPDATE reading_documents SET removed_at = ?, undo_token = ?, undo_expires_at = ?, updated_at = ? WHERE id = ?`,
    now,
    undoToken,
    undoExpiresAt,
    now,
    documentId,
  );
  return { undoToken, undoExpiresAt };
}

export async function undoRemoveReadingDocument(db: D1Database, libraryId: string, undoToken: string): Promise<ReadingSummary> {
  const token = undoToken.trim();
  if (!token) throw new MissingResource("document");
  const now = nowIso();
  const row = await first<DocumentRow>(
    db,
    `${LIST_SELECT}
     WHERE d.library_id = ? AND d.undo_token = ? AND d.removed_at IS NOT NULL
       AND d.undo_expires_at IS NOT NULL AND d.undo_expires_at > ?`,
    libraryId,
    token,
    now,
  );
  if (!row) throw new MissingResource("document");
  await run(
    db,
    `UPDATE reading_documents SET removed_at = NULL, undo_token = NULL, undo_expires_at = NULL, updated_at = ? WHERE id = ?`,
    now,
    row.id,
  );
  const summary = await toSummary(db, libraryId, { ...row, removed_at: null });
  if (!summary) throw new MissingResource("document");
  return summary;
}

export async function retryReadingDocument(db: D1Database, libraryId: string, documentId: string): Promise<void> {
  const now = nowIso();
  const row = await first<{
    id: string;
    failure_code: string | null;
    lease_expires_at: string | null;
    fetched_at: string | null;
  }>(
    db,
    `SELECT id, failure_code, lease_expires_at, fetched_at FROM reading_documents
      WHERE library_id = ? AND id = ? AND removed_at IS NULL`,
    libraryId,
    documentId,
  );
  if (!row) throw new MissingResource("document");
  if (row.failure_code === "gone") return;
  if (row.lease_expires_at && row.lease_expires_at > now) return;
  if (row.fetched_at && Date.parse(row.fetched_at) + RETRY_COOLDOWN_MS > Date.parse(now)) return;
  await run(
    db,
    `UPDATE reading_documents SET next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ? WHERE id = ?`,
    now,
    now,
    documentId,
  );
}

export async function drainReading(db: D1Database, libraryId?: string, limit = DRAIN_LIMIT): Promise<void> {
  const now = nowIso();
  await cleanupExpiredRemovals(db, now);
  await backfillItemUrls(db, libraryId);
  if (libraryId) await pullForwardOverRetry(db, libraryId, now);
  let drained = 0;
  while (drained < limit) {
    const claimed = await claimDue(db, now, libraryId);
    if (!claimed) break;
    drained += 1;
    try {
      await enrichDocument(db, claimed.library_id, claimed.id);
    } catch (error) {
      const code = error instanceof ReadingFetchError ? error.code : "network_error";
      await applyFailure(db, claimed.library_id, claimed.id, code, nowIso());
    }
  }
}

async function backfillItemUrls(db: D1Database, libraryId?: string): Promise<void> {
  const rows = libraryId
    ? await all<{ id: string; library_id: string }>(
        db,
        `SELECT i.id, i.library_id FROM items i
          WHERE i.library_id = ?
            AND NOT EXISTS (
              SELECT 1 FROM reading_provenance rp
               WHERE rp.item_id = i.id AND rp.library_id = i.library_id
            )
          ORDER BY i.id LIMIT ?`,
        libraryId,
        BACKFILL_BATCH,
      )
    : await all<{ id: string; library_id: string }>(
        db,
        `SELECT i.id, i.library_id FROM items i
          WHERE NOT EXISTS (
            SELECT 1 FROM reading_provenance rp
             WHERE rp.item_id = i.id AND rp.library_id = i.library_id
          )
          ORDER BY i.id LIMIT ?`,
        BACKFILL_BATCH,
      );
  for (const row of rows) await reconcileItem(db, row.library_id, row.id);
}

async function attachCandidate(
  db: D1Database,
  libraryId: string,
  item: { id: string; title: string | null; url: string },
  candidate: { observedUrl: string; canonicalUrl: string; kind: "article" | "pdf" },
  savedAt: string,
): Promise<void> {
  const now = nowIso();
  let doc = await first<{
    id: string;
    availability: string;
    failure_code: string | null;
    title: string | null;
    removed_at: string | null;
    last_saved_at: string;
  }>(db, `SELECT id, availability, failure_code, title, removed_at, last_saved_at FROM reading_documents WHERE library_id = ? AND canonical_url = ?`, libraryId, candidate.canonicalUrl);
  const classified = classifyLocal(candidate, item);

  if (!doc) {
    const id = crypto.randomUUID();
    try {
      await run(
        db,
        `INSERT INTO reading_documents (
          id, library_id, canonical_url, observed_url, final_url, kind, availability, failure_code,
          original_status, title, publication, last_saved_at, next_attempt_at, created_at, updated_at
        ) VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 'unknown', ?, ?, ?, ?, ?, ?)`,
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
      };
    } catch {
      doc = await first(
        db,
        `SELECT id, availability, failure_code, title, removed_at, last_saved_at FROM reading_documents WHERE library_id = ? AND canonical_url = ?`,
        libraryId,
        candidate.canonicalUrl,
      );
      if (!doc) throw new Error("Could not save Reading Document");
    }
  } else if (!doc.removed_at) {
    const hasProgress = await first<{ ok: number }>(
      db,
      `SELECT 1 AS ok FROM reading_progress WHERE library_id = ? AND document_id = ?`,
      libraryId,
      doc.id,
    );
    if (!hasProgress && savedAt > doc.last_saved_at) {
      await run(db, `UPDATE reading_documents SET last_saved_at = ?, updated_at = ? WHERE id = ?`, savedAt, now, doc.id);
    }
  }

  await run(
    db,
    `INSERT OR IGNORE INTO reading_provenance (library_id, document_id, item_id, observed_url, discovered_at)
     VALUES (?, ?, ?, ?, ?)`,
    libraryId,
    doc.id,
    item.id,
    candidate.observedUrl,
    now,
  );
}

function classifyLocal(
  candidate: { canonicalUrl: string; kind: "article" | "pdf" },
  item: { title: string | null },
): { kind: ReadingKind; availability: ReadingAvailability; failureCode: string | null; title: string } {
  const fallback = item.title?.trim() || hostOf(candidate.canonicalUrl);
  if (candidate.kind === "pdf") {
    return { kind: "pdf", availability: "metadata_only", failureCode: null, title: fallback };
  }
  return { kind: "article", availability: "pending", failureCode: null, title: fallback };
}

async function maybeDeleteOrphan(db: D1Database, libraryId: string, documentId: string): Promise<void> {
  const doc = await first<{ removed_at: string | null }>(
    db,
    `SELECT removed_at FROM reading_documents WHERE id = ? AND library_id = ?`,
    documentId,
    libraryId,
  );
  if (!doc || doc.removed_at) return;
  const provenance = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM reading_provenance WHERE library_id = ? AND document_id = ? LIMIT 1`,
    libraryId,
    documentId,
  );
  if (provenance) return;
  const progress = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM reading_progress WHERE library_id = ? AND document_id = ? LIMIT 1`,
    libraryId,
    documentId,
  );
  if (progress) return;
  await run(db, `DELETE FROM reading_documents WHERE id = ?`, documentId);
}

async function countReading(db: D1Database, libraryId: string, query: ReadingListQuery = {}): Promise<ReadingPageResult["counts"]> {
  const n = async (extra: ListExtra): Promise<number> => {
    const { sql, params } = matchingWhere(libraryId, query, extra, null);
    const row = await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM reading_documents d
        LEFT JOIN reading_progress p ON p.library_id = d.library_id AND p.document_id = d.id
        ${sql}`,
      ...params,
    );
    return Number(row?.n ?? 0);
  };
  return {
    unread: await n({ availability: "ready", unreadOnly: true }),
    reading: await n({ openedOnly: true }),
    preparing: await n({ availability: "pending" }),
    finished: await n({ finishedOnly: true }),
  };
}

async function loadDocumentPage(
  db: D1Database,
  libraryId: string,
  query: ReadingListQuery,
  extra: ListExtra,
  limit: number,
): Promise<{ rows: DocumentRow[]; nextCursor: string | null }> {
  const sort = query.sort ?? "recent";
  const cursor = decodeCursor(query.cursor, sort);
  const { sql, params } = matchingWhere(libraryId, query, extra, cursor);
  const rows = await all<DocumentRow>(db, `${LIST_SELECT} ${sql} ${orderSql(sort)} LIMIT ?`, ...params, limit + 1);
  const page = rows.slice(0, limit);
  const last = page[page.length - 1];
  return {
    rows: page,
    nextCursor: rows.length > limit && last ? encodeCursor({ sort, k: cursorKey(last, sort), id: last.id }) : null,
  };
}

async function pageDocuments(
  db: D1Database,
  libraryId: string,
  query: ReadingListQuery,
  extra: ListExtra,
  limit: number,
): Promise<{ items: ReadingSummary[]; nextCursor: string | null }> {
  const page = await loadDocumentPage(db, libraryId, query, extra, limit);
  return { items: await hydrateSummaries(db, libraryId, page.rows), nextCursor: page.nextCursor };
}

async function selectDocuments(
  db: D1Database,
  libraryId: string,
  query: ReadingListQuery,
  extra: ListExtra,
  limit: number,
): Promise<ReadingSummary[]> {
  const { sql, params } = matchingWhere(libraryId, query, extra, null);
  const rows = await all<DocumentRow>(db, `${LIST_SELECT} ${sql} ${orderSql(query.sort)} LIMIT ?`, ...params, limit);
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
    return { sql: `(d.last_saved_at > ? OR (d.last_saved_at = ? AND d.id > ?))`, params: [cursor.k, cursor.k, cursor.id] };
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
  return { sql: `(d.last_saved_at < ? OR (d.last_saved_at = ? AND d.id < ?))`, params: [cursor.k, cursor.k, cursor.id] };
}

async function hydrateSummaries(db: D1Database, libraryId: string, rows: DocumentRow[]): Promise<ReadingSummary[]> {
  const summaries: ReadingSummary[] = [];
  for (const row of rows) {
    const summary = await toSummary(db, libraryId, row);
    if (summary) summaries.push(summary);
  }
  return summaries;
}

async function toSummary(db: D1Database, libraryId: string, row: DocumentRow): Promise<ReadingSummary | null> {
  if (!isLiveDocument(row)) return null;
  const marks = await all<{ item_id: string }>(
    db,
    `SELECT item_id FROM reading_provenance WHERE library_id = ? AND document_id = ?`,
    libraryId,
    row.id,
  );
  return {
    id: row.id,
    canonicalUrl: row.canonical_url,
    title: displayTitle(row),
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
    sources: [],
    savedCount: new Set(marks.map((mark) => mark.item_id)).size,
    heroAssetId: row.hero_asset_id,
    progress:
      row.progress_state === "reading" || row.progress_state === "finished"
        ? { state: row.progress_state, progress: Number(row.progress_value ?? 0) }
        : null,
  };
}

async function toAgentSummary(db: D1Database, libraryId: string, row: DocumentRow): Promise<AgentReadingSummary | null> {
  const summary = await toSummary(db, libraryId, row);
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

function canOpenOriginal(row: Pick<DocumentRow, "failure_code" | "original_status" | "canonical_url">): boolean {
  if (row.failure_code === "gone" || row.original_status === "gone") return false;
  if (row.failure_code === "unsafe_target") return false;
  try {
    const u = new URL(row.canonical_url);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

async function loadProvenance(db: D1Database, libraryId: string, documentId: string): Promise<ReadingProvenance[]> {
  const rows = await all<{ item_id: string; observed_url: string }>(
    db,
    `SELECT item_id, observed_url FROM reading_provenance WHERE library_id = ? AND document_id = ? ORDER BY discovered_at`,
    libraryId,
    documentId,
  );
  const out: ReadingProvenance[] = [];
  for (const row of rows) {
    const item = await first<{
      id: string;
      title: string | null;
      body: string | null;
      url: string;
      author_name: string | null;
      author_handle: string | null;
      first_observed_at: string;
      source_saved_at: string | null;
      captured_at: string | null;
    }>(
      db,
      `SELECT id, title, body, url, author_name, author_handle, first_observed_at, source_saved_at, captured_at
         FROM items WHERE id = ? AND library_id = ?`,
      row.item_id,
      libraryId,
    );
    if (!item) continue;
    const [tags, notes] = await Promise.all([
      all<{ id: string; name: string }>(
        db,
        `SELECT t.id, t.name FROM memberships m JOIN tags t ON t.id = m.target_id
          WHERE m.item_id = ? AND m.target_kind = 'tag' ORDER BY t.name`,
        item.id,
      ),
      all<{ id: string; body: string }>(
        db,
        `SELECT id, body FROM notes WHERE item_id = ? ORDER BY created_at`,
        item.id,
      ),
    ]);
    out.push({
      itemId: item.id,
      observedUrl: row.observed_url,
      title: item.title,
      body: item.body,
      source: "",
      authorName: item.author_name,
      authorHandle: item.author_handle,
      permalink: item.url,
      firstObservedAt: item.first_observed_at,
      sourceSavedAt: item.source_saved_at,
      capturedAt: item.captured_at,
      tags,
      notes,
    });
  }
  return out;
}

async function claimDue(
  db: D1Database,
  now: string,
  libraryId?: string,
): Promise<{ id: string; library_id: string } | null> {
  const owner = crypto.randomUUID();
  const leaseUntil = new Date(Date.parse(now) + LEASE_MS).toISOString();
  const claimed = libraryId
    ? await first<{ id: string; library_id: string }>(
        db,
        `UPDATE reading_documents
            SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = (
            SELECT id FROM reading_documents
             WHERE library_id = ? AND removed_at IS NULL
               AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             ORDER BY next_attempt_at ASC, id ASC LIMIT 1
          )
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        RETURNING id, library_id`,
        owner,
        leaseUntil,
        now,
        libraryId,
        now,
        now,
        now,
      )
    : await first<{ id: string; library_id: string }>(
        db,
        `UPDATE reading_documents
            SET lease_owner = ?, lease_expires_at = ?, updated_at = ?
          WHERE id = (
            SELECT id FROM reading_documents
             WHERE removed_at IS NULL
               AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
               AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
             ORDER BY next_attempt_at ASC, id ASC LIMIT 1
          )
            AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        RETURNING id, library_id`,
        owner,
        leaseUntil,
        now,
        now,
        now,
        now,
      );
  return claimed;
}

async function pullForwardOverRetry(db: D1Database, libraryId: string, now: string): Promise<void> {
  await run(
    db,
    `UPDATE reading_documents SET next_attempt_at = ?
      WHERE library_id = ? AND removed_at IS NULL AND availability = 'pending'
        AND attempt_count > ? AND next_attempt_at IS NOT NULL AND next_attempt_at > ?`,
    now,
    libraryId,
    TRANSIENT_RETRIES,
    now,
  );
}

async function cleanupExpiredRemovals(db: D1Database, now: string): Promise<void> {
  const rows = await all<{ id: string; library_id: string }>(
    db,
    `SELECT id, library_id FROM reading_documents
      WHERE removed_at IS NOT NULL AND undo_expires_at IS NOT NULL AND undo_expires_at <= ?`,
    now,
  );
  for (const row of rows) {
    await run(db, `DELETE FROM reading_progress WHERE library_id = ? AND document_id = ?`, row.library_id, row.id);
    await run(
      db,
      `UPDATE reading_documents SET
         content_blocks = NULL, search_text = NULL, content_hash = NULL, hero_asset_id = NULL,
         excerpt = NULL, word_count = NULL, reading_minutes = NULL,
         undo_token = NULL, undo_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
      now,
      row.id,
    );
  }
}

async function enrichDocument(db: D1Database, libraryId: string, documentId: string): Promise<void> {
  const now = nowIso();
  const doc = await first<DocumentWork>(
    db,
    `SELECT id, library_id, canonical_url, observed_url, final_url, kind, availability, failure_code, original_status,
            title, content_blocks, content_hash, attempt_count, fetched_at, lease_expires_at, removed_at
       FROM reading_documents WHERE id = ? AND library_id = ?`,
    documentId,
    libraryId,
  );
  if (!doc || doc.removed_at) return;
  const target = doc.final_url || doc.observed_url || doc.canonical_url;
  const fallback = await fallbackTitle(db, libraryId, doc);
  try {
    const fetched = await fetchReadingPage(target);
    if (fetched.status < 200 || fetched.status >= 300) {
      const classified = classifyFetchedPage({
        status: fetched.status,
        finalUrl: fetched.url.toString(),
        contentType: fetched.contentType,
        title: null,
        text: "",
        wordCount: 0,
        hasArticle: false,
        scriptCount: 0,
      });
      await applyFailure(db, libraryId, documentId, classified.failure ?? "network_error", now, fetched.url.toString());
      return;
    }
    if (isPdfContentType(fetched.contentType)) {
      await applyPdf(db, doc, fetched.url.toString(), fallback, now);
      return;
    }
    if (!fetched.contentType || !isHtmlContentType(fetched.contentType)) {
      await applyFailure(db, libraryId, documentId, "unsupported_content_type", now, fetched.url.toString());
      return;
    }
    const extracted = extractPage(fetched.body, fetched.url.toString(), fallback);
    const classified = classifyFetchedPage({
      status: fetched.status,
      finalUrl: fetched.url.toString(),
      contentType: fetched.contentType,
      title: extracted.title,
      text: extracted.text,
      wordCount: extracted.wordCount,
      hasArticle: extracted.hasArticle,
      scriptCount: extracted.scriptCount,
    });
    if (classified.failure) {
      await applyFailure(db, libraryId, documentId, classified.failure, now, fetched.url.toString(), extracted, fallback);
      return;
    }
    if (!extracted.content || !qualifiesAsReadable(extracted)) {
      await applyFailure(
        db,
        libraryId,
        documentId,
        extracted.wordCount === 0 ? "empty_content" : "not_article_like",
        now,
        fetched.url.toString(),
        extracted,
        fallback,
      );
      return;
    }
    const identity = identityUrl(fetched.url.toString(), extracted.canonical);
    await commitReady(db, doc, {
      now,
      identity,
      finalUrl: fetched.url.toString(),
      extracted,
      fallback,
    });
  } catch (error) {
    const code: ReadingFailureCode =
      error instanceof ReadingFetchError
        ? error.code
        : error instanceof Error && error.message === "reading extraction timed out"
          ? "timeout"
          : "parse_error";
    await applyFailure(db, libraryId, documentId, code, now);
  }
}

function identityUrl(finalUrl: string, metadataCanonical: string | null): string {
  const cleanedFinal = cleanupUrl(finalUrl)?.canonicalUrl ?? finalUrl;
  if (metadataCanonical && isApprovedAlias(cleanedFinal, metadataCanonical)) {
    return cleanupUrl(metadataCanonical)?.canonicalUrl ?? cleanedFinal;
  }
  return cleanedFinal;
}

async function commitReady(
  db: D1Database,
  doc: DocumentWork,
  args: {
    now: string;
    identity: string;
    finalUrl: string;
    extracted: ReturnType<typeof extractPage>;
    fallback: string;
  },
): Promise<void> {
  const title = readyTitle(args.extracted.title, args.fallback);
  const content = args.extracted.content!;
  const hash = contentHash(content);
  const words = args.extracted.wordCount || wordCountOf(collectText(content.blocks));
  const merged = await mergeOnto(db, doc, args.identity, args.now, hash);
  if (merged.tombstone) return;
  const id = merged.id;
  const taken = await first<{ id: string }>(
    db,
    `SELECT id FROM reading_documents WHERE library_id = ? AND canonical_url = ? AND id != ?`,
    doc.library_id,
    args.identity,
    id,
  );
  const canonical = taken ? doc.canonical_url : args.identity;
  await run(
    db,
    `UPDATE reading_documents SET
       canonical_url = ?, final_url = ?, kind = ?, availability = 'ready', failure_code = NULL,
       original_status = 'reachable', original_checked_at = ?, title = ?, subtitle = ?, byline = ?,
       publication = ?, published_at = ?, language = ?, excerpt = ?, search_text = ?,
       word_count = ?, reading_minutes = ?, content_blocks = ?, content_hash = ?, hero_asset_id = NULL,
       fetched_at = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL,
       lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
    canonical,
    args.finalUrl,
    args.extracted.kind,
    args.now,
    title,
    args.extracted.subtitle,
    args.extracted.byline,
    args.extracted.publication,
    args.extracted.publishedAt,
    args.extracted.language,
    args.extracted.excerpt,
    args.extracted.searchText,
    words,
    readingMinutes(words),
    JSON.stringify(content),
    hash,
    args.now,
    args.now,
    id,
  );
  await remapProgress(db, doc.library_id, id, content);
}

async function mergeOnto(
  db: D1Database,
  doc: DocumentWork,
  identity: string,
  now: string,
  hash: string,
): Promise<{ id: string; tombstone: boolean }> {
  if (identity === doc.canonical_url) return { id: doc.id, tombstone: Boolean(doc.removed_at) };
  const other = await first<{ id: string; removed_at: string | null; content_hash: string | null }>(
    db,
    `SELECT id, removed_at, content_hash FROM reading_documents WHERE library_id = ? AND canonical_url = ?`,
    doc.library_id,
    identity,
  );
  if (!other || other.id === doc.id) return { id: doc.id, tombstone: false };
  const tombstone = Boolean(other.removed_at);
  if (!tombstone && other.content_hash && other.content_hash !== hash && !isApprovedAlias(doc.canonical_url, identity)) {
    return { id: doc.id, tombstone: false };
  }
  const keep = tombstone ? other.id : await pickWinner(db, doc.library_id, other.id, doc.id);
  const drop = keep === other.id ? doc.id : other.id;
  await relink(db, doc.library_id, keep, drop, now);
  return { id: keep, tombstone };
}

async function pickWinner(db: D1Database, libraryId: string, a: string, b: string): Promise<string> {
  const rank = async (id: string): Promise<[number, number, string, string]> => {
    const p = await first<{ state: string; progress: number }>(
      db,
      `SELECT state, progress FROM reading_progress WHERE library_id = ? AND document_id = ?`,
      libraryId,
      id,
    );
    const state = p?.state === "finished" ? 2 : p?.state === "reading" ? 1 : 0;
    const updated = await first<{ updated_at: string }>(db, `SELECT updated_at FROM reading_documents WHERE id = ?`, id);
    return [state, Number(p?.progress ?? 0), updated?.updated_at ?? "", id];
  };
  const ra = await rank(a);
  const rb = await rank(b);
  for (let i = 0; i < 4; i += 1) {
    const av = ra[i] ?? "";
    const bv = rb[i] ?? "";
    if (av > bv) return a;
    if (bv > av) return b;
  }
  return a < b ? a : b;
}

async function relink(db: D1Database, libraryId: string, keep: string, drop: string, now: string): Promise<void> {
  const rows = await all<{ item_id: string; observed_url: string }>(
    db,
    `SELECT item_id, observed_url FROM reading_provenance WHERE library_id = ? AND document_id = ?`,
    libraryId,
    drop,
  );
  for (const row of rows) {
    await run(
      db,
      `INSERT OR IGNORE INTO reading_provenance (library_id, document_id, item_id, observed_url, discovered_at)
       VALUES (?, ?, ?, ?, ?)`,
      libraryId,
      keep,
      row.item_id,
      row.observed_url,
      now,
    );
  }
  await run(db, `DELETE FROM reading_provenance WHERE library_id = ? AND document_id = ?`, libraryId, drop);
  const dropProgress = await first<{ state: string; progress: number; anchor: string | null }>(
    db,
    `SELECT state, progress, anchor FROM reading_progress WHERE library_id = ? AND document_id = ?`,
    libraryId,
    drop,
  );
  const keepProgress = await first<{ state: string; progress: number; anchor: string | null }>(
    db,
    `SELECT state, progress, anchor FROM reading_progress WHERE library_id = ? AND document_id = ?`,
    libraryId,
    keep,
  );
  if (dropProgress && !keepProgress) {
    await run(
      db,
      `UPDATE reading_progress SET document_id = ? WHERE library_id = ? AND document_id = ?`,
      keep,
      libraryId,
      drop,
    );
  } else if (dropProgress && keepProgress) {
    const winner = pickProgress(keepProgress, dropProgress);
    await run(
      db,
      `UPDATE reading_progress SET state = ?, progress = ?, anchor = ?, updated_at = ? WHERE library_id = ? AND document_id = ?`,
      winner.state,
      winner.progress,
      winner.anchor,
      now,
      libraryId,
      keep,
    );
    await run(db, `DELETE FROM reading_progress WHERE library_id = ? AND document_id = ?`, libraryId, drop);
  }
  await run(db, `DELETE FROM reading_documents WHERE id = ?`, drop);
}

function pickProgress(
  a: { state: string; progress: number; anchor: string | null },
  b: { state: string; progress: number; anchor: string | null },
): { state: string; progress: number; anchor: string | null } {
  const rank = (s: string) => (s === "finished" ? 2 : s === "reading" ? 1 : 0);
  if (rank(b.state) !== rank(a.state)) return rank(b.state) > rank(a.state) ? b : a;
  return b.progress > a.progress ? b : a;
}

async function applyPdf(db: D1Database, doc: DocumentWork, finalUrl: string, title: string, now: string): Promise<void> {
  if (doc.availability === "ready") {
    await run(
      db,
      `UPDATE reading_documents SET original_status = 'reachable', original_checked_at = ?, fetched_at = ?,
         attempt_count = attempt_count + 1, next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
      now,
      now,
      now,
      doc.id,
    );
    return;
  }
  await run(
    db,
    `UPDATE reading_documents SET kind = 'pdf', availability = 'metadata_only', failure_code = NULL, final_url = ?,
       original_status = 'reachable', original_checked_at = ?, title = ?, fetched_at = ?, attempt_count = attempt_count + 1,
       next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
    finalUrl,
    now,
    title,
    now,
    now,
    doc.id,
  );
}

async function applyFailure(
  db: D1Database,
  libraryId: string,
  documentId: string,
  code: ReadingFailureCode,
  now: string,
  finalUrl?: string,
  extracted?: ReturnType<typeof extractPage>,
  fallback?: string,
): Promise<void> {
  const doc = await first<DocumentWork>(
    db,
    `SELECT id, library_id, canonical_url, observed_url, final_url, kind, availability, failure_code, original_status,
            title, content_blocks, content_hash, attempt_count, fetched_at, lease_expires_at, removed_at
       FROM reading_documents WHERE id = ? AND library_id = ?`,
    documentId,
    libraryId,
  );
  if (!doc) return;
  const original = originalStatusFor(code, false);
  if (doc.availability === "ready") {
    await run(
      db,
      `UPDATE reading_documents SET original_status = ?, original_checked_at = ?, fetched_at = ?,
         attempt_count = attempt_count + 1, next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
      original,
      now,
      now,
      now,
      documentId,
    );
    return;
  }
  const retryAgain = isTransient(code) && doc.attempt_count < TRANSIENT_RETRIES;
  const nextAttempt = retryAgain ? new Date(Date.parse(now) + backoffMs(doc.attempt_count + 1)).toISOString() : null;
  const availability =
    code === "paywall_or_consent"
      ? "metadata_only"
      : code === "unsupported_content_type" || code === "not_article_like"
        ? "unsupported"
        : code === "blocked_challenge" || code === "authentication_required" || code === "unsafe_target" || code === "gone"
          ? "blocked"
          : code === "not_found" || code === "empty_content" || code === "parse_error"
            ? "error"
            : retryAgain
              ? "pending"
              : "error";
  const trusted = fallback ?? (await fallbackTitle(db, libraryId, doc));
  const keepMeta = code === "paywall_or_consent";
  const title = keepMeta ? readyTitle(extracted?.title ?? null, trusted) : trusted;
  await run(
    db,
    `UPDATE reading_documents SET availability = ?, failure_code = ?, original_status = ?, original_checked_at = ?,
       final_url = COALESCE(?, final_url), title = ?, subtitle = ?, byline = ?, excerpt = ?, publication = ?,
       fetched_at = ?, attempt_count = attempt_count + 1, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
       updated_at = ?
     WHERE id = ?`,
    availability,
    code,
    original,
    now,
    finalUrl ?? null,
    title,
    keepMeta ? extracted?.subtitle ?? null : null,
    keepMeta ? extracted?.byline ?? null : null,
    keepMeta ? extracted?.excerpt ?? null : null,
    keepMeta ? extracted?.publication ?? hostOf(doc.canonical_url) : hostOf(doc.canonical_url),
    now,
    nextAttempt,
    now,
    documentId,
  );
}

function backoffMs(attempt: number): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 10);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exp);
}

function readyTitle(extracted: string | null, fallback: string): string {
  const title = extracted?.trim() ?? "";
  if (title && !isChallengeTitle(title)) return title;
  return fallback;
}

async function fallbackTitle(
  db: D1Database,
  libraryId: string,
  doc: { title: string | null; canonical_url: string },
): Promise<string> {
  if (doc.title && !isChallengeTitle(doc.title)) return doc.title;
  const item = await first<{ title: string | null }>(
    db,
    `SELECT i.title FROM reading_provenance rp JOIN items i ON i.id = rp.item_id
      WHERE rp.library_id = ? AND rp.document_id = (SELECT id FROM reading_documents WHERE canonical_url = ? AND library_id = ?)
      LIMIT 1`,
    libraryId,
    doc.canonical_url,
    libraryId,
  );
  return item?.title?.trim() || hostOf(doc.canonical_url);
}

async function remapProgress(db: D1Database, libraryId: string, documentId: string, content: ReadingContent): Promise<void> {
  const row = await first<{ anchor: string | null }>(
    db,
    `SELECT anchor FROM reading_progress WHERE library_id = ? AND document_id = ?`,
    libraryId,
    documentId,
  );
  if (!row?.anchor) return;
  let parsed: { blockId?: string; offset?: number } | null = null;
  try {
    parsed = JSON.parse(row.anchor) as { blockId?: string; offset?: number };
  } catch {
    parsed = null;
  }
  if (typeof parsed?.blockId !== "string") {
    await run(
      db,
      `UPDATE reading_progress SET anchor = NULL, updated_at = ? WHERE library_id = ? AND document_id = ?`,
      nowIso(),
      libraryId,
      documentId,
    );
    return;
  }
  const mapped = remapAnchor({ blockId: parsed.blockId, offset: typeof parsed.offset === "number" ? parsed.offset : 0 }, content.blocks);
  if (mapped && mapped.blockId === parsed.blockId) return;
  await run(
    db,
    `UPDATE reading_progress SET anchor = ?, updated_at = ? WHERE library_id = ? AND document_id = ?`,
    mapped ? JSON.stringify({ v: 1, blockId: mapped.blockId, offset: mapped.offset }) : null,
    nowIso(),
    libraryId,
    documentId,
  );
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
  const json = JSON.stringify(cursor);
  return btoa(json).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function decodeCursor(raw: string | undefined, sort: ReadingSort): Cursor | null {
  if (!raw) return null;
  try {
    const pad = "=".repeat((4 - (raw.length % 4)) % 4);
    const json = atob(raw.replaceAll("-", "+").replaceAll("_", "/") + pad);
    const value = JSON.parse(json) as Partial<Cursor> & { lastSavedAt?: string };
    const id = value.id;
    if (typeof id !== "string") return null;
    if (typeof value.k === "string") {
      const cursorSort =
        value.sort === "oldest" ||
        value.sort === "shortest" ||
        value.sort === "longest" ||
        value.sort === "publication" ||
        value.sort === "recent"
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

function parseStoredBlocks(raw: string | null): ReadingContent | null {
  if (!raw) return null;
  try {
    return validateContent(JSON.parse(raw) as unknown);
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

async function first<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T | null> {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  return (await stmt.first<T>()) ?? null;
}

async function all<T>(db: D1Database, sql: string, ...params: unknown[]): Promise<T[]> {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  const result = await stmt.all<T>();
  return result.results ?? [];
}

async function run(db: D1Database, sql: string, ...params: unknown[]): Promise<void> {
  const stmt = params.length ? db.prepare(sql).bind(...params) : db.prepare(sql);
  await stmt.run();
}
