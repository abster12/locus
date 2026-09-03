import { createHash } from "node:crypto";
import { RejectedPayload } from "../../core/sanitize.ts";
import type { ShareSnapshot, ShareStopView } from "../../core/trip-share-html.ts";
import { foldName } from "../../server/atlas/policy.ts";
import {
  parseTripOperations,
  requireClientMutationId,
  validateMutationFields,
  validateTripInferences,
  validateTripReview,
  validateTripSetup,
  validateTripTitle,
  type TripAdvisoryCategory,
  type TripAdvisorySeverity,
  type TripContext,
  type TripReviewInput,
  type TripStopContent,
  type TripStopOp,
  type TripStopProvenance,
  type TripStopSnapshot,
} from "../../server/trips/policy.ts";
import { getPlaceCoordinates, getPlaceView, searchPlaces } from "./atlas.ts";
import { getLibraryItem, nowIso } from "./desk.ts";
import { all, first, run } from "./sql.ts";

export class TripConflict extends Error {
  readonly code = "conflict";
  constructor(message: string) {
    super(message);
    this.name = "TripConflict";
  }
}

export class ReviewIntentError extends Error {
  readonly code = "forbidden";
  constructor(message: string) {
    super(message);
    this.name = "ReviewIntentError";
  }
}

const REUSE_ERROR = "clientMutationId was already used for a different change";
const INTENT_TTL_MS = 15 * 60_000;
const MAX_TRIP_SOURCE_RESULTS = 20;

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

export type TripInference = { id: string; text: string; basis: string };

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
  inferences: TripInference[];
  revision: number;
  archivedAt: string | null;
  days: TripDay[];
  unscheduled: TripStop[];
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

