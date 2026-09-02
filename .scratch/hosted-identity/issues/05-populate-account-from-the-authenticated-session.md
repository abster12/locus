# 05: Populate Account from the authenticated session

**What to build:** Ship the existing React application as the hosted identity UI, with a deliberately small hosted shell. A signed-out visitor sees one Google entry point. A signed-in person sees the Account destination populated from the existing hosted session. Signing out immediately returns the UI to its signed-out state. This is client integration and static-asset delivery, not an authentication redesign or a port of the local backend.

**Blocked by:** 03: Protect private routes with session-derived identity; Account/Sources 05: Turn Sources into the Account destination

**Status:** resolved

## Proven prerequisites — do not rebuild

- Hosted `/api/session`, Google callback/sign-out, one-Library provisioning, `401`, disabled-user `403`, CSRF/origin protection, and cross-user isolation are implemented and staging-verified by tickets 01–04.
- The current inline hosted sign-in page is proof infrastructure. Ticket 05 replaces it with the built React UI.
- Account/Sources 01–05 established the Account information architecture and local-edition behavior. Reuse that code and visual language rather than creating a second unrelated Account design.
- Do not add auth tables, OAuth providers, client-selected Library state, a second identity endpoint, or a new server-side session abstraction.

## Decisions — implement these; do not invent alternatives

### One client, two explicit runtime builds

- Use the existing Vite/React application source for both editions. Do not create a separate hosted HTML application inside `hosted/`.
- Add an explicit build-time runtime value with exactly two values: `local` and `hosted`. The hosted artifact is written to a distinct directory such as `dist/hosted-app`; it must not overwrite or change the existing local `dist/app` artifact.
- Runtime selection is made from that build value. Do not infer it from hostname, port, missing fields, a failed request, or checks such as `"user" in response` scattered through components.
- The hosted deployment/check scripts must build the hosted asset artifact before Wrangler packages the Worker, so stale or absent client assets cannot be deployed accidentally.

### How the React page reaches Cloudflare

- Configure the existing Worker deployment to include the hosted Vite artifact with Cloudflare Workers Static Assets. Use an `ASSETS` binding, SPA not-found handling, and Worker-first routing.
- The Worker continues to own every request. `/api/*` is routed only through the existing API/auth router and must never fall through to `index.html`. Every non-API request that is not otherwise handled is served with `env.ASSETS.fetch(request)` so client routes receive the SPA shell.
- Keep the existing centralized security headers on asset responses as well as API responses. Hashed assets may be cached as immutable; `index.html`, session/auth responses, and personalized error states must not be cached as user-independent content.
- Replace the inline proof `SIGN_IN` document when the asset-backed UI is enabled. There is one same-origin Worker deployment, not separate UI and API origins, and no CORS layer is introduced.

### The client session seam

- Introduce one small client boundary that converts edition-specific wire responses into a discriminated application state. Components consume only that state; they do not parse either `/api/session` response directly.
- Select the local or hosted adapter from the build-time runtime value. This is the only new session abstraction allowed by this ticket; it is a client adapter over the two existing contracts, not a replacement auth system.
- Use these application states or an equivalent exhaustive discriminated union:

  - `local-ready`: local Library plus the local CSRF token; no sign-in or sign-out capability.
  - `hosted-signed-out`: the hosted endpoint returned `401`.
  - `hosted-ready`: Google user, session expiry, private Library, and hosted CSRF token.
  - `hosted-access-denied`: the hosted endpoint returned disabled-user `403`.
  - `load-failed`: network failure, unexpected status, malformed response, or server failure, retaining enough information to offer Retry without exposing response details.

- Normalize these existing field differences at the adapter boundary:

  - local `csrf` and hosted `csrfToken` become the same internal `csrfToken` field;
  - local `libraryId: "local"` becomes a local Library view with the established Local Library label;
  - hosted `user`, `session`, and `library` remain hosted identity data and are validated before reaching UI components.

- `401` is a normal signed-out state, `403` is access denied, and neither may be treated as an offline/server error. Conversely, a network or `5xx` failure must not be shown as signed out.
- Continue to set the existing API layer's trusted Library context from the normalized state. The browser never sends a Library identity to select or override the signed-in user's Library.

### Hosted shell and routing for this ticket

