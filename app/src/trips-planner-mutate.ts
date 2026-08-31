import { useEffect, useRef, useState } from "react";
import { api, type TripChangeOp, type TripDocument, type TripMutationResult } from "./api.ts";

export type PlannerMutationOutcome =
  | { status: "skipped" }
  | { status: "ok"; trip: TripDocument; canUndo: boolean; canRedo: boolean; note: string }
  | { status: "err"; message: string };

/** Non-React core of one Day Planner mutation: the busy reentry guard, the
 * replay note, and error message shaping. The hook maps outcomes onto state. */
export async function runPlannerMutation(
  busy: boolean,
  action: () => Promise<TripMutationResult>,
  successNote: string,
): Promise<PlannerMutationOutcome> {
  if (busy) return { status: "skipped" };
  try {
    const result = await action();
    return {
      status: "ok",
      trip: result.trip,
      canUndo: result.canUndo,
      canRedo: result.canRedo,
      note: result.replayed ? "Already saved." : successNote,
    };
  } catch (e: unknown) {
    return { status: "err", message: e instanceof Error ? e.message : String(e) };
  }
}

/** Mutation/history controller for the Day Planner: one busy-guarded changeset
 * channel (apply/undo/redo) plus undo/redo flags refreshed from the trip
 * revision. */
export function useTripPlannerMutations({ trip, onTrip }: { trip: TripDocument; onTrip: (trip: TripDocument) => void }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [flags, setFlags] = useState<{ canUndo: boolean; canRedo: boolean }>({ canUndo: false, canRedo: false });
  // One mutation id per logical changeset: held across a failed attempt so a
  // retry of the same intent (kind, revision, operations) replays the server
  // receipt instead of failing as a new mutation at a stale revision.
  const pendingMut = useRef<{ id: string; fingerprint: string } | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .tripHistory(trip.id)
      .then((next) => {
        if (alive) setFlags({ canUndo: next.canUndo, canRedo: next.canRedo });
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [trip.id, trip.revision]);

  const mutate = async (fingerprint: string, action: (clientMutationId: string) => Promise<TripMutationResult>, successNote: string) => {
    // Reentry guard: the helper re-checks as part of its contract, but the
    // hook must return before touching busy/err so a reentrant call leaves
    // the in-flight mutation's state alone. The pending id resolves after the
    // guard so an in-flight mutation's id is never overwritten.
    if (busy) return;
    if (!pendingMut.current || pendingMut.current.fingerprint !== fingerprint) {
      pendingMut.current = { id: crypto.randomUUID(), fingerprint };
    }
    const clientMutationId = pendingMut.current.id;
    setBusy(true);
    setErr(null);
    try {
      const outcome = await runPlannerMutation(false, () => action(clientMutationId), successNote);
      if (outcome.status === "ok") {
        pendingMut.current = null;
        onTrip(outcome.trip);
        setFlags({ canUndo: outcome.canUndo, canRedo: outcome.canRedo });
        setNotice(outcome.note);
      } else if (outcome.status === "err") {
        setErr(outcome.message);
      }
    } finally {
      setBusy(false);
    }
  };

  const apply = (operations: TripChangeOp[], note: string) =>
    void mutate(
      JSON.stringify({ kind: "apply", expectedRevision: trip.revision, operations }),
      (clientMutationId) => api.applyTripChanges(trip.id, { expectedRevision: trip.revision, clientMutationId, operations }),
      note,
    );
  const undo = () =>
    void mutate(
      JSON.stringify({ kind: "undo", expectedRevision: trip.revision }),
      (clientMutationId) => api.undoTripChanges(trip.id, trip.revision, clientMutationId),
      "Undo applied.",
    );
  const redo = () =>
    void mutate(
      JSON.stringify({ kind: "redo", expectedRevision: trip.revision }),
      (clientMutationId) => api.redoTripChanges(trip.id, trip.revision, clientMutationId),
      "Redo applied.",
    );

  return { busy, err, notice, apply, undo, redo, setNotice, canUndo: flags.canUndo, canRedo: flags.canRedo };
}
