import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Db } from "../../db/open.ts";
import { newId, nowIso, readingAssetsRoot, tx } from "../../db/open.ts";
import { MissingResource } from "../../core/commands.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import {
  collectText,
  contentHash,
  readingMinutes,
  remapAnchor,
  wordCountOf,
  type ReadingContent,
} from "./blocks.ts";
import {
  classifyFetchedPage,
  isHtmlContentType,
  isPdfContentType,
  isTransient,
  originalStatusFor,
  type ReadingFailureCode,
} from "./classify.ts";
import { extractPage, extractPageBounded, qualifiesAsReadable } from "./extract.ts";
import {
  fetchReadingResource,
  imageWithinBounds,
  MAX_HTML_BYTES,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_TOTAL_BYTES,
  ReadingFetchError,
  type ReadingTransport,
} from "./fetch.ts";
import { cleanupUrl, hostOf, isApprovedAlias, isChallengeTitle, LOCAL_LIBRARY_ID } from "./policy.ts";

export const enrichDiagnostics = {
  merges: 0,
  challenges: 0,
  enrichments: {} as Record<string, number>,
};

export function resetEnrichDiagnostics(): void {
  enrichDiagnostics.merges = 0;
  enrichDiagnostics.challenges = 0;
  enrichDiagnostics.enrichments = {};
}

function bump(kind: "merges" | "challenges" | "enrichments", key: string): void {
  if (kind === "merges") enrichDiagnostics.merges += 1;
  else if (kind === "challenges") enrichDiagnostics.challenges += 1;
  else enrichDiagnostics.enrichments[key] = (enrichDiagnostics.enrichments[key] ?? 0) + 1;
}

const LEASE_MS = 60_000;
const BACKOFF_BASE_MS = 15_000;
const BACKOFF_CAP_MS = 5 * 60 * 1000;
const TRANSIENT_RETRIES = 3;
export const RETRY_COOLDOWN_MS = 15_000;
const DRAIN_LIMIT = 8;
const IMAGE_MIME = new Set(["image/jpeg", "image/jpg", "image/png", "image/gif", "image/webp", "image/avif"]);

export interface ReadingScheduler {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
}

const defaultScheduler: ReadingScheduler = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

type WorkerState = {
  db: Db;
  libraryId: string;
  transport?: ReadingTransport;
  scheduler: ReadingScheduler;
  draining: boolean;
  timer: unknown;
  idle: Promise<void>;
};

const workers = new WeakMap<Db, WorkerState>();

export function startReadingWorker(
  db: Db,
  opts: { transport?: ReadingTransport; scheduler?: ReadingScheduler; libraryId?: string } = {},
): void {
  const existing = workers.get(db);
  if (existing) {
    existing.transport = opts.transport ?? existing.transport;
    existing.scheduler = opts.scheduler ?? existing.scheduler;
    existing.libraryId = opts.libraryId ?? existing.libraryId;
    void drain(existing);
    return;
  }
  const state: WorkerState = {
    db,
    libraryId: opts.libraryId ?? LOCAL_LIBRARY_ID,
    transport: opts.transport,
    scheduler: opts.scheduler ?? defaultScheduler,
    draining: false,
    timer: null,
    idle: Promise.resolve(),
  };
  state.idle = Promise.resolve();
  workers.set(db, state);
  void drain(state);
}

export function stopReadingWorker(db: Db): void {
  const state = workers.get(db);
  if (!state) return;
  if (state.timer != null) state.scheduler.clearTimeout(state.timer);
  workers.delete(db);
}

export function wakeReadingWorker(db: Db): void {
  const state = workers.get(db);
  if (!state) return;
  void drain(state);
}

export function drainReadingWorker(db: Db): Promise<void> {
  const state = workers.get(db);
  if (!state) return Promise.resolve();
  return drain(state);
}

