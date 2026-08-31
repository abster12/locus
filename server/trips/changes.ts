import { createHash } from "node:crypto";
import type { Db } from "../../db/open.ts";
import { newId, nowIso, tx } from "../../db/open.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import {
  parseTripOperations,
  validateMutationFields,
  validateTripInferences,
  type TripStopContent,
  type TripStopOp,
  type TripStopProvenance,
} from "./policy.ts";
import { TripConflict } from "./receipts.ts";
import {
  getTrip,
  insertStopSnapshot,
  listDayRows,
  listDismissedAdvisories,
  listStopRows,
  parseProvenance,
  parseStopContent,
  parseStringList,
  requireDayRow,
  requireStopRow,
  resolveStopContent,
  stopsInList,
  toStop,
  tripRowOrNull,
  type StopRow,
  type TripAdvisoryView,
  type TripDocument,
} from "./repository.ts";

// ---------- Day Planner changesets ----------

export type TripChangesetView = {
  id: string;
  tripId: string;
  kind: "change" | "undo" | "redo";
  actor: string;
  instruction: string | null;
  summary: string;
  baseRevision: number;
  resultRevision: number;
  reversesId: string | null;
  createdAt: string;
  undoneAt: string | null;
};

export type TripMutationResult = {
  trip: TripDocument;
  changeset: TripChangesetView;
  replayed: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

type ChangesetRow = {
  row_id?: number;
  id: string;
  trip_id: string;
  base_revision: number;
  result_revision: number;
  actor: string;
  instruction: string | null;
  client_mutation_id: string;
  kind: string;
  operations_json: string;
  inverse_json: string;
  summary: string;
  reverses_id: string | null;
  payload_hash: string;
  undone_at: string | null;
  created_at: string;
};

function toChangesetView(row: ChangesetRow): TripChangesetView {
  return {
    id: row.id,
    tripId: row.trip_id,
    kind: row.kind === "undo" || row.kind === "redo" ? row.kind : "change",
    actor: row.actor,
    instruction: row.instruction,
    summary: row.summary,
    baseRevision: row.base_revision,
    resultRevision: row.result_revision,
    reversesId: row.reverses_id,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  };
}

/** The payload hash covers everything a retry must repeat exactly: a client
 * mutation id may be replayed, never repurposed for a different change. */
function payloadHash(kind: "change" | "undo" | "redo", expectedRevision: number, operations: unknown, instruction: string | null = null, inferences: unknown = null): string {
  return createHash("sha256").update(JSON.stringify({ kind, expectedRevision, operations, instruction, inferences })).digest("hex");
}

function changesetByMutationId(db: Db, tripId: string, clientMutationId: string): ChangesetRow | undefined {
  return db.prepare(`SELECT rowid AS row_id, * FROM trip_changesets WHERE trip_id = ? AND client_mutation_id = ?`).get(tripId, clientMutationId) as
    | ChangesetRow
    | undefined;
}

function insertChangeset(
  db: Db,
  tripId: string,
  params: {
    baseRevision: number;
    resultRevision: number;
    actor: string;
    instruction: string | null;
    clientMutationId: string;
    kind: "change" | "undo" | "redo";
    operations: TripStopOp[];
    inverse: TripStopOp[];
    summary: string;
    reversesId: string | null;
    hash: string;
    at: string;
  },
): ChangesetRow {
  const id = newId();
  db.prepare(
    `INSERT INTO trip_changesets (id, trip_id, base_revision, result_revision, actor, instruction, client_mutation_id, kind, operations_json, inverse_json, summary, reverses_id, payload_hash, undone_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
  ).run(
    id,
    tripId,
    params.baseRevision,
    params.resultRevision,
    params.actor,
    params.instruction,
    params.clientMutationId,
    params.kind,
    JSON.stringify(params.operations),
    JSON.stringify(params.inverse),
    params.summary,
    params.reversesId,
    params.hash,
    params.at,
  );
  return db.prepare(`SELECT rowid AS row_id, * FROM trip_changesets WHERE id = ?`).get(id) as ChangesetRow;
}

function redoTarget(db: Db, tripId: string): ChangesetRow | undefined {
  // LIFO redo: the change undone most recently, and only when no later user
  // change is still active on top of it.
  return db
    .prepare(
      `SELECT rowid AS row_id, * FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NOT NULL ORDER BY undone_at DESC, rowid DESC LIMIT 1`,
    )
    .get(tripId) as ChangesetRow | undefined;
}

function undoRedoFlags(db: Db, tripId: string): { canUndo: boolean; canRedo: boolean } {
  const canUndo = !!db.prepare(`SELECT 1 FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NULL LIMIT 1`).get(tripId);
  let canRedo = false;
  const target = redoTarget(db, tripId);
  if (target?.row_id !== undefined) {
    const blocked = db
      .prepare(`SELECT COUNT(*) AS n FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NULL AND rowid > ?`)
      .get(tripId, target.row_id) as { n: number };
    canRedo = blocked.n === 0;
  }
  return { canUndo, canRedo };
}

function stopTitle(db: Db, libraryId: string, row: StopRow): string {
  const content = parseStopContent(row.content_json);
  if (content.kind === "outside") return content.title;
  if (content.kind === "hole") return content.request;
  const resolved = resolveStopContent(db, libraryId, content);
  if (resolved) return resolved.kind === "item" ? resolved.title : resolved.name;
  return content.kind === "item" ? "a saved item" : "a place";
}

/** Referencing stops must point at entities in the adapter's Library. The
 * check runs at write time; later removal turns the reference broken rather
 * than rejecting or deleting anything. */
function requireStopReference(db: Db, libraryId: string, content: TripStopContent): string {
  if (content.kind === "outside") return content.title;
  if (content.kind === "hole") return content.request;
  const resolved = resolveStopContent(db, libraryId, content);
  if (!resolved) {
    throw new RejectedPayload(content.kind === "item" ? "referenced Item is not in this Library" : "referenced Place is not in this Library");
  }
  return resolved.kind === "item" ? resolved.title : resolved.name;
}

function dayLabelLookup(db: Db, tripId: string): (dayId: string | null) => string {
  const labels = new Map<string, string>();
  for (const day of listDayRows(db, tripId)) labels.set(day.id, day.label);
  return (dayId) => (dayId === null ? "Unscheduled" : labels.get(dayId) ?? "a removed day");
}

/** Resolve an anchor- or index-based insertion point against the target list
 * (with a moving stop already removed). Anchors must exist in that list. */
function insertionIndex(list: StopRow[], placement: { beforeStopId?: string; afterStopId?: string; atPosition?: number }): number {
  if (placement.beforeStopId !== undefined) {
    const index = list.findIndex((row) => row.id === placement.beforeStopId);
    if (index < 0) throw new RejectedPayload("placement anchor not found in the target day");
    return index;
  }
  if (placement.afterStopId !== undefined) {
    const index = list.findIndex((row) => row.id === placement.afterStopId);
    if (index < 0) throw new RejectedPayload("placement anchor not found in the target day");
    return index + 1;
  }
  if (placement.atPosition !== undefined) {
    if (!Number.isInteger(placement.atPosition) || placement.atPosition < 0 || placement.atPosition > list.length) {
      throw new RejectedPayload("placement index is out of range");
    }
    return placement.atPosition;
  }
  return list.length;
}

type Applied = { inverse: TripStopOp | null; note: string };

function applyOne(db: Db, libraryId: string, tripId: string, at: string, actor: string, dayLabelOf: (dayId: string | null) => string, op: TripStopOp): Applied {
  switch (op.type) {
    case "addStop": {
      if (op.dayId !== null) requireDayRow(db, tripId, op.dayId);
      // References are checked against this Library before anything is written;
      // an unknown Item or Place id rejects the whole changeset.
      const display = requireStopReference(db, libraryId, op.content);
      const list = stopsInList(listStopRows(db, tripId), op.dayId);
      const index = insertionIndex(list, op);
      db.prepare(`UPDATE trip_stops SET position = position + 1, updated_at = ? WHERE trip_id = ? AND day_id IS ? AND position >= ?`).run(
        at,
        tripId,
        op.dayId,
        index,
      );
      const id = newId();
      // Human-created stops begin Confirmed; agent-authored content waits in
      // Draft until a human keeps it (spec stories 25–26).
      const isAgent = actor !== "user";
      const state = isAgent ? "draft" : "confirmed";
      const provenance: TripStopProvenance = { actor, via: isAgent ? "agent" : "manual" };
      db.prepare(
        `INSERT INTO trip_stops (id, trip_id, day_id, position, content_json, state, provenance_json, public_notes, private_notes, time_window, duration_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        tripId,
        op.dayId,
        index,
        JSON.stringify(op.content),
        state,
        JSON.stringify(provenance),
        op.publicNotes ?? "",
        op.privateNotes ?? "",
        op.timeWindow ?? null,
        op.durationMinutes ?? null,
        at,
        at,
      );
      return { inverse: { type: "removeStop", stopId: id }, note: `added "${display}" to ${dayLabelOf(op.dayId)}` };
    }
    case "updateStop": {
      const row = requireStopRow(db, tripId, op.stopId);
      const oldContent = parseStopContent(row.content_json);
      const oldState: "confirmed" | "draft" = row.state === "draft" ? "draft" : "confirmed";
      const oldProvenance = parseProvenance(row.provenance_json);
      const isAgent = actor !== "user";
      // Keeping a draft is a human decision; agents review but never confirm
      // their own content (spec: Draft review cannot be bypassed).
      if (op.state === "confirmed" && isAgent) {
        throw new RejectedPayload("only the human can confirm a draft stop");
      }
      const content = op.content ?? oldContent;
      const display = op.content ? requireStopReference(db, libraryId, op.content) : stopTitle(db, libraryId, row);
      const timeWindow = op.timeWindow === undefined ? row.time_window : op.timeWindow;
      const durationMinutes = op.durationMinutes === undefined ? row.duration_minutes : op.durationMinutes;
      const publicNotes = op.publicNotes === undefined ? row.public_notes : (op.publicNotes ?? "");
      const privateNotes = op.privateNotes === undefined ? row.private_notes : (op.privateNotes ?? "");
      const reservation = op.reservation === undefined ? row.reservation : op.reservation;
      const storedFacts = op.storedFacts === undefined ? parseStringList(row.stored_facts_json) : op.storedFacts;
      const alternatives = op.alternatives === undefined ? parseStringList(row.alternatives_json) : op.alternatives;
      // An agent edit is a replacement: the stop drops back to Draft under
      // agent provenance. A user edit keeps the stop's current state unless
      // the op explicitly keeps (confirms) a draft.
      const state = op.state ?? (isAgent ? "draft" : oldState);
      const provenance = op.provenance ?? (isAgent ? ({ actor, via: "agent" } as TripStopProvenance) : oldProvenance);
      db.prepare(
        `UPDATE trip_stops SET content_json = ?, state = ?, provenance_json = ?, time_window = ?, duration_minutes = ?, public_notes = ?, private_notes = ?, reservation = ?, stored_facts_json = ?, alternatives_json = ?, updated_at = ? WHERE id = ? AND trip_id = ?`,
      ).run(JSON.stringify(content), state, JSON.stringify(provenance), timeWindow, durationMinutes, publicNotes, privateNotes, reservation, JSON.stringify(storedFacts), JSON.stringify(alternatives), at, row.id, tripId);
      return {
        inverse: {
          type: "updateStop",
          stopId: row.id,
          content: oldContent,
          timeWindow: row.time_window,
          durationMinutes: row.duration_minutes,
          publicNotes: row.public_notes,
          privateNotes: row.private_notes,
          reservation: row.reservation,
          storedFacts: parseStringList(row.stored_facts_json),
          alternatives: parseStringList(row.alternatives_json),
          state: oldState,
          provenance: oldProvenance,
        },
        note: `updated "${display}"`,
      };
    }
    case "moveStop": {
      const row = requireStopRow(db, tripId, op.stopId);
      const oldDayId = row.day_id ?? null;
      const targetDayId = op.dayId === undefined ? oldDayId : op.dayId;
      if (targetDayId !== null) requireDayRow(db, tripId, targetDayId);
      const all = listStopRows(db, tripId);
      const oldList = stopsInList(all, oldDayId);
      const oldIndex = oldList.findIndex((candidate) => candidate.id === row.id);
      const sameList = (targetDayId ?? null) === (oldDayId ?? null);
      const working = stopsInList(all, targetDayId).filter((candidate) => candidate.id !== row.id);
      const index = insertionIndex(working, op);
      const final = [...working.slice(0, index), row, ...working.slice(index)];
      const update = db.prepare(`UPDATE trip_stops SET day_id = ?, position = ?, updated_at = ? WHERE id = ? AND trip_id = ?`);
      final.forEach((candidate, position) => {
        if ((candidate.day_id ?? null) !== targetDayId || candidate.position !== position) {
          update.run(targetDayId, position, at, candidate.id, tripId);
        }
      });
      // A recorded inverse provenance restores exactly who authored the stop
      // before the move (set when undoing an agent move).
      if (op.provenance) {
        db.prepare(`UPDATE trip_stops SET provenance_json = ? WHERE id = ? AND trip_id = ?`).run(
          JSON.stringify(op.provenance),
          row.id,
          tripId,
        );
      }
      if (!sameList) {
        db.prepare(`UPDATE trip_stops SET position = position - 1, updated_at = ? WHERE trip_id = ? AND day_id IS ? AND position > ?`).run(
          at,
          tripId,
          oldDayId,
          oldIndex,
        );
      }
      // A mechanical agent move records agent provenance but keeps the stop's
      // state — an exact instructed move of a Confirmed stop stays Confirmed.
      if (actor !== "user") {
        db.prepare(`UPDATE trip_stops SET provenance_json = ?, updated_at = ? WHERE id = ? AND trip_id = ?`).run(
          JSON.stringify({ actor, via: "agent move" } satisfies TripStopProvenance),
          at,
          row.id,
          tripId,
        );
      }
      return {
        // The exact inverse: back to the old day at the old absolute index,
        // with the provenance the stop had before the move.
        inverse: { type: "moveStop", stopId: row.id, dayId: oldDayId, atPosition: oldIndex, provenance: parseProvenance(row.provenance_json) },
        note: `moved "${stopTitle(db, libraryId, row)}" to ${dayLabelOf(targetDayId)}`,
      };
    }
    case "removeStop": {
      const row = requireStopRow(db, tripId, op.stopId);
      const title = stopTitle(db, libraryId, row);
      const snapshot = toStop(row);
      db.prepare(`DELETE FROM trip_stops WHERE id = ? AND trip_id = ?`).run(row.id, tripId);
      db.prepare(`UPDATE trip_stops SET position = position - 1, updated_at = ? WHERE trip_id = ? AND day_id IS ? AND position > ?`).run(
        at,
        tripId,
        row.day_id,
        row.position,
      );
      return { inverse: { type: "restoreStop", stop: snapshot }, note: `removed "${title}" from ${dayLabelOf(snapshot.dayId)}` };
    }
    case "updateDay": {
      const row = requireDayRow(db, tripId, op.dayId);
      db.prepare(`UPDATE trip_days SET theme = ?, updated_at = ? WHERE id = ? AND trip_id = ?`).run(op.theme, at, row.id, tripId);
      return { inverse: { type: "updateDay", dayId: row.id, theme: row.theme ?? null }, note: `updated theme for ${row.label}` };
    }
    case "restoreInferences": {
      const previous = db.prepare(`SELECT inferences_json FROM trips WHERE id = ?`).get(tripId) as { inferences_json: string } | undefined;
      db.prepare(`UPDATE trips SET inferences_json = ? WHERE id = ?`).run(op.json, tripId);
      return { inverse: { type: "restoreInferences", json: previous?.inferences_json ?? "[]" }, note: "restored inferences" };
    }
    case "restoreStop": {
      const stop = op.stop;
      // Restoration identity policy: undo preserves the removed stop's own id
      // and the snapshot's original created/updated timestamps. Collision
      // reindexing below stays in this changeset workflow.
      insertStopSnapshot(db, tripId, stop);
      db.prepare(`UPDATE trip_stops SET position = position + 1, updated_at = ? WHERE trip_id = ? AND day_id IS ? AND position >= ? AND id != ?`).run(
        at,
        tripId,
        stop.dayId,
        stop.position,
        stop.id,
      );
      return { inverse: { type: "removeStop", stopId: stop.id }, note: `restored "${stopTitleOf(stop.content)}"` };
    }
  }
}

