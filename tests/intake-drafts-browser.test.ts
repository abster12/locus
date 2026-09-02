import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createCollection } from "../core/commands.ts";
import { listItems, listTags } from "../core/library.ts";
import { CHROME, launchBrowser, startServer, tempDb, trackTraffic } from "./trips-browser-harness.ts";
import type { Page } from "puppeteer-core";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8851";

type ExecutableTool = { name: string; execute: (input: unknown) => unknown };

type WebmcpWindow = {
  __locusIntakeTools?: Map<string, ExecutableTool>;
};

const FAKE_WEBMCP_RUNTIME = `
  const tracked = new Set(["create_items", "get_library_intake_context", "present_item_drafts", "search_library"]);
  const tools = new Map();
  window.__locusIntakeTools = tools;
  Object.defineProperty(document, "modelContext", {
    value: {
      registerTool(tool, options = {}) {
        if (tracked.has(tool.name)) tools.set(tool.name, tool);
        const remove = () => { if (tracked.has(tool.name)) tools.delete(tool.name); };
        if (options.signal?.aborted) remove();
        else options.signal?.addEventListener("abort", remove, { once: true });
        return Promise.resolve();
      },
    },
    configurable: true,
  });
`;

async function invokeTool(page: Page, name: string, input: unknown): Promise<Record<string, unknown>> {
  return (await page.evaluate(
    async (toolName: string, toolInput: unknown) => {
      const w = window as unknown as WebmcpWindow & { __locusIntakeTools: Map<string, ExecutableTool> };
      const tool = w.__locusIntakeTools.get(toolName);
      if (!tool) throw new Error(`missing tool: ${toolName}`);
      return (await tool.execute(toolInput)) as Record<string, unknown>;
    },
    name,
    input,
  )) as Record<string, unknown>;
}

test("exploratory sheet saves a subset, confirms a new tag, and leaves rejected drafts unsaved", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const db = tempDb("locus-intake-drafts-");
  const collection = createCollection(db, "Research", "Deep reading");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-tech', 'tech', '#333')`).run();
  const app = await startServer(db);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const { writes } = trackTraffic(page, base);
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);
    await page.goto(`${base}/#/recent`, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusIntakeTools?.size ?? 0) === 4,
    );

    const presented = await invokeTool(page, "present_item_drafts", {
      drafts: [
        { url: "https://example.com/skip-me", title: "Skip me" },
        {
          url: "https://example.com/keep-me",
          title: "Keep me",
          collectionIds: [collection.id],
          tagIds: ["tag-tech"],
          proposedNewTags: ["Local First"],
          rationale: "About local-first software",
          evidenceBasis: "title",
          uncertainty: "Author unknown",
        },
      ],
    });
    assert.equal(presented.ok, true);
    assert.equal(presented.persisted, false);
    await page.waitForSelector("dialog.intake-drafts[open]", { timeout: 5000 });
    await page.waitForSelector("button[name='saveSelected']:not([disabled])", { timeout: 5000 });
    const panelText = await page.$eval("dialog.intake-drafts", (el) => el.textContent ?? "");
    assert.match(panelText, /Keep me/);
    assert.match(panelText, /Skip me/);
    assert.match(panelText, /proposed new tag, not saved/);
    assert.match(panelText, /Author unknown/);

    const includes = await page.$$("input[name='includeDraft']");
    assert.equal(includes.length, 2);
    await includes[0]?.click();

    await page.click("button[name='confirmTag']");
    await page.waitForFunction(
      () => !document.body.textContent?.includes("proposed new tag, not saved"),
      { timeout: 5000 },
    );
    assert.equal(listTags(db).some((tag) => tag.name === "Local First"), true);

    await page.click("button[name='saveSelected']");
    await page.waitForFunction(() => !document.querySelector("dialog.intake-drafts[open]"), { timeout: 5000 });
    await page.waitForFunction(() => document.body.innerText.includes("Keep me"), { timeout: 5000 });
    assert.deepEqual(listItems(db).map((item) => item.url).sort(), ["https://example.com/keep-me"]);
    assert.match(await page.evaluate(() => document.body.innerText), /Added by agent/i);
    assert.ok(writes.some((entry) => entry === "POST /api/intake/tags"));
    assert.ok(writes.some((entry) => entry === "POST /api/intake/drafts/save"));
    assert.equal(writes.filter((entry) => entry === "POST /api/intake/batch").length, 0);
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});

test("sheet save uses the presented context and keeps selections after taxonomy change", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const db = tempDb("locus-intake-drafts-stale-");
  const collection = createCollection(db, "Research", "Deep reading");
  db.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-tech', 'tech', '#333')`).run();
  const app = await startServer(db);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);
    await page.goto(`${base}/#/recent`, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusIntakeTools?.size ?? 0) === 4,
    );
    await invokeTool(page, "present_item_drafts", {
      drafts: [{
        url: "https://example.com/keep-me",
        title: "Keep me",
        collectionIds: [collection.id],
        tagIds: ["tag-tech"],
      }],
    });
    await page.waitForSelector("dialog.intake-drafts[open]", { timeout: 5000 });
    await page.waitForSelector("button[name='saveSelected']:not([disabled])", { timeout: 5000 });
    assert.equal(await page.$eval("input[name='tagIds'][value='tag-tech']", (el) => (el as HTMLInputElement).checked), true);
    db.prepare(`DELETE FROM tags WHERE id = 'tag-tech'`).run();
    await page.click("button[name='saveSelected']");
    await page.waitForSelector("dialog.intake-drafts [role='alert']", { timeout: 5000 });
    assert.match(await page.$eval("[role='alert']", (el) => el.textContent ?? ""), /Tags or Collections changed/);
    const gone = await page.$eval("label.save-choice:has(input[name='tagIds'][value='tag-tech'])", (el) => ({
      checked: (el.querySelector("input") as HTMLInputElement).checked,
      text: el.textContent ?? "",
    }));
    assert.equal(gone.checked, true);
    assert.match(gone.text, /no longer available/i);
    assert.equal(await page.$eval("button[name='saveSelected']", (el) => (el as HTMLButtonElement).disabled), true);
    await page.click("input[name='tagIds'][value='tag-tech']");
    await page.waitForSelector("button[name='saveSelected']:not([disabled])", { timeout: 5000 });
    await page.click("button[name='saveSelected']");
    await page.waitForFunction(() => !document.querySelector("dialog.intake-drafts[open]"), { timeout: 5000 });
    assert.deepEqual(listItems(db).map((item) => item.url), ["https://example.com/keep-me"]);
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});
