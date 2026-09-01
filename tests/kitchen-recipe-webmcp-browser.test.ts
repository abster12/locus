import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";
import { captionRevision } from "../server/kitchen/module.ts";

// Browser proof for the Recipe Document WebMCP slice: exactly two tools on the
// visible Kitchen detail route, a grounded caption-backed proposal that lands
// as a Draft and refreshes the visible recipe score, strict input bounds, and
// clean cleanup/re-registration across route changes. The fake WebMCP runtime
// is injected before any page script runs; Locus itself never ships a runtime.
process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8811";

const TS = "2026-08-29T12:00:00.000Z";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type ExecutableTool = { name: string; execute: (input: unknown) => unknown };

type WebmcpWindow = {
  __locusKitchenTools?: Map<string, ExecutableTool>;
  __locusKitchenRegsState?: { count: number };
};

// The fake runtime is injected as a source string on purpose: the TS build
// wraps named functions from this file in a __name() helper that only exists
// at module scope, so a serialized function callback would crash in the page.
const FAKE_WEBMCP_RUNTIME = `
  const tools = new Map();
  const regs = { count: 0 };
  window.__locusKitchenTools = tools;
  window.__locusKitchenRegsState = regs;
  Object.defineProperty(document, "modelContext", {
    value: {
      registerTool(tool, options = {}) {
        regs.count += 1;
        tools.set(tool.name, tool);
        const remove = () => tools.delete(tool.name);
        if (options.signal?.aborted) remove();
        else options.signal?.addEventListener("abort", remove, { once: true });
        return Promise.resolve();
      },
    },
    configurable: true,
  });
`;

const CAPTION = "200 g paneer\r\nGrill it";
const NORMALIZED_CAPTION = "200 g paneer\nGrill it";
const EXPECTED_REVISION = captionRevision(NORMALIZED_CAPTION);
const RECIPE_TOOLS = ["get_recipe_source", "propose_recipe"];
const TONIGHT_TOOLS = ["apply_tonight_changes", "get_tonight", "search_food_items"];

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-kitchen-webmcp-browser-")), "t.db"));
}

function seed(db: ReturnType<typeof mem>): void {
  db.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at) VALUES ('acct', 'instagram', 'u', 'U', ?)`,
  ).run(TS);
  db.prepare(
    `INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES ('col', 'acct', 'saved', 'Saved', ?)`,
  ).run(TS);
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
     VALUES ('food-1', 'reel', NULL, ?, 'https://www.instagram.com/reel/food-1/', 'cook', ?, '[]', ?, ?)`,
  ).run(CAPTION, TS, TS, TS);
  addTag(db, "food-1", "food");
}

async function invokeTool(page: Page, name: string, input: unknown): Promise<Record<string, unknown>> {
  return (await page.evaluate(
    async (toolName: string, toolInput: unknown) => {
      const w = window as unknown as WebmcpWindow & { __locusKitchenTools: Map<string, ExecutableTool> };
      const tool = w.__locusKitchenTools.get(toolName);
      if (!tool) throw new Error(`missing tool: ${toolName}`);
      return (await tool.execute(toolInput)) as Record<string, unknown>;
    },
    name,
    input,
  )) as Record<string, unknown>;
}