- In the hosted build, render only the Locus shell, signed-out/access/error states, and the Account destination. Do not render navigation or boot-time effects for Desk, Kitchen, Atlas, Trips, Reading, Sources, or any other domain whose hosted API is not implemented yet.
- The signed-in default route is Account. The OAuth callback destination is the same-origin Account route; do not accept an arbitrary external return URL. An absent or invalid return destination falls back to Account.
- The signed-out shell contains the Locus identity and one `Continue with Google` action. It contains no private user or Library details.
- A callback failure renders a generic recoverable sign-in error and another Google action. Remove callback error parameters from the visible URL after reading them, and do not log them.

### Exact hosted Account content

- The hosted Account page shows:

  - optional Google profile image with a text fallback;
  - verified display name and email;
  - `Signed in with Google`;
  - current Library name and `Owner` role from `/api/session`;
  - one Sign out action.

- Session expiry remains application state for refresh/expiry handling; do not add a session-management interface in this ticket.
- In hosted mode, omit the entire local-only Capture setup, extension pairing, Source connections, capture preferences, Pi, import history, export, restore, source import, and delete-data sections. Do not show disabled controls or “coming soon” placeholders for endpoints that do not exist.
- Structure the Account destination so the local body and hosted body are explicit branches. The hosted branch must not mount the current local Sources/Account polling or issue requests to `/api/sources`, `/api/export`, `/api/imports`, `/api/settings`, or extension endpoints.
- In the local build, preserve the completed Account/Sources behavior and honest Local account summary exactly. Do not add Google controls or hosted calls to the local edition.

### Sign-in, sign-out, and state changes

- Sign-in uses the existing Better Auth social sign-in endpoint with `provider: "google"` and the allowlisted same-origin Account callback. Do not add a client OAuth library.
- Sign-out uses the existing hosted endpoint with the required JSON request and CSRF/origin behavior already established by the Worker. On success, clear authenticated client state and render `hosted-signed-out` without a reload.
- If a later session refresh returns `401`, discard identity/Library details and render signed out. If it returns disabled-user `403`, discard those details and render access denied. Access denied may offer Sign out so the person can switch Google accounts; it must not offer private application content.

## Acceptance checklist

- [x] `build:local` and `build:hosted` (names may follow repository conventions) select their adapters explicitly and emit separate artifacts.
- [x] Wrangler packages the hosted artifact as Worker Static Assets; the Worker applies security headers and SPA fallback without allowing `/api/*` to fall through to the client.
- [x] The old inline proof page is no longer the hosted root after this integration.
- [x] Local and hosted `/api/session` responses are normalized at one tested client boundary; components do not distinguish contracts by inspecting response shape.
- [x] Hosted boot distinguishes signed-out `401`, disabled `403`, callback failure, and retryable network/server failure.
- [x] Signed-out hosted Locus shows one Continue with Google action and no private details.
- [x] Signed-in hosted Account renders the exact hosted content above from the existing `/api/session` contract.
- [x] The hosted shell exposes no unported domain and makes no request to a local-only API.
- [x] Sign-out clears authenticated state and renders signed out without a manual reload.
- [x] A session that expires or becomes disabled while the app is open removes identity and Library details and enters the correct state.
- [x] The browser never submits a Library identity to choose the current Library.
- [x] The local Account page retains its Account, Capture setup, Sources, Preferences, and Data/privacy behavior without Google controls.

## Required regression coverage

- Adapter contract tests cover local success; hosted success; hosted `401`; hosted disabled `403`; malformed response; network failure; and `5xx`.
- Worker route tests prove an unknown `/api/*` path returns an API `404`, not the SPA, while an Account client route receives the SPA shell with security headers.
- Hosted UI tests cover signed out, signed in, sign out, expired session, access denied, callback failure, Retry after load failure, keyboard operation, and a 320 px viewport.
- A hosted UI test fails if the Account-only build renders unported navigation or calls local-only Account/Sources endpoints.
- Local UI regression tests prove the existing full Account destination still renders and behaves as before.

Ticket 06, not this ticket, performs the focused real-staging pass with the two already-created Google users.

## Answer

Shipped. `vite build` stays local (`dist/app`); `npm run build:hosted` writes `dist/hosted-app`. The Worker serves that artifact through `ASSETS` with worker-first routing; unknown `/api/*` stays JSON 404. Session states live in `app/src/session.ts`. Hosted UI is Account-only (`app/src/hosted-app.tsx`). Local Account is unchanged.

Tests: `tests/session.test.ts`, `tests/hosted-account-browser.test.ts`, Worker route cases in `hosted/tests/identity.test.ts`, existing `tests/sources-browser.test.ts`.
