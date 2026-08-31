import type { Db } from "../../db/open.ts";
import { newId } from "../../db/open.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import { getLibraryItem } from "../../core/library.ts";
import { getPlaceView } from "../atlas/module.ts";
import type {
  TripAdvisoryCategory,
  TripAdvisorySeverity,
  TripContext,
  TripStopContent,
  TripStopProvenance,
  TripStopSnapshot,
} from "./policy.ts";

/** Display data resolved from the authoritative modules at read time. A
 * missing reference keeps the stop visible with broken: true instead of
 * disappearing — the identity and placement are trip-owned history. */
export type TripStopResolved =
  | { kind: "item"; title: string; source: string | null; url: string | null }
  | { kind: "place"; name: string; kindLabel: string; location: string | null };

export type TripStop = {
  id: string;
  dayId: string | null;
  position: number;
  content: TripStopContent;
  resolved: TripStopResolved | null;
  broken: boolean;
  state: "confirmed" | "draft";
  provenance: TripStopProvenance;
  publicNotes: string;
  privateNotes: string;
  timeWindow: string | null;
  durationMinutes: number | null;
  reservation: string | null;
  storedFacts: string[];
  alternatives: string[];
  createdAt: string;
  updatedAt: string;
};

export type TripDay = {
  id: string;
  position: number;
  date: string | null;
  label: string;
  theme: string | null;
  stops: TripStop[];
};

/** One bounded advisory flag saved by an agent review. Opinions are pinned to
 * the revision they reviewed: later itinerary edits never rewrite them, the
 * UI derives staleness from reviewedRevision < trip.revision. */
export type TripAdvisoryView = {
  id: string;
  tripId: string;
  reviewedRevision: number;
  category: TripAdvisoryCategory;
  severity: TripAdvisorySeverity;
  opinion: string;
  rationale: string;
  dayRefs: string[];
  stopRefs: string[];
  actor: string;
  createdAt: string;
  dismissedAt: string | null;
};

/** One agent-authored preference inference saved by a base build. Labels on
 * the document only: linked to its Library basis, removable by the human, and
 * never merged into the user-entered trip context. */
export type TripInference = {
  id: string;
  text: string;
  basis: string;
};

export type TripDocument = {
  id: string;
  libraryId: string;
  title: string;
  destination: string;
  timezone: string | null;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  travelers: string | null;
  context: TripContext;
  /** Agent-authored inferences (build_trip_draft). Separate from context by
   * construction; an empty list means the agent invented nothing. */
  inferences: TripInference[];
  revision: number;
  archivedAt: string | null;
  days: TripDay[];
  unscheduled: TripStop[];
  /** Current (non-dismissed) advisories. Dismissed rows stay in the table for
   * history; staleness is derived, never stored. */
  advisories: TripAdvisoryView[];
  createdAt: string;
  updatedAt: string;
};

export type TripSummary = {
  id: string;
  title: string;
  destination: string;
  startDate: string | null;
  endDate: string | null;
  durationDays: number;
  revision: number;
  archivedAt: string | null;
  updatedAt: string;
  draftCount: number;
  holeCount: number;
};

// Only the human adapter exists today, so every context value stored here is
// user-entered by construction. Agent-authored content arrives through the
// changeset workflow (ticket 04+) and never through this setup seam.
export type TripRow = {
  id: string;
  library_id: string;
  title: string;
  destination: string;
  timezone: string | null;
  start_date: string | null;
  end_date: string | null;
  duration_days: number;
  travelers: string | null;
  context_json: string;
  inferences_json: string;
  revision: number;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
};

export type DayRow = {
  id: string;
  position: number;
  date: string | null;
  label: string;
  theme: string | null;
};

export type StopRow = {
  id: string;
  trip_id: string;
  day_id: string | null;
  position: number;
  content_json: string;
  state: string;
  provenance_json: string;
  public_notes: string;
  private_notes: string;
  time_window: string | null;
  duration_minutes: number | null;
  reservation: string | null;
  stored_facts_json: string | null;
  alternatives_json: string | null;
  created_at: string;
  updated_at: string;
};

export type AdvisoryRow = {
  id: string;
  trip_id: string;
  reviewed_revision: number;
  category: string;
  severity: string;
  opinion: string;
  rationale: string;
  day_refs_json: string;
  stop_refs_json: string;
  actor: string;
  client_mutation_id: string;
  payload_hash: string;
  created_at: string;
  dismissed_at: string | null;
};

