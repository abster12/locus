import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db/open.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { createPlace } from "../server/atlas/module.ts";
import { projectTripForExport, exportTripText } from "../server/trips/export.ts";
import {
  applyTripChanges,
  createTrip,
  duplicateTrip,
  getTrip,
  searchTripSources,
} from "../server/trips/module.ts";
import { prepareShareSnapshot } from "../server/trips/share.ts";

const TS = "2026-09-01T09:00:00.000Z";
const SECRET_TITLE = "SECRET FOREIGN TITLE NEVER LEAK";
const SECRET_BODY = "SECRET FOREIGN BODY NEVER LEAK";
const SECRET_URL = "https://example.com/secret-item";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-own-")), "t.db"));
}

function seedItem(db: ReturnType<typeof mem>, id = "item-secret") {
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES (?, 'post', ?, ?, ?, ?, '[]', ?, ?)`,
  ).run(id, SECRET_TITLE, SECRET_BODY, SECRET_URL, TS, TS, TS);
}

function changesetCount(db: ReturnType<typeof mem>, tripId: string) {
  return (db.prepare(`SELECT COUNT(*) AS n FROM trip_changesets WHERE trip_id = ?`).get(tripId) as { n: number }).n;
}

function smuggleItemStop(db: ReturnType<typeof mem>, tripId: string, dayId: string, itemId: string) {
  db.prepare(
    `INSERT INTO trip_stops (id, trip_id, day_id, position, content_json, state, provenance_json, public_notes, private_notes, created_at, updated_at)
     VALUES (?, ?, ?, 0, ?, 'confirmed', '{}', '', '', ?, ?)`,
  ).run("smuggled-stop", tripId, dayId, JSON.stringify({ kind: "item", itemId }), TS, TS);
}

test("search never returns another Library's Item; Places stay Library-scoped", () => {
  const db = mem();
  seedItem(db);
  createPlace(db, "local", { name: "Nishiki Market", kind: "landmark" });
  createPlace(db, "hosted-b", { name: "Goa beach" });

  const localItems = searchTripSources(db, "local", "SECRET");
  assert.equal(localItems.items.length, 1);
  assert.equal(localItems.items[0]!.title, SECRET_TITLE);
  assert.deepEqual(localItems.places, []);
  const localPlaces = searchTripSources(db, "local", "Nishiki");
  assert.equal(localPlaces.places.length, 1);
  assert.equal(localPlaces.places[0]!.name, "Nishiki Market");

  const foreign = searchTripSources(db, "hosted-b", "SECRET");
  assert.deepEqual(foreign.items, [], "another Library cannot search Items");
  assert.ok(!JSON.stringify(foreign).includes(SECRET_TITLE));
  assert.ok(!JSON.stringify(foreign).includes(SECRET_BODY));

  const foreignEmpty = searchTripSources(db, "hosted-b", "");
  assert.deepEqual(foreignEmpty.items, [], "unfiltered search still cannot list another Library's Items");
  assert.equal(foreignEmpty.places.length, 1);
  assert.equal(foreignEmpty.places[0]!.name, "Goa beach");
});

test("addStop and updateStop reject foreign Item ids without changing revision or history", () => {
  const db = mem();
  seedItem(db);
  const localTrip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const foreignTrip = createTrip(db, "hosted-b", { destination: "Goa", durationDays: 2 }, TS);
  const foreignDay = foreignTrip.days[0]!.id;

  const beforeRevision = foreignTrip.revision;
  const beforeHistory = changesetCount(db, foreignTrip.id);
  assert.throws(
    () =>
      applyTripChanges(
        db,
        "hosted-b",
        foreignTrip.id,
        {
          expectedRevision: beforeRevision,
          clientMutationId: "add-foreign",
          operations: [{ type: "addStop", dayId: foreignDay, content: { kind: "item", itemId: "item-secret" } }],
        },
        "user",
        TS,
      ),
    (error: unknown) => error instanceof RejectedPayload && /not in this Library/.test(error.message),
  );
  assert.equal(getTrip(db, "hosted-b", foreignTrip.id)!.revision, beforeRevision);
  assert.equal(changesetCount(db, foreignTrip.id), beforeHistory);
  assert.equal(getTrip(db, "hosted-b", foreignTrip.id)!.days[0]!.stops.length, 0);

  const seeded = applyTripChanges(
    db,
    "hosted-b",
    foreignTrip.id,
    {
      expectedRevision: beforeRevision,
      clientMutationId: "add-outside",
      operations: [{ type: "addStop", dayId: foreignDay, content: { kind: "outside", title: "Placeholder", notes: null, url: null } }],
    },
    "user",
    TS,
  )!;
  const stopId = seeded.trip.days[0]!.stops[0]!.id;
  const afterAddRevision = seeded.trip.revision;
  const afterAddHistory = changesetCount(db, foreignTrip.id);

  assert.throws(
    () =>
      applyTripChanges(
        db,
        "hosted-b",
        foreignTrip.id,
        {
          expectedRevision: afterAddRevision,
          clientMutationId: "update-foreign",
          operations: [{ type: "updateStop", stopId, content: { kind: "item", itemId: "item-secret" } }],
        },
        "user",
        TS,
      ),
    (error: unknown) => error instanceof RejectedPayload && /not in this Library/.test(error.message),
  );
  const afterUpdate = getTrip(db, "hosted-b", foreignTrip.id)!;
  assert.equal(afterUpdate.revision, afterAddRevision);
  assert.equal(changesetCount(db, foreignTrip.id), afterAddHistory);
  assert.deepEqual(afterUpdate.days[0]!.stops[0]!.content, { kind: "outside", title: "Placeholder", notes: null, url: null });

  assert.throws(
    () =>
      applyTripChanges(
        db,
        "local",
        localTrip.id,
        {
          expectedRevision: localTrip.revision,
          clientMutationId: "unknown-item",
          operations: [{ type: "addStop", dayId: localTrip.days[0]!.id, content: { kind: "item", itemId: "no-such-item" } }],
        },
        "user",
        TS,
      ),
    (error: unknown) => error instanceof RejectedPayload && /not in this Library/.test(error.message),
    "unknown Item ids use the same rejection as foreign ids",
  );
  assert.equal(getTrip(db, "local", localTrip.id)!.revision, localTrip.revision);
});

test("hydration, share, export, and duplicate never resolve a foreign Item", () => {
  const db = mem();
  seedItem(db);
  const trip = createTrip(db, "hosted-b", { destination: "Goa", durationDays: 2 }, TS);
  smuggleItemStop(db, trip.id, trip.days[0]!.id, "item-secret");

  const hydrated = getTrip(db, "hosted-b", trip.id)!;
  const stop = hydrated.days[0]!.stops[0]!;
  assert.equal(stop.broken, true);
  assert.equal(stop.resolved ?? null, null);
  assert.deepEqual(stop.content, { kind: "item", itemId: "item-secret" });
  const hydratedText = JSON.stringify(hydrated);
  assert.ok(!hydratedText.includes(SECRET_TITLE));
  assert.ok(!hydratedText.includes(SECRET_BODY));
  assert.ok(!hydratedText.includes(SECRET_URL));

  const snapshot = prepareShareSnapshot(db, hydrated);
  const snapshotText = JSON.stringify(snapshot);
  assert.equal(snapshot.days[0]!.stops.length, 0, "broken foreign refs are omitted from the Share Snapshot");
  assert.ok(!snapshotText.includes(SECRET_TITLE));
  assert.ok(!snapshotText.includes(SECRET_BODY));
  assert.ok(!snapshotText.includes(SECRET_URL));

  const exported = projectTripForExport(hydrated);
  assert.equal(exported.days[0]!.stops[0]!.name, "Missing saved item");
  assert.ok(!exportTripText(exported).includes(SECRET_TITLE));
  assert.ok(!JSON.stringify(exported).includes(SECRET_BODY));

  const copy = duplicateTrip(db, "hosted-b", trip.id, { expectedRevision: 1, clientMutationId: "dup-own" }, TS)!;
  const copied = copy.days[0]!.stops[0]!;
  assert.equal(copied.broken, true);
  assert.equal(copied.resolved ?? null, null);
  const copyText = JSON.stringify(copy);
  assert.ok(!copyText.includes(SECRET_TITLE));
  assert.ok(!copyText.includes(SECRET_BODY));
});

test("Place ownership stays Library-scoped", () => {
  const db = mem();
  const local = createPlace(db, "local", { name: "Fushimi Inari", kind: "landmark" });
  const foreign = createPlace(db, "hosted-b", { name: "Goa beach" });
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 1 }, TS);
  const dayId = trip.days[0]!.id;

  const added = applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 1,
      clientMutationId: "place-ok",
      operations: [{ type: "addStop", dayId, content: { kind: "place", placeId: local.id } }],
    },
    "user",
    TS,
  )!;
  assert.equal(added.trip.days[0]!.stops[0]!.broken, false);
  assert.equal(added.trip.days[0]!.stops[0]!.resolved?.kind, "place");

  assert.throws(
    () =>
      applyTripChanges(
        db,
        "local",
        trip.id,
        {
          expectedRevision: 2,
          clientMutationId: "place-foreign",
          operations: [{ type: "addStop", dayId, content: { kind: "place", placeId: foreign.id } }],
        },
        "user",
        TS,
      ),
    (error: unknown) => error instanceof RejectedPayload && /not in this Library/.test(error.message),
  );
  assert.equal(getTrip(db, "local", trip.id)!.revision, 2);
  assert.equal(searchTripSources(db, "local", "Goa").places.length, 0);
  assert.equal(searchTripSources(db, "hosted-b", "Goa").places.length, 1);
});
