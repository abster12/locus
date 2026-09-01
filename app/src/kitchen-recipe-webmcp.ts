// Page-defined WebMCP adapter for one visible Kitchen Recipe Document route.
//
// Registers exactly two bounded tools while a detail route shows one Item and
// removes them when the route or visible Item changes, so the agent's
// capabilities always match the visible page. Library identity and the actor
// never travel through tool input: the trusted session resolves the Library
// and the server always applies actor "agent". No React, no MCP SDK, no
// api.ts import — host errors are duck-typed by status so tests run in Node.

export const KITCHEN_RECIPE_WEBMCP_VERSION = 1;

export type KitchenRecipeWebmcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

export type KitchenRecipeWebmcpRuntime = {
  registerTool(tool: KitchenRecipeWebmcpTool, options?: { signal?: AbortSignal }): void | Promise<void>;
};

export type KitchenRecipeWebmcpSourceRecipe = {
  id: string;
  status: "draft" | "reviewed";
  provenance: "caption" | "generated" | "user";
  sourceChanged: boolean;
  title: string | null;
  servings: string | null;
  totalTime: string | null;
  /** Full structured draft and recipe score only when the host includes them (detail route). */
  draft?: unknown;
  score?: unknown;
};

export type KitchenRecipeWebmcpSource = {
  itemId: string;
  displayTitle: string;
  caption: string | null;
  sourceRevision: string;
  availability: string;
  canWatch: boolean;
  recipe: KitchenRecipeWebmcpSourceRecipe | null;
};

export type KitchenRecipeWebmcpHost = {
  /** The one Item bound to the visible Recipe Document detail route, or null. */
  getVisibleItemId: () => string | null;
  /** True only after explicit human consent for a suggested recipe on this Item. Opening the page never sets this. */
  generationAllowed: () => boolean;
  getSource: (itemId: string) => Promise<KitchenRecipeWebmcpSource | null>;
  propose: (
    itemId: string,
    input: { expectedSourceRevision: string; draft: unknown; allowGenerate: boolean },
  ) => Promise<{ document: unknown }>;
  log?: (entry: { tool: string; outcome: string; durationMs: number; resultCount?: number }) => void;
};

export type KitchenRecipeWebmcpError = "invalid" | "not-found" | "forbidden" | "stale" | "unavailable";
export type KitchenRecipeWebmcpToolResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: KitchenRecipeWebmcpError };

const TOOL_NAMES = ["get_recipe_source", "propose_recipe"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

class ToolInvalidError extends Error {}
class ToolNotFoundError extends Error {}
class ToolForbiddenError extends Error {}

function invalidInput(): never {
  throw new ToolInvalidError();
}

function notFound(): never {
  throw new ToolNotFoundError();
}

function forbidden(): never {
  throw new ToolForbiddenError();
}

function optionalRecord(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== "object" || Array.isArray(input)) invalidInput();
  return input as Record<string, unknown>;
}

// Source revision is the SHA-256 digest of the normalized caption.
const SOURCE_REVISION = /^[a-f0-9]{64}$/;

const GET_SOURCE_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const PROPOSE_SCHEMA = {
  type: "object",
  properties: {
    expectedSourceRevision: { type: "string", pattern: SOURCE_REVISION.source, minLength: 64, maxLength: 64 },
    draft: { type: "object" },
  },
  required: ["expectedSourceRevision", "draft"],
  additionalProperties: false,
};

type HandlerOut = { result: KitchenRecipeWebmcpToolResult; count: number };

