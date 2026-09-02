import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/open.ts";
import { LOCAL_LIBRARY_ID } from "../db/library-id.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { createPlace } from "../server/atlas/module.ts";
import {
  applyTripChanges,
  archiveTrip,
  createTrip,
  deleteTrip,
  dismissTripAdvisory,
  duplicateTrip,
  getTrip,
  recordTripReview,
  removeTripInference,
  renameTrip,
  restoreTrip,
  TripConflict,
  updateTripSetup,
  type TripDocument,
} from "../server/trips/module.ts";
import { getShareState, previewShareSnapshot, publishShareSnapshot, revokeShareSnapshot } from "../server/trips/share.ts";

const TS = "2026-09-01T09:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-changes-")), "t.db"));
}

function env(expectedRevision: number, clientMutationId: string) {
  return { expectedRevision, clientMutationId };
}

function publishBound(db: Db, tripId: string, expectedRevision: number, clientMutationId: string, at = TS) {
  const preview = previewShareSnapshot(db, "local", tripId)!;
  return publishShareSnapshot(db, "local", tripId, { ...env(expectedRevision, clientMutationId), digest: preview.digest }, at);
}

type Counts = { trips: number; stops: number; days: number; changesets: number; advisories: number; shares: number; receipts: number };

function snapshot(db: Db): Counts {
  const n = (sql: string) => (db.prepare(sql).get() as { n: number }).n;
  return {
    trips: n(`SELECT COUNT(*) AS n FROM trips`),
    stops: n(`SELECT COUNT(*) AS n FROM trip_stops`),
    days: n(`SELECT COUNT(*) AS n FROM trip_days`),
    changesets: n(`SELECT COUNT(*) AS n FROM trip_changesets`),
    advisories: n(`SELECT COUNT(*) AS n FROM trip_advisories`),
    shares: n(`SELECT COUNT(*) AS n FROM trip_share_snapshots`),
    receipts: n(`SELECT COUNT(*) AS n FROM trip_mutation_receipts`),
  };
}

/** The full database state of one trip plus row counts, so stale/replayed
 * rejects can prove "nothing anywhere was written". */
function state(db: Db, tripId: string): string {
  return JSON.stringify({ counts: snapshot(db), doc: getTrip(db, "local", tripId) });
}

function rejectsConflict(run: () => unknown) {
  assert.throws(run, (error: unknown) => error instanceof TripConflict);
}

function rejectsPayload(run: () => unknown) {
  assert.throws(run, (error: unknown) => error instanceof RejectedPayload);
}

test("v20: new databases carry the owner-scoped mutation receipt table at the current schema version", () => {
  const db = mem();
  assert.equal((db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
  assert.ok(db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'trip_mutation_receipts'`).get());
  assert.ok((db.prepare(`PRAGMA table_info(trip_mutation_receipts)`).all() as { name: string }[]).some((column) => column.name === "library_id"));
});

test("updateTripSetup: stale revision writes nothing, replay returns the original result, reuse with a different payload is rejected", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const updated = updateTripSetup(
    db,
    "local",
    trip.id,
    { ...env(1, "u1"), destination: "Kyoto, Japan", durationDays: 2, title: "Kyoto in October" },
    TS,
  )!;
  assert.equal(updated.revision, 2, "a successful setup edit bumps the revision exactly once");

  const before = state(db, trip.id);
  rejectsConflict(() => updateTripSetup(db, "local", trip.id, { ...env(1, "u2"), destination: "Osaka", durationDays: 2 }, TS));
  assert.equal(state(db, trip.id), before, "a stale revision leaves every trip-owned table untouched");

  const replay = updateTripSetup(
    db,
    "local",
    trip.id,
    { ...env(1, "u1"), destination: "Kyoto, Japan", durationDays: 2, title: "Kyoto in October" },
    TS,
  )!;
  assert.equal(replay.revision, 2, "replay does not bump the revision again");
  assert.equal(replay.title, "Kyoto in October", "replay returns the original result");
  assert.equal(snapshot(db).receipts, 1, "exactly one receipt exists");

  rejectsPayload(() => updateTripSetup(db, "local", trip.id, { ...env(1, "u1"), destination: "Osaka", durationDays: 2 }, TS));
  assert.equal(getTrip(db, "local", trip.id)!.destination, "Kyoto, Japan", "the repurposed id changed nothing");
});

test("rename: envelope, replay, and repurpose behave like the changeset engine", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const renamed = renameTrip(db, "local", trip.id, { ...env(1, "r1"), title: "Kyoto in October" }, TS)!;
  assert.equal(renamed.revision, 2, "a successful rename bumps the revision exactly once");

  const before = state(db, trip.id);
  rejectsConflict(() => renameTrip(db, "local", trip.id, { ...env(1, "r2"), title: "Stale" }, TS));
  assert.equal(state(db, trip.id), before);

  const replay = renameTrip(db, "local", trip.id, { ...env(1, "r1"), title: "Kyoto in October" }, TS)!;
  assert.equal(replay.revision, 2);
  assert.equal(replay.title, "Kyoto in October");
  assert.equal(snapshot(db).receipts, 1);

  rejectsPayload(() => renameTrip(db, "local", trip.id, { ...env(1, "r1"), title: "Different" }, TS));
  assert.equal(getTrip(db, "local", trip.id)!.title, "Kyoto in October");
});

test("duplicate: replay with the same mutation id never creates a second trip", () => {
  const db = mem();
  const source = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  renameTrip(db, "local", source.id, { ...env(1, "r0"), title: "Kyoto in October" }, TS);
  // Duplicate has no operation-specific payload and does not edit the source,
  // so a seen id can only ever mean the same copy — stale and replay are the
  // cases to pin.
  const copy = duplicateTrip(db, "local", source.id, env(2, "d1"), TS)!;
  assert.equal(copy.revision, 1, "the copy starts its own revision history");
  assert.equal(getTrip(db, "local", source.id)!.revision, 2, "duplicating does not edit the source document");

  const before = state(db, source.id);
  rejectsConflict(() => duplicateTrip(db, "local", source.id, env(1, "d2"), TS));
  assert.equal(state(db, source.id), before);

  const replay = duplicateTrip(db, "local", source.id, env(2, "d1"), TS)!;
  assert.equal(replay.id, copy.id, "the original result comes back, not a new copy");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trips`).get() as { n: number }).n, 2, "no extra duplicate trip");
});

