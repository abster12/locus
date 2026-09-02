import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { canAccessJob, cancelJobs, enqueueJob, extensionAlive, extensionHealth, finishJob, getJob, heartbeat, resetJobsForTest, waitJob } from "../server/capture/jobs.ts";

describe("capture jobs", { concurrency: false }, () => {
  test("waitJob returns the next queued job and marks it running", async () => {
    resetJobsForTest();
    const job = enqueueJob("x", "acct-1");
    const got = await waitJob(50);
    assert.equal(got?.id, job.id);
    assert.equal(got?.status, "running");
    assert.equal(got?.url, "https://x.com/i/bookmarks");
    finishJob(job.id);
  });

  test("heartbeat makes the extension look alive", () => {
    resetJobsForTest();
    heartbeat();
    assert.equal(extensionAlive(), true);
  });

  test("extension health is not paired until a heartbeat, then stale after 45s", () => {
    resetJobsForTest();
    assert.deepEqual(extensionHealth(), { state: "not_paired", lastSeenAt: null });
    const seenAt = Date.now();
    heartbeat(seenAt);
    assert.deepEqual(extensionHealth(), { state: "paired", lastSeenAt: new Date(seenAt).toISOString() });
    heartbeat(seenAt - 60_000);
    assert.equal(extensionHealth().state, "needs_attention");
    assert.equal(extensionHealth().lastSeenAt, new Date(seenAt - 60_000).toISOString());
    assert.equal(extensionAlive(), false);
  });

  test("cancelJobs flips queued work", () => {
    resetJobsForTest();
    const job = enqueueJob("reddit", "acct-2");
    cancelJobs("reddit", "acct-2");
    assert.equal(getJob(job.id)?.status, "cancelled");
  });

  test("cancelJobs flips a running job", async () => {
    resetJobsForTest();
    const job = enqueueJob("x", "acct-3");
    const got = await waitJob(50);
    assert.equal(got?.status, "running");
    cancelJobs("x", "acct-3");
    assert.equal(getJob(job.id)?.status, "cancelled");
  });

  test("a job grant cannot access an unrelated job", () => {
    resetJobsForTest();
    const a = enqueueJob("x", "acct-a", { token: "tok-a", tokenId: "grant-a" });
    const b = enqueueJob("reddit", "acct-b", { token: "tok-b", tokenId: "grant-b" });
    const grantA = { id: "grant-a", source: "x", sourceAccountId: "acct-a" };
    assert.equal(canAccessJob(a, grantA), true);
    assert.equal(canAccessJob(b, grantA), false);
    assert.equal(canAccessJob(a, { id: "device", source: "*", sourceAccountId: null }), true);
    assert.equal(canAccessJob(b, { id: "device", source: "*", sourceAccountId: null }), true);
  });
});
