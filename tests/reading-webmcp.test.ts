import { test } from "node:test";
import assert from "node:assert/strict";
import {
  READING_WEBMCP_VERSION,
  attachReadingWebmcp,
  detectReadingWebmcpRuntime,
  registerReadingWebmcp,
  type ReadingWebmcpAgentDocument,
  type ReadingWebmcpHost,
  type ReadingWebmcpRuntime,
} from "../app/src/reading-webmcp.ts";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => unknown | Promise<unknown>;
};

type Panel = { mood: string | null; recommendations: Array<Record<string, unknown>> };

const FOUR_TOOLS = ["get_reading", "get_reading_context", "present_reading_recommendations", "search_reading"];

function fakeRuntime() {
  const tools = new Map<string, RegisteredTool>();
  const runtime: ReadingWebmcpRuntime = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      const remove = () => tools.delete(tool.name);
      if (options?.signal?.aborted) remove();
      else options?.signal?.addEventListener("abort", remove, { once: true });
    },
  };
  return { runtime, tools };
}

function fakeHost() {
  const ctx = {
    mood: null as string | null,
    view: "queue" as "queue" | "finished",
    q: "",
    kind: "",
    source: "",
    sort: "recent",
    counts: { unread: 0, reading: 0, preparing: 0, finished: 0 },
  };
  const searchCalls: Array<Record<string, unknown>> = [];
  const docs = new Map<string, Record<string, unknown>>();
  const panels: Panel[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const host: ReadingWebmcpHost = {
    getPageContext: () => ({ mood: ctx.mood, view: ctx.view, q: ctx.q, kind: ctx.kind, source: ctx.source, sort: ctx.sort, counts: { ...ctx.counts } }),
    async search(query) {
      searchCalls.push(query);
      return { items: [{ id: "doc-1" }, { id: "doc-2" }], nextCursor: null };
    },
    async getDocument(documentId) {
      return (docs.get(documentId) as ReadingWebmcpAgentDocument | undefined) ?? null;
    },
    present(panel) {
      panels.push({ mood: panel.mood, recommendations: panel.recommendations as Array<Record<string, unknown>> });
    },
    log(entry) {
      logs.push({ ...entry });
    },
  };
  return { ctx, host, searchCalls, docs, panels, logs };
}

function storedDoc(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    title: `Title ${id}`,
    canonicalUrl: `https://example.com/${id}`,
    availability: "ready",
    hasStoredText: true,
    readingMinutes: 7,
    publication: "Pub",
    host: "example.com",
    readingState: "unread",
    text: "SECRET-ARTICLE-TEXT",
    truncated: false,
    totalTextLength: 19,
    provenance: [],
    ...overrides,
  };
}

async function call(tools: Map<string, RegisteredTool>, name: string, input?: unknown): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return (await tool.execute(input)) as Record<string, unknown>;
}

test("registers exactly the four Reading tools and never a recommender", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerReadingWebmcp(runtime, host);
  assert.deepEqual([...tools.keys()].sort(), FOUR_TOOLS);
  assert.equal(tools.has("recommend_reading"), false);
  cleanup();
});

test("tool schemas exist, declare objects, and omit library identity fields", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerReadingWebmcp(runtime, host);
  for (const [name, tool] of tools) {
    assert.equal(tool.inputSchema.type, "object", name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    const schema = JSON.stringify(tool.inputSchema);
    assert.equal(schema.includes("libraryId"), false, name);
    assert.equal(schema.includes("actor"), false, name);
    assert.ok(tool.description.length > 40, name);
  }
  assert.match(tools.get("search_reading")!.description, /stored article text is NOT in this tool/);
  assert.match(tools.get("search_reading")!.description, /independently open a safe canonical URL/);
  assert.match(tools.get("get_reading")!.description, /never fetches the publisher/);
  assert.match(tools.get("get_reading")!.description, /if hasStoredText is false/);
  const presentProperties = tools.get("present_reading_recommendations")!.inputSchema.properties as Record<string, Record<string, unknown>>;
  assert.equal(presentProperties.recommendations!.maxItems, undefined);
  cleanup();
});

