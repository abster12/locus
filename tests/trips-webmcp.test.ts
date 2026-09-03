import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TRIPS_WEBMCP_VERSION,
  attachTripsWebmcp,
  detectTripsWebmcpRuntime,
  registerTripsWebmcp,
  type TripsWebmcpHost,
  type TripsWebmcpRuntime,
} from "../app/src/trips-webmcp.ts";
import type { TripAdvisoryView, TripDocument } from "../server/trips/module.ts";

type RegisteredTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: { readOnlyHint?: boolean; untrustedContentHint?: boolean };
  execute: (input: unknown) => unknown | Promise<unknown>;
};

const NINE_TOOLS = [
  "apply_trip_changes",
  "build_trip_draft",
  "create_trip",
  "get_trip",
  "get_trip_share_preview",
  "list_trips",
  "present_trip_recommendations",
  "search_trip_sources",
  "validate_trip",
];

function fakeRuntime() {
  const tools = new Map<string, RegisteredTool>();
  const runtime: TripsWebmcpRuntime = {
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
  const state = { visibleTripId: null as string | null, reviewRequested: false, surface: "document" as "index" | "setup" | "document" };
  const calls = {
    list: 0,
    get: [] as string[],
    search: [] as string[],
    create: [] as Record<string, unknown>[],
    apply: [] as Array<{ tripId: string; input: Record<string, unknown> }>,
    present: [] as unknown[],
    review: [] as Array<{ tripId: string; input: Record<string, unknown> }>,
  };
  const trips = new Map<string, TripDocument>();
  const logs: Array<Record<string, unknown>> = [];
  const host: TripsWebmcpHost = {
    surface: () => state.surface,
    getVisibleTripId: () => state.visibleTripId,
    reviewRequested: () => state.reviewRequested,
    consumeReviewIntent: () => {
      state.reviewRequested = false;
    },
    async listTrips() {
      calls.list += 1;
      return { trips: [...trips.values()].map((trip) => ({ id: trip.id, title: trip.title })) };
    },
    async getTrip(tripId) {
      calls.get.push(tripId);
      return trips.get(tripId) ?? null;
    },
    async searchSources(q) {
      calls.search.push(q);
      return { items: [{ id: "item-1", title: "Kyoto tea guide", source: "x" }], places: [{ id: "place-1", name: "Fushimi Inari", kind: "sight" }] };
    },
    async createTrip(setup) {
      calls.create.push(setup);
      return { trip: { id: "new-trip", revision: 1 } as unknown as TripDocument };
    },
    async applyChanges(tripId, input) {
      calls.apply.push({ tripId, input: { ...input } });
      return {
        trip: { id: tripId, revision: input.expectedRevision + 1 } as unknown as TripDocument,
        changeset: { id: "cs-1" },
        replayed: false,
        canUndo: true,
        canRedo: false,
      };
    },
    async recordReview(tripId, input) {
      calls.review.push({ tripId, input: { ...input } });
      return { trip: minimalTrip({ id: tripId, advisories: [advisory() as unknown as TripAdvisoryView] }), replayed: false };
    },
    present(panel) {
      calls.present.push(panel);
    },
    async previewShare(tripId) {
      return { snapshot: { tripId, title: "preview" } };
    },
    log(entry) {
      logs.push({ ...entry });
    },
  };
  return { host, state, trips, calls, logs };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`http ${status}`), { status });
}

function advisory(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "adv-1",
    tripId: "trip-1",
    reviewedRevision: 3,
    category: "strain",
    severity: "concern",
    opinion: "Tuesday may feel rushed",
    rationale: "Four timed stops with no gap for lunch",
    dayRefs: ["day-1"],
    stopRefs: [],
    actor: "agent",
    createdAt: "2026-09-02T00:00:00.000Z",
    dismissedAt: null,
    ...overrides,
  };
}

function minimalTrip(overrides: Partial<TripDocument> = {}): TripDocument {
  return {
    id: "trip-1",
    libraryId: "local",
    title: "Kyoto in October",
    destination: "Kyoto",
    timezone: "Asia/Tokyo",
    startDate: "2026-10-12",
    endDate: "2026-10-12",
    durationDays: 1,
    travelers: null,
    context: {
      lodgingAnchors: [],
      pace: null,
      mobility: null,
      budget: null,
      mealPreferences: [],
      interests: [],
      mustDos: [],
      hardConstraints: [],
    },
    revision: 3,
    archivedAt: null,
    days: [{ id: "day-1", position: 0, date: "2026-10-12", label: "Day 1", theme: null, stops: [] }],
    unscheduled: [],
    advisories: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  } as TripDocument;
}

