import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath } from "node:url";
import { unstable_dev, type Unstable_DevWorker } from "wrangler";
import { resolveIdentity } from "../src/identity.ts";
import { applySecurityHeaders, logEvent, mayLogRequest, redact } from "../src/index.ts";

const HOSTED_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "..");
const SECRET = "test-secret-test-secret-test-secret";
const CSRF_SECRET = "csrf-secret-csrf-secret-csrf-secret";

function originFor(port: number): string {
  return `http://127.0.0.1:${port}`;
}

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

async function start(opts: {
  persistTo: string;
  port: number;
  registrationMode?: string;
}): Promise<Unstable_DevWorker> {
  applyMigrations(opts.persistTo);
  const origin = originFor(opts.port);
  return unstable_dev("tests/worker.ts", {
    config: "wrangler.jsonc",
    ip: "127.0.0.1",
    port: opts.port,
    localProtocol: "http",
    persist: true,
    persistTo: opts.persistTo,
    logLevel: "error",
    vars: {
      BETTER_AUTH_URL: origin,
      BETTER_AUTH_SECRET: SECRET,
      GOOGLE_CLIENT_ID: "test-google-client-id",
      GOOGLE_CLIENT_SECRET: "test-google-client-secret",
      CSRF_SECRET,
      REGISTRATION_MODE: opts.registrationMode ?? "open",
    },
    experimental: { disableExperimentalWarning: true },
  });
}

async function json(
  worker: Unstable_DevWorker,
  origin: string,
  path: string,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (init.method && init.method !== "GET" && !headers.has("origin")) headers.set("origin", origin);
  const res = await worker.fetch(`${origin}${path}`, { ...init, headers });
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

async function login(
  worker: Unstable_DevWorker,
  origin: string,
  email: string,
  name = "Ada",
  accountId = email,
) {
  const { res, body } = await json(worker, origin, "/__test/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      email,
      name,
      accountId,
      accessToken: "google-access-token",
      refreshToken: "google-refresh-token",
      idToken: "google-id-token",
    }),
  });
  assert.equal(res.status, 200, JSON.stringify(body));
  return { cookie: cookieFrom(res), body: body as Record<string, unknown> };
}

const MAIN_PORT = 8798;
const MAIN_ORIGIN = originFor(MAIN_PORT);
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
  persistTo = await mkdtemp(join(tmpdir(), "locus-identity-"));
  worker = await start({ persistTo, port: MAIN_PORT });
});

