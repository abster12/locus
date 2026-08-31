# Centralize Trip stop persistence

Type: task
Status: resolved

## Outcome

Every path that writes a complete `trip_stops` row uses one repository-owned serialization and insertion primitive.

## Problem

Trip duplication in `server/trips/lifecycle.ts` and undo restoration in `server/trips/changes.ts` independently maintain the same 16-column insertion statement. A future column change can silently make clone and restore behavior diverge.

## Scope

- `server/trips/repository.ts`
- `server/trips/lifecycle.ts`
- `server/trips/changes.ts`
- Clone, removal, undo, and redo tests

## Requirements

1. Introduce one repository primitive for inserting a complete stop snapshot.
2. Make identity policy explicit: duplication creates a new stop id, while undo restoration preserves the removed stop id.
3. Make timestamp policy explicit: duplication uses clone time; restoration preserves snapshot creation/update semantics required by history.
4. Preserve every private and public field, including provenance, reservation, facts, alternatives, notes, time, duration, state, day, and position.
5. Keep list reindexing and collision handling in the owning changeset workflow.
6. Route both duplication and restoration through the primitive.

## Tests

Add a field-complete fixture and prove duplicate, remove/undo, and redo round-trip every persisted stop field with the correct identity and timestamps. Include placement among existing stops.

## Completion criteria

- Exactly one production insertion shape owns complete `trip_stops` serialization.
- Clone and restore behavior remain transactionally identical to their current contracts.
- Focused persistence and changeset tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Answer

`insertStopSnapshot` in `server/trips/repository.ts` is the only production 16-column `trip_stops` insert. Clone (`insertClonedStop`) passes a new id and clone time; restore (`restoreStop`) passes the snapshot id and timestamps, then reindexes collisions in the changeset. `addStop` stays a partial 13-column insert. Duplicate + remove/undo/redo tests cover every persisted field, identity, timestamps, and sibling placement. typecheck, build, and `npm test` 429 pass.

## Comments