function stop(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    dayId: "day-1",
    position: 0,
    content: { kind: "outside", title: `Stop ${id}`, notes: null, url: null },
    resolved: null,
    broken: false,
    state: "confirmed",
    provenance: { actor: "user", via: "manual" },
    publicNotes: "",
    privateNotes: "",
    timeWindow: null,
    durationMinutes: null,
    reservation: null,
    storedFacts: [],
    alternatives: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-01T00:00:00.000Z",
    ...overrides,
  };
}

function assertNoLibraryFields(schema: Record<string, unknown>, path = "schema"): void {
  const properties = schema.properties as Record<string, unknown> | undefined;
  if (properties) {
    for (const [key, value] of Object.entries(properties)) {
      assert.ok(!["libraryId", "library_id", "actor"].includes(key), `${path} must not accept ${key}`);
      if (value && typeof value === "object") assertNoLibraryFields(value as Record<string, unknown>, `${path}.${key}`);
    }
  }
  for (const key of ["items", "oneOf", "anyOf"]) {
    const branch = schema[key];
    if (Array.isArray(branch)) {
      for (const [index, value] of branch.entries()) {
        if (value && typeof value === "object") assertNoLibraryFields(value as Record<string, unknown>, `${path}.${key}[${index}]`);
      }
    }
  }
}

test("registers exactly the nine Trips tools and never a consequential one", () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state } = fakeHost();
  state.visibleTripId = "trip-1";
  const cleanup = registerTripsWebmcp(runtime, host);
  assert.deepEqual([...tools.keys()].sort(), NINE_TOOLS);
  for (const tool of tools.values()) {
    assert.equal(typeof tool.description, "string");
    assert.ok(tool.description.length > 20, `${tool.name} must describe itself`);
    assert.equal(tool.inputSchema.type, "object");
    assert.equal(tool.inputSchema.additionalProperties, false);
    assertNoLibraryFields(tool.inputSchema, tool.name);
  }
  // Forbidden consequential abilities never register.
  for (const forbidden of ["delete_trip", "publish_trip", "revoke_share", "update_shared_version", "share_trip", "publish_trip_share", "revoke_trip_share", "undo_trip_changes", "redo_trip_changes", "confirm_trip_changes"]) {
    assert.ok(!tools.has(forbidden), `${forbidden} must not exist`);
  }
  cleanup();
  assert.equal(tools.size, 0, "cleanup removes every tool");
});

test("the Trips index only exposes list, search, and create", () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state } = fakeHost();
  state.surface = "index";
  const cleanup = registerTripsWebmcp(runtime, host);
  assert.deepEqual([...tools.keys()].sort(), ["create_trip", "list_trips", "search_trip_sources"]);
  cleanup();
  state.surface = "setup";
  const cleanupSetup = registerTripsWebmcp(runtime, host);
  assert.deepEqual([...tools.keys()].sort(), ["create_trip", "list_trips", "search_trip_sources"]);
  cleanupSetup();
});

test("unknown input keys including library and actor fields are ignored and never forwarded", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, calls } = fakeHost();
  state.visibleTripId = "trip-1";
  const cleanup = registerTripsWebmcp(runtime, host);
  const list = tools.get("list_trips")!;
  const listed = (await list.execute({ libraryId: "hosted-b", actor: "agent" })) as { ok: boolean };
  assert.equal(listed.ok, true, "unknown keys are ignored, like the Reading adapter");
  const apply = tools.get("apply_trip_changes")!;
  await apply.execute({
    expectedRevision: 1,
    clientMutationId: "m",
    operations: [{ type: "removeStop", stopId: "s" }],
    libraryId: "hosted-b",
    actor: "agent",
  });
  assert.equal(calls.apply.length, 1);
  const forwarded = calls.apply[0]!.input as Record<string, unknown>;
  assert.ok(!("libraryId" in forwarded), "library identity never reaches the module seam");
  assert.ok(!("actor" in forwarded), "actor never travels through tool input");
  assert.equal(calls.list, 1);
  cleanup();
});

