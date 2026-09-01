// Page-defined WebMCP adapter for the private Trips routes (index, setup,
// and Trip Document). Same lifecycle as the Reading proving slice: tools are
// registered only while a Trips page is mounted, removed on unmount or route
// change, and re-registered once when the surface returns. Library identity
// and actor never travel through tool input — the trusted session resolves
// the Library and the trusted adapter route derives the agent actor. No React
// and no MCP SDK.

import { validateTripDocument } from "./trips.ts";
import type { TripDocument } from "./api.ts";

export const TRIPS_WEBMCP_VERSION = 1;

export type TripsWebmcpTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

export type TripsWebmcpRuntime = {
  registerTool(tool: TripsWebmcpTool, options?: { signal?: AbortSignal }): void | Promise<void>;
};

export type TripsWebmcpApplied = {
  trip: TripDocument;
  changeset: unknown;
  replayed: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

export type TripsWebmcpHost = {
  /** index/setup expose list/search/create only; document tools require a visible Trip Document. */
  surface: () => "index" | "setup" | "document";
  getVisibleTripId: () => string | null;
  /** True only after the user explicitly asked the visible agent to review
   * the Trip Document. `record_trip_review` registers only while this and a
   * visible document hold; opening a trip never sets it. */
  reviewRequested: () => boolean;
  consumeReviewIntent?: () => void;
  listTrips: () => Promise<{ trips: unknown[] }>;
  getTrip: (tripId: string) => Promise<TripDocument | null>;
  searchSources: (q: string) => Promise<{ items: unknown[]; places: unknown[] }>;
  createTrip: (setup: Record<string, unknown>) => Promise<{ trip: TripDocument }>;
  applyChanges: (
    tripId: string,
    input: { expectedRevision: number; clientMutationId: string; instruction?: string | null; operations: unknown[]; inferredPreferences?: unknown[] },
  ) => Promise<TripsWebmcpApplied>;
  /** Temporary presentation: hands the sanitized three-option panel to the
   * visible drawer. Never writes the Trip Document. */
  present: (panel: unknown) => void;
  previewShare: (tripId: string) => Promise<{ snapshot: unknown }>;
  recordReview: (
    tripId: string,
    input: { expectedRevision: number; clientMutationId: string; flags: unknown[] },
  ) => Promise<{ trip: TripDocument; replayed: boolean }>;
  log?: (entry: { tool: string; outcome: string; durationMs: number; resultCount?: number }) => void;
};

export type TripsWebmcpError = "invalid" | "not-found" | "forbidden" | "stale" | "unavailable";
export type TripsWebmcpToolResult =
  | { ok: true; [key: string]: unknown }
  | { ok: false; error: TripsWebmcpError; detail?: string };

const TOOL_NAMES = [
  "apply_trip_changes",
  "build_trip_draft",
  "create_trip",
  "get_trip",
  "list_trips",
  "present_trip_recommendations",
  "record_trip_review",
  "search_trip_sources",
  "get_trip_share_preview",
  "validate_trip",
] as const;
type ToolName = (typeof TOOL_NAMES)[number];

const MAX_LIST_TRIPS = 50;

class ToolInvalidError extends Error {}
class ToolNotFoundError extends Error {}

function invalidInput(): never {
  throw new ToolInvalidError();
}

function notFound(): never {
  throw new ToolNotFoundError();
}

// Bounded plain text for agent-authored strings: strip angle-bracket markup
// and all control/format characters, then trim and slice.
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

function pickTripId(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 64) invalidInput();
  return value;
}

function requireVisibleTripId(host: TripsWebmcpHost, requested: unknown): string {
  const visible = host.getVisibleTripId();
  if (!visible) notFound();
  const named = pickOptionalTripId(requested);
  if (named && named !== visible) notFound();
  return visible;
}

function pickOptionalTripId(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return pickTripId(value);
}

function pickPositiveInteger(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) invalidInput();
  void field;
  return value;
}

const TRIP_ID_SCHEMA = { type: "string", minLength: 1, maxLength: 64 };

const LIST_TRIPS_SCHEMA = {
  type: "object",
  properties: {},
  additionalProperties: false,
};

const GET_TRIP_SCHEMA = {
  type: "object",
  properties: { tripId: TRIP_ID_SCHEMA },
  additionalProperties: false,
};

