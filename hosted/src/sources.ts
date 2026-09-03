import { RejectedPayload } from "../../core/sanitize.ts";
import { isSourceId, SOURCES, type SourceId } from "../../core/types.ts";
import { MissingResource, nowIso } from "./desk.ts";
import {
  isPendingExternalId,
  isPlaceholderDisplayName,
  pickConnectionAccount,
  sourceConnectionState,
  type SourceConnectionState,
} from "./source-helpers.ts";
import {
  CaptureAuthorizationError,
  cancelRun,
  issueToken,
  revokeTokenById,
  revokeTokensForAccount,
  type CaptureToken,
} from "./capture.ts";
import { all, first, run } from "./sql.ts";

export const EXTENSION_STALE_MS = 45_000;
export const JOB_LEASE_MS = 45_000;
export const JOB_WAIT_MS = 25_000;
const JOB_WAIT_POLL_MS = 1_000;

export class CaptureConflict extends Error {
  readonly code = "conflict";
  constructor(message: string) {
    super(message);
    this.name = "CaptureConflict";
  }
}

export class ExtensionRequired extends Error {
  constructor(message = "Pair the browser extension first.") {
    super(message);
    this.name = "ExtensionRequired";
  }
}

const COLLECTION_URL: Record<SourceId, string> = {
  x: "https://x.com/i/bookmarks",
  instagram: "https://www.instagram.com/saves/all-posts/",
  youtube: "https://www.youtube.com/playlist?list=WL",
  reddit: "https://www.reddit.com/user/me/saved/",
};

export function sourceLabel(source: SourceId): string {
  switch (source) {
    case "x":
      return "X";
    case "instagram":
      return "Instagram";
    case "youtube":
      return "YouTube";
    case "reddit":
      return "Reddit";
  }
}

type JobRow = {
  id: string;
  library_id: string;
  source: string;
  source_account_id: string;
  url: string;
  status: "queued" | "running" | "done" | "cancelled";
  token_id: string | null;
  token_plain: string | null;
  progress_json: string | null;
  lease_expires_at: string | null;
};

type JobAuthorization = {
  id: string;
  libraryId: string;
  source: string;
  sourceAccountId: string | null;
};

export type ExtensionHealthState = "not_paired" | "paired" | "needs_attention";

export async function heartbeat(db: D1Database, libraryId: string, at = nowIso()): Promise<void> {
  await run(
    db,
    `INSERT INTO capture_heartbeats (library_id, last_seen_at) VALUES (?, ?)
     ON CONFLICT(library_id) DO UPDATE SET last_seen_at = excluded.last_seen_at`,
    libraryId,
    at,
  );
}

export async function extensionHealth(
  db: D1Database,
  libraryId: string,
  now = Date.now(),
): Promise<{ state: ExtensionHealthState; lastSeenAt: string | null }> {
  const row = await first<{ last_seen_at: string }>(
    db,
    `SELECT last_seen_at FROM capture_heartbeats WHERE library_id = ?`,
    libraryId,
  );
  if (!row) return { state: "not_paired", lastSeenAt: null };
  const lastSeenAt = row.last_seen_at;
  const seen = Date.parse(lastSeenAt);
  if (Number.isNaN(seen) || now - seen >= EXTENSION_STALE_MS) {
    return { state: "needs_attention", lastSeenAt };
  }
  return { state: "paired", lastSeenAt };
}

export async function extensionAlive(db: D1Database, libraryId: string, now = Date.now()): Promise<boolean> {
  return (await extensionHealth(db, libraryId, now)).state === "paired";
}

function canAccessJob(job: JobRow, authorization: JobAuthorization, jobGrant: boolean): boolean {
  if (job.library_id !== authorization.libraryId) return false;
  if (jobGrant) return job.token_id === authorization.id;
  if (authorization.source === "*") return authorization.sourceAccountId === null;
  return (
    authorization.source === job.source &&
    (authorization.sourceAccountId === null || authorization.sourceAccountId === job.source_account_id)
  );
}

