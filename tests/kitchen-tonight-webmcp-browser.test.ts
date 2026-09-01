import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";

// Browser proof for the Tonight WebMCP slice: exactly three tools on the
// Kitchen index surface, Recipe Box-only search, one atomic composition that
// updates the visible Tonight section without a reload, idempotent retries,
// and clean cleanup/re-registration across route changes. The fake WebMCP
// runtime is injected before any page script runs; Locus itself never ships a
// runtime. Opening Kitchen never invokes an agent and never changes Tonight.
process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8812";

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
// Same window keys as the Recipe Document browser test: both Kitchen adapters
// register into one document.modelContext, exactly as in production.
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

const TONIGHT_TOOLS = ["apply_tonight_changes", "get_tonight", "search_food_items"];
const RECIPE_TOOLS = ["get_recipe_source", "propose_recipe"];

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-tonight-webmcp-browser-")), "t.db"));
}

function seed(db: ReturnType<typeof mem>): void {
  db.prepare(
    `INSERT INTO source_accounts (id, source, external_id, display_name, created_at) VALUES ('acct', 'instagram', 'u', 'U', ?)`,
  ).run(TS);
  db.prepare(
    `INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES ('col', 'acct', 'saved', 'Saved', ?)`,
  ).run(TS);
  const item = (id: string, body: string | null, url = `https://www.instagram.com/reel/${id}/`): void => {
    db.prepare(
      `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'reel', NULL, ?, ?, 'cook', ?, '[]', ?, ?)`,
    ).run(id, body, url, TS, TS, TS);
  };
  item("food-1", "Paneer tikka recipe\nGrill it");
  item("food-2", "Chana masala recipe\nSimmer it");
  item("food-3", "Dal fry recipe");
  item("tech-1", null, "https://example.com/plain-note");
  for (const id of ["food-1", "food-2", "food-3"]) addTag(db, id, "food");
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

// Both tests bind the one captured LOCUS_PORT; keep them sequential so the
// two servers never fight for it.
describe("kitchen tonight webmcp browser", { concurrency: false }, () => {
test("kitchen index registers the three Tonight tools, composes Tonight atomically and visibly, and cleans up on navigation", async () => {
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
    // Navigating to the detail route later embeds an Instagram reel; abort
    // every external request so the test proves the tools, not the platform.
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
    const tonightRows = () => page.$$eval(".kitchen-tonight-list li", (els) => els.length);

    // 1. The index surface owns exactly the three Tonight tools, and opening
    // the page never composes Tonight: zero entries, initial revision.
    await page.goto(`${base}/#/kitchen`, { waitUntil: "networkidle0" });
    await page.waitForSelector("h1");
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusKitchenTools?.size ?? 0) === 3,
      { timeout: 5000 },
    );
    assert.deepEqual(await toolNames(), TONIGHT_TOOLS, "the Kitchen index registers exactly the three Tonight tools");

    const initial = (await invokeTool(page, "get_tonight", {})) as {
      ok: boolean;
      capabilityVersion: number;
      revision: number;
      entries: unknown[];
    };
    assert.equal(initial.ok, true);
    assert.equal(initial.capabilityVersion, 1);
    assert.equal(initial.revision, 1, "opening Kitchen never changes Tonight");
    assert.equal(initial.entries.length, 0);
    assert.equal(await tonightRows(), 0);

    // 2. search_food_items: bounded summaries from the Recipe Box predicate
    // only; unknown keys (a nutrition guess, a table/sql injection attempt)
    // are rejected as invalid input.
    const found = (await invokeTool(page, "search_food_items", {})) as {
      ok: boolean;
      items: { itemId: string; displayTitle: string; availability: string }[];
      nextCursor: string | null;
    };
    assert.equal(found.ok, true);
    assert.deepEqual(
      found.items.map((item) => item.itemId).sort(),
      ["food-1", "food-2", "food-3"],
      "search returns only Food Items, never arbitrary saves",
    );
    assert.equal(found.nextCursor, null);
    for (const bad of [{ nutrition: true }, { table: "items", sql: "1=1" }]) {
      const rejected = (await invokeTool(page, "search_food_items", bad)) as { ok: boolean; error: string };
      assert.equal(rejected.ok, false, `unknown keys must be rejected: ${JSON.stringify(bad)}`);
      assert.equal(rejected.error, "invalid");
    }

    // 3. apply_tonight_changes: one atomic composition of two eligible Items.
    const applied = (await invokeTool(page, "apply_tonight_changes", {
      expectedRevision: initial.revision,
      clientMutationId: "mut-1",
      operations: [
        { op: "add", itemId: "food-1" },
        { op: "add", itemId: "food-2" },
      ],
    })) as { ok: boolean; revision: number; entries: unknown[]; replayed: boolean };
    assert.equal(applied.ok, true);
    assert.equal(applied.replayed, false);
    assert.equal(applied.revision, 2);
    assert.equal(applied.entries.length, 2);
    // The visible Tonight section is the only composition surface: it updates
    // immediately, without a reload.
    await page.waitForFunction(() => document.querySelectorAll(".kitchen-tonight-list li").length === 2, { timeout: 5000 });
    const listText = await page.$eval(".kitchen-tonight", (el) => el.textContent ?? "");
    assert.match(listText, /Paneer tikka recipe/);
    assert.match(listText, /Chana masala recipe/);

    // 4. Retrying the same clientMutationId with the same payload replays the
    // original result instead of duplicating dishes.
    const replay = (await invokeTool(page, "apply_tonight_changes", {
      expectedRevision: initial.revision,
      clientMutationId: "mut-1",
      operations: [
        { op: "add", itemId: "food-1" },
        { op: "add", itemId: "food-2" },
      ],
    })) as { ok: boolean; revision: number; entries: unknown[]; replayed: boolean };
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.revision, 2);
    assert.equal(replay.entries.length, 2, "the replay returns the same two entries");
    assert.equal(await tonightRows(), 2, "no duplicate dishes in the visible list");

    // 5. The same clientMutationId with a different payload is rejected and
    // changes nothing.
    const reuse = (await invokeTool(page, "apply_tonight_changes", {
      expectedRevision: applied.revision,
      clientMutationId: "mut-1",
      operations: [{ op: "add", itemId: "food-3" }],
    })) as { ok: boolean; error: string };
    assert.equal(reuse.ok, false);
    assert.equal(reuse.error, "stale", "a reused mutation id cannot carry a different payload");
    assert.equal(await tonightRows(), 2);

    // 6. The detail route owns the Recipe Document tools: the Tonight tools
    // unregister and never remain on another surface.
    await page.evaluate(() => {
      location.hash = "#/kitchen/food-1";
    });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusKitchenTools?.size ?? -1) === 2,
      { timeout: 5000 },
    );
    assert.deepEqual(await toolNames(), RECIPE_TOOLS, "the detail route replaces Tonight tools with the Recipe Document tools");

    // 7. Back on the index the Tonight tools register once more without
    // duplicates, and the composed list survives the round trip.
    await page.evaluate(() => {
      location.hash = "#/kitchen";
    });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusKitchenTools?.size ?? -1) === 3,
      { timeout: 5000 },
    );
    assert.deepEqual(await toolNames(), TONIGHT_TOOLS);
    assert.equal(await regCount(), 8, "one cycle per mount (3 + 2 + 3), never duplicates");
    await page.waitForFunction(() => document.querySelectorAll(".kitchen-tonight-list li").length === 2, { timeout: 5000 });
    assert.match(await page.$eval(".kitchen-tonight", (el) => el.textContent ?? ""), /Paneer tikka recipe/);
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});

