import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { validateContent } from "../server/reading/blocks.ts";
import { classifyFetchedPage } from "../server/reading/classify.ts";
import { extractPage, qualifiesAsReadable } from "../server/reading/extract.ts";
import {
  fetchReadingResource,
  pinnedAddress,
  ReadingFetchError,
  type ReadingTransport,
} from "../server/reading/fetch.ts";
import {
  LOCAL_LIBRARY_ID,
  getReadingDocument,
  listReadingDocuments,
  importReadingRecords,
  reconcileItem,
  removeReadingDocument,
} from "../server/reading/module.ts";
import {
  drainReadingWorker,
  enrichDocument,
  startReadingWorker,
  stopReadingWorker,
} from "../server/reading/worker.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_READING_ASSETS = mkdtempSync(join(tmpdir(), "locus-reading-assets-"));

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-reading-enrich-")), "t.db"));
}

function words(n: number): string {
  return Array.from({ length: n }, () => "word").join(" ");
}

function articleHtml(title: string, extra = "", n = 220): string {
  return `<!doctype html><html lang="en"><head>
    <title>${title}</title>
    <meta property="og:title" content="${title}">
    <meta property="og:site_name" content="Example">
    <link rel="canonical" href="https://example.com/essay">
  </head><body>
    <nav>ignore</nav>
    <article><h1>${title}</h1><p>${words(n)}</p>${extra}</article>
    <script>alert(1)</script>
  </body></html>`;
}

function transport(pages: Record<string, { status?: number; headers?: Record<string, string>; body?: string | Buffer; ips?: string[] }>): ReadingTransport & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    async resolve(hostname) {
      const hit = Object.values(pages).find((page) => page.ips)?.ips;
      if (hit) return { a: hit, aaaa: [] };
      if (hostname === "mixed.example") return { a: ["8.8.8.8", "10.0.0.1"], aaaa: [] };
      if (hostname === "private.example") return { a: ["192.168.1.8"], aaaa: [] };
      return { a: ["93.184.216.34"], aaaa: [] };
    },
    async request({ url }) {
      calls.push(url.toString());
      const page = pages[url.toString()] ?? pages[`${url.origin}${url.pathname}`];
      if (!page) return { status: 404, headers: { "content-type": "text/html" }, body: Buffer.from("missing") };
      return {
        status: page.status ?? 200,
        headers: { "content-type": "text/html; charset=utf-8", ...page.headers },
        body: Buffer.isBuffer(page.body) ? page.body : Buffer.from(page.body ?? ""),
      };
    },
  };
}

function insertItem(db: ReturnType<typeof mem>, id: string, body: string, permalink = "https://x.com/a/status/1"): void {
  const now = "2026-08-27T00:00:00.000Z";
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, `Item ${id}`, body, permalink, now, now, now);
}

function pendingDocs(db: ReturnType<typeof mem>): { id: string; canonicalUrl: string }[] {
  return listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", limit: 100 }).preparing.preview;
}

test("a long article still qualifies when publisher chrome adds many links", () => {
  const chrome = Array.from({ length: 40 }, (_, i) => `<a href="/related-${i}">more from the blog here</a>`).join(" ");
  const extracted = extractPage(articleHtml("Long essay", `<p>${chrome}</p>`), "https://example.com/essay", "fallback");
  assert.equal(extracted.hasArticle, true);
  assert.ok(extracted.wordCount >= 200);
  assert.ok(extracted.linkCount >= 10);
  assert.ok(qualifiesAsReadable(extracted));
});

