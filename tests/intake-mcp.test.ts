import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { createCollection } from "../core/commands.ts";
import { listItems, wipeLibrary } from "../core/library.ts";
import { issueToken } from "../server/capture/ingest.ts";
import { issueLibraryCapability, lookupLibraryCapability } from "../server/intake/capabilities.ts";
import { commitIntakeItem, getIntakeContext, getIntakeProvenance } from "../server/intake/module.ts";
import { writeLibraryArchive } from "../server/library-archive.ts";

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8852";
const { listen } = await import("../server/http/server.ts");

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-intake-mcp-")), "t.db"));
}

async function start(database: ReturnType<typeof mem>) {
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
  const session = (await sessionResponse.json()) as { csrf: string };
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const headers = { cookie, "content-type": "application/json", "x-csrf-token": session.csrf };
  return {
    base,
    headers,
    close: () => app.close(),
    post: (path: string, body: unknown) =>
      fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    get: (path: string) => fetch(`${base}${path}`, { headers }),
  };
}

async function eventually(request: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await request();
    } catch {
      if (attempt === 19) throw new Error("server did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("unreachable");
}

async function mcp(base: string, token: string | null, method: string, params?: unknown, extra: Record<string, string> = {}) {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (token) headers.authorization = `Bearer ${token}`;
  return fetch(`${base}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params === undefined ? {} : { params }) }),
  });
}

function toolPayload(body: unknown): Record<string, unknown> {
  const rec = body as { result?: { content?: { text?: string }[] } };
  const text = rec.result?.content?.[0]?.text;
  assert.equal(typeof text, "string");
  return JSON.parse(text as string) as Record<string, unknown>;
}

test("Account can issue, inspect, and revoke Library capabilities without exposing secrets later", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const created = await app.post("/api/library-capabilities", { scope: "library:read", label: "Claude" });
    assert.equal(created.status, 200);
    const issued = (await created.json()) as {
      token: string;
      url: string;
      capability: { id: string; scope: string; label: string; libraryId: string };
    };
    assert.match(issued.token, /^lib_/);
    assert.match(issued.url, /\/mcp$/);
    assert.equal(issued.capability.scope, "library:read");
    assert.equal(issued.capability.label, "Claude");
    assert.equal(issued.capability.libraryId, "local");

    const listed = await app.get("/api/library-capabilities");
    const page = (await listed.json()) as { capabilities: { id: string; token?: string; token_hash?: string }[] };
    assert.equal(page.capabilities.length, 1);
    assert.equal(page.capabilities[0]?.id, issued.capability.id);
    assert.equal(page.capabilities[0]?.token, undefined);
    assert.equal(page.capabilities[0]?.token_hash, undefined);

    const csrf = await fetch(`${app.base}/api/library-capabilities`, {
      method: "POST",
      headers: { cookie: app.headers.cookie, "content-type": "application/json" },
      body: JSON.stringify({ scope: "library:write" }),
    });
    assert.equal(csrf.status, 403);

    const anon = await fetch(`${app.base}/api/library-capabilities`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-csrf-token": "nope" },
      body: JSON.stringify({ scope: "library:read" }),
    });
    assert.equal(anon.status, 401);

    const revoked = await app.post(`/api/library-capabilities/${issued.capability.id}/revoke`, {});
    assert.equal(revoked.status, 200);
    const after = (await (await app.get("/api/library-capabilities")).json()) as { capabilities: unknown[] };
    assert.equal(after.capabilities.length, 0);
    assert.equal(lookupLibraryCapability(database, issued.token), null);
  } finally {
    await app.close();
    database.close();
  }
});

test("direct MCP read tools use the capability's Library and match page context/search bounds", async () => {
  const database = mem();
  const collection = createCollection(database, "Research", "Deep reading");
  database.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-tech', 'tech', NULL)`).run();
  commitIntakeItem(database, { libraryId: "local", actor: "user" }, {
    url: "https://example.com/essay",
    title: "Local-first software",
    body: "secret body that must not leak",
  });
  const app = await start(database);
  try {
    const read = await app.post("/api/library-capabilities", { scope: "library:read", label: "Cursor" });
    const write = await app.post("/api/library-capabilities", { scope: "library:write", label: "Cursor" });
    const readToken = ((await read.json()) as { token: string }).token;
    const writeToken = ((await write.json()) as { token: string }).token;

    const listed = await mcp(app.base, readToken, "tools/list");
    const tools = ((await listed.json()) as { result: { tools: { name: string }[] } }).result.tools.map((tool) => tool.name);
    assert.deepEqual(tools, ["get_library_intake_context", "search_library"]);

    const contextRes = await mcp(app.base, readToken, "tools/call", { name: "get_library_intake_context", arguments: {} });
    const context = toolPayload(await contextRes.json());
    const expected = getIntakeContext(database, { libraryId: "local" });
    assert.equal(context.ok, true);
    assert.equal(context.version, expected.version);
    assert.deepEqual(context.collections, expected.collections);
    assert.equal(JSON.stringify(context).includes("secret body"), false);

    const searchRes = await mcp(app.base, readToken, "tools/call", {
      name: "search_library",
      arguments: { url: "https://example.com/essay" },
    });
    const search = toolPayload(await searchRes.json()) as { ok: boolean; items: { url: string; title: string; body?: string; notes?: string }[] };
    assert.equal(search.ok, true);
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0]?.url, "https://example.com/essay");
    assert.equal(search.items[0]?.body, undefined);
    assert.equal(search.items[0]?.notes, undefined);

    const impersonate = await mcp(app.base, readToken, "tools/call", {
      name: "search_library",
      arguments: { url: "https://example.com/essay", libraryId: "other", actor: "user" },
    });
    assert.equal(toolPayload(await impersonate.json()).error, "invalid");

    const writeList = await mcp(app.base, writeToken, "tools/list");
    const writeTools = ((await writeList.json()) as { result: { tools: { name: string; description: string }[] } }).result.tools;
    assert.deepEqual(writeTools.map((tool) => tool.name), [
      "get_library_intake_context",
      "search_library",
      "create_items",
    ]);
    assert.match(writeTools[2]?.description ?? "", /page workflow/);
    assert.match(writeTools[2]?.description ?? "", /cannot be auto-saved/);
    const writeRead = await mcp(app.base, writeToken, "tools/call", { name: "get_library_intake_context", arguments: {} });
    assert.equal(toolPayload(await writeRead.json()).ok, true);
    const create = await mcp(app.base, readToken, "tools/call", { name: "create_items", arguments: {} });
    assert.equal(toolPayload(await create.json()).error, "unavailable");
    assert.ok(collection.id);
  } finally {
    await app.close();
    database.close();
  }
});

