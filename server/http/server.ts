import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { spawn, type ChildProcess } from "node:child_process";
import { createReadStream, createWriteStream, existsSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { Transform } from "node:stream";
import type { Db } from "../../db/open.ts";
import { browserProfileDir, newId, nowIso } from "../../db/open.ts";
import {
  addNote,
  addTag,
  addToCollection,
  createCollection,
  getSetting,
  MissingResource,
  removeFromCollection,
  removeTag,
  setSetting,
  setStatus,
} from "../../core/commands.ts";
import { buildSummary, getItem, itemCounts, listCollections, listItems, listItemsPage, listTags, wipeLibrary } from "../../core/library.ts";
import { isItemStatus, isSourceId, recoveryText, type SourceId } from "../../core/types.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { parseBatch, parseFinish, parseSession } from "../../packages/protocol/validate.ts";
import {
  CaptureAuthorizationError,
  cancelRun,
  failRun,
  finishSession,
  ingestBatch,
  issueToken,
  knownCompleteIds,
  lookupToken,
  revokeTokensForAccount,
  startSession,
} from "../capture/ingest.ts";
import { importJsonl } from "../import.ts";
import { scheduleXEnrich } from "../enrich.ts";
import { importRedditExport } from "../../importers/reddit-export/index.ts";
import { cancelRunner, deleteProfile, getProgress, isRunning, markDone, markRunning, setProgress, startRunner } from "../../runner/index.ts";
import { canAccessJob, cancelJobs, enqueueJob, extensionAlive, finishJob, getJob, heartbeat, waitJob } from "../capture/jobs.ts";
import { frameCheck, linkPreview } from "./preview.ts";
import { filterCitations, type SummarySnapshotV1 } from "../../core/summaries.ts";
import { classifySourceAccount } from "../source-state.ts";
import {
  LOCAL_LIBRARY_ID,
  backfillReading,
  getReadingDocument,
  listReadingDocuments,
  openReadingAsset,
  removeReadingDocument,
  retryReadingDocument,
  startReadingWorker,
  stopReadingWorker,
  undoRemoveReadingDocument,
  updateReadingProgress,
  wakeReadingWorker,
  type ReadingSort,
  type ReadingView,
} from "../reading/module.ts";
import {
  ArchiveTooLarge,
  importLibraryArchive,
  LibraryConflict,
  MAX_LIBRARY_ARCHIVE_BYTES,
  writeLibraryArchive,
} from "../library-archive.ts";
import {
  allowedHost,
  allowedOrigin,
  csrfToken,
  loadInstall,
  sessionCookie,
  validCsrf,
  validSession,
} from "./session.ts";

const PORT = Number(process.env.LOCUS_PORT || 8787);
const ROOT = join(import.meta.dirname, "../..");

// Keep ordinary API/capture requests bounded while allowing a documented,
// larger envelope for the two user-driven import endpoints.
export const MAX_REQUEST_BODY_BYTES = 1 * 1024 * 1024;
export const MAX_IMPORT_BODY_BYTES = 25 * 1024 * 1024;

type RouteFn = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: unknown,
  params: Record<string, string>,
) => Promise<void>;