test("parse5 mapping drops scripts, handlers, and javascript links", () => {
  const html = articleHtml(
    "Safe essay",
    `<p>See <a href="javascript:alert(1)">nope</a>, <a href="https://example.com/more">ok</a>, and <a href="/relative">relative</a>.</p>
     <img src="https://evil.example/x.png" onerror="alert(1)">
     <p onclick="alert(1)">${words(20)}</p>`,
  );
  const extracted = extractPage(html, "https://example.com/essay", "fallback");
  assert.equal(extracted.content?.version, 1);
  const json = JSON.stringify(extracted.content);
  assert.doesNotMatch(json, /javascript:/i);
  assert.doesNotMatch(json, /onerror|onclick|alert\(/i);
  assert.doesNotMatch(json, /<script/i);
  assert.match(json, /https:\/\/example\.com\/more/);
  assert.match(json, /https:\/\/example\.com\/relative/);
  assert.ok(extracted.content?.blocks.some((block) => block.type === "paragraph"));
  assert.ok(qualifiesAsReadable(extracted));
});

test("list items keep adjacent text and inline marks in one paragraph", () => {
  const extracted = extractPage(
    articleHtml("List essay", `<ol><li>The <code>normal</code> loop stays together.</li></ol>`),
    "https://example.com/essay",
    "fallback",
  );
  const list = extracted.content?.blocks.find((block) => block.type === "list");
  assert.ok(list?.type === "list");
  assert.equal(list.items[0]?.blocks.length, 1);
  const paragraph = list.items[0]?.blocks[0];
  assert.ok(paragraph?.type === "paragraph");
  assert.equal(paragraph.inlines.map((inline) => inline.text).join(""), "The normal loop stays together.");
  assert.deepEqual(paragraph.inlines[1]?.marks, [{ type: "code" }]);
});

test("block validator rejects unknown nodes, remote images, and unsafe marks", () => {
  assert.equal(validateContent({ version: 2, blocks: [] }), null);
  assert.equal(validateContent({ version: 1, blocks: [{ id: "1", type: "widget" }] }), null);
  assert.equal(
    validateContent({
      version: 1,
      blocks: [{ id: "1", type: "image", assetId: "https://evil.example/x.png", alt: "x", caption: null }],
    }),
    null,
  );
  assert.equal(
    validateContent({
      version: 1,
      blocks: [{ id: "1", type: "paragraph", inlines: [{ text: "x", marks: [{ type: "link", href: "javascript:alert(1)" }] }] }],
    }),
    null,
  );
  const ok = validateContent({
    version: 1,
    blocks: [{ id: "1-abc", type: "paragraph", inlines: [{ text: "Hello", marks: [{ type: "em" }] }] }],
  });
  assert.ok(ok);
});

test("challenge classifier needs a strong title/URL signal, not the word human", () => {
  const blocked = classifyFetchedPage({
    status: 200,
    finalUrl: "https://www.reddit.com/",
    contentType: "text/html",
    title: "Reddit - Prove your humanity.",
    text: "Verify you are human to continue",
    wordCount: 6,
    hasArticle: false,
    scriptCount: 12,
  });
  assert.equal(blocked.failure, "blocked_challenge");
  const essay = classifyFetchedPage({
    status: 200,
    finalUrl: "https://example.com/human",
    contentType: "text/html",
    title: "What it means to be human",
    text: words(220),
    wordCount: 220,
    hasArticle: true,
    scriptCount: 2,
  });
  assert.equal(essay.failure, null);
});

test("pinned transport rejects mixed public/private DNS and private redirects", async () => {
  await assert.rejects(
    () => pinnedAddress("mixed.example", transport({ "https://mixed.example/": { ips: ["8.8.8.8", "10.0.0.1"] } })),
    (error: unknown) => error instanceof ReadingFetchError && error.code === "unsafe_target",
  );
  const t = transport({
    "https://example.com/go": { status: 302, headers: { location: "https://private.example/secret" }, body: "" },
  });
  t.resolve = async (hostname) => {
    if (hostname === "private.example") return { a: ["127.0.0.1"], aaaa: [] };
    return { a: ["93.184.216.34"], aaaa: [] };
  };
  await assert.rejects(
    () => fetchReadingResource("https://example.com/go", { accept: "text/html", maxBytes: 1000, transport: t }),
    (error: unknown) => error instanceof ReadingFetchError && error.code === "unsafe_target",
  );
});

test("worker extracts a ready article and list stays database-only", async () => {
  const db = mem();
  const t = transport({
    "https://example.com/essay": { body: articleHtml("Fast hard code") },
  });
  insertItem(db, "item-1", "read https://example.com/essay");
  reconcileItem(db, LOCAL_LIBRARY_ID, "item-1");
  const before = t.calls.length;
  const listed = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(listed.preparing.count, 1);
  assert.equal(t.calls.length, before);
  assert.ok(!("contentBlocks" in (listed.preparing.preview[0] ?? {})));

  const id = listed.preparing.preview[0]!.id;
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport: t });
  const page = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" });
  assert.equal(page.unread.items.length, 1);
  assert.equal(page.unread.items[0]?.availability, "ready");
  assert.equal(page.unread.items[0]?.title, "Fast hard code");
  const detail = getReadingDocument(db, LOCAL_LIBRARY_ID, id);
  assert.equal(detail.contentBlocks?.version, 1);
  assert.ok((detail.contentBlocks?.blocks.length ?? 0) >= 1);
  assert.equal(detail.actions.retry, true);
  db.close();
});

