import { test } from "node:test";
import assert from "node:assert/strict";
import {
  KITCHEN_RECIPE_WEBMCP_VERSION,
  attachKitchenRecipeWebmcp,
  registerKitchenRecipeWebmcp,
  type KitchenRecipeWebmcpHost,
  type KitchenRecipeWebmcpRuntime,
  type KitchenRecipeWebmcpSource,
} from "../app/src/kitchen-recipe-webmcp.ts";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

const TWO_TOOLS = ["get_recipe_source", "propose_recipe"];
const REVISION = "a".repeat(64);

function fakeRuntime() {
  const tools = new Map<string, RegisteredTool>();
  const runtime: KitchenRecipeWebmcpRuntime = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      const remove = () => tools.delete(tool.name);
      if (options?.signal?.aborted) remove();
      else options?.signal?.addEventListener("abort", remove, { once: true });
    },
  };
  return { runtime, tools };
}

function fakeHost(overrides: Partial<KitchenRecipeWebmcpHost> = {}) {
  const state = {
    visibleItemId: "food-1" as string | null,
    generationAllowed: false,
    sourceCalls: [] as string[],
    proposeCalls: [] as Array<{ itemId: string; input: { expectedSourceRevision: string; draft: unknown; allowGenerate: boolean } }>,
  };
  const source: KitchenRecipeWebmcpSource = {
    itemId: "food-1",
    displayTitle: "Paneer tikka",
    caption: "200 g paneer\nGrill it",
    sourceRevision: REVISION,
    availability: "caption",
    canWatch: true,
    recipe: null,
  };
  const host: KitchenRecipeWebmcpHost = {
    getVisibleItemId: () => state.visibleItemId,
    generationAllowed: () => state.generationAllowed,
    async getSource(itemId) {
      state.sourceCalls.push(itemId);
      return { ...source, itemId };
    },
    async propose(itemId, input) {
      state.proposeCalls.push({ itemId, input });
      return { document: { id: "doc-1", status: "draft", score: { placed: [], unreferenced: [], steps: [] } } };
    },
    ...overrides,
  };
  return { state, host, source };
}

async function call(tools: Map<string, RegisteredTool>, name: string, input?: unknown): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return (await tool.execute(input)) as Record<string, unknown>;
}

function statusError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

const captionDraft = {
  version: 1,
  ingredients: [
    {
      id: "ing-1",
      raw: "200 g paneer",
      name: "paneer",
      evidence: { kind: "caption", spans: [{ start: 0, end: 12, text: "200 g paneer" }] },
    },
  ],
  steps: [],
};

const generatedDraft = {
  version: 1,
  ingredients: [{ id: "ing-1", raw: "salt", name: "salt", evidence: { kind: "generated" } }],
  steps: [{ id: "step-1", instruction: "Cook.", ingredientIds: ["ing-1"], evidence: { kind: "generated" } }],
};

test("registers exactly the two Recipe Document tools with closed schemas and no identity fields", () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerKitchenRecipeWebmcp(runtime, host);
  assert.deepEqual([...tools.keys()].sort(), TWO_TOOLS);
  for (const [name, tool] of tools) {
    assert.equal(tool.inputSchema.type, "object", name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    const schema = JSON.stringify(tool.inputSchema);
    assert.equal(schema.includes("libraryId"), false, name);
    assert.equal(schema.includes("actor"), false, name);
    assert.ok(tool.description.length > 40, name);
  }
  assert.match(tools.get("get_recipe_source")!.description, /never fetches the publisher page/);
  assert.match(tools.get("get_recipe_source")!.description, /never watches inaccessible media/);
  assert.match(tools.get("propose_recipe")!.description, /only the human can mark it Reviewed/);
  assert.equal(tools.get("get_recipe_source")!.annotations?.readOnlyHint, true);
  assert.equal(tools.get("propose_recipe")!.annotations?.readOnlyHint, false);
  cleanup();
});