test("kitchen detail registers the two Recipe Document tools, proposes a grounded Draft, refreshes the score, and cleans up on navigation", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const { listen } = await import("../server/http/server.ts");
  const db = mem();
  seed(db);
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (event) => console.info(`[pageerror] ${String((event as Error).message)}`));
    page.on("console", (message) => {
      if (message.type() === "error") console.info(`[console] ${message.text()}`);
    });
    // Watch & Cook embeds the Instagram reel for this Item; abort every
    // external request so the test proves the tools, not the platform.
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (/^https?:/.test(request.url()) && !request.url().startsWith(base)) {
        void request.abort();
        return;
      }
      void request.continue();
    });
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);

    const toolNames = () =>
      page.evaluate(() => [...(window as unknown as WebmcpWindow & { __locusKitchenTools: Map<string, unknown> }).__locusKitchenTools.keys()].sort());
    const regCount = () => page.evaluate(() => (window as unknown as WebmcpWindow).__locusKitchenRegsState?.count ?? 0);

    await page.goto(`${base}/#/kitchen/food-1`, { waitUntil: "networkidle0" });
    await page.waitForSelector("h1");
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusKitchenTools?.size ?? 0) === 2,
      { timeout: 5000 },
    );
    assert.deepEqual(await toolNames(), RECIPE_TOOLS, "detail registers exactly the two Recipe Document tools");
    assert.equal(await regCount(), 2, "one registration cycle of two on first mount");

    // get_recipe_source: bounded stored source for the one visible Item.
    const source = (await invokeTool(page, "get_recipe_source", {})) as {
      ok: boolean;
      capabilityVersion: number;
      itemId: string;
      displayTitle: string;
      caption: string | null;
      sourceRevision: string;
      availability: string;
      canWatch: boolean;
      recipe: unknown;
    };
    assert.equal(source.ok, true);
    assert.equal(source.capabilityVersion, 1);
    assert.equal(source.itemId, "food-1");
    const caption = source.caption ?? "";
    assert.equal(caption.includes("\r"), false, "get_recipe_source returns LF, not the stored CRLF");
    assert.equal(caption, NORMALIZED_CAPTION);
    assert.match(source.sourceRevision, /^[a-f0-9]{64}$/);
    assert.equal(source.sourceRevision, captionRevision(caption), "sourceRevision is SHA-256 of the returned caption");
    assert.equal(source.sourceRevision, EXPECTED_REVISION, "source revision is the normalized caption digest");
    assert.equal(source.availability, "caption");
    assert.equal(source.recipe, null, "no Recipe Document exists yet");
    assert.deepEqual(
      Object.keys(source).sort(),
      ["availability", "canWatch", "capabilityVersion", "caption", "displayTitle", "itemId", "ok", "recipe", "sourceRevision"],
      "the read result is bounded: no credentials, no unrelated Library content",
    );

    // propose_recipe: offsets are UTF-16 indexes into the returned caption,
    // including the span after the newline that CRLF would shift by one.
    const paneer = "200 g paneer";
    const grill = "Grill it";
    const paneerStart = caption.indexOf(paneer);
    const grillStart = caption.indexOf(grill);
    assert.equal(paneerStart, 0);
    assert.ok(grillStart > paneerStart, "Grill it is after the newline in the returned caption");
    const proposed = (await invokeTool(page, "propose_recipe", {
      expectedSourceRevision: source.sourceRevision,
      draft: {
        version: 1,
        ingredients: [
          {
            id: "ing-1",
            raw: paneer,
            name: "paneer",
            evidence: { kind: "caption", spans: [{ start: paneerStart, end: paneerStart + paneer.length, text: paneer }] },
          },
        ],
        steps: [
          {
            id: "step-1",
            instruction: grill,
            ingredientIds: ["ing-1"],
            evidence: { kind: "caption", spans: [{ start: grillStart, end: grillStart + grill.length, text: grill }] },
          },
        ],
      },
    })) as {
      ok: boolean;
      itemId: string;
      document: { status: string; updatedBy: string; provenance: string; sourceRevision: string };
    };
    assert.equal(proposed.ok, true);
    assert.equal(proposed.itemId, "food-1");
    assert.equal(proposed.document.status, "draft", "agent proposals are forced to Draft");
    assert.equal(proposed.document.updatedBy, "agent");
    assert.equal(proposed.document.provenance, "caption");
    assert.equal(proposed.document.sourceRevision, EXPECTED_REVISION);

    // The visible recipe score refreshes without a manual reload.
    await page.waitForSelector(".kitchen-score", { timeout: 5000 });
    assert.ok(
      (await page.$$eval(".kitchen-detail-titlerow .chip", (els) => els.map((el) => el.textContent ?? ""))).includes("Draft"),
      "the refreshed score shows the Draft state",
    );
    assert.match(await page.$eval(".kitchen-score", (el) => el.textContent ?? ""), /paneer/);
    assert.equal(await page.$eval(".kitchen-score-heading-ing h2", (el) => el.textContent ?? ""), "Ingredients");

    // Bounds: the propose schema rejects an extra key such as a review state.
    const reviewed = (await invokeTool(page, "propose_recipe", {
      expectedSourceRevision: EXPECTED_REVISION,
      status: "reviewed",
      draft: { version: 1, ingredients: [], steps: [] },
    })) as { ok: boolean; error: string };
    assert.equal(reviewed.ok, false);
    assert.equal(reviewed.error, "invalid", "the agent cannot mark a Recipe Document Reviewed");
    assert.ok(await page.$(".kitchen-score"), "the visible score is unchanged by the rejected write");

    // Consent: generated evidence without the human Allow flip is forbidden.
    const generated = (await invokeTool(page, "propose_recipe", {
      expectedSourceRevision: EXPECTED_REVISION,
      draft: {
        version: 1,
        ingredients: [{ id: "ing-9", raw: "salt", name: "salt", evidence: { kind: "generated" } }],
        steps: [],
      },
    })) as { ok: boolean; error: string };
    assert.equal(generated.ok, false);
    assert.equal(generated.error, "forbidden", "a suggested recipe needs explicit human consent");

    // Lifecycle: leaving for the Kitchen index unregisters the recipe tools;
    // the index-owned Tonight tools may take their place, recipe tools must not
    // remain or duplicate.
    await page.evaluate(() => {
      location.hash = "#/kitchen";
    });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusKitchenTools?.size ?? 0) === 3,
      { timeout: 5000 },
    );
    assert.deepEqual(await toolNames(), TONIGHT_TOOLS, "the index surface owns the Tonight tools");
    await page.evaluate(() => {
      location.hash = "#/kitchen/food-1";
    });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusKitchenTools?.size ?? 0) === 2,
      { timeout: 5000 },
    );
    assert.deepEqual(await toolNames(), RECIPE_TOOLS, "returning re-registers the Recipe Document tools once");
    assert.equal(await regCount(), 7, "exactly one more cycle of two: 2 + 3 + 2, never duplicates");

    // Leaving Kitchen entirely removes every Kitchen tool.
    await page.evaluate(() => {
      location.hash = "#/recent";
    });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusKitchenTools?.size ?? -1) === 0,
      { timeout: 5000 },
    );
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});
