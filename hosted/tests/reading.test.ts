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
const PORT = 8806;
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
  persistTo = await mkdtemp(join(tmpdir(), "locus-reading-"));
  worker = await start(persistTo);
});

after(async () => {
  await worker?.stop();
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

test("anonymous private reading routes are 401", async () => {
  for (const path of ["/api/reading", "/api/reading/not-a-document"]) {
    const { res, body } = await json(worker, path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(body, { error: "Unauthorized" });
  }
  for (const path of ["/api/reading/not-a-document/progress", "/api/reading/not-a-document/remove", "/api/reading/undo-remove"]) {
    const { res, body } = await json(worker, path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(res.status, 401, path);
    assert.deepEqual(body, { error: "Unauthorized" });
  }
});

test("saving an item with an outbound URL creates a Library-scoped document", async () => {
  const user = await login(worker, "reading-discover@example.com", "Discover");
  const session = await sessionOf(worker, user.cookie);
  const before = await json(worker, "/__test/stats");
  const startCount = (before.body as { readingDocuments: number }).readingDocuments;
  const saved = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({
      url: "https://x.com/locus/status/1",
      title: "A save",
      body: "worth reading https://www.example.com/hosted-reading-one",
    }),
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  const after = await json(worker, "/__test/stats");
  assert.equal((after.body as { readingDocuments: number }).readingDocuments, startCount + 1);

  const list = await json(worker, "/api/reading", { headers: { cookie: user.cookie } });
  assert.equal(list.res.status, 200, JSON.stringify(list.body));
  const page = list.body as {
    preparing: { preview: { id: string; canonicalUrl: string }[] };
    unread: { items: { id: string }[] };
  };
  const doc = page.preparing.preview[0];
  if (doc) {
    assert.equal(doc.canonicalUrl, "https://example.com/hosted-reading-one");
    const own = await json(worker, `/api/reading/${doc.id}`, { headers: { cookie: user.cookie } });
    assert.equal(own.res.status, 200);
  }
});

test("saving a link with an empty body uses the Item URL as a Reading candidate", async () => {
  const user = await login(worker, "reading-permalink@example.com", "Permalink");
  const session = await sessionOf(worker, user.cookie);
  const saved = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ url: "https://www.example.com/hosted-permalink-essay", title: "Essay" }),
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  const listed = await json(worker, "/api/reading?audience=agent", { headers: { cookie: user.cookie } });
  assert.equal(listed.res.status, 200, JSON.stringify(listed.body));
  const docs = listed.body as { items: { id: string; host: string; title: string }[] };
  assert.equal(docs.items.length, 1, JSON.stringify(docs));
  assert.equal(docs.items[0]?.host, "example.com");

  const social = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ url: "https://x.com/locus/status/9001" }),
  });
  assert.equal(social.res.status, 200, JSON.stringify(social.body));
  const afterSocial = await json(worker, "/api/reading?audience=agent", { headers: { cookie: user.cookie } });
  assert.equal(((afterSocial.body as { items: unknown[] }).items).length, 1);
});

