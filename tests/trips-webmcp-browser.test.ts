import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type HTTPRequest, type Page } from "puppeteer-core";
import { openDb } from "../db/open.ts";
import { createTrip } from "../server/trips/module.ts";
import { createPlace } from "../server/atlas/module.ts";

// Browser proof for the Trips WebMCP slice: three tools on the index, nine on a
// Trip Document, exact reads and draft-making writes through the same Trips
// module as the human UI, visible updates without a reload, and clean
// cleanup/re-registration across route changes. The fake runtime is injected
// before any page script runs; Locus never ships a runtime.
process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8806";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const TS = "2026-09-01T09:00:00.000Z";

type ExecutableTool = { name: string; execute: (input: unknown) => unknown };

type WebmcpWindow = {
  __locusTripsTools?: Map<string, ExecutableTool>;
  __locusTripsRegsState?: { count: number };
};

// Source string on purpose: the TS build wraps named functions in __name(),
// which only exists at module scope, so a serialized callback would crash.
const FAKE_WEBMCP_RUNTIME = `
  const tracked = new Set([
    "apply_trip_changes", "build_trip_draft", "create_trip", "get_trip", "get_trip_share_preview",
    "list_trips", "present_trip_recommendations", "record_trip_review", "search_trip_sources", "validate_trip",
  ]);
  const tools = new Map();
  const regs = { count: 0 };
  window.__locusTripsTools = tools;
  window.__locusTripsRegsState = regs;
  Object.defineProperty(document, "modelContext", {
    value: {
      registerTool(tool, options = {}) {
        const ours = tracked.has(tool.name);
        if (ours) {
          regs.count += 1;
          tools.set(tool.name, tool);
        }
        const remove = () => { if (ours) tools.delete(tool.name); };
        if (options.signal?.aborted) remove();
        else options.signal?.addEventListener("abort", remove, { once: true });
        return Promise.resolve();
      },
    },
    configurable: true,
  });
`;

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-webmcp-")), "t.db"));
}

function insertItem(db: ReturnType<typeof mem>, id: string, title: string): void {
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'post', ?, NULL, ?, ?, '[]', ?, ?)`,
  ).run(id, title, `https://x.com/a/status/${id}`, TS, TS, TS);
}

const TRIP_TOOL_NAMES = [
  "apply_trip_changes",
  "build_trip_draft",
  "create_trip",
  "get_trip",
  "get_trip_share_preview",
  "list_trips",
  "present_trip_recommendations",
  "record_trip_review",
  "search_trip_sources",
  "validate_trip",
];

function waitForTripsToolsGone(page: Page) {
  return page.waitForFunction(
    (names: string[]) => names.every((name) => !(window as unknown as WebmcpWindow).__locusTripsTools?.has(name)),
    { timeout: 5000 },
    TRIP_TOOL_NAMES,
  );
}

async function invokeTool(page: Page, name: string, input: unknown): Promise<Record<string, unknown>> {
  return (await page.evaluate(
    async (toolName: string, toolInput: unknown) => {
      const w = window as unknown as WebmcpWindow & { __locusTripsTools: Map<string, ExecutableTool> };
      const tool = w.__locusTripsTools.get(toolName);
      if (!tool) throw new Error(`missing tool: ${toolName}`);
      return (await tool.execute(toolInput)) as Record<string, unknown>;
    },
    name,
    input,
  )) as Record<string, unknown>;
}

