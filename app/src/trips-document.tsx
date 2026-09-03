import { useEffect, useRef, useState } from "react";
import { api, type TripDocument } from "./api.ts";
import { formatDate, weekdayDay } from "./trips-format.ts";
import { TripSetupForm } from "./trips-index.tsx";
import { OverviewView } from "./trips-overview.tsx";
import { ScheduleView } from "./trips-schedule.tsx";
import { DayPlanner } from "./trips-stops.tsx";
import { AddStopDialog } from "./trips-add-stop.tsx";
import type { OpenAdd } from "./trips-stop-ops.ts";
import { TripAdvisories } from "./trips-advisories.tsx";
import { ExportControl, ShareButton, SharePreviewPanel, ShareStatus, useTripShare } from "./trips-share.tsx";
import { parseRecommendations, RecommendationDrawer, type TripRecommendations } from "./trips-recommendations.tsx";
import { PageAgentBanner } from "./page-agent-banner.tsx";

export type TripViewKind = { view: "overview" | "schedule" | "day"; dayId: string | null };

/** The hash query picks the projection; unknown or stale view values fall back
 * to Overview, never to a broken screen. */
export function resolveTripView(trip: TripDocument | null, view: string): TripViewKind {
  if (trip && view !== "overview" && view !== "schedule" && trip.days.some((day) => day.id === view)) {
    return { view: "day", dayId: view };
  }
  return { view: view === "schedule" ? "schedule" : "overview", dayId: null };
}

function TripNav({ trip, active }: { trip: TripDocument; active: TripViewKind }) {
  const base = `#/trips/${trip.id}`;
  const current = (isCurrent: boolean) => (isCurrent ? "true" : undefined);
  return (
    <nav className="trip-nav" aria-label="Trip Document views">
      <a className={`trip-nav-tab${active.view === "overview" ? " active" : ""}`} href={`${base}?view=overview`} aria-current={current(active.view === "overview")}>
        Overview
      </a>
      {trip.days.map((day) => {
        const isCurrent = active.view === "day" && active.dayId === day.id;
        return (
          <a
            key={day.id}
            className={`trip-nav-tab${isCurrent ? " active" : ""}`}
            href={`${base}?view=${day.id}`}
            aria-current={current(isCurrent)}
          >
            {day.label}
            {day.date ? <span className="trip-nav-date"> · {weekdayDay(day.date)}</span> : null}
          </a>
        );
      })}
      <a className={`trip-nav-tab${active.view === "schedule" ? " active" : ""}`} href={`${base}?view=schedule`} aria-current={current(active.view === "schedule")}>
        Schedule
      </a>
    </nav>
  );
}

function RenameControl({ trip, onRenamed }: { trip: TripDocument; onRenamed: (trip: TripDocument) => void }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  if (!open) {
    return (
      <button
        type="button"
        className="btn"
        onClick={() => {
          setTitle(trip.title);
          setErr(null);
          setOpen(true);
        }}
      >
        Rename
      </button>
    );
  }

  async function save() {
    if (busy) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await api.renameTrip(trip.id, title.trim(), trip.revision);
      onRenamed(result.trip);
      setOpen(false);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <span className="trip-rename">
      <label className="visually-hidden" htmlFor="trip-rename-title">
        Trip title
      </label>
      <input
        id="trip-rename-title"
        value={title}
        maxLength={120}
        autoFocus
        onChange={(e) => setTitle(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") void save();
        }}
      />
      <button type="button" className="btn primary" disabled={busy} onClick={() => void save()}>
        {busy ? "Saving…" : "Save"}
      </button>
      <button type="button" className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {err ? (
        <span className="bad" role="alert">
          {err}
        </span>
      ) : null}
    </span>
  );
}

function TripDocumentMenu({
  trip,
  busy,
  run,
  setTrip,
  setEditing,
  reviewRequested,
  onRequestReview,
  share,
}: {
  trip: TripDocument;
  busy: boolean;
  run: (action: () => Promise<void>) => void;
  setTrip: (trip: TripDocument) => void;
  setEditing: (open: boolean) => void;
  reviewRequested: boolean;
  onRequestReview: (tripId: string) => void;
  share: ReturnType<typeof useTripShare>;
}) {
  return (
    <details className="trip-doc-menu">
      <summary aria-label="Trip Document menu">⋯</summary>
      <div className="trip-doc-menu-list">
        <button type="button" className="btn" disabled={busy} onClick={() => setEditing(true)}>
          Edit setup
        </button>
        <RenameControl trip={trip} onRenamed={setTrip} />
        {reviewRequested ? (
          <span className="trip-review-armed" role="status">
            Your browser agent can now save an advisory review of this Trip Document.
          </span>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const id = trip.id;
                await api.armTripReview(id, trip.revision);
                onRequestReview(id);
              })
            }
          >
            Ask agent to review
          </button>
        )}
        <button
          type="button"
          className="btn"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await api.duplicateTrip(trip.id, trip.revision);
              location.hash = `#/trips/${result.trip.id}`;
            })
          }
        >
          Duplicate
        </button>
        {trip.archivedAt ? (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await api.restoreTrip(trip.id, trip.revision);
                setTrip(result.trip);
              })
            }
          >
            Restore
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                await api.archiveTrip(trip.id, trip.revision);
                location.hash = "#/trips";
              })
            }
          >
            Archive
          </button>
        )}
        <details className="trip-doc-export">
          <summary>Export</summary>
          <ExportControl trip={trip} />
        </details>
        {share.shared ? (
          <>
            <button
              type="button"
              className="btn"
              disabled={share.busy}
              onClick={(event) => {
                event.currentTarget.closest("details.trip-doc-menu")?.removeAttribute("open");
                void share.preview();
              }}
            >
              Update shared version
            </button>
            <button type="button" className="btn danger" disabled={share.busy} onClick={() => void share.revoke()}>
              Revoke
            </button>
          </>
        ) : null}
        <button
          type="button"
          className="btn danger"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              if (!window.confirm("Delete this Trip Document? Its days are removed. Saved Items and Places stay in your Library.")) return;
              await api.deleteTrip(trip.id, trip.revision);
              location.hash = "#/trips";
            })
          }
        >
          Delete
        </button>
      </div>
    </details>
  );
}

