import type { TripAdvisory, TripChangesetView, TripDocument } from "./api.ts";
import { stopDisplay } from "./trips-format.ts";

const ADVISORY_CATEGORY_LABEL = {
  travel_feasibility: "Travel feasibility",
  strain: "Strain",
  missing_information: "Missing information",
} as const;

/** One advisory card for both lists: with onDismiss it renders the active
 * "Agent opinion" variant with the Dismiss control; without it, the read-only
 * dismissed record with the dismissal timestamp. Advisory opinions are
 * agent-authored and clearly separated from the deterministic health numbers:
 * pinned to the revision they reviewed, and marked stale once the document
 * moves on. */
function AdvisoryCard({ trip, advisory, busy, onDismiss }: { trip: TripDocument; advisory: TripAdvisory; busy?: boolean; onDismiss?: (advisoryId: string) => void }) {
  const dismissed = !onDismiss;
  const stale = trip.revision > advisory.reviewedRevision;
  const dayLabels = new Map(trip.days.map((day) => [day.id, day.label]));
  const allStops = [...trip.days.flatMap((day) => day.stops), ...trip.unscheduled];
  const stopTitles = new Map(allStops.map((stop) => [stop.id, stopDisplay(stop).title]));
  return (
    <article className="trip-advisory">
      <div className="trip-advisory-head">
        <span className="trip-advisory-mark">{dismissed ? "Dismissed agent opinion" : "Agent opinion"}</span>
        <span className="trip-advisory-meta">
          {ADVISORY_CATEGORY_LABEL[advisory.category]} · {advisory.severity}
        </span>
        {stale ? (
          <span className="trip-advisory-stale">Based on revision {advisory.reviewedRevision} — the trip has changed since</span>
        ) : (
          <span className="trip-advisory-meta">reviewed revision {advisory.reviewedRevision}</span>
        )}
      </div>
      <p className="trip-advisory-opinion">{advisory.opinion}</p>
      <p className="trip-advisory-rationale">{advisory.rationale}</p>
      {advisory.dayRefs.length > 0 ? (
        <p className="trip-advisory-meta">
          Days: {advisory.dayRefs.map((id) => dayLabels.get(id) ?? "removed day").join(", ")}
        </p>
      ) : null}
      {advisory.stopRefs.length > 0 ? (
        <p className="trip-advisory-meta">
          Stops: {advisory.stopRefs.map((id) => stopTitles.get(id) ?? "removed stop").join(", ")}
        </p>
      ) : null}
      <div className="trip-advisory-foot">
        <span className="trip-advisory-meta">
          Saved {new Date(advisory.createdAt).toLocaleString()} · actor {advisory.actor}
          {dismissed ? ` · dismissed ${new Date(advisory.dismissedAt!).toLocaleString()}` : ""}
        </span>
        {onDismiss ? (
          <button type="button" className="btn" disabled={busy} onClick={() => onDismiss(advisory.id)}>
            Dismiss
          </button>
        ) : null}
      </div>
    </article>
  );
}

/** Advisory opinions are agent-authored and clearly separated from the
 * deterministic health numbers: labelled Agent opinion, pinned to the
 * revision they reviewed, and marked stale once the document moves on. */
export function TripAdvisories({ trip, busy, onDismiss }: { trip: TripDocument; busy: boolean; onDismiss: (advisoryId: string) => void }) {
  if (trip.advisories.length === 0) return null;
  return (
    <section className="trip-advisories" aria-label="Agent opinions">
      {trip.advisories.map((advisory) => (
        <AdvisoryCard key={advisory.id} trip={trip} advisory={advisory} busy={busy} onDismiss={onDismiss} />
      ))}
    </section>
  );
}

/** Changeset history under the Day Planner: read-only context that loads only
 * when opened; mutate() refreshes it while it stays open. Dismissed agent
 * opinions stay here as a read-only record — dismissal is not reversible, so
 * they carry no Dismiss control and never rejoin the active list. */
export function TripHistory({
  history,
  trip,
  onToggle,
  redo,
  canRedo,
  busy,
}: {
  history: { changesets: TripChangesetView[]; canUndo: boolean; canRedo: boolean; dismissedAdvisories: TripAdvisory[] } | null;
  trip: TripDocument;
  onToggle: (open: boolean) => void;
  redo: () => void;
  canRedo: boolean;
  busy: boolean;
}) {
  const dismissed = history?.dismissedAdvisories ?? [];
  return (
    <details
      className="trip-history"
      onToggle={(event) => onToggle((event.target as HTMLDetailsElement).open)}
    >
      <summary>Activity and recovery</summary>
      <p className="trip-history-tools">
        <button type="button" className="btn trip-redo" disabled={busy || !canRedo} onClick={redo}>
          Redo
        </button>
      </p>
      {dismissed.length > 0 ? (
        <section className="trip-advisories" aria-label="Dismissed agent opinions">
          {dismissed.map((advisory) => (
            <AdvisoryCard key={advisory.id} trip={trip} advisory={advisory} />
          ))}
        </section>
      ) : null}
      {history && history.changesets.length === 0 && dismissed.length === 0 ? <p className="trip-stop-empty">No changes yet.</p> : null}
      {history && history.changesets.length > 0 ? (
        <ul className="trip-history-list">
          {history.changesets.map((changeset) => (
            <li key={changeset.id} className={changeset.undoneAt ? "trip-history-undone" : undefined}>
              <span className="trip-history-meta">
                {changeset.kind === "undo" ? "Undo" : changeset.kind === "redo" ? "Redo" : "Change"} · {changeset.actor} ·{" "}
                {new Date(changeset.createdAt).toLocaleString()} · revision {changeset.baseRevision} → {changeset.resultRevision}
              </span>
              {changeset.instruction ? <span className="trip-history-instruction">“{changeset.instruction}”</span> : null}
              <span className="trip-history-summary">{changeset.summary}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </details>
  );
}