test("repeated registration stays idempotent and cleanup removes all four", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup1 = registerReadingWebmcp(runtime, host);
  const cleanup2 = registerReadingWebmcp(runtime, host);
  assert.equal(tools.size, 4);
  cleanup2();
  assert.equal(tools.size, 0);
  cleanup1();
  assert.equal(tools.size, 0);
});

test("registering against a failing runtime does not throw and returns a no-op", () => {
  const { host } = fakeHost();
  const failing: ReadingWebmcpRuntime = {
    registerTool() {
      throw new Error("boom");
    },
  };
  const cleanup = registerReadingWebmcp(failing, host);
  cleanup();
});

test("get_reading_context reads live page state without re-registration", async () => {
  const { runtime, tools } = fakeRuntime();
  const { ctx, host } = fakeHost();
  const cleanup = registerReadingWebmcp(runtime, host);
  const before = await call(tools, "get_reading_context", {});
  assert.equal(before.ok, true);
  assert.deepEqual(Object.keys(before).sort(), [
    "capabilityVersion",
    "counts",
    "kind",
    "mood",
    "ok",
    "q",
    "sort",
    "source",
    "view",
    "webmcpActive",
  ]);
  assert.equal(before.capabilityVersion, READING_WEBMCP_VERSION);
  assert.equal(before.mood, null);
  assert.equal(before.webmcpActive, true);
  ctx.mood = "thoughtful";
  ctx.view = "finished";
  ctx.q = "essays";
  ctx.counts.unread = 42;
  const after = await call(tools, "get_reading_context", {});
  assert.equal(after.mood, "thoughtful");
  assert.equal(after.view, "finished");
  assert.equal(after.q, "essays");
  assert.deepEqual(after.counts, { unread: 42, reading: 0, preparing: 0, finished: 0 });
  cleanup();
});

test("search defaults come from page context, explicit input overrides, page state unchanged", async () => {
  const { runtime, tools } = fakeRuntime();
  const { ctx, host, searchCalls } = fakeHost();
  ctx.q = "page query";
  ctx.view = "queue";
  const cleanup = registerReadingWebmcp(runtime, host);
  const defaults = await call(tools, "search_reading", {});
  assert.equal(defaults.ok, true);
  assert.deepEqual(searchCalls[0], { view: "queue", q: "page query", kind: "", source: "", sort: "recent", limit: 50 });
  assert.deepEqual(defaults.items, [{ id: "doc-1" }, { id: "doc-2" }]);
  assert.equal(defaults.nextCursor, null);
  const override = await call(tools, "search_reading", { q: "agent query", view: "finished", limit: 10 });
  assert.equal(override.ok, true);
  assert.deepEqual(searchCalls[1], { view: "finished", q: "agent query", kind: "", source: "", sort: "recent", limit: 10 });
  assert.equal(ctx.q, "page query");
  assert.equal(ctx.view, "queue");
  cleanup();
});

test("search rejects an out-of-range limit without calling the host", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, searchCalls } = fakeHost();
  const cleanup = registerReadingWebmcp(runtime, host);
  for (const limit of [51, 0, 2.5]) {
    const bad = await call(tools, "search_reading", { limit });
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "invalid");
  }
  assert.equal(searchCalls.length, 0);
  cleanup();
});

test("search rejects malformed sources and cursors as invalid before calling the host", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, searchCalls } = fakeHost();
  const cleanup = registerReadingWebmcp(runtime, host);
  const wrongSortCursor = Buffer.from(JSON.stringify({ sort: "oldest", k: "2026-01-01", id: "doc-1" }), "utf8").toString("base64url");
  const malformedCursor = Buffer.from(JSON.stringify({ sort: "recent", id: "doc-1" }), "utf8").toString("base64url");
  for (const input of [
    { source: "" },
    { source: "not a source" },
    { source: "1reddit" },
    { cursor: "not-base64!" },
    { cursor: malformedCursor },
    { sort: "recent", cursor: wrongSortCursor },
  ]) {
    const bad = await call(tools, "search_reading", input);
    assert.equal(bad.ok, false);
    assert.equal(bad.error, "invalid");
  }
  assert.equal(searchCalls.length, 0);
  cleanup();
});