async function getSourceHandler(host: KitchenRecipeWebmcpHost): Promise<HandlerOut> {
  const itemId = host.getVisibleItemId();
  if (!itemId) notFound();
  const source = await host.getSource(itemId);
  if (!source) notFound();
  const recipe = source.recipe
    ? {
        id: source.recipe.id,
        status: source.recipe.status,
        provenance: source.recipe.provenance,
        sourceChanged: source.recipe.sourceChanged,
        title: source.recipe.title,
        servings: source.recipe.servings,
        totalTime: source.recipe.totalTime,
        ...(source.recipe.draft !== undefined ? { draft: source.recipe.draft } : {}),
        ...(source.recipe.score !== undefined ? { score: source.recipe.score } : {}),
      }
    : null;
  return {
    result: {
      ok: true,
      capabilityVersion: KITCHEN_RECIPE_WEBMCP_VERSION,
      itemId: source.itemId,
      displayTitle: source.displayTitle,
      caption: source.caption,
      sourceRevision: source.sourceRevision,
      availability: source.availability,
      canWatch: source.canWatch,
      recipe,
    },
    count: 1,
  };
}

// Evidence kinds declared inside the agent's draft. Only used for the
// provenance and consent gates below — deep span/bounds validation stays in
// the Kitchen module, which rejects the whole write atomically.
function declaredEvidenceKinds(draft: Record<string, unknown>): Set<string> {
  const kinds = new Set<string>();
  const add = (value: unknown): void => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return;
    const kind = (value as Record<string, unknown>).kind;
    if (typeof kind === "string") kinds.add(kind);
  };
  add(draft.titleEvidence);
  add(draft.servingsEvidence);
  add(draft.totalTimeEvidence);
  for (const key of ["ingredients", "steps"] as const) {
    const list = draft[key];
    if (!Array.isArray(list)) continue;
    for (const row of list) {
      if (!row || typeof row !== "object" || Array.isArray(row)) continue;
      add((row as Record<string, unknown>).evidence);
    }
  }
  return kinds;
}

function pickProposeInput(input: unknown): { expectedSourceRevision: string; draft: Record<string, unknown> } {
  const rec = optionalRecord(input);
  for (const key of Object.keys(rec)) {
    if (key !== "expectedSourceRevision" && key !== "draft") invalidInput();
  }
  const expectedSourceRevision = rec.expectedSourceRevision;
  if (typeof expectedSourceRevision !== "string" || !SOURCE_REVISION.test(expectedSourceRevision)) invalidInput();
  const draft = rec.draft;
  if (!draft || typeof draft !== "object" || Array.isArray(draft)) invalidInput();
  return { expectedSourceRevision, draft: draft as Record<string, unknown> };
}

async function proposeHandler(host: KitchenRecipeWebmcpHost, input: unknown): Promise<HandlerOut> {
  const itemId = host.getVisibleItemId();
  if (!itemId) notFound();
  const { expectedSourceRevision, draft } = pickProposeInput(input);
  const kinds = declaredEvidenceKinds(draft);
  if (kinds.has("user")) invalidInput(); // agent provenance can never claim user evidence
  if (kinds.has("caption") && kinds.has("generated")) invalidInput();
  const hasGenerated = kinds.has("generated");
  if (hasGenerated && !host.generationAllowed()) forbidden();
  const out = await host.propose(itemId, {
    expectedSourceRevision,
    draft,
    allowGenerate: host.generationAllowed() && hasGenerated,
  });
  return { result: { ok: true, capabilityVersion: KITCHEN_RECIPE_WEBMCP_VERSION, itemId, document: out.document }, count: 1 };
}

// One diagnostics wrapper for every tool: bounded log entry only — never
// draft bodies or caption text — and a stable outcome even when the host
// rejects or throws. Host errors thrown by the HTTP layer carry a duck-typed
// status; 400 means the agent can fix the request, 409 means a stale source
// revision worth retrying after a fresh get_recipe_source.
function wrapTool(
  host: KitchenRecipeWebmcpHost,
  name: ToolName,
  handler: (input: unknown) => Promise<HandlerOut>,
): (input: unknown) => Promise<KitchenRecipeWebmcpToolResult> {
  return async (input: unknown) => {
    const startedAt = Date.now();
    let outcome: KitchenRecipeWebmcpError | "ok" = "ok";
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
          : error instanceof ToolNotFoundError || status === 404
            ? "not-found"
            : error instanceof ToolForbiddenError || status === 403
              ? "forbidden"
              : status === 409
                ? "stale"
                : "unavailable";
      return { ok: false, error: outcome };
    } finally {
      try {
        host.log?.({ tool: name, outcome, durationMs: Date.now() - startedAt, resultCount });
      } catch {
        // Diagnostics must never break the tool.
      }
    }
  };
}