function parseContext(json: string): TripContext {
  try {
    const parsed = JSON.parse(json) as Partial<TripContext>;
    return {
      lodgingAnchors: parsed.lodgingAnchors ?? [],
      pace: parsed.pace ?? null,
      mobility: parsed.mobility ?? null,
      budget: parsed.budget ?? null,
      mealPreferences: parsed.mealPreferences ?? [],
      interests: parsed.interests ?? [],
      mustDos: parsed.mustDos ?? [],
      hardConstraints: parsed.hardConstraints ?? [],
    };
  } catch {
    return {
      lodgingAnchors: [],
      pace: null,
      mobility: null,
      budget: null,
      mealPreferences: [],
      interests: [],
      mustDos: [],
      hardConstraints: [],
    };
  }
}

function dayLabel(position: number): string {
  return `Day ${position + 1}`;
}

function daysForSetup(setup: { startDate: string | null; endDate: string | null; durationDays: number }): { date: string | null }[] {
  if (setup.startDate && setup.endDate) {
    const days: { date: string }[] = [];
    const cursor = new Date(`${setup.startDate}T00:00:00Z`);
    const end = new Date(`${setup.endDate}T00:00:00Z`);
    for (; cursor <= end; cursor.setUTCDate(cursor.getUTCDate() + 1)) {
      days.push({ date: cursor.toISOString().slice(0, 10) });
    }
    return days;
  }
  return Array.from({ length: setup.durationDays }, () => ({ date: null }));
}

export function insertDays(db: Db, tripId: string, setup: { startDate: string | null; endDate: string | null; durationDays: number }, at: string): void {
  const insert = db.prepare(
    `INSERT INTO trip_days (id, trip_id, position, date, label, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  daysForSetup(setup).forEach((day, position) => {
    insert.run(newId(), tripId, position, day.date, dayLabel(position), at, at);
  });
}

export function listDayRows(db: Db, tripId: string): DayRow[] {
  return db
    .prepare(`SELECT id, position, date, label, theme FROM trip_days WHERE trip_id = ? ORDER BY position`)
    .all(tripId) as unknown as DayRow[];
}

export function parseStopContent(json: string): TripStopContent {
  try {
    const parsed = JSON.parse(json) as Partial<TripStopContent>;
    if (parsed.kind === "item" && typeof parsed.itemId === "string") return { kind: "item", itemId: parsed.itemId };
    if (parsed.kind === "place" && typeof parsed.placeId === "string") return { kind: "place", placeId: parsed.placeId };
    if (parsed.kind === "outside" && typeof parsed.title === "string") {
      return { kind: "outside", title: parsed.title, notes: typeof parsed.notes === "string" ? parsed.notes : null, url: typeof parsed.url === "string" ? parsed.url : null };
    }
    if (parsed.kind === "hole" && typeof parsed.request === "string") return { kind: "hole", request: parsed.request };
    throw new Error("bad content");
  } catch {
    // A row that fails validation still renders as a visible stop rather
    // than disappearing; repair path is a normal updateStop edit.
    return { kind: "outside", title: "Unavailable stop", notes: null, url: null };
  }
}

export function parseStringList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

export function parseProvenance(json: string): TripStopProvenance {
  try {
    const parsed = JSON.parse(json) as Partial<TripStopProvenance>;
    return { actor: typeof parsed.actor === "string" ? parsed.actor : "user", via: typeof parsed.via === "string" ? parsed.via : "manual" };
  } catch {
    return { actor: "user", via: "manual" };
  }
}

export function toStop(row: StopRow): TripStop {
  return {
    id: row.id,
    dayId: row.day_id,
    position: row.position,
    content: parseStopContent(row.content_json),
    resolved: null,
    broken: false,
    state: row.state === "draft" ? "draft" : "confirmed",
    provenance: parseProvenance(row.provenance_json),
    publicNotes: row.public_notes,
    privateNotes: row.private_notes,
    timeWindow: row.time_window,
    durationMinutes: row.duration_minutes,
    reservation: row.reservation ?? null,
    storedFacts: parseStringList(row.stored_facts_json),
    alternatives: parseStringList(row.alternatives_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** One insert for every persisted stop field. Callers own identity and
 * timestamps: duplication passes a new id and clone time; undo restoration
 * passes the snapshot id and created/updated times. List reindexing stays
 * in the changeset workflow. */
export function insertStopSnapshot(db: Db, tripId: string, stop: TripStopSnapshot): void {
  db.prepare(
    `INSERT INTO trip_stops (id, trip_id, day_id, position, content_json, state, provenance_json, public_notes, private_notes, time_window, duration_minutes, reservation, stored_facts_json, alternatives_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    stop.id,
    tripId,
    stop.dayId,
    stop.position,
    JSON.stringify(stop.content),
    stop.state,
    JSON.stringify(stop.provenance),
    stop.publicNotes,
    stop.privateNotes,
    stop.timeWindow,
    stop.durationMinutes,
    stop.reservation ?? null,
    JSON.stringify(stop.storedFacts ?? []),
    JSON.stringify(stop.alternatives ?? []),
    stop.createdAt,
    stop.updatedAt,
  );
}

export function listStopRows(db: Db, tripId: string): StopRow[] {
  return db
    .prepare(`SELECT * FROM trip_stops WHERE trip_id = ? ORDER BY position, created_at, id`)
    .all(tripId) as unknown as StopRow[];
}

function advisoryRefArray(json: string): string[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function toAdvisoryView(row: AdvisoryRow): TripAdvisoryView {
  return {
    id: row.id,
    tripId: row.trip_id,
    reviewedRevision: row.reviewed_revision,
    category: row.category as TripAdvisoryCategory,
    severity: row.severity as TripAdvisorySeverity,
    opinion: row.opinion,
    rationale: row.rationale,
    dayRefs: advisoryRefArray(row.day_refs_json),
    stopRefs: advisoryRefArray(row.stop_refs_json),
    actor: row.actor,
    createdAt: row.created_at,
    dismissedAt: row.dismissed_at,
  };
}

function listAdvisoryRows(db: Db, tripId: string): AdvisoryRow[] {
  return db
    .prepare(`SELECT * FROM trip_advisories WHERE trip_id = ? AND dismissed_at IS NULL ORDER BY created_at, rowid`)
    .all(tripId) as unknown as AdvisoryRow[];
}

/** Dismissed advisories for the owning Library only. Newest 100; active flags
 * stay on TripDocument.advisories; missing or foreign trips return null. */
export function listDismissedAdvisories(db: Db, libraryId: string, tripId: string): TripAdvisoryView[] | null {
  if (!tripRowOrNull(db, libraryId, tripId)) return null;
  return (
    db
      .prepare(
        `SELECT * FROM trip_advisories WHERE trip_id = ? AND dismissed_at IS NOT NULL ORDER BY dismissed_at DESC, rowid DESC LIMIT 100`,
      )
      .all(tripId) as unknown as AdvisoryRow[]
  ).map(toAdvisoryView);
}

export function stopsInList(rows: StopRow[], dayId: string | null): StopRow[] {
  return rows.filter((row) => (row.day_id ?? null) === dayId);
}

export function parseInferences(json: string): TripInference[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TripInference =>
        !!entry && typeof entry === "object" && typeof (entry as TripInference).id === "string" && typeof (entry as TripInference).text === "string" && typeof (entry as TripInference).basis === "string",
    );
  } catch {
    return [];
  }
}

