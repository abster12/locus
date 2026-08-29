import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { blockId, remapAnchor, type ReadingBlock } from "../server/reading/blocks.ts";
import { extractPage, extractPageBounded } from "../server/reading/extract.ts";
import { imageWithinBounds, ReadingFetchError, fetchReadingResource, type ReadingTransport } from "../server/reading/fetch.ts";
import { importLibraryArchive } from "../server/library-archive.ts";
import {
  cleanupUrl,
  discoverCandidates,
  isApprovedAlias,
  isBlockedIp,
} from "../server/reading/policy.ts";
import {
  LOCAL_LIBRARY_ID,
  backfillReading,
  getReadingDocument,
  importReadingRecords,
  listReadingDocuments,
  reconcileItem,
} from "../server/reading/module.ts";
import { drainReadingWorker, enrichDocument, retryReadingDocument, startReadingWorker, stopReadingWorker } from "../server/reading/worker.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_READING_ASSETS = mkdtempSync(join(tmpdir(), "locus-p1-assets-"));

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-p1-")), "t.db"));
}

test("www aliases collapse while distinct path identities remain", () => {
  const hosts = discoverCandidates("https://www.example.com/a https://example.com/a", "https://x.com/a/status/1");
  assert.equal(hosts.candidates.length, 1);
  assert.equal(cleanupUrl("https://www.example.com/a")?.canonicalUrl, "https://example.com/a");
  assert.equal(isApprovedAlias("https://www.example.com/a", "https://example.com/a"), true);
  assert.equal(isApprovedAlias("https://example.com/a", "https://evil.example/a"), false);
  const paths = discoverCandidates(
    "https://example.com/javascript https://example.com/javascript-tutorial",
    "https://x.com/a/status/1",
  );
  assert.equal(paths.candidates.length, 2);
});

test("unknown www and mobile hosts are not rewritten without explicit policy", () => {
  assert.equal(cleanupUrl("https://www.publisher.test/a")?.canonicalUrl, "https://www.publisher.test/a");
  assert.equal(cleanupUrl("https://m.publisher.test/a")?.canonicalUrl, "https://m.publisher.test/a");
  const found = discoverCandidates(
    "https://www.publisher.test/a https://publisher.test/a",
    "https://x.com/a/status/1",
  );
  assert.equal(found.candidates.length, 2);
});

test("blocked IPs include documentation, NAT64, and mapped IPv4", () => {
  assert.equal(isBlockedIp("8.8.8.8"), false);
  assert.equal(isBlockedIp("10.1.2.3"), true);
  assert.equal(isBlockedIp("192.0.2.1"), true);
  assert.equal(isBlockedIp("198.51.100.1"), true);
  assert.equal(isBlockedIp("203.0.113.5"), true);
  assert.equal(isBlockedIp("::1"), true);
  assert.equal(isBlockedIp("::ffff:10.0.0.1"), true);
  assert.equal(isBlockedIp("64:ff9b::10.0.0.1"), true);
  assert.equal(isBlockedIp("2001:db8::1"), true);
  assert.equal(isBlockedIp("2606:4700:4700::1111"), false);
});

test("refresh remaps surviving block identity and keeps offset", () => {
  const first = extractPage(
    `<html><body><article><p>${"word ".repeat(40)}</p></article></body></html>`,
    "https://example.com/a",
    "T",
  );
  const para = first.content?.blocks.find((block) => block.type === "paragraph");
  assert.ok(para);
  const second = extractPage(
    `<html><body><article><h2>Intro</h2><p>${"word ".repeat(40)}</p></article></body></html>`,
    "https://example.com/a",
    "T",
  );
  const mapped = remapAnchor({ blockId: para!.id, offset: 0.4 }, second.content!.blocks);
  assert.ok(mapped);
  assert.equal(mapped.blockId, para!.id);
  assert.equal(mapped.offset, 0.4);
  const oldStyle = remapAnchor({ blockId: `1-${blockId("p", 1, "hello").split("-")[0]!}`, offset: 0 }, [
    { id: blockId("p", 1, "hello"), type: "paragraph", inlines: [{ text: "hello", marks: [] }] },
  ] as ReadingBlock[]);
  assert.equal(oldStyle?.blockId, blockId("p", 1, "hello"));
});

test("composite library foreign keys reject mismatched ownership", () => {
  const db = mem();
  const now = "2026-08-27T00:00:00.000Z";
  // Migration/schema exception: this deliberately bypasses the module to
  // prove SQLite's composite ownership FK rejects a mismatched Library id.
  db.prepare(
    `INSERT INTO reading_documents (
       id, library_id, canonical_url, observed_url, kind, availability, original_status, last_saved_at, created_at, updated_at
     ) VALUES ('doc-a', 'local', 'https://example.com/a', 'https://example.com/a', 'article', 'ready', 'unknown', ?, ?, ?)`,
  ).run(now, now, now);
  assert.throws(() => {
    db.prepare(
      `INSERT INTO reading_progress (library_id, document_id, state, progress, updated_at)
       VALUES ('other', 'doc-a', 'reading', 0.2, ?)`,
    ).run(now);
  });
  db.close();
});