export async function retryReadingDocument(db: Db, libraryId: string, documentId: string): Promise<void> {
  const now = nowIso();
  const row = db
    .prepare(
      `SELECT id, availability, failure_code, lease_expires_at, fetched_at FROM reading_documents
        WHERE library_id = ? AND id = ? AND removed_at IS NULL`,
    )
    .get(libraryId, documentId) as
    | { id: string; availability: string; failure_code: string | null; lease_expires_at: string | null; fetched_at: string | null }
    | undefined;
  if (!row) throw new MissingResource("document");
  if (row.failure_code === "gone") return;
  if (row.lease_expires_at && row.lease_expires_at > now) return;
  if (row.fetched_at && Date.parse(row.fetched_at) + RETRY_COOLDOWN_MS > Date.parse(now)) return;
  db.prepare(
    `UPDATE reading_documents SET next_attempt_at = ?, lease_owner = NULL, lease_expires_at = ?, updated_at = ? WHERE id = ?`,
  ).run(now, null, now, documentId);
  const state = workers.get(db);
  if (state) await drain(state);
  else await enrichDocument(db, libraryId, documentId, { now: Date.now() });
}

async function drain(state: WorkerState): Promise<void> {
  if (state.draining) return state.idle;
  state.draining = true;
  let resolveIdle = (): void => {};
  state.idle = new Promise<void>((resolve) => {
    resolveIdle = resolve;
  });
  try {
    const now = new Date(state.scheduler.now()).toISOString();
    cleanupExpiredRemovals(state.db, now);
    pullForwardOverRetry(state.db, state.libraryId, now);
    const { backfillReading } = await import("./module.ts");
    backfillReading(state.db, state.libraryId);
    let drained = 0;
    for (;;) {
      if (drained >= DRAIN_LIMIT) break;
      const now = new Date(state.scheduler.now()).toISOString();
      const claimed = claimDue(state.db, state.libraryId, now);
      if (!claimed) break;
      drained += 1;
      try {
        await enrichDocument(state.db, claimed.library_id, claimed.id, {
          now: state.scheduler.now(),
          transport: state.transport,
        });
      } catch (error) {
        const code = error instanceof ReadingFetchError ? error.code : "network_error";
        applyFailure(state.db, claimed.library_id, claimed.id, code, now);
        console.info("reading: enrich", { host: hostOf(claimed.canonical_url), code });
      }
    }
  } finally {
    state.draining = false;
    armTimer(state);
    resolveIdle();
  }
  return state.idle;
}

function claimDue(db: Db, libraryId: string, now: string): { id: string; library_id: string; canonical_url: string; lease_owner: string } | null {
  const owner = newId();
  const leaseUntil = new Date(Date.parse(now) + LEASE_MS).toISOString();
  const row = db
    .prepare(
      `SELECT id, library_id, canonical_url FROM reading_documents
        WHERE library_id = ? AND removed_at IS NULL
          AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        ORDER BY next_attempt_at ASC, id ASC LIMIT 1`,
    )
    .get(libraryId, now, now) as { id: string; library_id: string; canonical_url: string } | undefined;
  if (!row) return null;
  db.prepare(`UPDATE reading_documents SET lease_owner = ?, lease_expires_at = ?, updated_at = ? WHERE id = ? AND library_id = ?`).run(
    owner,
    leaseUntil,
    now,
    row.id,
    libraryId,
  );
  return { ...row, lease_owner: owner };
}

