import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LOCAL_LIBRARY_ID } from "../db/library-id.ts";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import type { TripStop } from "../server/trips/module.ts";
import {
  archiveTrip,
  applyTripChanges,
  createTrip,
  deleteTrip,
  duplicateTrip,
  getTrip,
  getTripHistory,
  listDismissedAdvisories,
  listTrips,
  recordTripReview,
  redoTripChanges,
  removeTripInference,
  renameTrip,
  restoreTrip,
  searchTripSources,
  dismissTripAdvisory,
  TripConflict,
  undoTripChanges,
  updateTripSetup,
  validateTripSetup,
  type TripDocument,
  type TripMutationResult,
  type TripSetupInput,
} from "../server/trips/module.ts";
import { createPlace, markNotAtlas, setExactPlace } from "../server/atlas/module.ts";


/** Existing test stops are outside content; reference stops resolve server-side. */
function titleOf(stop: { content: TripStop["content"] }): string {
  if (stop.content.kind === "outside") return stop.content.title;
  if (stop.content.kind === "hole") return stop.content.request;
  return stop.content.kind === "item" ? "a saved item" : "a place";
}

function notesOf(stop: { content: TripStop["content"] }): string | null {
  return stop.content.kind === "outside" ? stop.content.notes : null;
}

const TS = "2026-09-01T09:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-")), "t.db"));
}

function rejects(setup: unknown, message: RegExp) {
  assert.throws(() => createTrip(mem(), "local", setup as TripSetupInput, TS), (error: unknown) => {
    assert.ok(error instanceof RejectedPayload, `expected RejectedPayload, got ${String(error)}`);
    assert.match(error.message, message);
    return true;
  });
}

test("create requires destination and a date range or a trip length", () => {
  rejects({ destination: "" }, /destination is required/);
  rejects({ destination: "Kyoto" }, /date range or a trip length/);
  rejects({ destination: "Kyoto", startDate: "2026-10-12" }, /endDate is required/);
  rejects({ destination: "Kyoto", endDate: "2026-10-15" }, /startDate is required/);
  rejects({ destination: "Kyoto", durationDays: 0 }, /trip length/);
  rejects({ destination: "Kyoto", durationDays: 400 }, /trip length/);
  rejects({ destination: "Kyoto", durationDays: 2.5 }, /trip length/);
});

test("dates must be valid, ordered, bounded, and consistent with a stated length", () => {
  rejects({ destination: "Kyoto", startDate: "12/10/2026", endDate: "2026-10-15" }, /YYYY-MM-DD/);
  rejects({ destination: "Kyoto", startDate: "2026-13-01", endDate: "2026-10-15" }, /YYYY-MM-DD/);
  rejects({ destination: "Kyoto", startDate: "2026-10-15", endDate: "2026-10-12" }, /on or after startDate/);
  rejects({ destination: "Kyoto", startDate: "2020-01-01", endDate: "2026-10-15" }, /at most 365 days/);
  rejects({ destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-15", durationDays: 5 }, /match the date range/);
});

test("optional fields are bounded and honest about timezone", () => {
  rejects({ destination: "x".repeat(121), durationDays: 2 }, /destination/);
  rejects({ destination: "Kyoto", durationDays: 2, timezone: "Mars/Olympus" }, /IANA/);
  rejects({ destination: "Kyoto", durationDays: 2, context: { interests: Array.from({ length: 13 }, (_, i) => `i${i}`) } }, /at most 12/);
  rejects({ destination: "Kyoto", durationDays: 2, context: { pace: "x".repeat(121) } }, /pace/);
});

test("setup codec normalizes valid dated and duration-only setup", () => {
  const db = mem();
  const dated = createTrip(
    db,
    "local",
    { destination: "  Kyoto, Japan  ", startDate: "2026-10-12", endDate: "2026-10-15", durationDays: 4, title: "", context: {} },
    TS,
  );
  assert.equal(dated.destination, "Kyoto, Japan", "destination is trimmed");
  assert.equal(dated.title, "Kyoto, Japan", "empty title falls back to destination");
  assert.equal(dated.durationDays, 4);
  assert.equal(dated.travelers, null);
  assert.deepEqual(
    dated.context,
    { lodgingAnchors: [], pace: null, mobility: null, budget: null, mealPreferences: [], interests: [], mustDos: [], hardConstraints: [] },
    "missing context fields normalize to empty lists and nulls",
  );

  const durationOnly = createTrip(db, "local", { destination: "Kochi", durationDays: 3, title: "  Kochi food weekend  " }, TS);
  assert.equal(durationOnly.title, "Kochi food weekend", "titles are trimmed");
  assert.equal(durationOnly.startDate, null);
  assert.equal(durationOnly.endDate, null);
  assert.equal(durationOnly.durationDays, 3);
});

test("setup codec rejects malformed and out-of-contract payloads by name", () => {
  const cases: [string, unknown, RegExp][] = [
    ["missing destination", { durationDays: 2 }, /destination is required/],
    ["blank destination", { destination: "   ", durationDays: 2 }, /destination is required/],
    ["missing dates and duration", { destination: "Kyoto" }, /date range or a trip length/],
    ["malformed start date", { destination: "Kyoto", startDate: "October 12", endDate: "2026-10-15" }, /YYYY-MM-DD/],
    ["impossible calendar date", { destination: "Kyoto", startDate: "2026-02-30", endDate: "2026-03-01" }, /YYYY-MM-DD/],
    ["end before start", { destination: "Kyoto", startDate: "2026-10-15", endDate: "2026-10-12" }, /on or after startDate/],
    ["stated duration mismatch", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-15", durationDays: 5 }, /match the date range/],
    ["unknown setup field", { destination: "Kyoto", durationDays: 2, route: "https://maps.example.com" }, /route is not a trip setup field/],
    ["unknown context field", { destination: "Kyoto", durationDays: 2, context: { flightNumbers: ["NH110"] } }, /context\.flightNumbers is not a trip setup field/],
  ];
  for (const [name, setup, expected] of cases) {
    assert.throws(() => validateTripSetup(setup), (error: unknown) => {
      assert.ok(error instanceof RejectedPayload, `${name}: expected RejectedPayload, got ${String(error)}`);
      assert.match(error.message, expected, name);
      return true;
    }, name);
  }
});

test("setup codec ignores mutation envelope keys and stores nothing from them", () => {
  const setup = validateTripSetup({
    destination: "Kyoto",
    durationDays: 2,
    clientMutationId: "m-1",
    expectedRevision: 7,
    libraryId: "hosted-b",
    actor: "agent",
  });
  assert.equal(setup.destination, "Kyoto");
  assert.ok(!("clientMutationId" in setup));
  assert.ok(!("expectedRevision" in setup));
  assert.ok(!("actor" in setup));
});

test("a dated trip persists with ordered days and reopens with stable identities", () => {
  const db = mem();
  const trip = createTrip(
    db,
    "local",
    {
      destination: "Kyoto, Japan",
      startDate: "2026-10-12",
      endDate: "2026-10-15",
      timezone: "Asia/Tokyo",
      travelers: "2 adults",
      context: { pace: "slow mornings", mustDos: ["Nishiki Market", "Arashiyama"], lodgingAnchors: ["Ace Hotel Kyoto"] },
    },
    TS,
  );
  assert.ok(trip.id);
  assert.equal(trip.libraryId, LOCAL_LIBRARY_ID);
  assert.equal(trip.title, "Kyoto, Japan", "title defaults to destination");
  assert.equal(trip.timezone, "Asia/Tokyo");
  assert.equal(trip.startDate, "2026-10-12");
  assert.equal(trip.endDate, "2026-10-15");
  assert.equal(trip.durationDays, 4);
  assert.equal(trip.revision, 1);
  assert.equal(trip.archivedAt, null);
  assert.equal(trip.createdAt, TS);
  assert.equal(trip.updatedAt, TS);
  assert.deepEqual(
    trip.days.map((day) => [day.position, day.date, day.label]),
    [
      [0, "2026-10-12", "Day 1"],
      [1, "2026-10-13", "Day 2"],
      [2, "2026-10-14", "Day 3"],
      [3, "2026-10-15", "Day 4"],
    ],
  );
  assert.deepEqual(trip.context.mustDos, ["Nishiki Market", "Arashiyama"]);

  const reopened = getTrip(db, "local", trip.id);
  assert.ok(reopened);
  assert.equal(reopened!.id, trip.id);
  assert.deepEqual(reopened!.context, trip.context);
  assert.deepEqual(
    reopened!.days.map((day) => day.id),
    trip.days.map((day) => day.id),
    "day ids are stable across reopen",
  );

  const listed = listTrips(db, "local");
  assert.equal(listed.length, 1);
  assert.equal(listed[0]!.id, trip.id);
  assert.equal(listed[0]!.durationDays, 4);
});

test("a duration trip has honest open dates", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kochi", durationDays: 3, title: "Kochi food weekend" }, TS);
  assert.equal(trip.durationDays, 3);
  assert.equal(trip.startDate, null);
  assert.equal(trip.endDate, null);
  assert.deepEqual(
    trip.days.map((day) => [day.date, day.label]),
    [
      [null, "Day 1"],
      [null, "Day 2"],
      [null, "Day 3"],
    ],
  );
});

test("setup updates edit user context, bump revision once, and regenerate days", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-14" }, TS);
  const beforeDayIds = trip.days.map((day) => day.id);
  const updated = updateTripSetup(
    db,
    "local",
    trip.id,
    { expectedRevision: 1, clientMutationId: "setup-1", destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-15", title: "Kyoto in October", travelers: "2 adults" },
    "2026-09-02T09:00:00.000Z",
  );
  assert.ok(updated);
  assert.equal(updated!.revision, 2);
  assert.equal(updated!.title, "Kyoto in October");
  assert.equal(updated!.destination, "Kyoto, Japan");
  assert.equal(updated!.durationDays, 4);
  assert.equal(updated!.travelers, "2 adults");
  assert.equal(updated!.createdAt, TS);
  assert.equal(updated!.updatedAt, "2026-09-02T09:00:00.000Z");
  assert.notDeepEqual(
    updated!.days.map((day) => day.id),
    beforeDayIds,
  );
  const unchanged = updateTripSetup(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "setup-2", destination: "Kyoto", durationDays: 4 }, TS);
  assert.equal(unchanged!.revision, 3);
});

test("invalid updates leave the document unchanged", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 3 }, TS);
  assert.throws(
    () => updateTripSetup(db, "local", trip.id, { destination: "Kyoto", durationDays: -1 }, TS),
    (error: unknown) => error instanceof RejectedPayload,
  );
  const after = getTrip(db, "local", trip.id);
  assert.equal(after!.revision, 1);
  assert.equal(after!.durationDays, 3);
});

