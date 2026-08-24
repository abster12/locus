# Handoff: Locus

Use this file as the starting point for a new session. Work from `/Users/abhigyan/Desktop/Dev/locus`.

## Current state

- Saved: 2026-08-23
- Phases 1–3 implemented in this tree (desk, Capture Protocol, headed runner, X/YouTube/Reddit/Instagram packs, Reddit export, optional Pi prose)
- Repository: still not initialized (no commit unless asked)
- How to run: `npm install && npm run dev` then open http://127.0.0.1:8787
- Tests: `npm test`
- Extension: load unpacked `extension/shell`
- Data: `~/Library/Application Support/Locus/`
- Next work: Phase 5 in-tab viewer if the user asks — `handoff/prompts/phase-5-in-tab-viewer.md`
- Do not commit or push unless the user asks

### What was built

- Local SQLite desk with fixtures from X, Instagram, YouTube, Reddit
- Deterministic day/collection summaries; `SummaryGenerator` + optional Pi prose
- Capture Protocol V1, pairing tokens, JSONL import, headed Chrome runner
- Site packs for all four sources; Manifest V3 extension “save this item”
- Reddit official-export importer; Instagram official export not shipped (no proven Saved fixtures)
- Disconnect revokes token and deletes that source’s capture profile

### Deferred / unverified live

- Live Connect on Instagram/YouTube/Reddit depends on logging in inside the Locus-owned window
- Instagram export importer
- LICENSE file (ask before adding)

## Mission

Locus is a free, open-source, local-first dashboard for personal social-media bookmarks and saves.

The first release covers:

- X Bookmarks
- Instagram Saved
- YouTube Watch Later and saved playlists
- Reddit Saved posts and comments

It is not a work dashboard. GitHub, Gmail, RSS, Maps, Slack, Linear, and other work or general-productivity sources are outside the first product.

The dashboard is the product. It must remain useful without a model, agent, paid API, API key, hosted account, cloud service, or Executor installation.

## Honest product promise

Locus can be free and open source. The source platforms are proprietary and control access to their saves.

The first release promises:

- **automated capture** from the four supported social sites after the user logs in once in a Locus-opened browser window
- later refreshes reuse that local browser session when it is still valid — the user does not re-import by hand
- local organization, search, summaries, and export
- summaries that work with no model
- optional prose summaries through a model the user already pays for (Pi login), never a Locus-billed model
- no required payment or developer account
- Locus never asks for, stores, or transmits passwords, cookies, or platform tokens (the real site gets the login; cookies stay inside the capture browser profile)
- visible failure when a site changes or a login expires
- extension interfaces for other producers, agents, and summary tools

It does not promise:

- invisible 3 a.m. headless scraping as the default (that is how accounts get flagged)
- exact historical save dates
- a complete backup of deleted or private posts
- permanent compatibility with every site
- official endorsement by the source platforms
- guaranteed compliance with every platform term
- that the first run will page through an unbounded lifetime of saves without the user present

Use "capture" for the free browser path. Reserve "sync" for a provider that has reliable cursor and deletion semantics.

## Why browser capture is the default

The official interfaces cannot provide a free common path:

- [X bookmark reads are paid](https://x-preview.mintlify.app/x-api/getting-started/pricing), including personal Owned Reads.
- [Instagram's official API](https://developers.facebook.com/docs/instagram-platform/instagram-api-with-facebook-login) does not expose a personal account's Saved collection.
- [YouTube's Data API](https://developers.google.com/youtube/v3/docs/playlistItems/list) explicitly cannot list Watch Later.
- [Reddit's Data API terms](https://redditinc.com/policies/data-api-terms) allow some free non-commercial use, but access is OAuth-based, revocable, rate-limited, and subject to changing terms.

The common no-payment route is a **local capture runner**, not a paid API and not “please go save this yourself.”

This is feasible on a machine the user already runs Locus on:

1. Dashboard **Connect X** (or Instagram / YouTube / Reddit) opens a **visible** browser window Locus owns.
2. The runner navigates to that site's login or Saved/Bookmarks URL.
3. If the site shows a login wall, the user logs in **on the real site** in that window. Locus does not see the password.
4. Once the site pack detects a logged-in Saved/Bookmarks page, the runner scrolls and collects records that the page already renders, and submits Capture Protocol batches.
5. The window stays visible. Progress and errors show on the dashboard. The user can cancel.
6. The capture browser profile is kept on disk. Next **Refresh** usually skips login.

That is the workaround. Official APIs do not give these collections away; a headed local browser after the user's own login does.

A Manifest V3 extension remains the second path: use the user's everyday Chrome, where they are often already logged in, so they never log in twice. Same site packs, same Capture Protocol.

Do **not** drive the user's main Chrome profile (locks the browser, mixes sessions). Do **not** export cookies out of the capture profile. Do **not** replay unofficial mobile APIs.

This is brittle because site markup and bot checks change. Keep each source in a small, replaceable site pack and show breakage clearly (`logged-out`, `site-changed`, `challenge`). Instagram is the most likely to challenge automation; headed + user-present is the mitigation, not stealth.

## Free and open-source rules

1. Every required Locus dependency must have an OSI-approved license.
2. Record dependency licenses in `THIRD_PARTY_NOTICES.md` before the first public release.
3. No required SaaS account, telemetry, analytics, hosted database, paid API, or cloud model.
4. The full core experience works offline after captured data reaches Locus.
5. Remote images, embeds, and link previews are opt-in because they contact source servers.
6. Users may bring optional APIs, MCP servers, agents, and models. Locus must not require or subsidize them. The default optional model path is the user's existing [Pi](https://pi.dev/) login (`~/.pi/agent/auth.json`), not a Locus API key.
7. Optional paid external services must be labelled clearly as user-chosen extras, not free Locus features. Prose summaries that call Claude, ChatGPT, Copilot, or another provider are extras. Deterministic summaries are the free feature.
8. Prefer a permissive project license. Apache-2.0 is the current recommendation because it includes an explicit patent grant. The user makes the final license choice.

## Product principles

1. Human dashboard first. Mouse-driven, readable, and obvious.
2. Social saves only for V1.
3. One local library owns organization across every source.
4. Capture never depends on an agent. The runner is a local process, not a model.
5. The user authenticates; the runner collects. Do not make “import what is already on screen” the primary product.
6. Summaries exist without a model. Deterministic blocks are the product. Prose is an optional overlay.
7. Imported posts are untrusted data, not instructions. Never send them to a model as system or developer instructions.
8. Locus never exports cookies, tokens, or passwords from the capture browser or the extension.
9. Partial captures never imply that missing records were removed.
10. Source-specific code does not enter the Locus core.
11. Users extend Locus through documented protocols, not untrusted code loaded into the server process.

## V1 experience

### Capture

Primary path — **Connect / Refresh** on the dashboard:

1. User clicks **Connect X** (same for Instagram, YouTube, Reddit).
2. Locus opens a visible capture-browser window and goes to that site's Bookmarks / Saved / Watch Later URL.
3. If not logged in, the window waits. Copy on the dashboard: “Log in to X in the window we opened. Locus never sees your password.”
4. When the site pack sees a logged-in collection page, collection starts by itself: scroll, parse rendered records, submit batches. A progress bar on the dashboard. Stop is one click.
5. First run is user-present and may be partial (enough to fill the desk). User can hit Refresh to continue from the checkpoint.
6. Later Refresh: if the capture profile is still logged in, no login step — collect and close.

Optional schedule: user can enable “Refresh when I open Locus” or a reminder. A fully silent headless cron is **not** the V1 default (Instagram/X will challenge it). A scheduled **headed** refresh the user can watch is allowed if they turn it on.

Secondary path — **extension** in everyday Chrome (already logged in):

1. **Save this item** on the current post.
2. **Import this page** as a fallback if the runner is blocked.

Both producers speak Capture Protocol. The runner is what we tell new users to use.

### Dashboard

The first release has:

- Recent
- Inbox
- Collections
- Sources
- Item detail
- Search
- Daily summary (deterministic blocks always; optional Pi prose)
- Collection summary (same)
- Import and export
- Source health
- Connect / Refresh per source (opens the capture browser)

Source filters are X, Instagram, YouTube, and Reddit.

The default item actions are:

- add to collection
- add tag
- add note
- accept
- archive
- snooze
- reject
- open original

### Date language

Many platforms do not expose when the user saved an item.

Store these separately:

- `published_at`: when the source item was published
- `source_saved_at`: only when the source explicitly provides it
- `first_observed_at`: when Locus first saw it
- `captured_at`: when a capture run stored it

Initial imports create an `imported` activity. Later newly discovered items create a `detected` activity.

The UI must say "discovered today" or "captured today" when the actual save time is unknown. Never relabel publication time or import time as the save time.

## Architecture

```text
Capture runner + site packs  ─┐
  (opens browser, waits for login,
   collects, persists profile)
Browser extension + same packs├──> Capture Protocol ──> local server ──> SQLite
Import files and CLI scripts  │                            │
Optional API or MCP adapters  ┘                            └──> dashboard
                                                              │
                                         deterministic summaries (always)
                                                              │
                                         optional Pi prose (user's login)

Optional agents <──> Locus HTTP or Locus MCP read/proposal interface
```

The Capture Protocol is the only ingest interface. The runner, extension, imports, scripts, optional APIs, and MCP adapters all submit the same versioned batches.

Third-party producer code runs outside the Locus server. It receives a narrow, revocable capture token.

## Capture Protocol

Start with a versioned loopback HTTP protocol and JSONL import equivalent.

```ts
interface CaptureSessionV1 {
  protocolVersion: 1;
  source: "x" | "instagram" | "youtube" | "reddit" | `custom:${string}`;
  producer: {
    id: string;
    version: string;
  };
  accountExternalId: string;
  collection: {
    externalId: string;
    name?: string;
    url?: string;
  };
  mode: "incremental" | "snapshot";
  observedAt: string;
}

interface CaptureBatchV1 {
  sessionId: string;
  sequence: number;
  idempotencyKey: string;
  changes: CaptureChangeV1[];
}

type CaptureChangeV1 =
  | {
      kind: "upsert";
      externalId: string;
      revision?: string;
      sourcePosition?: number;
      item: ItemDraftV1;
      metadata?: Record<string, JsonValue>;
    }
  | {
      kind: "remove";
      externalId: string;
      observedAt: string;
    };

interface CaptureFinishV1 {
  sessionId: string;
  coverage: "complete" | "partial";
  cursor?: JsonValue;
}
```

Runtime rules:

- Assign the account and permissions from the pairing token. Do not trust a producer to choose another account.
- Unique source identity is `(source_account_id, external_id)`.
- Unique collection membership is `(source_collection_id, source_record_id)`.
- Commit a batch, sequence number, and checkpoint in one SQLite transaction.
- Replayed batches are harmless upserts.
- Reject unknown, malformed, oversized, or unsafe payloads before storage.
- Namespaced source metadata has a strict size limit.
- Partial captures only add or update. They never remove.
- Remove missing membership only after a verified complete snapshot.
- Preserve an item locally after source removal unless the user deletes it.
- Do not automatically fetch URLs found inside captured content.

## Capture runner (default producer)

A local process started from the dashboard. Not an agent. Not headless-by-default.

Responsibilities:

- Launch a **headed** Chromium/Chrome window with a per-source persistent profile under `~/Library/Application Support/Locus/browsers/<source>/`.
- Navigate to the collection URL the site pack declares.
- Detect `logged-out` vs ready. Block on login; do not type or scrape credentials.
- Detect common challenge walls (`challenge`) and stop with recovery text (“complete the check in the window, then click Resume”).
- Run the same `SitePack.capture()` as the extension: scroll, parse rendered cards, emit batches.
- Checkpoint after each committed batch so Refresh resumes.
- Close the window on success, cancel, or unrecoverable error.
- Never copy cookies or storage out of the profile. Never log request headers that carry session material.

Use a real Chrome channel when possible (installed Google Chrome), not a bare automation build. User-present + headed is the anti-challenge strategy. Do not add stealth/evasion packs.

Required extra error codes: `login-timeout`, `challenge`, `session-expired`.

## Browser extension

Ship one open-source Manifest V3 extension with the **same** four site packs, for people already logged into everyday Chrome.

### Site-pack interface

```ts
interface SitePack {
  manifest: {
    id: string;
    version: string;
    protocolVersion: 1;
    hostPermissions: string[];
  };

  detect(page: PageContext): CaptureTarget | null;

  capture(
    request: CaptureRequest,
    context: CaptureContext,
  ): AsyncIterable<CaptureBatchV1>;
}
```

A site pack owns:

- supported page URLs
- current-account detection
- Saved or Bookmarks page detection
- stable source ID extraction
- rendered-card parsing
- virtualization and loaded-record handling
- source ordering
- mapping into the common item shape
- empty-state and site-change detection

The extension runtime owns:

- pairing
- permission requests
- schema validation
- batching
- retries to local Locus
- progress
- cancellation
- source health

### Permissions

- Request each platform's host permission only when its pack is enabled.
- Use `activeTab`, `scripting`, and extension storage where possible.
- Never request `<all_urls>`.
- Do not request cookies, browsing history, or password access.
- Do not intercept or replay private mobile interfaces.
- Do not download remote code.
- Keep the Locus capture token in extension-owned storage and never expose it to page scripts.
- Content scripts send records through a narrow extension message channel.

### Capture health

Record every run with:

- source and pack version
- start and finish time
- captured and rejected counts
- complete or partial coverage
- last checkpoint
- error code and recovery text

Required errors:

- `logged-out`
- `login-timeout`
- `session-expired`
- `challenge`
- `wrong-page`
- `permission-denied`
- `site-changed`
- `scan-stalled`
- `tab-closed`
- `server-unreachable`
- `storage-full`
- `interrupted`

Zero records is success only when the pack positively recognizes the source's empty state.

## Source-specific plan

### X

V1 default:

- Connect/Refresh opens the capture browser on the Bookmarks URL, waits for login, then collects
- preserve X bookmark order when available
- use post ID as stable identity
- extension: capture the current post or thread as a side path

Do not use X's paid API in the default path. A later user-funded official provider may use the API and submit normal capture batches.

X does not expose the bookmark timestamp through its official endpoint. Browser capture must not invent one.

### Instagram

V1 default:

- Connect/Refresh opens Saved (and Saved Collections), waits for login, then collects
- expect challenges; headed + user-present; stop on `challenge` rather than fighting the wall
- use media ID or canonical shortcode as identity
- extension: capture the current post or reel as a side path

Add an official data-export importer only after testing real export fixtures and documenting which saved data Meta includes.

Do not claim official Saved API support. Do not store login data or call unofficial mobile interfaces.

### YouTube

V1 default:

- Connect/Refresh opens Watch Later and any playlists the user selected, waits for Google login, then collects
- store playlist membership separately from video identity
- extension: capture the current video as a side path

The official YouTube API may later support user-created playlists within free quota, but it cannot read Watch Later. The browser pack remains the default.

### Reddit

V1 default:

- Connect/Refresh opens the Saved page, waits for login, then collects posts and comments as distinct items
- support Reddit's official data-export files when fixtures confirm their current shape
- use Reddit fullname or canonical post/comment ID as identity
- extension: capture the current post or comment as a side path

An optional OAuth provider may be added later for users whose use fits Reddit's current terms. It is not required for V1.

## Core data model

### SourceAccount

One account on one platform.

```text
id
source
external_id
display_name?
created_at
```

### SourceCollection

One upstream collection, such as X Bookmarks, Instagram Saved, YouTube Watch Later, or Reddit Saved.

```text
id
source_account_id
external_id
name
url?
created_at
```

### CaptureRun

```text
id
source_collection_id
producer_id
producer_version
started_at
finished_at?
coverage
status
seen_count
upserted_count
removed_count
error_code?
error_detail?
```

### SourceRecord

```text
id
source_account_id
external_id
revision?
item_id?
first_observed_at
last_observed_at
source_position?
metadata?
```

Several source records may point to one deduplicated item.

### Item

```text
id
content_type          post | thread | reel | video | comment | link
title?
body?
url
author_name?
author_handle?
published_at?
source_saved_at?
first_observed_at
media[]
created_at
updated_at
```

Remote media is stored as references only in V1. Do not mirror media by default.

### Activity

```text
id
item_id
kind                  imported | detected | captured | updated | source_removed
occurred_at
timestamp_source      source | locus
capture_run_id?
```

### User organization

```text
ItemState: item_id, status, snoozed_until?, updated_at
Collection: id, name, description?, created_at
Tag: id, name, color?
Membership: item_id, target_id, target_kind, actor, created_at
Note: id, item_id, body, created_at, updated_at
```

Item status is `inbox`, `accepted`, `snoozed`, `archived`, or `rejected`.

### Summary

```text
id
scope                 day | collection | selection | item
scope_ref
item_revisions[]
generator_id
generator_version
content
citations[]
created_at
```

### Proposal

```text
id
scope
command
reason
status                pending | accepted | rejected
created_at
resolved_at?
```

Proposals are reserved for optional agents after V1.

## Summaries without paid AI

Summaries are a core feature. They do not require a model, Pi, an API key, or a network.

### Layer 1. Deterministic (required, Phase 1)

Always on. Built from SQLite. Works offline.

Blocks:

- new captures by source
- newly discovered creators
- most common tags
- items added to collections
- unresolved Inbox count
- selected excerpts
- links back to every cited item

Required scopes: day, collection, selection, item.

The UI must show these blocks even when no model is connected. If a prose pass fails, keep the blocks.

### Layer 2. Optional prose via Pi (V1, not required)

A `SummaryGenerator` may turn the **same snapshot** into prose. The first shipped generator uses [Pi](https://pi.dev/) so the user can spend a subscription or key they already have: ChatGPT Plus/Pro (Codex), Claude Pro/Max, GitHub Copilot, xAI, OpenRouter, llama.cpp, Ollama, or any API key Pi already understands.

Locus does not bundle a model. Locus does not create a Locus-billed inference account. Locus does not require the `pi` CLI to open the desk.

```ts
interface SummarySnapshotV1 {
  scope: "day" | "collection" | "selection" | "item";
  scopeRef: string;
  generatedAt: string;
  blocks: DeterministicBlockV1[];
  items: CitedItemV1[];
}

interface SummaryGenerator {
  id: string;
  version: string;
  generate(snapshot: SummarySnapshotV1): Promise<ProseSummaryV1>;
}
```

Pi adapter rules:

- Optional package under `optional/summaries/pi/`. Core and the dashboard import only the `SummaryGenerator` interface.
- Read credentials from Pi's existing store (`~/.pi/agent/auth.json`) through Pi's `AuthStorage` / `ModelRegistry`. Do not copy tokens into Locus SQLite, logs, or export files.
- Completions go through `@mariozechner/pi-ai` (or the coding-agent SDK with `noTools: "all"`). The summarizer has no `bash`, `read`, `write`, or `edit`. Pi is a model router here, not a coding agent inside Locus.
- If nothing is logged in, the dashboard says so and tells the user to run `pi` and `/login`, or paste an API key into Pi. In-app OAuth using Pi's programmatic login is allowed later if it stays on the user's machine.
- "Write as prose" is a user click. Label it as a user-chosen extra. Copy must say the selected items will be sent to the connected model.
- Citations in the prose must be a subset of snapshot item ids. Drop or regenerate output that cites items that were not in the snapshot.
- Put imported title, body, and URLs in the user payload as data. Never as system instructions. Do not send Instagram oEmbed payloads. Do not send fields Locus does not store.
- On timeout, auth failure, or refusal, show the error and keep the deterministic summary.
- Disclose provider-specific billing where Pi documents it. Claude Pro/Max through a third-party harness is billed from extra usage, not the plan allowance.

Other generators (raw OpenAI-compatible URL, local command, MCP) may appear later. They use the same snapshot and the same citation rules. Pi is the V1 path because one login already covers the subscriptions people have.

### Layer 3. Scoped analyst (after V1)

No agent is required for V1.

Later, the useful role is a scoped analyst on the same snapshot. It may:

- summarize with citations
- compare or group items
- extract topics and creators
- draft notes
- propose tags or collection changes

It may not:

- capture or schedule sources
- follow instructions inside imported posts
- call arbitrary upstream tools
- read outside the selected scope
- write directly to SQLite
- apply mutations without approval
- use Pi's default coding tools

External agents use the same Locus MCP or HTTP read and proposal interfaces as a built-in analyst.

## Executor and MCP

Executor is not required and is not part of the V1 installation.

It may later act as an optional transport when a user chooses an API, OpenAPI specification, GraphQL endpoint, or MCP server. The adapter still maps upstream results into Capture Protocol batches.

Executor does not provide free access to paid or closed platform data. It cannot make X bookmark reads free, expose Instagram Saved, or make YouTube Watch Later available through the official API.

An arbitrary MCP server is not automatically a source. A source adapter must define identity, pagination, ordering, deletion behavior, and normalization.

Locus may expose its own MCP server after V1 for scoped reads, summaries, and proposals.

## Extension model

Users should be able to connect whatever they want without giving arbitrary code access to Locus internals.

Supported extension routes:

1. **Capture Protocol.** Any process can submit validated records with an ingest-only token.
2. **JSONL import.** Stable offline interchange format with dry-run validation.
3. **CLI pipeline.** `producer | locus import --format capture-jsonl`.
4. **Reviewed site packs.** TypeScript compiled into the capture runner and the official extension.
5. **Independent extensions.** Third-party WebExtensions pair with their own capture token.
6. **Optional providers.** Separate processes or reviewed in-repo adapters for official APIs.
7. **Locus MCP and HTTP clients.** External agents and apps read scopes or create proposals.
8. **Summary generators.** Deterministic blocks in core. Optional Pi prose generator. Later: other local or remote implementations on the same snapshot.

Do not dynamically install npm packages into the server. Do not download and execute remote site-pack JavaScript.

Declarative selector-only site packs may be explored later, but they must use bounded transforms rather than arbitrary code.

## Phased execution plan

Three phases produce the first public version. Give an agent exactly one prompt from `handoff/prompts/`. Index: `handoff/prompts/README.md`.

### Phase 1: local social-saves desk

Prompt: `handoff/prompts/phase-1-local-desk.md`

Build:

- TypeScript workspace
- SQLite schema
- local HTTP server
- Vite dashboard
- fixture capture producer
- about 30 social-save fixtures across all four sources
- Recent, Inbox, Collections, Sources, Item detail, and Search
- deterministic day and collection summaries (no model)
- `SummaryGenerator` interface and snapshot type only. No Pi dependency yet
- JSON export and complete local deletion

Do not build the capture runner or browser extension yet.

Phase 1 is done when:

- [ ] no work-oriented source or UI remains
- [ ] fixtures from all four sources use the same item and activity model
- [ ] collection, tag, note, status, and search changes persist
- [ ] deterministic summaries cite their items
- [ ] no model, API key, account, or internet connection is required

### Phase 2: Capture Protocol, runner, and X vertical slice

Prompt: `handoff/prompts/phase-2-capture-x.md`

Build:

- versioned Capture Protocol and runtime schemas
- pairing with revocable, source-bound capture tokens
- atomic batch ingestion and idempotency
- capture-run history and health
- JSONL import with dry-run
- **capture runner**: headed Chrome window, per-source profile, login wait, progress, cancel
- X Bookmarks site pack that collects after login (scroll + rendered cards)
- dashboard Connect / Refresh / health for X
- Manifest V3 extension shell + “save this item” as the secondary path

Phase 2 is done when:

- [ ] Connect X opens a browser, user logs in on x.com, bookmarks land in Locus with no API key
- [ ] a second Refresh reuses the profile when still logged in
- [ ] `logged-out`, `challenge`, and `site-changed` are visible and recoverable
- [ ] replaying a batch creates no duplicates
- [ ] partial capture never removes existing records
- [ ] Locus never reads or sends cookies or passwords

### Phase 3: remaining sources and V1

Prompt: `handoff/prompts/phase-3-sources-and-v1.md`

Build YouTube and Reddit first, Instagram last, then harden:

- YouTube runner pack: Watch Later and chosen playlists after Google login
- Reddit runner pack: Saved posts and comments after login
- tested Reddit data-export importer
- multi-account / multi-profile separation
- revoke profile + token UI (deletes capture-browser profile for that source)
- recovery tests for changed markup, interrupted capture, expired session
- Instagram runner pack: Saved and Saved Collections after login
- stop-and-resume on `challenge` (do not fight the wall)
- official export importer if real fixtures prove it reliable
- optional “Refresh when I open Locus” (headed, user can see it)
- complete and partial capture language throughout the UI
- import/export compatibility fixtures
- dependency license audit and `THIRD_PARTY_NOTICES.md`
- threat model and hostile-content tests
- Chromium/Chrome runner + extension packaging and reproducible build instructions
- optional Pi prose `SummaryGenerator` (`optional/summaries/pi/`), tools disabled, labeled as a user-chosen extra

V1 is done when:

- [ ] Connect on each of X, Instagram, YouTube, and Reddit logs in once and collects without a developer account
- [ ] Refresh works from a warm capture profile
- [ ] every default path is free and works without a developer account
- [ ] no required hosted service, Executor, API key, or model exists
- [ ] failures and partial coverage are visible
- [ ] exact save dates are shown only when supplied by the source
- [ ] all user data can be exported and deleted
- [ ] a custom script can ingest records without changing Locus core
- [ ] required code and dependencies are open source
- [ ] day and collection summaries work with Pi uninstalled
- [ ] with a Pi login present, "Write as prose" uses that model and still cites only snapshot items
- [ ] Locus never stores Pi tokens or provider API keys in SQLite

### After V1

No prompt yet. Only after the V1 bar:

- publish Capture Protocol schemas and client package
- add Firefox support
- add optional official API providers
- add Locus MCP read and proposal server
- deepen the scoped analyst (notes, proposals) on top of the Pi summarizer
- consider declarative third-party site packs
- consider sandboxed MCP Apps for specialist views

## Security and privacy baseline

- Bind the server to loopback.
- Require a per-install authenticated dashboard session.
- Validate `Host` and `Origin`.
- Protect mutations against CSRF. CORS alone is insufficient.
- Pair every producer explicitly.
- Bind capture tokens to one source account and capability.
- Make tokens independently revocable.
- Validate all captured data at runtime.
- Sanitize text and URLs before rendering.
- Use `noopener noreferrer` for external links.
- Do not auto-load remote media.
- Do not store cookies, passwords, or platform tokens in Locus SQLite, logs, or the dashboard session. The capture browser profile on disk is Chrome's own storage; never copy it out, never upload it, delete it when the user disconnects a source.
- Do not copy Pi OAuth tokens or provider API keys out of `~/.pi/agent/auth.json`. Optional prose may send user-selected item text to the connected model after an explicit click.
- Do not retain raw page HTML.
- Give site packs no database access.
- Treat all imported content as hostile prompt input.
- Provide per-source deletion and complete library deletion.

## Target repository layout

Create directories only when their phase begins.

```text
locus/
  app/                         Vite dashboard
  server/
    capture/                   pairing, auth, validation, sessions
    http/                      dashboard and client interface
  core/                        items, activities, collections, summaries, commands
  db/                          schema, migrations, repositories
  packages/
    protocol/                  wire types, JSON Schemas, compatibility fixtures
    capture-client/            pairing and batch submission
    import-format/             JSONL interchange format
  runner/                      headed capture browser, profiles, login wait
  extension/
    shell/                     service worker, popup, pairing, progress
  site-packs/                  shared by runner and extension
    x/
    instagram/
    youtube/
    reddit/
  importers/
    reddit-export/
    instagram-export/          only after fixtures prove the format
  optional/
    providers/
    summaries/
      pi/                      optional prose via user's Pi login
    executor/
    mcp/
    agent/
  handoff/
    handoff-locus.md
```

## Explicitly deferred

- required Executor installation
- paid X API
- official-API-only architecture
- invisible headless background capture as the default
- stealth / anti-detect browsers
- private mobile interfaces
- cookie export; typing passwords into the site for the user
- write-back, liking, posting, or unsaving
- media mirroring
- cloud sync and multi-user
- telemetry and analytics
- bundled model
- requiring the `pi` CLI or a provider account to use the desk
- embeddings and vector search
- automatic AI filing
- giving the summarizer Pi coding tools (`bash`, `read`, `write`, `edit`)
- dynamic npm plugins
- remote extension code
- extension marketplace
- MCP App hosting
- Firefox and Safari in V1
- work sources and general productivity features

## Open decisions

These do not block Phase 1:

1. Apache-2.0 or MIT for the project.
2. Whether “Refresh when I open Locus” ships in V1 (headed only).
3. Whether V1 targets installed Google Chrome only or also bundled Chromium.
4. Maximum metadata and batch sizes in Capture Protocol.
5. How much remote media previewing the user wants to enable.
6. Whether V1 Pi login is “run `pi` then `/login`” only, or also in-app OAuth on loopback.

## Immediate next action

Implement Phase 1 only. Use `handoff/prompts/phase-1-local-desk.md`. Stop when the fixture-backed social dashboard, collections, search, and deterministic summaries work. Show the user the dashboard before building the capture runner.