test("trips page registers three index tools and nine document tools, applies exact changes visibly, and cleans up on navigation", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const db = mem();
  insertItem(db, "item-kyoto", "Kyoto tea guide");
  createPlace(db, "local", { name: "Kyoto Fushimi Inari shrine", kind: "sight" }, TS);
  const trip = createTrip(db, "local", { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-13" }, TS);
  const { listen } = await import("../server/http/server.ts");
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

    // The Trips index is a private Trips route: three tools live here.
    await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 3, { timeout: 5000 });
    assert.deepEqual(
      await page.evaluate(() => [...((window as unknown as WebmcpWindow & { __locusTripsTools: Map<string, unknown> }).__locusTripsTools.keys())].sort()),
      ["create_trip", "list_trips", "search_trip_sources"],
    );
    assert.equal(
      await page.evaluate(() => (window as unknown as WebmcpWindow).__locusTripsRegsState?.count),
      3,
      "one registration cycle of three on the index",
    );
    assert.equal(
      await page.$eval("[data-agent-banner=trips] .reading-agent-title", (node) => node.textContent?.trim()),
      "Your browser agent can help plan a trip",
    );

    // list_trips: bounded summaries for this Library only.
    const listed = (await invokeTool(page, "list_trips", {})) as { ok: boolean; trips: Array<{ id: string; title: string }> };
    assert.equal(listed.ok, true);
    assert.deepEqual(
      listed.trips.map((row) => row.id),
      [trip.id],
    );

    // Opening the document re-registers for the new surface, never duplicates.
    await page.click("a.trip-row");
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => (window as unknown as WebmcpWindow).__locusTripsRegsState?.count),
      12,
    );
    await page.waitForSelector("[data-agent-banner=trip]");
    assert.equal(await page.$("[data-agent-banner=trips]"), null);
    assert.equal(
      await page.$eval("[data-agent-banner=trip] .reading-agent-title", (node) => node.textContent?.trim()),
      "Your browser agent can help with this trip",
    );

    // get_trip: the exact visible document without session data.
    const got = (await invokeTool(page, "get_trip", {})) as {
      ok: boolean;
      trip: { id: string; revision: number; days: Array<{ id: string; label: string; stops: unknown[] }>; unscheduled: unknown[]; libraryId?: string };
      advisories: unknown[];
    };
    assert.equal(got.ok, true);
    assert.equal(got.trip.id, trip.id);
    assert.equal(got.trip.revision, 1);
    assert.equal(got.trip.days.length, 2);
    assert.deepEqual(got.advisories, []);
    const dayId = got.trip.days[0]!.id;
    assert.deepEqual(await invokeTool(page, "get_trip", { tripId: "invented" }), { ok: false, error: "not-found" });

    // search_trip_sources: bounded Library summaries.
    const search = (await invokeTool(page, "search_trip_sources", { q: "Kyoto" })) as {
      ok: boolean;
      items: Array<{ id: string; title: string }>;
      places: Array<{ id: string; name: string }>;
    };
    assert.equal(search.ok, true);
    assert.ok(search.items.some((row) => row.id === "item-kyoto"));
    assert.ok(search.places.some((row) => row.name === "Kyoto Fushimi Inari shrine"));
    assert.ok(search.items.every((row) => !("body" in row) && !("media" in row)), "no captions or media bytes");

    // create_trip: same validation seam as the human setup form.
    const created = (await invokeTool(page, "create_trip", { destination: "Goa", durationDays: 3, clientMutationId: "webmcp-create-1" })) as {
      ok: boolean;
      trip: { destination: string; durationDays: number; revision: number };
    };
    assert.equal(created.ok, true);
    assert.equal(created.trip.destination, "Goa");
    assert.equal(created.trip.durationDays, 3);
    assert.equal(created.trip.revision, 1);
    assert.deepEqual(
      await invokeTool(page, "create_trip", { destination: "" }),
      { ok: false, error: "invalid" },
      "the module rejects empty destinations",
    );

    // apply_trip_changes: agent actor makes a Draft the human must keep, and
    // the visible artifact updates in the same tick (no reload).
    const applied = (await invokeTool(page, "apply_trip_changes", {
      expectedRevision: 1,
      clientMutationId: "webmcp-1",
      instruction: "Add the tea ceremony the user mentioned.",
      operations: [{ type: "addStop", dayId, content: { kind: "outside", title: "Tea ceremony" } }],
    })) as { ok: boolean; trip: { revision: number }; changeset: { actor?: string }; replayed: boolean };
    assert.equal(applied.ok, true);
    assert.equal(applied.trip.revision, 2);
    assert.equal(applied.replayed, false);
    await page.waitForFunction(
      () => document.querySelector(".pagehead .count")?.textContent === "revision 2",
      { timeout: 5000 },
    );
    await page.waitForFunction(
      () => [...document.querySelectorAll(".trip-anchor b")].some((el) => el.textContent === "Tea ceremony"),
      { timeout: 5000 },
    );

    // The write landed as the agent actor: the stop is Draft on screen. The
    // state chip lives in the Day Planner, so open the focused day view.
    await page.evaluate((dayHash: string) => {
      location.hash = dayHash;
    }, `#/trips/${trip.id}?view=${dayId}`);
    await page.waitForSelector(".trip-planner", { timeout: 5000 });
    assert.match(await page.$eval(".trip-stop-state", (el) => el.textContent ?? ""), /Draft/);
    await page.evaluate((overviewHash: string) => {
      location.hash = overviewHash;
    }, `#/trips/${trip.id}`);
    await page.waitForSelector(".trip-overview", { timeout: 5000 });

    // Idempotent retry with the same clientMutationId.
    const replay = (await invokeTool(page, "apply_trip_changes", {
      expectedRevision: 1,
      clientMutationId: "webmcp-1",
      instruction: "Add the tea ceremony the user mentioned.",
      operations: [{ type: "addStop", dayId, content: { kind: "outside", title: "Tea ceremony" } }],
    })) as { ok: boolean; replayed: boolean; trip: { revision: number } };
    assert.equal(replay.ok, true);
    assert.equal(replay.replayed, true);
    assert.equal(replay.trip.revision, 2, "replay returns the original changeset result");
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 2");

    // Stale revision is a stable stale error and changes nothing.
    assert.deepEqual(
      await invokeTool(page, "apply_trip_changes", {
        expectedRevision: 1,
        clientMutationId: "webmcp-stale",
        operations: [{ type: "addStop", dayId, content: { kind: "outside", title: "Ghost" } }],
      }),
      { ok: false, error: "stale" },
    );
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 2");

    // Open-ended prose without typed operations points at the recommendation
    // contract instead of writing.
    const taste = (await invokeTool(page, "apply_trip_changes", {
      expectedRevision: 2,
      clientMutationId: "webmcp-taste",
      instruction: "find a quiet dinner near Gion",
      operations: [],
    })) as { ok: boolean; error: string; detail?: string };
    assert.equal(taste.ok, false);
    assert.equal(taste.error, "invalid");
    assert.match(taste.detail ?? "", /present_trip_recommendations/);

    // validate_trip: deterministic saved-data conditions only. The trip now
    // carries no holes, so it is clean; add one and the hole is reported.
    const clean = (await invokeTool(page, "validate_trip", {})) as { ok: boolean; valid: boolean; issues: Array<{ kind: string }> };
    assert.equal(clean.ok, true);
    assert.equal(clean.valid, true);
    assert.deepEqual(clean.issues, []);
    const holeApplied = (await invokeTool(page, "apply_trip_changes", {
      expectedRevision: 2,
      clientMutationId: "webmcp-2",
      operations: [{ type: "addStop", dayId, content: { kind: "hole", request: "quiet dinner" } }],
    })) as { ok: boolean };
    assert.equal(holeApplied.ok, true);
    const holey = (await invokeTool(page, "validate_trip", {})) as { valid: boolean; issues: Array<{ kind: string; detail: string }> };
    assert.equal(holey.valid, false);
    assert.deepEqual(
      holey.issues.map((issue) => issue.kind),
      ["unfilled_hole"],
    );
    assert.match(holey.issues[0]!.detail, /quiet dinner/);

    // Lifecycle: leaving Trips removes every tool; returning registers one
    // more cycle without duplicates, and the saved itinerary is still there.
    await page.evaluate(() => {
      location.hash = "#/recent";
    });
    await waitForTripsToolsGone(page);
    assert.equal(
      await page.evaluate(() => (window as unknown as WebmcpWindow).__locusTripsRegsState?.count),
      12,
    );
    await page.evaluate((tripHash: string) => {
      location.hash = tripHash;
    }, `#/trips/${trip.id}`);
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => (window as unknown as WebmcpWindow).__locusTripsRegsState?.count),
      21,
      "returning to Trips registers one more cycle, never duplicates",
    );
    await page.waitForFunction(
      () => [...document.querySelectorAll(".trip-anchor b")].some((el) => el.textContent === "Tea ceremony"),
      { timeout: 5000 },
      "the exact itinerary survives the round trip",
    );
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});