test("list_trips returns bounded summaries through the host", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, trips } = fakeHost();
  for (let index = 0; index < 60; index += 1) trips.set(`t${index}`, minimalTrip({ id: `t${index}` }));
  const cleanup = registerTripsWebmcp(runtime, host);
  const result = (await tools.get("list_trips")!.execute({})) as { ok: boolean; trips: unknown[]; capabilityVersion: number };
  assert.equal(result.ok, true);
  assert.equal(result.capabilityVersion, TRIPS_WEBMCP_VERSION);
  assert.equal(result.trips.length, 50, "summaries are capped");
  cleanup();
});

test("get_trip defaults to the visible document, accepts an explicit id, and is honest about missing documents", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, trips, calls } = fakeHost();
  trips.set("trip-1", minimalTrip());
  const cleanup = registerTripsWebmcp(runtime, host);
  const get = tools.get("get_trip")!;

  assert.deepEqual(await get.execute({}), { ok: false, error: "not-found" }, "no visible document is a stable not-found");

  state.visibleTripId = "trip-1";
  const visible = (await get.execute({})) as { ok: boolean; trip: TripDocument; advisories: unknown[] };
  assert.equal(visible.ok, true);
  assert.equal(visible.trip.id, "trip-1");
  assert.equal(visible.trip.revision, 3);
  assert.deepEqual(visible.advisories, [], "advisory flags are reported (none exist yet)");

  const explicit = (await get.execute({ tripId: "trip-1" })) as { ok: boolean };
  assert.equal(explicit.ok, true);
  assert.deepEqual(await get.execute({ tripId: "invented" }), { ok: false, error: "not-found" });
  assert.deepEqual(calls.get, ["trip-1", "trip-1"]);
  cleanup();
});

test("search_trip_sources stays bounded and passes only the query", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, calls } = fakeHost();
  const cleanup = registerTripsWebmcp(runtime, host);
  const search = tools.get("search_trip_sources")!;
  const result = (await search.execute({ q: "kyoto" })) as { ok: boolean; items: unknown[]; places: unknown[] };
  assert.equal(result.ok, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.places.length, 1);
  assert.deepEqual(calls.search, ["kyoto"]);
  assert.deepEqual(await search.execute({ q: "x".repeat(121) }), { ok: false, error: "invalid" });
  const empty = (await search.execute({})) as { ok: boolean; items: unknown[]; places: unknown[] };
  assert.equal(empty.ok, true);
  assert.deepEqual(empty.items, result.items);
  cleanup();
});

test("create_trip forwards the caller-owned mutation id, rejects id-less creates, and maps rejections to invalid", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, calls } = fakeHost();
  const cleanup = registerTripsWebmcp(runtime, host);
  const create = tools.get("create_trip")!;
  const setup = { destination: "Kyoto", durationDays: 3, clientMutationId: "c-1", context: { pace: "slow" } };
  const result = (await create.execute(setup)) as { ok: boolean; trip: { id: string } };
  assert.equal(result.ok, true);
  assert.equal(result.trip.id, "new-trip");
  assert.deepEqual(calls.create[0], setup, "the module receives the exact setup and owns validation");

  // The caller owns the id so a retry can replay the server receipt: missing,
  // empty, or over-long ids are invalid and never reach the host.
  assert.deepEqual(await create.execute({ destination: "Kyoto" }), { ok: false, error: "invalid" });
  assert.deepEqual(await create.execute({ destination: "Kyoto", clientMutationId: "" }), { ok: false, error: "invalid" });
  assert.deepEqual(await create.execute({ destination: "Kyoto", clientMutationId: "x".repeat(101) }), { ok: false, error: "invalid" });
  assert.equal(calls.create.length, 1, "id-less creates never reach the host");

  const failing = fakeHost();
  failing.host.createTrip = async () => {
    throw httpError(400);
  };
  const cleanup2 = registerTripsWebmcp(runtime, failing.host);
  assert.deepEqual(
    await tools.get("create_trip")!.execute({ destination: "Kyoto", clientMutationId: "c-2" }),
    { ok: false, error: "invalid" },
    "a server payload rejection maps to invalid",
  );
  cleanup2();
  cleanup();
});

