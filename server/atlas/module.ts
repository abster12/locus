import { createHash } from "node:crypto";
import type { Db } from "../../db/open.ts";
import { newId, nowIso, tx } from "../../db/open.ts";
import { MissingResource } from "../../core/commands.ts";
import { getSetting, setSetting } from "../../core/commands.ts";
import { getItem, type ItemCard } from "../../core/library.ts";
import { RejectedPayload, sanitizeText } from "../../core/sanitize.ts";
import { tagsForShelf } from "../../core/categories.ts";
import { LOCAL_LIBRARY_ID } from "../reading/policy.ts";
import {
  ATLAS_BATCH,
  ANALYZER_POLICY_VERSION,
  SCREENING_POLICY_VERSION,
  TRAVEL_OVERRIDE_CURSOR_SETTING,
  TRAVEL_OVERRIDE_POLICY_VERSION,
  TRAVEL_OVERRIDE_VERSION_SETTING,
  BACKFILL_BATCH,
  BACKFILL_DONE,
  BACKFILL_SETTING,
  BACKFILL_VERSION_SETTING,
  HOME_SETTING,
  MAX_PLACE_SEARCH,
  MAX_ATLAS_ATTEMPTS,
  MAX_REVIEW_PREVIEW,
  decideOutcome,
  emptyPayload,
  foldName,
  mapKind,
  normalizeSource,
  parseKind,
  parsePayload,
  placeAccent,
  repairProposal,
  sanitizePlaceName,
  validateAssignmentPayload,
  validateProposal,
  type AssignmentActor,
  type AssignmentOutcome,
  type AssignmentPayload,
  type AtlasProposal,
  type DestinationCandidate,
  type PlaceKind,
} from "./policy.ts";

export { LOCAL_LIBRARY_ID } from "../reading/policy.ts";
export {
  ANALYZER_POLICY_VERSION,
  SCREENING_POLICY_VERSION,
  TRAVEL_OVERRIDE_CURSOR_SETTING,
  TRAVEL_OVERRIDE_POLICY_VERSION,
  TRAVEL_OVERRIDE_VERSION_SETTING,
  BACKFILL_SETTING,
  BACKFILL_VERSION_SETTING,
  HOME_SETTING,
  MAX_PLACE_SEARCH,
  MAX_REVIEW_PREVIEW,
  foldName,
  placeAccent,
  sanitizePlaceName,
  validateProposal,
} from "./policy.ts";
export type {
  AssignmentActor,
  AssignmentOutcome,
  AtlasProposal,
  DestinationCandidate,
  EvidenceSpan,
  PlaceKind,
} from "./policy.ts";

export class AtlasConflict extends Error {
  readonly code = "conflict";
  constructor(message: string) {
    super(message);
    this.name = "AtlasConflict";
  }
}

export type PlaceView = {
  id: string;
  name: string;
  kind: PlaceKind;
  parentId: string | null;
  ancestors: { id: string; name: string }[];
  altNames: string[];
  accent: { color: string; ink: string };
};

export type AtlasAssignmentView = {
  id: string;
  itemId: string;
  outcome: AssignmentOutcome;
  actor: AssignmentActor;
  version: number;
  sourceRevision: string;
  sourceChanged: boolean;
  primary: PlaceView | null;
  contained: PlaceView[];
  mentioned: PlaceView[];
  peers: PlaceView[];
  suggestions: DestinationCandidate[];
};

export type AtlasCard = { item: ItemCard; assignment: AtlasAssignmentView };
export type ReviewRow = {
  item: ItemCard;
  assignment: AtlasAssignmentView | null;
};

export type DestinationSection = {
  id: string;
  title: string;
  kind: "around_home" | "destination";
  placeId: string | null;
  count: number;
  contained: string[];
  items: AtlasCard[];
};

export type AtlasProjection = {
  home: { place: PlaceView | null };
  analysis: { queued: number; failed: number; backfillDone: boolean };
  needsPlace: { count: number; preview: ReviewRow[]; items: ReviewRow[] };
  multiple: AtlasCard[];
  destinations: DestinationSection[];
  counts: { items: number; destinations: number };
};

type PlaceRow = {
  id: string;
  library_id: string;
  name: string;
  kind: PlaceKind;
  parent_id: string | null;
  alt_names: string;
  created_at: string;
  updated_at: string;
};

type AssignmentRow = {
  id: string;
  library_id: string;
  item_id: string;
  outcome: AssignmentOutcome;
  actor: AssignmentActor;
  primary_place_id: string | null;
  source_revision: string;
  write_version: number;
  payload_json: string;
  created_at: string;
  updated_at: string;
};

type AttemptRow = {
  item_id: string;
  source_revision: string;
  analyzer_version: number;
  status: "queued" | "running" | "succeeded" | "failed";
  retryable: number;
  attempt_count: number;
  failure_reason: string | null;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
};

export type AtlasScreeningDecision = { atlasCandidate: boolean };
export type AtlasScreeningItem = {
  id: string;
  title: string | null;
  body: string | null;
  url: string;
  tags: string[];
};

type ScreeningRow = {
  item_id: string;
  source_revision: string;
  screening_version: number;
  status: "queued" | "running" | "succeeded" | "failed";
  candidate: number | null;
  retryable: number;
  attempt_count: number;
  failure_reason: string | null;
  next_attempt_at: string | null;
  lease_expires_at: string | null;
};

export function sourceRevision(title: string | null | undefined, body: string | null | undefined): string {
  const source = normalizeSource(title, body);
  return createHash("sha256").update(`${source.title}\n${source.body}`, "utf8").digest("hex");
}

/** Revision of the input seen by the batched screen. Unlike sourceRevision,
 * this deliberately includes normalized tags because a tag can change Atlas
 * eligibility without changing the saved caption. Assignment provenance and
 * sourceChanged continue to use sourceRevision only. */
export function screeningInputRevision(
  title: string | null | undefined,
  body: string | null | undefined,
  tags: readonly string[] = [],
): string {
  const source = normalizeSource(title, body);
  const normalizedTags = [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))].sort();
  return createHash("sha256").update(`${source.title}\n${source.body}\n${normalizedTags.join("\n")}`, "utf8").digest("hex");
}

export function getAtlasProjection(db: Db, libraryId = LOCAL_LIBRARY_ID): AtlasProjection {
  const places = loadPlaces(db, libraryId);
  const byId = new Map(places.map((place) => [place.id, place]));
  const homeId = getSetting(db, HOME_SETTING);
  const home = homeId && byId.has(homeId) ? viewPlace(byId.get(homeId)!, byId) : null;
  const assignments = loadAssignments(db, libraryId);
  const assigned = new Set(assignments.map((row) => row.item_id));
  const cards: AtlasCard[] = [];
  const review: ReviewRow[] = [];
  const multiple: AtlasCard[] = [];
  for (const row of assignments) {
    const item = presentItem(getItem(db, row.item_id));
    if (!item) continue;
    const view = viewAssignment(db, row, item, byId);
    if (row.outcome === "not_atlas") continue;
    if (row.outcome === "needs_place") review.push({ item, assignment: view });
    else if (row.outcome === "multiple") multiple.push({ item, assignment: view });
    else cards.push({ item, assignment: view });
  }
  for (const itemId of travelItemIds(db)) {
    if (assigned.has(itemId)) continue;
    const item = presentItem(getItem(db, itemId));
    if (item) review.push({ item, assignment: null });
  }
  review.sort(compareReview);
  cards.sort(compareCard);
  multiple.sort(compareCard);
  const destinations = groupDestinations(cards, home, byId);
  const atlasItems = new Set([
    ...cards.map((row) => row.item.id),
    ...multiple.map((row) => row.item.id),
    ...review.map((row) => row.item.id),
  ]);
  return {
    home: { place: home },
    analysis: atlasQueueStats(db, libraryId),
    needsPlace: { count: review.length, preview: review.slice(0, MAX_REVIEW_PREVIEW), items: review },
    multiple,
    destinations,
    counts: { items: atlasItems.size, destinations: destinations.length },
  };
}