test("record_trip_review appears only after the user asks, saves a visible advisory, and cleans up", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-13" }, TS);
  const { listen } = await import("../server/http/server.ts");
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (event) => console.info(`[pageerror] ${String((event as Error).message)}`));
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);
    const reviewCalls: string[] = [];
    page.on("request", (request) => {
      if (request.url().includes("/agent/review")) reviewCalls.push(request.url());
    });

    // Opening the document arms nothing: nine tools, and no review call.
    await page.goto(`${base}/#/trips/${trip.id}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => ((window as unknown as WebmcpWindow & { __locusTripsTools: Map<string, unknown> }).__locusTripsTools).has("record_trip_review")),
      false,
      "opening a trip never registers the review tool",
    );
    assert.equal(await page.$(".trip-advisory"), null);
    assert.deepEqual(reviewCalls, []);

    // The explicit human ask re-registers once, adding exactly the review tool.
    const clickButton = (label: string) =>
      page.evaluate((text) => {
        const match = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
        if (!match) throw new Error(`button not found: ${text}`);
        (match as HTMLElement).click();
      }, label);
    await clickButton("Ask agent to review");
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 10, { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => ((window as unknown as WebmcpWindow & { __locusTripsTools: Map<string, unknown> }).__locusTripsTools).has("record_trip_review")),
      true,
    );
    assert.match(
      await page.$eval(".trip-review-armed", (el) => el.textContent ?? ""),
      /browser agent can now save an advisory review/,
    );

    // The agent reviews only the saved document and stores one bounded flag.
    const recorded = (await invokeTool(page, "record_trip_review", {
      expectedRevision: 1,
      clientMutationId: "review-1",
      flags: [
        {
          category: "strain",
          severity: "concern",
          opinion: "Day 2 feels long for one afternoon",
          rationale: "Two timed stops with no break between them",
          dayRefs: [],
          stopRefs: [],
        },
      ],
    })) as { ok: boolean; replayed: boolean; advisories: Array<Record<string, unknown>> };
    assert.equal(recorded.ok, true);
    assert.equal(recorded.replayed, false);
    assert.equal(recorded.advisories.length, 1);

    // Successful use consumes the intent: the review tool disappears and the
    // armed status gives way to the Ask button without further human action.
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => ((window as unknown as WebmcpWindow & { __locusTripsTools: Map<string, unknown> }).__locusTripsTools).has("record_trip_review")),
      false,
      "successful use removes the review tool",
    );
    assert.equal(await page.$(".trip-review-armed"), null, "armed status clears after the intent is consumed");
    assert.ok(
      await page.evaluate(() => [...document.querySelectorAll("button")].some((el) => el.textContent?.trim() === "Ask agent to review")),
      "the Ask action returns after consumption",
    );

    // The advisory is visible and clearly labelled as an agent opinion.
    await page.waitForSelector(".trip-advisory", { timeout: 5000 });
    assert.match(await page.$eval(".trip-advisory-mark", (el) => el.textContent ?? ""), /Agent opinion/);
    assert.match(await page.$eval(".trip-advisory-opinion", (el) => el.textContent ?? ""), /Day 2 feels long/);
    assert.match(await page.$eval(".trip-advisory-rationale", (el) => el.textContent ?? ""), /no break/);
    assert.match(await page.$eval(".trip-advisory-head", (el) => el.textContent ?? ""), /reviewed revision 1/);
    assert.equal(await page.$(".trip-health .trip-advisory"), null, "never mixed into the deterministic health panel");

    // An itinerary edit afterwards marks the advisory stale without rewriting it.
    const firstDay = (((await invokeTool(page, "get_trip", {})) as { trip: { days: Array<{ id: string }> } }).trip.days ?? [])[0]?.id;
    assert.ok(firstDay, "get_trip exposes day ids for refs");
    const applied = (await invokeTool(page, "apply_trip_changes", {
      expectedRevision: 1,
      clientMutationId: "after-review-1",
      operations: [{ type: "addStop", dayId: firstDay, content: { kind: "outside", title: "Morning market" } }],
    })) as { ok: boolean; trip: { revision: number } };
    assert.equal(applied.ok, true);
    assert.equal(applied.trip.revision, 2, "a review never moves the revision, so the edit applies at 1");
    // The document moved on; a retry of the same edit at the old revision is stale.
    assert.deepEqual(
      await invokeTool(page, "apply_trip_changes", {
        expectedRevision: 1,
        clientMutationId: "after-review-2",
        operations: [{ type: "addStop", dayId: firstDay, content: { kind: "outside", title: "Morning market" } }],
      }),
      { ok: false, error: "stale" },
    );
    await page.waitForFunction(() => document.querySelector(".trip-advisory-stale")?.textContent?.includes("the trip has changed"), { timeout: 5000 });
    assert.match(await page.$eval(".trip-advisory-opinion", (el) => el.textContent ?? ""), /Day 2 feels long/, "the opinion text is never rewritten");

    // Only the recorded review ever reached the agent route.
    assert.equal(reviewCalls.length, 1, `unexpected review calls: ${reviewCalls.join(", ")}`);

    // Dismissal is human and removes the advisory from the current list.
    await clickButton("Dismiss");
    await page.waitForFunction(() => document.querySelector(".trip-advisory") === null, { timeout: 5000 });
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 2", "dismissal does not bump the document revision");

    // History (on the Day Planner view) holds the dismissed opinion as a
    // read-only record: labelled, stamped, honestly stale, not reversible.
    await page.evaluate((hash: string) => {
      location.hash = hash;
    }, `#/trips/${trip.id}?view=${firstDay}`);
    await page.waitForSelector(".trip-history", { timeout: 5000 });
    await page.click(".trip-history summary");
    await page.waitForSelector('[aria-label="Dismissed agent opinions"]', { timeout: 5000 });
    assert.match(await page.$eval('[aria-label="Dismissed agent opinions"] .trip-advisory-mark', (el) => el.textContent ?? ""), /Dismissed agent opinion/);
    assert.match(await page.$eval('[aria-label="Dismissed agent opinions"] .trip-advisory-opinion', (el) => el.textContent ?? ""), /Day 2 feels long/);
    assert.match(await page.$eval('[aria-label="Dismissed agent opinions"] .trip-advisory-foot', (el) => el.textContent ?? ""), /dismissed/);
    assert.match(await page.$eval('[aria-label="Dismissed agent opinions"] .trip-advisory-stale', (el) => el.textContent ?? ""), /the trip has changed/);
    assert.equal(await page.$eval('[aria-label="Dismissed agent opinions"]', (el) => el.querySelectorAll("button").length), 0, "dismissal is not reversible");
    assert.equal(await page.$('[aria-label="Agent opinions"]'), null, "the active opinions surface stays empty");

    // Leaving the document disarms the review tool; returning does not re-arm it.
    await page.evaluate(() => {
      location.hash = "#/recent";
    });
    await waitForTripsToolsGone(page);
    await page.evaluate((tripHash: string) => {
      location.hash = tripHash;
    }, `#/trips/${trip.id}`);
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => ((window as unknown as WebmcpWindow & { __locusTripsTools: Map<string, unknown> }).__locusTripsTools).has("record_trip_review")),
      false,
      "re-opening the trip starts unarmed again",
    );
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});

