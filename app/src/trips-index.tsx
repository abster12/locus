import { useEffect, useRef, useState } from "react";
import { api, type TripDocument, type TripSetupBody, type TripSummary } from "./api.ts";
import { formatDate } from "./trips-format.ts";
import { PageAgentBanner } from "./page-agent-banner.tsx";

export function TripsIndex({ filter, webmcpReady = false }: { filter: "active" | "archived"; webmcpReady?: boolean }) {
  const [trips, setTrips] = useState<TripSummary[] | null>(null);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    api
      .trips()
      .then((page) => {
        if (alive) setTrips(page.trips);
      })
      .catch((e: unknown) => {
        if (alive) setErr(e instanceof Error ? e.message : String(e));
      });
    return () => {
      alive = false;
    };
  }, []);

  // Counts derive from the same fetched collection the rows render from, so
  // the filter control can never disagree with the list.
  const active = trips?.filter((trip) => !trip.archivedAt) ?? [];
  const archived = trips?.filter((trip) => trip.archivedAt) ?? [];
  const visible = filter === "archived" ? archived : active;

  return (
    <section className="trips" aria-label="Trips">
      <div className="trips-pagehead">
        <div className="pagehead">
          <h1>Trips</h1>
          {trips ? <span className="count">{tripCountLine(trips.length)}</span> : null}
        </div>
        <p className="pagesub">Durable travel plans you can reopen and edit. Opening Trips does not start an agent.</p>
        {webmcpReady ? <PageAgentBanner surface="trips" /> : null}
        <div className="trips-tools">
          <a className="btn primary" href="#/trips/new">
            Plan a trip
          </a>
          <div className="trips-filter" role="group" aria-label="Filter trips">
            <button
              type="button"
              className={`chip ${filter === "active" ? "active" : ""}`}
              aria-pressed={filter === "active"}
              onClick={() => (location.hash = "#/trips")}
            >
              Active · {active.length}
            </button>
            <button
              type="button"
              className={`chip ${filter === "archived" ? "active" : ""}`}
              aria-pressed={filter === "archived"}
              onClick={() => (location.hash = "#/trips?filter=archived")}
            >
              Archived · {archived.length}
            </button>
          </div>
        </div>
      </div>
      {err ? (
        <p className="bad" role="alert">
          {err}
        </p>
      ) : null}
      <div className="trips-root">
        <div className="trips-main">
          {trips && visible.length === 0 ? (
            <div className="index-empty">
              <p className="empty">{emptyIndexLine(filter, trips.length)}</p>
              {filter === "active" && trips.length === 0 ? (
                <a className="btn primary" href="#/trips/new">
                  Plan a trip
                </a>
              ) : null}
            </div>
          ) : null}
          {trips && visible.length > 0 ? (
            <ul className="trip-list">
              {visible.map((trip) => (
                <TripRow key={trip.id} trip={trip} />
              ))}
            </ul>
          ) : null}
        </div>
        <aside className="trips-rail" aria-label="Trip planning">
          <h2>Trip planning</h2>
          <p>Each trip is one document. Start with a destination and dates; add stops when you are ready.</p>
        </aside>
      </div>
    </section>
  );
}

function emptyIndexLine(filter: "active" | "archived", total: number): string {
  if (filter === "archived") return "Nothing archived yet.";
  return total === 0 ? "No Trip Documents yet. Plan a trip to create one." : "No active trips. Archived trips keep their history and can be restored.";
}

function tripCountLine(total: number): string {
  return total === 1 ? "1 trip" : `${total} trips`;
}

function tripState(trip: TripSummary): string {
  if (trip.archivedAt) return "Archived";
  // Saved data only: revision 1 means nothing was edited since creation.
  return trip.revision === 1 ? "Early notes" : "Planning";
}

function TripRow({ trip }: { trip: TripSummary }) {
  const href = `#/trips/${trip.id}`;
  return (
    <li>
      <a
        className="trip-row"
        href={href}
        aria-label={`Open ${trip.title}`}
        onKeyDown={(e) => {
          // Links activate on Enter natively; Space is added so the whole row
          // behaves like one activation target from the keyboard.
          if (e.key !== " ") return;
          e.preventDefault();
          location.hash = href;
        }}
      >
        <span className="trip-date">
          <b>{trip.startDate && trip.endDate ? tripRangeChip(trip) : "Dates"}</b>
          {trip.startDate ? formatDate(trip.startDate).slice(0, 3) : "Open"}
        </span>
        <span className="trip-row-main">
          <span className="trip-row-title">{trip.title}</span>
          <span className="trip-row-meta">
            {trip.destination} · {tripRangeLine(trip)}
          </span>
        </span>
        <span className="trip-progress">
          {tripState(trip)}
          <span>
            {trip.draftCount > 0 ? `${trip.draftCount} ${trip.draftCount === 1 ? "draft" : "drafts"}` : "No drafts"}
            {trip.holeCount > 0 ? ` · ${trip.holeCount} ${trip.holeCount === 1 ? "open hole" : "open holes"}` : ""}
            {` · updated ${updatedLabel(trip.updatedAt)}`}
          </span>
        </span>
      </a>
    </li>
  );
}