test("apply_trip_changes targets the visible document, forwards exact fields, and maps stable errors", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, calls } = fakeHost();
  state.visibleTripId = "trip-1";
  const cleanup = registerTripsWebmcp(runtime, host);
  const apply = tools.get("apply_trip_changes")!;
  const operations = [{ type: "addStop", dayId: "day-1", content: { kind: "hole", request: "quiet dinner" } }];

  const result = (await apply.execute({ expectedRevision: 2, clientMutationId: "m-1", instruction: "add a dinner slot", operations })) as {
    ok: boolean;
    trip: { id: string; revision: number };
    replayed: boolean;
  };
  assert.equal(result.ok, true);
  assert.equal(result.trip.revision, 3);
  assert.equal(result.replayed, false);
  assert.deepEqual(calls.apply[0], { tripId: "trip-1", input: { expectedRevision: 2, clientMutationId: "m-1", instruction: "add a dinner slot", operations } });

  // An arbitrary payload id cannot target a hidden Trip Document.
  assert.deepEqual(await apply.execute({ tripId: "trip-2", expectedRevision: 1, clientMutationId: "m-2", operations }), {
    ok: false,
    error: "not-found",
  });
  assert.equal(calls.apply.length, 1);

  // Stable stale/invalid/not-found mappings.
  const stale = fakeHost();
  stale.state.visibleTripId = "trip-1";
  stale.host.applyChanges = async () => {
    throw httpError(409);
  };
  const staleCleanup = registerTripsWebmcp(runtime, stale.host);
  assert.deepEqual(
    await tools.get("apply_trip_changes")!.execute({ tripId: "trip-1", expectedRevision: 1, clientMutationId: "m", operations }),
    { ok: false, error: "stale" },
  );
  staleCleanup();

  const invalid = fakeHost();
  invalid.state.visibleTripId = "trip-1";
  invalid.host.applyChanges = async () => {
    throw httpError(400);
  };
  const invalidCleanup = registerTripsWebmcp(runtime, invalid.host);
  assert.deepEqual(
    await tools.get("apply_trip_changes")!.execute({ tripId: "trip-1", expectedRevision: 1, clientMutationId: "m", operations: [{ type: "bogus" }] }),
    { ok: false, error: "invalid" },
  );
  invalidCleanup();

  const missing = fakeHost();
  missing.state.visibleTripId = "trip-1";
  missing.host.applyChanges = async () => {
    throw httpError(404);
  };
  const missingCleanup = registerTripsWebmcp(runtime, missing.host);
  assert.deepEqual(
    await tools.get("apply_trip_changes")!.execute({ tripId: "trip-1", expectedRevision: 1, clientMutationId: "m", operations }),
    { ok: false, error: "not-found" },
  );
  missingCleanup();

  assert.deepEqual(await apply.execute({ expectedRevision: 1, clientMutationId: "m-3" }), { ok: false, error: "invalid" });
  assert.deepEqual(await apply.execute({ clientMutationId: "m-4", operations }), { ok: false, error: "invalid" });
  assert.deepEqual(await apply.execute({ expectedRevision: 1, operations }), { ok: false, error: "invalid" });

  const addStopSchema = ((apply.inputSchema.properties as { operations: { items: { oneOf: Array<{ properties: Record<string, unknown>; required: string[] }> } } }).operations.items.oneOf[0]!);
  assert.deepEqual(addStopSchema.properties.state, { type: "string", enum: ["confirmed", "draft"] });
  assert.equal(addStopSchema.required.includes("state"), false);
  assert.equal("actor" in addStopSchema.properties, false);

  const drafted = [{ type: "addStop", dayId: "day-1", content: { kind: "outside", title: "Tea tasting", notes: null, url: null }, state: "draft" }];
  await apply.execute({ expectedRevision: 4, clientMutationId: "m-5", operations: drafted, actor: "user" });
  const forwardedDraft = calls.apply.at(-1)! as { input: Record<string, unknown> };
  assert.deepEqual(forwardedDraft.input.operations, drafted, "optional addStop.state round-trips");
  assert.ok(!("actor" in forwardedDraft.input), "tool input never chooses the actor");
  cleanup();
});

test("open-ended prose without typed operations is rejected and names the recommendation contract", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, calls } = fakeHost();
  state.visibleTripId = "trip-1";
  const cleanup = registerTripsWebmcp(runtime, host);
  const apply = tools.get("apply_trip_changes")!;
  const rejection = (await apply.execute({
    expectedRevision: 1,
    clientMutationId: "m-1",
    instruction: "find a quiet dinner near Gion",
    operations: [],
  })) as { ok: boolean; error: string; detail?: string };
  assert.equal(rejection.ok, false);
  assert.equal(rejection.error, "invalid");
  assert.match(rejection.detail ?? "", /present_trip_recommendations/);
  assert.equal(calls.apply.length, 0, "nothing reaches the document");
  cleanup();
});