const SEARCH_SOURCES_SCHEMA = {
  type: "object",
  properties: { q: { type: "string", maxLength: 120 } },
  additionalProperties: false,
};

const CONTEXT_SCHEMA = {
  type: "object",
  properties: {
    lodgingAnchors: { type: "array", maxItems: 12, items: { type: "string", maxLength: 160 } },
    pace: { type: ["string", "null"], maxLength: 120 },
    mobility: { type: ["string", "null"], maxLength: 120 },
    budget: { type: ["string", "null"], maxLength: 120 },
    mealPreferences: { type: "array", maxItems: 12, items: { type: "string", maxLength: 160 } },
    interests: { type: "array", maxItems: 12, items: { type: "string", maxLength: 160 } },
    mustDos: { type: "array", maxItems: 12, items: { type: "string", maxLength: 160 } },
    hardConstraints: { type: "array", maxItems: 12, items: { type: "string", maxLength: 160 } },
  },
  additionalProperties: false,
};

const CREATE_TRIP_SCHEMA = {
  type: "object",
  properties: {
    destination: { type: "string", minLength: 1, maxLength: 120 },
    clientMutationId: { type: "string", minLength: 1, maxLength: 100 },
    startDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    endDate: { type: "string", pattern: "^\\d{4}-\\d{2}-\\d{2}$" },
    durationDays: { type: "integer", minimum: 1, maximum: 365 },
    title: { type: "string", maxLength: 120 },
    timezone: { type: "string", maxLength: 64 },
    travelers: { type: "string", maxLength: 120 },
    context: CONTEXT_SCHEMA,
  },
  required: ["destination", "clientMutationId"],
  additionalProperties: false,
};

const STOP_CONTENT_SCHEMA = {
  type: "object",
  oneOf: [
    {
      type: "object",
      properties: { kind: { const: "item" }, itemId: TRIP_ID_SCHEMA },
      required: ["kind", "itemId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "place" }, placeId: TRIP_ID_SCHEMA },
      required: ["kind", "placeId"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: {
        kind: { const: "outside" },
        title: { type: "string", minLength: 1, maxLength: 120 },
        notes: { type: ["string", "null"], maxLength: 400 },
        url: { type: ["string", "null"], maxLength: 2000 },
      },
      required: ["kind", "title"],
      additionalProperties: false,
    },
    {
      type: "object",
      properties: { kind: { const: "hole" }, request: { type: "string", minLength: 1, maxLength: 120 } },
      required: ["kind", "request"],
      additionalProperties: false,
    },
  ],
};

const NOTES_FIELD = { type: ["string", "null"], maxLength: 400 };
const TIME_WINDOW_FIELD = { type: ["string", "null"], maxLength: 120 };
const DURATION_FIELD = { type: ["integer", "null"], minimum: 1, maximum: 1440 };

const OPERATIONS_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 50,
  items: {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: {
          type: { const: "addStop" },
          dayId: { type: ["string", "null"], maxLength: 64 },
          content: STOP_CONTENT_SCHEMA,
          beforeStopId: TRIP_ID_SCHEMA,
          afterStopId: TRIP_ID_SCHEMA,
          timeWindow: TIME_WINDOW_FIELD,
          durationMinutes: DURATION_FIELD,
          publicNotes: NOTES_FIELD,
          privateNotes: NOTES_FIELD,
          state: { type: "string", enum: ["confirmed", "draft"] },
        },
        required: ["type", "dayId", "content"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "updateStop" },
          stopId: TRIP_ID_SCHEMA,
          content: STOP_CONTENT_SCHEMA,
          timeWindow: TIME_WINDOW_FIELD,
          durationMinutes: DURATION_FIELD,
          publicNotes: NOTES_FIELD,
          privateNotes: NOTES_FIELD,
          state: { type: "string", enum: ["confirmed", "draft"] },
        },
        required: ["type", "stopId"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          type: { const: "moveStop" },
          stopId: TRIP_ID_SCHEMA,
          dayId: { type: ["string", "null"], maxLength: 64 },
          beforeStopId: TRIP_ID_SCHEMA,
          afterStopId: TRIP_ID_SCHEMA,
        },
        required: ["type", "stopId"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { type: { const: "removeStop" }, stopId: TRIP_ID_SCHEMA },
        required: ["type", "stopId"],
        additionalProperties: false,
      },
    ],
  },
};

