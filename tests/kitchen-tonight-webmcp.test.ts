import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KITCHEN_TONIGHT_WEBMCP_VERSION,
  attachKitchenTonightWebmcp,
  registerKitchenTonightWebmcp,
  type KitchenTonightWebmcpEntry,
  type KitchenTonightWebmcpHost,
  type KitchenTonightWebmcpRuntime,
} from "../app/src/kitchen-tonight-webmcp.ts";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

const THREE_TOOLS = ["apply_tonight_changes", "get_tonight", "search_food_items"];

function fakeRuntime() {
  const tools = new Map<string, RegisteredTool>();
  const runtime: KitchenTonightWebmcpRuntime = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      const remove = () => tools.delete(tool.name);
      if (options?.signal?.aborted) remove();
      else options?.signal?.addEventListener("abort", remove, { once: true });
    },
  };
  return { runtime, tools };
}

function fakeHost(overrides: Partial<KitchenTonightWebmcpHost> = {}) {
  const state = {
    filters: { q: "", source: "" } as { q: string; source: string },
    tonight: {
      revision: 3,
      entries: [
        { id: "entry-1", itemId: "food-1", order: 0, item: { itemId: "food-1", displayTitle: "Paneer tikka", availability: "reviewed", recipe: { id: "doc-1", status: "reviewed", title: "Paneer tikka" } } },
        { id: "entry-2", itemId: "gone", order: 1, item: null },
      ] as KitchenTonightWebmcpEntry[],
    },
    searchCalls: [] as Array<{ q?: string; source?: string; cursor?: string; limit?: number }>,
    applyCalls: [] as Array<{ expectedRevision: number; clientMutationId: string; instruction?: string | null; operations: unknown[] }>,
  };
  const host: KitchenTonightWebmcpHost = {
    getPageFilters: () => ({ ...state.filters }),
    async getTonight() {
      return { revision: state.tonight.revision, entries: state.tonight.entries.map((entry) => ({ ...entry })) };
    },
    async search(query) {
      state.searchCalls.push(query);
      return {
        items: [{ itemId: "food-1", displayTitle: "Paneer tikka", availability: "caption", recipe: null }],
        nextCursor: null,
      };
    },
    async apply(input) {
      state.applyCalls.push(input);
      return { revision: input.expectedRevision + 1, entries: [], replayed: false };
    },
    ...overrides,
  };
  return { state, host };
}

async function call(tools: Map<string, RegisteredTool>, name: string, input?: unknown): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return (await tool.execute(input)) as Record<string, unknown>;
}

function statusError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

test("registers exactly the three Tonight tools with closed schemas and no identity fields", () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  assert.deepEqual([...tools.keys()].sort(), THREE_TOOLS);
  for (const [name, tool] of tools) {
    assert.equal(tool.inputSchema.type, "object", name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    const schema = JSON.stringify(tool.inputSchema);
    assert.equal(schema.includes("libraryId"), false, name);
    assert.equal(schema.includes("actor"), false, name);
    assert.equal(schema.includes("nutrition"), false, name);
    assert.ok(tool.description.length > 40, name);
  }
  assert.equal(tools.get("get_tonight")!.annotations?.readOnlyHint, true);
  assert.equal(tools.get("search_food_items")!.annotations?.readOnlyHint, true);
  assert.equal(tools.get("apply_tonight_changes")!.annotations?.readOnlyHint, false);
  cleanup();
});

test("apply and search descriptions demand explicit user intent and bound the surface", () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  const apply = tools.get("apply_tonight_changes")!.description;
  assert.match(apply, /only after the user explicitly asks/);
  assert.match(apply, /opening Kitchen or changing filters never applies/);
  assert.match(apply, /atomically/i);
  assert.match(apply, /retry the same id|clientMutationId/i);
  assert.match(apply, /cannot edit Recipe Documents, tags, captions/);
  assert.match(apply, /cannot invent nutrition/);
  assert.match(apply, /Missing Items already on Tonight stay until the user explicitly removes them/);
  const search = tools.get("search_food_items")!.description;
  assert.match(search, /explicitly asks/);
  assert.match(search, /never arbitrary saved Items, outside restaurants, tags, or nutrition/);
  const read = tools.get("get_tonight")!.description;
  assert.match(read, /never changes Tonight/);
  cleanup();
});

test("re-registration replaces the set and cleanup removes all three", () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup1 = registerKitchenTonightWebmcp(runtime, host);
  const cleanup2 = registerKitchenTonightWebmcp(runtime, host);
  assert.equal(tools.size, 3);
  cleanup2();
  assert.equal(tools.size, 0);
  cleanup1();
  assert.equal(tools.size, 0);
});

