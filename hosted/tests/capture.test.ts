import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";

const HOSTED_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SECRET = "test-secret-test-secret-test-secret";
const CSRF_SECRET = "csrf-secret-csrf-secret-csrf-secret";
const PORT = 8808;
const ORIGIN = `http://127.0.0.1:${PORT}`;

function cookieFrom(res: Response): string {
  const parts = res.headers.getSetCookie?.() ?? [];
  return parts.map((c) => c.split(";")[0]).join("; ");
}

function applyMigrations(persistTo: string) {
  execFileSync(
    "npx",
    ["wrangler", "d1", "migrations", "apply", "locus-identity", "--local", "--persist-to", persistTo],
    { cwd: HOSTED_ROOT, env: { ...process.env, CI: "1" }, stdio: "pipe" },
  );
}

async function start(persistTo: string): Promise<Unstable_DevWorker> {
  applyMigrations(persistTo);
  return unstable_dev("tests/worker.ts", {
    config: "wrangler.jsonc",
    ip: "127.0.0.1",
    port: PORT,
    localProtocol: "http",
    persist: true,
    persistTo,
    logLevel: "error",
    vars: {
      BETTER_AUTH_URL: ORIGIN,
      BETTER_AUTH_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      CSRF_SECRET,
      REGISTRATION_MODE: "open",
    },
    experimental: { disableExperimentalWarning: true },
  });
}

async function json(worker: Unstable_DevWorker, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", ORIGIN);
  const res = await worker.fetch(`${ORIGIN}${path}`, { ...init, headers });
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  return { res, body };
}

