# 04: Deploy and verify the identity backend in staging

**What to build:** Run the identity boundary in a real staging Cloudflare environment. Staging has its own D1 database, Google OAuth client, secrets, callback origin, and migrations. New users can register while the hackathon switch is open, and registration can be closed without preventing existing users from returning or exposing any existing Locus domain that is not yet tenant-safe.

**Blocked by:** 03: Protect private routes with session-derived identity

**Status:** resolved

## Verification scope and waiver

Ticket 03 proves the request-identity seam locally. Cloudflare setup, Google OAuth secrets, deployment, and the two-user real-account matrix are complete as of 2026-09-02. A third distinct Google identity was not available, so the owner waived only the live new-user-while-closed probe. The equivalent registration close/reopen behavior remains covered by the Worker-runtime suite. Do not reopen this ticket to repeat Cloudflare platform checks.

## Agent-executable code preparation

Complete and test these before asking an operator to deploy:

- [x] Add an explicit Wrangler `staging` environment with a dedicated Worker name, non-local `BETTER_AUTH_URL`, dedicated D1 binding, open `REGISTRATION_MODE`, enabled staging observability, and declared secrets. Never copy a production database id or secret into staging.
- [x] Add Cloudflare Rate Limiting bindings and enforcement for sign-in initiation, OAuth callbacks, and repeated rejected private-session requests. Define stable `429` responses and Worker-runtime tests for allowed and limited requests.
- [x] Centralize the intended staging security headers and apply them to applicable HTML and API responses. Add automated assertions for CSP/frame protection, content-type sniffing protection, referrer policy, permissions policy, authenticated `no-store`, and HTTPS-only HSTS behavior.
- [x] Route application logging through one small structured logger that redacts before emission and never logs request headers, cookies, OAuth query strings/codes, tokens, secrets, complete email addresses, or raw D1 rows. Test the emitted structured record, not only the standalone helper.
- [x] Add staging-safe package scripts or documented commands for check, remote migration list/apply, deploy, and log tailing; commands must always name the `staging` environment and staging database.
- [x] Add the operator procedure in `../staging-runbook.md`, including registration close/reopen and disable/re-enable commands.

## Operator-owned prerequisites

These cannot be supplied or simulated by an implementation agent:

- [x] An authenticated Cloudflare account with permission to create/deploy the staging Worker, create a dedicated D1 database, set Worker secrets, enable/read Workers Logs, and use the Rate Limiting binding. Confirm with `npx wrangler whoami` from `hosted/`.
- [x] The Cloudflare `workers.dev` subdomain or approved staging custom hostname, so `BETTER_AUTH_URL` and the Google callback can be exact HTTPS URLs rather than localhost.
- [x] A dedicated Google Cloud OAuth web client for staging, with an authorized redirect URI exactly equal to `<staging-origin>/api/auth/callback/google`, plus authority to update its consent-screen/test-user configuration when applicable.
- [x] Two real Google identities completed the staging matrix. The unavailable third-user registration-closed probe is explicitly waived and replaced only by the existing Worker-runtime coverage; no live result was simulated.
- [x] Permission to create and later remove or retain the Cloudflare/Google staging resources according to the owner's cost and security policy.

Follow `.scratch/hosted-identity/staging-runbook.md`. Never paste secret values, OAuth codes, cookies, or token-bearing URLs into this ticket's comments.

- [x] Staging uses a dedicated Worker environment, D1 database, Google OAuth application, Better Auth secret, and CSRF secret.
- [x] Secrets are stored as Cloudflare secrets and do not appear in Worker variables, generated assets, source, command output, or logs.
- [x] Migrations apply to a fresh staging D1 database and report no pending changes when applied again.
- [x] Staging serves only the explicit public identity routes and authenticated proof routes from the specification.
- [x] Two new Google users register while the switch is open and receive stable, distinct Libraries; repeat sign-in is live-verified and Worker restart persistence is covered by the Worker-runtime suite.
- [x] Registration close/reopen behavior and existing-user return pass the Worker-runtime suite. The owner accepted that Cloudflare will preserve this behavior; the third-new-user staging probe was waived because no third Google identity is available.
- [x] Each user receives `404` when probing the other user's Library.
- [x] Disabling one user blocks its existing session.
- [x] Stored Google access, refresh, and ID token columns remain null after repeat login.
- [x] Staging security headers, secure cookie configuration, callback URL/trusted origin, redacted structured logs, and enforced rate limits are verified using the runbook and focused Worker tests.

## Evidence required to resolve

Append only sanitized evidence under `## Answer`: staging Worker hostname, D1 database name/id suffix, migration names, deployment version, test timestamps and outcomes, header/cookie attribute names, rate-limit outcome counts, token-null aggregate counts, and log-search outcome. Do not append emails, user/session ids, cookies, OAuth URLs/codes, secrets, or raw database rows.

## Answer

Resolved evidence, 2026-09-02 UTC:

- Cloudflare account authentication confirmed; staging hostname is `locus-identity-staging.abhigyan0987.workers.dev`.
- Dedicated APAC D1 database `locus-identity-staging` created (id suffix `c861`).
- Migrations `0001_better_auth.sql`, `0002_libraries.sql`, and `0003_user_access.sql` applied; a second list reports no pending migrations.
- All four required secrets are present as encrypted staging secret bindings; values were never emitted.
- Staging check passes: 20 Worker-runtime tests, generated binding types, TypeScript, and Wrangler deploy dry-run.
- Live deployment version `fc633d58-4b6b-4a53-8bb6-82f0c944e934` serves the configured staging hostname.
- Live public health and root return `200`; anonymous session returns `401`. HTTPS responses include HSTS, CSP/frame denial, nosniff, no-referrer, permissions policy, and no-store.
- Bounded live rate probes produced `20 × 200` then `1 × 429` for Google sign-in initiation, and `30 × 401` then `1 × 429` for rejected private sessions.
- Raw Cloudflare invocation logs and preview URLs are disabled. Structured logs persist clean path/status events; query-bearing or cookie/authorization-bearing requests are suppressed. A harmless query/cookie marker was absent from the post-deploy log search.
- Real user A completed Google sign-in and received a Library. Aggregate D1 verification reported one user, session, Google account, Library, owner membership, and access row, with zero retained Google tokens; no identity values were queried or recorded.
- User A signed out and returned through Google. Aggregate verification still reported exactly one user, account, Library, owner membership, and active session, proving that repeat sign-in reused the original Library; retained Google tokens remained zero.
- User B completed Google sign-in in a separate browser context. Aggregate verification reported two users, two Google accounts, two active sessions, two Libraries, two owner memberships, and two distinct Library owners; retained Google tokens remained zero. No identity values were queried or recorded.
- Both users probed the other user's Library through their separate authenticated browser contexts and received the same non-enumerating `404 Not found` response.
- A third distinct Google identity was not available. The registration-closed new-user criterion remains explicitly incomplete; no result was simulated.
- User B's already-issued session changed from normal access to `Access denied` after an operator disable, while user A remained active. User B was then re-enabled; aggregate verification reports two active users and zero disabled users.
- Owner accepted the focused Worker-runtime coverage for registration close/reopen and restart persistence instead of further staging-platform repetition. Ticket 04 is resolved with the unavailable third-user staging probe documented as a waiver.
