import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { parseBatch, parseSession } from "../packages/protocol/validate.ts";
import {
  CaptureAuthorizationError,
  finishSession,
  ingestBatch,
  isThinBody,
  issueToken,
  lookupToken,
  startSession,
} from "../server/capture/ingest.ts";
import { importJsonl } from "../server/import.ts";
import { importRedditExport } from "../importers/reddit-export/index.ts";
import { RejectedPayload, sanitizeUrl } from "../core/sanitize.ts";
import { dateLabel } from "../core/types.ts";
import { listItems } from "../core/library.ts";

function mem() {
  const dir = mkdtempSync(join(tmpdir(), "locus-"));
  return openDb(join(dir, "t.db"));
}

const session = {
  protocolVersion: 1 as const,
  source: "x" as const,
  producer: { id: "test", version: "1" },
  accountExternalId: "acct",
  collection: { externalId: "bookmarks", name: "Bookmarks" },
  mode: "snapshot" as const,
  observedAt: "2026-08-23T12:00:00.000Z",
};

function upsert(externalId: string, url = `https://x.com/i/status/${externalId}`) {
  return {
    kind: "upsert" as const,
    externalId,
    item: { contentType: "post" as const, body: `post ${externalId}`, url },
  };
}

test("isThinBody treats empty and a lone URL as not-yet-read", () => {
  assert.equal(isThinBody(null), true);
  assert.equal(isThinBody("https://www.instagram.com/p/abc/"), true);
  assert.equal(isThinBody("nice light on this street"), false);
});

test("replayed batch does not duplicate", () => {
  const db = mem();
  const { token } = issueToken(db, "x", null);
  const tok = lookupToken(db, token)!;
  const { sessionId } = startSession(db, tok, session);
  const batch = { sessionId, sequence: 1, idempotencyKey: "k1", changes: [upsert("1"), upsert("2")] };
  const a = ingestBatch(db, batch);
  const b = ingestBatch(db, batch);
  assert.equal(a.replayed, false);
  assert.equal(b.replayed, true);
  const n = db.prepare(`SELECT COUNT(*) as n FROM items`).get() as { n: number };
  assert.equal(n.n, 2);
});

test("capture sessions reject a different token, including on finish", () => {
  const db = mem();
  const first = lookupToken(db, issueToken(db, "x", null).token)!;
  const other = lookupToken(db, issueToken(db, "x", null).token)!;
  const started = startSession(db, first, session);
  const batch = { sessionId: started.sessionId, sequence: 1, idempotencyKey: "cross-token", changes: [upsert("cross-token")] };

  assert.throws(
    () => ingestBatch(db, batch, { token: other }),
    (error: unknown) => error instanceof CaptureAuthorizationError && error.statusCode === 403,
  );
  assert.throws(
    () => finishSession(db, { sessionId: started.sessionId, coverage: "partial" }, other),
    (error: unknown) => error instanceof CaptureAuthorizationError && error.statusCode === 403,
  );
  assert.throws(
    () => ingestBatch(db, { ...batch, sessionId: "missing" }, { token: other }),
    (error: unknown) => error instanceof CaptureAuthorizationError && error.statusCode === 404,
  );
  assert.equal((db.prepare(`SELECT COUNT(*) as n FROM items`).get() as { n: number }).n, 0);
});

test("source/account tokens cannot start a session for another source", () => {
  const db = mem();
  const reddit = lookupToken(db, issueToken(db, "reddit", null).token)!;
  const redditSession = startSession(db, reddit, {
    ...session,
    source: "reddit",
    accountExternalId: "reddit-user",
    collection: { externalId: "saved", name: "Saved" },
  });
  const accountId = (db.prepare(`SELECT source_account_id as id FROM capture_sessions WHERE id = ?`).get(redditSession.sessionId) as { id: string }).id;
  const x = lookupToken(db, issueToken(db, "x", accountId).token)!;
  assert.throws(
    () => startSession(db, x, session),
    (error: unknown) => error instanceof CaptureAuthorizationError && error.statusCode === 403,
  );
});

test("idempotency keys are scoped to one capture session", () => {
  const db = mem();
  const tok = lookupToken(db, issueToken(db, "x", null).token)!;
  const first = startSession(db, tok, session);
  const key = "same-key-in-different-sessions";
  const firstResult = ingestBatch(db, { sessionId: first.sessionId, sequence: 1, idempotencyKey: key, changes: [upsert("same", "https://x.com/first")] });
  assert.deepEqual(firstResult, { replayed: false, inserted: 1, updated: 0, upserted: 1, removed: 0 });
  finishSession(db, { sessionId: first.sessionId, coverage: "partial" });

  const second = startSession(db, tok, { ...session, mode: "incremental" });
  const secondResult = ingestBatch(db, { sessionId: second.sessionId, sequence: 1, idempotencyKey: key, changes: [upsert("same", "https://x.com/second")] });
  assert.deepEqual(secondResult, { replayed: false, inserted: 0, updated: 1, upserted: 1, removed: 0 });
  assert.equal((db.prepare(`SELECT url FROM items`).get() as { url: string }).url, "https://x.com/second");
});