test("search forwards valid source and sort-compatible cursors", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, searchCalls } = fakeHost();
  const cleanup = registerReadingWebmcp(runtime, host);
  const cursor = Buffer.from(JSON.stringify({ sort: "oldest", k: "2026-01-01", id: "doc-1" }), "utf8").toString("base64url");
  const result = await call(tools, "search_reading", { source: "reddit_export", sort: "oldest", cursor });
  assert.equal(result.ok, true);
  assert.equal(searchCalls.length, 1);
  assert.equal(searchCalls[0]!.source, "reddit_export");
  assert.equal(searchCalls[0]!.cursor, cursor);
  cleanup();
});

test("extra libraryId and actor keys in tool input are ignored, never forwarded", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, searchCalls, docs, panels } = fakeHost();
  docs.set("doc-a", storedDoc("doc-a"));
  const cleanup = registerReadingWebmcp(runtime, host);
  const searched = await call(tools, "search_reading", { q: "x", libraryId: "other-library", actor: "agent" });
  assert.equal(searched.ok, true);
  assert.equal("libraryId" in searchCalls[0]!, false);
  assert.equal("actor" in searchCalls[0]!, false);
  const presented = await call(tools, "present_reading_recommendations", {
    mood: "short",
    recommendations: [{ documentId: "doc-a", reason: "fits", basis: "stored_text", libraryId: "other-library" }],
  });
  assert.equal(presented.ok, true);
  assert.equal(panels[0]!.recommendations[0]!.hasOwnProperty("libraryId"), false);
  cleanup();
});

test("host HTTP 400 maps to invalid so the agent can fix the request, 500 stays unavailable", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, logs } = fakeHost();
  host.search = async () => {
    const error = new Error("invalid cursor");
    (error as { status?: number }).status = 400;
    throw error;
  };
  const cleanup = registerReadingWebmcp(runtime, host);
  const rejected = await call(tools, "search_reading", { q: "x" });
  assert.equal(rejected.ok, false);
  assert.equal(rejected.error, "invalid");
  assert.notEqual(rejected.error, "unavailable");
  host.search = async () => {
    const error = new Error("boom");
    (error as { status?: number }).status = 500;
    throw error;
  };
  const outage = await call(tools, "search_reading", { q: "x" });
  assert.equal(outage.ok, false);
  assert.equal(outage.error, "unavailable");
  assert.deepEqual(logs.map((entry) => entry.outcome), ["invalid", "unavailable"]);
  cleanup();
});

test("get_reading returns the bounded projection and not-found for unknown ids", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, docs } = fakeHost();
  docs.set("doc-1", storedDoc("doc-1"));
  const cleanup = registerReadingWebmcp(runtime, host);
  const found = await call(tools, "get_reading", { documentId: "doc-1" });
  assert.equal(found.ok, true);
  const doc = found.document as Record<string, unknown>;
  assert.equal(doc.title, "Title doc-1");
  assert.equal(doc.text, "SECRET-ARTICLE-TEXT");
  const missing = await call(tools, "get_reading", { documentId: "invented" });
  assert.equal(missing.ok, false);
  assert.equal(missing.error, "not-found");
  const malformed = await call(tools, "get_reading", { documentId: "" });
  assert.equal(malformed.ok, false);
  assert.equal(malformed.error, "invalid");
  cleanup();
});