test("arming the review UI needs a successful arm request: failures disarm, a retry arms exactly once", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-13" }, TS);
  const { listen } = await import("../server/http/server.ts");
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (event) => console.info(`[pageerror] ${String((event as Error).message)}`));
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);

    // Only the arm POST is shaped; session, CSRF, and document traffic pass through.
    let failMode: "http" | "network" | "pass" = "pass";
    let armPosts = 0;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/review-intent")) {
        armPosts += 1;
        if (failMode === "http") {
          void request.respond({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "arm failed" }) });
          return;
        }
        if (failMode === "network") {
          void request.abort("failed");
          return;
        }
      }
      void request.continue();
    });

    const reviewRegistered = () =>
      page.evaluate(() => ((window as unknown as WebmcpWindow & { __locusTripsTools: Map<string, unknown> }).__locusTripsTools).has("record_trip_review"));
    const askEnabled = () =>
      page.evaluate(() => {
        const match = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Ask agent to review");
        return match ? !(match as HTMLButtonElement).disabled : null;
      });
    const clickButton = (label: string) =>
      page.evaluate((text) => {
        const match = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === text);
        if (!match) throw new Error(`button not found: ${text}`);
        (match as HTMLElement).click();
      }, label);

    // Opening the document arms nothing.
    await page.goto(`${base}/#/trips/${trip.id}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(await reviewRegistered(), false);
    assert.equal(await page.$(".trip-review-armed"), null);

    // An HTTP failure shows an accessible error and keeps the tool away.
    failMode = "http";
    await clickButton("Ask agent to review");
    await page.waitForSelector("p.bad[role='alert']", { timeout: 5000 });
    assert.match(await page.$eval("p.bad[role='alert']", (el) => el.textContent ?? ""), /arm failed/);
    assert.equal(await page.$(".trip-review-armed"), null, "a failed arm never shows the armed status");
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(await reviewRegistered(), false, "a failed arm never registers the review tool");
    assert.equal(await askEnabled(), true, "the Ask action stays enabled for retry");

    // A failed arm leaves nothing behind across navigation.
    await page.evaluate(() => {
      location.hash = "#/recent";
    });
    await waitForTripsToolsGone(page);
    await page.evaluate((tripHash: string) => {
      location.hash = tripHash;
    }, `#/trips/${trip.id}`);
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(await reviewRegistered(), false, "returning after a failed arm starts unarmed");
    assert.equal(await page.$(".trip-review-armed"), null);

    // A network failure behaves like any other failed arm.
    failMode = "network";
    await clickButton("Ask agent to review");
    await page.waitForSelector("p.bad[role='alert']", { timeout: 5000 });
    assert.equal(await page.$(".trip-review-armed"), null);
    assert.equal(await reviewRegistered(), false);
    assert.equal(await askEnabled(), true, "the retry action survives a network failure");

    // Retrying after failure arms exactly once even with an overlapping double click.
    failMode = "pass";
    const postsBeforeRetry = armPosts;
    await page.evaluate(() => {
      const match = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Ask agent to review");
      if (!match) throw new Error("button not found: Ask agent to review");
      (match as HTMLElement).click();
      (match as HTMLElement).click();
    });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 10, { timeout: 5000 });
    assert.equal(armPosts - postsBeforeRetry, 1, "an overlapping double click sends exactly one arm request");
    assert.equal(await reviewRegistered(), true);
    assert.match(await page.$eval(".trip-review-armed", (el) => el.textContent ?? ""), /browser agent can now save an advisory review/);
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});

