# Make Trip Stop cards the details surface

Type: task
Status: resolved
Blocked by: 25

## Outcome

Each Trip Stop is a compact elevated card whose full primary surface opens accessible details, with Draft review and contextual actions progressively disclosed.

## Problem

The current stop row exposes status pills, a Details disclosure, up/down controls, Move, Edit, Keep, and Remove at once. This makes the planner visually dense and requires a small secondary target to inspect the content. Direction A makes itinerary comprehension primary and moves operations into details or a contextual menu.

## Scope

- `app/src/trips-stop-row.tsx`
- A focused stop-details component or module
- `app/src/trips-format.ts`
- Trips-only selectors in `app/src/styles.css`
- Stop-row unit tests and Trips browser library/schedule/accessibility coverage

## Implementation

1. Render one semantic list item/card per stop with time, title, useful compact metadata, and an optional textual Draft cue.
2. Make the card's primary surface a real button that opens a modal details surface. Give it a useful accessible name such as `Open details for …`.
3. Keep nested source links, drag handle, and contextual action menu independently interactive; their activation must not open details.
4. Move source, address/location, reservation, public/private notes, provenance, stored facts, alternatives, and broken-reference context into the details surface.
5. Confirmed is the unlabelled visual default. Keep its state available to assistive technology where context requires it.
6. Draft uses visible text, a dashed neutral border, and a quieter surface at full content contrast. Draft details expose **Keep stop**, **Edit Draft**, and **Remove Draft**.
7. Keep holes visibly distinct and fully clickable while preserving Fill and Dismiss actions.
8. Put Edit, Move to day/Unscheduled, placement fallback, and Remove in the contextual menu. Keep bulk Draft confirmation as a secondary planner action when multiple Drafts are visible.
9. Use a native dialog or equivalent focus-managed modal: labelled title, initial focus, Escape close, focus restoration, and no background interaction.
10. Preserve existing changeset notes, busy states, errors, and Undo/Redo behavior.

## Tests

- Pointer and Enter/Space activation on the card open the correct details.
- Source links, menu controls, and the future drag handle do not open details.
- Details expose every applicable bounded field and missing-reference state.
- Draft is exposed as text, Keep confirms exactly one stop, and removal targets only that Draft.
- Confirmed cards have no persistent Confirmed pill.
- Dialog focus is trapped/restored and Escape closes without mutation.
- Cards remain readable and operable at desktop, tablet, 320px, dark theme, forced colors, and reduced motion.

## Completion criteria

- The default planner surface contains itinerary information rather than a row of operations.
- Every stop remains fully operable by pointer, touch, and keyboard.
- Relevant focused tests, `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

- Replacing the Trip Stop model.
- Loading external map or booking data.
- Drag implementation, which belongs to issue 28.

## Answer

Each stop is an elevated card. The primary surface is `Open details for …` and opens a native dialog (title focused, Escape restores focus, no write). Source links, the future drag handle, and the actions menu stay independently clickable. Confirmed has no pill; Draft is text plus a dashed quieter card; holes keep Fill/Dismiss on the card. Edit / move / remove live in the menu; Draft details expose Keep stop, Edit Draft, and Remove Draft. Keep all drafts stays on the planner when more than one Draft is visible. `npm run typecheck`, `npm run build`, and `npm test` pass.
