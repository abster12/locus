# Locus hosted deployment plan

Status: active
Date: 2026-09-01
Updated: 2026-09-03

## Outcome

Ship **the whole Locus App** on the existing identity Worker: Google sign-in, one private Library per user, Desk, Save a link, Kitchen, Atlas, Trips, Reading, Account, intake, WebMCP, trip share, library MCP.

Staging URL: `https://locus-identity-staging.abhigyan0987.workers.dev`

This is not a smaller hosted product. Identity (ADR 0003) is the boundary. ADR 0004 is the destination. ADR 0002 (no Effect) still holds.

## Capture: extension is enough

Two producers send the same Capture Protocol (start session → batches → finish).

**Extension — hosted capture.** The user's everyday Chrome is already logged into X / Instagram / YouTube / Reddit. Pair the extension to the hosted origin and a Library-scoped capture token. That is enough for hosted Source capture.

Distribute the extension from **GitHub first** (clone or a release zip of `extension/shell`, Chrome → Load unpacked). That is the path for anyone who wants capture before Chrome Web Store review. Store listing is later, for people who will not sideload. Sideload needs Developer mode and a manual update when the pack changes. Pairing origin is the hosted Worker URL, not localhost.

**Runner — only where Chrome already runs.** The runner is a headed Chrome that a Locus process opens on a computer. Pointing that process at the hosted domain is enough for *that computer* to write into the hosted Library. It does not create a runner on Cloudflare. The website cannot open Chrome. Users with only the website do not have a runner.

Do not build Cloudflare Browser Run or Containers for this path. Local Locus may keep a runner that targets the hosted origin (optional hybrid). Hosted Account **Capture now** without a local process is extension-driven, not server-launched Chrome.

## Current execution status

- Identity tickets 01–06 resolved. Staging proved two Google users, distinct Libraries, cross-user `404`, disable, no stored Google tokens. ADR 0003.
- D1 `0004_library_items.sql` applied local + staging (items, item_state, activities, item_intake, tags, collections, memberships, notes). Unique `(library_id, url)` and `(library_id, tag name)`.
- Desk + Save a link is on the staging Worker. Two-user isolation is covered by Worker tests.
- Desk mutations (status, tags, notes, collections, memberships) are on the staging Worker and in hosted Desk/Stage UI. Worker tests cover two-user isolation.
- Reading (documents, progress, extract-via-fetch, D1 text) is on the staging Worker. D1 `0005_reading.sql` applied local + staging. The Reading tab is on. Images stay at the original URL.
- Atlas, Kitchen, and Trips are on the staging Worker. D1 `0006_kitchen.sql`, `0007_atlas.sql`, and `0008_trips.sql` applied local + staging. Those tabs are on. Hosted Kitchen generate and Atlas analyzer stay disabled until an approved Worker secret exists. Owner trip share routes are on the Worker; public share HTML is still later.
- Step 5 is in the Worker: Source connection state, extension pairing to the hosted origin, Capture ingest + jobs in D1, JSONL import. No server Chrome. D1 `0009_capture.sql` applied local + staging.
- Step 6 is in the Worker: intake context/search, classified drafts prepare/save, agent batches with mutation ids, Library capabilities, `POST /mcp`. D1 `0010_intake_extras.sql` applied local + staging. WebMCP intake tools and Account capability grants are on in the hosted App.
- Step 7 is in the Worker and deployed: link preview (`0011_link_previews.sql`, Library-scoped cache), frame-check, deterministic summaries with the Summary tab on (prose stays unavailable until an approved Worker secret), and the public Trip share page at `GET /s/:token`. The share renderer and pure preview parsing moved to `core/` so local and hosted stay one implementation. Arbitrary URL fetches go through the reading-fetch SSRF policy — ADR 0005.
- Effect remains excluded (ADR 0002).

## Stack

Keep:

- One Worker + Static Assets + D1
- `hosted/` scripts: `check:staging`, `deploy:staging`, `migrations:apply:staging`, `tail:staging`
- Session cookie + CSRF already on the Worker
- Library id from `RequestIdentity` only

Do not add on this path: Tunnel, Containers, Pages, R2, Queues, custom domain, production env.

Do not import `server/http/server.ts` or `db/open.ts`. Do not copy `db/schema.ts`. Each domain gets a small async D1 module and a migration that is that domain's tables, with `library_id` on uniques.

## Invariants

- Cross-user guessed ids → `404`, not `403`
- Two users, two Libraries; same URL may exist in both
- Disabled user → `403` with a live cookie
- Anonymous private routes → `401`
- No emails or tokens in logs
- Hosted UI: `RUNTIME === "hosted"`; `boot()` calls `loadSession(RUNTIME)`; never `loadSession("local")` and never `LOCAL_LIBRARY_ID` as a fallback
- One SPA: Google gate, then the real `App`

## Architecture

