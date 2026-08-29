import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { MissingResource, setStatus } from "../core/commands.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import {
  LOCAL_LIBRARY_ID,
  cleanupExpiredRemovals,
  listReadingDocuments,
  getReadingDocument,
  reconcileItem,
  removeReadingDocument,
  undoRemoveReadingDocument,
  updateReadingProgress,
} from "../server/reading/module.ts";
import { importReadingRecords } from "../server/reading/module.ts";
import { saveAsset } from "../server/reading/worker.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8795";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_READING_ASSETS = mkdtempSync(join(tmpdir(), "locus-queue-assets-"));

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-reading-queue-")), "t.db"));
}

function seedDocs(
  db: ReturnType<typeof mem>,
  n: number,
  opts: { availability?: string; kind?: string; finished?: boolean; prefix?: string; originalStatus?: string } = {},
): void {
  const availability = opts.availability ?? "ready";
  const kind = opts.kind ?? "article";
  const prefix = opts.prefix ?? "doc";
  const records: Record<string, unknown>[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `${prefix}-${String(i).padStart(4, "0")}`;
    const saved = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
    records.push({
      kind: "readingDocument",
      id,
      canonicalUrl: `https://example.com/p/${id}`,
      observedUrl: `https://example.com/p/${id}`,
      kindName: kind,
      availability,
      originalStatus: opts.originalStatus ?? "unknown",
      title: `Title ${id}`,
      publication: `Pub ${String(i % 10).padStart(2, "0")}`,
      searchText: i === 7 ? "unique-search-body" : null,
      readingMinutes: i % 29 === 0 ? null : (i % 23) + 1,
      lastSavedAt: saved,
      createdAt: saved,
      updatedAt: saved,
    });
  }
  importReadingRecords(db, { documents: records, provenance: [], progress: [], itemIds: new Set() });
  if (opts.finished) {
    for (const record of records) updateReadingProgress(db, LOCAL_LIBRARY_ID, String(record.id), { op: "finished" });
  }
}

function insertItem(
  db: ReturnType<typeof mem>,
  id: string,
  permalink: string,
  body: string,
): void {
  const now = "2026-08-27T00:00:00.000Z";
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, `Item ${id}`, body, permalink, now, now, now);
}

test("queue sections keep preparing and unread apart", () => {
  const db = mem();
  seedDocs(db, 1, { availability: "pending" });
  seedDocs(db, 1, { prefix: "ready" });
  seedDocs(db, 1, { prefix: "block", availability: "blocked" });
  seedDocs(db, 1, { prefix: "read" });
  updateReadingProgress(db, LOCAL_LIBRARY_ID, "read-0000", { op: "advance", progress: 0.4 });
  const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(page.preparing.count, 1);
  assert.equal(page.unread.items.map((row) => row.id).includes("ready-0000"), true);
  assert.equal(page.unread.items.some((row) => row.id === "read-0000"), true);
  assert.equal(page.unread.items.some((row) => row.id === "doc-0000" || row.id === "block-0000"), false);
  assert.equal(page.unread.items.find((row) => row.id === "read-0000")?.progress?.state, "reading");
  assert.equal(page.counts.reading, 1);
  assert.equal(page.counts.unread, 2);
  assert.ok(!("contentBlocks" in (page.unread.items[0] ?? {})));
  db.close();
});

test("queue section previews stay bounded when real libraries have many pending documents", () => {
  const db = mem();
  seedDocs(db, 30, { prefix: "pending", availability: "pending" });
  seedDocs(db, 20, { prefix: "blocked", availability: "blocked" });
  const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(page.preparing.count, 30);
  assert.equal(page.preparing.preview.length, 8);
  assert.equal(page.unread.items.length, 0);
  db.close();
});

test("known-gone original status reaches queue summaries and hides the index action", () => {
  const db = mem();
  seedDocs(db, 1, { prefix: "gone", originalStatus: "gone" });
  const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(page.unread.items[0]?.originalStatus, "gone");
  const source = readFileSync(new URL("../app/src/ReadingPage.tsx", import.meta.url), "utf8");
  assert.match(source, /doc\.originalStatus !== "gone"/);
  db.close();
});

test("unknown and pdf never mix into unread even if marked ready", () => {
  const db = mem();
  seedDocs(db, 1, { prefix: "unk", kind: "unknown" });
  seedDocs(db, 1, { prefix: "pdf", kind: "pdf", availability: "metadata_only" });
  const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(page.unread.items.length, 0);
  db.close();
});