export function searchPlaces(db: Db, libraryId: string, q: string): PlaceView[] {
  const needle = foldName(q.trim().slice(0, MAX_PLACE_SEARCH));
  const places = loadPlaces(db, libraryId);
  const byId = new Map(places.map((place) => [place.id, place]));
  const ranked = (!needle ? places : places.filter((place) => foldName(place.name).includes(needle) || altNames(place).some((name) => foldName(name).includes(needle))))
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return ranked.map((place) => viewPlace(place, byId));
}

/** Library-scoped single-place projection for referencing modules (Trips).
 * Returns null for unknown ids and for ids owned by another Library. */
export function getPlaceView(db: Db, libraryId: string, placeId: string): PlaceView | null {
  const place = getPlace(db, libraryId, placeId);
  if (!place) return null;
  return viewPlace(place, mapPlaces(loadPlaces(db, libraryId)));
}

export function createPlace(
  db: Db,
  libraryId: string,
  input: { name: string; kind?: string; parentId?: string | null; altNames?: string[] },
  now = nowIso(),
): PlaceView {
  return tx(db, () => {
    const row = insertPlace(db, libraryId, sanitizePlaceName(input.name), parseKind(input.kind ?? "place"), input.parentId ?? null, input.altNames ?? [], now);
    return viewPlace(row, mapPlaces(loadPlaces(db, libraryId)));
  });
}

export function deletePlace(db: Db, libraryId: string, placeId: string): void {
  tx(db, () => {
    const place = getPlace(db, libraryId, placeId);
    if (!place) throw new MissingResource("place");
    if (placeReferenced(db, libraryId, placeId)) throw new RejectedPayload("place is still referenced");
    db.prepare(`DELETE FROM atlas_places WHERE library_id = ? AND id = ?`).run(libraryId, placeId);
  });
}

export function setHomeBase(db: Db, libraryId: string, placeId: string | null): PlaceView | null {
  if (!placeId) {
    db.prepare(`DELETE FROM settings WHERE key = ?`).run(HOME_SETTING);
    return null;
  }
  const places = loadPlaces(db, libraryId);
  const place = places.find((row) => row.id === placeId);
  if (!place) throw new MissingResource("place");
  setSetting(db, HOME_SETTING, placeId);
  return viewPlace(place, mapPlaces(places));
}

export function applyProposal(db: Db, libraryId: string, itemId: string, raw: unknown, now = nowIso()): AtlasAssignmentView | null {
  return tx(db, () => {
    const item = requireItem(db, itemId);
    const source = normalizeSource(item.title, item.body);
    const revision = sourceRevision(item.title, item.body);
    const existing = loadAssignment(db, libraryId, itemId);
    const attempt = loadAttempt(db, itemId);
    if (existing?.actor === "user") {
      return viewAssignment(db, existing, item, mapPlaces(loadPlaces(db, libraryId)));
    }
    if (
      existing?.actor === "analyzer" &&
      existing.source_revision === revision &&
      attempt?.analyzer_version === ANALYZER_POLICY_VERSION &&
      attempt.status === "succeeded"
    ) {
      markAttempt(db, libraryId, itemId, revision, "succeeded", now);
      return viewAssignment(db, existing, item, mapPlaces(loadPlaces(db, libraryId)));
    }
    const prior = existing;
    const travel = itemHasTravelTag(db, itemId);
    try {
      if (!source.title && !source.body) {
        markAttempt(db, libraryId, itemId, revision, "succeeded", now);
        return existing ? viewAssignment(db, existing, item, mapPlaces(loadPlaces(db, libraryId))) : null;
      }
      const proposal = validateProposal(repairProposal(raw, itemId, source.title, source.body), itemId, source.title, source.body);
      // Travel is a deliberately high-recall topic hint. The interpreter can
      // still return a useful `not_atlas` result for a non-Travel save, but a
      // Travel-tagged Item must stay reviewable rather than disappearing from
      // Atlas. Preserve any primary suggestions in the needs_place payload.
      const outcome = travel && proposal.relevance === "not_atlas" ? "needs_place" : decideOutcome(proposal);
      const built = buildPayload(db, libraryId, outcome, proposal, now);
      const row = writeAssignment(db, libraryId, itemId, {
        outcome,
        actor: "analyzer",
        primaryPlaceId: built.primaryPlaceId,
        revision,
        payload: built.payload,
        now,
        existing,
      });
      markAttempt(db, libraryId, itemId, revision, "succeeded", now);
      return viewAssignment(db, row, item, mapPlaces(loadPlaces(db, libraryId)));
    } catch (error) {
      if (travel && error instanceof RejectedPayload && (!prior || (prior.actor === "analyzer" && prior.outcome === "not_atlas"))) {
        const row = writeAssignment(db, libraryId, itemId, {
          outcome: "needs_place",
          actor: "analyzer",
          primaryPlaceId: null,
          revision,
          payload: emptyPayload(),
          now,
          existing,
        });
        markAttempt(db, libraryId, itemId, revision, "succeeded", now);
        return viewAssignment(db, row, item, mapPlaces(loadPlaces(db, libraryId)));
      }
      if (prior) writeAssignment(db, libraryId, itemId, {
        outcome: prior.outcome,
        actor: prior.actor,
        primaryPlaceId: prior.primary_place_id,
        revision: prior.source_revision,
        payload: parsePayload(prior.payload_json),
        now,
        existing: prior,
        bump: false,
      });
      throw error;
    }
  });
}

export function acceptSuggestion(db: Db, libraryId: string, itemId: string, index: number, expectedVersion: number, now = nowIso()): AtlasAssignmentView {
  return tx(db, () => mutateUser(db, libraryId, itemId, expectedVersion, now, (item, existing) => {
    const suggestion = parsePayload(existing?.payload_json ?? "{}").suggestions[index];
    if (!suggestion) throw new RejectedPayload("unknown suggestion");
    const place = ensureFromCandidate(db, libraryId, suggestion, now);
    return placedUser(db, libraryId, item, place.id, now, existing);
  }));
}

export function setExactPlace(
  db: Db,
  libraryId: string,
  itemId: string,
  input: { placeId?: string; name?: string; kind?: string; parentId?: string | null },
  expectedVersion: number,
  now = nowIso(),
): AtlasAssignmentView {
  return tx(db, () => mutateUser(db, libraryId, itemId, expectedVersion, now, (item, existing) => {
    const place = input.placeId
      ? requirePlace(db, libraryId, input.placeId)
      : insertPlace(db, libraryId, sanitizePlaceName(input.name ?? ""), parseKind(input.kind ?? "place"), input.parentId ?? null, [], now);
    return placedUser(db, libraryId, item, place.id, now, existing);
  }));
}

export function markMultiple(db: Db, libraryId: string, itemId: string, expectedVersion: number, now = nowIso()): AtlasAssignmentView {
  return tx(db, () => mutateUser(db, libraryId, itemId, expectedVersion, now, (item, existing) => {
    const payload = existing ? parsePayload(existing.payload_json) : emptyPayload();
    const peers = payload.suggestions.filter((row) => row.role === "primary").map((row) => ensureFromCandidate(db, libraryId, row, now).id);
    return writeAssignment(db, libraryId, itemId, {
      outcome: "multiple",
      actor: "user",
      primaryPlaceId: null,
      revision: sourceRevision(item.title, item.body),
      payload: { ...emptyPayload(), peerPlaceIds: unique(peers.length >= 2 ? peers : payload.peerPlaceIds) },
      now,
      existing,
    });
  }));
}

