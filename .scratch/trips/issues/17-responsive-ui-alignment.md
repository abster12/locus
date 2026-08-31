# Trips responsive UI and alignment

Type: task
Status: resolved
Blocked by: 16

## Outcome

Trips matches the intended Direction A layout at desktop and narrow mobile widths, with aligned columns, no horizontal overflow, and one empty-day action group.

## Problem

- Empty-day actions are rendered in both the day header and empty-state card on mobile.
- `.trip-row`, `.trip-calendar`, and `.trip-calendar-row` have competing definitions whose cascade order can override the intended grid and `--trip-day-count` behavior.

## Scope

- Extracted Trips UI components
- Trips rules in `app/src/styles.css`
- Responsive Trips browser tests

## Requirements

1. Render exactly one primary empty-day action group at every breakpoint.
2. Keep both `Add from Library` and `Add a placeholder` available.
3. Remove the duplicate rendering path instead of leaving hidden interactive duplicates.
4. Consolidate each Trips component's base CSS into one authoritative definition.
5. Place explicit responsive overrides beside the relevant component rules or in clearly owned breakpoint sections.
6. Preserve intentional `--trip-day-count` grid behavior.
7. Verify index columns, document shell, context rail, schedule grid, day headers, stop cards, controls, and empty states.
8. Maintain a viewport-width layout with no horizontal document overflow at 320px.
9. Preserve readable focus indicators, touch targets, accessible names, and keyboard access.

## Browser verification

Test at minimum:

- 1440px desktop
- A representative tablet width
- 320px mobile

Assert action counts and document width programmatically. Perform visual inspection for column, baseline, spacing, rail, card, and control alignment.

## Completion criteria

- Each empty-day action appears once at 320px.
- `scrollWidth` does not exceed viewport width at 320px.
- Trips CSS has no competing base definitions for the named components.
- Desktop and mobile screenshots show aligned content without clipped controls.
- Responsive browser tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Comments

- Empty-day Library/placeholder live only on `.trip-empty-card` (`trips-stops.tsx`). Header keeps Theme + Add a hole. Unscheduled keeps its own add row.
- CSS: one `.trip-row` grid; one `.trip-calendar` / `.trip-calendar-row` using `--trip-day-count` (dropped competing flex + `auto-fit`). Scroller owns overflow.
- Tests: unique action counts in the existing empty-day path; new 1440 / 768 / 320 pass for index columns, empty-day uniqueness, calendar tracks, and `scrollWidth` at 320. Shots in `.scratch/trips/shots/`.
- Verified: `npm run typecheck`; `npm run build`; `tests/trips-browser.test.ts` 10 pass; `npm test` 409 pass.
