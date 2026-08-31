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
        { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "outside", title: "Fushimi Inari", notes: null, url: null }, timeWindow: "09:00-11:00" },
        { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "outside", title: "Gion walk", notes: null, url: null }, timeWindow: "15:00-17:00" },
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
        els.map((el) => (el.textContent ?? "").trim()).filter((label) => label === "Add from Library" || label === "Add a placeholder"),
      );

    for (const width of [1440, 768, 320] as const) {
      await page.setViewport({ width, height: 900 });
      await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-row", { timeout: 5000 });
      const indexCols = await page.$eval(".trips-root", (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
      assert.equal(indexCols, width >= 1100 ? 2 : 1, `index columns at ${width}px`);
      if (width === 320) assert.equal(await noDocOverflow(), true, "index does not overflow at 320px");
      await page.screenshot({ path: join(shotDir, `index-${width}.png`), fullPage: true });

      await page.goto(`${base}/#/trips/${trip.id}?view=overview`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-overview", { timeout: 5000 });
      if (width === 320) assert.equal(await noDocOverflow(), true, "overview does not overflow at 320px");
      await page.screenshot({ path: join(shotDir, `overview-${width}.png`), fullPage: true });

      await page.goto(`${base}/#/trips/${trip.id}?view=${emptyDayId}`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-empty-card", { timeout: 5000 });
      assert.deepEqual(await emptyDayAdds(), ["Add from Library", "Add a placeholder"], `one empty-day action group at ${width}px`);
      assert.deepEqual(
        await page.$$eval(".trip-empty-actions button", (els) => els.map((el) => (el.textContent ?? "").trim())),
        ["Add from Library", "Add a placeholder", "Ask for three opinions"],
      );
      const headerAdds = await page.$$eval(".trip-day.trip-day-open .trip-day-head button", (els) =>
        els.map((el) => (el.textContent ?? "").trim()),
      );
      assert.equal(headerAdds.includes("Add from Library"), false);
      assert.equal(headerAdds.includes("Add a placeholder"), false);
      if (width === 320) assert.equal(await noDocOverflow(), true, "empty day does not overflow at 320px");
      await page.screenshot({ path: join(shotDir, `empty-day-${width}.png`), fullPage: true });

      await page.goto(`${base}/#/trips/${trip.id}?view=schedule`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-calendar-row", { timeout: 5000 });
      const tracks = await page.$eval(".trip-calendar-row", (el) => getComputedStyle(el).gridTemplateColumns.trim().split(/\s+/).length);
      assert.equal(tracks, 1 + trip.days.length, `--trip-day-count columns at ${width}px`);
      if (width === 320) assert.equal(await noDocOverflow(), true, "schedule does not overflow at 320px");
      await page.screenshot({ path: join(shotDir, `schedule-${width}.png`), fullPage: true });
    }
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});