export function markNotAtlas(db: Db, libraryId: string, itemId: string, expectedVersion: number, now = nowIso()): AtlasAssignmentView {
  return tx(db, () => mutateUser(db, libraryId, itemId, expectedVersion, now, (item, existing) =>
    writeAssignment(db, libraryId, itemId, {
      outcome: "not_atlas",
      actor: "user",
      primaryPlaceId: null,
      revision: sourceRevision(item.title, item.body),
      payload: emptyPayload(),
      now,
      existing,
    })));
}

export function leaveUnresolved(db: Db, libraryId: string, itemId: string, expectedVersion: number, now = nowIso()): AtlasAssignmentView | null {
  return tx(db, () => {
    const item = requireItem(db, itemId);
    const existing = loadAssignment(db, libraryId, itemId);
    assertVersion(existing, expectedVersion);
    if (!existing) return null;
    const row = writeAssignment(db, libraryId, itemId, {
      outcome: "needs_place",
      actor: "user",
      primaryPlaceId: null,
      revision: sourceRevision(item.title, item.body),
      payload: parsePayload(existing.payload_json),
      now,
      existing,
    });
    db.prepare(`DELETE FROM atlas_attempts WHERE item_id = ?`).run(itemId);
    db.prepare(`DELETE FROM atlas_screenings WHERE item_id = ?`).run(itemId);
    return viewAssignment(db, row, item, mapPlaces(loadPlaces(db, libraryId)));
  });
}

export function changePlace(db: Db, libraryId: string, itemId: string, placeId: string, expectedVersion: number, now = nowIso()): AtlasAssignmentView {
  return setExactPlace(db, libraryId, itemId, { placeId }, expectedVersion, now);
}

export function enqueueAtlasItem(db: Db, libraryId: string, itemId: string, now = nowIso()): void {
  enqueueAtlasScreening(db, libraryId, itemId, now);
}

/** Queue the cheap Atlas screen. Capture and source updates use this seam, so
 * Atlas never depends on the manual topic-tag action to discover candidates. */