test("opening a legacy database migrates global idempotency uniqueness", () => {
  const dir = mkdtempSync(join(tmpdir(), "locus-legacy-"));
  const path = join(dir, "legacy.db");
  const db = openDb(path);
  db.prepare(`INSERT INTO capture_batches (session_id, sequence, idempotency_key) VALUES (?, ?, ?)`).run("old-session", 1, "reusable-key");
  db.exec(`CREATE UNIQUE INDEX legacy_capture_batch_key ON capture_batches(idempotency_key); PRAGMA user_version = 1`);
  db.close();

  const migrated = openDb(path);
  migrated.prepare(`INSERT INTO capture_batches (session_id, sequence, idempotency_key) VALUES (?, ?, ?)`).run("new-session", 1, "reusable-key");
  assert.equal((migrated.prepare(`SELECT COUNT(*) as n FROM capture_batches WHERE idempotency_key = ?`).get("reusable-key") as { n: number }).n, 2);
});

test("partial finish never removes existing records", () => {
  const db = mem();
  const { token } = issueToken(db, "x", null);
  const tok = lookupToken(db, token)!;
  const first = startSession(db, tok, session);
  ingestBatch(db, { sessionId: first.sessionId, sequence: 1, idempotencyKey: "a", changes: [upsert("keep"), upsert("gone")] });
  finishSession(db, { sessionId: first.sessionId, coverage: "complete" });
  const second = startSession(db, tok, { ...session, mode: "incremental" });
  ingestBatch(db, { sessionId: second.sessionId, sequence: 1, idempotencyKey: "b", changes: [upsert("keep")] });
  finishSession(db, { sessionId: second.sessionId, coverage: "partial" });
  const memberships = db.prepare(`SELECT COUNT(*) as n FROM source_memberships`).get() as { n: number };
  assert.equal(memberships.n, 2);
});

test("complete snapshot removes missing membership and keeps the item", () => {
  const db = mem();
  const { token } = issueToken(db, "x", null);
  const tok = lookupToken(db, token)!;
  const first = startSession(db, tok, session);
  ingestBatch(db, { sessionId: first.sessionId, sequence: 1, idempotencyKey: "a", changes: [upsert("keep"), upsert("gone")] });
  finishSession(db, { sessionId: first.sessionId, coverage: "complete" });
  const second = startSession(db, tok, session);
  ingestBatch(db, { sessionId: second.sessionId, sequence: 1, idempotencyKey: "c", changes: [upsert("keep")] });
  finishSession(db, { sessionId: second.sessionId, coverage: "complete" });
  const items = db.prepare(`SELECT COUNT(*) as n FROM items`).get() as { n: number };
  const memberships = db.prepare(`SELECT COUNT(*) as n FROM source_memberships`).get() as { n: number };
  assert.equal(items.n, 2);
  assert.equal(memberships.n, 1);
});

test("malformed and unsafe payloads are rejected", () => {
  assert.throws(() => parseSession({ protocolVersion: 2 }), RejectedPayload);
  assert.throws(() => parseBatch({ sessionId: "s", sequence: 1, idempotencyKey: "k", changes: [] }), RejectedPayload);
  assert.throws(() => sanitizeUrl("javascript:alert(1)"), RejectedPayload);
  assert.throws(() => {
    parseBatch({
      sessionId: "s",
      sequence: 1,
      idempotencyKey: "k",
      changes: [{ kind: "upsert", externalId: "e", item: { contentType: "post", url: "javascript:alert(1)" } }],
    });
  }, RejectedPayload);
});

test("date language never invents a save time", () => {
  const label = dateLabel({
    sourceSavedAt: null,
    firstObservedAt: "2026-08-23T10:00:00.000Z",
    capturedAt: "2026-08-23T11:00:00.000Z",
    publishedAt: "2020-01-01T00:00:00.000Z",
  });
  assert.equal(label.kind, "published");
  assert.doesNotMatch(label.text, /saved/);
});

