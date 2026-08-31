import { projectTripSchedule } from "./trips.ts";
import { weekdayDay } from "./trips-format.ts";
import type { TripDocument } from "./api.ts";

/** Schedule lays the same timed stops onto an hour grid. Untimed and
 * Unscheduled stops stay in their own honest lists — never given invented
 * clock times. The projection is read-only. */
export function ScheduleView({ trip }: { trip: TripDocument }) {
  const schedule = projectTripSchedule(trip);
  return (
    <section className="trip-schedule" aria-label="Schedule">
      <p className="trip-schedule-tz">
        {schedule.timezone ? `All times are ${schedule.timezone}.` : "No timezone set — times are exactly as you entered them."}
      </p>
      {schedule.rows.length > 0 ? (
        <div
          className="trip-calendar-scroller"
          role="region"
          aria-label="Timed stops by day, scroll horizontally when needed"
          style={{ ["--trip-day-count" as string]: String(schedule.days.length) }}
        >
        <div className="trip-calendar" role="table" aria-label="Timed stops by day">
          <div className="trip-calendar-row" role="row">
            <div className="trip-calendar-cell trip-calendar-head" role="columnheader">
              <span className="visually-hidden">Time</span>
            </div>
            {schedule.days.map((day) => (
              <div key={day.id} className="trip-calendar-cell trip-calendar-head" role="columnheader">
                {day.label}
                {day.date ? <span className="trip-calendar-date"> · {weekdayDay(day.date)}</span> : null}
              </div>
            ))}
          </div>
          {schedule.rows.map((row) => (
            <div key={row.hour} className="trip-calendar-row" role="row">
              <div className="trip-calendar-cell trip-calendar-time" role="rowheader">
                {row.label}
              </div>
              {schedule.days.map((day) => {
                const slot = day.slots.find((entry) => entry.hour === row.hour);
                return (
                  <div key={day.id} className="trip-calendar-cell" role="cell">
                    {slot?.stops.map((stop) => (
                      <div key={stop.id} className="trip-calendar-event">
                        <b>{stop.title}</b>
                        {stop.timeWindow ? <span>{stop.timeWindow}</span> : null}
                      </div>
                    ))}
                  </div>
                );
              })}
            </div>
          ))}
        </div>
        </div>
      ) : (
        <p className="trip-stop-empty">No timed stops yet.</p>
      )}
      {schedule.days.some((day) => day.untimed.length > 0) || schedule.unscheduled.length > 0 ? (
        <div className="trip-schedule-loose">
          {schedule.days.map((day) =>
            day.untimed.length > 0 ? (
              <p key={day.id} className="trip-schedule-loose-line">
                {day.label} untimed: {day.untimed.map((stop) => stop.title).join(", ")}
              </p>
            ) : null,
          )}
          {schedule.unscheduled.length > 0 ? (
            <p className="trip-schedule-loose-line">Unscheduled: {schedule.unscheduled.map((stop) => stop.title).join(", ")}</p>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
