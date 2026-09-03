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
const PORT = 8809;
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

async function mcp(worker: Unstable_DevWorker, token: string | null, method: string, params?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json", origin: ORIGIN };
  if (token) headers.authorization = `Bearer ${token}`;
  return json(worker, "/mcp", {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
}

function toolPayload(body: unknown): Record<string, unknown> {
  const rec = body as { result?: { content?: { text?: string }[] } };
  const text = rec.result?.content?.[0]?.text;
  assert.equal(typeof text, "string", JSON.stringify(body));
  return JSON.parse(text as string) as Record<string, unknown>;
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
  persistTo = await mkdtemp(join(tmpdir(), "locus-intake-"));
  worker = await start(persistTo);
});

after(async () => {
  await worker?.stop();
  if (persistTo) await rm(persistTo, { recursive: true, force: true });
});

test("anonymous intake extras are 401 and MCP is unauthorized", async () => {
  for (const path of ["/api/intake/context", "/api/intake/search", "/api/library-capabilities"]) {
    const { res, body } = await json(worker, path);
    assert.equal(res.status, 401, path);
    assert.deepEqual(body, { error: "Unauthorized" });
  }
  const batch = await json(worker, "/api/intake/batch", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(batch.res.status, 401);
  const getMcp = await json(worker, "/mcp");
  assert.equal(getMcp.res.status, 405);
  const postMcp = await mcp(worker, null, "initialize");
  assert.equal(postMcp.res.status, 401);
  assert.deepEqual(postMcp.body, { error: "unauthorized" });
});

test("two users have isolated context, search, capabilities, and batches", async () => {
  const a = await login(worker, "intake-a@example.com", "Ada");
  const b = await login(worker, "intake-b@example.com", "Bob");
  const sessionA = await sessionOf(worker, a.cookie);
  const sessionB = await sessionOf(worker, b.cookie);
  const headersA = mutate(a.cookie, sessionA.csrfToken);
  const headersB = mutate(b.cookie, sessionB.csrfToken);

  const collection = await json(worker, "/api/collections", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ name: "Research" }),
  });
  assert.equal(collection.res.status, 200, JSON.stringify(collection.body));
  const collectionId = (collection.body as { collection: { id: string } }).collection.id;

  const tag = await json(worker, "/api/intake/tags", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ name: "alpha" }),
  });
  assert.equal(tag.res.status, 200, JSON.stringify(tag.body));
  const tagId = (tag.body as { tag: { id: string }; context: { version: string } }).tag.id;
  const contextA = (tag.body as { context: { version: string; tags: { name: string }[] } }).context;
  assert.equal(contextA.tags.some((entry) => entry.name === "alpha"), true);

  const contextB = await json(worker, "/api/intake/context", { headers: { cookie: b.cookie } });
  assert.equal(contextB.res.status, 200);
  assert.deepEqual((contextB.body as { tags: unknown[] }).tags, []);
  assert.notEqual((contextB.body as { version: string }).version, contextA.version);

  const saved = await json(worker, "/api/intake", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ url: "https://example.com/essay", title: "Local-first software", body: "secret body" }),
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));

  const searchA = await json(worker, "/api/intake/search?url=https://example.com/essay", {
    headers: { cookie: a.cookie },
  });
  const hitsA = searchA.body as { items: { url: string; body?: string }[] };
  assert.equal(hitsA.items.length, 1);
  assert.equal(hitsA.items[0]?.url, "https://example.com/essay");
  assert.equal(hitsA.items[0]?.body, undefined);

  const searchB = await json(worker, "/api/intake/search?url=https://example.com/essay", {
    headers: { cookie: b.cookie },
  });
  assert.deepEqual((searchB.body as { items: unknown[] }).items, []);

  const impersonate = await json(worker, "/api/intake/search?url=https://example.com/essay", {
    headers: { cookie: a.cookie },
  });
  assert.equal(impersonate.res.status, 200);

  const prepared = await json(worker, "/api/intake/drafts/prepare", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({
      drafts: [{
        url: "https://example.com/draft",
        title: "Proposed",
        tagIds: [tagId],
        proposedNewTags: ["fresh"],
        rationale: "Matches the topic",
      }],
    }),
  });
  assert.equal(prepared.res.status, 200, JSON.stringify(prepared.body));
  const shown = prepared.body as {
    drafts: { tags: { id: string | null; name: string; proposed: boolean }[]; item: { url: string } }[];
  };
  assert.equal(shown.drafts[0]?.item.url, "https://example.com/draft");
  assert.equal(shown.drafts[0]?.tags.some((entry) => entry.proposed && entry.name === "fresh"), true);
  const listed = await json(worker, "/api/items", { headers: { cookie: a.cookie } });
  assert.equal((listed.body as { items: unknown[] }).items.length, 1);

  const payload = {
    clientMutationId: "hosted-1",
    instruction: "save these URLs to Research and tag alpha",
    contextVersion: contextA.version,
    drafts: [
      {
        url: "https://example.com/a",
        title: "A",
        observedFields: ["title"],
        collectionIds: [collectionId],
      },
      {
        url: "HTTPS://EXAMPLE.COM:443/a",
        title: "Ignored",
        observedFields: ["title"],
        tagIds: [tagId],
        classifications: [{
          tagId,
          rationale: "Matches the requested topic",
          evidence: [{ field: "instruction", text: "save these URLs to Research and tag alpha" }],
        }],
      },
    ],
  };
  const batch = await json(worker, "/api/intake/batch", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify(payload),
  });
  assert.equal(batch.res.status, 200, JSON.stringify(batch.body));
  const created = batch.body as {
    actor: string;
    drafts: { outcome: string; item: { id: string; title: string; intakeActor: string; notes?: unknown } }[];
  };
  assert.equal(created.actor, "agent");
  assert.equal(created.drafts[0]?.outcome, "created");
  assert.equal(created.drafts[1]?.outcome, "reused");
  assert.equal(created.drafts[0]?.item.id, created.drafts[1]?.item.id);
  assert.equal(created.drafts[0]?.item.title, "A");
  assert.equal(created.drafts[0]?.item.intakeActor, "agent");

  const replay = await json(worker, "/api/intake/batch", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify(payload),
  });
  assert.deepEqual(replay.body, batch.body);

  const changed = await json(worker, "/api/intake/batch", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ ...payload, drafts: [{ url: "https://example.com/changed", observedFields: [] }] }),
  });
  assert.equal(changed.res.status, 400);
  assert.match(JSON.stringify(changed.body), /different change/);

  const stale = await json(worker, "/api/intake/batch", {
    method: "POST",
    headers: headersA,
    body: JSON.stringify({ ...payload, clientMutationId: "hosted-2", contextVersion: "deadbeef" }),
  });
  assert.equal(stale.res.status, 400);
  assert.match(JSON.stringify(stale.body), /stale context/);

  const crossTag = await json(worker, "/api/intake/batch", {
    method: "POST",
    headers: headersB,
    body: JSON.stringify({
      clientMutationId: "bob-1",
      contextVersion: (contextB.body as { version: string }).version,
      drafts: [{ url: "https://example.com/bob", observedFields: [], tagIds: [tagId] }],
    }),
  });
  assert.equal(crossTag.res.status, 400);
  assert.match(JSON.stringify(crossTag.body), /unknown tag/);

  const listB = await json(worker, "/api/items", { headers: { cookie: b.cookie } });
  assert.equal((listB.body as { items: unknown[] }).items.length, 0);

  const guessedItem = await json(worker, `/api/items/${created.drafts[0]!.item.id}`, {
    headers: { cookie: b.cookie },
  });
  assert.equal(guessedItem.res.status, 404);
});