test("present accepts a variable recommendation count with every evidence basis", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, docs, panels } = fakeHost();
  const ids = ["a", "b", "c", ...Array.from({ length: 72 }, (_, index) => `doc-${index + 4}`)];
  for (const id of ids) docs.set(id, storedDoc(id));
  const cleanup = registerReadingWebmcp(runtime, host);
  const one = await call(tools, "present_reading_recommendations", {
    mood: "thoughtful",
    recommendations: [{ documentId: "a", reason: "deep dive", basis: "stored_text" }],
  });
  assert.equal(one.ok, true);
  const two = await call(tools, "present_reading_recommendations", {
    recommendations: [
      { documentId: "a", reason: "stored", basis: "stored_text" },
      { documentId: "b", reason: "skimmed metadata", basis: "metadata" },
    ],
  });
  assert.equal(two.ok, true);
  const ten = await call(tools, "present_reading_recommendations", {
    mood: "short",
    recommendations: ids.slice(0, 10).map((documentId, index) => ({
      documentId,
      reason: `reason ${index + 1}`,
      basis: (["stored_text", "metadata", "external_source"] as const)[index % 3],
    })),
  });
  assert.equal(ten.ok, true);
  const seventyFive = await call(tools, "present_reading_recommendations", {
    recommendations: ids.map((documentId) => ({ documentId, reason: "worth reading", basis: "metadata" })),
  });
  assert.equal(seventyFive.ok, true);
  assert.equal(panels.length, 4);
  assert.equal(panels[2]!.recommendations.length, 10);
  assert.equal(panels[3]!.recommendations.length, 75);
  assert.deepEqual(
    panels[2]!.recommendations.slice(0, 3).map((entry) => entry.basis),
    ["stored_text", "metadata", "external_source"],
  );
  assert.deepEqual(
    panels[2]!.recommendations.slice(0, 3).map((entry) => entry.canonicalUrl),
    ["https://example.com/a", "https://example.com/b", "https://example.com/c"],
  );
  assert.equal(panels[2]!.mood, "short");
  cleanup();
});

test("present falls back to the page mood when the agent omits it", async () => {
  const { runtime, tools } = fakeRuntime();
  const { ctx, host, docs, panels } = fakeHost();
  docs.set("a", storedDoc("a"));
  ctx.mood = "comforting";
  const cleanup = registerReadingWebmcp(runtime, host);
  await call(tools, "present_reading_recommendations", {
    recommendations: [{ documentId: "a", reason: "warm", basis: "metadata" }],
  });
  assert.equal(panels[0]!.mood, "comforting");
  cleanup();
});

test("present rejects duplicates, lists larger than the available documents, and unsafe URLs atomically", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, docs, panels } = fakeHost();
  docs.set("a", storedDoc("a"));
  docs.set("b", storedDoc("b"));
  docs.set("unsafe", storedDoc("unsafe", { canonicalUrl: null }));
  const cleanup = registerReadingWebmcp(runtime, host);
  const cases: Array<[unknown, string]> = [
    [{ recommendations: [{ documentId: "a", reason: "x", basis: "metadata" }, { documentId: "a", reason: "y", basis: "metadata" }] }, "invalid"],
    [
      {
        recommendations: [
          { documentId: "a", reason: "x", basis: "metadata" },
          { documentId: "b", reason: "y", basis: "metadata" },
          { documentId: "c", reason: "z", basis: "metadata" },
        ],
      },
      "not-found",
    ],
    [{ recommendations: [] }, "invalid"],
    [{ recommendations: [{ documentId: "unsafe", reason: "r", basis: "metadata" }] }, "invalid"],
    [{ recommendations: [{ documentId: "a", reason: "r", basis: "mood" }] }, "invalid"],
    [{ mood: 5, recommendations: [{ documentId: "a", reason: "r", basis: "metadata" }] }, "invalid"],
  ];
  for (const [input, expected] of cases) {
    const result = await call(tools, "present_reading_recommendations", input);
    assert.equal(result.ok, false);
    assert.equal(result.error, expected);
  }
  assert.equal(panels.length, 0);
  cleanup();
});