test("validate_trip reports deterministic saved-data issues and a clean document", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, trips } = fakeHost();
  state.visibleTripId = "trip-1";
  const cleanup = registerTripsWebmcp(runtime, host);
  const validate = tools.get("validate_trip")!;

  trips.set(
    "trip-1",
    minimalTrip({
      days: [
        {
          id: "day-1",
          position: 0,
          date: "2026-10-12",
          label: "Day 1",
          theme: null,
          stops: [
            stop("s-1", { position: 0, timeWindow: "09:00-11:00", content: { kind: "outside", title: "Temple", notes: null, url: null } }),
            stop("s-1", { position: 1, timeWindow: "10:00-12:00", content: { kind: "outside", title: "Market", notes: null, url: null } }),
            stop("s-3", { position: 3, content: { kind: "hole", request: "quiet dinner" } }),
          ] as unknown as TripDocument["days"][number]["stops"],
        },
      ],
      unscheduled: [stop("s-4", { dayId: null, position: 0 })] as unknown as TripDocument["unscheduled"],
    }),
  );
  const report = (await validate.execute({})) as {
    ok: boolean;
    tripId: string;
    revision: number;
    valid: boolean;
    issues: Array<{ kind: string; detail?: string }>;
  };
  assert.equal(report.ok, true);
  assert.equal(report.tripId, "trip-1");
  assert.equal(report.revision, 3);
  assert.equal(report.valid, false);
  const kinds = report.issues.map((issue) => issue.kind).sort();
  assert.deepEqual(kinds, ["duplicate_identity", "ordering", "overlap", "unfilled_hole"]);
  assert.match(report.issues.find((issue) => issue.kind === "overlap")!.detail ?? "", /Temple overlaps Market/);
  assert.match(report.issues.find((issue) => issue.kind === "unfilled_hole")!.detail ?? "", /quiet dinner/);

  trips.set("clean", minimalTrip({ id: "clean" }));
  state.visibleTripId = "clean";
  const clean = (await validate.execute({})) as { valid: boolean; issues: unknown[] };
  assert.equal(clean.valid, true);
  assert.deepEqual(clean.issues, []);

  assert.deepEqual(await validate.execute({ tripId: "invented" }), { ok: false, error: "not-found" });
  cleanup();
});

test("diagnostics logs stay bounded and never carry payload text", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, logs } = fakeHost();
  const cleanup = registerTripsWebmcp(runtime, host);
  await tools.get("list_trips")!.execute({});
  assert.equal(logs.length, 1);
  const entry = logs[0] as { tool: string; outcome: string; durationMs: number; resultCount: number };
  assert.deepEqual(Object.keys(entry).sort(), ["durationMs", "outcome", "resultCount", "tool"]);
  assert.equal(entry.tool, "list_trips");
  assert.equal(entry.outcome, "ok");
  assert.equal(entry.resultCount, 0);
  cleanup();
});

test("cleanup aborts registrations and re-registering never duplicates", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host } = fakeHost();
  const cleanup = registerTripsWebmcp(runtime, host);
  assert.equal(tools.size, 9);
  cleanup();
  assert.equal(tools.size, 0);
  const cleanup2 = registerTripsWebmcp(runtime, host);
  assert.equal(tools.size, 9, "re-registration replaces the previous set without duplicates");
  cleanup2();
  assert.equal(tools.size, 0);
});

test("detect returns null without a usable runtime and attach degrades to a no-op", () => {
  assert.equal(detectTripsWebmcpRuntime({}), null);
  assert.equal(detectTripsWebmcpRuntime({ document: { modelContext: {} } }), null);
  assert.equal(detectTripsWebmcpRuntime({ navigator: {} }), null);
  const logs: string[] = [];
  const cleanup = attachTripsWebmcp(
    {
      surface: () => "index",
      getVisibleTripId: () => null,
      listTrips: async () => ({ trips: [] }),
      getTrip: async () => null,
      searchSources: async () => ({ items: [], places: [] }),
      createTrip: async () => ({ trip: null as unknown as TripDocument }),
      applyChanges: async () => {
        throw new Error("never called without a runtime");
      },
      present: () => {},
      previewShare: async () => ({ snapshot: {} }),
      reviewRequested: () => false,
      recordReview: async () => {
        throw new Error("never called without a runtime");
      },
      log: (entry) => logs.push(entry.outcome),
    },
    {},
  );
  cleanup();
  assert.deepEqual(logs, ["unavailable"]);
});

