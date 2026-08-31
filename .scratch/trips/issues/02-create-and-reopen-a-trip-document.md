# 02: Create and reopen a Trip Document

**What to build:** Let a user create an empty, durable Trip Document from Plan a trip and reopen it later from the Trips index. Destination plus dates or trip length are the only required setup inputs. Everything else—title, timezone, travelers, lodging anchors, pace, mobility, budget, interests, meal preferences, must-dos, and hard constraints—is optional user-authored context stored with the Trip Document for later manual or agent use. The same Trips module contract must serve local-only and hosted adapters, with every document scoped to its owning Library.

**Blocked by:** 01: Add Trips and the global + New menu.

**Status:** done

- [x] A user can create a Trip Document with destination and either a date range or duration, without answering optional setup questions or invoking an agent.
- [x] The created document has a stable identity, Library owner, title, timezone when supplied, ordered Trip Days, revision, archive state, and timestamps.
- [x] Optional setup values are bounded, validated, editable, and presented as user-entered context rather than inferred facts.
- [x] Leaving, refreshing, directly opening, and returning to Trips restores the selected Trip Document without deleting or silently rebuilding it.
- [x] Hosted requests derive Library ownership from the authenticated session; local-only requests retain loopback session and CSRF protections while using the same domain operations.
- [x] One Library cannot list, read, select, or mutate another Library's Trip Documents.
- [x] Module tests with a real test database cover required/optional setup, persistence, current-document selection, Library isolation, and invalid bounds. HTTP and browser tests cover create/reload/reopen, authorization failures, and no-inference creation. Relevant existing tests, typecheck, and build remain green.

## Comments

Implemented the Trips module seam (`server/trips/policy.ts` bounds + `server/trips/module.ts` create/list/get/update), schema v13 (`trips` + `trip_days`, days as ordered child rows with stable ids), HTTP routes (`GET/POST /api/trips`, `GET /api/trips/:id`, `POST /api/trips/:id/update`) using session + global CSRF and `LOCAL_LIBRARY_ID` from the trusted adapter, client API methods, and the real setup form / index rows / document view in `app/src/TripsPage.tsx`. Title defaults to destination; date range or duration required (mismatch rejected); duration-only trips keep honest open dates; revision starts at 1 and increments per setup update; edit setup lives on the document page.

Commands: `npx tsc --noEmit`, `npm test` (263 pass), `npm run build`, plus `npx vite build` before browser tests. Key tests: `tests/trips-module.test.ts` (required/optional setup, bounds, day generation, persistence, revision, Library isolation, agent-shaped fields ignored), `tests/trips-http.test.ts` (create/list/get/update, 401/403/404/400, body libraryId/actor ignored), `tests/trips-browser.test.ts` (create → document route, refresh/reopen, index row click, Back, duration-only, no writes beyond the two creates, no external calls).
