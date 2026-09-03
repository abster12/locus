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
const PORT = 8811;
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

function utcToday(): string {
  return new Date().toISOString().slice(0, 10);
}

type SummarySnapshot = {
  scope: string;
  scopeRef: string;
  generatedAt: string;
  blocks: { kind: string; title: string; count?: number; itemIds?: string[]; rows?: Record<string, unknown>[] }[];
  items: { id: string; url: string }[];
};

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
  persistTo = await mkdtemp(join(tmpdir(), "locus-step7-"));
  worker = await start(persistTo);
});

after(async () => {
  await worker?.stop();
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

test("anonymous summary, preview, and frame-check routes are 401", async () => {
  for (const path of [
    `/api/summaries/day/${utcToday()}`,
    "/api/link-preview?url=https://example.com/",
    "/api/frame-check?url=https://example.com/",
  ]) {
    const { res, body } = await json(worker, path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(body, { error: "Unauthorized" });
  }
  const { res } = await json(worker, `/api/summaries/day/${utcToday()}/prose`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 401);
});

test("summaries are Library-scoped and prose stays unavailable on hosted", async () => {
  const ada = await login(worker, "step7-ada@example.com", "Ada");
  const gus = await login(worker, "step7-gus@example.com", "Gus");
  const adaSession = await sessionOf(worker, ada.cookie);
  const gusSession = await sessionOf(worker, gus.cookie);

  const saved = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ url: "https://example.com/ada-article", title: "Ada's article" }),
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  const itemId = (saved.body as { item: { id: string } }).item.id;

  // Collection for the collection scope.
  const col = await json(worker, "/api/collections", {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ name: "Step7" }),
  });
  assert.equal(col.res.status, 200, JSON.stringify(col.body));
  const collectionId = (col.body as { collection: { id: string } }).collection.id;

  // Ada's day snapshot contains her Item and the deterministic blocks.
  const day = await json(worker, `/api/summaries/day/${utcToday()}`, { headers: { cookie: ada.cookie } });
  assert.equal(day.res.status, 200, JSON.stringify(day.body));
  const daySnap = (day.body as { snapshot: SummarySnapshot; pi: { available: boolean; detail: string } }).snapshot;
  const pi = (day.body as { pi: { available: boolean; detail: string } }).pi;
  assert.equal(daySnap.scope, "day");
  assert.equal(daySnap.items.length, 1);
  assert.equal(daySnap.items[0].url, "https://example.com/ada-article");
  assert.equal(daySnap.blocks.some((b) => b.kind === "inbox"), true);
  assert.equal(pi.available, false);

  // Gus's day snapshot in his own Library is empty: no Ada rows leak.
  const gusDay = await json(worker, `/api/summaries/day/${utcToday()}`, { headers: { cookie: gus.cookie } });
  assert.equal(gusDay.res.status, 200);
  assert.equal((gusDay.body as { snapshot: SummarySnapshot }).snapshot.items.length, 0);

  // Cross-tenant refs resolve to empty snapshots, not errors: item, selection,
  // and collection refs from another Library match nothing in Gus's Library.
  for (const path of [
    `/api/summaries/item/${itemId}`,
    `/api/summaries/selection/${itemId}`,
    `/api/summaries/collection/${collectionId}`,
  ]) {
    const cross = await json(worker, path, { headers: { cookie: gus.cookie } });
    assert.equal(cross.res.status, 200, path);
    const snap = (cross.body as { snapshot: SummarySnapshot }).snapshot;
    assert.equal(snap.items.length, 0, path);
    const links = snap.blocks.find((b) => b.kind === "citations");
    assert.deepEqual(links?.itemIds ?? [], [], path);
  }

  // Prose stays unavailable until an approved Worker secret exists.
  const prose = await json(worker, `/api/summaries/day/${utcToday()}/prose`, {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: "{}",
  });
  assert.equal(prose.res.status, 400, JSON.stringify(prose.body));
  assert.match(String((prose.body as { error: string }).error), /deployment|AI|available/i);
  assert.ok((prose.body as { snapshot: SummarySnapshot }).snapshot, "prose rejection still carries the snapshot");

  // Bad scope is a 404 via the desk path matcher, not a crash.
  const badScope = await json(worker, "/api/summaries/bogus/ref", { headers: { cookie: ada.cookie } });
  assert.equal(badScope.res.status, 404);
});

