# 06: Create exact requested Items through Library WebMCP

**What to build:** Add the page-scoped `create_items` tool for an agent carrying out an exact user instruction such as saving known URLs to named existing destinations and classifying them. The WebMCP adapter must call the same Library Intake module as manual intake, attach transparent agent provenance and evidence, and immediately update the visible Library with an honest created/reused result.

**Blocked by:** 04: Reuse duplicate URLs and make Intake batches retry-safe; 05: Present classified drafts through Library WebMCP.

**Status:** done

- [x] The tool accepts one atomic batch of at most 25 Items, with at most 12 existing tags and five existing Collections per Item, a bounded originating user instruction, the Intake Context version used, and a client mutation ID.
- [x] Source fields require the agent to identify them as observed at the submitted URL; missing fields remain missing, interpretations do not enter source text, and Locus does not claim it verified or fetched the page.
- [x] Every new agent-authored tag membership includes a concise rationale and valid bounded evidence tied to a submitted sanitized field/excerpt or the explicit user classification instruction.
- [x] The adapter derives Library, agent actor, and page authority from trusted page/session context; payload fields cannot impersonate the user or target another Library.
- [x] Only existing tag and Collection identifiers from the current context may be committed. Stale context, unknown targets, invalid evidence, unapproved new tags, unsafe content, or any invalid draft reject the whole batch.
- [x] Exact normalized duplicates reuse existing Items according to Ticket 04, preserve prior content/provenance/evidence, and add only missing organization.
- [x] Results identify each Item as created or reused and are bounded and stable; successful writes update the visible Library without reload.
- [x] The tool description clearly limits direct creation to exact user-requested work and directs exploratory recommendations to `present_item_drafts` first.
- [x] Tool lifecycle and public-page exclusions remain identical to the presentation tools; navigation or Library changes cannot leave a stale write capability registered.
- [x] Automated regression tests cover exact creation, agent field provenance, evidence validation, stale context, atomic rejection, duplicate reuse/no-overwrite, idempotent retry, actor derivation, cross-Library denial, visible refresh, lifecycle cleanup, and real-browser invocation against real Library data.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

`create_items` registers with the other Intake tools on Desk + `#/save`. It posts to `/api/intake/batch`, which calls `commitIntakeBatch` as actor `agent`. Agent drafts list `observedFields` matching submitted source fields, and each new tag needs `classifications` (rationale + excerpt in title/body/author/url/instruction). Stale context, new tags, and bad evidence reject the batch. Replay still uses Ticket 04 mutation ids.

Follow-up: receipts, not a confirm sheet; 07 owns subset/save. Evidence: `tests/intake-module.test.ts`, `tests/intake-http.test.ts`, `tests/intake-webmcp.test.ts`, `tests/intake-webmcp-browser.test.ts`. `npx tsc --noEmit` and `npm run build` green.
