import { test } from "node:test";
import assert from "node:assert/strict";
import { setupBodyFromForm } from "../app/src/trips-index.tsx";
import { resolveTripView } from "../app/src/trips-document.tsx";
import { parseRecommendations } from "../app/src/trips-recommendations.tsx";
import { buildAddOrFillOps } from "../app/src/trips-stop-ops.ts";
import { moveStopOp } from "../app/src/trips-stop-row.tsx";
import { updateStopOps } from "../app/src/trips-stop-editor.tsx";
import { libraryStopOps } from "../app/src/trips-library-picker.tsx";
import { holeStopOps, placeholderStopOps } from "../app/src/trips-stop-forms.tsx";
import { runPlannerMutation } from "../app/src/trips-planner-mutate.ts";
import type { TripDocument, TripMutationResult, TripStopContent } from "../app/src/api.ts";

type SetupForm = Parameters<typeof setupBodyFromForm>[0];

function form(overrides: Partial<SetupForm> = {}): SetupForm {
  return {
    destination: "Kyoto",
    title: "",
    startDate: "",
    endDate: "",
    duration: "",
    timezone: "",
    travelers: "",
    lodgingAnchors: "",
    pace: "",
    mobility: "",
    budget: "",
    mealPreferences: "",
    interests: "",
    mustDos: "",
    hardConstraints: "",
    ...overrides,
  };
}

test("setupBodyFromForm trims the destination and maps empty optionals to null", () => {
  const body = setupBodyFromForm(form({ destination: "  Kyoto, Japan  " }));
  assert.equal(body.destination, "Kyoto, Japan");
  assert.equal(body.title, null);
  assert.equal(body.startDate, null);
  assert.equal(body.endDate, null);
  assert.equal(body.durationDays, null);
  assert.equal(body.timezone, null);
  assert.equal(body.travelers, null);
  assert.deepEqual(body.context, {
    lodgingAnchors: [],
    pace: null,
    mobility: null,
    budget: null,
    mealPreferences: [],
    interests: [],
    mustDos: [],
    hardConstraints: [],
  });
});

test("setupBodyFromForm splits newline lists and numbers the duration", () => {
  const body = setupBodyFromForm(
    form({
      duration: "5",
      title: " Autumn trip ",
      mustDos: "Fushimi Inari\n Nishiki Market \n\n",
      interests: "temples",
    }),
  );
  assert.equal(body.durationDays, 5);
  assert.equal(body.title, "Autumn trip");
  assert.deepEqual(body.context!.mustDos, ["Fushimi Inari", "Nishiki Market"]);
  assert.deepEqual(body.context!.interests, ["temples"]);
});

test("resolveTripView picks overview and schedule from the hash and days by id", () => {
  const trip = { days: [{ id: "day-2" }, { id: "day-1" }] } as unknown as TripDocument;
  assert.deepEqual(resolveTripView(null, ""), { view: "overview", dayId: null });
  assert.deepEqual(resolveTripView(trip, "overview"), { view: "overview", dayId: null });
  assert.deepEqual(resolveTripView(trip, "schedule"), { view: "schedule", dayId: null });
  assert.deepEqual(resolveTripView(trip, "day-2"), { view: "day", dayId: "day-2" });
  assert.deepEqual(resolveTripView(trip, "not-a-day"), { view: "overview", dayId: null }, "unknown views fall back to overview");
  assert.deepEqual(resolveTripView(null, "day-2"), { view: "overview", dayId: null }, "day hashes need a loaded trip");
});

test("parseRecommendations accepts exactly three bounded options and rejects junk", () => {
  const option = {
    opinion: "Go early",
    fit: "cooler light",
    tradeoff: "crowds return later",
    basis: "saved post",
    effect: "busier afternoon",
    operations: [{ type: "addStop", dayId: "day-1" }],
  };
  const panel = parseRecommendations({ tripId: "trip-1", request: "quiet morning", options: [option, option, option] });
  assert.ok(panel);
  assert.equal(panel.tripId, "trip-1");
  assert.equal(panel.request, "quiet morning");
  assert.equal(panel.options.length, 3);
  assert.deepEqual(panel.options[0]!.operations, option.operations);

  assert.equal(parseRecommendations(null), null);
  assert.equal(parseRecommendations("nope"), null);
  assert.equal(parseRecommendations({ options: [option, option] }), null, "two options are not the presentation contract");
  assert.equal(parseRecommendations({ options: [option, option, option, option] }), null, "four options are not the presentation contract");
  assert.equal(parseRecommendations({ options: [option, option, "junk"] }), null);
  assert.equal(parseRecommendations({ options: [option, option, { ...option, operations: "not-array" }] }), null);
});