export function enqueueAtlasScreening(db: Db, libraryId: string, itemId: string, now = nowIso()): void {
  const item = getItem(db, itemId);
  if (!item) return;
  const revision = screeningInputRevision(item.title, item.body, item.tags.map((tag) => tag.name));
  const assignment = loadAssignment(db, libraryId, itemId);
  if (assignment?.actor === "user") return;
  const screening = loadScreening(db, itemId);
  if (screening && screening.source_revision === revision && screening.screening_version === SCREENING_POLICY_VERSION) {
    if (screening.status === "queued" || screening.status === "running") return;
    if (screening.status === "succeeded") {
      if (screening.candidate === 1) enqueueAtlasAnalysis(db, libraryId, itemId, now);
      return;
    }
    if (screening.status === "failed" && !screening.retryable) return;
  }
  db.prepare(
    `INSERT INTO atlas_screenings (
       item_id, library_id, source_revision, screening_version, status, candidate, retryable, attempt_count, failure_reason,
       next_attempt_at, lease_owner, lease_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'queued', NULL, 0, 0, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       source_revision = excluded.source_revision,
       screening_version = excluded.screening_version,
       status = 'queued',
       candidate = NULL,
       retryable = 0,
       failure_reason = NULL,
       next_attempt_at = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(itemId, libraryId, revision, SCREENING_POLICY_VERSION, now, now);
}

export function backfillAtlas(db: Db, libraryId = LOCAL_LIBRARY_ID, now = nowIso()): boolean {
  let cursor = getSetting(db, BACKFILL_SETTING) ?? "";
  const version = getSetting(db, BACKFILL_VERSION_SETTING);
  if (version !== String(SCREENING_POLICY_VERSION)) {
    cursor = "";
    setSetting(db, BACKFILL_SETTING, cursor);
    setSetting(db, BACKFILL_VERSION_SETTING, String(SCREENING_POLICY_VERSION));
  }
  if (cursor === BACKFILL_DONE) return false;
  const rows = (
    cursor
      ? db.prepare(`SELECT id FROM items WHERE id > ? ORDER BY id LIMIT ?`).all(cursor, BACKFILL_BATCH)
      : db.prepare(`SELECT id FROM items ORDER BY id LIMIT ?`).all(BACKFILL_BATCH)
  ) as { id: string }[];
  if (rows.length === 0) {
    setSetting(db, BACKFILL_SETTING, BACKFILL_DONE);
    return false;
  }
  for (const row of rows) {
    enqueueAtlasScreening(db, libraryId, row.id, now);
    cursor = row.id;
    setSetting(db, BACKFILL_SETTING, cursor);
  }
  if (rows.length < BACKFILL_BATCH) {
    setSetting(db, BACKFILL_SETTING, BACKFILL_DONE);
    return false;
  }
  return true;
}

/** One bounded migration for the high-recall Travel override. This deliberately
 * does not invalidate the all-Item screening cursor: only non-user Travel
 * Items are forced back through detailed extraction, once per policy version.
 */
export function backfillTravelAtlas(db: Db, libraryId = LOCAL_LIBRARY_ID, now = nowIso()): boolean {
  let cursor = getSetting(db, TRAVEL_OVERRIDE_CURSOR_SETTING) ?? "";
  const version = getSetting(db, TRAVEL_OVERRIDE_VERSION_SETTING);
  if (version !== String(TRAVEL_OVERRIDE_POLICY_VERSION)) {
    cursor = "";
    setSetting(db, TRAVEL_OVERRIDE_CURSOR_SETTING, cursor);
    setSetting(db, TRAVEL_OVERRIDE_VERSION_SETTING, String(TRAVEL_OVERRIDE_POLICY_VERSION));
  }
  if (cursor === BACKFILL_DONE) return false;

  const travel = travelSelect();
  if (travel.names.length === 0) {
    setSetting(db, TRAVEL_OVERRIDE_CURSOR_SETTING, BACKFILL_DONE);
    return false;
  }
  const where = cursor ? ` AND m.item_id > ?` : "";
  const params = cursor ? [...travel.names, cursor, BACKFILL_BATCH] : [...travel.names, BACKFILL_BATCH];
  const rows = db
    .prepare(
      `SELECT DISTINCT m.item_id AS id
         FROM memberships m JOIN tags t ON t.id = m.target_id
        WHERE m.target_kind = 'tag' AND lower(t.name) IN (${travel.names.map(() => "?").join(", ")})${where}
        ORDER BY m.item_id LIMIT ?`,
    )
    .all(...params) as { id: string }[];
  if (rows.length === 0) {
    setSetting(db, TRAVEL_OVERRIDE_CURSOR_SETTING, BACKFILL_DONE);
    return false;
  }
  for (const row of rows) {
    const assignment = loadAssignment(db, libraryId, row.id);
    if (!assignment || (assignment.actor === "analyzer" && (assignment.outcome === "not_atlas" || assignment.outcome === "needs_place"))) {
      enqueueAtlasAnalysis(db, libraryId, row.id, now, true);
    }
    cursor = row.id;
    setSetting(db, TRAVEL_OVERRIDE_CURSOR_SETTING, cursor);
  }
  if (rows.length < BACKFILL_BATCH) {
    setSetting(db, TRAVEL_OVERRIDE_CURSOR_SETTING, BACKFILL_DONE);
    return false;
  }
  return true;
}

export function retryAtlasAnalysis(db: Db, libraryId: string, itemId: string, now = nowIso()): void {
  const item = db.prepare(`SELECT title, body FROM items WHERE id = ?`).get(itemId) as { title: string | null; body: string | null } | undefined;
  if (!item) throw new MissingResource("item");
  const assignment = loadAssignment(db, libraryId, itemId);
  if (assignment?.actor === "user") return;
  // An explicit retry is the one escape hatch from a negative/unknown screen.
  // Removing that screen does not manufacture a screen result; the detailed
  // interpreter is simply allowed to run once at the user's request.
  db.prepare(`DELETE FROM atlas_screenings WHERE item_id = ?`).run(itemId);
  enqueueAtlasAnalysis(db, libraryId, itemId, now, true);
}

export function enqueueAtlasAnalysis(db: Db, libraryId: string, itemId: string, now = nowIso(), force = false): void {
  const item = db.prepare(`SELECT title, body FROM items WHERE id = ?`).get(itemId) as { title: string | null; body: string | null } | undefined;
  if (!item) return;
  const assignment = loadAssignment(db, libraryId, itemId);
  if (assignment?.actor === "user") return;
  const revision = sourceRevision(item.title, item.body);
  const attempt = loadAttempt(db, itemId);
  if (!force && attempt && attempt.source_revision === revision && attempt.analyzer_version === ANALYZER_POLICY_VERSION) {
    if (attempt.status === "queued" || attempt.status === "succeeded" || attempt.status === "running") return;
    if (attempt.status === "failed" && !attempt.retryable) return;
  }
  db.prepare(
    `INSERT INTO atlas_attempts (
       item_id, library_id, source_revision, analyzer_version, status, retryable, attempt_count, failure_reason,
       next_attempt_at, lease_owner, lease_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, 'queued', 0, 0, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       source_revision = excluded.source_revision,
       analyzer_version = excluded.analyzer_version,
       status = 'queued',
       retryable = 0,
       failure_reason = NULL,
       next_attempt_at = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(itemId, libraryId, revision, ANALYZER_POLICY_VERSION, now, now);
}

export function claimAtlasScreeningBatch(
  db: Db,
  libraryId: string,
  now = nowIso(),
  leaseOwner = "atlas-screen",
  leaseMs = 60_000,
  limit = ATLAS_BATCH,
): string[] {
  const rows = db.prepare(
    `SELECT item_id FROM atlas_screenings
      WHERE library_id = ?
        AND (
          (status = 'queued')
          OR (status = 'failed' AND retryable = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
          OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
        )
      ORDER BY updated_at ASC, item_id ASC LIMIT ?`,
  ).all(libraryId, now, now, limit) as { item_id: string }[];
  const expires = new Date(Date.parse(now) + leaseMs).toISOString();
  const update = db.prepare(
    `UPDATE atlas_screenings
        SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
      WHERE item_id = ?`,
  );
  for (const row of rows) update.run(leaseOwner, expires, now, row.item_id);
  return rows.map((row) => row.item_id);
}

export function failAtlasScreening(db: Db, itemId: string, reason: string, now = nowIso(), retryable = true): void {
  const screening = loadScreening(db, itemId);
  const delay = Math.min(5 * 60 * 1000, 15_000 * 2 ** Math.max(0, (screening?.attempt_count ?? 1) - 1));
  const next = new Date(Date.parse(now) + delay).toISOString();
  const shouldRetry = retryable && (screening?.attempt_count ?? 0) < MAX_ATLAS_ATTEMPTS;
  db.prepare(
    `UPDATE atlas_screenings
        SET status = 'failed', retryable = ?, failure_reason = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE item_id = ?`,
  ).run(shouldRetry ? 1 : 0, sanitizeText(reason, 200), shouldRetry ? next : null, now, itemId);
}

/** Apply one validated screen and enter detailed extraction for candidates or
 * Travel-tagged Items. A user assignment always wins over the screen. */
export function applyAtlasScreening(
  db: Db,
  libraryId: string,
  itemId: string,
  result: AtlasScreeningDecision,
  now = nowIso(),
  expectedScreeningInputRevision?: string,
): void {
  tx(db, () => {
    const item = requireItem(db, itemId);
    if (typeof result.atlasCandidate !== "boolean") throw new RejectedPayload("invalid atlas screening");
    const revision = screeningInputRevision(item.title, item.body, item.tags.map((tag) => tag.name));
    const existing = loadAssignment(db, libraryId, itemId);
    const priorScreening = loadScreening(db, itemId);
    // A capture can update an Item while the provider is thinking. Never
    // attach that stale batch result to the new revision; leave it queued for
    // a fresh screen instead.
    if (expectedScreeningInputRevision && expectedScreeningInputRevision !== revision) {
      if (existing?.actor === "user") {
        db.prepare(`DELETE FROM atlas_screenings WHERE item_id = ?`).run(itemId);
        return;
      }
      enqueueAtlasScreening(db, libraryId, itemId, now);
      return;
    }
    if (!expectedScreeningInputRevision && priorScreening && priorScreening.source_revision !== revision) {
      if (existing?.actor === "user") {
        db.prepare(`DELETE FROM atlas_screenings WHERE item_id = ?`).run(itemId);
        return;
      }
      enqueueAtlasScreening(db, libraryId, itemId, now);
      return;
    }
    const screeningRefresh = !priorScreening || priorScreening.source_revision !== revision || priorScreening.screening_version !== SCREENING_POLICY_VERSION;
    db.prepare(
      `INSERT INTO atlas_screenings (
         item_id, library_id, source_revision, screening_version, status, candidate, retryable, attempt_count,
         failure_reason, next_attempt_at, lease_owner, lease_expires_at, created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'succeeded', ?, 0, 1, NULL, NULL, NULL, NULL, ?, ?)
       ON CONFLICT(item_id) DO UPDATE SET
         source_revision = excluded.source_revision,
         screening_version = excluded.screening_version,
         status = 'succeeded',
         candidate = excluded.candidate,
         retryable = 0,
         failure_reason = NULL,
         next_attempt_at = NULL,
         lease_owner = NULL,
         lease_expires_at = NULL,
         updated_at = excluded.updated_at`,
    ).run(itemId, libraryId, revision, SCREENING_POLICY_VERSION, result.atlasCandidate ? 1 : 0, now, now);

    if (existing?.actor === "user") {
      db.prepare(`DELETE FROM atlas_attempts WHERE item_id = ?`).run(itemId);
      return;
    }
    const travel = itemHasTravelTag(db, itemId);
    if (result.atlasCandidate || travel) {
      enqueueAtlasAnalysis(db, libraryId, itemId, now, screeningRefresh);
      // If a prior automatic negative is already suppressing this Travel
      // Item, expose the conservative review fallback immediately while the
      // detailed pass runs. User assignments were handled above.
      if (travel && existing?.actor === "analyzer" && existing.outcome === "not_atlas") {
        writeAssignment(db, libraryId, itemId, {
          outcome: "needs_place",
          actor: "analyzer",
          primaryPlaceId: null,
          revision: sourceRevision(item.title, item.body),
          payload: emptyPayload(),
          now,
          existing,
        });
      }
      return;
    }
    db.prepare(`DELETE FROM atlas_attempts WHERE item_id = ?`).run(itemId);
    writeAssignment(db, libraryId, itemId, {
      outcome: "not_atlas",
      actor: "analyzer",
      primaryPlaceId: null,
      revision: sourceRevision(item.title, item.body),
      payload: emptyPayload(),
      now,
      existing,
    });
  });
}

export function claimAtlasBatch(
  db: Db,
  libraryId: string,
  now = nowIso(),
  leaseOwner = "atlas",
  leaseMs = 60_000,
  limit = ATLAS_BATCH,
): string[] {
  const travel = travelSelect();
  const travelGate = travel.names.length
    ? `OR EXISTS (
            SELECT 1 FROM memberships mt JOIN tags tt ON tt.id = mt.target_id
             WHERE mt.item_id = atlas_attempts.item_id AND mt.target_kind = 'tag'
               AND lower(tt.name) IN (${travel.names.map(() => "?").join(", ")})
          )`
    : "";
  const rows = db
    .prepare(
      `SELECT item_id FROM atlas_attempts
        WHERE library_id = ?
          AND NOT EXISTS (
            SELECT 1 FROM atlas_assignments a
             WHERE a.item_id = atlas_attempts.item_id AND a.actor = 'user'
          )
          AND (
            NOT EXISTS (SELECT 1 FROM atlas_screenings s WHERE s.item_id = atlas_attempts.item_id)
            OR EXISTS (
              SELECT 1 FROM atlas_screenings s
               WHERE s.item_id = atlas_attempts.item_id
                 AND s.status = 'succeeded' AND s.candidate = 1
            )
            ${travelGate}
          )
          AND (
            status = 'queued'
            OR (status = 'failed' AND retryable = 1 AND (next_attempt_at IS NULL OR next_attempt_at <= ?))
            OR (status = 'running' AND (lease_expires_at IS NULL OR lease_expires_at <= ?))
          )
        ORDER BY updated_at ASC, item_id ASC
        LIMIT ?`,
    )
    .all(libraryId, ...travel.names, now, now, limit) as { item_id: string }[];
  const expires = new Date(Date.parse(now) + leaseMs).toISOString();
  const update = db.prepare(
    `UPDATE atlas_attempts
        SET status = 'running', lease_owner = ?, lease_expires_at = ?, attempt_count = attempt_count + 1, updated_at = ?
      WHERE item_id = ?`,
  );
  for (const row of rows) update.run(leaseOwner, expires, now, row.item_id);
  return rows.map((row) => row.item_id);
}

export function failAtlasAttempt(db: Db, itemId: string, reason: string, now = nowIso(), retryable = true): void {
  const attempt = loadAttempt(db, itemId);
  const delay = Math.min(5 * 60 * 1000, 15_000 * 2 ** Math.max(0, (attempt?.attempt_count ?? 1) - 1));
  const next = new Date(Date.parse(now) + delay).toISOString();
  const shouldRetry = retryable && (attempt?.attempt_count ?? 0) < MAX_ATLAS_ATTEMPTS;
  db.prepare(
    `UPDATE atlas_attempts
        SET status = 'failed', retryable = ?, failure_reason = ?, next_attempt_at = ?, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
      WHERE item_id = ?`,
  ).run(shouldRetry ? 1 : 0, sanitizeText(reason, 200), shouldRetry ? next : null, now, itemId);
}

export function atlasQueueStats(db: Db, libraryId: string): {
  queued: number;
  failed: number;
  screeningQueued: number;
  screeningFailed: number;
  screeningPending: number;
  analysisQueued: number;
  analysisFailed: number;
  analysisPending: number;
  backfillDone: boolean;
} {
  const screeningQueued = db.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings WHERE library_id = ? AND status IN ('queued', 'running')`).get(libraryId) as { n: number };
  const screeningFailed = db.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings WHERE library_id = ? AND status = 'failed'`).get(libraryId) as { n: number };
  const screeningPending = db.prepare(`SELECT COUNT(*) AS n FROM atlas_screenings WHERE library_id = ? AND (status IN ('queued', 'running') OR (status = 'failed' AND retryable = 1))`).get(libraryId) as { n: number };
  const analysisQueued = db.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE library_id = ? AND status IN ('queued', 'running')`).get(libraryId) as { n: number };
  const analysisFailed = db.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE library_id = ? AND status = 'failed'`).get(libraryId) as { n: number };
  const analysisPending = db.prepare(`SELECT COUNT(*) AS n FROM atlas_attempts WHERE library_id = ? AND (status IN ('queued', 'running') OR (status = 'failed' AND retryable = 1))`).get(libraryId) as { n: number };
  return {
    queued: Number(screeningQueued?.n ?? 0) + Number(analysisQueued?.n ?? 0),
    failed: Number(screeningFailed?.n ?? 0) + Number(analysisFailed?.n ?? 0),
    screeningQueued: Number(screeningQueued?.n ?? 0),
    screeningFailed: Number(screeningFailed?.n ?? 0),
    screeningPending: Number(screeningPending?.n ?? 0),
    analysisQueued: Number(analysisQueued?.n ?? 0),
    analysisFailed: Number(analysisFailed?.n ?? 0),
    analysisPending: Number(analysisPending?.n ?? 0),
    backfillDone: (getSetting(db, BACKFILL_SETTING) ?? "") === BACKFILL_DONE,
  };
}