function stopTitleOf(content: TripStopContent): string {
  if (content.kind === "outside") return content.title;
  if (content.kind === "hole") return content.request;
  return content.kind === "item" ? "a saved item" : "a place";
}

/** Apply a bounded op list inside the caller's transaction. Each inverse is
 * captured against the state before its op runs; undo replays them in reverse
 * order, which reconstructs the exact prior arrangement of every touched list. */
function applyOps(db: Db, libraryId: string, tripId: string, at: string, actor: string, ops: TripStopOp[]): { summary: string; inverses: TripStopOp[] } {
  const dayLabelOf = dayLabelLookup(db, tripId);
  const inverses: TripStopOp[] = [];
  const notes: string[] = [];
  for (const op of ops) {
    const applied = applyOne(db, libraryId, tripId, at, actor, dayLabelOf, op);
    if (applied.inverse) inverses.unshift(applied.inverse);
    notes.push(applied.note);
  }
  return { summary: notes.join("; ").slice(0, 240), inverses };
}

/** Trusted-actor guard shared with the review write path in review.ts. */
export function requireActor(actor: string): string {
  if (typeof actor !== "string" || !actor.trim()) throw new RejectedPayload("actor is required from the trusted adapter");
  return actor;
}

function replayOrThrow(existing: ChangesetRow, hash: string): TripChangesetView {
  if (existing.payload_hash !== hash) {
    throw new RejectedPayload("clientMutationId was already used for a different change");
  }
  return toChangesetView(existing);
}