after(async () => {
  await worker?.stop();
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

test("request identity is 401 without a session and without Better Auth", async () => {
  const result = await resolveIdentity({} as never, null);
  assert.deepEqual(result, { ok: false, status: 401, error: "Unauthorized" });
});

test("health and unknown routes", async () => {
  const health = await json(worker, MAIN_ORIGIN, "/api/health");
  assert.equal(health.res.status, 200);
  assert.deepEqual(health.body, { ok: true });

  const missing = await json(worker, MAIN_ORIGIN, "/api/items");
  assert.equal(missing.res.status, 401);
  assert.deepEqual(missing.body, { error: "Unauthorized" });
  assert.match(missing.res.headers.get("content-type") ?? "", /json/);

  const unknownApi = await json(worker, MAIN_ORIGIN, "/api/does-not-exist");
  assert.equal(unknownApi.res.status, 404);
  assert.deepEqual(unknownApi.body, { error: "Not found" });

  const page = await worker.fetch(`${MAIN_ORIGIN}/`);
  assert.equal(page.status, 200);
  const pageText = await page.text();
  assert.match(page.headers.get("content-type") ?? "", /html/);
  assert.match(pageText, /id="root"/);
  assert.doesNotMatch(pageText, /Checking session/);
  assert.equal(page.headers.get("cache-control"), "no-store");
  assert.match(page.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
  assert.equal(page.headers.get("x-frame-options"), "DENY");
  assert.equal(page.headers.get("x-content-type-options"), "nosniff");
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("permissions-policy"), "camera=(), geolocation=(), microphone=()");
  assert.equal(page.headers.get("strict-transport-security"), null);

  const account = await worker.fetch(`${MAIN_ORIGIN}/account`);
  assert.equal(account.status, 200);
  assert.match(account.headers.get("content-type") ?? "", /html/);
  assert.match(await account.text(), /id="root"/);
  assert.equal(account.headers.get("cache-control"), "no-store");
  assert.match(account.headers.get("content-security-policy") ?? "", /frame-ancestors 'none'/);
});

test("anonymous session is 401", async () => {
  const { res, body } = await json(worker, MAIN_ORIGIN, "/api/session");
  assert.equal(res.status, 401);
  assert.equal(res.headers.get("cache-control"), "no-store");
  assert.deepEqual(body, { error: "Unauthorized" });
});

test("HSTS is added only to HTTPS responses", () => {
  const https = applySecurityHeaders(Response.json({ ok: true }), new URL("https://staging.example/api/session"));
  assert.equal(https.headers.get("strict-transport-security"), "max-age=31536000; includeSubDomains");
  assert.equal(https.headers.get("cache-control"), "no-store");

  const http = applySecurityHeaders(
    new Response(null, { headers: { "strict-transport-security": "max-age=1" } }),
    new URL("http://127.0.0.1/api/session"),
  );
  assert.equal(http.headers.get("strict-transport-security"), null);
});

test("hashed assets may be cached; HTML must not", () => {
  const asset = applySecurityHeaders(new Response("ok"), new URL("https://staging.example/assets/index-abc123.js"));
  assert.equal(asset.headers.get("cache-control"), "public, max-age=31536000, immutable");

  const html = applySecurityHeaders(new Response("<html></html>"), new URL("https://staging.example/"));
  assert.equal(html.headers.get("cache-control"), "no-store");

  const missing = applySecurityHeaders(new Response("nope", { status: 404 }), new URL("https://staging.example/assets/missing.js"));
  assert.equal(missing.headers.get("cache-control"), "no-store");
});

test("auth initiation returns a stable 429 after its allowance", async () => {
  const headers = {
    "cf-connecting-ip": "203.0.113.20",
    "content-type": "application/json",
  };
  for (let attempt = 0; attempt < 20; attempt++) {
    const allowed = await json(worker, MAIN_ORIGIN, "/api/auth/sign-in/social", {
      method: "POST",
      headers,
      body: JSON.stringify({ provider: "google", callbackURL: "/" }),
    });
    assert.notEqual(allowed.res.status, 429, `attempt ${attempt + 1}`);
  }
  const limited = await json(worker, MAIN_ORIGIN, "/api/auth/sign-in/social", {
    method: "POST",
    headers,
    body: JSON.stringify({ provider: "google", callbackURL: "/" }),
  });
  assert.equal(limited.res.status, 429);
  assert.equal(limited.res.headers.get("retry-after"), "60");
  assert.deepEqual(limited.body, { error: "Too many requests" });
});

test("repeated rejected private sessions return a stable 429", async () => {
  const headers = { "cf-connecting-ip": "203.0.113.30" };
  for (let attempt = 0; attempt < 30; attempt++) {
    const rejected = await json(worker, MAIN_ORIGIN, "/api/libraries/not-a-library", { headers });
    assert.equal(rejected.res.status, 401, `attempt ${attempt + 1}`);
  }
  const limited = await json(worker, MAIN_ORIGIN, "/api/libraries/not-a-library", { headers });
  assert.equal(limited.res.status, 429);
  assert.equal(limited.res.headers.get("retry-after"), "60");
  assert.deepEqual(limited.body, { error: "Too many requests" });
});

test("first login creates one user, session, library, and owner membership", async () => {
  const { cookie, body: loginBody } = await login(worker, MAIN_ORIGIN, "ada@example.com", "Ada");
  const stored = (loginBody.stored as { accessToken: unknown; refreshToken: unknown; idToken: unknown }[])[0];
  assert.equal(stored?.accessToken, null);
  assert.equal(stored?.refreshToken, null);
  assert.equal(stored?.idToken, null);

  const { res, body } = await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  assert.equal(res.status, 200, JSON.stringify(body));
  const session = body as {
    user: { id: string; name: string; email: string; image: string | null };
    session: { expiresAt: string; id?: unknown; token?: unknown };
    library: { id: string; name: string; role: string };
    csrfToken: string;
  };
  assert.equal(session.user.email, "ada@example.com");
  assert.equal(session.user.name, "Ada");
  assert.equal(session.library.role, "owner");
  assert.equal(session.session.id, undefined);
  assert.equal(session.session.token, undefined);
  assert.ok(session.library.id);
  assert.ok(session.csrfToken);
  assert.match(session.session.expiresAt, /^\d{4}-/);

  const stats = await json(worker, MAIN_ORIGIN, "/__test/stats");
  assert.equal((stats.body as { libraries: number }).libraries, 1);
  assert.equal((stats.body as { memberships: number }).memberships, 1);
  assert.equal((stats.body as { userAccess: number }).userAccess, 1);
});

test("repeat login returns the same library", async () => {
  const { cookie } = await login(worker, MAIN_ORIGIN, "bob@example.com", "Bob");
  const first = await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  const second = await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  assert.equal(first.res.status, 200);
  assert.equal(second.res.status, 200);
  assert.equal(
    (first.body as { library: { id: string } }).library.id,
    (second.body as { library: { id: string } }).library.id,
  );
});

test("concurrent session bootstrap does not duplicate libraries", async () => {
  const { cookie } = await login(worker, MAIN_ORIGIN, "cara@example.com", "Cara");
  const [a, b] = await Promise.all([
    json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } }),
    json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } }),
  ]);
  assert.equal(a.res.status, 200, JSON.stringify(a.body));
  assert.equal(b.res.status, 200, JSON.stringify(b.body));
  assert.equal(
    (a.body as { library: { id: string } }).library.id,
    (b.body as { library: { id: string } }).library.id,
  );
});