test("get_tonight returns the revision and honest missing-Item entries", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  const result = await call(tools, "get_tonight");
  assert.equal(result.ok, true);
  assert.equal(result.revision, 3);
  assert.equal(result.capabilityVersion, KITCHEN_TONIGHT_WEBMCP_VERSION);
  const entries = result.entries as Array<Record<string, unknown>>;
  assert.equal(entries.length, 2);
  assert.equal(entries[1]?.item, null, "missing Item stays null, no invented title");
  const present = entries[0]?.item as Record<string, unknown>;
  assert.deepEqual(Object.keys(present).sort(), ["availability", "displayTitle", "itemId", "recipe"]);
  assert.equal((present.recipe as Record<string, unknown>).status, "reviewed");
  cleanup();
});

test("get_tonight and apply never stringify missing recipe titles or leak captions", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost({
    async getTonight() {
      return {
        revision: 1,
        entries: [{
          id: "entry-1",
          itemId: "food-1",
          order: 0,
          item: {
            itemId: "food-1",
            displayTitle: "Paneer",
            availability: "draft",
            recipe: { id: "doc-1", status: "draft", title: undefined as unknown as string },
          },
        }],
      };
    },
    async apply() {
      return {
        revision: 2,
        replayed: false,
        entries: [{
          id: "entry-1",
          itemId: "food-1",
          order: 0,
          item: {
            itemId: "food-1",
            displayTitle: "Paneer",
            availability: "draft",
            recipe: { id: "doc-1", status: "draft", title: undefined as unknown as string },
            caption: "SECRET",
            notes: ["secret"],
          } as KitchenTonightWebmcpEntry["item"],
        }],
      };
    },
  });
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  const read = await call(tools, "get_tonight");
  const readItem = (read.entries as Array<{ item: { recipe: { title: unknown } } }>)[0]?.item;
  assert.equal(readItem?.recipe.title, null);
  const applied = await call(tools, "apply_tonight_changes", {
    expectedRevision: 1,
    clientMutationId: "mut-1",
    operations: [{ op: "add", itemId: "food-1" }],
  });
  const appliedItem = (applied.entries as Array<{ item: Record<string, unknown> }>)[0]?.item;
  assert.deepEqual(Object.keys(appliedItem ?? {}).sort(), ["availability", "displayTitle", "itemId", "recipe"]);
  assert.equal((appliedItem?.recipe as { title: unknown }).title, null);
  assert.equal(appliedItem?.caption, undefined);
  cleanup();
});

test("search defaults omitted q/source to the live page filters", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  state.filters = { q: "paneer", source: "instagram" };
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  await call(tools, "search_food_items", {});
  assert.deepEqual(state.searchCalls, [{ q: "paneer", source: "instagram", limit: 50 }]);

  state.searchCalls.length = 0;
  await call(tools, "search_food_items", { q: "tofu", source: "youtube", cursor: "abc123", limit: 100 });
  assert.deepEqual(state.searchCalls, [{ q: "tofu", source: "youtube", cursor: "abc123", limit: 100 }]);

  state.searchCalls.length = 0;
  await call(tools, "search_food_items", { q: null, source: null, limit: 1 });
  assert.deepEqual(state.searchCalls, [{ q: "paneer", source: "instagram", limit: 1 }]);
  cleanup();
});

test("search rejects unknown keys, oversized input, and bad cursor/limit shapes", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  for (const input of [
    { tags: "vegan" },
    { restaurant: " вблизи" },
    { nutrition: true },
    { shelf: "food" },
    { extra: 1 },
    { q: "x".repeat(201) },
    { source: "bad source" },
    { cursor: "not base64url!" },
    { limit: 0 },
    { limit: 101 },
    { limit: 1.5 },
  ]) {
    const result = await call(tools, "search_food_items", input);
    assert.deepEqual(result, { ok: false, error: "invalid" }, JSON.stringify(input));
  }
  assert.equal(state.searchCalls.length, 0);
  cleanup();
});

test("apply forwards add, remove, and reorder with the parsed envelope", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  const result = await call(tools, "apply_tonight_changes", {
    expectedRevision: 3,
    clientMutationId: "mut-1",
    instruction: "add paneer and put it first",
    operations: [
      { op: "add", itemId: "food-1" },
      { op: "remove", itemId: "gone" },
      { op: "reorder", itemIds: ["food-1", "food-2"] },
    ],
  });
  assert.equal(result.ok, true);
  assert.equal(result.replayed, false);
  assert.deepEqual(state.applyCalls, [{
    expectedRevision: 3,
    clientMutationId: "mut-1",
    instruction: "add paneer and put it first",
    operations: [
      { op: "add", itemId: "food-1" },
      { op: "remove", itemId: "gone" },
      { op: "reorder", itemIds: ["food-1", "food-2"] },
    ],
  }]);

  state.applyCalls.length = 0;
  await call(tools, "apply_tonight_changes", { expectedRevision: 4, clientMutationId: "mut-2", operations: [{ op: "add", itemId: "food-1" }] });
  assert.equal(state.applyCalls[0]?.instruction, null, "omitted instruction forwards null");
  cleanup();
});