async function login(worker: Unstable_DevWorker, email: string, name = "Ada") {
  const { res, body } = await json(worker, "/__test/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, name, accountId: email }),
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  return { cookie: cookieFrom(res), body: body as { user: { id: string } } };
}

type HostedSession = { library: { id: string }; csrfToken: string };

async function sessionOf(worker: Unstable_DevWorker, cookie: string): Promise<HostedSession> {
  const { res, body } = await json(worker, "/api/session", { headers: { cookie } });
  assert.equal(res.status, 200, JSON.stringify(body));
  return body as HostedSession;
}

function mutate(cookie: string, csrf: string, extra: Record<string, string> = {}) {
  return {
    cookie,
    "content-type": "application/json",
    "x-csrf-token": csrf,
    ...extra,
  };
}

function bearer(token: string) {
  return { authorization: `Bearer ${token}`, "content-type": "application/json" };
}

const JSONL = [
  JSON.stringify({
    type: "session",
    protocolVersion: 1,
    source: "x",
    producer: { id: "test", version: "1" },
    accountExternalId: "ada",
    collection: { externalId: "bookmarks", name: "Bookmarks" },
    mode: "incremental",
    observedAt: "2026-01-01T00:00:00.000Z",
  }),
  JSON.stringify({
    type: "batch",
    sessionId: "ignored",
    sequence: 1,
    idempotencyKey: "import-1",
    changes: [
      {
        kind: "upsert",
        externalId: "post-1",
        item: { contentType: "post", body: "imported save", url: "https://x.com/ada/status/1" },
      },
    ],
  }),
  JSON.stringify({ type: "finish", sessionId: "ignored", coverage: "partial" }),
].join("\n");

let persistTo: string;
let worker: Unstable_DevWorker;

before(async () => {
  const spaDir = join(HOSTED_ROOT, "../dist/hosted-app");
  if (!existsSync(join(spaDir, "index.html"))) {
    await mkdir(spaDir, { recursive: true });
    await writeFile(
      join(spaDir, "index.html"),
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Locus</title></head><body><div id="root"></div></body></html>\n`,
    );
  }
  persistTo = await mkdtemp(join(tmpdir(), "locus-capture-"));
  worker = await start(persistTo);
});

after(async () => {
  await worker?.stop();
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

test("anonymous private source routes are 401 and hello does not mint a token", async () => {
  const sources = await json(worker, "/api/sources");
  assert.equal(sources.res.status, 401);
  const pair = await json(worker, "/api/extension/pair", { method: "POST", body: "{}" });
  assert.equal(pair.res.status, 401);
  const hello = await json(worker, "/capture/v1/hello", { method: "POST", body: "{}" });
  assert.equal(hello.res.status, 401);
  assert.deepEqual(hello.body, { error: "invalid token" });
});

test("pair is Library-scoped and hello confirms the same token", async () => {
  const user = await login(worker, "pair-a@example.com", "PairA");
  const session = await sessionOf(worker, user.cookie);
  const pair = await json(worker, "/api/extension/pair", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: "{}",
  });
  assert.equal(pair.res.status, 200, JSON.stringify(pair.body));
  const issued = pair.body as { token: string; origin: string };
  assert.match(issued.token, /^loc_/);
  assert.equal(issued.origin, ORIGIN);

  const hello = await json(worker, "/capture/v1/hello", {
    method: "POST",
    body: JSON.stringify({ token: issued.token }),
  });
  assert.equal(hello.res.status, 200, JSON.stringify(hello.body));
  assert.deepEqual(hello.body, { token: issued.token, origin: ORIGIN });
});

test("connect without a paired extension does not start Chrome", async () => {
  const user = await login(worker, "no-ext@example.com", "NoExt");
  const session = await sessionOf(worker, user.cookie);
  const connected = await json(worker, "/api/sources/x/connect", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: "{}",
  });
  assert.equal(connected.res.status, 409, JSON.stringify(connected.body));
  assert.deepEqual(connected.body, { error: "Pair the browser extension first." });
});

test("paired extension can capture into its Library only", async () => {
  const a = await login(worker, "cap-a@example.com", "CapA");
  const b = await login(worker, "cap-b@example.com", "CapB");
  const sessionA = await sessionOf(worker, a.cookie);
  const sessionB = await sessionOf(worker, b.cookie);
  assert.notEqual(sessionA.library.id, sessionB.library.id);

  const pairA = await json(worker, "/api/extension/pair", {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: "{}",
  });
  const tokenA = (pairA.body as { token: string }).token;
  await json(worker, "/capture/v1/hello", { method: "POST", body: JSON.stringify({ token: tokenA }) });

  const pairB = await json(worker, "/api/extension/pair", {
    method: "POST",
    headers: mutate(b.cookie, sessionB.csrfToken),
    body: "{}",
  });
  const tokenB = (pairB.body as { token: string }).token;

  const connect = await json(worker, "/api/sources/x/connect", {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: "{}",
  });
  assert.equal(connect.res.status, 200, JSON.stringify(connect.body));
  assert.equal((connect.body as { via: string }).via, "extension");

  const waited = await json(worker, "/capture/v1/jobs/wait", { headers: bearer(tokenA) });
  assert.equal(waited.res.status, 200, JSON.stringify(waited.body));
  const job = waited.body as { id: string; source: string; url: string; token?: string };
  assert.equal(job.source, "x");
  assert.ok(job.token);

  const status = await json(worker, `/capture/v1/jobs/${job.id}`, { headers: bearer(tokenA) });
  assert.equal(status.res.status, 200);
  assert.equal("token" in (status.body as object), false);

  const crossJob = await json(worker, `/capture/v1/jobs/${job.id}`, { headers: bearer(tokenB) });
  assert.equal(crossJob.res.status, 404);

  const guessed = await json(worker, "/capture/v1/jobs/00000000-0000-4000-8000-000000000000", {
    headers: bearer(tokenA),
  });
  assert.equal(guessed.res.status, 404);

  const started = await json(worker, "/capture/v1/sessions", {
    method: "POST",
    headers: bearer(job.token),
    body: JSON.stringify({
      protocolVersion: 1,
      source: "x",
      producer: { id: "test", version: "1" },
      accountExternalId: "ada-x",
      collection: { externalId: "bookmarks", name: "Bookmarks" },
      mode: "incremental",
      observedAt: "2026-01-02T00:00:00.000Z",
    }),
  });
  assert.equal(started.res.status, 200, JSON.stringify(started.body));
  const sessionId = (started.body as { sessionId: string }).sessionId;

  const batchBody = {
    sessionId,
    sequence: 1,
    idempotencyKey: "cap-1",
    changes: [
      {
        kind: "upsert",
        externalId: "item-1",
        item: { contentType: "post", body: "secret", url: "https://x.com/ada/status/item-1" },
      },
    ],
  };
  const batch = await json(worker, "/capture/v1/batches", {
    method: "POST",
    headers: bearer(job.token),
    body: JSON.stringify(batchBody),
  });
  assert.equal(batch.res.status, 200, JSON.stringify(batch.body));
  assert.equal((batch.body as { inserted: number }).inserted, 1);

  const replay = await json(worker, "/capture/v1/batches", {
    method: "POST",
    headers: bearer(job.token),
    body: JSON.stringify(batchBody),
  });
  assert.equal(replay.res.status, 200);
  assert.equal((replay.body as { replayed: boolean }).replayed, true);

  const wrongLibrary = await json(worker, "/capture/v1/batches", {
    method: "POST",
    headers: bearer(tokenB),
    body: JSON.stringify(batchBody),
  });
  assert.equal(wrongLibrary.res.status, 404);

  const unknown = await json(worker, "/capture/v1/batches", {
    method: "POST",
    headers: bearer(tokenB),
    body: JSON.stringify({ ...batchBody, sessionId: "unknown-session" }),
  });
  assert.equal(unknown.res.status, 404);

  const finished = await json(worker, "/capture/v1/finish", {
    method: "POST",
    headers: bearer(job.token),
    body: JSON.stringify({ sessionId, coverage: "partial" }),
  });
  assert.equal(finished.res.status, 200, JSON.stringify(finished.body));

  const listA = await json(worker, "/api/items", { headers: { cookie: a.cookie } });
  const itemsA = (listA.body as { items: { id: string; url: string; source: string | null }[] }).items;
  assert.equal(itemsA.length, 1);
  assert.equal(itemsA[0].url, "https://x.com/ada/status/item-1");
  assert.equal(itemsA[0].source, "x");

  const listB = await json(worker, "/api/items", { headers: { cookie: b.cookie } });
  assert.deepEqual((listB.body as { items: unknown[] }).items, []);

  const crossItem = await json(worker, `/api/items/${itemsA[0].id}`, { headers: { cookie: b.cookie } });
  assert.equal(crossItem.res.status, 404);

  const filtered = await json(worker, "/api/items?source=x", { headers: { cookie: a.cookie } });
  assert.equal((filtered.body as { items: unknown[] }).items.length, 1);
});

test("import JSONL dry-run does not write; import is Library-scoped", async () => {
  const a = await login(worker, "imp-a@example.com", "ImpA");
  const b = await login(worker, "imp-b@example.com", "ImpB");
  const sessionA = await sessionOf(worker, a.cookie);
  const sessionB = await sessionOf(worker, b.cookie);

  const dry = await json(worker, "/api/import/jsonl", {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: JSON.stringify({ text: JSONL, dryRun: true }),
  });
  assert.equal(dry.res.status, 200, JSON.stringify(dry.body));
  assert.equal((dry.body as { sessions: number; changes: number }).sessions, 1);
  assert.equal((dry.body as { changes: number }).changes, 1);
  const empty = await json(worker, "/api/items", { headers: { cookie: a.cookie } });
  assert.deepEqual((empty.body as { items: unknown[] }).items, []);

  const imported = await json(worker, "/api/import/jsonl", {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: JSON.stringify({ text: JSONL, dryRun: false }),
  });
  assert.equal(imported.res.status, 200, JSON.stringify(imported.body));
  assert.equal((imported.body as { inserted: number }).inserted, 1);

  const listA = await json(worker, "/api/items", { headers: { cookie: a.cookie } });
  const itemsA = (listA.body as { items: { url: string }[] }).items;
  assert.equal(itemsA.length, 1);
  assert.equal(itemsA[0].url, "https://x.com/ada/status/1");

  const importedB = await json(worker, "/api/import/jsonl", {
    method: "POST",
    headers: mutate(b.cookie, sessionB.csrfToken),
    body: JSON.stringify({ text: JSONL, dryRun: false }),
  });
  assert.equal(importedB.res.status, 200, JSON.stringify(importedB.body));
  const listB = await json(worker, "/api/items", { headers: { cookie: b.cookie } });
  assert.equal((listB.body as { items: { url: string }[] }).items.length, 1);

  const overview = await json(worker, "/api/sources", { headers: { cookie: a.cookie } });
  assert.equal(overview.res.status, 200);
  const body = overview.body as {
    account: { mode: string };
    connections: { source: string }[];
    imports: { itemCount: number }[];
  };
  assert.equal(body.account.mode, "hosted");
  assert.deepEqual(
    body.connections.map((c) => c.source),
    ["x", "instagram", "youtube", "reddit"],
  );
  assert.equal(body.imports.length, 1);
  assert.equal(body.imports[0].itemCount, 1);
});
