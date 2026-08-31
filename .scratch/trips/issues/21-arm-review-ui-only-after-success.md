# Arm the review UI only after server success

Type: task
Status: resolved
Blocked by: 20

## Outcome

The review WebMCP tool and “armed” status appear only after the server has persisted a valid review intent for the current session and Trip.

## Problem

`TripDocumentPage` calls `onRequestReview()` in `finally`. Network, authorization, validation, and server failures therefore expose `record_trip_review` and tell the user the agent can save a review even though no intent exists.

## Scope

- `app/src/trips-document.tsx`
- Review-request state in `app/src/TripsPage.tsx`
- `app/src/trips-webmcp.ts` lifecycle integration
- Focused client and browser tests

## Requirements

1. Enter the armed client state only after a successful `armTripReview` response.
2. Keep the review tool absent after any failed arm request.
3. Display an accessible error and restore an enabled retry action after failure.
4. Prevent overlapping arm requests and duplicate registrations.
5. Reset armed state when navigating away, changing Trip, or successfully consuming the intent.
6. Preserve the rule that merely opening a Trip never arms review.

## Tests

Add focused coverage for successful arm, HTTP failure, network failure, double click, navigation cleanup, successful consumption, and retry after failure. Browser assertions must inspect the actual WebMCP tool set and visible status.

## Completion criteria

- No failure path can display the armed message or register `record_trip_review`.
- A successful arm registers the tool once and successful use removes it.
- Focused review lifecycle tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Answer

`Ask agent to review` awaits `armTripReview` and arms only on success (`run()` + `busyRef`). Failures keep the tool off, show `p.bad[role=alert]`, and leave retry enabled. Armed state is the Trip id, not a boolean: a late success for Trip A cannot arm Trip B. Consume and `[mode, tripId]` still clear it. `trips-webmcp.ts` unchanged.

Browser coverage in `tests/trips-webmcp-browser.test.ts`: success+consume, HTTP/network fail, double-click, nav, retry, delayed cross-Trip arm. `npm run typecheck`, `npm run build`, `npm test` (414) pass.

## Comments