async function isJobGrant(db: D1Database, tokenId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(db, `SELECT 1 AS ok FROM capture_jobs WHERE token_id = ?`, tokenId);
  return Boolean(row);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadJob(db: D1Database, jobId: string): Promise<JobRow | null> {
  return first<JobRow>(
    db,
    `SELECT id, library_id, source, source_account_id, url, status, token_id, token_plain, progress_json, lease_expires_at
       FROM capture_jobs WHERE id = ?`,
    jobId,
  );
}

export async function enqueueJob(
  db: D1Database,
  libraryId: string,
  source: SourceId,
  accountId: string,
): Promise<JobRow> {
  const existing = await first<JobRow>(
    db,
    `SELECT id, library_id, source, source_account_id, url, status, token_id, token_plain, progress_json, lease_expires_at
       FROM capture_jobs
      WHERE library_id = ? AND source = ? AND source_account_id = ? AND status IN ('queued', 'running')
      ORDER BY created_at DESC LIMIT 1`,
    libraryId,
    source,
    accountId,
  );
  if (existing) return existing;
  const grant = await issueToken(db, libraryId, source, accountId);
  const now = nowIso();
  const id = crypto.randomUUID().replaceAll("-", "");
  await run(
    db,
    `INSERT INTO capture_jobs (
      id, library_id, source, source_account_id, url, status, token_id, token_plain, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?)`,
    id,
    libraryId,
    source,
    accountId,
    COLLECTION_URL[source],
    grant.tokenId,
    grant.token,
    now,
    now,
  );
  const created = await loadJob(db, id);
  if (!created) throw new Error("Could not enqueue capture job");
  return created;
}

async function claimJob(db: D1Database, authorization: JobAuthorization, now: Date): Promise<JobRow | null> {
  const grant = await isJobGrant(db, authorization.id);
  const candidates = await all<JobRow>(
    db,
    `SELECT id, library_id, source, source_account_id, url, status, token_id, token_plain, progress_json, lease_expires_at
       FROM capture_jobs
      WHERE library_id = ?
        AND status IN ('queued', 'running')
      ORDER BY created_at`,
    authorization.libraryId,
  );
  const nowIsoStamp = now.toISOString();
  const leaseExpired = (job: JobRow) => !job.lease_expires_at || Date.parse(job.lease_expires_at) <= now.getTime();
  for (const job of candidates) {
    if (!canAccessJob(job, authorization, grant)) continue;
    if (job.status === "running" && !leaseExpired(job)) continue;
    if (job.status === "queued" || leaseExpired(job)) {
      const leaseUntil = new Date(now.getTime() + JOB_LEASE_MS).toISOString();
      await run(
        db,
        `UPDATE capture_jobs
            SET status = 'running', lease_expires_at = ?, updated_at = ?
          WHERE id = ?
            AND status IN ('queued', 'running')
            AND (status = 'queued' OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
        leaseUntil,
        nowIsoStamp,
        job.id,
        nowIsoStamp,
      );
      const claimed = await loadJob(db, job.id);
      if (claimed?.status === "running") return claimed;
      continue;
    }
  }
  return null;
}

export async function waitJob(
  db: D1Database,
  token: CaptureToken,
  opts: { waitMs?: number; now?: Date } = {},
): Promise<JobRow | null> {
  await heartbeat(db, token.libraryId);
  const waitMs = opts.waitMs ?? JOB_WAIT_MS;
  const started = opts.now ?? new Date();
  const authorization: JobAuthorization = {
    id: token.id,
    libraryId: token.libraryId,
    source: token.source,
    sourceAccountId: token.sourceAccountId,
  };
  const deadline = started.getTime() + waitMs;
  let now = started;
  while (now.getTime() <= deadline) {
    const job = await claimJob(db, authorization, now);
    if (job) return job;
    if (now.getTime() + JOB_WAIT_POLL_MS > deadline) break;
    await sleep(JOB_WAIT_POLL_MS);
    now = new Date();
  }
  return null;
}

export function jobDeliveryView(job: JobRow): { id: string; source: string; url: string; token?: string } {
  return { id: job.id, source: job.source, url: job.url, ...(job.token_plain ? { token: job.token_plain } : {}) };
}

export function jobStatusView(job: JobRow): { id: string; source: string; url: string; status: JobRow["status"] } {
  return { id: job.id, source: job.source, url: job.url, status: job.status };
}

export async function jobForTokenId(db: D1Database, tokenId: string): Promise<JobRow | null> {
  return first<JobRow>(
    db,
    `SELECT id, library_id, source, source_account_id, url, status, token_id, token_plain, progress_json, lease_expires_at
       FROM capture_jobs WHERE token_id = ?`,
    tokenId,
  );
}

export async function getAccessibleJob(
  db: D1Database,
  token: CaptureToken,
  jobId: string,
): Promise<JobRow> {
  const job = await loadJob(db, jobId);
  if (!job || job.library_id !== token.libraryId) {
    throw new CaptureAuthorizationError(404, "unknown job");
  }
  const grant = await isJobGrant(db, token.id);
  if (
    !canAccessJob(
      job,
      { id: token.id, libraryId: token.libraryId, source: token.source, sourceAccountId: token.sourceAccountId },
      grant,
    )
  ) {
    throw new CaptureAuthorizationError(403, "token cannot access this job");
  }
  return job;
}

export async function touchJobLease(db: D1Database, job: JobRow): Promise<void> {
  if (job.status !== "running") return;
  await heartbeat(db, job.library_id);
  await run(
    db,
    `UPDATE capture_jobs SET lease_expires_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`,
    new Date(Date.now() + JOB_LEASE_MS).toISOString(),
    nowIso(),
    job.id,
  );
}

export async function setJobProgress(
  db: D1Database,
  job: JobRow,
  input: { phase: string; message: string; seen?: number; upserted?: number },
): Promise<{ cancelled: boolean }> {
  const progress = {
    phase: input.phase,
    message: input.message,
    seen: input.seen ?? 0,
    upserted: input.upserted ?? 0,
  };
  await run(
    db,
    `UPDATE capture_jobs SET progress_json = ?, updated_at = ?, lease_expires_at = ? WHERE id = ?`,
    JSON.stringify(progress),
    nowIso(),
    new Date(Date.now() + JOB_LEASE_MS).toISOString(),
    job.id,
  );
  return { cancelled: job.status === "cancelled" };
}

export async function finishCaptureJob(
  db: D1Database,
  job: JobRow,
  input: { error?: string; message?: string; seen?: number; upserted?: number },
): Promise<void> {
  const progress = {
    phase: input.error ? "error" : "done",
    message: input.message ?? (input.error ? String(input.error) : "Done."),
    seen: input.seen ?? 0,
    upserted: input.upserted ?? 0,
    coverage: input.error ? "partial" : "complete",
  };
  await run(
    db,
    `UPDATE capture_jobs SET status = 'done', token_plain = NULL, progress_json = ?, lease_expires_at = NULL, updated_at = ? WHERE id = ? AND status != 'cancelled'`,
    JSON.stringify(progress),
    nowIso(),
    job.id,
  );
  if (job.token_id) await revokeTokenById(db, job.token_id);
}

export async function retargetJobs(db: D1Database, source: string, fromAccountId: string, toAccountId: string): Promise<void> {
  if (fromAccountId === toAccountId) return;
  await run(
    db,
    `UPDATE capture_jobs SET source_account_id = ? WHERE source = ? AND source_account_id = ?`,
    toAccountId,
    source,
    fromAccountId,
  );
}

export async function cancelJobs(db: D1Database, source: SourceId, accountId: string): Promise<JobRow[]> {
  const jobs = await all<JobRow>(
    db,
    `SELECT id, library_id, source, source_account_id, url, status, token_id, token_plain, progress_json, lease_expires_at
       FROM capture_jobs
      WHERE source = ? AND source_account_id = ? AND status NOT IN ('done', 'cancelled')`,
    source,
    accountId,
  );
  for (const job of jobs) {
    await run(
      db,
      `UPDATE capture_jobs SET status = 'cancelled', token_plain = NULL, updated_at = ? WHERE id = ?`,
      nowIso(),
      job.id,
    );
    if (job.token_id) await revokeTokenById(db, job.token_id);
  }
  return jobs;
}

async function isRunning(db: D1Database, libraryId: string, source: SourceId, accountId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(
    db,
    `SELECT 1 AS ok FROM capture_jobs
      WHERE library_id = ? AND source = ? AND source_account_id = ? AND status IN ('queued', 'running')`,
    libraryId,
    source,
    accountId,
  );
  return Boolean(row);
}

async function lookupSourceAccount(
  db: D1Database,
  libraryId: string,
  source: SourceId,
  accountId: string,
): Promise<{ id: string; source: string; external_id: string; accountKind: "live" | "imported" | "disconnected" } | null> {
  const row = await first<{
    id: string;
    source: string;
    external_id: string;
    account_kind: "live" | "imported" | "disconnected";
  }>(
    db,
    `SELECT id, source, external_id, account_kind FROM source_accounts WHERE id = ? AND source = ? AND library_id = ?`,
    accountId,
    source,
    libraryId,
  );
  if (!row) return null;
  return { id: row.id, source: row.source, external_id: row.external_id, accountKind: row.account_kind };
}

async function reviveAccount(db: D1Database, accountId: string): Promise<void> {
  await run(db, `UPDATE source_accounts SET account_kind = 'live' WHERE id = ? AND account_kind = 'disconnected'`, accountId);
}

export async function ensurePendingAccount(
  db: D1Database,
  libraryId: string,
  source: SourceId,
  accountId?: string,
): Promise<{ id: string; source: string; external_id: string }> {
  if (accountId) {
    const row = await lookupSourceAccount(db, libraryId, source, accountId);
    if (!row || row.accountKind === "imported") throw new MissingResource("unknown source account");
    if (row.accountKind === "disconnected") await reviveAccount(db, row.id);
    return row;
  }
  const rows = await all<{ id: string; source: string; external_id: string; account_kind: string }>(
    db,
    `SELECT id, source, external_id, account_kind FROM source_accounts WHERE library_id = ? AND source = ? ORDER BY created_at DESC`,
    libraryId,
    source,
  );
  const live = rows.filter((row) => row.account_kind === "live");
  const resolved = live.find((row) => !isPendingExternalId(row.external_id));
  if (resolved) return resolved;
  const pending = live.find((row) => isPendingExternalId(row.external_id));
  if (pending) return pending;
  const disconnected = rows.find((row) => row.account_kind === "disconnected");
  if (disconnected) {
    await reviveAccount(db, disconnected.id);
    return disconnected;
  }
  const id = crypto.randomUUID();
  const external = `pending:${id}`;
  await run(
    db,
    `INSERT INTO source_accounts (id, library_id, source, external_id, display_name, created_at, account_kind)
     VALUES (?, ?, ?, ?, ?, ?, 'live')`,
    id,
    libraryId,
    source,
    external,
    null,
    nowIso(),
  );
  return { id, source, external_id: external };
}

async function latestRun(
  db: D1Database,
  accountId: string,
): Promise<{ id: string } | null> {
  return first<{ id: string }>(
    db,
    `SELECT r.id
       FROM capture_runs r
       JOIN source_collections c ON c.id = r.source_collection_id
      WHERE c.source_account_id = ? AND r.finished_at IS NULL
      ORDER BY r.started_at DESC LIMIT 1`,
    accountId,
  );
}

export async function beginCapture(
  db: D1Database,
  libraryId: string,
  sourceRaw: string,
  accountId?: string,
): Promise<{ account: { id: string; source: string; external_id: string }; via: "extension"; copy: string }> {
  if (!isSourceId(sourceRaw)) throw new RejectedPayload("unknown source");
  if (!(await extensionAlive(db, libraryId))) throw new ExtensionRequired();
  const account = await ensurePendingAccount(db, libraryId, sourceRaw, accountId);
  if (await isRunning(db, libraryId, sourceRaw, account.id)) {
    throw new CaptureConflict("already running");
  }
  await enqueueJob(db, libraryId, sourceRaw, account.id);
  return {
    account,
    via: "extension",
    copy: `Log in to ${sourceLabel(sourceRaw)} to continue.`,
  };
}

export async function cancelCapture(db: D1Database, libraryId: string, sourceRaw: string, accountId: string): Promise<void> {
  if (!isSourceId(sourceRaw)) throw new RejectedPayload("unknown source");
  const account = await lookupSourceAccount(db, libraryId, sourceRaw, accountId);
  if (!account || account.accountKind !== "live") throw new MissingResource("unknown source account");
  await cancelJobs(db, sourceRaw, accountId);
  const runRow = await latestRun(db, accountId);
  if (runRow) await cancelRun(db, runRow.id);
  if (isPendingExternalId(account.external_id)) {
    await run(db, `DELETE FROM source_accounts WHERE id = ?`, accountId);
  }
}

async function hasSourceRecords(db: D1Database, accountId: string): Promise<boolean> {
  const row = await first<{ ok: number }>(db, `SELECT 1 AS ok FROM source_records WHERE source_account_id = ?`, accountId);
  return Boolean(row);
}

export async function disconnectSource(
  db: D1Database,
  libraryId: string,
  sourceRaw: string,
  accountId: string,
): Promise<void> {
  if (!isSourceId(sourceRaw)) throw new RejectedPayload("unknown source");
  const account = await lookupSourceAccount(db, libraryId, sourceRaw, accountId);
  if (!account || account.accountKind !== "live") throw new MissingResource("unknown source account");
  await cancelJobs(db, sourceRaw, accountId);
  const runRow = await latestRun(db, accountId);
  if (runRow) await cancelRun(db, runRow.id);
  await revokeTokensForAccount(db, accountId);
  if (await hasSourceRecords(db, accountId)) {
    await run(db, `UPDATE source_accounts SET account_kind = 'disconnected' WHERE id = ?`, accountId);
    return;
  }
  await run(db, `DELETE FROM source_accounts WHERE id = ?`, accountId);
}

export async function pairExtension(
  db: D1Database,
  libraryId: string,
  origin: string,
): Promise<{ token: string; origin: string }> {
  const { token } = await issueToken(db, libraryId, "*", null);
  return { token, origin };
}

type CaptureRunRow = {
  id: string;
  status: string;
  coverage: string | null;
  started_at: string;
  finished_at: string | null;
  seen_count: number;
  upserted_count: number;
  error_code: string | null;
};

function runSummary(row: CaptureRunRow) {
  return {
    id: row.id,
    status: row.status,
    coverage: row.coverage,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    seenCount: row.seen_count,
    upsertedCount: row.upserted_count,
    errorCode: row.error_code,
    recovery: row.error_code ? row.error_code : null,
  };
}

async function captureRunSummary(db: D1Database, accountId: string, which: "latest" | "successful") {
  const row =
    which === "successful"
      ? await first<CaptureRunRow>(
          db,
          `SELECT r.id, r.status, r.coverage, r.started_at, r.finished_at, r.seen_count, r.upserted_count, r.error_code
             FROM capture_runs r
             JOIN source_collections c ON c.id = r.source_collection_id
            WHERE c.source_account_id = ?
              AND r.finished_at IS NOT NULL
              AND r.error_code IS NULL
              AND r.status IN ('ok', 'complete')
            ORDER BY r.finished_at DESC LIMIT 1`,
          accountId,
        )
      : await first<CaptureRunRow>(
          db,
          `SELECT r.id, r.status, r.coverage, r.started_at, r.finished_at, r.seen_count, r.upserted_count, r.error_code
             FROM capture_runs r
             JOIN source_collections c ON c.id = r.source_collection_id
            WHERE c.source_account_id = ?
            ORDER BY r.started_at DESC LIMIT 1`,
          accountId,
        );
  return row ? runSummary(row) : null;
}

function parseProgress(raw: string | null): {
  phase: string;
  seen: number;
  upserted: number;
  message: string;
} | null {
  if (!raw) return null;
  try {
    const value = JSON.parse(raw) as { phase?: unknown; seen?: unknown; upserted?: unknown; message?: unknown };
    return {
      phase: typeof value.phase === "string" ? value.phase : "capturing",
      seen: typeof value.seen === "number" ? value.seen : 0,
      upserted: typeof value.upserted === "number" ? value.upserted : 0,
      message: typeof value.message === "string" ? value.message : "",
    };
  } catch {
    return null;
  }
}

async function sourceConnection(db: D1Database, libraryId: string, source: SourceId) {
  const accounts = await all<{
    id: string;
    externalId: string;
    displayName: string | null;
    accountKind: "live" | "imported" | "disconnected";
    createdAt: string;
  }>(
    db,
    `SELECT id, external_id AS externalId, display_name AS displayName, account_kind AS accountKind, created_at AS createdAt
       FROM source_accounts WHERE library_id = ? AND source = ?`,
    libraryId,
    source,
  );
  const chosen = pickConnectionAccount(accounts);
  if (!chosen) {
    return {
      source,
      label: sourceLabel(source),
      state: "not_connected" as SourceConnectionState,
      liveAccount: null,
      progress: null,
      latestAttempt: null,
      lastSuccessfulCapture: null,
    };
  }
  const latestAttempt = await captureRunSummary(db, chosen.id, "latest");
  const lastSuccessfulCapture = await captureRunSummary(db, chosen.id, "successful");
  const running = await isRunning(db, libraryId, source, chosen.id);
  const job = running
    ? await first<JobRow>(
        db,
        `SELECT id, library_id, source, source_account_id, url, status, token_id, token_plain, progress_json, lease_expires_at
           FROM capture_jobs
          WHERE library_id = ? AND source = ? AND source_account_id = ? AND status IN ('queued', 'running')
          ORDER BY created_at DESC LIMIT 1`,
        libraryId,
        source,
        chosen.id,
      )
    : null;
  return {
    source,
    label: sourceLabel(source),
    state: sourceConnectionState({
      hasLiveAccount: chosen.accountKind === "live",
      pending: isPendingExternalId(chosen.externalId),
      running,
      hasRecovery: Boolean(latestAttempt?.errorCode),
    }),
    liveAccount: {
      id: chosen.id,
      externalId: chosen.externalId,
      displayName: isPlaceholderDisplayName(chosen.displayName) ? null : chosen.displayName,
    },
    progress: running ? parseProgress(job?.progress_json ?? null) : null,
    latestAttempt,
    lastSuccessfulCapture,
  };
}

async function importHistory(db: D1Database, libraryId: string) {
  const rows = await all<{ id: string; source: string; importedAt: string; itemCount: number }>(
    db,
    `SELECT a.id AS id, a.source AS source,
            COALESCE(
              (SELECT MAX(r.started_at)
                 FROM source_collections c
                 JOIN capture_runs r ON r.source_collection_id = c.id
                WHERE c.source_account_id = a.id),
              a.created_at
            ) AS importedAt,
            (SELECT COUNT(DISTINCT sr.item_id)
               FROM source_records sr
               JOIN items i ON i.id = sr.item_id
              WHERE sr.source_account_id = a.id) AS itemCount
       FROM source_accounts a
      WHERE a.library_id = ? AND a.account_kind = 'imported'
      ORDER BY importedAt DESC, a.id`,
    libraryId,
  );
  return rows.flatMap((row) => {
    if (!isSourceId(row.source)) return [];
    return [
      {
        id: row.id,
        source: row.source,
        label: `${sourceLabel(row.source)} export`,
        importedAt: row.importedAt,
        itemCount: Number(row.itemCount),
      },
    ];
  });
}

export async function sourcesOverview(db: D1Database, libraryId: string) {
  const [extension, connections, imports] = await Promise.all([
    extensionHealth(db, libraryId),
    Promise.all(SOURCES.map((source) => sourceConnection(db, libraryId, source))),
    importHistory(db, libraryId),
  ]);
  return {
    account: { mode: "hosted" as const },
    extension,
    connections,
    imports,
    preferences: { captureOnOpen: false },
    pi: { available: false, detail: "Writing tools are not on this deployment." },
  };
}