function tripRangeLine(trip: { startDate: string | null; endDate: string | null; durationDays: number }): string {
  if (trip.startDate && trip.endDate) {
    return `${formatDate(trip.startDate)} – ${formatDate(trip.endDate)} · ${trip.durationDays} days`;
  }
  return `${trip.durationDays} ${trip.durationDays === 1 ? "day" : "days"} · dates open`;
}

function tripRangeChip(trip: { startDate: string | null; endDate: string | null; durationDays: number }): string {
  if (trip.startDate && trip.endDate) return `${trip.durationDays}d`;
  return "open dates";
}

function updatedLabel(iso: string): string {
  const at = Date.parse(iso);
  const minutes = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  return formatDate(iso.slice(0, 10));
}

type SetupFormState = {
  destination: string;
  title: string;
  startDate: string;
  endDate: string;
  duration: string;
  timezone: string;
  travelers: string;
  lodgingAnchors: string;
  pace: string;
  mobility: string;
  budget: string;
  mealPreferences: string;
  interests: string;
  mustDos: string;
  hardConstraints: string;
};

const EMPTY_FORM: SetupFormState = {
  destination: "",
  title: "",
  startDate: "",
  endDate: "",
  duration: "",
  timezone: "",
  travelers: "",
  lodgingAnchors: "",
  pace: "",
  mobility: "",
  budget: "",
  mealPreferences: "",
  interests: "",
  mustDos: "",
  hardConstraints: "",
};

function formStateFromTrip(trip: TripDocument): SetupFormState {
  return {
    destination: trip.destination,
    title: trip.title === trip.destination ? "" : trip.title,
    startDate: trip.startDate ?? "",
    endDate: trip.endDate ?? "",
    duration: trip.startDate ? "" : String(trip.durationDays),
    timezone: trip.timezone ?? "",
    travelers: trip.travelers ?? "",
    lodgingAnchors: trip.context.lodgingAnchors.join("\n"),
    pace: trip.context.pace ?? "",
    mobility: trip.context.mobility ?? "",
    budget: trip.context.budget ?? "",
    mealPreferences: trip.context.mealPreferences.join("\n"),
    interests: trip.context.interests.join("\n"),
    mustDos: trip.context.mustDos.join("\n"),
    hardConstraints: trip.context.hardConstraints.join("\n"),
  };
}

