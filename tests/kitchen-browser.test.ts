import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";
import { captionRevision, normalizeCaption, putRecipeDocument } from "../server/kitchen/module.ts";

// Browser coverage for the Kitchen spec's end-to-end criteria. External
// requests are aborted and counted so we can prove the Recipe Box index makes
// none without depending on platform iframe behavior.
process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8799";

const TS = "2026-08-29T12:00:00.000Z";
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-kitchen-browser-")), "t.db"));
}

function insertItem(database: ReturnType<typeof mem>, id: string, body: string | null, url = `https://www.instagram.com/reel/${id}/`): void {
  database
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'reel', NULL, ?, ?, 'cook', ?, '[]', ?, ?)`,
    )
    .run(id, body, url, TS, TS, TS);
}

test("kitchen browser: tabs, tonight flow, watch & cook, recipe score, 320px, shelves redirect", async () => {
  const database = mem();
  database
    .prepare(`INSERT INTO source_accounts (id, source, external_id, display_name, created_at) VALUES ('acct', 'instagram', 'u', 'U', ?)`)
    .run(TS);
  database
    .prepare(`INSERT INTO source_collections (id, source_account_id, external_id, name, created_at) VALUES ('col', 'acct', 'saved', 'Saved', ?)`)
    .run(TS);
  const caption1 = "200 g paneer\nGrill it hot\nServe with mint chutney";
  insertItem(database, "f1", caption1);
  insertItem(database, "f2", null);
  insertItem(database, "f3", "Full paneer tikka recipe:\n1. marinate the paneer\n2. grill until charred", "https://example.com/paneer-post");
  insertItem(database, "f4", null, "https://example.com/plain-note");
  insertItem(database, "f5", null);
  for (const id of ["f1", "f2", "f3", "f4", "f5"]) addTag(database, id, "food");
  putRecipeDocument(
    database,
    "local",
    "f1",
    {
      expectedSourceRevision: captionRevision(normalizeCaption(caption1)),
      status: "reviewed",
      draft: {
        version: 1,
        title: "Paneer tikka",
        titleEvidence: { kind: "user" },
        ingredients: [
          { id: "ing-1", raw: "200 g (7 oz) paneer", quantity: "200", unit: "g", name: "paneer", evidence: { kind: "user" } },
          { id: "ing-2", raw: "2 tbsp (30 ml) yogurt", quantity: "2", unit: "tbsp", name: "yogurt", evidence: { kind: "user" } },
        ],
        steps: [
          { id: "step-1", instruction: "Coat the paneer thoroughly in yogurt and leave it ready for the hot grill.", ingredientIds: ["ing-1", "ing-2"], evidence: { kind: "user" } },
          { id: "step-2", instruction: "Grill until charred.", ingredientIds: ["ing-1", "ing-2"], duration: "8–10 min", temperature: "450°F", evidence: { kind: "user" } },
        ],
      },
    },
    "user",
    TS,
  );

  const { listen } = await import("../server/http/server.ts");
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
  try {
    const page = await browser.newPage();
    const external: string[] = [];
    const seen: string[] = [];
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      const url = request.url();
      seen.push(url);
      if (/^https?:/.test(url) && !url.startsWith(base)) {
        external.push(url);
        void request.abort();
        return;
      }
      void request.continue();
    });

    const waitForRows = () =>
      page.waitForFunction(() => document.querySelectorAll(".kitchen-row:not(.kitchen-skeleton)").length === 5, { timeout: 5000 });
    const text = (selector: string) => page.$eval(selector, (el) => el.textContent ?? "");
    const tonightCount = () => page.$$eval(".kitchen-tonight-list li", (els) => els.length);
    const nav = async (hash: string, selector: string) => {
      await page.evaluate((target) => {
        location.hash = target;
      }, hash);
      await page.waitForSelector(selector, { timeout: 5000 });
    };

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/kitchen`, { waitUntil: "networkidle0" });
    await waitForRows();

    // Navigation: Kitchen is a primary tab, Shelves is gone.
    assert.equal(await page.$eval("h1", (el) => el.textContent), "Kitchen");
    assert.match(await text(".count"), /5 food saves · 1 structured/);
    const tabs = await page.$$eval(".tabs a", (els) => els.map((el) => el.getAttribute("href")));
    assert.ok(tabs.includes("#/kitchen"), "kitchen tab");
    assert.ok(!tabs.includes("#/shelves"), "no shelves tab");

    // Recipe Box rows: availability labels and row actions.
    const labels = await page.$$eval(".kitchen-avail", (els) => els.map((el) => el.textContent));
    for (const label of ["Reviewed recipe", "Watch recipe", "Caption available", "Source only"]) {
      assert.ok(labels.includes(label), `availability label ${label}`);
    }
    const openActions = await page.$$eval(".kitchen-row-actions a.btn", (els) => els.map((el) => el.textContent ?? ""));
    assert.equal(openActions.filter((t) => t === "Open recipe").length, 1);
    assert.equal(openActions.filter((t) => t === "Make this cookable").length, 4);

    // Index requests: no embeds, no link previews while browsing Recipe Box.
    const externalOnIndex = external.length;
    assert.equal(externalOnIndex, 0);
    assert.equal(seen.slice().filter((url) => url.includes("/api/link-preview")).length, 0);

    await nav("#/kitchen", ".kitchen-row:not(.kitchen-skeleton)");
    await waitForRows();

    // Tonight: add two, move by keyboard, reload persists, remove, clear.
    const rowTitles = await page.$$eval(".kitchen-row .kitchen-row-title", (els) => els.map((el) => el.textContent ?? ""));
    const addFirst = async () => (await page.$$(".kitchen-add-tonight"))[0]!.click();
    await addFirst();
    await page.waitForFunction((n) => document.querySelectorAll(".kitchen-tonight-list li").length >= n, { timeout: 5000 }, 1);
    await addFirst();
    await page.waitForFunction((n) => document.querySelectorAll(".kitchen-tonight-list li").length >= n, { timeout: 5000 }, 2);
    assert.deepEqual(await page.$$eval(".kitchen-tonight-title", (els) => els.map((el) => el.textContent)), rowTitles.slice(0, 2));

    const down = await page.$('[aria-label^="Move "][aria-label$="down"]');
    assert.ok(down, "keyboard move control");
    await down!.focus();
    await page.keyboard.press("Enter");
    await page.waitForFunction(
      (first) => document.querySelector(".kitchen-tonight-title")?.textContent === first,
      { timeout: 5000 },
      rowTitles[1],
    );

    await page.reload({ waitUntil: "networkidle0" });
    await waitForRows();
    assert.equal(await tonightCount(), 2);
    assert.equal(await text(".kitchen-tonight-title"), rowTitles[1]);

    await page.click('[aria-label^="Remove "][aria-label$="from Tonight"]');
    await page.waitForFunction((n) => document.querySelectorAll(".kitchen-tonight-list li").length === n, { timeout: 5000 }, 1);
    await addFirst();
    await page.waitForFunction((n) => document.querySelectorAll(".kitchen-tonight-list li").length >= n, { timeout: 5000 }, 2);
    page.once("dialog", (dialog) => void dialog.accept());
    await page.click(".kitchen-clear");
    await page.waitForSelector(".kitchen-tonight-empty", { timeout: 5000 });
    assert.match(await text(".kitchen-tonight-empty"), /Add something from the Recipe Box/);

    // Watch & Cook with a captured caption: full text plus a safe original exit.
    await nav("#/kitchen/f3", ".kitchen-caption-text");
    assert.match(await text(".kitchen-caption-text"), /marinate the paneer/);
    const actions = await page.$$eval(".kitchen-detail-actions a", (els) =>
      els.map((el) => ({ text: el.textContent ?? "", href: el.getAttribute("href"), target: el.target, rel: el.rel })),
    );
    const original = actions.find((a) => a.text.includes("Open original"));
    assert.ok(original, "Open original action");
    assert.equal(original!.href, "https://example.com/paneer-post");
    assert.equal(original!.target, "_blank");
    assert.match(original!.rel, /noopener/);
    assert.equal(external.length, externalOnIndex, "no external requests from a caption-only Watch & Cook");

    // Honest copy when nothing was captured.
    await nav("#/kitchen/f4", ".kitchen-watch");
    assert.match(await text(".kitchen-watch"), /No caption was captured\. Open the original for the source\./);
    assert.ok((await page.$$eval(".kitchen-detail-actions a", (els) => els.map((el) => el.textContent))).some((t) => (t ?? "").includes("Open original")));

    // Video-only fallback copy; the embed request is allowed here and aborted.
    await nav("#/kitchen/f5", ".kitchen-watch");
    assert.match(await text(".kitchen-watch"), /This recipe lives in the video\./);
    assert.ok(await page.$(".kitchen-embed"));

    // Recipe timeline: semantic ingredient and step lists, exact alignment,
    // multiple measurement representations, and timing metadata.
    await nav("#/kitchen/f1", ".kitchen-score");
    assert.match(await page.$eval("h1", (el) => el.textContent ?? ""), /paneer/i);
    assert.equal(await page.$$eval(".kitchen-score-ing ul li", (els) => els.length >= 1), true);
    assert.equal(await page.$$eval(".kitchen-score-flow .kitchen-step", (els) => els.length), 2);
    assert.equal(await page.$(".kitchen-score-connector"), null);
    assert.equal(await page.$$eval(".kitchen-score-spine", (els) => els.length), 2);
    assert.deepEqual(await page.$$eval(".kitchen-step-node", (els) => els.map((el) => ({ text: el.textContent, label: el.getAttribute("aria-label") }))), [
      { text: "1", label: "Step 1" },
      { text: "2", label: "Step 2" },
    ]);
    assert.equal(await page.$eval(".kitchen-score-flow", (el) => el.getAttribute("aria-label")), "Recipe timeline");
    assert.match(await text(".kitchen-ing"), /200 g paneer/);
    assert.match(await text(".kitchen-ing-raw"), /200 g \(7 oz\) paneer/);
    assert.equal(await text(".kitchen-step-time"), "8–10 min");
    assert.equal(await text(".kitchen-step-temperature"), "450°F");
    const centers = await page.$$eval(".kitchen-score-row", (rows) => rows.map((row) =>
      [".kitchen-score-ing", ".kitchen-score-spine", ".kitchen-step"].map((selector) => {
        const box = row.querySelector(selector)?.getBoundingClientRect();
        return box ? Math.round(box.top + box.height / 2) : -1;
      })),
    );
    for (const rowCenters of centers) {
      assert.ok(rowCenters.every((center) => center === rowCenters[0]), `timeline centres differ: ${rowCenters.join(", ")}`);
    }
    assert.ok(
      (await page.$$eval(".kitchen-detail-head .chip", (els) => els.map((el) => el.textContent))).includes("Reviewed"),
    );
    assert.match(await text(".kitchen-provenance"), /Edited by you/);
    assert.ok(await page.$(".kitchen-source-caption"));

    // In-place edit: the score itself is the editor, not a stacked form.
    await nav("#/kitchen/f1/edit", ".kitchen-score-edit");
    assert.equal(await page.$(".kitchen-editor"), null);

    // Blur never writes: type into the first beat, click away, reload.
    const beatSel = ".kitchen-score-edit .kitchen-step-text";
    const originalBeat = await page.$eval(beatSel, (el) => el.textContent ?? "");
    await page.click(beatSel);
    await page.keyboard.type(" until set");
    await page.click(".kitchen-score-heading-method h2");
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.equal(await page.$eval(beatSel, (el) => el.textContent ?? ""), originalBeat);

    // Enter in method does not accept; the beat stays pending until ticked,
    // and ticking a reviewed recipe writes the change and returns it to draft.
    await page.click(beatSel);
    await page.keyboard.type(" until set");
    await page.keyboard.press("Enter");
    assert.ok(await page.$(".kitchen-score-edit .kitchen-step.pending"), "beat stays pending after Enter");
    await page.click(".kitchen-score-edit .kitchen-step.pending .kitchen-tick");
    await page.waitForFunction(() => !document.querySelector(".kitchen-score-edit .kitchen-step.pending"), { timeout: 5000 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.match(await page.$eval(beatSel, (el) => el.textContent ?? ""), / until set/);
    assert.ok(
      (await page.$$eval(".kitchen-detail-titlerow .chip", (els) => els.map((el) => el.textContent ?? ""))).includes("Draft"),
      "ticking a reviewed recipe returns it to draft",
    );

    // Enter on an ingredient field accepts that ingredient.
    await page.click(".kitchen-score-edit .kitchen-ing-read");
    await page.waitForSelector(".kitchen-ing-edit .n", { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.classList.contains("n") ?? false),
      true,
      "ingredient editor focuses the name field",
    );
    await page.click(".kitchen-ing-edit .n", { clickCount: 3 });
    await page.keyboard.type("paneer cubes");
    await page.keyboard.press("Enter");
    await page.waitForFunction(() => !document.querySelector(".kitchen-ing.editing"), { timeout: 5000 });
    // The saved row is canonicalized in the working copy so its pending tick clears.
    await page.waitForFunction(() => !document.querySelector(".kitchen-ing.pending"), { timeout: 5000 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.match(await page.$eval(".kitchen-ing-text", (el) => el.textContent ?? ""), /paneer cubes/);

    // A tick merges only its own unit: the unticked beat edit below stays
    // working-only and disappears on reload while the ticked facts persist.
    await page.click(".kitchen-score-flow li:nth-child(2) .kitchen-step-text");
    await page.keyboard.type(" and rest");
    await page.click("[data-edit='title']");
    await page.keyboard.type("Paneer night");
    await page.click(".kitchen-facts-edit .kitchen-tick");
    await page.waitForFunction(() => !document.querySelector(".kitchen-facts-edit.pending"), { timeout: 5000 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.match(await page.$eval("[data-edit='title']", (el) => el.textContent ?? ""), /Paneer night/);
    assert.doesNotMatch(
      await page.$eval(".kitchen-score-flow li:nth-child(2) .kitchen-step-text", (el) => el.textContent ?? ""),
      / and rest/,
      "unticked beat edits are not persisted by another unit's tick",
    );

    // Structural changes are pending units with their own tick/cross: a move
    // is shown on both swapped beats and never rides along with other ticks.
    await page.click('.kitchen-score-flow li:first-child .kitchen-beat-tools button[aria-label="Move beat down"]');
    await page.waitForFunction(
      () => document.querySelectorAll(".kitchen-score-edit .kitchen-step.pending").length === 2,
      { timeout: 5000 },
    );
    await page.click(".kitchen-score-flow li:first-child .kitchen-step .kitchen-tick");
    await page.waitForFunction(() => !document.querySelector(".kitchen-score-edit .kitchen-step.pending"), { timeout: 5000 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.match(
      await page.$eval(".kitchen-score-flow li:first-child .kitchen-step-text", (el) => el.textContent ?? ""),
      /Grill until charred/,
      "accepted move persists the new order",
    );

    // Removal: mark, prove it is not persisted until ticked, revert it, then
    // accept it.
    await page.click('.kitchen-score-flow li:nth-child(2) .kitchen-beat-tools button[aria-label="Remove beat"]');
    await page.waitForSelector(".kitchen-step.removing", { timeout: 5000 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.equal(
      await page.$$eval(".kitchen-score-flow > li:not(.kitchen-composer)", (els) => els.length),
      2,
      "removal waits for its tick",
    );
    await page.click('.kitchen-score-flow li:nth-child(2) .kitchen-beat-tools button[aria-label="Remove beat"]');
    await page.waitForSelector(".kitchen-step.removing", { timeout: 5000 });
    await page.click(".kitchen-step.removing .kitchen-cross");
    await page.waitForFunction(() => !document.querySelector(".kitchen-step.removing"), { timeout: 5000 });
    assert.equal(
      await page.$$eval(".kitchen-score-flow > li:not(.kitchen-composer)", (els) => els.length),
      2,
      "cross restores the removed beat",
    );
    await page.click('.kitchen-score-flow li:nth-child(2) .kitchen-beat-tools button[aria-label="Remove beat"]');
    await page.waitForSelector(".kitchen-step.removing", { timeout: 5000 });
    await page.click(".kitchen-step.removing .kitchen-tick");
    await page.waitForFunction(() => !document.querySelector(".kitchen-step.removing"), { timeout: 5000 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.equal(
      await page.$$eval(".kitchen-score-flow > li:not(.kitchen-composer)", (els) => els.length),
      1,
      "accepted removal persists",
    );

    // Blank recipe: the same score starts empty with no placeholder rows.
    await nav("#/kitchen/f4/edit", ".kitchen-score-edit");
    assert.equal(await page.$$eval(".kitchen-score-flow > li", (els) => els.length), 1);
    assert.equal(await page.$(".kitchen-detail-titlerow .chip"), null);

    // First keystroke shows Draft.
    await page.click("[data-edit='title']");
    await page.keyboard.type("Sunday toast");
    await page.waitForSelector(".kitchen-detail-titlerow .chip", { timeout: 5000 });
    assert.equal(await page.$eval(".kitchen-detail-titlerow .chip", (el) => el.textContent ?? ""), "Draft");

    // Enter in the composer does not accept; ticking creates the beat and writes it.
    await page.click("[data-edit='composer']");
    await page.keyboard.type("Butter the bread");
    await page.keyboard.press("Enter");
    assert.ok(await page.$(".kitchen-composer .kitchen-tick"), "composer stays pending after Enter");
    await page.click(".kitchen-composer .kitchen-tick");
    await page.waitForFunction(() => document.querySelectorAll(".kitchen-score-flow > li").length === 2, { timeout: 5000 });

    // + ingredient focuses the name field; Place on N hangs it on a beat;
    // ticking the beat writes the placement.
    await page.click(".kitchen-composer .kitchen-ghost-add");
    await page.waitForSelector(".kitchen-ing-edit .n", { timeout: 5000 });
    assert.equal(
      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.classList.contains("n") ?? false),
      true,
      "+ ingredient focuses the name field",
    );
    await page.keyboard.type("Sourdough slice");
    await page.waitForSelector(".kitchen-place-on button", { timeout: 5000 });
    await page.click(".kitchen-place-on button");
    await page.waitForFunction(
      () => Boolean(document.querySelector(".kitchen-score-flow li:first-child .kitchen-ing")),
      { timeout: 5000 },
    );
    await page.click(".kitchen-score-flow li:first-child .kitchen-step .kitchen-tick");
    await page.waitForFunction(() => !document.querySelector(".kitchen-score-edit .pending"), { timeout: 5000 });

    // The composer tick merged only the beat: the unticked title stayed
    // working-only and is gone after reload, while the beat and its absorbed
    // ingredient persist.
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.match(await page.$eval(".kitchen-ing-text", (el) => el.textContent ?? ""), /Sourdough slice/);
    assert.equal(await page.$eval("[data-edit='title']", (el) => el.textContent ?? ""), "");

    // Ticking the facts unit persists the title.
    await page.click("[data-edit='title']");
    await page.keyboard.type("Sunday toast");
    await page.click(".kitchen-facts-edit .kitchen-tick");
    await page.waitForFunction(() => !document.querySelector(".kitchen-facts-edit.pending"), { timeout: 5000 });
    await page.reload({ waitUntil: "networkidle0" });
    await page.waitForSelector(".kitchen-score-edit", { timeout: 5000 });
    assert.match(await page.$eval("[data-edit='title']", (el) => el.textContent ?? ""), /Sunday toast/);

    // 320px: no horizontal overflow on the index or the score.
    await page.setViewport({ width: 320, height: 800 });
    await nav("#/kitchen", ".kitchen-score, .kitchen-row:not(.kitchen-skeleton)");
    await waitForRows();
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      true,
      "no overflow at 320px on index",
    );
    await nav("#/kitchen/f1", ".kitchen-score");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      true,
      "no overflow at 320px on score",
    );
    await nav("#/kitchen/f1/edit", ".kitchen-score-edit");
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth),
      true,
      "no overflow at 320px on the editable score",
    );

    // Old Shelves links land on Desk without adding a history step.
    await page.evaluate(() => {
      location.hash = "#/shelves";
    });
    await page.waitForSelector(".rail", { timeout: 5000 });
    assert.equal(await page.evaluate(() => location.hash), "#/recent");
    assert.equal(await page.evaluate(() => document.querySelector(".tabs a[href='#/shelves']") === null), true);
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});
