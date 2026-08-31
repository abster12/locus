import type { Db } from "../../db/open.ts";
import { searchItemSummaries } from "../../core/library.ts";
import { searchPlaces } from "../atlas/module.ts";

// ---------- Library source search (ticket 05) ----------

export const MAX_TRIP_SOURCE_RESULTS = 20;

export type TripSourceItem = { id: string; title: string; source: string | null };
export type TripSourcePlace = { id: string; name: string; kind: string };
export type TripSources = { items: TripSourceItem[]; places: TripSourcePlace[] };

/** Bounded picker search across the adapter's Library. Items come from the
 * authoritative library projection, Places from Atlas; both return selection
 * fields only — never captions, media, credentials, or session data. */
export function searchTripSources(db: Db, libraryId: string, q: string): TripSources {
  return {
    items: searchItemSummaries(db, libraryId, q, MAX_TRIP_SOURCE_RESULTS),
    places: searchPlaces(db, libraryId, q)
      .slice(0, MAX_TRIP_SOURCE_RESULTS)
      .map((place) => ({ id: place.id, name: place.name, kind: place.kind })),
  };
}