const REVIEW_TOOL = "record_trip_review";

const REVIEW_FLAGS = [
  {
    category: "strain",
    severity: "concern",
    opinion: "Tuesday may feel rushed",
    rationale: "Four timed stops with no gap for lunch",
    dayRefs: ["day-1"],
    stopRefs: [],
  },
];

test("record_trip_review exists only after the user asks for a review of the visible document", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state } = fakeHost();

  // No visible document: the review tool never registers, requested or not.
  state.visibleTripId = null;
  const cleanupNone = registerTripsWebmcp(runtime, host);
  assert.equal(tools.size, 9);
  assert.ok(!tools.has(REVIEW_TOOL));
  state.reviewRequested = true;
  const cleanupRequested = registerTripsWebmcp(runtime, host);
  assert.equal(tools.size, 9, "asking for a review without a visible document changes nothing");
  cleanupRequested();
  cleanupNone();

  // Visible document, no user request: nine tools.
  state.reviewRequested = false;
  state.visibleTripId = "trip-1";
  const cleanupVisible = registerTripsWebmcp(runtime, host);
  assert.equal(tools.size, 9);
  assert.ok(!tools.has(REVIEW_TOOL), "opening a trip never arms the review tool");
  cleanupVisible();

  // Visible document after an explicit ask: ten tools, one registration each.
  state.reviewRequested = true;
  const cleanup = registerTripsWebmcp(runtime, host);
  assert.equal(tools.size, 10);
  assert.ok(tools.has(REVIEW_TOOL));
  const record = tools.get(REVIEW_TOOL)!;
  assert.match(record.description, /explicitly/i);
  assert.match(record.description, /get_trip/i);
  assert.match(record.description, /no route durations/i);
  assert.equal((record.inputSchema as { additionalProperties: boolean }).additionalProperties, false);
  assertNoLibraryFields(record.inputSchema, REVIEW_TOOL);
  cleanup();
  assert.equal(tools.size, 0, "cleanup removes the review tool with the rest");
});

test("record_trip_review forwards the exact payload and maps stable errors", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, calls } = fakeHost();
  state.visibleTripId = "trip-1";
  state.reviewRequested = true;
  const cleanup = registerTripsWebmcp(runtime, host);
  const record = tools.get(REVIEW_TOOL)!;

  const result = (await record.execute({
    expectedRevision: 3,
    clientMutationId: "rev-1",
    flags: REVIEW_FLAGS,
    libraryId: "hosted-b",
    actor: "user",
  })) as { ok: boolean; tripId: string; replayed: boolean; advisories: unknown[] };
  assert.equal(result.ok, true);
  assert.equal(result.tripId, "trip-1");
  assert.equal(result.replayed, false);
  assert.equal(result.advisories.length, 1);
  assert.deepEqual(
    calls.review[0],
    { tripId: "trip-1", input: { expectedRevision: 3, clientMutationId: "rev-1", flags: REVIEW_FLAGS } },
    "trusted keys are dropped, data fields forwarded unchanged",
  );

  const invalidHost = fakeHost();
  invalidHost.state.visibleTripId = "trip-1";
  invalidHost.state.reviewRequested = true;
  invalidHost.host.recordReview = async () => {
    throw httpError(400);
  };
  const cleanupInvalid = registerTripsWebmcp(runtime, invalidHost.host);
  assert.deepEqual(await tools.get(REVIEW_TOOL)!.execute({ expectedRevision: 3, clientMutationId: "r", flags: REVIEW_FLAGS }), {
    ok: false,
    error: "invalid",
  });
  cleanupInvalid();

  const staleHost = fakeHost();
  staleHost.state.visibleTripId = "trip-1";
  staleHost.state.reviewRequested = true;
  staleHost.host.recordReview = async () => {
    throw httpError(409);
  };
  const cleanupStale = registerTripsWebmcp(runtime, staleHost.host);
  assert.deepEqual(await tools.get(REVIEW_TOOL)!.execute({ expectedRevision: 3, clientMutationId: "r", flags: REVIEW_FLAGS }), {
    ok: false,
    error: "stale",
  });
  cleanupStale();

  // Structural input problems are invalid before the host is called.
  assert.deepEqual(await record.execute({ expectedRevision: 3, clientMutationId: "r", flags: [] }), { ok: false, error: "invalid" });
  assert.deepEqual(await record.execute({ clientMutationId: "r", flags: REVIEW_FLAGS }), { ok: false, error: "invalid" });
  cleanup();
});