export function applyTripChanges(db: Db, libraryId: string, tripId: string, input: unknown, actor: string, at = nowIso()): TripMutationResult | null {
  const trustedActor = requireActor(actor);
  const fields = validateMutationFields(input, "change");
  const rec = input as Record<string, unknown>;
  const operations = parseTripOperations(rec.operations);
  // Inferred preferences ride the same atomic changeset as the build (ticket
  // 10): one agent write, one revision bump, and a stale or partially invalid
  // call leaves both the stops and the labels untouched. Only the agent
  // adapter may set them; the human context form never carries this field.
  const hasInferences = rec.inferredPreferences !== undefined;
  if (hasInferences && trustedActor === "user") throw new RejectedPayload("inferred preferences can only be saved by the agent adapter");
  const inferences = hasInferences ? validateTripInferences(rec.inferredPreferences) : null;
  const hash = payloadHash("change", fields.expectedRevision, operations, fields.instruction, hasInferences ? inferences : null);
  return tx(db, () => {
    const tripRow = tripRowOrNull(db, libraryId, tripId);
    if (!tripRow) return null;
    const existing = changesetByMutationId(db, tripId, fields.clientMutationId);
    if (existing) {
      const changeset = replayOrThrow(existing, hash);
      return { trip: getTrip(db, libraryId, tripId)!, changeset, replayed: true, ...undoRedoFlags(db, tripId) };
    }
    if (tripRow.revision !== fields.expectedRevision) {
      throw new TripConflict(`expected revision ${fields.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
    }
    const applied = applyOps(db, libraryId, tripId, at, trustedActor, operations);
    const inverses = applied.inverses;
    if (inferences && inferences.length > 0) {
      const previous = tripRow.inferences_json;
      db.prepare(`UPDATE trips SET inferences_json = ? WHERE id = ?`).run(
        JSON.stringify(inferences.map((entry) => ({ id: newId(), text: entry.text, basis: entry.basis }))),
        tripId,
      );
      inverses.unshift({ type: "restoreInferences", json: previous });
    }
    const resultRevision = fields.expectedRevision + 1;
    db.prepare(`UPDATE trips SET revision = ?, updated_at = ? WHERE id = ?`).run(resultRevision, at, tripId);
    const row = insertChangeset(db, tripId, {
      baseRevision: fields.expectedRevision,
      resultRevision,
      actor: trustedActor,
      instruction: fields.instruction,
      clientMutationId: fields.clientMutationId,
      kind: "change",
      operations,
      inverse: inverses,
      summary: applied.summary,
      reversesId: null,
      hash,
      at,
    });
    return { trip: getTrip(db, libraryId, tripId)!, changeset: toChangesetView(row), replayed: false, ...undoRedoFlags(db, tripId) };
  });
}

/** Undo reverses the most recent still-active user changeset by applying its
 * stored inverse operations as a new auditable changeset. Undo rows themselves
 * are never undo targets; redo reverses an undo. */
export function undoTripChanges(db: Db, libraryId: string, tripId: string, input: unknown, actor: string, at = nowIso()): TripMutationResult | null {
  const trustedActor = requireActor(actor);
  const fields = validateMutationFields(input, "undo");
  const hash = payloadHash("undo", fields.expectedRevision, null);
  return tx(db, () => {
    const tripRow = tripRowOrNull(db, libraryId, tripId);
    if (!tripRow) return null;
    const existing = changesetByMutationId(db, tripId, fields.clientMutationId);
    if (existing) {
      const changeset = replayOrThrow(existing, hash);
      return { trip: getTrip(db, libraryId, tripId)!, changeset, replayed: true, ...undoRedoFlags(db, tripId) };
    }
    if (tripRow.revision !== fields.expectedRevision) {
      throw new TripConflict(`expected revision ${fields.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
    }
    const target = db
      .prepare(`SELECT rowid AS row_id, * FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NULL ORDER BY rowid DESC LIMIT 1`)
      .get(tripId) as ChangesetRow | undefined;
    if (!target) throw new RejectedPayload("nothing to undo");
    const operations = JSON.parse(target.inverse_json) as TripStopOp[];
    const applied = applyOps(db, libraryId, tripId, at, trustedActor, operations);
    const resultRevision = fields.expectedRevision + 1;
    db.prepare(`UPDATE trips SET revision = ?, updated_at = ? WHERE id = ?`).run(resultRevision, at, tripId);
    db.prepare(`UPDATE trip_changesets SET undone_at = ? WHERE id = ?`).run(at, target.id);
    const row = insertChangeset(db, tripId, {
      baseRevision: fields.expectedRevision,
      resultRevision,
      actor: trustedActor,
      instruction: null,
      clientMutationId: fields.clientMutationId,
      kind: "undo",
      operations,
      inverse: applied.inverses,
      summary: `Undo — ${applied.summary}`.slice(0, 240),
      reversesId: target.id,
      hash,
      at,
    });
    return { trip: getTrip(db, libraryId, tripId)!, changeset: toChangesetView(row), replayed: false, ...undoRedoFlags(db, tripId) };
  });
}

export function redoTripChanges(db: Db, libraryId: string, tripId: string, input: unknown, actor: string, at = nowIso()): TripMutationResult | null {
  const trustedActor = requireActor(actor);
  const fields = validateMutationFields(input, "redo");
  const hash = payloadHash("redo", fields.expectedRevision, null);
  return tx(db, () => {
    const tripRow = tripRowOrNull(db, libraryId, tripId);
    if (!tripRow) return null;
    const existing = changesetByMutationId(db, tripId, fields.clientMutationId);
    if (existing) {
      const changeset = replayOrThrow(existing, hash);
      return { trip: getTrip(db, libraryId, tripId)!, changeset, replayed: true, ...undoRedoFlags(db, tripId) };
    }
    if (tripRow.revision !== fields.expectedRevision) {
      throw new TripConflict(`expected revision ${fields.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
    }
    const target = redoTarget(db, tripId);
    if (!target?.row_id) throw new RejectedPayload("nothing to redo");
    const blocked = db
      .prepare(`SELECT COUNT(*) AS n FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NULL AND rowid > ?`)
      .get(tripId, target.row_id) as { n: number };
    if (blocked.n > 0) throw new RejectedPayload("nothing to redo");
    const undoRow = db
      .prepare(`SELECT inverse_json FROM trip_changesets WHERE trip_id = ? AND kind = 'undo' AND reverses_id = ? ORDER BY rowid DESC LIMIT 1`)
      .get(tripId, target.id) as { inverse_json: string } | undefined;
    if (!undoRow) throw new RejectedPayload("nothing to redo");
    const operations = JSON.parse(undoRow.inverse_json) as TripStopOp[];
    const applied = applyOps(db, libraryId, tripId, at, trustedActor, operations);
    const resultRevision = fields.expectedRevision + 1;
    db.prepare(`UPDATE trips SET revision = ?, updated_at = ? WHERE id = ?`).run(resultRevision, at, tripId);
    db.prepare(`UPDATE trip_changesets SET undone_at = NULL WHERE id = ?`).run(target.id);
    const row = insertChangeset(db, tripId, {
      baseRevision: fields.expectedRevision,
      resultRevision,
      actor: trustedActor,
      instruction: null,
      clientMutationId: fields.clientMutationId,
      kind: "redo",
      operations,
      inverse: JSON.parse(target.inverse_json) as TripStopOp[],
      summary: `Redo — ${applied.summary}`.slice(0, 240),
      reversesId: target.id,
      hash,
      at,
    });
    return { trip: getTrip(db, libraryId, tripId)!, changeset: toChangesetView(row), replayed: false, ...undoRedoFlags(db, tripId) };
  });
}

/** Bounded history (newest first), the undo/redo availability flags the Day
 * Planner renders as disabled buttons rather than guessing client-side, and
 * the owning Library's dismissed advisory history. */
export function getTripHistory(db: Db, libraryId: string, tripId: string): { changesets: TripChangesetView[]; canUndo: boolean; canRedo: boolean; dismissedAdvisories: TripAdvisoryView[] } | null {
  if (!tripRowOrNull(db, libraryId, tripId)) return null;
  const rows = db
    .prepare(`SELECT rowid AS row_id, * FROM trip_changesets WHERE trip_id = ? ORDER BY rowid DESC LIMIT 100`)
    .all(tripId) as unknown as ChangesetRow[];
  return { changesets: rows.map(toChangesetView), ...undoRedoFlags(db, tripId), dismissedAdvisories: listDismissedAdvisories(db, libraryId, tripId) ?? [] };
}