test("archive: stale envelope conflicts even on an already-archived trip; replay returns the original result", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const archived = archiveTrip(db, "local", trip.id, env(1, "a1"), TS)!;
  assert.equal(archived.revision, 2, "a successful archive bumps the revision exactly once");
  assert.ok(archived.archivedAt);

  // A new mutation id against a stale revision must not clobber anything,
  // even though the archive itself would be a no-op.
  const before = state(db, trip.id);
  rejectsConflict(() => archiveTrip(db, "local", trip.id, env(1, "a3"), TS));
  assert.equal(state(db, trip.id), before);

  const noOp = archiveTrip(db, "local", trip.id, env(2, "a2"), TS)!;
  assert.equal(noOp.revision, 2, "archiving an archived trip is a no-bump no-op with a valid envelope");
  assert.equal(noOp.title, "Kyoto", "the no-op leaves unrelated fields alone");

  const replay = archiveTrip(db, "local", trip.id, env(1, "a1"), TS)!;
  assert.equal(replay.revision, 2);
  assert.ok(replay.archivedAt);
});

test("restore: revision-checked, idempotent, replayable", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  archiveTrip(db, "local", trip.id, env(1, "a1"), TS);
  const restored = restoreTrip(db, "local", trip.id, env(2, "s1"), TS)!;
  assert.equal(restored.revision, 3, "a successful restore bumps the revision exactly once");
  assert.equal(restored.archivedAt, null);

  const before = state(db, trip.id);
  rejectsConflict(() => restoreTrip(db, "local", trip.id, env(2, "s2"), TS));
  assert.equal(state(db, trip.id), before);

  const replay = restoreTrip(db, "local", trip.id, env(2, "s1"), TS)!;
  assert.equal(replay.revision, 3);
  assert.equal(replay.archivedAt, null);
});

