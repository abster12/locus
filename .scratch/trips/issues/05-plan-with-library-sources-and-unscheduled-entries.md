# 05: Plan with Library sources and Unscheduled entries

**What to build:** Let the user build a Trip Document from things already known to Locus while keeping provenance honest. A Trip Stop may reference an Item, reference an existing Place, or contain bounded trip-owned outside content deliberately entered by the user. The user can search bounded Library summaries from the Trip Document page, add a result to a day or Unscheduled, inspect details, and move it later. Trips references authoritative Library entities rather than copying them into a second catalog.

**Blocked by:** 04: Edit a Day Planner with reversible changesets.

**Status:** done

- [x] Library search returns bounded selection fields for Items and Places in the current Library and never exposes unrelated captions, credentials, session data, media bytes, or raw queries.
- [x] Item and Place references preserve stable identity and resolve current display data from their authoritative modules.
- [x] A reference to a removed or unavailable Item remains as a visible broken reference with its historical placement instead of disappearing silently.
- [x] Outside content is bounded, sanitized, visibly distinguished from saved Library content, and may include only a safe public source URL when the user supplied it.
- [x] Adding outside content never automatically creates an Item, Place, Collection, tag, or Place Assignment.
- [x] Unscheduled is part of the same Trip Document and supports the same add, inspect, move, order, remove, revision, and history behavior as dated days.
- [x] Stop details progressively disclose source, address, reservation, public/private notes, provenance, and stored facts without crowding the default row.
- [x] Real-database tests cover all content kinds, same-Library enforcement, missing references, outside-content bounds/sanitization, and Unscheduled ordering. HTTP/browser tests cover Library search, details disclosure, manual placement, and the guarantee that outside content does not pollute the Library. Relevant existing tests, typecheck, and build remain green.

## Comments

`TripStopContent` is now a three-kind union in `server/trips/policy.ts`: `{ kind: "item", itemId }`, `{ kind: "place", placeId }`, and `{ kind: "outside", title, notes, url }` — references store identity only. Outside URLs pass through the existing `sanitizeUrl` (http(s)-only, no credentials, ≤2000 chars, normalized). `validateStopContent` accepts all three; `parseStopContent` round-trips them and keeps malformed rows visible.

`server/trips/module.ts`: `applyOne` validates references against the adapter's Library at write time via `requireStopReference` (unknown Item ids and foreign-Library Place ids reject the whole changeset; a later removal just breaks the reference). `getTrip` resolves display data through the authoritative modules — `getItem` (core/library) and a new `getPlaceView` (atlas) — into `resolved` + `broken` on each stop, never copying captions or media. `stopTitle` is kind-aware so history summaries name the resolved title. New `searchTripSources(db, libraryId, q)` returns `{ items, places }` with selection fields only (`id/title/source`, `id/name/kind`), capped at 20 per group; item search reuses a new bounded `searchItemSummaries` in `core/library.ts`, place search reuses Atlas `searchPlaces`. HTTP: `GET /api/trips/sources?q=` (exact route, session-gated like all reads; CSRF already enforced on mutations).

UI (`app/src/TripsPage.tsx`): each day and Unscheduled now offer "Add from Library" (debounced search, grouped results, one click places a reference stop through the same changeset engine) and "Add a placeholder" (now with an optional source-link field). Stop rows show a text kind chip (`Saved item` / `Place` / `Outside` / `Missing` — never color alone); references resolve their title from `resolved` and broken ones read "Missing saved item" / "Missing place" while keeping placement. `<details>` discloses source, original link, place kind/location, outside notes/URL, public/private notes, and provenance without crowding the default row. `EditStopForm` only edits timing for reference stops (content stays authoritative); outside stops edit title/notes/URL.

Residuals: Places have no address field in the Atlas model, so details show kind + ancestor location instead; reservation fields do not exist yet (arrive with later tickets' stop schema). Unscheduled ordering/revision/history reuse the ticket-04 engine unchanged and stay covered by its tests.

Commands: `npx tsc --noEmit`, `npm test` (291 pass, 0 fail; was 285), `npm run build`, `npx vite build` before browser tests. Tests: `tests/trips-module.test.ts` (+6: item/place resolution, foreign/unknown reference rejection incl. updateStop smuggling, broken reference with placement after Item deletion, outside URL sanitization, no-Library-pollution counts, bounded/Library-scoped search), `tests/trips-http.test.ts` (+1: bounded source search, 401 anonymous, outside stop creates zero Library rows), `tests/trips-browser.test.ts` (+1: search both kinds, add item to a day, details disclosure, outside stop with link, broken reference after Item deletion across reload, writes only `POST /api/trips*`, zero external calls).
