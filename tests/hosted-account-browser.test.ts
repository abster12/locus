import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { extname, join, normalize } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import puppeteer, { type Browser, type Page } from "puppeteer-core";

const ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SPA = join(ROOT, "dist/hosted-app");
const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const PORT = 8831;
const BASE = `http://127.0.0.1:${PORT}`;

const hostedSession = {
  csrfToken: "hosted-csrf",
  user: { id: "u1", name: "Ada Lovelace", email: "ada@example.com", image: null },
  session: { expiresAt: "2026-12-01T00:00:00.000Z" },
  library: { id: "lib-1", name: "Ada's Library", role: "owner" },
};

const LOCAL_API = /^\/api\/(sources|export|imports|settings|library|pair|extension)/;

const stub = {
  mode: "signed-out" as "signed-out" | "signed-in" | "denied" | "fail" | "expire",
  calls: 0,
  localApis: [] as string[],
};

function resetStub(mode: typeof stub.mode) {
  stub.mode = mode;
  stub.calls = 0;
  stub.localApis = [];
}

function sessionPayload(): { status: number; body: unknown } {
  stub.calls += 1;
  if (stub.mode === "fail") return { status: 500, body: { error: "Internal server error" } };
  if (stub.mode === "denied") return { status: 403, body: { error: "Forbidden" } };
  if (stub.mode === "expire") {
    // HostedApp loads the session, then App.boot() loads it again. Expire after both.
    if (stub.calls <= 2) {
      return {
        status: 200,
        body: { ...hostedSession, session: { expiresAt: new Date(Date.now() + 400).toISOString() } },
      };
    }
    return { status: 401, body: { error: "Unauthorized" } };
  }
  if (stub.mode === "signed-in") return { status: 200, body: hostedSession };
  return { status: 401, body: { error: "Unauthorized" } };
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

function serveFile(res: ServerResponse, file: string) {
  const types: Record<string, string> = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".map": "application/json",
  };
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
}

function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", BASE);
  if (url.pathname === "/api/session") {
    const payload = sessionPayload();
    sendJson(res, payload.status, payload.body);
    return;
  }
  if (url.pathname === "/api/auth/sign-in/social") {
    sendJson(res, 200, { url: `${BASE}/#/account` });
    return;
  }
  if (url.pathname === "/api/auth/sign-out") {
    stub.mode = "signed-out";
    sendJson(res, 200, { success: true });
    return;
  }
  if (url.pathname === "/api/items" || url.pathname === "/api/items/counts") {
    sendJson(res, 200, {
      items: [],
      nextCursor: null,
      counts: { total: 0, inbox: 0, shelves: {} },
    });
    return;
  }
  if (url.pathname === "/api/collections") {
    sendJson(res, 200, { collections: [], tags: [] });
    return;
  }
  if (LOCAL_API.test(url.pathname)) {
    stub.localApis.push(url.pathname);
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 404, { error: "Not found" });
    return;
  }
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = normalize(join(SPA, rel));
  if (!file.startsWith(SPA)) {
    res.writeHead(403).end();
    return;
  }
  if (existsSync(file) && statSync(file).isFile()) {
    serveFile(res, file);
    return;
  }
  serveFile(res, join(SPA, "index.html"));
}

async function openPage(): Promise<Page> {
  const page = await browser.newPage();
  await page.setRequestInterception(true);
  page.on("request", (request) => {
    const href = request.url();
    if (/^https?:/.test(href) && !href.startsWith(BASE)) {
      void request.abort();
      return;
    }
    void request.continue();
  });
  return page;
}

let server: Server;
let browser: Browser;

before(async () => {
  execFileSync("npx", ["vite", "build", "--mode", "hosted"], { cwd: ROOT, stdio: "pipe" });
  server = createServer(handle);
  await new Promise<void>((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ["--no-sandbox"] });
});

