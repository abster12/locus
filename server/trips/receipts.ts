import { createHash } from "node:crypto";
import { ownedLibraryId } from "../../db/library-id.ts";
import type { Db } from "../../db/open.ts";
import { nowIso, tx } from "../../db/open.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { validateMutationFields } from "./policy.ts";
import { tripRowOrNull, type TripRow } from "./repository.ts";

export class TripConflict extends Error {
  readonly code = "conflict";
  constructor(message: string) {
    super(message);
    this.name = "TripConflict";
  }
}

const REUSE_ERROR = "clientMutationId was already used for a different change";

type StoredReceipt = { payload_hash: string; result_json: string; trip_id: string | null };

export function mutationPayloadHash(kind: string, expectedRevision: number | null, payload: unknown, tripId: string | null = null): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, expectedRevision, tripId, payload: payload ?? null }))
    .digest("hex");
}

function legacyMutationPayloadHash(kind: string, expectedRevision: number | null, payload: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify({ kind, expectedRevision, payload: payload ?? null }))
    .digest("hex");
}

function getReceipt(db: Db, libraryId: string, clientMutationId: string): StoredReceipt | undefined {
  return db
    .prepare(`SELECT payload_hash, result_json, trip_id FROM trip_mutation_receipts WHERE library_id = ? AND client_mutation_id = ?`)
    .get(libraryId, clientMutationId) as StoredReceipt | undefined;
}

function replayOrConflict<T>(existing: StoredReceipt, hash: string, legacyHash: string, tripId: string | null): T {
  if (existing.payload_hash === hash) return JSON.parse(existing.result_json) as T;
  if (existing.payload_hash === legacyHash && existing.trip_id === tripId) return JSON.parse(existing.result_json) as T;
  throw new RejectedPayload(REUSE_ERROR);
}

/** Create is owner-scoped: the mutation id is unique per Library, not per Trip,
 * because the Trip id does not exist until the first successful write. */
export function withCreateMutation<T>(
  db: Db,
  libraryId: string,
  clientMutationId: string,
  spec: {
    kind: string;
    payload: unknown;
    at?: string;
    apply: (at: string) => { result: T; tripId: string; resultRevision: number; receipt?: unknown };
  },
): T {
  libraryId = ownedLibraryId(libraryId);
  const at = spec.at ?? nowIso();
  const hash = mutationPayloadHash(spec.kind, null, spec.payload);
  const legacyHash = legacyMutationPayloadHash(spec.kind, null, spec.payload);
  return tx(db, () => {
    const existing = getReceipt(db, libraryId, clientMutationId);
    if (existing) return replayOrConflict<T>(existing, hash, legacyHash, existing.trip_id);
    const applied = spec.apply(at);
    db.prepare(
      `INSERT INTO trip_mutation_receipts (library_id, client_mutation_id, trip_id, kind, payload_hash, result_json, result_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      libraryId,
      clientMutationId,
      applied.tripId,
      spec.kind,
      hash,
      JSON.stringify(applied.receipt ?? applied.result),
      applied.resultRevision,
      at,
    );
    return applied.result;
  });
}

/** Receipt lookup is owner-scoped and runs before the Trip row is required, so
 * a delete replay still returns the original success after the document is gone. */
export function runTripMutation<T, R extends { id: string; revision: number }>(
  db: Db,
  libraryId: string,
  tripId: string,
  spec: {
    kind: string;
    input: unknown;
    payload?: unknown;
    at?: string;
    load: () => R | null | undefined;
    apply: (tripRow: R, at: string, bump: () => void) => { result: T; receipt?: unknown };
  },
): T | null {
  libraryId = ownedLibraryId(libraryId);
  const fields = validateMutationFields(spec.input, "lifecycle");
  const at = spec.at ?? nowIso();
  const hash = mutationPayloadHash(spec.kind, fields.expectedRevision, spec.payload ?? null, tripId);
  const legacyHash = legacyMutationPayloadHash(spec.kind, fields.expectedRevision, spec.payload ?? null);
  return tx(db, () => {
    const existing = getReceipt(db, libraryId, fields.clientMutationId);
    if (existing) return replayOrConflict<T>(existing, hash, legacyHash, tripId);
    const tripRow = spec.load();
    if (!tripRow) return null;
    if (tripRow.revision !== fields.expectedRevision) {
      throw new TripConflict(`expected revision ${fields.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
    }
    db.prepare(
      `INSERT INTO trip_mutation_receipts (library_id, client_mutation_id, trip_id, kind, payload_hash, result_json, result_revision, created_at)
       VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
    ).run(libraryId, fields.clientMutationId, tripId, spec.kind, hash, tripRow.revision, at);
    let bumped = false;
    const applied = spec.apply(tripRow, at, () => {
      bumped = true;
      db.prepare(`UPDATE trips SET revision = revision + 1, updated_at = ? WHERE id = ?`).run(at, tripId);
    });
    db.prepare(
      `UPDATE trip_mutation_receipts SET result_json = ?, result_revision = ? WHERE library_id = ? AND client_mutation_id = ?`,
    ).run(
      JSON.stringify(applied.receipt ?? applied.result),
      tripRow.revision + (bumped ? 1 : 0),
      libraryId,
      fields.clientMutationId,
    );
    return applied.result;
  });
}

/** Every mutation of an existing Trip Document carries one envelope:
 * { expectedRevision, clientMutationId, ...operation-specific payload }.
 * Receipt check and the protected write share one transaction in
 * runTripMutation; callers only supply the load hook's standard row lookup. */
export function withTripMutation<T>(
  db: Db,
  libraryId: string,
  tripId: string,
  spec: {
    kind: string;
    input: unknown;
    /** Normalized operation-specific payload hashed alongside kind and
     * expectedRevision, so a retry must repeat the change exactly. */
    payload?: unknown;
    at?: string;
    apply: (tripRow: TripRow, at: string, bump: () => void) => { result: T; receipt?: unknown };
  },
): T | null {
  return runTripMutation(db, libraryId, tripId, {
    ...spec,
    load: () => tripRowOrNull(db, libraryId, tripId) ?? null,
  });
}