test("buildAddOrFillOps shares add vs fill placement for Library and placeholder", () => {
  const content: TripStopContent = { kind: "item", itemId: "item-1" };
  const outside: TripStopContent = { kind: "outside", title: "Nishiki", notes: null, url: null };
  const timing = { timeWindow: "09:00–11:00", durationMinutes: 90 };

  assert.deepEqual(buildAddOrFillOps({ dayId: "day-1", content }), [
    { type: "addStop", dayId: "day-1", content },
  ]);
  assert.deepEqual(buildAddOrFillOps({ dayId: "day-1", content, fill: { holeId: "hole-1" } }), [
    { type: "removeStop", stopId: "hole-1" },
    { type: "addStop", dayId: "day-1", content },
  ]);
  assert.deepEqual(
    buildAddOrFillOps({ dayId: "day-1", content, fill: { holeId: "hole-1", beforeStopId: "stop-2" } }),
    [
      { type: "removeStop", stopId: "hole-1" },
      { type: "addStop", dayId: "day-1", content, beforeStopId: "stop-2" },
    ],
  );
  assert.deepEqual(buildAddOrFillOps({ dayId: null, content: outside, timing }), [
    { type: "addStop", dayId: null, content: outside, ...timing },
  ]);
  assert.equal(
    "timeWindow" in buildAddOrFillOps({ dayId: "day-1", content })[0]!,
    false,
    "Library path omits timing",
  );
});

test("moveStopOp builds the row's up/down/to-day/to-Unscheduled ops", () => {
  assert.deepEqual(moveStopOp("stop-2", { beforeStopId: "stop-1" }), { type: "moveStop", stopId: "stop-2", beforeStopId: "stop-1" }, "up uses the previous stop");
  assert.deepEqual(moveStopOp("stop-1", { afterStopId: "stop-2" }), { type: "moveStop", stopId: "stop-1", afterStopId: "stop-2" }, "down uses the next stop");
  assert.deepEqual(moveStopOp("stop-1", { dayId: "day-3" }), { type: "moveStop", stopId: "stop-1", dayId: "day-3" }, "to-day sets dayId");
  assert.deepEqual(moveStopOp("stop-1", { dayId: null }), { type: "moveStop", stopId: "stop-1", dayId: null }, "Unscheduled is dayId null");
});

test("placeholderStopOps trims fields, fills holes, and refuses blank titles", () => {
  assert.deepEqual(
    placeholderStopOps({
      dayId: "day-1",
      title: "  Nishiki Market  ",
      notes: " go early ",
      url: " https://example.com ",
      timeWindow: " 09:00–11:00 ",
      duration: "90",
    }),
    [
      {
        type: "addStop",
        dayId: "day-1",
        content: { kind: "outside", title: "Nishiki Market", notes: "go early", url: "https://example.com" },
        timeWindow: "09:00–11:00",
        durationMinutes: 90,
      },
    ],
  );
  assert.deepEqual(placeholderStopOps({ dayId: null, title: "X", notes: "", url: "", timeWindow: "", duration: "" }), [
    { type: "addStop", dayId: null, content: { kind: "outside", title: "X", notes: null, url: null }, timeWindow: null, durationMinutes: null },
  ]);
  assert.deepEqual(
    placeholderStopOps({
      dayId: "day-2",
      fill: { holeId: "hole-1", beforeStopId: "stop-2" },
      title: "Kiyomizu",
      notes: "",
      url: "",
      timeWindow: "",
      duration: "",
    }),
    [
      { type: "removeStop", stopId: "hole-1" },
      {
        type: "addStop",
        dayId: "day-2",
        content: { kind: "outside", title: "Kiyomizu", notes: null, url: null },
        beforeStopId: "stop-2",
        timeWindow: null,
        durationMinutes: null,
      },
    ],
    "placeholder fill is remove+add at the hole's exact place, timing kept as null",
  );
  assert.equal(placeholderStopOps({ dayId: "day-1", title: "   ", notes: "x", url: "", timeWindow: "", duration: "" }), null, "blank title emits no ops");
});

test("holeStopOps emits a hole stop and refuses blank requests", () => {
  assert.deepEqual(holeStopOps({ dayId: "day-1", request: "  quiet dinner near Gion  " }), [
    { type: "addStop", dayId: "day-1", content: { kind: "hole", request: "quiet dinner near Gion" } },
  ]);
  assert.deepEqual(holeStopOps({ dayId: null, request: "x" }), [{ type: "addStop", dayId: null, content: { kind: "hole", request: "x" } }]);
  assert.equal(holeStopOps({ dayId: "day-1", request: "   " }), null, "blank request emits no ops");
});

test("libraryStopOps: item add is one addStop with no timing fields", () => {
  const ops = libraryStopOps({ dayId: "day-1", content: { kind: "item", itemId: "item-1" } });
  assert.deepEqual(ops, [{ type: "addStop", dayId: "day-1", content: { kind: "item", itemId: "item-1" } }]);
  assert.equal("timeWindow" in ops[0]!, false, "Library picks carry no time window");
  assert.equal("durationMinutes" in ops[0]!, false, "Library picks carry no duration");
});

