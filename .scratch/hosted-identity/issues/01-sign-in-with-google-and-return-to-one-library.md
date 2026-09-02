# 01: Sign in with Google and return to one Library

**What to build:** Turn the successful authentication spike into a production-shaped hosted identity slice. A Google user can sign in, receive one persistent private Library and owner membership, restore that same Library on later sessions, and sign out. The implementation absorbs the proven decisions into the hosted Worker while leaving the disposable prototype and existing local edition isolated.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] The hosted Worker exposes only health, authentication, session, and the minimal sign-in surface needed by this slice.
- [x] Immutable migrations create the pinned Better Auth schema separately from Locus Library and membership tables.
- [x] Google OAuth creates one user, one session, one Library, and one owner membership on first successful login.
- [x] Repeated and concurrent session bootstrap returns the same Library without creating orphaned or duplicate records.
- [x] The authenticated session response contains display-safe user, session-expiry, Library, and role information but no session or OAuth token.
- [x] Sign-out clears the current Better Auth session and the next session request returns `401`.
- [x] Google access, refresh, and ID tokens remain null after first and repeated login.
- [x] The local edition retains its existing local session behavior and never imports hosted Worker dependencies.
- [x] Worker-runtime tests cover first login, repeat login, concurrent provisioning, sign-out, restart persistence, and token non-retention.

## Answer

Shipped in `hosted/`: Worker with health, Google auth, `/api/session`, sign-out, and a minimal sign-in page. One Library per user, restored on later login. Local edition untouched.

Verified with Worker tests and a live Google sign-in (same Library after sign-out).