test("Account issues, lists, and revokes Library capabilities; MCP uses the bound Library", async () => {
  const user = await login(worker, "intake-mcp@example.com", "Mcp");
  const other = await login(worker, "intake-mcp-b@example.com", "Other");
  const session = await sessionOf(worker, user.cookie);
  const otherSession = await sessionOf(worker, other.cookie);
  const headers = mutate(user.cookie, session.csrfToken);

  const collection = await json(worker, "/api/collections", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "Research" }),
  });
  const collectionId = (collection.body as { collection: { id: string } }).collection.id;
  const tag = await json(worker, "/api/intake/tags", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "alpha" }),
  });
  const tagId = (tag.body as { tag: { id: string }; context: { version: string } }).tag.id;
  const contextVersion = (tag.body as { context: { version: string } }).context.version;

  const csrf = await json(worker, "/api/library-capabilities", {
    method: "POST",
    headers: { cookie: user.cookie, "content-type": "application/json" },
    body: JSON.stringify({ scope: "library:write", label: "Cursor" }),
  });
  assert.equal(csrf.res.status, 403);

  const issued = await json(worker, "/api/library-capabilities", {
    method: "POST",
    headers,
    body: JSON.stringify({ scope: "library:write", label: "Cursor" }),
  });
  assert.equal(issued.res.status, 200, JSON.stringify(issued.body));
  const write = issued.body as {
    token: string;
    url: string;
    capability: { id: string; scope: string; label: string; libraryId: string };
  };
  assert.match(write.token, /^lib_/);
  assert.match(write.url, /\/mcp$/);
  assert.equal(write.capability.scope, "library:write");
  assert.equal(write.capability.libraryId, session.library.id);

  const listed = await json(worker, "/api/library-capabilities", { headers: { cookie: user.cookie } });
  const page = listed.body as { capabilities: { id: string; token?: string; token_hash?: string }[] };
  assert.equal(page.capabilities.length, 1);
  assert.equal(page.capabilities[0]?.id, write.capability.id);
  assert.equal(page.capabilities[0]?.token, undefined);
  assert.equal(page.capabilities[0]?.token_hash, undefined);

  const otherList = await json(worker, "/api/library-capabilities", { headers: { cookie: other.cookie } });
  assert.equal((otherList.body as { capabilities: unknown[] }).capabilities.length, 0);

  const readIssued = await json(worker, "/api/library-capabilities", {
    method: "POST",
    headers,
    body: JSON.stringify({ scope: "library:read", label: "Claude" }),
  });
  const readToken = (readIssued.body as { token: string }).token;

  const listedRead = await mcp(worker, readToken, "tools/list");
  const readTools = ((listedRead.body as { result: { tools: { name: string }[] } }).result.tools).map((tool) => tool.name);
  assert.deepEqual(readTools, ["get_library_intake_context", "search_library"]);

  const writeList = await mcp(worker, write.token, "tools/list");
  const writeTools = ((writeList.body as { result: { tools: { name: string; description: string }[] } }).result.tools);
  assert.deepEqual(writeTools.map((tool) => tool.name), [
    "get_library_intake_context",
    "search_library",
    "create_items",
  ]);
  assert.match(writeTools[2]?.description ?? "", /cannot be auto-saved/);

  const createDenied = await mcp(worker, readToken, "tools/call", { name: "create_items", arguments: {} });
  assert.equal(toolPayload(createDenied.body).error, "unavailable");

  const payload = {
    clientMutationId: "mcp-1",
    instruction: "save these URLs to Research and tag alpha",
    contextVersion,
    drafts: [
      {
        url: "https://example.com/mcp-a",
        title: "A",
        observedFields: ["title"],
        collectionIds: [collectionId],
        tagIds: [tagId],
        classifications: [{
          tagId,
          rationale: "Matches the requested topic",
          evidence: [{ field: "instruction", text: "save these URLs to Research and tag alpha" }],
        }],
      },
    ],
  };
  const created = await mcp(worker, write.token, "tools/call", { name: "create_items", arguments: payload });
  const result = toolPayload(created.body) as {
    ok: boolean;
    actor: string;
    drafts: { outcome: string; item: { id: string; intakeActor: string; notes?: unknown } }[];
  };
  assert.equal(result.ok, true);
  assert.equal(result.actor, "agent");
  assert.equal(result.drafts[0]?.outcome, "created");
  assert.equal(result.drafts[0]?.item.intakeActor, "agent");
  assert.equal(result.drafts[0]?.item.notes, undefined);

  const otherItems = await json(worker, "/api/items", { headers: { cookie: other.cookie } });
  assert.equal((otherItems.body as { items: unknown[] }).items.length, 0);

  const capturePair = await json(worker, "/api/extension/pair", { method: "POST", headers });
  assert.equal(capturePair.res.status, 200, JSON.stringify(capturePair.body));
  const captureToken = (capturePair.body as { token: string }).token;
  const captureOnMcp = await mcp(worker, captureToken, "initialize");
  assert.equal(captureOnMcp.res.status, 401);

  const guessedRevoke = await json(worker, "/api/library-capabilities/00000000-0000-4000-8000-000000000000/revoke", {
    method: "POST",
    headers: mutate(other.cookie, otherSession.csrfToken),
    body: "{}",
  });
  assert.equal(guessedRevoke.res.status, 404);

  const crossRevoke = await json(worker, `/api/library-capabilities/${write.capability.id}/revoke`, {
    method: "POST",
    headers: mutate(other.cookie, otherSession.csrfToken),
    body: "{}",
  });
  assert.equal(crossRevoke.res.status, 404);

  const revoked = await json(worker, `/api/library-capabilities/${write.capability.id}/revoke`, {
    method: "POST",
    headers,
    body: "{}",
  });
  assert.equal(revoked.res.status, 200);
  const after = await mcp(worker, write.token, "tools/list");
  assert.equal(after.res.status, 401);
});

