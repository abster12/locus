// Page-defined WebMCP adapter for the Kitchen index page (Recipe Box + Tonight).
//
// Registers exactly three bounded tools while the Kitchen index is visible and
// removes them on unmount or route change, so the agent's capabilities always
// match the visible page. Library identity and the actor never travel through
// tool input: the trusted session resolves the Library and the server derives
// the agent identity. Search is Recipe Box only (the Food predicate lives
// server-side); there is no way to reach arbitrary Items, restaurants, or
// nutrition from here. No React, no MCP SDK, no api.ts import — host errors
// are duck-typed by status so tests run in plain Node.

export const KITCHEN_TONIGHT_WEBMCP_VERSION = 1;

export type KitchenTonightWebmcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

export type KitchenTonightWebmcpRuntime = {
  registerTool(tool: KitchenTonightWebmcpTool, options?: { signal?: AbortSignal }): void | Promise<void>;
};

export type KitchenTonightWebmcpRecipeSummary = {
  id: string;
  status: string;
  title: string | null;
};

export type KitchenTonightWebmcpItemSummary = {
  itemId: string;
  displayTitle: string;
  availability: string;
  recipe: KitchenTonightWebmcpRecipeSummary | null;
};

export type KitchenTonightWebmcpEntry = {
  id: string;
  itemId: string;
  order: number;
  /** Missing Item (deleted from the Library): still listed, never invented. */
  item: KitchenTonightWebmcpItemSummary | null;
};

export type KitchenTonightWebmcpHost = {
  /** Live page filters; omitted tool inputs default to these like Reading. */
  getPageFilters: () => { q: string; source: string };
  getTonight: () => Promise<{
    revision: number;
    entries: KitchenTonightWebmcpEntry[];
  }>;
  /** Recipe Box search only: the Food predicate and visibility rules stay in the Kitchen module. */
  search: (query: { q?: string; source?: string; cursor?: string; limit?: number }) => Promise<{
    items: KitchenTonightWebmcpItemSummary[];
    nextCursor: string | null;
  }>;
  apply: (input: {
    expectedRevision: number;
    clientMutationId: string;
    instruction?: string | null;
    operations: unknown[];
  }) => Promise<{ revision: number; entries: unknown[]; replayed: boolean }>;
  log?: (entry: { tool: string; outcome: string; durationMs: number; resultCount?: number }) => void;
};

export type KitchenTonightWebmcpError = "invalid" | "not-found" | "forbidden" | "stale" | "unavailable";
export type KitchenTonightWebmcpToolResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: KitchenTonightWebmcpError };

const TOOL_NAMES = ["apply_tonight_changes", "get_tonight", "search_food_items"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const SEARCH_LIMIT_DEFAULT = 50;
const SEARCH_LIMIT_MAX = 100;
const MAX_OPERATIONS = 200;
const MAX_ITEM_IDS = 100; // matches MAX_TONIGHT_ENTRIES in the Kitchen module

class ToolInvalidError extends Error {}

function invalidInput(): never {
  throw new ToolInvalidError();
}

// Bounded plain text for the agent-authored instruction: strip angle-bracket
// markup and all control/format characters (including zero-width and bidi
// overrides, which must never reach page-rendered text), then trim and slice.
function sanitizeBounded(raw: string, max: number): string {
  return raw
    .replace(/[<>]/g, "")
    .replace(/\p{C}/gu, "")
    .trim()
    .slice(0, max);
}

function optionalRecord(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) invalidInput();
  return input as Record<string, unknown>;
}

function pickOptionalString(value: unknown, max: number, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || value.length > max) invalidInput();
  return value;
}

function pickSource(value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !/^[a-z][a-z0-9_-]{0,39}$/i.test(value)) invalidInput();
  return value;
}

// Kitchen cursors are base64url JSON from the same pagination seam as Reading.
function pickCursor(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) invalidInput();
  return value;
}

function pickLimit(value: unknown): number {
  if (value === undefined || value === null) return SEARCH_LIMIT_DEFAULT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > SEARCH_LIMIT_MAX) invalidInput();
  return value;
}

const ITEM_ID = /^[A-Za-z0-9._:-]{1,128}$/;

function pickItemId(value: unknown): string {
  if (typeof value !== "string" || !ITEM_ID.test(value)) invalidInput();
  return value;
}

const GET_TONIGHT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string", maxLength: 200 },
    source: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,39}$", maxLength: 40 },
    cursor: { type: "string", pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 1024 },
    limit: { type: "integer", minimum: 1, maximum: SEARCH_LIMIT_MAX },
  },
  additionalProperties: false,
};

