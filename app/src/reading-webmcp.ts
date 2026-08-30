// Page-defined WebMCP adapter for the Reading index route (proving slice).
//
// Registers exactly four bounded tools while Reading is mounted and removes
// them on cleanup, so the agent's capabilities always match the visible page.
// Library identity never travels through tool input: the trusted session on
// the Locus server resolves the Library, and unknown input keys are ignored
// rather than forwarded. This file has no React and no MCP SDK — the runtime
// and the page host are injected seams so tests run in plain Node.

export const READING_WEBMCP_VERSION = 1;

export type ReadingWebmcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

export type ReadingWebmcpRuntime = {
  registerTool(tool: ReadingWebmcpTool, options?: { signal?: AbortSignal }): void | Promise<void>;
};

export type ReadingWebmcpPageContext = {
  mood: string | null;
  view: "queue" | "finished";
  q: string;
  kind: string;
  source: string;
  sort: string;
  counts: { unread: number; reading: number; preparing: number; finished: number };
};

export type ReadingWebmcpAgentDocument = {
  id: string;
  title: string;
  canonicalUrl: string | null;
  availability: string;
  hasStoredText: boolean;
  readingMinutes: number | null;
  publication: string | null;
  host: string;
  readingState: string;
  text?: string | null;
  truncated?: boolean;
  totalTextLength?: number;
  provenance?: unknown;
};

export type ReadingWebmcpPanelEntry = {
  documentId: string;
  title: string;
  publication: string | null;
  host: string;
  readingMinutes: number | null;
  readingState: string;
  canonicalUrl: string;
  reason: string;
  basis: "stored_text" | "metadata" | "external_source";
};

export type ReadingWebmcpHost = {
  getPageContext: () => ReadingWebmcpPageContext;
  search: (query: Record<string, unknown>) => Promise<{ items: unknown[]; nextCursor: string | null }>;
  getDocument: (documentId: string) => Promise<ReadingWebmcpAgentDocument | null>;
  present: (panel: { mood: string | null; recommendations: ReadingWebmcpPanelEntry[] }) => void;
  log?: (entry: { tool: string; outcome: string; durationMs: number; resultCount?: number }) => void;
};

export type WebmcpError = "invalid" | "not-found" | "unavailable" | "stale-context" | "unsupported";
export type WebmcpToolResult = { ok: true; [key: string]: unknown } | { ok: false; error: WebmcpError };

const TOOL_NAMES = ["get_reading_context", "search_reading", "get_reading", "present_reading_recommendations"] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const VIEW_VALUES = ["queue", "finished"] as const;
const SORT_VALUES = ["recent", "oldest", "shortest", "longest", "publication"] as const;
const KIND_VALUES = ["article", "documentation", "repository", "pdf", "unknown"] as const;
const BASIS_VALUES = ["stored_text", "metadata", "external_source"] as const;
const SEARCH_LIMIT_DEFAULT = 50;

class ToolInvalidError extends Error {}
class ToolNotFoundError extends Error {}

function invalidInput(): never {
  throw new ToolInvalidError();
}

function notFound(): never {
  throw new ToolNotFoundError();
}

// Bounded plain text for agent-authored strings: strip angle-bracket markup
// and all control/format characters (including zero-width and bidi overrides,
// which must never reach page-rendered text), then trim and slice.
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

function pickCursor(value: unknown, sort: string): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length < 1 || value.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(value)) invalidInput();
  try {
    const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
    const bytes = Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
    const parsed = JSON.parse(new TextDecoder().decode(bytes)) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalidInput();
    const cursor = parsed as { id?: unknown; k?: unknown; lastSavedAt?: unknown; sort?: unknown };
    if (typeof cursor.id !== "string") invalidInput();
    if (typeof cursor.k === "string") {
      const cursorSort = typeof cursor.sort === "string" && SORT_VALUES.includes(cursor.sort as (typeof SORT_VALUES)[number])
        ? cursor.sort
        : sort;
      if (cursorSort !== sort) invalidInput();
      return value;
    }
    if (typeof cursor.lastSavedAt === "string" && (sort === "recent" || sort === "oldest")) return value;
  } catch {
    invalidInput();
  }
  invalidInput();
}

function pickOptionalEnum(value: unknown, values: readonly string[], fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== "string" || !values.includes(value)) invalidInput();
  return value;
}

function pickLimit(value: unknown): number {
  if (value === undefined || value === null) return SEARCH_LIMIT_DEFAULT;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > 50) invalidInput();
  return value;
}

function pickDocumentId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) invalidInput();
  return value;
}

const CONTEXT_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const SEARCH_SCHEMA = {
  type: "object",
  properties: {
    q: { type: "string", maxLength: 200 },
    view: { type: "string", enum: [...VIEW_VALUES] },
    kind: { type: "string", enum: [...KIND_VALUES] },
    source: { type: "string", pattern: "^[A-Za-z][A-Za-z0-9_-]{0,39}$", maxLength: 40 },
    sort: { type: "string", enum: [...SORT_VALUES] },
    cursor: { type: "string", pattern: "^[A-Za-z0-9_-]+$", minLength: 1, maxLength: 1024 },
    limit: { type: "integer", minimum: 1, maximum: 50 },
  },
  additionalProperties: false,
};

