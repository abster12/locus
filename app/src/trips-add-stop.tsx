import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { api, type TripChangeOp, type TripDocument } from "./api.ts";
import { LibrarySearchForm } from "./trips-library-picker.tsx";
import { AddStopForm, HoleForm } from "./trips-stop-forms.tsx";
import type { OpenAdd } from "./trips-stop-ops.ts";

const TITLES = {
  choice: "What do you want to add?",
  library: "Add a saved place or Item",
  outside: "Add something outside Locus",
  hole: "Add a hole",
} as const;

/** Focused Add Stop dialog: source choice, then one form, one insertion path. */
export function AddStopDialog({
  trip,
  openAdd,
  onOpenAdd,
  onClose,
  onTrip,
}: {
  trip: TripDocument;
  openAdd: NonNullable<OpenAdd>;
  onOpenAdd: (next: OpenAdd) => void;
  onClose: () => void;
  onTrip: (trip: TripDocument) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const pendingMut = useRef<{ id: string; fingerprint: string } | null>(null);
  const days = trip.days.map((day) => ({ id: day.id, label: day.label }));
  const fillRequest = openAdd.fill
    ? (([...trip.days.flatMap((day) => day.stops), ...trip.unscheduled].find((stop) => stop.id === openAdd.fill?.holeId)?.content as { request?: string } | undefined)
        ?.request ?? "")
    : "";
  const heading = openAdd.source ? TITLES[openAdd.source] : TITLES.choice;

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    return () => {
      if (el.open) el.close();
      previouslyFocused?.focus();
    };
  }, []);

  useEffect(() => {
    setErr(null);
  }, [openAdd.source]);

  async function submit(operations: TripChangeOp[]) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const fingerprint = JSON.stringify({ expectedRevision: trip.revision, operations });
      if (!pendingMut.current || pendingMut.current.fingerprint !== fingerprint) {
        pendingMut.current = { id: crypto.randomUUID(), fingerprint };
      }
      const result = await api.applyTripChanges(trip.id, {
        expectedRevision: trip.revision,
        clientMutationId: pendingMut.current.id,
        operations,
      });
      pendingMut.current = null;
      onTrip(result.trip);
      onClose();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  const back = () => onOpenAdd({ ...openAdd, source: null });
  const form = { dayId: openAdd.dayId, days, fill: openAdd.fill, busy, onAdd: submit, onBack: back };

  return (
    <dialog
      ref={dialog}
      className="trip-add-dialog"
      aria-labelledby="trip-add-title"
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="trip-add-head">
        <h2 id="trip-add-title">{heading}</h2>
        <button type="button" className="btn trip-add-close" aria-label="Close add stop flow" disabled={busy} onClick={onClose}>
          ×
        </button>
      </div>
      {openAdd.fill ? (
        <p className="trip-fill-label">Fill “{fillRequest}” — the hole closes and what you add takes its exact place.</p>
      ) : openAdd.source === null ? (
        <p className="trip-place-hint">Choose the source that matches what you know. Every path creates one Trip Stop.</p>
      ) : null}
      {err ? (
        <p className="bad" role="alert">
          {err}
        </p>
      ) : null}
      {openAdd.source === null ? (
        <div className="trip-add-choices">
          <button type="button" className="trip-add-choice" onClick={() => onOpenAdd({ ...openAdd, source: "library" })}>
            Choose from Library
          </button>
          <button type="button" className="trip-add-choice" onClick={() => onOpenAdd({ ...openAdd, source: "outside" })}>
            Add outside content
          </button>
          {openAdd.fill ? null : (
            <button type="button" className="trip-add-choice" onClick={() => onOpenAdd({ ...openAdd, source: "hole" })}>
              Add a hole
            </button>
          )}
        </div>
      ) : null}
      {openAdd.source === "library" ? <LibrarySearchForm {...form} /> : null}
      {openAdd.source === "outside" ? <AddStopForm {...form} /> : null}
      {openAdd.source === "hole" ? <HoleForm dayId={openAdd.dayId} days={days} busy={busy} onAdd={submit} onBack={back} /> : null}
    </dialog>
  );
}
