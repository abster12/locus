# Make drag the primary Trip Stop reorder interaction

Type: task
Status: resolved
Blocked by: 27

## Outcome

Pointer and touch users reorder Trip Stops by dragging the card handle, while keyboard and menu users get equivalent placement controls backed by the same `moveStop` operations.

## Problem

Persistent up/down buttons consume space and communicate implementation mechanics rather than itinerary structure. Native HTML drag alone does not provide reliable touch or keyboard behavior. The approved design needs direct manipulation without weakening the existing accessibility contract.

## Scope

- `app/src/trips-stop-row.tsx`
- `app/src/trips-day-section.tsx`
- `app/src/trips-stops.tsx`
- `app/src/trips-stop-ops.ts`
- Trips-only drag/drop styles
- Client operation-builder and browser schedule/responsive tests

## Implementation

1. Add a clearly named drag handle with a minimum 44px hit target; dragging the card body remains reserved for opening details.
2. Implement pointer and touch reordering without adding a dependency unless the implementation proves the in-repo event model cannot meet touch, cancellation, and accessibility requirements.
3. Represent drag state by stop id and target placement, never an absolute client index. Commit one existing `moveStop` operation on drop.
4. Support reordering within a day and Unscheduled. Cross-day movement remains available through explicit Move controls unless a tested cross-container drag can be added without obscuring placement.
5. Provide keyboard lift, move before/after, and drop/cancel behavior with concise live-region announcements.
6. Keep contextual **Place before**, **Place after**, **Move to day**, and **Move to Unscheduled** controls as the non-drag fallback.
7. Remove persistent up/down button pairs from the default card.
8. On successful movement, use the existing mutation controller and expose one recoverable Undo action. Failed or stale writes return the card to its saved order and announce the error.
9. Avoid motion-dependent meaning; respect reduced motion and forced-colors modes.

## Tests

- Reordering emits one stable-id `moveStop` operation with the correct before/after anchor.
- Pointer drag, touch drag, and keyboard movement produce the same persisted order.
- Escape cancels an active drag and writes nothing.
- Dragging cannot activate card details or the contextual menu.
- A stale or failed mutation restores the saved order and announces the failure.
- Move-to-day and Move-to-Unscheduled fallbacks remain fully keyboard operable.
- Reorder interactions fit and scroll correctly at 320px.

## Completion criteria

- Drag is the primary visible reorder affordance and persistent arrow controls are gone.
- Every drag outcome has an accessible non-drag equivalent.
- Focused tests, `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

- Freeform calendar positioning.
- Invented travel-time or route calculations.
- A second ordering model outside Trip Changesets.

## Answer

Drag handle is the primary reorder control (44px, pointer + touch, no new dependency). Drop commits one `moveStop` by stop id and before/after anchor; Escape writes nothing. Keyboard lift/arrows/drop and menu Place before/after / Move to day / Unscheduled share those ops. Persistent up/down controls are gone. Stale writes keep the saved order and announce via the existing alert. `npm run typecheck`, `npm run build`, and `npm test` pass.
