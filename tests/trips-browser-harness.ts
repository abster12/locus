// Shared harness for the Trips browser suites. Each test keeps its own db,
// server, and browser so results never depend on file or test order. Each
// test file sets its own LOCUS_PORT at the top, before any listen() call.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer, { type Page } from "puppeteer-core";
import { openDb } from "../db/open.ts";

export const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function tempDb(prefix = "locus-trips-browser-") {
  return openDb(join(mkdtempSync(join(tmpdir(), prefix)), "t.db"));
}

/** Imported per call so the file's LOCUS_PORT is read at listen time, keeping
 * parallel test files on distinct ports. */
export async function startServer(db: ReturnType<typeof tempDb>) {
  const { listen } = await import("../server/http/server.ts");
  return listen(db);
}

export function launchBrowser() {
  return puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
}

/** Abort every non-base http(s) request and record same-origin traffic.
 * `writes` keeps `METHOD /relative/url` entries for mutations; `onInference`
 * lets a test count accidental Kitchen/Reading/Atlas agent calls. */
export function trackTraffic(
  page: Page,
  base: string,
  options: { onInference?: () => void } = {},
): { external: string[]; writes: string[] } {
  const external: string[] = [];
  const writes: string[] = [];
  void page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(base)) {
      external.push(url);
      void request.abort();
      return;
    }
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method())) {
      writes.push(`${request.method()} ${url.replace(base, "")}`);
      if (/\/api\/(kitchen\/.*cookable|reading|atlas)/.test(url)) options.onInference?.();
    }
    void request.continue();
  });
  return { external, writes };
}

/** Abort-only variant for tests that assert nothing about traffic. */
export function blockExternal(page: Page, base: string): void {
  void page.setRequestInterception(true);
  page.on("request", (request) => {
    const url = request.url();
    if (/^https?:/.test(url) && !url.startsWith(base)) {
      void request.abort();
      return;
    }
    void request.continue();
  });
}

/** React controlled inputs need the native value setter + input event. */
export function setInput(page: Page, selector: string, value: string): Promise<void> {
  return page.$eval(
    selector,
    (el, v) => {
      const input = el as HTMLInputElement | HTMLTextAreaElement;
      const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(input, v as string);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    },
    value,
  );
}

/** Open the Add Stop dialog's named source. The dialog must already be open. */
export async function chooseAddSource(page: Page, source: "Choose from Library" | "Add outside content" | "Add a hole"): Promise<void> {
  await page.waitForSelector(".trip-add-dialog[open]", { timeout: 5000 });
  await clickByText(page, ".trip-add-dialog", source);
}

/** Click the one button inside `scope` whose text is exactly `text`. */
export function clickByText(page: Page, scope: string, text: string): Promise<void> {
  return page.$eval(
    scope,
    (root, wanted) => {
      const el = [...root.querySelectorAll<HTMLButtonElement>("button")].find((candidate) => candidate.textContent === wanted);
      if (!el) throw new Error(`no button ${wanted}`);
      el.click();
    },
    text,
  );
}