test("oversized mood and reason are sanitized and bounded, not rejected", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, docs, panels } = fakeHost();
  docs.set("a", storedDoc("a"));
  const cleanup = registerReadingWebmcp(runtime, host);
  const result = await call(tools, "present_reading_recommendations", {
    mood: `${"m".repeat(120)}<b>bold</b>`,
    recommendations: [{ documentId: "a", reason: `${"r".repeat(300)}<script>alert(1)</script>`, basis: "metadata" }],
  });
  assert.equal(result.ok, true);
  const mood = panels[0]!.mood as string;
  assert.equal(mood.length, 80);
  assert.equal(mood.includes("<"), false);
  const reason = panels[0]!.recommendations[0]!.reason as string;
  assert.ok(reason.length <= 240);
  assert.equal(reason.includes("<"), false);
  assert.equal(reason.includes("script"), false);
  cleanup();
});

test("a second present replaces the previous panel", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, docs, panels } = fakeHost();
  docs.set("a", storedDoc("a"));
  docs.set("b", storedDoc("b"));
  const cleanup = registerReadingWebmcp(runtime, host);
  await call(tools, "present_reading_recommendations", {
    mood: "thoughtful",
    recommendations: [{ documentId: "a", reason: "first", basis: "stored_text" }],
  });
  await call(tools, "present_reading_recommendations", {
    mood: "thoughtful",
    recommendations: [{ documentId: "b", reason: "second", basis: "metadata" }],
  });
  assert.equal(panels.length, 2);
  assert.equal((panels[1]!.recommendations[0]!.documentId), "b");
  cleanup();
});

test("diagnostics log entries stay bounded and never carry text, notes, or payloads", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, docs, logs } = fakeHost();
  docs.set("a", storedDoc("a"));
  const cleanup = registerReadingWebmcp(runtime, host);
  await call(tools, "get_reading_context", {});
  await call(tools, "search_reading", { q: "agent query" });
  await call(tools, "get_reading", { documentId: "a" });
  await call(tools, "present_reading_recommendations", {
    recommendations: [{ documentId: "a", reason: "nice", basis: "stored_text" }],
  });
  await call(tools, "search_reading", { limit: 51 });
  await call(tools, "get_reading", { documentId: "missing" });
  assert.equal(logs.length, 6);
  for (const entry of logs) {
    assert.deepEqual(Object.keys(entry).sort(), ["durationMs", "outcome", "resultCount", "tool"]);
  }
  const outcomes = new Set(logs.map((entry) => entry.outcome));
  assert.deepEqual([...outcomes].sort(), ["invalid", "not-found", "ok"]);
  const serialized = JSON.stringify(logs);
  assert.equal(serialized.includes("SECRET-ARTICLE-TEXT"), false);
  assert.equal(serialized.includes("agent query"), false);
  assert.equal(serialized.includes("nice"), false);
  cleanup();
});

test("detectReadingWebmcpRuntime returns null without a usable modelContext", () => {
  assert.equal(detectReadingWebmcpRuntime({}), null);
  assert.equal(detectReadingWebmcpRuntime({ document: {} }), null);
  assert.equal(detectReadingWebmcpRuntime({ document: { modelContext: {} } }), null);
  const standard = detectReadingWebmcpRuntime({ document: { modelContext: { registerTool() {} } } });
  assert.ok(standard);
  assert.equal(detectReadingWebmcpRuntime({ navigator: {} }), null);
  assert.equal(detectReadingWebmcpRuntime({ navigator: { modelContext: { registerTool() {} } } }), null);
  assert.equal(detectReadingWebmcpRuntime({ navigator: { modelContext: { unregisterTool() {} } } }), null);
  const legacy = detectReadingWebmcpRuntime({ navigator: { modelContext: { registerTool() {}, unregisterTool() {} } } });
  assert.ok(legacy);
});

test("attachReadingWebmcp is a no-op without a runtime and registers with one", async () => {
  const { host, logs } = fakeHost();
  const noop = attachReadingWebmcp(host, {});
  noop();
  assert.equal(logs[0]?.tool, "register");
  assert.equal(logs[0]?.outcome, "unsupported");
  const { runtime, tools } = fakeRuntime();
  const globalObj = { document: { modelContext: runtime } };
  const cleanup = attachReadingWebmcp(host, globalObj);
  assert.equal(tools.size, 4);
  cleanup();
  assert.equal(tools.size, 0);
});
