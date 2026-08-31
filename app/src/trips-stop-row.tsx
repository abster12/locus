import type { TripChangeOp, TripDocument, TripStop } from "./api.ts";
import { stopDisplay } from "./trips-format.ts";
import { EditStopForm } from "./trips-stop-editor.tsx";

const STOP_STATE_LABEL = { confirmed: "Confirmed", draft: "Draft" } as const;

/** One moveStop op for the row's up/down/to-day/to-Unscheduled controls. */
export function moveStopOp(stopId: string, target: { dayId?: string | null; beforeStopId?: string; afterStopId?: string }): TripChangeOp {
  return { type: "moveStop", stopId, ...target };
}

export function StopRow({
  stop,
  trip,
  list,
  index,
  busy,
  editing,
  onEdit,
  onCloseEdit,
  onFill,
  apply,
}: {
  stop: TripStop;
  trip: TripDocument;
  list: TripStop[];
  index: number;
  busy: boolean;
  editing: boolean;
  onEdit: () => void;
  onCloseEdit: () => void;
  onFill: () => void;
  apply: (operations: TripChangeOp[], note: string) => void;
}) {
  const { title, kindLabel } = stopDisplay(stop);
  const isHole = stop.content.kind === "hole";
  if (editing) return <EditStopForm stop={stop} busy={busy} onClose={onCloseEdit} apply={apply} />;
  return (
    <li className={`trip-stop${isHole ? " trip-stop-hole" : ""}`}>
      <span className={`trip-stop-state trip-stop-state-${stop.state}`}>{STOP_STATE_LABEL[stop.state]}</span>
      {kindLabel ? <span className={`trip-stop-kind trip-stop-kind-${kindLabel === "Missing" ? "missing" : kindLabel.toLowerCase().replace(/\s+/g, "-")}`}>{kindLabel}</span> : null}
      <span className="trip-stop-main">
        <span className="trip-stop-title">{title}</span>
        <span className="trip-stop-meta">
          {stop.timeWindow ? <span>{stop.timeWindow}</span> : null}
          {stop.durationMinutes ? <span>{stop.durationMinutes} min</span> : null}
        </span>
      </span>
      <details className="trip-stop-more">
        <summary aria-label={`Details for ${title}`}>Details</summary>
        <dl className="trip-stop-facts">
          {stop.content.kind === "item" && stop.resolved?.kind === "item" ? (
            <>
              {stop.resolved.source ? (
                <div>
                  <dt>Source</dt>
                  <dd>{stop.resolved.source}</dd>
                </div>
              ) : null}
              <div>
                <dt>Original</dt>
                <dd>
                  {stop.resolved.url ? (
                    <a href={stop.resolved.url} target="_blank" rel="noopener noreferrer">
                      Open original ↗
                    </a>
                  ) : (
                    "link unavailable"
                  )}
                </dd>
              </div>
            </>
          ) : null}
          {stop.content.kind === "place" && stop.resolved?.kind === "place" ? (
            <>
              <div>
                <dt>Kind</dt>
                <dd>{stop.resolved.kindLabel}</dd>
              </div>
              {stop.resolved.location ? (
                <div>
                  <dt>Location</dt>
                  <dd>{stop.resolved.location}</dd>
                </div>
              ) : null}
            </>
          ) : null}
          {stop.content.kind === "outside" ? (
            <>
              {stop.content.notes ? (
                <div>
                  <dt>Notes</dt>
                  <dd>{stop.content.notes}</dd>
                </div>
              ) : null}
              {stop.content.url ? (
                <div>
                  <dt>Source link</dt>
                  <dd>
                    <a href={stop.content.url} target="_blank" rel="noopener noreferrer">
                      Open link ↗
                    </a>
                  </dd>
                </div>
              ) : null}
            </>
          ) : null}
          {stop.publicNotes ? (
            <div>
              <dt>Public notes</dt>
              <dd>{stop.publicNotes}</dd>
            </div>
          ) : null}
          {stop.privateNotes ? (
            <div>
              <dt>Private notes</dt>
              <dd>{stop.privateNotes}</dd>
            </div>
          ) : null}
          {stop.resolved?.kind === "place" && stop.resolved.location ? (
            <div>
              <dt>Address</dt>
              <dd>{stop.resolved.location}</dd>
            </div>
          ) : null}
          {stop.reservation ? (
            <div>
              <dt>Reservation</dt>
              <dd>{stop.reservation}</dd>
            </div>
          ) : null}
          {stop.storedFacts.length > 0 ? (
            <div>
              <dt>Stored facts</dt>
              <dd>{stop.storedFacts.join(" · ")}</dd>
            </div>
          ) : null}
          {stop.alternatives.length > 0 ? (
            <div>
              <dt>Alternatives</dt>
              <dd>{stop.alternatives.join(" · ")}</dd>
            </div>
          ) : null}
          <div>
            <dt>Added</dt>
            <dd>
              by {stop.provenance.actor === "user" ? "you" : stop.provenance.actor} · {new Date(stop.createdAt).toLocaleDateString()}
            </dd>
          </div>
        </dl>
      </details>
      <button
        type="button"
        className="btn"
        disabled={busy || index === 0}
        aria-label={`Move ${title} up`}
        onClick={() => apply([moveStopOp(stop.id, { beforeStopId: list[index - 1]!.id })], `Moved ${title} up.`)}
      >
        ↑
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy || index === list.length - 1}
        aria-label={`Move ${title} down`}
        onClick={() => apply([moveStopOp(stop.id, { afterStopId: list[index + 1]!.id })], `Moved ${title} down.`)}
      >
        ↓
      </button>
      <details className="trip-stop-move">
        <summary aria-label={`Move ${title} to another day`}>Move…</summary>
        <div className="trip-stop-move-menu">
          {trip.days.map((day) => (
            <button
              key={day.id}
              type="button"
              className="btn"
              disabled={busy || stop.dayId === day.id}
              aria-label={`Move ${title} to ${day.label}`}
              onClick={() => apply([moveStopOp(stop.id, { dayId: day.id })], `Moved ${title} to ${day.label}.`)}
            >
              To {day.label}
            </button>
          ))}
          <button
            type="button"
            className="btn"
            disabled={busy || stop.dayId === null}
            aria-label={`Move ${title} to Unscheduled`}
            onClick={() => apply([moveStopOp(stop.id, { dayId: null })], `Moved ${title} to Unscheduled.`)}
          >
            To Unscheduled
          </button>
        </div>
      </details>
      {stop.state === "draft" ? (
        <button
          type="button"
          className="btn"
          disabled={busy}
          aria-label={`Keep ${title}`}
          onClick={() => apply([{ type: "updateStop", stopId: stop.id, state: "confirmed" }], `Kept ${title}.`)}
        >
          Keep
        </button>
      ) : null}
      {isHole ? (
        <button type="button" className="btn" disabled={busy} onClick={onFill} aria-label={`Fill ${title}`}>
          Fill…
        </button>
      ) : null}
      <button type="button" className="btn" disabled={busy} onClick={onEdit} aria-label={`Edit ${title}`}>
        Edit
      </button>
      <button
        type="button"
        className="btn"
        disabled={busy}
        aria-label={isHole ? `Dismiss ${title}` : `Remove ${title}`}
        onClick={() => apply([{ type: "removeStop", stopId: stop.id }], isHole ? "Hole dismissed." : `Removed ${title}.`)}
      >
        {isHole ? "Dismiss" : "Remove"}
      </button>
    </li>
  );
}
