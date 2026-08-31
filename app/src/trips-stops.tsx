import { useEffect, useState } from "react";
import { api, type TripAdvisory, type TripChangesetView, type TripDocument, type TripStop } from "./api.ts";
import { useTripPlannerMutations } from "./trips-planner-mutate.ts";
import { DaySection, UnscheduledSection, type OpenAdd } from "./trips-day-section.tsx";
import type { TripRecommendations } from "./trips-recommendations.tsx";
import { TripHistory } from "./trips-advisories.tsx";

// ---------- Day Planner (ticket 04) ----------

export function DayPlanner({
  trip,
  onTrip,
  focusDayId,
  presentedRecs,
  onOpenRecs,
}: {
  trip: TripDocument;
  onTrip: (trip: TripDocument) => void;
  focusDayId?: string | null;
  presentedRecs: TripRecommendations | null;
  onOpenRecs: () => void;
}) {
  const { busy, err, notice, apply, undo, redo, setNotice, canUndo, canRedo } = useTripPlannerMutations({ trip, onTrip });
  const [openAdd, setOpenAdd] = useState<OpenAdd>(null);
  const [editingStopId, setEditingStopId] = useState<string | null>(null);
  const [history, setHistory] = useState<{ changesets: TripChangesetView[]; canUndo: boolean; canRedo: boolean; dismissedAdvisories: TripAdvisory[] } | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);

  useEffect(() => {
    if (!historyOpen) return;
    let alive = true;
    api
      .tripHistory(trip.id)
      .then((next) => {
        if (alive) setHistory(next);
      })
      .catch(() => {
        /* history is read-only context; the planner stays usable without it */
      });
    return () => {
      alive = false;
    };
  }, [historyOpen, trip.id, trip.advisories]);

  // A focused day view renders one day (plus Unscheduled). An empty focused
  // day gets the approved empty-day screen; Library and placeholder live on
  // that card once, not again in the day header.
  const focusedDay = focusDayId ? (trip.days.find((day) => day.id === focusDayId) ?? null) : null;
  const visibleDays = focusedDay ? [focusedDay] : trip.days;
  const draftIds = [...visibleDays.flatMap((day) => day.stops), ...trip.unscheduled]
    .filter((stop) => stop.state === "draft")
    .map((stop) => stop.id);
  // Opening the sheet again re-shows the last presented options; with nothing
  // presented it stays an honest no-op that calls no agent.
  const askForOpinions = () => {
    if (presentedRecs) onOpenRecs();
    else setNotice("No agent was called. Options appear when your browser agent presents them.");
  };
  const fillHole = (hole: TripStop, list: TripStop[], index: number) =>
    setOpenAdd({
      dayId: hole.dayId,
      mode: "library",
      fill: { holeId: hole.id, beforeStopId: list[index + 1]?.id },
    });
  const fillRequest = openAdd?.fill
    ? ([...trip.days.flatMap((day) => day.stops), ...trip.unscheduled].find((stop) => stop.id === openAdd.fill?.holeId)?.content as { request?: string } | undefined)?.request ?? ""
    : "";

  return (
    <section className="trip-planner" aria-label="Day Planner">
      <div className="trip-planner-head">
        <h2 className="trip-planner-title">Day Planner</h2>
        <div className="trip-planner-tools">
          {draftIds.length > 0 ? (
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() =>
                apply(
                  draftIds.map((stopId) => ({ type: "updateStop", stopId, state: "confirmed" as const })),
                  `Kept ${draftIds.length} ${draftIds.length === 1 ? "draft" : "drafts"}.`,
                )
              }
            >
              Keep all drafts ({draftIds.length})
            </button>
          ) : null}
          <button type="button" className="btn" disabled={busy || !canUndo} onClick={undo}>
            Undo
          </button>
          <button type="button" className="btn" disabled={busy || !canRedo} onClick={redo}>
            Redo
          </button>
        </div>
      </div>
      {err ? (
        <p className="bad" role="alert">
          {err}
        </p>
      ) : null}
      <p className="trip-live" role="status" aria-live="polite">
        {notice}
      </p>
      {visibleDays.map((day) => (
        <DaySection
          key={day.id}
          day={day}
          emptyOpen={Boolean(focusedDay && day.stops.length === 0)}
          askForOpinions={askForOpinions}
          trip={trip}
          busy={busy}
          apply={apply}
          openAdd={openAdd}
          setOpenAdd={setOpenAdd}
          editingStopId={editingStopId}
          setEditingStopId={setEditingStopId}
          fillHole={fillHole}
          fillRequest={fillRequest}
        />
      ))}
      <UnscheduledSection
        trip={trip}
        busy={busy}
        apply={apply}
        openAdd={openAdd}
        setOpenAdd={setOpenAdd}
        editingStopId={editingStopId}
        setEditingStopId={setEditingStopId}
        fillHole={fillHole}
        fillRequest={fillRequest}
      />
      <TripHistory history={history} trip={trip} onToggle={setHistoryOpen} />
    </section>
  );
}