```text
Browser ──┐
Extension ┼──► Worker + Static Assets
Local runner (optional, user's machine)
              - Google session, CSRF, RequestIdentity
              - same /api JSON the App already speaks
              - Capture Protocol (extension / local runner)
                    │
                    └── D1: auth, access, Libraries, Items, domain data
```

Trusted context is `userId` + `sessionId` + `libraryId`. Ordinary clients never choose those. Capture tokens bind `libraryId + source + sourceAccountId + capabilities`.

## Product decisions

1. **Same App.** Every local section is in the destination. Hide a tab only until its routes exist.
2. **Identity.** Google authenticates a Locus user. It does not connect a Source. GitHub, linking, teams, billing stay later.
3. **One Library per user** in beta, with `libraries` + `library_memberships` (`owner`).
4. **Registration.** Open through judging 2026-09-21 17:00 PDT. Operator `REGISTRATION_MODE` and per-user disable remain.
5. **Intake.** Save a link is the first hosted write. Agent drafts, batch, MCP follow in the same App.
6. **Capture.** Extension → hosted origin is the hosted producer. Runner stays a local Chrome process; it may POST to the hosted origin if that process exists.
7. **Reading.** HTML/blocks in D1 within existing fetch bounds. Images stay at the original URL. Extract via Worker `fetch` + `waitUntil` or cron, not Queues.
8. **AI.** Hosted Kitchen/Atlas/summary use Worker secrets, not `~/.pi`. Until that secret exists, those generate actions stay disabled rather than reading local files.
9. **Share.** Trip Share Snapshots are Worker routes + D1 tokens on workers.dev.
10. **Shared D1**, every query Library-scoped. Database-per-Library only with size or isolation evidence.

## Sequence

Each step deploys to staging. The App is the real App. Tabs whose APIs are missing stay hidden until that step lands, then they turn on.

### 1. Desk + Save a link — on staging

- `hosted/src` D1: `POST /api/intake`, `POST /api/intake/preview`, `GET /api/items`, `/api/items/counts`, `/api/items/:id`, `GET /api/collections`
- Session/CSRF already exist. Cross-user item ids → `404`
- UI: Google gate → `App`. Hide Kitchen, Atlas, Trips, Reading, Sources-connect until later steps
- Tests: two users, guessed id `404`, same URL in two Libraries, preview does not write
- `npm run check:staging` then `deploy:staging` from `hosted/`

Done when two signed-in users can each save a URL and only see their own Item.

### 2. Desk mutations — on staging

Status, tags, notes, `POST /api/collections`, memberships. Inbox becomes usable.

### 3. Reading — on staging

Documents, progress, extract-via-fetch, D1 text. Turn the Reading tab on.

### 4. Atlas, Kitchen, Trips — on staging

Their tables and routes. Turn those tabs on. Hosted AI only with an approved Worker secret.

### 5. Account minus server Chrome

Google identity (done). Source connection **state**. Pair extension to the hosted origin. Capture ingest + jobs in D1 (leases, expiry; no in-memory loop). Import JSONL. No “start Chrome” on the Worker.

### 6. Intake extras

Drafts, batch, context, library MCP, capabilities.

### 7. The rest of the App — on staging

Summaries, link preview, frame-check, trip share. SSRF policy for Worker `fetch` before arbitrary URL fetch (ADR 0005). Deployed 2026-09-03; operator two-user smoke of the new routes is the remaining live check.

After 4, hosted chrome matches local. After 5–7, the same verbs, except server-launched Chrome.

## Staging operations

Already in `hosted/package.json` and `.scratch/hosted-identity/staging-runbook.md`.

- Secrets: `BETTER_AUTH_SECRET`, `CSRF_SECRET`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` via `wrangler secret put --env staging`
- D1: `locus-identity-staging` / `f6f96094-57cf-4fb3-b751-9e7d1db1c861`
- Apply migrations remote before a deploy that needs new tables
- Structured logs on; invocation URL/header logs off (OAuth codes)
- Two-user smoke after each private slice: two Google accounts, cross-user `404`, no emails in `tail:staging`

Production env, custom domain, and Chrome Web Store listing are **later ops**, not this sequence. GitHub sideload is enough for optional capture until Store review lands.

## Test matrix (every private slice)

- Auth: first Google login, repeat login, sign-out, disabled `403`, anonymous `401`
- Tenancy: list/get/mutate with owner, other user, guessed id → `404`
- Intake: save, preview without write, duplicate reuse in one Library, same URL allowed in two Libraries
- Capture (from step 5): token bound to Library; revoked/wrong-source/replay denied
- D1: migration apply, unique `(library_id, url)`, concurrent first-save does not duplicate

## Next milestone

The sequence is deployed through step 7. What remains, in order: (1) operator two-user smoke of summaries, link preview, frame-check, and trip share on staging per the test matrix; (2) hosted capture reliability — issue 01 (capture does not finish all bookmarks); (3) decide the approved Worker secret for hosted AI (Kitchen generate, Atlas analyzer, summary prose) and turn those actions on; (4) later ops only — Chrome Web Store listing, production env, custom domain.
