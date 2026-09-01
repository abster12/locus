import { test } from "node:test";
import assert from "node:assert/strict";
import { chooseAddSource, clickByText as harnessClickByText, launchBrowser, setInput as harnessSetInput, startServer, tempDb, trackTraffic } from "./trips-browser-harness.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8822";


test("trips browser: add from Library, inspect details, and broken references stay visible", async () => {
  const database = tempDb("locus-trips-browser-src-");
  database
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'post', ?, ?, ?, 'cook', ?, '[]', ?, ?)`,
    )
    .run("item-planner", "Nishiki snack walk", "a long stored caption", "https://x.com/a/status/7", "2026-09-01T09:00:00.000Z", "2026-09-01T09:00:00.000Z", "2026-09-01T09:00:00.000Z");
  const { createPlace } = await import("../server/atlas/module.ts");
  createPlace(database, "local", { name: "Nishiki Market", kind: "landmark" });

  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const { external, writes } = trackTraffic(page, base);

    const setInput = (selector: string, value: string) => harnessSetInput(page, selector, value);
    const clickByText = (scope: string, text: string) => harnessClickByText(page, scope, text);

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/trips/new`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-form input[required]", { timeout: 5000 });
    await setInput(".trip-form input[required]", "Kyoto references");
    await setInput(".trip-when input[type='number']", "2");
    await page.click(".trip-form button[type='submit']");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    await page.$$eval(".trip-nav a", (els) => {
      const tab = els.find((el) => el.textContent?.startsWith("Day 1"));
      if (!tab) throw new Error("no Day 1 tab");
      (tab as HTMLElement).click();
    });
    await page.waitForFunction(() => /view=/.test(location.hash), { timeout: 5000 });
    await page.waitForSelector(".trip-planner", { timeout: 5000 });

    // Add from Library: search finds both kinds; the item result plus Add stop places a reference.
    await clickByText(".trip-day:not(.trip-unscheduled)", "Add stop");
    await chooseAddSource(page, "Choose from Library");
    await page.waitForSelector(".trip-add-dialog input[type='search']", { timeout: 5000 });
    await setInput(".trip-add-dialog input[type='search']", "nishiki");
    await page.waitForSelector(".trip-search-result", { timeout: 5000 });
    const results = await page.$$eval(".trip-search-result", (els) => els.map((el) => el.textContent ?? ""));
    assert.equal(results.filter((text) => text.includes("Saved item")).length, 1);
    assert.equal(results.filter((text) => text.includes("Place · landmark")).length, 1);

    await page.$eval(".trip-add-dialog", (root) => {
      const button = [...root.querySelectorAll<HTMLButtonElement>(".trip-search-result")].find((el) => el.textContent?.includes("Nishiki snack walk"));
      if (!button) throw new Error("no item result");
      button.click();
    });
    await page.click(".trip-add-dialog button[type='submit']");
    await page.waitForFunction(() => document.querySelector(".trip-day:not(.trip-unscheduled) .trip-stop-title")?.textContent === "Nishiki snack walk", { timeout: 5000 });
    const kinds = await page.$$eval(".trip-day:not(.trip-unscheduled) .trip-stop-kind", (els) => els.map((el) => el.textContent ?? ""));
    assert.deepEqual(kinds, ["Saved item"]);

    // The card itself opens details; nested source/menu/drag do not.
    assert.equal(await page.$(".trip-stop-state"), null, "Confirmed has no persistent pill");
    await page.focus('[aria-label="Open details for Nishiki snack walk"]');
    await page.keyboard.press("Enter");
    await page.waitForSelector(".trip-stop-dialog[open]", { timeout: 5000 });
    const facts = await page.$eval(".trip-stop-dialog[open] .trip-stop-facts", (el) => el.textContent ?? "");
    assert.match(facts, /Source/);
    assert.match(facts, /x/);
    assert.match(facts, /Open original/);
    const writesBeforeEscape = writes.length;
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".trip-stop-dialog"), { timeout: 5000 });
    assert.equal(writes.length, writesBeforeEscape, "Escape closes details without mutation");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), "Open details for Nishiki snack walk");
    assert.equal(
      await page.$eval(".trip-stop-source", (el) => {
        el.addEventListener("click", (event) => event.preventDefault(), { once: true });
        (el as HTMLElement).click();
        return document.querySelector(".trip-stop-dialog[open]") ? true : false;
      }),
      false,
      "source link does not open details",
    );
    await page.click('[aria-label="Drag Nishiki snack walk to reorder"]');
    assert.equal(await page.$(".trip-stop-dialog[open]"), null, "drag handle does not open details");
    await page.click('[aria-label="Actions for Nishiki snack walk"]');
    assert.equal(await page.$(".trip-stop-dialog[open]"), null, "menu does not open details");
    await page.click('[aria-label="Actions for Nishiki snack walk"]');

    // An outside stop with a user-supplied public link stays visibly distinct.
    await clickByText(".trip-day:not(.trip-unscheduled)", "Add stop");
    await chooseAddSource(page, "Add outside content");
    await page.waitForSelector(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", { timeout: 5000 });
    await setInput(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", "Ramen research");
    await setInput(".trip-add-dialog input[type='url']", "https://example.com/ramen");
    await page.click(".trip-add-dialog button[type='submit']");
    await page.waitForFunction(() => document.querySelectorAll(".trip-day:not(.trip-unscheduled) .trip-stop-title").length === 2, { timeout: 5000 });
    await page.focus('[aria-label="Open details for Ramen research"]');
    await page.keyboard.press(" ");
    await page.waitForFunction(() => document.querySelector(".trip-stop-dialog[open] .trip-stop-facts")?.textContent?.includes("Open link"), { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".trip-stop-dialog"), { timeout: 5000 });
    const outsideKinds = await page.$$eval(".trip-day:not(.trip-unscheduled) .trip-stop-kind", (els) => els.map((el) => el.textContent ?? ""));
    assert.ok(outsideKinds.includes("Outside"), "outside content is labelled as text");

    const writesBeforeCancel = writes.length;
    await page.$$eval(".trip-day:not(.trip-unscheduled) button", (els) => {
      const button = els.find((el) => (el.textContent ?? "").trim() === "Add stop") as HTMLButtonElement | undefined;
      if (!button) throw new Error("no Add stop button");
      button.focus();
      button.click();
    });
    await chooseAddSource(page, "Choose from Library");
    await page.$$eval(".trip-add-dialog button", (els) => {
      const back = els.find((el) => (el.textContent ?? "").includes("Choose another source"));
      if (!back) throw new Error("no back");
      (back as HTMLElement).click();
    });
    await chooseAddSource(page, "Add outside content");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".trip-add-dialog"), { timeout: 5000 });
    assert.equal(writes.length, writesBeforeCancel, "cancel and source switching write nothing");
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), "Add stop");

    const writesBeforeDraft = writes.length;
    await clickByText(".trip-day:not(.trip-unscheduled)", "Add stop");
    await chooseAddSource(page, "Add outside content");
    await page.waitForSelector(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", { timeout: 5000 });
    await setInput(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", "Maybe later");
    await page.$$eval(".trip-add-dialog button", (els) => {
      const draft = els.find((el) => el.textContent === "Save as Draft");
      if (!draft) throw new Error("no Save as Draft");
      (draft as HTMLElement).click();
    });
    await page.waitForFunction(() => [...document.querySelectorAll(".trip-stop-title")].some((el) => el.textContent === "Maybe later"), { timeout: 5000 });
    assert.equal(writes.length, writesBeforeDraft + 1, "Save as Draft is one POST");
    assert.equal(
      await page.$$eval(".trip-stop", (els) => {
        const row = els.find((el) => el.querySelector(".trip-stop-title")?.textContent === "Maybe later");
        return row?.querySelector(".trip-stop-state")?.textContent ?? "";
      }),
      "Draft",
    );
    const confirmedPills = await page.$$eval(".trip-stop", (els) =>
      els
        .filter((el) => el.querySelector(".trip-stop-title")?.textContent !== "Maybe later")
        .map((el) => el.querySelector(".trip-stop-state")?.textContent ?? ""),
    );
    assert.ok(confirmedPills.every((text) => text === ""), "Confirmed cards have no persistent Confirmed pill");
    await page.click('[aria-label="Open details for Draft Maybe later"]');
    await page.waitForSelector(".trip-stop-dialog[open]", { timeout: 5000 });
    assert.deepEqual(
      await page.$$eval(".trip-stop-dialog[open] .trip-form-actions button", (els) => els.map((el) => (el.textContent ?? "").trim())),
      ["Keep stop", "Edit Draft", "Remove Draft"],
    );
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".trip-stop-dialog"), { timeout: 5000 });

    // Removing the referenced Item turns the stop into a visible broken reference.
    database.prepare(`DELETE FROM items WHERE id = 'item-planner'`).run();
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-planner", { timeout: 5000 });
    await page.waitForFunction(() => [...document.querySelectorAll(".trip-stop-title")].some((el) => el.textContent === "Missing saved item"), { timeout: 5000 });
    const brokenKinds = await page.$$eval(".trip-stop-kind", (els) => els.map((el) => el.textContent ?? ""));
    assert.ok(brokenKinds.includes("Missing"), "broken reference is labelled as text");
    await page.click('[aria-label="Open details for Missing saved item"]');
    await page.waitForSelector(".trip-stop-dialog[open]", { timeout: 5000 });
    assert.match(await page.$eval(".trip-stop-dialog[open] .trip-stop-facts", (el) => el.textContent ?? ""), /missing from the Library/);
    await page.keyboard.press("Escape");
    const titles = await page.$$eval(".trip-day:not(.trip-unscheduled) .trip-stop-title", (els) => els.map((el) => el.textContent ?? ""));
    assert.deepEqual(titles, ["Missing saved item", "Ramen research", "Maybe later"], "historical placement is preserved");

    assert.deepEqual(
      writes.filter((entry) => !entry.startsWith("POST /api/trips")),
      [],
      `unexpected writes: ${writes.join(", ")}`,
    );
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});