test("link preview and frame-check reject unsafe targets without egress", async () => {
  const ada = await login(worker, "step7-preview@example.com", "Ada");
  const adaSession = await sessionOf(worker, ada.cookie);
  void adaSession;

  // SSRF policy: non-http scheme, loopback, and private addresses are blocked
  // before any fetch, so the preview degrades to an error row instead.
  for (const url of ["javascript:alert(1)", "http://localhost/x", "http://127.0.0.1/x", "http://10.0.0.1/x", "not a url"]) {
    const { res, body } = await json(worker, `/api/link-preview?url=${encodeURIComponent(url)}`, {
      headers: { cookie: ada.cookie },
    });
    assert.equal(res.status, 200, url);
    const preview = (body as { preview: { url: string; status: string } }).preview;
    assert.equal(preview.status, "error", url);
    assert.equal(preview.url, url);
  }

  // Missing url parameter is an error preview, not a crash.
  const missing = await json(worker, "/api/link-preview", { headers: { cookie: ada.cookie } });
  assert.equal(missing.res.status, 200);
  assert.equal((missing.body as { preview: { status: string } }).preview.status, "error");

  // Frame-check cannot verify blocked or malformed targets: unknown, not yes.
  for (const url of ["http://localhost/x", "http://192.168.1.1/x", "javascript:alert(1)", "not a url"]) {
    const { res, body } = await json(worker, `/api/frame-check?url=${encodeURIComponent(url)}`, {
      headers: { cookie: ada.cookie },
    });
    assert.equal(res.status, 200, url);
    assert.equal((body as { framed: string }).framed, "unknown", url);
  }
});

test("public share page serves the snapshot and 404s revoked tokens", async () => {
  const ada = await login(worker, "step7-share@example.com", "Ada");
  const adaSession = await sessionOf(worker, ada.cookie);

  const created = await json(worker, "/api/trips", {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ destination: "Porto", durationDays: 2, clientMutationId: "step7-trip-1" }),
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  const tripId = (created.body as { trip: { id: string; revision: number } }).trip.id;

  const preview = await json(worker, `/api/trips/${tripId}/share/preview`, {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: "{}",
  });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  const digest = (preview.body as { digest: string }).digest;

  const publish = await json(worker, `/api/trips/${tripId}/share/publish`, {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ digest, expectedRevision: 1, clientMutationId: "step7-share-publish-1" }),
  });
  assert.equal(publish.res.status, 200, JSON.stringify(publish.body));
  const token = (publish.body as { token: string }).token;
  const publishedRevision = (publish.body as { revision: number }).revision;
  assert.ok(token);

  // Public page: no cookie, no session.
  const page = await worker.fetch(`${ORIGIN}/s/${token}`);
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-type") ?? "", /text\/html/);
  const html = await page.text();
  assert.match(html, /Porto/);
  assert.match(html, /Shared from Locus/);
  assert.doesNotMatch(html, /<script/);

  // Another user's cookie changes nothing on the public page.
  const gus = await login(worker, "step7-share-gus@example.com", "Gus");
  const pageAsGus = await worker.fetch(`${ORIGIN}/s/${token}`, { headers: { cookie: gus.cookie } });
  assert.equal(pageAsGus.status, 200);

  // Unknown and revoked tokens get the same empty 404.
  const missing = await worker.fetch(`${ORIGIN}/s/not-a-real-token-value`);
  assert.equal(missing.status, 404);

  const revoke = await json(worker, `/api/trips/${tripId}/share/revoke`, {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ expectedRevision: publishedRevision, clientMutationId: "step7-share-revoke-1" }),
  });
  assert.equal(revoke.res.status, 200, JSON.stringify(revoke.body));
  const revoked = await worker.fetch(`${ORIGIN}/s/${token}`);
  assert.equal(revoked.status, 404);
});