const GET_SCHEMA = {
  type: "object",
  properties: {
    documentId: { type: "string", minLength: 1, maxLength: 128 },
  },
  required: ["documentId"],
  additionalProperties: false,
};

const PRESENT_SCHEMA = {
  type: "object",
  properties: {
    mood: { type: "string", maxLength: 80 },
    recommendations: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        properties: {
          documentId: { type: "string", minLength: 1, maxLength: 128 },
          reason: { type: "string", maxLength: 240 },
          basis: { type: "string", enum: [...BASIS_VALUES] },
        },
        required: ["documentId", "reason", "basis"],
        additionalProperties: false,
      },
    },
  },
  required: ["recommendations"],
  additionalProperties: false,
};

type HandlerOut = { result: WebmcpToolResult; count: number };

async function contextHandler(host: ReadingWebmcpHost): Promise<HandlerOut> {
  const ctx = host.getPageContext();
  return {
    result: {
      ok: true,
      capabilityVersion: READING_WEBMCP_VERSION,
      mood: ctx.mood,
      view: ctx.view,
      q: ctx.q,
      kind: ctx.kind,
      source: ctx.source,
      sort: ctx.sort,
      counts: ctx.counts,
      webmcpActive: true,
    },
    count: 1,
  };
}

async function searchHandler(host: ReadingWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  // Defaults come from the live page state at call time; explicit input only
  // overrides this one call and never mutates the visible Reading filters.
  const ctx = host.getPageContext();
  const view = pickOptionalEnum(rec.view, VIEW_VALUES, ctx.view);
  const sort = pickOptionalEnum(rec.sort, SORT_VALUES, ctx.sort);
  const kind = pickOptionalEnum(rec.kind, KIND_VALUES, ctx.kind);
  const q = pickOptionalString(rec.q, 200, ctx.q);
  const source = pickSource(rec.source, ctx.source);
  const cursor = pickCursor(rec.cursor, sort);
  const limit = pickLimit(rec.limit);
  const query: Record<string, unknown> = { view, q, kind, source, sort, limit };
  if (cursor) query.cursor = cursor;
  const page = await host.search(query);
  const items = Array.isArray(page.items) ? page.items : [];
  return {
    result: {
      ok: true,
      items,
      nextCursor: typeof page.nextCursor === "string" ? page.nextCursor : null,
    },
    count: items.length,
  };
}

async function getHandler(host: ReadingWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const documentId = pickDocumentId(rec.documentId);
  const doc = await host.getDocument(documentId);
  if (!doc) notFound();
  return { result: { ok: true, document: doc }, count: 1 };
}

async function presentHandler(host: ReadingWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const list = rec.recommendations;
  if (!Array.isArray(list) || list.length < 1) invalidInput();
  const moodRaw = rec.mood;
  let mood: string | null;
  if (moodRaw === undefined || moodRaw === null) {
    mood = host.getPageContext().mood;
  } else {
    if (typeof moodRaw !== "string") invalidInput();
    mood = sanitizeBounded(moodRaw, 80) || null;
  }
  const entries = list.map((raw) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalidInput();
    const entry = raw as Record<string, unknown>;
    const documentId = pickDocumentId(entry.documentId);
    if (typeof entry.reason !== "string") invalidInput();
    if (typeof entry.basis !== "string" || !(BASIS_VALUES as readonly string[]).includes(entry.basis)) invalidInput();
    return { documentId, reason: sanitizeBounded(entry.reason, 240), basis: entry.basis };
  });
  const seen = new Set<string>();
  for (const entry of entries) {
    if (seen.has(entry.documentId)) invalidInput();
    seen.add(entry.documentId);
  }
  // Atomic validation: resolve every id and canonical URL before the single
  // present() call, so a bad entry leaves the previous panel untouched.
  const resolved: ReadingWebmcpPanelEntry[] = [];
  for (const entry of entries) {
    const doc = await host.getDocument(entry.documentId);
    if (!doc) notFound();
    const canonicalUrl = typeof doc.canonicalUrl === "string" ? doc.canonicalUrl : "";
    if (!canonicalUrl) invalidInput();
    resolved.push({
      documentId: entry.documentId,
      title: doc.title,
      publication: doc.publication ?? null,
      host: doc.host,
      readingMinutes: doc.readingMinutes ?? null,
      readingState: doc.readingState,
      canonicalUrl,
      reason: entry.reason,
      basis: entry.basis as ReadingWebmcpPanelEntry["basis"],
    });
  }
  host.present({ mood, recommendations: resolved });
  return { result: { ok: true, mood, recommendations: resolved }, count: resolved.length };
}