function hasDueWork(db: Db, libraryId: string, now: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM reading_documents
        WHERE library_id = ? AND removed_at IS NULL
          AND next_attempt_at IS NOT NULL AND next_attempt_at <= ?
          AND (lease_expires_at IS NULL OR lease_expires_at <= ?)
        LIMIT 1`,
    )
    .get(libraryId, now, now) as { ok: number } | undefined;
  return Boolean(row);
}

function pullForwardOverRetry(db: Db, libraryId: string, now: string): void {
  db.prepare(
    `UPDATE reading_documents SET next_attempt_at = ?
      WHERE library_id = ? AND removed_at IS NULL AND availability = 'pending'
        AND attempt_count > ? AND next_attempt_at IS NOT NULL AND next_attempt_at > ?`,
  ).run(now, libraryId, TRANSIENT_RETRIES, now);
}

function backfillPending(db: Db): boolean {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get("reading.backfill.cursor") as { value: string } | undefined;
  return row?.value !== "done";
}

function armTimer(state: WorkerState): void {
  if (state.timer != null) state.scheduler.clearTimeout(state.timer);
  state.timer = null;
  const nowMs = state.scheduler.now();
  const now = new Date(nowMs).toISOString();
  if (hasDueWork(state.db, state.libraryId, now) || backfillPending(state.db)) {
    state.timer = state.scheduler.setTimeout(() => {
      state.timer = null;
      void drain(state);
    }, 0);
    return;
  }
  const row = state.db
    .prepare(
      `SELECT MIN(t) AS t FROM (
         SELECT next_attempt_at AS t FROM reading_documents
          WHERE library_id = ? AND removed_at IS NULL AND next_attempt_at IS NOT NULL AND next_attempt_at > ?
         UNION ALL
         SELECT lease_expires_at AS t FROM reading_documents
          WHERE library_id = ? AND removed_at IS NULL AND lease_expires_at IS NOT NULL AND lease_expires_at > ?
         UNION ALL
         SELECT undo_expires_at AS t FROM reading_documents
          WHERE library_id = ? AND removed_at IS NOT NULL AND undo_expires_at IS NOT NULL AND undo_expires_at > ?
       )`,
    )
    .get(state.libraryId, now, state.libraryId, now, state.libraryId, now) as { t: string | null } | undefined;
  if (!row?.t) return;
  const delay = Math.max(0, Date.parse(row.t) - nowMs);
  state.timer = state.scheduler.setTimeout(() => {
    state.timer = null;
    void drain(state);
  }, delay);
}

export async function enrichDocument(
  db: Db,
  libraryId: string,
  documentId: string,
  opts: { now?: number; transport?: ReadingTransport } = {},
): Promise<void> {
  const now = new Date(opts.now ?? Date.now()).toISOString();
  const doc = db.prepare(`SELECT * FROM reading_documents WHERE id = ? AND library_id = ?`).get(documentId, libraryId) as
    | DocumentWork
    | undefined;
  if (!doc || doc.removed_at) return;
  const target = doc.final_url || doc.observed_url || doc.canonical_url;
  const fallback = fallbackTitle(db, libraryId, doc);
  try {
    const fetched = await fetchReadingResource(target, {
      accept: "text/html,application/xhtml+xml,application/pdf;q=0.9,*/*;q=0.1",
      maxBytes: MAX_HTML_BYTES,
      transport: opts.transport,
    });
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
      applyFailure(db, libraryId, documentId, classified.failure ?? "network_error", now, fetched.url.toString());
      return;
    }
    if (isPdfContentType(fetched.contentType)) {
      applyPdf(db, doc, fetched.url.toString(), fallback, now);
      return;
    }
    if (!fetched.contentType || !isHtmlContentType(fetched.contentType)) {
      applyFailure(db, libraryId, documentId, "unsupported_content_type", now, fetched.url.toString());
      return;
    }
    const html = fetched.body.toString("utf8");
    const extracted = await extractPageBounded(html, fetched.url.toString(), fallback);
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
      applyFailure(db, libraryId, documentId, classified.failure, now, fetched.url.toString(), extracted, fallback);
      return;
    }
    if (!extracted.content || !qualifiesAsReadable(extracted)) {
      applyFailure(
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
    const hero = extracted.heroUrl
      ? await cacheHero(db, libraryId, documentId, extracted.heroUrl, opts.transport)
      : null;
    const identity = identityUrl(fetched.url.toString(), extracted.canonical);
    await commitReady(db, doc, {
      now,
      identity,
      finalUrl: fetched.url.toString(),
      extracted,
      fallback,
      heroAssetId: hero,
    });
  } catch (error) {
    const code: ReadingFailureCode =
      error instanceof ReadingFetchError
        ? error.code
        : error instanceof SyntaxError
          ? "parse_error"
          : error instanceof Error && error.message === "reading extraction timed out"
            ? "timeout"
            : "parse_error";
    applyFailure(db, libraryId, documentId, code, now);
  }
}

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
  hero_asset_id: string | null;
  attempt_count: number;
  removed_at: string | null;
};

function identityUrl(finalUrl: string, metadataCanonical: string | null): string {
  const cleanedFinal = cleanupUrl(finalUrl)?.canonicalUrl ?? finalUrl;
  if (metadataCanonical && isApprovedAlias(cleanedFinal, metadataCanonical)) {
    return cleanupUrl(metadataCanonical)?.canonicalUrl ?? cleanedFinal;
  }
  return cleanedFinal;
}

async function commitReady(
  db: Db,
  doc: DocumentWork,
  args: {
    now: string;
    identity: string;
    finalUrl: string;
    extracted: ReturnType<typeof extractPage>;
    fallback: string;
    heroAssetId: string | null;
  },
): Promise<void> {
  const title = displayTitle(args.extracted.title, args.fallback);
  const content = args.extracted.content!;
  const hash = contentHash(content);
  const words = args.extracted.wordCount || wordCountOf(collectText(content.blocks));
  tx(db, () => {
    const merged = mergeOnto(db, doc, args.identity, args.now, hash);
    if (merged.tombstone) return;
    const id = merged.id;
    // A hero cached for the candidate belongs to that candidate document. If
    // canonical merging keeps another document, retain only the winner's asset.
    const heroAssetId = id === doc.id
      ? args.heroAssetId
      : (db
          .prepare(`SELECT hero_asset_id FROM reading_documents WHERE id = ? AND library_id = ?`)
          .get(id, doc.library_id) as { hero_asset_id: string | null } | undefined)?.hero_asset_id ?? null;
    const taken = db
      .prepare(`SELECT id FROM reading_documents WHERE library_id = ? AND canonical_url = ? AND id != ?`)
      .get(doc.library_id, args.identity, id) as { id: string } | undefined;
    const canonical = taken ? doc.canonical_url : args.identity;
    db.prepare(
      `UPDATE reading_documents SET
         canonical_url = ?, final_url = ?, kind = ?, availability = 'ready', failure_code = NULL,
         original_status = 'reachable', original_checked_at = ?, title = ?, subtitle = ?, byline = ?,
         publication = ?, published_at = ?, language = ?, excerpt = ?, search_text = ?,
         word_count = ?, reading_minutes = ?, content_blocks = ?, content_hash = ?, hero_asset_id = ?,
         fetched_at = ?, attempt_count = attempt_count + 1, next_attempt_at = NULL,
         lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(
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
      heroAssetId,
      args.now,
      args.now,
      id,
    );
    remapProgress(db, doc.library_id, id, content);
    collapseFailedDisplayFragments(db, doc.library_id, id, canonical, args.now);
  });
  bump("enrichments", "ready");
  console.info("reading: enrich", { host: hostOf(args.identity), code: "ready" });
}