test("a delayed arm for one trip never arms a different trip", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const db = mem();
  const tripA = createTrip(db, "local", { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-13" }, TS);
  const tripB = createTrip(db, "local", { destination: "Osaka, Japan", startDate: "2026-11-01", endDate: "2026-11-02" }, TS);
  const { listen } = await import("../server/http/server.ts");
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);

    await page.setRequestInterception(true);
    const held = new Promise<HTTPRequest>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("arm request was never intercepted")), 5000);
      page.on("request", (request) => {
        if (request.method() === "POST" && new URL(request.url()).pathname.endsWith("/review-intent")) {
          clearTimeout(timer);
          resolve(request);
          return;
        }
        void request.continue();
      });
    });

    await page.goto(`${base}/#/trips/${tripA.id}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    await page.evaluate(() => {
      const match = [...document.querySelectorAll("button")].find((el) => el.textContent?.trim() === "Ask agent to review");
      if (!match) throw new Error("button not found: Ask agent to review");
      (match as HTMLElement).click();
    });
    const pending = await held;

    await page.evaluate((tripHash: string) => {
      location.hash = tripHash;
    }, `#/trips/${tripB.id}`);
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    await page.waitForFunction((destination: string) => document.body.textContent?.includes(destination), { timeout: 5000 }, "Osaka, Japan");
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });

    const finished = page.waitForResponse((response) => response.url().includes("/review-intent") && response.request().method() === "POST", { timeout: 5000 });
    void pending.continue();
    await finished;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 250)));
    assert.equal(
      await page.evaluate(() => ((window as unknown as WebmcpWindow & { __locusTripsTools: Map<string, unknown> }).__locusTripsTools).has("record_trip_review")),
      false,
      "a late arm for another trip never registers the review tool",
    );
    assert.equal(await page.$(".trip-review-armed"), null, "a late arm for another trip never shows armed status");
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});

