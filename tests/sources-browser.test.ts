import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { openDb, type Db } from "../db/open.ts";
import { heartbeat, resetJobsForTest } from "../server/capture/jobs.ts";
import { markDone, markRunning, setProgress } from "../runner/index.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8824";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

test.describe("account capture setup", { concurrency: false }, () => {
  test("Account page renders one connection per Source for mixed live, pending, and imported rows", async () => {
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-browser-")), "t.db"));
    seedScreenshotMix(database);
    database.prepare(
      `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("reddit-imported-2", "reddit", "reddit-export-2", "u/imported-2", "2026-08-30T00:00:00Z", "imported");
    const { listen } = await import("../server/http/server.ts");
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (/^https?:/.test(url) && !url.startsWith(base)) {
          void request.abort();
          return;
        }
        void request.continue();
      });
      await page.goto(`${base}/#/account`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.querySelectorAll(".source-card").length === 4, { timeout: 5000 });

      const cards = await readCards(page);
      assert.deepEqual(
        cards.map((card) => card.source),
        ["src-x", "src-instagram", "src-youtube", "src-reddit"],
      );
      assert.equal(cards[0]!.handle, "@abhigyan898");
      assert.equal(cards[1]!.handle, "abhigyan.k");
      assert.equal(cards[0]!.status, "Connected");
      assert.match(cards[0]!.text, /Last captured 20 Aug 2026/);
      assert.equal(cards[0]!.primary, "Capture now");
      assert.match(cards[0]!.text, /Disconnect/);
      assert.equal(cards[1]!.status, "Connected");
      assert.equal(cards[1]!.primary, "Capture now");
      assert.equal(cards[2]!.status, "Connecting");
      assert.equal(cards[2]!.handle, "");
      assert.equal(cards[2]!.primary, "Continue setup");
      assert.match(cards[2]!.text, /Cancel setup/);
      assert.equal(cards[3]!.status, "Not connected");
      assert.equal(cards[3]!.handle, "");
      assert.equal(cards[3]!.primary, "Connect");
      assert.equal(cards.some((card) => card.status === "Imported"), false);
      assert.equal(cards.some((card) => card.text.includes("Pair extension")), false);
      assert.equal(cards.some((card) => card.text.includes("Import history")), false);
      assert.equal(cards.some((card) => card.text.includes("Capture new saves")), false);
      assert.equal(cards.some((card) => card.text.includes("Writing tools")), false);

      assert.equal(await page.$eval("h1", (el) => el.textContent?.trim()), "Account");
      assert.deepEqual(
        await page.$$eval("h2", (els) => els.map((el) => el.textContent?.trim())),
        ["Account", "Capture setup", "Preferences", "Data and privacy"],
      );
      assert.equal(await page.$eval(".tabs a[aria-current='page']", (el) => el.textContent?.trim()), "Account");
      const local = await page.$eval("#local-account", (el) => ({
        title: el.querySelector("h3")?.textContent ?? "",
        text: el.textContent ?? "",
        images: el.querySelectorAll("img").length,
      }));
      assert.equal(local.title, "Local account");
      assert.match(local.text, /Your Library is stored on this device/);
      assert.equal(local.images, 0);
      assert.equal(await page.$eval("#preferences", (el) => el.textContent?.includes("Capture new saves when Locus opens") ?? false), true);
      assert.ok(await page.$("#data-and-privacy .account-danger .btn.danger"));
      assert.equal(await page.$eval("#import-source-exports", (el) => (el as HTMLDetailsElement).open), false);

      const history = await page.$eval("#import-history", (el) => ({
        heading: el.querySelector("h3")?.textContent ?? "",
        items: [...el.querySelectorAll("li")].map((item) => item.textContent ?? ""),
        cards: el.querySelectorAll(".source-card").length,
      }));
      assert.equal(history.heading, "Import history");
      assert.equal(history.cards, 0);
      assert.deepEqual(history.items, [
        "Reddit export · 0 Items · 30 Aug 2026",
        "Reddit export · 0 Items · 6 Aug 2026",
        "Instagram export · 0 Items · 4 Aug 2026",
        "X export · 0 Items · 2 Aug 2026",
      ]);

      const pairing = await page.$eval("#extension-setup", (el) => ({
        status: el.querySelector("[role='status']")?.textContent ?? "",
        primary: el.querySelector(".btn.primary")?.textContent?.trim() ?? "",
      }));
      assert.equal(pairing.status, "Not paired");
      assert.equal(pairing.primary, "Pair extension");
      assert.equal(await page.$$eval("#extension-setup", (els) => els.length), 1);

      await page.click("#extension-setup .btn.primary");
      await page.waitForSelector("#pairing-code", { timeout: 5000 });
      assert.equal(await page.$eval("label[for='pairing-code']", (el) => el.textContent?.trim()), "Pairing code");
      await contextGrant(page, base);
      await page.click("#copy-pairing-code");
      await page.waitForFunction(() => [...document.querySelectorAll("[role='status']")].some((el) => el.textContent === "Copied pairing code."), { timeout: 5000 });

      heartbeat();
      await page.waitForFunction(() => {
        const panel = document.querySelector("#extension-setup");
        const status = panel?.querySelector("[role='status']")?.textContent ?? "";
        const lastSeen = panel?.textContent ?? "";
        const secondary = [...panel?.querySelectorAll("button") ?? []].some((el) => el.textContent?.trim() === "Pair another browser" && !el.classList.contains("primary"));
        return status === "Paired" && /Last seen /.test(lastSeen) && secondary;
      }, { timeout: 5000 });
      await page.evaluate(() => {
        const btn = [...document.querySelectorAll("#extension-setup button")].find((el) => el.textContent?.trim() === "Pair another browser");
        if (btn instanceof HTMLButtonElement) btn.click();
      });
      await page.waitForSelector("#pairing-code", { timeout: 5000 });
      assert.equal(await page.$eval("label[for='pairing-code']", (el) => el.textContent?.trim()), "Pairing code");
    } finally {
      await browser.close();
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("each Source shows capturing or needs-attention actions from live capture state", async () => {
    process.env.LOCUS_PORT = "8827";
    resetJobsForTest();
    heartbeat(Date.now() - 60_000);
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-states-")), "t.db"));
    seedScreenshotMix(database);
    database
      .prepare(`INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES (?, ?, 'saved', 'Saved', ?)`)
      .run("ig-live-col", "ig-live", "2026-08-01T00:00:00Z");
    database
      .prepare(
        `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status) VALUES (?, ?, 'test', '1', ?, ?, 'complete', 'complete')`,
      )
      .run("ig-success-run", "ig-live-col", "2026-08-10T00:00:00Z", "2026-08-10T00:01:00Z");
    database
      .prepare(
        `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status, error_code) VALUES (?, ?, 'test', '1', ?, ?, 'partial', 'error', 'logged-out')`,
      )
      .run("ig-fail-run", "ig-live-col", "2026-08-21T00:00:00Z", "2026-08-21T00:01:00Z");
    markRunning("x", "x-live");
    setProgress("x", "x-live", { phase: "capturing", message: "Reading bookmarks…", seen: 4 });
    const { listen } = await import("../server/http/server.ts");
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (/^https?:/.test(url) && !url.startsWith(base)) {
          void request.abort();
          return;
        }
        void request.continue();
      });
      await page.goto(`${base}/#/account`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.querySelectorAll(".source-card").length === 4, { timeout: 5000 });
      const cards = await readCards(page);
      assert.equal(cards[0]!.status, "Capturing");
      assert.equal(cards[0]!.handle, "@abhigyan898");
      assert.equal(cards[0]!.primary, "View progress");
      assert.match(cards[0]!.text, /Stop capture/);
      assert.match(cards[0]!.text, /Reading bookmarks/);
      assert.match(cards[0]!.text, /Last captured 20 Aug 2026/);
      assert.equal(cards[1]!.status, "Needs attention");
      assert.equal(cards[1]!.handle, "abhigyan.k");
      assert.equal(cards[1]!.primary, "Resolve issue");
      assert.match(cards[1]!.text, /Disconnect/);
      assert.match(cards[1]!.text, /Log in to continue/);
      assert.match(cards[1]!.text, /Last captured 10 Aug 2026/);
      assert.equal(cards[1]!.text.includes("Last captured 21 Aug 2026"), false);
      const extension = await page.$eval("#extension-setup", (el) => ({
        status: el.querySelector("[role='status']")?.textContent ?? "",
        text: el.textContent ?? "",
        primary: el.querySelector(".btn.primary")?.textContent?.trim() ?? "",
      }));
      assert.equal(extension.status, "Needs attention");
      assert.match(extension.text, /Last seen /);
      assert.equal(extension.primary, "Pair another browser");
    } finally {
      markDone("x", "x-live");
      await browser.close();
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("successful partial capture shows last captured and the discovered handle", async () => {
    process.env.LOCUS_PORT = "8829";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-partial-ui-")), "t.db"));
    database.prepare(
      `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("x-live", "x", "abhigyan898", "X", "2026-08-01T00:00:00Z", "live");
    database.prepare(
      `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run("ig-live", "instagram", "abhigyan.k", "Instagram", "2026-08-01T00:00:00Z", "live");
    database.prepare(`INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES (?, ?, 'bookmarks', 'Bookmarks', ?)`).run("x-live-col", "x-live", "2026-08-01T00:00:00Z");
    database.prepare(`INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES (?, ?, 'saved', 'Saved', ?)`).run("ig-live-col", "ig-live", "2026-08-01T00:00:00Z");
    database
      .prepare(
        `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status) VALUES (?, ?, 'locus.extension', '1', ?, ?, 'partial', 'ok')`,
      )
      .run("x-partial", "x-live-col", "2026-08-20T00:00:00Z", "2026-08-20T00:01:00Z");
    database
      .prepare(
        `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status) VALUES (?, ?, 'locus.extension', '1', ?, ?, 'partial', 'ok')`,
      )
      .run("ig-partial", "ig-live-col", "2026-08-10T00:00:00Z", "2026-08-10T00:01:00Z");
    database
      .prepare(
        `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status, error_code) VALUES (?, ?, 'locus.extension', '1', ?, ?, 'partial', 'error', 'logged-out')`,
      )
      .run("ig-fail", "ig-live-col", "2026-08-21T00:00:00Z", "2026-08-21T00:01:00Z");
    const { listen } = await import("../server/http/server.ts");
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (/^https?:/.test(url) && !url.startsWith(base)) {
          void request.abort();
          return;
        }
        void request.continue();
      });
      await page.goto(`${base}/#/account`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.querySelectorAll(".source-card").length === 4, { timeout: 5000 });
      const cards = await readCards(page);
      assert.equal(cards[0]!.status, "Connected");
      assert.equal(cards[0]!.handle, "abhigyan898");
      assert.match(cards[0]!.text, /Last captured 20 Aug 2026/);
      assert.equal(cards[1]!.status, "Needs attention");
      assert.equal(cards[1]!.handle, "abhigyan.k");
      assert.match(cards[1]!.text, /Last captured 10 Aug 2026/);
      assert.match(cards[1]!.text, /Log in to continue/);
      assert.equal(cards[1]!.text.includes("Last captured 21 Aug 2026"), false);
    } finally {
      await browser.close();
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });

  test("empty Import history is omitted, import forms stay collapsed, and the page holds at 320", async () => {
    process.env.LOCUS_PORT = "8828";
    resetJobsForTest();
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-sources-empty-ui-")), "t.db"));
    const { listen } = await import("../server/http/server.ts");
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
    try {
      const page = await browser.newPage();
      await page.setRequestInterception(true);
      page.on("request", (request) => {
        const url = request.url();
        if (/^https?:/.test(url) && !url.startsWith(base)) {
          void request.abort();
          return;
        }
        void request.continue();
      });
      await page.goto(`${base}/#/account`, { waitUntil: "networkidle0" });
      await page.waitForFunction(() => document.querySelectorAll(".source-card").length === 4, { timeout: 5000 });
      assert.equal(await page.$("#import-history"), null);
      assert.equal(await page.$eval("#import-source-exports", (el) => (el as HTMLDetailsElement).open), false);
      await page.focus("#import-source-exports > summary");
      await page.keyboard.press("Enter");
      assert.equal(await page.$eval("#import-source-exports", (el) => (el as HTMLDetailsElement).open), true);
      await page.setViewport({ width: 320, height: 800 });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
        true,
        "no overflow at 320px",
      );
      await page.setViewport({ width: 1280, height: 800 });
      await page.evaluate(() => {
        document.documentElement.style.zoom = "2";
      });
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
        true,
        "no overflow at 200% zoom",
      );
    } finally {
      await browser.close();
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });
});

async function readCards(page: Page) {
  return page.$$eval(".source-card", (els) =>
    els.map((el) => ({
      source: [...el.classList].find((name) => name.startsWith("src-")) ?? "",
      text: el.textContent ?? "",
      status: el.querySelector(".source-state")?.textContent ?? "",
      handle: el.querySelector(".source-handle")?.textContent ?? "",
      primary: el.querySelector(".btn.primary")?.textContent?.trim() ?? "",
    })),
  );
}

async function contextGrant(page: Page, origin: string): Promise<void> {
  const context = page.browser().defaultBrowserContext();
  await context.overridePermissions(origin, ["clipboard-read", "clipboard-write"]);
}

function seedScreenshotMix(database: Db): void {
  const insert = database.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at, account_kind) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  insert.run("x-live", "x", "abhigyan898", "@abhigyan898", "2026-08-01T00:00:00Z", "live");
  insert.run("x-imported", "x", "abhigyan898-export", "@abhigyan898", "2026-08-02T00:00:00Z", "imported");
  insert.run("x-pending", "x", "pending:x-pending", "X", "2026-08-03T00:00:00Z", "live");
  insert.run("ig-live", "instagram", "abhigyan.k", "abhigyan.k", "2026-08-01T00:00:00Z", "live");
  insert.run("ig-imported", "instagram", "ig-export", "abhigyan.k", "2026-08-04T00:00:00Z", "imported");
  insert.run("yt-pending", "youtube", "pending:yt-pending", "YouTube", "2026-08-05T00:00:00Z", "live");
  insert.run("reddit-imported", "reddit", "reddit-export", "u/imported", "2026-08-06T00:00:00Z", "imported");
  database
    .prepare(`INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES (?, ?, 'bookmarks', 'Bookmarks', ?)`)
    .run("x-live-col", "x-live", "2026-08-01T00:00:00Z");
  database
    .prepare(
      `INSERT INTO capture_runs (id, source_collection_id, producer_id, producer_version, started_at, finished_at, coverage, status) VALUES (?, ?, 'test', '1', ?, ?, 'complete', 'complete')`,
    )
    .run("x-live-run", "x-live-col", "2026-08-20T00:00:00Z", "2026-08-20T00:01:00Z");
}
