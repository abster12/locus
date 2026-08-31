import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { applyTripChanges, createTrip, type TripDocument, type TripStopOp } from "../server/trips/module.ts";
import { parseTimeWindow } from "../server/trips/projections.ts";
import { prepareShareSnapshot } from "../server/trips/share.ts";
import {
  exportFileName,
  exportTripHtml,
  exportTripIcs,
  exportTripText,
  projectTripForExport,
  type ExportStop,
  type ExportTrip,
} from "../server/trips/export.ts";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-export-")), "t.db"));
}

type Db = ReturnType<typeof mem>;

function change(database: Db, tripId: string, revision: number, clientMutationId: string, operations: TripStopOp[], overrides: Record<string, unknown> = {}, actor = "user"): TripDocument {
  const result = applyTripChanges(database, "local", tripId, { expectedRevision: revision, clientMutationId, operations, ...overrides }, actor);
  assert.ok(result);
  return result.trip;
}

function outside(title: string, url: string | null = null) {
  return { kind: "outside" as const, title, notes: null, url };
}

// ---------- text ----------

test("text export preserves order, times, public notes, and hole markers without private notes", () => {
  const database = mem();
  const trip = createTrip(
    database,
    "local",
    { destination: "Kyoto, Japan", startDate: "2026-10-12", endDate: "2026-10-13", timezone: "Asia/Tokyo", title: "Kyoto in October" },
    "2026-09-01T09:00:00.000Z",
  );
  const withStop = change(database, trip.id, trip.revision, "e1", [
    { type: "addStop", dayId: trip.days[0]!.id, content: outside("Fushimi Inari"), timeWindow: "15:00", durationMinutes: 120 },
  ]);
  const stopId = withStop.days[0]!.stops[0]!.id;
  const withNotes = change(database, trip.id, withStop.revision, "e2", [
    { type: "updateStop", stopId, publicNotes: "Go early", privateNotes: "PRIVATE-TRAIN-CODE" },
    { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "hole", request: "quiet dinner near Gion" }, afterStopId: stopId, timeWindow: "19:30" },
    { type: "addStop", dayId: trip.days[1]!.id, content: outside("Nara deer park") },
    { type: "addStop", dayId: null, content: outside("Kurama day trip", "https://example.com/kurama") },
  ]);

  const text = exportTripText(projectTripForExport(withNotes));
  assert.match(text, /^Kyoto in October\n/);
  assert.match(text, /Kyoto, Japan · 2026-10-12 – 2026-10-13 · Asia\/Tokyo/);
  const day1 = text.indexOf("Day 1 · 2026-10-12");
  const day2 = text.indexOf("Day 2 · 2026-10-13");
  const unscheduled = text.indexOf("Unscheduled");
  assert.ok(day1 >= 0 && day2 > day1 && unscheduled > day2, "day then unscheduled order");
  assert.match(text, /15:00 Fushimi Inari · 120 min/);
  assert.match(text, /· Go early/);
  assert.doesNotMatch(text, /PRIVATE-TRAIN-CODE/);
  assert.match(text, /Open: quiet dinner near Gion/);
  assert.match(text, /↗ https:\/\/example\.com\/kurama/);
  assert.equal(text, exportTripText(projectTripForExport(withNotes)), "deterministic");
});

test("agent drafts export marked as drafts in text and html", () => {
  const database = mem();
  const trip = createTrip(database, "local", { destination: "Kochi", durationDays: 2 }, "2026-09-01T09:00:00.000Z");
  const drafted = change(
    database,
    trip.id,
    trip.revision,
    "a1",
    [{ type: "addStop", dayId: trip.days[0]!.id, content: outside("Tasting menu") }],
    { instruction: "add a dinner idea" },
    "agent",
  );
  assert.equal(drafted.days[0]!.stops[0]!.state, "draft");
  const projection = projectTripForExport(drafted);
  assert.match(exportTripText(projection), /Tasting menu \(draft\)/);
  assert.match(exportTripHtml(projection), /Tasting menu \(draft\)/);
});

// ---------- html ----------

