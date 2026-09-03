import { createHash } from "node:crypto";
import { tagsForShelf } from "../../core/categories.ts";
import { RejectedPayload } from "../../core/sanitize.ts";
import {
  HOME_SETTING,
  MAX_PLACE_SEARCH,
  MAX_REVIEW_PREVIEW,
  emptyPayload,
  foldName,
  mapKind,
  normalizeSource,
  parseKind,
  parsePayload,
  placeAccent,
  sanitizePlaceName,
  type AssignmentActor,
  type AssignmentOutcome,
  type AssignmentPayload,
  type DestinationCandidate,
  type PlaceKind,
} from "../../server/atlas/policy.ts";
import { MissingResource, getLibraryItem, nowIso, type ItemCard } from "./desk.ts";
import { all, first, inMarks, run } from "./sql.ts";

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
export type ReviewRow = { item: ItemCard; assignment: AtlasAssignmentView | null };

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
  lat: number | null;
  lng: number | null;
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

export function sourceRevision(title: string | null | undefined, body: string | null | undefined): string {
  const source = normalizeSource(title, body);
  return createHash("sha256").update(`${source.title}\n${source.body}`).digest("hex");
}

export async function getAtlasProjection(db: D1Database, libraryId: string): Promise<AtlasProjection> {
  const places = await loadPlaces(db, libraryId);
  const byId = mapPlaces(places);
  const homeId = await getSetting(db, libraryId, HOME_SETTING);
  const home = homeId && byId.has(homeId) ? viewPlace(byId.get(homeId)!, byId) : null;
  const assignments = await loadAssignments(db, libraryId);
  const assigned = new Set(assignments.map((row) => row.item_id));
  const cards: AtlasCard[] = [];
  const review: ReviewRow[] = [];
  const multiple: AtlasCard[] = [];
  for (const row of assignments) {
    const item = presentItem(await getLibraryItem(db, libraryId, row.item_id));
    if (!item) continue;
    const view = viewAssignment(row, item, byId);
    if (row.outcome === "not_atlas") continue;
    if (row.outcome === "needs_place") review.push({ item, assignment: view });
    else if (row.outcome === "multiple") multiple.push({ item, assignment: view });
    else cards.push({ item, assignment: view });
  }
  for (const itemId of await travelItemIds(db, libraryId)) {
    if (assigned.has(itemId)) continue;
    const item = presentItem(await getLibraryItem(db, libraryId, itemId));
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
    analysis: { queued: 0, failed: 0, backfillDone: true },
    needsPlace: { count: review.length, preview: review.slice(0, MAX_REVIEW_PREVIEW), items: review },
    multiple,
    destinations,
    counts: { items: atlasItems.size, destinations: destinations.length },
  };
}

export async function searchPlaces(db: D1Database, libraryId: string, q: string): Promise<PlaceView[]> {
  const needle = foldName(q.trim().slice(0, MAX_PLACE_SEARCH));
  const places = await loadPlaces(db, libraryId);
  const byId = mapPlaces(places);
  const ranked = (!needle
    ? places
    : places.filter((place) => foldName(place.name).includes(needle) || altNames(place).some((name) => foldName(name).includes(needle)))
  ).sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return ranked.map((place) => viewPlace(place, byId));
}

export async function getPlaceView(db: D1Database, libraryId: string, placeId: string): Promise<PlaceView | null> {
  const place = await getPlace(db, libraryId, placeId);
  if (!place) return null;
  return viewPlace(place, mapPlaces(await loadPlaces(db, libraryId)));
}

export async function getPlaceCoordinates(
  db: D1Database,
  libraryId: string,
  placeId: string,
): Promise<{ lat: number; lng: number } | null> {
  const place = await getPlace(db, libraryId, placeId);
  if (place?.lat == null || place.lng == null) return null;
  return { lat: place.lat, lng: place.lng };
}

export async function createPlace(
  db: D1Database,
  libraryId: string,
  input: { name: string; kind?: string; parentId?: string | null; altNames?: string[] },
  now = nowIso(),
): Promise<PlaceView> {
  const row = await insertPlace(
    db,
    libraryId,
    sanitizePlaceName(input.name),
    parseKind(input.kind ?? "place"),
    input.parentId ?? null,
    input.altNames ?? [],
    now,
  );
  return viewPlace(row, mapPlaces(await loadPlaces(db, libraryId)));
}

