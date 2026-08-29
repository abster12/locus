import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { openDb } from "../db/open.ts";
import { LOCAL_LIBRARY_ID, listReadingDocuments, reconcileItem } from "../server/reading/module.ts";
import { enrichDocument, startReadingWorker, stopReadingWorker } from "../server/reading/worker.ts";
import type { ReadingTransport } from "../server/reading/fetch.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8798";
process.env.LOCUS_READING_ASSETS = mkdtempSync(join(tmpdir(), "locus-browser-assets-"));

test("seeded reading index and reader routes make no external fetches", async () => {
  const { listen } = await import("../server/http/server.ts");
  const db = openDb(join(mkdtempSync(join(tmpdir(), "locus-browser-")), "t.db"));
  const now = "2026-08-27T00:00:00.000Z";
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES ('item-1', 'post', 'Saved', 'https://example.com/essay', 'https://x.com/a/status/1', ?, '[]', ?, ?)`,
  ).run(now, now, now);
  reconcileItem(db, LOCAL_LIBRARY_ID, "item-1");
  const id = listReadingDocuments(db, LOCAL_LIBRARY_ID, { view: "queue" }).preparing.preview[0]!.id;
  await enrichDocument(db, LOCAL_LIBRARY_ID, id, {
    transport: {
      async resolve() { return { a: ["93.184.216.34"], aaaa: [] }; },
      async request() {
        return {
          status: 200,
          headers: { "content-type": "text/html" },
          body: Buffer.from("<html><head><title>Saved essay</title></head><body><article><p>Hello article " + "word ".repeat(220) + "</p></article></body></html>"),
        };
      },
    },
  });
  const calls: string[] = [];
  const transport: ReadingTransport = {
    async resolve(hostname) {
      calls.push(`dns:${hostname}`);
      throw new Error("external dns denied");
    },
    async request({ url }) {
      calls.push(`http:${url}`);
      throw new Error("external http denied");
    },
  };
  startReadingWorker(db, { transport });
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  try {
    const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
    const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
    assert.ok(cookie);
    const list = await fetch(`${base}/api/reading?view=queue`, { headers: { cookie } });
    assert.equal(list.status, 200);
    const body = (await list.json()) as { unread: { items: { id: string }[] } };
    const detail = await fetch(`${base}/api/reading/${id}`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const page = await fetch(`${base}/`, { headers: { cookie } });
    assert.ok(page.status === 200 || page.status === 502);
    assert.deepEqual(calls, []);
    assert.ok(body.unread.items.length >= 1);

    const browser = await puppeteer.launch({
      executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const browserPage = await browser.newPage();
      await browserPage.setViewport({ width: 320, height: 800, deviceScaleFactor: 1 });
      const external: string[] = [];
      browserPage.on("request", (request) => {
        if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) external.push(request.url());
      });
      await browserPage.goto(`${base}/#/reading`, { waitUntil: "networkidle0" });
      await browserPage.waitForSelector("h1");
      assert.equal(await browserPage.$eval("h1", (element) => element.textContent), "Reading");
      assert.equal(
        await browserPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
        true,
      );
      await browserPage.waitForSelector("a.reading-open");
      const title = await browserPage.$eval("a.reading-open", (element) => ({
        href: (element as HTMLAnchorElement).href,
        target: (element as HTMLAnchorElement).target,
      }));
      assert.equal(title.target, "_blank");
      assert.match(title.href, /^https:\/\/example\.com\/essay/);
      assert.ok(await browserPage.$("button"));
      assert.deepEqual(external, []);
      assert.deepEqual(calls, []);
    } finally {
      await browser.close();
    }
  } finally {
    stopReadingWorker(db);
    await app.close();
    db.close();
  }
});

test("reading CSS and markup cover overflow, reduced motion, and landmarks", () => {
  const css = readFileSync(new URL("../app/src/styles.css", import.meta.url), "utf8");
  const page = readFileSync(new URL("../app/src/ReadingPage.tsx", import.meta.url), "utf8");
  assert.match(css, /overflow-x:\s*hidden/);
  assert.match(css, /@media \(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /min-height:\s*44px/);
  assert.match(page, /useLayoutEffect/);
  assert.match(page, /<h1>Reading<\/h1>/);
  assert.match(page, /Open original in a new tab/);
  assert.doesNotMatch(page, /ReadingReader/);
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
