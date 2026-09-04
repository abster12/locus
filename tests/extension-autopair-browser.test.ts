import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { openDb } from "../db/open.ts";
import { resetJobsForTest } from "../server/capture/jobs.ts";

process.env.NODE_ENV = "production";
process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_READING_WORKER = "0";
process.env.LOCUS_PORT = "8831";

const EXTENSION = new URL("../extension/shell", import.meta.url).pathname;
// Branded Chrome 137+ ignores --load-extension even headed, so the e2e runs on
// Chrome for Testing, installed on first run into tmp/ (gitignored).
const CFT_VERSION = "152.0.7977.82";
const CHROME = join(
  "tmp",
  "browsers",
  "chrome",
  `mac_arm-${CFT_VERSION}`,
  "chrome-mac-arm64",
  "Google Chrome for Testing.app",
  "Contents",
  "MacOS",
  "Google Chrome for Testing",
);

// Real end-to-end auto-pair: the unpacked extension is loaded into Chrome, the
// Account page posts the pairing, and content.js/sw.js must store it without
// any copy-paste. Headed on purpose so the extension loads. pack.js is
// gitignored, so build it if it is missing.
test.describe("extension auto-pair", { concurrency: false }, () => {
  test("Pair extension pairs the installed extension without copy-paste", async () => {
    if (!existsSync(join(EXTENSION, "pack.js"))) {
      execSync("npx tsx scripts/build-extension.ts", { stdio: "ignore" });
    }
    if (!existsSync(CHROME)) {
      execSync(`npx @puppeteer/browsers install chrome@${CFT_VERSION} --path tmp/browsers`, { stdio: "ignore" });
    }
    const database = openDb(join(mkdtempSync(join(tmpdir(), "locus-autopair-")), "t.db"));
    const { listen } = await import("../server/http/server.ts");
    resetJobsForTest();
    const app = listen(database);
    const base = `http://127.0.0.1:${app.port}`;
    const browser = await puppeteer.launch({
      executablePath: CHROME,
      headless: false,
      // puppeteer-core 24 injects --disable-extensions into every launch unless
      // this is set; it also adds --enable-unsafe-extension-debugging, which
      // Chrome 137+ needs for --load-extension to have any effect.
      enableExtensions: true,
      args: ["--no-sandbox", `--disable-extensions-except=${EXTENSION}`, `--load-extension=${EXTENSION}`],
    });
    try {
      const page = await browser.newPage();
      await page.goto(`${base}/#/account`, { waitUntil: "networkidle0" });
      await page.waitForSelector("#extension-setup", { timeout: 5000 });
      assert.equal(await page.$eval("#extension-setup [role='status']", (el) => el.textContent?.trim()), "Not paired");

      await page.click("#extension-setup .btn.primary");

      // The extension should confirm the pairing in the page…
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("#extension-setup [role='status']")].some((el) =>
            (el.textContent ?? "").includes("Paired with the extension in this browser"),
          ),
        { timeout: 10000 },
      );
      // …so no copy-paste code appears…
      assert.equal(await page.$("#pairing-code"), null);
      // …and the extension's hello marks the desk as paired.
      await page.waitForFunction(
        () =>
          [...document.querySelectorAll("#extension-setup [role='status']")].some((el) => el.textContent === "Paired"),
        { timeout: 10000 },
      );
      assert.match(await page.$eval("#extension-setup", (el) => el.textContent ?? ""), /Last seen /);
    } finally {
      await browser.close();
      await app.close();
      database.close();
      resetJobsForTest();
    }
  });
});
