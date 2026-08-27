import type { SourceId } from "../../core/types.ts";
import { packFor } from "../../site-packs/index.ts";

export interface CaptureJob {
  id: string;
  source: SourceId;
  accountId: string;
  url: string;
  status: "queued" | "running" | "done" | "cancelled";
}

const jobs: CaptureJob[] = [];
type JobAuthorization = { source: string; sourceAccountId: string | null };
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

export function heartbeat(): void {
  lastBeat = Date.now();
}

export function extensionAlive(): boolean {
  return Date.now() - lastBeat < 45_000;
}

export function enqueueJob(source: SourceId, accountId: string): CaptureJob {
  const existing = jobs.find((j) => j.source === source && j.accountId === accountId && (j.status === "queued" || j.status === "running"));
  if (existing) return existing;
  const job: CaptureJob = {
    id: crypto.randomUUID().replaceAll("-", ""),
    source,
    accountId,
    url: packFor(source).manifest.collectionUrl,
    status: "queued",
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

/**
 * Wildcard tokens are the narrowly-scoped extension pairing credential: they
 * may consume jobs for any source, while source/account tokens only consume
 * their exact source account's jobs. The HTTP layer still limits these tokens
 * to the Capture Protocol endpoints.
 */
export function canAccessJob(job: CaptureJob, authorization: JobAuthorization): boolean {
  if (authorization.source === "*") return authorization.sourceAccountId === null;
  return (
    authorization.source === job.source &&
    (authorization.sourceAccountId === null || authorization.sourceAccountId === job.accountId)
  );
}

export function cancelJobs(source: SourceId, accountId: string): void {
  for (const job of jobs) {
    if (job.source === source && job.accountId === accountId && job.status !== "done") job.status = "cancelled";
  }
}

export function finishJob(id: string, status: "done" | "cancelled" = "done"): CaptureJob | undefined {
  const job = getJob(id);
  if (job && job.status !== "cancelled") job.status = status;
  return job;
}

function take(job: CaptureJob): CaptureJob {
  if (job.status === "queued") job.status = "running";
  return job;
}