function buildTools(host: KitchenRecipeWebmcpHost): Array<{
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => Promise<KitchenRecipeWebmcpToolResult>;
}> {
  return [
    {
      name: "get_recipe_source",
      description:
        "Read the stored source material for the Recipe Document page currently visible in Locus: display title, complete captured caption, source revision, availability, and the existing Recipe Document summary with draft and recipe score when present. Bound to the one visible Item; never fetches the publisher page, never watches inaccessible media, and returns no credentials or other Library content. Use the caption and source revision to ground a propose_recipe draft.",
      inputSchema: GET_SOURCE_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrapTool(host, "get_recipe_source", () => getSourceHandler(host)),
    },
    {
      name: "propose_recipe",
      description:
        "Propose one structured Recipe Document draft for the Item visible on this Recipe Document page: the expectedSourceRevision from get_recipe_source and a draft whose facts cite exact stored caption spans, or use generated evidence only after the human explicitly consented to a suggested recipe on this page. Every accepted proposal is stored as a Draft with agent provenance; only the human can mark it Reviewed, and Tonight is never changed. Unsupported caption claims reject the whole write.",
      inputSchema: PROPOSE_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: wrapTool(host, "propose_recipe", (input) => proposeHandler(host, input)),
    },
  ];
}

// One active registration per page: re-registering (React remount, route
// revisit) removes the previous set first, so tool names never duplicate.
let activeCleanup: (() => void) | null = null;

export function registerKitchenRecipeWebmcp(runtime: KitchenRecipeWebmcpRuntime, host: KitchenRecipeWebmcpHost): () => void {
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

export function detectKitchenRecipeWebmcpRuntime(globalObj: unknown = globalThis): KitchenRecipeWebmcpRuntime | null {
  if (!globalObj || typeof globalObj !== "object") return null;
  const root = globalObj as { document?: unknown; navigator?: unknown };
  const documentObj = root.document;
  if (documentObj && typeof documentObj === "object") {
    const modelContext = (documentObj as { modelContext?: unknown }).modelContext;
    if (modelContext && typeof modelContext === "object") {
      const candidate = modelContext as { registerTool?: unknown };
      if (typeof candidate.registerTool === "function") {
        return { registerTool: candidate.registerTool.bind(candidate) as KitchenRecipeWebmcpRuntime["registerTool"] };
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
      const result = (legacy.registerTool as (tool: KitchenRecipeWebmcpTool) => void | Promise<void>).call(legacy, tool);
      signal?.addEventListener("abort", unregister, { once: true });
      return result;
    },
  };
}

// Progressive enhancement seam: absent runtime returns a no-op cleanup and
// never throws, so ordinary Kitchen keeps working without WebMCP.
export function attachKitchenRecipeWebmcp(host: KitchenRecipeWebmcpHost, globalObj: unknown = globalThis): () => void {
  const runtime = detectKitchenRecipeWebmcpRuntime(globalObj);
  if (!runtime) {
    try {
      host.log?.({ tool: "register", outcome: "unsupported", durationMs: 0 });
    } catch {
      /* diagnostics must never break Kitchen */
    }
    return () => {};
  }
  try {
    return registerKitchenRecipeWebmcp(runtime, host);
  } catch {
    try {
      host.log?.({ tool: "register", outcome: "unavailable", durationMs: 0 });
    } catch {
      /* diagnostics must never break Kitchen */
    }
    return () => {};
  }
}
