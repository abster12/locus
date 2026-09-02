import type { SourceId } from "../../core/types.ts";
import { packFor } from "../../site-packs/index.ts";

export interface CaptureJob {
  id: string;
  source: SourceId;
  accountId: string;
  url: string;
  status: "queued" | "running" | "done" | "cancelled";
  /** Plaintext job grant. Delivered once on wait; never returned on job GET. */
  token?: string;
  tokenId?: string;
}

export interface JobAuthorization {
  id?: string;
  source: string;
  sourceAccountId: string | null;
}

const jobs: CaptureJob[] = [];
type JobWaiter = {
  resolve: (job: CaptureJob | null) => void;
  authorization?: JobAuthorization;
};
const waiters: JobWaiter[] = [];
let lastBeat = 0;

export function resetJobsForTest(): void {
  jobs.length = 0;
  waiters.length = 0;
  lastBeat = 0;
}

export function heartbeat(at = Date.now()): void {
  lastBeat = at;
}

/** Paired while a heartbeat arrived within this window; after that, Needs attention. Never seen: Not paired. In-memory only. */
export const EXTENSION_STALE_MS = 45_000;

export type ExtensionHealthState = "not_paired" | "paired" | "needs_attention";

export function extensionHealth(): { state: ExtensionHealthState; lastSeenAt: string | null } {
  if (lastBeat === 0) return { state: "not_paired", lastSeenAt: null };
  const lastSeenAt = new Date(lastBeat).toISOString();
  if (Date.now() - lastBeat < EXTENSION_STALE_MS) return { state: "paired", lastSeenAt };
  return { state: "needs_attention", lastSeenAt };
}

export function extensionAlive(): boolean {
  return extensionHealth().state === "paired";
}

export function enqueueJob(
  source: SourceId,
  accountId: string,
  grant?: { token: string; tokenId: string },
): CaptureJob {
  const existing = jobs.find((j) => j.source === source && j.accountId === accountId && (j.status === "queued" || j.status === "running"));
  if (existing) return existing;
  const job: CaptureJob = {
    id: crypto.randomUUID().replaceAll("-", ""),
    source,
    accountId,
    url: packFor(source).manifest.collectionUrl,
    status: "queued",
    token: grant?.token,
    tokenId: grant?.tokenId,
  };
  jobs.push(job);
  const waiterIndex = waiters.findIndex((waiter) => !waiter.authorization || canAccessJob(job, waiter.authorization));
  if (waiterIndex >= 0) {
    const waiter = waiters.splice(waiterIndex, 1)[0];
    waiter?.resolve(take(job));
  }
  return job;
}

export function waitJob(ms: number, signal?: AbortSignal, authorization?: JobAuthorization): Promise<CaptureJob | null> {
  heartbeat();
  const ready = jobs.find((j) => j.status === "queued" && (!authorization || canAccessJob(j, authorization)));
  if (ready) return Promise.resolve(take(ready));
  return new Promise((resolve) => {
    const finish = (job: CaptureJob | null) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const i = waiters.indexOf(waiter);
      if (i >= 0) waiters.splice(i, 1);
      resolve(job);
    };
    const waiter: JobWaiter = { resolve: (job) => finish(job), authorization };
    const onAbort = () => finish(null);
    const timer = setTimeout(() => finish(null), ms);
    waiters.push(waiter);
    if (signal?.aborted) {
      finish(null);
      return;
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function getJob(id: string): CaptureJob | undefined {
  return jobs.find((j) => j.id === id);
}

export function jobForTokenId(tokenId: string): CaptureJob | undefined {
  return jobs.find((j) => j.tokenId === tokenId);
}

/**
 * Wildcard tokens are the device pairing credential: they may wait/poll any
 * job. A job grant (tokenId on the job) is only that job — it cannot see
 * unrelated jobs or Source accounts. Other source/account tokens stay limited
 * to their source account's jobs. The HTTP layer still limits these tokens to
 * the Capture Protocol endpoints.
 */
export function canAccessJob(job: CaptureJob, authorization: JobAuthorization): boolean {
  if (authorization.id && isJobGrant(authorization.id)) return job.tokenId === authorization.id;
  if (authorization.source === "*") return authorization.sourceAccountId === null;
  return (
    authorization.source === job.source &&
    (authorization.sourceAccountId === null || authorization.sourceAccountId === job.accountId)
  );
}

export function cancelJobs(source: SourceId, accountId: string): CaptureJob[] {
  const cancelled: CaptureJob[] = [];
  for (const job of jobs) {
    if (job.source === source && job.accountId === accountId && job.status !== "done") {
      job.status = "cancelled";
      cancelled.push(job);
    }
  }
  return cancelled;
}

export function retargetJobs(source: SourceId, fromAccountId: string, toAccountId: string): void {
  if (fromAccountId === toAccountId) return;
  for (const job of jobs) {
    if (job.source === source && job.accountId === fromAccountId) job.accountId = toAccountId;
  }
}

export function finishJob(id: string, status: "done" | "cancelled" = "done"): CaptureJob | undefined {
  const job = getJob(id);
  if (job && job.status !== "cancelled") job.status = status;
  return job;
}

export function jobStatusView(job: CaptureJob): { id: string; source: SourceId; url: string; status: CaptureJob["status"] } {
  return { id: job.id, source: job.source, url: job.url, status: job.status };
}

export function jobDeliveryView(job: CaptureJob): { id: string; source: SourceId; url: string; token?: string } {
  return { id: job.id, source: job.source, url: job.url, ...(job.token ? { token: job.token } : {}) };
}

function isJobGrant(tokenId: string): boolean {
  return jobs.some((job) => job.tokenId === tokenId);
}

function take(job: CaptureJob): CaptureJob {
  if (job.status === "queued") job.status = "running";
  return job;
}
