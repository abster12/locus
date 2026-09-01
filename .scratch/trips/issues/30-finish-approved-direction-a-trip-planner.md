# Finish the approved Direction A Trip Planner

Type: task
Status: resolved
Blocked by: 26, 27, 28, 29

## Outcome

The production Trip Document matches the approved Direction A hierarchy across planned, new-empty-trip, and empty-day states, with a coherent Locus visual system and complete regression coverage.

## Problem

The preceding tickets establish the behavior in bounded modules. A final integration pass is needed to remove legacy layout remnants, apply one visual rhythm, and prove that the end-to-end flow works across themes, input modes, and viewport sizes without weakening existing Trips capabilities.

## Reference

- Approved interaction prototype: `.scratch/trips/ux-options-prototype.html`
- Product contract: `.scratch/trips/spec.md`
- Existing production tokens and responsive system: `app/src/styles.css`

The prototype determines information hierarchy and flow. Production components, semantic HTML, live data, and established Locus tokens determine implementation details.

## Scope

- Trip Document and Day Planner composition
- Trips-only styles
- Planned day, new empty Trip Document, and empty focused day
- Existing Overview, Schedule, recommendations, advisories, history, sharing, and exports as integration consumers
- Trips client, browser, responsive, share, WebMCP, and module suites

## Implementation

1. Remove superseded inline forms, duplicate theme presentation, status pills, exposed arrow pairs, and primary action rows left behind by issues 26–29.
2. Apply the approved hierarchy:
   - one day theme presentation;
   - one Add stop action;
   - elevated stop cards;
   - dashed, fully legible Draft treatment;
   - whole-card details;
   - concise Unscheduled and Activity/recovery disclosures.
3. Use semantic Locus color tokens for surfaces, text, borders, Draft, holes, focus, danger, and informational source kinds. Verify contrast in light and dark themes.
4. Use the established display/UI type pairing with a restrained scale, readable line lengths, stable numeric time columns, and 16px mobile form controls.
5. Keep interactive targets at least 44px where touch is expected. Ensure menus and dialogs remain inside the viewport and do not cause horizontal document overflow.
6. Preserve no-inference-on-open, trusted actor, revision, idempotency, Share Snapshot, export, and WebMCP boundaries.
7. Update browser selectors toward roles, labels, and user-visible outcomes so tests assert the new contract rather than legacy class structure.
8. Capture deterministic screenshots for the three approved states at 1440px, tablet, and 320px in the existing Trips screenshot directory.

## Tests

- Planned day: Confirmed and Draft cards, details, review, drag, contextual movement, add flow, Unscheduled, and recovery.
- New empty Trip Document: first-stop path, optional guidance, zero automatic inference.
- Empty day: Add stop, Ask agent for options, relevant Unscheduled entry, zero automatic inference.
- Light, dark, forced-colors, reduced-motion, pointer, touch, and keyboard behavior.
- No horizontal overflow at 1440px, tablet, and 320px.
- Overview and Schedule remain projections of the same saved Trip Document after every new interaction.
- Share, export, WebMCP, authorization, revision, idempotency, and full Trips regression suites remain green.

## Completion criteria

- Production behavior and hierarchy match all three approved Direction A prototype states without prototype-only controls.
- The former dense planner controls are absent from the default surface while their supported capabilities remain reachable.
- Automated screenshots and accessible browser outcomes cover every approved state.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

- Copying prototype HTML or JavaScript into production.
- New maps, booking, collaboration, autonomous agent, or external-data features.
- Unrelated redesigns of Desk, Atlas, Kitchen, or Reading.

## Answer

Focused day uses one theme field, one Add stop, elevated cards (Draft dashed + ink label), whole-card details, Unscheduled as a disclosure, and Activity and recovery as a disclosure. Source kinds use `--info`; holes `--warn`; focus `--focus`; danger `--bad`. Screenshots: `planned`, `empty-trip`, `empty-day` at 1440/768/320 in `.scratch/trips/shots/`. `npm run typecheck`, `npm run build`, and `npm test` pass (462).