test("progress is monotonic, unread deletes the row, finished is authoritative", () => {
  const db = mem();
  seedDocs(db, 1);
  insertItem(db, "item-1", "https://x.com/a/status/1", "https://example.com/p/doc-0000");
  reconcileItem(db, LOCAL_LIBRARY_ID, "item-1");
  const first = updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "advance", progress: 0.2 });
  assert.equal(first?.state, "reading");
  assert.equal(first?.progress, 0.2);
  assert.throws(() => updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "advance", progress: 0.1 }), RejectedPayload);
  assert.throws(() => updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "nope" }), RejectedPayload);
  assert.throws(() => updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "advance", progress: 2 }), RejectedPayload);
  assert.throws(
    () => updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "advance", progress: 0.3, anchor: { blockId: "" } }),
    RejectedPayload,
  );
  assert.throws(
    () => updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "advance", progress: 0.3, anchor: { blockId: "doc-0000", offset: 2 } }),
    RejectedPayload,
  );
  const still = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).unread.items.find((row) => row.id === "doc-0000");
  assert.equal(still?.progress?.progress, 0.2);
  const done = updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "finished" });
  assert.equal(done?.state, "finished");
  assert.equal(done?.progress, 1);
  const again = updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "advance", progress: 1 });
  assert.equal(again?.state, "finished");
  setStatus(db, "item-1", "archived");
  assert.equal(
    (db.prepare(`SELECT status FROM item_state WHERE item_id = 'item-1'`).get() as { status: string }).status,
    "archived",
  );
  assert.equal(
    getReadingDocument(db, LOCAL_LIBRARY_ID, "doc-0000").progress?.state,
    "finished",
  );
  assert.equal(updateReadingProgress(db, LOCAL_LIBRARY_ID, "doc-0000", { op: "unread" }), null);
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).unread.items[0]?.id, "doc-0000");
  db.close();
});

test("remove hides immediately, scoped undo restores only that token, cleanup keeps the tombstone", () => {
  const db = mem();
  seedDocs(db, 2);
  const a = removeReadingDocument(db, LOCAL_LIBRARY_ID, "doc-0000");
  const b = removeReadingDocument(db, LOCAL_LIBRARY_ID, "doc-0001");
  const hidden = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(hidden.unread.items.length, 0);
  assert.throws(() => getReadingDocument(db, LOCAL_LIBRARY_ID, "doc-0000"), MissingResource);
  const restored = undoRemoveReadingDocument(db, LOCAL_LIBRARY_ID, a.undoToken);
  assert.equal(restored.id, "doc-0000");
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).unread.items[0]?.id, "doc-0000");
  assert.throws(() => getReadingDocument(db, LOCAL_LIBRARY_ID, "doc-0001"), MissingResource);
  undoRemoveReadingDocument(db, LOCAL_LIBRARY_ID, b.undoToken);
  const again = removeReadingDocument(db, LOCAL_LIBRARY_ID, "doc-0000");
  cleanupExpiredRemovals(db, new Date(Date.now() + 31_000).toISOString());
  assert.throws(() => getReadingDocument(db, LOCAL_LIBRARY_ID, "doc-0000"), MissingResource);
  assert.throws(() => undoRemoveReadingDocument(db, LOCAL_LIBRARY_ID, again.undoToken), MissingResource);
  insertItem(db, "item-tomb", "https://x.com/a/status/1", "https://example.com/p/doc-0000");
  reconcileItem(db, LOCAL_LIBRARY_ID, "item-tomb");
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).unread.items.some((row) => row.id === "doc-0000"), false);
  db.close();
});

test("search covers article text, provenance, tags, and notes", () => {
  const db = mem();
  seedDocs(db, 8);
  insertItem(db, "item-s", "https://x.com/a/status/1", "body with zebra-note-token https://example.com/p/doc-0001");
  reconcileItem(db, LOCAL_LIBRARY_ID, "item-s");
  db.prepare(`INSERT INTO tags (id, name) VALUES ('tag-1', 'coral-tag')`).run();
  db.prepare(
    `INSERT INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES ('item-s', 'tag-1', 'tag', 'user', '2026-08-27T00:00:00.000Z')`,
  ).run();
  db.prepare(
    `INSERT INTO notes (id, item_id, body, created_at, updated_at) VALUES ('note-1', 'item-s', 'notebook margin', '2026-08-27T00:00:00.000Z', '2026-08-27T00:00:00.000Z')`,
  ).run();
  const byBody = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", q: "unique-search-body" });
  assert.equal(byBody.unread.items[0]?.id, "doc-0007");
  const byTag = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", q: "coral-tag" });
  assert.equal(byTag.unread.items[0]?.id, "doc-0001");
  const byNote = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", q: "notebook margin" });
  assert.equal(byNote.unread.items[0]?.id, "doc-0001");
  db.close();
});

test("1,000 documents paginate without gaps or duplicates for every sort", () => {
  const db = mem();
  seedDocs(db, 1000);
  const sorts = ["recent", "oldest", "shortest", "longest", "publication"] as const;
  for (const sort of sorts) {
    const ids: string[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", sort, cursor, limit: 50 });
      assert.equal(page.counts.unread, 1000);
      ids.push(...page.unread.items.map((row) => row.id));
      if (!page.unread.nextCursor) break;
      cursor = page.unread.nextCursor;
    }
    assert.equal(ids.length, 1000, sort);
    assert.equal(new Set(ids).size, 1000, sort);
  }
  let unreadCursor: string | undefined;
  for (;;) {
    const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", cursor: unreadCursor, limit: 100 });
    for (const item of page.unread.items) updateReadingProgress(db, LOCAL_LIBRARY_ID, item.id, { op: "finished" });
    if (!page.unread.nextCursor) break;
    unreadCursor = page.unread.nextCursor;
  }
  const finished: string[] = [];
  let cursor: string | undefined;
  for (;;) {
    const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "finished", cursor, limit: 50 });
    assert.equal(page.counts.finished, 1000);
    finished.push(...page.items.map((row) => row.id));
    if (!page.nextCursor) break;
    cursor = page.nextCursor;
  }
  assert.equal(finished.length, 1000);
  assert.equal(new Set(finished).size, 1000);
  db.close();
});

