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
const PORT = 8805;
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
  persistTo = await mkdtemp(join(tmpdir(), "locus-desk-"));
  worker = await start(persistTo);
});

after(async () => {
  await worker?.stop();
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

test("anonymous private desk routes are 401", async () => {
  for (const path of ["/api/items", "/api/items/counts", "/api/items/not-an-item", "/api/collections"]) {
    const { res, body } = await json(worker, path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(body, { error: "Unauthorized" });
  }
  for (const path of [
    "/api/intake",
    "/api/collections",
    "/api/items/not-an-item/status",
    "/api/items/not-an-item/tags",
    "/api/items/not-an-item/notes",
  ]) {
    const { res, body } = await json(worker, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401, path);
    assert.deepEqual(body, { error: "Unauthorized" });
  }
});

test("two users each save a URL and cannot see the other's Item", async () => {
  const a = await login(worker, "desk-a@example.com", "DeskA");
  const b = await login(worker, "desk-b@example.com", "DeskB");
  const sessionA = await sessionOf(worker, a.cookie);
  const sessionB = await sessionOf(worker, b.cookie);
  assert.notEqual(sessionA.library.id, sessionB.library.id);

  const savedA = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: JSON.stringify({ url: "https://example.com/shared", title: "Ada's copy" }),
  });
  assert.equal(savedA.res.status, 200, JSON.stringify(savedA.body));
  const itemA = savedA.body as { outcome: string; item: { id: string; url: string; title: string; status: string } };
  assert.equal(itemA.outcome, "created");
  assert.equal(itemA.item.url, "https://example.com/shared");
  assert.equal(itemA.item.title, "Ada's copy");
  assert.equal(itemA.item.status, "inbox");

  const savedB = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(b.cookie, sessionB.csrfToken),
    body: JSON.stringify({ url: "https://example.com/shared", title: "Bob's copy" }),
  });
  assert.equal(savedB.res.status, 200, JSON.stringify(savedB.body));
  const itemB = savedB.body as { outcome: string; item: { id: string; title: string } };
  assert.equal(itemB.outcome, "created");
  assert.equal(itemB.item.title, "Bob's copy");
  assert.notEqual(itemA.item.id, itemB.item.id);

  const listA = await json(worker, "/api/items", { headers: { cookie: a.cookie } });
  assert.equal(listA.res.status, 200);
  const pageA = listA.body as { items: { id: string; title: string }[] };
  assert.deepEqual(pageA.items.map((item) => item.id), [itemA.item.id]);

  const listB = await json(worker, "/api/items", { headers: { cookie: b.cookie } });
  const pageB = listB.body as { items: { id: string }[] };
  assert.deepEqual(pageB.items.map((item) => item.id), [itemB.item.id]);

  const cross = await json(worker, `/api/items/${itemB.item.id}`, { headers: { cookie: a.cookie } });
  assert.equal(cross.res.status, 404);
  assert.deepEqual(cross.body, { error: "Not found" });

  const guessed = await json(worker, "/api/items/00000000-0000-4000-8000-000000000000", {
    headers: { cookie: a.cookie },
  });
  assert.equal(guessed.res.status, 404);

  const own = await json(worker, `/api/items/${itemA.item.id}`, { headers: { cookie: a.cookie } });
  assert.equal(own.res.status, 200);
  assert.equal((own.body as { item: { id: string } }).item.id, itemA.item.id);
});

test("saving the same URL twice in one Library reuses the Item", async () => {
  const user = await login(worker, "desk-reuse@example.com", "Reuse");
  const session = await sessionOf(worker, user.cookie);
  const first = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ url: "https://example.com/once" }),
  });
  const second = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ url: "https://example.com/once", title: "Again" }),
  });
  assert.equal(first.res.status, 200, JSON.stringify(first.body));
  assert.equal(second.res.status, 200, JSON.stringify(second.body));
  assert.equal((first.body as { outcome: string }).outcome, "created");
  assert.equal((second.body as { outcome: string }).outcome, "reused");
  assert.equal((first.body as { item: { id: string } }).item.id, (second.body as { item: { id: string } }).item.id);
  const list = await json(worker, "/api/items", { headers: { cookie: user.cookie } });
  assert.equal(((list.body as { items: unknown[] }).items).length, 1);
});

