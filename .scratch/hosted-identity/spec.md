# Hosted identity foundation

Status: accepted
Date: 2026-09-02

## Outcome

Productionize the proven Google OAuth spike as the identity and ownership boundary for hosted Locus.

A person can sign in with Google during open registration, receive exactly one private Library, restore that Library on later sessions, sign out, and access only resources belonging to that Library. Registration can be closed without preventing existing users from returning. Every hosted request derives `userId`, `sessionId`, and `libraryId` from the authenticated server-side session; ordinary clients never choose those values.

This is the first production slice of the Cloudflare deployment. It does not port the existing Locus domains to D1.

## Proven decision

Adopt the spike's architecture for the first hosted release:

- Cloudflare Worker using the native `fetch` interface
- Better Auth 1.7.2, pinned until an intentional upgrade
- Cloudflare D1 for auth, access, Library, and membership records
- Google OAuth only in this slice
- one private Library and one owner membership per user
- identity-only OAuth; Google access, refresh, and ID tokens are not retained
- Better Auth account linking disabled
- no Effect dependency, consistent with ADR 0002

The spike proved:

- Google OAuth callback and session creation in the Worker runtime
- D1 persistence across sign-out and later sign-in
- stable Library identity for the same Google user
- different Library identity for a second Google user
- `404` for a cross-user Library probe
- session-cookie deletion on sign-out

The spike remains disposable evidence. Production code absorbs the decisions, not the prototype dashboard. Adopted production record: `docs/adr/0003-hosted-identity.md`.

Deviations from the spike: no prototype dashboard; Account is the Vite shell from `/api/session` (no `/api/account`); dedicated `CSRF_SECRET`; `REGISTRATION_MODE` and `user_access`; rate limits, security headers, and redacted logs; Google tokens nulled in database hooks.

## Scope

### Included

- Google sign-in and callback routes
- open Google registration for the WebMCP Challenge, kept free and available to judges through the end of judging
- an operator-controlled switch that can stop new accounts after judging or during a genuine safety incident
- per-user active or disabled access status
- Better Auth user, account, session, and verification tables
- Locus user-access, Library, and membership tables
- idempotent first-login Library provisioning
- a trusted request identity module
- authenticated `/api/session`
- sign-out and session revocation of the current session
- an unauthenticated sign-in screen and authenticated Account identity summary
- staging Worker, staging D1, staging Google OAuth application, and environment secrets
- security and tenant-isolation tests for this boundary

### Excluded

- GitHub sign-in or Google/GitHub account linking
- password, magic-link, passkey, or recovery authentication
- registration methods other than Google
- admin UI and general user management
- multiple Libraries, teams, sharing, invitations between users, or role editing
- migration of existing local Library content
- personal content intake and the judge walkthrough, which belong to product and submission readiness rather than identity
- hosted Sources capture, Items, Reading, Kitchen, Atlas, Trips, imports, or exports
- production deployment to the final domain
- an Effect adoption

## Runtime boundary

The hosted Worker begins with a deny-by-default route policy:

### Public routes

- static sign-in shell
- `/api/health`, containing no user or deployment secrets
- `/api/auth/*`, owned by Better Auth

Any future public capability route, such as a Share Snapshot, must be added explicitly and must not pass through authenticated Library resolution.

### Authenticated routes

- `/api/session`
- all future private Locus API routes

Account is a client destination populated from `/api/session`, not a separate API route.

An authenticated request resolves this internal value:

```ts
interface RequestIdentity {
  userId: string;
  sessionId: string;
  libraryId: string;
  role: "owner";
}
```

The module that creates `RequestIdentity` owns session validation, user-access status, membership lookup, and consistent `401`/`403` behavior. Domain handlers receive `RequestIdentity`; they do not read cookies or accept a client-supplied Library identity.

## Data model

Better Auth owns its generated tables:

- `user`
- `account`
- `session`
- `verification`

Locus owns:

### Registration mode

The hosted environment has an operator-controlled mode:

- `open`: a new Google identity may create a Locus account
- `closed`: existing users may sign in, but a new identity may not create an account

The browser cannot choose or override this mode. The submitted challenge environment starts in `open` mode and remains free and open through judging, which ends September 21, 2026 at 5:00 pm PDT. Switching it to `closed` before then is reserved for a genuine safety incident and requires an alternative judge-access path and instructions, because the challenge requires unrestricted sponsor, administrator, and judge testing. Closing registration does not log out existing users.

### `user_access`

- Better Auth user ID, primary key
- normalized email for support lookup
- status: `active` or `disabled`
- created and disabled timestamps

The first successful registration creates an active access record. Every private request rejects a disabled user even if the Better Auth session has not yet expired.

### `libraries`

- opaque Library ID, primary key
- owner user ID, unique
- display name
- created and updated timestamps

### `library_memberships`

- Library ID
- user ID, unique for the one-Library beta
- role constrained to `owner`
- created timestamp
- unique `(library_id, user_id)`

The schema deliberately contains membership even though beta supports one owner. Collaboration can later expand the constraint without replacing the ownership vocabulary.

## First-login provisioning

After Better Auth validates the Google identity and `/api/session` is requested:

1. Better Auth restores an existing Google user, or creates one only when registration is open.
2. Create an active user-access record on the first successful registration.
3. Reject a disabled user even if its authentication session remains valid.
4. Read the user's existing owner membership.
5. If none exists, create one Library and one owner membership in a D1 atomic batch.
6. On a concurrent first-request uniqueness conflict, re-read and return the winning Library.
7. Return the session and Account presentation only after access and membership resolution succeed.

Repeated login must return the original Library. After registration, provisioning uses the stable Better Auth user ID rather than browser-provided display name or email as its identity key.

## Session contract