test("direct MCP create_items commits an exact write-scoped batch", async () => {
  const database = mem();
  const collection = createCollection(database, "Research");
  database.prepare(`INSERT INTO tags (id, name, color) VALUES ('tag-a', 'alpha', NULL)`).run();
  const context = getIntakeContext(database, { libraryId: "local" });
  const app = await start(database);
  try {
    const write = await app.post("/api/library-capabilities", { scope: "library:write", label: "Cursor" });
    const writeToken = ((await write.json()) as { token: string }).token;
    const payload = {
      clientMutationId: "mcp-1",
      instruction: "save these URLs to Research and tag alpha",
      contextVersion: context.version,
      drafts: [
        {
          url: "https://example.com/a",
          title: "A",
          observedFields: ["title"],
          collectionIds: [collection.id],
        },
        {
          url: "HTTPS://EXAMPLE.COM:443/a",
          title: "Ignored",
          observedFields: ["title"],
          tagIds: ["tag-a"],
          classifications: [{
            tagId: "tag-a",
            rationale: "Matches the requested topic",
            evidence: [{ field: "instruction", text: "save these URLs to Research and tag alpha" }],
          }],
        },
      ],
    };

    const created = await mcp(app.base, writeToken, "tools/call", { name: "create_items", arguments: payload });
    const result = toolPayload(await created.json()) as {
      ok: boolean;
      actor: string;
      instruction?: string;
      drafts: {
        outcome: string;
        item: { id: string; title: string; url: string; intakeActor: string; notes?: unknown; publishedAt: string | null };
        added: { tagIds: string[]; collectionIds: string[] };
      }[];
    };
    assert.equal(result.ok, true);
    assert.equal(result.actor, "agent");
    assert.equal(result.instruction, undefined);
    assert.equal(result.drafts[0]?.outcome, "created");
    assert.equal(result.drafts[1]?.outcome, "reused");
    assert.equal(result.drafts[0]?.item.id, result.drafts[1]?.item.id);
    assert.equal(result.drafts[0]?.item.title, "A");
    assert.equal(result.drafts[0]?.item.intakeActor, "agent");
    assert.equal(result.drafts[0]?.item.publishedAt, null);
    assert.equal(result.drafts[0]?.item.notes, undefined);
    assert.equal(JSON.stringify(result).includes("notes"), false);
    assert.equal(listItems(database).length, 1);
    assert.deepEqual(getIntakeProvenance(database, result.drafts[0]!.item.id).classifications[0]?.rationale, "Matches the requested topic");

    const replay = await mcp(app.base, writeToken, "tools/call", { name: "create_items", arguments: payload });
    assert.deepEqual(toolPayload(await replay.json()), result);
    assert.equal(listItems(database).length, 1);

    const changed = await mcp(app.base, writeToken, "tools/call", {
      name: "create_items",
      arguments: { ...payload, drafts: [{ url: "https://example.com/changed", observedFields: [] }] },
    });
    assert.equal(toolPayload(await changed.json()).error, "invalid");
    assert.equal(listItems(database).length, 1);

    const impersonate = await mcp(app.base, writeToken, "tools/call", {
      name: "create_items",
      arguments: { ...payload, clientMutationId: "mcp-2", actor: "user", libraryId: "other" },
    });
    assert.equal(toolPayload(await impersonate.json()).error, "invalid");

    const stale = await mcp(app.base, writeToken, "tools/call", {
      name: "create_items",
      arguments: { ...payload, clientMutationId: "mcp-3", contextVersion: "deadbeef" },
    });
    assert.equal(toolPayload(await stale.json()).error, "stale-context");
    assert.equal(listItems(database).length, 1);

    const unknown = await mcp(app.base, writeToken, "tools/call", {
      name: "create_items",
      arguments: {
        clientMutationId: "mcp-4",
        contextVersion: context.version,
        drafts: [
          { url: "https://example.com/keep", observedFields: [] },
          { url: "https://example.com/bad", tagIds: ["missing"], observedFields: [] },
        ],
      },
    });
    assert.equal(toolPayload(await unknown.json()).error, "invalid");
    assert.equal(listItems(database).length, 1);

    const oversized = await mcp(app.base, writeToken, "tools/call", {
      name: "create_items",
      arguments: {
        clientMutationId: "mcp-5",
        contextVersion: context.version,
        drafts: Array.from({ length: 26 }, (_, i) => ({ url: `https://example.com/n/${i}`, observedFields: [] })),
      },
    });
    assert.equal(toolPayload(await oversized.json()).error, "invalid");

    const unsafe = await mcp(app.base, writeToken, "tools/call", {
      name: "create_items",
      arguments: {
        clientMutationId: "mcp-6",
        contextVersion: context.version,
        drafts: [{ url: "javascript:alert(1)", observedFields: [] }],
      },
    });
    assert.equal(toolPayload(await unsafe.json()).error, "invalid");
    assert.equal(listItems(database).length, 1);

    const captureToken = issueToken(database, "*", null).token;
    const captureCreate = await mcp(app.base, captureToken, "tools/call", { name: "create_items", arguments: payload });
    assert.equal(captureCreate.status, 401);
  } finally {
    await app.close();
    database.close();
  }
});