test("Reading index stays a real route list without Stage or previews", () => {
  const src = readFileSync(new URL("../app/src/ReadingPage.tsx", import.meta.url), "utf8");
  const app = readFileSync(new URL("../app/src/App.tsx", import.meta.url), "utf8");
  const api = readFileSync(new URL("../app/src/api.ts", import.meta.url), "utf8");
  assert.doesNotMatch(src, /useLinkPreview|link-preview|isReadingItem/);
  assert.doesNotMatch(src, /Continue reading|Needs original/);
  assert.doesNotMatch(src, /continue/);
  assert.doesNotMatch(api, /continue:\s*ReadingSummary\[\]/);
  assert.doesNotMatch(app, /readerOpen|reading-shell|documentId/);
  assert.match(app, /if \(a === "reading"\) return \{ name: "reading" \}/);
  assert.match(src, /Opened/);
  assert.match(src, /Open original in a new tab/);
  assert.match(src, /Mark finished/);
  assert.doesNotMatch(src, /#\/reading\/\$\{doc\.id\}/);
  assert.match(src, /Remove from Reading/);
});

test("HTTP progress, remove, and undo stay Library-scoped", async () => {
  const { listen } = await import("../server/http/server.ts");
  const database = mem();
  seedDocs(database, 2);
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    const session = (await sessionResponse.json()) as { csrf: string };
    assert.ok(cookie);
    const headers = { cookie, "content-type": "application/json", "x-csrf-token": session.csrf };
    const bad = await fetch(`${base}/api/reading/doc-0000/progress`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op: "advance", progress: -1 }),
    });
    assert.equal(bad.status, 400);
    const ok = await fetch(`${base}/api/reading/doc-0000/progress`, {
      method: "POST",
      headers,
      body: JSON.stringify({ op: "advance", progress: 0.5 }),
    });
    assert.equal(ok.status, 200);
    const queue = await fetch(`${base}/api/reading?view=queue`, { headers: { cookie } });
    const body = (await queue.json()) as { unread: { items: { id: string; progress: { state: string } | null }[] } };
    assert.equal(body.unread.items.find((row) => row.id === "doc-0000")?.progress?.state, "reading");
    const removed = await fetch(`${base}/api/reading/doc-0001/remove`, { method: "POST", headers, body: "{}" });
    assert.equal(removed.status, 200);
    const token = ((await removed.json()) as { undoToken: string }).undoToken;
    const missing = await fetch(`${base}/api/reading/doc-0001`, { headers: { cookie } });
    assert.equal(missing.status, 404);
    const undo = await fetch(`${base}/api/reading/undo-remove`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token }),
    });
    assert.equal(undo.status, 200);
    const expired = await fetch(`${base}/api/reading/undo-remove`, {
      method: "POST",
      headers,
      body: JSON.stringify({ token: "missing" }),
    });
    assert.equal(expired.status, 404);
  } finally {
    await app.close();
    database.close();
  }
});

async function eventually(request: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await request();
    } catch (error) {
      if (attempt === 19) throw error;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("unreachable");
}

test("reading asset paths cannot escape the cache root", () => {
  const db = mem();
  const root = process.env.LOCUS_READING_ASSETS!;
  const canary = join(root, "outside");
  mkdirSync(canary, { recursive: true });
  writeFileSync(join(canary, "keep.txt"), "keep");

  // saveAsset refuses traversal ids instead of writing outside the cache root.
  assert.throws(
    () => saveAsset(db, "local", "../outside", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg"),
    RejectedPayload,
  );
  assert.equal(existsSync(join(root, "local")), false);
  assert.equal(readdirSync(canary).length, 1);

  // Schema-fixture exception: this hostile persisted id cannot be created via
  // the public import interface (which rejects traversal ids). It exercises
  // cleanup's containment guard rather than Reading behavior through SQL.
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO reading_documents (
       id, library_id, canonical_url, observed_url, kind, availability, original_status,
       last_saved_at, removed_at, undo_expires_at, created_at, updated_at
     ) VALUES ('../outside', 'local', 'https://example.com/x', 'https://example.com/x', 'article', 'ready', 'unknown',
       ?, ?, ?, ?, ?)`,
  ).run(now, now, new Date(Date.now() - 1_000).toISOString(), now, now);
  cleanupExpiredRemovals(db, now);
  assert.ok(existsSync(join(canary, "keep.txt")));
  assert.equal(readdirSync(canary).length, 1);
  assert.throws(() => getReadingDocument(db, LOCAL_LIBRARY_ID, "../outside"), MissingResource);
  db.close();
});
