import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTripChanges, createTrip } from "../server/trips/module.ts";
import { launchBrowser, setInput as harnessSetInput, startServer, tempDb, trackTraffic } from "./trips-browser-harness.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8813";


test("trips browser: share preview, publish, public page, update, and confirmed revoke", async () => {
  const database = tempDb("locus-trips-share-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  const AT = "2026-09-01T09:00:00.000Z";
  try {
    const page = await browser.newPage();
    const { external, writes } = trackTraffic(page, base);
    page.on("dialog", (dialog) => void dialog.accept());

    const setInput = (selector: string, value: string) => harnessSetInput(page, selector, value);
    const seedStop = (id: string, tripId: string, dayId: string, position: number, title: string) =>
      database
        .prepare(
          `INSERT INTO trip_stops (id, trip_id, day_id, position, content_json, state, provenance_json, public_notes, private_notes, time_window, duration_minutes, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?, ?, '09:00', 60, ?, ?)`,
        )
        .run(id, tripId, dayId, position, JSON.stringify({ kind: "outside", title, notes: null, url: null }), JSON.stringify({ actor: "user", via: "user" }), `Public note for ${title}`, `PRIVATE ${title}`, AT, AT);

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/trips/new`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-form input[required]", { timeout: 5000 });
    await setInput(".trip-form input[required]", "Kyoto shared");
    await setInput(".trip-when input[type='number']", "2");
    await page.click(".trip-form button[type='submit']");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    const tripId = (await page.evaluate(() => location.hash)).replace("#/trips/", "").replace(/\?.*$/, "");
    const days = database.prepare(`SELECT id FROM trip_days WHERE trip_id = ? ORDER BY position`).all(tripId) as { id: string }[];
    seedStop("stop-share-1", tripId, days[0]!.id, 0, "Fushimi Inari");

    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-detail-actions", { timeout: 5000 });

    // Preview shows the exact snapshot and no private note; cancel writes nothing.
    await page.$$eval(".trip-detail-actions .btn", (els) => {
      const share = els.find((el) => el.textContent === "Share");
      if (!share) throw new Error("no share button");
      (share as HTMLElement).click();
    });
    await page.waitForSelector(".trip-share-panel", { timeout: 5000 });
    assert.match(await page.$eval(".trip-share-panel", (el) => el.textContent ?? ""), /Fushimi Inari/);
    assert.doesNotMatch(await page.$eval(".trip-share-panel", (el) => el.textContent ?? ""), /PRIVATE Fushimi/);
    await page.$$eval(".trip-share-actions .btn", (els) => {
      const cancel = els.find((el) => el.textContent === "Cancel");
      if (!cancel) throw new Error("no cancel");
      (cancel as HTMLElement).click();
    });
    await page.waitForFunction(() => !document.querySelector(".trip-share-panel"), { timeout: 5000 });
    const writesBeforePublish = writes.length;

    // Publish mints a visible capability link.
    await page.$$eval(".trip-detail-actions .btn", (els) => {
      const share = els.find((el) => el.textContent === "Share");
      if (!share) throw new Error("no share button");
      (share as HTMLElement).click();
    });
    await page.waitForSelector(".trip-share-panel", { timeout: 5000 });
    await page.$eval(".trip-share-actions .btn.primary", (el) => (el as HTMLElement).click());
    await page.waitForSelector(".trip-share-link", { timeout: 5000 });
    const link = await page.$eval(".trip-share-link", (el) => (el as HTMLAnchorElement).href);
    assert.match(link, /\/s\/[A-Za-z0-9_-]{43,}$/);
    assert.match(await page.$eval(".trip-share-on", (el) => el.textContent ?? ""), /Shared · rev/);

    const pub = await fetch(link);
    assert.equal(pub.status, 200);
    const pubHtml = await pub.text();
    assert.match(pubHtml, /Fushimi Inari/);
    assert.match(pubHtml, /Public note for Fushimi Inari/);
    assert.ok(!pubHtml.includes("PRIVATE Fushimi"), "private notes never reach the public page");
    assert.ok(!pubHtml.includes("<script"), "public page ships no scripts");

    // The public page is not the app: no shell chrome, no WebMCP runtime.
    const publicPage = await browser.newPage();
    await publicPage.goto(link, { waitUntil: "networkidle0" });
    assert.equal(await publicPage.$(".tabs, .new-btn, .trip-nav"), null);
    assert.equal(await publicPage.evaluate(() => (document as { modelContext?: unknown }).modelContext), undefined);
    await publicPage.setViewport({ width: 320, height: 700 });
    assert.equal(
      await publicPage.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      true,
      "no overflow at 320px on the public page",
    );
    await publicPage.close();

    // A later private stop stays private until an explicit update; update
    // mints a new token and the old one dies.
    seedStop("stop-share-2", tripId, days[1]!.id, 0, "Day 2 stop");
    assert.ok(!(await (await fetch(link)).text()).includes("Day 2 stop"));
    await page.$$eval(".trip-detail-actions .btn", (els) => {
      const update = els.find((el) => el.textContent === "Update shared version");
      if (!update) throw new Error("no update button");
      (update as HTMLElement).click();
    });
    await page.waitForSelector(".trip-share-panel", { timeout: 5000 });
    await page.$eval(".trip-share-actions .btn.primary", (el) => (el as HTMLElement).click());
    await page.waitForFunction((old) => document.querySelector(".trip-share-link")?.getAttribute("href") !== old, { timeout: 5000 }, link);
    const link2 = await page.$eval(".trip-share-link", (el) => (el as HTMLAnchorElement).href);
    assert.notEqual(link2, link);
    assert.match(await (await fetch(link2)).text(), /Day 2 stop/);
    assert.equal((await fetch(link)).status, 404, "old token is dead after republish");

    // Revoke requires the confirm dialog and kills the link.
    await page.$$eval(".trip-detail-actions .btn", (els) => {
      const revoke = els.find((el) => el.textContent === "Revoke");
      if (!revoke) throw new Error("no revoke button");
      (revoke as HTMLElement).click();
    });
    await page.waitForFunction(() => !document.querySelector(".trip-share-on"), { timeout: 5000 });
    assert.equal((await fetch(link2)).status, 404);

    assert.deepEqual(
      writes.slice(writesBeforePublish).filter((entry) => !entry.startsWith("POST /api/trips")),
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

test("trips browser: export actions copy, print, and download without external requests", async () => {
  const database = tempDb("locus-trips-export-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const downloadDir = mkdtempSync(join(tmpdir(), "locus-trips-downloads-"));
  const browser = await launchBrowser();

  // Seed through the module seam: one timed stop with public + private notes,
  // a hole, an untimed stop on day 2, and one unscheduled stop.
  const trip = createTrip(
    database,
    "local",
    { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-13", timezone: "Asia/Tokyo", title: "Kyoto in October" },
    "2026-09-01T09:00:00.000Z",
  );
  const first = applyTripChanges(
    database,
    "local",
    trip.id,
    { expectedRevision: trip.revision, clientMutationId: "export-seed-1", operations: [{ type: "addStop", dayId: trip.days[0]!.id, content: { kind: "outside", title: "Fushimi Inari", notes: null, url: null }, timeWindow: "15:00-17:00" }] },
    "user",
  );
  assert.ok(first);
  const stopId = first.trip.days[0]!.stops[0]!.id;
  const seeded = applyTripChanges(
    database,
    "local",
    trip.id,
    {
      expectedRevision: first.trip.revision,
      clientMutationId: "export-seed-2",
      operations: [
        { type: "updateStop", stopId, publicNotes: "Go early", privateNotes: "PRIVATE-EXPORT-NOTE" },
        { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "hole", request: "quiet dinner" }, timeWindow: "19:30" },
        { type: "addStop", dayId: trip.days[1]!.id, content: { kind: "outside", title: "Nara deer park", notes: null, url: null } },
        { type: "addStop", dayId: null, content: { kind: "outside", title: "Kurama day trip", notes: null, url: null } },
      ],
    },
    "user",
  );
  assert.ok(seeded);

  try {
    const page = await browser.newPage();
    const { external, writes } = trackTraffic(page, base);
    try {
      await page.browserContext().overridePermissions(base, ["clipboard-read", "clipboard-write"]);
    } catch {
      /* older Chrome: the copy falls back to execCommand */
    }
    const downloads = await browser.target().createCDPSession();
    await downloads.send("Browser.setDownloadBehavior", { behavior: "allow", downloadPath: downloadDir });

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/trips/${trip.id}`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-export", { timeout: 5000 });
    assert.match(await page.$eval(".trip-export-projection", (el) => el.textContent ?? ""), /Current private revision \d+/);

    // Copy text: clipboard content keeps public notes and the hole marker,
    // never the private note.
    await page.click(".trip-export-copy");
    await page.waitForFunction(() => document.querySelector(".trip-export-notice")?.textContent?.includes("copied"), { timeout: 5000 });
    const copied = await page.evaluate(() => navigator.clipboard.readText().catch(() => null));
    if (copied !== null) {
      assert.match(copied, /Kyoto in October/);
      assert.match(copied, /15:00-17:00 Fushimi Inari/);
      assert.match(copied, /Open: quiet dinner/);
      assert.match(copied, /Unscheduled/);
      assert.ok(!copied.includes("PRIVATE-EXPORT-NOTE"));
    }

    // Print / PDF: the same document in a print-only frame, no app chrome.
    await page.click(".trip-export-print");
    await page.waitForSelector("iframe.trip-print-frame", { timeout: 5000 });
    const printDoc = await page.$eval("iframe.trip-print-frame", (el) => el.getAttribute("srcdoc") ?? "");
    assert.match(printDoc, /<title>Kyoto in October<\/title>/);
    assert.match(printDoc, /@media print/);
    assert.ok(!printDoc.includes("PRIVATE-EXPORT-NOTE"));
    assert.ok(!printDoc.includes('class="tabs"') && !printDoc.includes("+ New"), "no application chrome in the print view");

    // Downloads: self-contained HTML and a timezone-correct ICS.
    await page.click(".trip-export-html");
    await page.click(".trip-export-ics");
    const waitFile = async (suffix: string): Promise<string> => {
      for (let attempt = 0; attempt < 50; attempt += 1) {
        const file = readdirSync(downloadDir).find((name) => name.endsWith(suffix));
        if (file && statSync(join(downloadDir, file)).size > 20) return join(downloadDir, file);
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      throw new Error(`no ${suffix} download appeared`);
    };
    const htmlText = readFileSync(await waitFile(".html"), "utf8");
    assert.match(htmlText, /<title>Kyoto in October<\/title>/);
    assert.ok(!htmlText.includes("PRIVATE-EXPORT-NOTE"));
    assert.ok(!htmlText.includes("127.0.0.1") && !htmlText.includes("localhost"), "no Locus server dependency");

    const icsText = readFileSync(await waitFile(".ics"), "utf8");
    assert.match(icsText, /BEGIN:VCALENDAR/);
    assert.match(icsText, /X-WR-TIMEZONE:Asia\/Tokyo/);
    assert.match(icsText, /DTSTART:20261012T060000Z/, "15:00 Tokyo becomes 06:00Z");
    assert.match(icsText, /SUMMARY:Open: quiet dinner/);
    assert.match(icsText, /DTSTART;VALUE=DATE:20261013/, "untimed stop on a dated day is all-day");
    assert.match(icsText, /BEGIN:VJOURNAL/, "unscheduled content gets no invented time");
    assert.ok(!icsText.includes("PRIVATE-EXPORT-NOTE"));

    // Switching to the snapshot source is one same-origin preview and the
    // projection label changes before any export action.
    await page.click(".trip-export-source label:nth-of-type(2) input");
    await page.waitForFunction(() => document.querySelector(".trip-export-projection")?.textContent?.includes("Sanitized snapshot"), { timeout: 5000 });

    assert.equal(external.length, 0, "no external requests during export");
    assert.ok(writes.every((entry) => entry.startsWith("POST /api/trips/")), `writes stay on the trips seam: ${writes.join(", ")}`);
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});
