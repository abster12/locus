import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db/open.ts";
import { SCHEMA_VERSION } from "../db/schema.ts";
import { RejectedPayload } from "../core/sanitize.ts";
import { applyTripChanges, createTrip, TripConflict } from "../server/trips/module.ts";
import { armReviewIntent, recordAgentReview, ReviewIntentError } from "../server/trips/review.ts";

const TS = "2026-09-01T09:00:00.000Z";

function mem() {
  return openDb(join(mkdtempSync(join(tmpdir(), "locus-trips-review-")), "t.db"));
}

function flag(dayId?: string) {
  return {
    category: "strain",
    severity: "concern",
    opinion: "Tuesday feels tight",
    rationale: "Two timed stops back to back",
    dayRefs: dayId ? [dayId] : [],
    stopRefs: [],
  };
}

function reviewInput(revision: number, clientMutationId: string, dayId?: string) {
  return { expectedRevision: revision, clientMutationId, flags: [flag(dayId)] };
}

function intentCount(db: Db, sessionId: string) {
  return (db.prepare(`SELECT COUNT(*) AS n FROM trip_review_intents WHERE session_id = ?`).get(sessionId) as { n: number }).n;
}

function advisoryCount(db: Db) {
  return (db.prepare(`SELECT COUNT(*) AS n FROM trip_advisories`).get() as { n: number }).n;
}

test("v21: review intents are session- and trip-bound with one live row per pair", () => {
  const db = mem();
  assert.equal((db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  armReviewIntent(db, "local", "s1", trip.id, TS);
  armReviewIntent(db, "local", "s1", trip.id, TS);
  assert.equal(intentCount(db, "s1"), 1, "re-arming replaces, never duplicates");
  assert.equal(intentCount(db, "s2"), 0, "other sessions have no intent");
});

test("first successful use consumes the intent atomically with the advisory write", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const armed = armReviewIntent(db, "local", "s1", trip.id, TS)!;
  assert.equal(armed.revision, trip.revision);

  const result = recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r1", trip.days[0]!.id), TS)!;
  assert.equal(result.replayed, false);
  assert.equal(result.trip.advisories.length, 1);
  assert.equal(advisoryCount(db), 1);
  assert.equal(intentCount(db, "s1"), 0, "the successful review consumed the intent");
});

test("attempted reuse after success is rejected", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  armReviewIntent(db, "local", "s1", trip.id, TS);
  recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r1"), TS);
  assert.throws(
    () => recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r2"), TS),
    (error: unknown) => error instanceof ReviewIntentError,
  );
  assert.equal(advisoryCount(db), 1, "the reuse wrote nothing");
});

test("expired intents are rejected", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  armReviewIntent(db, "local", "s1", trip.id, TS);
  db.prepare(`UPDATE trip_review_intents SET expires_at = 0`).run();
  assert.throws(
    () => recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r1"), TS),
    (error: unknown) => error instanceof ReviewIntentError && (error as Error).message.includes("expired"),
  );
  assert.equal(advisoryCount(db), 0);
});

test("cross-session use is rejected and leaves the owner's intent intact", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  armReviewIntent(db, "local", "s1", trip.id, TS);
  assert.throws(
    () => recordAgentReview(db, "local", "s2", trip.id, reviewInput(trip.revision, "r-other"), TS),
    (error: unknown) => error instanceof ReviewIntentError,
  );
  assert.equal(intentCount(db, "s1"), 1, "another session cannot consume the intent");
  const result = recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r1"), TS)!;
  assert.equal(result.trip.advisories.length, 1, "the owning session still succeeds");
});

test("wrong-trip use is rejected", () => {
  const db = mem();
  const armed = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  const other = createTrip(db, "local", { destination: "Osaka", durationDays: 2 }, TS);
  armReviewIntent(db, "local", "s1", armed.id, TS);
  assert.throws(
    () => recordAgentReview(db, "local", "s1", other.id, reviewInput(other.revision, "r1"), TS),
    (error: unknown) => error instanceof ReviewIntentError,
  );
  assert.equal(intentCount(db, "s1"), 1, "the armed intent still belongs to its own trip");
});

test("missing intent is rejected", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  assert.throws(
    () => recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r1"), TS),
    (error: unknown) => error instanceof ReviewIntentError,
  );
  assert.equal(advisoryCount(db), 0);
});

test("failed validation leaves the intent usable", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  armReviewIntent(db, "local", "s1", trip.id, TS);
  const smuggled = {
    expectedRevision: trip.revision,
    clientMutationId: "r-bad",
    flags: [{ ...flag(), coordinates: { lat: 35, lng: 135 } }],
  };
  assert.throws(
    () => recordAgentReview(db, "local", "s1", trip.id, smuggled, TS),
    (error: unknown) => error instanceof RejectedPayload,
  );
  assert.equal(intentCount(db, "s1"), 1, "a rejected payload does not consume the intent");
  const result = recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r-good", trip.days[0]!.id), TS)!;
  assert.equal(result.trip.advisories.length, 1, "the same intent still authorizes a valid review");
});

test("stale revision conflicts and preserves the intent", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  armReviewIntent(db, "local", "s1", trip.id, TS);
  applyTripChanges(db, "local", trip.id, {
    expectedRevision: trip.revision,
    clientMutationId: "m1",
    operations: [{ type: "addStop", dayId: trip.days[0]!.id, content: { kind: "outside", title: "Nishiki" } }],
  }, "user", TS);
  assert.throws(
    () => recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r-stale"), TS),
    (error: unknown) => error instanceof TripConflict,
  );
  assert.equal(intentCount(db, "s1"), 1, "a stale review does not consume the intent");
  const rearmed = armReviewIntent(db, "local", "s1", trip.id, TS)!;
  assert.equal(rearmed.revision, trip.revision + 1);
  const result = recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision + 1, "r-fresh", trip.days[0]!.id), TS)!;
  assert.equal(result.trip.advisories.length, 1);
});

test("failed persistence rolls back and preserves the intent", () => {
  const db = mem();
  const trip = createTrip(db, "local", { destination: "Kyoto", durationDays: 2 }, TS);
  armReviewIntent(db, "local", "s1", trip.id, TS);
  db.exec(`CREATE TRIGGER fail_advisories BEFORE INSERT ON trip_advisories BEGIN SELECT RAISE(FAIL, 'nope'); END`);
  assert.throws(() => recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r1"), TS));
  assert.equal(intentCount(db, "s1"), 1, "the failed write rolled back the consumption");
  db.exec(`DROP TRIGGER fail_advisories`);
  const result = recordAgentReview(db, "local", "s1", trip.id, reviewInput(trip.revision, "r2", trip.days[0]!.id), TS)!;
  assert.equal(result.trip.advisories.length, 1, "the same intent still authorizes the review");
});