test("Capture tokens and Library capabilities cannot use each other's endpoints", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const library = await app.post("/api/library-capabilities", { scope: "library:read", label: "Agent" });
    const libraryToken = ((await library.json()) as { token: string }).token;
    const captureToken = issueToken(database, "*", null).token;

    const captureOnMcp = await mcp(app.base, captureToken, "initialize");
    assert.equal(captureOnMcp.status, 401);
    assert.deepEqual(await captureOnMcp.json(), { error: "unauthorized" });

    const missing = await mcp(app.base, null, "initialize");
    assert.equal(missing.status, 401);
    assert.deepEqual(await missing.json(), { error: "unauthorized" });

    const captureWait = await fetch(`${app.base}/capture/v1/jobs/missing-job`, {
      headers: { authorization: `Bearer ${libraryToken}` },
    });
    assert.equal(captureWait.status, 401);

    const foreign = issueLibraryCapability(database, { libraryId: "other", scope: "library:read" });
    const cross = await mcp(app.base, foreign.token, "tools/list");
    assert.equal(cross.status, 401);
    assert.deepEqual(await cross.json(), { error: "unauthorized" });

    await app.post(`/api/library-capabilities/${((await (await app.get("/api/library-capabilities")).json()) as { capabilities: { id: string }[] }).capabilities[0]!.id}/revoke`, {});
    const revoked = await mcp(app.base, libraryToken, "tools/list");
    assert.equal(revoked.status, 401);
    assert.deepEqual(await revoked.json(), { error: "unauthorized" });

    const stillCapture = await fetch(`${app.base}/capture/v1/jobs/missing-job`, {
      headers: { authorization: `Bearer ${captureToken}` },
    });
    assert.equal(stillCapture.status, 404);
  } finally {
    await app.close();
    database.close();
  }
});

test("Library capability secrets stay out of archives and wipe", async () => {
  const database = mem();
  const issued = issueLibraryCapability(database, { libraryId: "local", scope: "library:read", label: "Claude" });
  const dest = join(mkdtempSync(join(tmpdir(), "locus-intake-mcp-archive-")), "library.ndjson");
  writeLibraryArchive(database, dest);
  const text = readFileSync(dest, "utf8");
  assert.equal(text.includes(issued.token), false);
  assert.equal(text.includes("library_capabilities"), true);
  assert.match(text, /"excluded":\[[^\]]*library_capabilities/);
  assert.equal(lookupLibraryCapability(database, issued.token)?.label, "Claude");
  wipeLibrary(database);
  assert.equal(lookupLibraryCapability(database, issued.token), null);
});
