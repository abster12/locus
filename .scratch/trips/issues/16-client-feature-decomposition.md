# Trips client feature decomposition

Type: task
Status: resolved
Blocked by: 15

## Outcome

`TripsPage.tsx` becomes a thin route and composition layer. Trips UI behavior lives in cohesive, independently testable feature modules behind a narrow client Trips facade.

## Problem

The current page combines index routing, setup, overview, schedule, stop editing, recommendations, sharing, export, advisories, history, and WebMCP lifecycle in roughly 2,700 lines. Client consumers also reach directly into internal Trips projection and export modules.

## Required boundaries

Extract cohesive modules for at least:

1. Trip index and setup
2. Trip Document shell and navigation
3. Overview
4. Schedule and day view
5. Stop editor
6. Recommendations and Library actions
7. Sharing and export
8. Advisories and history
9. Trips WebMCP lifecycle integration

## Requirements

1. Keep `TripsPage.tsx` responsible for route interpretation and high-level composition only.
2. Extract stateful workflows into focused hooks or controllers where that creates a testable seam.
3. Establish a small client Trips facade for the operations the UI and WebMCP adapter need.
4. Keep projections, exports, and other client internals behind the facade.
5. Give every nontrivial extracted workflow focused tests.
6. Preserve keyboard behavior, semantic structure, accessibility names, responsive behavior, and visible UI behavior.
7. Preserve working WebMCP registration and abort-signal cleanup.
8. Produce genuine feature modules; moving the monolith into one replacement file does not satisfy this ticket.

## Completion criteria

- `TripsPage.tsx` is materially smaller and readable as a route/composition file.
- Each listed feature has an identifiable owner and test seam.
- Client imports use the stable facade rather than projection/export internals.
- Existing Trips browser behavior remains unchanged.
- Focused unit and browser tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

Preserve the visual design in this ticket. Responsive and CSS corrections belong to ticket 05.

## Comments

- `TripsPage.tsx` is route + WebMCP attach + compose (~73 lines). Feature modules: `trips-index.tsx` (index/setup), `trips-document.tsx` (shell/nav), `trips-overview.tsx`, `trips-schedule.tsx`, `trips-stops.tsx` (day planner + library add), `trips-recommendations.tsx`, `trips-share.tsx`, `trips-advisories.tsx` (advisories + history), `trips-webmcp.ts`. Shared display helpers in `trips-format.ts`.
- Client facade `app/src/trips.ts` is the only app import of projection/export internals; `parseTimeWindow` stays hidden. UI/WebMCP do not import `server/trips/projections.ts` or `export.ts`.
- Tests: `tests/trips-client.test.ts` (setupBodyFromForm, resolveTripView, parseRecommendations). Visual CSS unchanged (ticket 17).
- Verified: focused client/webmcp/ui-copy 27 pass; `trips-browser.test.ts` 9 pass; `trips-webmcp-browser.test.ts` 3 pass; `npm run typecheck`; `npm run build`; `npm test` 408 pass.
