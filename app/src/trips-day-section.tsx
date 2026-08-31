import type { TripChangeOp, TripDay, TripDocument, TripStop } from "./api.ts";
import { formatDate, weekdayDay } from "./trips-format.ts";
import { StopRow } from "./trips-stop-row.tsx";
import { AddStopForm, HoleForm } from "./trips-stop-forms.tsx";
import { LibrarySearchForm } from "./trips-library-picker.tsx";
import type { FillPlacement } from "./trips-stop-ops.ts";

/** Which add sheet is open in the planner: a day, Unscheduled, or a fill. */
export type OpenAdd = {
  dayId: string | null;
  mode: "library" | "placeholder" | "hole";
  fill?: FillPlacement;
} | null;

type SectionProps = {
  trip: TripDocument;
  busy: boolean;
  apply: (operations: TripChangeOp[], note: string) => void;
  openAdd: OpenAdd;
  setOpenAdd: (next: OpenAdd) => void;
  editingStopId: string | null;
  setEditingStopId: (stopId: string | null) => void;
  fillHole: (hole: TripStop, list: TripStop[], index: number) => void;
  fillRequest: string;
};

/** The hole/fill/library/placeholder slots shared by every day section and
 * Unscheduled. Only one sheet is open at a time, so the dayId guard decides
 * whether any slot renders. */
function AddSlots({
  dayId,
  label,
  openAdd,
  setOpenAdd,
  busy,
  apply,
  fillRequest,
}: {
  dayId: string | null;
  label: string;
  openAdd: OpenAdd;
  setOpenAdd: (next: OpenAdd) => void;
  busy: boolean;
  apply: (operations: TripChangeOp[], note: string) => void;
  fillRequest: string;
}) {
  if (!openAdd || openAdd.dayId !== dayId) return null;
  const add = (operations: TripChangeOp[], note: string) => {
    setOpenAdd(null);
    apply(operations, note);
  };
  return (
    <>
      {openAdd.mode === "hole" ? (
        <HoleForm
          dayId={dayId}
          busy={busy}
          onCancel={() => setOpenAdd(null)}
          onAdd={(operations) => add(operations, `Hole added to ${label}.`)}
        />
      ) : null}
      {openAdd.fill ? (
        <div className="trip-fill">
          <p className="trip-fill-label">Fill “{fillRequest}” — the hole closes and what you add takes its exact place.</p>
          <LibrarySearchForm
            dayId={dayId}
            fill={openAdd.fill}
            busy={busy}
            onCancel={() => setOpenAdd(null)}
            onAdd={(operations) => add(operations, "Hole filled.")}
          />
          <AddStopForm
            dayId={dayId}
            fill={openAdd.fill}
            busy={busy}
            onCancel={() => setOpenAdd(null)}
            onAdd={(operations) => add(operations, "Hole filled.")}
          />
        </div>
      ) : null}
      {!openAdd.fill && openAdd.mode === "library" ? (
        <LibrarySearchForm dayId={dayId} busy={busy} onCancel={() => setOpenAdd(null)} onAdd={(operations) => add(operations, `Stop added to ${label}.`)} />
      ) : null}
      {!openAdd.fill && openAdd.mode === "placeholder" ? (
        <AddStopForm dayId={dayId} busy={busy} onCancel={() => setOpenAdd(null)} onAdd={(operations) => add(operations, `Stop added to ${label}.`)} />
      ) : null}
    </>
  );
}

