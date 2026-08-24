import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { parseBatch, parseSession } from "../packages/protocol/validate.ts";
import { finishSession, ingestBatch, isThinBody, issueToken, lookupToken, startSession } from "../server/capture/ingest.ts";
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
  importRedditExport(db, posts, comments, { dryRun: false });
  const items = listItems(db, { source: "reddit" });
  assert.equal(items.length, 3);
  assert.ok(items.some((i) => i.contentType === "comment"));
  assert.ok(items.some((i) => i.sourceSavedAt));
});
