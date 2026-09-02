import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/open.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { cleanupSourceConnections, releaseSourceConnection, resolvedAccountDisplayName } from "../db/source-lifecycle.ts";
import type { SourceId } from "../core/types.ts";
import { pickConnectionAccount } from "../server/source-state.ts";
import { issueToken, lookupToken, startSession, ingestBatch } from "../server/capture/ingest.ts";
import { enqueueJob, getJob, heartbeat, resetJobsForTest } from "../server/capture/jobs.ts";
import { getProgress, isRunning, markDone, markRunning, retargetRunner, setProgress } from "../runner/index.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8827";
const { listen } = await import("../server/http/server.ts");

function mem(name = "lifecycle"): Db {
  return openDb(join(mkdtempSync(join(tmpdir(), `locus-${name}-`)), "t.db"));
}

function insertAccount(db: Db, row: {
  id: string;
  source?: string;
  externalId: string;
  kind?: string;
  createdAt?: string;
  displayName?: string;
}): void {
  db.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(row.id, row.source ?? "x", row.externalId, row.displayName ?? row.externalId, row.createdAt ?? "2026-08-01T00:00:00Z", row.kind ?? "live");
}

function insertItem(db: Db, accountId: string, externalId: string, observedAt: string, revision = "1"): string {
  const itemId = `item-${accountId}-${externalId}`;
  const recordId = `sr-${accountId}-${externalId}`;
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(itemId, externalId, externalId, `https://x.com/i/status/${externalId}`, observedAt, observedAt, observedAt);
  db.prepare(
    `INSERT INTO source_records (id, source_account_id, external_id, revision, item_id, first_observed_at, last_observed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(recordId, accountId, externalId, revision, itemId, observedAt, observedAt);
  return recordId;
}

type SourcesOverview = {
  connections: {
    source: string;
    state: string;
    liveAccount: { id: string; externalId: string } | null;
    latestAttempt?: { status: string; finishedAt: string | null } | null;
  }[];
};

function sessionBody(source: SourceId, accountExternalId: string) {
  return {
    protocolVersion: 1 as const,
    source,
    producer: { id: "locus.extension", version: "0.1.0" },
    accountExternalId,
    collection: { externalId: source === "x" ? "bookmarks" : "saved", name: source === "x" ? "Bookmarks" : "Saved" },
    mode: "incremental" as const,
    observedAt: "2026-08-20T00:00:00.000Z",
  };
}

function upsertChange(externalId: string, url: string) {
  return {
    kind: "upsert" as const,
    externalId,
    item: { contentType: "post" as const, body: externalId, url },
  };
}

async function capturePost(base: string, path: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function captureGet(base: string, path: string, token: string): Promise<Response> {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

function accountIdentity(db: Db, id: string) {
  return db.prepare(`SELECT external_id AS externalId, display_name AS displayName FROM source_accounts WHERE id = ?`).get(id) as {
    externalId: string;
    displayName: string | null;
  };
}

test("placeholder display names yield to discovered identity", () => {
  assert.equal(resolvedAccountDisplayName("X", "abhigyan898"), "abhigyan898");
  assert.equal(resolvedAccountDisplayName("Instagram", "abhigyan.k"), "abhigyan.k");
  assert.equal(resolvedAccountDisplayName("Ada", "abhigyan898"), "Ada");
  assert.equal(resolvedAccountDisplayName("Ada", "pending"), "Ada");
  assert.equal(resolvedAccountDisplayName("Ada", "unknown"), "Ada");
  assert.equal(resolvedAccountDisplayName("Ada", "extension"), "Ada");
  assert.equal(resolvedAccountDisplayName(null, "abhigyan898"), "abhigyan898");
  assert.equal(resolvedAccountDisplayName("X", "pending"), "X");
});

test.describe("source connection lifecycle", { concurrency: false }, () => {
  test("retargeted runner settles on the canonical key", async () => {
    markRunning("x", "rt-pending");
    setProgress("x", "rt-pending", { phase: "capturing", message: "Collecting…" });
    retargetRunner("x", "rt-pending", "rt-live");
    assert.equal(isRunning("x", "rt-live"), true);
    assert.equal(isRunning("x", "rt-pending"), false);
    assert.equal(getProgress("x", "rt-live")?.phase, "capturing");
    assert.equal(getProgress("x", "rt-pending"), undefined);
    retargetRunner("x", "rt-pending", "rt-live");
    assert.equal(isRunning("x", "rt-live"), true);
    await markDone("x", "rt-live");
    assert.equal(isRunning("x", "rt-live"), false);
    assert.equal(isRunning("x", "rt-pending"), false);
  });

  test("repeated connect, continue, cancel, and pairing reuse one pending row", async () => {
    const db = mem("repeat");
    const app = listen(db);
    const base = `http://127.0.0.1:${app.port}`;
    resetJobsForTest();
    heartbeat();
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const csrf = (await sessionResponse.json()) as { csrf: string };
      const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf };

      const first = await fetch(`${base}/api/sources/reddit/connect`, { method: "POST", headers, body: "{}" });
      assert.equal(first.status, 200);
      const firstBody = (await first.json()) as { account: { id: string } };
      assert.equal(accountIdentity(db, firstBody.account.id).displayName, null);
      const second = await fetch(`${base}/api/sources/reddit/connect`, { method: "POST", headers, body: "{}" });
      assert.equal(second.status, 409);
      const secondBody = (await second.json()) as { account: { id: string } };
      assert.equal(secondBody.account.id, firstBody.account.id);

      const pairA = await fetch(`${base}/api/sources/reddit/pair-extension`, { method: "POST", headers, body: "{}" });
      const pairB = await fetch(`${base}/api/sources/reddit/pair-extension`, { method: "POST", headers, body: "{}" });
      assert.equal(pairA.status, 200);
      assert.equal(pairB.status, 200);
      const pairABody = (await pairA.json()) as { account: { id: string } };
      const pairBBody = (await pairB.json()) as { account: { id: string } };
      assert.equal(pairABody.account.id, firstBody.account.id);
      assert.equal(pairBBody.account.id, firstBody.account.id);

      const cancel = await fetch(`${base}/api/sources/reddit/cancel`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: firstBody.account.id }),
      });
      assert.equal(cancel.status, 200);
      const afterCancel = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as SourcesOverview;
      const reddit = afterCancel.connections.find((connection) => connection.source === "reddit")!;
      assert.equal(reddit.state, "not_connected");
      assert.equal(reddit.liveAccount, null);

      const again = await fetch(`${base}/api/sources/reddit/connect`, { method: "POST", headers, body: "{}" });
      assert.equal(again.status, 200);
      const live = db.prepare(`SELECT COUNT(*) AS n FROM source_accounts WHERE source = 'reddit' AND account_kind = 'live'`).get() as { n: number };
      assert.equal(live.n, 1);

      insertAccount(db, { id: "x-live", externalId: "abhigyan898", displayName: "@abhigyan898" });
      insertItem(db, "x-live", "kept", "2026-08-01T00:00:00Z");
      const disconnect = await fetch(`${base}/api/sources/x/disconnect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: "x-live" }),
      });
      assert.equal(disconnect.status, 200);
      const afterDisconnect = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as SourcesOverview;
      assert.equal(afterDisconnect.connections.find((connection) => connection.source === "x")!.state, "not_connected");
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items WHERE id = 'item-x-live-kept'`).get() as { n: number }).n, 1);
    } finally {
      resetJobsForTest();
      await app.close();
      db.close();
    }
  });

  test("completing setup merges pending into the live account", () => {
    const db = mem("merge-complete");
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", displayName: "@abhigyan898", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(db, { id: "x-pending", externalId: "pending:x-pending", displayName: "X", createdAt: "2026-08-03T00:00:00Z" });
    const tok = lookupToken(db, issueToken(db, "x", "x-pending").token)!;
    const started = startSession(db, tok, {
      protocolVersion: 1,
      source: "x",
      producer: { id: "test", version: "1" },
      accountExternalId: "abhigyan898",
      collection: { externalId: "bookmarks", name: "Bookmarks" },
      mode: "incremental",
      observedAt: "2026-08-20T00:00:00.000Z",
    });
    ingestBatch(db, {
      sessionId: started.sessionId,
      sequence: 1,
      idempotencyKey: "merge-1",
      changes: [
        {
          kind: "upsert",
          externalId: "post-1",
          item: { contentType: "post", body: "hi", url: "https://x.com/i/status/post-1" },
        },
      ],
    });
    const accounts = db.prepare(`SELECT id, external_id AS externalId FROM source_accounts WHERE account_kind = 'live'`).all() as {
      id: string;
      externalId: string;
    }[];
    assert.equal(accounts.length, 1);
    assert.equal(accounts[0]?.id, "x-live");
    assert.equal(accounts[0]?.externalId, "abhigyan898");
    assert.equal(accountIdentity(db, "x-live").displayName, "@abhigyan898");
    const record = db.prepare(`SELECT source_account_id AS id FROM source_records WHERE external_id = 'post-1'`).get() as { id: string };
    assert.equal(record.id, "x-live");
    const session = db.prepare(`SELECT source_account_id AS id FROM capture_sessions WHERE id = ?`).get(started.sessionId) as { id: string };
    assert.equal(session.id, "x-live");
    db.close();
  });

  test("pending accounts take the discovered identity on runner and extension completion", () => {
    const db = mem("identity-resolve");
    insertAccount(db, { id: "x-pending", externalId: "pending:x-pending", displayName: "X" });
    insertAccount(db, { id: "ig-pending", source: "instagram", externalId: "pending:ig-pending", displayName: "Instagram" });
    const xTok = lookupToken(db, issueToken(db, "x", "x-pending").token)!;
    startSession(db, xTok, { ...sessionBody("x", "abhigyan898"), producer: { id: "locus.extension", version: "0.1.0" } });
    const igTok = lookupToken(db, issueToken(db, "instagram", "ig-pending").token)!;
    startSession(db, igTok, { ...sessionBody("instagram", "abhigyan.k"), producer: { id: "locus.runner", version: "0.1.0" } });
    const x = accountIdentity(db, "x-pending");
    const ig = accountIdentity(db, "ig-pending");
    assert.equal(x.externalId, "abhigyan898");
    assert.equal(x.displayName, "abhigyan898");
    assert.equal(ig.externalId, "abhigyan.k");
    assert.equal(ig.displayName, "abhigyan.k");
    db.close();
  });

  test("meaningful display names survive recapture and placeholder input", () => {
    const db = mem("identity-keep");
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", displayName: "Ada" });
    insertAccount(db, { id: "ig-pending", source: "instagram", externalId: "pending:ig-pending", displayName: "Ada" });
    const liveTok = lookupToken(db, issueToken(db, "x", "x-live").token)!;
    startSession(db, liveTok, sessionBody("x", "pending"));
    const pendingTok = lookupToken(db, issueToken(db, "instagram", "ig-pending").token)!;
    startSession(db, pendingTok, sessionBody("instagram", "pending"));
    const live = accountIdentity(db, "x-live");
    const pending = accountIdentity(db, "ig-pending");
    assert.equal(live.externalId, "abhigyan898");
    assert.equal(live.displayName, "Ada");
    assert.equal(pending.externalId, "pending:ig-pending");
    assert.equal(pending.displayName, "Ada");
    startSession(db, pendingTok, sessionBody("instagram", "abhigyan.k"));
    const resolved = accountIdentity(db, "ig-pending");
    assert.equal(resolved.externalId, "abhigyan.k");
    assert.equal(resolved.displayName, "Ada");
    db.close();
  });

  test("cleanup keeps canonical live data and revokes discarded pending tokens", () => {
    const db = mem("cleanup");
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(db, { id: "x-pending", externalId: "pending:x-pending", createdAt: "2026-08-03T00:00:00Z" });
    db.prepare(`INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES (?, ?, 'bookmarks', 'Bookmarks', ?)`).run(
      "live-col",
      "x-live",
      "2026-08-01T00:00:00Z",
    );
    db.prepare(`INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES (?, ?, 'bookmarks', 'Bookmarks', ?)`).run(
      "pending-col",
      "x-pending",
      "2026-08-03T00:00:00Z",
    );
    db.prepare(
      `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, status) VALUES (?, ?, 'test', '1', ?, 'ok')`,
    ).run("pending-run", "pending-col", "2026-08-03T00:00:00Z");
    insertItem(db, "x-pending", "from-pending", "2026-08-03T00:00:00Z");
    insertItem(db, "x-live", "from-live", "2026-08-01T00:00:00Z");
    const { tokenId } = issueToken(db, "x", "x-pending");
    db.prepare(
      `INSERT INTO capture_sessions (
        id, token_id, source, source_account_id, source_collection_id, producer_id, producer_version,
        mode, observed_at, capture_run_id, account_external_id, collection_external_id
      ) VALUES ('sess-pending', ?, 'x', 'x-pending', 'pending-col', 'test', '1', 'incremental', ?, 'pending-run', 'pending:x-pending', 'bookmarks')`,
    ).run(tokenId, "2026-08-03T00:00:00Z");

    const report = cleanupSourceConnections(db);
    assert.deepEqual(report.leftovers, []);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM source_accounts WHERE id = 'x-pending'`).get() as { n: number }).n, 0);
    assert.equal((db.prepare(`SELECT source_account_id AS id FROM source_records WHERE external_id = 'from-pending'`).get() as { id: string }).id, "x-live");
    assert.equal((db.prepare(`SELECT source_collection_id AS id FROM capture_runs WHERE id = 'pending-run'`).get() as { id: string }).id, "live-col");
    assert.equal((db.prepare(`SELECT source_account_id AS id FROM capture_sessions WHERE id = 'sess-pending'`).get() as { id: string }).id, "x-live");
    const token = db.prepare(`SELECT revoked_at AS revokedAt, source_account_id AS accountId FROM capture_tokens WHERE id = ?`).get(tokenId) as {
      revokedAt: string | null;
      accountId: string;
    };
    assert.ok(token.revokedAt);
    assert.equal(token.accountId, "x-pending");
    db.close();
  });

  test("cleanup keeps the newest record on uniqueness collision", () => {
    const db = mem("collision");
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(db, { id: "x-pending", externalId: "pending:x-pending", createdAt: "2026-08-03T00:00:00Z" });
    insertItem(db, "x-live", "same", "2026-08-01T00:00:00Z", "1");
    insertItem(db, "x-pending", "same", "2026-08-04T00:00:00Z", "9");
    cleanupSourceConnections(db);
    const kept = db.prepare(`SELECT revision, last_observed_at AS seen FROM source_records WHERE external_id = 'same'`).get() as {
      revision: string;
      seen: string;
    };
    assert.equal(kept.revision, "9");
    assert.equal(kept.seen, "2026-08-04T00:00:00Z");
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 2);
    db.close();
  });

  test("cleanup reports incompatible live accounts instead of deleting them", () => {
    const db = mem("leftover");
    insertAccount(db, { id: "older", externalId: "one", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(db, { id: "newer", externalId: "two", createdAt: "2026-08-02T00:00:00Z" });
    insertItem(db, "older", "a", "2026-08-01T00:00:00Z");
    insertItem(db, "newer", "b", "2026-08-02T00:00:00Z");
    const report = cleanupSourceConnections(db);
    assert.equal(report.leftovers.length, 1);
    assert.equal(report.leftovers[0]?.id, "older");
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM source_accounts WHERE account_kind = 'live'`).get() as { n: number }).n, 2);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 2);
    db.close();
  });

  test("cleanup rolls back when a later step fails", () => {
    const db = mem("rollback");
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(db, { id: "x-pending", externalId: "pending:x-pending", createdAt: "2026-08-03T00:00:00Z" });
    insertItem(db, "x-pending", "keep", "2026-08-03T00:00:00Z");
    db.exec(`CREATE TRIGGER fail_del BEFORE DELETE ON source_accounts BEGIN SELECT RAISE(ABORT, 'nope'); END`);
    assert.throws(() => cleanupSourceConnections(db));
    assert.equal((db.prepare(`SELECT source_account_id AS id FROM source_records WHERE external_id = 'keep'`).get() as { id: string }).id, "x-pending");
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM source_accounts WHERE id = 'x-pending'`).get() as { n: number }).n, 1);
    db.close();
  });

  test("disconnect revokes access and keeps items and imports", () => {
    const db = mem("disconnect");
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", displayName: "@abhigyan898" });
    insertAccount(db, { id: "x-imported", externalId: "export", kind: "imported", createdAt: "2026-08-02T00:00:00Z" });
    insertItem(db, "x-live", "kept", "2026-08-01T00:00:00Z");
    const issued = issueToken(db, "x", "x-live");
    releaseSourceConnection(db, "x-live");
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 1);
    assert.equal((db.prepare(`SELECT account_kind AS k FROM source_accounts WHERE id = 'x-imported'`).get() as { k: string }).k, "imported");
    const token = db.prepare(`SELECT revoked_at AS revokedAt FROM capture_tokens WHERE id = ?`).get(issued.tokenId) as { revokedAt: string | null };
    assert.ok(token.revokedAt);
    assert.equal((db.prepare(`SELECT account_kind AS k FROM source_accounts WHERE id = 'x-live'`).get() as { k: string }).k, "disconnected");
    const rows = db
      .prepare(`SELECT id, account_kind AS accountKind, external_id AS externalId, created_at AS createdAt FROM source_accounts`)
      .all() as { id: string; accountKind: "live" | "imported" | "disconnected"; externalId: string; createdAt: string }[];
    assert.equal(pickConnectionAccount(rows), undefined);
    db.close();
  });

  test("queued extension job binds capture to the pending Source account", async () => {
    process.env.LOCUS_PORT = "8831";
    const db = mem("job-bind");
    const app = listen(db);
    const base = `http://127.0.0.1:${app.port}`;
    resetJobsForTest();
    heartbeat();
    let pendingId = "";
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const csrf = (await sessionResponse.json()) as { csrf: string };
      const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf };

      const pair = await fetch(`${base}/api/extension/pair`, { method: "POST", headers, body: "{}" });
      assert.equal(pair.status, 200);
      const device = (await pair.json()) as { token: string };

      const connect = await fetch(`${base}/api/sources/x/connect`, { method: "POST", headers, body: "{}" });
      assert.equal(connect.status, 200);
      const connected = (await connect.json()) as { account: { id: string; external_id: string }; via: string };
      assert.equal(connected.via, "extension");
      pendingId = connected.account.id;
      assert.match(connected.account.external_id, /^pending:/);

      const waiting = await captureGet(base, "/capture/v1/jobs/wait", device.token);
      assert.equal(waiting.status, 200);
      const job = (await waiting.json()) as { id: string; source: string; url: string; token?: string; accountId?: string };
      assert.equal(job.source, "x");
      assert.ok(job.token);
      assert.equal(job.accountId, undefined);

      const polled = await captureGet(base, `/capture/v1/jobs/${job.id}`, device.token);
      assert.equal(polled.status, 200);
      const polledBody = (await polled.json()) as { status: string; token?: string; accountId?: string };
      assert.equal(polledBody.status, "running");
      assert.equal(polledBody.token, undefined);
      assert.equal(polledBody.accountId, undefined);

      const capturing = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as SourcesOverview;
      const xBefore = capturing.connections.find((connection) => connection.source === "x")!;
      assert.equal(xBefore.state, "capturing");
      assert.equal(xBefore.liveAccount?.id, pendingId);

      const started = await capturePost(base, "/capture/v1/sessions", job.token!, {
        ...sessionBody("x", "abhigyan898"),
        accountId: "forged-account",
      });
      assert.equal(started.status, 200);
      const { sessionId } = (await started.json()) as { sessionId: string };
      const batch = await capturePost(base, "/capture/v1/batches", job.token!, {
        sessionId,
        sequence: 1,
        idempotencyKey: "job-bind-1",
        changes: [upsertChange("post-1", "https://x.com/i/status/post-1")],
      });
      assert.equal(batch.status, 200);
      const finished = await capturePost(base, "/capture/v1/finish", job.token!, { sessionId, coverage: "partial" });
      assert.equal(finished.status, 200);

      const live = db
        .prepare(`SELECT id, external_id AS externalId FROM source_accounts WHERE source = 'x' AND account_kind = 'live'`)
        .all() as { id: string; externalId: string }[];
      assert.equal(live.length, 1);
      assert.equal(live[0]?.id, pendingId);
      assert.equal(live[0]?.externalId, "abhigyan898");
      assert.equal((db.prepare(`SELECT source_account_id AS id FROM capture_sessions WHERE id = ?`).get(sessionId) as { id: string }).id, pendingId);
      assert.equal((db.prepare(`SELECT source_account_id AS id FROM source_records WHERE external_id = 'post-1'`).get() as { id: string }).id, pendingId);
      assert.equal(
        (db.prepare(`SELECT source_account_id AS id FROM source_collections WHERE external_id = 'bookmarks'`).get() as { id: string }).id,
        pendingId,
      );
      const run = db
        .prepare(
          `SELECT c.source_account_id AS id FROM capture_runs r JOIN source_collections c ON c.id = r.source_collection_id ORDER BY r.started_at DESC LIMIT 1`,
        )
        .get() as { id: string };
      assert.equal(run.id, pendingId);
      const grant = lookupToken(db, job.token!);
      assert.equal(grant?.sourceAccountId, pendingId);
      assert.equal(grant?.source, "x");

      const stillCapturing = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as SourcesOverview;
      const xAfter = stillCapturing.connections.find((connection) => connection.source === "x")!;
      assert.equal(xAfter.state, "capturing");
      assert.equal(xAfter.liveAccount?.id, pendingId);
      assert.equal(xAfter.liveAccount?.externalId, "abhigyan898");
    } finally {
      markDone("x", pendingId);
      resetJobsForTest();
      await app.close();
      db.close();
    }
  });

  test("save this item still works without a queued job", async () => {
    process.env.LOCUS_PORT = "8832";
    const db = mem("save-item");
    const app = listen(db);
    const base = `http://127.0.0.1:${app.port}`;
    resetJobsForTest();
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const csrf = (await sessionResponse.json()) as { csrf: string };
      const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf };
      const pair = await fetch(`${base}/api/extension/pair`, { method: "POST", headers, body: "{}" });
      const device = (await pair.json()) as { token: string };

      const started = await capturePost(base, "/capture/v1/sessions", device.token, sessionBody("instagram", "ig-user"));
      assert.equal(started.status, 200);
      const { sessionId } = (await started.json()) as { sessionId: string };
      const batch = await capturePost(base, "/capture/v1/batches", device.token, {
        sessionId,
        sequence: 1,
        idempotencyKey: "save-item-1",
        changes: [upsertChange("ig-1", "https://www.instagram.com/p/ig-1/")],
      });
      assert.equal(batch.status, 200);
      const finished = await capturePost(base, "/capture/v1/finish", device.token, { sessionId, coverage: "partial" });
      assert.equal(finished.status, 200);
      const accounts = db.prepare(`SELECT id FROM source_accounts WHERE source = 'instagram' AND account_kind = 'live'`).all();
      assert.equal(accounts.length, 1);
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 1);
    } finally {
      resetJobsForTest();
      await app.close();
      db.close();
    }
  });

  test("job-bound capture merges pending into the live account and moves running state", async () => {
    const db = mem("job-merge");
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(db, { id: "x-pending", externalId: "pending:x-pending", createdAt: "2026-08-03T00:00:00Z" });
    insertItem(db, "x-live", "kept", "2026-08-01T00:00:00Z");
    const grant = issueToken(db, "x", "x-pending");
    resetJobsForTest();
    heartbeat();
    const job = enqueueJob("x", "x-pending", grant);
    markRunning("x", "x-pending");
    process.env.LOCUS_PORT = "8833";
    const app = listen(db);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const started = await capturePost(base, "/capture/v1/sessions", grant.token, sessionBody("x", "abhigyan898"));
      assert.equal(started.status, 200);
      const { sessionId } = (await started.json()) as { sessionId: string };
      const batch = await capturePost(base, "/capture/v1/batches", grant.token, {
        sessionId,
        sequence: 1,
        idempotencyKey: "job-merge-1",
        changes: [upsertChange("from-pending", "https://x.com/i/status/from-pending")],
      });
      assert.equal(batch.status, 200);
      const live = db.prepare(`SELECT id, external_id AS externalId FROM source_accounts WHERE account_kind = 'live'`).all() as {
        id: string;
        externalId: string;
      }[];
      assert.equal(live.length, 1);
      assert.equal(live[0]?.id, "x-live");
      assert.equal((db.prepare(`SELECT source_account_id AS id FROM capture_sessions WHERE id = ?`).get(sessionId) as { id: string }).id, "x-live");
      assert.equal((db.prepare(`SELECT source_account_id AS id FROM source_records WHERE external_id = 'from-pending'`).get() as { id: string }).id, "x-live");
      assert.equal(lookupToken(db, grant.token)?.sourceAccountId, "x-live");
      assert.equal(isRunning("x", "x-live"), true);
      assert.equal(isRunning("x", "x-pending"), false);
      assert.equal(getJob(job.id)?.accountId, "x-live");

      const overview = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as SourcesOverview;
      const x = overview.connections.find((connection) => connection.source === "x")!;
      assert.equal(x.state, "capturing");
      assert.equal(x.liveAccount?.id, "x-live");
    } finally {
      await markDone("x", "x-live");
      resetJobsForTest();
      await app.close();
      db.close();
    }
  });

  test("job-bound capture completes on the canonical account", async () => {
    const db = mem("job-complete");
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(db, { id: "x-pending", externalId: "pending:x-pending", createdAt: "2026-08-03T00:00:00Z" });
    insertItem(db, "x-live", "kept", "2026-08-01T00:00:00Z");
    const grant = issueToken(db, "x", "x-pending");
    resetJobsForTest();
    heartbeat();
    const job = enqueueJob("x", "x-pending", grant);
    markRunning("x", "x-pending");
    process.env.LOCUS_PORT = "8835";
    const app = listen(db);
    const base = `http://127.0.0.1:${app.port}`;
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const csrf = (await sessionResponse.json()) as { csrf: string };
      const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf };

      const started = await capturePost(base, "/capture/v1/sessions", grant.token, sessionBody("x", "abhigyan898"));
      assert.equal(started.status, 200);
      const { sessionId } = (await started.json()) as { sessionId: string };
      const batch = await capturePost(base, "/capture/v1/batches", grant.token, {
        sessionId,
        sequence: 1,
        idempotencyKey: "job-complete-1",
        changes: [upsertChange("from-pending", "https://x.com/i/status/from-pending")],
      });
      assert.equal(batch.status, 200);
      assert.equal(isRunning("x", "x-live"), true);
      assert.equal(isRunning("x", "x-pending"), false);
      assert.equal(getJob(job.id)?.accountId, "x-live");

      const finished = await capturePost(base, "/capture/v1/finish", grant.token, { sessionId, coverage: "complete" });
      assert.equal(finished.status, 200);
      const jobDone = await capturePost(base, `/capture/v1/jobs/${job.id}/finish`, grant.token, { message: "Done." });
      assert.equal(jobDone.status, 200);
      await markDone("x", "x-live");

      const overview = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as SourcesOverview;
      const x = overview.connections.find((connection) => connection.source === "x")!;
      assert.equal(x.state, "connected");
      assert.equal(x.liveAccount?.id, "x-live");
      assert.equal(isRunning("x", "x-live"), false);
      assert.equal(isRunning("x", "x-pending"), false);

      heartbeat();
      const captureNow = await fetch(`${base}/api/sources/x/refresh`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: "x-live" }),
      });
      assert.equal(captureNow.status, 200);
      assert.equal(isRunning("x", "x-live"), true);
    } finally {
      await markDone("x", "x-live");
      resetJobsForTest();
      await app.close();
      db.close();
    }
  });

  test("disconnect cancels queued and running extension jobs", async () => {
    process.env.LOCUS_PORT = "8834";
    const db = mem("job-disconnect");
    insertAccount(db, { id: "x-imported", externalId: "export", kind: "imported", createdAt: "2026-08-02T00:00:00Z" });
    const app = listen(db);
    const base = `http://127.0.0.1:${app.port}`;
    resetJobsForTest();
    heartbeat();
    let queuedAccountId = "";
    let runningAccountId = "";
    try {
      const sessionResponse = await fetch(`${base}/api/session`);
      const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
      assert.ok(cookie);
      const csrf = (await sessionResponse.json()) as { csrf: string };
      const headers = { cookie, "content-type": "application/json", "x-csrf-token": csrf.csrf };
      const pair = await fetch(`${base}/api/extension/pair`, { method: "POST", headers, body: "{}" });
      const device = (await pair.json()) as { token: string };

      const queuedConnect = await fetch(`${base}/api/sources/x/connect`, { method: "POST", headers, body: "{}" });
      const queuedAccount = (await queuedConnect.json()) as { account: { id: string } };
      queuedAccountId = queuedAccount.account.id;
      const queued = enqueueJob("x", queuedAccount.account.id);
      assert.equal(queued.status, "queued");
      assert.ok(queued.token);

      const queuedDisconnect = await fetch(`${base}/api/sources/x/disconnect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: queuedAccount.account.id }),
      });
      assert.equal(queuedDisconnect.status, 200);
      const queuedPoll = await captureGet(base, `/capture/v1/jobs/${queued.id}`, device.token);
      assert.equal(queuedPoll.status, 200);
      assert.equal(((await queuedPoll.json()) as { status: string }).status, "cancelled");
      assert.equal(getJob(queued.id)?.status, "cancelled");
      const queuedSession = await capturePost(base, "/capture/v1/sessions", queued.token!, sessionBody("x", "abhigyan898"));
      assert.equal(queuedSession.status, 401);

      const again = await fetch(`${base}/api/sources/x/connect`, { method: "POST", headers, body: "{}" });
      assert.equal(again.status, 200);
      const runningAccount = (await again.json()) as { account: { id: string } };
      runningAccountId = runningAccount.account.id;
      const waiting = await captureGet(base, "/capture/v1/jobs/wait", device.token);
      const runningJob = (await waiting.json()) as { id: string; token?: string };
      assert.ok(runningJob.token);
      const started = await capturePost(base, "/capture/v1/sessions", runningJob.token, sessionBody("x", "abhigyan898"));
      const { sessionId, captureRunId } = (await started.json()) as { sessionId: string; captureRunId: string };
      const firstBatch = await capturePost(base, "/capture/v1/batches", runningJob.token, {
        sessionId,
        sequence: 1,
        idempotencyKey: "disc-1",
        changes: [upsertChange("kept", "https://x.com/i/status/kept")],
      });
      assert.equal(firstBatch.status, 200);
      const sessionBefore = db.prepare(`SELECT finished_at AS finishedAt FROM capture_sessions WHERE id = ?`).get(sessionId) as {
        finishedAt: string | null;
      };
      assert.equal(sessionBefore.finishedAt, null);
      const runBefore = db
        .prepare(`SELECT status, finished_at AS finishedAt FROM capture_runs WHERE id = ?`)
        .get(captureRunId) as { status: string; finishedAt: string | null };
      assert.equal(runBefore.status, "running");
      assert.equal(runBefore.finishedAt, null);

      const runningDisconnect = await fetch(`${base}/api/sources/x/disconnect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: runningAccount.account.id }),
      });
      assert.equal(runningDisconnect.status, 200);
      const runningPoll = await captureGet(base, `/capture/v1/jobs/${runningJob.id}`, device.token);
      assert.equal(((await runningPoll.json()) as { status: string }).status, "cancelled");
      const continued = await capturePost(base, "/capture/v1/batches", runningJob.token, {
        sessionId,
        sequence: 2,
        idempotencyKey: "disc-2",
        changes: [upsertChange("late", "https://x.com/i/status/late")],
      });
      assert.equal(continued.status, 401);
      const resume = await capturePost(base, "/capture/v1/sessions", runningJob.token, sessionBody("x", "abhigyan898"));
      assert.equal(resume.status, 401);

      const runAfter = db
        .prepare(
          `SELECT status, finished_at AS finishedAt, coverage, error_code AS errorCode, error_detail AS errorDetail FROM capture_runs WHERE id = ?`,
        )
        .get(captureRunId) as {
        status: string;
        finishedAt: string | null;
        coverage: string | null;
        errorCode: string | null;
        errorDetail: string | null;
      };
      assert.equal(runAfter.status, "cancelled");
      assert.ok(runAfter.finishedAt);
      assert.equal(runAfter.coverage, "partial");
      assert.equal(runAfter.errorCode, "interrupted");
      assert.equal(runAfter.errorDetail, "stopped by user");
      assert.equal(
        (db.prepare(`SELECT COUNT(*) AS n FROM capture_runs WHERE status = 'running' AND finished_at IS NULL`).get() as { n: number }).n,
        0,
      );
      const cleaned = cleanupSourceConnections(db);
      assert.deepEqual(cleaned.leftovers, []);
      assert.equal(
        (db.prepare(`SELECT COUNT(*) AS n FROM capture_runs WHERE status = 'running' AND finished_at IS NULL`).get() as { n: number }).n,
        0,
      );

      const after = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as SourcesOverview;
      assert.equal(after.connections.find((connection) => connection.source === "x")!.state, "not_connected");
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items WHERE url LIKE '%/kept'`).get() as { n: number }).n, 1);
      assert.equal((db.prepare(`SELECT account_kind AS k FROM source_accounts WHERE id = 'x-imported'`).get() as { k: string }).k, "imported");

      const repeat = await fetch(`${base}/api/sources/x/disconnect`, {
        method: "POST",
        headers,
        body: JSON.stringify({ accountId: runningAccount.account.id }),
      });
      assert.equal(repeat.status, 404);

      heartbeat();
      const reconnect = await fetch(`${base}/api/sources/x/connect`, { method: "POST", headers, body: "{}" });
      assert.equal(reconnect.status, 200);
      const reconnected = (await reconnect.json()) as { account: { id: string } };
      runningAccountId = reconnected.account.id;
      const afterReconnect = (await (await fetch(`${base}/api/sources`, { headers: { cookie } })).json()) as SourcesOverview;
      const xReconnect = afterReconnect.connections.find((connection) => connection.source === "x")!;
      assert.notEqual(xReconnect.latestAttempt?.status, "running");
      assert.ok(xReconnect.latestAttempt?.finishedAt);
      const waitingAgain = await captureGet(base, "/capture/v1/jobs/wait", device.token);
      const nextJob = (await waitingAgain.json()) as { id: string; token?: string };
      assert.ok(nextJob.token);
      const nextSession = await capturePost(base, "/capture/v1/sessions", nextJob.token, sessionBody("x", "abhigyan898"));
      assert.equal(nextSession.status, 200);
      const next = (await nextSession.json()) as { captureRunId: string };
      assert.notEqual(next.captureRunId, captureRunId);
      const oldRun = db.prepare(`SELECT status FROM capture_runs WHERE id = ?`).get(captureRunId) as { status: string };
      const newRun = db.prepare(`SELECT status, finished_at AS finishedAt FROM capture_runs WHERE id = ?`).get(next.captureRunId) as {
        status: string;
        finishedAt: string | null;
      };
      assert.equal(oldRun.status, "cancelled");
      assert.equal(newRun.status, "running");
      assert.equal(newRun.finishedAt, null);
    } finally {
      markDone("x", queuedAccountId);
      markDone("x", runningAccountId);
      resetJobsForTest();
      await app.close();
      db.close();
    }
  });

  test("opening a v24 database merges stale pending rows", () => {
    const dir = mkdtempSync(join(tmpdir(), "locus-lifecycle-migrate-"));
    const path = join(dir, "legacy.db");
    const db = openDb(path);
    insertAccount(db, { id: "x-live", externalId: "abhigyan898", createdAt: "2026-08-01T00:00:00Z" });
    insertAccount(db, { id: "x-pending", externalId: "pending:x-pending", createdAt: "2026-08-03T00:00:00Z" });
    insertItem(db, "x-pending", "migrated", "2026-08-03T00:00:00Z");
    db.exec(`PRAGMA user_version = 24`);
    db.close();

    const migrated = openDb(path);
    assert.equal((migrated.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
    assert.equal((migrated.prepare(`SELECT COUNT(*) AS n FROM source_accounts WHERE id = 'x-pending'`).get() as { n: number }).n, 0);
    assert.equal((migrated.prepare(`SELECT source_account_id AS id FROM source_records WHERE external_id = 'migrated'`).get() as { id: string }).id, "x-live");
    migrated.close();
  });
});
