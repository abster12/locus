# 06: Show Overview, Schedule, and empty-day states

**What to build:** Implement the approved Direction A projections on the normal Trip Document route. Day Planner remains the editing surface. Overview summarizes the trip as day cards, and Schedule lays the same timed stops onto a calendar-like grid; neither owns separate editable data. An empty day is a deliberate, useful state with manual actions and visible Unscheduled possibilities, not a prompt that automatically calls an agent.

**Blocked by:** 04: Edit a Day Planner with reversible changesets.

**Status:** done

- [x] Overview follows the locked prototype: compact trip identity and health, one card per day, date, time range, stop count, two or three anchors, open conflicts, and an Open Day action. (Holes are a ticket-07 entity and are not faked.)
- [x] An empty day card is visibly different from a populated day (dashed card, "Open day", "Plan this day →") and opens the approved empty-day screen rather than an empty generic panel.
- [x] The empty-day screen offers Add from Library, Add a placeholder, and Ask for three opinions; merely opening it performs no inference or mutation (verified: zero POSTs on open and on the opinions control).
- [x] Relevant Unscheduled entries appear alongside the empty day without being placed automatically.
- [x] Schedule is a projection of the same stable Trip Days and Stops; it is read-only this ticket, so every edit that exists still flows through the same changeset engine and updates Day Planner and Overview immediately.
- [x] Sticky day navigation (Overview · each day · Schedule, `aria-current`), compact default rows, details disclosures, and responsive one-column/mobile behavior match the approved prototype's hierarchy.
- [x] All view changes and state labels are keyboard and screen-reader accessible (native hash links, `aria-current`, `role=table` calendar semantics), with no behavior dependent on hover, drag, color, or motion.
- [x] Browser regression tests cover projection consistency after edits, Overview content, empty-day actions, no-inference opening, Schedule timezone placement, focus/keyboard navigation, responsive 320px layout, and reduced motion. Module/view-model tests verify that all projections derive from one Trip Document. Relevant existing tests, typecheck, and build remain green.

## Comments

Projections live in the pure module `server/trips/projections.ts`: `projectTripOverview` (health counts, per-day time range/anchors/conflicts) and `projectTripSchedule` (hour rows derived only from real stop times, per-day untimed + unscheduled lists). `parseTimeWindow` reads one clock time as a start and a pair as a range; junk text, impossible times, and start-only windows never claim conflicts or schedule slots — nothing invents durations or clock times. Conflicts require both stops to have parseable ranges that intersect (same day).

Routing: `#/trips/:id?view=overview|schedule|<dayId>` (query survives Back/Forward; unknown/stale view falls back to Overview). Document default is Overview like the prototype. Sticky `TripNav` tabs with `aria-current`. Day tabs render the existing Day Planner focused on one day (`focusDayId` filter — no planner rewrite); an empty focused day renders the approved empty-day card (Add from Library / Add a placeholder / Ask for three opinions) inside the same section, with Unscheduled below. "Ask for three opinions" sets an honest status notice and calls nothing; the recommendations drawer/sheet is ticket 07. Schedule is a read-only projection with honest untimed/unscheduled lists ("Day 2 untimed: …"), labelled with the document timezone.

Tests 2/4/5 in `tests/trips-browser.test.ts` were adapted to the Overview default (day assertions now read overview cards; planner flows click the Day 1 tab first — all previously verified behaviors unchanged and passing). New coverage: `tests/trips-projections.test.ts` (6 view-model tests) and browser test 6 (consistency after edits, health/anchors/conflicts, empty-day no-POST, schedule timezone + untimed honesty, 320px, reduced motion, zero external calls).

Commands: `npx tsc --noEmit` clean, `npm test` 300 pass / 0 fail, `npx vite build` + `npm run build` green. Files: `server/trips/projections.ts` (new), `app/src/TripsPage.tsx`, `app/src/App.tsx`, `app/src/styles.css` (Locus tokens only), `tests/trips-projections.test.ts` (new), `tests/trips-browser.test.ts`.