test("JSONL import and hostile url reject", () => {
  const db = mem();
  const jsonl = readFileSync(new URL("../fixtures/capture-x.jsonl", import.meta.url), "utf8");
  const dry = importJsonl(db, jsonl, { dryRun: true });
  assert.equal(dry.sessions, 1);
  const live = importJsonl(db, jsonl, { dryRun: false });
  assert.equal(live.sessions, 1);
  const items = listItems(db, {});
  assert.equal(items.length, 1);
  const hostile = readFileSync(new URL("../fixtures/hostile.jsonl", import.meta.url), "utf8");
  assert.throws(() => importJsonl(db, hostile, { dryRun: false }), RejectedPayload);
});

test("JSONL import requires one complete session followed by batches and one final finish", () => {
  const db = mem();
  const [sessionLine, batchLine, finishLine] = readFileSync(new URL("../fixtures/capture-x.jsonl", import.meta.url), "utf8").trim().split("\n");
  const invalid = [
    [batchLine, sessionLine, finishLine],
    [sessionLine, batchLine],
    [sessionLine, finishLine, batchLine],
    [sessionLine, sessionLine, finishLine],
    [sessionLine, batchLine, finishLine, finishLine],
  ];
  for (const lines of invalid) {
    assert.throws(() => importJsonl(db, lines.join("\n"), { dryRun: true }), RejectedPayload);
  }
});

test("migration recognizes generic legacy JSONL identities as imported provenance", () => {
  const dir = mkdtempSync(join(tmpdir(), "locus-import-account-"));
  const path = join(dir, "legacy-import.db");
  const db = openDb(path);
  const jsonl = readFileSync(new URL("../fixtures/capture-x.jsonl", import.meta.url), "utf8");
  importJsonl(db, jsonl, { dryRun: false });
  // Recreate the pre-v4 shape: JSONL imports used a source-specific unbound
  // token and their Item activities were recorded as ordinary captures.
  db.exec(`
    UPDATE source_accounts SET account_kind = 'live';
    UPDATE activities SET kind = 'captured' WHERE kind = 'imported';
    PRAGMA user_version = 4;
  `);
  db.close();

  const migrated = openDb(path);
  const account = migrated.prepare(`SELECT external_id, account_kind FROM source_accounts`).get() as {
    external_id: string;
    account_kind: string;
  };
  assert.equal(account.external_id, "jsonl-x");
  assert.equal(account.account_kind, "imported");
  migrated.close();
});

test("wildcard extension token can ingest any source", () => {
  const db = mem();
  const { token } = issueToken(db, "*", null);
  const tok = lookupToken(db, token)!;
  assert.equal(tok.source, "*");
  const x = startSession(db, tok, session);
  ingestBatch(db, { sessionId: x.sessionId, sequence: 1, idempotencyKey: "wx", changes: [upsert("9")] });
  const ig = startSession(db, tok, {
    ...session,
    source: "instagram",
    accountExternalId: "ig-user",
    collection: { externalId: "saved", name: "Saved" },
  });
  ingestBatch(db, {
    sessionId: ig.sessionId,
    sequence: 1,
    idempotencyKey: "wig",
    changes: [
      {
        kind: "upsert",
        externalId: "AbC",
        item: { contentType: "post", url: "https://www.instagram.com/p/AbC/", body: "hi" },
      },
    ],
  });
  assert.equal(listItems(db, { source: "x" }).length, 1);
  assert.equal(listItems(db, { source: "instagram" }).length, 1);
});

test("reddit export importer", () => {
  const db = mem();
  const posts = readFileSync(new URL("../fixtures/reddit-export/saved_posts.csv", import.meta.url), "utf8");
  const comments = readFileSync(new URL("../fixtures/reddit-export/saved_comments.csv", import.meta.url), "utf8");
  const dry = importRedditExport(db, posts, comments, { dryRun: true });
  assert.equal(dry.changes, 3);
  const first = importRedditExport(db, posts, comments, { dryRun: false });
  assert.deepEqual(
    { inserted: first.inserted, updated: first.updated, removed: first.removed, replayed: first.replayed, changes: first.changes },
    { inserted: 3, updated: 0, removed: 0, replayed: 0, changes: 3 },
  );
  const items = listItems(db, { source: "reddit" });
  assert.equal(items.length, 3);
  assert.ok(items.some((i) => i.contentType === "comment"));
  assert.ok(items.some((i) => i.sourceSavedAt));

  const changed = posts.replace("What I actually keep", "Changed title from a later export");
  const second = importRedditExport(db, changed, comments, { dryRun: false });
  assert.deepEqual(
    { inserted: second.inserted, updated: second.updated, removed: second.removed, replayed: second.replayed, changes: second.changes },
    { inserted: 0, updated: 3, removed: 0, replayed: 0, changes: 3 },
  );
  assert.ok(listItems(db, { source: "reddit" }).some((i) => i.title === "Changed title from a later export"));
});