test("archive restore rejects javascript URLs and bad enums", async () => {
  const db = mem();
  const dest = join(mkdtempSync(join(tmpdir(), "locus-p1-arc-")), "bad.ndjson");
  writeFileSync(
    dest,
    [
      JSON.stringify({ kind: "manifest", format: "locus-library", version: 1, counts: { readingDocument: 1 } }),
      JSON.stringify({
        kind: "readingDocument",
        id: "bad",
        canonicalUrl: "javascript:alert(1)",
        observedUrl: "javascript:alert(1)",
        kindName: "article",
        availability: "ready",
        lastSavedAt: "2026-08-27T00:00:00.000Z",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
      }),
    ].join("\n") + "\n",
  );
  await assert.rejects(() => importLibraryArchive(db, dest), RejectedPayload);
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).counts.unread, 0);
  db.close();
});

test("backfill processes one bounded batch per call", () => {
  const db = mem();
  const now = "2026-08-27T00:00:00.000Z";
  db.exec("BEGIN");
  for (let i = 0; i < 51; i += 1) {
    const id = `item-${String(i).padStart(3, "0")}`;
    db.prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
    ).run(id, id, `https://example.com/p/${id}`, `https://x.com/a/status/${i}`, now, now, now);
  }
  db.exec("COMMIT");
  assert.equal(backfillReading(db), true);
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", limit: 100 }).preparing.count, 50);
  assert.equal(backfillReading(db), false);
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", limit: 100 }).preparing.count, 51);
  db.close();
});

test("retry cooldown is server-side immediately after a completed attempt", async () => {
  const db = mem();
  const now = "2026-08-27T00:00:00.000Z";
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES ('item-r', 'post', 'R', 'https://example.com/retry', 'https://x.com/a/status/1', ?, '[]', ?, ?)`,
  ).run(now, now, now);
  reconcileItem(db, LOCAL_LIBRARY_ID, "item-r");
  const id = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).preparing.preview[0]!.id;
  let calls = 0;
  const transport: ReadingTransport = {
    async resolve() {
      return { a: ["93.184.216.34"], aaaa: [] };
    },
    async request() {
      calls += 1;
      return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("no") };
    },
  };
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport });
  assert.equal(calls, 1);
  startReadingWorker(db, { transport });
  await drainReadingWorker(db);
  await retryReadingDocument(db, LOCAL_LIBRARY_ID, id);
  assert.equal(calls, 1);
  await drainReadingWorker(db);
  stopReadingWorker(db);
  const detail = getReadingDocument(db, LOCAL_LIBRARY_ID, id);
  assert.equal(detail.failureCode, "not_found");
  db.close();
});

test("untrusted extraction has a hard worker deadline", async () => {
  await assert.rejects(
    () => extractPageBounded(`<html><body><article>${"<p>word</p>".repeat(10_000)}</article></body></html>`, "https://example.com/a", "A", 1),
    /reading extraction timed out/,
  );
});

test("overall fetch deadline covers DNS", async () => {
  const transport: ReadingTransport = {
    async resolve() {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return { a: ["93.184.216.34"], aaaa: [] };
    },
    async request() {
      throw new Error("should not request");
    },
  };
  await assert.rejects(
    () => fetchReadingResource("https://slow.example.com/a", { accept: "text/html", maxBytes: 1000, transport, timeoutMs: 5 }),
    (error: unknown) => error instanceof ReadingFetchError && error.code === "timeout",
  );
});

test("image dimension bounds reject huge decoded sizes", () => {
  const png = Buffer.alloc(24);
  png[0] = 0x89;
  png.write("PNG\r\n\x1a\n", 1, "binary");
  png.writeUInt32BE(20_000, 16);
  png.writeUInt32BE(20_000, 20);
  assert.equal(imageWithinBounds(png, "image/png"), false);
  png.writeUInt32BE(10, 16);
  png.writeUInt32BE(10, 20);
  assert.equal(imageWithinBounds(png, "image/png"), true);
});

test("queue counts stay consistent with section previews", () => {
  const db = mem();
  const now = "2026-08-27T00:00:00.000Z";
  importReadingRecords(db, {
    documents: [
      { kind: "readingDocument", id: "a", canonicalUrl: "https://example.com/a", observedUrl: "https://example.com/a", kindName: "article", availability: "ready", originalStatus: "unknown", title: "A", lastSavedAt: now, createdAt: now, updatedAt: now },
      { kind: "readingDocument", id: "b", canonicalUrl: "https://example.com/b", observedUrl: "https://example.com/b", kindName: "article", availability: "pending", originalStatus: "unknown", title: "B", lastSavedAt: now, createdAt: now, updatedAt: now },
      { kind: "readingDocument", id: "c", canonicalUrl: "https://example.com/c", observedUrl: "https://example.com/c", kindName: "article", availability: "blocked", originalStatus: "unknown", title: "C", lastSavedAt: now, createdAt: now, updatedAt: now },
    ],
    provenance: [],
    progress: [],
    itemIds: new Set(),
  });
  const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(page.counts.preparing, 1);
  assert.equal(page.preparing.count, 1);
  assert.equal(page.unread.items.length, 1);
  db.close();
});
