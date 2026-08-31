# Trips review-intent security

Type: task
Status: resolved
Blocked by: 13

## Outcome

Agent review mutations require a short-lived authorization intent that belongs to the active session and Trip and can be successfully used only once.

## Problem

Review intent is stored by Trip id alone and is not consumed by the successful server mutation. Client-side removal of a tool is not a security boundary: the HTTP path can reuse the same intent.

## Scope

- `server/http/server.ts`
- Trips review and transaction code under `server/trips/`
- `app/src/trips-webmcp.ts` only where needed to preserve lifecycle behavior
- Focused HTTP and review tests

## Requirements

1. Bind each intent to the active authenticated session or owner and the exact Trip.
2. Give every intent an explicit short expiry.
3. Validate and atomically consume the intent in the same transaction as the successful review mutation.
4. Reject reuse after the first successful mutation.
5. Reject cross-session, wrong-Trip, absent, and expired intent with stable errors.
6. Preserve a valid intent when validation or persistence fails before a successful protected mutation.
7. Derive identity from the trusted server session rather than client-supplied identity.
8. Extract review-intent and review-mutation behavior into a focused internal module.
9. Preserve current visible-route WebMCP registration and cleanup behavior.

## Tests

Add focused coverage for:

- First successful use
- Attempted reuse
- Expiration
- Cross-session use
- Wrong-Trip use
- Missing intent
- Failed validation before persistence
- Failed persistence and transaction rollback
- Existing client WebMCP review lifecycle

## Completion criteria

- A captured or stale intent cannot authorize a second or cross-session mutation.
- Successful review and intent consumption are atomic.
- Review tests pass independently.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Exclusions

Do not redesign recommendation UI or perform unrelated server decomposition in this ticket.

## Comments

Review intents moved from an in-process Map to `trip_review_intents` (schema v21) keyed `(library_id, session_id, trip_id)` with revision + 15-minute expiry; trip FK cascades. New `server/trips/review.ts`: `armReviewIntent` (re-arming replaces) and `recordAgentReview`, which checks the intent, validates, writes advisories, and consumes the intent in ONE sqlite transaction — reuse, cross-session, wrong-trip, absent, and expired all throw `ReviewIntentError` (stable 403), and any failure before the successful write rolls back with the intent intact. `module.ts` exposes the tx-free `applyTripReview` core; `recordTripReview` keeps its signature. HTTP derives the session from the trusted cookie payload (`SESSION_PAYLOAD`), never the body; the review route no longer trusts client identity.

Tests: new `tests/trips-review.test.ts` (first use, reuse, expiry, cross-session, wrong-trip, missing, failed validation, stale revision, failed persistence rollback, re-arm replacement); `tests/trips-http.test.ts` review sequence now asserts the second use is 403 and re-arms before stale/invalid cases. Verification: focused trips tests 98/98 pass, webmcp-browser 3/3, `npm run typecheck`, `npm run build`.
