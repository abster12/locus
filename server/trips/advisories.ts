import type { Db } from "../../db/open.ts";
import { nowIso } from "../../db/open.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { withTripMutation } from "./receipts.ts";
import { getTrip, parseInferences, type TripDocument } from "./repository.ts";

/** Human-only removal of one agent preference inference (ticket 10). A label
 * cleanup, not an itinerary change: like advisory dismissal it bumps no
 * revision and is idempotent through the mutation receipt. */
export function removeTripInference(db: Db, libraryId: string, tripId: string, inferenceId: string, input: unknown, at = nowIso()): TripDocument | null {
  return withTripMutation(db, libraryId, tripId, {
    kind: "remove-inference",
    input,
    payload: { inferenceId },
    at,
    apply: (_tripRow, at) => {
      const row = db.prepare(`SELECT inferences_json FROM trips WHERE id = ?`).get(tripId) as { inferences_json: string } | undefined;
      const current = row ? parseInferences(row.inferences_json) : [];
      if (!current.some((entry) => entry.id === inferenceId)) throw new RejectedPayload("inference not found in this Trip Document");
      db.prepare(`UPDATE trips SET inferences_json = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(current.filter((entry) => entry.id !== inferenceId)),
        at,
        tripId,
      );
      return { result: getTrip(db, libraryId, tripId)! };
    },
  });
}

/** Human-only dismissal: stamps dismissed_at and keeps the row so the flagged
 * opinion stays understandable in history. Idempotent — dismissing an already
 * dismissed advisory returns the document unchanged. */
export function dismissTripAdvisory(db: Db, libraryId: string, tripId: string, advisoryId: string, input: unknown, at = nowIso()): TripDocument | null {
  return withTripMutation(db, libraryId, tripId, {
    kind: "dismiss-advisory",
    input,
    payload: { advisoryId },
    at,
    apply: (_tripRow, at) => {
      const row = db.prepare(`SELECT id, dismissed_at FROM trip_advisories WHERE trip_id = ? AND id = ?`).get(tripId, advisoryId) as
        | { id: string; dismissed_at: string | null }
        | undefined;
      if (!row) throw new RejectedPayload("advisory not found in this Trip Document");
      if (!row.dismissed_at) {
        db.prepare(`UPDATE trip_advisories SET dismissed_at = ? WHERE id = ?`).run(at, advisoryId);
      }
      return { result: getTrip(db, libraryId, tripId)! };
    },
  });
}