type TripRow = {
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

type DayRow = {
  id: string;
  position: number;
  date: string | null;
  label: string;
  theme: string | null;
};

type StopRow = {
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

type AdvisoryRow = {
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

type StoredReceipt = { payload_hash: string; result_json: string; trip_id: string | null };

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function mutationPayloadHash(kind: string, expectedRevision: number | null, payload: unknown, tripId: string | null = null): string {
  return sha256(JSON.stringify({ kind, expectedRevision, tripId, payload: payload ?? null }));
}

function legacyMutationPayloadHash(kind: string, expectedRevision: number | null, payload: unknown): string {
  return sha256(JSON.stringify({ kind, expectedRevision, payload: payload ?? null }));
}

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

function parseStopContent(json: string): TripStopContent {
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
    return { kind: "outside", title: "Unavailable stop", notes: null, url: null };
  }
}

function parseStringList(json: string | null | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json) as unknown;
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

function parseProvenance(json: string): TripStopProvenance {
  try {
    const parsed = JSON.parse(json) as Partial<TripStopProvenance>;
    return { actor: typeof parsed.actor === "string" ? parsed.actor : "user", via: typeof parsed.via === "string" ? parsed.via : "manual" };
  } catch {
    return { actor: "user", via: "manual" };
  }
}

function toStop(row: StopRow): TripStop {
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

async function insertStopSnapshot(db: D1Database, tripId: string, stop: TripStopSnapshot): Promise<void> {
  await run(
    db,
    `INSERT INTO trip_stops (id, trip_id, day_id, position, content_json, state, provenance_json, public_notes, private_notes, time_window, duration_minutes, reservation, stored_facts_json, alternatives_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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

async function listDayRows(db: D1Database, tripId: string): Promise<DayRow[]> {
  return all<DayRow>(db, `SELECT id, position, date, label, theme FROM trip_days WHERE trip_id = ? ORDER BY position`, tripId);
}

async function listStopRows(db: D1Database, tripId: string): Promise<StopRow[]> {
  return all<StopRow>(db, `SELECT * FROM trip_stops WHERE trip_id = ? ORDER BY position, created_at, id`, tripId);
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

async function listAdvisoryRows(db: D1Database, tripId: string): Promise<AdvisoryRow[]> {
  return all<AdvisoryRow>(
    db,
    `SELECT * FROM trip_advisories WHERE trip_id = ? AND dismissed_at IS NULL ORDER BY created_at, rowid`,
    tripId,
  );
}

export async function listDismissedAdvisories(
  db: D1Database,
  libraryId: string,
  tripId: string,
): Promise<TripAdvisoryView[] | null> {
  if (!(await tripRowOrNull(db, libraryId, tripId))) return null;
  return (
    await all<AdvisoryRow>(
      db,
      `SELECT * FROM trip_advisories WHERE trip_id = ? AND dismissed_at IS NOT NULL ORDER BY dismissed_at DESC, rowid DESC LIMIT 100`,
      tripId,
    )
  ).map(toAdvisoryView);
}

function stopsInList(rows: StopRow[], dayId: string | null): StopRow[] {
  return rows.filter((row) => (row.day_id ?? null) === dayId);
}

function parseInferences(json: string): TripInference[] {
  try {
    const parsed = JSON.parse(json) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (entry): entry is TripInference =>
        !!entry &&
        typeof entry === "object" &&
        typeof (entry as TripInference).id === "string" &&
        typeof (entry as TripInference).text === "string" &&
        typeof (entry as TripInference).basis === "string",
    );
  } catch {
    return [];
  }
}

async function resolveStopContent(db: D1Database, libraryId: string, content: TripStopContent): Promise<TripStopResolved | null> {
  if (content.kind === "item") {
    const item = await getLibraryItem(db, libraryId, content.itemId);
    if (!item) return null;
    return {
      kind: "item",
      title: item.title?.trim() || item.body?.trim().slice(0, 80) || "Saved item",
      source: item.source ?? null,
      url: item.url,
    };
  }
  if (content.kind === "place") {
    const place = await getPlaceView(db, libraryId, content.placeId);
    if (!place) return null;
    return { kind: "place", name: place.name, kindLabel: place.kind, location: place.ancestors.map((a) => a.name).join(" · ") || null };
  }
  return null;
}

async function resolveStop(db: D1Database, libraryId: string, stop: TripStop): Promise<TripStop> {
  if (stop.content.kind !== "item" && stop.content.kind !== "place") return stop;
  const resolved = await resolveStopContent(db, libraryId, stop.content);
  return { ...stop, resolved, broken: resolved === null };
}

async function toDocument(db: D1Database, row: TripRow, days: DayRow[], stops: StopRow[]): Promise<TripDocument> {
  const grouped = new Map<string, TripStop[]>();
  const unscheduled: TripStop[] = [];
  for (const stop of stops) {
    const projected = await resolveStop(db, row.library_id, toStop(stop));
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
    days: days.map((day) => ({
      id: day.id,
      position: day.position,
      date: day.date,
      label: day.label,
      theme: day.theme ?? null,
      stops: grouped.get(day.id) ?? [],
    })),
    unscheduled,
    advisories: (await listAdvisoryRows(db, row.id)).map(toAdvisoryView),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function tripRowOrNull(db: D1Database, libraryId: string, tripId: string): Promise<TripRow | null> {
  return first<TripRow>(db, `SELECT * FROM trips WHERE library_id = ? AND id = ?`, libraryId, tripId);
}

export async function getTrip(db: D1Database, libraryId: string, tripId: string): Promise<TripDocument | null> {
  const row = await tripRowOrNull(db, libraryId, tripId);
  if (!row) return null;
  return toDocument(db, row, await listDayRows(db, tripId), await listStopRows(db, tripId));
}

export async function listTrips(db: D1Database, libraryId: string): Promise<TripSummary[]> {
  const rows = await all<{
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
  }>(
    db,
    `SELECT t.id, t.title, t.destination, t.start_date, t.end_date, t.duration_days, t.revision, t.archived_at, t.updated_at,
            (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id = t.id AND s.state = 'draft') AS draft_count,
            (SELECT COUNT(*) FROM trip_stops s WHERE s.trip_id = t.id AND json_extract(s.content_json, '$.kind') = 'hole') AS hole_count
       FROM trips t WHERE t.library_id = ? ORDER BY t.updated_at DESC, t.id`,
    libraryId,
  );
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

async function insertDays(
  db: D1Database,
  tripId: string,
  setup: { startDate: string | null; endDate: string | null; durationDays: number },
  at: string,
): Promise<void> {
  for (const [position, day] of daysForSetup(setup).entries()) {
    await run(
      db,
      `INSERT INTO trip_days (id, trip_id, position, date, label, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      crypto.randomUUID(),
      tripId,
      position,
      day.date,
      dayLabel(position),
      at,
      at,
    );
  }
}

async function reconcileDays(
  db: D1Database,
  tripId: string,
  setup: { startDate: string | null; endDate: string | null; durationDays: number },
  at: string,
): Promise<void> {
  const existing = await listDayRows(db, tripId);
  const target = daysForSetup(setup);
  const keep = Math.min(existing.length, target.length);
  for (let i = 0; i < keep; i += 1) {
    await run(db, `UPDATE trip_days SET date = ?, label = ?, updated_at = ? WHERE id = ?`, target[i]!.date, dayLabel(i), at, existing[i]!.id);
  }
  if (target.length > existing.length) {
    for (let i = existing.length; i < target.length; i += 1) {
      await run(
        db,
        `INSERT INTO trip_days (id, trip_id, position, date, label, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        crypto.randomUUID(),
        tripId,
        i,
        target[i]!.date,
        dayLabel(i),
        at,
        at,
      );
    }
  }
  if (target.length < existing.length) {
    const released = existing.slice(target.length);
    const allStops = await listStopRows(db, tripId);
    const byList = (dayId: string | null) =>
      stopsInList(allStops, dayId).sort((a, b) => a.position - b.position || a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
    const ordered = [...byList(null), ...released.flatMap((day) => byList(day.id))];
    for (const [index, stop] of ordered.entries()) {
      await run(db, `UPDATE trip_stops SET day_id = NULL, position = ?, updated_at = ? WHERE id = ?`, index, at, stop.id);
    }
    await run(db, `DELETE FROM trip_days WHERE trip_id = ? AND position >= ?`, tripId, target.length);
  }
}

async function getReceipt(db: D1Database, libraryId: string, clientMutationId: string): Promise<StoredReceipt | null> {
  return first<StoredReceipt>(
    db,
    `SELECT payload_hash, result_json, trip_id FROM trip_mutation_receipts WHERE library_id = ? AND client_mutation_id = ?`,
    libraryId,
    clientMutationId,
  );
}

function replayOrConflict<T>(existing: StoredReceipt, hash: string, legacyHash: string, tripId: string | null): T {
  if (existing.payload_hash === hash) return JSON.parse(existing.result_json) as T;
  if (existing.payload_hash === legacyHash && existing.trip_id === tripId) return JSON.parse(existing.result_json) as T;
  throw new RejectedPayload(REUSE_ERROR);
}

async function withCreateMutation<T>(
  db: D1Database,
  libraryId: string,
  clientMutationId: string,
  spec: {
    kind: string;
    payload: unknown;
    at: string;
    apply: (at: string) => Promise<{ result: T; tripId: string; resultRevision: number; receipt?: unknown }>;
  },
): Promise<T> {
  const hash = mutationPayloadHash(spec.kind, null, spec.payload);
  const legacyHash = legacyMutationPayloadHash(spec.kind, null, spec.payload);
  const existing = await getReceipt(db, libraryId, clientMutationId);
  if (existing) return replayOrConflict<T>(existing, hash, legacyHash, existing.trip_id);
  const applied = await spec.apply(spec.at);
  await run(
    db,
    `INSERT INTO trip_mutation_receipts (library_id, client_mutation_id, trip_id, kind, payload_hash, result_json, result_revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    libraryId,
    clientMutationId,
    applied.tripId,
    spec.kind,
    hash,
    JSON.stringify(applied.receipt ?? applied.result),
    applied.resultRevision,
    spec.at,
  );
  return applied.result;
}

async function withTripMutation<T>(
  db: D1Database,
  libraryId: string,
  tripId: string,
  spec: {
    kind: string;
    input: unknown;
    payload?: unknown;
    at?: string;
    apply: (tripRow: TripRow, at: string, bump: () => Promise<void>) => Promise<{ result: T; receipt?: unknown }>;
  },
): Promise<T | null> {
  const fields = validateMutationFields(spec.input, "lifecycle");
  const at = spec.at ?? nowIso();
  const hash = mutationPayloadHash(spec.kind, fields.expectedRevision, spec.payload ?? null, tripId);
  const legacyHash = legacyMutationPayloadHash(spec.kind, fields.expectedRevision, spec.payload ?? null);
  const existing = await getReceipt(db, libraryId, fields.clientMutationId);
  if (existing) return replayOrConflict<T>(existing, hash, legacyHash, tripId);
  const tripRow = await tripRowOrNull(db, libraryId, tripId);
  if (!tripRow) return null;
  if (tripRow.revision !== fields.expectedRevision) {
    throw new TripConflict(`expected revision ${fields.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
  }
  await run(
    db,
    `INSERT INTO trip_mutation_receipts (library_id, client_mutation_id, trip_id, kind, payload_hash, result_json, result_revision, created_at)
     VALUES (?, ?, ?, ?, ?, '', ?, ?)`,
    libraryId,
    fields.clientMutationId,
    tripId,
    spec.kind,
    hash,
    tripRow.revision,
    at,
  );
  let bumped = false;
  const applied = await spec.apply(tripRow, at, async () => {
    bumped = true;
    await run(db, `UPDATE trips SET revision = revision + 1, updated_at = ? WHERE id = ?`, at, tripId);
  });
  await run(
    db,
    `UPDATE trip_mutation_receipts SET result_json = ?, result_revision = ? WHERE library_id = ? AND client_mutation_id = ?`,
    JSON.stringify(applied.receipt ?? applied.result),
    tripRow.revision + (bumped ? 1 : 0),
    libraryId,
    fields.clientMutationId,
  );
  return applied.result;
}

function clientMutationIdOf(input: unknown): string | null {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const value = (input as Record<string, unknown>).clientMutationId;
  if (value === undefined || value === null || value === "") return null;
  return requireClientMutationId(input);
}

export async function createTrip(db: D1Database, libraryId: string, input: unknown, at = nowIso()): Promise<TripDocument> {
  const setup = validateTripSetup(input);
  const insert = async (when: string): Promise<TripDocument> => {
    const id = crypto.randomUUID();
    await run(
      db,
      `INSERT INTO trips (id, library_id, title, destination, timezone, start_date, end_date, duration_days, travelers, context_json, revision, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
      id,
      libraryId,
      setup.title,
      setup.destination,
      setup.timezone,
      setup.startDate,
      setup.endDate,
      setup.durationDays,
      setup.travelers,
      JSON.stringify(setup.context),
      when,
      when,
    );
    await insertDays(db, id, setup, when);
    return (await getTrip(db, libraryId, id))!;
  };
  const mutationId = clientMutationIdOf(input);
  if (!mutationId) return insert(at);
  return withCreateMutation(db, libraryId, mutationId, {
    kind: "create",
    payload: setup,
    at,
    apply: async (when) => {
      const trip = await insert(when);
      return { result: trip, tripId: trip.id, resultRevision: trip.revision };
    },
  });
}

export async function updateTripSetup(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  at = nowIso(),
): Promise<TripDocument | null> {
  const setup = validateTripSetup(input);
  return withTripMutation(db, libraryId, tripId, {
    kind: "setup",
    input,
    payload: setup,
    at,
    apply: async (_tripRow, when, bump) => {
      await run(
        db,
        `UPDATE trips SET title = ?, destination = ?, timezone = ?, start_date = ?, end_date = ?, duration_days = ?, travelers = ?, context_json = ?
         WHERE library_id = ? AND id = ?`,
        setup.title,
        setup.destination,
        setup.timezone,
        setup.startDate,
        setup.endDate,
        setup.durationDays,
        setup.travelers,
        JSON.stringify(setup.context),
        libraryId,
        tripId,
      );
      await reconcileDays(db, tripId, setup, when);
      await bump();
      return { result: (await getTrip(db, libraryId, tripId))! };
    },
  });
}

export async function renameTrip(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  at = nowIso(),
): Promise<TripDocument | null> {
  const nextTitle = validateTripTitle((input as { title?: unknown } | null)?.title);
  return withTripMutation(db, libraryId, tripId, {
    kind: "rename",
    input,
    payload: { title: nextTitle },
    at,
    apply: async (_tripRow, _when, bump) => {
      await run(db, `UPDATE trips SET title = ? WHERE id = ?`, nextTitle, tripId);
      await bump();
      return { result: (await getTrip(db, libraryId, tripId))! };
    },
  });
}

async function copyTrip(db: D1Database, libraryId: string, tripId: string, at: string): Promise<TripDocument> {
  const source = (await getTrip(db, libraryId, tripId))!;
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO trips (id, library_id, title, destination, timezone, start_date, end_date, duration_days, travelers, context_json, revision, archived_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, NULL, ?, ?)`,
    id,
    libraryId,
    source.title,
    source.destination,
    source.timezone,
    source.startDate,
    source.endDate,
    source.durationDays,
    source.travelers,
    JSON.stringify(source.context),
    at,
    at,
  );
  const dayIdMap = new Map<string, string>();
  for (const day of source.days) {
    const dayId = crypto.randomUUID();
    dayIdMap.set(day.id, dayId);
    await run(
      db,
      `INSERT INTO trip_days (id, trip_id, position, date, label, theme, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      dayId,
      id,
      day.position,
      day.date,
      day.label,
      day.theme,
      at,
      at,
    );
  }
  for (const stop of [...source.days.flatMap((day) => day.stops), ...source.unscheduled]) {
    await insertStopSnapshot(db, id, {
      ...stop,
      id: crypto.randomUUID(),
      dayId: stop.dayId === null ? null : (dayIdMap.get(stop.dayId) ?? null),
      createdAt: at,
      updatedAt: at,
    });
  }
  return (await getTrip(db, libraryId, id))!;
}

export async function duplicateTrip(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  at = nowIso(),
): Promise<TripDocument | null> {
  return withTripMutation(db, libraryId, tripId, {
    kind: "duplicate",
    input,
    at,
    apply: async () => ({ result: await copyTrip(db, libraryId, tripId, at) }),
  });
}

async function setArchived(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  archived: boolean,
  at: string,
): Promise<TripDocument | null> {
  return withTripMutation(db, libraryId, tripId, {
    kind: archived ? "archive" : "restore",
    input,
    at,
    apply: async (tripRow, when, bump) => {
      if (Boolean(tripRow.archived_at) !== archived) {
        await run(db, `UPDATE trips SET archived_at = ? WHERE id = ?`, archived ? when : null, tripId);
        await bump();
      }
      return { result: (await getTrip(db, libraryId, tripId))! };
    },
  });
}

export async function archiveTrip(db: D1Database, libraryId: string, tripId: string, input: unknown, at = nowIso()): Promise<TripDocument | null> {
  return setArchived(db, libraryId, tripId, input, true, at);
}

export async function restoreTrip(db: D1Database, libraryId: string, tripId: string, input: unknown, at = nowIso()): Promise<TripDocument | null> {
  return setArchived(db, libraryId, tripId, input, false, at);
}

export async function deleteTrip(db: D1Database, libraryId: string, tripId: string, input: unknown): Promise<boolean> {
  const rec = (input ?? {}) as Record<string, unknown>;
  if (rec.confirm !== "DELETE") throw new RejectedPayload('delete requires confirm "DELETE"');
  return (
    (await withTripMutation<boolean>(db, libraryId, tripId, {
      kind: "delete",
      input,
      payload: { confirm: "DELETE" },
      apply: async () => {
        await run(db, `DELETE FROM trip_stops WHERE trip_id = ?`, tripId);
        await run(db, `DELETE FROM trip_changesets WHERE trip_id = ?`, tripId);
        await run(db, `DELETE FROM trip_days WHERE trip_id = ?`, tripId);
        await run(db, `DELETE FROM trips WHERE library_id = ? AND id = ?`, libraryId, tripId);
        return { result: true };
      },
    })) ?? false
  );
}

export type TripSourceItem = { id: string; title: string; source: string | null };
export type TripSourcePlace = { id: string; name: string; kind: string };
export type TripSources = { items: TripSourceItem[]; places: TripSourcePlace[] };

export async function searchTripSources(db: D1Database, libraryId: string, q: string): Promise<TripSources> {
  const needle = foldName(q.trim().slice(0, 80));
  const allPlaces = await searchPlaces(db, libraryId, "");
  const places = needle ? await searchPlaces(db, libraryId, q) : allPlaces;
  const namesByPlace = new Map(
    allPlaces.map((place) => [place.id, [place.name, ...place.altNames, ...place.ancestors.map((row) => row.name)].map(foldName)]),
  );
  const rows = await all<{
    id: string;
    title: string | null;
    body: string | null;
    primary_place_id: string | null;
  }>(
    db,
    `SELECT i.id, i.title, i.body, asg.primary_place_id
       FROM items i
       LEFT JOIN atlas_assignments asg ON asg.item_id = i.id AND asg.library_id = ?
      WHERE i.library_id = ?
        AND (asg.outcome IS NULL OR asg.outcome IN ('placed', 'multiple'))
      ORDER BY i.first_observed_at DESC, i.id`,
    libraryId,
    libraryId,
  );
  const items: TripSourceItem[] = [];
  for (const row of rows) {
    const names = row.primary_place_id ? namesByPlace.get(row.primary_place_id) : undefined;
    const hit =
      !needle ||
      foldName(row.title ?? "").includes(needle) ||
      foldName(row.body ?? "").includes(needle) ||
      (names?.some((name) => name.includes(needle)) ?? false);
    if (!hit) continue;
    items.push({
      id: row.id,
      title: row.title?.trim() || row.body?.trim().slice(0, 80) || "Saved item",
      source: null,
    });
    if (items.length >= MAX_TRIP_SOURCE_RESULTS) break;
  }
  return {
    items,
    places: places.slice(0, MAX_TRIP_SOURCE_RESULTS).map((place) => ({ id: place.id, name: place.name, kind: place.kind })),
  };
}

export type TripChangesetView = {
  id: string;
  tripId: string;
  kind: "change" | "undo" | "redo";
  actor: string;
  instruction: string | null;
  summary: string;
  baseRevision: number;
  resultRevision: number;
  reversesId: string | null;
  createdAt: string;
  undoneAt: string | null;
};

export type TripMutationResult = {
  trip: TripDocument;
  changeset: TripChangesetView;
  replayed: boolean;
  canUndo: boolean;
  canRedo: boolean;
};

type ChangesetRow = {
  row_id?: number;
  id: string;
  trip_id: string;
  base_revision: number;
  result_revision: number;
  actor: string;
  instruction: string | null;
  client_mutation_id: string;
  kind: string;
  operations_json: string;
  inverse_json: string;
  summary: string;
  reverses_id: string | null;
  payload_hash: string;
  undone_at: string | null;
  created_at: string;
};

function toChangesetView(row: ChangesetRow): TripChangesetView {
  return {
    id: row.id,
    tripId: row.trip_id,
    kind: row.kind === "undo" || row.kind === "redo" ? row.kind : "change",
    actor: row.actor,
    instruction: row.instruction,
    summary: row.summary,
    baseRevision: row.base_revision,
    resultRevision: row.result_revision,
    reversesId: row.reverses_id,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
  };
}

function payloadHash(
  kind: "change" | "undo" | "redo",
  expectedRevision: number,
  operations: unknown,
  instruction: string | null = null,
  inferences: unknown = null,
): string {
  return sha256(JSON.stringify({ kind, expectedRevision, operations, instruction, inferences }));
}

async function changesetByMutationId(db: D1Database, tripId: string, clientMutationId: string): Promise<ChangesetRow | null> {
  return first<ChangesetRow>(
    db,
    `SELECT rowid AS row_id, * FROM trip_changesets WHERE trip_id = ? AND client_mutation_id = ?`,
    tripId,
    clientMutationId,
  );
}

async function insertChangeset(
  db: D1Database,
  tripId: string,
  params: {
    baseRevision: number;
    resultRevision: number;
    actor: string;
    instruction: string | null;
    clientMutationId: string;
    kind: "change" | "undo" | "redo";
    operations: TripStopOp[];
    inverse: TripStopOp[];
    summary: string;
    reversesId: string | null;
    hash: string;
    at: string;
  },
): Promise<ChangesetRow> {
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO trip_changesets (id, trip_id, base_revision, result_revision, actor, instruction, client_mutation_id, kind, operations_json, inverse_json, summary, reverses_id, payload_hash, undone_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
    id,
    tripId,
    params.baseRevision,
    params.resultRevision,
    params.actor,
    params.instruction,
    params.clientMutationId,
    params.kind,
    JSON.stringify(params.operations),
    JSON.stringify(params.inverse),
    params.summary,
    params.reversesId,
    params.hash,
    params.at,
  );
  return (await first<ChangesetRow>(db, `SELECT rowid AS row_id, * FROM trip_changesets WHERE id = ?`, id))!;
}

async function redoTarget(db: D1Database, tripId: string): Promise<ChangesetRow | null> {
  return first<ChangesetRow>(
    db,
    `SELECT rowid AS row_id, * FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NOT NULL ORDER BY undone_at DESC, rowid DESC LIMIT 1`,
    tripId,
  );
}

async function undoRedoFlags(db: D1Database, tripId: string): Promise<{ canUndo: boolean; canRedo: boolean }> {
  const canUndo = Boolean(
    await first<{ ok: number }>(db, `SELECT 1 AS ok FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NULL LIMIT 1`, tripId),
  );
  let canRedo = false;
  const target = await redoTarget(db, tripId);
  if (target?.row_id !== undefined) {
    const blocked = await first<{ n: number }>(
      db,
      `SELECT COUNT(*) AS n FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NULL AND rowid > ?`,
      tripId,
      target.row_id,
    );
    canRedo = Number(blocked?.n ?? 0) === 0;
  }
  return { canUndo, canRedo };
}

function daySql(dayId: string | null): { sql: string; params: unknown[] } {
  if (dayId === null) return { sql: "day_id IS NULL", params: [] };
  return { sql: "day_id = ?", params: [dayId] };
}

async function requireStopRow(db: D1Database, tripId: string, stopId: string): Promise<StopRow> {
  const row = await first<StopRow>(db, `SELECT * FROM trip_stops WHERE trip_id = ? AND id = ?`, tripId, stopId);
  if (!row) throw new RejectedPayload("stop not found in this Trip Document");
  return row;
}

async function requireDayRow(db: D1Database, tripId: string, dayId: string): Promise<DayRow> {
  const row = await first<DayRow>(
    db,
    `SELECT id, position, date, label, theme FROM trip_days WHERE trip_id = ? AND id = ?`,
    tripId,
    dayId,
  );
  if (!row) throw new RejectedPayload("day not found in this Trip Document");
  return row;
}

async function requireStopReference(db: D1Database, libraryId: string, content: TripStopContent): Promise<string> {
  if (content.kind === "outside") return content.title;
  if (content.kind === "hole") return content.request;
  const resolved = await resolveStopContent(db, libraryId, content);
  if (!resolved) {
    throw new RejectedPayload(content.kind === "item" ? "referenced Item is not in this Library" : "referenced Place is not in this Library");
  }
  return resolved.kind === "item" ? resolved.title : resolved.name;
}

function insertionIndex(list: StopRow[], placement: { beforeStopId?: string; afterStopId?: string; atPosition?: number }): number {
  if (placement.beforeStopId !== undefined) {
    const index = list.findIndex((row) => row.id === placement.beforeStopId);
    if (index < 0) throw new RejectedPayload("placement anchor not found in the target day");
    return index;
  }
  if (placement.afterStopId !== undefined) {
    const index = list.findIndex((row) => row.id === placement.afterStopId);
    if (index < 0) throw new RejectedPayload("placement anchor not found in the target day");
    return index + 1;
  }
  if (placement.atPosition !== undefined) {
    if (!Number.isInteger(placement.atPosition) || placement.atPosition < 0 || placement.atPosition > list.length) {
      throw new RejectedPayload("placement index is out of range");
    }
    return placement.atPosition;
  }
  return list.length;
}

function stopTitleOf(content: TripStopContent): string {
  if (content.kind === "outside") return content.title;
  if (content.kind === "hole") return content.request;
  return content.kind === "item" ? "a saved item" : "a place";
}

async function stopTitle(db: D1Database, libraryId: string, row: StopRow): Promise<string> {
  const content = parseStopContent(row.content_json);
  if (content.kind === "outside") return content.title;
  if (content.kind === "hole") return content.request;
  const resolved = await resolveStopContent(db, libraryId, content);
  if (resolved) return resolved.kind === "item" ? resolved.title : resolved.name;
  return content.kind === "item" ? "a saved item" : "a place";
}

async function dayLabelLookup(db: D1Database, tripId: string): Promise<(dayId: string | null) => string> {
  const labels = new Map<string, string>();
  for (const day of await listDayRows(db, tripId)) labels.set(day.id, day.label);
  return (dayId) => (dayId === null ? "Unscheduled" : labels.get(dayId) ?? "a removed day");
}

type Applied = { inverse: TripStopOp | null; note: string };

async function applyOne(
  db: D1Database,
  libraryId: string,
  tripId: string,
  at: string,
  actor: string,
  dayLabelOf: (dayId: string | null) => string,
  op: TripStopOp,
): Promise<Applied> {
  switch (op.type) {
    case "addStop": {
      if (op.dayId !== null) await requireDayRow(db, tripId, op.dayId);
      const display = await requireStopReference(db, libraryId, op.content);
      const list = stopsInList(await listStopRows(db, tripId), op.dayId);
      const index = insertionIndex(list, op);
      const day = daySql(op.dayId);
      await run(
        db,
        `UPDATE trip_stops SET position = position + 1, updated_at = ? WHERE trip_id = ? AND ${day.sql} AND position >= ?`,
        at,
        tripId,
        ...day.params,
        index,
      );
      const id = crypto.randomUUID();
      const isAgent = actor !== "user";
      const state = isAgent ? "draft" : (op.state ?? "confirmed");
      const provenance: TripStopProvenance = { actor, via: isAgent ? "agent" : "manual" };
      await run(
        db,
        `INSERT INTO trip_stops (id, trip_id, day_id, position, content_json, state, provenance_json, public_notes, private_notes, time_window, duration_minutes, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id,
        tripId,
        op.dayId,
        index,
        JSON.stringify(op.content),
        state,
        JSON.stringify(provenance),
        op.publicNotes ?? "",
        op.privateNotes ?? "",
        op.timeWindow ?? null,
        op.durationMinutes ?? null,
        at,
        at,
      );
      return { inverse: { type: "removeStop", stopId: id }, note: `added "${display}" to ${dayLabelOf(op.dayId)}` };
    }
    case "updateStop": {
      const row = await requireStopRow(db, tripId, op.stopId);
      const oldContent = parseStopContent(row.content_json);
      const oldState: "confirmed" | "draft" = row.state === "draft" ? "draft" : "confirmed";
      const oldProvenance = parseProvenance(row.provenance_json);
      const isAgent = actor !== "user";
      if (op.state === "confirmed" && isAgent) throw new RejectedPayload("only the human can confirm a draft stop");
      const content = op.content ?? oldContent;
      const display = op.content ? await requireStopReference(db, libraryId, op.content) : await stopTitle(db, libraryId, row);
      const timeWindow = op.timeWindow === undefined ? row.time_window : op.timeWindow;
      const durationMinutes = op.durationMinutes === undefined ? row.duration_minutes : op.durationMinutes;
      const publicNotes = op.publicNotes === undefined ? row.public_notes : (op.publicNotes ?? "");
      const privateNotes = op.privateNotes === undefined ? row.private_notes : (op.privateNotes ?? "");
      const reservation = op.reservation === undefined ? row.reservation : op.reservation;
      const storedFacts = op.storedFacts === undefined ? parseStringList(row.stored_facts_json) : op.storedFacts;
      const alternatives = op.alternatives === undefined ? parseStringList(row.alternatives_json) : op.alternatives;
      const state = op.state ?? (isAgent ? "draft" : oldState);
      const provenance = op.provenance ?? (isAgent ? ({ actor, via: "agent" } as TripStopProvenance) : oldProvenance);
      await run(
        db,
        `UPDATE trip_stops SET content_json = ?, state = ?, provenance_json = ?, time_window = ?, duration_minutes = ?, public_notes = ?, private_notes = ?, reservation = ?, stored_facts_json = ?, alternatives_json = ?, updated_at = ? WHERE id = ? AND trip_id = ?`,
        JSON.stringify(content),
        state,
        JSON.stringify(provenance),
        timeWindow,
        durationMinutes,
        publicNotes,
        privateNotes,
        reservation,
        JSON.stringify(storedFacts),
        JSON.stringify(alternatives),
        at,
        row.id,
        tripId,
      );
      return {
        inverse: {
          type: "updateStop",
          stopId: row.id,
          content: oldContent,
          timeWindow: row.time_window,
          durationMinutes: row.duration_minutes,
          publicNotes: row.public_notes,
          privateNotes: row.private_notes,
          reservation: row.reservation,
          storedFacts: parseStringList(row.stored_facts_json),
          alternatives: parseStringList(row.alternatives_json),
          state: oldState,
          provenance: oldProvenance,
        },
        note: `updated "${display}"`,
      };
    }
    case "moveStop": {
      const row = await requireStopRow(db, tripId, op.stopId);
      const oldDayId = row.day_id ?? null;
      const targetDayId = op.dayId === undefined ? oldDayId : op.dayId;
      if (targetDayId !== null) await requireDayRow(db, tripId, targetDayId);
      const allStops = await listStopRows(db, tripId);
      const oldList = stopsInList(allStops, oldDayId);
      const oldIndex = oldList.findIndex((candidate) => candidate.id === row.id);
      const sameList = (targetDayId ?? null) === (oldDayId ?? null);
      const working = stopsInList(allStops, targetDayId).filter((candidate) => candidate.id !== row.id);
      const index = insertionIndex(working, op);
      const final = [...working.slice(0, index), row, ...working.slice(index)];
      for (const [position, candidate] of final.entries()) {
        if ((candidate.day_id ?? null) !== targetDayId || candidate.position !== position) {
          await run(db, `UPDATE trip_stops SET day_id = ?, position = ?, updated_at = ? WHERE id = ? AND trip_id = ?`, targetDayId, position, at, candidate.id, tripId);
        }
      }
      if (op.provenance) {
        await run(db, `UPDATE trip_stops SET provenance_json = ? WHERE id = ? AND trip_id = ?`, JSON.stringify(op.provenance), row.id, tripId);
      }
      if (!sameList) {
        const old = daySql(oldDayId);
        await run(
          db,
          `UPDATE trip_stops SET position = position - 1, updated_at = ? WHERE trip_id = ? AND ${old.sql} AND position > ?`,
          at,
          tripId,
          ...old.params,
          oldIndex,
        );
      }
      if (actor !== "user") {
        await run(
          db,
          `UPDATE trip_stops SET provenance_json = ?, updated_at = ? WHERE id = ? AND trip_id = ?`,
          JSON.stringify({ actor, via: "agent move" } satisfies TripStopProvenance),
          at,
          row.id,
          tripId,
        );
      }
      return {
        inverse: { type: "moveStop", stopId: row.id, dayId: oldDayId, atPosition: oldIndex, provenance: parseProvenance(row.provenance_json) },
        note: `moved "${await stopTitle(db, libraryId, row)}" to ${dayLabelOf(targetDayId)}`,
      };
    }
    case "removeStop": {
      const row = await requireStopRow(db, tripId, op.stopId);
      const title = await stopTitle(db, libraryId, row);
      const snapshot = toStop(row);
      await run(db, `DELETE FROM trip_stops WHERE id = ? AND trip_id = ?`, row.id, tripId);
      const day = daySql(row.day_id);
      await run(
        db,
        `UPDATE trip_stops SET position = position - 1, updated_at = ? WHERE trip_id = ? AND ${day.sql} AND position > ?`,
        at,
        tripId,
        ...day.params,
        row.position,
      );
      return { inverse: { type: "restoreStop", stop: snapshot }, note: `removed "${title}" from ${dayLabelOf(snapshot.dayId)}` };
    }
    case "updateDay": {
      const row = await requireDayRow(db, tripId, op.dayId);
      await run(db, `UPDATE trip_days SET theme = ?, updated_at = ? WHERE id = ? AND trip_id = ?`, op.theme, at, row.id, tripId);
      return { inverse: { type: "updateDay", dayId: row.id, theme: row.theme ?? null }, note: `updated theme for ${row.label}` };
    }
    case "restoreInferences": {
      const previous = await first<{ inferences_json: string }>(db, `SELECT inferences_json FROM trips WHERE id = ?`, tripId);
      await run(db, `UPDATE trips SET inferences_json = ? WHERE id = ?`, op.json, tripId);
      return { inverse: { type: "restoreInferences", json: previous?.inferences_json ?? "[]" }, note: "restored inferences" };
    }
    case "restoreStop": {
      const stop = op.stop;
      await insertStopSnapshot(db, tripId, stop);
      const day = daySql(stop.dayId);
      await run(
        db,
        `UPDATE trip_stops SET position = position + 1, updated_at = ? WHERE trip_id = ? AND ${day.sql} AND position >= ? AND id != ?`,
        at,
        tripId,
        ...day.params,
        stop.position,
        stop.id,
      );
      return { inverse: { type: "removeStop", stopId: stop.id }, note: `restored "${stopTitleOf(stop.content)}"` };
    }
  }
}

async function applyOps(
  db: D1Database,
  libraryId: string,
  tripId: string,
  at: string,
  actor: string,
  ops: TripStopOp[],
): Promise<{ summary: string; inverses: TripStopOp[] }> {
  const dayLabelOf = await dayLabelLookup(db, tripId);
  const inverses: TripStopOp[] = [];
  const notes: string[] = [];
  for (const op of ops) {
    const applied = await applyOne(db, libraryId, tripId, at, actor, dayLabelOf, op);
    if (applied.inverse) inverses.unshift(applied.inverse);
    notes.push(applied.note);
  }
  return { summary: notes.join("; ").slice(0, 240), inverses };
}

function requireActor(actor: string): string {
  if (typeof actor !== "string" || !actor.trim()) throw new RejectedPayload("actor is required from the trusted adapter");
  return actor;
}

function replayOrThrow(existing: ChangesetRow, hash: string): TripChangesetView {
  if (existing.payload_hash !== hash) throw new RejectedPayload("clientMutationId was already used for a different change");
  return toChangesetView(existing);
}

export async function applyTripChanges(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  actor: string,
  at = nowIso(),
): Promise<TripMutationResult | null> {
  const trustedActor = requireActor(actor);
  const fields = validateMutationFields(input, "change");
  const rec = input as Record<string, unknown>;
  const operations = parseTripOperations(rec.operations);
  const hasInferences = rec.inferredPreferences !== undefined;
  if (hasInferences && trustedActor === "user") throw new RejectedPayload("inferred preferences can only be saved by the agent adapter");
  const inferences = hasInferences ? validateTripInferences(rec.inferredPreferences) : null;
  const hash = payloadHash("change", fields.expectedRevision, operations, fields.instruction, hasInferences ? inferences : null);
  const tripRow = await tripRowOrNull(db, libraryId, tripId);
  if (!tripRow) return null;
  const existing = await changesetByMutationId(db, tripId, fields.clientMutationId);
  if (existing) {
    const changeset = replayOrThrow(existing, hash);
    return { trip: (await getTrip(db, libraryId, tripId))!, changeset, replayed: true, ...(await undoRedoFlags(db, tripId)) };
  }
  if (tripRow.revision !== fields.expectedRevision) {
    throw new TripConflict(`expected revision ${fields.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
  }
  const applied = await applyOps(db, libraryId, tripId, at, trustedActor, operations);
  const inverses = applied.inverses;
  if (inferences && inferences.length > 0) {
    const previous = tripRow.inferences_json;
    await run(
      db,
      `UPDATE trips SET inferences_json = ? WHERE id = ?`,
      JSON.stringify(inferences.map((entry) => ({ id: crypto.randomUUID(), text: entry.text, basis: entry.basis }))),
      tripId,
    );
    inverses.unshift({ type: "restoreInferences", json: previous });
  }
  const resultRevision = fields.expectedRevision + 1;
  await run(db, `UPDATE trips SET revision = ?, updated_at = ? WHERE id = ?`, resultRevision, at, tripId);
  const row = await insertChangeset(db, tripId, {
    baseRevision: fields.expectedRevision,
    resultRevision,
    actor: trustedActor,
    instruction: fields.instruction,
    clientMutationId: fields.clientMutationId,
    kind: "change",
    operations,
    inverse: inverses,
    summary: applied.summary,
    reversesId: null,
    hash,
    at,
  });
  return { trip: (await getTrip(db, libraryId, tripId))!, changeset: toChangesetView(row), replayed: false, ...(await undoRedoFlags(db, tripId)) };
}

export async function undoTripChanges(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  actor: string,
  at = nowIso(),
): Promise<TripMutationResult | null> {
  const trustedActor = requireActor(actor);
  const fields = validateMutationFields(input, "undo");
  const hash = payloadHash("undo", fields.expectedRevision, null);
  const tripRow = await tripRowOrNull(db, libraryId, tripId);
  if (!tripRow) return null;
  const existing = await changesetByMutationId(db, tripId, fields.clientMutationId);
  if (existing) {
    const changeset = replayOrThrow(existing, hash);
    return { trip: (await getTrip(db, libraryId, tripId))!, changeset, replayed: true, ...(await undoRedoFlags(db, tripId)) };
  }
  if (tripRow.revision !== fields.expectedRevision) {
    throw new TripConflict(`expected revision ${fields.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
  }
  const target = await first<ChangesetRow>(
    db,
    `SELECT rowid AS row_id, * FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NULL ORDER BY rowid DESC LIMIT 1`,
    tripId,
  );
  if (!target) throw new RejectedPayload("nothing to undo");
  const operations = JSON.parse(target.inverse_json) as TripStopOp[];
  const applied = await applyOps(db, libraryId, tripId, at, trustedActor, operations);
  const resultRevision = fields.expectedRevision + 1;
  await run(db, `UPDATE trips SET revision = ?, updated_at = ? WHERE id = ?`, resultRevision, at, tripId);
  await run(db, `UPDATE trip_changesets SET undone_at = ? WHERE id = ?`, at, target.id);
  const row = await insertChangeset(db, tripId, {
    baseRevision: fields.expectedRevision,
    resultRevision,
    actor: trustedActor,
    instruction: null,
    clientMutationId: fields.clientMutationId,
    kind: "undo",
    operations,
    inverse: applied.inverses,
    summary: `Undo — ${applied.summary}`.slice(0, 240),
    reversesId: target.id,
    hash,
    at,
  });
  return { trip: (await getTrip(db, libraryId, tripId))!, changeset: toChangesetView(row), replayed: false, ...(await undoRedoFlags(db, tripId)) };
}

export async function redoTripChanges(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  actor: string,
  at = nowIso(),
): Promise<TripMutationResult | null> {
  const trustedActor = requireActor(actor);
  const fields = validateMutationFields(input, "redo");
  const hash = payloadHash("redo", fields.expectedRevision, null);
  const tripRow = await tripRowOrNull(db, libraryId, tripId);
  if (!tripRow) return null;
  const existing = await changesetByMutationId(db, tripId, fields.clientMutationId);
  if (existing) {
    const changeset = replayOrThrow(existing, hash);
    return { trip: (await getTrip(db, libraryId, tripId))!, changeset, replayed: true, ...(await undoRedoFlags(db, tripId)) };
  }
  if (tripRow.revision !== fields.expectedRevision) {
    throw new TripConflict(`expected revision ${fields.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
  }
  const target = await redoTarget(db, tripId);
  if (!target?.row_id) throw new RejectedPayload("nothing to redo");
  const blocked = await first<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM trip_changesets WHERE trip_id = ? AND kind = 'change' AND undone_at IS NULL AND rowid > ?`,
    tripId,
    target.row_id,
  );
  if (Number(blocked?.n ?? 0) > 0) throw new RejectedPayload("nothing to redo");
  const undoRow = await first<{ inverse_json: string }>(
    db,
    `SELECT inverse_json FROM trip_changesets WHERE trip_id = ? AND kind = 'undo' AND reverses_id = ? ORDER BY rowid DESC LIMIT 1`,
    tripId,
    target.id,
  );
  if (!undoRow) throw new RejectedPayload("nothing to redo");
  const operations = JSON.parse(undoRow.inverse_json) as TripStopOp[];
  const applied = await applyOps(db, libraryId, tripId, at, trustedActor, operations);
  const resultRevision = fields.expectedRevision + 1;
  await run(db, `UPDATE trips SET revision = ?, updated_at = ? WHERE id = ?`, resultRevision, at, tripId);
  await run(db, `UPDATE trip_changesets SET undone_at = NULL WHERE id = ?`, target.id);
  const row = await insertChangeset(db, tripId, {
    baseRevision: fields.expectedRevision,
    resultRevision,
    actor: trustedActor,
    instruction: null,
    clientMutationId: fields.clientMutationId,
    kind: "redo",
    operations,
    inverse: JSON.parse(target.inverse_json) as TripStopOp[],
    summary: `Redo — ${applied.summary}`.slice(0, 240),
    reversesId: target.id,
    hash,
    at,
  });
  return { trip: (await getTrip(db, libraryId, tripId))!, changeset: toChangesetView(row), replayed: false, ...(await undoRedoFlags(db, tripId)) };
}

export async function getTripHistory(
  db: D1Database,
  libraryId: string,
  tripId: string,
): Promise<{ changesets: TripChangesetView[]; canUndo: boolean; canRedo: boolean; dismissedAdvisories: TripAdvisoryView[] } | null> {
  if (!(await tripRowOrNull(db, libraryId, tripId))) return null;
  const rows = await all<ChangesetRow>(
    db,
    `SELECT rowid AS row_id, * FROM trip_changesets WHERE trip_id = ? ORDER BY rowid DESC LIMIT 100`,
    tripId,
  );
  return { changesets: rows.map(toChangesetView), ...(await undoRedoFlags(db, tripId)), dismissedAdvisories: (await listDismissedAdvisories(db, libraryId, tripId)) ?? [] };
}

export async function removeTripInference(
  db: D1Database,
  libraryId: string,
  tripId: string,
  inferenceId: string,
  input: unknown,
  at = nowIso(),
): Promise<TripDocument | null> {
  return withTripMutation(db, libraryId, tripId, {
    kind: "remove-inference",
    input,
    payload: { inferenceId },
    at,
    apply: async (_tripRow, when) => {
      const row = await first<{ inferences_json: string }>(db, `SELECT inferences_json FROM trips WHERE id = ?`, tripId);
      const current = row ? parseInferences(row.inferences_json) : [];
      if (!current.some((entry) => entry.id === inferenceId)) throw new RejectedPayload("inference not found in this Trip Document");
      await run(
        db,
        `UPDATE trips SET inferences_json = ?, updated_at = ? WHERE id = ?`,
        JSON.stringify(current.filter((entry) => entry.id !== inferenceId)),
        when,
        tripId,
      );
      return { result: (await getTrip(db, libraryId, tripId))! };
    },
  });
}

export async function dismissTripAdvisory(
  db: D1Database,
  libraryId: string,
  tripId: string,
  advisoryId: string,
  input: unknown,
  at = nowIso(),
): Promise<TripDocument | null> {
  return withTripMutation(db, libraryId, tripId, {
    kind: "dismiss-advisory",
    input,
    payload: { advisoryId },
    at,
    apply: async (_tripRow, when) => {
      const row = await first<{ id: string; dismissed_at: string | null }>(
        db,
        `SELECT id, dismissed_at FROM trip_advisories WHERE trip_id = ? AND id = ?`,
        tripId,
        advisoryId,
      );
      if (!row) throw new RejectedPayload("advisory not found in this Trip Document");
      if (!row.dismissed_at) {
        await run(db, `UPDATE trip_advisories SET dismissed_at = ? WHERE id = ?`, when, advisoryId);
      }
      return { result: (await getTrip(db, libraryId, tripId))! };
    },
  });
}

export async function armReviewIntent(
  db: D1Database,
  libraryId: string,
  sessionId: string,
  tripId: string,
  at = nowIso(),
): Promise<{ revision: number } | null> {
  const tripRow = await first<{ revision: number }>(db, `SELECT revision FROM trips WHERE library_id = ? AND id = ?`, libraryId, tripId);
  if (!tripRow) return null;
  await run(db, `DELETE FROM trip_review_intents WHERE library_id = ? AND session_id = ? AND trip_id = ?`, libraryId, sessionId, tripId);
  await run(
    db,
    `INSERT INTO trip_review_intents (library_id, session_id, trip_id, revision, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
    libraryId,
    sessionId,
    tripId,
    tripRow.revision,
    Date.now() + INTENT_TTL_MS,
    at,
  );
  return { revision: tripRow.revision };
}

async function applyTripReview(
  db: D1Database,
  libraryId: string,
  tripId: string,
  review: TripReviewInput,
  actor: string,
  at: string,
): Promise<{ trip: TripDocument; replayed: boolean } | null> {
  const hash = sha256(JSON.stringify({ kind: "review", expectedRevision: review.expectedRevision, flags: review.flags }));
  const tripRow = await tripRowOrNull(db, libraryId, tripId);
  if (!tripRow) return null;
  const existing = await first<AdvisoryRow>(
    db,
    `SELECT * FROM trip_advisories WHERE trip_id = ? AND client_mutation_id = ? LIMIT 1`,
    tripId,
    review.clientMutationId,
  );
  if (existing) {
    if (existing.payload_hash !== hash) throw new RejectedPayload("clientMutationId was already used for a different review");
    return { trip: (await getTrip(db, libraryId, tripId))!, replayed: true };
  }
  if (tripRow.revision !== review.expectedRevision) {
    throw new TripConflict(`expected revision ${review.expectedRevision} but the Trip Document is at revision ${tripRow.revision}`);
  }
  for (const flag of review.flags) {
    for (const dayId of flag.dayRefs) await requireDayRow(db, tripId, dayId);
    for (const stopId of flag.stopRefs) await requireStopRow(db, tripId, stopId);
  }
  for (const flag of review.flags) {
    await run(
      db,
      `INSERT INTO trip_advisories (id, trip_id, reviewed_revision, category, severity, opinion, rationale, day_refs_json, stop_refs_json, actor, client_mutation_id, payload_hash, created_at, dismissed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
      crypto.randomUUID(),
      tripId,
      review.expectedRevision,
      flag.category,
      flag.severity,
      flag.opinion,
      flag.rationale,
      JSON.stringify(flag.dayRefs),
      JSON.stringify(flag.stopRefs),
      actor,
      review.clientMutationId,
      hash,
      at,
    );
  }
  return { trip: (await getTrip(db, libraryId, tripId))!, replayed: false };
}

export async function recordAgentReview(
  db: D1Database,
  libraryId: string,
  sessionId: string,
  tripId: string,
  input: unknown,
  at = nowIso(),
): Promise<{ trip: TripDocument; replayed: boolean } | null> {
  if (!(await first<{ ok: number }>(db, `SELECT 1 AS ok FROM trips WHERE library_id = ? AND id = ?`, libraryId, tripId))) return null;
  const intent = await first<{ revision: number; expires_at: number }>(
    db,
    `SELECT revision, expires_at FROM trip_review_intents WHERE library_id = ? AND session_id = ? AND trip_id = ?`,
    libraryId,
    sessionId,
    tripId,
  );
  if (!intent) throw new ReviewIntentError("review intent required for this session and Trip");
  if (intent.expires_at < Date.now()) throw new ReviewIntentError("review intent expired");
  const review = validateTripReview(input);
  if (intent.revision !== review.expectedRevision) {
    throw new TripConflict(`expected revision ${review.expectedRevision} but the review intent is for revision ${intent.revision}`);
  }
  const result = await applyTripReview(db, libraryId, tripId, review, "agent", at);
  if (!result) return null;
  await run(db, `DELETE FROM trip_review_intents WHERE library_id = ? AND session_id = ? AND trip_id = ?`, libraryId, sessionId, tripId);
  return result;
}

// Snapshot and stop types come from core/trip-share-html.ts — the same
// definitions the local server and the public renderer use.
export type ShareState = { revision: number; updatedAt: string };

function stopView(stop: TripStop): Omit<ShareStopView, "coordinates"> | null {
  if (stop.state === "draft") return null;
  const kind = stop.content.kind;
  const name =
    kind === "outside"
      ? stop.content.title
      : kind === "hole"
        ? stop.content.request
        : stop.resolved?.kind === "item"
          ? stop.resolved.title
          : stop.resolved?.kind === "place"
            ? stop.resolved.name
            : null;
  if (!name) return null;
  return {
    name,
    kind,
    timeWindow: stop.timeWindow,
    durationMinutes: stop.durationMinutes,
    notes: stop.publicNotes.trim() || null,
    sourceUrl:
      kind === "outside" ? stop.content.url : kind === "item" && stop.resolved?.kind === "item" ? stop.resolved.url : null,
    location: stop.resolved?.kind === "place" ? stop.resolved.location : null,
  };
}

async function prepareShareSnapshot(db: D1Database, trip: TripDocument): Promise<ShareSnapshot> {
  const shareStop = async (stop: TripStop): Promise<ShareStopView | null> => {
    const view = stopView(stop);
    if (!view) return null;
    const coordinates =
      stop.content.kind === "place" ? await getPlaceCoordinates(db, trip.libraryId, stop.content.placeId) : null;
    return { ...view, coordinates };
  };
  return {
    title: trip.title,
    destination: trip.destination,
    startDate: trip.startDate,
    endDate: trip.endDate,
    durationDays: trip.durationDays,
    timezone: trip.timezone,
    days: await Promise.all(
      trip.days.map(async (day) => ({
        label: day.label,
        date: day.date,
        stops: (await Promise.all(day.stops.map(shareStop))).filter((stop): stop is ShareStopView => stop !== null),
      })),
    ),
    unscheduled: (await Promise.all(trip.unscheduled.map(shareStop))).filter((stop): stop is ShareStopView => stop !== null),
  };
}

function snapshotDigest(snapshot: ShareSnapshot): string {
  return sha256(JSON.stringify(snapshot));
}

function previewDigestOf(input: unknown): string | null {
  const rec = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
  const digest = typeof rec.digest === "string" ? rec.digest.trim().toLowerCase() : "";
  return /^[0-9a-f]{64}$/.test(digest) ? digest : null;
}

function randomToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let bin = "";
  for (const byte of bytes) bin += String.fromCharCode(byte);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

/** Public lookup by raw share token, for GET /s/:token. Revoked and unknown
 * tokens are the same "no itinerary payload" result. */
export async function findSharedSnapshot(
  db: D1Database,
  token: string,
): Promise<{ snapshot: ShareSnapshot; revision: number; updatedAt: string } | null> {
  const trimmed = token.trim();
  if (!trimmed || trimmed.length > 128) return null;
  const row = await first<{ trip_revision: number; snapshot_json: string; updated_at: string; revoked_at: string | null }>(
    db,
    `SELECT trip_revision, snapshot_json, updated_at, revoked_at FROM trip_share_snapshots WHERE token_hash = ?`,
    sha256(trimmed),
  );
  if (!row || row.revoked_at) return null;
  return {
    snapshot: JSON.parse(row.snapshot_json) as ShareSnapshot,
    revision: row.trip_revision,
    updatedAt: row.updated_at,
  };
}

export async function getShareState(db: D1Database, libraryId: string, tripId: string): Promise<ShareState | null> {
  const trip = await getTrip(db, libraryId, tripId);
  if (!trip) return null;
  const row = await first<{ trip_revision: number; updated_at: string; revoked_at: string | null }>(
    db,
    `SELECT trip_revision, updated_at, revoked_at FROM trip_share_snapshots WHERE trip_id = ?`,
    tripId,
  );
  if (!row || row.revoked_at) return null;
  return { revision: row.trip_revision, updatedAt: row.updated_at };
}

export async function previewShareSnapshot(
  db: D1Database,
  libraryId: string,
  tripId: string,
): Promise<{ snapshot: ShareSnapshot; digest: string; revision: number; shared: ShareState | null } | null> {
  const trip = await getTrip(db, libraryId, tripId);
  if (!trip) return null;
  const snapshot = await prepareShareSnapshot(db, trip);
  return { snapshot, digest: snapshotDigest(snapshot), revision: trip.revision, shared: await getShareState(db, libraryId, tripId) };
}

export async function publishShareSnapshot(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  at = nowIso(),
): Promise<{ token: string | null; snapshot: ShareSnapshot; revision: number; updatedAt: string } | null> {
  return withTripMutation(db, libraryId, tripId, {
    kind: "share-publish",
    input,
    payload: { digest: previewDigestOf(input) },
    at,
    apply: async (_tripRow, when) => {
      const bound = previewDigestOf(input);
      if (!bound) throw new RejectedPayload("share publish requires the preview digest");
      const trip = (await getTrip(db, libraryId, tripId))!;
      const snapshot = await prepareShareSnapshot(db, trip);
      if (snapshotDigest(snapshot) !== bound) throw new TripConflict("share preview is stale; preview the Trip Document again");
      const token = randomToken();
      await run(db, `DELETE FROM trip_share_snapshots WHERE trip_id = ?`, tripId);
      await run(
        db,
        `INSERT INTO trip_share_snapshots (id, trip_id, trip_revision, token_hash, snapshot_json, created_at, updated_at, revoked_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
        crypto.randomUUID(),
        tripId,
        trip.revision,
        sha256(token),
        JSON.stringify(snapshot),
        when,
        when,
      );
      return {
        result: { token, snapshot, revision: trip.revision, updatedAt: when },
        receipt: { token: null, snapshot, revision: trip.revision, updatedAt: when },
      };
    },
  });
}

export async function revokeShareSnapshot(
  db: D1Database,
  libraryId: string,
  tripId: string,
  input: unknown,
  at = nowIso(),
): Promise<boolean | null> {
  return withTripMutation(db, libraryId, tripId, {
    kind: "share-revoke",
    input,
    at,
    apply: async (_tripRow, when) => {
      const result = await run(
        db,
        `UPDATE trip_share_snapshots SET revoked_at = ? WHERE trip_id = ? AND revoked_at IS NULL`,
        when,
        tripId,
      );
      return { result: Number(result.meta.changes ?? 0) > 0 };
    },
  });
}