// One diagnostics wrapper for every tool: bounded log entry only (name,
// outcome, duration, count) — never query bodies, article text, notes, or
// full payloads — and a stable outcome even when the host rejects or throws.
function wrapTool(
  host: ReadingWebmcpHost,
  name: ToolName,
  handler: (input: unknown) => Promise<HandlerOut>,
): (input: unknown) => Promise<WebmcpToolResult> {
  return async (input: unknown) => {
    const startedAt = Date.now();
    let outcome: WebmcpError | "ok" = "ok";
    let resultCount = 0;
    try {
      const out = await handler(input);
      resultCount = out.count;
      if (!out.result.ok) outcome = out.result.error;
      return out.result;
    } catch (error) {
      // Host errors thrown by the HTTP layer carry a duck-typed status; a 400
      // (RejectedPayload) means the agent can fix the request, so invalid beats
      // a retry of a dead tool. No api.ts import — duck-type only.
      const status = error instanceof Error ? (error as { status?: unknown }).status : undefined;
      outcome =
        error instanceof ToolInvalidError || status === 400
          ? "invalid"
          : error instanceof ToolNotFoundError
            ? "not-found"
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

function buildTools(host: ReadingWebmcpHost): Array<{
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => Promise<WebmcpToolResult>;
}> {
  return [
    {
      name: "get_reading_context",
      description:
        "Read the current Reading page context in Locus: selected mood, active Unread/Finished view, search, kind, source, and sort filters, queue counts, and the tool capability version. Returns no article bodies.",
      inputSchema: CONTEXT_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: wrapTool(host, "get_reading_context", () => contextHandler(host)),
    },
    {
      name: "search_reading",
      description:
        "List or search the user's Reading section through Locus. Locus returns bounded metadata for every non-removed Reading Document including source-only rows; stored article text is NOT in this tool; the agent may independently open a safe canonical URL. Omitted fields default to the page's current view and filters. Use get_reading for stored article text.",
      inputSchema: SEARCH_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrapTool(host, "search_reading", (input) => searchHandler(host, input)),
    },
    {
      name: "get_reading",
      description:
        "Inspect one Reading Document by opaque id. This tool never fetches the publisher; if hasStoredText is false the agent may inspect canonicalUrl itself when it is non-null. Returns bounded metadata, bounded provenance, and normalized stored article text when present, capped with truncation markers.",
      inputSchema: GET_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrapTool(host, "get_reading", (input) => getHandler(host, input)),
    },
    {
      name: "present_reading_recommendations",
      description:
        "Present a variable-length list of existing Reading Documents in a temporary recommendation sheet on the Reading page. The recommendations array determines the displayed count. Every id must be unique, must come from search_reading or get_reading in this Library, and needs a safe canonical URL, so the Library's recommendable Reading Documents are the natural maximum; each reason must state its evidence basis (stored_text, metadata, or external_source) and is shown as agent-authored.",
      inputSchema: PRESENT_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: wrapTool(host, "present_reading_recommendations", (input) => presentHandler(host, input)),
    },
  ];
}

// One active registration per page: re-registering (React remount, route
// revisit) removes the previous set first, so tool names never duplicate.
let activeCleanup: (() => void) | null = null;

export function registerReadingWebmcp(runtime: ReadingWebmcpRuntime, host: ReadingWebmcpHost): () => void {
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
      /* diagnostics must never break Reading */
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

export function detectReadingWebmcpRuntime(globalObj: unknown = globalThis): ReadingWebmcpRuntime | null {
  if (!globalObj || typeof globalObj !== "object") return null;
  const root = globalObj as { document?: unknown; navigator?: unknown };
  const documentObj = root.document;
  if (documentObj && typeof documentObj === "object") {
    const modelContext = (documentObj as { modelContext?: unknown }).modelContext;
    if (modelContext && typeof modelContext === "object") {
      const candidate = modelContext as { registerTool?: unknown };
      if (typeof candidate.registerTool === "function") {
        return { registerTool: candidate.registerTool.bind(candidate) as ReadingWebmcpRuntime["registerTool"] };
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
      const result = (legacy.registerTool as (tool: ReadingWebmcpTool) => void | Promise<void>).call(legacy, tool);
      signal?.addEventListener("abort", unregister, { once: true });
      return result;
    },
  };
}

// Progressive enhancement seam: absent runtime returns a no-op cleanup and
// never throws, so ordinary Reading keeps working without WebMCP.
export function attachReadingWebmcp(host: ReadingWebmcpHost, globalObj: unknown = globalThis): () => void {
  const runtime = detectReadingWebmcpRuntime(globalObj);
  if (!runtime) {
    try {
      host.log?.({ tool: "register", outcome: "unsupported", durationMs: 0 });
    } catch {
      /* diagnostics must never break Reading */
    }
    return () => {};
  }
  try {
    return registerReadingWebmcp(runtime, host);
  } catch {
    try {
      host.log?.({ tool: "register", outcome: "unavailable", durationMs: 0 });
    } catch {
      /* diagnostics must never break Reading */
    }
    return () => {};
  }
}
