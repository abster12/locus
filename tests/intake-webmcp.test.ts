import { test } from "node:test";
import assert from "node:assert/strict";
import {
  INTAKE_WEBMCP_VERSION,
  attachLibraryIntakeWebmcp,
  registerLibraryIntakeWebmcp,
  type IntakeWebmcpHost,
  type IntakeWebmcpPresentedDraft,
  type IntakeWebmcpRuntime,
} from "../app/src/library-intake-webmcp.ts";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (input: unknown) => unknown | Promise<unknown>;
};

const FOUR_TOOLS = ["create_items", "get_library_intake_context", "present_item_drafts", "search_library"];

function fakeRuntime() {
  const tools = new Map<string, RegisteredTool>();
  const runtime: IntakeWebmcpRuntime = {
    registerTool(tool, options) {
      tools.set(tool.name, tool);
      const remove = () => tools.delete(tool.name);
      if (options?.signal?.aborted) remove();
      else options?.signal?.addEventListener("abort", remove, { once: true });
    },
  };
  return { runtime, tools };
}

function sampleDraft(): IntakeWebmcpPresentedDraft {
  return {
    item: {
      url: "https://example.com/essay",
      title: "Essay",
      body: null,
      authorName: null,
      publishedAt: null,
      media: [],
    },
    missing: ["source text", "author", "publication date", "media"],
    collections: [{ id: "c1", name: "Research", description: "Deep reading" }],
    tags: [
      { id: "tag-tech", name: "tech", proposed: false },
      { id: null, name: "Local First", proposed: true },
    ],
    rationale: "About local-first software",
    evidenceBasis: "title",
    uncertainty: null,
  };
}

function fakeHost() {
  const panels: IntakeWebmcpPresentedDraft[][] = [];
  const searchCalls: Array<{ url?: string; q?: string }> = [];
  const prepareCalls: unknown[] = [];
  const createCalls: unknown[] = [];
  const logs: Array<Record<string, unknown>> = [];
  const host: IntakeWebmcpHost = {
    async getContext() {
      return {
        version: "abc",
        collections: [{ id: "c1", name: "Research", description: "Deep reading" }],
        tags: [{ id: "tag-tech", name: "tech", color: "#333", consequence: null }],
      };
    },
    async search(query) {
      searchCalls.push(query);
      return { items: [{ id: "item-1", title: "Local-first software", url: "https://example.com/essay", source: null }] };
    },
    async prepare(input) {
      prepareCalls.push(input);
      return [sampleDraft()];
    },
    present(drafts) {
      panels.push(drafts);
    },
    async create(input) {
      createCalls.push(input);
      return {
        actor: "agent",
        drafts: [{
          outcome: "created",
          item: {
            id: "item-1",
            title: "Essay",
            url: "https://example.com/essay",
            intakeActor: "agent",
            notes: [{ id: "n1", body: "SECRET-NOTE" }],
          },
          added: { tagIds: ["tag-tech"], collectionIds: ["c1"] },
          alreadyPresent: { tagIds: [], collectionIds: [] },
        }],
      };
    },
    log(entry) {
      logs.push({ ...entry });
    },
  };
  return { host, panels, searchCalls, prepareCalls, createCalls, logs };
}

async function call(tools: Map<string, RegisteredTool>, name: string, input?: unknown): Promise<Record<string, unknown>> {
  const tool = tools.get(name);
  assert.ok(tool, `missing tool ${name}`);
  return (await tool.execute(input)) as Record<string, unknown>;
}

test("registers exactly the four Intake tools with closed schemas and no identity fields", () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerLibraryIntakeWebmcp(runtime, host);
  assert.deepEqual([...tools.keys()].sort(), FOUR_TOOLS);
  for (const [name, tool] of tools) {
    assert.equal(tool.inputSchema.type, "object", name);
    assert.equal(tool.inputSchema.additionalProperties, false, name);
    const schema = JSON.stringify(tool.inputSchema);
    assert.equal(schema.includes("libraryId"), false, name);
    assert.equal(schema.includes("actor"), false, name);
    assert.ok(tool.description.length > 40, name);
  }
  assert.match(tools.get("present_item_drafts")!.description, /writes nothing/);
  assert.match(tools.get("create_items")!.description, /present_item_drafts/);
  assert.match(tools.get("search_library")!.description, /notes/);
  cleanup();
});

test("repeated registration stays idempotent and cleanup removes all four", () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup1 = registerLibraryIntakeWebmcp(runtime, host);
  const cleanup2 = registerLibraryIntakeWebmcp(runtime, host);
  assert.equal(tools.size, 4);
  cleanup2();
  assert.equal(tools.size, 0);
  cleanup1();
  assert.equal(tools.size, 0);
});

