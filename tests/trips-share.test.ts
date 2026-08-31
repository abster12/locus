import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDb } from "../db/open.ts";
import { addTag } from "../core/commands.ts";
import { applyTripChanges, createTrip, deleteTrip, getTrip, listTrips, type TripSetupInput } from "../server/trips/module.ts";
import {
  findSharedSnapshot,
  getShareState,
  prepareShareSnapshot,
  previewShareSnapshot,
  publishShareSnapshot,
  renderShareHtml,
  revokeShareSnapshot,
  snapshotDigest,
  type SharePublishResult,
} from "../server/trips/share.ts";

const TS = "2026-09-01T09:00:00.000Z";
const TS2 = "2026-09-02T09:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-share-")), "t.db"));
}

/** Envelope + publish in one call; the revision arrives from the caller
 * because publish does not bump it. A fresh publish always mints a token. */
function bind(db: ReturnType<typeof mem>, tripId: string) {
  const preview = previewShareSnapshot(db, "local", tripId)!;
  return { expectedRevision: preview.revision, digest: preview.digest, snapshot: preview.snapshot };
}

function publish(db: ReturnType<typeof mem>, tripId: string, expectedRevision: number, clientMutationId: string, at = TS): SharePublishResult {
  const preview = previewShareSnapshot(db, "local", tripId)!;
  assert.equal(preview.revision, expectedRevision);
  const result = publishShareSnapshot(db, "local", tripId, { expectedRevision, clientMutationId, digest: preview.digest }, at)!;
  assert.ok(typeof result.token === "string", "a fresh publish mints a token");
  return result;
}

/** A trip whose stops cover every content kind and both note scopes, so the
 * allowlist test can assert exactly what survived. */