test("localhost targets in an Item body do not become documents", async () => {
  const user = await login(worker, "reading-ssrf@example.com", "Ssrf");
  const session = await sessionOf(worker, user.cookie);
  const before = await json(worker, "/__test/stats");
  const startCount = (before.body as { readingDocuments: number }).readingDocuments;
  const saved = await json(worker, "/api/intake", {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({
      url: "https://x.com/locus/status/9002",
      body: "nope http://127.0.0.1/secret http://169.254.169.254/latest/meta-data",
    }),
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  const after = await json(worker, "/__test/stats");
  assert.equal((after.body as { readingDocuments: number }).readingDocuments, startCount);
  const list = await json(worker, "/api/reading", { headers: { cookie: user.cookie } });
  assert.equal((list.body as { counts: { preparing: number } }).counts.preparing, 0);
});

test("two users cannot see or mutate each other's documents", async () => {
  const a = await login(worker, "reading-a@example.com", "ReadA");
  const b = await login(worker, "reading-b@example.com", "ReadB");
  const sessionA = await sessionOf(worker, a.cookie);
  const sessionB = await sessionOf(worker, b.cookie);

  const seedA = await json(worker, "/__test/reading-document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: a.body.user.id,
      canonicalUrl: "https://example.com/shared-essay",
      title: "Ada essay",
    }),
  });
  const seedB = await json(worker, "/__test/reading-document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: b.body.user.id,
      canonicalUrl: "https://example.com/shared-essay",
      title: "Bob essay",
    }),
  });
  assert.equal(seedA.res.status, 200, JSON.stringify(seedA.body));
  assert.equal(seedB.res.status, 200, JSON.stringify(seedB.body));
  const docA = seedA.body as { id: string };
  const docB = seedB.body as { id: string };
  assert.notEqual(docA.id, docB.id);

  const listA = await json(worker, "/api/reading", { headers: { cookie: a.cookie } });
  const pageA = listA.body as { unread: { items: { id: string; title: string }[] } };
  assert.deepEqual(
    pageA.unread.items.map((item) => item.id),
    [docA.id],
  );
  assert.equal(pageA.unread.items[0]?.title, "Ada essay");

  const listB = await json(worker, "/api/reading", { headers: { cookie: b.cookie } });
  assert.deepEqual(
    (listB.body as { unread: { items: { id: string }[] } }).unread.items.map((item) => item.id),
    [docB.id],
  );

  const cross = await json(worker, `/api/reading/${docB.id}`, { headers: { cookie: a.cookie } });
  assert.equal(cross.res.status, 404);
  assert.deepEqual(cross.body, { error: "Not found" });

  const guessed = await json(worker, "/api/reading/00000000-0000-4000-8000-000000000000", {
    headers: { cookie: a.cookie },
  });
  assert.equal(guessed.res.status, 404);

  const steal = await json(worker, `/api/reading/${docB.id}/progress`, {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: JSON.stringify({ op: "finished" }),
  });
  assert.equal(steal.res.status, 404);

  const removeOther = await json(worker, `/api/reading/${docB.id}/remove`, {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: "{}",
  });
  assert.equal(removeOther.res.status, 404);

  const finished = await json(worker, `/api/reading/${docA.id}/progress`, {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: JSON.stringify({ op: "finished" }),
  });
  assert.equal(finished.res.status, 200, JSON.stringify(finished.body));
  assert.equal((finished.body as { progress: { state: string } }).progress.state, "finished");

  const bStillUnread = await json(worker, `/api/reading/${docB.id}`, { headers: { cookie: b.cookie } });
  assert.equal((bStillUnread.body as { document: { progress: unknown } }).document.progress, null);

  const removed = await json(worker, `/api/reading/${docA.id}/remove`, {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: "{}",
  });
  assert.equal(removed.res.status, 200, JSON.stringify(removed.body));
  const gone = await json(worker, `/api/reading/${docA.id}`, { headers: { cookie: a.cookie } });
  assert.equal(gone.res.status, 404);

  const undo = await json(worker, "/api/reading/undo-remove", {
    method: "POST",
    headers: mutate(a.cookie, sessionA.csrfToken),
    body: JSON.stringify({ token: (removed.body as { undoToken: string }).undoToken }),
  });
  assert.equal(undo.res.status, 200, JSON.stringify(undo.body));
  const restored = await json(worker, `/api/reading/${docA.id}`, { headers: { cookie: a.cookie } });
  assert.equal(restored.res.status, 200);

  const crossUndo = await json(worker, "/api/reading/undo-remove", {
    method: "POST",
    headers: mutate(b.cookie, sessionB.csrfToken),
    body: JSON.stringify({ token: (removed.body as { undoToken: string }).undoToken }),
  });
  assert.equal(crossUndo.res.status, 404);
});

test("reading CSRF matches other private mutations", async () => {
  const user = await login(worker, "reading-csrf@example.com", "Csrf");
  const other = await login(worker, "reading-csrf-b@example.com", "CsrfB");
  const session = await sessionOf(worker, user.cookie);
  const otherSession = await sessionOf(worker, other.cookie);
  const seeded = await json(worker, "/__test/reading-document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: user.body.user.id,
      canonicalUrl: "https://example.com/csrf-essay",
    }),
  });
  const id = (seeded.body as { id: string }).id;
  const path = `/api/reading/${id}/progress`;
  const body = JSON.stringify({ op: "finished" });
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

test("disabled user is 403 on reading routes while the cookie remains", async () => {
  const user = await login(worker, "reading-disabled@example.com", "No");
  const session = await sessionOf(worker, user.cookie);
  const seeded = await json(worker, "/__test/reading-document", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      userId: user.body.user.id,
      canonicalUrl: "https://example.com/disabled-essay",
    }),
  });
  const id = (seeded.body as { id: string }).id;
  await json(worker, "/__test/disable", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId: user.body.user.id }),
  });
  const list = await json(worker, "/api/reading", { headers: { cookie: user.cookie } });
  assert.equal(list.res.status, 403);
  const write = await json(worker, `/api/reading/${id}/progress`, {
    method: "POST",
    headers: mutate(user.cookie, session.csrfToken),
    body: JSON.stringify({ op: "finished" }),
  });
  assert.equal(write.res.status, 403);
});