test("challenge HTML 200 is blocked and never uses the challenge title", async () => {
  const db = mem();
  const t = transport({
    "https://news.example.com/humanity": {
      body: `<html><head><title>Reddit - Prove your humanity.</title></head><body>Verify you are human</body></html>`,
    },
  });
  insertItem(db, "bot", "https://news.example.com/humanity");
  reconcileItem(db, LOCAL_LIBRARY_ID, "bot");
  const id = listReadingDocuments(db, LOCAL_LIBRARY_ID).preparing.preview[0]!.id;
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport: t });
  const detail = getReadingDocument(db, LOCAL_LIBRARY_ID, id);
  assert.equal(detail.availability, "blocked");
  assert.equal(detail.failureCode, "blocked_challenge");
  assert.notEqual(detail.title, "Reddit - Prove your humanity.");
  assert.equal(detail.contentBlocks, null);
  assert.equal(detail.excerpt, null);
  assert.equal(detail.subtitle, null);
  db.close();
});

test("paywall preview is metadata-only; empty JS shell is not an article", async () => {
  const db = mem();
  const t = transport({
    "https://pay.example.com/a": {
      body: `<html><head><title>Subscribe to continue</title></head><body><p>Already a subscriber? ${words(10)}</p></body></html>`,
    },
    "https://spa.example.com/a": {
      body: `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script><p>Enable JavaScript to continue</p></body></html>`,
    },
  });
  insertItem(db, "pay", "https://pay.example.com/a");
  insertItem(db, "spa", "https://spa.example.com/a");
  reconcileItem(db, LOCAL_LIBRARY_ID, "pay");
  reconcileItem(db, LOCAL_LIBRARY_ID, "spa");
  const docs = pendingDocs(db);
  for (const doc of docs) await enrichDocument(db, LOCAL_LIBRARY_ID, doc.id, { transport: t });
  const pay = docs.find((d) => d.canonicalUrl.includes("pay.example"))!;
  const spa = docs.find((d) => d.canonicalUrl.includes("spa.example"))!;
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, pay.id).availability, "metadata_only");
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, pay.id).failureCode, "paywall_or_consent");
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, spa.id).contentBlocks, null);
  assert.notEqual(getReadingDocument(db, LOCAL_LIBRARY_ID, spa.id).availability, "ready");
  db.close();
});

test("failed refresh preserves a ready snapshot", async () => {
  const db = mem();
  const pages: Record<string, { status?: number; body?: string }> = {
    "https://example.com/essay": { body: articleHtml("Keep me") },
  };
  const t = transport(pages);
  insertItem(db, "keep", "https://example.com/essay");
  reconcileItem(db, LOCAL_LIBRARY_ID, "keep");
  const id = listReadingDocuments(db, LOCAL_LIBRARY_ID).preparing.preview[0]!.id;
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport: t });
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, id).availability, "ready");
  pages["https://example.com/essay"] = { status: 403, body: "<html><title>Log in to continue</title><body>no</body></html>" };
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport: t });
  const detail = getReadingDocument(db, LOCAL_LIBRARY_ID, id);
  assert.equal(detail.availability, "ready");
  assert.equal(detail.title, "Keep me");
  assert.ok(detail.contentBlocks);
  assert.equal(detail.originalStatus, "authentication_required");
  db.close();
});

test("HTTP 410 hides retry; 404 stays retryable", async () => {
  const db = mem();
  const t = transport({
    "https://gone.example.com/a": { status: 410, body: "gone" },
    "https://miss.example.com/a": { status: 404, body: "nope" },
  });
  insertItem(db, "g", "https://gone.example.com/a\nhttps://miss.example.com/a");
  reconcileItem(db, LOCAL_LIBRARY_ID, "g");
  const docs = pendingDocs(db);
  for (const doc of docs) await enrichDocument(db, LOCAL_LIBRARY_ID, doc.id, { transport: t });
  const gone = docs.find((d) => d.canonicalUrl.includes("gone.example"))!;
  const miss = docs.find((d) => d.canonicalUrl.includes("miss.example"))!;
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, gone.id).failureCode, "gone");
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, gone.id).actions.retry, false);
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, gone.id).actions.openOriginal, false);
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, miss.id).failureCode, "not_found");
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, miss.id).actions.retry, true);
  db.close();
});