export function listen(db: Db): { port: number; close: () => Promise<void> } {
  const install = loadInstall();
  if (!getSetting(db, "refreshOnOpen")) setSetting(db, "refreshOnOpen", "0");
  // Existing libraries get local candidate rows on boot; this never fetches the web.
  backfillReading(db, LOCAL_LIBRARY_ID);
  if (process.env.LOCUS_READING_WORKER !== "0") startReadingWorker(db);

  const routes = new Map<string, RouteFn>();
  const matchers: { method: string; re: RegExp; keys: string[]; fn: RouteFn }[] = [];

  const on = (method: string, path: string, fn: RouteFn) => {
    if (!path.includes(":")) {
      routes.set(`${method} ${path}`, fn);
      return;
    }
    const keys: string[] = [];
    const re = new RegExp(`^${path.replace(/:([A-Za-z]+)/g, (_, k) => {
      keys.push(k);
      return "([^/]+)";
    })}$`);
    matchers.push({ method, re, keys, fn });
  };

  on("GET", "/api/session", async (_req, res) => {
    json(res, 200, { csrf: csrfToken(install), port: PORT });
  });

  on("GET", "/api/items", async (_req, res, url) => {
    const view = url.searchParams.get("view") === "inbox" ? "inbox" : "recent";
    const source = url.searchParams.get("source") ?? undefined;
    const q = url.searchParams.get("q") ?? undefined;
    const collectionId = url.searchParams.get("collectionId") ?? undefined;
    const shelf = url.searchParams.get("shelf") ?? undefined;
    const cursor = url.searchParams.get("cursor") ?? undefined;
    const requested = Number(url.searchParams.get("limit") ?? 50);
    const page = listItemsPage(db, { view, source, q, collectionId, shelf }, { cursor, limit: Number.isFinite(requested) ? requested : 50 });
    json(res, 200, { items: page.items, nextCursor: page.nextCursor, counts: page.counts });
  });

  on("GET", "/api/items/counts", async (_req, res, url) => {
    const view = url.searchParams.get("view") === "inbox" ? "inbox" : "recent";
    const source = url.searchParams.get("source") ?? undefined;
    const q = url.searchParams.get("q") ?? undefined;
    const collectionId = url.searchParams.get("collectionId") ?? undefined;
    const shelf = url.searchParams.get("shelf") ?? undefined;
    json(res, 200, { counts: itemCounts(db, { view, source, q, collectionId, shelf }) });
  });

  on("GET", "/api/items/:id", async (_req, res, _url, _body, params) => {
    const item = getItem(db, params.id ?? "");
    if (!item) return json(res, 404, { error: "not found" });
    json(res, 200, { item });
  });

  on("POST", "/api/items/:id/status", async (_req, res, _url, body, params) => {
    const rec = asRec(body);
    const status = String(rec.status ?? "");
    if (!isItemStatus(status)) return json(res, 400, { error: "invalid status" });
    setStatus(db, params.id ?? "", status, typeof rec.snoozedUntil === "string" ? rec.snoozedUntil : undefined);
    json(res, 200, { item: getItem(db, params.id ?? "") });
  });

  on("POST", "/api/items/:id/tags", async (_req, res, _url, body, params) => {
    const rec = asRec(body);
    const tag = addTag(db, params.id ?? "", String(rec.name ?? ""), typeof rec.color === "string" ? rec.color : undefined);
    json(res, 200, { tag, item: getItem(db, params.id ?? "") });
  });

  on("POST", "/api/items/:id/tags/remove", async (_req, res, _url, body, params) => {
    removeTag(db, params.id ?? "", String(asRec(body).tagId ?? ""));
    json(res, 200, { item: getItem(db, params.id ?? "") });
  });

  on("POST", "/api/items/:id/notes", async (_req, res, _url, body, params) => {
    addNote(db, params.id ?? "", String(asRec(body).body ?? ""));
    json(res, 200, { item: getItem(db, params.id ?? "") });
  });

  on("POST", "/api/items/:id/collections", async (_req, res, _url, body, params) => {
    addToCollection(db, params.id ?? "", String(asRec(body).collectionId ?? ""));
    json(res, 200, { item: getItem(db, params.id ?? "") });
  });

  on("POST", "/api/items/:id/collections/remove", async (_req, res, _url, body, params) => {
    removeFromCollection(db, params.id ?? "", String(asRec(body).collectionId ?? ""));
    json(res, 200, { item: getItem(db, params.id ?? "") });
  });

  on("POST", "/api/items/auto-tag", async (_req, res) => {
    const rows = db
      .prepare(
        `SELECT i.id, i.title, i.body, i.url FROM items i
         LEFT JOIN memberships m ON m.item_id = i.id AND m.target_kind = 'tag'
         WHERE m.target_id IS NULL
         ORDER BY i.first_observed_at DESC`,
      )
      .all() as { id: string; title: string | null; body: string | null; url: string }[];
    if (rows.length === 0) {
      console.info("auto-tag: nothing untagged");
      return json(res, 200, { tagged: 0, applied: 0 });
    }
    console.info(`auto-tag: asking Pi about ${rows.length} posts`);
    try {
      const mod = await import("../../optional/tagging/pi.ts");
      const byItem = await mod.autoTagWithPi(rows);
      let applied = 0;
      for (const [itemId, tags] of Object.entries(byItem)) {
        for (const tag of tags) {
          addTag(db, itemId, tag);
          applied++;
        }
      }
      console.info(`auto-tag: tagged ${Object.keys(byItem).length} posts (${applied} tags)`);
      json(res, 200, { tagged: Object.keys(byItem).length, applied });
    } catch (error) {
      console.error("auto-tag failed:", error instanceof Error ? error.message : error);
      json(res, 502, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  on("GET", "/api/collections", async (_req, res) => {
    json(res, 200, { collections: listCollections(db), tags: listTags(db) });
  });

  on("GET", "/api/link-preview", async (_req, res, url) => {
    json(res, 200, { preview: await linkPreview(db, url.searchParams.get("url") ?? "") });
  });

  // Library id is always "local" on localhost. Clients cannot choose it.
  on("GET", "/api/reading", async (_req, res, url) => {
    json(res, 200, listReadingDocuments(db, LOCAL_LIBRARY_ID, parseReadingQuery(url)));
  });

  on("GET", "/api/reading/:documentId", async (_req, res, _url, _body, params) => {
    json(res, 200, { document: getReadingDocument(db, LOCAL_LIBRARY_ID, params.documentId ?? "") });
  });

  on("GET", "/api/reading/:documentId/assets/:assetId", async (_req, res, _url, _body, params) => {
    const file = openReadingAsset(db, LOCAL_LIBRARY_ID, params.documentId ?? "", params.assetId ?? "");
    if (!file) return json(res, 404, { error: "not found" });
    res.writeHead(200, { "content-type": file.mime, "cache-control": "private, max-age=31536000" });
    createReadStream(file.path).pipe(res);
  });

  on("POST", "/api/reading/:documentId/retry", async (_req, res, _url, _body, params) => {
    json(res, 200, { document: await retryReadingDocument(db, LOCAL_LIBRARY_ID, params.documentId ?? "") });
  });

  on("POST", "/api/reading/:documentId/progress", async (_req, res, _url, body, params) => {
    json(res, 200, { progress: updateReadingProgress(db, LOCAL_LIBRARY_ID, params.documentId ?? "", asRec(body)) });
  });

  on("POST", "/api/reading/:documentId/remove", async (_req, res, _url, _body, params) => {
    json(res, 200, removeReadingDocument(db, LOCAL_LIBRARY_ID, params.documentId ?? ""));
  });

  on("POST", "/api/reading/undo-remove", async (_req, res, _url, body) => {
    json(res, 200, { document: undoRemoveReadingDocument(db, LOCAL_LIBRARY_ID, String(asRec(body).token ?? "")) });
  });

  on("GET", "/api/frame-check", async (_req, res, url) => {
    json(res, 200, { framed: await frameCheck(url.searchParams.get("url") ?? "") });
  });

  on("POST", "/api/collections", async (_req, res, _url, body) => {
    const rec = asRec(body);
    const col = createCollection(db, String(rec.name ?? ""), typeof rec.description === "string" ? rec.description : undefined);
    json(res, 200, { collection: col, collections: listCollections(db) });
  });

  on("GET", "/api/summaries/:scope/:ref", async (_req, res, _url, _body, params) => {
    const scope = params.scope;
    if (scope !== "day" && scope !== "collection" && scope !== "selection" && scope !== "item") {
      return json(res, 400, { error: "bad scope" });
    }
    const ref = decodeURIComponent(params.ref ?? "");
    json(res, 200, { snapshot: buildSummary(db, scope, ref), pi: await piStatus() });
  });

  on("POST", "/api/summaries/:scope/:ref/prose", async (_req, res, _url, _body, params) => {
    const scope = params.scope;
    if (scope !== "day" && scope !== "collection" && scope !== "selection" && scope !== "item") {
      return json(res, 400, { error: "bad scope" });
    }
    const snapshot = buildSummary(db, scope, decodeURIComponent(params.ref ?? ""));
    try {
      const gen = await loadPiGenerator();
      if (!gen) return json(res, 400, { error: "Pi is not available. Run `pi` and /login, or install optional/summaries/pi." });
      const prose = await gen.generate(snapshot);
      const citations = filterCitations(prose.citations, snapshot.items.map((i) => i.id));
      json(res, 200, { prose: { ...prose, citations }, snapshot });
    } catch (error) {
      json(res, 502, { error: error instanceof Error ? error.message : String(error), snapshot });
    }
  });

  on("GET", "/api/export", async (_req, res) => {
    const tmp = join(tmpdir(), `locus-export-${newId()}.ndjson`);
    try {
      const bytes = writeLibraryArchive(db, tmp);
      res.writeHead(200, {
        "content-type": "application/x-ndjson; charset=utf-8",
        "content-disposition": 'attachment; filename="locus-library.locus.ndjson"',
        "content-length": String(bytes),
        "cache-control": "no-store",
      });
      const stream = createReadStream(tmp);
      const done = () => rmSync(tmp, { force: true });
      stream.on("close", done);
      stream.on("error", done);
      stream.pipe(res);
    } catch (error) {
      rmSync(tmp, { force: true });
      throw error;
    }
  });

  on("POST", "/api/library/import", async (req, res) => {
    const tmp = join(tmpdir(), `locus-import-${newId()}.ndjson`);
    try {
      await streamRequestToFile(req, tmp, MAX_LIBRARY_ARCHIVE_BYTES);
      const result = await importLibraryArchive(db, tmp);
      wakeReadingWorker(db);
      json(res, 200, result);
    } finally {
      rmSync(tmp, { force: true });
    }
  });

  on("POST", "/api/library/delete", async (_req, res, _url, body) => {
    if (asRec(body).confirm !== "DELETE") return json(res, 400, { error: "confirm must be DELETE" });
    wipeLibrary(db);
    json(res, 200, { ok: true });
  });


  on("GET", "/api/sources", async (_req, res) => {
    json(res, 200, {
      sources: sourceOverview(db),
      settings: { refreshOnOpen: getSetting(db, "refreshOnOpen") === "1" },
      pi: await piStatus(),
      extension: { alive: extensionAlive() },
    });
  });

  on("POST", "/api/settings", async (_req, res, _url, body) => {
    const rec = asRec(body);
    if (typeof rec.refreshOnOpen === "boolean") setSetting(db, "refreshOnOpen", rec.refreshOnOpen ? "1" : "0");
    json(res, 200, { refreshOnOpen: getSetting(db, "refreshOnOpen") === "1" });
  });

  on("POST", "/api/sources/:source/connect", async (_req, res, _url, body, params) => {
    await beginCapture(db, res, params?.source ?? "", body);
  });

  on("POST", "/api/sources/:source/refresh", async (_req, res, _url, body, params) => {
    await beginCapture(db, res, params?.source ?? "", body);
  });

  on("POST", "/api/sources/:source/resume", async (_req, res, _url, body, params) => {
    await beginCapture(db, res, params?.source ?? "", body);
  });

  on("POST", "/api/sources/:source/cancel", async (_req, res, _url, body, params) => {
    const source = params.source ?? "";
    if (!isSourceId(source)) return json(res, 400, { error: "unknown source" });
    const accountId = String(asRec(body).accountId ?? "");
    const account = lookupSourceAccount(db, source, accountId);
    if (!account || account.accountKind === "imported") return json(res, 404, { error: "unknown source account" });
    cancelRunner(source, accountId);
    cancelJobs(source, accountId);
    const run = latestRun(db, source, accountId);
    if (run) cancelRun(db, run.id);
    json(res, 200, { ok: true });
  });

  on("POST", "/api/sources/:source/disconnect", async (_req, res, _url, body, params) => {
    const source = params.source ?? "";
    if (!isSourceId(source)) return json(res, 400, { error: "unknown source" });
    const accountId = String(asRec(body).accountId ?? "");
    if (!accountId) return json(res, 400, { error: "accountId required" });
    const account = lookupSourceAccount(db, source, accountId);
    if (!account || account.accountKind === "imported") return json(res, 404, { error: "unknown source account" });
    cancelRunner(source, accountId);
    revokeTokensForAccount(db, accountId);
    deleteProfile(source, accountId);
    json(res, 200, { ok: true, profile: browserProfileDir(source, accountId) });
  });

  on("POST", "/api/sources/:source/pair-extension", async (_req, res, _url, _body, params) => {
    const source = params.source ?? "";
    if (!isSourceId(source)) return json(res, 400, { error: "unknown source" });
    const account = ensurePendingAccount(db, source);
    const { token } = issueToken(db, source, account.id);
    json(res, 200, { token, account, origin: `http://127.0.0.1:${PORT}` });
  });

  on("GET", "/api/sources/:source/health", async (_req, res, url, _body, params) => {
    const source = params.source ?? "";
    if (!isSourceId(source)) return json(res, 400, { error: "unknown source" });
    const accountId = url.searchParams.get("accountId") ?? undefined;
    if (accountId && !lookupSourceAccount(db, source, accountId)) return json(res, 404, { error: "unknown source account" });
    json(res, 200, { health: sourceHealth(db, source, accountId) });
  });

  on("POST", "/api/import/jsonl", async (_req, res, _url, body) => {
    const rec = asRec(body);
    const text = String(rec.text ?? "");
    const dryRun = Boolean(rec.dryRun);
    const result = importJsonl(db, text, { dryRun });
    if (!dryRun) scheduleXEnrich(db);
    json(res, 200, result);
  });

  on("POST", "/api/import/reddit-export", async (_req, res, _url, body) => {
    const rec = asRec(body);
    json(
      res,
      200,
      importRedditExport(db, String(rec.postsCsv ?? ""), String(rec.commentsCsv ?? ""), { dryRun: Boolean(rec.dryRun) }),
    );
  });

  on("POST", "/capture/v1/hello", async (req, res, _url, body) => {
    heartbeat();
    const offered = String(asRec(body).token ?? bearer(req) ?? "");
    const existing = offered ? lookupToken(db, offered) : null;
    if (existing && !existing.revokedAt && existing.source === "*") {
      return json(res, 200, { token: offered, origin: `http://127.0.0.1:${PORT}` });
    }
    const { token } = issueToken(db, "*", null);
    json(res, 200, { token, origin: `http://127.0.0.1:${PORT}` });
  });

  on("GET", "/capture/v1/jobs/wait", async (req, res) => {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing token" });
    const row = lookupToken(db, token);
    if (!row || row.revokedAt) return json(res, 401, { error: "invalid token" });
    const ac = new AbortController();
    req.on("close", () => ac.abort());
    const job = await waitJob(25_000, ac.signal, row);
    if (!job) {
      res.writeHead(204).end();
      return;
    }
    json(res, 200, { id: job.id, source: job.source, url: job.url });
  });

  on("GET", "/capture/v1/jobs/:id", async (req, res, _url, _body, params) => {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing token" });
    const row = lookupToken(db, token);
    if (!row || row.revokedAt) return json(res, 401, { error: "invalid token" });
    const job = getJob(params.id ?? "");
    if (!job) return json(res, 404, { error: "unknown job" });
    if (!canAccessJob(job, row)) return json(res, 403, { error: "token cannot access this job" });
    json(res, 200, job);
  });

  on("POST", "/capture/v1/jobs/:id/progress", async (req, res, _url, body, params) => {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing token" });
    const row = lookupToken(db, token);
    if (!row || row.revokedAt) return json(res, 401, { error: "invalid token" });
    const job = getJob(params.id ?? "");
    if (!job) return json(res, 404, { error: "unknown job" });
    if (!canAccessJob(job, row)) return json(res, 403, { error: "token cannot access this job" });
    const rec = asRec(body);
    const phase = String(rec.phase ?? "capturing") as "opening" | "waiting-login" | "capturing" | "done" | "error";
    setProgress(job.source, job.accountId, {
      phase,
      message: String(rec.message ?? ""),
      seen: typeof rec.seen === "number" ? rec.seen : undefined,
      upserted: typeof rec.upserted === "number" ? rec.upserted : undefined,
    });
    json(res, 200, { cancelled: job.status === "cancelled" });
  });

  on("POST", "/capture/v1/jobs/:id/finish", async (req, res, _url, body, params) => {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing token" });
    const row = lookupToken(db, token);
    if (!row || row.revokedAt) return json(res, 401, { error: "invalid token" });
    const job = getJob(params.id ?? "");
    if (!job) return json(res, 404, { error: "unknown job" });
    if (!canAccessJob(job, row)) return json(res, 403, { error: "token cannot access this job" });
    finishJob(job.id);
    const rec = asRec(body);
    setProgress(job.source, job.accountId, {
      phase: rec.error ? "error" : "done",
      message: String(rec.message ?? (rec.error ? String(rec.error) : "Done.")),
      coverage: rec.error ? "partial" : "complete",
      seen: typeof rec.seen === "number" ? rec.seen : undefined,
      upserted: typeof rec.upserted === "number" ? rec.upserted : undefined,
    });
    markDone(job.source, job.accountId);
    json(res, 200, { ok: true });
  });

  on("GET", "/capture/v1/known", async (req, res, url) => {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing token" });
    const row = lookupToken(db, token);
    if (!row || row.revokedAt) return json(res, 401, { error: "invalid token" });
    const asked = url.searchParams.get("source");
    const source = row.source === "*" && asked && isSourceId(asked) ? asked : row.source;
    const accountId = row.source === "*" ? null : row.sourceAccountId;
    json(res, 200, { done: knownCompleteIds(db, source, accountId) });
  });

  on("POST", "/capture/v1/sessions", async (req, res, _url, body) => {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing token" });
    const row = lookupToken(db, token);
    if (!row || row.revokedAt) return json(res, 401, { error: "invalid token" });
    const session = parseSession(body);
    const started = startSession(db, row, session);
    json(res, 200, started);
  });

  on("POST", "/capture/v1/batches", async (req, res, _url, body) => {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing token" });
    const row = lookupToken(db, token);
    if (!row || row.revokedAt) return json(res, 401, { error: "invalid token" });
    const batch = parseBatch(body);
    const result = ingestBatch(db, batch, { token: row });
    const urls = batch.changes.flatMap((c) => (c.kind === "upsert" && c.item.url ? [c.item.url] : []));
    if (urls.length) scheduleXEnrich(db, urls);
    json(res, 200, result);
  });

  on("POST", "/capture/v1/finish", async (req, res, _url, body) => {
    const token = bearer(req);
    if (!token) return json(res, 401, { error: "missing token" });
    const row = lookupToken(db, token);
    if (!row || row.revokedAt) return json(res, 401, { error: "invalid token" });
    const finish = parseFinish(body);
    json(res, 200, finishSession(db, finish, row));
  });

  const server = createServer(async (req, res) => {
    try {
      const host = req.headers.host;
      if (!allowedHost(host, PORT)) {
        res.writeHead(400).end("bad host");
        return;
      }
      const url = new URL(req.url || "/", `http://${host}`);
      if (req.method === "OPTIONS") {
        res.writeHead(204, corsHeaders(req, url.pathname)).end();
        return;
      }

      const isCapture = url.pathname.startsWith("/capture/");
      const isApi = url.pathname.startsWith("/api/");
      const mutating = req.method !== "GET" && req.method !== "HEAD";
      const archiveImport = url.pathname === "/api/library/import" && req.method === "POST";
      const bodyLimit = archiveImport
        ? MAX_LIBRARY_ARCHIVE_BYTES
        : url.pathname.startsWith("/api/import/")
          ? MAX_IMPORT_BODY_BYTES
          : MAX_REQUEST_BODY_BYTES;
      if (mutating && (isApi || isCapture) && declaredContentLength(req) > bodyLimit) {
        req.resume();
        json(res, 413, { error: "request body too large" });
        return;
      }
      if (mutating && (isApi || isCapture)) console.info(`${req.method} ${url.pathname}`);

      if (isApi || isCapture) {
        const origin = req.headers.origin;
        if (origin && !allowedOrigin(origin, PORT) && !isCapture) {
          res.writeHead(403).end("bad origin");
          return;
        }
        if (isApi) {
          if (!validSession(install, req.headers.cookie)) {
            if (url.pathname === "/api/session") {
              // fall through after cookie set below
            } else if (!readBodySoon) {
              // still require session except first /api/session
            }
          }
          const hasSession = validSession(install, req.headers.cookie);
          if (!hasSession && url.pathname !== "/api/session") {
            res.writeHead(401, { "set-cookie": cookieHeader(install) }).end(JSON.stringify({ error: "no session" }));
            return;
          }
          if (mutating && !isCapture) {
            const csrf = String(req.headers["x-csrf-token"] || "");
            if (!validCsrf(install, csrf)) {
              res.writeHead(403).end(JSON.stringify({ error: "csrf" }));
              return;
            }
          }
        }
      }

      if (url.pathname === "/api/session" && req.method === "GET") {
        res.setHeader("set-cookie", cookieHeader(install));
      }

      const body = mutating && !archiveImport ? await readJson(req, bodyLimit) : null;
      const key = `${req.method} ${url.pathname}`;
      const exact = routes.get(key);
      if (exact) {
        await exact(req, res, url, body, {});
        return;
      }
      for (const m of matchers) {
        if (m.method !== req.method) continue;
        const hit = url.pathname.match(m.re);
        if (!hit) continue;
        const params: Record<string, string> = {};
        m.keys.forEach((k, i) => {
          params[k] = decodeURIComponent(hit[i + 1] ?? "");
        });
        await m.fn(req, res, url, body, params);
        return;
      }

      await serveApp(req, res, url);
    } catch (error) {
      if (error instanceof RequestTooLarge || error instanceof ArchiveTooLarge) {
        json(res, 413, { error: error.message });
        return;
      }
      if (error instanceof LibraryConflict) {
        json(res, 409, { error: error.message });
        return;
      }
      if (error instanceof MissingResource) {
        json(res, 404, { error: error.message });
        return;
      }
      if (error instanceof CaptureAuthorizationError) {
        json(res, error.statusCode, { error: error.message });
        return;
      }
      if (error instanceof RejectedPayload) {
        json(res, 400, { error: error.message });
        return;
      }
      json(res, 500, { error: error instanceof Error ? error.message : String(error) });
    }
  });

  // patch on() to accept params by wrapping matcher fns — handled above

  let vite: ChildProcess | null = null;
  if (process.env.NODE_ENV !== "production" && process.env.LOCUS_NO_VITE !== "1") {
    vite = spawn("npx", ["vite"], { cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    vite.stdout?.on("data", (b) => process.stdout.write(`[vite] ${b}`));
    vite.stderr?.on("data", (b) => process.stderr.write(`[vite] ${b}`));
  }

  if (getSetting(db, "refreshOnOpen") === "1") {
    refreshOnOpen(db);
  }

  server.listen(PORT, "127.0.0.1");
  return {
    port: PORT,
    close: async () => {
      stopReadingWorker(db);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      vite?.kill();
    },
  };
}

const readBodySoon = false;

function cookieHeader(install: ReturnType<typeof loadInstall>): string {
  return `locus_session=${sessionCookie(install)}; Path=/; HttpOnly; SameSite=Lax`;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }).end(data);
}

function corsHeaders(req: IncomingMessage, pathname: string): Record<string, string> {
  const origin = typeof req.headers.origin === "string" ? req.headers.origin : "";
  if (pathname.startsWith("/capture/") && origin.startsWith("chrome-extension://")) {
    return {
      "access-control-allow-origin": origin,
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "GET, POST, OPTIONS",
    };
  }
  return {};
}

function asRec(body: unknown): Record<string, unknown> {
  if (!body || typeof body !== "object") return {};
  return body as Record<string, unknown>;
}

function parseReadingQuery(url: URL): {
  view?: ReadingView;
  kind?: string;
  source?: string;
  q?: string;
  sort?: ReadingSort;
  cursor?: string;
  limit?: number;
} {
  const viewRaw = url.searchParams.get("view");
  const sortRaw = url.searchParams.get("sort");
  const view = viewRaw === "finished" || viewRaw === "queue" ? viewRaw : undefined;
  const sort =
    sortRaw === "recent" || sortRaw === "oldest" || sortRaw === "shortest" || sortRaw === "longest" || sortRaw === "publication"
      ? sortRaw
      : undefined;
  const limitRaw = url.searchParams.get("limit");
  const limit = limitRaw ? Number(limitRaw) : undefined;
  return {
    view,
    kind: url.searchParams.get("kind") ?? undefined,
    source: url.searchParams.get("source") ?? undefined,
    q: url.searchParams.get("q") ?? undefined,
    sort,
    cursor: url.searchParams.get("cursor") ?? undefined,
    limit: Number.isFinite(limit) ? limit : undefined,
  };
}

function bearer(req: IncomingMessage): string | null {
  const h = req.headers.authorization;
  if (!h?.startsWith("Bearer ")) return null;
  return h.slice("Bearer ".length).trim();
}

class RequestTooLarge extends Error {
  constructor(limit: number) {
    super(`request body too large (limit ${Math.round(limit / 1024 / 1024)}MB)`);
    this.name = "RequestTooLarge";
  }
}

function declaredContentLength(req: IncomingMessage): number {
  const raw = req.headers["content-length"];
  if (typeof raw !== "string") return 0;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
}

async function streamRequestToFile(req: IncomingMessage, path: string, limit: number): Promise<void> {
  let bytes = 0;
  const limitStream = new Transform({
    transform(chunk, _enc, cb) {
      bytes += chunk.length;
      if (bytes > limit) cb(new ArchiveTooLarge());
      else cb(null, chunk);
    },
  });
  await pipeline(req, limitStream, createWriteStream(path));
}

async function readJson(req: IncomingMessage, limit: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string | Uint8Array);
    bytes += buffer.byteLength;
    if (bytes > limit) continue;
    chunks.push(buffer);
  }
  if (bytes > limit) throw new RequestTooLarge(limit);
  const raw = Buffer.concat(chunks).toString("utf8");
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new RejectedPayload("invalid JSON");
  }
}

async function beginCapture(db: Db, res: ServerResponse, sourceRaw: string, body: unknown): Promise<void> {
  if (!isSourceId(sourceRaw)) {
    json(res, 400, { error: "unknown source" });
    return;
  }
  const account = ensurePendingAccount(
    db,
    sourceRaw,
    typeof asRec(body).accountId === "string" ? String(asRec(body).accountId) : undefined,
  );
  if (isRunning(sourceRaw, account.id)) {
    json(res, 409, { error: "already running", account });
    return;
  }
  if (extensionAlive()) {
    markRunning(sourceRaw, account.id);
    enqueueJob(sourceRaw, account.id);
    setProgress(sourceRaw, account.id, {
      phase: "waiting-login",
      message: `Opening ${sourceLabel(sourceRaw)}…`,
    });
    json(res, 200, {
      account,
      via: "extension",
      copy: `Log in to ${sourceLabel(sourceRaw)} to continue.`,
    });
    return;
  }
  const { token } = issueToken(db, sourceRaw, account.id);
  startRunner({ source: sourceRaw, accountId: account.id, token, baseUrl: `http://127.0.0.1:${PORT}` });
  json(res, 200, {
    account,
    via: "runner",
    copy: `Log in to ${sourceLabel(sourceRaw)} to continue.`,
  });
}

function sourceLabel(source: SourceId): string {
  switch (source) {
    case "x":
      return "X";
    case "instagram":
      return "Instagram";
    case "youtube":
      return "YouTube";
    case "reddit":
      return "Reddit";
    default: {
      const _exhaustive: never = source;
      return _exhaustive;
    }
  }
}

function ensurePendingAccount(db: Db, source: SourceId, accountId?: string): { id: string; source: string; external_id: string } {
  if (accountId) {
    const row = lookupSourceAccount(db, source, accountId);
    if (!row || row.accountKind === "imported") throw new MissingResource("unknown source account");
    return row;
  }
  const rows = db
    .prepare(`SELECT id, source, external_id, account_kind FROM source_accounts WHERE source = ? AND account_kind <> 'imported' ORDER BY created_at DESC`)
    .all(source) as { id: string; source: string; external_id: string; account_kind: "live" }[];
  const reusable = rows.find((row) => {
    const ext = String(row.external_id);
    if (ext.startsWith("fixture:")) return false;
    if (ext.startsWith("pending:")) return true;
    return existsSync(browserProfileDir(source, row.id));
  });
  if (reusable) return reusable;
  const id = newId();
  const external = `pending:${id}`;
  db.prepare(`INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, 'live')`).run(
    id,
    source,
    external,
    sourceLabel(source),
    nowIso(),
  );
  return { id, source, external_id: external };
}

function latestRun(db: Db, source: SourceId, accountId: string): { id: string } | null {
  const row = db
    .prepare(
      `SELECT r.id FROM capture_runs r
       JOIN source_collections c ON c.id = r.source_collection_id
       JOIN source_accounts a ON a.id = c.source_account_id
       WHERE c.source_account_id = ? AND a.source = ? ORDER BY r.started_at DESC LIMIT 1`,
    )
    .get(accountId, source) as { id: string } | undefined;
  return row ?? null;
}

export function lookupSourceAccount(
  db: Db,
  source: SourceId,
  accountId: string,
): { id: string; source: string; external_id: string; accountKind: "live" | "imported" } | undefined {
  return db
    .prepare(`SELECT id, source, external_id, account_kind as accountKind FROM source_accounts WHERE id = ? AND source = ?`)
    .get(accountId, source) as { id: string; source: string; external_id: string; accountKind: "live" | "imported" } | undefined;
}

function sourceOverview(db: Db) {
  const sources: SourceId[] = ["x", "instagram", "youtube", "reddit"];
  return sources.map((source) => ({
    source,
    label: sourceLabel(source),
    accounts: (
      db
        .prepare(`SELECT id, external_id as externalId, display_name as displayName, account_kind as accountKind FROM source_accounts WHERE source = ?`)
        .all(source) as { id: string; externalId: string; displayName: string | null; accountKind: "live" | "imported" }[]
    ).map((account) => sourceHealth(db, source, account.id)),
  }));
}

function sourceHealth(db: Db, source: SourceId, accountId?: string) {
  const account = accountId
    ? (db.prepare(`SELECT id, external_id as externalId, display_name as displayName, account_kind as accountKind FROM source_accounts WHERE id = ? AND source = ?`).get(accountId, source) as
        | { id: string; externalId: string; displayName: string | null; accountKind: "live" | "imported" }
        | undefined)
    : (db.prepare(`SELECT id, external_id as externalId, display_name as displayName, account_kind as accountKind FROM source_accounts WHERE source = ? ORDER BY created_at DESC LIMIT 1`).get(source) as
        | { id: string; externalId: string; displayName: string | null; accountKind: "live" | "imported" }
        | undefined);
  const run = account
    ? (db
        .prepare(
          `SELECT r.* FROM capture_runs r
           JOIN source_collections c ON c.id = r.source_collection_id
           WHERE c.source_account_id = ? ORDER BY r.started_at DESC LIMIT 1`,
        )
        .get(account.id) as
        | {
            id: string;
            status: string;
            coverage: string | null;
            started_at: string;
            finished_at: string | null;
            seen_count: number;
            upserted_count: number;
            removed_count: number;
            error_code: string | null;
            error_detail: string | null;
          }
        | undefined)
    : undefined;
  const live = account ? getProgress(source, account.id) : undefined;
  const running = account ? isRunning(source, account.id) : false;
  const state = account
    ? classifySourceAccount({
        accountKind: account.accountKind,
        externalId: account.externalId,
        captureRunning: running,
        extensionConnected: extensionAlive(),
        runnerProfileExists: existsSync(browserProfileDir(source, account.id)),
      })
    : null;
  return {
    source,
    account: account ? { ...account, state } : null,
    running,
    progress: live ?? null,
    lastRun: run
      ? {
          id: run.id,
          status: run.status,
          coverage: run.coverage,
          startedAt: run.started_at,
          finishedAt: run.finished_at,
          seenCount: run.seen_count,
          upsertedCount: run.upserted_count,
          removedCount: run.removed_count,
          errorCode: run.error_code,
          errorDetail: run.error_detail,
          recovery: run.error_code ? recoveryTextSafe(run.error_code) : null,
          coverageLabel: coverageLabel(run.coverage, run.status),
        }
      : null,
  };
}

function coverageLabel(coverage: string | null, status: string): string {
  if (status === "running") return "Refresh in progress.";
  if (coverage === "complete") return "Last refresh complete.";
  if (coverage === "partial") return "Last refresh was partial.";
  return "Not refreshed yet.";
}

function recoveryTextSafe(code: string): string | null {
  try {
    return recoveryText(code as Parameters<typeof recoveryText>[0]);
  } catch {
    return code;
  }
}

function refreshOnOpen(db: Db): void {
  const accounts = db
    .prepare(`SELECT id, source FROM source_accounts WHERE account_kind <> 'imported' AND external_id NOT LIKE 'pending:%'`)
    .all() as { id: string; source: string }[];
  for (const account of accounts) {
    if (!isSourceId(account.source)) continue;
    if (isRunning(account.source, account.id)) continue;
    if (extensionAlive()) {
      markRunning(account.source, account.id);
      enqueueJob(account.source, account.id);
      setProgress(account.source, account.id, {
        phase: "waiting-login",
        message: `Opening ${sourceLabel(account.source)}…`,
      });
      continue;
    }
    const { token } = issueToken(db, account.source, account.id);
    startRunner({ source: account.source, accountId: account.id, token, baseUrl: `http://127.0.0.1:${PORT}` });
  }
}

async function serveApp(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
  if (process.env.NODE_ENV !== "production") {
    const target = `http://127.0.0.1:5173${url.pathname}${url.search}`;
    try {
      const upstream = await fetch(target, { headers: { accept: req.headers.accept ?? "*/*" } });
      const buf = Buffer.from(await upstream.arrayBuffer());
      const headers: Record<string, string> = {};
      const ct = upstream.headers.get("content-type");
      if (ct) headers["content-type"] = ct;
      res.writeHead(upstream.status, headers).end(buf);
      return;
    } catch {
      res.writeHead(502).end("dashboard bundler is starting — refresh in a moment");
      return;
    }
  }
  const dist = join(ROOT, "dist/app");
  let path = join(dist, url.pathname === "/" ? "index.html" : url.pathname);
  if (!existsSync(path) || url.pathname === "/") path = join(dist, "index.html");
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".json": "application/json",
  };
  res.writeHead(200, { "content-type": types[extname(path)] ?? "application/octet-stream" });
  createReadStream(path).pipe(res);
}

async function piStatus(): Promise<{ available: boolean; detail: string }> {
  try {
    const gen = await loadPiGenerator();
    if (!gen) return { available: false, detail: "Optional Pi generator is not installed. Deterministic summaries still work." };
    return { available: true, detail: "Pi login found. Write as prose is a user-chosen extra." };
  } catch (error) {
    return { available: false, detail: error instanceof Error ? error.message : String(error) };
  }
}

async function loadPiGenerator(): Promise<{ generate: (s: SummarySnapshotV1) => Promise<{ generatorId: string; generatorVersion: string; prose: string; citations: string[] }> } | null> {
  try {
    const mod = await import(`../../optional/summaries/pi/index.ts?t=${Date.now()}`);
    return mod.piSummaryGenerator;
  } catch {
    return null;
  }
}

// unused import guard
void failRun;
void readFileSync;