test("attach against a missing runtime is a no-op", () => {
  const { host } = fakeHost();
  const cleanup = attachLibraryIntakeWebmcp(host, {});
  cleanup();
});

test("get_library_intake_context returns vocabulary and versions without bodies", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerLibraryIntakeWebmcp(runtime, host);
  const result = await call(tools, "get_library_intake_context", {});
  assert.equal(result.ok, true);
  assert.equal(result.capabilityVersion, INTAKE_WEBMCP_VERSION);
  assert.equal(result.version, "abc");
  assert.equal(JSON.stringify(result).includes("SECRET"), false);
  cleanup();
});

test("search_library forwards bounded url/q and rejects extra fields", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, searchCalls } = fakeHost();
  const cleanup = registerLibraryIntakeWebmcp(runtime, host);
  const result = await call(tools, "search_library", { url: "https://example.com/essay", q: "local" });
  assert.equal(result.ok, true);
  assert.deepEqual(searchCalls, [{ url: "https://example.com/essay", q: "local" }]);
  const bad = await call(tools, "search_library", { q: "local", raw: "SELECT 1" });
  assert.deepEqual(bad, { ok: false, error: "invalid" });
  cleanup();
});

test("present_item_drafts prepares, renders, and does not claim persistence", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, panels, prepareCalls } = fakeHost();
  const cleanup = registerLibraryIntakeWebmcp(runtime, host);
  const result = await call(tools, "present_item_drafts", {
    drafts: [{ url: "https://example.com/essay", title: "Essay" }],
  });
  assert.equal(result.ok, true);
  assert.equal(result.persisted, false);
  assert.equal(panels.length, 1);
  assert.equal(panels[0]?.[0]?.tags.some((tag) => tag.proposed), true);
  assert.deepEqual(prepareCalls, [{ drafts: [{ url: "https://example.com/essay", title: "Essay" }] }]);
  const missing = await call(tools, "present_item_drafts", {});
  assert.deepEqual(missing, { ok: false, error: "invalid" });
  cleanup();
});

test("prepare 400 becomes invalid and skips present", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, panels } = fakeHost();
  host.prepare = async () => {
    throw Object.assign(new Error("unknown tag"), { status: 400 });
  };
  const cleanup = registerLibraryIntakeWebmcp(runtime, host);
  const result = await call(tools, "present_item_drafts", {
    drafts: [{ url: "https://example.com/x", tagIds: ["missing"] }],
  });
  assert.deepEqual(result, { ok: false, error: "invalid" });
  assert.equal(panels.length, 0);
  cleanup();
});

test("create_items forwards an exact batch and strips notes from the result", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, createCalls } = fakeHost();
  const cleanup = registerLibraryIntakeWebmcp(runtime, host);
  const payload = {
    clientMutationId: "m1",
    contextVersion: "abc",
    instruction: "save this URL to Research",
    drafts: [{
      url: "https://example.com/essay",
      title: "Essay",
      observedFields: ["title"],
      tagIds: ["tag-tech"],
      collectionIds: ["c1"],
      classifications: [{
        tagId: "tag-tech",
        rationale: "Requested tech classification",
        evidence: [{ field: "instruction", text: "save this URL to Research" }],
      }],
    }],
  };
  const result = await call(tools, "create_items", payload);
  assert.equal(result.ok, true);
  assert.equal(result.actor, "agent");
  assert.equal((result.drafts as { outcome: string }[])[0]?.outcome, "created");
  assert.equal(JSON.stringify(result).includes("SECRET-NOTE"), false);
  assert.deepEqual(createCalls, [payload]);
  const missing = await call(tools, "create_items", { drafts: payload.drafts });
  assert.deepEqual(missing, { ok: false, error: "invalid" });
  const extra = await call(tools, "create_items", { ...payload, actor: "user" });
  assert.deepEqual(extra, { ok: false, error: "invalid" });
  cleanup();
});

test("create_items maps stale context and invalid writes", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  host.create = async () => {
    throw Object.assign(new Error("stale context"), { status: 400 });
  };
  const cleanup = registerLibraryIntakeWebmcp(runtime, host);
  const stale = await call(tools, "create_items", {
    clientMutationId: "m2",
    contextVersion: "old",
    drafts: [{ url: "https://example.com/x" }],
  });
  assert.deepEqual(stale, { ok: false, error: "stale-context" });
  host.create = async () => {
    throw Object.assign(new Error("unknown tag"), { status: 400 });
  };
  const invalid = await call(tools, "create_items", {
    clientMutationId: "m3",
    contextVersion: "abc",
    drafts: [{ url: "https://example.com/x", tagIds: ["missing"] }],
  });
  assert.deepEqual(invalid, { ok: false, error: "invalid" });
  cleanup();
});
