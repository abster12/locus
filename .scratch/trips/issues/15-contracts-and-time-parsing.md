# Trips contracts and time parsing

Type: task
Status: resolved
Blocked by: 14

## Outcome

Trip setup crosses the application boundary through one authoritative codec, and projections and exports interpret time windows through one strict parser.

## Problem

- Setup fields and validation are duplicated across the page, API client, and server policy.
- Time parsing accepts the valid half of a malformed range. For example, `09:00–25:00` can become a timed event beginning at 09:00.

## Scope

- `app/src/TripsPage.tsx`
- `app/src/api.ts`
- `server/trips/policy.ts`
- `server/trips/projections.ts`
- `server/trips/export.ts`
- Focused contract, projection, and export tests

## Requirements

1. Define one authoritative Trip-setup transport shape and boundary codec.
2. Derive or reuse types from that contract instead of maintaining parallel field lists.
3. Keep UI-only draft state separate from the transport and persisted domain models.
4. Keep server validation authoritative and reject or normalize fields deliberately.
5. Implement one strict time-window parser shared by projections and exports.
6. Treat a value as timed only when the complete range is valid.
7. Treat missing, malformed, impossible, or reversed ranges as untimed according to the Trips spec.
8. Avoid partial regex matches and partial fallback values.

## Tests

Use table-driven tests for:

- Valid setup input
- Missing required setup fields
- Malformed dates and invalid date ranges
- Normalization and unknown setup fields
- Valid time ranges
- Invalid start or end
- Missing endpoints
- Reversed ranges
- Boundary times
- Malformed surrounding text
- Identical semantics in projections and exports

## Completion criteria

- Setup validation has one boundary source of truth.
- Projection and export code cannot disagree about whether an item is timed.
- `09:00–25:00` and every other partially malformed range remain untimed.
- Focused tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

Do not restructure the complete Trips page or adjust visual design in this ticket.

## Comments

- Setup codec is `validateTripSetup` in `server/trips/policy.ts` (`TRIP_SETUP_FIELDS` / `TRIP_CONTEXT_FIELDS`). Unknown setup/context keys rejected; mutation envelope ignored. Client `TripSetupBody` is a type-only alias of `TripSetupInput`. UI draft stays in `SetupFormState`; `setupBodyFromForm` maps at submit. HTTP create/update pass the body through that codec.
- `parseTimeWindow` in `server/trips/projections.ts` is the shared strict parser (export ICS uses it). Timed only for a complete valid `HH:MM[-–]HH:MM`; `09:00–25:00` and start-only values stay untimed.
- Tests: `trips-module.test.ts` codec tables; `trips-projections.test.ts` parser table; `trips-export.test.ts` projection/export agreement. Browser export fixture uses `15:00-17:00`.
- Verified: focused module/projections/export 71 pass; `trips-browser.test.ts` 9 pass; `npm run typecheck`; `npm run build`; `npm test` 404 pass.