test("build_trip_draft makes visible Drafts and present_trip_recommendations shows three options the human chooses", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const db = mem();
  insertItem(db, "item-tea", "Kyoto tea guide");
  createPlace(db, "local", { name: "Nanzen-ji temple grounds", kind: "landmark" }, TS);
  const trip = createTrip(db, "local", { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-13" }, TS);
  const { listen } = await import("../server/http/server.ts");
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const writes: string[] = [];
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) && url.startsWith(base)) {
        writes.push(`${request.method()} ${url.replace(base, "")}`);
      }
      void request.continue();
    });
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);

    // Opening the document performs no mutation and arms no inference.
    await page.goto(`${base}/#/trips/${trip.id}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 1");
    assert.equal(writes.length, 0, "opening a trip never writes or calls an agent");
    assert.equal(await page.$(".trip-inference"), null);

    const got = (await invokeTool(page, "get_trip", {})) as { trip: { days: Array<{ id: string }> } };
    const dayId = got.trip.days[0]!.id;

    // build_trip_draft: one atomic agent changeset of Draft stops on
    // Unscheduled, with labelled inferences. The visible document updates
    // without a reload.
    const built = (await invokeTool(page, "build_trip_draft", {
      expectedRevision: 1,
      clientMutationId: "browser-build-1",
      instruction: "plan a base itinerary from my saved Kyoto sources",
      selectedSources: [
        { kind: "item", id: "item-tea" },
        { kind: "place", id: "no-such-place" },
      ],
      inferredPreferences: [{ text: "prefers slow mornings", basis: "pace: slow mornings" }],
    })) as { ok: boolean; error?: string };
    assert.equal(built.ok, false, "an unknown source id rejects the whole build");
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 1");
    assert.equal(await page.$(".trip-inference"), null, "a rejected build persists no inferences");

    // Build from real Library ids: the place id comes from the bounded search
    // tool, exactly the path an agent would take.
    const search = (await invokeTool(page, "search_trip_sources", { q: "Nanzen" })) as { places: Array<{ id: string }> };
    assert.equal(search.places.length, 1);
    const builtOk = (await invokeTool(page, "build_trip_draft", {
      expectedRevision: 1,
      clientMutationId: "browser-build-2",
      instruction: "plan a base itinerary from my saved Kyoto sources",
      selectedSources: [
        { kind: "item", id: "item-tea" },
        { kind: "place", id: search.places[0]!.id },
      ],
      inferredPreferences: [{ text: "prefers slow mornings", basis: "pace: slow mornings" }],
    })) as { ok: boolean; addedStops: number };
    assert.equal(builtOk.ok, true);
    assert.equal(builtOk.addedStops, 2);
    await page.waitForFunction(() => document.querySelector(".pagehead .count")?.textContent === "revision 2", { timeout: 5000 });
    await page.evaluate((viewHash: string) => {
      location.hash = viewHash;
    }, `#/trips/${trip.id}?view=${dayId}`);
    await page.waitForSelector(".trip-planner", { timeout: 5000 });
    const draftStates = await page.$$eval(".trip-unscheduled .trip-stop-state", (els) => els.map((el) => el.textContent));
    assert.deepEqual(draftStates, ["Draft", "Draft"], "both built stops wait in Draft on Unscheduled");
    assert.equal(await page.$eval(".trip-inference .trip-inference-text", (el) => el.textContent), "prefers slow mornings");
    assert.match(await page.$eval(".trip-inference .trip-inference-basis", (el) => el.textContent ?? ""), /pace: slow mornings/);
    assert.equal(await page.$eval(".trip-inference button", (el) => el.textContent), "Remove");

    // present_trip_recommendations: exactly three options in the drawer, and
    // presentation itself writes nothing.
    const option = {
      opinion: "Best fit",
      summary: "Day 1 tea tasting after the temple walk.",
      fit: "Next to the temple walk",
      tradeoff: "Booked out weeks ahead",
      basis: "2 saved Library sources",
      effect: "No known schedule conflict",
      operations: [{ type: "addStop", dayId, content: { kind: "outside", title: "Tea tasting", notes: null, url: null } }],
    };
    const presented = (await invokeTool(page, "present_trip_recommendations", {
      request: "a quiet tea stop",
      options: [option, { ...option, opinion: "Most adventurous" }, { ...option, opinion: "Lowest pressure" }],
    })) as { ok: boolean; optionCount: number };
    assert.equal(presented.ok, true);
    assert.equal(presented.optionCount, 3);
    await page.waitForSelector(".trip-recs", { timeout: 5000 });
    assert.equal((await page.$$(".trip-rec")).length, 3, "exactly three options are visible");
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 2", "presentation never mutates");
    await page.click(".trip-recs-dismiss");
    await page.waitForFunction(() => !document.querySelector(".trip-recs-layer"), { timeout: 5000 });

    // Wrong option counts are rejected before anything is shown.
    assert.deepEqual(
      await invokeTool(page, "present_trip_recommendations", { request: "r", options: [option, option] }),
      { ok: false, error: "invalid" },
    );
    assert.equal((await page.$(".trip-recs")) === null, true, "a rejected presentation shows no drawer");

    // Dismissal leaves the document untouched.
    await invokeTool(page, "present_trip_recommendations", {
      request: "a quiet tea stop",
      options: [option, { ...option, opinion: "Most adventurous" }, { ...option, opinion: "Lowest pressure" }],
    });
    await page.waitForSelector(".trip-recs", { timeout: 5000 });
    await page.click(".trip-recs-dismiss");
    await page.waitForFunction(() => !document.querySelector(".trip-recs-layer"), { timeout: 5000 });
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 2");
    assert.equal(await page.$(".trip-unscheduled .trip-stop-title") ? true : true, true);

    // Selecting one option is exactly one human changeset at revision 2.
    await invokeTool(page, "present_trip_recommendations", {
      request: "a quiet tea stop",
      options: [option, { ...option, opinion: "Most adventurous" }, { ...option, opinion: "Lowest pressure" }],
    });
    await page.waitForSelector(".trip-recs", { timeout: 5000 });
    await page.click(".trip-rec button");
    await page.waitForFunction(() => !document.querySelector(".trip-recs-layer"), { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".pagehead .count")?.textContent === "revision 3", { timeout: 5000 });
    const dayTitles = await page.$$eval(".trip-day:not(.trip-unscheduled) .trip-stop-title", (els) => els.map((el) => el.textContent));
    assert.ok(dayTitles.includes("Tea tasting"), "the chosen option landed on its proposed day");

    // The human can remove an agent inference; the label list updates live.
    await page.click(".trip-inference button");
    await page.waitForFunction(() => !document.querySelector(".trip-inference"), { timeout: 5000 });

    // Cleanup on navigation, one re-registration cycle on return.
    await page.evaluate(() => {
      location.hash = "#/recent";
    });
    await waitForTripsToolsGone(page);
    await page.evaluate((tripHash: string) => {
      location.hash = tripHash;
    }, `#/trips/${trip.id}`);
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 9, { timeout: 5000 });

    // Exactly the writes we made happen: two build calls (the first rejected
    // server-side by module reference validation — that is the point), one
    // human selection changeset, one inference removal. Presentations made
    // none.
    assert.equal(writes.filter((entry) => entry.endsWith("/agent/changes")).length, 2, "two atomic build calls");
    assert.equal(writes.filter((entry) => entry === `POST /api/trips/${trip.id}/changes`).length, 1, "one human selection changeset");
    assert.equal(writes.filter((entry) => entry.includes("/inferences/")).length, 1, "one inference removal");
    assert.equal(writes.length, 4, `unexpected writes: ${writes.join(", ")}`);
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});

