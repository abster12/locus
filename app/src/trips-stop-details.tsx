import { useLayoutEffect, useRef } from "react";
import type { TripChangeOp, TripStop } from "./api.ts";
import { stopDisplay, stopFacts } from "./trips-format.ts";

/** Modal details for one stop. Native dialog traps focus, restores it, and
 * Escape closes without writing. Draft review actions live here. */
export function StopDetailsDialog({
  stop,
  busy,
  onClose,
  onEdit,
  apply,
}: {
  stop: TripStop;
  busy: boolean;
  onClose: () => void;
  onEdit: () => void;
  apply: (operations: TripChangeOp[], note: string) => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const { title, kindLabel } = stopDisplay(stop);
  const isDraft = stop.state === "draft";
  const facts = stopFacts(stop);

  useLayoutEffect(() => {
    const el = dialog.current;
    if (!el) return;
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (!el.open) el.showModal();
    titleRef.current?.focus();
    return () => {
      if (el.open) el.close();
      previouslyFocused?.focus();
    };
  }, []);

  return (
    <dialog
      ref={dialog}
      className="trip-add-dialog trip-stop-dialog"
      aria-labelledby="trip-stop-detail-title"
      aria-busy={busy || undefined}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onClose();
      }}
    >
      <div className="trip-add-head">
        <div>
          <p className="trip-stop-kicker">
            {kindLabel}
            {isDraft ? " · Draft" : <span className="visually-hidden"> · Confirmed</span>}
          </p>
          <h2 id="trip-stop-detail-title" ref={titleRef} tabIndex={-1}>
            {title}
          </h2>
        </div>
        <button type="button" className="btn trip-add-close" aria-label="Close stop details" disabled={busy} onClick={onClose}>
          ×
        </button>
      </div>
      <dl className="trip-stop-facts">
        {facts.map((fact) => (
          <div key={fact.label}>
            <dt>{fact.label}</dt>
            <dd>
              {fact.href ? (
                <a href={fact.href} target="_blank" rel="noopener noreferrer">
                  {fact.text}
                </a>
              ) : (
                fact.text
              )}
            </dd>
          </div>
        ))}
      </dl>
      {isDraft ? (
        <div className="trip-form-actions">
          <button
            type="button"
            className="btn primary"
            disabled={busy}
            aria-label={`Keep ${title}`}
            onClick={() => {
              apply([{ type: "updateStop", stopId: stop.id, state: "confirmed" }], `Kept ${title}.`);
              onClose();
            }}
          >
            Keep stop
          </button>
          <button type="button" className="btn" disabled={busy} aria-label={`Edit ${title}`} onClick={onEdit}>
            Edit Draft
          </button>
          <button
            type="button"
            className="btn danger"
            disabled={busy}
            aria-label={`Remove ${title}`}
            onClick={() => {
              apply([{ type: "removeStop", stopId: stop.id }], `Removed ${title}.`);
              onClose();
            }}
          >
            Remove Draft
          </button>
        </div>
      ) : null}
    </dialog>
  );
}