export function atlasLibraryIsEmpty(db: Db, libraryId = LOCAL_LIBRARY_ID): boolean {
  const places = db.prepare(`SELECT COUNT(*) AS n FROM atlas_places WHERE library_id = ?`).get(libraryId) as { n: number };
  const assignments = db.prepare(`SELECT COUNT(*) AS n FROM atlas_assignments WHERE library_id = ?`).get(libraryId) as { n: number };
  return Number(places.n) === 0 && Number(assignments.n) === 0;
}

export function atlasBackfillSettingKey(): string {
  return BACKFILL_SETTING;
}

export function atlasBackfillVersionSettingKey(): string {
  return BACKFILL_VERSION_SETTING;
}

export type AtlasArchiveRecord = Record<string, unknown>;

export function exportAtlasRecords(db: Db, libraryId = LOCAL_LIBRARY_ID): {
  counts: { atlasPlace: number; atlasAssignment: number };
  records: AtlasArchiveRecord[];
} {
  const places = loadPlaces(db, libraryId);
  const assignments = loadAssignments(db, libraryId);
  const records: AtlasArchiveRecord[] = [
    ...places.map((row) => ({
      kind: "atlasPlace",
      id: row.id,
      name: row.name,
      kindName: row.kind,
      parentId: row.parent_id,
      altNames: altNames(row),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
    ...assignments.map((row) => ({
      kind: "atlasAssignment",
      id: row.id,
      itemId: row.item_id,
      outcome: row.outcome,
      actor: row.actor,
      primaryPlaceId: row.primary_place_id,
      sourceRevision: row.source_revision,
      writeVersion: row.write_version,
      payload: parsePayload(row.payload_json),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  ];
  return { counts: { atlasPlace: places.length, atlasAssignment: assignments.length }, records };
}

export function importAtlasRecords(
  db: Db,
  input: {
    places: readonly AtlasArchiveRecord[];
    assignments: readonly AtlasArchiveRecord[];
    itemIds: ReadonlySet<string>;
    libraryId?: string;
  },
): void {
  const libraryId = input.libraryId ?? LOCAL_LIBRARY_ID;
  const placeIds = new Set<string>();
  const ordered = topologicalPlaces(input.places);
  const insPlace = db.prepare(
    `INSERT INTO atlas_places (id, library_id, name, kind, parent_id, alt_names, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const rec of ordered) {
    const id = reqString(rec.id, 80);
    if (placeIds.has(id)) throw new RejectedPayload("duplicate place");
    placeIds.add(id);
    const parentId = rec.parentId == null || rec.parentId === "" ? null : reqString(rec.parentId, 80);
    if (parentId && !placeIds.has(parentId) && parentId !== id) throw new RejectedPayload("missing parent place");
    if (parentId === id) throw new RejectedPayload("place cycle");
    insPlace.run(
      id,
      libraryId,
      sanitizePlaceName(reqString(rec.name, 80)),
      parseKind(rec.kindName ?? rec.kind ?? "place"),
      parentId,
      JSON.stringify(Array.isArray(rec.altNames) ? rec.altNames : []),
      reqString(rec.createdAt, 40),
      reqString(rec.updatedAt, 40),
    );
  }
  const assignmentIds = new Set<string>();
  const ins = db.prepare(
    `INSERT INTO atlas_assignments (
       id, library_id, item_id, outcome, actor, primary_place_id, source_revision, write_version, payload_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const rec of input.assignments) {
    const id = reqString(rec.id, 80);
    if (assignmentIds.has(id)) throw new RejectedPayload("duplicate assignment");
    assignmentIds.add(id);
    const itemId = reqString(rec.itemId, 128);
    if (!input.itemIds.has(itemId)) throw new RejectedPayload("orphan assignment");
    const outcome = rec.outcome;
    const actor = rec.actor;
    if (outcome !== "placed" && outcome !== "needs_place" && outcome !== "multiple" && outcome !== "not_atlas") {
      throw new RejectedPayload("invalid assignment outcome");
    }
    if (actor !== "analyzer" && actor !== "user") throw new RejectedPayload("invalid assignment actor");
    const primaryPlaceId = rec.primaryPlaceId == null ? null : reqString(rec.primaryPlaceId, 80);
    if (outcome === "placed") {
      if (!primaryPlaceId || !placeIds.has(primaryPlaceId)) throw new RejectedPayload("invalid primary place");
    } else if (primaryPlaceId) throw new RejectedPayload("unexpected primary place");
    const item = getItem(db, itemId);
    const payload = validateAssignmentPayload(rec.payload, item?.title ?? "", item?.body ?? "");
    for (const placeId of [...payload.containedPlaceIds, ...payload.mentionedPlaceIds, ...payload.peerPlaceIds]) {
      if (!placeIds.has(placeId)) throw new RejectedPayload("unknown assignment place");
    }
    ins.run(
      id,
      libraryId,
      itemId,
      outcome,
      actor,
      primaryPlaceId,
      reqString(rec.sourceRevision, 80),
      Number.isInteger(rec.writeVersion) ? Number(rec.writeVersion) : 1,
      JSON.stringify(payload),
      reqString(rec.createdAt, 40),
      reqString(rec.updatedAt, 40),
    );
  }
  const home = getSetting(db, HOME_SETTING);
  if (home && !placeIds.has(home) && loadPlaces(db, libraryId).every((place) => place.id !== home)) {
    throw new RejectedPayload("invalid home base");
  }
}

function mutateUser(
  db: Db,
  libraryId: string,
  itemId: string,
  expectedVersion: number,
  now: string,
  write: (item: ItemCard, existing: AssignmentRow | undefined) => AssignmentRow,
): AtlasAssignmentView {
  const item = requireItem(db, itemId);
  const existing = loadAssignment(db, libraryId, itemId);
  assertVersion(existing, expectedVersion);
  const row = write(item, existing);
  // Once a human has acted, any in-flight detailed result is stale work. The
  // assignment remains authoritative and the queue must not keep waking the
  // worker for an item it is no longer allowed to change.
  db.prepare(`DELETE FROM atlas_attempts WHERE item_id = ?`).run(itemId);
  db.prepare(`DELETE FROM atlas_screenings WHERE item_id = ?`).run(itemId);
  return viewAssignment(db, row, item, mapPlaces(loadPlaces(db, libraryId)));
}

function placedUser(db: Db, libraryId: string, item: ItemCard, placeId: string, now: string, existing: AssignmentRow | undefined): AssignmentRow {
  requirePlace(db, libraryId, placeId);
  return writeAssignment(db, libraryId, item.id, {
    outcome: "placed",
    actor: "user",
    primaryPlaceId: placeId,
    revision: sourceRevision(item.title, item.body),
    payload: emptyPayload(),
    now,
    existing,
  });
}

function buildPayload(
  db: Db,
  libraryId: string,
  outcome: AssignmentOutcome,
  proposal: AtlasProposal,
  now: string,
): { primaryPlaceId: string | null; payload: AssignmentPayload } {
  if (outcome === "not_atlas") return { primaryPlaceId: null, payload: emptyPayload() };
  if (outcome === "needs_place") {
    return {
      primaryPlaceId: null,
      payload: { ...emptyPayload(), suggestions: proposal.destinations.filter((row) => row.role === "primary").slice(0, 3) },
    };
  }
  if (outcome === "multiple") {
    const peers = proposal.destinations.filter((row) => row.role === "primary").map((row) => ensureFromCandidate(db, libraryId, row, now).id);
    return { primaryPlaceId: null, payload: { ...emptyPayload(), peerPlaceIds: unique(peers) } };
  }
  const primary = proposal.destinations.find((row) => row.role === "primary");
  if (!primary) return { primaryPlaceId: null, payload: emptyPayload() };
  const place = ensureFromCandidate(db, libraryId, primary, now);
  const contained = proposal.destinations
    .filter((row) => row.role === "contained")
    .map((row) => ensureFromCandidate(db, libraryId, { ...row, parentName: row.parentName ?? primary.name, parentKind: row.parentKind ?? primary.kind }, now).id);
  const mentioned = proposal.destinations
    .filter((row) => row.role === "mentioned")
    .map((row) => ensureFromCandidate(db, libraryId, row, now).id);
  return {
    primaryPlaceId: place.id,
    payload: { ...emptyPayload(), containedPlaceIds: unique(contained), mentionedPlaceIds: unique(mentioned) },
  };
}

function ensureFromCandidate(db: Db, libraryId: string, candidate: DestinationCandidate, now: string): PlaceRow {
  let parentId: string | null = null;
  if (candidate.parentName) {
    const parents = findNamed(db, libraryId, candidate.parentName);
    const uniqueParent = parents.length === 1 ? parents[0] : parents.find((row) => row.parent_id == null);
    if (uniqueParent && parents.filter((row) => row.parent_id == null).length <= 1) parentId = uniqueParent.id;
    else if (parents.length === 0) {
      parentId = insertPlace(db, libraryId, candidate.parentName, candidate.parentKind ?? "place", null, [], now).id;
    }
  }
  return insertPlace(db, libraryId, candidate.name, candidate.kind, parentId, candidate.altNames, now);
}

function insertPlace(db: Db, libraryId: string, name: string, kind: PlaceKind, parentId: string | null, alt: string[], now: string): PlaceRow {
  if (parentId) {
    const parent = getPlace(db, libraryId, parentId);
    if (!parent) throw new MissingResource("place");
  }
  const existing = findAtParent(db, libraryId, name, parentId);
  if (existing) {
    const names = unique([...altNames(existing), ...alt, name].filter((value) => foldName(value) !== foldName(existing.name)));
    if (names.join("\0") !== altNames(existing).join("\0")) {
      db.prepare(`UPDATE atlas_places SET alt_names = ?, updated_at = ? WHERE id = ?`).run(JSON.stringify(names), now, existing.id);
      return { ...existing, alt_names: JSON.stringify(names), updated_at: now };
    }
    return existing;
  }
  const id = newId();
  db.prepare(
    `INSERT INTO atlas_places (id, library_id, name, kind, parent_id, alt_names, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, libraryId, name, mapKind(kind), parentId, JSON.stringify(unique(alt.filter((value) => foldName(value) !== foldName(name)))), now, now);
  return getPlace(db, libraryId, id)!;
}

function writeAssignment(
  db: Db,
  libraryId: string,
  itemId: string,
  input: {
    outcome: AssignmentOutcome;
    actor: AssignmentActor;
    primaryPlaceId: string | null;
    revision: string;
    payload: AssignmentPayload;
    now: string;
    existing: AssignmentRow | undefined;
    bump?: boolean;
  },
): AssignmentRow {
  const id = input.existing?.id ?? newId();
  const created = input.existing?.created_at ?? input.now;
  const version = input.existing ? (input.bump === false ? input.existing.write_version : input.existing.write_version + 1) : 1;
  db.prepare(
    `INSERT INTO atlas_assignments (
       id, library_id, item_id, outcome, actor, primary_place_id, source_revision, write_version, payload_json, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(library_id, item_id) DO UPDATE SET
       outcome = excluded.outcome,
       actor = excluded.actor,
       primary_place_id = excluded.primary_place_id,
       source_revision = excluded.source_revision,
       write_version = excluded.write_version,
       payload_json = excluded.payload_json,
       updated_at = excluded.updated_at`,
  ).run(
    id,
    libraryId,
    itemId,
    input.outcome,
    input.actor,
    input.primaryPlaceId,
    input.revision,
    version,
    JSON.stringify(input.payload),
    created,
    input.now,
  );
  return loadAssignment(db, libraryId, itemId)!;
}

function markAttempt(db: Db, libraryId: string, itemId: string, revision: string, status: "succeeded", now: string): void {
  db.prepare(
    `INSERT INTO atlas_attempts (
       item_id, library_id, source_revision, analyzer_version, status, retryable, attempt_count, failure_reason,
       next_attempt_at, lease_owner, lease_expires_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, 0, 1, NULL, NULL, NULL, NULL, ?, ?)
     ON CONFLICT(item_id) DO UPDATE SET
       source_revision = excluded.source_revision,
       analyzer_version = excluded.analyzer_version,
       status = excluded.status,
       retryable = 0,
       failure_reason = NULL,
       next_attempt_at = NULL,
       lease_owner = NULL,
       lease_expires_at = NULL,
       updated_at = excluded.updated_at`,
  ).run(itemId, libraryId, revision, ANALYZER_POLICY_VERSION, status, now, now);
}

function groupDestinations(cards: AtlasCard[], home: PlaceView | null, byId: Map<string, PlaceRow>): DestinationSection[] {
  const around: AtlasCard[] = [];
  const buckets = new Map<string, AtlasCard[]>();
  for (const card of cards) {
    const primaryId = card.assignment.primary?.id;
    if (!primaryId) continue;
    if (home && inHome(primaryId, home.id, byId)) {
      around.push(card);
      continue;
    }
    const root = rootPlace(primaryId, byId);
    const list = buckets.get(root) ?? [];
    list.push(card);
    buckets.set(root, list);
  }
  const sections: DestinationSection[] = [];
  if (home && around.length > 0) {
    sections.push(section(`around-${home.id}`, `Around ${home.name}`, "around_home", home.id, around, byId));
  }
  const rest = [...buckets.entries()].sort((a, b) => {
    const left = byId.get(a[0])?.name ?? a[0];
    const right = byId.get(b[0])?.name ?? b[0];
    return left.localeCompare(right) || a[0].localeCompare(b[0]);
  });
  for (const [placeId, items] of rest) {
    const place = byId.get(placeId);
    sections.push(section(placeId, place?.name ?? placeId, "destination", placeId, items, byId));
  }
  return sections;
}

function section(
  id: string,
  title: string,
  kind: DestinationSection["kind"],
  placeId: string | null,
  items: AtlasCard[],
  byId: Map<string, PlaceRow>,
): DestinationSection {
  const contained: string[] = [];
  const seen = new Set<string>();
  for (const card of items) {
    const names = [
      ...card.assignment.contained.map((place) => place.name),
      ...(card.assignment.primary && card.assignment.primary.id !== placeId ? [card.assignment.primary.name] : []),
    ];
    for (const name of names) {
      if (seen.has(name) || (placeId && byId.get(placeId)?.name === name)) continue;
      seen.add(name);
      contained.push(name);
    }
  }
  return { id, title, kind, placeId, count: items.length, contained, items };
}

function viewAssignment(db: Db, row: AssignmentRow, item: ItemCard, byId: Map<string, PlaceRow>): AtlasAssignmentView {
  const payload = parsePayload(row.payload_json);
  const current = sourceRevision(item.title, item.body);
  return {
    id: row.id,
    itemId: row.item_id,
    outcome: row.outcome,
    actor: row.actor,
    version: row.write_version,
    sourceRevision: row.source_revision,
    sourceChanged: row.actor === "analyzer" && current !== row.source_revision,
    primary: row.primary_place_id && byId.has(row.primary_place_id) ? viewPlace(byId.get(row.primary_place_id)!, byId) : null,
    contained: payload.containedPlaceIds.flatMap((id) => (byId.has(id) ? [viewPlace(byId.get(id)!, byId)] : [])),
    mentioned: payload.mentionedPlaceIds.flatMap((id) => (byId.has(id) ? [viewPlace(byId.get(id)!, byId)] : [])),
    peers: payload.peerPlaceIds.flatMap((id) => (byId.has(id) ? [viewPlace(byId.get(id)!, byId)] : [])),
    suggestions: payload.suggestions,
  };
}

function viewPlace(place: PlaceRow, byId: Map<string, PlaceRow>): PlaceView {
  return {
    id: place.id,
    name: place.name,
    kind: place.kind,
    parentId: place.parent_id,
    ancestors: ancestors(place, byId),
    altNames: altNames(place),
    accent: placeAccent(place.id),
  };
}

function ancestors(place: PlaceRow, byId: Map<string, PlaceRow>): { id: string; name: string }[] {
  const out: { id: string; name: string }[] = [];
  const seen = new Set<string>([place.id]);
  let current = place.parent_id ? byId.get(place.parent_id) : undefined;
  while (current && !seen.has(current.id)) {
    out.push({ id: current.id, name: current.name });
    seen.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return out;
}

function inHome(placeId: string, homeId: string, byId: Map<string, PlaceRow>): boolean {
  const seen = new Set<string>();
  let current = byId.get(placeId);
  while (current && !seen.has(current.id)) {
    if (current.id === homeId) return true;
    seen.add(current.id);
    current = current.parent_id ? byId.get(current.parent_id) : undefined;
  }
  return false;
}

function rootPlace(placeId: string, byId: Map<string, PlaceRow>): string {
  const seen = new Set<string>();
  let current = byId.get(placeId);
  if (!current) return placeId;
  while (current.parent_id && byId.has(current.parent_id) && !seen.has(current.id)) {
    seen.add(current.id);
    current = byId.get(current.parent_id)!;
  }
  return current.id;
}

function loadPlaces(db: Db, libraryId: string): PlaceRow[] {
  return db
    .prepare(
      `SELECT id, library_id, name, kind, parent_id, alt_names, created_at, updated_at FROM atlas_places WHERE library_id = ?`,
    )
    .all(libraryId) as PlaceRow[];
}

function loadAssignments(db: Db, libraryId: string): AssignmentRow[] {
  return db
    .prepare(
      `SELECT id, library_id, item_id, outcome, actor, primary_place_id, source_revision, write_version, payload_json, created_at, updated_at
         FROM atlas_assignments WHERE library_id = ?`,
    )
    .all(libraryId) as AssignmentRow[];
}

function loadAssignment(db: Db, libraryId: string, itemId: string): AssignmentRow | undefined {
  return db
    .prepare(
      `SELECT id, library_id, item_id, outcome, actor, primary_place_id, source_revision, write_version, payload_json, created_at, updated_at
         FROM atlas_assignments WHERE library_id = ? AND item_id = ?`,
    )
    .get(libraryId, itemId) as AssignmentRow | undefined;
}

function loadAttempt(db: Db, itemId: string): AttemptRow | undefined {
  return db
    .prepare(
      `SELECT item_id, source_revision, analyzer_version, status, retryable, attempt_count, failure_reason, next_attempt_at, lease_expires_at
         FROM atlas_attempts WHERE item_id = ?`,
    )
    .get(itemId) as AttemptRow | undefined;
}

function loadScreening(db: Db, itemId: string): ScreeningRow | undefined {
  return db
    .prepare(
      `SELECT item_id, source_revision, screening_version, status, candidate, retryable, attempt_count,
              failure_reason, next_attempt_at, lease_expires_at
         FROM atlas_screenings WHERE item_id = ?`,
    )
    .get(itemId) as ScreeningRow | undefined;
}

function getPlace(db: Db, libraryId: string, placeId: string): PlaceRow | undefined {
  return db
    .prepare(
      `SELECT id, library_id, name, kind, parent_id, alt_names, created_at, updated_at FROM atlas_places WHERE library_id = ? AND id = ?`,
    )
    .get(libraryId, placeId) as PlaceRow | undefined;
}

function findAtParent(db: Db, libraryId: string, name: string, parentId: string | null): PlaceRow | undefined {
  const needle = foldName(name);
  const rows = parentId
    ? (db.prepare(`SELECT id, library_id, name, kind, parent_id, alt_names, created_at, updated_at FROM atlas_places WHERE library_id = ? AND parent_id = ?`).all(libraryId, parentId) as PlaceRow[])
    : (db.prepare(`SELECT id, library_id, name, kind, parent_id, alt_names, created_at, updated_at FROM atlas_places WHERE library_id = ? AND parent_id IS NULL`).all(libraryId) as PlaceRow[]);
  return rows.find((row) => foldName(row.name) === needle || altNames(row).some((alt) => foldName(alt) === needle));
}

function findNamed(db: Db, libraryId: string, name: string): PlaceRow[] {
  const needle = foldName(name);
  return loadPlaces(db, libraryId).filter((row) => foldName(row.name) === needle || altNames(row).some((alt) => foldName(alt) === needle));
}

function placeReferenced(db: Db, libraryId: string, placeId: string): boolean {
  if (getSetting(db, HOME_SETTING) === placeId) return true;
  const child = db.prepare(`SELECT 1 AS ok FROM atlas_places WHERE parent_id = ?`).get(placeId) as { ok: number } | undefined;
  if (child) return true;
  const primary = db.prepare(`SELECT 1 AS ok FROM atlas_assignments WHERE library_id = ? AND primary_place_id = ?`).get(libraryId, placeId) as { ok: number } | undefined;
  if (primary) return true;
  for (const row of loadAssignments(db, libraryId)) {
    const payload = parsePayload(row.payload_json);
    if (payload.containedPlaceIds.includes(placeId) || payload.mentionedPlaceIds.includes(placeId) || payload.peerPlaceIds.includes(placeId)) return true;
  }
  return false;
}

function travelSelect(): { sql: string; names: string[] } {
  const names = tagsForShelf("travel").map((name) => name.toLowerCase());
  const marks = names.map(() => "?").join(", ") || "NULL";
  return {
    sql: `SELECT m.item_id FROM memberships m JOIN tags t ON t.id = m.target_id WHERE m.target_kind = 'tag' AND lower(t.name) IN (${marks})`,
    names,
  };
}

function itemHasTravelTag(db: Db, itemId: string): boolean {
  const travel = travelSelect();
  if (travel.names.length === 0) return false;
  return Boolean(
    db.prepare(`${travel.sql} AND m.item_id = ?`).get(...travel.names, itemId),
  );
}

export function pruneNonTravelAttempts(db: Db): void {
  // Kept as a compatibility hook for older boot code. Atlas analyzes every
  // Item, so non-Travel attempts are valid and must never be pruned.
  db.prepare(`DELETE FROM atlas_attempts WHERE item_id NOT IN (SELECT id FROM items) OR item_id IN (SELECT item_id FROM atlas_assignments WHERE actor = 'user')`).run();
  db.prepare(`DELETE FROM atlas_screenings WHERE item_id NOT IN (SELECT id FROM items) OR item_id IN (SELECT item_id FROM atlas_assignments WHERE actor = 'user')`).run();
}

export function requeueTravelNotAtlas(db: Db, libraryId: string, now = nowIso()): void {
  // A not_atlas result is a valid analyzer decision, including for a Travel
  // tagged Item. Never turn a weak topic tag into an automatic requeue.
  void db;
  void libraryId;
  void now;
}

function travelItemIds(db: Db): string[] {
  const travel = travelSelect();
  if (travel.names.length === 0) return [];
  const rows = db.prepare(travel.sql).all(...travel.names) as { item_id: string }[];
  return [...new Set(rows.map((row) => row.item_id))];
}

function requireItem(db: Db, itemId: string): ItemCard {
  const item = getItem(db, itemId);
  if (!item) throw new MissingResource("item");
  return item;
}

function requirePlace(db: Db, libraryId: string, placeId: string): PlaceRow {
  const place = getPlace(db, libraryId, placeId);
  if (!place) throw new MissingResource("place");
  return place;
}

function assertVersion(existing: AssignmentRow | undefined, expectedVersion: number): void {
  const current = existing?.write_version ?? 0;
  if (expectedVersion !== current) throw new AtlasConflict("stale write");
}

function presentItem(item: ItemCard | null): ItemCard | null {
  if (!item) return null;
  const body = item.body && item.body.length > 800 ? `${item.body.slice(0, 799).trimEnd()}…` : item.body;
  return { ...item, body, notes: [], collections: [] };
}

function altNames(place: PlaceRow): string[] {
  try {
    const value = JSON.parse(place.alt_names) as unknown;
    return Array.isArray(value) ? value.filter((name): name is string => typeof name === "string") : [];
  } catch {
    return [];
  }
}

function mapPlaces(places: PlaceRow[]): Map<string, PlaceRow> {
  return new Map(places.map((place) => [place.id, place]));
}

function topologicalPlaces(rows: readonly AtlasArchiveRecord[]): AtlasArchiveRecord[] {
  const byId = new Map<string, AtlasArchiveRecord>();
  for (const rec of rows) {
    if (typeof rec.id !== "string") throw new RejectedPayload("invalid place");
    byId.set(rec.id, rec);
  }
  const out: AtlasArchiveRecord[] = [];
  const seen = new Set<string>();
  const visiting = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    if (visiting.has(id)) throw new RejectedPayload("place cycle");
    const rec = byId.get(id);
    if (!rec) throw new RejectedPayload("missing parent place");
    visiting.add(id);
    if (typeof rec.parentId === "string" && rec.parentId) visit(rec.parentId);
    visiting.delete(id);
    seen.add(id);
    out.push(rec);
  };
  for (const id of byId.keys()) visit(id);
  return out;
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function reqString(value: unknown, max: number): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) throw new RejectedPayload("invalid archive field");
  return value;
}

function compareCard(a: AtlasCard, b: AtlasCard): number {
  return b.item.firstObservedAt.localeCompare(a.item.firstObservedAt) || a.item.id.localeCompare(b.item.id);
}

function compareReview(a: ReviewRow, b: ReviewRow): number {
  return b.item.firstObservedAt.localeCompare(a.item.firstObservedAt) || a.item.id.localeCompare(b.item.id);
}