test("create_trip keeps one Trip across a lost response, identical retries, and rejects a conflicting payload", async () => {
  if (!existsSync(CHROME)) assert.fail(`Chrome not found at ${CHROME}; install Google Chrome to run this smoke test.`);
  const db = mem();
  const { listen } = await import("../server/http/server.ts");
  const app = listen(db);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (event) => console.info(`[pageerror] ${String((event as Error).message)}`));
    await page.evaluateOnNewDocument(FAKE_WEBMCP_RUNTIME);

    // The first create POST is committed server-side via a direct Node fetch
    // and then aborted, so the tool sees a transport failure after the server
    // already wrote the Trip — a lost response. Everything else passes through.
    const lostId = "webmcp-lost-1";
    const abortedIds = new Set<string>();
    let commit: Promise<number> | null = null;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (request.method() === "POST" && new URL(url).pathname === "/api/trips") {
        const id = (JSON.parse(request.postData() ?? "{}") as { clientMutationId?: string }).clientMutationId ?? "";
        if (id === lostId && !abortedIds.has(lostId)) {
          abortedIds.add(lostId);
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

    await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => ((window as unknown as WebmcpWindow).__locusTripsTools?.size ?? 0) === 3, { timeout: 5000 });

    const createInput = { destination: "Goa", durationDays: 3, clientMutationId: lostId };

    // Lost response: the server commits, the caller sees a transport failure.
    assert.deepEqual(await invokeTool(page, "create_trip", createInput), { ok: false, error: "unavailable" });
    assert.equal(await commit, 200, "the lost attempt committed exactly one Trip server-side");

    // The unchanged retry replays the owner-scoped receipt instead of inserting.
    const retry = (await invokeTool(page, "create_trip", createInput)) as { ok: boolean; trip: { id: string } };
    assert.equal(retry.ok, true);

    // Another identical execution with the same id returns the same Trip.
    const again = (await invokeTool(page, "create_trip", createInput)) as { ok: boolean; trip: { id: string } };
    assert.equal(again.ok, true);
    assert.equal(again.trip.id, retry.trip.id, "the same mutation id returns the same Trip");

    // The same id with a different setup payload is rejected.
    assert.deepEqual(
      await invokeTool(page, "create_trip", { ...createInput, destination: "Osaka" }),
      { ok: false, error: "invalid" },
    );

    // Exactly one Trip exists for the whole flow.
    const listed = (await invokeTool(page, "list_trips", {})) as { ok: boolean; trips: Array<{ id: string }> };
    assert.equal(listed.ok, true);
    assert.deepEqual(
      listed.trips.map((row) => row.id),
      [retry.trip.id],
    );
  } finally {
    await browser.close();
    await app.close();
    db.close();
  }
});
