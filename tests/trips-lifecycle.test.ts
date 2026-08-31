import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { applyTripChanges, createTrip, duplicateTrip, getTrip, updateTripSetup } from "../server/trips/module.ts";
import { validateTripDocument } from "../server/trips/projections.ts";
import { getShareState, previewShareSnapshot, publishShareSnapshot } from "../server/trips/share.ts";

const TS = "2026-09-01T09:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-life-")), "t.db"));
}

function env(expectedRevision: number, clientMutationId: string) {
  return { expectedRevision, clientMutationId };
}

test("shortening several days appends released stops after existing Unscheduled with contiguous positions", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-16" }, TS);
  const [day1, day2, day3, day4] = trip.days;
  applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 1,
      clientMutationId: "seed",
      operations: [
        { type: "addStop", dayId: null, content: { kind: "outside", title: "U1", notes: null, url: null } },
        { type: "addStop", dayId: null, content: { kind: "outside", title: "U2", notes: null, url: null } },
        { type: "addStop", dayId: day2!.id, content: { kind: "outside", title: "D2a", notes: null, url: null } },
        { type: "addStop", dayId: day3!.id, content: { kind: "outside", title: "D3a", notes: null, url: null } },
        { type: "addStop", dayId: day3!.id, content: { kind: "outside", title: "D3b", notes: null, url: null } },
        { type: "addStop", dayId: day4!.id, content: { kind: "outside", title: "D4a", notes: null, url: null } },
        { type: "addStop", dayId: day1!.id, content: { kind: "outside", title: "Keep", notes: null, url: null } },
      ],
    },
    "user",
    TS,
  );

  const shortened = updateTripSetup(
    db,
    "local",
    trip.id,
    { ...env(2, "shorten"), destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-13" },
    TS,
  )!;
  assert.equal(shortened.days.length, 2);
  assert.deepEqual(
    shortened.unscheduled.map((stop) => stop.content.kind === "outside" ? stop.content.title : ""),
    ["U1", "U2", "D3a", "D3b", "D4a"],
    "existing Unscheduled stay first; removed days follow in day then stop order",
  );
  assert.deepEqual(
    shortened.unscheduled.map((stop) => stop.position),
    [0, 1, 2, 3, 4],
    "Unscheduled positions are contiguous and unique",
  );
  assert.equal(shortened.unscheduled.every((stop) => stop.dayId === null), true);
  assert.deepEqual(
    shortened.days[1]!.stops.map((stop) => (stop.content.kind === "outside" ? stop.content.title : "")),
    ["D2a"],
    "kept days keep their stops",
  );

  const issues = validateTripDocument(shortened).issues.filter((issue) => issue.kind === "ordering");
  assert.deepEqual(issues, [], "validation reports no ordering conflict after shortening");
});

test("duplicate clones every private stop field, isolates mutations, and does not inherit an active share", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const day1 = trip.days[0]!.id;
  const cloneAt = "2026-09-05T09:00:00.000Z";
  const added = applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 1,
      clientMutationId: "seed",
      operations: [
        { type: "addStop", dayId: day1, content: { kind: "outside", title: "Fushimi", notes: null, url: null } },
        {
          type: "addStop",
          dayId: day1,
          content: { kind: "outside", title: "Kiyomizu", notes: "public-ish", url: "https://example.com/k" },
          timeWindow: "08:30-10:00",
          durationMinutes: 90,
          publicNotes: "Go early",
          privateNotes: "SECRET",
        },
        { type: "addStop", dayId: day1, content: { kind: "outside", title: "Gion", notes: null, url: null } },
      ],
    },
    "user",
    TS,
  )!;
  const stopId = added.trip.days[0]!.stops[1]!.id;
  applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 2,
      clientMutationId: "facts",
      operations: [
        {
          type: "updateStop",
          stopId,
          reservation: "conf-99",
          storedFacts: ["opens 06:00"],
          alternatives: ["Kodai-ji if rain"],
        },
      ],
    },
    "user",
    TS,
  );
  const sourceStop = getTrip(db, "local", trip.id)!.days[0]!.stops.find((stop) => stop.id === stopId)!;
  assert.equal(sourceStop.createdAt, TS, "sanity: source stop timestamps precede the clone clock");
  const preview = previewShareSnapshot(db, "local", trip.id)!;
  publishShareSnapshot(db, "local", trip.id, { ...env(3, "pub-1"), digest: preview.digest }, TS);
  assert.ok(getShareState(db, "local", trip.id), "source has an active share");

  const copy = duplicateTrip(db, "local", trip.id, env(3, "dup-1"), cloneAt)!;
  const titleOf = (stop: (typeof copy.days)[number]["stops"][number]) => (stop.content.kind === "outside" ? stop.content.title : "");
  const cloned = copy.days[0]!.stops.find((stop) => titleOf(stop) === "Kiyomizu")!;
  assert.notEqual(copy.id, trip.id);
  assert.notEqual(cloned.id, stopId);
  assert.notEqual(copy.days[0]!.id, day1);
  assert.equal(cloned.publicNotes, "Go early");
  assert.equal(cloned.privateNotes, "SECRET");
  assert.equal(cloned.timeWindow, "08:30-10:00");
  assert.equal(cloned.durationMinutes, 90);
  assert.equal(cloned.reservation, "conf-99");
  assert.deepEqual(cloned.storedFacts, ["opens 06:00"]);
  assert.deepEqual(cloned.alternatives, ["Kodai-ji if rain"]);
  assert.equal(cloned.state, "confirmed");
  assert.deepEqual(cloned.provenance, { actor: "user", via: "manual" });
  assert.deepEqual(cloned.content, { kind: "outside", title: "Kiyomizu", notes: "public-ish", url: "https://example.com/k" });
  assert.equal(cloned.createdAt, cloneAt, "clone stamps the duplicate mutation time, not the source timestamps");
  assert.equal(cloned.updatedAt, cloneAt);
  assert.notEqual(cloned.createdAt, sourceStop.createdAt);
  assert.equal(cloned.dayId, copy.days[0]!.id, "clone lands on the copy's new day");
  assert.deepEqual(copy.days[0]!.stops.map(titleOf), ["Fushimi", "Kiyomizu", "Gion"], "clone keeps sibling order");
  assert.deepEqual(copy.days[0]!.stops.map((stop) => stop.position), [0, 1, 2]);
  assert.equal(getShareState(db, "local", copy.id), null, "duplicate does not inherit an active Share Snapshot");
  assert.ok(getShareState(db, "local", trip.id), "source share is untouched");

  applyTripChanges(
    db,
    "local",
    copy.id,
    {
      expectedRevision: 1,
      clientMutationId: "edit-copy",
      operations: [{ type: "updateStop", stopId: cloned.id, publicNotes: "changed on copy" }],
    },
    "user",
    TS,
  );
  assert.equal(getTrip(db, "local", trip.id)!.days[0]!.stops.find((stop) => stop.id === stopId)!.publicNotes, "Go early", "editing the copy leaves the source stop alone");
  assert.equal(getTrip(db, "local", copy.id)!.days[0]!.stops.find((stop) => stop.id === cloned.id)!.publicNotes, "changed on copy");
});