test("html export escapes markup, excludes private fields, and is self-contained", () => {
  const database = mem();
  const trip = createTrip(
    database,
    "local",
    { destination: "Kochi & coast <b>", durationDays: 2, title: 'A "quoted" <title>' },
    "2026-09-01T09:00:00.000Z",
  );
  const withStop = change(database, trip.id, trip.revision, "h1", [
    { type: "addStop", dayId: trip.days[0]!.id, content: outside("Nara deer park", "https://example.com/deer"), timeWindow: "09:00" },
  ]);
  const stopId = withStop.days[0]!.stops[0]!.id;
  const withNotes = change(database, trip.id, withStop.revision, "h2", [
    { type: "updateStop", stopId, publicNotes: "Feed only the crackers", privateNotes: "PRIVATE-HOTEL-ADDRESS" },
  ]);
  const projection = projectTripForExport(withNotes);
  const html = exportTripHtml(projection, { updatedAt: "2026-09-02T08:00:00.000Z" });

  assert.doesNotMatch(html, /<script|<img|<iframe/);
  assert.ok(!html.includes("coast <b>") && html.includes("coast &lt;b&gt;"), "markup in fields is escaped, not rendered");
  assert.ok(html.includes("&quot;quoted&quot;") && html.includes("Kochi &amp; coast"));
  assert.ok(html.includes("https://example.com/deer"), "public source link survives");
  assert.equal(html.match(/https?:\/\//g)?.length, 1, "the only URL is the public source link");
  assert.doesNotMatch(html, /PRIVATE-HOTEL-ADDRESS/);
  assert.ok(html.includes("Last updated 2026-09-02T08:00:00.000Z"));
  assert.ok(html.includes("@media print"), "the same file is the print view");
  assert.ok(html.includes("09:00") && html.includes("Feed only the crackers"));
  assert.doesNotMatch(exportTripHtml(projection), /Last updated/, "no timestamp invented when none is passed");
  assert.ok(!html.includes("127.0.0.1") && !html.includes("localhost"), "no Locus server dependency");
});

// ---------- calendar ----------

test("timed stops convert wall time through the document timezone, DST-safe", () => {
  const summer: ExportTrip = {
    title: "New York week",
    destination: "New York",
    timezone: "America/New_York",
    startDate: "2026-07-01",
    endDate: "2026-07-01",
    durationDays: 1,
    days: [{ label: "Day 1", date: "2026-07-01", stops: [{ name: "Lunch", kind: "outside", timeWindow: "12:00-13:00", durationMinutes: 60, notes: null, sourceUrl: null, location: null }] }],
    unscheduled: [],
  };
  const winter: ExportTrip = {
    ...summer,
    startDate: "2026-01-15",
    endDate: "2026-01-15",
    days: [{ label: "Day 1", date: "2026-01-15", stops: summer.days[0]!.stops }],
  };
  assert.match(exportTripIcs(summer), /DTSTART:20260701T160000Z/, "EDT is UTC-4");
  assert.match(exportTripIcs(winter), /DTSTART:20260115T170000Z/, "EST is UTC-5");
});

test("duration produces DTEND; repeated exports keep stable event identities", () => {
  const trip: ExportTrip = {
    title: "Kyoto in October",
    destination: "Kyoto",
    timezone: "Asia/Tokyo",
    startDate: "2026-10-12",
    endDate: "2026-10-13",
    durationDays: 2,
    days: [
      {
        label: "Day 1",
        date: "2026-10-12",
        stops: [
          { name: "Fushimi Inari", kind: "outside", timeWindow: "15:00-16:30", durationMinutes: 90, notes: null, sourceUrl: null, location: null, uid: "stop-uuid-1" },
          { name: "Museum", kind: "outside", timeWindow: "10:00-11:00", durationMinutes: null, notes: null, sourceUrl: null, location: null },
        ],
      },
    ],
    unscheduled: [],
  };
  const first = exportTripIcs(trip, { stamp: "2026-09-01T09:00:00.000Z" });
  const second = exportTripIcs(trip, { stamp: "2026-09-01T09:00:00.000Z" });
  assert.equal(first, second, "same input, same calendar");
  assert.match(first, /UID:stop-uuid-1@locus/, "private stop ids become stable UIDs");
  assert.match(first, /DTSTART:20261012T060000Z/, "15:00 Tokyo is 06:00Z");
  assert.match(first, /DTEND:20261012T073000Z/, "90 minutes after the start");
  assert.match(first, /DTSTAMP:20260901T090000Z/);
  const uids = [...first.matchAll(/UID:(.+)/g)].map((match) => match[1]);
  assert.equal(new Set(uids).size, uids.length, "every event has a unique uid");
  assert.ok(!uids.includes(undefined));
  const derived = [...first.matchAll(/UID:([0-9a-f]{8})@locus/g)].map((match) => match[1]);
  assert.equal(derived.length, 1, "the content-derived uid is deterministic");
});

test("untimed stops become all-day events; undated content never invents a clock time", () => {
  const dated: ExportTrip = {
    title: "Kyoto",
    destination: "Kyoto",
    timezone: "Asia/Tokyo",
    startDate: "2026-10-12",
    endDate: "2026-10-12",
    durationDays: 1,
    days: [
      { label: "Day 1", date: "2026-10-12", stops: [{ name: "Nara deer park", kind: "outside", timeWindow: null, durationMinutes: null, notes: null, sourceUrl: null, location: null }] },
    ],
    unscheduled: [{ name: "Kurama day trip", kind: "outside", timeWindow: "15:00", durationMinutes: null, notes: "wants a day", sourceUrl: null, location: null }],
  };
  const ics = exportTripIcs(dated);
  assert.match(ics, /DTSTART;VALUE=DATE:20261012/, "untimed on a dated day is an all-day event");
  const journal = ics.slice(ics.indexOf("BEGIN:VJOURNAL"));
  assert.ok(journal.includes("BEGIN:VJOURNAL") && !journal.includes("DTSTART"), "unscheduled content gets no date or time");
  assert.match(journal, /Time: 15:00 \(no date assigned\)/, "the known time is described, not placed");
  assert.match(journal, /SUMMARY:Kurama day trip/);

  const open: ExportTrip = {
    ...dated,
    startDate: null,
    endDate: null,
    durationDays: 2,
    days: [{ label: "Day 1", date: null, stops: [{ name: "Morning market", kind: "outside", timeWindow: "08:00", durationMinutes: null, notes: null, sourceUrl: null, location: null }] }],
  };
  const openIcs = exportTripIcs(open);
  assert.ok(openIcs.includes("BEGIN:VJOURNAL") && !openIcs.includes("BEGIN:VEVENT"), "no date means no event time");
  assert.match(openIcs, /DESCRIPTION:.*Time: 08:00 \(no date assigned\)/);
});

test("ics escapes text and folds long lines with CRLF", () => {
  const longName = "A".repeat(120);
  const trip: ExportTrip = {
    title: "Escape; test, with \\ slashes\nand newline",
    destination: "Somewhere",
    timezone: null,
    startDate: null,
    endDate: null,
    durationDays: 1,
    days: [{ label: "Day 1", date: null, stops: [{ name: longName, kind: "outside", timeWindow: null, durationMinutes: null, notes: null, sourceUrl: null, location: null }] }],
    unscheduled: [],
  };
  const ics = exportTripIcs(trip);
  assert.ok(ics.includes("\r\n"), "CRLF line endings");
  assert.ok(ics.includes("X-WR-CALNAME:Escape\\; test\\, with \\\\ slashes\\nand newline"), "value escaping");
  for (const line of ics.split("\r\n")) {
    assert.ok(line.length <= 75, `folded line length: ${line.length}`);
  }
  assert.ok(
    [...ics.split("\r\n")].some((line) => line.startsWith(" ") && line.trim().startsWith("A")),
    "long values continue with a folded space",
  );
});

test("the sanitized snapshot exports without drafts or private notes", () => {
  const database = mem();
  const trip = createTrip(database, "local", { destination: "Kyoto", durationDays: 1 }, "2026-09-01T09:00:00.000Z");
  const withStop = change(database, trip.id, trip.revision, "s1", [
    { type: "addStop", dayId: trip.days[0]!.id, content: outside("Fushimi Inari"), timeWindow: "15:00" },
  ]);
  const stopId = withStop.days[0]!.stops[0]!.id;
  change(database, trip.id, withStop.revision, "s2", [
    { type: "updateStop", stopId, publicNotes: "Go early", privateNotes: "PRIVATE-TICKET-REFERENCE" },
    { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "hole", request: "quiet dinner" } },
  ], { instruction: "find dinner" });
  const drafted = change(database, trip.id, withStop.revision + 1, "s3", [
    { type: "addStop", dayId: trip.days[0]!.id, content: outside("Random bar") },
  ], { instruction: "add a bar" }, "agent");
  const snapshot = prepareShareSnapshot(database, drafted);
  const text = exportTripText(snapshot);
  const html = exportTripHtml(snapshot);
  const ics = exportTripIcs(snapshot);
  for (const output of [text, html, ics]) {
    assert.ok(!output.includes("PRIVATE-TICKET-REFERENCE"), "private note excluded");
    assert.ok(!output.includes("Random bar"), "draft stops stay out of the sanitized projection");
    assert.ok(output.includes("Fushimi Inari"));
    assert.ok(output.includes("Go early"));
    assert.ok(output.includes("quiet dinner") || output.includes("Open: quiet dinner"));
  }
});

test("invalid and reversed times stay visible in text/HTML but never invent ICS clock times", () => {
  const trip: ExportTrip = {
    title: "Kyoto",
    destination: "Kyoto",
    timezone: "Asia/Tokyo",
    startDate: "2026-10-12",
    endDate: "2026-10-12",
    durationDays: 1,
    days: [
      {
        label: "Day 1",
        date: "2026-10-12",
        stops: [
          { name: "Impossible hour", kind: "outside", timeWindow: "25:00", durationMinutes: null, notes: null, sourceUrl: null, location: null },
          { name: "Impossible minute", kind: "outside", timeWindow: "09:99", durationMinutes: null, notes: null, sourceUrl: null, location: null },
          { name: "Reversed range", kind: "outside", timeWindow: "11:00-09:00", durationMinutes: null, notes: null, sourceUrl: null, location: null },
          { name: "Partially malformed", kind: "outside", timeWindow: "09:00–25:00", durationMinutes: null, notes: null, sourceUrl: null, location: null },
          { name: "Valid range", kind: "outside", timeWindow: "09:00-11:00", durationMinutes: null, notes: null, sourceUrl: null, location: null },
        ],
      },
    ],
    unscheduled: [],
  };
  const text = exportTripText(trip);
  const html = exportTripHtml(trip);
  assert.match(text, /25:00 Impossible hour/);
  assert.match(text, /09:99 Impossible minute/);
  assert.match(text, /11:00-09:00 Reversed range/);
  assert.match(text, /09:00–25:00 Partially malformed/);
  assert.match(html, /25:00/);
  assert.match(html, /09:99/);
  assert.match(html, /09:00–25:00/);
  const ics = exportTripIcs(trip);
  assert.equal([...ics.matchAll(/DTSTART;VALUE=DATE:20261012/g)].length, 4, "legacy invalid data exports as untimed all-day content");
  assert.match(ics, /DTSTART:20261012T000000Z/, "09:00 Tokyo is still a real timed event");
  assert.doesNotMatch(ics, /DTSTART:20261013/, "25:00 must not roll onto the next calendar day");
});

 test("projections and exports agree on which time windows are timed", () => {
  // The same samples the shared parser table covers: export code must never
  // disagree with projections about whether a stop is timed.
  const samples: (string | null)[] = [
    "09:00–11:00",
    "09:00-11:00",
    " 9:05 - 10:30 ",
    "00:00-23:59",
    "09:00–25:00",
    "25:00–11:00",
    "09:99-11:00",
    "24:00-01:00",
    "11:00-09:00",
    "09:00-09:00",
    null,
    "",
    "09:00",
    "from 9:05",
    "opens 06:00, closes 18:00",
    "09:00–11:00 extra",
  ];
  for (const sample of samples) {
    const trip: ExportTrip = {
      title: "Agreement",
      destination: "Kyoto",
      timezone: "Asia/Tokyo",
      startDate: "2026-10-12",
      endDate: "2026-10-12",
      durationDays: 1,
      days: [{ label: "Day 1", date: "2026-10-12", stops: [{ name: "Stop", kind: "outside", timeWindow: sample, durationMinutes: null, notes: null, sourceUrl: null, location: null }] }],
      unscheduled: [],
    };
    const ics = exportTripIcs(trip);
    const expectedTimed = parseTimeWindow(sample) !== null;
    assert.equal(/DTSTART:\d{8}T\d{6}Z/.test(ics), expectedTimed, `timed DTSTART for "${String(sample)}"`);
    assert.equal(/DTSTART;VALUE=DATE:20261012/.test(ics), !expectedTimed, `all-day fallback for "${String(sample)}"`);
  }
});

test("download names are deterministic and filesystem-safe", () => {
  assert.equal(exportFileName("Kyoto in October!", "html"), "kyoto-in-october.html");
  assert.equal(exportFileName("   ", "ics"), "trip.ics");
  assert.equal(exportFileName("A".repeat(80), "txt"), `${"a".repeat(60)}.txt`);
});

test("export projections keep stop identity and draft flags from the private document", () => {
  const database = mem();
  const trip = createTrip(database, "local", { destination: "Kochi", durationDays: 1 }, "2026-09-01T09:00:00.000Z");
  const withStop = change(database, trip.id, trip.revision, "p1", [
    { type: "addStop", dayId: trip.days[0]!.id, content: outside("Tasting menu"), timeWindow: "18:00" },
  ]);
  const stop = withStop.days[0]!.stops[0]!;
  const projection = projectTripForExport(withStop);
  const projected = projection.days[0]!.stops[0]! as ExportStop;
  assert.equal(projected.uid, stop.id, "private stop id travels as the calendar identity");
  assert.equal(projected.kind, "outside");
  assert.equal(projected.timeWindow, "18:00");
});