test("libraryStopOps: place fill is remove+add at the hole's exact place", () => {
  assert.deepEqual(
    libraryStopOps({ dayId: "day-2", content: { kind: "place", placeId: "place-1" }, fill: { holeId: "hole-1", beforeStopId: "stop-2" } }),
    [
      { type: "removeStop", stopId: "hole-1" },
      { type: "addStop", dayId: "day-2", content: { kind: "place", placeId: "place-1" }, beforeStopId: "stop-2" },
    ],
  );
});

test("runPlannerMutation skips reentry while busy and never calls the action", async () => {
  let calls = 0;
  const outcome = await runPlannerMutation(
    true,
    async () => {
      calls += 1;
      throw new Error("must not run");
    },
    "Saved.",
  );
  assert.deepEqual(outcome, { status: "skipped" });
  assert.equal(calls, 0);
});

test("runPlannerMutation ok path carries trip, undo/redo flags, and the success note", async () => {
  const trip = { id: "trip-1", revision: 3 } as unknown as TripDocument;
  const result = { trip, changeset: {}, replayed: false, canUndo: true, canRedo: false } as TripMutationResult;
  const outcome = await runPlannerMutation(false, async () => result, "Undo applied.");
  assert.deepEqual(outcome, { status: "ok", trip, canUndo: true, canRedo: false, note: "Undo applied." });
});

test("runPlannerMutation replaces the success note when the changeset was replayed", async () => {
  const result = {
    trip: { id: "trip-1" } as unknown as TripDocument,
    changeset: {},
    replayed: true,
    canUndo: false,
    canRedo: false,
  } as TripMutationResult;
  const outcome = await runPlannerMutation(false, async () => result, "Undo applied.");
  assert.equal(outcome.status, "ok");
  assert.equal(outcome.status === "ok" && outcome.note, "Already saved.");
});

test("runPlannerMutation shapes error messages from Error and non-Error throws", async () => {
  const thrown = await runPlannerMutation(
    false,
    async () => {
      throw new Error("boom");
    },
    "Saved.",
  );
  assert.deepEqual(thrown, { status: "err", message: "boom" });
  const junk = await runPlannerMutation(
    false,
    async () => {
      throw "nope";
    },
    "Saved.",
  );
  assert.deepEqual(junk, { status: "err", message: "nope" });
});

const editBase = {
  stopId: "stop-1",
  title: "Nishiki Market",
  notes: "  go early  ",
  url: " https://example.com ",
  timeWindow: " 09:00–11:00 ",
  duration: "90",
  publicNotes: " public ",
  privateNotes: " private ",
  reservation: " table for two ",
  storedFacts: " fact a \n\n fact b ",
  alternatives: " alt a \n alt b ",
};

test("updateStopOps builds outside, hole, and Library-reference payloads", () => {
  const outside = updateStopOps({ ...editBase, content: { kind: "outside", title: "old", notes: null, url: null } });
  assert.deepEqual(outside, [
    {
      type: "updateStop",
      stopId: "stop-1",
      content: { kind: "outside", title: "Nishiki Market", notes: "go early", url: "https://example.com" },
      timeWindow: "09:00–11:00",
      durationMinutes: 90,
      publicNotes: "public",
      privateNotes: "private",
      reservation: "table for two",
      storedFacts: ["fact a", "fact b"],
      alternatives: ["alt a", "alt b"],
    },
  ]);

  const hole = updateStopOps({ ...editBase, title: "  quiet dinner near Gion  ", content: { kind: "hole", request: "old" } });
  assert.deepEqual(hole, [
    {
      type: "updateStop",
      stopId: "stop-1",
      content: { kind: "hole", request: "quiet dinner near Gion" },
      timeWindow: "09:00–11:00",
      durationMinutes: 90,
      publicNotes: "public",
      privateNotes: "private",
      reservation: "table for two",
      storedFacts: ["fact a", "fact b"],
      alternatives: ["alt a", "alt b"],
    },
  ]);

  const reference = updateStopOps({ ...editBase, content: { kind: "item", itemId: "item-1" } });
  assert.equal(reference![0]!.content, undefined, "Library references keep authoritative content");
});

test("updateStopOps caps list fields at 12 lines and returns null for blank required titles", () => {
  const thirteen = Array.from({ length: 13 }, (_, i) => `fact ${i + 1}`).join("\n");
  const ops = updateStopOps({ ...editBase, storedFacts: thirteen, content: { kind: "item", itemId: "item-1" } });
  assert.deepEqual(ops![0]!.storedFacts, Array.from({ length: 12 }, (_, i) => `fact ${i + 1}`));

  assert.equal(updateStopOps({ ...editBase, title: "   ", content: { kind: "outside", title: "old", notes: null, url: null } }), null, "blank outside title skips apply");
  assert.equal(updateStopOps({ ...editBase, title: "", content: { kind: "hole", request: "old" } }), null, "blank hole request skips apply");
  assert.ok(updateStopOps({ ...editBase, title: "", content: { kind: "item", itemId: "item-1" } }), "reference stops have no required title");
});