function mergeOnto(
  db: Db,
  doc: DocumentWork,
  identity: string,
  now: string,
  hash: string,
): { id: string; tombstone: boolean } {
  if (identity === doc.canonical_url) return { id: doc.id, tombstone: Boolean(doc.removed_at) };
  const other = db
    .prepare(`SELECT id, removed_at, content_hash, updated_at FROM reading_documents WHERE library_id = ? AND canonical_url = ?`)
    .get(doc.library_id, identity) as
    | { id: string; removed_at: string | null; content_hash: string | null; updated_at: string }
    | undefined;
  if (!other || other.id === doc.id) return { id: doc.id, tombstone: false };
  const tombstone = Boolean(other.removed_at);
  if (!tombstone && other.content_hash && other.content_hash !== hash && !isApprovedAlias(doc.canonical_url, identity)) {
    return { id: doc.id, tombstone: false };
  }
  const keep = tombstone ? other.id : pickWinner(db, doc.library_id, other.id, doc.id);
  const drop = keep === other.id ? doc.id : other.id;
  relink(db, doc.library_id, keep, drop, now);
  bump("merges", "canonical");
  return { id: keep, tombstone };
}

function pickWinner(db: Db, libraryId: string, a: string, b: string): string {
  const rank = (id: string): [number, number, string, string] => {
    const p = db
      .prepare(`SELECT state, progress FROM reading_progress WHERE library_id = ? AND document_id = ?`)
      .get(libraryId, id) as { state: string; progress: number } | undefined;
    const state = p?.state === "finished" ? 2 : p?.state === "reading" ? 1 : 0;
    const updated = (db.prepare(`SELECT updated_at FROM reading_documents WHERE id = ?`).get(id) as { updated_at: string }).updated_at;
    return [state, Number(p?.progress ?? 0), updated, id];
  };
  const ra = rank(a);
  const rb = rank(b);
  for (let i = 0; i < 4; i += 1) {
    const av = ra[i] ?? "";
    const bv = rb[i] ?? "";
    if (av > bv) return a;
    if (bv > av) return b;
  }
  return a < b ? a : b;
}

