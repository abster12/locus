# 03: Protect private routes with session-derived identity

**What to build:** Establish the authorization seam every hosted Locus domain will use. The Worker denies private routes by default and resolves a trusted request identity from the Better Auth session, active user status, and Library membership. Private handlers receive that identity instead of cookies or client-selected ownership fields, and mutations receive session-bound cross-site request protection.

**Blocked by:** 02: Control registration and disable abusive users

**Status:** resolved

- [x] The trusted request identity contains the authenticated user, session, Library, and owner role resolved entirely on the server.
- [x] Anonymous requests receive `401`; authenticated but disabled or unowned requests receive the defined `403` or non-enumerating `404` response.
- [x] Private routes are denied unless explicitly registered behind the identity resolver.
- [x] Client-supplied `libraryId`, `library_id`, user, session, and actor fields are rejected or ignored and never replace trusted identity.
- [x] A private proof resource returns the current user's Library and returns `404` for another user's Library.
- [x] Mutation requests require an exact allowed origin and a CSRF token bound to the current session using a dedicated secret.
- [x] Authenticated responses use `Cache-Control: no-store` and logs redact email addresses, cookies, OAuth codes, and tokens.
- [x] Tests cover guessed identifiers, cross-Library reads and writes, missing and stale CSRF tokens, wrong origins, disabled sessions, and public-route exceptions.

## Answer

`RequestIdentity` is resolved on the Worker from the Better Auth session, `user_access`, and membership. Public: `/`, `/api/health`, `/api/auth/*`. Private: `/api/session` (provisions) and `GET|POST /api/libraries/:id` (proof; other ids are `404`). Mutations need `Origin === BETTER_AUTH_URL` and `x-csrf-token` HMAC'd with `CSRF_SECRET` over `sessionId`. Client `libraryId` fields are ignored. `redact()` strips emails/cookies/tokens from log text.