test("reviewed draft save commits selected Items and respects stale context", async () => {
  const user = await login(worker, "intake-review@example.com", "Review");
  const session = await sessionOf(worker, user.cookie);
  const headers = mutate(user.cookie, session.csrfToken);
  const context = await json(worker, "/api/intake/context", { headers: { cookie: user.cookie } });
  const version = (context.body as { version: string }).version;
  const saved = await json(worker, "/api/intake/drafts/save", {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientMutationId: "review-1",
      contextVersion: version,
      drafts: [{ url: "https://example.com/reviewed", title: "Reviewed" }],
    }),
  });
  assert.equal(saved.res.status, 200, JSON.stringify(saved.body));
  const result = saved.body as { actor: string; drafts: { outcome: string; item: { intakeActor: string; title: string } }[] };
  assert.equal(result.actor, "agent");
  assert.equal(result.drafts[0]?.outcome, "created");
  assert.equal(result.drafts[0]?.item.intakeActor, "agent");
  assert.equal(result.drafts[0]?.item.title, "Reviewed");

  const tag = await json(worker, "/api/intake/tags", {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "later" }),
  });
  assert.equal(tag.res.status, 200);
  const stale = await json(worker, "/api/intake/drafts/save", {
    method: "POST",
    headers,
    body: JSON.stringify({
      clientMutationId: "review-2",
      contextVersion: version,
      drafts: [{ url: "https://example.com/stale" }],
    }),
  });
  assert.equal(stale.res.status, 400);
  assert.match(JSON.stringify(stale.body), /stale context/);
});
