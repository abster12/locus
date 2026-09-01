import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { TripChangeOp, TripDocument, TripStop } from "./api.ts";
import { stopDisplay, stopOpenLabel, stopSourceLink } from "./trips-format.ts";
import { isHomePlacement, moveStopOp, placementAt, stepAnchor, type StopAnchor } from "./trips-stop-ops.ts";
import { StopDetailsDialog } from "./trips-stop-details.tsx";
import { EditStopForm } from "./trips-stop-editor.tsx";

function placementNote(title: string, list: TripStop[], anchor: StopAnchor): string {
  const otherId = "beforeStopId" in anchor ? anchor.beforeStopId : anchor.afterStopId;
  const other = list.find((stop) => stop.id === otherId);
  const otherTitle = other ? stopDisplay(other).title : "stop";
  return "beforeStopId" in anchor ? `${title} before ${otherTitle}` : `${title} after ${otherTitle}`;
}

function StopDragHandle({
  stopId,
  title,
  list,
  busy,
  announce,
  apply,
}: {
  stopId: string;
  title: string;
  list: TripStop[];
  busy: boolean;
  announce: (message: string) => void;
  apply: (operations: TripChangeOp[], note: string) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const drag = useRef<{ pointerId: number; x: number; y: number; moved: boolean; target: StopAnchor | null } | null>(null);
  const moved = useRef(false);
  const [lifted, setLifted] = useState<"pointer" | "keyboard" | null>(null);
  const [line, setLine] = useState<{ top: number; left: number; width: number } | null>(null);
  const [target, setTarget] = useState<StopAnchor | null>(null);

  const mark = (on: boolean) => {
    const listEl = button.current?.closest(".trip-stop-list");
    const row = button.current?.closest(".trip-stop");
    if (on) listEl?.setAttribute("data-reordering", "");
    else listEl?.removeAttribute("data-reordering");
    row?.classList.toggle("trip-stop-dragging", on);
  };

  const finish = (message: string | null) => {
    const session = drag.current;
    if (session && button.current?.hasPointerCapture(session.pointerId)) button.current.releasePointerCapture(session.pointerId);
    drag.current = null;
    mark(false);
    setLifted(null);
    setLine(null);
    setTarget(null);
    if (message != null) announce(message);
  };

  const commit = (next: StopAnchor | null, attempted: boolean) => {
    if (!next || isHomePlacement(list, stopId, next)) {
      finish(attempted ? `${title} stayed in place.` : null);
      return;
    }
    finish("");
    apply([moveStopOp(stopId, next)], `Moved ${title}.`);
  };

  const lineFor = (next: StopAnchor | null) => {
    const listEl = button.current?.closest(".trip-stop-list");
    if (!listEl || !next) return null;
    const id = "beforeStopId" in next ? next.beforeStopId : next.afterStopId;
    const row = listEl.querySelector(`[data-stop-id="${CSS.escape(id)}"]`);
    if (!(row instanceof HTMLElement)) return null;
    const box = row.getBoundingClientRect();
    return { top: "beforeStopId" in next ? box.top : box.bottom, left: box.left, width: box.width };
  };

  useEffect(() => {
    if (!lifted) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      finish(`Cancelled reordering ${title}.`);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [lifted, title]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className="trip-stop-drag"
        aria-label={`Drag ${title} to reorder`}
        aria-describedby="trip-stop-reorder-help"
        aria-pressed={lifted ? true : undefined}
        disabled={busy}
        onClick={(event) => {
          if (moved.current) {
            event.preventDefault();
            event.stopPropagation();
            moved.current = false;
          }
        }}
        onPointerDown={(event) => {
          if (busy || event.button !== 0 || lifted === "keyboard") return;
          event.currentTarget.focus();
          event.preventDefault();
          event.stopPropagation();
          event.currentTarget.setPointerCapture(event.pointerId);
          drag.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, moved: false, target: null };
          moved.current = false;
        }}
        onPointerMove={(event) => {
          const session = drag.current;
          if (!session || event.pointerId !== session.pointerId) return;
          if (!session.moved && Math.hypot(event.clientX - session.x, event.clientY - session.y) < 4) return;
          if (!session.moved) {
            session.moved = true;
            moved.current = true;
            mark(true);
            setLifted("pointer");
            announce(`Lifted ${title}.`);
          }
          const listEl = button.current?.closest(".trip-stop-list");
          const row = button.current?.closest(".trip-stop");
          if (!(listEl instanceof HTMLElement)) return;
          if (row instanceof HTMLElement) row.style.pointerEvents = "none";
          const hit = document.elementFromPoint(event.clientX, event.clientY)?.closest(".trip-stop");
          if (row instanceof HTMLElement) row.style.pointerEvents = "";
          if (!(hit instanceof HTMLElement) || !listEl.contains(hit) || !hit.dataset.stopId) return;
          const box = hit.getBoundingClientRect();
          const half = event.clientY < box.top + box.height / 2 ? "before" : "after";
          const next = placementAt(list, stopId, hit.dataset.stopId, half);
          session.target = next;
          setTarget(next);
          setLine({ top: half === "before" ? box.top : box.bottom, left: box.left, width: box.width });
        }}
        onPointerUp={(event) => {
          const session = drag.current;
          if (!session || event.pointerId !== session.pointerId) return;
          event.preventDefault();
          event.stopPropagation();
          if (!session.moved) {
            finish(null);
            return;
          }
          commit(session.target, true);
        }}
        onPointerCancel={() => finish(drag.current?.moved ? `Cancelled reordering ${title}.` : null)}
        onKeyDown={(event) => {
          if (busy) return;
          if (lifted === "keyboard" && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
            event.preventDefault();
            const next = stepAnchor(list, stopId, target, event.key === "ArrowUp" ? -1 : 1);
            setTarget(next);
            setLine(lineFor(next && !isHomePlacement(list, stopId, next) ? next : null));
            announce(next && !isHomePlacement(list, stopId, next) ? placementNote(title, list, next) : `${title} is in its original place`);
            return;
          }
          if (event.key !== " " && event.key !== "Enter") return;
          event.preventDefault();
          if (!lifted) {
            mark(true);
            setLifted("keyboard");
            setTarget(null);
            announce(`Lifted ${title}. Use arrows to move, Space to drop, Escape to cancel.`);
            return;
          }
          if (lifted === "keyboard") commit(target, true);
        }}
      >
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true">
          <circle cx="9" cy="7" r="1.2" fill="currentColor" />
          <circle cx="15" cy="7" r="1.2" fill="currentColor" />
          <circle cx="9" cy="12" r="1.2" fill="currentColor" />
          <circle cx="15" cy="12" r="1.2" fill="currentColor" />
          <circle cx="9" cy="17" r="1.2" fill="currentColor" />
          <circle cx="15" cy="17" r="1.2" fill="currentColor" />
        </svg>
      </button>
      {line
        ? createPortal(<div className="trip-stop-drop-line" style={{ top: line.top, left: line.left, width: line.width }} />, document.body)
        : null}
    </>
  );
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
  announce,
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
  announce: (message: string) => void;
}) {
  const { title, kindLabel } = stopDisplay(stop);
  const source = stopSourceLink(stop);
  const isHole = stop.content.kind === "hole";
  const isDraft = stop.state === "draft";
  const prev = list[index - 1];
  const next = list[index + 1];
  const [detailsOpen, setDetailsOpen] = useState(false);
  const menu = useRef<HTMLDetailsElement>(null);
  const closeMenu = () => menu.current?.removeAttribute("open");
  const edit = () => {
    closeMenu();
    setDetailsOpen(false);
    onEdit();
  };
  const run = (operations: TripChangeOp[], note: string) => {
    closeMenu();
    apply(operations, note);
  };

  if (editing) return <EditStopForm stop={stop} busy={busy} onClose={onCloseEdit} apply={apply} />;

  return (
    <li className={`trip-stop${isHole ? " trip-stop-hole" : ""}${isDraft ? " trip-stop-draft" : ""}`} data-stop-id={stop.id}>
      <button type="button" className="trip-stop-open" aria-label={stopOpenLabel(stop)} onClick={() => setDetailsOpen(true)} />
      <StopDragHandle stopId={stop.id} title={title} list={list} busy={busy} announce={announce} apply={apply} />
      {stop.timeWindow ? <time className="trip-stop-time">{stop.timeWindow}</time> : <span className="trip-stop-time" />}
      <span className="trip-stop-node" aria-hidden="true" />
      <div className="trip-stop-copy">
        <span className="trip-stop-title">{title}</span>
        <span className="trip-stop-meta">
          {isDraft ? <span className="trip-stop-state trip-stop-state-draft">Draft</span> : null}
          {kindLabel ? <span className={`trip-stop-kind trip-stop-kind-${kindClass(kindLabel)}`}>{kindLabel}</span> : null}
          {stop.durationMinutes ? <span>{stop.durationMinutes} min</span> : null}
        </span>
      </div>
      <span className="trip-stop-cue">{isDraft ? "Review Draft →" : "Open details →"}</span>
      <div className="trip-stop-tools">
        {source ? (
          <a className="trip-stop-source" href={source.href} target="_blank" rel="noopener noreferrer">
            {source.label}
          </a>
        ) : null}
        {isHole ? (
          <>
            <button type="button" className="btn" disabled={busy} onClick={onFill} aria-label={`Fill ${title}`}>
              Fill…
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy}
              aria-label={`Dismiss ${title}`}
              onClick={() => run([{ type: "removeStop", stopId: stop.id }], "Hole dismissed.")}
            >
              Dismiss
            </button>
          </>
        ) : null}
        <details ref={menu} className="trip-stop-menu">
          <summary aria-label={`Actions for ${isDraft ? `Draft ${title}` : title}`}>⋯</summary>
          <div className="trip-stop-menu-list">
            <button type="button" className="btn" disabled={busy} onClick={edit} aria-label={`Edit ${title}`}>
              {isDraft ? "Edit Draft" : "Edit"}
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !prev}
              aria-label={prev ? `Place ${title} before ${stopDisplay(prev).title}` : `Place ${title} before`}
              onClick={() => run([moveStopOp(stop.id, { beforeStopId: prev!.id })], `Moved ${title}.`)}
            >
              Place before
            </button>
            <button
              type="button"
              className="btn"
              disabled={busy || !next}
              aria-label={next ? `Place ${title} after ${stopDisplay(next).title}` : `Place ${title} after`}
              onClick={() => run([moveStopOp(stop.id, { afterStopId: next!.id })], `Moved ${title}.`)}
            >
              Place after
            </button>
            {trip.days.map((day) => (
              <button
                key={day.id}
                type="button"
                className="btn"
                disabled={busy || stop.dayId === day.id}
                aria-label={`Move ${title} to ${day.label}`}
                onClick={() => run([moveStopOp(stop.id, { dayId: day.id })], `Moved ${title} to ${day.label}.`)}
              >
                To {day.label}
              </button>
            ))}
            <button
              type="button"
              className="btn"
              disabled={busy || stop.dayId === null}
              aria-label={`Move ${title} to Unscheduled`}
              onClick={() => run([moveStopOp(stop.id, { dayId: null })], `Moved ${title} to Unscheduled.`)}
            >
              To Unscheduled
            </button>
            {isHole ? null : (
              <button
                type="button"
                className="btn danger"
                disabled={busy}
                aria-label={`Remove ${title}`}
                onClick={() => run([{ type: "removeStop", stopId: stop.id }], `Removed ${title}.`)}
              >
                {isDraft ? "Remove Draft" : "Remove"}
              </button>
            )}
          </div>
        </details>
      </div>
      {detailsOpen ? (
        <StopDetailsDialog stop={stop} busy={busy} onClose={() => setDetailsOpen(false)} onEdit={edit} apply={apply} />
      ) : null}
    </li>
  );
}

function kindClass(kindLabel: string): string {
  return kindLabel === "Missing" ? "missing" : kindLabel.toLowerCase().replace(/\s+/g, "-");
}
