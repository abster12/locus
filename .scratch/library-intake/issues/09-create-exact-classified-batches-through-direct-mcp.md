# 09: Create exact classified batches through direct MCP

**What to build:** Allow a properly authorized external agent to carry out an exact user instruction by creating or organizing a classified batch directly in the Library without an open page. Reuse the same Intake contract, validation, evidence, provenance, duplicate, idempotency, and reconciliation behavior proven through manual and WebMCP intake; do not let exploratory research become an unattended save path. Attach `create_items` to the existing `POST /mcp` adapter behind `library:write`; do not add a second transport or token type.

**Blocked by:** 04: Reuse duplicate URLs and make Intake batches retry-safe; 06: Create exact requested Items through Library WebMCP; 08: Authorize direct MCP Library Intake access.

**Status:** done

- [x] Direct `create_items` requires valid `library:write` authority and does not become available with read-only or producer Capture credentials.
- [x] The request carries an exact originating user instruction, current Intake Context version, client mutation ID, and at most 25 Items with no more than 12 existing tags and five existing Collections each.
- [x] Direct MCP v1 accepts only existing stable tag and Collection identifiers. It cannot create or propose-then-silently-create new tags or Collections.
- [x] Agent-observed source fields, missing-value behavior, untrusted-content handling, actor provenance, classification rationale, and bounded evidence obey the same contract as WebMCP; there is no weaker direct-agent validation path.
- [x] The complete batch is validated before writing and commits Items, organization, evidence, activity, history, and downstream reconciliation atomically; one invalid or stale entry saves nothing.
- [x] Duplicate and retry behavior matches Ticket 04, including created/reused results, no overwrite of existing or producer-owned data, same-payload replay, and changed-payload rejection.
- [x] Tool descriptions and authorization boundaries state that exact requested URLs may be committed, while exploratory discovery or recommendations require human review through the page workflow and cannot be auto-saved by this adapter.
- [x] Bounded stable results expose outcomes and actionable validation categories without returning credentials, private notes, unrelated Item bodies, internal persistence details, or capability material.
- [x] A successful direct write produces ordinary Library Items visible on the next/current Library view and follows existing Reading, Atlas, and Food projection behavior without creating downstream-owned documents directly.
- [x] Automated regression tests cover scope enforcement, exact multi-Item creation, existing-target enforcement, field provenance/evidence, stale context, atomic rollback, URL reuse/no-overwrite, idempotency, hostile/oversized input, stable redacted results, Capture isolation, and downstream observable behavior.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

`library:write` lists context, search, and `create_items`. Read tokens still cannot create. `POST /mcp` `create_items` calls `commitIntakeBatch` as actor `agent` with Library id from the capability. Same observed-fields / evidence / existing-id contract as WebMCP. Exploratory work is described as page-workflow only; this adapter has no `present_item_drafts`. Results strip notes and omit instruction. Stale context maps to `stale-context`; other `RejectedPayload` to `invalid`.

Evidence: `tests/intake-mcp.test.ts`. `npx tsc --noEmit`, `npm test` (562 pass), `npm run build` green.
