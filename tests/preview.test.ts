import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { allowsIframe, framePermission, isPrivateIp, linkPreview, parsePreview } from "../server/http/preview.ts";

const OG = `<!doctype html><html><head>
<title>Fallback &amp; Title</title>
<meta property="og:title" content="Why hosting Git is hard" />
<meta name="twitter:description" content="A war story &quot;with&quot; quotes" />
<meta content="https://blog.example.com/cover.png" property="og:image">
<meta property="og:site_name" content="vmg&#x27;s blog">
</head><body>ignored</body></html>`;

test("parsePreview reads og tags regardless of attribute order", () => {
  const p = parsePreview(OG, "https://blog.example.com/post/1");
  assert.equal(p.title, "Why hosting Git is hard");
  assert.equal(p.description, 'A war story "with" quotes');
  assert.equal(p.image, "https://blog.example.com/cover.png");
  assert.equal(p.siteName, "vmg's blog");
});

test("parsePreview falls back to <title> and resolves relative images", () => {
  const p = parsePreview(
    `<html><head><title>Plain page</title><meta name="twitter:image" content="/img.png"></head></html>`,
    "https://example.com/a/b",
  );
  assert.equal(p.title, "Plain page");
  assert.equal(p.image, "https://example.com/img.png");
});

test("parsePreview rejects non-http image URLs", () => {
  const p = parsePreview(`<meta property="og:image" content="javascript:alert(1)">`, "https://example.com/");
  assert.equal(p.image, null);
});

test("isPrivateIp blocks loopback, rfc1918, link-local, and v6", () => {
  for (const ip of ["127.0.0.1", "10.1.2.3", "192.168.1.1", "172.16.0.1", "169.254.1.1", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "0.0.0.0"]) {
    assert.ok(isPrivateIp(ip), ip);
  }
  for (const ip of ["8.8.8.8", "172.15.0.1", "192.167.1.1", "2606:4700::1"]) {
    assert.ok(!isPrivateIp(ip), ip);
  }
});

test("keepLink accepts article and quote urls, drops self and t.co", async () => {
  const { keepLink, needsEnrich, applyLinks } = await import("../server/enrich.ts");
  const self = "https://x.com/a/status/1";
  assert.equal(keepLink("https://lucumr.pocoo.org/p", self), true);
  assert.equal(keepLink("https://x.com/b/status/2", self), true);
  assert.equal(keepLink(self, self), false);
  assert.equal(keepLink("https://t.co/abc", self), false);
  assert.equal(needsEnrich({ url: self, body: "hi", published_at: null }), true);
  assert.equal(needsEnrich({ url: self, body: "hi\nhttps://lucumr.pocoo.org/p", published_at: "2026-01-01T00:00:00.000Z" }), false);
  assert.equal(applyLinks("hello", ["https://a.com"]), "hello\nhttps://a.com");
});

test("parseYtDate reads itemprop and json keys", async () => {
  const { parseYtDate, videoId } = await import("../server/enrich.ts");
  assert.equal(videoId("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoId("https://youtu.be/dQw4w9WgXcQ"), "dQw4w9WgXcQ");
  assert.equal(videoId("https://x.com/a/status/1"), null);
  assert.equal(parseYtDate(`<meta itemprop="datePublished" content="2024-03-15">`), "2024-03-15T00:00:00.000Z");
  assert.equal(parseYtDate(`<meta content="2024-03-15T12:00:00.000Z" itemprop="uploadDate">`), "2024-03-15T12:00:00.000Z");
  assert.equal(parseYtDate(`{"uploadDate":"2024-03-15"}`), "2024-03-15T00:00:00.000Z");
  assert.equal(parseYtDate("<html></html>"), null);
});

test("allowsIframe reads X-Frame-Options and CSP frame-ancestors", () => {
  assert.equal(allowsIframe("DENY", null), false);
  assert.equal(allowsIframe("SAMEORIGIN", null), false);
  assert.equal(allowsIframe(null, "default-src 'self'"), null);
  assert.equal(allowsIframe(null, "frame-ancestors *"), true);
  assert.equal(allowsIframe(null, "frame-ancestors 'none'"), false);
  assert.equal(allowsIframe(null, "frame-ancestors 'self' cursor.com *.cursor.com"), false);
  assert.equal(allowsIframe(null, "default-src 'self'; frame-ancestors http://127.0.0.1:8787"), true);
  assert.equal(
    allowsIframe(null, "script-src 'self'; frame-ancestors 'self' cursor.com *.cursor.com cursor.sh *.cursor.sh ; upgrade-insecure-requests"),
    false,
  );
});

test("framePermission treats successful unrestricted pages as frameable and rejects blocked responses", () => {
  assert.equal(framePermission(200, null, null), "yes");
  assert.equal(framePermission(200, "DENY", null), "no");
  assert.equal(framePermission(200, null, "frame-ancestors 'none'"), "no");
  assert.equal(framePermission(403, null, null), "no");
});

test("linkPreview caches an error for private targets and never fetches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "locus-"));
  const db = openDb(join(dir, "t.db"));
  const p = await linkPreview(db, "http://127.0.0.1:8787/api/items");
  assert.equal(p.status, "error");
  const row = db.prepare(`SELECT status FROM link_previews WHERE url = ?`).get("http://127.0.0.1:8787/api/items") as { status: string };
  assert.equal(row.status, "error");
});