const APPLY_SCHEMA = {
  type: "object",
  properties: {
    tripId: TRIP_ID_SCHEMA,
    expectedRevision: { type: "integer", minimum: 1 },
    clientMutationId: { type: "string", minLength: 1, maxLength: 100 },
    instruction: { type: "string", maxLength: 500 },
    operations: OPERATIONS_SCHEMA,
  },
  required: ["expectedRevision", "clientMutationId", "operations"],
  additionalProperties: false,
};

const VALIDATE_TRIP_SCHEMA = {
  type: "object",
  properties: { tripId: TRIP_ID_SCHEMA },
  additionalProperties: false,
};

// Base build (ticket 10): bounded selected sources become Draft stops. The
// tool owns the shape; the Trips module owns reference validation, so unknown
// or foreign ids reject the whole atomic changeset server-side.
const SOURCE_SELECTION_SCHEMA = {
  type: "array",
  minItems: 1,
  maxItems: 12,
  items: {
    type: "object",
    oneOf: [
      {
        type: "object",
        properties: { kind: { const: "item" }, id: TRIP_ID_SCHEMA },
        required: ["kind", "id"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { kind: { const: "place" }, id: TRIP_ID_SCHEMA },
        required: ["kind", "id"],
        additionalProperties: false,
      },
    ],
  },
};

const INFERRED_PREFERENCE_SCHEMA = {
  type: "array",
  maxItems: 8,
  items: {
    type: "object",
    properties: {
      text: { type: "string", minLength: 1, maxLength: 160 },
      basis: { type: "string", minLength: 1, maxLength: 160 },
    },
    required: ["text", "basis"],
    additionalProperties: false,
  },
};

const BUILD_DRAFT_SCHEMA = {
  type: "object",
  properties: {
    tripId: TRIP_ID_SCHEMA,
    expectedRevision: { type: "integer", minimum: 1 },
    clientMutationId: { type: "string", minLength: 1, maxLength: 100 },
    instruction: { type: "string", minLength: 1, maxLength: 500 },
    selectedSources: SOURCE_SELECTION_SCHEMA,
    inferredPreferences: INFERRED_PREFERENCE_SCHEMA,
  },
  required: ["expectedRevision", "clientMutationId", "instruction", "selectedSources"],
  additionalProperties: false,
};

const REC_TEXT_FIELD = { type: "string", minLength: 1, maxLength: 280 };

const REC_OPTION_SCHEMA = {
  type: "object",
  properties: {
    opinion: REC_TEXT_FIELD,
    fit: REC_TEXT_FIELD,
    tradeoff: REC_TEXT_FIELD,
    basis: REC_TEXT_FIELD,
    effect: REC_TEXT_FIELD,
    operations: OPERATIONS_SCHEMA,
  },
  required: ["opinion", "fit", "tradeoff", "basis", "effect", "operations"],
  additionalProperties: false,
};

const PRESENT_RECS_SCHEMA = {
  type: "object",
  properties: {
    tripId: TRIP_ID_SCHEMA,
    request: REC_TEXT_FIELD,
    options: { type: "array", minItems: 3, maxItems: 3, items: REC_OPTION_SCHEMA },
  },
  required: ["request", "options"],
  additionalProperties: false,
};

const REVIEW_FLAG_SCHEMA = {
  type: "object",
  properties: {
    category: { type: "string", enum: ["travel_feasibility", "strain", "missing_information"] },
    severity: { type: "string", enum: ["info", "concern", "urgent"] },
    opinion: { type: "string", minLength: 1, maxLength: 240 },
    rationale: { type: "string", minLength: 1, maxLength: 600 },
    dayRefs: { type: "array", maxItems: 12, items: TRIP_ID_SCHEMA },
    stopRefs: { type: "array", maxItems: 12, items: TRIP_ID_SCHEMA },
  },
  required: ["category", "severity", "opinion", "rationale"],
  additionalProperties: false,
};

const REVIEW_SCHEMA = {
  type: "object",
  properties: {
    expectedRevision: { type: "integer", minimum: 1 },
    clientMutationId: { type: "string", minLength: 1, maxLength: 100 },
    flags: { type: "array", minItems: 1, maxItems: 8, items: REVIEW_FLAG_SCHEMA },
  },
  required: ["expectedRevision", "clientMutationId", "flags"],
  additionalProperties: false,
};

type HandlerOut = { result: TripsWebmcpToolResult; count: number };

async function listHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  optionalRecord(input);
  const page = await host.listTrips();
  const trips = Array.isArray(page.trips) ? page.trips.slice(0, MAX_LIST_TRIPS) : [];
  return { result: { ok: true, capabilityVersion: TRIPS_WEBMCP_VERSION, trips }, count: trips.length };
}