test("Trip Documents are isolated per Library and unknown ids are null", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  createTrip(db, "hosted-a", { destination: "Goa", durationDays: 2 }, TS);

  assert.equal(getTrip(db, "hosted-b", trip.id), null, "another library cannot read the trip");
  assert.equal(getTrip(db, "local", "missing-id"), null);
  assert.deepEqual(listTrips(db, "hosted-b"), []);
  assert.deepEqual(listTrips(db, "local").map((row) => row.destination), ["Kyoto"]);
  assert.deepEqual(listTrips(db, "hosted-a").map((row) => row.destination), ["Goa"]);

  const foreignUpdate = updateTripSetup(db, "hosted-b", trip.id, { expectedRevision: 1, clientMutationId: "hijack", destination: "Hijacked", durationDays: 9 }, TS);
  assert.equal(foreignUpdate, null, "another library cannot update the trip");
  const untouched = getTrip(db, "local", trip.id);
  assert.equal(untouched!.destination, "Kyoto");
  assert.equal(untouched!.revision, 1);
});

test("agent-shaped payload fields are never stored as user facts", () => {
  const db = mem();
  const trip = createTrip(
    db,
    "local",
    {
      destination: "Kyoto",
      durationDays: 2,
      libraryId: "hosted-b",
      actor: "agent",
      context: { pace: "user typed this" },
    } as TripSetupInput,
    TS,
  );
  assert.equal(trip.libraryId, LOCAL_LIBRARY_ID, "library comes from the trusted adapter argument");
  assert.ok(!("actor" in trip));
  assert.deepEqual(trip.context.pace, "user typed this");
  assert.throws(
    () => createTrip(db, "local", { destination: "Kyoto", durationDays: 2, inferred: true } as TripSetupInput, TS),
    (error: unknown) => error instanceof RejectedPayload && /inferred is not a trip setup field/.test(error.message),
    "agent-inferred facts cannot ride into setup as unknown fields",
  );
});

test("rename changes only the title, keeps identity and content, and bumps revision once", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2, context: { pace: "slow" } }, TS);
  const renamed = renameTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "r1", title: "Kyoto in October" }, "2026-09-02T09:00:00.000Z");
  assert.ok(renamed);
  assert.equal(renamed!.id, trip.id);
  assert.equal(renamed!.title, "Kyoto in October");
  assert.equal(renamed!.destination, "Kyoto");
  assert.equal(renamed!.revision, 2);
  assert.equal(renamed!.createdAt, TS);
  assert.equal(renamed!.updatedAt, "2026-09-02T09:00:00.000Z");
  assert.deepEqual(renamed!.days.map((day) => day.id), trip.days.map((day) => day.id), "days are untouched by rename");
  assert.deepEqual(renamed!.context, trip.context);
  assert.equal(getTrip(db, "local", trip.id)!.title, "Kyoto in October", "rename persists");

  assert.throws(() => renameTrip(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "r2", title: "" }), (error: unknown) => error instanceof RejectedPayload);
  assert.throws(() => renameTrip(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "r3", title: "x".repeat(121) }), (error: unknown) => error instanceof RejectedPayload);
  assert.throws(() => renameTrip(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "r4", title: null }), (error: unknown) => error instanceof RejectedPayload);
  assert.equal(renameTrip(db, "hosted-b", trip.id, { expectedRevision: 2, clientMutationId: "r5", title: "Hijack" }, TS), null, "another library cannot rename");
  assert.equal(getTrip(db, "local", trip.id)!.title, "Kyoto in October");
  assert.equal(getTrip(db, "local", trip.id)!.revision, 2, "a rejected rename leaves the document unchanged");
});

test("duplicate creates an independent active copy with fresh day identities", () => {
  const db = mem();
  const source = createTrip(
    db,
    "local",
    {
      destination: "Kyoto, Japan",
      startDate: "2026-10-12",
      endDate: "2026-10-14",
      title: "Kyoto in October",
      timezone: "Asia/Tokyo",
      context: { pace: "slow mornings", mustDos: ["Nishiki Market"] },
    },
    TS,
  );
  // Bump the source well past revision 1 and archive it before duplicating.
  const edited = updateTripSetup(
    db,
    "local",
    source.id,
    {
      expectedRevision: 1,
      clientMutationId: "dup-setup",
      destination: "Kyoto, Japan",
      startDate: "2026-10-12",
      endDate: "2026-10-15",
      title: "Kyoto in October",
      timezone: "Asia/Tokyo",
      context: { pace: "slow mornings", mustDos: ["Nishiki Market"] },
    },
    "2026-09-02T09:00:00.000Z",
  );
  assert.equal(edited!.revision, 2);
  archiveTrip(db, "local", source.id, { expectedRevision: 2, clientMutationId: "dup-arch" }, "2026-09-03T09:00:00.000Z");

  const copy = duplicateTrip(db, "local", source.id, { expectedRevision: 3, clientMutationId: "dup-1" }, "2026-09-04T09:00:00.000Z");
  assert.ok(copy);
  assert.notEqual(copy!.id, source.id);
  assert.equal(copy!.revision, 1, "the copy starts its own revision history");
  assert.equal(copy!.archivedAt, null, "the copy is active even when the source is archived");
  assert.equal(copy!.title, "Kyoto in October");
  assert.equal(copy!.destination, "Kyoto, Japan");
  assert.equal(copy!.timezone, "Asia/Tokyo");
  assert.equal(copy!.durationDays, 4);
  assert.deepEqual(copy!.context, source.context);
  assert.deepEqual(
    copy!.days.map((day) => [day.position, day.date, day.label]),
    edited!.days.map((day) => [day.position, day.date, day.label]),
    "days are copied in order with dates",
  );
  assert.notDeepEqual(
    copy!.days.map((day) => day.id),
    edited!.days.map((day) => day.id),
    "day ids are fresh, never shared",
  );

  // Editing the copy leaves the source exactly as it was.
  renameTrip(db, "local", copy.id, { expectedRevision: 1, clientMutationId: "copy-rename", title: "Copy renamed" }, "2026-09-05T09:00:00.000Z");
  const untouched = getTrip(db, "local", source.id);
  assert.equal(untouched!.title, "Kyoto in October");
  assert.equal(untouched!.revision, 3, "source revision history is untouched by the copy");
  assert.equal(duplicateTrip(db, "hosted-b", source.id, { expectedRevision: 3, clientMutationId: "dup-x" }, TS), null, "another library cannot duplicate");
});

test("archive is reversible and idempotent; restore returns the full document", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 3 }, TS);
  const dayIds = trip.days.map((day) => day.id);

  const archived = archiveTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "arch-1" }, "2026-09-02T09:00:00.000Z");
  assert.ok(archived);
  assert.equal(archived!.archivedAt, "2026-09-02T09:00:00.000Z");
  assert.equal(archived!.revision, 2);
  assert.deepEqual(archived!.days.map((day) => day.id), dayIds, "archiving retains days");

  const again = archiveTrip(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "arch-2" }, "2026-09-03T09:00:00.000Z");
  assert.equal(again!.revision, 2, "archiving an archived trip is a no-op");
  assert.equal(again!.archivedAt, "2026-09-02T09:00:00.000Z");

  const restored = restoreTrip(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "rest-1" }, "2026-09-04T09:00:00.000Z");
  assert.ok(restored);
  assert.equal(restored!.archivedAt, null);
  assert.equal(restored!.revision, 3);
  assert.equal(restoreTrip(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "rest-2" }, "2026-09-05T09:00:00.000Z")!.revision, 3, "restoring an active trip is a no-op");
  assert.deepEqual(restoreTrip(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "rest-3" })!.days.map((day) => day.id), dayIds);

  assert.equal(archiveTrip(db, "hosted-b", trip.id, { expectedRevision: 3, clientMutationId: "arch-x" }, TS), null, "another library cannot archive");

  // The index derives Active/Archived membership and counts from this list.
  archiveTrip(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "arch-3" }, "2026-09-06T09:00:00.000Z");
  const listed = listTrips(db, "local");
  assert.equal(listed.length, 1);
  assert.ok(listed[0]!.archivedAt, "archived trips stay listed with their archivedAt for the filter counts");
});

test("delete requires confirm, is library-scoped, and removes only trip-owned rows", () => {
  const db = mem();
  // Referenced Library entity that must survive every trip deletion.
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'reel', NULL, ?, ?, 'cook', ?, '[]', ?, ?)`,
  ).run("item-1", "trip caption", "https://www.instagram.com/reel/item-1/", TS, TS, TS);
  addTag(db, "item-1", "food");

  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 3 }, TS);
  assert.throws(() => deleteTrip(db, "local", trip.id, undefined), (error: unknown) => error instanceof RejectedPayload);
  assert.throws(() => deleteTrip(db, "local", trip.id, "yes"), (error: unknown) => error instanceof RejectedPayload);
  assert.throws(() => deleteTrip(db, "local", trip.id, ""), (error: unknown) => error instanceof RejectedPayload);
  assert.ok(getTrip(db, "local", trip.id), "rejected deletes leave the document in place");

  assert.equal(deleteTrip(db, "hosted-b", trip.id, { expectedRevision: 1, clientMutationId: "d-x", confirm: "DELETE" }), false, "another library cannot delete");
  assert.equal(deleteTrip(db, "local", "missing-id", { expectedRevision: 1, clientMutationId: "d-m", confirm: "DELETE" }), false);
  assert.equal(deleteTrip(db, "local", trip.id, { expectedRevision: 1, clientMutationId: "d-1", confirm: "DELETE" }), true);

  assert.equal(getTrip(db, "local", trip.id), null);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trip_days WHERE trip_id = ?`).get(trip.id) as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items WHERE id = 'item-1'`).get() as { n: number }).n, 1, "Items survive trip deletion");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tags WHERE name = 'food'`).get() as { n: number }).n, 1, "tags survive trip deletion");
});

// ---------- Day Planner changesets (ticket 04) ----------

function dayStopTitles(trip: TripDocument, dayIndex: number): string[] {
  return trip.days[dayIndex]!.stops.map((stop) => titleOf(stop));
}

function addStopOp(dayId: string | null, title: string, placement: Record<string, unknown> = {}) {
  return { type: "addStop", dayId, content: { kind: "outside", title }, ...placement };
}

function apply(
  db: ReturnType<typeof mem>,
  tripId: string,
  revision: number,
  clientMutationId: string,
  operations: unknown,
  at = TS,
  overrides: Record<string, unknown> = {},
): TripMutationResult | null {
  return applyTripChanges(db, "local", tripId, { expectedRevision: revision, clientMutationId, operations, ...overrides }, "user", at);
}