function relink(db: Db, libraryId: string, keep: string, drop: string, now: string): void {
  const rows = db
    .prepare(`SELECT item_id, observed_url FROM reading_provenance WHERE library_id = ? AND document_id = ?`)
    .all(libraryId, drop) as { item_id: string; observed_url: string }[];
  for (const row of rows) {
    db.prepare(
      `INSERT OR IGNORE INTO reading_provenance (library_id, document_id, item_id, observed_url, discovered_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(libraryId, keep, row.item_id, row.observed_url, now);
  }
  db.prepare(`DELETE FROM reading_provenance WHERE library_id = ? AND document_id = ?`).run(libraryId, drop);
  const dropProgress = db
    .prepare(`SELECT * FROM reading_progress WHERE library_id = ? AND document_id = ?`)
    .get(libraryId, drop) as { state: string; progress: number; anchor: string | null } | undefined;
  const keepProgress = db
    .prepare(`SELECT * FROM reading_progress WHERE library_id = ? AND document_id = ?`)
    .get(libraryId, keep) as { state: string; progress: number; anchor: string | null } | undefined;
  if (dropProgress && !keepProgress) {
    db.prepare(`UPDATE reading_progress SET document_id = ? WHERE library_id = ? AND document_id = ?`).run(keep, libraryId, drop);
  } else if (dropProgress && keepProgress) {
    const winner = pickProgress(keepProgress, dropProgress);
    db.prepare(
      `UPDATE reading_progress SET state = ?, progress = ?, anchor = ?, updated_at = ? WHERE library_id = ? AND document_id = ?`,
    ).run(winner.state, winner.progress, winner.anchor, now, libraryId, keep);
    db.prepare(`DELETE FROM reading_progress WHERE library_id = ? AND document_id = ?`).run(libraryId, drop);
  }
  db.prepare(`DELETE FROM reading_assets WHERE document_id = ?`).run(drop);
  db.prepare(`DELETE FROM reading_documents WHERE id = ?`).run(drop);
}

function pickProgress(
  a: { state: string; progress: number; anchor: string | null },
  b: { state: string; progress: number; anchor: string | null },
): { state: string; progress: number; anchor: string | null } {
  const rank = (s: string) => (s === "finished" ? 2 : s === "reading" ? 1 : 0);
  if (rank(b.state) !== rank(a.state)) return rank(b.state) > rank(a.state) ? b : a;
  return b.progress > a.progress ? b : a;
}

const DISPLAY_FRAGMENT_FAILURES = new Set<ReadingFailureCode>([
  "not_found",
  "gone",
  "unsupported_content_type",
  "not_article_like",
  "empty_content",
]);

function failedDisplayFragmentTarget(
  db: Db,
  libraryId: string,
  failedId: string,
  shorterUrl: string,
  code: ReadingFailureCode,
): string | null {
  if (!DISPLAY_FRAGMENT_FAILURES.has(code)) return null;
  const rows = db
    .prepare(
      `SELECT d.id, d.canonical_url FROM reading_documents d
       WHERE d.library_id = ? AND d.removed_at IS NULL AND d.availability = 'ready'
         AND EXISTS (
           SELECT 1 FROM reading_provenance failed
           JOIN reading_provenance ready
             ON ready.library_id = failed.library_id AND ready.item_id = failed.item_id
           WHERE failed.library_id = ? AND failed.document_id = ? AND ready.document_id = d.id
         )`,
    )
    .all(libraryId, libraryId, failedId) as { id: string; canonical_url: string }[];
  return rows.find((row) => isFailedPrefixOf(shorterUrl, row.canonical_url))?.id ?? null;
}

function collapseFailedDisplayFragments(
  db: Db,
  libraryId: string,
  readyId: string,
  readyUrl: string,
  now: string,
): void {
  const rows = db
    .prepare(
      `SELECT d.id, d.canonical_url, d.failure_code FROM reading_documents d
       WHERE d.library_id = ? AND d.id != ? AND d.removed_at IS NULL AND d.failure_code IS NOT NULL
         AND EXISTS (
           SELECT 1 FROM reading_provenance failed
           JOIN reading_provenance ready
             ON ready.library_id = failed.library_id AND ready.item_id = failed.item_id
           WHERE failed.library_id = ? AND failed.document_id = d.id AND ready.document_id = ?
         )`,
    )
    .all(libraryId, readyId, libraryId, readyId) as { id: string; canonical_url: string; failure_code: ReadingFailureCode }[];
  for (const row of rows) {
    if (!DISPLAY_FRAGMENT_FAILURES.has(row.failure_code) || !isFailedPrefixOf(row.canonical_url, readyUrl)) continue;
    relink(db, libraryId, readyId, row.id, now);
    bump("merges", "display_fragment");
  }
}

function isFailedPrefixOf(shorterRaw: string, longerRaw: string): boolean {
  try {
    const shorter = new URL(shorterRaw);
    const longer = new URL(longerRaw);
    return (
      shorter.origin === longer.origin &&
      shorter.search === longer.search &&
      shorter.pathname.length >= 8 &&
      longer.pathname.startsWith(shorter.pathname) &&
      /[\p{L}\p{N}]/u.test(longer.pathname.charAt(shorter.pathname.length))
    );
  } catch {
    return false;
  }
}

function remapProgress(db: Db, libraryId: string, documentId: string, content: ReadingContent): void {
  const row = db
    .prepare(`SELECT anchor, progress FROM reading_progress WHERE library_id = ? AND document_id = ?`)
    .get(libraryId, documentId) as { anchor: string | null; progress: number } | undefined;
  if (!row?.anchor) return;
  let parsed: { blockId?: string; offset?: number } | null = null;
  try {
    parsed = JSON.parse(row.anchor) as { blockId?: string; offset?: number };
  } catch {
    parsed = null;
  }
  if (typeof parsed?.blockId !== "string") {
    db.prepare(`UPDATE reading_progress SET anchor = NULL, updated_at = ? WHERE library_id = ? AND document_id = ?`).run(
      nowIso(),
      libraryId,
      documentId,
    );
    return;
  }
  const mapped = remapAnchor({ blockId: parsed.blockId, offset: typeof parsed.offset === "number" ? parsed.offset : 0 }, content.blocks);
  if (mapped && mapped.blockId === parsed.blockId) return;
  db.prepare(`UPDATE reading_progress SET anchor = ?, updated_at = ? WHERE library_id = ? AND document_id = ?`).run(
    mapped ? JSON.stringify({ v: 1, blockId: mapped.blockId, offset: mapped.offset }) : null,
    nowIso(),
    libraryId,
    documentId,
  );
}

function applyPdf(db: Db, doc: DocumentWork, finalUrl: string, title: string, now: string): void {
  if (doc.availability === "ready") {
    db.prepare(
      `UPDATE reading_documents SET original_status = 'reachable', original_checked_at = ?, fetched_at = ?,
         attempt_count = attempt_count + 1, next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, now, now, doc.id);
    return;
  }
  db.prepare(
    `UPDATE reading_documents SET kind = 'pdf', availability = 'metadata_only', failure_code = NULL, final_url = ?,
       original_status = 'reachable', original_checked_at = ?, title = ?, fetched_at = ?, attempt_count = attempt_count + 1,
       next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
     WHERE id = ?`,
  ).run(finalUrl, now, title, now, now, doc.id);
}

