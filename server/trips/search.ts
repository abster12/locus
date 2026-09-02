import { ownedLibraryId } from "../../db/library-id.ts";
import type { Db } from "../../db/open.ts";
import { foldName, searchPlaces } from "../atlas/module.ts";

// ---------- Library source search (ticket 05) ----------

export const MAX_TRIP_SOURCE_RESULTS = 20;

export type TripSourceItem = { id: string; title: string; source: string | null };
export type TripSourcePlace = { id: string; name: string; kind: string };
export type TripSources = { items: TripSourceItem[]; places: TripSourcePlace[] };

type CandidateRow = {
  id: string;
  title: string | null;
  body: string | null;
  source: string | null;
  primary_place_id: string | null;
};

/** Bounded picker search. Saved items are Atlas-placed (or not yet classified),
 * never not_atlas reading material. Places stay Atlas Places. Selection fields
 * only — never captions, media, credentials, or session data. */
export function searchTripSources(db: Db, libraryId: string, q: string): TripSources {
  const needle = foldName(q.trim().slice(0, 80));
  const allPlaces = searchPlaces(db, libraryId, "");
  const places = needle ? searchPlaces(db, libraryId, q) : allPlaces;
  return {
    items: searchTripItems(db, libraryId, needle, placeSearchNames(allPlaces)),
    places: places.slice(0, MAX_TRIP_SOURCE_RESULTS).map((place) => ({ id: place.id, name: place.name, kind: place.kind })),
  };
}

function placeSearchNames(places: { id: string; name: string; altNames: string[]; ancestors: { name: string }[] }[]): Map<string, string[]> {
  return new Map(
    places.map((place) => [
      place.id,
      [place.name, ...place.altNames, ...place.ancestors.map((row) => row.name)].map(foldName),
    ]),
  );
}

function searchTripItems(db: Db, libraryId: string, needle: string, namesByPlace: Map<string, string[]>): TripSourceItem[] {
  const owned = ownedLibraryId(libraryId);
  const rows = db
    .prepare(
      `SELECT i.id, i.title, i.body,
         (SELECT a.source FROM source_records r JOIN source_accounts a ON a.id = r.source_account_id
           WHERE r.item_id = i.id LIMIT 1) AS source,
         asg.primary_place_id
       FROM items i
       LEFT JOIN atlas_assignments asg ON asg.item_id = i.id AND asg.library_id = ?
       WHERE i.library_id = ?
         AND (asg.outcome IS NULL OR asg.outcome IN ('placed', 'multiple'))
       ORDER BY i.first_observed_at DESC, i.id`,
    )
    .all(owned, owned) as CandidateRow[];
  const hits: TripSourceItem[] = [];
  for (const row of rows) {
    if (needle && !itemMatches(row, needle, namesByPlace)) continue;
    hits.push({
      id: row.id,
      title: row.title?.trim() || row.body?.trim().slice(0, 80) || "Saved item",
      source: row.source ?? null,
    });
    if (hits.length >= MAX_TRIP_SOURCE_RESULTS) break;
  }
  return hits;
}

function itemMatches(row: CandidateRow, needle: string, namesByPlace: Map<string, string[]>): boolean {
  if (foldName(row.title ?? "").includes(needle) || foldName(row.body ?? "").includes(needle)) return true;
  const names = row.primary_place_id ? namesByPlace.get(row.primary_place_id) : undefined;
  return names?.some((name) => name.includes(needle)) ?? false;
}