async function getHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const tripId = requireVisibleTripId(host, rec.tripId);
  const trip = await host.getTrip(tripId);
  if (!trip) notFound();
  return {
    result: { ok: true, capabilityVersion: TRIPS_WEBMCP_VERSION, trip, advisories: Array.isArray(trip.advisories) ? trip.advisories : [] },
    count: 1,
  };
}

async function sharePreviewHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const tripId = requireVisibleTripId(host, rec.tripId);
  const { snapshot } = await host.previewShare(tripId);
  return { result: { ok: true, capabilityVersion: TRIPS_WEBMCP_VERSION, snapshot }, count: 1 };
}

async function searchHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const q = pickOptionalString(rec.q, 120, "");
  const sources = await host.searchSources(q);
  return {
    result: {
      ok: true,
      capabilityVersion: TRIPS_WEBMCP_VERSION,
      items: Array.isArray(sources.items) ? sources.items : [],
      places: Array.isArray(sources.places) ? sources.places : [],
    },
    count: (Array.isArray(sources.items) ? sources.items.length : 0) + (Array.isArray(sources.places) ? sources.places.length : 0),
  };
}

async function createHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const setup = optionalRecord(input);
  if (!Object.hasOwn(setup, "destination")) invalidInput();
  // Same bounds as the other Trip mutations. The caller owns the id so a
  // lost-response retry replays the server receipt instead of duplicating.
  if (typeof setup.clientMutationId !== "string" || setup.clientMutationId.length < 1 || setup.clientMutationId.length > 100) invalidInput();
  const created = await host.createTrip(setup);
  return { result: { ok: true, capabilityVersion: TRIPS_WEBMCP_VERSION, trip: created.trip }, count: 1 };
}

async function applyHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const tripId = requireVisibleTripId(host, rec.tripId);
  const expectedRevision = pickPositiveInteger(rec.expectedRevision, "expectedRevision");
  if (typeof rec.clientMutationId !== "string" || rec.clientMutationId.length < 1 || rec.clientMutationId.length > 100) invalidInput();
  const clientMutationId = rec.clientMutationId;
  const instruction = pickOptionalString(rec.instruction, 500, "");
  const hasOperations = Array.isArray(rec.operations) && rec.operations.length > 0;
  if (!hasOperations) {
    // Prose without typed operations is an open-ended request, never a write:
    // route the agent to the visible three-option presentation contract.
    if (instruction.trim()) {
      return {
        result: {
          ok: false,
          error: "invalid",
          detail:
            "open-ended requests are never applied directly; present exactly three opinionated options with present_trip_recommendations instead",
        },
        count: 0,
      };
    }
    invalidInput();
  }
  const result = await host.applyChanges(tripId, {
    expectedRevision,
    clientMutationId,
    instruction: instruction || null,
    operations: rec.operations as unknown[],
  });
  return {
    result: {
      ok: true,
      capabilityVersion: TRIPS_WEBMCP_VERSION,
      trip: result.trip,
      changeset: result.changeset,
      replayed: result.replayed,
    },
    count: 1,
  };
}

