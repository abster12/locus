import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, tx } from "../db/open.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { wipeLibrary } from "../core/library.ts";
import { CANDIDATE_LIMIT, cleanupUrl, discoverCandidates, isChallengeTitle } from "../server/reading/policy.ts";
import {
  LOCAL_LIBRARY_ID,
  absorbPreviewedUrl,
  backfillReading,
  getReadingDocument,
  listReadingDocuments,
  readingDiagnostics,
  reconcileItem,
  resetReadingDiagnostics,
} from "../server/reading/module.ts";
import { enrichDocument } from "../server/reading/worker.ts";
import type { ReadingTransport } from "../server/reading/fetch.ts";
import { finishSession, ingestBatch, issueToken, lookupToken, startSession } from "../server/capture/ingest.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8792";
process.env.LOCUS_READING_WORKER = "0";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-reading-")), "t.db"));
}

function missingTransport(status = 200): ReadingTransport {
  return {
    async resolve() {
      return { a: ["93.184.216.34"], aaaa: [] };
    },
    async request() {
      return {
        status,
        headers: { "content-type": "text/html" },
        body: Buffer.from(`<html><body><main>${Array.from({ length: 100 }, (_, i) => `<a href="/p/${i}">link ${i}</a>`).join("")}</main></body></html>`),
      };
    },
  };
}

function queueDocs(db: ReturnType<typeof mem>): ReturnType<typeof listReadingDocuments> {
  return listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", limit: 100 });
}

test("URL cleanup joins wraps, strips punctuation, tracking, and www", () => {
  assert.equal(cleanupUrl("https://spottedinprod.com,")?.canonicalUrl, "https://spottedinprod.com/");
  assert.equal(
    cleanupUrl("https://www.example.com/a?utm_source=x&id=9#frag")?.canonicalUrl,
    "https://example.com/a?id=9",
  );
  const wrapped = discoverCandidates("see https://\nexample.com/full-article-slug", "https://x.com/a/status/1");
  assert.equal(wrapped.candidates[0]?.canonicalUrl, "https://example.com/full-article-slug");
});

test("a useful Desk preview re-discovers the Item and requeues a false not_article_like", async () => {
  const db = mem();
  const body =
    "https://\ntrychroma.com/engineering/tr\nansactions\n…\nhttps://www.trychroma.com/engineering/transactions";
  insertRawItem(db, "previewed", "https://x.com/a/status/1", body);
  absorbPreviewedUrl(db, "https://www.trychroma.com/engineering/transactions", "Agent Swarms are a Distributed Systems Problem");
  const urls = queueDocs(db).preparing.preview.map((row) => row.canonicalUrl).sort();
  assert.deepEqual(urls, [
    "https://trychroma.com/engineering/tr",
    "https://www.trychroma.com/engineering/transactions",
  ]);
  const target = queueDocs(db).preparing.preview.find((row) => row.canonicalUrl === "https://www.trychroma.com/engineering/transactions")!;
  await enrichDocument(db, LOCAL_LIBRARY_ID, target.id, { transport: missingTransport() });
  absorbPreviewedUrl(db, "https://www.trychroma.com/engineering/transactions", "Agent Swarms are a Distributed Systems Problem");
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, target.id).availability, "pending");
  db.close();
});

test("X wrap plus expanded URL both become candidates", () => {
  const body =
    "pi install https://\ngithub.com/mitsuhiko/pi-d\nrinking-game\n…\nhttps://github.com/mitsuhiko/pi-drinking-game";
  const found = discoverCandidates(body, "https://x.com/mitsuhiko/status/1");
  assert.deepEqual(
    found.candidates.map((candidate) => candidate.canonicalUrl).sort(),
    ["https://github.com/mitsuhiko/pi-d", "https://github.com/mitsuhiko/pi-drinking-game"],
  );
  const db = mem();
  insertRawItem(db, "wrap", "https://x.com/mitsuhiko/status/1", body);
  reconcileItem(db, LOCAL_LIBRARY_ID, "wrap");
  const urls = queueDocs(db).preparing.preview.map((row) => row.canonicalUrl).sort();
  assert.deepEqual(urls, ["https://github.com/mitsuhiko/pi-d", "https://github.com/mitsuhiko/pi-drinking-game"]);
  db.close();
});