function applyFailure(
  db: Db,
  libraryId: string,
  documentId: string,
  code: ReadingFailureCode,
  now: string,
  finalUrl?: string,
  extracted?: ReturnType<typeof extractPage>,
  fallback?: string,
): void {
  const doc = db.prepare(`SELECT * FROM reading_documents WHERE id = ? AND library_id = ?`).get(documentId, libraryId) as
    | DocumentWork
    | undefined;
  if (!doc) return;
  const original = originalStatusFor(code, false);
  const readyAlias = failedDisplayFragmentTarget(db, libraryId, documentId, doc.canonical_url, code);
  if (readyAlias && readyAlias !== documentId) {
    tx(db, () => relink(db, libraryId, readyAlias, documentId, now));
    bump("merges", "display_fragment");
    return;
  }
  if (doc.availability === "ready") {
    db.prepare(
      `UPDATE reading_documents SET original_status = ?, original_checked_at = ?, fetched_at = ?,
         attempt_count = attempt_count + 1, next_attempt_at = NULL, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(original, now, now, now, documentId);
    bump("enrichments", "refresh_preserved");
    console.info("reading: enrich", { host: hostOf(doc.canonical_url), code: `ready+${code}` });
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
  const trusted = fallback ?? fallbackTitle(db, libraryId, doc);
  const keepMeta = code === "paywall_or_consent";
  const title = keepMeta ? displayTitle(extracted?.title ?? null, trusted) : trusted;
  if (code === "blocked_challenge") bump("challenges", "blocked_challenge");
  db.prepare(
    `UPDATE reading_documents SET availability = ?, failure_code = ?, original_status = ?, original_checked_at = ?,
       final_url = COALESCE(?, final_url), title = ?, subtitle = ?, byline = ?, excerpt = ?, publication = ?,
       fetched_at = ?, attempt_count = attempt_count + 1, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL,
       updated_at = ?
     WHERE id = ?`,
  ).run(
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
  bump("enrichments", code);
  console.info("reading: enrich", { host: hostOf(doc.canonical_url), code });
}

function backoffMs(attempt: number): number {
  const exp = Math.min(Math.max(attempt - 1, 0), 10);
  return Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** exp);
}

function displayTitle(extracted: string | null, fallback: string): string {
  const title = extracted?.trim() ?? "";
  if (title && !isChallengeTitle(title)) return title;
  return fallback;
}

function fallbackTitle(db: Db, libraryId: string, doc: { title: string | null; canonical_url: string }): string {
  if (doc.title && !isChallengeTitle(doc.title)) return doc.title;
  const item = db
    .prepare(
      `SELECT i.title FROM reading_provenance rp JOIN items i ON i.id = rp.item_id
        WHERE rp.library_id = ? AND rp.document_id = (SELECT id FROM reading_documents WHERE canonical_url = ? AND library_id = ?)
        LIMIT 1`,
    )
    .get(libraryId, doc.canonical_url, libraryId) as { title: string | null } | undefined;
  return item?.title?.trim() || hostOf(doc.canonical_url);
}

async function cacheHero(
  db: Db,
  libraryId: string,
  documentId: string,
  url: string,
  transport?: ReadingTransport,
): Promise<string | null> {
  try {
    const fetched = await fetchReadingResource(url, {
      accept: "image/jpeg,image/png,image/gif,image/webp,image/avif",
      maxBytes: Math.min(MAX_IMAGE_BYTES, MAX_IMAGE_TOTAL_BYTES),
      transport,
    });
    if (fetched.status < 200 || fetched.status >= 300) return null;
    const mime = (fetched.contentType.split(";")[0] ?? "").trim().toLowerCase() || sniffImage(fetched.body);
    if (!IMAGE_MIME.has(mime)) return null;
    if (!imageWithinBounds(fetched.body, mime)) return null;
    return saveAsset(db, libraryId, documentId, fetched.body, mime);
  } catch {
    return null;
  }
}

function sniffImage(bytes: Buffer): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8) return "image/jpeg";
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50) return "image/png";
  if (bytes.length >= 6 && bytes.subarray(0, 6).toString("ascii") === "GIF87a") return "image/gif";
  return "";
}

const ASSET_ID = /^[A-Za-z0-9_-]{1,128}$/;

/** Containment-checked path under the Reading asset cache. Library and document ids
 *  come from persisted rows (including archive import), so anything that is not a
 *  plain id or resolves outside the cache root is rejected. */
function safeAssetPath(libraryId: string, documentId: string): string | null {
  if (!ASSET_ID.test(libraryId) || !ASSET_ID.test(documentId)) return null;
  const root = resolve(readingAssetsRoot(), libraryId);
  const full = resolve(root, documentId);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  return full;
}

export function saveAsset(db: Db, libraryId: string, documentId: string, bytes: Buffer, mime: string): string {
  const hash = createHash("sha256").update(bytes).digest("hex");
  const existing = db
    .prepare(`SELECT id FROM reading_assets WHERE library_id = ? AND document_id = ? AND content_hash = ?`)
    .get(libraryId, documentId, hash) as { id: string } | undefined;
  if (existing) return existing.id;
  const dir = safeAssetPath(libraryId, documentId);
  if (!dir) throw new RejectedPayload("unsafe reading asset path");
  const id = newId();
  const adapterKey = `${documentId}/${hash}`;
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, hash), bytes);
  db.prepare(
    `INSERT INTO reading_assets (id, library_id, document_id, content_hash, mime, byte_size, adapter_key)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, libraryId, documentId, hash, mime, bytes.length, adapterKey);
  return id;
}

export function openReadingAsset(
  db: Db,
  libraryId: string,
  documentId: string,
  assetId: string,
): { path: string; mime: string } | null {
  const row = db
    .prepare(
      `SELECT adapter_key, mime FROM reading_assets WHERE id = ? AND library_id = ? AND document_id = ?`,
    )
    .get(assetId, libraryId, documentId) as { adapter_key: string; mime: string } | undefined;
  if (!row) return null;
  const root = resolve(readingAssetsRoot(), libraryId);
  const full = resolve(root, row.adapter_key);
  const rel = relative(root, full);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) return null;
  if (!existsSync(full)) return null;
  return { path: full, mime: row.mime };
}