// Base build (ticket 10): a thin wrapper over the exact-change engine. Every
// selected source becomes one addStop on Unscheduled — placement is a
// deliberate choice (Unscheduled is always valid and races with no day edit);
// the human moves Draft stops into days. References are validated by the
// module, so unknown or foreign ids reject the whole atomic changeset.
async function buildDraftHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const tripId = requireVisibleTripId(host, rec.tripId);
  const expectedRevision = pickPositiveInteger(rec.expectedRevision, "expectedRevision");
  if (typeof rec.clientMutationId !== "string" || rec.clientMutationId.length < 1 || rec.clientMutationId.length > 100) invalidInput();
  if (typeof rec.instruction !== "string" || !rec.instruction.trim()) invalidInput();
  if (!Array.isArray(rec.selectedSources) || rec.selectedSources.length === 0 || rec.selectedSources.length > 12) invalidInput();
  const operations = rec.selectedSources.map((source) => {
    if (!source || typeof source !== "object" || Array.isArray(source)) invalidInput();
    const entry = source as Record<string, unknown>;
    if (entry.kind === "item" && typeof entry.id === "string" && entry.id) {
      return { type: "addStop", dayId: null, content: { kind: "item", itemId: entry.id } };
    }
    if (entry.kind === "place" && typeof entry.id === "string" && entry.id) {
      return { type: "addStop", dayId: null, content: { kind: "place", placeId: entry.id } };
    }
    invalidInput();
  });
  // Omitted inferences are passed as absent — the tool never invents
  // preferences the agent did not supply.
  const inferences = sanitizeInferredPreferences(rec.inferredPreferences);
  const result = await host.applyChanges(tripId, {
    expectedRevision,
    clientMutationId: rec.clientMutationId,
    instruction: sanitizeBounded(rec.instruction, 500),
    operations,
    ...(inferences ? { inferredPreferences: inferences } : {}),
  });
  return {
    result: {
      ok: true,
      capabilityVersion: TRIPS_WEBMCP_VERSION,
      trip: result.trip,
      changeset: result.changeset,
      replayed: result.replayed,
      addedStops: operations.length,
    },
    count: operations.length,
  };
}

function sanitizeInferredPreferences(value: unknown): Array<Record<string, string>> | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.length > 8) invalidInput();
  return value.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalidInput();
    const rec = entry as Record<string, unknown>;
    if (typeof rec.text !== "string" || !rec.text.trim() || typeof rec.basis !== "string" || !rec.basis.trim()) invalidInput();
    return { text: sanitizeBounded(rec.text, 160), basis: sanitizeBounded(rec.basis, 160) };
  });
}

// Presentation (ticket 10): exactly three bounded, opinionated options shown
// in the visible drawer. Presentation is temporary page state — this tool
// never writes the Trip Document; selection is a human changeset.
async function presentRecsHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const tripId = requireVisibleTripId(host, rec.tripId);
  if (typeof rec.request !== "string" || !rec.request.trim()) invalidInput();
  if (!Array.isArray(rec.options) || rec.options.length !== 3) invalidInput();
  const optionText = (value: unknown): string => {
    if (typeof value !== "string" || !value.trim()) invalidInput();
    return sanitizeBounded(value, 280);
  };
  const options = rec.options.map((entry) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) invalidInput();
    const option = entry as Record<string, unknown>;
    if (!Array.isArray(option.operations) || option.operations.length < 1 || option.operations.length > 50) invalidInput();
    for (const operation of option.operations) {
      if (!operation || typeof operation !== "object" || Array.isArray(operation)) invalidInput();
    }
    return {
      opinion: optionText(option.opinion),
      fit: optionText(option.fit),
      tradeoff: optionText(option.tradeoff),
      basis: optionText(option.basis),
      effect: optionText(option.effect),
      operations: option.operations,
    };
  });
  host.present({ tripId, request: sanitizeBounded(rec.request, 280), options });
  return { result: { ok: true, capabilityVersion: TRIPS_WEBMCP_VERSION, presented: true, optionCount: 3 }, count: 3 };
}

async function validateHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const tripId = requireVisibleTripId(host, rec.tripId);
  const trip = await host.getTrip(tripId);
  if (!trip) notFound();
  const report = validateTripDocument(trip);
  return {
    result: {
      ok: true,
      capabilityVersion: TRIPS_WEBMCP_VERSION,
      tripId: trip.id,
      revision: trip.revision,
      valid: report.valid,
      issues: report.issues,
    },
    count: report.issues.length,
  };
}

async function reviewHandler(host: TripsWebmcpHost, input: unknown): Promise<HandlerOut> {
  const rec = optionalRecord(input);
  const tripId = requireVisibleTripId(host, rec.tripId);
  const expectedRevision = pickPositiveInteger(rec.expectedRevision, "expectedRevision");
  if (typeof rec.clientMutationId !== "string" || rec.clientMutationId.length < 1 || rec.clientMutationId.length > 100) invalidInput();
  if (!Array.isArray(rec.flags) || rec.flags.length === 0) invalidInput();
  const result = await host.recordReview(tripId, {
    expectedRevision,
    clientMutationId: rec.clientMutationId,
    flags: rec.flags,
  });
  const advisories = Array.isArray(result.trip.advisories) ? result.trip.advisories : [];
  try {
    host.consumeReviewIntent?.();
  } catch {
    /* intent cleanup must not hide a successful save */
  }
  return {
    result: {
      ok: true,
      capabilityVersion: TRIPS_WEBMCP_VERSION,
      tripId,
      reviewedRevision: expectedRevision,
      replayed: result.replayed,
      advisories,
    },
    count: advisories.length,
  };
}