test("preview does not insert", async () => {
  const user = await login(worker, "desk-preview@example.com", "Preview");
  const session = await sessionOf(worker, user.cookie);
  const preview = await json(worker, "/api/intake/preview", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ url: "https://example.com/preview-only", title: "Draft" }),
  });
  assert.equal(preview.res.status, 200, JSON.stringify(preview.body));
  const shown = preview.body as { item: { url: string; title: string }; missing: string[] };
  assert.equal(shown.item.url, "https://example.com/preview-only");
  assert.equal(shown.item.title, "Draft");
  assert.ok(shown.missing.includes("source text"));
  const list = await json(worker, "/api/items", { headers: { cookie: user.cookie } });
  assert.equal(((list.body as { items: unknown[] }).items).length, 0);
  const counts = await json(worker, "/api/items/counts", { headers: { cookie: user.cookie } });
  assert.equal((counts.body as { counts: { total: number } }).counts.total, 0);
});

test("unsupported body fields are 400", async () => {
  const user = await login(worker, "desk-fields@example.com", "Fields");
  const session = await sessionOf(worker, user.cookie);
  const headers = mutate(user.cookie, session.csrfToken);
  const libraryId = await json(worker, "/api/intake", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "https://example.com/spoof", libraryId: session.library.id }),
  });
  assert.equal(libraryId.res.status, 400);
  assert.match(JSON.stringify(libraryId.body), /unsupported field/);
  const actor = await json(worker, "/api/intake", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "https://example.com/spoof", actor: "agent" }),
  });
  assert.equal(actor.res.status, 400);
  assert.match(JSON.stringify(actor.body), /unsupported field/);
  const preview = await json(worker, "/api/intake/preview", {
    method: "POST",
    headers,
    body: JSON.stringify({ url: "https://example.com/spoof", libraryId: "other" }),
  });
  assert.equal(preview.res.status, 400);
});

test("intake CSRF and origin match other private mutations", async () => {
  const user = await login(worker, "desk-csrf@example.com", "Csrf");
  const other = await login(worker, "desk-csrf-b@example.com", "CsrfB");
  const session = await sessionOf(worker, user.cookie);
  const otherSession = await sessionOf(worker, other.cookie);
  const path = "/api/intake";
  const body = JSON.stringify({ url: "https://example.com/csrf-item" });
  const headers = mutate(user.cookie, session.csrfToken);

  const noCsrf = await json(worker, path, {
    method: "POST",
    headers: { cookie: user.cookie, "content-type": "application/json" },
    body,
  });
  assert.equal(noCsrf.res.status, 403);

  const stale = await json(worker, path, {
    method: "POST",
    headers: { ...headers, "x-csrf-token": otherSession.csrfToken },
    body,
  });
  assert.equal(stale.res.status, 403);

  const wrongOrigin = await json(worker, path, {
    method: "POST",
    headers: { ...headers, origin: "https://evil.example" },
    body,
  });
  assert.equal(wrongOrigin.res.status, 403);

  const ok = await json(worker, path, { method: "POST", headers, body });
  assert.equal(ok.res.status, 200, JSON.stringify(ok.body));
});

test("disabled user is 403 on desk routes while the cookie remains", async () => {
  const user = await login(worker, "desk-disabled@example.com", "No");
  const session = await sessionOf(worker, user.cookie);
  await json(worker, "/__test/disable", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: user.body.user.id }),
  });
  const list = await json(worker, "/api/items", { headers: { cookie: user.cookie } });
  assert.equal(list.res.status, 403);
  const write = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ url: "https://example.com/disabled" }),
  });
  assert.equal(write.res.status, 403);
  const status = await json(worker, "/api/items/not-an-item/status", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ status: "accepted" }),
  });
  assert.equal(status.res.status, 403);
});

