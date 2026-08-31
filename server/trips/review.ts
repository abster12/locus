import { createHash } from "node:crypto";
import type { Db } from "../../db/open.ts";
import { newId, nowIso, tx } from "../../db/open.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { requireActor } from "./changes.ts";
import { validateTripReview, type TripReviewInput } from "./policy.ts";
import { TripConflict } from "./receipts.ts";
import { getTrip, requireDayRow, requireStopRow, tripRowOrNull, type AdvisoryRow, type TripDocument } from "./repository.ts";

/** A missing, expired, cross-session, or wrong-Trip intent is always this
 * error: the HTTP layer maps it to a stable 403, never to a 404 that would
 * reveal which Trip ids exist. */
export class ReviewIntentError extends Error {
  readonly code = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "ReviewIntentError";
  }
}

const INTENT_TTL_MS = 15 * 60_000;

type IntentRow = { revision: number; expires_at: number };

function liveIntent(db: Db, libraryId: string, sessionId: string, tripId: string): IntentRow | undefined {
  return db
    .prepare(`SELECT revision, expires_at FROM trip_review_intents WHERE library_id = ? AND session_id = ? AND trip_id = ?`)
    .get(libraryId, sessionId, tripId) as IntentRow | undefined;
}

/** Arm the human "Ask agent to review" grant for one Trip Document: bound to
 * the Library, the trusted session, the exact Trip, and the revision at arm
 * time, with an explicit short expiry. Re-arming replaces the previous intent
 * for that session and Trip. Returns the armed revision, or null when the
 * Trip does not exist in this Library. */
export function armReviewIntent(db: Db, libraryId: string, sessionId: string, tripId: string, at = nowIso()): { revision: number } | null {
  const tripRow = db.prepare(`SELECT revision FROM trips WHERE library_id = ? AND id = ?`).get(libraryId, tripId) as
    | { revision: number }
    | undefined;
  if (!tripRow) return null;
  tx(db, () => {
    db.prepare(`DELETE FROM trip_review_intents WHERE library_id = ? AND session_id = ? AND trip_id = ?`).run(libraryId, sessionId, tripId);
    db.prepare(
      `INSERT INTO trip_review_intents (library_id, session_id, trip_id, revision, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(libraryId, sessionId, tripId, tripRow.revision, Date.now() + INTENT_TTL_MS, at);
  });
  return { revision: tripRow.revision };
}

/** Agent review gated by a live intent. Intent check, payload validation, the
 * advisory write, and intent consumption share one transaction: any failure
 * before the successful write rolls back and leaves the intent intact, and
 * the first success consumes it, so a captured intent cannot be replayed. */
export function recordAgentReview(
  db: Db,
  libraryId: string,
  sessionId: string,
  tripId: string,
  input: unknown,
  at = nowIso(),
): { trip: TripDocument; replayed: boolean } | null {
  return tx(db, () => {
    if (!db.prepare(`SELECT 1 AS ok FROM trips WHERE library_id = ? AND id = ?`).get(libraryId, tripId)) return null;
    const intent = liveIntent(db, libraryId, sessionId, tripId);
    if (!intent) throw new ReviewIntentError("review intent required for this session and Trip");
    if (intent.expires_at < Date.now()) throw new ReviewIntentError("review intent expired");
    const review = validateTripReview(input);
    if (intent.revision !== review.expectedRevision) {
      throw new TripConflict(`expected revision ${review.expectedRevision} but the review intent is for revision ${intent.revision}`);
    }
    const result = applyTripReview(db, libraryId, tripId, review, "agent", at);
    if (!result) return null;
    db.prepare(`DELETE FROM trip_review_intents WHERE library_id = ? AND session_id = ? AND trip_id = ?`).run(libraryId, sessionId, tripId);
    return result;
  });
}

/** Save one agent review as a set of advisory rows inside a single
 * transaction. Stale revisions throw TripConflict; invalid flags or unknown
 * day/stop references reject the whole review atomically. Retries carrying
 * the same clientMutationId and payload return the saved state unchanged. */
export function recordTripReview(
  db: Db,
  libraryId: string,
  tripId: string,
  input: unknown,
  actor: string,
  at = nowIso(),
): { trip: TripDocument; replayed: boolean } | null {
  const trustedActor = requireActor(actor);
  const review = validateTripReview(input);
  return tx(db, () => applyTripReview(db, libraryId, tripId, review, trustedActor, at));
}

/** Advisory write core shared with the intent-gated agent path in review.ts.
 * Runs inside the caller's transaction; callers validate the review first. */
export function applyTripReview(
  db: Db,
  libraryId: string,
  tripId: string,
  review: TripReviewInput,
  actor: string,
  at: string,
): { trip: TripDocument; replayed: boolean } | null {
  const hash = createHash("sha256").update(JSON.stringify({ kind: "review", expectedRevision: review.expectedRevision, flags: review.flags })).digest("hex");
  const tripRow = tripRowOrNull(db, libraryId, tripId);
  if (!tripRow) return null;
  const existing = db
    .prepare(`SELECT * FROM trip_advisories WHERE trip_id = ? AND client_mutation_id = ? LIMIT 1`)
    .get(tripId, review.clientMutationId) as AdvisoryRow | undefined;
  if (existing) {
    if (existing.payload_hash !== hash) {
      throw new RejectedPayload("clientMutationId was already used for a different review");
    }
    return { trip: getTrip(db, libraryId, tripId)!, replayed: true };
  }
  if (tripRow.revision !== review.expectedRevision) {
    throw new TripConflict(`expected revision ${review.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
  }
  // References must belong to this exact document — a flag pointing at
  // another trip's day or stop rejects the entire review.
  for (const flag of review.flags) {
    for (const dayId of flag.dayRefs) requireDayRow(db, tripId, dayId);
    for (const stopId of flag.stopRefs) requireStopRow(db, tripId, stopId);
  }
  const insert = db.prepare(
    `INSERT INTO trip_advisories (id, trip_id, reviewed_revision, category, severity, opinion, rationale, day_refs_json, stop_refs_json, actor, client_mutation_id, payload_hash, created_at, dismissed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
  );
  for (const flag of review.flags) {
    insert.run(
      newId(),
      tripId,
      review.expectedRevision,
      flag.category,
      flag.severity,
      flag.opinion,
      flag.rationale,
      JSON.stringify(flag.dayRefs),
      JSON.stringify(flag.stopRefs),
      actor,
      review.clientMutationId,
      hash,
      at,
    );
  }
  return { trip: getTrip(db, libraryId, tripId)!, replayed: false };
}
