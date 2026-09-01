# Allow human-created Draft Trip Stops

Type: task
Status: resolved

## Outcome

A human can deliberately save a new Trip Stop as Draft, while omitted human state still creates Confirmed content and every agent-created or agent-replaced stop remains Draft.

## Problem

The approved Direction A add flow offers **Add stop** and **Save as Draft**. The current changeset engine derives every add state only from the trusted actor, so a human-authored add cannot request Draft without a second mutation. That would create misleading history and make one form submission span two revisions.

## Scope

- `.scratch/trips/spec.md`
- `app/src/api.ts`
- `app/src/trips-stop-ops.ts`
- `server/trips/policy.ts`
- `server/trips/changes.ts`
- Trips module, HTTP, WebMCP, and client operation-builder tests

## Implementation

1. Add optional `state: "confirmed" | "draft"` to the client and server `addStop` operation contracts.
2. Parse and bound that state through the existing changeset envelope; keep internal inverse operations field-complete.
3. Derive persisted state from both trusted actor and request:
   - human plus omitted state → Confirmed;
   - human plus Draft → Draft;
   - agent plus omitted, Draft, or Confirmed request → Draft.
4. Preserve `{ actor: "user", via: "manual" }` provenance for a human-created Draft. State is review status, not authorship.
5. Keep confirmation human-only. Agent `updateStop { state: "confirmed" }` remains rejected.
6. Extend the shared add/fill builder to accept requested state so Library and outside-content paths cannot diverge.
7. Update WebMCP schemas and descriptions only as needed to accept the widened operation without granting agents confirmation authority.

## Tests

- Human add without state is Confirmed.
- Human add with Draft state is Draft with manual human provenance.
- Agent add is Draft even when Confirmed is requested.
- Agent replacement and confirmation protections remain intact.
- Remove/Undo/Redo and fill-hole changesets restore exact state and provenance.
- Invalid add state rejects the entire changeset without a revision increment.
- HTTP and WebMCP contracts round-trip the optional field without trusting client-supplied actor identity.

## Completion criteria

- One add changeset can create a human Draft without a follow-up mutation.
- Trusted-actor invariants hold at the server boundary.
- Existing Confirmed-by-default behavior remains backward compatible.
- Focused Trips tests, `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

- Visual Draft treatment.
- Add-dialog layout.
- Changes to Share Snapshot inclusion rules.

## Answer

Optional `addStop.state` is parsed on the client and server. Persisted review state is `human + omitted/confirmed → Confirmed`, `human + draft → Draft` with `{ actor: "user", via: "manual" }`, and agent adds stay Draft even if Confirmed is requested. Agent `updateStop { state: "confirmed" }` is still rejected. `buildAddOrFillOps` carries the requested state so Library and outside-content cannot diverge. Focused Trips tests, typecheck, and build pass.
