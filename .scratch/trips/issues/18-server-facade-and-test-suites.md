# Trips server facade and test-suite boundaries

Type: task
Status: resolved
Blocked by: 13, 14, 15, 16, 17

## Outcome

The server exposes one narrow Trips facade over cohesive internal modules, and the browser suite is split into independently runnable behavior groups with correct WebMCP scope expectations.

## Problem

- `server/trips/module.ts` owns persistence, hydration, lifecycle, receipts, changesets, undo/redo, search, reviews, inference, and advisories in roughly 1,500 lines.
- HTTP imports multiple Trips internals instead of one stable seam.
- `tests/trips-browser.test.ts` is roughly 1,550 lines with a repeated harness.
- `tests/trips-webmcp-browser.test.ts` expects nine tools on the Trips index even though the scoped contract exposes three there and nine in a Trip Document.

## Required server boundaries

Finish extracting cohesive internal modules for:

1. Repository, persistence, and hydration
2. Lifecycle operations
3. Mutation receipts and idempotency
4. Changesets and undo/redo
5. Reviews and review intent
6. Search and recommendations
7. Inference and advisories

Expose only the operations needed by HTTP, UI-facing APIs, WebMCP, exports, and sharing through a narrow Trips facade. A barrel that re-exports every internal symbol is not a facade.

## Required browser-test boundaries

Extract a shared harness and split scenarios into independently runnable files for:

1. Setup and index
2. Schedule and day editing
3. Recommendations and Library integration
4. Sharing and export
5. Responsive layout and accessibility

Keep fixtures isolated so test results do not depend on file or test order.

## WebMCP correction

1. Assert exactly `list_trips`, `search_trip_sources`, and `create_trip` on the Trips index.
2. Open a Trip Document and assert its intended nine-tool surface.
3. Correct registration counts to reflect replacement across route transitions.
4. Assert cleanup on navigation and absence of tools from the wrong scope.
5. Keep browser expectations consistent with `tests/trips-webmcp.test.ts`.

## Completion criteria

- HTTP and other consumers enter the server Trips domain through one stable facade.
- Internal modules have narrow interfaces and focused tests.
- Transaction boundaries introduced by tickets 13 and 14 remain intact.
- Each browser test file passes when run alone.
- The full browser suite has no ordering dependency.
- WebMCP scope tests reflect three index tools and nine document tools.
- `npm run typecheck`, `npm run build`, and `npm test` pass with zero failures.

## Comments

- Node 2 (facade): added `server/trips/facade.ts` (named exports only: 17 module ops + TripConflict, review intent + RecordAgentReview pair, 6 share ops) and pointed `server/http/server.ts` at the single `../trips/facade.ts` import. No behavior change; tickets 13/14 transaction boundaries untouched. Verified: trips-http + trips-share-http + trips-export 20 pass, `npm run typecheck` clean.
- Node 4 (internals): `module.ts` is now a 56-line compat shim; changesets moved to `changes.ts` (own `tx()`, no receipt wrap), `search.ts`, `advisories.ts` (withTripMutation kept), and review write/intent unified in `review.ts` (no module.ts import; facade exports named symbols only). Verified: 7 focused trips suites 98 pass, remaining trips/client/ui-copy 53 pass, `npm run typecheck` clean.
- Node 6 (browser split): `tests/trips-browser.test.ts` split into `trips-browser-{index,schedule,library,share,responsive}.test.ts` (ports 8810–8814, moved not rewritten) over a shared `trips-browser-harness.ts` (tempDb/startServer/launchBrowser/trackTraffic/setInput/clickByText); `listen()` now reads `LOCUS_PORT` per call; each file passes alone and all six browser files pass together 13/13, `npm run typecheck` clean.
- Node 3 (repository + lifecycle): extracted `server/trips/repository.ts` (document/row types, parse/hydrate, getTrip/listTrips/tripRowOrNull/insertDays/reconcileDays/requireStopRow/requireDayRow/resolveStopContent; imports only policy/db/core/atlas) and `server/trips/lifecycle.ts` (create/update/rename/duplicate/archive/restore/delete via withCreateMutation/withTripMutation; no module import); `withTripMutation` moved into `receipts.ts`; `share.ts` now imports receipts+repository; `module.ts` 1499→790 lines, re-exports moved public symbols, keeps changesets/search/review-apply with their own `tx()`. Verified: 6 focused trip test files 82 pass + 7 more 64 pass + browser 13 pass, `npm run typecheck` clean.
- Done: HTTP enters via `server/trips/facade.ts` (named exports only). Internals: repository, lifecycle, receipts, changes (own `tx()`), search, advisories, review. `module.ts` is a test compat shim. Browser suite: index/schedule/library/share/responsive + harness, ports 8810–8814. WebMCP: 3 index / 9 document. `listen()` reads `LOCUS_PORT` per call.
- Verified: each `tests/trips-browser-*.test.ts` alone; `trips-webmcp-browser.test.ts`; `npm run typecheck`; `npm run build`; `npm test` 409 pass. Reviewer OK; oracle no P0/P1.