test("truncated display URLs collapse; distinct paths do not", () => {
  const collapsed = discoverCandidates(
    "https://blog.example.com/some-arti https://blog.example.com/some-article-here",
    "https://x.com/a/status/1",
  );
  assert.equal(collapsed.candidates.length, 2);

  const distinct = discoverCandidates(
    "https://blog.example.com/foo https://blog.example.com/foo/bar",
    "https://x.com/a/status/1",
  );
  assert.equal(distinct.candidates.length, 2);

  const prefix = discoverCandidates(
    "https://example.com/javascript https://example.com/javascript-tutorial",
    "https://x.com/a/status/1",
  );
  assert.equal(prefix.candidates.length, 2);

  const hosts = discoverCandidates(
    "https://www.example.com/a https://example.com/a",
    "https://x.com/a/status/1",
  );
  assert.equal(hosts.candidates.length, 1);
});

test("hard exclusions drop social assets, permalinks, binaries, and the Item permalink", () => {
  const found = discoverCandidates(
    [
      "https://i.redd.it/abc.jpg",
      "https://www.reddit.com/r/x/comments/abc/hi/",
      "https://www.reddit.com/gallery/abc",
      "https://x.com/b/status/2",
      "https://x.com/i/broadcasts/1ABCdef",
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://streamable.com/2b2fs2",
      "https://imgur.com/2DIKJeK",
      "https://open.spotify.com/s/Rlw2Xz6",
      "https://pca.st/podcast/example",
      "https://cdn.example.com/pic.png",
      "https://example.com/login",
      "https://x.com/a/status/1",
      "https://lucumr.pocoo.org/2026/8/22/fast-hard-code/",
      "https://arxiv.org/pdf/2301.00001.pdf",
    ].join("\n"),
    "https://x.com/a/status/1",
  );
  const urls = found.candidates.map((c) => c.canonicalUrl);
  assert.deepEqual(urls, ["https://lucumr.pocoo.org/2026/8/22/fast-hard-code", "https://arxiv.org/pdf/2301.00001.pdf"]);
  assert.equal(found.candidates[1]?.kind, "pdf");
  assert.ok((found.exclusions.social_asset ?? 0) >= 1);
  assert.equal(found.exclusions.media_page, 4);
  assert.ok((found.exclusions.platform_permalink ?? 0) >= 1);
  assert.ok((found.exclusions.item_permalink ?? 0) >= 1);
  assert.ok((found.exclusions.binary ?? 0) >= 1);
  assert.ok((found.exclusions.policy_path ?? 0) >= 1);
});

test("candidate cap is 20 unique eligible URLs and records overflow", () => {
  const urls = Array.from({ length: 22 }, (_, i) => `https://example.com/post-${String(i).padStart(2, "0")}`);
  const found = discoverCandidates(urls.join("\n"), "https://x.com/a/status/1");
  assert.equal(found.candidates.length, CANDIDATE_LIMIT);
  assert.equal(found.exclusions.candidate_limit_exceeded, 2);
});

test("challenge titles are a strong title signal, not a body-word match", () => {
  assert.equal(isChallengeTitle("Reddit - Prove your humanity."), true);
  assert.equal(isChallengeTitle("Just a moment..."), true);
  assert.equal(isChallengeTitle("What it means to be human"), false);
});