function toDocument(db: Db, row: TripRow, days: DayRow[], stops: StopRow[]): TripDocument {
  const grouped = new Map<string, TripStop[]>();
  const unscheduled: TripStop[] = [];
  for (const stop of stops) {
    const projected = resolveStop(db, row.library_id, toStop(stop));
    if (stop.day_id === null) unscheduled.push(projected);
    else {
      const list = grouped.get(stop.day_id) ?? [];
      list.push(projected);
      grouped.set(stop.day_id, list);
    }
  }
  return {
    id: row.id,
    libraryId: row.library_id,
    title: row.title,
    destination: row.destination,
    timezone: row.timezone,
    startDate: row.start_date,
    endDate: row.end_date,
    durationDays: row.duration_days,
    travelers: row.travelers,
    context: parseContext(row.context_json),
    inferences: parseInferences(row.inferences_json),
    revision: row.revision,
    archivedAt: row.archived_at,
    days: days.map((day) => ({ id: day.id, position: day.position, date: day.date, label: day.label, theme: day.theme ?? null, stops: grouped.get(day.id) ?? [] })),
    unscheduled,
    advisories: listAdvisoryRows(db, row.id).map(toAdvisoryView),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** Resolve one stop's references against the authoritative modules. Returns
 * the same stop with `resolved` display data and `broken` set for references
 * that no longer resolve. Outside content and holes never resolve — they are
 * trip-owned text, not Library references, so they are never "broken". */
function resolveStop(db: Db, libraryId: string, stop: TripStop): TripStop {
  if (stop.content.kind !== "item" && stop.content.kind !== "place") return stop;
  const resolved = resolveStopContent(db, libraryId, stop.content);
  return { ...stop, resolved, broken: resolved === null };
}

/** Resolve one stop's content against the authoritative modules. Outside
 * content and holes are trip-owned text and resolve to null. */
export function resolveStopContent(db: Db, libraryId: string, content: TripStopContent): TripStopResolved | null {
  if (content.kind === "item") {
    const item = getLibraryItem(db, libraryId, content.itemId);
    if (!item) return null;
    return {
      kind: "item",
      title: item.title?.trim() || item.body?.trim().slice(0, 80) || "Saved item",
      source: item.source ?? null,
      url: item.url,
    };
  }
  if (content.kind === "place") {
    const place = getPlaceView(db, libraryId, content.placeId);
    if (!place) return null;
    return { kind: "place", name: place.name, kindLabel: place.kind, location: place.ancestors.map((a) => a.name).join(" · ") || null };
  }
  return null;
}

export function requireStopRow(db: Db, tripId: string, stopId: string): StopRow {
  const row = db.prepare(`SELECT * FROM trip_stops WHERE trip_id = ? AND id = ?`).get(tripId, stopId) as StopRow | undefined;
  if (!row) throw new RejectedPayload("stop not found in this Trip Document");
  return row;
}

export function requireDayRow(db: Db, tripId: string, dayId: string): DayRow {
  const row = db.prepare(`SELECT id, position, date, label, theme FROM trip_days WHERE trip_id = ? AND id = ?`).get(tripId, dayId) as DayRow | undefined;
  if (!row) throw new RejectedPayload("day not found in this Trip Document");
  return row;
}

export function tripRowOrNull(db: Db, libraryId: string, tripId: string): TripRow | undefined {
  return db.prepare(`SELECT * FROM trips WHERE library_id = ? AND id = ?`).get(libraryId, tripId) as TripRow | undefined;
}

export function getTrip(db: Db, libraryId: string, tripId: string): TripDocument | null {
  const row = db.prepare(`SELECT * FROM trips WHERE library_id = ? AND id = ?`).get(libraryId, tripId) as TripRow | undefined;
  if (!row) return null;
  return toDocument(db, row, listDayRows(db, tripId), listStopRows(db, tripId));
}

export function listTrips(db: Db, libraryId: string): TripSummary[] {
  const rows = db
    .prepare(
      `SELECT t.id, t.title, t.destination, t.start_date, t.end_date, t.duration_days, t.revision, t.archived_at, t.updated_at,
              (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id = t.id AND s.state = 'draft') AS draft_count,
              (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id = t.id AND json_extract(s.content_json, '$.kind') = 'hole') AS hole_count
         FROM trips t WHERE t.library_id = ? ORDER BY t.updated_at DESC, t.id`,
    )
    .all(libraryId) as unknown as {
    id: string;
    title: string;
    destination: string;
    start_date: string | null;
    end_date: string | null;
    duration_days: number;
    revision: number;
    archived_at: string | null;
    updated_at: string;
    draft_count: number;
    hole_count: number;
  }[];
  return rows.map((row) => ({
    id: row.id,
    title: row.title,
    destination: row.destination,
    startDate: row.start_date,
    endDate: row.end_date,
    durationDays: row.duration_days,
    revision: row.revision,
    archivedAt: row.archived_at,
    updatedAt: row.updated_at,
    draftCount: row.draft_count,
    holeCount: row.hole_count,
  }));
}

/** Replace the day layout on an existing Trip Document. Day identities
 * survive when the day count is unchanged (dates may shift; stops stay on
 * their day). A longer trip appends days; a shorter one removes them from the
 * end, releasing their stops to Unscheduled instead of deleting. */
export function reconcileDays(db: Db, tripId: string, setup: { startDate: string | null; endDate: string | null; durationDays: number }, at: string): void {
  const existing = listDayRows(db, tripId);
  const target = daysForSetup(setup);
  const update = db.prepare(`UPDATE trip_days SET date = ?, label = ?, updated_at = ? WHERE id = ?`);
  const keep = Math.min(existing.length, target.length);
  for (let i = 0; i < keep; i += 1) update.run(target[i]!.date, dayLabel(i), at, existing[i]!.id);
  if (target.length > existing.length) {
    const insert = db.prepare(
      `INSERT INTO trip_days (id, trip_id, position, date, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let i = existing.length; i < target.length; i += 1) insert.run(newId(), tripId, i, target[i]!.date, dayLabel(i), at, at);
  }
  if (target.length < existing.length) {
    const released = existing.slice(target.length);
    const all = listStopRows(db, tripId);
    const byList = (dayId: string | null) =>
      stopsInList(all, dayId).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const ordered = [...byList(null), ...released.flatMap((day) => byList(day.id))];
    const park = db.prepare(`UPDATE trip_stops SET day_id = NULL, position = ?, updated_at = ? WHERE id = ?`);
    ordered.forEach((stop, index) => park.run(index, at, stop.id));
    db.prepare(`DELETE FROM trip_days WHERE trip_id = ? AND position >= ?`).run(tripId, target.length);
  }
}
