import { useEffect, useRef, useState } from "react";
import { api, type TripChangeOp, type TripDocument } from "./api.ts";

export type TripRecommendationOption = {
  opinion: string;
  fit: string;
  tradeoff: string;
  basis: string;
  effect: string;
  operations: unknown[];
};

export type TripRecommendations = { tripId?: string; request: string; options: TripRecommendationOption[] };

const REC_TEXT_MAX = 280;

function recText(value: unknown): string {
  return typeof value === "string" ? value.trim().slice(0, REC_TEXT_MAX) : "";
}

/** The presentation contract delivers exactly three bounded options as
 * transient page state. Anything malformed is ignored, and no option touches
 * the Trip Document until the human chooses it — the operations are validated
 * by the module when a selection is applied. */
export function parseRecommendations(detail: unknown): TripRecommendations | null {
  if (!detail || typeof detail !== "object") return null;
  const rec = detail as Record<string, unknown>;
  if (!Array.isArray(rec.options) || rec.options.length !== 3) return null;
  const options: TripRecommendationOption[] = [];
  for (const entry of rec.options) {
    if (!entry || typeof entry !== "object") return null;
    const opt = entry as Record<string, unknown>;
    if (!Array.isArray(opt.operations)) return null;
    options.push({
      opinion: recText(opt.opinion),
      fit: recText(opt.fit),
      tradeoff: recText(opt.tradeoff),
      basis: recText(opt.basis),
      effect: recText(opt.effect),
      operations: opt.operations,
    });
  }
  return {
    tripId: typeof rec.tripId === "string" ? rec.tripId : undefined,
    request: recText(rec.request),
    options,
  };
}

export function optionTitle(option: TripRecommendationOption): string {
  for (const op of option.operations) {
    if (!op || typeof op !== "object") continue;
    const record = op as Record<string, unknown>;
    if (record.type !== "addStop" || !record.content || typeof record.content !== "object") continue;
    const content = record.content as Record<string, unknown>;
    if (typeof content.title === "string" && content.title.trim()) return content.title.trim();
    if (typeof content.request === "string" && content.request.trim()) return content.request.trim();
  }
  return option.opinion || "Option";
}

export function optionPlacement(option: TripRecommendationOption, trip: TripDocument): string | null {
  for (const op of option.operations) {
    if (!op || typeof op !== "object") continue;
    const record = op as Record<string, unknown>;
    if (record.type !== "addStop") continue;
    if (record.dayId === null) return "Unscheduled";
    if (typeof record.dayId === "string") {
      const day = trip.days.find((candidate) => candidate.id === record.dayId);
      return day ? day.label : null;
    }
  }
  return null;
}

/** Temporary drawer for presented recommendations: desktop side drawer, mobile
 * bottom sheet. Selection applies one human changeset; dismissal changes
 * nothing. Focus is trapped and restored like the Reading recommendations. */
export function RecommendationDrawer({
  recs,
  trip,
  onTrip,
  onClose,
}: {
  recs: TripRecommendations;
  trip: TripDocument;
  onTrip: (trip: TripDocument) => void;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLElement | null>(null);
  const dismiss = useRef<HTMLButtonElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const previousOverflow = document.body.style.overflow;
    const focusFrame = window.requestAnimationFrame(() => dismiss.current?.focus());
    document.body.style.overflow = "hidden";

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("a[href], button:not([disabled])")];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) return;
      if (event.shiftKey && (document.activeElement === first || !dialog.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
      previouslyFocused?.focus();
    };
    // The trap lives and dies with this mount; onClose identity is stable per open.
  }, []);

  const [placeOn, setPlaceOn] = useState<string>("proposed");
  // One mutation id per logical choose: held across a failed attempt so a
  // retry of the same option/placement/revision replays the server receipt
  // instead of failing as a new mutation at a stale revision.
  const pendingMut = useRef<{ id: string; fingerprint: string } | null>(null);
  async function choose(option: TripRecommendationOption) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      // One human changeset, rechecked against the current revision. A stale
      // selection fails safely: 409 leaves the latest itinerary untouched.
      const operations = (option.operations as TripChangeOp[]).map((op) => {
        if (placeOn === "proposed" || op.type !== "addStop") return op;
        return { ...op, dayId: placeOn === "unscheduled" ? null : placeOn };
      });
      // Fresh id only for a new logical choose (first attempt or changed
      // payload); an identical retry keeps the id the server already saw.
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

  return (
    <div
      className="trip-recs-layer"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section ref={dialog} className="trip-recs" role="dialog" aria-modal="true" aria-labelledby="trip-recs-title">
        <div className="trip-recs-head">
          <div>
            <p className="trip-recs-kicker">Browser agent · opinion only</p>
            <h2 id="trip-recs-title">Three options</h2>
          </div>
          <button ref={dismiss} type="button" className="trip-recs-dismiss" aria-label="Dismiss recommendations" onClick={onClose}>
            <span aria-hidden="true">×</span>
          </button>
        </div>
        <p className="trip-recs-sub">
          {recs.request ? `For “${recs.request}” — ` : ""}
          nothing changes in your trip until you choose one. Options are opinions, not saved facts, and outside ideas never become Items.
        </p>
        <label className="trip-field">
          Place on
          <select value={placeOn} onChange={(event) => setPlaceOn(event.target.value)}>
            <option value="proposed">Proposed placement</option>
            {trip.days.map((day) => (
              <option key={day.id} value={day.id}>
                {day.label}{day.theme ? ` · ${day.theme}` : ""}
              </option>
            ))}
            <option value="unscheduled">Unscheduled</option>
          </select>
        </label>
        {err ? (
          <p className="bad" role="alert">
            {err}
          </p>
        ) : null}
        <ul className="trip-rec-list">
          {recs.options.map((option, index) => {
            const placement = optionPlacement(option, trip);
            return (
              <li key={index} className="trip-rec">
                <p className="trip-rec-kicker">
                  Option {index + 1} · {option.opinion}
                </p>
                <h3 className="trip-rec-title">{optionTitle(option)}</h3>
                <dl className="trip-rec-facts">
                  <div>
                    <dt>Why it fits</dt>
                    <dd>{option.fit}</dd>
                  </div>
                  <div>
                    <dt>Tradeoff</dt>
                    <dd>{option.tradeoff}</dd>
                  </div>
                  <div>
                    <dt>Basis</dt>
                    <dd>{option.basis}</dd>
                  </div>
                  {placement ? (
                    <div>
                      <dt>Proposed placement</dt>
                      <dd>{placement}</dd>
                    </div>
                  ) : null}
                  <div>
                    <dt>Likely effect</dt>
                    <dd>{option.effect}</dd>
                  </div>
                </dl>
                <button type="button" className="btn primary" disabled={busy} onClick={() => void choose(option)}>
                  Choose this option
                </button>
              </li>
            );
          })}
        </ul>
      </section>
    </div>
  );
}