test("re-registration replaces the set and cleanup removes both", () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup1 = registerKitchenRecipeWebmcp(runtime, host);
  const cleanup2 = registerKitchenRecipeWebmcp(runtime, host);
  assert.equal(tools.size, 2);
  cleanup2();
  assert.equal(tools.size, 0);
  cleanup1();
  assert.equal(tools.size, 0);
});

test("get_recipe_source binds to the visible Item and rebinds live without re-registering", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host, source } = fakeHost();
  const cleanup = registerKitchenRecipeWebmcp(runtime, host);
  const first = await call(tools, "get_recipe_source");
  assert.equal(first.ok, true);
  assert.equal(first.itemId, "food-1");
  assert.deepEqual(state.sourceCalls, ["food-1"]);
  assert.equal(first.recipe, null);

  state.visibleItemId = "food-2";
  const second = await call(tools, "get_recipe_source");
  assert.equal(second.ok, true);
  assert.equal(second.itemId, "food-2");
  assert.deepEqual(state.sourceCalls, ["food-1", "food-2"]);

  state.visibleItemId = null;
  const missing = await call(tools, "get_recipe_source");
  assert.deepEqual(missing, { ok: false, error: "not-found" });
  assert.deepEqual(state.sourceCalls, ["food-1", "food-2"]);

  const unresolvable = fakeHost({ getSource: async () => null });
  registerKitchenRecipeWebmcp(runtime, unresolvable.host);
  assert.deepEqual(await call(tools, "get_recipe_source"), { ok: false, error: "not-found" });
  assert.equal(unresolvable.state.visibleItemId, "food-1");
  void source;
  cleanup();
});

test("get_recipe_source returns the bounded source shape only", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, source } = fakeHost({
    getSource: async () => ({ ...source, recipe: {
      id: "doc-1",
      status: "draft",
      provenance: "caption",
      sourceChanged: false,
      title: "Paneer tikka",
      servings: "2",
      totalTime: "30 min",
      draft: { version: 1, ingredients: [], steps: [] },
      score: { placed: [], unreferenced: [], steps: [] },
    } }),
  });
  const cleanup = registerKitchenRecipeWebmcp(runtime, host);
  const result = await call(tools, "get_recipe_source");
  assert.deepEqual(Object.keys(result).sort(), [
    "availability",
    "canWatch",
    "capabilityVersion",
    "caption",
    "displayTitle",
    "itemId",
    "ok",
    "recipe",
    "sourceRevision",
  ]);
  assert.equal(result.caption, "200 g paneer\nGrill it");
  assert.equal(result.sourceRevision, REVISION);
  assert.equal(result.capabilityVersion, KITCHEN_RECIPE_WEBMCP_VERSION);
  const recipe = result.recipe as Record<string, unknown>;
  assert.deepEqual(Object.keys(recipe).sort(), [
    "draft",
    "id",
    "provenance",
    "score",
    "servings",
    "sourceChanged",
    "status",
    "title",
    "totalTime",
  ]);
  cleanup();
});

test("propose_recipe sends a caption draft without generation consent", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  state.generationAllowed = true; // consent present, but the draft cites caption evidence
  const cleanup = registerKitchenRecipeWebmcp(runtime, host);
  const result = await call(tools, "propose_recipe", { expectedSourceRevision: REVISION, draft: captionDraft });
  assert.equal(result.ok, true);
  assert.equal(state.proposeCalls.length, 1);
  assert.equal(state.proposeCalls[0]?.itemId, "food-1");
  assert.deepEqual(state.proposeCalls[0]?.input, { expectedSourceRevision: REVISION, draft: captionDraft, allowGenerate: false });
  assert.equal((result.document as { id?: string }).id, "doc-1");
  cleanup();
});

