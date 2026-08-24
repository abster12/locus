import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { cancelJobs, enqueueJob, extensionAlive, finishJob, getJob, heartbeat, resetJobsForTest, waitJob } from "../server/capture/jobs.ts";

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

  test("cancelJobs flips queued work", () => {
    resetJobsForTest();
    const job = enqueueJob("reddit", "acct-2");
    cancelJobs("reddit", "acct-2");
    assert.equal(getJob(job.id)?.status, "cancelled");
  });
});
