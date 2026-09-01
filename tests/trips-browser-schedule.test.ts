import { test } from "node:test";
import assert from "node:assert/strict";
import { applyTripChanges, getTrip } from "../server/trips/module.ts";
import { chooseAddSource, launchBrowser, setInput as harnessSetInput, startServer, tempDb, trackTraffic } from "./trips-browser-harness.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8821";


test("trips browser: day planner adds, keyboard-moves, unschedules, undoes, and keeps stops on refresh", async () => {
  const database = tempDb("locus-trips-browser-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    let inferenceCalls = 0;
    const { external, writes } = trackTraffic(page, base, { onInference: () => { inferenceCalls += 1; } });

    const setInput = (selector: string, value: string) => harnessSetInput(page, selector, value);
    const dayTitles = () => page.$$eval(".trip-day:not(.trip-unscheduled) .trip-stop-title", (els) => els.map((el) => el.textContent ?? ""));
    const unscheduledTitles = () => page.$$eval(".trip-unscheduled .trip-stop-title", (els) => els.map((el) => el.textContent ?? ""));
    const clickUndo = () =>
      page.$eval(".trip-undo", (el) => {
        const button = el as HTMLButtonElement;
        if (button.disabled) throw new Error("Undo is disabled");
        button.click();
      });
    const clickRedo = async () => {
      await page.$eval(".trip-history", (el) => {
        (el as HTMLDetailsElement).open = true;
      });
      await page.$eval(".trip-redo", (el) => {
        const button = el as HTMLButtonElement;
        if (button.disabled) throw new Error("Redo is disabled");
        button.click();
      });
    };
    const openFirstDay = async () => {
      await page.$$eval(".trip-nav a", (els) => {
        const tab = els.find((el) => el.textContent?.startsWith("Day 1"));
        if (!tab) throw new Error("no Day 1 tab");
        (tab as HTMLElement).click();
      });
      await page.waitForFunction(() => /view=/.test(location.hash), { timeout: 5000 });
    };

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/trips/new`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-form input[required]", { timeout: 5000 });
    await setInput(".trip-form input[required]", "Kochi food weekend");
    await setInput(".trip-when input[type='number']", "2");
    await page.click(".trip-form button[type='submit']");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    const writesAfterCreate = writes.length;
    await openFirstDay();
    await page.waitForSelector(".trip-empty-card", { timeout: 5000 });

    // The empty-day screen: deliberate, with manual actions and no agent call.
    const emptyActions = await page.$$eval(".trip-empty-actions button", (els) => els.map((el) => (el.textContent ?? "").trim()));
    assert.deepEqual(emptyActions, ["Add stop", "Ask agent for options"]);
    const focusedAdds = await page.$$eval(".trip-day.trip-day-open button", (els) =>
      els.map((el) => (el.textContent ?? "").trim()).filter((label) => label === "Add stop"),
    );
    assert.deepEqual(focusedAdds, ["Add stop"], "empty-day Add stop appears once");
    const headerAdds = await page.$$eval(".trip-day.trip-day-open .trip-day-head button", (els) =>
      els.map((el) => (el.textContent ?? "").trim()).filter((label) => label === "Add stop"),
    );
    assert.deepEqual(headerAdds, [], "empty-day header does not repeat Add stop");
    assert.deepEqual(
      await page.$$eval(".trip-unscheduled button", (els) => els.map((el) => (el.textContent ?? "").trim()).filter((label) => label === "Add stop")),
      ["Add stop"],
      "Unscheduled exposes one Add stop",
    );
    assert.match(await page.$eval(".trip-empty-card", (el) => el.textContent ?? ""), /Opening this day never starts inference/);
    assert.ok(await page.$(".trip-unscheduled"), "empty day surfaces Unscheduled");
    await page.$eval(".trip-empty-actions", (root) => {
      const ask = [...root.querySelectorAll<HTMLButtonElement>("button")].find((el) => el.textContent === "Ask agent for options");
      if (!ask) throw new Error("no Ask agent for options button");
      ask.click();
    });
    await page.waitForFunction(() => document.querySelector(".trip-live")?.textContent?.includes("No agent was called"), { timeout: 5000 });
    assert.equal(writes.length, writesAfterCreate, "opening the empty day and asking for opinions mutates nothing");

    // Add outside content to Day 1 through the unified dialog.
    let stopCount = 0;
    const addStop = async (title: string) => {
      stopCount += 1;
      await page.$$eval(".trip-day:not(.trip-unscheduled) button", (els) => {
        const button = els.find((el) => (el.textContent ?? "").trim() === "Add stop") as HTMLElement | undefined;
        if (!button) throw new Error("no Add stop button");
        button.click();
      });
      await chooseAddSource(page, "Add outside content");
      await page.waitForSelector(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", { timeout: 5000 });
      await setInput(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", title);
      await page.click(".trip-add-dialog button[type='submit']");
      await page.waitForFunction(
        (n) => document.querySelectorAll(".trip-stop-title").length >= n,
        { timeout: 5000 },
        stopCount,
      );
    };
    await addStop("Nishiki Market");
    await addStop("Kiyomizu-dera");
    await page.waitForFunction(() => document.querySelectorAll(".trip-day:not(.trip-unscheduled) .trip-stop-title").length === 2, { timeout: 5000 });
    assert.deepEqual(await dayTitles(), ["Nishiki Market", "Kiyomizu-dera"]);
    assert.equal(await page.$(".trip-stop-state"), null, "Confirmed cards have no persistent Confirmed pill");
    assert.equal(await page.$('[aria-label="Move Kiyomizu-dera up"]'), null, "no persistent Move up");
    assert.equal(await page.$('[aria-label="Move Kiyomizu-dera down"]'), null, "no persistent Move down");

    const handlePoint = (title: string) =>
      page.$eval(`[aria-label="Drag ${title} to reorder"]`, (el) => {
        const box = el.getBoundingClientRect();
        return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      });
    const rowPoint = (title: string, where: "before" | "after") =>
      page.$$eval(
        ".trip-day:not(.trip-unscheduled) .trip-stop",
        (els, wanted, edge) => {
          const row = els.find((el) => el.querySelector(".trip-stop-title")?.textContent === wanted);
          if (!row) throw new Error(`no ${wanted}`);
          const box = row.getBoundingClientRect();
          return { x: box.x + box.width / 2, y: edge === "before" ? box.y + 8 : box.y + box.height - 8 };
        },
        title,
        where,
      );
    const waitDayOrder = (order: string[]) =>
      page.waitForFunction(
        (wanted) =>
          JSON.stringify([...document.querySelectorAll(".trip-day:not(.trip-unscheduled) .trip-stop-title")].map((el) => el.textContent ?? "")) ===
          JSON.stringify(wanted),
        { timeout: 5000 },
        order,
      );

    // Pointer drag: second card onto the first. Same moveStop as keyboard/menu.
    const pointerFrom = await handlePoint("Kiyomizu-dera");
    const pointerTo = await rowPoint("Nishiki Market", "before");
    await page.mouse.move(pointerFrom.x, pointerFrom.y);
    await page.mouse.down();
    await page.mouse.move(pointerTo.x, pointerTo.y, { steps: 12 });
    await page.mouse.up();
    await waitDayOrder(["Kiyomizu-dera", "Nishiki Market"]);
    assert.equal(await page.$(".trip-stop-dialog[open]"), null, "pointer drag does not open details");
    assert.match(await page.$eval(".trip-live", (el) => el.textContent ?? ""), /Moved Kiyomizu-dera/);
    await clickUndo();
    await waitDayOrder(["Nishiki Market", "Kiyomizu-dera"]);

    // Touch drag uses the same handle and anchors.
    const touchFrom = await handlePoint("Kiyomizu-dera");
    const touchTo = await rowPoint("Nishiki Market", "before");
    const touch = await page.touchscreen.touchStart(touchFrom.x, touchFrom.y);
    await touch.move(touchTo.x, touchTo.y);
    await touch.end();
    await waitDayOrder(["Kiyomizu-dera", "Nishiki Market"]);
    await clickUndo();
    await waitDayOrder(["Nishiki Market", "Kiyomizu-dera"]);

    // Keyboard lift / move before / drop.
    await page.focus('[aria-label="Drag Kiyomizu-dera to reorder"]');
    await page.keyboard.press(" ");
    await page.waitForFunction(() => document.querySelector(".trip-live")?.textContent?.includes("Lifted Kiyomizu-dera"), { timeout: 5000 });
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press(" ");
    await waitDayOrder(["Kiyomizu-dera", "Nishiki Market"]);
    await clickUndo();
    await waitDayOrder(["Nishiki Market", "Kiyomizu-dera"]);

    // Escape cancels an active lift and writes nothing.
    const writesBeforeCancel = writes.length;
    await page.focus('[aria-label="Drag Kiyomizu-dera to reorder"]');
    await page.keyboard.press(" ");
    await page.waitForFunction(() => document.querySelector(".trip-live")?.textContent?.includes("Lifted Kiyomizu-dera"), { timeout: 5000 });
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".trip-live")?.textContent?.includes("Cancelled reordering Kiyomizu-dera"), { timeout: 5000 });
    assert.deepEqual(await dayTitles(), ["Nishiki Market", "Kiyomizu-dera"]);
    assert.equal(writes.length, writesBeforeCancel, "Escape writes nothing");
    await page.click('[aria-label="Drag Kiyomizu-dera to reorder"]');
    assert.equal(await page.$(".trip-stop-dialog[open]"), null, "drag handle click does not open details");

    // A stale write keeps the saved order and announces the failure.
    const tripId = await page.evaluate(() => location.hash.match(/trips\/([0-9a-f-]+)/)?.[1] ?? "");
    const snapshot = getTrip(database, "local", tripId)!;
    assert.ok(
      applyTripChanges(
        database,
        "local",
        tripId,
        {
          expectedRevision: snapshot.revision,
          clientMutationId: "stale-bump",
          operations: [{ type: "updateDay", dayId: snapshot.days[0]!.id, theme: "east" }],
        },
        "user",
      ),
    );
    await page.focus('[aria-label="Drag Kiyomizu-dera to reorder"]');
    await page.keyboard.press(" ");
    await page.keyboard.press("ArrowUp");
    await page.keyboard.press(" ");
    await page.waitForSelector(".bad", { timeout: 5000 });
    assert.match(await page.$eval(".bad", (el) => el.textContent ?? ""), /revision/);
    assert.deepEqual(await dayTitles(), ["Nishiki Market", "Kiyomizu-dera"]);
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-planner", { timeout: 5000 });
    await waitDayOrder(["Nishiki Market", "Kiyomizu-dera"]);

    // Menu Place before is the non-drag keyboard fallback.
    await page.click('[aria-label="Actions for Kiyomizu-dera"]');
    await page.focus('[aria-label="Place Kiyomizu-dera before Nishiki Market"]');
    await page.keyboard.press("Enter");
    await waitDayOrder(["Kiyomizu-dera", "Nishiki Market"]);

    // Move to Unscheduled through the stop's contextual menu.
    await page.click('[aria-label="Actions for Kiyomizu-dera"]');
    await page.click('[aria-label="Move Kiyomizu-dera to Unscheduled"]');
    await page.waitForFunction(() => document.querySelector(".trip-unscheduled .trip-stop-title")?.textContent === "Kiyomizu-dera", { timeout: 5000 });
    assert.deepEqual(await dayTitles(), ["Nishiki Market"]);
    assert.deepEqual(await unscheduledTitles(), ["Kiyomizu-dera"]);
    assert.match(await page.$eval(".trip-live", (el) => el.textContent ?? ""), /Moved Kiyomizu-dera to Unscheduled/);

    // Undo and Redo as complete actions.
    await clickUndo();
    await page.waitForFunction(() => document.querySelectorAll(".trip-unscheduled .trip-stop-title").length === 0, { timeout: 5000 });
    assert.deepEqual(await dayTitles(), ["Kiyomizu-dera", "Nishiki Market"]);
    await clickRedo();
    await page.waitForFunction(() => document.querySelector(".trip-unscheduled .trip-stop-title")?.textContent === "Kiyomizu-dera", { timeout: 5000 });

    // History lists the changesets with actor and time.
    await page.$eval(".trip-history", (el) => {
      (el as HTMLDetailsElement).open = true;
    });
    await page.waitForSelector(".trip-history-list li", { timeout: 5000 });
    const historyRows = await page.$$eval(".trip-history-list li", (els) => els.map((el) => el.textContent ?? ""));
    assert.ok(historyRows.length >= 5, "history covers every changeset");
    assert.ok(historyRows.some((row) => row.includes("user")), "history shows the actor");
    assert.ok(historyRows.some((row) => row.includes("Undo")), "undo rows are auditable");

    // Refresh keeps the exact arrangement.
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-planner", { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll(".trip-stop-title").length === 2, { timeout: 5000 });
    assert.deepEqual(await dayTitles(), ["Nishiki Market"]);
    assert.deepEqual(await unscheduledTitles(), ["Kiyomizu-dera"]);

    assert.equal(inferenceCalls, 0);
    assert.deepEqual(external, []);
    assert.ok(
      writes.every((entry) => entry.startsWith("POST /api/trips")),
      `unexpected writes: ${writes.join(", ")}`,
    );
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});

test("trips browser: overview, empty-day screen, schedule projections stay consistent with one document", async () => {
  const database = tempDb("locus-trips-browser-views-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    let inferenceCalls = 0;
    const { external, writes } = trackTraffic(page, base, { onInference: () => { inferenceCalls += 1; } });

    const setInput = (selector: string, value: string) => harnessSetInput(page, selector, value);
    const clickTab = async (label: string) => {
      await page.$$eval(
        ".trip-nav a",
        (els, wanted) => {
          const tab = els.find((el) => el.textContent?.startsWith(wanted));
          if (!tab) throw new Error(`no ${wanted} tab`);
          (tab as HTMLElement).click();
        },
        label,
      );
      await page.waitForFunction(() => /view=/.test(location.hash), { timeout: 5000 });
    };
    const addStop = async (title: string, timeWindow: string | null) => {
      await page.$$eval(".trip-day:not(.trip-unscheduled) button", (els) => {
        const button = els.find((el) => (el.textContent ?? "").trim() === "Add stop") as HTMLElement | undefined;
        if (!button) throw new Error("no Add stop button");
        button.click();
      });
      await chooseAddSource(page, "Add outside content");
      await page.waitForSelector(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", { timeout: 5000 });
      await setInput(".trip-add-dialog input[placeholder='e.g. Nishiki Market']", title);
      if (timeWindow) await setInput(".trip-add-dialog input[placeholder='e.g. 09:00–11:00']", timeWindow);
      await page.click(".trip-add-dialog button[type='submit']");
      await page.waitForFunction(
        (name) => [...document.querySelectorAll(".trip-stop-title")].some((el) => el.textContent === name),
        { timeout: 5000 },
        title,
      );
    };

    await page.emulateMediaFeatures([{ name: "prefers-reduced-motion", value: "reduce" }]);
    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/trips/new`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-form input[required]", { timeout: 5000 });
    await setInput(".trip-form input[required]", "Kyoto projections");
    const dateInputs = await page.$$(".trip-when input[type='date']");
    await dateInputs[0]!.evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, "2026-10-12");
    await dateInputs[1]!.evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, "2026-10-14");
    await setInput('input[list="trip-timezones"]', "Asia/Tokyo");
    await page.click(".trip-form button[type='submit']");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    const writesAfterCreate = writes.length;

    // Opening the document performed no mutation; the nav marks Overview current.
    assert.equal(writes.length, writesAfterCreate);
    assert.equal(await page.$eval(".trip-nav a[href$='view=overview']", (el) => el.getAttribute("aria-current")), "true");
    assert.match(await page.$eval(".trip-overview", (el) => el.textContent ?? ""), /Add first stop/);
    assert.match(await page.$eval(".trip-overview", (el) => el.textContent ?? ""), /Nothing is generated until you ask/);
    assert.equal(await page.$(".health-item"), null, "new empty trip does not start with health stats");

    // Day 1: two overlapping timed stops and one untimed stop.
    await clickTab("Day 1");
    await page.waitForSelector(".trip-empty-card", { timeout: 5000 });
    await addStop("Fushimi Inari", "09:00–11:00");
    await addStop("Weekenders Coffee", "10:00–12:00");
    await addStop("Gion walk", null);
    assert.deepEqual(
      await page.$$eval(".trip-day:not(.trip-unscheduled) .trip-stop-title", (els) => els.map((el) => el.textContent ?? "")),
      ["Fushimi Inari", "Weekenders Coffee", "Gion walk"],
    );

    // Overview reflects the same document: health, time range, anchors, conflict.
    await clickTab("Overview");
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    const health = await page.$$eval(".health-item", (els) => els.map((el) => el.textContent ?? ""));
    assert.ok(health.some((item) => item.includes("Stops") && item.includes("3")), health.join(" | "));
    assert.ok(health.some((item) => item.includes("Empty days") && item.includes("2")), health.join(" | "));
    assert.ok(health.some((item) => item.includes("Overlaps") && item.includes("1")), health.join(" | "));
    const day1Card = await page.$eval(".trip-day-card", (el) => el.textContent ?? "");
    assert.match(day1Card, /3 stops/);
    assert.match(day1Card, /09:00–12:00/);
    assert.match(day1Card, /Fushimi Inari/);
    assert.match(day1Card, /Gion walk/);
    assert.match(day1Card, /overlaps/);
    const emptyCards = await page.$$eval(".trip-day-card-empty", (els) => els.map((el) => el.textContent ?? ""));
    assert.equal(emptyCards.length, 2);
    assert.ok(emptyCards.every((card) => card.includes("Open day")), "empty cards look and read differently");

    // An empty day card opens the empty-day screen; opening performs no POST.
    const writesBeforeEmpty = writes.length;
    await page.$$eval(".trip-day-card-empty .trip-day-card-open", (els) => {
      const link = els.find((el) => el.textContent?.includes("Plan this day")) as HTMLElement | undefined;
      if (!link) throw new Error("no Plan this day link");
      link.click();
    });
    await page.waitForSelector(".trip-empty-card", { timeout: 5000 });
    assert.match(await page.$eval(".trip-empty-card", (el) => el.textContent ?? ""), /Opening this day never starts inference/);
    assert.ok(await page.$(".trip-unscheduled"), "Unscheduled stays visible alongside the empty day");
    assert.equal(writes.length, writesBeforeEmpty, "opening an empty day mutates nothing");

    // Day 2 gets one untimed stop; the schedule must keep it honest.
    await addStop("Afternoon tea", null);
    await clickTab("Schedule");
    await page.waitForSelector(".trip-schedule", { timeout: 5000 });
    assert.equal(await page.$eval(".trip-schedule-tz", (el) => el.textContent ?? ""), "All times are Asia/Tokyo.");
    const rows = await page.$$eval(".trip-calendar-time", (els) => els.map((el) => el.textContent ?? ""));
    assert.deepEqual(rows, ["09:00", "10:00"], "rows come only from real stop times");
    const events = await page.$$eval(".trip-calendar-event", (els) => els.map((el) => el.textContent ?? ""));
    assert.ok(events.some((event) => event.includes("Fushimi Inari") && event.includes("09:00–11:00")), events.join(" | "));
    assert.ok(events.every((event) => !event.includes("Afternoon tea")), "untimed stops never receive an invented row");
    assert.match(await page.$eval(".trip-schedule-loose", (el) => el.textContent ?? ""), /Day 2 untimed: Afternoon tea/);
    assert.equal(await page.$eval(".trip-nav a[href$='view=schedule']", (el) => el.getAttribute("aria-current")), "true");

    // Editing through the day planner updates Overview immediately.
    await clickTab("Day 3");
    await page.waitForSelector(".trip-empty-card", { timeout: 5000 });
    await addStop("Evening walk", null);
    await clickTab("Overview");
    await page.waitForFunction(
      () => document.querySelectorAll(".trip-day-card")[2]?.textContent?.includes("1 stop"),
      { timeout: 5000 },
    );
    const healthAfter = await page.$$eval(".health-item", (els) => els.map((el) => el.textContent ?? ""));
    assert.ok(healthAfter.some((item) => item.includes("Stops") && item.includes("5")), healthAfter.join(" | "));
    assert.ok(healthAfter.some((item) => item.includes("Empty days") && item.includes("0")), healthAfter.join(" | "));

    // Mobile: projections stay one-column without horizontal overflow.
    await page.setViewport({ width: 320, height: 800 });
    await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-row", { timeout: 5000 });
    await page.click(".trip-row");
    await page.waitForSelector(".trip-overview", { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      true,
      "no overflow at 320px on overview",
    );
    await page.click(".trip-nav a[href$='view=schedule']");
    await page.waitForSelector(".trip-schedule", { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      true,
      "no overflow at 320px on schedule",
    );

    // Reduced motion is already emulated for this page; the projections rendered fine.
    assert.ok(await page.$(".trip-nav"));

    assert.equal(inferenceCalls, 0);
    assert.deepEqual(external, []);
    assert.ok(writes.every((entry) => entry.startsWith("POST /api/trips")), `unexpected writes: ${writes.join(", ")}`);
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});
