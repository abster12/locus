import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { openDb } from "../db/open.ts";
import { LOCAL_LIBRARY_ID, importReadingRecords } from "../server/reading/module.ts";
import { AUTHENTICATED_LIBRARY_CHANGED_EVENT } from "../app/src/library-identity.ts";

// Browser proof for the Reading WebMCP proving slice: four page-defined tools
// registered only while Reading is visible, the visible recommendation panel,
// and cleanup when the route changes. The fake WebMCP runtime is injected
// before any page script runs; Locus itself never ships a runtime.
process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8802";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

type ExecutableTool = { name: string; execute: (input: unknown) => unknown };

type WebmcpWindow = {
  __locusReadingTools?: Map<string, ExecutableTool>;
  __locusReadingRegsState?: { count: number };
};

// The fake runtime is injected as a source string on purpose: the TS build
// wraps named functions from this file in a __name() helper that only exists
// at module scope, so a serialized function callback would crash in the page.
const FAKE_WEBMCP_RUNTIME = `
  const tools = new Map();
  const regs = { count: 0 };
  window.__locusReadingTools = tools;
  window.__locusReadingRegsState = regs;
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

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-webmcp-browser-")), "t.db"));
}

function paragraph(id: string, text: string) {
  return { id, type: "paragraph", inlines: [{ text, marks: [] as string[] }] };
}

function seed(db: ReturnType<typeof mem>): void {
  const saved = "2026-08-27T00:00:00.000Z";
  const doc = (id: string, title: string, minutes: number, blocks: unknown) => ({
    kind: "readingDocument",
    id,
    canonicalUrl: `https://example.com/${id}`,
    observedUrl: `https://example.com/${id}`,
    kindName: "article",
    availability: "ready",
    originalStatus: "unknown",
    title,
    publication: "Example Press",
    excerpt: null,
    searchText: "stored thoughtful body",
    readingMinutes: minutes,
    contentBlocks: blocks,
    lastSavedAt: saved,
    createdAt: saved,
    updatedAt: saved,
  });
  importReadingRecords(db, {
    documents: [
      doc("essay-a", "Distributed systems explained slowly", 24, {
        version: 1,
        blocks: [paragraph("essay-a-p", "A careful, patient walk through the hard parts.")],
      }),
      doc("essay-b", "A short note on small software", 3, null),
      doc("essay-c", "Field guide to boring databases", 31, null),
    ],
    provenance: [],
    progress: [],
    itemIds: new Set<string>(),
  });
}

async function invokeTool(page: Page, name: string, input: unknown): Promise<Record<string, unknown>> {
  return (await page.evaluate(
    async (toolName: string, toolInput: unknown) => {
      const w = window as unknown as WebmcpWindow & { __locusReadingTools: Map<string, ExecutableTool> };
      const tool = w.__locusReadingTools.get(toolName);
      if (!tool) throw new Error(`missing tool: ${toolName}`);
      return (await tool.execute(toolInput)) as Record<string, unknown>;
    },
    name,
    input,
  )) as Record<string, unknown>;
}

