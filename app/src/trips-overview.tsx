import { projectTripOverview } from "./trips.ts";
import { formatDate } from "./trips-format.ts";
import type { TripDocument } from "./api.ts";

/** Overview is a read-only projection: identity, health from saved data only,
 * and one card per day. Conflicts come only from overlapping user-entered time windows. */
export function OverviewView({ trip, onAddFirstStop }: { trip: TripDocument; onAddFirstStop: () => void }) {
  const overview = projectTripOverview(trip);
  const emptyTrip = trip.days.every((day) => day.stops.length === 0) && trip.unscheduled.length === 0;
  if (emptyTrip) {
    return (
      <section className="trip-overview" aria-label="Overview">
        <div className="trip-empty-trip">
          <div className="trip-empty-trip-main">
            <div className="trip-empty-mark" aria-hidden="true">
              ＋
            </div>
            <h2>Start with the first day</h2>
            <p>Your Trip Document is ready. Add a stop from your Library, enter something outside Locus, or leave a hole for later. Nothing is generated until you ask.</p>
            <button type="button" className="btn primary" aria-haspopup="dialog" onClick={onAddFirstStop}>
              Add first stop
            </button>
          </div>
          <aside className="trip-getting-started" aria-label="Getting started">
            <h3>A new Trip Document</h3>
            <p>The durable plan already exists. These are useful next steps, not required setup.</p>
            <ol className="trip-start-list">
              <li>
                <b>Add a day theme</b>
                <p>A short phrase such as “East Kyoto” gives the day a useful shape.</p>
              </li>
              <li>
                <b>Add known stops</b>
                <p>Use saved Items and Places or enter outside content deliberately.</p>
              </li>
              <li>
                <b>Ask when useful</b>
                <p>Your agent can fill a hole, present three options, or review the saved plan.</p>
              </li>
            </ol>
          </aside>
        </div>
      </section>
    );
  }
  return (
    <section className="trip-overview" aria-label="Overview">
      <div className="trip-health" aria-label="Trip health">
        <div className="health-item">
          <small>Stops</small>
          <b>{overview.stopCount}</b>
        </div>
        <div className="health-item">
          <small>Empty days</small>
          <b>{overview.emptyDayCount}</b>
        </div>
        <div className="health-item">
          <small>Open holes</small>
          <b>{overview.holeCount === 0 ? "None" : overview.holeCount}</b>
        </div>
        <div className="health-item">
          <small>Overlaps</small>
          <b>{overview.conflictCount === 0 ? "No overlaps" : overview.conflictCount}</b>
        </div>
      </div>
      <div className="trip-overview-layout">
      <div className="trip-overview-main">
      <p className="trip-overview-note">Day cards summarize the same Trip Document; editing happens inside a day.</p>
      <div className="trip-day-grid">
        {overview.days.map((day) => (
          <article key={day.id} className={`trip-day-card${day.isEmpty ? " trip-day-card-empty" : ""}`}>
            <span className="trip-day-card-title">
              {day.label} · {day.date ? formatDate(day.date) : "open date"}
            </span>
            <h3 className="trip-day-card-heading">{day.theme || (day.isEmpty ? "Open day" : `${day.stopCount} ${day.stopCount === 1 ? "stop" : "stops"}`)}</h3>
            <p className="trip-day-card-meta">
              {day.isEmpty
                ? "No stops yet · intentionally unplanned"
                : day.timeRange
                  ? `${day.timeRange.start}–${day.timeRange.end} · ${day.timedCount} timed`
                  : day.timedCount === 0
                    ? "No times set"
                    : null}
              {day.holeCount > 0 ? ` · ${day.holeCount} ${day.holeCount === 1 ? "open hole" : "open holes"}` : null}
            </p>
            {day.anchors.map((anchor) => (
              <div key={anchor.title} className="trip-anchor">
                <time>{anchor.time ?? "—"}</time>
                <b>{anchor.title}</b>
              </div>
            ))}
            {day.conflicts.map((conflict) => (
              <p key={conflict} className="trip-conflict">
                {conflict}
              </p>
            ))}
            <a className="btn trip-day-card-open" href={`#/trips/${trip.id}?view=${day.id}`}>
              {day.isEmpty ? "Plan this day →" : "Open day →"}
            </a>
          </article>
        ))}
      </div>
      </div>
      <aside className="overview-rail" aria-label="Trip facts">
        <h3>Useful context</h3>
        <p>Only information you entered or explicitly asked an agent to save belongs here.</p>
        <ul className="fact-list">
          {trip.context.lodgingAnchors.map((item) => (
            <li key={item}>
              <b>Lodging</b>
              {item}
            </li>
          ))}
          {trip.context.pace ? (
            <li>
              <b>Pace</b>
              {trip.context.pace}
            </li>
          ) : null}
          {trip.context.mobility ? (
            <li>
              <b>Mobility</b>
              {trip.context.mobility}
            </li>
          ) : null}
          {trip.context.hardConstraints.map((item) => (
            <li key={item}>
              <b>Hard constraint</b>
              {item}
            </li>
          ))}
        </ul>
      </aside>
      </div>
    </section>
  );
}