const APPLY_SCHEMA = {
  type: "object",
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    clientMutationId: { type: "string", minLength: 1, maxLength: 100 },
    instruction: { type: "string", maxLength: 2000 },
    operations: {
      type: "array",
      minItems: 1,
      maxItems: MAX_OPERATIONS,
      items: {
        type: "object",
        oneOf: [
          {
            properties: {
              op: { type: "string", enum: ["add"] },
              itemId: { type: "string", pattern: ITEM_ID.source, minLength: 1, maxLength: 128 },
            },
            required: ["op", "itemId"],
            additionalProperties: false,
          },
          {
            properties: {
              op: { type: "string", enum: ["remove"] },
              itemId: { type: "string", pattern: ITEM_ID.source, minLength: 1, maxLength: 128 },
            },
            required: ["op", "itemId"],
            additionalProperties: false,
          },
          {
            properties: {
              op: { type: "string", enum: ["reorder"] },
              itemIds: {
                type: "array",
                maxItems: MAX_ITEM_IDS,
                items: { type: "string", pattern: ITEM_ID.source, minLength: 1, maxLength: 128 },
              },
            },
            required: ["op", "itemIds"],
            additionalProperties: false,
          },
        ],
      },
    },
  },
  required: ["expectedRevision", "clientMutationId", "operations"],
  additionalProperties: false,
};

type TonightOp = { op: "add"; itemId: string } | { op: "remove"; itemId: string } | { op: "reorder"; itemIds: string[] };

function pickOperation(raw: unknown): TonightOp {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidInput();
  const rec = raw as Record<string, unknown>;
  if (rec.op === "add" || rec.op === "remove") {
    for (const key of Object.keys(rec)) {
      if (key !== "op" && key !== "itemId") invalidInput();
    }
    return { op: rec.op, itemId: pickItemId(rec.itemId) };
  }
  if (rec.op === "reorder") {
    for (const key of Object.keys(rec)) {
      if (key !== "op" && key !== "itemIds") invalidInput();
    }
    if (!Array.isArray(rec.itemIds)) invalidInput();
    return { op: "reorder", itemIds: rec.itemIds.map(pickItemId) };
  }
  invalidInput();
}

function pickApplyInput(input: unknown): {
  expectedRevision: number;
  clientMutationId: string;
  instruction: string | null;
  operations: TonightOp[];
} {
  const rec = optionalRecord(input);
  for (const key of Object.keys(rec)) {
    if (key !== "expectedRevision" && key !== "clientMutationId" && key !== "instruction" && key !== "operations") invalidInput();
  }
  const expectedRevision = rec.expectedRevision;
  if (typeof expectedRevision !== "number" || !Number.isInteger(expectedRevision) || expectedRevision < 1) invalidInput();
  const clientMutationId = rec.clientMutationId;
  if (typeof clientMutationId !== "string" || clientMutationId.length < 1 || clientMutationId.length > 100) invalidInput();
  let instruction: string | null = null;
  if (rec.instruction !== undefined && rec.instruction !== null) {
    if (typeof rec.instruction !== "string" || rec.instruction.length > 2000) invalidInput();
    instruction = sanitizeBounded(rec.instruction, 2000) || null;
  }
  if (!Array.isArray(rec.operations) || rec.operations.length < 1 || rec.operations.length > MAX_OPERATIONS) invalidInput();
  return { expectedRevision, clientMutationId, instruction, operations: rec.operations.map(pickOperation) };
}

// Defensive projection: the adapter returns only the bounded summary fields,
// even if the host shape drifts.
function projectItem(item: KitchenTonightWebmcpItemSummary | null): KitchenTonightWebmcpItemSummary | null {
  if (!item) return null;
  return {
    itemId: String(item.itemId),
    displayTitle: String(item.displayTitle),
    availability: String(item.availability),
    recipe: item.recipe
      ? {
          id: String(item.recipe.id),
          status: String(item.recipe.status),
          title: typeof item.recipe.title === "string" ? item.recipe.title : null,
        }
      : null,
  };
}

type HandlerOut = { result: KitchenTonightWebmcpToolResult; count: number };

async function getTonightHandler(host: KitchenTonightWebmcpHost): Promise<HandlerOut> {
  const view = await host.getTonight();
  const entries = view.entries.map((entry) => ({
    id: String(entry.id),
    itemId: String(entry.itemId),
    order: Number(entry.order),
    item: projectItem(entry.item),
  }));
  return {
    result: {
      ok: true,
      capabilityVersion: KITCHEN_TONIGHT_WEBMCP_VERSION,
      revision: Number(view.revision),
      entries,
    },
    count: entries.length,
  };
}