function plannerTrip(): { db: ReturnType<typeof mem>; trip: TripDocument } {
  const db = mem();
  return { db, trip: createTrip(db, "local", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-14" }, TS) };
}

test("addStop places stops by id, marks them Confirmed, and orders within a day", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;

  const first = apply(db, trip.id, 1, "m1", [addStopOp(day1, "Nishiki Market")])!;
  assert.equal(first.replayed, false);
  assert.equal(first.trip.revision, 2, "revision increments exactly once");
  const nishiki = first.trip.days[0]!.stops[0]!;
  assert.equal(titleOf(nishiki), "Nishiki Market");
  assert.equal(nishiki.state, "confirmed", "human-created stops begin Confirmed");
  assert.deepEqual(nishiki.provenance, { actor: "user", via: "manual" });
  assert.equal(nishiki.position, 0);
  assert.deepEqual(first.trip.unscheduled, []);

  // Placement by anchor ids, never by client array indexes.
  const second = apply(db, trip.id, 2, "m2", [addStopOp(day1, "Kiyomizu-dera", { beforeStopId: nishiki.id })])!;
  const third = apply(db, trip.id, 3, "m3", [addStopOp(day1, "Gion at dusk", { afterStopId: second.trip.days[0]!.stops[0]!.id })])!;
  assert.deepEqual(dayStopTitles(third.trip, 0), ["Kiyomizu-dera", "Gion at dusk", "Nishiki Market"]);
  assert.deepEqual(third.trip.days[0]!.stops.map((stop) => stop.position), [0, 1, 2]);

  const fourth = apply(db, trip.id, 4, "m4", [addStopOp(null, "Loose idea")])!;
  assert.deepEqual(fourth.trip.unscheduled.map((stop) => titleOf(stop)), ["Loose idea"]);

  // Unknown day, both anchors, and oversized text are invalid and change nothing.
  assert.throws(() => apply(db, trip.id, 5, "m5", [addStopOp("no-such-day", "Ghost")]), (error: unknown) => error instanceof RejectedPayload);
  assert.throws(
    () => apply(db, trip.id, 5, "m5", [addStopOp(day1, "Ghost", { beforeStopId: "x", afterStopId: "y" })]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.throws(
    () => apply(db, trip.id, 5, "m5", [addStopOp(day1, "x".repeat(121))]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  const unchanged = getTrip(db, "local", trip.id)!;
  assert.equal(unchanged.revision, 5);
  assert.deepEqual(dayStopTitles(unchanged, 0), ["Kiyomizu-dera", "Gion at dusk", "Nishiki Market"]);
});

test("addStop requested state follows the trusted actor and restores on undo", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;

  const humanDraft = apply(db, trip.id, 1, "d1", [addStopOp(day1, "Maybe later", { state: "draft" })], TS, { actor: "agent" })!;
  const draftStop = humanDraft.trip.days[0]!.stops[0]!;
  assert.equal(draftStop.state, "draft", "human add with Draft is Draft");
  assert.deepEqual(draftStop.provenance, { actor: "user", via: "manual" }, "Draft is review state, not authorship");
  assert.equal(humanDraft.changeset.actor, "user", "body-provided actor is ignored");

  const undoneAdd = undoTripChanges(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "u-add" }, "user")!;
  assert.deepEqual(undoneAdd.trip.days[0]!.stops, []);
  const redoneAdd = redoTripChanges(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "r-add" }, "user")!;
  const redone = redoneAdd.trip.days[0]!.stops[0]!;
  assert.equal(redone.id, draftStop.id);
  assert.equal(redone.state, "draft");
  assert.deepEqual(redone.provenance, { actor: "user", via: "manual" });

  const removed = apply(db, trip.id, 4, "rm", [{ type: "removeStop", stopId: draftStop.id }])!;
  assert.equal(removed.trip.days[0]!.stops.length, 0);
  const undoneRemove = undoTripChanges(db, "local", trip.id, { expectedRevision: 5, clientMutationId: "u-rm" }, "user")!;
  const restored = undoneRemove.trip.days[0]!.stops[0]!;
  assert.equal(restored.id, draftStop.id);
  assert.equal(restored.state, "draft");
  assert.deepEqual(restored.provenance, { actor: "user", via: "manual" });

  const humanConfirmed = apply(db, trip.id, 6, "c1", [addStopOp(day1, "Locked in", { state: "confirmed" })])!;
  assert.equal(humanConfirmed.trip.days[0]!.stops[1]!.state, "confirmed");

  const agentForced = applyTripChanges(
    db,
    "local",
    trip.id,
    { expectedRevision: 7, clientMutationId: "a1", operations: [addStopOp(day1, "Agent cafe", { state: "confirmed" })] },
    "agent",
  )!;
  const agentStop = agentForced.trip.days[0]!.stops[2]!;
  assert.equal(agentStop.state, "draft", "agent add stays Draft even when Confirmed is requested");
  assert.deepEqual(agentStop.provenance, { actor: "agent", via: "agent" });

  assert.throws(
    () => apply(db, trip.id, 8, "bad", [addStopOp(day1, "Ghost", { state: "published" })]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.equal(getTrip(db, "local", trip.id)!.revision, 8, "invalid add state does not increment revision");
  assert.equal(getTrip(db, "local", trip.id)!.days[0]!.stops.length, 3);

  const hole = apply(db, trip.id, 8, "h1", [{ type: "addStop", dayId: day1, content: { kind: "hole", request: "dinner slot" } }])!;
  const holeId = hole.trip.days[0]!.stops.find((stop) => stop.content.kind === "hole")!.id;
  const filled = apply(db, trip.id, 9, "f1", [
    { type: "removeStop", stopId: holeId },
    addStopOp(day1, "Draft dinner", { state: "draft" }),
  ])!;
  const dinner = filled.trip.days[0]!.stops.find((stop) => titleOf(stop) === "Draft dinner")!;
  assert.equal(dinner.state, "draft");
  assert.deepEqual(dinner.provenance, { actor: "user", via: "manual" });
  const undoneFill = undoTripChanges(db, "local", trip.id, { expectedRevision: 10, clientMutationId: "u-fill" }, "user")!;
  assert.ok(undoneFill.trip.days[0]!.stops.some((stop) => stop.content.kind === "hole"));
  const redoneFill = redoTripChanges(db, "local", trip.id, { expectedRevision: 11, clientMutationId: "r-fill" }, "user")!;
  const dinnerAgain = redoneFill.trip.days[0]!.stops.find((stop) => stop.id === dinner.id)!;
  assert.equal(dinnerAgain.state, "draft");
  assert.deepEqual(dinnerAgain.provenance, { actor: "user", via: "manual" });
});

test("updateStop changes fields, keeps identity, and requires a real change", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const added = apply(db, trip.id, 1, "m1", [addStopOp(day1, "Nishiki Market")])!;
  const stopId = added.trip.days[0]!.stops[0]!.id;

  const updated = apply(db, trip.id, 2, "m2", [
    { type: "updateStop", stopId, content: { kind: "outside", title: "Nishiki Market", notes: "go hungry" }, timeWindow: "09:00-11:00", durationMinutes: 90 },
  ])!;
  const stop = updated.trip.days[0]!.stops[0]!;
  assert.equal(stop.id, stopId, "identity survives an edit");
  assert.equal(notesOf(stop), "go hungry");
  assert.equal(stop.timeWindow, "09:00-11:00");
  assert.equal(stop.durationMinutes, 90);
  assert.equal(updated.trip.revision, 3);

  assert.throws(
    () => apply(db, trip.id, 3, "m3", [{ type: "updateStop", stopId }]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.throws(
    () => apply(db, trip.id, 3, "m3", [{ type: "updateStop", stopId: "missing", content: { kind: "outside", title: "x" } }]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.equal(getTrip(db, "local", trip.id)!.revision, 3, "rejected updates leave the revision alone");
});

test("moveStop reorders by anchors, moves across days and Unscheduled, and rejects client indexes", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const day2 = trip.days[1]!.id;
  let current = apply(db, trip.id, 1, "seed", [addStopOp(day1, "A"), addStopOp(day1, "B"), addStopOp(day1, "C")])!;
  const idOf = (title: string) =>
    [...current.trip.days.flatMap((day) => day.stops), ...current.trip.unscheduled].find((stop) => titleOf(stop) === title)!.id;

  current = apply(db, trip.id, 2, "mv1", [{ type: "moveStop", stopId: idOf("C"), beforeStopId: idOf("A") }])!;
  assert.deepEqual(dayStopTitles(current.trip, 0), ["C", "A", "B"]);

  current = apply(db, trip.id, 3, "mv2", [{ type: "moveStop", stopId: idOf("A"), dayId: day2 }])!;
  assert.deepEqual(dayStopTitles(current.trip, 0), ["C", "B"]);
  assert.deepEqual(current.trip.days[1]!.stops.map((stop) => titleOf(stop)), ["A"]);

  current = apply(db, trip.id, 4, "mv3", [{ type: "moveStop", stopId: idOf("A"), dayId: null }])!;
  assert.deepEqual(current.trip.unscheduled.map((stop) => titleOf(stop)), ["A"]);

  // Absolute indexes are module-internal; adapters must place with anchors.
  assert.throws(
    () => apply(db, trip.id, 5, "mv4", [{ type: "moveStop", stopId: idOf("A"), dayId: day1, atPosition: 0 }]),
    (error: unknown) => error instanceof RejectedPayload && /atPosition/.test(error.message),
  );
  // An anchor that does not exist in the target day is invalid.
  assert.throws(
    () => apply(db, trip.id, 5, "mv4", [{ type: "moveStop", stopId: idOf("A"), dayId: day1, afterStopId: "missing" }]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  // Stops are addressed by id: an unknown stop is rejected, not ignored.
  assert.throws(
    () => apply(db, trip.id, 5, "mv4", [{ type: "moveStop", stopId: "missing" }]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.equal(getTrip(db, "local", trip.id)!.revision, 5);
});

test("removeStop closes ordering gaps", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const seeded = apply(db, trip.id, 1, "seed", [addStopOp(day1, "A"), addStopOp(day1, "B"), addStopOp(day1, "C")])!;
  const b = seeded.trip.days[0]!.stops[1]!.id;
  const removed = apply(db, trip.id, 2, "rm", [{ type: "removeStop", stopId: b }])!;
  assert.deepEqual(dayStopTitles(removed.trip, 0), ["A", "C"]);
  assert.deepEqual(removed.trip.days[0]!.stops.map((stop) => stop.position), [0, 1], "positions stay contiguous");
});

test("stale expectedRevision is rejected without any writes", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  apply(db, trip.id, 1, "m1", [addStopOp(day1, "A")]);
  assert.throws(
    () => apply(db, trip.id, 1, "m2", [addStopOp(day1, "B")]),
    (error: unknown) => error instanceof TripConflict,
  );
  const after = getTrip(db, "local", trip.id)!;
  assert.equal(after.revision, 2);
  assert.deepEqual(dayStopTitles(after, 0), ["A"], "the stale write changed nothing");
  assert.deepEqual(getTripHistory(db, "local", trip.id)!.changesets.length, 1);
});

test("client mutation id retries are idempotent; reuse with a different payload is rejected", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const operations = [addStopOp(day1, "A")];
  const first = apply(db, trip.id, 1, "m1", operations)!;
  assert.equal(first.replayed, false);

  const retry = apply(db, trip.id, 1, "m1", operations)!;
  assert.equal(retry.replayed, true, "same id + same payload replays the original result");
  assert.equal(retry.trip.revision, 2, "no double revision increment");
  assert.deepEqual(dayStopTitles(retry.trip, 0), ["A"]);
  assert.equal(getTripHistory(db, "local", trip.id)!.changesets.length, 1, "retry creates no second changeset");

  assert.throws(
    () => apply(db, trip.id, 1, "m1", [addStopOp(day1, "Different")]),
    (error: unknown) => error instanceof RejectedPayload && /different change/.test(error.message),
  );
  assert.throws(
    () => apply(db, trip.id, 1, "m1", operations, TS, { instruction: "a different instruction" }),
    (error: unknown) => error instanceof RejectedPayload && /different change/.test(error.message),
  );
  assert.equal(getTrip(db, "local", trip.id)!.revision, 2);
});

test("an invalid operation rolls the whole changeset back", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  assert.throws(
    () => apply(db, trip.id, 1, "m1", [addStopOp(day1, "Keep me"), addStopOp("bogus-day", "Doomed")]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  const after = getTrip(db, "local", trip.id)!;
  assert.equal(after.revision, 1, "no revision bump on a failed changeset");
  assert.deepEqual(after.days[0]!.stops, [], "no partial writes");
  assert.deepEqual(getTripHistory(db, "local", trip.id)!.changesets, []);
});

test("undo and redo restore complete changesets with their own history rows", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const at = (n: number) => `2026-09-0${n}T09:00:00.000Z`;

  // One changeset with several operations, including a removal: its inverse
  // must unwind every operation as one unit. An unknown stop fails the whole
  // changeset first.
  assert.throws(
    () => apply(db, trip.id, 1, "m1", [addStopOp(day1, "A"), addStopOp(day1, "B"), { type: "removeStop", stopId: "placeholder" }], at(1)),
    (error: unknown) => error instanceof RejectedPayload,
  );

  const seeded = apply(db, trip.id, 1, "s1", [addStopOp(day1, "A"), addStopOp(day1, "B")], at(1))!;
  const aId = seeded.trip.days[0]!.stops.find((stop) => titleOf(stop) === "A")!.id;
  const changed2 = apply(db, trip.id, 2, "m2", [{ type: "removeStop", stopId: aId }], at(2))!;
  assert.deepEqual(dayStopTitles(changed2.trip, 0), ["B"]);
  assert.equal(changed2.canUndo, true);
  assert.equal(changed2.canRedo, false);

  const undone = undoTripChanges(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "u1" }, "user", at(3))!;
  assert.equal(undone.trip.revision, 4);
  assert.deepEqual(dayStopTitles(undone.trip, 0), ["A", "B"], "undo restored the removed stop");
  assert.equal(undone.changeset.kind, "undo");
  assert.equal(undone.changeset.reversesId, changed2.changeset.id);
  assert.equal(undone.canUndo, true, "the earlier seed changeset is still active");
  assert.equal(undone.canRedo, true);

  // Retrying the same undo is idempotent and adds no row.
  const retry = undoTripChanges(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "u1" }, "user", at(3))!;
  assert.equal(retry.replayed, true);
  assert.equal(getTripHistory(db, "local", trip.id)!.changesets.length, 3);

  const redone = redoTripChanges(db, "local", trip.id, { expectedRevision: 4, clientMutationId: "r1" }, "user", at(4))!;
  assert.equal(redone.trip.revision, 5);
  assert.deepEqual(dayStopTitles(redone.trip, 0), ["B"], "redo re-applied the removal");
  assert.equal(redone.changeset.kind, "redo");
  assert.equal(redone.changeset.reversesId, changed2.changeset.id);
  assert.equal(redone.canUndo, true);
  assert.equal(redone.canRedo, false);

  assert.throws(
    () => redoTripChanges(db, "local", trip.id, { expectedRevision: 5, clientMutationId: "r2" }, "user", at(5)),
    (error: unknown) => error instanceof RejectedPayload && /nothing to redo/.test(error.message),
  );
  const finalUndo = undoTripChanges(db, "local", trip.id, { expectedRevision: 5, clientMutationId: "u2" }, "user", at(5))!;
  assert.deepEqual(dayStopTitles(finalUndo.trip, 0), ["A", "B"], "undo after redo undoes the restored change");

  // Undo keeps walking back through the stack: the seed changeset is next.
  const emptyUndo = undoTripChanges(db, "local", trip.id, { expectedRevision: 6, clientMutationId: "u3" }, "user", at(6))!;
  assert.deepEqual(dayStopTitles(emptyUndo.trip, 0), [], "undoing the seed changeset empties the day");
  assert.equal(emptyUndo.changeset.reversesId, seeded.changeset.id);

  assert.throws(
    () => undoTripChanges(db, "local", trip.id, { expectedRevision: 7, clientMutationId: "u4" }, "user", at(7)),
    (error: unknown) => error instanceof RejectedPayload && /nothing to undo/.test(error.message),
  );

  const history = getTripHistory(db, "local", trip.id)!;
  assert.equal(history.changesets.length, 6, "two changes + one redo + three undos");
  assert.ok(history.changesets.every((row) => row.actor === "user"));
  assert.ok(history.changesets.every((row) => row.createdAt.length > 0));
  assert.ok(history.changesets.every((row) => row.summary.length > 0));
});

test("redo of an agent add restores the same Draft stop rather than confirming a new one", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const added = applyTripChanges(
    db,
    "local",
    trip.id,
    { expectedRevision: 1, clientMutationId: "agent-add", operations: [addStopOp(day1, "Draft cafe")] },
    "agent",
  )!;
  const stop = added.trip.days[0]!.stops[0]!;
  assert.equal(stop.state, "draft");
  const undone = undoTripChanges(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "u-agent" }, "user")!;
  assert.equal(undone.trip.days[0]!.stops.length, 0);
  const redone = redoTripChanges(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "r-agent" }, "user")!;
  const restored = redone.trip.days[0]!.stops[0]!;
  assert.equal(restored.id, stop.id);
  assert.equal(restored.state, "draft");
  assert.equal(titleOf(restored), "Draft cafe");
});

test("undo of removeStop round-trips every stop field with the original id and timestamps", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const at = (n: number) => `2026-09-0${n}T09:00:00.000Z`;

  // Agent-seeded so state and provenance are distinctive, sitting between two
  // neighbors; addStop cannot set the rich fields, so updateStop adds them.
  const seeded = applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 1,
      clientMutationId: "seed",
      operations: [addStopOp(day1, "Arashiyama"), addStopOp(day1, "Kiyomizu"), addStopOp(day1, "Gion")],
    },
    "agent",
    at(1),
  )!;
  const richId = seeded.trip.days[0]!.stops[1]!.id;
  apply(
    db,
    trip.id,
    2,
    "rich",
    [{ type: "updateStop", stopId: richId, timeWindow: "08:30-10:00", durationMinutes: 90, publicNotes: "Go early", privateNotes: "SECRET", reservation: "conf-99", storedFacts: ["opens 06:00"], alternatives: ["Kodai-ji if rain"] }],
    at(1),
  )!;

  const removed = apply(db, trip.id, 3, "rm", [{ type: "removeStop", stopId: richId }], at(2))!;
  assert.deepEqual(dayStopTitles(removed.trip, 0), ["Arashiyama", "Gion"], "neighbors close the gap");
  assert.deepEqual(removed.trip.days[0]!.stops.map((stop) => stop.position), [0, 1]);

  const undo1 = undoTripChanges(db, "local", trip.id, { expectedRevision: 4, clientMutationId: "u1" }, "user", at(3))!;
  const back = undo1.trip.days[0]!.stops.find((stop) => stop.id === richId)!;
  assert.ok(back, "undo preserves the removed stop's id");
  assert.deepEqual(back.content, { kind: "outside", title: "Kiyomizu", notes: null, url: null });
  assert.equal(back.state, "draft");
  assert.deepEqual(back.provenance, { actor: "agent", via: "agent" });
  assert.equal(back.publicNotes, "Go early");
  assert.equal(back.privateNotes, "SECRET");
  assert.equal(back.timeWindow, "08:30-10:00");
  assert.equal(back.durationMinutes, 90);
  assert.equal(back.reservation, "conf-99");
  assert.deepEqual(back.storedFacts, ["opens 06:00"]);
  assert.deepEqual(back.alternatives, ["Kodai-ji if rain"]);
  assert.equal(back.dayId, day1);
  assert.equal(back.position, 1);
  assert.equal(back.createdAt, at(1), "undo keeps the original createdAt, not the undo clock");
  assert.equal(back.updatedAt, at(1));
  assert.deepEqual(dayStopTitles(undo1.trip, 0), ["Arashiyama", "Kiyomizu", "Gion"], "neighbors shift back");
  assert.deepEqual(undo1.trip.days[0]!.stops.map((stop) => stop.position), [0, 1, 2]);

  const redone = redoTripChanges(db, "local", trip.id, { expectedRevision: 5, clientMutationId: "r1" }, "user", at(4))!;
  assert.deepEqual(dayStopTitles(redone.trip, 0), ["Arashiyama", "Gion"]);

  const undo2 = undoTripChanges(db, "local", trip.id, { expectedRevision: 6, clientMutationId: "u2" }, "user", at(5))!;
  const back2 = undo2.trip.days[0]!.stops.find((stop) => stop.id === richId)!;
  assert.ok(back2, "second undo restores the same stop id again");
  assert.equal(back2.createdAt, at(1));
  assert.equal(back2.reservation, "conf-99");
  assert.deepEqual(back2.provenance, { actor: "agent", via: "agent" });
  assert.equal(back2.position, 1);
  assert.deepEqual(dayStopTitles(undo2.trip, 0), ["Arashiyama", "Kiyomizu", "Gion"]);
});