// One diagnostics wrapper for every tool: bounded log entry only — never
// instruction text, setup bodies, or full payloads — and a stable outcome even
// when the host rejects or throws. Host errors thrown by the HTTP layer carry
// a duck-typed status; 400 means the agent can fix the request.
function wrapTool(
  host: TripsWebmcpHost,
  name: ToolName,
  handler: (input: unknown) => Promise<HandlerOut>,
): (input: unknown) => Promise<TripsWebmcpToolResult> {
  return async (input: unknown) => {
    const startedAt = Date.now();
    let outcome: TripsWebmcpError | "ok" = "ok";
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
        // Diagnostics must never break the tool.
      }
    }
  };
}

type BuiltTool = {
  name: ToolName;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; untrustedContentHint: boolean };
  execute: (input: unknown) => Promise<TripsWebmcpToolResult>;
};

function buildTools(host: TripsWebmcpHost): BuiltTool[] {
  const documentTools = new Set<ToolName>([
    "apply_trip_changes",
    "build_trip_draft",
    "get_trip",
    "get_trip_share_preview",
    "present_trip_recommendations",
    "validate_trip",
  ]);
  const tools: BuiltTool[] = [
    {
      name: "list_trips",
      description:
        "List the user's Trip Documents in the current Library as bounded summaries (id, title, destination, dates or open dates, duration, revision, archive state, last update). Only works while a Trips page is visible. Creates nothing.",
      inputSchema: LIST_TRIPS_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: wrapTool(host, "list_trips", (input) => listHandler(host, input)),
    },
    {
      name: "get_trip",
      description:
        "Inspect the exact Trip Document visible on this Trips page (or one named by opaque id in this Library): revision, user-entered setup context, ordered days, ordered stops with draft/confirmed state and provenance, Unscheduled entries, item/place references, holes, and current advisory flags. Read-only: returns no session data and mutates nothing.",
      inputSchema: GET_TRIP_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: true },
      execute: wrapTool(host, "get_trip", (input) => getHandler(host, input)),
    },
    {
      name: "search_trip_sources",
      description:
        "Search bounded saved Item and Place summaries in the user's Library to reference in a trip. Returns selection fields only (id, title/source; id, name/kind) — never captions, media, or credentials. Use returned ids in addStop content.",
      inputSchema: SEARCH_SOURCES_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: wrapTool(host, "search_trip_sources", (input) => searchHandler(host, input)),
    },
    {
      name: "create_trip",
      description:
        "Create a Trip Document after the user explicitly asks for one. Requires a destination, a date range or a trip length, and a clientMutationId you keep stable when retrying this exact creation; every other field is optional user context. Uses the same validation and ownership as the human setup form; agent-created documents contain nothing the user did not supply through this call.",
      inputSchema: CREATE_TRIP_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: false },
      execute: wrapTool(host, "create_trip", (input) => createHandler(host, input)),
    },
    {
      name: "apply_trip_changes",
      description:
        "Apply exact, user-instructed changes to the visible Trip Document as one atomic changeset: typed operations (addStop, updateStop, moveStop, removeStop), the expected revision, a fresh clientMutationId, and the user's instruction when present. Agent-added or replaced stops begin Draft until the user keeps them. Open-ended taste requests are rejected — present options with present_trip_recommendations instead. No publish, revoke, delete, or confirmation abilities exist.",
      inputSchema: APPLY_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: wrapTool(host, "apply_trip_changes", (input) => applyHandler(host, input)),
    },
    {
      name: "build_trip_draft",
      description:
        "After the user explicitly asks for a base itinerary, build one atomic Draft changeset from the Trip Document context and the bounded saved sources you name: selectedSources (1–12 saved Item/Place ids from search_trip_sources) become Draft stops on Unscheduled. Supply inferredPreferences only when the user asked you to infer; they are stored as labelled agent inferences (never user-entered context) and the human can remove them. Sources must already exist — this never creates Items/Places, never crawls, and never touches days the user planned.",
      inputSchema: BUILD_DRAFT_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: wrapTool(host, "build_trip_draft", (input) => buildDraftHandler(host, input)),
    },
    {
      name: "present_trip_recommendations",
      description:
        "For one explicit open-ended request or hole, show exactly three opinionated options in the visible recommendations drawer: each needs opinion, why it fits, an important tradeoff, provenance/basis, proposed typed addStop/moveStop operations, and the likely schedule effect. Presentation is temporary — nothing is written until the human chooses one; you cannot choose for them.",
      inputSchema: PRESENT_RECS_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: wrapTool(host, "present_trip_recommendations", (input) => presentRecsHandler(host, input)),
    },
    {
      name: "validate_trip",
      description:
        "Report deterministic conditions present in the saved Trip Document data only: overlapping timed ranges, unfilled holes, duplicate stop identities, and position/order mismatches. No route lookup, no travel-time invention, no web access, no inference. Read-only.",
      inputSchema: VALIDATE_TRIP_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: wrapTool(host, "validate_trip", (input) => validateHandler(host, input)),
    },
    {
      name: "get_trip_share_preview",
      description:
        "Read the exact sanitized Share Snapshot that would leave the private Library if the owner published. Allowlisted public fields only: no private notes, captions, agent instructions, history, or capability tokens. Read-only: this never publishes, updates, or revokes a share.",
      inputSchema: GET_TRIP_SCHEMA,
      annotations: { readOnlyHint: true, untrustedContentHint: false },
      execute: wrapTool(host, "get_trip_share_preview", (input) => sharePreviewHandler(host, input)),
    },
  ];
  // The advisory write tool exists only while the user has explicitly asked
  // the visible agent to review the Trip Document they are looking at.
  const onDocument = host.surface() === "document";
  const scoped = onDocument ? tools : tools.filter((tool) => !documentTools.has(tool.name));
  if (onDocument && host.reviewRequested() && host.getVisibleTripId()) {
    scoped.push({
      name: "record_trip_review",
      description:
        "Save bounded advisory opinions (travel feasibility, strain, missing information) about the Trip Document the user explicitly asked you to review. Review ONLY the fields returned by get_trip plus the user's own request: Locus supplies no route durations, distance data, fitness profile, or web results, and the payload cannot store URLs, coordinates, reservations, or Library entities. Factual itinerary changes belong in apply_trip_changes, never here.",
      inputSchema: REVIEW_SCHEMA,
      annotations: { readOnlyHint: false, untrustedContentHint: true },
      execute: wrapTool(host, "record_trip_review", (input) => reviewHandler(host, input)),
    });
  }
  return scoped;
}