test("apply rejects empty operations, unknown ops, unknown fields, and bad ids", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  const base = { expectedRevision: 3, clientMutationId: "mut-1" };
  for (const input of [
    { ...base, operations: [] },
    { ...base, operations: [{ op: "clear" }] },
    { ...base, operations: [{ op: "update", itemId: "food-1", status: "archived" }] },
    { ...base, operations: [{ op: "add", itemId: "food-1", status: "reviewed" }] },
    { ...base, operations: [{ op: "add", itemId: "food-1", tags: ["food"] }] },
    { ...base, operations: [{ op: "add", itemId: "food-1" }, { op: "add", itemId: "food-1" }], extra: true },
    { ...base, operations: [{ op: "add", itemId: "" }] },
    { ...base, operations: [{ op: "add", itemId: "bad id!" }] },
    { ...base, operations: [{ op: "add", itemId: "x".repeat(129) }] },
    { ...base, operations: [{ op: "reorder", itemIds: "food-1" }] },
    { ...base, operations: [{ op: "remove" }] },
    { ...base, operations: [{ op: "remove", itemId: "food-1", recipe: { version: 1 } }] },
    { expectedRevision: 0, clientMutationId: "mut-1", operations: [{ op: "add", itemId: "food-1" }] },
    { expectedRevision: 1.5, clientMutationId: "mut-1", operations: [{ op: "add", itemId: "food-1" }] },
    { expectedRevision: 3, clientMutationId: "", operations: [{ op: "add", itemId: "food-1" }] },
    { expectedRevision: 3, clientMutationId: "x".repeat(101), operations: [{ op: "add", itemId: "food-1" }] },
    { expectedRevision: 3, clientMutationId: "mut-1", instruction: "x".repeat(2001), operations: [{ op: "add", itemId: "food-1" }] },
    { expectedRevision: 3, clientMutationId: "mut-1", operations: [{ op: "add", itemId: "food-1" }], recipe: {} },
    { expectedRevision: 3, clientMutationId: "mut-1", operations: [{ op: "add", itemId: "food-1" }], status: "reviewed" },
    { expectedRevision: 3, clientMutationId: "mut-1", operations: [{ op: "add", itemId: "food-1" }], actor: "user" },
  ]) {
    const result = await call(tools, "apply_tonight_changes", input);
    assert.deepEqual(result, { ok: false, error: "invalid" }, JSON.stringify(input));
  }
  assert.equal(state.applyCalls.length, 0);
  cleanup();
});

test("apply cannot reach Recipe Documents, review state, or nutrition through operations", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  const cleanup = registerKitchenTonightWebmcp(runtime, host);
  // The only writable surface is Tonight membership/order: every operation is
  // one of add/remove/reorder, and no input key can name a recipe, evidence,
  // review status, source revision, or nutrition field.
  const schema = JSON.stringify(tools.get("apply_tonight_changes")!.inputSchema);
  for (const forbidden of ["recipe", "evidence", "reviewed", "sourceRevision", "provenance", "nutrition", "calories"]) {
    assert.equal(schema.includes(forbidden), false, forbidden);
  }
  const operationsSchema = JSON.stringify((tools.get("apply_tonight_changes")!.inputSchema.properties as Record<string, Record<string, unknown>>).operations);
  for (const allowed of ["\"add\"", "\"remove\"", "\"reorder\""]) {
    assert.match(operationsSchema, new RegExp(allowed));
  }
  // A reorder is the only shape carrying itemIds; nothing else is accepted.
  const result = await call(tools, "apply_tonight_changes", {
    expectedRevision: 1,
    clientMutationId: "mut-recipe",
    operations: [{ op: "reorder", itemIds: ["food-1"] }],
  });
  assert.equal(result.ok, true);
  assert.deepEqual(state.applyCalls[0]?.operations, [{ op: "reorder", itemIds: ["food-1"] }]);
  cleanup();
});

test("host failures map to stable errors including stale on 409", async () => {
  const { runtime, tools } = fakeRuntime();
  const statuses: number[] = [400, 403, 404, 409];
  const cleanup = registerKitchenTonightWebmcp(runtime, fakeHost({
    apply: async () => {
      throw statusError(statuses.shift() ?? 400);
    },
  }).host);
  const expected = ["invalid", "forbidden", "not-found", "stale"];
  for (const outcome of expected) {
    const result = await call(tools, "apply_tonight_changes", {
      expectedRevision: 1,
      clientMutationId: `mut-${outcome}`,
      operations: [{ op: "add", itemId: "food-1" }],
    });
    assert.deepEqual(result, { ok: false, error: outcome });
  }

  const failing = fakeHost({ getTonight: async () => { throw new Error("boom"); } });
  registerKitchenTonightWebmcp(runtime, failing.host);
  assert.deepEqual(await call(tools, "get_tonight"), { ok: false, error: "unavailable" });

  const searchBoom = fakeHost({ search: async () => { throw new Error("boom"); } });
  registerKitchenTonightWebmcp(runtime, searchBoom.host);
  assert.deepEqual(await call(tools, "search_food_items"), { ok: false, error: "unavailable" });
  cleanup();
});

test("attach without a WebMCP runtime is a no-op cleanup", () => {
  const { host } = fakeHost();
  const cleanup = attachKitchenTonightWebmcp(host, {});
  cleanup();
});