test("history rows carry actor, time, instruction, and a bounded summary", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  apply(db, trip.id, 1, "m1", [addStopOp(day1, "Nishiki Market", { timeWindow: "09:00" })], TS, { instruction: "pack day one" });
  const history = getTripHistory(db, "local", trip.id)!;
  assert.equal(history.changesets.length, 1);
  const row = history.changesets[0]!;
  assert.equal(row.actor, "user");
  assert.equal(row.instruction, "pack day one");
  assert.match(row.summary, /added "Nishiki Market" to Day 1/);
  assert.ok(row.summary.length <= 240, "summary stays bounded");
  assert.equal(row.baseRevision, 1);
  assert.equal(row.resultRevision, 2);
});

test("setup edits preserve day and stop identities when the day count is unchanged", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const added = apply(db, trip.id, 1, "m1", [addStopOp(day1, "Nishiki Market")])!;
  const stopId = added.trip.days[0]!.stops[0]!.id;

  const shifted = updateTripSetup(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "shift", destination: "Kyoto", startDate: "2026-11-02", endDate: "2026-11-04" }, "2026-09-02T09:00:00.000Z")!;
  assert.equal(shifted.days.length, 3);
  assert.deepEqual(
    shifted.days.map((day) => day.id),
    trip.days.map((day) => day.id),
    "day ids survive a date shift",
  );
  assert.equal(shifted.days[0]!.date, "2026-11-02");
  const stop = shifted.days[0]!.stops[0]!;
  assert.equal(stop.id, stopId, "stop identity survives the setup edit");
  assert.equal(stop.dayId, shifted.days[0]!.id, "the stop stays on its day");
});

test("shortening a trip releases end-day stops to Unscheduled instead of deleting them", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const day3 = trip.days[2]!.id;
  const seeded = apply(db, trip.id, 1, "m1", [addStopOp(day1, "Keep me"), addStopOp(day3, "End of trip")])!;
  const keepId = seeded.trip.days[0]!.stops[0]!.id;

  const shortened = updateTripSetup(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "shorten", destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-13" }, "2026-09-02T09:00:00.000Z")!;
  assert.equal(shortened.days.length, 2);
  assert.equal(shortened.days[0]!.id, day1, "surviving days keep their identity");
  assert.deepEqual(shortened.days[0]!.stops.map((stop) => stop.id), [keepId]);
  assert.deepEqual(shortened.unscheduled.map((stop) => titleOf(stop)), ["End of trip"], "released, not destroyed");
});