test("dismiss advisory: replayable, repurpose-rejected, and a no-bump label change", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", startDate: "2026-10-12", endDate: "2026-10-13" }, TS);
  const reviewed = recordTripReview(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 1,
      clientMutationId: "rev-1",
      flags: [{ category: "strain", severity: "concern", opinion: "Tight day", rationale: "Two stops, no lunch", dayRefs: [trip.days[0]!.id], stopRefs: [] }],
    },
    "agent",
    TS,
  )!;
  const advisoryId = reviewed.trip.advisories[0]!.id;
  const otherAdvisory = recordTripReview(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 1,
      clientMutationId: "rev-2",
      flags: [{ category: "missing_information", severity: "info", opinion: "Lodging open", rationale: "No anchor", dayRefs: [], stopRefs: [] }],
    },
    "agent",
    TS,
  )!;
  const otherId = otherAdvisory.trip.advisories.find((row) => row.id !== advisoryId)!.id;

  const dismissed = dismissTripAdvisory(db, "local", trip.id, advisoryId, env(1, "dis-1"), TS)!;
  assert.equal(dismissed.advisories.length, 1);
  assert.equal(dismissed.revision, 1, "dismissal is a label change: no revision bump");

  const before = state(db, trip.id);
  rejectsConflict(() => dismissTripAdvisory(db, "local", trip.id, advisoryId, env(9, "dis-2"), TS));
  assert.equal(state(db, trip.id), before);

  const replay = dismissTripAdvisory(db, "local", trip.id, advisoryId, env(1, "dis-1"), TS)!;
  assert.equal(replay.advisories.length, 1, "replay returns the original result");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trip_mutation_receipts`).get() as { n: number }).n, 1);

  rejectsPayload(() => dismissTripAdvisory(db, "local", trip.id, otherId, env(1, "dis-1"), TS));
  assert.equal(getTrip(db, "local", trip.id)!.advisories.length, 1, "the repurposed id dismissed nothing");
});

test("remove inference: replayable, repurpose-rejected, and a no-bump label change", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES ('item-i', 'post', 'Markets', 'body', 'https://x.com/a/status/i', ?, '[]', ?, ?)`,
  ).run(TS, TS, TS);
  const built = applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 1,
      clientMutationId: "b1",
      operations: [{ type: "addStop", dayId: null, content: { kind: "item", itemId: "item-i" } }],
      inferredPreferences: [{ text: "likes markets", basis: "saved item" }],
    },
    "agent",
    TS,
  )!;
  const inferenceId = built.trip.inferences[0]!.id;
  assert.equal(built.trip.revision, 2);

  const removed = removeTripInference(db, "local", trip.id, inferenceId, env(2, "ri-1"), TS)!;
  assert.equal(removed.inferences.length, 0);
  assert.equal(removed.revision, 2, "label cleanup is not an itinerary changeset: no revision bump");

  const before = state(db, trip.id);
  rejectsConflict(() => removeTripInference(db, "local", trip.id, inferenceId, env(1, "ri-2"), TS));
  assert.equal(state(db, trip.id), before);

  const replay = removeTripInference(db, "local", trip.id, inferenceId, env(2, "ri-1"), TS)!;
  assert.equal(replay.inferences.length, 0, "replay returns the original result");

  rejectsPayload(() => removeTripInference(db, "local", trip.id, "another-inference", env(2, "ri-1"), TS));
});

