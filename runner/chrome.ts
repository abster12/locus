import { existsSync } from "node:fs";
import type { Page } from "puppeteer-core";
import puppeteer from "puppeteer-core";
import type { CaptureContext } from "../site-packs/shared.ts";

export function findChrome(): string {
  const fromEnv = process.env.LOCUS_CHROME;
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ];
  for (const path of candidates) {
    if (existsSync(path)) return path;
  }
  throw new Error("Google Chrome is not installed. Locus opens a real Chrome window for capture.");
}

export async function launchCaptureBrowser(profileDir: string): Promise<{
  close: () => Promise<void>;
  page: Page;
}> {
  const browser = await puppeteer.launch({
    executablePath: findChrome(),
    headless: false,
    userDataDir: profileDir,
    defaultViewport: null,
    args: ["--no-first-run", "--no-default-browser-check", "--disable-session-crashed-bubble"],
  });
  const pages = await browser.pages();
  const page = pages[0] ?? (await browser.newPage());
  await page.bringToFront();
  return {
    page,
    close: async () => {
      try {
        await browser.close();
      } catch {
        // already closed
      }
    },
  };
}

export function pageContext(page: Page, cancelled: () => boolean): CaptureContext {
  return {
    url: () => Promise.resolve(page.url()),
    title: () => Promise.resolve(page.title()),
    evaluate: (fn) => page.evaluate(fn),
    goto: async (url) => {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    },
    scrollBy: async (y) => {
      await page.evaluate((dy) => window.scrollBy(0, dy), y);
    },
    wait: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    cancelled,
  };
}