test("reading page registers four WebMCP tools, renders presented recommendations, and cleans up on navigation", async () => {
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
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);

    await page.goto(`${base}/#/reading`, { waitUntil: "networkidle0" });
    await page.waitForSelector("h1");
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusReadingTools?.size ?? 0) === 4,
    );
    assert.deepEqual(
      await page.evaluate(() => [...(window as unknown as WebmcpWindow & { __locusReadingTools: Map<string, unknown> }).__locusReadingTools.keys()].sort()),
      ["get_reading", "get_reading_context", "present_reading_recommendations", "search_reading"],
    );
    assert.equal(
      await page.evaluate(() => (window as unknown as WebmcpWindow).__locusReadingRegsState?.count),
      4,
      "tools must register exactly one cycle of four on first mount",
    );

    // get_reading_context: page state without DOM scraping.
    const context1 = (await invokeTool(page, "get_reading_context", {})) as {
      mood: string | null;
      counts: { unread: number };
      capabilityVersion: number;
      webmcpActive: boolean;
    };
    assert.equal(context1.mood, null);
    assert.equal(context1.counts.unread, 3);
    assert.equal(context1.capabilityVersion, 1);
    assert.equal(context1.webmcpActive, true);

    assert.equal(
      await page.$eval(".reading-agent-title", (node) => node.textContent?.trim()),
      "Your browser agent can help with your reading",
    );

    // search_reading: defaults from page context, real saved documents.
    const search = (await invokeTool(page, "search_reading", {})) as {
      items: Array<{ id: string; title: string; canonicalUrl: string | null; hasStoredText: boolean }>;
      nextCursor: string | null;
    };
    assert.equal(search.items.length, 3);
    assert.deepEqual(
      search.items.map((row) => row.id).sort(),
      ["essay-a", "essay-b", "essay-c"],
    );
    assert.ok(search.items.every((row) => typeof row.canonicalUrl === "string" && row.canonicalUrl.startsWith("https://")));

    // get_reading: stored text for one, honest metadata-only for another.
    const stored = (await invokeTool(page, "get_reading", { documentId: "essay-a" })) as {
      document: { title: string; hasStoredText: boolean; text: string | null; truncated: boolean };
    };
    assert.equal(stored.document.title, "Distributed systems explained slowly");
    assert.equal(stored.document.hasStoredText, true);
    assert.match(stored.document.text ?? "", /patient walk/);
    assert.equal(stored.document.truncated, false);
    const sourceOnly = (await invokeTool(page, "get_reading", { documentId: "essay-b" })) as {
      document: { hasStoredText: boolean; text: string | null; canonicalUrl: string | null };
    };
    assert.equal(sourceOnly.document.hasStoredText, false);
    assert.equal(sourceOnly.document.text, null);
    assert.ok(sourceOnly.document.canonicalUrl);
    const missing = (await invokeTool(page, "get_reading", { documentId: "invented-id" })) as { ok: boolean; error: string };
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "not-found");

    // present_reading_recommendations: three real documents, every basis.
    const presented = (await invokeTool(page, "present_reading_recommendations", {
      mood: "thoughtful",
      recommendations: [
        { documentId: "essay-a", reason: "A slow, careful treatment of the topic; matches a thoughtful mood.", basis: "stored_text" },
        { documentId: "essay-b", reason: "Short and small in scope; a gentle palate cleanser.", basis: "metadata" },
        { documentId: "essay-c", reason: "I inspected the original page; it goes deep on the same theme.", basis: "external_source" },
      ],
    })) as { ok: boolean };
    assert.equal(presented.ok, true);

    await page.waitForSelector(".reading-recs");
    assert.equal(await page.$eval(".reading-recs", (el) => el.getAttribute("role")), "dialog");
    assert.equal(await page.$eval(".reading-recs", (el) => el.getAttribute("aria-modal")), "true");
    assert.equal(await page.$eval(".reading-recs-layer", (el) => getComputedStyle(el).position), "fixed");
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("aria-label")),
      "Dismiss recommendations",
      "the arriving sheet should announce itself by moving focus to its dismiss control",
    );
    const panelText = await page.$eval(".reading-recs", (el) => el.textContent ?? "");
    for (const title of ["Distributed systems explained slowly", "A short note on small software", "Field guide to boring databases"]) {
      assert.ok(panelText.includes(title), `panel missing title: ${title}`);
    }
    assert.match(panelText, /Agent:/);
    assert.match(panelText, /3 recommendations for thoughtful/);
    assert.match(panelText, /from your saved copy/);
    assert.match(panelText, /from the original page/);
    assert.equal(
      await page.$eval(".reading-recs-live", (el) => el.textContent ?? ""),
      "3 recommendations for thoughtful · chosen by your browser agent",
    );
    const recLink = await page.$eval("a.reading-rec-open", (el) => ({
      href: (el as HTMLAnchorElement).href,
      target: (el as HTMLAnchorElement).target,
      rel: (el as HTMLAnchorElement).rel,
    }));
    assert.equal(recLink.target, "_blank");
    assert.match(recLink.href, /^https:\/\/example\.com\//);
    assert.match(recLink.rel, /noopener/);

    // Keyboard: dismiss without a pointer.
    await page.evaluate(() => {
      const dismiss = document.querySelector('button[aria-label="Dismiss recommendations"]');
      if (!dismiss) throw new Error("dismiss button not found");
      (dismiss as HTMLElement).focus();
    });
    await page.keyboard.press("Enter");
    await page.waitForSelector(".reading-recs", { hidden: true });

    // Authenticated Library identity is a separate lifecycle seam from item
    // refresh. Changing it aborts the old registrations and mounts one fresh
    // cycle of four tools.
    await page.evaluate((eventName: string) => {
      window.dispatchEvent(new CustomEvent(eventName, { detail: { libraryId: "other-library" } }));
    }, AUTHENTICATED_LIBRARY_CHANGED_EVENT);
    await page.waitForFunction(
      () => (window as unknown as WebmcpWindow).__locusReadingRegsState?.count === 8,
    );
    assert.equal(
      await page.evaluate(() => (window as unknown as WebmcpWindow).__locusReadingTools?.size),
      4,
      "a Library change must replace, not duplicate, the four registrations",
    );

    // Lifecycle: navigating away removes all four tools; returning registers
    // once more (three cycles: initial, Library change, route return).
    await page.evaluate(() => {
      location.hash = "#/kitchen";
    });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusReadingTools?.size ?? 4) === 0,
    );
    assert.equal(
      await page.evaluate(() => (window as unknown as WebmcpWindow).__locusReadingRegsState?.count),
      8,
    );
    await page.evaluate(() => {
      location.hash = "#/reading";
    });
    await page.waitForFunction(
      () => ((window as unknown as WebmcpWindow).__locusReadingTools?.size ?? 0) === 4,
    );
    assert.equal(
      await page.evaluate(() => (window as unknown as WebmcpWindow).__locusReadingRegsState?.count),
      12,
      "returning to Reading registers one more cycle, never duplicates",
    );
    // Recommendations are non-durable page state: a fresh mount starts empty.
    assert.equal(await page.$(".reading-recs"), null);
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});
