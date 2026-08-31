import { useState } from "react";
import type { TripChangeOp, TripStopContent } from "./api.ts";
import { buildAddOrFillOps, type FillPlacement } from "./trips-stop-ops.ts";

/** Placeholder add/fill ops from raw form fields. Blank title yields null and
 * emits no ops. Fill placement goes through the shared builder so the
 * placeholder path cannot drift from Library. */
export function placeholderStopOps(input: {
  dayId: string | null;
  fill?: FillPlacement;
  title: string;
  notes: string;
  url: string;
  timeWindow: string;
  duration: string;
}): TripChangeOp[] | null {
  const title = input.title.trim();
  if (!title) return null;
  const content: TripStopContent = { kind: "outside", title, notes: input.notes.trim() || null, url: input.url.trim() || null };
  const timing = { timeWindow: input.timeWindow.trim() || null, durationMinutes: input.duration ? Number(input.duration) : null };
  // Filling a hole is one changeset: the hole closes and the new stop takes
  // its exact place (before the stop that followed the hole).
  return buildAddOrFillOps({ dayId: input.dayId, content, fill: input.fill, timing });
}

/** Hole add ops from the raw request field. Blank request yields null. */
export function holeStopOps(input: { dayId: string | null; request: string }): TripChangeOp[] | null {
  const request = input.request.trim();
  if (!request) return null;
  return buildAddOrFillOps({ dayId: input.dayId, content: { kind: "hole", request } });
}

export function AddStopForm({
  dayId,
  fill,
  busy,
  onAdd,
  onCancel,
}: {
  dayId: string | null;
  fill?: FillPlacement;
  busy: boolean;
  onAdd: (operations: TripChangeOp[]) => void;
  onCancel: () => void;
}) {
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [url, setUrl] = useState("");
  const [timeWindow, setTimeWindow] = useState("");
  const [duration, setDuration] = useState("");

  function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    const ops = placeholderStopOps({ dayId, fill, title, notes, url, timeWindow, duration });
    if (!ops) return;
    onAdd(ops);
  }

  return (
    <form className="trip-add-form" onSubmit={submit}>
      <label className="trip-field">
        Stop title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required autoFocus placeholder="e.g. Nishiki Market" />
      </label>
      <label className="trip-field">
        Notes
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={400} />
      </label>
      <label className="trip-field">
        Source link <span className="trip-hint">optional, must be a public http(s) link</span>
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} placeholder="https://…" />
      </label>
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
      <p className="trip-form-actions">
        <button type="submit" className="btn primary" disabled={busy || !title.trim()}>
          {busy ? "Saving…" : "Add stop"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}

/** A hole is a bounded request at a stable placement. It is trip-owned text:
 * no Library lookup, no agent, and it stays until filled or dismissed. */
export function HoleForm({
  dayId,
  busy,
  onAdd,
  onCancel,
}: {
  dayId: string | null;
  busy: boolean;
  onAdd: (operations: TripChangeOp[]) => void;
  onCancel: () => void;
}) {
  const [request, setRequest] = useState("");

  function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    const ops = holeStopOps({ dayId, request });
    if (!ops) return;
    onAdd(ops);
  }

  return (
    <form className="trip-add-form" onSubmit={submit}>
      <label className="trip-field">
        What is missing?
        <input
          value={request}
          onChange={(e) => setRequest(e.target.value)}
          maxLength={120}
          required
          autoFocus
          placeholder="e.g. quiet dinner near Gion"
        />
      </label>
      <p className="trip-place-hint">A hole marks an unresolved need at this exact spot until you fill or dismiss it.</p>
      <p className="trip-form-actions">
        <button type="submit" className="btn primary" disabled={busy || !request.trim()}>
          {busy ? "Saving…" : "Add hole"}
        </button>
        <button type="button" className="btn" onClick={onCancel}>
          Cancel
        </button>
      </p>
    </form>
  );
}
