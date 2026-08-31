# 04: Edit a Day Planner with reversible changesets

**What to build:** Make the Day Planner the primary manual editing surface for a Trip Document. A user can add, update, reorder, move between days, move to or from Unscheduled, and remove Trip Stops. Every user action crosses the Trips module as one bounded, atomic Trip Changeset with an expected revision and client mutation id. Changes are visible immediately and can be inspected, undone, and redone as complete actions rather than low-level database edits.

**Blocked by:** 02: Create and reopen a Trip Document.

**Status:** done

- [x] A Trip Day and Trip Stop have stable identities and explicit ordering; stop edits never depend on array position supplied by an untrusted client.
- [x] Manual add, edit, move, reorder, move between days, move to or from Unscheduled, and remove Trip Stops work through buttons and keyboard controls; dragging is not required (not implemented).
- [x] Human-created stops begin Confirmed, and draft/confirmed state is exposed as text (`Confirmed` / `Draft`) rather than color alone.
- [x] Each mutation declares the expected Trip Document revision, increments it once on success, and rejects stale writes (409) without changing the document.
- [x] A client mutation id makes retries idempotent and cannot be reused for a different operation payload (payload hash covers kind, expected revision, operations, and instruction).
- [x] A bounded group of operations (max 50) commits atomically or rolls back completely when any operation is invalid.
- [x] History shows actor, time, originating instruction when present, and a bounded before/after summary (GET `/api/trips/:id/history`). Undo and Redo operate on complete changesets and create auditable revision transitions.
- [x] Actor identity comes from the trusted human adapter (forced `"user"` server-side) and is never accepted from the request body.
- [x] Real-database tests cover every operation, ordering, stale conflicts, idempotent retries, rollback, history persistence, Undo/Redo, and actor derivation. HTTP and browser tests cover visible updates, keyboard editing, accessible announcements, and regression of existing Library behavior. Relevant existing tests, typecheck, and build remain green.

## Comments

Schema v14 adds `trip_stops` (day_id NULL = Unscheduled, FK to trips CASCADE, FK to days SET NULL so a removed day releases stops instead of destroying them) and `trip_changesets` (kind change/undo/redo, reverses_id, payload_hash, UNIQUE(trip_id, client_mutation_id)). One engine: `applyTripChanges(db, libraryId, tripId, input, actor)` with typed ops `addStop`/`updateStop`/`moveStop`/`removeStop`; placement is by stop/day ids plus before/after anchors — an absolute `atPosition` index exists only as a module-internal inverse representation and `parseTripOperations` rejects it from adapters. Inverses are captured against pre-op state and stored reversed; undo applies them in reverse order (exact multi-op unwind verified by test). Undo targets the latest active change-kind row, redo is LIFO over undone rows and is blocked once a later change is active; undo/redo create their own changeset rows with revisions and summaries. Idempotent replay returns the original changeset marked `replayed: true`; reuse with a different payload (including a different instruction) is a 400. Stale revision throws `TripConflict` → 409.

Landmine fixed: `updateTripSetup` no longer wipes days — day identities survive when the day count is unchanged (dates may shift), longer trips append days at the end, shorter trips remove end days and release their stops to Unscheduled (SET NULL). `duplicateTrip` copies stops under new stop/day ids; `deleteTrip` removes stops, changesets, and days but never Items/Places/tags.

UI: Day Planner is the document page's primary surface (setup facts and lifecycle actions from tickets 02–03 kept intact for their tests). Per-day sections plus Unscheduled; compact stop rows with text state chips, details disclosure, ↑/↓ buttons (aria-labelled), Move… menu for day/Unscheduled targets, inline Edit form, Remove; Undo/Redo buttons with server-derived disabled states; `role="status" aria-live` announcement; History `<details>` listing actor/time/instruction/summary. clientMutationId is generated in the browser (api.ts). Ticket 05 (Item/Place refs) is untouched; stop content is bounded outside/placeholder text only.

Commands: `npx tsc --noEmit`, `npm test` (285 pass, 0 fail; was 269), `npm run build`, `npx vite build` before browser tests. Tests: `tests/trips-module.test.ts` (+10: add/update/move/remove, ids-not-indexes, stale, idempotency + payload-reuse, rollback, undo/redo stack, history, setup identity preservation, end-day release, duplicate/delete boundaries, actor derivation, Library isolation), `tests/trips-http.test.ts` (+1: changes/undo/redo/history, CSRF 403, 409 stale, 400 invalid incl. atPosition, 404, actor forced, replay), `tests/trips-browser.test.ts` (+1: add placeholder, keyboard move via focused ↑ + Enter, move to Unscheduled, undo/redo, history, refresh persistence, writes only `POST /api/trips*`, zero external calls, zero inference). Files: `db/schema.ts`, `server/trips/policy.ts`, `server/trips/module.ts`, `server/http/server.ts`, `app/src/api.ts`, `app/src/TripsPage.tsx`, `app/src/styles.css`, the three test files.
