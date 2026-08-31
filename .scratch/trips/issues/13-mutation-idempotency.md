# Trips mutation idempotency

Type: task
Status: resolved

## Outcome

Trip creation and deletion are safely replayable. A lost response followed by an exact retry returns the original result without creating a second Trip or turning a successful deletion into `not-found`.

## Problem

- Trip creation currently posts setup data without a client mutation id and calls creation directly.
- Deleting a Trip removes the receipt with the Trip, so the receipt cannot authorize an idempotent replay.
- The Trips spec requires mutations to use revision checks where applicable and client mutation ids for retry safety.

## Scope

- `app/src/api.ts`
- `server/http/server.ts`
- `server/trips/`
- Focused API, persistence, and lifecycle tests

## Requirements

1. Require a client mutation id at the Trip-creation boundary.
2. Scope stored mutation identity to the appropriate authenticated session or owner.
3. Store enough request identity to distinguish an exact replay from reuse with a different payload.
4. Return the original successful creation response for an exact replay without inserting another Trip.
5. Preserve a deletion receipt or tombstone independently of the deleted Trip.
6. Return the original successful deletion response for an exact replay after the Trip data is gone.
7. Reject mutation-id reuse with a different operation or payload using a stable error.
8. Keep receipt checking and the protected write in one transaction.
9. Extract the receipt/idempotency responsibility from the large Trips module into a focused internal module with a narrow interface.

## Tests

Add focused coverage for:

- First creation
- Exact creation retry
- Lost-response-style creation retry
- Creation retry with a conflicting payload
- First deletion
- Exact deletion retry after the Trip is gone
- Conflicting deletion mutation-id reuse
- A new deletion mutation against an already absent Trip
- Rollback when receipt persistence or the protected write fails

## Completion criteria

- One logical create produces exactly one Trip across any number of exact retries.
- One successful delete remains successfully replayable.
- Conflicting mutation-id reuse cannot mutate data.
- The extracted idempotency tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

Review intent, UI layout, time parsing, and general-purpose Trips refactoring belong to later tickets.

## Comments

Owner-scoped `trip_mutation_receipts` (schema v20, no trip CASCADE). Extracted `server/trips/receipts.ts`. Create requires `clientMutationId` at HTTP; exact retry returns the original trip. Delete receipts survive the trip so exact retry returns `{deleted:true}`; a new mutation id on an absent trip is still not-found.

Tests: `tests/trips-receipts.test.ts` plus HTTP create/delete replay. Verification: focused receipts/changes/http tests, `npm run typecheck`, `npm run build`. `create_trip` WebMCP still generates a fresh id per UI call via `api.createTrip`.
