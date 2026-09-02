import { test } from "node:test";
import assert from "node:assert/strict";
import { launchBrowser, setInput as harnessSetInput, startServer, tempDb, trackTraffic } from "./trips-browser-harness.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8810";


test("trips browser: nav, + New menu, routes, no mutation", async () => {
  const database = tempDb("locus-trips-browser-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const { external, writes } = trackTraffic(page, base);

    const text = (selector: string) => page.$eval(selector, (el) => (el.textContent ?? "").trim());
    const hash = () => page.evaluate(() => location.hash);
    const waitPage = (target: string, tab: string) =>
      page.waitForFunction(
        (value, tabHref) =>
          location.hash === value && document.querySelector(`.tabs a[href="${tabHref}"]`)?.getAttribute("aria-current") === "page",
        { timeout: 5000 },
        target,
        tab,
      );
    const current = (href: string) =>
      page.$eval(`.tabs a[href="${href}"]`, (el) => el.getAttribute("aria-current"));

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/recent`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".tabs", { timeout: 5000 });

    const tabs = await page.$$eval(".tabs a", (els) => els.map((el) => ({ href: el.getAttribute("href"), label: (el.textContent ?? "").trim() })));
    assert.deepEqual(
      tabs.map((tab) => tab.href),
      ["#/recent", "#/kitchen", "#/atlas", "#/trips", "#/reading", "#/account"],
    );
    assert.ok(tabs.some((tab) => tab.label.startsWith("Trips")));
    assert.equal(await current("#/recent"), "page");
    assert.equal(await current("#/trips"), null);
    assert.equal(await text(".new-btn"), "+ New");

    await page.click(".tabs a[href='#/trips']");
    await page.waitForSelector(".trips h1", { timeout: 5000 });
    assert.equal(await hash(), "#/trips");
    assert.equal(await text(".trips h1"), "Trips");
    assert.equal(await current("#/trips"), "page");
    assert.equal(await current("#/recent"), null);
    await page.waitForFunction(() => document.querySelector(".empty")?.textContent?.includes("No Trip Documents yet"), { timeout: 5000 });
    assert.match(await text(".empty"), /No Trip Documents yet/);
    assert.equal(await text(".trips-tools .btn.primary"), "Plan a trip");
    assert.ok(await page.$(".trips-rail"));
    assert.equal(await page.$(".trips-overlay, .scratch-pad"), null);

    await page.click(".trips-tools .btn.primary");
    await waitPage("#/trips/new", "#/trips");
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Plan a trip", { timeout: 5000 });
    assert.equal(await current("#/trips"), "page");

    await page.goBack();
    await waitPage("#/trips", "#/trips");
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Trips", { timeout: 5000 });

    await page.goBack();
    await waitPage("#/recent", "#/recent");
    await page.waitForSelector(".desk, .wall, .rail", { timeout: 5000 });
    assert.equal(await current("#/recent"), "page");

    await page.goForward();
    await waitPage("#/trips", "#/trips");
    await page.waitForSelector(".trips h1", { timeout: 5000 });

    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".trips h1", { timeout: 5000 });
    assert.equal(await hash(), "#/trips");
    assert.equal(await text(".trips h1"), "Trips");

    await page.evaluate(() => {
      location.hash = "#/trips/demo-trip";
    });
    await waitPage("#/trips/demo-trip", "#/trips");
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Trip Document", { timeout: 5000 });
    assert.equal(await current("#/trips"), "page");
    await page.goBack();
    await waitPage("#/trips", "#/trips");

    await page.click(".new-btn");
    await page.waitForSelector(".new-menu", { timeout: 5000 });
    assert.equal(await page.$eval(".new-btn", (el) => el.getAttribute("aria-expanded")), "true");
    const items = await page.$$eval(".new-menu [role='menuitem']", (els) =>
      els.map((el) => ({ href: el.getAttribute("href"), label: el.querySelector("b")?.textContent })),
    );
    assert.deepEqual(items, [
      { href: "#/trips/new", label: "Plan a trip" },
      { href: "#/save", label: "Save a link" },
      { href: "#/kitchen", label: "Make a saved dish cookable" },
    ]);
    assert.equal(
      await page.evaluate(() => document.activeElement?.getAttribute("href")),
      "#/trips/new",
    );

    await page.keyboard.press("Escape");
    await page.waitForFunction(() => document.querySelector(".new-menu") === null, { timeout: 5000 });
    assert.equal(await page.$eval(".new-btn", (el) => el.getAttribute("aria-expanded")), "false");
    assert.equal(await page.evaluate(() => (document.activeElement as HTMLElement | null)?.classList.contains("new-btn")), true);
    assert.equal(await hash(), "#/trips");

    await page.click(".new-btn");
    await page.waitForSelector(".new-menu", { timeout: 5000 });
    await page.click(".wordmark");
    await page.waitForFunction(() => document.querySelector(".new-menu") === null, { timeout: 5000 });

    await page.focus(".new-btn");
    await page.keyboard.press("Enter");
    await page.waitForSelector(".new-menu", { timeout: 5000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("href") === "#/trips/new", { timeout: 5000 });
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      () => location.hash === "#/save" && Boolean(document.querySelector("dialog.save-link[open]")),
      { timeout: 5000 },
    );
    await page.waitForFunction(() => document.querySelector(".new-menu") === null, { timeout: 5000 });
    assert.equal(await current("#/recent"), "page");
    await page.keyboard.press("Escape");
    await page.waitForFunction(() => location.hash === "#/recent" && !document.querySelector("dialog.save-link"), { timeout: 5000 });

    await page.click(".new-btn");
    await page.waitForSelector(".new-menu", { timeout: 5000 });
    await page.click(".new-menu [href='#/kitchen']");
    await waitPage("#/kitchen", "#/kitchen");
    await page.waitForSelector("h1", { timeout: 5000 });
    assert.equal(await text("h1"), "Kitchen");
    assert.equal(await current("#/kitchen"), "page");

    await page.click(".new-btn");
    await page.waitForSelector(".new-menu", { timeout: 5000 });
    await page.click(".new-menu [href='#/trips/new']");
    await waitPage("#/trips/new", "#/trips");
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Plan a trip", { timeout: 5000 });

    await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".new-btn", { timeout: 5000 });
    await page.click(".new-btn");
    await page.waitForSelector(".new-menu", { timeout: 5000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("href") === "#/trips/new", { timeout: 5000 });
    await page.keyboard.press("End");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "#/kitchen");
    await page.keyboard.press("Home");
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), "#/trips/new");
    await page.keyboard.press(" ");
    await waitPage("#/trips/new", "#/trips");
    await page.waitForFunction(() => document.querySelector(".new-menu") === null, { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Plan a trip", { timeout: 5000 });

    await page.setViewport({ width: 320, height: 800 });
    await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trips h1", { timeout: 5000 });
    assert.ok(await page.$(".new-btn"));
    await page.click(".new-btn");
    await page.waitForSelector(".new-menu", { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      true,
      "no overflow at 320px with + New open",
    );
    await page.keyboard.press("Escape");

    assert.deepEqual(writes, []);
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});

test("trips browser: create a Trip Document, reopen it, and refresh keeps it", async () => {
  const database = tempDb("locus-trips-browser-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    let inferenceCalls = 0;
    const { external, writes } = trackTraffic(page, base, { onInference: () => { inferenceCalls += 1; } });

    const text = (selector: string) => page.$eval(selector, (el) => (el.textContent ?? "").trim());
    const hash = () => page.evaluate(() => location.hash);
    const waitHash = (target: string) => page.waitForFunction((value) => location.hash === value, { timeout: 5000 }, target);

    // React controlled inputs need the native value setter + input event.
    const setInput = (selector: string, value: string) => harnessSetInput(page, selector, value);

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector(".empty")?.textContent?.includes("No Trip Documents yet"), { timeout: 5000 });

    // Empty state CTA opens the setup flow.
    await page.click(".trips-tools .btn.primary");
    await waitHash("#/trips/new");
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Plan a trip", { timeout: 5000 });

    // Required setup only: destination + date range. No optional answers.
    await setInput(".trip-form input[required]", "Kyoto, Japan");
    const dateInputs = await page.$$(".trip-when input[type='date']");
    await dateInputs[0]!.evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, "2026-10-12");
    await dateInputs[1]!.evaluate((el, v) => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, v);
      el.dispatchEvent(new Event("input", { bubbles: true }));
    }, "2026-10-15");
    await page.click(".trip-form button[type='submit']");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    const kyotoHash = await hash();
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kyoto, Japan", { timeout: 5000 });
    assert.equal(await text(".trip-facts dd"), "Kyoto, Japan");
    // The document opens on Overview as a new empty trip: Add first stop, days in the nav.
    await page.waitForSelector(".trip-empty-trip", { timeout: 5000 });
    assert.match(await page.$eval(".trip-empty-trip", (el) => el.textContent ?? ""), /Add first stop/);
    const dayTabs = await page.$$eval(".trip-nav a", (els) => els.map((el) => (el.textContent ?? "").trim()).filter((label) => label.startsWith("Day")));
    assert.equal(dayTabs.length, 4);
    dayTabs.forEach((rendered, index) => {
      assert.ok(rendered.includes(`Day ${index + 1}`), rendered);
      assert.ok(rendered.includes(String(12 + index)), rendered);
    });
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 1");

    // Refresh restores the same document from its stable route.
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kyoto, Japan", { timeout: 5000 });
    assert.equal(await hash(), kyotoHash);

    // The index lists the trip; the whole row is the link.
    await page.click(".trips-pagehead a[href='#/trips']");
    await waitHash("#/trips");
    await page.waitForSelector(".trip-row", { timeout: 5000 });
    const rows = await page.$$eval("a.trip-row", (els) => els.map((el) => ({ href: el.getAttribute("href"), text: el.textContent ?? "" })));
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.href, kyotoHash);
    assert.match(rows[0]!.text, /Kyoto, Japan/);
    assert.match(rows[0]!.text, /4 days/);
    assert.equal(await page.$eval("a.trip-row", (el) => el.tagName), "A", "whole row is one link, no separate Open button");

    // Clicking the row reopens the document; Back returns to the index.
    await page.click("a.trip-row");
    await waitHash(kyotoHash);
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kyoto, Japan", { timeout: 5000 });
    await page.goBack();
    await waitHash("#/trips");
    await page.waitForSelector(".trip-row", { timeout: 5000 });

    // A duration-only trip is honest about open dates.
    await page.goto(`${base}/#/trips/new`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trip-form input[required]", { timeout: 5000 });
    await setInput(".trip-form input[required]", "Kochi food weekend");
    await setInput(".trip-when input[type='number']", "3");
    await page.click(".trip-form button[type='submit']");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kochi food weekend", { timeout: 5000 });
    await page.waitForSelector(".trip-empty-trip", { timeout: 5000 });
    const openTabs = await page.$$eval(".trip-nav a", (els) => els.map((el) => (el.textContent ?? "").trim()).filter((label) => label.startsWith("Day")));
    assert.equal(openTabs.length, 3);
    assert.ok(openTabs.every((rendered) => !rendered.includes("Oct")), "duration-only days stay honestly open");
    assert.match(await page.$eval(".trip-facts", (el) => el.textContent ?? ""), /3 days · dates open/);

    // Direct navigation to a foreign id stays a clean missing state.
    await page.goto(`${base}/#/trips/does-not-exist`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Trip Document", { timeout: 5000 });
    assert.match(await text(".empty"), /not available/);

    // Exactly two creates happened; no other mutations and no external calls.
    assert.deepEqual(
      writes.filter((entry) => entry !== "POST /api/trips"),
      [],
      `unexpected writes: ${writes.join(", ")}`,
    );
    assert.equal(inferenceCalls, 0);
    assert.deepEqual(external, []);
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});

test("trips browser: filters, lifecycle actions, keyboard rows, and confirmed delete", async () => {
  const database = tempDb("locus-trips-browser-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    let inferenceCalls = 0;
    page.on("dialog", (dialog) => void dialog.accept());
    const { external, writes } = trackTraffic(page, base, { onInference: () => { inferenceCalls += 1; } });

    const text = (selector: string) => page.$eval(selector, (el) => (el.textContent ?? "").trim());
    const hash = () => page.evaluate(() => location.hash);
    const waitHash = (target: string) => page.waitForFunction((value) => location.hash === value, { timeout: 5000 }, target);
    const filterChips = () => page.$$eval(".trips-filter .chip", (els) => els.map((el) => (el.textContent ?? "").trim()));
    // Lifecycle actions live in the document menu; always target by label.
    const clickAction = async (label: string) => {
      await page.$eval(".trip-doc-menu", (el) => {
        (el as HTMLDetailsElement).open = true;
      });
      await page.$$eval(
        ".trip-doc-menu-list .btn",
        (els, wanted) => {
          const button = els.find((el) => el.textContent === wanted) as HTMLButtonElement | undefined;
          if (!button) throw new Error(`no ${wanted} action`);
          button.click();
        },
        label,
      );
    };

    // React controlled inputs need the native value setter + input event.
    const setInput = (selector: string, value: string) => harnessSetInput(page, selector, value);
    const setDate = (index: number, value: string) =>
      page.$$eval(".trip-when input[type='date']", (els, args) => {
        const el = els[args.index] as HTMLInputElement;
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, args.value);
        el.dispatchEvent(new Event("input", { bubbles: true }));
      }, { index, value });
    const createTripViaForm = async (destination: string, when: { start?: string; end?: string; days?: string }) => {
      await page.goto(`${base}/#/trips/new`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-form input[required]", { timeout: 5000 });
      await setInput(".trip-form input[required]", destination);
      if (when.start) await setDate(0, when.start);
      if (when.end) await setDate(1, when.end);
      if (when.days) await setInput(".trip-when input[type='number']", when.days);
      await page.click(".trip-form button[type='submit']");
      await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
      await page.waitForFunction(
        (expected) => document.querySelector(".trips h1")?.textContent === expected,
        { timeout: 5000 },
        destination,
      );
      return hash();
    };

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/trips`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector(".empty")?.textContent?.includes("No Trip Documents yet"), { timeout: 5000 });
    assert.deepEqual(await filterChips(), ["Active · 0", "Archived · 0"]);
    assert.doesNotMatch(await text(".trips-rail"), /Active ·|Archived ·/, "rail never repeats the filter counts");

    const kyotoHash = await createTripViaForm("Kyoto, Japan", { start: "2026-10-12", end: "2026-10-15" });

    // Rename through the inline control; identity, days, and context survive.
    await clickAction("Rename");
    await setInput("#trip-rename-title", "Kyoto in October");
    await page.click(".trip-rename .btn.primary");
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kyoto in October", { timeout: 5000 });
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 2");
    await page.waitForSelector(".trip-empty-trip", { timeout: 5000 });
    const renamedDays = await page.$$eval(".trip-nav a", (els) => els.map((el) => (el.textContent ?? "").trim()).filter((label) => label.startsWith("Day")));
    assert.equal(renamedDays.length, 4, "rename keeps every day on the overview");

    await page.click(".trips-pagehead a[href='#/trips']");
    await waitHash("#/trips");
    await page.waitForSelector(".trip-row", { timeout: 5000 });
    assert.deepEqual(await filterChips(), ["Active · 1", "Archived · 0"]);
    assert.match(await text(".trip-row"), /Kyoto, Japan/);
    assert.match(await text(".trip-row"), /4 days/);
    assert.match(await text(".trip-row"), /Planning/);
    assert.equal(await page.$eval(".trip-row", (el) => el.getAttribute("aria-label")), "Open Kyoto in October");

    // Whole-row keyboard activation: Enter (native) and Space (added handler).
    await page.focus(".trip-row");
    await page.keyboard.press("Enter");
    await waitHash(kyotoHash);
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kyoto in October", { timeout: 5000 });
    await page.goBack();
    await waitHash("#/trips");
    await page.waitForSelector(".trip-row", { timeout: 5000 });
    await page.focus(".trip-row");
    await page.keyboard.press(" ");
    await waitHash(kyotoHash);
    await page.goBack();
    await waitHash("#/trips");
    await page.waitForSelector(".trip-row", { timeout: 5000 });

    const goaHash = await createTripViaForm("Goa", { days: "4" });

    // Archive from the document returns to the active index.
    await clickAction("Archive");
    await page.waitForFunction(() => location.hash === "#/trips", { timeout: 5000 });
    await page.waitForFunction(() => document.querySelectorAll(".trip-row").length === 1, { timeout: 5000 });
    assert.deepEqual(await filterChips(), ["Active · 1", "Archived · 1"]);
    assert.match(await text(".trip-row"), /Kyoto/);

    // Archived filter keeps its own route; Back restores it after opening a row.
    await page.click(".trips-filter .chip:nth-child(2)");
    await waitHash("#/trips?filter=archived");
    // Wait for the archived row itself: the stale active row can still be in
    // the DOM for one commit before React swaps the filtered list in.
    await page.waitForFunction(() => document.querySelector(".trip-row")?.textContent?.includes("Archived") === true, { timeout: 5000 });
    assert.match(await text(".trip-row"), /Goa/);
    assert.match(await text(".trip-row"), /Archived/);
    assert.deepEqual(await filterChips(), ["Active · 1", "Archived · 1"]);
    await page.click(".trip-row");
    await waitHash(goaHash);
    await page.goBack();
    await waitHash("#/trips?filter=archived");
    await page.waitForSelector(".trip-row", { timeout: 5000 });
    assert.match(await text(".trip-row"), /Goa/);

    // Restore brings the trip back to active; the actions row flips back.
    await page.click(".trip-row");
    await waitHash(goaHash);
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Goa", { timeout: 5000 });
    const restoreButton = await page.$$eval(".trip-doc-menu-list .btn", (els) => els.map((el) => el.textContent));
    assert.ok(restoreButton.includes("Restore"), "restorable document offers Restore");
    await clickAction("Restore");
    await page.waitForFunction(() => {
      const buttons = [...document.querySelectorAll(".trip-doc-menu-list .btn")];
      return buttons.some((el) => el.textContent === "Archive");
    }, { timeout: 5000 });
    const chips = await page.$$eval(".pagehead .chip", (els) => els.map((el) => el.textContent));
    assert.deepEqual(chips, [], "restored document no longer shows the Archived chip");

    // Duplicate creates a fresh document with its own revision history.
    await page.goto(`${base}${kyotoHash}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kyoto in October", { timeout: 5000 });
    await clickAction("Duplicate");
    await page.waitForFunction(
      (previous) => /^#\/trips\/[0-9a-f-]+$/.test(location.hash) && location.hash !== previous,
      { timeout: 5000 },
      kyotoHash,
    );
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kyoto in October", { timeout: 5000 });
    assert.equal(await page.$eval(".pagehead .count", (el) => el.textContent), "revision 1");

    // Confirmed deletes remove trip documents one by one until the empty state.
    await clickAction("Delete");
    await waitHash("#/trips");
    await page.waitForFunction(() => document.querySelectorAll(".trip-row").length === 2, { timeout: 5000 });
    assert.deepEqual(await filterChips(), ["Active · 2", "Archived · 0"]);

    await page.goto(`${base}${goaHash}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Goa", { timeout: 5000 });
    await clickAction("Delete");
    await waitHash("#/trips");
    await page.waitForFunction(() => document.querySelectorAll(".trip-row").length === 1, { timeout: 5000 });

    await page.goto(`${base}${kyotoHash}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.querySelector(".trips h1")?.textContent === "Kyoto in October", { timeout: 5000 });
    await clickAction("Delete");
    await waitHash("#/trips");
    await page.waitForFunction(() => document.querySelector(".empty")?.textContent?.includes("No Trip Documents yet"), { timeout: 5000 });
    assert.ok(await page.$(".trips-tools .btn.primary"), "empty state keeps Plan a trip");

    await page.setViewport({ width: 320, height: 800 });
    await page.goto(`${base}/#/trips?filter=archived`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".trips-filter", { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      true,
      "no overflow at 320px with the filter control",
    );

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

test("trips browser: setup form keeps one create mutation id across an uncertain failure", async () => {
  const database = tempDb("locus-trips-browser-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();

    // The first create POST aborts (an uncertain transport failure); later ones
    // pass through. Every create id is recorded for the identity assertions.
    const ids: string[] = [];
    let failedOnce = false;
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      if (request.method() === "POST" && new URL(url).pathname === "/api/trips") {
        ids.push((JSON.parse(request.postData() ?? "{}") as { clientMutationId?: string }).clientMutationId ?? "");
        if (!failedOnce) {
          failedOnce = true;
          void request.abort("failed");
          return;
        }
      }
      void request.continue();
    });

    const fillAndSubmit = async (destination: string) => {
      await page.goto(`${base}/#/trips/new`, { waitUntil: "networkidle0" });
      await page.waitForSelector(".trip-form input[required]", { timeout: 5000 });
      await harnessSetInput(page, ".trip-form input[required]", destination);
      await harnessSetInput(page, ".trip-when input[type='number']", "3");
      await page.click(".trip-form button[type='submit']");
    };

    // First submit fails as an uncertain transport error.
    await fillAndSubmit("Kyoto, Japan");
    await page.waitForSelector("p.bad[role='alert']", { timeout: 5000 });

    // Retrying the unchanged payload reuses the id the server already saw.
    await page.click(".trip-form button[type='submit']");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    assert.equal(ids.length, 2);
    assert.equal(ids[0], ids[1], "an unchanged retry keeps one mutation id");

    // A new submission is a new logical create and gets a fresh id.
    await fillAndSubmit("Osaka, Japan");
    await page.waitForFunction(() => /^#\/trips\/[0-9a-f-]+$/.test(location.hash), { timeout: 5000 });
    assert.equal(ids.length, 3);
    assert.notEqual(ids[2], ids[0], "a new submission gets a fresh mutation id");
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});
