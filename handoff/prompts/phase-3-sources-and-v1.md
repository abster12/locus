# Phase 3. Remaining sources and V1

You are implementing Phase 3 of Locus, the last phase before the first public version.

Work from `/Users/abhigyan/Desktop/Dev/locus`.

If Phase 2 is not done, stop and say so. Connect X must already open a headed window, collect Bookmarks after login, and Refresh from a warm profile. If that is missing, go back to `handoff/prompts/phase-2-capture-x.md`.

Do not start after-V1 work (Firefox, official API providers, Locus MCP, bundled generators, declarative third-party packs).

## Read first

1. `/Users/abhigyan/Desktop/Dev/locus/handoff/handoff-locus.md`
2. This file
3. `/Users/abhigyan/Desktop/Dev/locus/handoff/locus-free-social-saves-v1-feasibility-2026-08-23.md`
4. Existing runner, protocol, X pack, and dashboard Connect / Refresh

Handoff wins on product shape. Feasibility note still binds these claims and techniques:

- Do not claim official Instagram Saved, YouTube Watch Later API, or free X bookmark API
- Do not persist Instagram oEmbed as metadata
- Reddit official export is allowed once fixtures match the current `saved_posts.csv` / `saved_comments.csv` shape
- Instagram official export importer only after real fixtures prove it. Mark it experimental until then
- No unofficial mobile APIs, no stealth, no cookie export
- Do not scrape as a hidden headless cron. Headed and user-present remains the default

## Mission

Same Capture Protocol and runner as X. Three more site packs. Then harden until the V1 bar in the handoff is honest.

Instagram is last among the three packs. It is the most likely to challenge. Stop on `challenge`. Do not fight the wall.

## Your job

1. YouTube and Reddit packs, plus Reddit export import.
2. Instagram pack and optional Instagram export only if fixtures justify it.
3. Multi-account / multi-profile hygiene and revoke.
4. V1 hardening and packaging.
5. Optional Pi prose summaries on the same snapshot as the deterministic blocks.

## Build

Create only what this phase needs:

```text
site-packs/youtube/
site-packs/reddit/
site-packs/instagram/
importers/reddit-export/
importers/instagram-export/    only after fixtures prove the format
```

Create `optional/summaries/pi/` for the prose generator. Leave `optional/providers`, `optional/executor`, `optional/mcp`, and `optional/agent` empty.

### Sources

YouTube:

- Connect / Refresh opens Watch Later and any playlists the user selected, waits for Google login, collects
- Store playlist membership separately from video identity
- Extension: save the current video as a side path
- Do not use the YouTube Data API as the default. It cannot list Watch Later

Reddit:

- Connect / Refresh opens Saved, waits for login, collects posts and comments as distinct items
- Identity: Reddit fullname or canonical post/comment ID
- Tested importer for official `saved_posts.csv` and `saved_comments.csv` once you have fixtures
- Extension: save the current post or comment as a side path
- No Reddit OAuth provider in V1

Instagram (after YouTube and Reddit work):

- Connect / Refresh opens Saved and Saved Collections, waits for login, collects
- Identity: media ID or canonical shortcode
- On `challenge`, stop and show "complete the check in the window, then click Resume"
- Extension: save the current post or reel as a side path
- Official export importer only after real HTML/JSON fixtures. Do not advertise Saved export if the fixture lacks it

### Product

- Multi-account / multi-profile separation. One capture profile per source account
- Revoke profile + token UI. Disabling a source deletes that source's capture-browser profile and revokes its token. Never copy the profile out before delete
- Recovery tests: changed markup (`site-changed`), interrupted capture, expired session
- Optional "Refresh when I open Locus" if you ship it: headed only, user can see the window. Not a silent headless cron
- Complete vs partial coverage language on every source health surface
- Import/export compatibility fixtures for Capture Protocol JSONL
- Dependency license audit. Write `THIRD_PARTY_NOTICES.md`. Every required dependency needs an OSI-approved license
- Threat model notes in the handoff or a short `handoff/` security note: loopback, CSRF, pairing, hostile imported content, no cookie export
- Hostile-content tests: imported HTML/text/URLs must not execute, must not become model instructions, must sanitize before render
- Chromium/Chrome runner + extension packaging and reproducible build instructions
- Prefer Apache-2.0 for the project license if the user has not chosen. Ask before adding a LICENSE file if none exists
- Optional Pi prose generator, after the four source packs work:
  - Implement `SummaryGenerator` in `optional/summaries/pi/`
  - Use `@mariozechner/pi-ai` (MIT) plus Pi `AuthStorage` / `ModelRegistry` from `@mariozechner/pi-coding-agent` so the user can spend ChatGPT Plus, Claude Pro/Max, Copilot, xAI, OpenRouter, llama.cpp, or an API key already in `~/.pi/agent/auth.json`
  - Completions only. `noTools: "all"` if you touch the coding-agent SDK. No `bash`, `read`, `write`, or `edit`
  - Do not copy Pi tokens into Locus SQLite, logs, or exports
  - If Pi is missing or nobody is logged in, the desk still shows deterministic summaries. UI tells the user to run `pi` and `/login`
  - "Write as prose" is a click. Label it a user-chosen extra. Warn that selected items leave the machine toward the connected model
  - Prose citations must be a subset of snapshot item ids
  - Imported text is user-payload data, never system instructions. No Instagram oEmbed in the prompt
  - Failure keeps the deterministic summary
  - Record Pi package licenses in `THIRD_PARTY_NOTICES.md`. Pi stays optional. Do not add it to the required install path
  - Disclose Claude-through-Pi extra-usage billing in the settings copy if that provider is listed