function lines(value: string): string[] {
  return value
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

/** One-way draft→transport adapter: UI strings become the Trip setup codec
 * shape (TripSetupBody). Validation stays server-side in validateTripSetup;
 * this mapping never second-guesses it. formStateFromTrip is the reverse. */
export function setupBodyFromForm(form: SetupFormState): TripSetupBody {
  return {
    destination: form.destination.trim(),
    startDate: form.startDate || null,
    endDate: form.endDate || null,
    durationDays: form.duration ? Number(form.duration) : null,
    title: form.title.trim() || null,
    timezone: form.timezone.trim() || null,
    travelers: form.travelers.trim() || null,
    context: {
      lodgingAnchors: lines(form.lodgingAnchors),
      pace: form.pace.trim() || null,
      mobility: form.mobility.trim() || null,
      budget: form.budget.trim() || null,
      mealPreferences: lines(form.mealPreferences),
      interests: lines(form.interests),
      mustDos: lines(form.mustDos),
      hardConstraints: lines(form.hardConstraints),
    },
  };
}

export function TripSetupPage() {
  return (
    <section className="trips" aria-label="Plan a trip">
      <div className="trips-pagehead">
        <div className="pagehead">
          <h1>Plan a trip</h1>
        </div>
        <p className="pagesub">
          <a href="#/trips">Back to Trips</a> · Destination and dates or trip length are required. Everything else is optional context, stored as you
          entered it.
        </p>
      </div>
      <TripSetupForm onDone={(trip) => (location.hash = `#/trips/${trip.id}`)} />
    </section>
  );
}

export function TripSetupForm({ existing, onDone }: { existing?: TripDocument | null; onDone: (trip: TripDocument) => void }) {
  const [form, setForm] = useState<SetupFormState>(existing ? formStateFromTrip(existing) : EMPTY_FORM);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // One mutation id per logical create: held while a submission is pending and
  // reused when an unchanged payload is retried after a failure, so the server
  // receipt can dedupe a lost response. A changed submission is a new request.
  const pendingCreate = useRef<{ id: string; fingerprint: string } | null>(null);
  const set = (key: keyof SetupFormState) => (event: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: event.target.value }));

  async function submit(event: { preventDefault: () => void }) {
    event.preventDefault();
    setBusy(true);
    setErr(null);
    const body = setupBodyFromForm(form);
    try {
      const result = existing
        ? await api.updateTrip(existing.id, { ...body, expectedRevision: existing.revision })
        : await api.createTrip({ ...body, clientMutationId: createMutationId(body) });
      pendingCreate.current = null;
      onDone(result.trip);
    } catch (e: unknown) {
      setErr(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  // Fresh id only for a new logical create (first attempt or changed payload);
  // an identical retry keeps the id the server already saw.
  function createMutationId(body: TripSetupBody): string {
    const fingerprint = JSON.stringify(body);
    if (!pendingCreate.current || pendingCreate.current.fingerprint !== fingerprint) {
      pendingCreate.current = { id: crypto.randomUUID(), fingerprint };
    }
    return pendingCreate.current.id;
  }

  return (
    <form className="trip-form" onSubmit={submit}>
      {err ? (
        <p className="bad" role="alert">
          {err}
        </p>
      ) : null}
      <label className="trip-field">
        Destination <span className="trip-req">required</span>
        <input value={form.destination} onChange={set("destination")} maxLength={120} required />
      </label>
      <div className="trip-when">
        <span className="trip-when-label">Dates</span>
        <label>
          Start <input type="date" value={form.startDate} onChange={set("startDate")} />
        </label>
        <label>
          End <input type="date" value={form.endDate} onChange={set("endDate")} />
        </label>
        <span className="trip-or">or trip length</span>
        <label>
          Days <input type="number" min={1} max={365} value={form.duration} onChange={set("duration")} placeholder="e.g. 5" />
        </label>
      </div>
      <details className="trip-optional">
        <summary>Optional context</summary>
        <label className="trip-field">
          Title
          <input value={form.title} onChange={set("title")} maxLength={120} placeholder="Defaults to the destination" />
        </label>
        <label className="trip-field">
          Timezone
          <input value={form.timezone} onChange={set("timezone")} list="trip-timezones" placeholder="e.g. Asia/Tokyo" />
        </label>
        <datalist id="trip-timezones">
          {Intl.supportedValuesOf("timeZone").map((zone) => (
            <option key={zone} value={zone} />
          ))}
        </datalist>
        <label className="trip-field">
          Travelers
          <input value={form.travelers} onChange={set("travelers")} maxLength={120} placeholder="e.g. 2 adults" />
        </label>
        <label className="trip-field">
          Lodging anchors <span className="trip-hint">one per line</span>
          <textarea value={form.lodgingAnchors} onChange={set("lodgingAnchors")} rows={2} />
        </label>
        <label className="trip-field">
          Pace
          <input value={form.pace} onChange={set("pace")} maxLength={120} placeholder="e.g. slow mornings" />
        </label>
        <label className="trip-field">
          Mobility
          <input value={form.mobility} onChange={set("mobility")} maxLength={120} placeholder="e.g. walking and transit" />
        </label>
        <label className="trip-field">
          Budget
          <input value={form.budget} onChange={set("budget")} maxLength={120} placeholder="e.g. mid-range" />
        </label>
        <label className="trip-field">
          Meal preferences <span className="trip-hint">one per line</span>
          <textarea value={form.mealPreferences} onChange={set("mealPreferences")} rows={2} />
        </label>
        <label className="trip-field">
          Interests <span className="trip-hint">one per line</span>
          <textarea value={form.interests} onChange={set("interests")} rows={2} />
        </label>
        <label className="trip-field">
          Must-dos <span className="trip-hint">one per line</span>
          <textarea value={form.mustDos} onChange={set("mustDos")} rows={2} />
        </label>
        <label className="trip-field">
          Hard constraints <span className="trip-hint">one per line</span>
          <textarea value={form.hardConstraints} onChange={set("hardConstraints")} rows={2} />
        </label>
      </details>
      <p className="trip-form-actions">
        <button type="submit" className="btn primary" disabled={busy}>
          {busy ? "Saving…" : existing ? "Save changes" : "Create trip"}
        </button>
      </p>
    </form>
  );
}