after(async () => {
  await browser?.close();
  await new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

test.describe("hosted account", { concurrency: false }, () => {
test("signed-out hosted shell is Google only", async () => {
  resetStub("signed-out");
  const page = await openPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".hosted-session .btn.primary", { timeout: 5000 });
    const text = await page.evaluate(() => document.body.textContent ?? "");
    assert.match(text, /Continue with Google/);
    assert.doesNotMatch(text, /Ada/);
    assert.doesNotMatch(text, /ada@example.com/);
    assert.doesNotMatch(text, /Desk/);
    assert.doesNotMatch(text, /Capture setup/);
    assert.equal(stub.localApis.length, 0);
  } finally {
    await page.close();
  }
});

test("signed-in hosted App shows Desk and Google Account, not later tabs", async () => {
  resetStub("signed-in");
  const page = await openPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForFunction(() => (document.body.textContent ?? "").includes("Desk"), { timeout: 5000 });
    const desk = await page.evaluate(() => document.body.textContent ?? "");
    assert.match(desk, /Desk/);
    assert.doesNotMatch(desk, /Continue with Google/);
    assert.doesNotMatch(desk, /Kitchen/);
    assert.doesNotMatch(desk, /Atlas/);
    assert.doesNotMatch(desk, /Trips/);
    assert.doesNotMatch(desk, /Reading/);
    assert.doesNotMatch(desk, /Capture setup/);
    assert.doesNotMatch(desk, /Pair extension/);
    assert.doesNotMatch(desk, /Connect/);
    await page.goto(`${BASE}/#/account`, { waitUntil: "load" });
    await page.waitForSelector("#hosted-account", { timeout: 5000 });
    const text = await page.evaluate(() => document.body.textContent ?? "");
    assert.match(text, /Ada Lovelace/);
    assert.match(text, /ada@example.com/);
    assert.match(text, /Signed in with Google/);
    assert.match(text, /Ada's Library/);
    assert.match(text, /Owner/);
    assert.match(text, /Sign out/);
    assert.doesNotMatch(text, /Capture setup/);
    assert.doesNotMatch(text, /Pair extension/);
    assert.doesNotMatch(text, /Local account/);
    assert.equal(stub.localApis.length, 0);
  } finally {
    await page.close();
  }
});

test("sign-out returns to the Google entry without a reload", async () => {
  resetStub("signed-in");
  const page = await openPage();
  try {
    await page.goto(`${BASE}/#/account`, { waitUntil: "load" });
    await page.waitForSelector("#hosted-account", { timeout: 5000 });
    await page.click("#hosted-account .btn");
    await page.waitForSelector(".hosted-session .btn.primary", { timeout: 5000 });
    const text = await page.evaluate(() => document.body.textContent ?? "");
    assert.doesNotMatch(text, /Ada Lovelace/);
    assert.doesNotMatch(text, /Ada's Library/);
    assert.equal(stub.localApis.length, 0);
  } finally {
    await page.close();
  }
});

test("an expired session returns to signed out", async () => {
  resetStub("expire");
  const page = await openPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForFunction(() => (document.body.textContent ?? "").includes("Desk"), { timeout: 5000 });
    await page.waitForSelector(".hosted-session .btn.primary", { timeout: 8000 });
    const text = await page.evaluate(() => document.body.textContent ?? "");
    assert.doesNotMatch(text, /Ada Lovelace/);
    assert.equal(stub.localApis.length, 0);
  } finally {
    await page.close();
  }
});

test("disabled access is denied and can sign out", async () => {
  resetStub("denied");
  const page = await openPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForFunction(() => (document.body.textContent ?? "").includes("Access denied."), { timeout: 5000 });
    const text = await page.evaluate(() => document.body.textContent ?? "");
    assert.match(text, /Sign out/);
    assert.doesNotMatch(text, /Ada Lovelace/);
    assert.doesNotMatch(text, /Ada's Library/);
    assert.doesNotMatch(text, /Continue with Google/);
    await page.click(".hosted-session .btn");
    await page.waitForSelector(".hosted-session .btn.primary", { timeout: 5000 });
    assert.equal(stub.localApis.length, 0);
  } finally {
    await page.close();
  }
});

test("callback failure is generic and stripped from the URL", async () => {
  resetStub("signed-out");
  const page = await openPage();
  try {
    await page.goto(`${BASE}/?error=access_denied&error_description=denied`, { waitUntil: "load" });
    await page.waitForSelector(".hosted-session .btn.primary", { timeout: 5000 });
    const text = await page.evaluate(() => document.body.textContent ?? "");
    assert.match(text, /Google sign-in failed/);
    assert.match(text, /Continue with Google/);
    assert.equal(page.url(), `${BASE}/`);
    assert.equal(stub.localApis.length, 0);
  } finally {
    await page.close();
  }
});

test("Retry recovers from a load failure", async () => {
  resetStub("fail");
  const page = await openPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForFunction(() => (document.body.textContent ?? "").includes("Could not load session."), { timeout: 5000 });
    stub.mode = "signed-out";
    await page.click(".hosted-session .btn.primary");
    await page.waitForFunction(() => (document.body.textContent ?? "").includes("Continue with Google"), { timeout: 5000 });
    assert.equal(stub.localApis.length, 0);
  } finally {
    await page.close();
  }
});

test("Continue with Google is keyboard reachable and the shell holds at 320", async () => {
  resetStub("signed-out");
  const page = await openPage();
  try {
    await page.goto(`${BASE}/`, { waitUntil: "load" });
    await page.waitForSelector(".hosted-session .btn.primary", { timeout: 5000 });
    await page.focus(".hosted-session .btn.primary");
    assert.equal(
      await page.evaluate(() => document.activeElement?.textContent?.trim()),
      "Continue with Google",
    );
    await page.setViewport({ width: 320, height: 800 });
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1),
      true,
      "no overflow at 320px",
    );
    assert.equal(stub.localApis.length, 0);
  } finally {
    await page.close();
  }
});
});