test("query libraryId is ignored and collections start empty", async () => {
  const user = await login(worker, "desk-query@example.com", "Query");
  const other = await login(worker, "desk-query-b@example.com", "QueryB");
  const session = await sessionOf(worker, user.cookie);
  const otherSession = await sessionOf(worker, other.cookie);
  await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ url: "https://example.com/query" }),
  });
  const spoofed = await json(
    worker,
    `/api/items?libraryId=${otherSession.library.id}&library_id=${otherSession.library.id}`,
    { headers: { cookie: user.cookie } },
  );
  assert.equal(spoofed.res.status, 200);
  assert.equal(((spoofed.body as { items: unknown[] }).items).length, 1);
  const collections = await json(worker, "/api/collections", { headers: { cookie: user.cookie } });
  assert.equal(collections.res.status, 200);
  assert.deepEqual(collections.body, { collections: [], tags: [] });
});

async function saveUrl(cookie: string, csrf: string, url: string, title?: string) {
  const saved = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(cookie, csrf),
    body: JSON.stringify(title ? { url, title } : { url }),
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  return saved.body as { item: { id: string; status: string; tags: { id: string; name: string }[] } };
}

test("status, tags, notes, and collections stay inside one Library", async () => {
  const a = await login(worker, "desk-mut-a@example.com", "MutA");
  const b = await login(worker, "desk-mut-b@example.com", "MutB");
  const sessionA = await sessionOf(worker, a.cookie);
  const sessionB = await sessionOf(worker, b.cookie);
  const itemA = (await saveUrl(a.cookie, sessionA.csrfToken, "https://example.com/mut-a", "Ada item")).item;
  const itemB = (await saveUrl(b.cookie, sessionB.csrfToken, "https://example.com/mut-b", "Bob item")).item;
  const headersA = mutate(a.cookie, sessionA.csrfToken);
  const headersB = mutate(b.cookie, sessionB.csrfToken);

  const accepted = await json(worker, `/api/items/${itemA.id}/status`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ status: "accepted" }),
  });
  assert.equal(accepted.res.status, 200, JSON.stringify(accepted.body));
  assert.equal((accepted.body as { item: { status: string } }).item.status, "accepted");
  const inbox = await json(worker, "/api/items?view=inbox", { headers: { cookie: a.cookie } });
  assert.equal(((inbox.body as { items: unknown[] }).items).length, 0);
  const recent = await json(worker, "/api/items", { headers: { cookie: a.cookie } });
  assert.equal(((recent.body as { items: { status: string }[] }).items)[0]?.status, "accepted");

  const tagged = await json(worker, `/api/items/${itemA.id}/tags`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ name: "Food" }),
  });
  assert.equal(tagged.res.status, 200, JSON.stringify(tagged.body));
  const tag = (tagged.body as { tag: { id: string; name: string }; item: { tags: { name: string }[] } }).tag;
  assert.equal(tag.name, "Food");
  assert.deepEqual((tagged.body as { item: { tags: { name: string }[] } }).item.tags.map((entry) => entry.name), ["Food"]);

  const noted = await json(worker, `/api/items/${itemA.id}/notes`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ body: "cook this" }),
  });
  assert.equal(noted.res.status, 200, JSON.stringify(noted.body));
  assert.deepEqual(
    (noted.body as { item: { notes: { body: string }[] } }).item.notes.map((entry) => entry.body),
    ["cook this"],
  );

  const created = await json(worker, "/api/collections", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ name: "Tonight" }),
  });
  assert.equal(created.res.status, 200, JSON.stringify(created.body));
  const collection = (created.body as { collection: { id: string; name: string } }).collection;
  assert.equal(collection.name, "Tonight");
  const added = await json(worker, `/api/items/${itemA.id}/collections`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ collectionId: collection.id }),
  });
  assert.equal(added.res.status, 200, JSON.stringify(added.body));
  assert.deepEqual(
    (added.body as { item: { collections: { name: string }[] } }).item.collections.map((entry) => entry.name),
    ["Tonight"],
  );
  const org = await json(worker, "/api/collections", { headers: { cookie: a.cookie } });
  const listed = org.body as {
    collections: { name: string; count: number }[];
    tags: { name: string }[];
  };
  assert.deepEqual(
    listed.collections.map((entry) => ({ name: entry.name, count: entry.count })),
    [{ name: "Tonight", count: 1 }],
  );
  assert.deepEqual(listed.tags.map((entry) => entry.name), ["Food"]);

  const removedTag = await json(worker, `/api/items/${itemA.id}/tags/remove`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ tagId: tag.id }),
  });
  assert.equal(removedTag.res.status, 200);
  assert.deepEqual((removedTag.body as { item: { tags: unknown[] } }).item.tags, []);
  const removedCol = await json(worker, `/api/items/${itemA.id}/collections/remove`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ collectionId: collection.id }),
  });
  assert.equal(removedCol.res.status, 200);
  assert.deepEqual((removedCol.body as { item: { collections: unknown[] } }).item.collections, []);

  const crossStatus = await json(worker, `/api/items/${itemB.id}/status`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ status: "archived" }),
  });
  assert.equal(crossStatus.res.status, 404);
  assert.deepEqual(crossStatus.body, { error: "Not found" });
  const crossNote = await json(worker, `/api/items/${itemB.id}/notes`, {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ body: "nope" }),
  });
  assert.equal(crossNote.res.status, 404);
  const guessed = await json(worker, "/api/items/00000000-0000-4000-8000-000000000000/status", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ status: "accepted" }),
  });
  assert.equal(guessed.res.status, 404);
  const foreignCollection = await json(worker, `/api/items/${itemB.id}/collections`, {
    method: "POST",
    headers: headersB,
    body: JSON.stringify({ collectionId: collection.id }),
  });
  assert.equal(foreignCollection.res.status, 404);

  const stillB = await json(worker, `/api/items/${itemB.id}`, { headers: { cookie: b.cookie } });
  assert.equal((stillB.body as { item: { status: string } }).item.status, "inbox");
  const orgB = await json(worker, "/api/collections", { headers: { cookie: b.cookie } });
  assert.deepEqual(orgB.body, { collections: [], tags: [] });
});

