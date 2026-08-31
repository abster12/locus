import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { applyTripChanges, createTrip, type TripDocument } from "../server/trips/module.ts";
import { parseTimeWindow, projectTripOverview, projectTripSchedule } from "../server/trips/projections.ts";

const TS = "2026-09-01T09:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-projections-")), "t.db"));
}

function makeTrip(db: ReturnType<typeof mem>, stops: { dayIndex: number; title: string; timeWindow?: string }[]): { db: ReturnType<typeof mem>; trip: TripDocument } {
  const trip = createTrip(db, "local", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-14", timezone: "Asia/Tokyo" }, TS);
  let revision = trip.revision;
  let latest = trip;
  for (const entry of stops) {
    const result = applyTripChanges(
      db,
      "local",
      trip.id,
      {
        expectedRevision: revision,
        clientMutationId: `op-${latest.revision}-${entry.title}`,
        operations: [
          {
            type: "addStop",
            dayId: latest.days[entry.dayIndex]!.id,
            content: { kind: "outside", title: entry.title, notes: null, url: null },
            timeWindow: entry.timeWindow ?? null,
          },
        ],
      },
      "user",
      TS,
    );
    assert.ok(result, "changeset applied");
    latest = result.trip;
    revision = result.trip.revision;
  }
  return { db, trip: latest };
}

test("parseTimeWindow is strict: only a complete valid range is timed", () => {
  const timed: [string, number, number][] = [
    ["09:00–11:00", 540, 660],
    ["09:00-11:00", 540, 660],
    [" 9:05 - 10:30 ", 545, 630],
    ["00:00-23:59", 0, 23 * 60 + 59],
  ];
  for (const [text, start, end] of timed) {
    assert.deepEqual(parseTimeWindow(text), { start, end }, `timed: ${text}`);
  }

  const untimed: (string | null)[] = [
    "09:00–25:00", // invalid end clock
    "25:00–11:00", // invalid start clock
    "09:99-11:00", // invalid minutes
    "24:00-01:00", // hour 24 is not a 24-hour clock time
    "11:00-09:00", // reversed ranges are not swapped into another window
    "09:00-09:00", // identical endpoints
    null,
    "",
    "09:00", // missing end
    "from 9:05", // missing end inside prose
    "opens 06:00, closes 18:00", // prose around the times
    "09:00–11:00 extra", // trailing text
    "after breakfast", // no clock time at all
  ];
  for (const text of untimed) {
    assert.equal(parseTimeWindow(text), null, `untimed: ${String(text)}`);
  }
});

test("overview derives identity, health, anchors, and conflicts from one document", () => {
  const { db, trip } = makeTrip(mem(), [
    { dayIndex: 0, title: "Fushimi Inari", timeWindow: "09:00–11:00" },
    { dayIndex: 0, title: "Nishiki Market", timeWindow: "13:00–15:00" },
    { dayIndex: 0, title: "Gion walk" },
  ]);
  const overview = projectTripOverview(trip);
  assert.equal(overview.stopCount, 3);
  assert.equal(overview.holeCount, 0);
  assert.equal(overview.emptyDayCount, 2);
  assert.equal(overview.unscheduledCount, 0);
  assert.equal(overview.conflictCount, 0, "disjoint ranges do not conflict");
  assert.deepEqual(
    overview.days.map((day) => [day.label, day.stopCount, day.isEmpty]),
    [
      ["Day 1", 3, false],
      ["Day 2", 0, true],
      ["Day 3", 0, true],
    ],
  );
  const day1 = overview.days[0]!;
  assert.deepEqual(day1.timeRange, { start: "09:00", end: "15:00" });
  assert.equal(day1.timedCount, 2);
  assert.deepEqual(
    day1.anchors.map((anchor) => [anchor.time, anchor.title]),
    [
      ["09:00", "Fushimi Inari"],
      ["13:00", "Nishiki Market"],
      [null, "Gion walk"],
    ],
    "anchors carry the first stops and never invent times",
  );
});

test("an overlap is flagged only when both saved windows are ranges that intersect", () => {
  const overlapping = makeTrip(mem(), [
    { dayIndex: 0, title: "Kiyomizu-dera", timeWindow: "09:00–11:00" },
    { dayIndex: 0, title: "Weekenders Coffee", timeWindow: "10:00–12:00" },
  ]);
  const day1 = projectTripOverview(overlapping.trip).days[0]!;
  assert.equal(day1.conflicts.length, 1);
  assert.match(day1.conflicts[0]!, /Kiyomizu-dera overlaps Weekenders Coffee/);

  const startOnly = makeTrip(mem(), [
    { dayIndex: 0, title: "Kiyomizu-dera", timeWindow: "opens 09:00" },
    { dayIndex: 0, title: "Weekenders Coffee", timeWindow: "10:00–12:00" },
  ]);
  assert.deepEqual(projectTripOverview(startOnly.trip).days[0]!.conflicts, [], "start-only windows never claim a conflict");

  const acrossDays = makeTrip(mem(), [
    { dayIndex: 0, title: "A", timeWindow: "09:00–11:00" },
    { dayIndex: 1, title: "B", timeWindow: "10:00–12:00" },
  ]);
  assert.equal(projectTripOverview(acrossDays.trip).conflictCount, 0, "the same clock range on different days is not a conflict");
});

test("untimed stops stay honest in the schedule projection", () => {
  const { trip } = makeTrip(mem(), [
    { dayIndex: 0, title: "Timed temple", timeWindow: "09:30–11:00" },
    { dayIndex: 0, title: "Loose idea" },
    { dayIndex: 1, title: "Also loose" },
  ]);
  const schedule = projectTripSchedule(trip);
  assert.equal(schedule.timezone, "Asia/Tokyo");
  assert.deepEqual(
    schedule.rows.map((row) => row.label),
    ["09:00"],
    "rows come only from real stop times",
  );
  const day1 = schedule.days[0]!;
  assert.equal(day1.slots.length, 1);
  assert.deepEqual(
    day1.slots[0]!.stops.map((stop) => stop.title),
    ["Timed temple"],
  );
  assert.deepEqual(
    day1.untimed.map((stop) => stop.title),
    ["Loose idea"],
  );
  assert.deepEqual(
    schedule.days[1]!.untimed.map((stop) => stop.title),
    ["Also loose"],
  );
  assert.deepEqual(schedule.days[1]!.slots, [], "no hour rows exist where no stop has a time");
  assert.deepEqual(
    schedule.unscheduled.map((stop) => stop.title),
    [],
  );
});

test("schedule places stops in their starting hour and lists unscheduled separately", () => {
  const { db, trip } = makeTrip(mem(), [{ dayIndex: 0, title: "Early", timeWindow: "08:15–09:00" }]);
  const placed = applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: trip.revision,
      clientMutationId: "unschedule-1",
      operations: [{ type: "moveStop", stopId: trip.days[0]!.stops[0]!.id, dayId: null }],
    },
    "user",
    TS,
  );
  assert.ok(placed);
  const schedule = projectTripSchedule(placed!.trip);
  assert.deepEqual(
    schedule.unscheduled.map((stop) => stop.title),
    ["Early"],
  );
  assert.equal(schedule.timedCount, 0);
  assert.deepEqual(schedule.rows, []);
});

test("both projections agree with each other and with the document they derive from", () => {
  const { trip } = makeTrip(mem(), [
    { dayIndex: 0, title: "A", timeWindow: "09:00–10:00" },
    { dayIndex: 0, title: "B" },
    { dayIndex: 2, title: "C", timeWindow: "14:00–16:00" },
  ]);
  const overview = projectTripOverview(trip);
  const schedule = projectTripSchedule(trip);
  const dayStops = trip.days.reduce((total, day) => total + day.stops.length, 0);
  assert.equal(overview.stopCount, dayStops);
  const scheduledStops = schedule.days.reduce((total, day) => total + day.slots.reduce((count, slot) => count + slot.stops.length, 0) + day.untimed.length, 0);
  assert.equal(scheduledStops, dayStops, "schedule covers exactly the same stops as overview");
  assert.equal(schedule.timedCount, 2);
  assert.equal(overview.emptyDayCount, 1);
  assert.equal(schedule.days.length, trip.days.length);
});