## Do not build

- Paid X API, official Instagram Saved API claims, YouTube Watch Later via Data API
- Headless-by-default capture, stealth browsers, private mobile interfaces
- Cookie export, password filling, write-back
- Media mirroring, cloud sync, telemetry, bundled model
- Executor, Locus MCP, agent proposals, Pi coding tools on the summarizer
- Requiring `pi` or a provider account to open the desk
- Firefox / Safari
- Dynamic npm plugins or remote site-pack JavaScript
- Git commit or push unless the user asks

## Done when (V1 bar)

- [ ] Connect on each of X, Instagram, YouTube, and Reddit logs in once and collects without a developer account
- [ ] Refresh works from a warm capture profile on each connected source
- [ ] Every default path is free and works without a developer account
- [ ] No required hosted service, Executor, API key, or model exists
- [ ] Failures and partial coverage are visible
- [ ] Exact save dates are shown only when supplied by the source
- [ ] All user data can be exported and deleted
- [ ] Disabling a source revokes its token and removes its capture profile
- [ ] Source collection membership survives duplicate captures
- [ ] A custom script can ingest records via Capture Protocol or JSONL without changing Locus core
- [ ] Required code and dependencies are open source and listed in `THIRD_PARTY_NOTICES.md`
- [ ] Day and collection summaries work with Pi uninstalled
- [ ] With a Pi login present, "Write as prose" uses that model and cites only snapshot items
- [ ] Locus never stores Pi tokens or provider API keys in SQLite

## Verify

In the browser, on a machine with the user's own accounts where available:

1. Fresh Connect for YouTube. Watch Later items appear. Playlist membership is separate from video identity.
2. Fresh Connect for Reddit. Posts and comments are distinct items. Re-run does not duplicate membership.
3. Reddit export dry-run and import against fixtures (or a user-supplied archive).
4. Fresh Connect for Instagram. If a challenge appears, confirm stop + Resume, not a retry storm.
5. Disconnect one source. Confirm token gone, profile directory gone, other sources intact.
6. Export the library. Delete all. Confirm empty desk.
7. Submit a hostile fixture (script tags in title/body, `javascript:` URL). Confirm it cannot run in the UI.
8. Walk Source health for a partial run and a complete run. Language must match coverage.
9. Open a day summary with Pi unconfigured. Deterministic blocks are complete. Prose is offered only as an optional extra, not a broken empty state.
10. If the user has a Pi login, run "Write as prose" on that day. Confirm citations match snapshot items. Confirm tokens did not land in SQLite. If they have no login, say so and skip.

If you cannot log into a platform, say which source is unverified and what you tested with fixtures instead. Do not ship a pack you have never run against a live logged-in page or a recorded fixture of that page.

## When finished

Update `handoff/handoff-locus.md` current state:

- Phase 3 complete
- V1 bar met or list the remaining unchecked items honestly
- How to run desk, runner, extension, and importers
- Next work: after-V1 only if the user asks (no prompt file yet)

Stop. Do not publish Capture Protocol packages, add Firefox, or add MCP unless the user asks.

---

Built 2026-08-23. YouTube/Reddit/Instagram packs ship with the same runner. Reddit export fixtures import. Instagram official export not shipped. Optional Pi prose uses `~/.pi/agent/auth.json` and does not copy keys. Live Connect still needs a login in the Locus-owned window (not everyday Chrome).
