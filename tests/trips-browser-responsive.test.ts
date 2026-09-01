import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { applyTripChanges, createTrip } from "../server/trips/module.ts";
import { blockExternal, launchBrowser, startServer, tempDb } from "./trips-browser-harness.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8814";


test("trips browser: empty-day actions are unique and layouts hold at 1440, tablet, and 320", async () => {
  const database = tempDb("locus-trips-responsive-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const shotDir = join(".scratch/trips/shots");
  mkdirSync(shotDir, { recursive: true });
  const browser = await launchBrowser();

  const emptyTrip = createTrip(
    database,
    "local",
    { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-14", timezone: "Asia/Tokyo", title: "Kyoto trip" },
    "2026-09-01T09:00:00.000Z",
  );
  const trip = createTrip(
    database,
    "local",
    { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-14", timezone: "Asia/Tokyo", title: "Kyoto alignment" },
    "2026-09-01T09:00:00.000Z",
  );
  const seeded = applyTripChanges(
    database,
    "local",
    trip.id,
    {
      expectedRevision: trip.revision,
      clientMutationId: "responsive-seed",
      operations: [
        { type: "updateDay", dayId: trip.days[0]!.id, theme: "East Kyoto" },
        { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "outside", title: "Fushimi Inari", notes: null, url: null }, timeWindow: "09:00-11:00", durationMinutes: 120 },
        {
          type: "addStop",
          dayId: trip.days[0]!.id,
          content: { kind: "outside", title: "Quiet lunch near Gion", notes: null, url: null },
          timeWindow: "12:30-14:00",
          state: "draft",
        },
        { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "outside", title: "Gion walk", notes: null, url: null }, timeWindow: "15:00-17:00", durationMinutes: 120 },
        { type: "addStop", dayId: null, content: { kind: "hole", request: "Dinner near the hotel" } },
      ],
    },
    "user",
  );
  assert.ok(seeded);
  const emptyDayId = trip.days[1]!.id;

  try {
    const page = await browser.newPage();
    blockExternal(page, base);

    const noDocOverflow = () =>
      page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
    const emptyDayAdds = () =>
      page.$$eval(".trip-day.trip-day-open button", (els) =>
        els.map((el) => (el.textContent ?? "").trim()).filter((label) => label === "Add stop"),
      );

    for (const width of [1440, 768, 320] as const) {
      await page.setViewport({ width, height: 900 });
      await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-row", { timeout: 5000 });
      const indexCols = await page.$eval(".trips-root", (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      assert.equal(indexCols, width >= 1100 ? 2 : 1, `index columns at ${width}px`);
      assert.equal(await noDocOverflow(), true, `index does not overflow at ${width}px`);
      await page.screenshot({ path: join(shotDir, `index-${width}.png`), fullPage: true });

      await page.goto(`${base}/#/trips/${emptyTrip.id}?view=overview`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-empty-trip", { timeout: 5000 });
      assert.match(await page.$eval(".trip-empty-trip", (el) => el.textContent ?? ""), /Add first stop/);
      assert.match(await page.$eval(".trip-empty-trip", (el) => el.textContent ?? ""), /Nothing is generated until you ask/);
      assert.equal(await page.$(".health-item"), null, "empty trip has no health stats");
      assert.equal(await noDocOverflow(), true, `empty trip does not overflow at ${width}px`);
      await page.screenshot({ path: join(shotDir, `empty-trip-${width}.png`), fullPage: true });

      await page.goto(`${base}/#/trips/${trip.id}?view=overview`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-overview", { timeout: 5000 });
      assert.equal(await noDocOverflow(), true, `overview does not overflow at ${width}px`);
      await page.screenshot({ path: join(shotDir, `overview-${width}.png`), fullPage: true });

      await page.goto(`${base}/#/trips/${trip.id}?view=${emptyDayId}`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-empty-card", { timeout: 5000 });
      assert.deepEqual(await emptyDayAdds(), ["Add stop"], `one empty-day Add stop at ${width}px`);
      assert.deepEqual(
        await page.$$eval(".trip-empty-actions button", (els) => els.map((el) => (el.textContent ?? "").trim())),
        ["Add stop", "Ask agent for options"],
      );
      const headerAdds = await page.$$eval(".trip-day.trip-day-open .trip-day-head button", (els) =>
        els.map((el) => (el.textContent ?? "").trim()),
      );
      assert.equal(headerAdds.includes("Add stop"), false);
      assert.equal(await page.$eval(".trip-unscheduled", (el) => el.tagName), "DETAILS");
      assert.match(await page.$eval(".trip-unscheduled", (el) => el.textContent ?? ""), /Dinner near the hotel/);
      await page.$eval(".trip-unscheduled", (el) => {
        (el as HTMLDetailsElement).open = true;
      });
      assert.equal(await noDocOverflow(), true, `empty day does not overflow at ${width}px`);
      if (width === 320) {
        await page.$eval(".trip-empty-actions button", (el) => (el as HTMLButtonElement).click());
        await page.waitForSelector(".trip-add-dialog[open]", { timeout: 5000 });
        assert.equal(await noDocOverflow(), true, "add dialog does not overflow at 320px");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector(".trip-add-dialog"), { timeout: 5000 });
      }
      await page.screenshot({ path: join(shotDir, `empty-day-${width}.png`), fullPage: true });

      await page.goto(`${base}/#/trips/${trip.id}?view=${trip.days[0]!.id}`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-stop", { timeout: 5000 });
      assert.equal(await page.$eval(".trip-planner-title", (el) => el.textContent ?? ""), "Day 1");
      assert.equal(await page.$(".trip-day-theme"), null, "theme is not duplicated as a sibling label");
      assert.equal(await page.$$eval(".trip-day-theme-edit input", (els) => els.length), 1);
      assert.equal(await page.$eval(".trip-day-theme-edit input", (el) => (el as HTMLInputElement).value), "East Kyoto");
      assert.deepEqual(
        await page.$$eval(".trip-day:not(.trip-unscheduled) .trip-stop-title", (els) => els.map((el) => el.textContent ?? "")),
        ["Fushimi Inari", "Quiet lunch near Gion", "Gion walk"],
      );
      assert.ok(await page.$(".trip-stop-draft .trip-stop-state-draft"));
      assert.equal(await page.$(".trip-stop-state:not(.trip-stop-state-draft)"), null, "Confirmed has no pill");
      assert.equal(await page.$('[aria-label="Move Fushimi Inari up"]'), null, "no exposed arrow pair");
      assert.equal(await page.$$eval(".trip-day:not(.trip-unscheduled) .trip-add-btn", (els) => els.length), 1);
      assert.equal((await page.$eval(".trip-history summary", (el) => el.textContent ?? "")).trim(), "Activity and recovery");
      assert.equal(await noDocOverflow(), true, `planned day does not overflow at ${width}px`);
      await page.screenshot({ path: join(shotDir, `planned-${width}.png`), fullPage: true });
      if (width === 320) {
        const drag = await page.$eval('[aria-label="Drag Fushimi Inari to reorder"]', (el) => {
          const box = el.getBoundingClientRect();
          return { width: box.width, height: box.height };
        });
        assert.ok(drag.width >= 44 && drag.height >= 44, `drag handle ${drag.width}x${drag.height} at 320px`);
        await page.click('[aria-label="Actions for Gion walk"]');
        assert.ok(await page.$('[aria-label="Place Gion walk before Quiet lunch near Gion"]'));
        assert.ok(await page.$('[aria-label="Move Gion walk to Unscheduled"]'));
        assert.equal(await noDocOverflow(), true, "reorder menu does not overflow at 320px");
        await page.click('[aria-label="Actions for Gion walk"]');
        await page.emulateMediaFeatures([
          { name: "prefers-reduced-motion", value: "reduce" },
          { name: "prefers-color-scheme", value: "dark" },
        ]);
        await page.evaluate(() => {
          document.documentElement.dataset.theme = "dark";
        });
        const draftBorder = await page.$eval(".trip-stop-draft", (el) => getComputedStyle(el).borderTopStyle);
        assert.equal(draftBorder, "dashed");
        await page.click('[aria-label="Open details for Fushimi Inari"]');
        await page.waitForSelector(".trip-stop-dialog[open]", { timeout: 5000 });
        assert.equal(await noDocOverflow(), true, "stop details do not overflow at 320px");
        await page.keyboard.press("Escape");
        await page.waitForFunction(() => !document.querySelector(".trip-stop-dialog"), { timeout: 5000 });
      }

      await page.goto(`${base}/#/trips/${trip.id}?view=schedule`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-calendar-row", { timeout: 5000 });
      const tracks = await page.$eval(".trip-calendar-row", (el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
      assert.equal(tracks, 1 + trip.days.length, `--trip-day-count columns at ${width}px`);
      assert.equal(await noDocOverflow(), true, `schedule does not overflow at ${width}px`);
      await page.screenshot({ path: join(shotDir, `schedule-${width}.png`), fullPage: true });
    }
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});