test("duplicate copies stops under new identities; delete removes stops and changesets but not Items", () => {
  const { db, trip } = plannerTrip();
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'reel', NULL, ?, ?, 'cook', ?, '[]', ?, ?)`,
  ).run("item-1", "trip caption", "https://www.instagram.com/reel/item-1/", TS, TS, TS);
  addTag(db, "item-1", "food");

  const day1 = trip.days[0]!.id;
  const added = apply(db, trip.id, 1, "m1", [addStopOp(day1, "Nishiki Market")])!;
  const originalStopId = added.trip.days[0]!.stops[0]!.id;

  const copy = duplicateTrip(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "dup-2" }, "2026-09-02T09:00:00.000Z")!;
  assert.equal(copy.revision, 1, "copy starts its own history");
  assert.equal(copy.id !== trip.id, true);
  assert.notEqual(copy.days[0]!.id, day1, "days get fresh identities");
  assert.equal(copy.days[0]!.stops.length, 1);
  assert.notEqual(copy.days[0]!.stops[0]!.id, originalStopId, "stops get fresh identities");
  assert.equal(titleOf(copy.days[0]!.stops[0]!), "Nishiki Market");

  // Deleting the original removes only trip-owned rows.
  assert.equal(deleteTrip(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "del-2", confirm: "DELETE" }), true);
  assert.equal(getTrip(db, "local", trip.id), null);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trip_stops WHERE trip_id = ?`).get(trip.id) as { n: number }).n, 0);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trip_changesets WHERE trip_id = ?`).get(trip.id) as { n: number }).n, 0);
  assert.equal(getTrip(db, "local", copy.id)!.days[0]!.stops.length, 1, "the duplicate is untouched");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items WHERE id = 'item-1'`).get() as { n: number }).n, 1, "Items survive");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM tags WHERE name = 'food'`).get() as { n: number }).n, 1, "tags survive");
});

test("actor comes from the adapter argument, never from the payload", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const applied = apply(db, trip.id, 1, "m1", [addStopOp(day1, "A")], TS, { actor: "agent" })!;
  assert.equal(applied.changeset.actor, "user", "body-provided actor is ignored");
  assert.equal(applied.trip.days[0]!.stops[0]!.provenance.actor, "user");

  const asAgent = applyTripChanges(
    db,
    "local",
    trip.id,
    { expectedRevision: 2, clientMutationId: "m2", operations: [addStopOp(day1, "B")] },
    "agent",
  )!;
  assert.equal(asAgent.changeset.actor, "agent", "the adapter argument decides the actor");
  assert.equal(asAgent.trip.days[0]!.stops[1]!.provenance.actor, "agent");

  assert.throws(
    () => applyTripChanges(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "m3", operations: [addStopOp(day1, "C")] }, ""),
    (error: unknown) => error instanceof RejectedPayload,
  );
});

test("changesets are Library-scoped and unknown trips are null", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  assert.equal(applyTripChanges(db, "hosted-b", trip.id, { expectedRevision: 1, clientMutationId: "x", operations: [addStopOp(day1, "Hijack")] }, "user"), null);
  assert.equal(applyTripChanges(db, "local", "missing-trip", { expectedRevision: 1, clientMutationId: "x", operations: [addStopOp(day1, "Ghost")] }, "user"), null);
  assert.equal(getTripHistory(db, "hosted-b", trip.id), null);
  assert.equal(getTrip(db, "local", trip.id)!.revision, 1, "cross-Library writes never land");
});

// ---------- Ticket 05: Library sources and outside content ----------

function seedItem(database: ReturnType<typeof mem>, id: string, title: string | null, body: string, url: string): void {
  database
    .prepare(
      `INSERT INTO items (id, content_type, title, body, url, author_handle, first_observed_at, media, created_at, updated_at)
       VALUES (?, 'post', ?, ?, ?, 'cook', ?, '[]', ?, ?)`,
    )
    .run(id, title, body, url, TS, TS, TS);
}

test("an Item reference resolves authoritative display data and never copies it", () => {
  const { db, trip } = plannerTrip();
  seedItem(db, "item-9", null, "Quiet coffee kissaten worth the walk", "https://x.com/a/status/9");
  const day1 = trip.days[0]!.id;
  const applied = apply(db, trip.id, 1, "src1", [{ type: "addStop", dayId: day1, content: { kind: "item", itemId: "item-9" } }])!;
  const stop = applied.trip.days[0]!.stops[0]!;
  assert.deepEqual(stop.content, { kind: "item", itemId: "item-9" }, "identity only, no copied caption");
  assert.equal(stop.broken, false);
  assert.deepEqual(stop.resolved, {
    kind: "item",
    title: "Quiet coffee kissaten worth the walk",
    source: null,
    url: "https://x.com/a/status/9",
  });
  assert.match(applied.changeset.summary, /added "Quiet coffee kissaten/, "history names the resolved title");
});

test("a Place reference resolves from Atlas and foreign or unknown references are rejected", () => {
  const { db, trip } = plannerTrip();
  const place = createPlace(db, "local", { name: "Fushimi Inari", kind: "landmark" });
  const foreign = createPlace(db, "hosted-b", { name: "Goa beach" });
  const day1 = trip.days[0]!.id;

  const applied = apply(db, trip.id, 1, "src2", [{ type: "addStop", dayId: day1, content: { kind: "place", placeId: place.id } }])!;
  const stop = applied.trip.days[0]!.stops[0]!;
  assert.equal(stop.broken, false);
  assert.deepEqual(stop.resolved, { kind: "place", name: "Fushimi Inari", kindLabel: "landmark", location: null });

  assert.throws(
    () => apply(db, trip.id, 2, "src3", [{ type: "addStop", dayId: day1, content: { kind: "place", placeId: foreign.id } }]),
    (error: unknown) => error instanceof RejectedPayload && /not in this Library/.test(error.message),
    "another Library's Place id is rejected",
  );
  assert.throws(
    () => apply(db, trip.id, 2, "src4", [{ type: "addStop", dayId: day1, content: { kind: "item", itemId: "no-such-item" } }]),
    (error: unknown) => error instanceof RejectedPayload && /not in this Library/.test(error.message),
  );
  assert.throws(
    () => apply(db, trip.id, 2, "src5", [{ type: "addStop", dayId: day1, content: { kind: "place", placeId: "no-such-place" } }]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  // The rejected writes changed nothing.
  assert.equal(getTrip(db, "local", trip.id)!.revision, 2);
  assert.equal(getTrip(db, "local", trip.id)!.days[0]!.stops.length, 1);

  // updateStop cannot smuggle a broken reference in either.
  const stopId = getTrip(db, "local", trip.id)!.days[0]!.stops[0]!.id;
  assert.throws(
    () => apply(db, trip.id, 2, "src6", [{ type: "updateStop", stopId, content: { kind: "item", itemId: "ghost" } }]),
    (error: unknown) => error instanceof RejectedPayload,
  );
});

test("a removed Item leaves a visible broken reference with its historical placement", () => {
  const { db, trip } = plannerTrip();
  seedItem(db, "item-gone", "Kyoto guide", "body", "https://x.com/a/status/1");
  const day2 = trip.days[1]!.id;
  const applied = apply(db, trip.id, 1, "g1", [{ type: "addStop", dayId: day2, content: { kind: "item", itemId: "item-gone" } }])!;
  db.prepare(`DELETE FROM items WHERE id = 'item-gone'`).run();

  const later = getTrip(db, "local", trip.id)!;
  const stop = later.days[1]!.stops[0]!;
  assert.equal(stop.id, applied.trip.days[1]!.stops[0]!.id, "same stop identity");
  assert.equal(stop.position, 0, "historical placement preserved");
  assert.equal(stop.dayId, day2);
  assert.equal(stop.broken, true, "marked broken, not dropped");
  assert.equal(stop.resolved, null);
});

test("outside content bounds and sanitizes its source URL", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const ok = apply(db, trip.id, 1, "u1", [
    { type: "addStop", dayId: day1, content: { kind: "outside", title: "Ramen idea", notes: null, url: "https://example.com/ramen?utm=x" } },
  ])!;
  assert.deepEqual(ok.trip.days[0]!.stops[0]!.content, { kind: "outside", title: "Ramen idea", notes: null, url: "https://example.com/ramen?utm=x" });

  const bad = (url: unknown, label: string) =>
    assert.throws(
      () => apply(db, trip.id, ok.trip.revision, `u-${label}`, [{ type: "addStop", dayId: day1, content: { kind: "outside", title: "x", notes: null, url } }]),
      (error: unknown) => error instanceof RejectedPayload,
      `${label} must be rejected`,
    );
  bad("javascript:alert(1)", "javascript url");
  bad("https://user:pass@example.com/", "credentials");
  bad("ftp://example.com/file", "non-http scheme");
  bad("not a url", "garbage");
});

test("adding outside content never creates Library entities", () => {
  const { db, trip } = plannerTrip();
  const count = (table: string) => (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
  const before = { items: count("items"), places: count("atlas_places"), tags: count("tags"), collections: count("collections"), assignments: count("atlas_assignments") };
  const day1 = trip.days[0]!.id;
  apply(db, trip.id, 1, "out1", [
    { type: "addStop", dayId: day1, content: { kind: "outside", title: "Outside idea", notes: "research more", url: "https://example.com/x" } },
  ])!;
  const after = { items: count("items"), places: count("atlas_places"), tags: count("tags"), collections: count("collections"), assignments: count("atlas_assignments") };
  assert.deepEqual(after, before, "no Item, Place, tag, Collection, or Place Assignment rows appeared");
});

test("trip source search returns bounded selection fields and is Library-scoped for Places", () => {
  const { db, trip } = plannerTrip();
  seedItem(db, "item-a", "Nishiki Market snack walk", "long caption that is not returned", "https://x.com/a/status/2");
  createPlace(db, "local", { name: "Nishiki Market", kind: "landmark" });
  createPlace(db, "hosted-b", { name: "Nishiki clone" });

  const results = searchTripSources(db, "local", "nishiki");
  assert.equal(results.items.length, 1);
  assert.deepEqual(Object.keys(results.items[0]!).sort(), ["id", "source", "title"], "items expose selection fields only");
  assert.equal(results.items[0]!.title, "Nishiki Market snack walk");
  assert.ok(!JSON.stringify(results).includes("long caption"), "no caption text");
  assert.equal(results.places.length, 1, "foreign-Library Places never appear");
  assert.deepEqual(results.places[0], { id: results.places[0]!.id, name: "Nishiki Market", kind: "landmark" });
  assert.ok(trip.id, "sanity");

  const everything = searchTripSources(db, "local", "");
  assert.ok(everything.items.length <= 20 && everything.places.length <= 20, "results are bounded");
  const junk = searchTripSources(db, "local", "zzzz-nothing-matches");
  assert.deepEqual(junk, { items: [], places: [] });
});

test("trip source search returns Atlas items, not not_atlas reading material", () => {
  const { db } = plannerTrip();
  seedItem(db, "z-reading", "WAL blog", "Everyone should know how WALs work in Barcelona", "https://x.com/a/status/read");
  seedItem(db, "taco-1", "TKO Tacos", "Found your next taco spot", "https://instagram.com/p/taco");
  markNotAtlas(db, "local", "z-reading", 0);
  const city = createPlace(db, "local", { name: "Barcelona", kind: "city" });
  const venue = createPlace(db, "local", { name: "TKO Tacos", kind: "venue", parentId: city.id });
  setExactPlace(db, "local", "taco-1", { placeId: venue.id }, 0);

  const byCity = searchTripSources(db, "local", "Barcelona");
  assert.deepEqual(byCity.items.map((item) => item.id), ["taco-1"]);
  assert.equal(byCity.items[0]!.title, "TKO Tacos");
  assert.ok(byCity.places.some((place) => place.name === "Barcelona"));

  const empty = searchTripSources(db, "local", "");
  assert.deepEqual(empty.items.map((item) => item.id), ["taco-1"]);
});

// ---------- Drafts, holes, and recommendations (ticket 07) ----------

function applyAs(
  db: ReturnType<typeof mem>,
  tripId: string,
  revision: number,
  clientMutationId: string,
  operations: unknown,
  actor: string,
  at = TS,
): TripMutationResult | null {
  return applyTripChanges(db, "local", tripId, { expectedRevision: revision, clientMutationId, operations }, actor, at);
}

test("agent-created stops begin Draft; only the human keeps or confirms them", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;

  const agentAdd = applyAs(db, trip.id, 1, "a1", [addStopOp(day1, "Agent pick")], "agent")!;
  const draft = agentAdd.trip.days[0]!.stops[0]!;
  assert.equal(draft.state, "draft", "agent content waits in Draft");
  assert.deepEqual(draft.provenance, { actor: "agent", via: "agent" });
  assert.equal(titleOf(draft), "Agent pick");

  // An agent cannot confirm its own (or anyone's) content.
  assert.throws(
    () => applyAs(db, trip.id, 2, "a2", [{ type: "updateStop", stopId: draft.id, state: "confirmed" }], "agent"),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.equal(getTrip(db, "local", trip.id)!.revision, 2, "rejected confirm leaves the revision alone");

  // Human keep: one updateStop, revision bumps once, provenance stays agent.
  const kept = apply(db, trip.id, 2, "k1", [{ type: "updateStop", stopId: draft.id, state: "confirmed" }])!;
  const keptStop = kept.trip.days[0]!.stops[0]!;
  assert.equal(keptStop.state, "confirmed");
  assert.deepEqual(keptStop.provenance, { actor: "agent", via: "agent" }, "keeping records who authored, not who kept");
  assert.equal(kept.trip.revision, 3);

  // Agent replacement demotes the stop to Draft again under agent provenance.
  const replaced = applyAs(db, trip.id, 3, "a3", [{ type: "updateStop", stopId: draft.id, content: { kind: "outside", title: "Agent pick", notes: "changed" } }], "agent")!;
  assert.equal(replaced.trip.days[0]!.stops[0]!.state, "draft");
  assert.deepEqual(replaced.trip.days[0]!.stops[0]!.provenance, { actor: "agent", via: "agent" });

  // Removing a draft is a normal human removeStop.
  const removed = apply(db, trip.id, 4, "k2", [{ type: "removeStop", stopId: draft.id }])!;
  assert.deepEqual(removed.trip.days[0]!.stops, []);
});

test("an agent move of a Confirmed stop stays Confirmed and records agent provenance", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const day2 = trip.days[1]!.id;
  const added = apply(db, trip.id, 1, "m1", [addStopOp(day1, "Nishiki Market")])!;
  const stopId = added.trip.days[0]!.stops[0]!.id;

  const moved = applyAs(db, trip.id, 2, "a1", [{ type: "moveStop", stopId, dayId: day2 }], "agent")!;
  const stop = moved.trip.days[1]!.stops[0]!;
  assert.equal(stop.id, stopId);
  assert.equal(stop.state, "confirmed", "a mechanical move keeps the human's Confirmed state");
  assert.deepEqual(stop.provenance, { actor: "agent", via: "agent move" });
  assert.equal(moved.trip.revision, 3);

  // Undo restores placement AND the prior provenance as one complete changeset.
  const undoResult = undoTripChanges(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "un1" }, "user", TS)!;
  const restored = undoResult.trip.days[0]!.stops[0]!;
  assert.equal(restored.id, stopId);
  assert.equal(restored.dayId, day1);
  assert.equal(restored.position, 0);
  assert.deepEqual(restored.provenance, { actor: "user", via: "manual" }, "undo restores the exact prior provenance");
});

test("Keep All is one human changeset over currently visible drafts and never confirms future content", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const first = applyAs(db, trip.id, 1, "a1", [addStopOp(day1, "Draft one")], "agent")!;
  const second = applyAs(db, trip.id, 2, "a2", [addStopOp(null, "Draft two")], "agent")!;
  const confirmed = apply(db, trip.id, second.trip.revision, "m0", [addStopOp(day1, "Human stop")])!;
  const draftOne = confirmed.trip.days[0]!.stops.find((stop) => titleOf(stop) === "Draft one")!.id;
  const draftTwo = confirmed.trip.unscheduled.find((stop) => titleOf(stop) === "Draft two")!.id;

  // One changeset, both drafts, revision moves exactly once.
  const keptAll = apply(db, trip.id, confirmed.trip.revision, "k-all", [
    { type: "updateStop", stopId: draftOne, state: "confirmed" },
    { type: "updateStop", stopId: draftTwo, state: "confirmed" },
  ])!;
  assert.equal(keptAll.trip.revision, confirmed.trip.revision + 1);
  assert.ok(keptAll.trip.days[0]!.stops.every((stop) => stop.state === "confirmed"));
  assert.ok(keptAll.trip.unscheduled.every((stop) => stop.state === "confirmed"));
  assert.equal(keptAll.changeset.actor, "user");

  const history = getTripHistory(db, "local", trip.id)!;
  assert.equal(history.changesets[0]!.summary.includes("Kept") || history.changesets[0]!.summary.includes("updated"), true, "history records the keep");
  assert.equal(history.changesets.filter((row) => row.actor === "user" && row.kind === "change").length >= 1, true);

  // A later agent add is still Draft: keeping never confirms future content.
  const later = applyAs(db, trip.id, keptAll.trip.revision, "a3", [addStopOp(day1, "Draft three")], "agent")!;
  assert.equal(later.trip.days[0]!.stops.at(-1)!.state, "draft");
});

test("holes are durable ordered requests that fill and dismiss without phantom gaps", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const anchor = apply(db, trip.id, 1, "m1", [addStopOp(day1, "Kiyomizu-dera")])!;
  const draft = applyAs(db, trip.id, anchor.trip.revision, "a1", [addStopOp(day1, "Agent draft")], "agent")!;
  const draftId = draft.trip.days[0]!.stops.find((stop) => titleOf(stop) === "Agent draft")!.id;

  const hole = apply(db, trip.id, draft.trip.revision, "h1", [
    { type: "addStop", dayId: day1, content: { kind: "hole", request: "Quiet dinner near Gion" }, beforeStopId: draftId },
  ])!;
  const holeStop = hole.trip.days[0]!.stops.find((stop) => stop.content.kind === "hole")!;
  assert.equal(holeStop.state, "confirmed", "user-created holes are Confirmed");
  assert.equal(holeStop.broken, false, "holes are trip-owned, never broken");
  assert.deepEqual(
    hole.trip.days[0]!.stops.map((stop) => titleOf(stop)),
    ["Kiyomizu-dera", "Quiet dinner near Gion", "Agent draft"],
    "hole takes an exact order",
  );
  assert.deepEqual(hole.trip.days[0]!.stops.map((stop) => stop.position), [0, 1, 2]);

  // Persistence: the hole is a normal stop row and survives reopen.
  const reopened = getTrip(db, "local", trip.id)!;
  assert.ok(reopened.days[0]!.stops.some((stop) => stop.content.kind === "hole"));

  // Fill: remove the hole and add at its placement in ONE changeset. The
  // unrelated draft stays draft, ordering stays contiguous, revision +1.
  const filled = apply(db, trip.id, hole.trip.revision, "f1", [
    { type: "removeStop", stopId: holeStop.id },
    { type: "addStop", dayId: day1, content: { kind: "outside", title: "Dinner at Gion", notes: null, url: null }, beforeStopId: draftId },
  ])!;
  const dayStops = filled.trip.days[0]!.stops;
  assert.ok(!dayStops.some((stop) => stop.content.kind === "hole"), "no phantom hole");
  assert.deepEqual(dayStops.map((stop) => titleOf(stop)), ["Kiyomizu-dera", "Dinner at Gion", "Agent draft"]);
  assert.deepEqual(dayStops.map((stop) => stop.position), [0, 1, 2]);
  assert.equal(dayStops.find((stop) => stop.id === draftId)!.state, "draft", "filling never confirms unrelated drafts");
  assert.equal(filled.trip.revision, hole.trip.revision + 1);

  // Undo of the fill restores the hole in place as one complete changeset.
  const undone = undoTripChanges(db, "local", trip.id, { expectedRevision: filled.trip.revision, clientMutationId: "un-f1" }, "user", TS)!;
  const restoredStops = undone.trip.days[0]!.stops;
  assert.deepEqual(restoredStops.map((stop) => titleOf(stop)), ["Kiyomizu-dera", "Quiet dinner near Gion", "Agent draft"]);
  assert.deepEqual(restoredStops.map((stop) => stop.position), [0, 1, 2]);

  // Dismiss is a plain removeStop; positions close up.
  const holeAgain = restoredStops.find((stop) => stop.content.kind === "hole")!.id;
  const dismissed = apply(db, trip.id, undone.trip.revision, "h2", [{ type: "removeStop", stopId: holeAgain }])!;
  assert.deepEqual(dismissed.trip.days[0]!.stops.map((stop) => titleOf(stop)), ["Kiyomizu-dera", "Agent draft"]);
  assert.deepEqual(dismissed.trip.days[0]!.stops.map((stop) => stop.position), [0, 1]);

  // Bounds: a hole is a bounded request like any stop text.
  assert.throws(
    () => apply(db, trip.id, dismissed.trip.revision, "h3", [{ type: "addStop", dayId: day1, content: { kind: "hole", request: "" } }]),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.throws(
    () => apply(db, trip.id, dismissed.trip.revision, "h4", [{ type: "addStop", dayId: day1, content: { kind: "hole", request: "x".repeat(121) } }]),
    (error: unknown) => error instanceof RejectedPayload,
  );
});

test("selecting a recommendation is exactly one human changeset", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  // The option the agent presented: one typed operation proposed for a day.
  const selected = apply(db, trip.id, 1, "rec-1", [
    { type: "addStop", dayId: day1, content: { kind: "outside", title: "Gion dinner", notes: null, url: null }, timeWindow: "19:30" },
  ])!;
  assert.equal(selected.trip.revision, 2, "one selection, one revision");
  assert.equal(selected.changeset.actor, "user", "the selection is a human changeset");
  assert.equal(selected.changeset.instruction, null, "no agent instruction is invented");
  const history = getTripHistory(db, "local", trip.id)!;
  assert.equal(history.changesets.length, 1, "dismissal never reaches the module, so no clutter rows exist");
});

// ---------- Agent trip-review advisories (ticket 09) ----------

function review(db: ReturnType<typeof mem>, tripId: string, expectedRevision: number, clientMutationId: string, flags: unknown, at = TS, overrides: Record<string, unknown> = {}) {
  return recordTripReview(db, "local", tripId, { expectedRevision, clientMutationId, flags, ...overrides }, "agent", at);
}

function strainFlag(dayId: string): unknown {
  return { category: "strain", severity: "concern", opinion: "Tuesday may feel rushed", rationale: "Four timed stops with no gap for lunch", dayRefs: [dayId], stopRefs: [] };
}

test("a review stores bounded flags pinned to the reviewed revision and replays idempotently", () => {
  const { db, trip } = plannerTrip();
  const day2 = trip.days[1]!.id;
  const first = review(db, trip.id, trip.revision, "rev-1", [strainFlag(day2), { category: "missing_information", severity: "info", opinion: "Lodging is still open", rationale: "No anchor saved for any night", dayRefs: [], stopRefs: [] }])!;
  assert.equal(first.replayed, false);
  assert.equal(first.trip.revision, trip.revision, "a review never bumps the document revision");
  assert.equal(first.trip.advisories.length, 2);
  const [flag] = first.trip.advisories;
  assert.equal(flag!.category, "strain");
  assert.equal(flag!.severity, "concern");
  assert.equal(flag!.reviewedRevision, trip.revision);
  assert.equal(flag!.actor, "agent", "actor comes from the trusted adapter");
  assert.equal(flag!.dismissedAt, null);
  assert.deepEqual(flag!.dayRefs, [day2]);

  // Exact retry: idempotent, no duplicate rows.
  const retry = review(db, trip.id, trip.revision, "rev-1", [strainFlag(day2), { category: "missing_information", severity: "info", opinion: "Lodging is still open", rationale: "No anchor saved for any night", dayRefs: [], stopRefs: [] }])!;
  assert.equal(retry.replayed, true);
  assert.equal(retry.trip.advisories.length, 2);

  // Same mutation id with a different payload is a different change.
  assert.throws(() => review(db, trip.id, trip.revision, "rev-1", [strainFlag(day2)]), (error: unknown) => error instanceof RejectedPayload);
});

test("stale reviews conflict and leave no rows", () => {
  const { db, trip } = plannerTrip();
  const before = (db.prepare(`SELECT COUNT(*) AS n FROM trip_advisories`).get() as { n: number }).n;
  assert.throws(
    () => review(db, trip.id, trip.revision + 3, "rev-stale", [strainFlag(trip.days[0]!.id)]),
    (error: unknown) => error instanceof TripConflict,
  );
  const after = (db.prepare(`SELECT COUNT(*) AS n FROM trip_advisories`).get() as { n: number }).n;
  assert.equal(after, before);
});

test("invalid flags and unknown references reject the whole review atomically", () => {
  const { db, trip } = plannerTrip();
  const day1 = trip.days[0]!.id;
  const good = { category: "strain", severity: "info", opinion: "Fine", rationale: "Because" };
  const cases: unknown[] = [
    [],
    [{ ...good, category: "route_times" }],
    [{ ...good, severity: "catastrophic" }],
    [{ ...good, opinion: "" }],
    [{ ...good, opinion: "x".repeat(241) }],
    [{ ...good, rationale: "" }],
    [{ ...good, dayRefs: ["no-such-day"] }],
    [{ ...good, stopRefs: ["no-such-stop"] }],
    // One bad flag rejects the whole set, including the valid one.
    [strainFlag(day1), { ...good, dayRefs: ["no-such-day"] }],
    "not-an-array",
    { category: "strain", severity: "info", opinion: "Bare flag outside the array" },
  ];
  for (const flags of cases) {
    assert.throws(
      () => review(db, trip.id, trip.revision, `bad-${JSON.stringify(flags).slice(0, 40)}`, flags),
      (error: unknown) => error instanceof RejectedPayload,
    );
  }
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trip_advisories`).get() as { n: number }).n, 0, "nothing persisted");
});

