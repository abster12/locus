# Show an understandable history of dismissed advisories

Type: task
Status: resolved

## Outcome

Dismissed agent advisories leave the active Trip view while remaining visible as an understandable, read-only historical record.

## Problem

Dismissal retains the database row, but normal Trip hydration filters dismissed advisories and the visible History panel renders only changesets. The user cannot inspect what advice was dismissed, when it was created, or when it was dismissed.

## Scope

- Trips advisory repository/query boundary
- Trip history API shape where appropriate
- `app/src/trips-advisories.tsx`
- Advisory HTTP, projection, and browser tests

## Requirements

1. Keep active advisories separate from dismissed advisory history.
2. Expose dismissed entries only to the owning Library through a bounded read model.
3. Preserve opinion, rationale, category, severity, reviewed revision, references, creation time, dismissal time, and stale/removed-reference interpretation.
4. Show dismissed advisories in a clearly labelled read-only history section.
5. Keep dismissed advisories out of the active “Agent opinions” surface and out of deterministic Trip health.
6. Do not make dismissal reversible unless the Trips spec is explicitly changed.

## Tests

Add focused coverage proving dismissal removes the active card, preserves the database record, exposes it through the authorized history read, renders its status and timestamps, handles removed day/stop references honestly, and rejects cross-Library reads.

## Completion criteria

- A user can understand what was dismissed and when without querying the database.
- Active and historical advisory counts cannot be confused.
- Focused advisory-history tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Answer

Dismissed advisories stay off `getTrip` / Agent opinions and off Trip health. Owning-Library history is `getTripHistory.dismissedAdvisories` (newest 100). History panel shows a read-only **Dismissed agent opinions** section with timestamps, stale/removed-ref mapping, no undismiss.

## Comments
