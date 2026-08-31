import { useState } from "react";
import type { TripChangeOp, TripStop, TripStopContent } from "./api.ts";

/** Submit payload for one stop edit. Outside content and holes are trip-owned
 * and fully editable; Item and Place references are authoritative Library
 * data, so only timing and notes change here (content stays undefined).
 * A blank required title yields null: the form skips apply and stays open. */
export function updateStopOps(input: {
  stopId: string;
  content: TripStopContent;
  title: string;
  notes: string;
  url: string;
  timeWindow: string;
  duration: string;
  publicNotes: string;
  privateNotes: string;
  reservation: string;
  storedFacts: string;
  alternatives: string;
}): Extract<TripChangeOp, { type: "updateStop" }>[] | null {
  const isOutside = input.content.kind === "outside";
  const isHole = input.content.kind === "hole";
  if ((isOutside || isHole) && !input.title.trim()) return null;
  const linesOf = (value: string) => value.split("\n").map((line) => line.trim()).filter(Boolean).slice(0, 12);
  return [
    {
      type: "updateStop",
      stopId: input.stopId,
      content: isOutside
        ? { kind: "outside", title: input.title.trim(), notes: input.notes.trim() || null, url: input.url.trim() || null }
        : isHole
          ? { kind: "hole", request: input.title.trim() }
          : undefined,
      timeWindow: input.timeWindow.trim() || null,
      durationMinutes: input.duration ? Number(input.duration) : null,
      publicNotes: input.publicNotes.trim() || null,
      privateNotes: input.privateNotes.trim() || null,
      reservation: input.reservation.trim() || null,
      storedFacts: linesOf(input.storedFacts),
      alternatives: linesOf(input.alternatives),
    },
  ];
}

export function EditStopForm({
  stop,
  busy,
  onClose,
  apply,
}: {
  stop: TripStop;
  busy: boolean;
  onClose: () => void;
  apply: (operations: TripChangeOp[], note: string) => void;
}) {
  const content = stop.content;
  const isOutside = content.kind === "outside";
  const isHole = content.kind === "hole";
  const [title, setTitle] = useState(isOutside ? content.title : isHole ? content.request : "");
  const [notes, setNotes] = useState(isOutside ? (content.notes ?? "") : "");
  const [url, setUrl] = useState(isOutside ? (content.url ?? "") : "");
  const [timeWindow, setTimeWindow] = useState(stop.timeWindow ?? "");
  const [duration, setDuration] = useState(stop.durationMinutes === null ? "" : String(stop.durationMinutes));
  const [publicNotes, setPublicNotes] = useState(stop.publicNotes);
  const [privateNotes, setPrivateNotes] = useState(stop.privateNotes);
  const [reservation, setReservation] = useState(stop.reservation ?? "");
  const [storedFacts, setStoredFacts] = useState(stop.storedFacts.join("\n"));
  const [alternatives, setAlternatives] = useState(stop.alternatives.join("\n"));

  function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    const operations = updateStopOps({
      stopId: stop.id,
      content,
      title,
      notes,
      url,
      timeWindow,
      duration,
      publicNotes,
      privateNotes,
      reservation,
      storedFacts,
      alternatives,
    });
    if (!operations) return;
    apply(operations, "Stop updated.");
    onClose();
  }

  return (
    <li className="trip-stop trip-stop-editing">
      <form className="trip-add-form" onSubmit={submit}>
        {isOutside ? (
          <>
            <label className="trip-field">
              Stop title
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required autoFocus />
            </label>
            <label className="trip-field">
              Notes
              <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={400} />
            </label>
            <label className="trip-field">
              Source link <span className="trip-hint">optional, must be a public http(s) link</span>
              <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} placeholder="https://…" />
            </label>
          </>
        ) : isHole ? (
          <label className="trip-field">
            What is missing?
            <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required autoFocus />
          </label>
        ) : (
          <p className="trip-place-hint">
            This stop references {stop.content.kind === "item" ? "a saved item" : "a Place"} in your Library. Its name and source live there — edit the
            timing below or move the stop.
          </p>
        )}
        <div className="trip-add-when">
          <label className="trip-field">
            Time window
            <input value={timeWindow} onChange={(e) => setTimeWindow(e.target.value)} maxLength={120} placeholder="e.g. 09:00–11:00" />
          </label>
          <label className="trip-field">
            Duration (min)
            <input type="number" min={1} max={1440} value={duration} onChange={(e) => setDuration(e.target.value)} />
          </label>
        </div>
        <details className="trip-optional">
          <summary>More stop details</summary>
          <label className="trip-field">
            Public notes <span className="trip-hint">visible on a Share Snapshot</span>
            <textarea value={publicNotes} onChange={(e) => setPublicNotes(e.target.value)} rows={2} maxLength={400} aria-label="Public notes, shareable" />
          </label>
          <label className="trip-field">
            Private notes <span className="trip-hint">never shared or exported</span>
            <textarea value={privateNotes} onChange={(e) => setPrivateNotes(e.target.value)} rows={2} maxLength={400} aria-label="Private notes, not shared" />
          </label>
          <label className="trip-field">
            Reservation
            <input value={reservation} onChange={(e) => setReservation(e.target.value)} maxLength={120} aria-label="Reservation" />
          </label>
          <label className="trip-field">
            Stored facts <span className="trip-hint">one per line</span>
            <textarea value={storedFacts} onChange={(e) => setStoredFacts(e.target.value)} rows={2} maxLength={2000} aria-label="Stored facts" />
          </label>
          <label className="trip-field">
            Alternatives <span className="trip-hint">one per line</span>
            <textarea value={alternatives} onChange={(e) => setAlternatives(e.target.value)} rows={2} maxLength={2000} aria-label="Alternatives" />
          </label>
        </details>
        <p className="trip-form-actions">
          <button type="submit" className="btn primary" disabled={busy}>
            {busy ? "Saving…" : "Save"}
          </button>
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
        </p>
      </form>
    </li>
  );
}
