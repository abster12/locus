import { useState } from "react";
import type { TripChangeOp, TripStopContent } from "./api.ts";
import { buildAddOrFillOps, type FillPlacement } from "./trips-stop-ops.ts";

export type DayOption = { id: string; label: string };

/** Outside-content add/fill ops from raw form fields. Blank title yields null
 * and emits no ops. Fill placement goes through the shared builder so this
 * path cannot drift from Library. */
export function placeholderStopOps(input: {
  dayId: string | null;
  fill?: FillPlacement;
  title: string;
  notes: string;
  url: string;
  timeWindow: string;
  duration: string;
  publicNotes?: string;
  privateNotes?: string;
  state?: "confirmed" | "draft";
}): TripChangeOp[] | null {
  const title = input.title.trim();
  if (!title) return null;
  const content: TripStopContent = { kind: "outside", title, notes: input.notes.trim() || null, url: input.url.trim() || null };
  const timing = { timeWindow: input.timeWindow.trim() || null, durationMinutes: input.duration ? Number(input.duration) : null };
  return buildAddOrFillOps({
    dayId: input.dayId,
    content,
    fill: input.fill,
    timing,
    publicNotes: input.publicNotes,
    privateNotes: input.privateNotes,
    state: input.state,
  });
}

/** Hole add ops from the raw request field. Blank request yields null. */
export function holeStopOps(input: { dayId: string | null; request: string }): TripChangeOp[] | null {
  const request = input.request.trim();
  if (!request) return null;
  return buildAddOrFillOps({ dayId: input.dayId, content: { kind: "hole", request } });
}

function DaySelect({
  days,
  dayId,
  locked,
  onChange,
}: {
  days: DayOption[];
  dayId: string | null;
  locked?: boolean;
  onChange: (dayId: string | null) => void;
}) {
  return (
    <label className="trip-field">
      Trip Day
      <select value={dayId ?? "unscheduled"} disabled={locked} onChange={(event) => onChange(event.target.value === "unscheduled" ? null : event.target.value)}>
        {days.map((day) => (
          <option key={day.id} value={day.id}>
            {day.label}
          </option>
        ))}
        <option value="unscheduled">Unscheduled</option>
      </select>
    </label>
  );
}

/** Shared day, time, duration, and notes controls for Library and outside-content add forms. */
export function StopPlacementFields({
  days,
  dayId,
  locked,
  onDayId,
  timeWindow,
  onTimeWindow,
  duration,
  onDuration,
  publicNotes,
  onPublicNotes,
  privateNotes,
  onPrivateNotes,
  privateHint,
}: {
  days: DayOption[];
  dayId: string | null;
  locked?: boolean;
  onDayId: (dayId: string | null) => void;
  timeWindow: string;
  onTimeWindow: (value: string) => void;
  duration: string;
  onDuration: (value: string) => void;
  publicNotes: string;
  onPublicNotes: (value: string) => void;
  privateNotes: string;
  onPrivateNotes: (value: string) => void;
  privateHint: string;
}) {
  return (
    <>
      <DaySelect days={days} dayId={dayId} locked={locked} onChange={onDayId} />
      <div className="trip-add-when">
        <label className="trip-field">
          Time window
          <input value={timeWindow} onChange={(e) => onTimeWindow(e.target.value)} maxLength={120} placeholder="e.g. 09:00–11:00" />
        </label>
        <label className="trip-field">
          Duration (min)
          <input type="number" min={1} max={1440} value={duration} onChange={(e) => onDuration(e.target.value)} />
        </label>
      </div>
      <label className="trip-field">
        Public notes <span className="trip-hint">included in a Share Snapshot</span>
        <textarea value={publicNotes} onChange={(e) => onPublicNotes(e.target.value)} rows={2} maxLength={400} />
      </label>
      <label className="trip-field">
        Private notes <span className="trip-hint">{privateHint}</span>
        <textarea value={privateNotes} onChange={(e) => onPrivateNotes(e.target.value)} rows={2} maxLength={400} />
      </label>
    </>
  );
}

export function AddStopForm({
  dayId: initialDayId,
  days,
  fill,
  busy,
  onAdd,
  onBack,
}: {
  dayId: string | null;
  days: DayOption[];
  fill?: FillPlacement;
  busy: boolean;
  onAdd: (operations: TripChangeOp[]) => void;
  onBack: () => void;
}) {
  const [dayId, setDayId] = useState(initialDayId);
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState("");
  const [url, setUrl] = useState("");
  const [timeWindow, setTimeWindow] = useState("");
  const [duration, setDuration] = useState("");
  const [publicNotes, setPublicNotes] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");

  function submit(state?: "draft") {
    const ops = placeholderStopOps({ dayId, fill, title, notes, url, timeWindow, duration, publicNotes, privateNotes, state });
    if (!ops) return;
    onAdd(ops);
  }

  return (
    <form
      className="trip-add-form"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <button type="button" className="trip-add-back" onClick={onBack}>
        ← Choose another source
      </button>
      <label className="trip-field">
        Stop title
        <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={120} required autoFocus placeholder="e.g. Nishiki Market" />
      </label>
      <label className="trip-field">
        Source notes <span className="trip-hint">stored on this outside-content stop</span>
        <textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} maxLength={400} />
      </label>
      <label className="trip-field">
        Source link <span className="trip-hint">optional, must be a public http(s) link</span>
        <input type="url" value={url} onChange={(e) => setUrl(e.target.value)} maxLength={2000} placeholder="https://…" />
      </label>
      <StopPlacementFields
        days={days}
        dayId={dayId}
        locked={Boolean(fill)}
        onDayId={setDayId}
        timeWindow={timeWindow}
        onTimeWindow={setTimeWindow}
        duration={duration}
        onDuration={setDuration}
        publicNotes={publicNotes}
        onPublicNotes={setPublicNotes}
        privateNotes={privateNotes}
        onPrivateNotes={setPrivateNotes}
        privateHint="never shared or exported"
      />
      <p className="trip-form-actions">
        <button type="button" className="btn" disabled={busy || !title.trim()} onClick={() => submit("draft")}>
          {busy ? "Saving…" : "Save as Draft"}
        </button>
        <button type="submit" className="btn primary" disabled={busy || !title.trim()}>
          {busy ? "Saving…" : "Add stop"}
        </button>
      </p>
    </form>
  );
}

/** A hole is a bounded request at a stable placement. It is trip-owned text:
 * no Library lookup, no agent, and it stays until filled or dismissed. */
export function HoleForm({
  dayId: initialDayId,
  days,
  busy,
  onAdd,
  onBack,
}: {
  dayId: string | null;
  days: DayOption[];
  busy: boolean;
  onAdd: (operations: TripChangeOp[]) => void;
  onBack: () => void;
}) {
  const [dayId, setDayId] = useState(initialDayId);
  const [request, setRequest] = useState("");

  function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    const ops = holeStopOps({ dayId, request });
    if (!ops) return;
    onAdd(ops);
  }

  return (
    <form className="trip-add-form" onSubmit={submit}>
      <button type="button" className="trip-add-back" onClick={onBack}>
        ← Choose another source
      </button>
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
      <DaySelect days={days} dayId={dayId} onChange={setDayId} />
      <p className="trip-place-hint">A hole marks an unresolved need at this exact spot until you fill or dismiss it.</p>
      <p className="trip-form-actions">
        <button type="submit" className="btn primary" disabled={busy || !request.trim()}>
          {busy ? "Saving…" : "Add hole"}
        </button>
      </p>
    </form>
  );
}
