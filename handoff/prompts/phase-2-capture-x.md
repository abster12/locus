# Phase 2. Capture Protocol, runner, and X

You are implementing Phase 2 of Locus and only Phase 2.

Work from `/Users/abhigyan/Desktop/Dev/locus`.

If Phase 1 is not done, stop and say so. Run the desk. If Recent, Inbox, Collections, Search, and summaries are missing or fixture-only with no persistence, go back to `handoff/prompts/phase-1-local-desk.md`.

If this session already finished Phase 2, stop. Do not start Phase 3.

## Read first

1. `/Users/abhigyan/Desktop/Dev/locus/handoff/handoff-locus.md`
2. This file
3. `/Users/abhigyan/Desktop/Dev/locus/handoff/locus-free-social-saves-v1-feasibility-2026-08-23.md` (legal and API facts)
4. The Phase 1 desk code now in the repo

Handoff wins on product shape. Headed local capture after the user logs in on the real site is the default path. Do not replace it with paste-only because the feasibility note is more conservative.

Still obey the feasibility note on:

- No cookie or password export
- No unofficial mobile APIs, private GraphQL replay, or stealth/evasion packs
- No paid X API on the default path
- No oEmbed-as-storage
- No claiming official bookmark sync
- Instagram oEmbed must not be persisted if you touch embeds at all (you should not, this phase)

## Mission

Capture never depends on an agent. The runner is a local process. The user authenticates on the real site. The runner collects rendered records. Locus never asks for, stores, or transmits passwords, cookies, or platform tokens.

Use "capture" in the UI. Do not call this "sync".

## Your job

Make ingest real, then prove it on X Bookmarks. The extension is the secondary path, not the story you tell new users.

## Build

Create only what this phase needs:

```text
server/capture/              pairing, auth, validation, sessions
packages/protocol/           wire types, JSON Schemas
packages/capture-client/     pairing and batch submission
packages/import-format/      JSONL interchange
runner/                      headed capture browser, profiles, login wait
extension/shell/             service worker, popup, pairing, progress
site-packs/x/                shared by runner and extension
```

Concrete work:

1. Capture Protocol V1 from the handoff (`CaptureSessionV1`, `CaptureBatchV1`, `CaptureChangeV1`, `CaptureFinishV1`). Runtime schemas. Reject unknown, malformed, oversized, or unsafe payloads before storage.
2. Pairing with revocable, source-bound capture tokens. Assign account and permissions from the token. Do not trust a producer to choose another account.
3. Atomic batch ingestion. Commit batch, sequence number, and checkpoint in one SQLite transaction. Replayed batches are harmless upserts. Unique source identity is `(source_account_id, external_id)`. Unique collection membership is `(source_collection_id, source_record_id)`. Partial captures only add or update. They never remove. Remove missing membership only after a verified complete snapshot. Preserve an item locally after source removal unless the user deletes it. Do not automatically fetch URLs found inside captured content.
4. Capture-run history and source health on the dashboard.
5. JSONL import with dry-run validation. Same protocol as live ingest.
6. Capture runner:
   - Headed Chrome window (installed Google Chrome if present)
   - Per-source profile under `~/Library/Application Support/Locus/browsers/<source>/`
   - Navigate to the X Bookmarks URL from the site pack
   - Detect `logged-out` vs ready. Block on login. Do not type or scrape credentials
   - Detect `challenge` and stop with recovery text
   - Run `SitePack.capture()`: scroll, parse rendered cards, emit batches
   - Checkpoint after each committed batch
   - Close on success, cancel, or unrecoverable error
   - Never copy cookies or storage out of the profile. Never log request headers that carry session material
   - No stealth pack. No driving the user's main Chrome profile
7. X Bookmarks site pack. Post ID is stable identity. Preserve bookmark order when the page exposes it. Do not invent `source_saved_at`.
8. Dashboard Connect X, Refresh, and health. Copy for login: "Log in to X in the window we opened. Locus never sees your password." Progress bar. One-click stop. First run may be partial. Refresh reuses the profile when still logged in.
9. Manifest V3 extension shell plus "save this item" as the secondary path. Same X pack. Request host permission only when the pack is enabled. No `<all_urls>`. No cookies, history, or password permissions. Capture token stays in extension storage, never in page scripts.

Required error codes this phase: `logged-out`, `login-timeout`, `session-expired`, `challenge`, `wrong-page`, `permission-denied`, `site-changed`, `scan-stalled`, `tab-closed`, `server-unreachable`, `storage-full`, `interrupted`.

Zero records is success only when the pack recognizes the source empty state.

Follow the TypeScript and no-inline-import rules from Phase 1. Site-specific code stays in the pack, not in `core/` or `db/`.

## Do not build

- YouTube, Reddit, or Instagram packs
- Official X API provider
- Headless capture as the default
- Cookie export or password filling
- Write-back (like, post, unsave)
- Media mirroring
- Executor, MCP, agents
- Firefox
- Phase 3 hardening (license audit, threat-model suite, installer packaging) beyond what X needs
- Git commit or push unless the user asks

## Done when

- [ ] Connect X opens a browser, the user logs in on x.com, bookmarks land in Locus with no API key
- [ ] A second Refresh reuses the profile when still logged in
- [ ] `logged-out`, `challenge`, and `site-changed` are visible and recoverable
- [ ] Replaying a batch creates no duplicates
- [ ] Partial capture never removes existing records
- [ ] Locus never reads or sends cookies or passwords
- [ ] JSONL dry-run and import work for an X-shaped fixture batch
- [ ] You verified Connect → login → records in Recent/Inbox in the browser, then Refresh

## Verify

Use a real X account the user controls, or stop and say you could not. In the browser:

1. Connect X. Confirm a visible Chrome window. Confirm the dashboard tells the user to log in on the real site.
2. After login, confirm collection starts without a second import gesture.
3. Confirm items appear with source X, stable ids, and no invented save dates.
4. Refresh. Confirm no second login when the profile is still valid. Confirm no duplicates.
5. Cancel mid-run. Confirm existing records remain. Confirm health shows partial coverage.
6. If you can safely trigger logged-out or challenge, confirm the dashboard recovery text. Do not build evasion.

Also run protocol tests: replay a batch, submit a partial finish, submit a malformed batch, confirm reject.

## When finished

Update `handoff/handoff-locus.md` current state:

- Phase 2 complete
- How to run desk + runner
- Next work: Phase 3 only

Stop. Do not start YouTube, Reddit, or Instagram packs.

---

Built 2026-08-23 in the all-phases session. Connect X opens headed Chrome at `~/Library/Application Support/Locus/browsers/x/<account>/`. Login happens on x.com. Protocol tests in `npm test`.
