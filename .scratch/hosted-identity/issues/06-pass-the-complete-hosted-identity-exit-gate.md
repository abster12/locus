# 06: Pass the complete hosted identity exit gate

**What to build:** Perform one focused validation of the real Account interface against the already-verified staging identity backend, then record the production decision. This ticket closes the UI/integration seam; it does not repeat ticket 04's Cloudflare, D1, OAuth, rate-limit, log, or two-user backend matrix.

**Blocked by:** 04: Deploy and verify the identity backend in staging; 05: Populate Account from the authenticated session

**Status:** resolved

## Inherited evidence — do not repeat

- [x] Two real Google users registered in staging, received distinct Libraries, and one user returned to the same Library after sign-out/sign-in.
- [x] Both cross-user Library probes returned the same non-enumerating `404`; guessed ownership and mutation cases pass the Worker-runtime suite.
- [x] Disabling an already-authenticated user produced `Access denied`, the other user stayed active, and the disabled user was re-enabled afterward.
- [x] Registration close/reopen and existing-user return pass the Worker-runtime suite. The live third-new-user probe is waived because no third identity is available.
- [x] Restart persistence, wrong-origin, missing/stale CSRF, expired/revoked session, and callback/session failure behavior are covered by focused Worker tests and Better Auth integration; do not rerun them as generic Cloudflare checks.
- [x] Staging D1 retained zero Google OAuth tokens, and post-hardening log checks contained no query/cookie marker material.

## Remaining focused exit gate after ticket 05

- [x] Two users render the correct authenticated Account identity and private Library through the real interface; one focused sign-out/return pass is sufficient.
- [x] The real interface visibly handles signed-out `401`, disabled `403`, callback failure, and sign-out without exposing identity details or requiring a manual reload.
- [x] Hosted code has no fallback to the local Library identity and exposes no unported private Locus domains.
- [x] The adopted Better Auth, request-identity, cookie, CSRF, registration-switch, and one-Library decisions—and any deviations from the spike—are recorded.
- [x] The next hosted domain can consume the trusted request identity without importing Better Auth or parsing cookies itself.

## Answer

Owner confirmed the live Account pass on staging (`locus-identity-staging.abhigyan0987.workers.dev`) with two Google users: each saw their own identity and Library, one signed out and returned, and the UI handled signed-out, access-denied, callback failure, and sign-out without a reload. No identity values recorded.

Hosted runtime is an explicit `hosted` build (`app/src/runtime.ts`); Worker has no `LOCAL_LIBRARY_ID`; hosted UI is Account-only.

Decisions: `docs/adr/0003-hosted-identity.md`. Spec status is accepted.

Next domain: `import { resolveIdentity, type RequestIdentity } from "./identity.ts"`. That module does not import Better Auth or read cookies.