// One active registration per page: re-registering (React remount, route or
// document change) removes the previous set first, so tool names never
// duplicate. AbortSignal cleanup matches the Reading lifecycle exactly.
let activeCleanup: (() => void) | null = null;

export function registerTripsWebmcp(runtime: TripsWebmcpRuntime, host: TripsWebmcpHost): () => void {
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
      /* diagnostics must never break Trips */
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

export function detectTripsWebmcpRuntime(globalObj: unknown = globalThis): TripsWebmcpRuntime | null {
  if (!globalObj || typeof globalObj !== "object") return null;
  const root = globalObj as { document?: unknown; navigator?: unknown };
  const documentObj = root.document;
  if (documentObj && typeof documentObj === "object") {
    const modelContext = (documentObj as { modelContext?: unknown }).modelContext;
    if (modelContext && typeof modelContext === "object") {
      const candidate = modelContext as { registerTool?: unknown };
      if (typeof candidate.registerTool === "function") {
        return { registerTool: candidate.registerTool.bind(candidate) as TripsWebmcpRuntime["registerTool"] };
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
      const result = (legacy.registerTool as (tool: TripsWebmcpTool) => void | Promise<void>).call(legacy, tool);
      signal?.addEventListener("abort", unregister, { once: true });
      return result;
    },
  };
}

// Progressive enhancement seam: absent runtime returns a no-op cleanup and
// never throws, so ordinary Trips keeps working without WebMCP.
export function attachTripsWebmcp(host: TripsWebmcpHost, globalObj: unknown = globalThis): () => void {
  const runtime = detectTripsWebmcpRuntime(globalObj);
  if (!runtime) {
    try {
      host.log?.({ tool: "register", outcome: "unavailable", durationMs: 0 });
    } catch {
      /* diagnostics must never break Trips */
    }
    return () => {};
  }
  return registerTripsWebmcp(runtime, host);
}
