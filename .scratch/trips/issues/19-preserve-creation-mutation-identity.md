# Preserve Trip creation mutation identity across retries

Type: task
Status: resolved

## Outcome

One logical Trip-creation request has one client mutation id from the caller through every transport retry. A lost response cannot turn a retry from the setup form or `create_trip` WebMCP tool into a second Trip.

## Problem

The server receipt is replay-safe only when the caller repeats the same mutation id. `api.createTrip()` currently generates a new id on every invocation, while the WebMCP `create_trip` schema exposes no mutation id. Re-executing the same logical request therefore bypasses the receipt and can create a duplicate.

## Scope

- `app/src/api.ts`
- `app/src/trips-index.tsx`
- `app/src/trips-webmcp.ts`
- Creation HTTP/WebMCP/browser tests

## Requirements

1. Make the logical caller own the creation mutation id; the low-level API must forward it unchanged.
2. Require `clientMutationId` in the `create_trip` WebMCP schema and validate the same bounds as other Trip mutations.
3. Preserve one id while the human setup submission is pending and across an uncertain transport failure retry of the unchanged payload.
4. Use a fresh id for a deliberately new creation request or a changed payload.
5. Keep the existing owner-scoped server receipt and conflicting-payload rejection.
6. Document the retry boundary in the API type rather than hiding id generation inside the request function.

## Tests

Add focused coverage proving:

- Two identical `create_trip` executions with the same id return the same Trip.
- The same id with a different setup payload is rejected.
- A simulated lost HTTP response followed by retry creates exactly one Trip.
- The setup form reuses its id after an uncertain failure with unchanged data.
- A new or changed setup submission receives a fresh id.

## Completion criteria

- No creation adapter silently replaces a caller-supplied mutation id.
- Lost-response retries through HTTP, UI, and WebMCP produce exactly one Trip.
- Focused creation tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Answer

Callers own `clientMutationId`. `api.createTrip` forwards the body unchanged. The setup form keeps one id while a submit is pending and reuses it after a failed unchanged retry; a new or changed payload gets a fresh UUID. `create_trip` requires a 1–100 character id and does not generate one. Server receipts were not changed.

`npm run typecheck`, `npm run build`, and `npm test` pass (411).

## Comments
