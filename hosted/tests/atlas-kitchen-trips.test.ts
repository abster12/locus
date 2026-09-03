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
const PORT = 8807;
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

async function saveTagged(
  worker: Unstable_DevWorker,
  cookie: string,
  csrf: string,
  url: string,
  tag: string,
): Promise<{ id: string }> {
  const saved = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(cookie, csrf),
    body: JSON.stringify({ url, title: tag, body: `${tag} save`, newTags: [tag] }),
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  return (saved.body as { item: { id: string } }).item;
}

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
  persistTo = await mkdtemp(join(tmpdir(), "locus-akt-"));
  worker = await start(persistTo);
});

after(async () => {
  await worker?.stop();
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

test("anonymous kitchen, atlas, and trips routes are 401", async () => {
  for (const path of ["/api/kitchen", "/api/atlas", "/api/trips", "/api/kitchen/ai"]) {
    const { res, body } = await json(worker, path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(body, { error: "Unauthorized" });
  }
});

test("kitchen lists only the owner's food items and keeps Tonight inside one Library", async () => {
  const ada = await login(worker, "kitchen-ada@example.com", "Ada");
  const gus = await login(worker, "kitchen-gus@example.com", "Gus");
  const adaSession = await sessionOf(worker, ada.cookie);
  const gusSession = await sessionOf(worker, gus.cookie);
  const adaItem = await saveTagged(worker, ada.cookie, adaSession.csrfToken, "https://example.com/ada-food", "food");
  const gusItem = await saveTagged(worker, gus.cookie, gusSession.csrfToken, "https://example.com/gus-food", "food");

  const adaIndex = await json(worker, "/api/kitchen", { headers: { cookie: ada.cookie } });
  assert.equal(adaIndex.res.status, 200, JSON.stringify(adaIndex.body));
  const adaIds = ((adaIndex.body as { items: { item: { id: string } }[] }).items).map((row) => row.item.id);
  assert.ok(adaIds.includes(adaItem.id));
  assert.ok(!adaIds.includes(gusItem.id));

  const tonight = await json(worker, "/api/kitchen/tonight", {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ itemId: adaItem.id }),
  });
  assert.equal(tonight.res.status, 200, JSON.stringify(tonight.body));

  const gusTonight = await json(worker, "/api/kitchen/tonight", { headers: { cookie: gus.cookie } });
  assert.equal(gusTonight.res.status, 200);
  assert.equal((gusTonight.body as unknown[]).length, 0);

  const cross = await json(worker, `/api/kitchen/items/${gusItem.id}`, { headers: { cookie: ada.cookie } });
  assert.equal(cross.res.status, 404);

  const ai = await json(worker, "/api/kitchen/ai", { headers: { cookie: ada.cookie } });
  assert.equal(ai.res.status, 200);
  assert.equal((ai.body as { available: boolean }).available, false);
});

test("atlas home and travel review stay inside one Library", async () => {
  const ada = await login(worker, "atlas-ada@example.com", "Ada");
  const gus = await login(worker, "atlas-gus@example.com", "Gus");
  const adaSession = await sessionOf(worker, ada.cookie);
  const gusSession = await sessionOf(worker, gus.cookie);
  const adaItem = await saveTagged(worker, ada.cookie, adaSession.csrfToken, "https://example.com/ada-travel", "travel");
  await saveTagged(worker, gus.cookie, gusSession.csrfToken, "https://example.com/gus-travel", "travel");

  const atlas = await json(worker, "/api/atlas", { headers: { cookie: ada.cookie } });
  assert.equal(atlas.res.status, 200, JSON.stringify(atlas.body));
  const reviewIds = ((atlas.body as { needsPlace: { items: { item: { id: string } }[] } }).needsPlace.items).map(
    (row) => row.item.id,
  );
  assert.ok(reviewIds.includes(adaItem.id));
  assert.equal(reviewIds.length, 1);

  const home = await json(worker, "/api/atlas/home", {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ name: "Lisbon", kind: "city" }),
  });
  assert.equal(home.res.status, 200, JSON.stringify(home.body));
  const placeId = (home.body as { home: { id: string } }).home.id;

  const gusAtlas = await json(worker, "/api/atlas", { headers: { cookie: gus.cookie } });
  assert.equal((gusAtlas.body as { home: { place: unknown } }).home.place, null);
  const gusPlaces = await json(worker, "/api/atlas/places?q=Lisbon", { headers: { cookie: gus.cookie } });
  assert.equal((gusPlaces.body as { places: unknown[] }).places.length, 0);

  const placed = await json(worker, `/api/atlas/items/${adaItem.id}/place`, {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ placeId, expectedVersion: 0 }),
  });
  assert.equal(placed.res.status, 200, JSON.stringify(placed.body));

  const guessed = await json(worker, `/api/atlas/items/${crypto.randomUUID()}/not-atlas`, {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ expectedVersion: 0 }),
  });
  assert.equal(guessed.res.status, 404);
});

test("trips create, list, and guessed ids stay inside one Library", async () => {
  const ada = await login(worker, "trips-ada@example.com", "Ada");
  const gus = await login(worker, "trips-gus@example.com", "Gus");
  const adaSession = await sessionOf(worker, ada.cookie);
  const gusSession = await sessionOf(worker, gus.cookie);

  const created = await json(worker, "/api/trips", {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({
      destination: "Lisbon",
      durationDays: 3,
      clientMutationId: "trip-ada-1",
    }),
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  const tripId = (created.body as { trip: { id: string; revision: number } }).trip.id;

  const adaList = await json(worker, "/api/trips", { headers: { cookie: ada.cookie } });
  assert.equal((adaList.body as { trips: { id: string }[] }).trips.some((trip) => trip.id === tripId), true);

  const gusList = await json(worker, "/api/trips", { headers: { cookie: gus.cookie } });
  assert.equal((gusList.body as { trips: unknown[] }).trips.length, 0);

  const cross = await json(worker, `/api/trips/${tripId}`, { headers: { cookie: gus.cookie } });
  assert.equal(cross.res.status, 404);

  const guessed = await json(worker, `/api/trips/${crypto.randomUUID()}`, { headers: { cookie: ada.cookie } });
  assert.equal(guessed.res.status, 404);

  const renamed = await json(worker, `/api/trips/${tripId}/rename`, {
    method: "POST",
    headers: mutate(ada.cookie, adaSession.csrfToken),
    body: JSON.stringify({ title: "Lisbon spring", expectedRevision: 1, clientMutationId: "trip-ada-rename" }),
  });
  assert.equal(renamed.res.status, 200, JSON.stringify(renamed.body));

  const gusRename = await json(worker, `/api/trips/${tripId}/rename`, {
    method: "POST",
    headers: mutate(gus.cookie, gusSession.csrfToken),
    body: JSON.stringify({ title: "stolen", expectedRevision: 1, clientMutationId: "trip-gus-steal" }),
  });
  assert.equal(gusRename.res.status, 404);
});