test("share publish: revision-checked, replay returns the original snapshot without re-minting a token", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const published = publishBound(db, trip.id, 1, "pub-1", TS)!;
  assert.ok(typeof published.token === "string" && published.token.length >= 43);
  assert.equal(published.revision, 1, "publish records the revision it snapshotted");
  assert.equal(getTrip(db, "local", trip.id)!.revision, 1, "publishing does not edit the plan");

  const before = state(db, trip.id);
  rejectsConflict(() => publishShareSnapshot(db, "local", trip.id, env(9, "pub-2"), TS));
  assert.equal(state(db, trip.id), before, "a stale publish writes no share row and no receipt");

  const replay = publishBound(db, trip.id, 1, "pub-1", TS)!;
  assert.equal(replay.token, null, "the raw token never lives in the database, so a replay cannot re-show it");
  assert.deepEqual(replay.snapshot, published.snapshot, "the original snapshot comes back");
  assert.equal(replay.updatedAt, published.updatedAt);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM trip_share_snapshots`).get() as { n: number }).n, 1, "no second share row");

  const receipt = db.prepare(`SELECT result_json FROM trip_mutation_receipts`).get() as { result_json: string };
  assert.ok(!receipt.result_json.includes(published.token), "the receipt stores no raw token either");
});

test("share revoke: revision-checked and replay-stable", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  publishBound(db, trip.id, 1, "pub-1", TS);
  const revoked = revokeShareSnapshot(db, "local", trip.id, env(1, "rvk-1"), TS);
  assert.equal(revoked, true);
  assert.equal(getTrip(db, "local", trip.id)!.revision, 1, "revoking does not edit the plan");

  const before = state(db, trip.id);
  rejectsConflict(() => revokeShareSnapshot(db, "local", trip.id, env(9, "rvk-2"), TS));
  assert.equal(state(db, trip.id), before);

  const replay = revokeShareSnapshot(db, "local", trip.id, env(1, "rvk-1"), TS);
  assert.equal(replay, true, "replay returns the original result");
  const secondId = revokeShareSnapshot(db, "local", trip.id, env(1, "rvk-3"), TS);
  assert.equal(secondId, false, "a new mutation id on an already-revoked share is an honest no-op");
});

test("delete: envelope plus confirm, Items and Places survive, receipt outlives the trip", () => {
  const db = mem();
  db.prepare(
    `INSERT INTO items (id, content_type, title, body, url, first_observed_at, media, created_at, updated_at)
     VALUES ('item-d', 'post', 'Kiyomizu', 'body', 'https://x.com/a/status/d', ?, '[]', ?, ?)`,
  ).run(TS, TS, TS);
  const place = createPlace(db, "local", { name: "Gion", kind: "neighbourhood" });
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  applyTripChanges(
    db,
    "local",
    trip.id,
    {
      expectedRevision: 1,
      clientMutationId: "m1",
      operations: [
        { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "item", itemId: "item-d" } },
        { type: "addStop", dayId: trip.days[0]!.id, content: { kind: "place", placeId: place.id } },
      ],
    },
    "user",
    TS,
  );

  rejectsPayload(() => deleteTrip(db, "local", trip.id, env(2, "del-nc")));
  rejectsPayload(() => deleteTrip(db, "local", trip.id, { ...env(2, "del-bad"), confirm: "yes" }));

  const before = state(db, trip.id);
  rejectsConflict(() => deleteTrip(db, "local", trip.id, { ...env(1, "del-stale"), confirm: "DELETE" }));
  assert.equal(state(db, trip.id), before, "a stale delete writes nothing");

  assert.equal(deleteTrip(db, "local", trip.id, { ...env(2, "del-1"), confirm: "DELETE" }), true);
  assert.equal(getTrip(db, "local", trip.id), null);
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM items WHERE id = 'item-d'`).get() as { n: number }).n, 1, "Items survive trip deletion");
  assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM atlas_places WHERE id = ?`).get(place.id) as { n: number }).n, 1, "Places survive trip deletion");
  assert.equal(
    (db.prepare(`SELECT COUNT(*) AS n FROM trip_mutation_receipts WHERE client_mutation_id = 'del-1'`).get() as { n: number }).n,
    1,
    "the delete receipt outlives the trip",
  );

  assert.equal(deleteTrip(db, "local", trip.id, { ...env(2, "del-1"), confirm: "DELETE" }), true, "exact delete retry after gone");
});

test("trusted fields in the body never change ownership, and unknown trips are null", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const renamed = renameTrip(db, "local", trip.id, { ...env(1, "r1"), title: "Kyoto in October", libraryId: "hosted-b", actor: "agent" }, TS)!;
  assert.equal(renamed.libraryId, LOCAL_LIBRARY_ID, "libraryId in the body is ignored");
  assert.equal(renamed.title, "Kyoto in October");

  assert.equal(updateTripSetup(db, "hosted-b", trip.id, { ...env(1, "x"), destination: "Hijacked", durationDays: 2 }, TS), null);
  assert.equal(archiveTrip(db, "hosted-b", trip.id, env(1, "x"), TS), null);
  assert.equal(restoreTrip(db, "hosted-b", trip.id, env(1, "x"), TS), null);
  assert.equal(duplicateTrip(db, "hosted-b", trip.id, env(1, "x"), TS), null);
  assert.equal(dismissTripAdvisory(db, "hosted-b", trip.id, "a", env(1, "x")), null);
  assert.equal(removeTripInference(db, "hosted-b", trip.id, "i", env(1, "x")), null);
  assert.equal(publishShareSnapshot(db, "hosted-b", trip.id, env(1, "x")), null);
  assert.equal(revokeShareSnapshot(db, "hosted-b", trip.id, env(1, "x")), null);
  assert.equal(deleteTrip(db, "hosted-b", trip.id, { ...env(1, "x"), confirm: "DELETE" }), false);
});

// ---------- HTTP envelope handling ----------

process.env.LOCUS_NO_VITE = "1";
process.env.LOCUS_PORT = "8807";
const { listen } = await import("../server/http/server.ts");

async function start(database: ReturnType<typeof mem>) {
  const app = listen(database);
  const base = `http://127.0.0.1:${app.port}`;
  const sessionResponse = await eventually(() => fetch(`${base}/api/session`));
  const session = (await sessionResponse.json()) as { csrf: string };
  const cookie = sessionResponse.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);
  const headers = { cookie, "content-type": "application/json", "x-csrf-token": session.csrf };
  return {
    base,
    close: () => app.close(),
    post: (path: string, body: unknown) => fetch(`${base}${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
    get: (path: string) => fetch(`${base}${path}`, { headers }),
  };
}

async function eventually(request: () => Promise<Response>): Promise<Response> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      return await request();
    } catch {
      if (attempt === 19) throw new Error("server did not start");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error("unreachable");
}

test("trips HTTP: lifecycle routes parse the envelope, ignore actor/libraryId, map conflicts and rejections", async () => {
  const database = mem();
  const app = await start(database);
  try {
    const created = ((await (await app.post("/api/trips", { destination: "Kyoto", durationDays: 2, clientMutationId: "create-http-lifecycle" })).json()) as { trip: TripDocument }).trip;

    // Missing envelope is a 400, not a silent mutation.
    const noEnvelope = await app.post(`/api/trips/${created.id}/rename`, { title: "X" });
    assert.equal(noEnvelope.status, 400);

    // Body actor/libraryId are ignored: the session's Library owns the result.
    const renamed = await app.post(`/api/trips/${created.id}/rename`, {
      title: "Kyoto in October",
      expectedRevision: 1,
      clientMutationId: "rn-1",
      libraryId: "hosted-b",
      actor: "agent",
    });
    assert.equal(renamed.status, 200);
    const renamedTrip = ((await renamed.json()) as { trip: TripDocument }).trip;
    assert.equal(renamedTrip.libraryId, LOCAL_LIBRARY_ID);
    assert.equal(renamedTrip.revision, 2);

    // Identical retry replays; stale revision is a 409.
    const replay = await app.post(`/api/trips/${created.id}/rename`, { title: "Kyoto in October", expectedRevision: 1, clientMutationId: "rn-1" });
    assert.equal(replay.status, 200);
    assert.equal(((await replay.json()) as { trip: TripDocument }).trip.revision, 2, "replay does not bump again");
    const stale = await app.post(`/api/trips/${created.id}/rename`, { title: "Stale", expectedRevision: 1, clientMutationId: "rn-2" });
    assert.equal(stale.status, 409);
    const repurposed = await app.post(`/api/trips/${created.id}/rename`, { title: "Different", expectedRevision: 2, clientMutationId: "rn-1" });
    assert.equal(repurposed.status, 400);

    // Dismissal and inference removal take the envelope from the body too.
    assert.equal((await app.post(`/api/trips/${created.id}/review-intent`, {})).status, 200);
    const reviewed = await app.post(`/api/trips/${created.id}/agent/review`, {
      expectedRevision: 2,
      clientMutationId: "rev-1",
      flags: [{ category: "strain", severity: "info", opinion: "Fine", rationale: "Because", dayRefs: [], stopRefs: [] }],
    });
    const advisoryId = (((await reviewed.json()) as { trip: TripDocument }).trip.advisories[0]!).id;
    const dismissed = await app.post(`/api/trips/${created.id}/advisories/${advisoryId}/dismiss`, {
      expectedRevision: 2,
      clientMutationId: "dis-1",
      actor: "agent",
    });
    assert.equal(dismissed.status, 200);
    assert.equal(((await dismissed.json()) as { trip: TripDocument }).trip.advisories.length, 0);
    const missingEnvelopeDismiss = await app.post(`/api/trips/${created.id}/advisories/${advisoryId}/dismiss`, {});
    assert.equal(missingEnvelopeDismiss.status, 400);

    // Delete needs envelope AND confirm; stale delete conflicts.
    const staleDelete = await app.post(`/api/trips/${created.id}/delete`, { confirm: "DELETE", expectedRevision: 1, clientMutationId: "del-s" });
    assert.equal(staleDelete.status, 409);
    const noConfirm = await app.post(`/api/trips/${created.id}/delete`, { expectedRevision: 2, clientMutationId: "del-nc" });
    assert.equal(noConfirm.status, 400);
    const deleted = await app.post(`/api/trips/${created.id}/delete`, { confirm: "DELETE", expectedRevision: 2, clientMutationId: "del-1" });
    assert.equal(deleted.status, 200);
    assert.equal((await app.get(`/api/trips/${created.id}`)).status, 404);
    const deleteReplay = await app.post(`/api/trips/${created.id}/delete`, { confirm: "DELETE", expectedRevision: 2, clientMutationId: "del-1" });
    assert.equal(deleteReplay.status, 200, "exact delete retry after the trip is gone");
    assert.deepEqual((await deleteReplay.json()) as { deleted: boolean }, { deleted: true });
  } finally {
    await app.close();
    database.close();
  }
});