test("reconcile is local, Library-scoped, and shares the Item transaction", () => {
  const db = mem();
  resetReadingDiagnostics();
  db.exec("BEGIN IMMEDIATE");
  insertRawItem(db, "item-crash", "https://x.com/a/status/1", "https://example.com/a");
  reconcileItem(db, LOCAL_LIBRARY_ID, "item-crash");
  db.exec("ROLLBACK");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 0);
  assert.equal(queueDocs(db).preparing.count, 0);

  tx(db, () => {
    insertRawItem(db, "item-ok", "https://x.com/a/status/1", "https://example.com/a");
    reconcileItem(db, LOCAL_LIBRARY_ID, "item-ok");
  });
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items`).get() as { n: number }).n, 1);
  assert.equal(queueDocs(db).preparing.count, 1);
  const list = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(list.preparing.count, 1);
  assert.equal(list.unread.items.length, 0);
  assert.equal(list.preparing.preview[0]?.canonicalUrl, "https://example.com/a");
  db.close();
});

test("one Item can yield two documents; two Items collapse to one", () => {
  const db = mem();
  insertRawItem(db, "multi", "https://x.com/a/status/1", "https://a.example.com/one\nhttps://b.example.com/two");
  reconcileItem(db, LOCAL_LIBRARY_ID, "multi");
  assert.equal(queueDocs(db).preparing.count, 2);

  insertRawItem(db, "other", "https://x.com/c/status/9", "https://a.example.com/one");
  reconcileItem(db, LOCAL_LIBRARY_ID, "other");
  assert.equal(queueDocs(db).preparing.count, 2);
  const shared = queueDocs(db).preparing.preview.find((row) => row.canonicalUrl === "https://a.example.com/one")!;
  assert.equal(shared.savedCount, 2);
  db.close();
});

test("explicit host aliases collapse across Items and provenance retains the observed spelling", () => {
  const db = mem();
  insertRawItem(db, "www", "https://x.com/a/status/1", "https://www.example.com/a?utm_source=x#part");
  insertRawItem(db, "bare", "https://x.com/a/status/2", "https://example.com/a");
  reconcileItem(db, LOCAL_LIBRARY_ID, "www");
  reconcileItem(db, LOCAL_LIBRARY_ID, "bare");
  assert.equal(queueDocs(db).preparing.count, 1);
  const alias = queueDocs(db).preparing.preview[0]!;
  assert.equal(alias.savedCount, 2);
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, alias.id).provenance.find((row) => row.itemId === "www")?.observedUrl,
    "https://www.example.com/a?utm_source=x#part");
  db.close();
});

test("unchanged recapture preserves a ready snapshot after canonical identity changes", async () => {
  const db = mem();
  insertRawItem(db, "redirected", "https://x.com/a/status/1", "https://example.com/old");
  reconcileItem(db, LOCAL_LIBRARY_ID, "redirected");
  const row = queueDocs(db).preparing.preview[0]!;
  const redirectTransport: ReadingTransport = {
    async resolve() { return { a: ["93.184.216.34"], aaaa: [] }; },
    async request({ url }) {
      if (url.toString() === "https://example.com/old") {
        return { status: 302, headers: { location: "https://example.com/new", "content-type": "text/html" }, body: Buffer.from("") };
      }
      return {
        status: 200,
        headers: { "content-type": "text/html", location: "" },
        body: Buffer.from("<html><head><title>New</title></head><body><article><p>" + "word ".repeat(220) + "</p></article></body></html>"),
      };
    },
  };
  await enrichDocument(db, LOCAL_LIBRARY_ID, row.id, { transport: redirectTransport });
  reconcileItem(db, LOCAL_LIBRARY_ID, "redirected");
  const after = queueDocs(db).unread.items;
  assert.equal(after.length, 1);
  assert.equal(after[0]?.id, row.id);
  assert.equal(after[0]?.canonicalUrl, "https://example.com/new");
  assert.equal(after[0]?.availability, "ready");
  assert.equal(after[0]?.savedCount, 1);
  db.close();
});

test("i.redd.it stays out of Reading and challenge previews never become titles", () => {
  const db = mem();
  db.prepare(
    `INSERT INTO link_previews (url, status, title, description, image, site_name, fetched_at)
     VALUES ('https://news.example.com/humanity', 'ok', 'Reddit - Prove your humanity.', 'bot', 'https://i.redd.it/x.png', 'Reddit', '2026-08-27T00:00:00Z')`,
  ).run();
  insertRawItem(
    db,
    "polluted",
    "https://x.com/a/status/1",
    "https://i.redd.it/abc.jpg\nhttps://news.example.com/humanity",
  );
  reconcileItem(db, LOCAL_LIBRARY_ID, "polluted");
  const diagnostics = readingDiagnostics(db);
  assert.equal(diagnostics.availability?.blocked, 1);
  assert.equal(diagnostics.failureCodes?.blocked_challenge, 1);
  assert.equal(queueDocs(db).preparing.count, 0);
  db.close();
});

test("ingestBatch reconciles inside the same commit; JSONL-style finish does not fetch", () => {
  const db = mem();
  const tok = lookupToken(db, issueToken(db, "x", null).token)!;
  const started = startSession(db, tok, {
    protocolVersion: 1,
    source: "x",
    producer: { id: "test", version: "1" },
    accountExternalId: "acct",
    collection: { externalId: "bookmarks", name: "Bookmarks" },
    mode: "snapshot",
    observedAt: "2026-08-27T00:00:00.000Z",
  });
  ingestBatch(db, {
    sessionId: started.sessionId,
    sequence: 1,
    idempotencyKey: "r1",
    changes: [
      {
        kind: "upsert",
        externalId: "1",
        item: {
          contentType: "post",
          title: "Saved essay",
          body: "read https://example.com/essay",
          url: "https://x.com/a/status/1",
        },
      },
    ],
  });
  finishSession(db, { sessionId: started.sessionId, coverage: "partial" }, tok);
  assert.equal(queueDocs(db).preparing.count, 1);
  const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(page.preparing.count, 1);
  assert.ok(!("content_blocks" in (page.preparing.preview[0] ?? {})));
  db.close();
});

test("authoritative recapture removes stale Reading provenance", () => {
  const db = mem();
  const tok = lookupToken(db, issueToken(db, "x", null).token)!;
  const capture = (body: string, observedAt: string, key: string): void => {
    const started = startSession(db, tok, {
      protocolVersion: 1,
      source: "x",
      producer: { id: "test", version: "1" },
      accountExternalId: "acct",
      collection: { externalId: "bookmarks", name: "Bookmarks" },
      mode: "snapshot",
      observedAt,
    });
    ingestBatch(db, {
      sessionId: started.sessionId,
      sequence: 1,
      idempotencyKey: key,
      changes: [{
        kind: "upsert",
        externalId: "same-post",
        item: {
          contentType: "post",
          title: "Updated save",
          body,
          url: "https://x.com/a/status/1",
        },
      }],
    });
    finishSession(db, { sessionId: started.sessionId, coverage: "partial" }, tok);
  };

  capture("Original context https://example.com/old", "2026-08-27T00:00:00.000Z", "old");
  capture("Replacement context https://example.com/new", "2026-08-28T00:00:00.000Z", "new");
  const urls = queueDocs(db).preparing.preview.map((row) => row.canonicalUrl);
  assert.deepEqual(urls, ["https://example.com/new"]);
  assert.equal(queueDocs(db).preparing.preview[0]?.savedCount, 1);
  db.close();
});

test("backfill is idempotent and wipe removes Reading rows", () => {
  const db = mem();
  insertRawItem(db, "legacy", "https://x.com/a/status/1", "https://example.com/legacy");
  backfillReading(db);
  const first = queueDocs(db).preparing.preview[0]!;
  backfillReading(db);
  const second = queueDocs(db).preparing.preview[0]!;
  assert.equal(second.id, first.id);
  assert.equal(second.lastSavedAt, first.lastSavedAt);
  assert.equal((db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
  wipeLibrary(db);
  assert.equal(queueDocs(db).preparing.count, 0);
  db.close();
});

test("Reading page no longer fans out previews or opens Stage", () => {
  const src = readFileSync(new URL("../app/src/ReadingPage.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(src, /useLinkPreview|link-preview|isReadingItem/);
  assert.match(src, /\.reading\(/);
  assert.doesNotMatch(src, /ReadingReader|#\/reading\/\$\{doc\.id\}/);
});

test("HTTP list/detail are database-only and hide missing documents", async () => {
  const { listen } = await import("../server/http/server.ts");
  const database = mem();
  insertRawItem(database, "http-item", "https://x.com/a/status/1", "https://example.com/from-http");
  reconcileItem(database, LOCAL_LIBRARY_ID, "http-item");
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const list = await fetch(`${base}/api/reading?view=queue`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const body = (await list.json()) as {
      preparing: { count: number; preview: { canonicalUrl: string; title: string }[] };
      unread: { items: unknown[] };
    };
    assert.equal(body.preparing.count, 1);
    assert.equal(body.unread.items.length, 0);
    assert.equal(body.preparing.preview[0]?.canonicalUrl, "https://example.com/from-http");
    const missing = await fetch(`${base}/api/reading/missing-doc`, { headers: { cookie } });
    assert.equal(missing.status, 404);
  } finally {
    await app.close();
    database.close();
  }
});

test("overflow diagnostics increment for capped Items", () => {
  resetReadingDiagnostics();
  const db = mem();
  const urls = Array.from({ length: 21 }, (_, i) => `https://example.com/post-${String(i).padStart(2, "0")}`).join("\n");
  insertRawItem(db, "cap", "https://x.com/a/status/1", urls);
  reconcileItem(db, LOCAL_LIBRARY_ID, "cap");
  assert.equal(readingDiagnostics().exclusions.candidate_limit_exceeded, 1);
  assert.equal(queueDocs(db).preparing.count, 20);
  db.close();
});

function insertRawItem(db: ReturnType<typeof mem>, id: string, permalink: string, body?: string): void {
  const now = "2026-08-27T00:00:00.000Z";
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, `Item ${id}`, body ?? permalink, permalink, now, now, now);
}

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