export async function setHomeBase(db: D1Database, libraryId: string, placeId: string | null): Promise<PlaceView | null> {
  if (!placeId) {
    await run(db, `DELETE FROM library_settings WHERE library_id = ? AND key = ?`, libraryId, HOME_SETTING);
    return null;
  }
  const places = await loadPlaces(db, libraryId);
  const place = places.find((row) => row.id === placeId);
  if (!place) throw new MissingResource("place");
  await setSetting(db, libraryId, HOME_SETTING, placeId);
  return viewPlace(place, mapPlaces(places));
}

export async function acceptSuggestion(
  db: D1Database,
  libraryId: string,
  itemId: string,
  index: number,
  expectedVersion: number,
  now = nowIso(),
): Promise<AtlasAssignmentView> {
  return mutateUser(db, libraryId, itemId, expectedVersion, now, async (item, existing) => {
    const suggestion = parsePayload(existing?.payload_json ?? "{}").suggestions[index];
    if (!suggestion) throw new RejectedPayload("unknown suggestion");
    const place = await ensureFromCandidate(db, libraryId, suggestion, now);
    return placedUser(db, libraryId, item, place.id, now, existing);
  });
}

export async function setExactPlace(
  db: D1Database,
  libraryId: string,
  itemId: string,
  input: { placeId?: string; name?: string; kind?: string; parentId?: string | null },
  expectedVersion: number,
  now = nowIso(),
): Promise<AtlasAssignmentView> {
  return mutateUser(db, libraryId, itemId, expectedVersion, now, async (item, existing) => {
    const place = input.placeId
      ? await requirePlace(db, libraryId, input.placeId)
      : await insertPlace(db, libraryId, sanitizePlaceName(input.name ?? ""), parseKind(input.kind ?? "place"), input.parentId ?? null, [], now);
    return placedUser(db, libraryId, item, place.id, now, existing);
  });
}

export async function markMultiple(
  db: D1Database,
  libraryId: string,
  itemId: string,
  expectedVersion: number,
  now = nowIso(),
): Promise<AtlasAssignmentView> {
  return mutateUser(db, libraryId, itemId, expectedVersion, now, async (item, existing) => {
    const payload = existing ? parsePayload(existing.payload_json) : emptyPayload();
    const peers: string[] = [];
    for (const row of payload.suggestions.filter((candidate) => candidate.role === "primary")) {
      peers.push((await ensureFromCandidate(db, libraryId, row, now)).id);
    }
    return writeAssignment(db, libraryId, itemId, {
      outcome: "multiple",
      actor: "user",
      primaryPlaceId: null,
      revision: sourceRevision(item.title, item.body),
      payload: { ...emptyPayload(), peerPlaceIds: unique(peers.length >= 2 ? peers : payload.peerPlaceIds) },
      now,
      existing,
    });
  });
}

export async function markNotAtlas(
  db: D1Database,
  libraryId: string,
  itemId: string,
  expectedVersion: number,
  now = nowIso(),
): Promise<AtlasAssignmentView> {
  return mutateUser(db, libraryId, itemId, expectedVersion, now, (item, existing) =>
    writeAssignment(db, libraryId, itemId, {
      outcome: "not_atlas",
      actor: "user",
      primaryPlaceId: null,
      revision: sourceRevision(item.title, item.body),
      payload: emptyPayload(),
      now,
      existing,
    }),
  );
}

export async function leaveUnresolved(
  db: D1Database,
  libraryId: string,
  itemId: string,
  expectedVersion: number,
  now = nowIso(),
): Promise<AtlasAssignmentView | null> {
  const item = await requireItem(db, libraryId, itemId);
  const existing = await loadAssignment(db, libraryId, itemId);
  assertVersion(existing, expectedVersion);
  if (!existing) return null;
  const row = await writeAssignment(db, libraryId, itemId, {
    outcome: "needs_place",
    actor: "user",
    primaryPlaceId: null,
    revision: sourceRevision(item.title, item.body),
    payload: parsePayload(existing.payload_json),
    now,
    existing,
  });
  await run(db, `DELETE FROM atlas_attempts WHERE item_id = ?`, itemId);
  await run(db, `DELETE FROM atlas_screenings WHERE item_id = ?`, itemId);
  return viewAssignment(row, item, mapPlaces(await loadPlaces(db, libraryId)));
}

