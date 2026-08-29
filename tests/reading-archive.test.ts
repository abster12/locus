import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { wipeLibrary } from "../core/library.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { dropMissingImages, validateContent } from "../server/reading/blocks.ts";
import {
  ArchiveTooLarge,
  importLibraryArchive,
  LibraryConflict,
  writeLibraryArchive,
} from "../server/library-archive.ts";
import { LOCAL_LIBRARY_ID, getReadingDocument, importReadingRecords, listReadingDocuments } from "../server/reading/module.ts";
import { openReadingAsset, saveAsset } from "../server/reading/worker.ts";
import { importJsonl } from "../server/import.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8796";
process.env.LOCUS_READING_ASSETS = mkdtempSync(join(tmpdir(), "locus-archive-assets-"));

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-archive-")), "t.db"));
}

function tmpFile(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "locus-archive-file-")), name);
}

function seedLibrary(db: ReturnType<typeof mem>): void {
  const now = "2026-08-27T00:00:00.000Z";
  db.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind)
     VALUES ('acct-1', 'x', 'alice', 'Alice', ?, 'live')`,
  ).run(now);
  db.prepare(
    `INSERT INTO source_collections (id, source_account_id, external_id, name, created_at)
     VALUES ('col-src', 'acct-1', 'bookmarks', 'Bookmarks', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES ('item-1', 'post', 'Saved essay', 'see https://example.com/essay', 'https://x.com/a/status/1', ?, '[]', ?, ?)`,
  ).run(now, now, now);
  db.prepare(`INSERT INTO item_state (item_id, status, updated_at) VALUES ('item-1', 'accepted', ?)`).run(now);
  db.prepare(
    `INSERT INTO source_records (id, source_account_id, external_id, item_id, first_observed_at, last_observed_at)
     VALUES ('rec-1', 'acct-1', '1', 'item-1', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO source_memberships (source_collection_id, source_record_id) VALUES ('col-src', 'rec-1')`,
  ).run();
  db.prepare(`INSERT INTO collections (id, name, created_at) VALUES ('folder-1', 'Later', ?)`).run(now);
  db.prepare(`INSERT INTO tags (id, name) VALUES ('tag-1', 'longform')`).run();
  db.prepare(
    `INSERT INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES ('item-1', 'tag-1', 'tag', 'user', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO memberships (item_id, target_id, target_kind, actor, created_at) VALUES ('item-1', 'folder-1', 'collection', 'user', ?)`,
  ).run(now);
  db.prepare(
    `INSERT INTO notes (id, item_id, body, created_at, updated_at) VALUES ('note-1', 'item-1', 'read this', ?, ?)`,
  ).run(now, now);
  db.prepare(
    `INSERT INTO activities (id, item_id, kind, occurred_at, timestamp_source) VALUES ('act-1', 'item-1', 'captured', ?, 'locus')`,
  ).run(now);
  db.prepare(`INSERT INTO settings (key, value) VALUES ('refreshOnOpen', '1')`).run();
  const blocks = {
    version: 1,
    blocks: [
      { id: "0-p", type: "paragraph", inlines: [{ text: "Hello article body", marks: [] }] },
      { id: "1-img", type: "image", assetId: "asset-missing", alt: "diagram", caption: null },
    ],
  };
  importReadingRecords(db, {
    documents: [
      {
        kind: "readingDocument",
        id: "doc-ready",
        canonicalUrl: "https://example.com/essay",
        observedUrl: "https://example.com/essay",
        kindName: "article",
        availability: "ready",
        originalStatus: "reachable",
        title: "Essay",
        searchText: "Hello article body",
        wordCount: 3,
        readingMinutes: 1,
        contentBlocks: blocks,
        lastSavedAt: now,
        createdAt: now,
        updatedAt: now,
      },
      {
        kind: "readingDocument",
        id: "doc-tomb",
        canonicalUrl: "https://example.com/old",
        observedUrl: "https://example.com/old",
        kindName: "article",
        availability: "ready",
        originalStatus: "unknown",
        title: "Gone",
        contentBlocks: { version: 1, blocks: [] },
        removedAt: now,
        lastSavedAt: now,
        createdAt: now,
        updatedAt: now,
      },
    ],
    provenance: [
      { kind: "readingProvenance", documentId: "doc-ready", itemId: "item-1", observedUrl: "https://example.com/essay", discoveredAt: now },
      { kind: "readingProvenance", documentId: "doc-tomb", itemId: "item-1", observedUrl: "https://example.com/old", discoveredAt: now },
    ],
    progress: [
      { kind: "readingProgress", documentId: "doc-ready", state: "reading", progress: 0.4, anchor: '{"v":1,"blockId":"0-p","offset":0}', updatedAt: now },
      { kind: "readingProgress", documentId: "doc-tomb", state: "finished", progress: 1, updatedAt: now },
    ],
    itemIds: new Set(["item-1"]),
  });
  importReadingRecords(db, {
    documents: [{
      kind: "readingDocument",
      id: "foreign-doc",
      canonicalUrl: "https://private.example/essay",
      observedUrl: "https://private.example/essay",
      kindName: "article",
      availability: "ready",
      originalStatus: "reachable",
      title: "Foreign private essay",
      lastSavedAt: now,
      createdAt: now,
      updatedAt: now,
    }],
    provenance: [],
    progress: [],
    itemIds: new Set(),
  }, "other-lib");
  db.prepare(
    `INSERT INTO summaries (id, scope, scope_ref, item_revisions, generator_id, generator_version, content, citations, created_at)
     VALUES ('sum-1', 'day', '2026-08-27', '[]', 'locus', '1', '{}', '[]', ?)`,
  ).run(now);
}

test("dropMissingImages removes only image blocks without assets", () => {
  const content = validateContent({
    version: 1,
    blocks: [
      { id: "0-p", type: "paragraph", inlines: [{ text: "Hi", marks: [] }] },
      { id: "1-img", type: "image", assetId: "keep-me", alt: "ok", caption: null },
      { id: "2-img", type: "image", assetId: "gone", alt: "no", caption: null },
    ],
  });
  assert.ok(content);
  const kept = dropMissingImages(content!, new Set(["keep-me"]));
  assert.equal(kept.blocks.length, 2);
  assert.equal(kept.blocks[1]?.type, "image");
});

test("archive v1 round-trips durable records and rewrites Library id", async () => {
  const db = mem();
  seedLibrary(db);
  const dest = tmpFile("round.ndjson");
  const bytes = writeLibraryArchive(db, dest);
  assert.ok(bytes > 0);
  const text = readFileSync(dest, "utf8");
  const [manifestLine, ...recordLines] = text.trim().split("\n");
  assert.match(manifestLine ?? "", /"format":"locus-library"/);
  assert.match(text, /"kind":"readingDocument"/);
  assert.doesNotMatch(text, /Foreign private essay|foreign-doc/);
  assert.doesNotMatch(recordLines.join("\n"), /"undo_token"|"lease_owner"|"adapter_key"|"token_hash"/);
  wipeLibrary(db);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 0);
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).counts.unread, 0);
  const result = await importLibraryArchive(db, dest);
  assert.equal(result.ok, true);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 1);
  assert.equal((db.prepare(`SELECT account_kind AS k FROM source_accounts`).get() as { k: string }).k, "imported");
  const ready = getReadingDocument(db, LOCAL_LIBRARY_ID, "doc-ready");
  assert.equal(ready.title, "Essay");
  assert.equal(ready.progress?.progress, 0.4);
  assert.equal(ready.contentBlocks?.blocks.some((block) => block.type === "image"), false);
  assert.equal(ready.contentBlocks?.blocks[0]?.type, "paragraph");
  assert.throws(() => getReadingDocument(db, LOCAL_LIBRARY_ID, "doc-tomb"), /document/);
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).unread.items.some((row) => row.id === "doc-tomb"), false);
  assert.equal((db.prepare(`SELECT value FROM settings WHERE key = 'refreshOnOpen'`).get() as { value: string }).value, "1");
  db.close();
});

test("restore into a populated Library is 409 and leaves data", async () => {
  const db = mem();
  seedLibrary(db);
  const dest = tmpFile("conflict.ndjson");
  writeLibraryArchive(db, dest);
  await assert.rejects(() => importLibraryArchive(db, dest), LibraryConflict);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 1);
  db.close();
});

test("unknown version, missing relations, and unsafe blocks abort", async () => {
  const db = mem();
  const version = tmpFile("v2.ndjson");
  writeFileSync(version, `${JSON.stringify({ kind: "manifest", format: "locus-library", version: 2, counts: {} })}\n`);
  await assert.rejects(() => importLibraryArchive(db, version), RejectedPayload);

  const missing = tmpFile("missing.ndjson");
  writeFileSync(
    missing,
    [
      JSON.stringify({
        kind: "manifest",
        format: "locus-library",
        version: 1,
        counts: { itemState: 1 },
      }),
      JSON.stringify({ kind: "itemState", itemId: "nope", status: "inbox", updatedAt: "2026-08-27T00:00:00.000Z" }),
    ].join("\n") + "\n",
  );
  await assert.rejects(() => importLibraryArchive(db, missing), RejectedPayload);

  const unsafe = tmpFile("unsafe.ndjson");
  writeFileSync(
    unsafe,
    [
      JSON.stringify({
        kind: "manifest",
        format: "locus-library",
        version: 1,
        counts: { readingDocument: 1 },
      }),
      JSON.stringify({
        kind: "readingDocument",
        id: "bad",
        canonicalUrl: "https://example.com/x",
        observedUrl: "https://example.com/x",
        kindName: "article",
        availability: "ready",
        lastSavedAt: "2026-08-27T00:00:00.000Z",
        createdAt: "2026-08-27T00:00:00.000Z",
        updatedAt: "2026-08-27T00:00:00.000Z",
        contentBlocks: {
          version: 1,
          blocks: [{ id: "1", type: "paragraph", inlines: [{ text: "x", marks: [{ type: "link", href: "javascript:alert(1)" }] }] }],
        },
      }),
    ].join("\n") + "\n",
  );
  await assert.rejects(() => importLibraryArchive(db, unsafe), RejectedPayload);
  assert.equal(listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).counts.unread, 0);
  db.close();
});

test("export refuses oversized archives; wipe deletes the asset cache", () => {
  const db = mem();
  seedLibrary(db);
  const dest = tmpFile("tiny.ndjson");
  assert.throws(() => writeLibraryArchive(db, dest, 80), ArchiveTooLarge);
  const root = process.env.LOCUS_READING_ASSETS!;
  mkdirSync(join(root, "local", "doc-ready"), { recursive: true });
  writeFileSync(join(root, "local", "doc-ready", "x"), "img");
  wipeLibrary(db);
  assert.equal(existsSync(root), false);
  db.close();
});

test("asset GET stays Library and path scoped", () => {
  const db = mem();
  const now = "2026-08-27T00:00:00.000Z";
  importReadingRecords(db, {
    documents: [{
      kind: "readingDocument",
      id: "doc-a",
      canonicalUrl: "https://example.com/a",
      observedUrl: "https://example.com/a",
      kindName: "article",
      availability: "ready",
      originalStatus: "unknown",
      lastSavedAt: now,
      createdAt: now,
      updatedAt: now,
    }],
    provenance: [],
    progress: [],
    itemIds: new Set(),
  });
  const assetId = saveAsset(db, "local", "doc-a", Buffer.from([0xff, 0xd8, 0xff, 0xd9]), "image/jpeg");
  assert.ok(openReadingAsset(db, "local", "doc-a", assetId));
  assert.equal(openReadingAsset(db, "other", "doc-a", assetId), null);
  assert.equal(openReadingAsset(db, "local", "doc-b", assetId), null);
  // Schema-fixture exception: importReadingRecords rejects traversal ids and
  // cannot create a persisted adapter-key attack for this containment check.
  db.prepare(`UPDATE reading_assets SET adapter_key = '../secret' WHERE id = ?`).run(assetId);
  assert.equal(openReadingAsset(db, "local", "doc-a", assetId), null);
  db.close();
});

test("JSONL capture import does not restore Reading snapshots", () => {
  const db = mem();
  const jsonl = [
    JSON.stringify({
      type: "session",
      protocolVersion: 1,
      source: "x",
      producer: { id: "test", version: "1" },
      accountExternalId: "acct",
      collection: { externalId: "bookmarks", name: "Bookmarks" },
      mode: "snapshot",
      observedAt: "2026-08-27T00:00:00.000Z",
    }),
    JSON.stringify({
      type: "batch",
      sessionId: "pending",
      sequence: 1,
      idempotencyKey: "j1",
      changes: [
        {
          kind: "upsert",
          externalId: "1",
          item: {
            contentType: "post",
            title: "From JSONL",
            body: "https://example.com/from-jsonl",
            url: "https://x.com/a/status/9",
          },
        },
      ],
    }),
    JSON.stringify({ type: "finish", sessionId: "pending", coverage: "partial" }),
  ].join("\n");
  importJsonl(db, jsonl, { dryRun: false });
  const pending = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).preparing.preview[0]!;
  const row = getReadingDocument(db, LOCAL_LIBRARY_ID, pending.id);
  assert.equal(row.availability, "pending");
  assert.equal(row.contentBlocks, null);
  db.close();
});

test("Sources export downloads ndjson and restore uploads the raw archive", () => {
  const src = readFileSync(new URL("../app/src/SourcesPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /JSON\.stringify\(lib/);
  assert.match(src, /importLibrary/);
  assert.match(src, /Restore archive file/);
  assert.match(src, /Restore requires an empty library/);
  const api = readFileSync(new URL("../app/src/api.ts", import.meta.url), "utf8");
  assert.match(api, /\/api\/library\/import/);
  assert.match(api, /application\/x-ndjson/);
});

test("HTTP export/import streams NDJSON above the generic 1 MiB JSON limit", async () => {
  const { listen, MAX_REQUEST_BODY_BYTES } = await import("../server/http/server.ts");
  const db = mem();
  const now = "2026-08-27T00:00:00.000Z";
  db.exec("BEGIN");
  for (let i = 0; i < 60; i += 1) {
    const id = `item-${String(i).padStart(3, "0")}`;
    db.prepare(
      `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
    ).run(id, id, "x".repeat(20_000), `https://x.com/a/status/${i}`, now, now, now);
  }
  db.exec("COMMIT");
  const dest = tmpFile("big.ndjson");
  const bytes = writeLibraryArchive(db, dest);
  assert.ok(bytes > MAX_REQUEST_BODY_BYTES);
  wipeLibrary(db);
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
    const session = (await sessionResponse.json()) as { csrf: string };
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const exported = await fetch(`${base}/api/export`, { headers: { cookie } });
    assert.equal(exported.status, 200);
    assert.match(exported.headers.get("content-type") ?? "", /ndjson/);
    assert.match(exported.headers.get("content-disposition") ?? "", /locus-library\.locus\.ndjson/);
    const archive = readFileSync(dest);
    const restored = await fetch(`${base}/api/library/import`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": session.csrf, "content-type": "application/x-ndjson" },
      body: archive,
    });
    assert.equal(restored.status, 200);
    assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 60);
    const again = await fetch(`${base}/api/library/import`, {
      method: "POST",
      headers: { cookie, "x-csrf-token": session.csrf, "content-type": "application/x-ndjson" },
      body: archive,
    });
    assert.equal(again.status, 409);
    assert.match(await again.text(), /Delete Library before restoring an archive/);
  } finally {
    await app.close();
    db.close();
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

test("imported Reading ids cannot traverse", async () => {
  const db = mem();
  const now = "2026-08-27T00:00:00.000Z";
  const bad = tmpFile("traversal-doc.ndjson");
  writeFileSync(
    bad,
    [
      JSON.stringify({ kind: "manifest", format: "locus-library", version: 1, counts: { readingDocument: 1 } }),
      JSON.stringify({
        kind: "readingDocument",
        id: "../../evil",
        canonicalUrl: "https://example.com/a",
        observedUrl: "https://example.com/a",
        kindName: "article",
        availability: "ready",
        lastSavedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    ].join("\n") + "\n",
  );
  await assert.rejects(() => importLibraryArchive(db, bad), RejectedPayload);

  const badProvenance = tmpFile("traversal-provenance.ndjson");
  writeFileSync(
    badProvenance,
    [
      JSON.stringify({ kind: "manifest", format: "locus-library", version: 1, counts: { item: 1, readingDocument: 1, readingProvenance: 1 } }),
      JSON.stringify({
        kind: "item",
        id: "item-1",
        contentType: "post",
        url: "https://x.com/a/status/1",
        firstObservedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      JSON.stringify({
        kind: "readingDocument",
        id: "doc-ok",
        canonicalUrl: "https://example.com/a",
        observedUrl: "https://example.com/a",
        kindName: "article",
        availability: "ready",
        lastSavedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
      JSON.stringify({ kind: "readingProvenance", documentId: "../evil", itemId: "item-1", observedUrl: "https://example.com/a", discoveredAt: now }),
    ].join("\n") + "\n",
  );
  await assert.rejects(() => importLibraryArchive(db, badProvenance), RejectedPayload);
  db.close();
});
