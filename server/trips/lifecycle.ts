import type { Db } from "../../db/open.ts";
import { newId, nowIso, tx } from "../../db/open.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { requireClientMutationId, validateTripSetup, validateTripTitle } from "./policy.ts";
import { withCreateMutation, withTripMutation } from "./receipts.ts";
import { getTrip, insertDays, insertStopSnapshot, reconcileDays, type TripDocument, type TripStop } from "./repository.ts";

function clientMutationIdOf(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>).clientMutationId;
  if (value === undefined || value === null || value === "") return null;
  return requireClientMutationId(input);
}

export function createTrip(db: Db, libraryId: string, input: unknown, at = nowIso()): TripDocument {
  const setup = validateTripSetup(input);
  const insert = (when: string): TripDocument => {
    const id = newId();
    db.prepare(
      `INSERT INTO trips (id, library_id, title, destination, timezone, start_date, end_date, duration_days, travelers, context_json, revision, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
    ).run(
      id,
      libraryId,
      setup.title,
      setup.destination,
      setup.timezone,
      setup.startDate,
      setup.endDate,
      setup.durationDays,
      setup.travelers,
      JSON.stringify(setup.context),
      when,
      when,
    );
    insertDays(db, id, setup, when);
    return getTrip(db, libraryId, id)!;
  };
  const mutationId = clientMutationIdOf(input);
  if (!mutationId) return tx(db, () => insert(at));
  return withCreateMutation(db, libraryId, mutationId, {
    kind: "create",
    payload: setup,
    at,
    apply: (when) => {
      const trip = insert(when);
      return { result: trip, tripId: trip.id, resultRevision: trip.revision };
    },
  });
}

export function updateTripSetup(db: Db, libraryId: string, tripId: string, input: unknown, at = nowIso()): TripDocument | null {
  const setup = validateTripSetup(input);
  return withTripMutation(db, libraryId, tripId, {
    kind: "setup",
    input,
    payload: setup,
    at,
    apply: (_tripRow, at, bump) => {
      db.prepare(
        `UPDATE trips SET title = ?, destination = ?, timezone = ?, start_date = ?, end_date = ?, duration_days = ?, travelers = ?, context_json = ?
         WHERE library_id = ? AND id = ?`,
      ).run(
        setup.title,
        setup.destination,
        setup.timezone,
        setup.startDate,
        setup.endDate,
        setup.durationDays,
        setup.travelers,
        JSON.stringify(setup.context),
        libraryId,
        tripId,
      );
      reconcileDays(db, tripId, setup, at);
      bump();
      return { result: getTrip(db, libraryId, tripId)! };
    },
  });
}

export function renameTrip(db: Db, libraryId: string, tripId: string, input: unknown, at = nowIso()): TripDocument | null {
  const nextTitle = validateTripTitle((input as { title?: unknown } | null)?.title);
  return withTripMutation(db, libraryId, tripId, {
    kind: "rename",
    input,
    payload: { title: nextTitle },
    at,
    apply: (_tripRow, _at, bump) => {
      db.prepare(`UPDATE trips SET title = ? WHERE id = ?`).run(nextTitle, tripId);
      bump();
      return { result: getTrip(db, libraryId, tripId)! };
    },
  });
}

/** Duplicate copies the private setup, days, and stops under new identities.
 * Revision restarts at 1 (independent history) and the source document is not
 * modified, so its revision does not move; the copy is always active and no
 * share capability exists to inherit. */
function copyTrip(db: Db, libraryId: string, tripId: string, at: string): TripDocument {
  const source = getTrip(db, libraryId, tripId)!;
  const id = newId();
  db.prepare(
    `INSERT INTO trips (id, library_id, title, destination, timezone, start_date, end_date, duration_days, travelers, context_json, revision, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
  ).run(
    id,
    libraryId,
    source.title,
    source.destination,
    source.timezone,
    source.startDate,
    source.endDate,
    source.durationDays,
    source.travelers,
    JSON.stringify(source.context),
    at,
    at,
  );
  const insertDay = db.prepare(
    `INSERT INTO trip_days (id, trip_id, position, date, label, theme, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const dayIdMap = new Map<string, string>();
  for (const day of source.days) {
    const dayId = newId();
    dayIdMap.set(day.id, dayId);
    insertDay.run(dayId, id, day.position, day.date, day.label, day.theme, at, at);
  }
  for (const stop of [...source.days.flatMap((day) => day.stops), ...source.unscheduled]) {
    insertClonedStop(db, id, stop.dayId === null ? null : dayIdMap.get(stop.dayId) ?? null, stop, at);
  }
  return getTrip(db, libraryId, id)!;
}

/** Clone identity policy: duplication creates a new stop id and stamps clone
 * time on both timestamps; day ids are remapped by the caller. Every
 * persisted field is carried verbatim through the repository snapshot
 * insert, so a later column cannot be dropped from duplicate by forgetting
 * a field. */
function insertClonedStop(db: Db, tripId: string, dayId: string | null, stop: TripStop, at: string): void {
  insertStopSnapshot(db, tripId, { ...stop, id: newId(), dayId, createdAt: at, updatedAt: at });
}

export function duplicateTrip(db: Db, libraryId: string, tripId: string, input: unknown, at = nowIso()): TripDocument | null {
  return withTripMutation(db, libraryId, tripId, {
    kind: "duplicate",
    input,
    at,
    apply: () => ({ result: copyTrip(db, libraryId, tripId, at) }),
  });
}

function setArchived(db: Db, libraryId: string, tripId: string, input: unknown, archived: boolean, at: string): TripDocument | null {
  return withTripMutation(db, libraryId, tripId, {
    kind: archived ? "archive" : "restore",
    input,
    at,
    apply: (tripRow, at, bump) => {
      // Already-in-state archive/restore stays a no-bump no-op, but only after
      // the envelope (stale revision, replayed id) has been fully checked.
      if (Boolean(tripRow.archived_at) !== archived) {
        db.prepare(`UPDATE trips SET archived_at = ? WHERE id = ?`).run(archived ? at : null, tripId);
        bump();
      }
      return { result: getTrip(db, libraryId, tripId)! };
    },
  });
}

export function archiveTrip(db: Db, libraryId: string, tripId: string, input: unknown, at = nowIso()): TripDocument | null {
  return setArchived(db, libraryId, tripId, input, true, at);
}

export function restoreTrip(db: Db, libraryId: string, tripId: string, input: unknown, at = nowIso()): TripDocument | null {
  return setArchived(db, libraryId, tripId, input, false, at);
}

/** Human-only delete. The confirm field must arrive exactly like library
 * delete, alongside the standard mutation envelope; agent adapters never get a
 * route for this. Only trip-owned rows are removed — stops, changesets, days,
 * then the trip — so referenced Library entities (Items, Places, tags) are
 * untouched by construction. The delete receipt is owner-scoped and survives
 * the Trip row so an exact retry still returns success. */
export function deleteTrip(db: Db, libraryId: string, tripId: string, input: unknown): boolean {
  const rec = (input ?? {}) as Record<string, unknown>;
  if (rec.confirm !== "DELETE") throw new RejectedPayload('delete requires confirm "DELETE"');
  return (
    withTripMutation<boolean>(db, libraryId, tripId, {
      kind: "delete",
      input,
      payload: { confirm: "DELETE" },
      apply: () => {
        db.prepare(`DELETE FROM trip_stops WHERE trip_id = ?`).run(tripId);
        db.prepare(`DELETE FROM trip_changesets WHERE trip_id = ?`).run(tripId);
        db.prepare(`DELETE FROM trip_days WHERE trip_id = ?`).run(tripId);
        db.prepare(`DELETE FROM trips WHERE library_id = ? AND id = ?`).run(libraryId, tripId);
        return { result: true };
      },
    }) ?? false
  );
}
