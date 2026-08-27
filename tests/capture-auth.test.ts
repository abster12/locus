import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { issueToken, startSession } from "../server/capture/ingest.ts";
import { enqueueJob, heartbeat, resetJobsForTest } from "../server/capture/jobs.ts";
import { setProgress } from "../runner/index.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8792";
const { listen } = await import("../server/http/server.ts");

test("capture tokens cannot cross sessions or jobs", async () => {
  const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-capture-auth-")), "capture.db"));
  database.prepare(`INSERT INTO source_accounts (id, source, external_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    "x-account-a",
    "x",
    "a",
    "A",
    new Date().toISOString(),
  );
  database.prepare(`INSERT INTO source_accounts (id, source, external_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)`).run(
    "x-account-b",
    "x",
    "b",
    "B",
    new Date().toISOString(),
  );
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  const tokenA = issueToken(database, "x", "x-account-a").token;
  const tokenB = issueToken(database, "x", "x-account-b").token;
  const wildcard = issueToken(database, "*", null).token;

  try {
    const sessionBody = {
      protocolVersion: 1,
      source: "x",
      producer: { id: "test", version: "1" },
      accountExternalId: "a",
      collection: { externalId: "bookmarks", name: "Bookmarks" },
      mode: "incremental",
      observedAt: new Date().toISOString(),
    };
    const started = await post(base, "/capture/v1/sessions", tokenA, sessionBody);
    assert.equal(started.status, 200);
    const { sessionId } = (await started.json()) as { sessionId: string };
    const batch = {
      sessionId,
      sequence: 1,
      idempotencyKey: "auth-test",
      changes: [
        {
          kind: "upsert",
          externalId: "item-1",
          item: { contentType: "post", body: "secret", url: "https://x.com/a/status/item-1" },
        },
      ],
    };
    const forbiddenBatch = await post(base, "/capture/v1/batches", tokenB, batch);
    assert.equal(forbiddenBatch.status, 403);
    const forbiddenFinish = await post(base, "/capture/v1/finish", tokenB, { sessionId, coverage: "partial" });
    assert.equal(forbiddenFinish.status, 403);
    const unknownBatch = await post(base, "/capture/v1/batches", tokenB, { ...batch, sessionId: "unknown-session" });
    assert.equal(unknownBatch.status, 404);

    resetJobsForTest();
    const job = enqueueJob("x", "x-account-a");
    const forbiddenJob = await get(base, `/capture/v1/jobs/${job.id}`, tokenB);
    assert.equal(forbiddenJob.status, 403);
    const allowedJob = await get(base, `/capture/v1/jobs/${job.id}`, wildcard);
    assert.equal(allowedJob.status, 200);

    database.prepare(`INSERT INTO source_accounts (id, source, external_id, display_name, created_at) VALUES (?, ?, ?, ?, ?)`).run(
      "reddit-account",
      "reddit",
      "reddit-user",
      "Reddit",
      new Date().toISOString(),
    );
    const sessionResponse = await fetch(`${base}/api/session`);
    const csrf = (await sessionResponse.json()) as { csrf: string };
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf };
    for (const action of ["connect", "refresh", "resume", "cancel", "disconnect"]) {
      const response = await fetch(`${base}/api/sources/x/${action}`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: "reddit-account" }),
      });
      assert.equal(response.status, 404, action);
    }
    const health = await fetch(`${base}/api/sources/x/health?accountId=reddit-account`, { headers: { cookie } });
    assert.equal(health.status, 404);
    const pairing = await fetch(`${base}/api/sources/x/pair-extension`, { method: "POST", headers, body: "{}" });
    assert.equal(pairing.status, 200);

    heartbeat();
    setProgress("x", "x-account-a", { phase: "done", message: "Previous capture complete" });
    const staleProgressHealth = await fetch(`${base}/api/sources/x/health?accountId=x-account-a`, { headers: { cookie } });
    assert.equal(staleProgressHealth.status, 200);
    const staleProgressBody = (await staleProgressHealth.json()) as { health: { account: { state: string }; running: boolean } };
    assert.equal(staleProgressBody.health.running, false);
    assert.equal(staleProgressBody.health.account.state, "connected");
  } finally {
    resetJobsForTest();
    await app.close();
    database.close();
  }
});

async function post(base: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function get(base: string, path: string, token: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}