test("get_trip reports the document's current advisory flags", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, trips } = fakeHost();
  state.visibleTripId = "trip-1";
  trips.set("trip-1", minimalTrip({ advisories: [advisory() as unknown as TripAdvisoryView] }));
  const cleanup = registerTripsWebmcp(runtime, host);
  const got = (await tools.get("get_trip")!.execute({})) as { ok: boolean; advisories: Array<Record<string, unknown>> };
  assert.equal(got.ok, true);
  assert.equal(got.advisories.length, 1);
  assert.equal(got.advisories[0]!.category, "strain");
  assert.equal(got.advisories[0]!.reviewedRevision, 3);
  cleanup();
});

test("build_trip_draft wraps the exact-change engine: Draft stops on Unscheduled, bounded sources, sanitized inferences", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, calls } = fakeHost();
  state.visibleTripId = "trip-1";
  const cleanup = registerTripsWebmcp(runtime, host);
  const build = tools.get("build_trip_draft")!;

  const result = (await build.execute({
    expectedRevision: 3,
    clientMutationId: "build-1",
    instruction: "  plan a base itinerary from my saved Kyoto places  ",
    selectedSources: [
      { kind: "item", id: "item-1" },
      { kind: "place", id: "place-1" },
    ],
    inferredPreferences: [{ text: "  prefers slow mornings \u0007", basis: "pace: slow mornings" }],
    libraryId: "hosted-b",
    actor: "user",
  })) as { ok: boolean; addedStops: number; replayed: boolean };
  assert.equal(result.ok, true);
  assert.equal(result.addedStops, 2);
  assert.equal(result.replayed, false);
  assert.deepEqual(calls.present, [], "the build tool never presents");
  const forwarded = calls.apply[0]! as { tripId: string; input: Record<string, unknown> };
  assert.equal(forwarded.tripId, "trip-1");
  const input = forwarded.input as { expectedRevision: number; clientMutationId: string; instruction: string; operations: Array<Record<string, unknown>>; inferredPreferences?: Array<Record<string, string>> };
  assert.equal(input.expectedRevision, 3);
  assert.equal(input.clientMutationId, "build-1");
  assert.equal(input.instruction, "plan a base itinerary from my saved Kyoto places");
  assert.equal(input.operations.length, 2, "one stop per selected source");
  for (const operation of input.operations) {
    assert.equal(operation.type, "addStop");
    assert.equal(operation.dayId, null, "stops land on Unscheduled");
  }
  assert.deepEqual(input.operations[0]!.content, { kind: "item", itemId: "item-1" });
  assert.deepEqual(input.operations[1]!.content, { kind: "place", placeId: "place-1" });
  assert.deepEqual(input.inferredPreferences, [{ text: "prefers slow mornings", basis: "pace: slow mornings" }], "inferences are sanitized and forwarded on the same changeset");

  // Omitted inferences stay absent — the tool never invents preferences.
  await build.execute({ expectedRevision: 3, clientMutationId: "build-2", instruction: "build it", selectedSources: [{ kind: "item", id: "item-1" }] });
  assert.ok(!("inferredPreferences" in (calls.apply[1]!.input as Record<string, unknown>)), "no inferredPreferences field when the agent supplied none");

  // Structural bounds are invalid before the host is called.
  assert.deepEqual(await build.execute({ expectedRevision: 1, clientMutationId: "b", instruction: "", selectedSources: [{ kind: "item", id: "x" }] }), { ok: false, error: "invalid" });
  assert.deepEqual(await build.execute({ expectedRevision: 1, clientMutationId: "b", instruction: "go", selectedSources: [] }), { ok: false, error: "invalid" });
  assert.deepEqual(await build.execute({ expectedRevision: 1, clientMutationId: "b", instruction: "go", selectedSources: [{ kind: "outside", id: "x" }] }), { ok: false, error: "invalid" });
  assert.deepEqual(
    await build.execute({ expectedRevision: 1, clientMutationId: "b", instruction: "go", selectedSources: Array.from({ length: 13 }, (_, i) => ({ kind: "item", id: `i${i}` })) }),
    { ok: false, error: "invalid" },
  );
  assert.deepEqual(await build.execute({ expectedRevision: 1, clientMutationId: "b", instruction: "go", selectedSources: [{ kind: "item", id: "x" }], inferredPreferences: [{ text: "t" }] }), { ok: false, error: "invalid" });
  assert.equal(calls.apply.length, 2, "invalid input never reaches the document");

  // Stable error mappings from the module seam.
  const stale = fakeHost();
  stale.state.visibleTripId = "trip-1";
  stale.host.applyChanges = async () => {
    throw httpError(409);
  };
  const staleCleanup = registerTripsWebmcp(runtime, stale.host);
  assert.deepEqual(
    await tools.get("build_trip_draft")!.execute({ expectedRevision: 1, clientMutationId: "b", instruction: "go", selectedSources: [{ kind: "item", id: "x" }] }),
    { ok: false, error: "stale" },
  );
  staleCleanup();

  const missing = fakeHost();
  missing.host.applyChanges = async () => {
    throw httpError(404);
  };
  const missingCleanup = registerTripsWebmcp(runtime, missing.host);
  assert.deepEqual(
    await tools.get("build_trip_draft")!.execute({ tripId: "gone", expectedRevision: 1, clientMutationId: "b", instruction: "go", selectedSources: [{ kind: "item", id: "x" }] }),
    { ok: false, error: "not-found" },
  );
  missingCleanup();
  cleanup();
});