test("trips browser: drafts, holes, and the temporary recommendation sheet", async () => {
  const database = tempDb("locus-trips-drafts-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  const AT = "2026-09-01T09:00:00.000Z";
  try {
    const page = await browser.newPage();
    const { external, writes } = trackTraffic(page, base);

    const setInput = (selector: string, value: string) => harnessSetInput(page, selector, value);
    const clickAria = async (label: string) => {
      await page.$eval(`[aria-label="${label}"]`, (el) => (el as HTMLElement).click());
    };
    const clickDayText = (scope: string, text: string) => harnessClickByText(page, scope, text);
    const clickTab = async (label: string) =>
      page.$$eval(".trip-nav a", (els, wanted) => {
        const tab = els.find((el) => el.textContent?.startsWith(wanted));
        if (!tab) throw new Error(`no tab ${wanted}`);
        (tab as HTMLElement).click();
      }, label);
    const dayTitles = () => page.$$eval(".trip-day:not(.trip-unscheduled) .trip-stop-title", (els) => els.map((el) => el.textContent ?? ""));
    const seedDraft = (id: string, tripId: string, dayId: string, position: number) =>
      database
        .prepare(
          `INSERT INTO trip_stops (id, trip_id, day_id, position, content_json, state, provenance_json, public_notes, private_notes, time_window, duration_minutes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'draft', ?, '', '', NULL, NULL, ?, ?)`,
        )
        .run(id, tripId, dayId, position, JSON.stringify({ kind: "outside", title: `Agent idea ${id}`, notes: null, url: null }), JSON.stringify({ actor: "agent", via: "agent" }), AT, AT);
    const presentOptions = (tripId: string, dayId: string) =>
      page.evaluate(
        (ids) => {
          window.dispatchEvent(
            new CustomEvent("locus:trip-recommendations", {
              detail: {
                tripId: ids.tripId,
                request: "quiet dinner near Gion",
                options: [
                  {
                    opinion: "Best fit",
                    fit: "Two stops away from the day's temple climb, walking distance from the hotel.",
                    tradeoff: "Books out early most nights.",
                    basis: "One saved Library source and your hard constraint of no 07:00 trains.",
                    effect: "Fills the 19:30 hole without moving any Confirmed stop.",
                    operations: [{ type: "addStop", dayId: ids.dayId, content: { kind: "outside", title: "Ramen Tatsu", notes: null, url: null }, timeWindow: "19:30" }],
                  },
                  {
                    opinion: "Most adventurous",
                    fit: "Matches the request for a quiet dinner with a local counter feel.",
                    tradeoff: "Requires a 25 minute bus ride back.",
                    basis: "One Place saved in Atlas.",
                    effect: "No known schedule conflict.",
                    operations: [{ type: "addStop", dayId: ids.dayId, content: { kind: "outside", title: "Gion Kappa", notes: null, url: null }, timeWindow: "20:00" }],
                  },
                  {
                    opinion: "Lowest pressure",
                    fit: "Keeps the evening loose after a long walking day.",
                    tradeoff: "Less of a headline meal.",
                    basis: "Your pace note: slow evenings.",
                    effect: "Preserves an intentionally open evening.",
                    operations: [{ type: "addStop", dayId: null, content: { kind: "outside", title: "Conbini picnic", notes: null, url: null } }],
                  },
                ],
              },
            }),
          );
        },
        { tripId, dayId },
      );

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/trips/new`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-form input[required]", { timeout: 5000 });
    await setInput(".trip-form input[required]", "Kyoto drafts");
    await setInput(".trip-when input[type='number']", "2");
    await page.click(".trip-form button[type='submit']");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    const tripId = (await page.evaluate(() => location.hash)).replace("#/trips/", "").replace(/\?.*$/, "");
    const dayId = (database.prepare(`SELECT id FROM trip_days WHERE trip_id = ? ORDER BY position LIMIT 1`).get(tripId) as { id: string }).id;

    // The empty-day "Ask agent for options" control stays honest: no agent,
    // no POST, just a status notice.
    await clickTab("Day 2");
    await page.waitForSelector(".trip-empty-card", { timeout: 5000 });
    const writesBeforeAsk = writes.length;
    await page.$eval(".trip-empty-card", (root) => {
      const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === "Ask agent for options");
      if (!button) throw new Error("no ask button");
      button.click();
    });
    await page.waitForFunction((n) => document.querySelector(".trip-live")?.textContent?.includes("No agent was called"), { timeout: 5000 }, writesBeforeAsk);
    assert.equal(writes.length, writesBeforeAsk, "asking for opinions without a presented panel performs no request");

    // A seeded Draft stop shows as text and is kept by one human changeset.
    await clickTab("Day 1");
    await page.waitForSelector(".trip-planner", { timeout: 5000 });
    seedDraft("draft-1", tripId, dayId, 0);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-planner", { timeout: 5000 });
    await page.waitForSelector(".trip-stop-state-draft", { timeout: 5000 });
    assert.ok(await page.$eval(".trip-stop-state-draft", (el) => el.textContent === "Draft"), "Draft is exposed as text");
    const writesBeforeKeep = writes.length;
    await page.click('[aria-label="Open details for Draft Agent idea draft-1"]');
    await page.waitForSelector(".trip-stop-dialog[open]", { timeout: 5000 });
    await clickAria("Keep Agent idea draft-1");
    await page.waitForFunction(() => !document.querySelector(".trip-stop-state-draft"), { timeout: 5000 });
    assert.equal(await page.$(".trip-stop-state"), null, "keeping a Draft leaves no Confirmed pill");
    assert.equal(writes.length, writesBeforeKeep + 1, "keeping one draft is one changeset");

    // Keep all drafts: two seeded drafts confirm in exactly one changeset.
    seedDraft("draft-2", tripId, dayId, 1);
    seedDraft("draft-3", tripId, dayId, 2);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelectorAll(".trip-stop-state-draft").length === 2, { timeout: 5000 });
    const writesBeforeKeepAll = writes.length;
    await page.$eval(".trip-planner-head", (root) => {
      const button = [...root.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === "Keep all drafts (2)");
      if (!button) throw new Error("no keep-all button");
      button.click();
    });
    await page.waitForFunction(() => document.querySelectorAll(".trip-stop-state-draft").length === 0, { timeout: 5000 });
    assert.equal(writes.length, writesBeforeKeepAll + 1, "Keep All is exactly one changeset");
    const keepAllTitles = await dayTitles();
    assert.deepEqual(keepAllTitles, ["Agent idea draft-1", "Agent idea draft-2", "Agent idea draft-3"]);

    // A hole is a durable bounded request at an exact placement.
    const addHole = async (request: string) => {
      await clickDayText(".trip-day:not(.trip-unscheduled)", "Add stop");
      await chooseAddSource(page, "Add a hole");
      await page.waitForSelector(".trip-add-dialog input[placeholder='e.g. quiet dinner near Gion']", { timeout: 5000 });
      await setInput(".trip-add-dialog input[placeholder='e.g. quiet dinner near Gion']", request);
      await page.click(".trip-add-dialog button[type='submit']");
      await page.waitForFunction((want) => [...document.querySelectorAll(".trip-stop-title")].some((el) => el.textContent === want), { timeout: 5000 }, request);
    };
    const writesBeforeHole = writes.length;
    await addHole("Quiet dinner near Gion");
    assert.equal(writes.length, writesBeforeHole + 1);
    const holeCard = await page.$eval(".trip-stop-hole", (el) => el.textContent ?? "");
    assert.match(holeCard, /Hole/);
    assert.match(holeCard, /Fill/);
    assert.match(holeCard, /Dismiss/);
    assert.equal(await page.$(".trip-stop-hole .trip-stop-state"), null, "holes are not labelled Confirmed");

    // Filling the hole: one changeset, hole gone, exact place, no gap.
    await clickAria("Fill Quiet dinner near Gion");
    await chooseAddSource(page, "Add outside content");
    await page.waitForSelector(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", { timeout: 5000 });
    await setInput(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", "Dinner at Gion");
    await page.click(".trip-add-dialog button[type='submit']");
    await page.waitForFunction(() => !document.querySelector(".trip-stop-hole"), { timeout: 5000 });
    assert.equal(writes.length, writesBeforeHole + 2, "hole add + fill are two changesets total");
    assert.deepEqual(await dayTitles(), ["Agent idea draft-1", "Agent idea draft-2", "Agent idea draft-3", "Dinner at Gion"]);

    // Dismiss removes the hole without phantom state.
    await addHole("Backup museum morning");
    const writesBeforeDismiss = writes.length;
    await clickAria("Dismiss Backup museum morning");
    await page.waitForFunction(() => !document.querySelector(".trip-stop-hole"), { timeout: 5000 });
    assert.equal(writes.length, writesBeforeDismiss + 1);

    // Presentation: exactly three rich options in a temporary sheet.
    await presentOptions(tripId, dayId);
    await page.waitForSelector(".trip-recs", { timeout: 5000 });
    const options = await page.$$eval(".trip-rec", (els) => els.map((el) => el.textContent ?? ""));
    assert.equal(options.length, 3, "exactly three options");
    for (const text of ["Best fit", "Why it fits", "Tradeoff", "Basis", "Proposed placement", "Likely effect"]) {
      assert.ok(options.every((option) => option.includes(text)) || options.some((option) => option.includes(text)), `option text: ${text}`);
    }
    await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label") === "Dismiss recommendations", { timeout: 5000 }, "focus moves into the dialog");

    const revisionBeforeDismiss = await page.$eval(".pagehead .count", (el) => el.textContent ?? "");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => !document.querySelector(".trip-recs-layer"), { timeout: 5000 });
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), revisionBeforeDismiss, "dismissal leaves the document untouched");

    // Re-open via the presented panel state, then dismiss by button: no writes.
    const writesBeforeDismissSheet = writes.length;
    await clickTab("Overview");
    await clickTab("Day 1");
    await page.waitForSelector(".trip-planner", { timeout: 5000 });
    // The panel persists as page state; the drawer is closed after Escape, so
    // re-presenting (what an agent would do) reopens it.
    await presentOptions(tripId, dayId);
    await page.waitForSelector(".trip-recs", { timeout: 5000 });
    await page.click(".trip-recs-dismiss");
    await page.waitForFunction(() => !document.querySelector(".trip-recs-layer"), { timeout: 5000 });
    assert.equal(writes.length, writesBeforeDismissSheet, "dismissing the sheet performs no mutation");

    // Selecting one option is one human changeset and the stop appears.
    await presentOptions(tripId, dayId);
    await page.waitForSelector(".trip-recs", { timeout: 5000 });
    const writesBeforeSelect = writes.length;
    await page.evaluate(() => {
      const buttons = [...document.querySelectorAll<HTMLButtonElement>(".trip-rec .btn.primary")];
      buttons[1]!.click();
    });
    await page.waitForFunction(() => !document.querySelector(".trip-recs-layer"), { timeout: 5000 });
    assert.equal(writes.length, writesBeforeSelect + 1, "selection is exactly one changeset");
    await page.waitForFunction(() => [...document.querySelectorAll(".trip-stop-title")].some((el) => el.textContent === "Gion Kappa"), { timeout: 5000 });

    // Mobile: the sheet becomes a bottom sheet without horizontal overflow.
    await page.setViewport({ width: 320, height: 700 });
    await presentOptions(tripId, dayId);
    await page.waitForSelector(".trip-recs", { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      true,
      "no overflow at 320px with the sheet open",
    );

    assert.deepEqual(
      writes.filter((entry) => !entry.startsWith("POST /api/trips")),
      [],
      `unexpected writes: ${writes.join(", ")}`,
    );
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});