Replace the hosted meaning of the current anonymous `/api/session` response with:

```ts
interface HostedSessionContext {
  user: {
    id: string;
    name: string;
    email: string;
    image: string | null;
  };
  session: {
    expiresAt: string;
  };
  library: {
    id: string;
    name: string;
    role: "owner";
  };
  csrfToken: string;
}
```

Rules:

- `401` means no valid session and sends the client to the sign-in state.
- `403` means the authenticated identity has been disabled.
- The browser may display the Library ID for diagnostics, but private APIs ignore any submitted `libraryId` or `library_id`.
- The existing local edition keeps its local session contract behind an explicit local-runtime adapter. Hosted code never falls back to `LOCAL_LIBRARY_ID`.

## Browser behavior

### Signed out

- show the Locus wordmark and one `Continue with Google` action
- preserve the intended same-origin destination through the OAuth round trip
- show actionable errors for denied access, callback mismatch, and expired state

### Signed in

- bootstrap the app from `/api/session`
- populate the Account summary with Google identity and current Library
- offer `Sign out`
- after successful sign-out, clear authenticated client state and show the signed-out screen without requiring a manual reload

The Account/Sources redesign may land independently. Its local Account summary becomes the hosted identity summary when both efforts meet.

## Security requirements

- production and staging use HTTPS and host-only `Secure`, `HttpOnly`, `SameSite=Lax` session cookies
- local development may omit `Secure` only because it uses `http://localhost`
- auth callback URLs and trusted origins are explicit per environment
- app mutation routes require exact-origin validation and a session-bound CSRF token; the existing installation-wide CSRF secret is not used by hosted requests
- use a dedicated CSRF signing secret rather than reusing the Better Auth secret
- OAuth scopes remain identity-only
- database hooks remove Google access, refresh, and ID tokens before account persistence and on later account updates
- logs never include cookies, OAuth codes, tokens, raw D1 rows, or complete email addresses
- session responses and authenticated HTML use `Cache-Control: no-store`
- registration errors do not reveal whether a Google identity already has a Locus account
- rate limits cover sign-in initiation, callbacks, and repeated rejected sessions
- secrets live in Cloudflare secrets, never Worker variables, source files, or the frontend bundle

## Migration and environment rules

- keep immutable Wrangler SQL migrations in version control
- never run runtime schema mutation from request handlers
- use separate D1 databases and Google OAuth clients for local, staging, and production
- local `.dev.vars` remains ignored
- staging secrets include Better Auth, CSRF, and Google client secrets
- the production database and OAuth client are not created until staging passes the exit gate

The first migration imports the schema generated by the pinned Better Auth CLI. Locus-owned tables are separate migrations so an auth upgrade does not obscure application schema changes.

## Verification matrix

### Authentication

- when registration is open, a new Google identity can create an account
- when registration is closed, an existing user can sign in but a new identity receives a generic registration-closed result
- a disabled identity cannot use an existing session
- callback state is validated and expired/replayed callbacks fail
- sign-out clears the session cookie and subsequent `/api/session` returns `401`

### Ownership

- first sign-in creates exactly one Library and owner membership
- repeated and concurrent session bootstrap returns the same Library
- a second user receives a different Library
- guessed user, membership, and Library IDs cannot cross the identity boundary
- request payload and query-string `libraryId` fields are ignored or rejected

### Persistence and privacy

- Worker restart preserves users, sessions, access status, and Libraries
- Google OAuth token columns remain null after first and repeated login
- logs and client responses contain no session token, OAuth token, or secret
- staging migration applies to a fresh D1 database and is idempotently reported as complete on the second run

### Browser

- OAuth returns to the original same-origin destination
- signed-out boot renders sign-in instead of a generic application error
- Account identity renders after login
- sign-out transitions immediately to signed-out state
- two browser profiles demonstrate cross-Library `404`

## Exit gate

This slice is complete when:

- staging passes the full verification matrix with two real Google accounts
- the Worker contains no hosted fallback to `LOCAL_LIBRARY_ID`
- staging can switch between open and closed registration without changing client code
- the submitted environment's open-registration guarantee through the judging window is documented and operationally visible
- only the public and identity routes in this spec are exposed
- the Account screen can render authenticated identity from `/api/session`
- the auth/library decision and any deviations from the spike are recorded in ADR 0003

Passing this gate approves Better Auth and the request-identity interface for subsequent hosted domain slices. It does not imply that the existing application data is tenant-safe or ready to expose publicly.

## Step-by-step work after this slice

1. **Tenant the persistence model.** Add `library_id` to every private root aggregate and uniqueness constraint, with cross-Library tests and a migration path for the current local Library.
2. **Port one useful vertical slice to Workers and D1.** Start with authenticated Source connection overview or a minimal Desk Item read/write path; prove async repositories, guarded writes, and the request identity in real product behavior.
3. **Finish hosted Source capture.** Bind extension tokens to the authenticated Library and Source account, make setup idempotent, and remove dependencies on the local Chrome runner.
4. **Move files and deferred work.** Put Reading assets and generated archives in R2; move enrichment and repair work to Queues plus a small scheduled repair scan.
5. **Port remaining domains incrementally.** Desk, Reading, Kitchen, Atlas, and Trips each move as tenant-scoped vertical slices with concurrency and isolation tests.
6. **Add GitHub and safe account linking.** Prove explicit linking while signed in; never merge users solely because two providers report the same email without the approved verified-email policy.
7. **Add user operations.** Active sessions, revoke sessions, export, deletion, and a minimal admin ability to disable users and inspect coarse status.
8. **Complete operational readiness.** Limits, rate limiting, logs, alerts, backup/restore drills, privacy and terms, staging-to-production migrations, custom domain, and rollback procedure.
