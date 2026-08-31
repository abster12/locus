# Issue distinct authenticated session identities

Type: task
Status: resolved

## Outcome

Each authenticated browser session has a distinct, signed, server-issued identity. Review intent armed in one session cannot be consumed from another session, while local-only Locus retains its existing authentication and CSRF protections.

## Problem

Every valid session cookie currently carries the constant payload `desk`. Review-intent rows include `session_id`, but both review routes pass that constant, so the server cannot distinguish two authenticated browser sessions.

## Scope

- `server/http/session.ts`
- Session issuance and validation in `server/http/server.ts`
- Trips review-intent route integration
- Session and review HTTP tests

## Requirements

1. Issue an opaque, unique session id in each new signed session cookie.
2. Validate the signature and return the trusted session id to authenticated route handling.
3. Pass the validated request session id to both `armReviewIntent` and `recordAgentReview`.
4. Keep Library identity server-derived and independent from the session id.
5. Preserve loopback host/origin checks, HttpOnly/SameSite cookie behavior, and CSRF enforcement.
6. Reject malformed, unsigned, and tampered session payloads.
7. Avoid accepting a client body field as session identity.

## Tests

Use two independent cookie jars to prove:

- Each session receives a distinct valid identity.
- A session can consume its own armed intent.
- Another valid session cannot consume that intent.
- Cross-session rejection leaves the owner session's intent usable.
- Tampered and malformed cookies fail authentication.
- Existing local session and CSRF behavior still passes.

## Completion criteria

- The server can distinguish two simultaneously valid browser sessions.
- Review intent uses the identity extracted from the current validated request.
- Cross-session review tests pass without injecting session ids directly into domain calls as a substitute for HTTP coverage.
- `npm run typecheck`, `npm run build`, and `npm test` pass.

## Answer

Cookies are now `uuid.hmac`. `validSession` returns the trusted payload or `null` (exactly two parts, no legacy `desk`, HMAC must match). Review routes take that id; library stays `LOCAL_LIBRARY_ID`. Valid unique cookies are not rotated; missing/invalid/`desk` cookies get a new one on `GET /api/session`. CSRF stays install-wide.

HTTP two-jar test in `tests/trips-http.test.ts`. `npm run typecheck`, `npm run build`, `npm test` (412) pass.

## Comments