/** One Trip Day: header (theme edit, add buttons), add sheets, then the
 * empty-day card or the stop list. */
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
  fillRequest,
}: SectionProps & {
  day: TripDay;
  emptyOpen: boolean;
  askForOpinions: () => void;
}) {
  return (
    <section className={`trip-day${emptyOpen ? " trip-day-open" : ""}`} aria-label={day.label}>
      <header className="trip-day-head">
        <span className="trip-day-label">{day.label}</span>
        {day.theme ? <span className="trip-day-theme">{day.theme}</span> : null}
        <label className="trip-day-theme-edit">
          <span className="visually-hidden">Theme for {day.label}</span>
          <input
            defaultValue={day.theme ?? ""}
            placeholder="Theme"
            maxLength={120}
            disabled={busy}
            onBlur={(event) => {
              const theme = event.target.value.trim() || null;
              if (theme === (day.theme ?? null)) return;
              apply([{ type: "updateDay", dayId: day.id, theme }], theme ? `Theme set to ${theme}.` : "Theme cleared.");
            }}
          />
        </label>
        <span className="trip-day-date">{day.date ? formatDate(day.date) : "open date"}</span>
        {emptyOpen ? null : (
          <>
            <button
              type="button"
              className="btn trip-add-btn"
              disabled={busy}
              aria-expanded={openAdd?.dayId === day.id && openAdd.mode === "library" && !openAdd.fill}
              onClick={() => setOpenAdd(openAdd?.dayId === day.id && openAdd.mode === "library" && !openAdd.fill ? null : { dayId: day.id, mode: "library" })}
            >
              Add from Library
            </button>
            <button
              type="button"
              className="btn trip-add-btn"
              disabled={busy}
              aria-expanded={openAdd?.dayId === day.id && openAdd.mode === "placeholder" && !openAdd.fill}
              onClick={() => setOpenAdd(openAdd?.dayId === day.id && openAdd.mode === "placeholder" && !openAdd.fill ? null : { dayId: day.id, mode: "placeholder" })}
            >
              Add a placeholder
            </button>
          </>
        )}
        <button
          type="button"
          className="btn trip-add-btn"
          disabled={busy}
          aria-expanded={openAdd?.dayId === day.id && openAdd.mode === "hole"}
          onClick={() => setOpenAdd(openAdd?.dayId === day.id && openAdd.mode === "hole" ? null : { dayId: day.id, mode: "hole" })}
        >
          Add a hole
        </button>
      </header>
      <AddSlots dayId={day.id} label={day.label} openAdd={openAdd} setOpenAdd={setOpenAdd} busy={busy} apply={apply} fillRequest={fillRequest} />
      {day.stops.length === 0 ? (
        emptyOpen ? (
          <div className="trip-empty-card">
            <div className="trip-empty-mark" aria-hidden="true">
              ＋
            </div>
            <span className="trip-empty-stamp">
              {day.label} · {day.date ? weekdayDay(day.date) : "open date"}
            </span>
            <h3>Leave it open, or give it a shape.</h3>
            <p>Nothing is planned for {day.label}. Opening this day does not invoke an agent or turn loose ideas into stops.</p>
            <div className="trip-empty-actions">
              <button
                type="button"
                className="btn primary trip-add-btn"
                disabled={busy}
                aria-expanded={openAdd?.dayId === day.id && openAdd.mode === "library"}
                onClick={() => setOpenAdd(openAdd?.dayId === day.id && openAdd.mode === "library" ? null : { dayId: day.id, mode: "library" })}
              >
                Add from Library
              </button>
              <button
                type="button"
                className="btn trip-add-btn"
                disabled={busy}
                aria-expanded={openAdd?.dayId === day.id && openAdd.mode === "placeholder"}
                onClick={() => setOpenAdd(openAdd?.dayId === day.id && openAdd.mode === "placeholder" ? null : { dayId: day.id, mode: "placeholder" })}
              >
                Add a placeholder
              </button>
              <button type="button" className="btn" disabled={busy} onClick={askForOpinions}>
                Ask for three opinions
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
            />
          ))}
        </ol>
      )}
    </section>
  );
}

/** The Unscheduled holding area: same header/add-sheet/empty-or-list shape as
 * a day, pinned to dayId null. */
export function UnscheduledSection({
  trip,
  busy,
  apply,
  openAdd,
  setOpenAdd,
  editingStopId,
  setEditingStopId,
  fillHole,
  fillRequest,
}: SectionProps) {
  return (
    <section className="trip-day trip-unscheduled" aria-label="Unscheduled">
      <header className="trip-day-head">
        <h3 className="trip-unscheduled-label">Unscheduled</h3>
        <button
          type="button"
          className="btn trip-add-btn"
          disabled={busy}
          aria-expanded={openAdd?.dayId === null && openAdd.mode === "library" && !openAdd.fill}
          onClick={() => setOpenAdd(openAdd?.dayId === null && openAdd.mode === "library" && !openAdd.fill ? null : { dayId: null, mode: "library" })}
        >
          Add from Library
        </button>
        <button
          type="button"
          className="btn trip-add-btn"
          disabled={busy}
          aria-expanded={openAdd?.dayId === null && openAdd.mode === "placeholder" && !openAdd.fill}
          onClick={() => setOpenAdd(openAdd?.dayId === null && openAdd.mode === "placeholder" && !openAdd.fill ? null : { dayId: null, mode: "placeholder" })}
        >
          Add a placeholder
        </button>
        <button
          type="button"
          className="btn trip-add-btn"
          disabled={busy}
          aria-expanded={openAdd?.dayId === null && openAdd.mode === "hole"}
          onClick={() => setOpenAdd(openAdd?.dayId === null && openAdd.mode === "hole" ? null : { dayId: null, mode: "hole" })}
        >
          Add a hole
        </button>
      </header>
      <AddSlots dayId={null} label="Unscheduled" openAdd={openAdd} setOpenAdd={setOpenAdd} busy={busy} apply={apply} fillRequest={fillRequest} />
      {trip.unscheduled.length === 0 ? (
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
            />
          ))}
        </ol>
      )}
    </section>
  );
}
