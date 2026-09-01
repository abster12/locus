import type { TripChangeOp, TripDay, TripDocument, TripStop } from "./api.ts";
import { dayStamp, weekdayDay } from "./trips-format.ts";
import { StopRow } from "./trips-stop-row.tsx";
import type { OpenAdd } from "./trips-stop-ops.ts";

type SectionProps = {
  trip: TripDocument;
  busy: boolean;
  apply: (operations: TripChangeOp[], note: string) => void;
  openAdd: OpenAdd;
  setOpenAdd: (next: OpenAdd) => void;
  editingStopId: string | null;
  setEditingStopId: (stopId: string | null) => void;
  fillHole: (hole: TripStop, list: TripStop[], index: number) => void;
  announce: (message: string) => void;
};

function AddStopButton({
  dayId,
  busy,
  open,
  setOpenAdd,
  primary = false,
}: {
  dayId: string | null;
  busy: boolean;
  open: boolean;
  setOpenAdd: (next: OpenAdd) => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={`btn${primary ? " primary" : ""} trip-add-btn`}
      disabled={busy}
      aria-haspopup="dialog"
      aria-expanded={open}
      onClick={() => setOpenAdd({ dayId, source: null })}
    >
      Add stop
    </button>
  );
}

/** One Trip Day: header (theme edit, add), then the empty-day card or the stop list. */
export function DaySection({
  day,
  emptyOpen,
  askForOpinions,
  trip,
  busy,
  apply,
  openAdd,
  setOpenAdd,
  editingStopId,
  setEditingStopId,
  fillHole,
  announce,
}: SectionProps & {
  day: TripDay;
  emptyOpen: boolean;
  askForOpinions: () => void;
}) {
  const addOpen = openAdd?.dayId === day.id && !openAdd.fill;
  const drafts = day.stops.filter((stop) => stop.state === "draft").length;
  return (
    <section className={`trip-day${emptyOpen ? " trip-day-open" : ""}`} aria-label={day.label}>
      <header className="trip-day-head">
        <div className="trip-day-identity">
          <span className="trip-day-kicker">{day.date ? dayStamp(day.date) : "Open date"}</span>
          <h2 className="trip-planner-title">{day.label}</h2>
          <label className="trip-day-theme-edit">
            <span className="visually-hidden">Theme for {day.label}</span>
            <input
              key={day.theme ?? ""}
              defaultValue={day.theme ?? ""}
              placeholder="Add a day theme"
              maxLength={120}
              disabled={busy}
              onBlur={(event) => {
                const theme = event.target.value.trim() || null;
                if (theme === (day.theme ?? null)) return;
                apply([{ type: "updateDay", dayId: day.id, theme }], theme ? `Theme set to ${theme}.` : "Theme cleared.");
              }}
            />
          </label>
        </div>
        {emptyOpen ? null : (
          <div className="trip-day-tools">
            <span className="trip-stop-count">
              {day.stops.length} {day.stops.length === 1 ? "stop" : "stops"}
              {drafts ? ` · ${drafts} Draft${drafts === 1 ? "" : "s"}` : ""}
            </span>
            <AddStopButton dayId={day.id} busy={busy} open={addOpen} setOpenAdd={setOpenAdd} primary />
          </div>
        )}
      </header>
      {day.stops.length === 0 ? (
        emptyOpen ? (
          <div className="trip-empty-card">
            <div className="trip-empty-mark" aria-hidden="true">
              ＋
            </div>
            <span className="trip-empty-stamp">
              {day.label} · {day.date ? weekdayDay(day.date) : "open date"}
            </span>
            <h3>Nothing planned—and that is okay.</h3>
            <p>Keep the day open, add a stop yourself, or ask your agent to present three options. Opening this day never starts inference.</p>
            <div className="trip-empty-actions">
              <AddStopButton dayId={day.id} busy={busy} open={addOpen} setOpenAdd={setOpenAdd} primary />
              <button type="button" className="btn" disabled={busy} onClick={askForOpinions}>
                Ask agent for options
              </button>
            </div>
          </div>
        ) : (
          <p className="trip-stop-empty">Nothing planned yet.</p>
        )
      ) : (
        <ol className="trip-stop-list">
          {day.stops.map((stop, index) => (
            <StopRow
              key={stop.id}
              stop={stop}
              trip={trip}
              list={day.stops}
              index={index}
              busy={busy}
              editing={editingStopId === stop.id}
              onEdit={() => setEditingStopId(stop.id)}
              onCloseEdit={() => setEditingStopId(null)}
              onFill={() => fillHole(stop, day.stops, index)}
              apply={apply}
              announce={announce}
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** The Unscheduled holding area: same header/empty-or-list shape as a day, pinned to dayId null. */
export function UnscheduledSection({
  trip,
  busy,
  apply,
  openAdd,
  setOpenAdd,
  editingStopId,
  setEditingStopId,
  fillHole,
  announce,
}: SectionProps) {
  const waiting = trip.unscheduled.length;
  return (
    <details className="trip-unscheduled" aria-label="Unscheduled">
      <summary>
        Unscheduled
        <span>{waiting === 0 ? "Nothing waiting" : `${waiting} ${waiting === 1 ? "item" : "items"}`}</span>
      </summary>
      <div className="trip-unscheduled-body">
        <AddStopButton dayId={null} busy={busy} open={openAdd?.dayId === null && !openAdd.fill} setOpenAdd={setOpenAdd} primary />
        {waiting === 0 ? (
          <p className="trip-stop-empty">Nothing waiting.</p>
        ) : (
          <ol className="trip-stop-list">
            {trip.unscheduled.map((stop, index) => (
              <StopRow
                key={stop.id}
                stop={stop}
                trip={trip}
                list={trip.unscheduled}
                index={index}
                busy={busy}
                editing={editingStopId === stop.id}
                onEdit={() => setEditingStopId(stop.id)}
                onCloseEdit={() => setEditingStopId(null)}
                onFill={() => fillHole(stop, trip.unscheduled, index)}
                apply={apply}
                announce={announce}
              />
            ))}
          </ol>
        )}
      </div>
    </details>
  );
}