async function searchHandler(host: KitchenTonightWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  for (const key of Object.keys(rec)) {
    if (key !== "q" && key !== "source" && key !== "cursor" && key !== "limit") invalidInput();
  }
  // Defaults come from the live page filters at call time; explicit input
  // only narrows or pages the same Recipe Box query the human sees.
  const filters = host.getPageFilters();
  const q = pickOptionalString(rec.q, 200, filters.q);
  const source = pickSource(rec.source, filters.source);
  const cursor = pickCursor(rec.cursor);
  const limit = pickLimit(rec.limit);
  const out = await host.search({ q, source, ...(cursor !== undefined ? { cursor } : {}), limit });
  const items = out.items.map(projectItem) as KitchenTonightWebmcpItemSummary[];
  return {
    result: {
      ok: true,
      capabilityVersion: KITCHEN_TONIGHT_WEBMCP_VERSION,
      items,
      nextCursor: out.nextCursor === null ? null : String(out.nextCursor),
    },
    count: items.length,
  };
}

async function applyHandler(host: KitchenTonightWebmcpHost, input: unknown): Promise<HandlerOut> {
  const parsed = pickApplyInput(input);
  const out = await host.apply({
    expectedRevision: parsed.expectedRevision,
    clientMutationId: parsed.clientMutationId,
    instruction: parsed.instruction,
    operations: parsed.operations,
  });
  const entries = (Array.isArray(out.entries) ? out.entries : []).map((entry) => {
    const row = entry as KitchenTonightWebmcpEntry;
    return {
      id: String(row.id),
      itemId: String(row.itemId),
      order: Number(row.order),
      item: projectItem(row.item ?? null),
    };
  });
  return {
    result: {
      ok: true,
      capabilityVersion: KITCHEN_TONIGHT_WEBMCP_VERSION,
      revision: Number(out.revision),
      entries,
      replayed: Boolean(out.replayed),
    },
    count: entries.length,
  };
}

// One diagnostics wrapper for every tool: bounded log entry only — never
// instruction text or item payloads — and a stable outcome even when the host
// rejects or throws. Host errors thrown by the HTTP layer carry a duck-typed
// status; 400 means the agent can fix the request, 409 means a stale Tonight
// revision worth retrying after a fresh get_tonight.
function wrapTool(
  host: KitchenTonightWebmcpHost,
  name: ToolName,
  handler: (input: unknown) => Promise<HandlerOut>,
): (input: unknown) => Promise<KitchenTonightWebmcpToolResult> {
  return async (input: unknown) => {
    const startedAt = Date.now();
    let outcome: KitchenTonightWebmcpError | "ok" = "ok";
    let resultCount = 0;
    try {
      const out = await handler(input);
      resultCount = out.count;
      if (!out.result.ok) outcome = out.result.error;
      return out.result;
    } catch (error) {
      const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
      outcome =
        error instanceof ToolInvalidError || status === 400
          ? "invalid"
          : status === 404
            ? "not-found"
            : status === 403
              ? "forbidden"
              : status === 409
                ? "stale"
                : "unavailable";
      return { ok: false, error: outcome };
    } finally {
      try {
        host.log?.({ tool: name, outcome, durationMs: Date.now() - startedAt, resultCount });
      } catch {
        // Diagnostics must never break Kitchen.
      }
    }
  };
}

function buildTools(host: KitchenTonightWebmcpHost): Array<{
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => Promise<KitchenTonightWebmcpToolResult>;
}> {
  return [
    {
      name: "get_tonight",
      description:
        "Read the current ordered Tonight list in Locus Kitchen while the Kitchen index is visible: the revision token for apply_tonight_changes, one bounded summary per entry (display title, availability, Recipe Document summary), and honest missing-Item entries as null. Read-only: this never changes Tonight.",
      inputSchema: GET_TONIGHT_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrapTool(host, "get_tonight", () => getTonightHandler(host)),
    },
    {
      name: "search_food_items",
      description:
        "Search the Recipe Box (the user's saved Food Items in Locus Kitchen) after the user explicitly asks you to find dishes for Tonight. Only searches existing Recipe Box Food Items through the same filters as the human Kitchen page — never arbitrary saved Items, outside restaurants, tags, or nutrition. Returns bounded summaries with ids for apply_tonight_changes; it never invents Items or nutrition values.",
      inputSchema: SEARCH_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrapTool(host, "search_food_items", (input) => searchHandler(host, input)),
    },
    {
      name: "apply_tonight_changes",
      description:
        "Change Tonight only after the user explicitly asks for those changes: typed add/remove/reorder operations over eligible saved Food Item ids, the expected revision from get_tonight, a fresh clientMutationId (retry the same id for the same change — it is idempotent), and the user's originating instruction when present. One call commits atomically; opening Kitchen or changing filters never applies anything. This cannot edit Recipe Documents, tags, captions, Item status, or review state, and cannot invent nutrition. Missing Items already on Tonight stay until the user explicitly removes them.",
      inputSchema: APPLY_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: wrapTool(host, "apply_tonight_changes", (input) => applyHandler(host, input)),
    },
  ];
}