test("sign-out revokes the session", async () => {
  const { cookie } = await login(worker, MAIN_ORIGIN, "dee@example.com", "Dee");
  await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  const signedOut = await json(worker, MAIN_ORIGIN, "/api/auth/sign-out", {
    method: "POST",
    headers: { cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.ok(signedOut.res.status < 400, JSON.stringify(signedOut.body));
  const next = await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  assert.equal(next.res.status, 401);
});

test("google tokens stay null after repeat login", async () => {
  const { cookie } = await login(worker, MAIN_ORIGIN, "eve@example.com", "Eve");
  await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  const stats = await json(worker, MAIN_ORIGIN, "/__test/stats");
  const accounts = (stats.body as { accounts: { accessToken: unknown; refreshToken: unknown; idToken: unknown }[] })
    .accounts;
  assert.ok(accounts.length > 0);
  for (const account of accounts) {
    assert.equal(account.accessToken, null);
    assert.equal(account.refreshToken, null);
    assert.equal(account.idToken, null);
  }
});

test("disabled user is 403 while the session cookie remains", async () => {
  const { cookie, body: loginBody } = await login(worker, MAIN_ORIGIN, "ivy@example.com", "Ivy");
  const userId = (loginBody.user as { id: string }).id;
  const ok = await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  assert.equal(ok.res.status, 200, JSON.stringify(ok.body));

  const disabled = await json(worker, MAIN_ORIGIN, "/__test/disable", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  assert.equal(disabled.res.status, 200, JSON.stringify(disabled.body));

  const denied = await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  assert.equal(denied.res.status, 403);
  assert.deepEqual(denied.body, { error: "Forbidden" });
  assert.doesNotMatch(JSON.stringify(denied.body), /ivy@example.com/i);
});

test("registration can close, keep existing users, and reopen", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locus-identity-reg-"));
  const port = 8800;
  const origin = originFor(port);
  let local: Unstable_DevWorker | undefined;
  try {
    local = await start({ persistTo: dir, port, registrationMode: "open" });
    const { cookie } = await login(local, origin, "gina@example.com", "Gina");
    const first = await json(local, origin, "/api/session", { headers: { cookie } });
    assert.equal(first.res.status, 200, JSON.stringify(first.body));
    const libraryId = (first.body as { library: { id: string } }).library.id;

    await local.stop();
    local = await start({ persistTo: dir, port, registrationMode: "closed" });

    const existing = await login(local, origin, "gina@example.com", "Gina");
    const again = await json(local, origin, "/api/session", { headers: { cookie: existing.cookie } });
    assert.equal(again.res.status, 200, JSON.stringify(again.body));
    assert.equal((again.body as { library: { id: string } }).library.id, libraryId);

    const rejected = await json(local, origin, "/__test/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        email: "hank@example.com",
        name: "Hank",
        accountId: "hank@example.com",
        registrationMode: "open",
        status: "active",
      }),
    });
    assert.equal(rejected.res.status, 403);
    assert.deepEqual(rejected.body, { error: "Registration closed" });
    assert.doesNotMatch(JSON.stringify(rejected.body), /hank@example.com|gina@example.com/i);

    const closedStats = await json(local, origin, "/__test/stats");
    assert.equal((closedStats.body as { users: number }).users, 1);
    assert.equal((closedStats.body as { libraries: number }).libraries, 1);

    await local.stop();
    local = await start({ persistTo: dir, port, registrationMode: "open" });
    const { cookie: newbieCookie } = await login(local, origin, "hank@example.com", "Hank");
    const newbie = await json(local, origin, "/api/session", { headers: { cookie: newbieCookie } });
    assert.equal(newbie.res.status, 200, JSON.stringify(newbie.body));
    assert.notEqual((newbie.body as { library: { id: string } }).library.id, libraryId);
  } finally {
    await local?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

test("worker restart keeps the library", async () => {
  const dir = await mkdtemp(join(tmpdir(), "locus-identity-restart-"));
  const port = 8799;
  const origin = originFor(port);
  let local: Unstable_DevWorker | undefined;
  try {
    local = await start({ persistTo: dir, port });
    const { cookie } = await login(local, origin, "frank@example.com", "Frank");
    const first = await json(local, origin, "/api/session", { headers: { cookie } });
    assert.equal(first.res.status, 200, JSON.stringify(first.body));
    const libraryId = (first.body as { library: { id: string } }).library.id;
    await local.stop();
    local = await start({ persistTo: dir, port });
    const second = await json(local, origin, "/api/session", { headers: { cookie } });
    assert.equal(second.res.status, 200, JSON.stringify(second.body));
    assert.equal((second.body as { library: { id: string } }).library.id, libraryId);
  } finally {
    await local?.stop();
    await rm(dir, { recursive: true, force: true });
  }
});

type HostedSession = {
  library: { id: string; name: string; role: string };
  csrfToken: string;
};

async function sessionOf(cookie: string): Promise<HostedSession> {
  const { res, body } = await json(worker, MAIN_ORIGIN, "/api/session", { headers: { cookie } });
  assert.equal(res.status, 200, JSON.stringify(body));
  return body as HostedSession;
}

test("anonymous private proof is 401; public routes stay open", async () => {
  const missing = await json(worker, MAIN_ORIGIN, "/api/libraries/not-a-library");
  assert.equal(missing.res.status, 401);

  const health = await json(worker, MAIN_ORIGIN, "/api/health");
  assert.equal(health.res.status, 200);
  const page = await worker.fetch(`${MAIN_ORIGIN}/`);
  assert.equal(page.status, 200);
});

test("proof resource is the session library and 404s every other id", async () => {
  const a = await login(worker, MAIN_ORIGIN, "proof-a@example.com", "ProofA");
  const b = await login(worker, MAIN_ORIGIN, "proof-b@example.com", "ProofB");
  const sessionA = await sessionOf(a.cookie);
  const sessionB = await sessionOf(b.cookie);
  assert.notEqual(sessionA.library.id, sessionB.library.id);

  const own = await json(worker, MAIN_ORIGIN, `/api/libraries/${sessionA.library.id}`, {
    headers: { cookie: a.cookie },
  });
  assert.equal(own.res.status, 200, JSON.stringify(own.body));
  assert.equal(own.res.headers.get("cache-control"), "no-store");
  assert.deepEqual(own.body, {
    id: sessionA.library.id,
    name: sessionA.library.name,
    role: "owner",
  });

  const cross = await json(worker, MAIN_ORIGIN, `/api/libraries/${sessionB.library.id}`, {
    headers: { cookie: a.cookie },
  });
  assert.equal(cross.res.status, 404);
  assert.deepEqual(cross.body, { error: "Not found" });

  const guessed = await json(worker, MAIN_ORIGIN, "/api/libraries/00000000-0000-4000-8000-000000000000", {
    headers: { cookie: a.cookie },
  });
  assert.equal(guessed.res.status, 404);

  const spoofed = await json(
    worker,
    MAIN_ORIGIN,
    `/api/libraries/${sessionA.library.id}?libraryId=${sessionB.library.id}&library_id=${sessionB.library.id}&user=x&session=y&actor=z`,
    { headers: { cookie: a.cookie } },
  );
  assert.equal(spoofed.res.status, 200, JSON.stringify(spoofed.body));
  assert.equal((spoofed.body as { id: string }).id, sessionA.library.id);
});

test("mutations need this session CSRF and the exact origin", async () => {
  const a = await login(worker, MAIN_ORIGIN, "csrf-a@example.com", "CsrfA");
  const b = await login(worker, MAIN_ORIGIN, "csrf-b@example.com", "CsrfB");
  const sessionA = await sessionOf(a.cookie);
  const sessionB = await sessionOf(b.cookie);
  const path = `/api/libraries/${sessionA.library.id}`;
  const headers = {
    cookie: a.cookie,
    "content-type": "application/json",
    "x-csrf-token": sessionA.csrfToken,
  };

  const ok = await json(worker, MAIN_ORIGIN, path, {
    method: "POST",
    headers,
    body: JSON.stringify({
      libraryId: sessionB.library.id,
      library_id: sessionB.library.id,
      user: sessionB.library.id,
      session: "forged",
      actor: "forged",
    }),
  });
  assert.equal(ok.res.status, 200, JSON.stringify(ok.body));
  assert.equal((ok.body as { id: string }).id, sessionA.library.id);

  const noCsrf = await json(worker, MAIN_ORIGIN, path, {
    method: "POST",
    headers: { cookie: a.cookie, "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(noCsrf.res.status, 403);

  const stale = await json(worker, MAIN_ORIGIN, path, {
    method: "POST",
    headers: { ...headers, "x-csrf-token": sessionB.csrfToken },
    body: "{}",
  });
  assert.equal(stale.res.status, 403);

  const wrongOrigin = await json(worker, MAIN_ORIGIN, path, {
    method: "POST",
    headers: { ...headers, origin: "https://evil.example" },
    body: "{}",
  });
  assert.equal(wrongOrigin.res.status, 403);

  const crossWrite = await json(worker, MAIN_ORIGIN, `/api/libraries/${sessionB.library.id}`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(crossWrite.res.status, 404);

  await json(worker, MAIN_ORIGIN, "/api/auth/sign-out", {
    method: "POST",
    headers: { cookie: a.cookie, "content-type": "application/json" },
    body: "{}",
  });
  const again = await login(worker, MAIN_ORIGIN, "csrf-a@example.com", "CsrfA");
  const next = await sessionOf(again.cookie);
  const oldToken = await json(worker, MAIN_ORIGIN, `/api/libraries/${next.library.id}`, {
    method: "POST",
    headers: {
      cookie: again.cookie,
      "content-type": "application/json",
      "x-csrf-token": sessionA.csrfToken,
    },
    body: "{}",
  });
  assert.equal(oldToken.res.status, 403);
  const fresh = await json(worker, MAIN_ORIGIN, `/api/libraries/${next.library.id}`, {
    method: "POST",
    headers: {
      cookie: again.cookie,
      "content-type": "application/json",
      "x-csrf-token": next.csrfToken,
    },
    body: "{}",
  });
  assert.equal(fresh.res.status, 200, JSON.stringify(fresh.body));
});

test("disabled session is 403 on the proof resource", async () => {
  const { cookie, body: loginBody } = await login(worker, MAIN_ORIGIN, "proof-disabled@example.com", "No");
  const session = await sessionOf(cookie);
  const userId = (loginBody.user as { id: string }).id;
  await json(worker, MAIN_ORIGIN, "/__test/disable", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId }),
  });
  const read = await json(worker, MAIN_ORIGIN, `/api/libraries/${session.library.id}`, {
    headers: { cookie },
  });
  assert.equal(read.res.status, 403);
  const write = await json(worker, MAIN_ORIGIN, `/api/libraries/${session.library.id}`, {
    method: "POST",
    headers: {
      cookie,
      "content-type": "application/json",
      "x-csrf-token": session.csrfToken,
    },
    body: "{}",
  });
  assert.equal(write.res.status, 403);
});

test("logs redact email, cookies, oauth codes, and tokens", () => {
  const raw =
    "ada@example.com cookie: better-auth.session_token=abc; Path=/ code=oauth-code token=secret access_token=google";
  const cleaned = redact(raw);
  assert.equal(cleaned.includes("ada@example.com"), false);
  assert.equal(cleaned.includes("abc"), false);
  assert.equal(cleaned.includes("oauth-code"), false);
  assert.equal(cleaned.includes("secret"), false);
  assert.equal(cleaned.includes("google"), false);
  assert.match(cleaned, /\[redacted\]/);
});

test("the structured logger redacts before emitting one JSON record", () => {
  const lines: string[] = [];
  logEvent(
    {
      level: "info",
      event: "oauth.callback",
      requestId: "safe-ray-id",
      method: "GET",
      path: "/api/auth/callback/google?code=oauth-code",
      status: 302,
      detail: "ada@example.com cookie: better-auth.session_token=session-secret token=oauth-token",
      timestamp: "2026-09-02T00:00:00.000Z",
    },
    (line) => lines.push(line),
  );
  assert.equal(lines.length, 1);
  const emitted = lines[0];
  assert.doesNotMatch(emitted, /ada@example\.com|session-secret|oauth-code|oauth-token/);
  const record = JSON.parse(emitted) as Record<string, unknown>;
  assert.equal(record.path, "/api/auth/callback/google");
  assert.equal(record.status, 302);
  assert.match(String(record.detail), /\[redacted\]/);
});

test("requests carrying query values or credentials are not logged", () => {
  assert.equal(mayLogRequest(new Request("https://staging.example/api/health")), true);
  assert.equal(
    mayLogRequest(new Request("https://staging.example/api/auth/callback/google?code=marker")),
    false,
  );
  assert.equal(
    mayLogRequest(new Request("https://staging.example/api/session", { headers: { cookie: "marker=1" } })),
    false,
  );
  assert.equal(
    mayLogRequest(
      new Request("https://staging.example/api/session", { headers: { authorization: "Bearer marker" } }),
    ),
    false,
  );
});