function seededTrip(db: ReturnType<typeof mem>) {
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES ('item-1', 'post', 'Kiyomizu at dawn', 'CAPTION SHOULD NEVER APPEAR', 'https://example.com/post/1', ?, '[]', ?, ?)`,
  ).run(TS, TS, TS);
  addTag(db, "item-1", "food");
  db.prepare(
    `INSERT INTO atlas_places (id, library_id, name, kind, parent_id, alt_names, lat, lng, created_at, updated_at)
     VALUES ('place-1', 'local', 'Gion', 'neighbourhood', NULL, '[]', 35.0037, 135.7788, ?, ?)`,
  ).run(TS, TS);
  const trip = createTrip(
    db,
    "local",
    {
      destination: "Kyoto, Japan",
      startDate: "2026-10-12",
      endDate: "2026-10-13",
      timezone: "Asia/Tokyo",
      travelers: "2 adults",
      context: { pace: "slow mornings", hardConstraints: ["no 07:00 trains"] },
    },
    TS,
  );
  const day1 = trip.days[0]!.id;
  applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: trip.revision,
      clientMutationId: "m1",
      operations: [
        {
          type: "addStop",
          dayId: day1,
          content: { kind: "item", itemId: "item-1" },
          timeWindow: "08:30",
          durationMinutes: 90,
          publicNotes: "Go early to beat the crowds",
          privateNotes: "SECRET PRIVATE NOTE",
        },
        { type: "addStop", dayId: day1, content: { kind: "place", placeId: "place-1" }, timeWindow: "11:00-12:00" },
        {
          type: "addStop",
          dayId: day1,
          content: { kind: "outside", title: "Ryokan idea", notes: null, url: "https://travel.example.com/ryokan" },
          publicNotes: null,
        },
        { type: "addStop", dayId: null, content: { kind: "hole", request: "quiet dinner near Gion" } },
      ],
    },
    "user",
    TS,
  );
  // One agent draft that must never reach the snapshot.
  applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 2,
      clientMutationId: "m2",
      operations: [{ type: "addStop", dayId: day1, content: { kind: "outside", title: "Agent draft stop", notes: null, url: null } }],
    },
    "agent",
    TS,
  );
  return { trip, day1 };
}

test("the share allowlist keeps only public fields and drops private ones by construction", () => {
  const db = mem();
  const { trip } = seededTrip(db);
  const snapshot = prepareShareSnapshot(db, getTrip(db, "local", trip.id)!);
  const text = JSON.stringify(snapshot);

  // Allowlisted content survives.
  assert.equal(snapshot.title, "Kyoto, Japan");
  assert.equal(snapshot.timezone, "Asia/Tokyo");
  assert.equal(snapshot.days[0]!.label, "Day 1");
  const day1 = snapshot.days[0]!.stops;
  assert.deepEqual(
    day1.map((stop) => [stop.kind, stop.name]),
    [
      ["item", "Kiyomizu at dawn"],
      ["place", "Gion"],
      ["outside", "Ryokan idea"],
    ],
  );
  assert.equal(day1[0]!.timeWindow, "08:30");
  assert.equal(day1[0]!.durationMinutes, 90);
  assert.equal(day1[0]!.notes, "Go early to beat the crowds");
  assert.equal(day1[0]!.sourceUrl, "https://example.com/post/1");
  assert.deepEqual(day1[1]!.coordinates, { lat: 35.0037, lng: 135.7788 }, "Place coordinates ride along when they exist");
  assert.equal(day1[0]!.coordinates, null);
  assert.deepEqual(snapshot.unscheduled, [{ kind: "hole", name: "quiet dinner near Gion", timeWindow: null, durationMinutes: null, notes: null, sourceUrl: null, location: null, coordinates: null }]);

  // Private material is absent from the snapshot object itself.
  assert.ok(!text.includes("SECRET PRIVATE NOTE"), "private notes are excluded by construction");
  assert.ok(!text.includes("CAPTION SHOULD NEVER APPEAR"), "Item captions are excluded");
  assert.ok(!text.includes("slow mornings"), "user trip context stays private");
  assert.ok(!text.includes("2 adults"), "travelers stay private");
  assert.ok(!text.includes("no 07:00 trains"), "hard constraints stay private");
  assert.ok(!text.includes("Agent draft stop"), "draft stops are excluded");
  assert.ok(!text.includes("advisories") && !text.includes("inferences"), "advisories and inferences are excluded");
  assert.ok(!text.includes("item-1") && !text.includes("place-1"), "internal identifiers are excluded");
  for (const stop of [...snapshot.days.flatMap((day) => day.stops), ...snapshot.unscheduled]) {
    assert.ok(!("id" in stop) && !("provenance" in stop) && !("state" in stop), "no internal stop fields on the snapshot");
  }
});

test("publish stores only a token hash, the raw token stays out of the database", () => {
  const db = mem();
  const { trip } = seededTrip(db);
  const result = publish(db, trip.id, 3, "p1");
  assert.ok(result.token.length >= 43, "token is long enough to be unguessable");
  const row = db.prepare(`SELECT token_hash FROM trip_share_snapshots WHERE trip_id = ?`).get(trip.id) as { token_hash: string };
  assert.notEqual(row.token_hash, result.token, "the raw token is never stored");
  assert.equal(row.token_hash, createHash("sha256").update(result.token, "utf8").digest("hex"));

  // The token appears nowhere on the private document or its summary.
  assert.ok(!JSON.stringify(listTrips(db, "local")).includes(result.token));
  assert.ok(!JSON.stringify(getTrip(db, "local", trip.id)).includes(result.token));

  // Lookup by the raw token works; a wrong token is the same as unknown.
  const found = findSharedSnapshot(db, result.token)!;
  assert.equal(found.snapshot.title, "Kyoto, Japan");
  assert.equal(findSharedSnapshot(db, `${result.token}x`), null);
  assert.equal(findSharedSnapshot(db, ""), null);
});

test("public payload is immutable until an explicit human publish", () => {
  const db = mem();
  const { trip } = seededTrip(db);
  const before = publish(db, trip.id, 3, "p2");

  applyTripChanges(
    db,
    "local",
    trip.id,
    { expectedRevision: 3, clientMutationId: "m3", operations: [{ type: "addStop", dayId: trip.days[1]!.id, content: { kind: "outside", title: "Later private stop", notes: null, url: null } }] },
    "user",
    TS2,
  );
  const still = findSharedSnapshot(db, before.token)!;
  assert.equal(still.snapshot.days[1]!.stops.length, 0, "private edits do not change the shared snapshot");
  assert.notEqual(still.revision, getTrip(db, "local", trip.id)!.revision, "the shared revision lags the document");

  const updated = publish(db, trip.id, 4, "p3", TS2);
  assert.notEqual(updated.token, before.token, "republish mints a new token");
  assert.equal(findSharedSnapshot(db, before.token), null, "the old capability is dead after republish");
  assert.equal(findSharedSnapshot(db, updated.token)!.snapshot.days[1]!.stops.length, 1);
});

test("revocation removes the public payload; republish uses a new token", () => {
  const db = mem();
  const { trip } = seededTrip(db);
  const first = publish(db, trip.id, 3, "p4");
  assert.equal(getShareState(db, "local", trip.id)!.revision, first.revision);

  assert.equal(revokeShareSnapshot(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "r1" }, TS2), true);
  assert.equal(findSharedSnapshot(db, first.token), null, "revoked tokens carry no itinerary payload");
  assert.equal(getShareState(db, "local", trip.id), null);
  assert.equal(revokeShareSnapshot(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "r2" }, TS2), false, "double revoke is a no-op");

  const second = publish(db, trip.id, 3, "p5", TS2);
  assert.notEqual(second.token, first.token);
  assert.equal(findSharedSnapshot(db, second.token)!.snapshot.title, "Kyoto, Japan");
});

test("shares are Library-scoped and deleted with their trip", () => {
  const db = mem();
  const { trip } = seededTrip(db);
  publish(db, trip.id, 3, "p6");

  assert.equal(publishShareSnapshot(db, "hosted-b", trip.id, { expectedRevision: 3, clientMutationId: "p-x" }), null, "another Library cannot publish");
  assert.equal(getShareState(db, "hosted-b", trip.id), null);
  assert.equal(revokeShareSnapshot(db, "hosted-b", trip.id, { expectedRevision: 3, clientMutationId: "r-x" }), null);

  deleteTrip(db, "local", trip.id, { expectedRevision: 3, clientMutationId: "d-1", confirm: "DELETE" });
  const remaining = db.prepare(`SELECT COUNT(*) AS n FROM trip_share_snapshots`).get() as unknown as { n: number };
  assert.equal(remaining.n, 0, "snapshot rows die with the trip");
});

test("the public page is static read-only HTML with Last Updated, timezone, and no scripts", () => {
  const db = mem();
  const { trip } = seededTrip(db);
  const result = publish(db, trip.id, 3, "p7");
  const html = renderShareHtml(findSharedSnapshot(db, result.token)!.snapshot, result.updatedAt);

  assert.match(html, /<h1>Kyoto, Japan<\/h1>/);
  assert.match(html, /Kiyomizu at dawn/);
  assert.match(html, /Gion/);
  assert.match(html, /Ryokan idea/);
  assert.match(html, /Unresolved/);
  assert.match(html, /quiet dinner near Gion/);
  assert.match(html, /Last updated/);
  assert.match(html, /Asia\/Tokyo/);
  assert.ok(!html.includes("<script"), "the public page ships no scripts");
  assert.ok(!html.includes("SECRET PRIVATE NOTE"));
  assert.ok(!html.includes("CAPTION SHOULD NEVER APPEAR"));
  // Hostile stop names cannot break out of the text context.
  const hostile = createTrip(db, "local", { destination: "<script>alert(1)</script>", durationDays: 1 }, TS);
  const hostileHtml = renderShareHtml(publish(db, hostile.id, 1, "p8").snapshot, TS);
  assert.ok(!hostileHtml.includes("<script>alert(1)"));
  assert.match(hostileHtml, /&lt;script&gt;/);
});

test("publish requires the preview binding; an edit between preview and publish stores nothing", () => {
  const db = mem();
  const { trip, day1 } = seededTrip(db);
  const first = bind(db, trip.id);
  assert.equal(first.digest, snapshotDigest(first.snapshot));

  applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 3,
      clientMutationId: "edit-after-preview",
      operations: [{ type: "addStop", dayId: day1, content: { kind: "outside", title: "Never shared", notes: null, url: null } }],
    },
    "user",
    TS2,
  );
  assert.throws(
    () => publishShareSnapshot(db, "local", trip.id, { expectedRevision: 4, clientMutationId: "p-stale", digest: first.digest }, TS2),
    (error: unknown) => error instanceof Error && /stale/.test(error.message),
  );
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trip_share_snapshots`).get() as { n: number }).n, 0, "a stale preview publishes nothing");

  const fresh = bind(db, trip.id);
  const published = publishShareSnapshot(db, "local", trip.id, { expectedRevision: 4, clientMutationId: "p-ok", digest: fresh.digest }, TS2)!;
  assert.equal(typeof published.token, "string");
  assert.deepEqual(published.snapshot, fresh.snapshot, "the stored snapshot matches the approved preview");
  assert.equal(snapshotDigest(published.snapshot), fresh.digest);

  const other = createTrip(db, "local", { destination: "Goa", durationDays: 1 }, TS);
  assert.throws(
    () => publishShareSnapshot(db, "local", other.id, { expectedRevision: 1, clientMutationId: "cross", digest: fresh.digest }, TS),
    (error: unknown) => error instanceof Error && /stale/.test(error.message),
    "a preview digest cannot publish a different Trip Document",
  );
});