// One active registration per page: re-registering (React remount, route
// revisit) removes the previous set first, so tool names never duplicate.
let activeCleanup: (() => void) | null = null;

export function registerKitchenTonightWebmcp(runtime: KitchenTonightWebmcpRuntime, host: KitchenTonightWebmcpHost): () => void {
  if (activeCleanup) activeCleanup();
  const controller = new AbortController();
  let done = false;
  let registrationFailed = false;
  const cleanup = () => {
    if (done) return;
    done = true;
    controller.abort();
    if (activeCleanup === cleanup) activeCleanup = null;
  };
  const reportRegistrationFailure = () => {
    if (registrationFailed) return;
    registrationFailed = true;
    cleanup();
    try {
      host.log?.({ tool: "register", outcome: "unavailable", durationMs: 0 });
    } catch {
      /* diagnostics must never break Kitchen */
    }
  };
  activeCleanup = cleanup;
  try {
    for (const tool of buildTools(host)) {
      const registration = runtime.registerTool(tool, { signal: controller.signal });
      if (registration && typeof (registration as Promise<void>).then === "function") {
        void Promise.resolve(registration).catch(reportRegistrationFailure);
      }
    }
  } catch {
    reportRegistrationFailure();
  }
  return cleanup;
}

export function detectKitchenTonightWebmcpRuntime(globalObj: unknown = globalThis): KitchenTonightWebmcpRuntime | null {
  if (!globalObj || typeof globalObj !== "object") return null;
  const root = globalObj as { document?: unknown; navigator?: unknown };
  const documentObj = root.document;
  if (documentObj && typeof documentObj === "object") {
    const modelContext = (documentObj as { modelContext?: unknown }).modelContext;
    if (modelContext && typeof modelContext === "object") {
      const candidate = modelContext as { registerTool?: unknown };
      if (typeof candidate.registerTool === "function") {
        return { registerTool: candidate.registerTool.bind(candidate) as KitchenTonightWebmcpRuntime["registerTool"] };
      }
    }
  }

  // Compatibility with the original WebMCP prototype. Current browsers expose
  // document.modelContext and unregister registrations through AbortSignal.
  const navigatorObj = root.navigator;
  if (!navigatorObj || typeof navigatorObj !== "object") return null;
  const legacyContext = (navigatorObj as { modelContext?: unknown }).modelContext;
  if (!legacyContext || typeof legacyContext !== "object") return null;
  const legacy = legacyContext as { registerTool?: unknown; unregisterTool?: unknown };
  if (typeof legacy.registerTool !== "function" || typeof legacy.unregisterTool !== "function") return null;
  return {
    registerTool(tool, options) {
      const unregister = () => {
        try {
          (legacy.unregisterTool as (name: string) => void).call(legacy, tool.name);
        } catch {
          // Legacy cleanup remains best-effort progressive enhancement.
        }
      };
      const signal = options?.signal;
      if (signal?.aborted) {
        unregister();
        return;
      }
      const result = (legacy.registerTool as (tool: KitchenTonightWebmcpTool) => void | Promise<void>).call(legacy, tool);
      signal?.addEventListener("abort", unregister, { once: true });
      return result;
    },
  };
}

// Progressive enhancement seam: absent runtime returns a no-op cleanup and
// never throws, so ordinary Kitchen keeps working without WebMCP.
export function attachKitchenTonightWebmcp(host: KitchenTonightWebmcpHost, globalObj: unknown = globalThis): () => void {
  const runtime = detectKitchenTonightWebmcpRuntime(globalObj);
  if (!runtime) {
    try {
      host.log?.({ tool: "register", outcome: "unsupported", durationMs: 0 });
    } catch {
      /* diagnostics must never break Kitchen */
    }
    return () => {};
  }
  try {
    return registerKitchenTonightWebmcp(runtime, host);
  } catch {
    try {
      host.log?.({ tool: "register", outcome: "unavailable", durationMs: 0 });
    } catch {
      /* diagnostics must never break Kitchen */
    }
    return () => {};
  }
}