test("same-site canonical alias is adopted; cross-site canonical is ignored", async () => {
  const db = mem();
  const t = transport({
    "https://www.example.com/essay": {
      body: `<!doctype html><html><head><title>Alias</title>
        <link rel="canonical" href="https://example.com/essay">
        </head><body><article><h1>Alias</h1><p>${words(220)}</p></article></body></html>`,
    },
    "https://blog.example.com/one": {
      body: `<!doctype html><html><head><title>Hostile</title>
        <link rel="canonical" href="https://evil.example/steal">
        </head><body><article><h1>Hostile</h1><p>${words(220)}</p></article></body></html>`,
    },
  });
  insertItem(db, "alias", "https://www.example.com/essay");
  insertItem(db, "hostile", "https://blog.example.com/one");
  reconcileItem(db, LOCAL_LIBRARY_ID, "alias");
  reconcileItem(db, LOCAL_LIBRARY_ID, "hostile");
  const docs = pendingDocs(db);
  for (const doc of docs) await enrichDocument(db, LOCAL_LIBRARY_ID, doc.id, { transport: t });
  const alias = docs.find((d) => d.canonicalUrl.includes("example.com/essay"))!;
  const hostile = docs.find((d) => d.canonicalUrl.includes("blog.example"))!;
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, alias.id).canonicalUrl, "https://example.com/essay");
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, hostile.id).canonicalUrl, "https://blog.example.com/one");
  db.close();
});

test("tombstone wins a canonical merge and is not revived", async () => {
  const db = mem();
  insertItem(db, "live", "https://example.com/essay");
  reconcileItem(db, LOCAL_LIBRARY_ID, "live");
  const live = pendingDocs(db).find((row) => row.canonicalUrl === "https://example.com/essay")!;
  const removal = removeReadingDocument(db, LOCAL_LIBRARY_ID, live.id);
  insertItem(db, "again", "https://www.example.com/essay");
  reconcileItem(db, LOCAL_LIBRARY_ID, "again");
  assert.equal(pendingDocs(db).length, 0);
  assert.throws(() => getReadingDocument(db, LOCAL_LIBRARY_ID, live.id), /document/);
  assert.equal(removal.undoToken.length > 0, true);
  db.close();
});

test("due-time timer fires without boot or finishSession", async () => {
  const db = mem();
  let calls = 0;
  const t: ReadingTransport = {
    async resolve() { return { a: ["93.184.216.34"], aaaa: [] }; },
    async request() {
      calls += 1;
      if (calls === 1) throw new ReadingFetchError("network_error", "temporary");
      return { status: 200, headers: { "content-type": "text/html" }, body: Buffer.from(articleHtml("Timed")) };
    },
  };
  insertItem(db, "timer", "https://example.com/essay");
  reconcileItem(db, LOCAL_LIBRARY_ID, "timer");
  const id = pendingDocs(db)[0]!.id;

  let now = Date.now();
  const timers: { at: number; fn: () => void }[] = [];
  const scheduler = {
    now: () => now,
    setTimeout(fn: () => void, ms: number) {
      const handle = { at: now + ms, fn };
      timers.push(handle);
      return handle;
    },
    clearTimeout(id: unknown) {
      const i = timers.indexOf(id as (typeof timers)[0]);
      if (i >= 0) timers.splice(i, 1);
    },
  };
  startReadingWorker(db, { transport: t, scheduler });
  await drainReadingWorker(db);
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, id).availability, "pending");
  assert.ok(timers.length >= 1);
  assert.equal(calls, 1);
  now = timers[0]!.at;
  const due = [...timers];
  timers.length = 0;
  for (const timer of due) timer.fn();
  await drainReadingWorker(db);
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, id).availability, "ready");
  stopReadingWorker(db);
  db.close();
});