/** After the undo window, drop snapshot bytes/progress and keep the tombstone. */
export function cleanupExpiredRemovals(db: Db, now = nowIso()): void {
  const rows = db
    .prepare(
      `SELECT id, library_id FROM reading_documents
        WHERE removed_at IS NOT NULL AND undo_expires_at IS NOT NULL AND undo_expires_at <= ?`,
    )
    .all(now) as { id: string; library_id: string }[];
  for (const row of rows) {
    // Row ids may originate outside this process; never touch the filesystem
    // unless the id resolves strictly inside the cache root.
    const dir = safeAssetPath(row.library_id, row.id);
    if (dir) rmSync(dir, { recursive: true, force: true });
    db.prepare(`DELETE FROM reading_assets WHERE document_id = ?`).run(row.id);
    db.prepare(`DELETE FROM reading_progress WHERE library_id = ? AND document_id = ?`).run(row.library_id, row.id);
    db.prepare(
      `UPDATE reading_documents SET
         content_blocks = NULL, search_text = NULL, content_hash = NULL, hero_asset_id = NULL,
         excerpt = NULL, word_count = NULL, reading_minutes = NULL,
         undo_token = NULL, undo_expires_at = NULL, updated_at = ?
       WHERE id = ?`,
    ).run(now, row.id);
  }
}
