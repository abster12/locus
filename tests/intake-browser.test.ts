import { test } from "node:test";
import assert from "node:assert/strict";
import { createCollection } from "../core/commands.ts";
import { launchBrowser, setInput, startServer, tempDb, trackTraffic } from "./trips-browser-harness.ts";
import { localDay } from "../core/dates.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8849";

test("manual save is reachable from New, defaults today, and the You filter shows it", async () => {
  const database = tempDb("locus-intake-browser-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    const { writes } = trackTraffic(page, base);

    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/recent`, { waitUntil: "networkidle0" });
    await page.waitForSelector(".new-btn", { timeout: 5000 });
    assert.equal(await page.$("a.chip[href='#/save']"), null);
    assert.ok(await page.evaluate(() => [...document.querySelectorAll(".filters .chip")].some((el) => (el.textContent ?? "").trim() === "You")));

    const before = writes.length;
    await page.click(".new-btn");
    await page.waitForSelector(".new-menu", { timeout: 5000 });
    await page.click(".new-menu [href='#/save']");
    await page.waitForSelector("dialog.save-link[open]", { timeout: 5000 });
    assert.equal(await page.evaluate(() => location.hash), "#/save");
    assert.equal(writes.length, before);
    assert.match(await page.$eval("#save-link-title", (el) => el.textContent ?? ""), /Save a link/);
    assert.ok(await page.$("input[name='url']"));
    assert.equal(await page.$("dialog.save-link [role='alert']"), null);
    assert.equal(await page.$eval("input[name='publishedAt']", (el) => (el as HTMLInputElement).value), localDay(new Date()));

    await setInput(page, "input[name='url']", "https://example.com/manual");
    await setInput(page, "input[name='title']", "Manual essay");
    await page.waitForSelector("dialog.save-link button[type='submit']:not([disabled])", { timeout: 5000 });
    await page.click("dialog.save-link button[type='submit']");
    await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 5000 });
    await page.waitForFunction(() => document.body.textContent?.includes("Manual essay"), { timeout: 5000 });
    assert.match(await page.$eval(".intake-mark", (el) => el.textContent ?? ""), /Added by you/);
    assert.ok(writes.some((entry) => entry === "POST /api/intake"));
    assert.equal(writes.filter((entry) => entry === "POST /api/intake").length, 1);

    await page.evaluate(() => {
      const chip = [...document.querySelectorAll(".filters button.chip")].find((el) => (el.textContent ?? "").trim() === "You");
      (chip as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(() => document.body.textContent?.includes("Manual essay"), { timeout: 5000 });
    await page.evaluate(() => {
      const chip = [...document.querySelectorAll(".filters button.chip")].find((el) => (el.textContent ?? "").trim() === "X");
      (chip as HTMLButtonElement | undefined)?.click();
    });
    await page.waitForFunction(() => (document.querySelector(".empty")?.textContent ?? "").includes("Inbox is clear."), { timeout: 5000 });
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});

test("failed save keeps the draft and does not persist", async () => {
  const database = tempDb("locus-intake-browser-draft-");
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    trackTraffic(page, base);
    await page.goto(`${base}/#/save`, { waitUntil: "networkidle0" });
    await page.waitForSelector("dialog.save-link[open]", { timeout: 5000 });
    await setInput(page, "input[name='url']", "https://example.com/keep");
    await setInput(page, "input[name='title']", "Keep me");
    await setInput(
      page,
      "textarea[name='media']",
      Array.from({ length: 9 }, (_, i) => `https://example.com/${i}.jpg`).join("\n"),
    );
    await page.waitForSelector("dialog.save-link [role='alert']", { timeout: 5000 });
    assert.match(await page.$eval("[role='alert']", (el) => el.textContent ?? ""), /media exceeds/);
    assert.equal(await page.$eval("dialog.save-link button[type='submit']", (el) => (el as HTMLButtonElement).disabled), true);
    assert.equal(await page.$eval("input[name='url']", (el) => (el as HTMLInputElement).value), "https://example.com/keep");
    assert.equal(await page.$eval("input[name='title']", (el) => (el as HTMLInputElement).value), "Keep me");
    assert.equal(await page.evaluate(() => location.hash), "#/save");
    await page.click("dialog.save-link button[type='button']");
    await page.waitForFunction(() => location.hash === "#/recent" && !document.querySelector("dialog.save-link"), { timeout: 5000 });
    await page.waitForSelector(".empty", { timeout: 5000 });
    assert.match(await page.$eval(".empty", (el) => el.textContent ?? ""), /No saves found/);
    assert.doesNotMatch(await page.$eval(".empty", (el) => el.textContent ?? ""), /Keep me/);
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});

test("preview shows organization and a successful save is visible in Collections and search", async () => {
  const database = tempDb("locus-intake-browser-org-");
  const collection = createCollection(database, "Research", "Deep reading");
  database.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-food', 'food', NULL)`).run();
  const app = await startServer(database);
  const base = `http://127.0.0.1:${app.port}`;
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1100, height: 800 });
    await page.goto(`${base}/#/save`, { waitUntil: "networkidle0" });
    await page.waitForSelector("dialog.save-link[open]", { timeout: 5000 });
    await page.waitForSelector(`input[name='collectionIds'][value='${collection.id}']`, { timeout: 5000 });
    await setInput(page, "input[name='url']", "https://Example.com:443/manual-org");
    await setInput(page, "input[name='title']", "Organized essay");
    await setInput(page, "input[name='publishedAt']", "");
    await page.click(`input[name='collectionIds'][value='${collection.id}']`);
    await page.click("input[name='tagIds'][value='tag-food']");
    await setInput(page, "input[name='newTag']", "Essay");
    await page.click("button[name='createTag']");
    assert.match(await page.$eval("fieldset[name='classification']", (el) => el.textContent ?? ""), /Appears in Recipe Box/);
    await page.waitForFunction(() => {
      const text = document.querySelector("#save-link-preview")?.textContent ?? "";
      const date = [...document.querySelectorAll("#save-link-preview dt")].find((el) => el.textContent === "Publication date")
        ?.nextElementSibling?.textContent ?? "";
      return text.includes("https://example.com/manual-org")
        && text.includes("Organized essay")
        && text.includes("Research")
        && text.includes("food")
        && text.includes("Essay")
        && text.includes("Missing")
        && /^\d{4}-\d{2}-\d{2}T/.test(date);
    }, { timeout: 5000 });
    await setInput(page, "input[name='title']", "Organized essay v2");
    assert.equal(await page.$eval("dialog.save-link button[type='submit']", (el) => (el as HTMLButtonElement).disabled), true);
    await page.waitForFunction(() => (document.querySelector("#save-link-preview")?.textContent ?? "").includes("Organized essay v2"), { timeout: 5000 });
    await page.waitForSelector("dialog.save-link button[type='submit']:not([disabled])", { timeout: 5000 });
    await page.click("dialog.save-link button[type='submit']");
    await page.waitForFunction(() => location.hash === "#/inbox", { timeout: 5000 });
    await page.waitForFunction(() => document.body.textContent?.includes("Organized essay"), { timeout: 5000 });
    await page.goto(`${base}/#/collections/${collection.id}`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.body.textContent?.includes("Organized essay"), { timeout: 5000 });
    await page.goto(`${base}/#/search?q=Essay`, { waitUntil: "networkidle0" });
    await page.waitForFunction(() => document.body.textContent?.includes("Organized essay"), { timeout: 5000 });
  } finally {
    await browser.close();
    await app.close();
    database.close();
  }
});
