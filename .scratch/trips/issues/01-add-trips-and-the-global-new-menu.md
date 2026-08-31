# 01: Add Trips and the global + New menu

**What to build:** Add Trips as a normal top-level Locus section and add a visible, labelled + New menu to the global header. Trips uses ordinary routes for its index and Trip Documents rather than an overlay. The + New menu exposes three honest entry points: Plan a trip hands off to Trips, Save a link hands off to capture and Reading discovery, and Make a saved dish cookable hands off to Kitchen to choose a Food Item. The menu improves discoverability without merging the domains or inventing blank Reading Documents and recipes.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] Trips appears in primary navigation alongside Desk, Atlas, Kitchen, and Reading, with correct active-page and accessible-current-page state.
- [x] The Trips index and individual Trip Documents use stable ordinary routes. Direct navigation, refresh, browser Back/Forward, and internal navigation behave like the rest of Locus.
- [x] The global header shows a labelled + New control rather than an unlabeled plus, hamburger, homepage-only action, or hidden overflow entry.
- [x] + New is available on primary desktop and mobile pages and opens an accessible popover containing Plan a trip, Save a link, and Make a saved dish cookable.
- [x] Plan a trip routes to the Trip Document setup flow; Save a link reuses capture; Make a saved dish cookable routes to Kitchen to select a saved Food Item. The menu owns no capture, Reading, or Kitchen policy.
- [x] The Trips contextual primary action is Plan a trip, including on an empty Trips index.
- [x] Navigation, opening the menu, and entering Trips never invoke inference or mutate Library, Trip, Reading, or Kitchen state.
- [x] The implementation follows the locked Trips prototype and contains no overlay, generic Scratch Pad, job selector, Kitchen board, Reading workspace, direction picker, or design-development chrome.
- [x] Automated browser regression tests cover route navigation, Back/Forward and refresh, active navigation state, keyboard menu operation, focus/Escape/outside-click behavior, responsive layouts, correct handoff destinations, and absence of inference or mutation. Relevant existing tests, typecheck, and build remain green.

## Comments

Shipped nav + labelled + New + stub Trips routes (`#/trips`, `#/trips/new`, `#/trips/:id`). Setup is a destination only; persistence is ticket 02. Desk/home copy unchanged. Evidence: `tests/trips-browser.test.ts`, `tests/ui-copy.test.ts`; `npx tsc --noEmit`, `npm test` (251 pass), `npm run build` green.