test("propose_recipe rejects user evidence and mixed provenance before calling the host", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  state.generationAllowed = true;
  const cleanup = registerKitchenRecipeWebmcp(runtime, host);
  const userDraft = {
    version: 1,
    ingredients: [{ id: "ing-1", raw: "x", name: "x", evidence: { kind: "user" } }],
    steps: [],
  };
  assert.deepEqual(await call(tools, "propose_recipe", { expectedSourceRevision: REVISION, draft: userDraft }), { ok: false, error: "invalid" });
  const mixed = { version: 1, ingredients: captionDraft.ingredients, steps: generatedDraft.steps };
  assert.deepEqual(await call(tools, "propose_recipe", { expectedSourceRevision: REVISION, draft: mixed }), { ok: false, error: "invalid" });
  assert.equal(state.proposeCalls.length, 0);
  cleanup();
});

test("propose_recipe rejects status, actor, library, item, and unknown input keys", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  const cleanup = registerKitchenRecipeWebmcp(runtime, host);
  for (const extra of [
    { status: "reviewed" },
    { actor: "user" },
    { libraryId: "local" },
    { itemId: "food-1" },
    { extra: 1 },
  ]) {
    const result = await call(tools, "propose_recipe", { expectedSourceRevision: REVISION, draft: captionDraft, ...extra });
    assert.deepEqual(result, { ok: false, error: "invalid" }, JSON.stringify(extra));
  }
  assert.equal(state.proposeCalls.length, 0);
  cleanup();
});

test("propose_recipe gates generated evidence behind explicit consent", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  const cleanup = registerKitchenRecipeWebmcp(runtime, host);
  const denied = await call(tools, "propose_recipe", { expectedSourceRevision: REVISION, draft: generatedDraft });
  assert.deepEqual(denied, { ok: false, error: "forbidden" });
  assert.equal(state.proposeCalls.length, 0);

  state.generationAllowed = true;
  const allowed = await call(tools, "propose_recipe", { expectedSourceRevision: REVISION, draft: generatedDraft });
  assert.equal(allowed.ok, true);
  assert.equal(state.proposeCalls.length, 1);
  assert.equal(state.proposeCalls[0]?.input.allowGenerate, true);
  cleanup();
});

test("propose_recipe validates revision and draft shape", async () => {
  const { runtime, tools } = fakeRuntime();
  const { state, host } = fakeHost();
  const cleanup = registerKitchenRecipeWebmcp(runtime, host);
  for (const input of [
    {},
    { expectedSourceRevision: "deadbeef", draft: captionDraft },
    { expectedSourceRevision: "A".repeat(64), draft: captionDraft },
    { expectedSourceRevision: REVISION, draft: null },
    { expectedSourceRevision: REVISION, draft: "draft" },
    { expectedSourceRevision: REVISION, draft: [captionDraft] },
  ]) {
    const result = await call(tools, "propose_recipe", input);
    assert.deepEqual(result, { ok: false, error: "invalid" }, JSON.stringify(input));
  }
  assert.equal(state.proposeCalls.length, 0);
  cleanup();
});

test("host failures map to stable errors", async () => {
  const { runtime, tools } = fakeRuntime();
  const statuses: number[] = [400, 403, 404, 409];
  const cleanup = registerKitchenRecipeWebmcp(runtime, fakeHost({
    propose: async () => {
      throw statusError(statuses.shift() ?? 400);
    },
  }).host);
  const expected = ["invalid", "forbidden", "not-found", "stale"];
  for (const outcome of expected) {
    const result = await call(tools, "propose_recipe", { expectedSourceRevision: REVISION, draft: captionDraft });
    assert.deepEqual(result, { ok: false, error: outcome });
  }

  const failing = fakeHost({ getSource: async () => { throw new Error("boom"); } });
  registerKitchenRecipeWebmcp(runtime, failing.host);
  assert.deepEqual(await call(tools, "get_recipe_source"), { ok: false, error: "unavailable" });
  cleanup();
});

test("attach without a WebMCP runtime is a no-op cleanup", () => {
  const { host } = fakeHost();
  const cleanup = attachKitchenRecipeWebmcp(host, {});
  cleanup();
});