test("desk mutations reject bad payloads and missing CSRF", async () => {
  const user = await login(worker, "desk-mut-bad@example.com", "Bad");
  const session = await sessionOf(worker, user.cookie);
  const headers = mutate(user.cookie, session.csrfToken);
  const item = (await saveUrl(user.cookie, session.csrfToken, "https://example.com/mut-bad")).item;

  const invalid = await json(worker, `/api/items/${item.id}/status`, {
    method: "POST",
    headers,
    body: JSON.stringify({ status: "done" }),
  });
  assert.equal(invalid.res.status, 400);
  assert.match(JSON.stringify(invalid.body), /invalid status/);

  const empty = await json(worker, "/api/collections", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "  " }),
  });
  assert.equal(empty.res.status, 400);
  assert.match(JSON.stringify(empty.body), /collection name required/);

  const spoof = await json(worker, `/api/items/${item.id}/notes`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body: "x", libraryId: session.library.id }),
  });
  assert.equal(spoof.res.status, 400);
  assert.match(JSON.stringify(spoof.body), /unsupported field/);

  const noCsrf = await json(worker, `/api/items/${item.id}/status`, {
    method: "POST",
    headers: { cookie: user.cookie, "content-type": "application/json" },
    body: JSON.stringify({ status: "accepted" }),
  });
  assert.equal(noCsrf.res.status, 403);
});