test("review payloads cannot smuggle outside facts, route data, or Library entities", () => {
  const { db, trip } = plannerTrip();
  const good = { category: "strain", severity: "info", opinion: "Fine", rationale: "Because" };
  const forbidden: Record<string, unknown>[] = [
    { url: "https://example.com/route" },
    { sourceUrl: "https://example.com/route" },
    { coordinates: { lat: 35, lng: 135 } },
    { lat: 35.01, lng: 135.77 },
    { reservation: "Ace Hotel 7pm" },
    { route: { minutes: 40, distanceKm: 12 } },
    { travelMinutes: 40 },
    { items: ["item-1"] },
    { places: ["place-1"] },
    { loadThreshold: 3 },
  ];
  let index = 0;
  for (const extra of forbidden) {
    index += 1;
    assert.throws(
      () => review(db, trip.id, trip.revision, `ext-${index}`, [{ ...good, ...extra }]),
      (error: unknown) => error instanceof RejectedPayload,
      `unknown field ${Object.keys(extra).join(",")} must be rejected`,
    );
  }
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trip_advisories`).get() as { n: number }).n, 0);
});

test("dismissal is human-only state that keeps history and stops listing the advisory", () => {
  const { db, trip } = plannerTrip();
  const first = review(db, trip.id, trip.revision, "rev-1", [strainFlag(trip.days[0]!.id)], "2026-09-01T09:00:00.000Z")!;
  const second = review(db, trip.id, first.trip.revision, "rev-2", [{ category: "travel_feasibility", severity: "urgent", opinion: "Day 3 needs a transfer plan", rationale: "No lodging anchor exists yet", dayRefs: [trip.days[2]!.id], stopRefs: [] }], "2026-09-01T10:00:00.000Z")!;
  assert.equal(second.trip.advisories.length, 2);

  const advisoryId = second.trip.advisories[0]!.id;
  const dismissed = dismissTripAdvisory(db, "local", trip.id, advisoryId, { expectedRevision: 1, clientMutationId: "dis-1" }, "2026-09-01T11:00:00.000Z")!;
  assert.equal(dismissed.advisories.length, 1, "dismissed advisories leave the current list");
  const row = db.prepare(`SELECT dismissed_at FROM trip_advisories WHERE id = ?`).get(advisoryId) as { dismissed_at: string | null };
  assert.equal(row.dismissed_at, "2026-09-01T11:00:00.000Z", "the row is retained for history");

  const again = dismissTripAdvisory(db, "local", trip.id, advisoryId, { expectedRevision: 1, clientMutationId: "dis-2" }, "2026-09-01T12:00:00.000Z")!;
  assert.equal(again.advisories.length, 1, "dismissing twice stays idempotent");
  const rowAgain = db.prepare(`SELECT dismissed_at FROM trip_advisories WHERE id = ?`).get(advisoryId) as { dismissed_at: string | null };
  assert.equal(rowAgain.dismissed_at, "2026-09-01T11:00:00.000Z", "the first dismissal timestamp wins");

  assert.throws(() => dismissTripAdvisory(db, "local", trip.id, "missing-advisory", { expectedRevision: 1, clientMutationId: "dis-x" }), (error: unknown) => error instanceof RejectedPayload);
  assert.equal(dismissTripAdvisory(db, "hosted-b", trip.id, advisoryId, { expectedRevision: 1, clientMutationId: "dis-y" }), null, "another library cannot dismiss");
  assert.equal(review(db, "hosted-b", 1, "rev-x", [strainFlag("day")]), null, "another library cannot record a review");
});

test("dismissed advisory history is library-scoped, complete, and honest about removed references", () => {
  const { db, trip } = plannerTrip();
  const withStop = apply(db, trip.id, trip.revision, "s-1", [addStopOp(trip.days[0]!.id, "Fushimi Inari")])!;
  const stopId = withStop.trip.days[0]!.stops[0]!.id;
  const day3 = trip.days[2]!.id;
  const flagged = review(db, trip.id, withStop.trip.revision, "rev-1", [
    { category: "strain", severity: "concern", opinion: "Too much for one afternoon", rationale: "Five timed stops and no lunch gap", dayRefs: [day3], stopRefs: [stopId] },
  ])!;
  const advisoryId = flagged.trip.advisories[0]!.id;
  const dismissedAt = "2026-09-01T11:00:00.000Z";
  dismissTripAdvisory(db, "local", trip.id, advisoryId, { expectedRevision: withStop.trip.revision, clientMutationId: "dis-1" }, dismissedAt)!;

  assert.equal(getTrip(db, "local", trip.id)!.advisories.length, 0, "a fresh document read omits the dismissed card");

  const history = getTripHistory(db, "local", trip.id)!;
  const record = history.dismissedAdvisories.find((row) => row.id === advisoryId)!;
  assert.deepEqual(
    [record.opinion, record.rationale, record.category, record.severity, record.reviewedRevision, record.dayRefs, record.stopRefs, record.actor, record.createdAt, record.dismissedAt],
    ["Too much for one afternoon", "Five timed stops and no lunch gap", "strain", "concern", withStop.trip.revision, [day3], [stopId], "agent", TS, dismissedAt],
  );
  assert.deepEqual(listDismissedAdvisories(db, "local", trip.id)!.map((row) => row.id), [advisoryId]);
  const row = db.prepare(`SELECT dismissed_at FROM trip_advisories WHERE id = ?`).get(advisoryId) as { dismissed_at: string | null };
  assert.equal(row.dismissed_at, dismissedAt, "the database row is retained");

  assert.equal(listDismissedAdvisories(db, "hosted-b", trip.id), null, "another library cannot read the dismissed history");
  assert.equal(getTripHistory(db, "hosted-b", trip.id), null, "another library cannot read the history at all");

  // Removing the referenced stop and shrinking the trip past the referenced
  // day never rewrites the stored record: rendering resolves honesty later.
  apply(db, trip.id, withStop.trip.revision, "s-2", [{ type: "removeStop", stopId }]);
  updateTripSetup(db, "local", trip.id, { expectedRevision: withStop.trip.revision + 1, clientMutationId: "shrink-1", destination: "Kyoto", durationDays: 2 });
  const after = getTripHistory(db, "local", trip.id)!;
  const recordAfter = after.dismissedAdvisories.find((entry) => entry.id === advisoryId)!;
  assert.deepEqual([recordAfter.dayRefs, recordAfter.stopRefs], [[day3], [stopId]], "removed references stay as the original ids");
});

test("dismissed advisory history is newest-first and capped at 100", () => {
  const { db, trip } = plannerTrip();
  const day = trip.days[0]!.id;
  let newestId = "";
  for (let i = 0; i < 101; i += 1) {
    const created = new Date(Date.UTC(2026, 8, 1, 0, 0, i)).toISOString();
    const dismissedAt = new Date(Date.UTC(2026, 8, 1, 1, 0, i)).toISOString();
    const saved = review(db, trip.id, 1, `bound-${i}`, [strainFlag(day)], created)!;
    const id = saved.trip.advisories[0]!.id;
    dismissTripAdvisory(db, "local", trip.id, id, { expectedRevision: 1, clientMutationId: `dis-bound-${i}` }, dismissedAt);
    newestId = id;
  }
  const list = listDismissedAdvisories(db, "local", trip.id)!;
  assert.equal(list.length, 100);
  assert.equal(list[0]!.id, newestId, "newest dismissal is first");
  assert.equal(getTrip(db, "local", trip.id)!.advisories.length, 0, "the cap never leaks dismissed rows onto the document");
});

test("later itinerary edits mark advisories stale without rewriting them", () => {
  const { db, trip } = plannerTrip();
  const saved = review(db, trip.id, trip.revision, "rev-1", [strainFlag(trip.days[1]!.id)])!.trip.advisories[0]!;
  apply(db, trip.id, trip.revision, "m-1", [addStopOp(trip.days[1]!.id, "Extra stop")]);
  const afterEdit = getTrip(db, "local", trip.id)!;
  const advisory = afterEdit.advisories.find((row) => row.id === saved.id)!;
  assert.deepEqual(
    [advisory.opinion, advisory.rationale, advisory.reviewedRevision, advisory.category],
    [saved.opinion, saved.rationale, saved.reviewedRevision, saved.category],
    "edits never rewrite saved opinions",
  );
  assert.ok(advisory.reviewedRevision < afterEdit.revision, "the UI derives staleness from the revision gap");
  updateTripSetup(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "stale-setup", destination: "Kyoto", durationDays: 3 });
  const afterSetup = getTrip(db, "local", trip.id)!;
  assert.ok(afterSetup.advisories.every((row) => row.reviewedRevision < afterSetup.revision), "setup edits also age advisories");
});

// ---------- Ticket 10: base builds and inferred preferences ----------

function buildAs(
  db: ReturnType<typeof mem>,
  tripId: string,
  revision: number,
  clientMutationId: string,
  instruction: string,
  selectedSources: Array<{ kind: "item" | "place"; id: string }>,
  actor: string,
  overrides: Record<string, unknown> = {},
  at = TS,
): TripMutationResult | null {
  const operations = selectedSources.map((source) =>
    source.kind === "item"
      ? { type: "addStop", dayId: null, content: { kind: "item", itemId: source.id } }
      : { type: "addStop", dayId: null, content: { kind: "place", placeId: source.id } },
  );
  return applyTripChanges(db, "local", tripId, { expectedRevision: revision, clientMutationId, instruction, operations, ...overrides }, actor, at);
}

test("a base build is one atomic agent changeset of Draft stops on Unscheduled", () => {
  const { db, trip } = plannerTrip();
  seedItem(db, "item-b1", "Kyoto tea guide", "steep it cool", "https://x.com/a/status/b1");
  const place = createPlace(db, "local", { name: "Nanzen-ji", kind: "landmark" });

  const built = buildAs(
    db,
    trip.id,
    1,
    "build-1",
    "plan a base itinerary from my saved Kyoto places",
    [
      { kind: "item", id: "item-b1" },
      { kind: "place", id: place.id },
    ],
    "agent",
  )!;
  assert.equal(built.trip.revision, 2, "one changeset, one revision bump");
  assert.equal(built.changeset.actor, "agent");
  assert.equal(built.changeset.instruction, "plan a base itinerary from my saved Kyoto places");
  assert.equal(built.trip.unscheduled.length, 2, "both Draft stops land on Unscheduled");
  assert.ok(built.trip.days.every((day) => day.stops.length === 0), "the build never writes into a planned day");
  for (const stop of built.trip.unscheduled) {
    assert.equal(stop.state, "draft", "every generated stop begins Draft");
    assert.deepEqual(stop.provenance, { actor: "agent", via: "agent" });
  }

  // Replay with the same client mutation id is idempotent and adds nothing.
  const replay = buildAs(
    db,
    trip.id,
    1,
    "build-1",
    "plan a base itinerary from my saved Kyoto places",
    [
      { kind: "item", id: "item-b1" },
      { kind: "place", id: place.id },
    ],
    "agent",
  )!;
  assert.equal(replay.replayed, true);
  assert.equal(replay.trip.revision, 2);
  assert.equal(replay.trip.unscheduled.length, 2);
});

test("unknown or foreign build sources reject the whole changeset — no stops, no inferences", () => {
  const { db, trip } = plannerTrip();
  const foreign = createPlace(db, "hosted-b", { name: "Goa beach" });

  for (const [index, sources] of [
    [{ kind: "item", id: "ghost-item" }],
    [{ kind: "place", id: "ghost-place" }],
    [{ kind: "place", id: foreign.id }],
  ].entries()) {
    assert.throws(
      () => buildAs(db, trip.id, 1, `bad-${index}`, "build it", sources as Array<{ kind: "item" | "place"; id: string }>, "agent", {
        inferredPreferences: [{ text: "likes temples", basis: "interests" }],
      }),
      (error: unknown) => error instanceof RejectedPayload,
    );
  }
  const after = getTrip(db, "local", trip.id)!;
  assert.equal(after.revision, 1, "stale/partial builds leave the revision alone");
  assert.equal(after.unscheduled.length, 0, "no stop leaked out of the rolled-back changeset");
  assert.deepEqual(after.inferences, [], "no inference leaked out of the rolled-back changeset");
  assert.deepEqual(after.context.interests, [], "inferences never touch user context");
});

test("inferred preferences persist as labelled document inferences, removable by the human", () => {
  const { db, trip } = plannerTrip();
  seedItem(db, "item-b2", null, "morning markets", "https://x.com/a/status/b2");

  // Omitted inferences invent nothing.
  const plain = buildAs(db, trip.id, 1, "b-plain", "build it", [{ kind: "item", id: "item-b2" }], "agent")!;
  assert.deepEqual(plain.trip.inferences, []);

  const built = buildAs(
    db,
    trip.id,
    2,
    "b-inf",
    "build it",
    [{ kind: "item", id: "item-b2" }],
    "agent",
    { inferredPreferences: [{ text: "prefers slow mornings", basis: "pace: slow mornings" }, { text: "likes markets", basis: "saved item: morning markets" }] },
  )!;
  assert.equal(built.trip.inferences.length, 2);
  assert.deepEqual(built.trip.inferences.map((entry) => [entry.text, entry.basis]), [
    ["prefers slow mornings", "pace: slow mornings"],
    ["likes markets", "saved item: morning markets"],
  ]);
  assert.deepEqual(built.trip.context, trip.context, "inferences never merge into user-entered context");
  assert.equal(built.trip.revision, 3);

  // A retry with a different inference payload on the same mutation id is rejected.
  assert.throws(
    () =>
      buildAs(db, trip.id, 2, "b-inf", "build it", [{ kind: "item", id: "item-b2" }], "agent", {
        inferredPreferences: [{ text: "changed opinion", basis: "nowhere" }],
      }),
    (error: unknown) => error instanceof RejectedPayload,
  );

  // Human removal: the labelled annotation goes, identity and revision stay.
  const inferenceId = built.trip.inferences[0]!.id;
  const removed = removeTripInference(db, "local", trip.id, inferenceId, { expectedRevision: 3, clientMutationId: "rm-inf-1" })!;
  assert.deepEqual(removed.inferences.map((entry) => entry.text), ["likes markets"]);
  assert.equal(removed.revision, 3, "label cleanup is not an itinerary changeset");
  assert.throws(() => removeTripInference(db, "local", trip.id, inferenceId, { expectedRevision: 3, clientMutationId: "rm-inf-2" }), (error: unknown) => error instanceof RejectedPayload);
  assert.equal(removeTripInference(db, "hosted-b", trip.id, built.trip.inferences[1]!.id, { expectedRevision: 3, clientMutationId: "rm-inf-x" }), null, "another library cannot remove");
  assert.equal(removeTripInference(db, "local", "missing-trip", "x", { expectedRevision: 1, clientMutationId: "rm-inf-m" }), null);
});

test("only the agent adapter can save inferred preferences, and stale builds roll them back", () => {
  const { db, trip } = plannerTrip();
  seedItem(db, "item-b3", null, "body", "https://x.com/a/status/b3");
  const sources = [{ kind: "item" as const, id: "item-b3" }];

  assert.throws(
    () => buildAs(db, trip.id, 1, "h-1", "user build", sources, "user", { inferredPreferences: [{ text: "x", basis: "y" }] }),
    (error: unknown) => error instanceof RejectedPayload && /agent adapter/.test(error.message),
    "the human seam never sets inferences",
  );
  assert.deepEqual(getTrip(db, "local", trip.id)!.inferences, []);

  // A stale revision rejects the entire call — stops and inferences alike.
  assert.throws(
    () =>
      applyTripChanges(
        db,
        "local",
        trip.id,
        {
          expectedRevision: 99,
          clientMutationId: "s-1",
          instruction: "build",
          operations: [{ type: "addStop", dayId: null, content: { kind: "item", itemId: "item-b3" } }],
          inferredPreferences: [{ text: "likes tea", basis: "saved item" }],
        },
        "agent",
      ),
    (error: unknown) => error instanceof TripConflict,
  );
  const after = getTrip(db, "local", trip.id)!;
  assert.equal(after.revision, 1);
  assert.equal(after.unscheduled.length, 0);
  assert.deepEqual(after.inferences, []);

  // Over-bounds inferences reject the whole call.
  assert.throws(
    () => buildAs(db, trip.id, 1, "b-9", "build", sources, "agent", { inferredPreferences: Array.from({ length: 9 }, (_, i) => ({ text: `t${i}`, basis: "b" })) }),
    (error: unknown) => error instanceof RejectedPayload && /at most 8/.test(error.message),
  );
  assert.throws(
    () => buildAs(db, trip.id, 1, "b-10", "build", sources, "agent", { inferredPreferences: [{ text: "", basis: "b" }] }),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.deepEqual(getTrip(db, "local", trip.id)!.inferences, []);
});

test("undo of a base build restores inferred preferences", () => {
  const { db, trip } = plannerTrip();
  seedItem(db, "item-undo-inf", null, "body", "https://x.com/a/status/undo-inf");
  const built = buildAs(
    db,
    trip.id,
    1,
    "b-undo-inf",
    "build",
    [{ kind: "item", id: "item-undo-inf" }],
    "agent",
    { inferredPreferences: [{ text: "slow mornings", basis: "pace" }] },
  )!;
  assert.equal(built.trip.inferences.length, 1);
  const undone = undoTripChanges(db, "local", trip.id, { expectedRevision: 2, clientMutationId: "u-inf" }, "user")!;
  assert.deepEqual(undone.trip.inferences, []);
  assert.equal(undone.trip.unscheduled.length, 0);
  const redone = redoTripChanges(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "r-inf" }, "user")!;
  assert.equal(redone.trip.inferences.length, 1);
  assert.equal(redone.trip.inferences[0]!.text, "slow mornings");
  assert.equal(redone.trip.unscheduled.length, 1);
  assert.equal(redone.trip.unscheduled[0]!.state, "draft");
});