test("local worker never claims another Library's pending document", async () => {
  const db = mem();
  importReadingRecords(db, {
    documents: [{
      kind: "readingDocument",
      id: "foreign-doc",
      canonicalUrl: "https://example.com/foreign",
      observedUrl: "https://example.com/foreign",
      kindName: "article",
      availability: "pending",
      originalStatus: "unknown",
      title: "Foreign",
      lastSavedAt: "2026-08-27T00:00:00.000Z",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    }],
    provenance: [],
    progress: [],
    itemIds: new Set(),
  }, "foreign");
  const foreign = listReadingDocuments(db, "foreign", { view: "queue" }).preparing.preview[0]!;
  const t = transport({});
  startReadingWorker(db, { transport: t, libraryId: LOCAL_LIBRARY_ID });
  await drainReadingWorker(db);
  assert.equal(getReadingDocument(db, "foreign", foreign.id).availability, "pending");
  assert.deepEqual(t.calls, []);
  stopReadingWorker(db);
  db.close();
});

test("HTTP retry uses injected transport and list still omits blocks", async () => {
  process.env.LOCUS_PORT = "8793";
  const { listen } = await import("../server/http/server.ts");
  const db = mem();
  const t = transport({ "https://example.com/from-http": { body: articleHtml("From HTTP") } });
  insertItem(db, "http-item", "https://example.com/from-http");
  reconcileItem(db, LOCAL_LIBRARY_ID, "http-item");
  const id = pendingDocs(db)[0]!.id;
  startReadingWorker(db, { transport: t });
  await drainReadingWorker(db);
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
    const session = (await sessionResponse.json()) as { csrf: string };
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const listCalls = t.calls.length;
    const list = await fetch(`${base}/api/reading?view=queue`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { preparing: { preview: { id: string }[] }; unread: { items: { contentBlocks?: unknown }[] } };
    assert.equal(t.calls.length, listCalls);
    assert.ok(body.unread.items.every((item) => item.contentBlocks === undefined));
    const retry = await fetch(`${base}/api/reading/${id}/retry`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", "x-csrf-token": session.csrf },
      body: "{}",
    });
    assert.equal(retry.status, 200);
    const payload = (await retry.json()) as { document: { availability: string; contentBlocks: { version: number } | null } };
    assert.equal(payload.document.availability, "ready");
    assert.equal(payload.document.contentBlocks?.version, 1);
    const missingAsset = await fetch(`${base}/api/reading/${id}/assets/missing`, { headers: { cookie } });
    assert.equal(missingAsset.status, 404);
  } finally {
    stopReadingWorker(db);
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

test("a failed display fragment merges only after the complete URL succeeds", async () => {
  const db = mem();
  insertItem(db, "fragment", "https://example.com/some-arti https://example.com/some-article-here");
  reconcileItem(db, LOCAL_LIBRARY_ID, "fragment");
  assert.equal(pendingDocs(db).length, 2);
  const t = transport({
    "https://example.com/some-arti": { status: 404, body: "missing" },
    "https://example.com/some-article-here": { body: articleHtml("Complete essay") },
  });
  const ids = pendingDocs(db).sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl));
  for (const row of ids) await enrichDocument(db, LOCAL_LIBRARY_ID, row.id, { transport: t });
  const docs = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", limit: 100 }).unread.items;
  assert.equal(docs.length, 1);
  assert.equal(docs[0]?.canonicalUrl, "https://example.com/some-article-here");
  assert.equal(docs[0]?.availability, "ready");
  assert.equal(docs[0]?.savedCount, 1);
  db.close();
});

test("failed path prefixes from different Items never merge", async () => {
  const db = mem();
  insertItem(db, "short", "https://unknown.example/some-arti", "https://x.com/a/status/1");
  insertItem(db, "long", "https://unknown.example/some-article-here", "https://x.com/a/status/2");
  reconcileItem(db, LOCAL_LIBRARY_ID, "short");
  reconcileItem(db, LOCAL_LIBRARY_ID, "long");
  const t = transport({
    "https://unknown.example/some-arti": { status: 404, body: "missing" },
    "https://unknown.example/some-article-here": { body: articleHtml("Independent essay") },
  });
  const rows = pendingDocs(db).sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl));
  for (const row of rows) await enrichDocument(db, LOCAL_LIBRARY_ID, row.id, { transport: t });
  const docs = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue", limit: 100 });
  assert.equal(docs.unread.items.length, 1);
  assert.equal(docs.unread.items[0]?.canonicalUrl, "https://unknown.example/some-article-here");
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, rows[1]!.id).provenance.length, 1);
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, rows[0]!.id).failureCode, "not_found");
  db.close();
});