function TripContextSection({ trip }: { trip: TripDocument }) {
  const entries: [string, string[]][] = [
    ["Lodging anchors", trip.context.lodgingAnchors],
    ["Pace", trip.context.pace ? [trip.context.pace] : []],
    ["Mobility", trip.context.mobility ? [trip.context.mobility] : []],
    ["Budget", trip.context.budget ? [trip.context.budget] : []],
    ["Meal preferences", trip.context.mealPreferences],
    ["Interests", trip.context.interests],
    ["Must-dos", trip.context.mustDos],
    ["Hard constraints", trip.context.hardConstraints],
  ];
  const filled = entries.filter(([, values]) => values.length > 0);
  if (filled.length === 0) return null;
  return (
    <section aria-label="User-entered context">
      <h2 className="trip-context-heading">User-entered context</h2>
      <dl className="trip-facts">
        {filled.map(([label, values]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd>{values.join(" · ")}</dd>
          </div>
        ))}
      </dl>
    </section>
  );
}

/** Agent preference inferences (ticket 10): visibly labelled as agent
 * inferences — never inside "User-entered context" — each linked to its
 * Library basis and removable by the human. */
function TripInferences({ trip, busy, onRemove }: { trip: TripDocument; busy: boolean; onRemove: (inferenceId: string) => void }) {
  if (trip.inferences.length === 0) return null;
  return (
    <section className="trip-inferences" aria-label="Inferred by agent">
      <h2 className="trip-context-heading">Inferred by agent</h2>
      <p className="trip-inferences-note">Saved as agent inferences from your build request — these are not your saved context.</p>
      <ul className="trip-inference-list">
        {trip.inferences.map((inference) => (
          <li key={inference.id} className="trip-inference">
            <span className="trip-stop-kind">Inferred</span>
            <span className="trip-inference-main">
              <span className="trip-inference-text">{inference.text}</span>
              <span className="trip-inference-basis">Basis: {inference.basis}</span>
            </span>
            <button type="button" className="btn" disabled={busy} onClick={() => onRemove(inference.id)}>
              Remove
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

export function TripDocumentPage({
  tripId,
  view,
  reviewRequested,
  onRequestReview,
  webmcpReady = false,
}: {
  tripId: string;
  view: string;
  reviewRequested: boolean;
  onRequestReview: (tripId: string) => void;
  webmcpReady?: boolean;
}) {
  const [trip, setTrip] = useState<TripDocument | null>(null);
  const [missing, setMissing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [recs, setRecs] = useState<TripRecommendations | null>(null);
  const [presented, setPresented] = useState<TripRecommendations | null>(null);
  const [openAdd, setOpenAdd] = useState<OpenAdd>(null);
  const share = useTripShare(trip);

  // Recommendation presentation is transient page state (like Reading): the
  // sheet shows what was presented, dismissal keeps the document untouched,
  // and nothing here ever calls an agent by itself.
  useEffect(() => {
    const onPanel = (event: Event) => {
      const panel = parseRecommendations((event as CustomEvent).detail);
      if (!panel) return;
      if (panel.tripId && panel.tripId !== tripId) return;
      setPresented(panel);
      setRecs(panel);
    };
    window.addEventListener("locus:trip-recommendations", onPanel);
    return () => window.removeEventListener("locus:trip-recommendations", onPanel);
  }, [tripId]);

  // Agent-applied changesets (Trips WebMCP) arrive through this event so the
  // visible document updates in the same tick a human edit would.
  useEffect(() => {
    const onUpdated = (event: Event) => {
      const next = (event as CustomEvent).detail as TripDocument | undefined;
      if (next && next.id === tripId) setTrip(next);
    };
    window.addEventListener("locus:trip-updated", onUpdated);
    return () => window.removeEventListener("locus:trip-updated", onUpdated);
  }, [tripId]);

  useEffect(() => {
    setOpenAdd(null);
  }, [tripId]);

  useEffect(() => {
    let alive = true;
    setMissing(false);
    setEditing(false);
    api
      .trip(tripId)
      .then((result) => {
        if (alive) setTrip(result.trip);
      })
      .catch((e: unknown) => {
        if (!alive) return;
        const status = (e as { status?: number }).status;
        if (status === 404) setMissing(true);
        else setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, [tripId]);

  async function run(action: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setErr(null);
    try {
      await action();
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  function dismissAdvisory(doc: TripDocument, advisoryId: string) {
    void run(async () => {
      const result = await api.dismissTripAdvisory(doc.id, advisoryId, doc.revision);
      setTrip(result.trip);
    });
  }

  if (missing) {
    return (
      <section className="trips" aria-label="Trip Document">
        <div className="trips-pagehead">
          <div className="pagehead">
            <h1>Trip Document</h1>
          </div>
          <p className="empty">This Trip Document is not available.</p>
          <p className="trips-tools">
            <a className="btn" href="#/trips">
              Back to Trips
            </a>
          </p>
        </div>
      </section>
    );
  }

  return (
    <section className="trips" aria-label="Trip Document">
      <div className="trips-pagehead">
        <div className="pagehead">
          <h1>{trip?.title ?? "Trip Document"}</h1>
          {trip ? <span className="count">revision {trip.revision}</span> : null}
          {trip?.archivedAt ? <span className="chip">Archived</span> : null}
          {trip && !editing ? (
            <div className="trip-doc-actions">
              <ShareButton share={share} />
              <TripDocumentMenu
                trip={trip}
                busy={busy}
                run={run}
                setTrip={setTrip}
                setEditing={setEditing}
                reviewRequested={reviewRequested}
                onRequestReview={onRequestReview}
                share={share}
              />
            </div>
          ) : null}
        </div>
        <p className="pagesub">
          <a href="#/trips">Back to Trips</a>
        </p>
        {webmcpReady ? <PageAgentBanner surface="trip" /> : null}
      </div>
      {err ? (
        <p className="bad" role="alert">
          {err}
        </p>
      ) : null}
      {trip && editing ? (
        <div className="trips-main">
          <TripSetupForm
            existing={trip}
            onDone={(updated) => {
              setTrip(updated);
              setEditing(false);
            }}
          />
        </div>
      ) : null}
      {trip && !editing ? (
        <div className="trip-detail">
          {share.panel ? <SharePreviewPanel share={share} /> : null}
          <ShareStatus share={share} />
          <dl className="trip-facts">
            <div>
              <dt>Destination</dt>
              <dd>{trip.destination}</dd>
            </div>
            <div>
              <dt>Dates</dt>
              <dd>{trip.startDate && trip.endDate ? `${formatDate(trip.startDate)} – ${formatDate(trip.endDate)}` : `${trip.durationDays} days · dates open`}</dd>
            </div>
            {trip.timezone ? (
              <div>
                <dt>Timezone</dt>
                <dd>{trip.timezone}</dd>
              </div>
            ) : null}
            {trip.travelers ? (
              <div>
                <dt>Travelers</dt>
                <dd>{trip.travelers}</dd>
              </div>
            ) : null}
          </dl>
          <TripNav trip={trip} active={resolveTripView(trip, view)} />
          {resolveTripView(trip, view).view === "overview" ? (
            <OverviewView trip={trip} onAddFirstStop={() => setOpenAdd({ dayId: trip.days[0]?.id ?? null, source: null })} />
          ) : null}
          {resolveTripView(trip, view).view === "schedule" ? <ScheduleView trip={trip} /> : null}
          {resolveTripView(trip, view).view === "day" ? (
            <DayPlanner
              trip={trip}
              onTrip={setTrip}
              focusDayId={resolveTripView(trip, view).dayId}
              presentedRecs={presented}
              onOpenRecs={() => setRecs(presented)}
              openAdd={openAdd}
              setOpenAdd={setOpenAdd}
            />
          ) : null}
          <TripAdvisories trip={trip} busy={busy} onDismiss={(advisoryId) => dismissAdvisory(trip, advisoryId)} />
          <TripContextSection trip={trip} />
          <TripInferences
            trip={trip}
            busy={busy}
            onRemove={(inferenceId) =>
              void run(async () => {
                const result = await api.removeTripInference(trip.id, inferenceId, trip.revision);
                setTrip(result.trip);
              })
            }
          />
        </div>
      ) : null}
      {!trip && !missing && !err ? <p className="quiet">Opening the Trip Document…</p> : null}
      {recs && trip ? <RecommendationDrawer recs={recs} trip={trip} onTrip={setTrip} onClose={() => setRecs(null)} /> : null}
      {openAdd && trip ? (
        <AddStopDialog trip={trip} openAdd={openAdd} onOpenAdd={setOpenAdd} onClose={() => setOpenAdd(null)} onTrip={setTrip} />
      ) : null}
    </section>
  );
}
