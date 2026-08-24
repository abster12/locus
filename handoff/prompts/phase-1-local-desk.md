# Phase 1. Local social-saves desk

You are implementing Phase 1 of Locus and only Phase 1.

Work from `/Users/abhigyan/Desktop/Dev/locus`.

If this session already finished Phase 1, stop. Do not start Phase 2.

## Read first

1. `/Users/abhigyan/Desktop/Dev/locus/handoff/handoff-locus.md` (product and architecture source of truth)
2. This file (execution contract)
3. `/Users/abhigyan/Desktop/Dev/locus/handoff/locus-free-social-saves-v1-feasibility-2026-08-23.md` (legal and API facts only)

The handoff wins on product shape. Headed browser capture is the planned default for later phases. This phase does not implement capture.

From the feasibility note, keep these rules even on the fixture desk:

- Do not claim official Saved, Bookmarks, or Watch Later API support
- Do not treat oEmbed as stored metadata, especially Instagram
- Do not auto-load remote media, embeds, or link previews
- Do not bundle a model
- Exact save dates appear only when a fixture (later, a source) actually supplies them

## Mission

Locus is a free, open-source, local-first dashboard for personal social-media bookmarks and saves. First sources: X, Instagram, YouTube, Reddit. Not a work dashboard.

The dashboard is the product. After this phase it must be useful with no model, agent, paid API, API key, hosted account, cloud service, or Executor.

## Your job

Build the local library and the human dashboard. Prove the data model with fixtures. Show the user a working desk.

Do not build the capture runner, site packs, browser extension, pairing tokens, or live Connect / Refresh.

## Build

Create directories only when this phase needs them. Expected now:

```text
app/                 Vite dashboard
server/http/         local HTTP API for the dashboard
core/                items, activities, collections, summaries, commands
db/                  schema, migrations, repositories
```

You may add a small fixture loader under `server/` or `core/`. Do not create `runner/`, `extension/`, or `site-packs/`.

Concrete work:

1. TypeScript workspace. One package manager. Strict TypeScript. Imports at the top of each file. Exhaustive `switch` on unions and enums with a `never` default.
2. SQLite schema for the core model in the handoff: SourceAccount, SourceCollection, CaptureRun (can stay empty this phase), SourceRecord, Item, Activity, ItemState, Collection, Tag, Membership, Note, Summary.
3. Local HTTP server bound to loopback. Per-install authenticated dashboard session. Validate `Host` and `Origin`. CSRF protection on mutations.
4. Vite dashboard. Mouse-driven, readable, obvious. Screens: Recent, Inbox, Collections, Sources, item detail, Search. Source filters: X, Instagram, YouTube, Reddit. Item actions: add to collection, add tag, add note, accept, archive, snooze, reject, open original.
5. Fixture producer that loads about 30 social-save fixtures across all four sources into the same item and activity model. Mix posts, a thread, a reel, videos, comments, and links. Include at least one item with `source_saved_at` and several without.
6. Deterministic day and collection summaries. Required blocks: new captures by source, newly discovered creators, most common tags, items added to collections, unresolved Inbox count, selected excerpts, links back to every cited item. No model. Define the `SummarySnapshotV1` / `SummaryGenerator` types from the handoff so Phase 3 can plug Pi in. Do not add `@mariozechner/pi-ai` or `@mariozechner/pi-coding-agent` in this phase. The summary screens must look finished without a "connect a model" dead end. A quiet "Prose summaries can use a model you already pay for. Not required." is enough.
7. JSON export of the library. Complete local deletion of the library.
8. Date language: store `published_at`, `source_saved_at`, `first_observed_at`, `captured_at` separately. UI says "discovered today" or "captured today" when save time is unknown. Never relabel publication time or import time as save time. Initial fixture load creates `imported` activities.

Follow `/Users/abhigyan/.agents/skills/frontend-design/SKILL.md` for the dashboard. This is a personal desk, not a SaaS marketing page and not a generic shadcn admin theme.

Follow `/Users/abhigyan/.cursor/plugins/cache/cursor-public/pstack/46125561306434d8a1d7745d540d8932ab0cd2a2/skills/typescript-best-practices/SKILL.md` for TypeScript.

## Do not build

- Capture runner, headed Chrome, persistent browser profiles
- Browser extension
- Capture Protocol HTTP ingest, pairing, or tokens
- Live Connect / Refresh
- Site packs
- Official API providers
- Executor, MCP, agents, proposals
- Pi, `@mariozechner/pi-ai`, `@mariozechner/pi-coding-agent`, or any live model call
- Bundled or required model
- Work sources (GitHub, Gmail, RSS, Maps, Slack, Linear)
- Remote image hotlinking as a default
- Telemetry
- Git commit or push unless the user asks

## Done when

- [ ] No work-oriented source or UI remains
- [ ] Fixtures from all four sources use the same item and activity model
- [ ] Collection, tag, note, status, and search changes persist across a server restart
- [ ] Deterministic summaries cite their items
- [ ] `SummarySnapshotV1` and `SummaryGenerator` exist. No Pi package is installed as a required dependency
- [ ] JSON export and complete local deletion work
- [ ] Date language never invents a save time
- [ ] No model, API key, account, or internet connection is required to use the desk
- [ ] You have shown the running dashboard in the browser and used the main flows, not only a screenshot

## Verify

Start the server and dashboard. In the browser, as a user:

1. Open Recent and confirm fixtures from all four sources.
2. Open an item. Add a tag, a note, and a collection. Change status (inbox → accepted, then snooze or archive).
3. Search and find that item.
4. Open a day summary and a collection summary. Follow a citation back to an item.
5. Confirm an item without `source_saved_at` does not show a fake save date.
6. Export JSON. Delete the library. Confirm the desk is empty. Reload fixtures or restore only if needed for the demo.

If a flow fails, fix it and re-check. Say what you could not verify.

## When finished

Update `handoff/handoff-locus.md` current state:

- Phase 1 complete
- How to run the desk (commands)
- Next work: Phase 2 only

Leave a short note at the bottom of this prompt file or in the handoff: what was built, how to start it, what was deferred.

Stop. Do not start Phase 2. Show the user the dashboard.

---

Built 2026-08-23 as part of an all-three-phases session (user asked to continue). Desk: `npm run dev` → http://127.0.0.1:8787. Fixtures load on first start. Deferred from Phase 1 alone: runner, extension, live Connect.
