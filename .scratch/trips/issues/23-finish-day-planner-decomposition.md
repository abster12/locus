# Finish Day Planner and stop-editor decomposition

Type: task
Status: resolved

## Outcome

The Day Planner coordinates cohesive, independently testable modules instead of owning add workflows, Library search, stop rows, and stop editing in one file.

## Problem

`app/src/trips-stops.tsx` remains approximately 1,000 lines and combines planner state, mutation orchestration, empty-day rendering, placeholder and hole forms, Library search, stop movement, stop display, and the editor. Ticket 16 required a distinct stop-editor feature boundary and focused tests.

## Required boundaries

Extract at least:

1. Planner mutation/history controller hook
2. Day and Unscheduled section rendering
3. Placeholder and hole forms
4. Library-source picker
5. Stop row and movement controls
6. Stop editor

## Requirements

1. Leave `DayPlanner` as a readable composition layer.
2. Give extracted stateful workflows explicit input/output interfaces.
3. Centralize add/fill placement construction so Library and placeholder paths cannot drift.
4. Preserve revision handling, Draft confirmation, undo/redo, hole filling, accessibility names, and responsive behavior.
5. Add direct tests for nontrivial controllers or pure operation builders plus browser coverage for integrated behavior.
6. Avoid replacing the current monolith with one differently named monolith.

## Completion criteria

- Each required boundary has one identifiable owner.
- Stop editing and add/fill operation construction can be tested without exercising the entire Trips route.
- Existing Day Planner, Library, schedule, and responsive browser suites pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Answer

DayPlanner is a composition layer in `app/src/trips-stops.tsx`. Owners: `trips-planner-mutate.ts` (mutation/history hook), `trips-day-section.tsx` (day + Unscheduled), `trips-stop-forms.tsx` (placeholder/hole), `trips-library-picker.tsx` (Library picker), `trips-stop-row.tsx` (row + movement), `trips-stop-editor.tsx` (editor). Add/fill ops go through `buildAddOrFillOps` in `trips-stop-ops.ts`. Direct tests in `tests/trips-client.test.ts`. typecheck, build, and `npm test` 428 pass.

## Comments