test("PDF candidates honor HTTP failures before metadata-only classification", async () => {
  const db = mem();
  importReadingRecords(db, {
    documents: [{
      kind: "readingDocument",
      id: "pdf-gone",
      canonicalUrl: "https://docs.example.com/file.pdf",
      observedUrl: "https://docs.example.com/file.pdf",
      kindName: "pdf",
      availability: "pending",
      originalStatus: "unknown",
      title: "PDF",
      lastSavedAt: "2026-08-27T00:00:00.000Z",
      createdAt: "2026-08-27T00:00:00.000Z",
      updatedAt: "2026-08-27T00:00:00.000Z",
    }],
    provenance: [],
    progress: [],
    itemIds: new Set(),
  });
  const id = pendingDocs(db)[0]!.id;
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, {
    transport: transport({
      "https://docs.example.com/file.pdf": {
        status: 410,
        headers: { "content-type": "application/pdf" },
        body: "gone",
      },
    }),
  });
  const detail = getReadingDocument(db, LOCAL_LIBRARY_ID, id);
  assert.equal(detail.failureCode, "gone");
  assert.equal(detail.originalStatus, "gone");
  assert.equal(detail.actions.openOriginal, false);
  assert.equal(detail.actions.retry, false);
  db.close();
});

test("navigation-dominated catalog HTML and absent MIME do not become ready", async () => {
  const db = mem();
  insertItem(db, "catalog", "https://shop.example.com/catalog https://shop.example.com/no-mime");
  reconcileItem(db, LOCAL_LIBRARY_ID, "catalog");
  const rows = pendingDocs(db).sort((a, b) => a.canonicalUrl.localeCompare(b.canonicalUrl));
  const links = Array.from({ length: 100 }, (_, i) => `<a href="/p/${i}">${words(5)}</a>`).join("");
  const t = transport({
    "https://shop.example.com/catalog": { body: `<html><head><title>Catalog</title></head><body><main>${links}</main></body></html>` },
    "https://shop.example.com/no-mime": { headers: { "content-type": "" }, body: articleHtml("No MIME") },
  });
  for (const row of rows) await enrichDocument(db, LOCAL_LIBRARY_ID, row.id, { transport: t });
  const details = rows.map((row) => getReadingDocument(db, LOCAL_LIBRARY_ID, row.id));
  assert.deepEqual(details.map((detail) => detail.availability), ["unsupported", "unsupported"]);
  assert.deepEqual(details.map((detail) => detail.failureCode), ["not_article_like", "unsupported_content_type"]);
  db.close();
});

test("transient network errors retry three times then become error", async () => {
  const db = mem();
  insertItem(db, "dns", "https://gone.example/essay");
  reconcileItem(db, LOCAL_LIBRARY_ID, "dns");
  const id = pendingDocs(db)[0]!.id;
  let attempts = 0;
  const t: ReadingTransport = {
    async resolve() {
      attempts += 1;
      throw new ReadingFetchError("network_error", "dns failed");
    },
    async request() {
      throw new ReadingFetchError("network_error", "dns failed");
    },
  };
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport: t });
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, id).availability, "pending");
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport: t });
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport: t });
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, id).availability, "pending");
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, { transport: t });
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, id).availability, "error");
  assert.equal(attempts, 4);
  db.close();
});

test("drain does not wait out leftover backoff after the retry cap", async () => {
  const db = mem();
  insertItem(db, "old", "https://gone.example/essay");
  reconcileItem(db, LOCAL_LIBRARY_ID, "old");
  const id = pendingDocs(db)[0]!.id;
  // Worker-state fixture: attempt_count/next_attempt_at are deliberately not
  // part of the Reading module interface; seed an over-cap pending lease to
  // exercise pull-forward behavior through drainReadingWorker below.
  db.prepare(
    `UPDATE reading_documents SET availability = 'pending', failure_code = 'network_error',
       attempt_count = 12, next_attempt_at = ? WHERE id = ?`,
  ).run("2026-08-28T21:00:00.000Z", id);
  let attempts = 0;
  const t: ReadingTransport = {
    async resolve() {
      attempts += 1;
      throw new ReadingFetchError("network_error", "dns failed");
    },
    async request() {
      throw new ReadingFetchError("network_error", "dns failed");
    },
  };
  startReadingWorker(db, { transport: t });
  await drainReadingWorker(db);
  assert.equal(getReadingDocument(db, LOCAL_LIBRARY_ID, id).availability, "error");
  assert.equal(attempts, 1);
  stopReadingWorker(db);
  db.close();
});