export async function changePlace(
  db: D1Database,
  libraryId: string,
  itemId: string,
  placeId: string,
  expectedVersion: number,
  now = nowIso(),
): Promise<AtlasAssignmentView> {
  return setExactPlace(db, libraryId, itemId, { placeId }, expectedVersion, now);
}

async function mutateUser(
  db: D1Database,
  libraryId: string,
  itemId: string,
  expectedVersion: number,
  now: string,
  write: (item: ItemCard, existing: AssignmentRow | undefined) => Promise<AssignmentRow>,
): Promise<AtlasAssignmentView> {
  const item = await requireItem(db, libraryId, itemId);
  const existing = (await loadAssignment(db, libraryId, itemId)) ?? undefined;
  assertVersion(existing, expectedVersion);
  const row = await write(item, existing);
  await run(db, `DELETE FROM atlas_attempts WHERE item_id = ?`, itemId);
  await run(db, `DELETE FROM atlas_screenings WHERE item_id = ?`, itemId);
  return viewAssignment(row, item, mapPlaces(await loadPlaces(db, libraryId)));
}

async function placedUser(
  db: D1Database,
  libraryId: string,
  item: ItemCard,
  placeId: string,
  now: string,
  existing: AssignmentRow | undefined,
): Promise<AssignmentRow> {
  await requirePlace(db, libraryId, placeId);
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

async function ensureFromCandidate(
  db: D1Database,
  libraryId: string,
  candidate: DestinationCandidate,
  now: string,
): Promise<PlaceRow> {
  let parentId: string | null = null;
  if (candidate.parentName) {
    const parents = await findNamed(db, libraryId, candidate.parentName);
    const uniqueParent = parents.length === 1 ? parents[0] : parents.find((row) => row.parent_id == null);
    if (uniqueParent && parents.filter((row) => row.parent_id == null).length <= 1) parentId = uniqueParent.id;
    else if (parents.length === 0) {
      parentId = (await insertPlace(db, libraryId, candidate.parentName, candidate.parentKind ?? "place", null, [], now)).id;
    }
  }
  return insertPlace(db, libraryId, candidate.name, candidate.kind, parentId, candidate.altNames, now);
}

async function insertPlace(
  db: D1Database,
  libraryId: string,
  name: string,
  kind: PlaceKind,
  parentId: string | null,
  alt: string[],
  now: string,
): Promise<PlaceRow> {
  if (parentId) await requirePlace(db, libraryId, parentId);
  const existing = await findAtParent(db, libraryId, name, parentId);
  if (existing) {
    const names = unique([...altNames(existing), ...alt, name].filter((value) => foldName(value) !== foldName(existing.name)));
    if (names.join("\0") !== altNames(existing).join("\0")) {
      await run(db, `UPDATE atlas_places SET alt_names = ?, updated_at = ? WHERE id = ? AND library_id = ?`, JSON.stringify(names), now, existing.id, libraryId);
      return { ...existing, alt_names: JSON.stringify(names), updated_at: now };
    }
    return existing;
  }
  const id = crypto.randomUUID();
  await run(
    db,
    `INSERT INTO atlas_places (id, library_id, name, kind, parent_id, alt_names, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    id,
    libraryId,
    name,
    mapKind(kind),
    parentId,
    JSON.stringify(unique(alt.filter((value) => foldName(value) !== foldName(name)))),
    now,
    now,
  );
  return (await getPlace(db, libraryId, id))!;
}

async function writeAssignment(
  db: D1Database,
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
): Promise<AssignmentRow> {
  const id = input.existing?.id ?? crypto.randomUUID();
  const created = input.existing?.created_at ?? input.now;
  const version = input.existing ? (input.bump === false ? input.existing.write_version : input.existing.write_version + 1) : 1;
  await run(
    db,
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
  return (await loadAssignment(db, libraryId, itemId))!;
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

function viewAssignment(row: AssignmentRow, item: ItemCard, byId: Map<string, PlaceRow>): AtlasAssignmentView {
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

async function loadPlaces(db: D1Database, libraryId: string): Promise<PlaceRow[]> {
  return all<PlaceRow>(
    db,
    `SELECT id, library_id, name, kind, parent_id, alt_names, lat, lng, created_at, updated_at FROM atlas_places WHERE library_id = ?`,
    libraryId,
  );
}

async function loadAssignments(db: D1Database, libraryId: string): Promise<AssignmentRow[]> {
  return all<AssignmentRow>(
    db,
    `SELECT id, library_id, item_id, outcome, actor, primary_place_id, source_revision, write_version, payload_json, created_at, updated_at
       FROM atlas_assignments WHERE library_id = ?`,
    libraryId,
  );
}

async function loadAssignment(db: D1Database, libraryId: string, itemId: string): Promise<AssignmentRow | null> {
  return first<AssignmentRow>(
    db,
    `SELECT id, library_id, item_id, outcome, actor, primary_place_id, source_revision, write_version, payload_json, created_at, updated_at
       FROM atlas_assignments WHERE library_id = ? AND item_id = ?`,
    libraryId,
    itemId,
  );
}

async function getPlace(db: D1Database, libraryId: string, placeId: string): Promise<PlaceRow | null> {
  return first<PlaceRow>(
    db,
    `SELECT id, library_id, name, kind, parent_id, alt_names, lat, lng, created_at, updated_at FROM atlas_places WHERE library_id = ? AND id = ?`,
    libraryId,
    placeId,
  );
}

async function findAtParent(db: D1Database, libraryId: string, name: string, parentId: string | null): Promise<PlaceRow | null> {
  const rows = parentId
    ? await all<PlaceRow>(
        db,
        `SELECT id, library_id, name, kind, parent_id, alt_names, lat, lng, created_at, updated_at FROM atlas_places WHERE library_id = ? AND parent_id = ?`,
        libraryId,
        parentId,
      )
    : await all<PlaceRow>(
        db,
        `SELECT id, library_id, name, kind, parent_id, alt_names, lat, lng, created_at, updated_at FROM atlas_places WHERE library_id = ? AND parent_id IS NULL`,
        libraryId,
      );
  const needle = foldName(name);
  return rows.find((row) => foldName(row.name) === needle || altNames(row).some((alt) => foldName(alt) === needle)) ?? null;
}

async function findNamed(db: D1Database, libraryId: string, name: string): Promise<PlaceRow[]> {
  const needle = foldName(name);
  return (await loadPlaces(db, libraryId)).filter(
    (row) => foldName(row.name) === needle || altNames(row).some((alt) => foldName(alt) === needle),
  );
}

async function travelItemIds(db: D1Database, libraryId: string): Promise<string[]> {
  const names = tagsForShelf("travel").map((name) => name.toLowerCase());
  if (names.length === 0) return [];
  const rows = await all<{ item_id: string }>(
    db,
    `SELECT m.item_id FROM memberships m
       JOIN tags t ON t.id = m.target_id
       JOIN items i ON i.id = m.item_id
      WHERE i.library_id = ? AND m.target_kind = 'tag' AND lower(t.name) IN (${inMarks(names.length)})`,
    libraryId,
    ...names,
  );
  return [...new Set(rows.map((row) => row.item_id))];
}

async function requireItem(db: D1Database, libraryId: string, itemId: string): Promise<ItemCard> {
  const item = await getLibraryItem(db, libraryId, itemId);
  if (!item) throw new MissingResource("item");
  return item;
}

async function requirePlace(db: D1Database, libraryId: string, placeId: string): Promise<PlaceRow> {
  const place = await getPlace(db, libraryId, placeId);
  if (!place) throw new MissingResource("place");
  return place;
}

function assertVersion(existing: AssignmentRow | undefined | null, expectedVersion: number): void {
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

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

function compareCard(a: AtlasCard, b: AtlasCard): number {
  return b.item.firstObservedAt.localeCompare(a.item.firstObservedAt) || a.item.id.localeCompare(b.item.id);
}

function compareReview(a: ReviewRow, b: ReviewRow): number {
  return b.item.firstObservedAt.localeCompare(a.item.firstObservedAt) || a.item.id.localeCompare(b.item.id);
}

async function getSetting(db: D1Database, libraryId: string, key: string): Promise<string | null> {
  const row = await first<{ value: string }>(
    db,
    `SELECT value FROM library_settings WHERE library_id = ? AND key = ?`,
    libraryId,
    key,
  );
  return row?.value ?? null;
}

async function setSetting(db: D1Database, libraryId: string, key: string, value: string): Promise<void> {
  await run(
    db,
    `INSERT INTO library_settings (library_id, key, value) VALUES (?, ?, ?)
     ON CONFLICT(library_id, key) DO UPDATE SET value = excluded.value`,
    libraryId,
    key,
    value,
  );
}