test("apply_tonight_changes converges the rail after a lost response and never paints a stale receipt", async () => {
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
    // Lost-response harness: the FIRST apply POST carrying the lost id is
    // committed server-side through a direct Node fetch and then aborted, so
    // the tool sees a transport failure after the server already stored the
    // mutation receipt. Retries pass through; external requests are aborted so
    // the test proves the tools, not the platform.
    const lostId = "mut-lost";
    const lostOps = [
      { op: "add", itemId: "food-1" },
      { op: "add", itemId: "food-2" },
    ];
    let commit: Promise<number> | null = null;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (/^https?:/.test(url) && !url.startsWith(base)) {
        void request.abort();
        return;
      }
      if (request.method() === "POST" && new URL(url).pathname === "/api/kitchen/tonight/apply" && !commit) {
        if ((JSON.parse(request.postData() ?? "{}") as { clientMutationId?: string }).clientMutationId === lostId) {
          const headers = request.headers();
          commit = fetch(url, {
            method: "POST",
            headers: { cookie: headers["cookie"] ?? "", "content-type": "application/json", "x-csrf-token": headers["x-csrf-token"] ?? "" },
            body: request.postData() ?? "{}",
          }).then((response) => response.status);
          void request.abort("failed");
          return;
        }
      }
      void request.continue();
    });
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);

    await page.goto(`${base}/#/kitchen`, { waitUntil: "networkidle0" });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusKitchenTools?.size ?? 0) === 3,
      { timeout: 5000 },
    );

    const tonightRows = () => page.$$eval(".kitchen-tonight-list li", (els) => els.length);
    const railText = () => page.$eval(".kitchen-tonight", (el) => el.textContent ?? "");
    const initial = (await invokeTool(page, "get_tonight", {})) as { ok: boolean; revision: number; entries: unknown[] };
    assert.equal(initial.ok, true);
    assert.equal(initial.revision, 1);
    assert.equal(initial.entries.length, 0);

    // 1. Lost response: the server commits and stores the receipt while the
    // browser never sees the response; the rail stays empty (no reload).
    const lost = (await invokeTool(page, "apply_tonight_changes", {
      expectedRevision: initial.revision,
      clientMutationId: lostId,
      operations: lostOps,
    })) as { ok: boolean; error: string };
    assert.deepEqual(lost, { ok: false, error: "unavailable" }, "the lost attempt is reported as a transport failure");
    assert.equal(await commit, 200, "the lost attempt committed exactly one Tonight mutation server-side");
    assert.equal(await tonightRows(), 0, "the committed list is absent from the visible rail after the lost response");

    // 2. The identical retry replays instead of executing twice, and the
    // visible rail converges to the server state without a reload.
    const retry = (await invokeTool(page, "apply_tonight_changes", {
      expectedRevision: initial.revision,
      clientMutationId: lostId,
      operations: lostOps,
    })) as { ok: boolean; replayed: boolean; revision: number; entries: unknown[] };
    assert.equal(retry.ok, true);
    assert.equal(retry.replayed, true, "the retry is reported as a replay");
    assert.equal(retry.revision, 2);
    assert.equal(retry.entries.length, 2);
    await page.waitForFunction(() => document.querySelectorAll(".kitchen-tonight-list li").length === 2, { timeout: 5000 });
    const rail = await railText();
    assert.match(rail, /Paneer tikka recipe/);
    assert.match(rail, /Chana masala recipe/);
    const railItems = await page.$$eval(".kitchen-tonight-list li", (els) => els.map((el) => el.textContent ?? ""));
    assert.equal(new Set(railItems).size, 2, "no Item is duplicated in the visible list");
    const after = (await invokeTool(page, "get_tonight", {})) as {
      ok: boolean;
      revision: number;
      entries: Array<{ itemId: string }>;
    };
    assert.equal(after.revision, 2);
    assert.deepEqual(after.entries.map((entry) => entry.itemId), ["food-1", "food-2"], "the mutation was not executed twice");

    // 3. Tonight changes after the original receipt, then the original id
    // replays again: the tool still returns the stored receipt snapshot
    // (server idempotency), but the rail keeps the newest state — the client
    // refetches current Tonight instead of painting the stale receipt.
    const newer = (await invokeTool(page, "apply_tonight_changes", {
      expectedRevision: 2,
      clientMutationId: "mut-newer",
      operations: [{ op: "add", itemId: "food-3" }],
    })) as { ok: boolean; replayed: boolean; revision: number };
    assert.equal(newer.ok, true);
    assert.equal(newer.replayed, false);
    assert.equal(newer.revision, 3);
    await page.waitForFunction(() => document.querySelectorAll(".kitchen-tonight-list li").length === 3, { timeout: 5000 });
    assert.match(await railText(), /Dal fry recipe/);

    const receipt = (await invokeTool(page, "apply_tonight_changes", {
      expectedRevision: initial.revision,
      clientMutationId: lostId,
      operations: lostOps,
    })) as { ok: boolean; replayed: boolean; revision: number; entries: unknown[] };
    assert.equal(receipt.ok, true);
    assert.equal(receipt.replayed, true);
    assert.equal(receipt.revision, 2, "the replay still returns the stored receipt revision");
    assert.equal(receipt.entries.length, 2, "the receipt holds only the original two entries");
    // Sample across frames so a late paint of the 2-entry receipt cannot sneak past.
    for (let i = 0; i < 8; i++) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
      assert.equal(await tonightRows(), 3, "the rail keeps the newest state, never the old receipt snapshot");
    }
    assert.match(await railText(), /Dal fry recipe/);
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});
});