test("present_trip_recommendations requires exactly three rich options and writes nothing", async () => {
  const { runtime, tools } = fakeRuntime();
  const { host, state, calls } = fakeHost();
  state.visibleTripId = "trip-1";
  const cleanup = registerTripsWebmcp(runtime, host);
  const present = tools.get("present_trip_recommendations")!;
  const operation = { type: "addStop", dayId: "day-1", content: { kind: "outside", title: "Tea tasting", notes: null, url: null } };
  const option = { opinion: "Best fit", summary: "Day 1 tea tasting after the temple walk.", fit: "Near the temple", tradeoff: "Booked out", basis: "2 saved Library sources", effect: "No known conflict", operations: [operation] };

  const result = (await present.execute({ request: "quiet dinner near Gion", options: [option, { ...option, opinion: "Adventurous" }, { ...option, opinion: "Lowest pressure" }] })) as {
    ok: boolean;
    presented: boolean;
    optionCount: number;
  };
  assert.equal(result.ok, true);
  assert.equal(result.presented, true);
  assert.equal(result.optionCount, 3);
  assert.equal(calls.apply.length, 0, "presentation never writes the Trip Document");
  assert.equal(calls.create.length, 0);
  assert.equal(calls.present.length, 1);
  const panel = calls.present[0] as { tripId: string; request: string; options: Array<Record<string, unknown>> };
  assert.equal(panel.tripId, "trip-1");
  assert.equal(panel.request, "quiet dinner near Gion");
  assert.equal(panel.options.length, 3);
  assert.deepEqual(panel.options[0]!.operations, [operation], "typed operations pass through for the human to choose");
  assert.equal(panel.options[0]!.summary, "Day 1 tea tasting after the temple walk.");
  assert.deepEqual(
    await present.execute({ request: "r", options: [{ ...option, summary: undefined }, option, option] }),
    { ok: false, error: "invalid" },
    "a summary is required so the card can name every proposed day",
  );

  // Not exactly three is rejected before presentation.
  assert.deepEqual(await present.execute({ request: "r", options: [option, option] }), { ok: false, error: "invalid" });
  assert.deepEqual(await present.execute({ request: "r", options: [option, option, option, option] }), { ok: false, error: "invalid" });
  assert.deepEqual(await present.execute({ request: "r", options: [] }), { ok: false, error: "invalid" });
  // Missing option fields are invalid.
  assert.deepEqual(await present.execute({ request: "r", options: [{ ...option, tradeoff: undefined }, option, option] }), { ok: false, error: "invalid" });
  // Empty or missing operations are invalid.
  assert.deepEqual(await present.execute({ request: "r", options: [{ ...option, operations: [] }, option, option] }), { ok: false, error: "invalid" });
  assert.deepEqual(await present.execute({ request: "r", options: [{ ...option, operations: "add everything" }, option, option] }), { ok: false, error: "invalid" });
  assert.equal(calls.present.length, 1, "rejected panels never reach the drawer");
  assert.deepEqual(await present.execute({ options: [option, option, option] }), { ok: false, error: "invalid" }, "a request is required");

  // No visible document is a stable not-found, like get_trip.
  state.visibleTripId = null;
  assert.deepEqual(await present.execute({ request: "r", options: [option, option, option] }), { ok: false, error: "not-found" });
  cleanup();
});
