# 07: Review drafts, holes, and recommendations

**What to build:** Add the visible collaboration states needed before exposing agent writes on a Trip Document route. Agent-authored itinerary content is Draft until the user keeps it. A hole is a durable user need at a specific day and order. An open-ended choice is presented like Reading recommendations: exactly three temporary, opinionated options in a drawer or mobile sheet, and nothing enters the Trip Document until the user selects one. Exact user decisions remain direct edits and do not create recommendation clutter.

**Blocked by:** 05: Plan with Library sources and Unscheduled entries.

**Status:** done

- [x] Agent-created stops and agent replacements begin Draft; a mechanical move of an already Confirmed stop under an exact instruction may retain Confirmed state while recording agent provenance.
- [x] The user can keep or remove an individual Draft and can Keep All currently visible Drafts in one human changeset without confirming future content.
- [x] A hole stores a bounded request at a stable day/Unscheduled placement and survives close/reopen until filled, dismissed, or removed.
- [x] Filling a hole replaces it at the same placement without leaving a phantom gap or silently confirming unrelated Drafts.
- [x] An open-ended request produces exactly three recommendations containing a concise opinion, why it fits, an important tradeoff, provenance/basis, proposed placement, and likely schedule effect.
- [x] Recommendations appear in a temporary desktop drawer or mobile bottom sheet. They are not itinerary stops, saved Items, or durable agent prose before selection.
- [x] Selecting a recommendation creates one user-authored changeset at the proposed or user-adjusted placement; dismissing the sheet leaves the Trip Document unchanged.
- [x] Recommendation content, rationale, arrays, identifiers, and URLs are bounded and sanitized. Outside options do not become Items automatically.
- [x] Real-database tests cover Draft actor rules, Keep/Keep All, hole placement/fill/dismiss, selection atomicity, and no phantom state. Browser tests cover exactly three rich options, human selection, dismissal without mutation, focus trapping, mobile presentation, and accessible state text. Relevant existing tests, typecheck, and build remain green.

## Comments

Module (`server/trips/policy.ts`, `server/trips/module.ts`): `TripStopContent` gained `{ kind: "hole", request }` (bounded like stop text, trip-owned, never a Library reference, never "broken"). `applyTripChanges` now derives stop state from the trusted actor: non-`user` actors add stops as Draft with `{ actor, via: "agent" }` provenance, and agent `updateStop` is a replacement that demotes the stop to Draft under agent provenance. An agent `updateStop { state: "confirmed" }` is rejected — Draft review cannot be bypassed. An agent `moveStop` of a Confirmed stop keeps the state and records `{ via: "agent move" }`. `updateStop` gained a `state` field for the human Keep path; its captured inverse restores content, timing, notes, state, AND prior provenance (moves likewise), so undo/redo remain complete changesets — verified by tests.

Keep All is not a new endpoint: the UI composes one `applyTripChanges` changeset of `updateStop { state: "confirmed" }` ops for every Draft currently on the document, so it is one human revision bump that cannot confirm future agent content (asserted). Holes are ordinary stops: added via per-day and Unscheduled "Add a hole", ordered/reordered like any stop, dismissed via removeStop, and filled by one changeset of `removeStop(hole)` + `addStop` anchored to the stop that followed the hole — no phantom gap, unrelated drafts untouched.

Presentation (`app/src/TripsPage.tsx`): `window` event `locus:trip-recommendations` delivers exactly three options (opinion, fit, tradeoff, basis, effect, typed operations) which the page validates, bounds (280 chars/field), and holds as transient React state — no persistence, no table. The drawer mirrors the Reading recs pattern with Locus tokens: desktop side drawer, ≤480px bottom sheet, focus trap + Escape + backdrop dismiss, focus restored on close. Selection applies the option's operations as one human `applyTripChanges` rechecked against the current revision (stale 409 fails safely inside the sheet); dismissal mutates nothing (asserted via write counts and an unchanged revision counter). The empty-day "Ask for three opinions" button re-opens the last presented panel or shows the honest no-agent notice — it never POSTs. `server/trips/projections.ts` now counts holes separately per day (`stopCount` excludes them; anchors/conflicts/schedule never treat a hole as a timed stop), so Overview day cards read "N open holes" without fake stops.

Tests: `tests/trips-module.test.ts` +5 (draft actor rules incl. agent-cannot-confirm, agent move keeps Confirmed + provenance restored by undo, Keep-All single changeset, hole place/fill/dismiss with ordering + no phantom state + bounds, selection = one human changeset). `tests/trips-browser.test.ts` +1 (seeded Draft text + Keep + Keep-All(2)=one POST, hole add/fill/dismiss, exactly 3 rich options, Escape/backdrop dismiss with unchanged revision, focus trap, selection = one POST with visible stop, 320px bottom sheet without overflow, writes only `POST /api/trips*`, zero external calls).

Commands: `npx tsc --noEmit` clean; trips suite `tests/trips-module.test.ts tests/trips-http.test.ts tests/trips-browser.test.ts tests/trips-projections.test.ts` 56/56; `npm test` 306/306 (was 285); `npx vite build` before browser tests; `npm run build` green. Not started: 08–12.
