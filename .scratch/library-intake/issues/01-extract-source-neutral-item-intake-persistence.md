# 01: Extract source-neutral Item intake persistence

**What to build:** Introduce one Library Intake module seam that can persist an ordinary Item, its organization, activity, and downstream reconciliation without pretending the Item belongs to a producer Capture session. Move only the source-neutral behavior needed by Intake behind this seam and keep the existing Capture Protocol behavior unchanged. The result must give later manual, WebMCP, and direct MCP adapters one tested transaction boundary instead of three implementations of Item creation.

**Blocked by:** None (can start immediately).

**Status:** done

- [x] The module accepts trusted Library and actor context separately from untrusted Item input; callers cannot assert Library ownership or impersonate a user through payload fields.
- [x] A valid HTTP(S) URL can be persisted as an ordinary Inbox Item with stable, source-neutral Intake provenance and a private activity record.
- [x] Item persistence and required Reading and Atlas reconciliation succeed or fail as one unit; no successful call can leave an Item without its required downstream discovery state.
- [x] The seam does not create or modify producer source records, Capture sessions, Capture coverage, Reading Documents, Places, Recipe Documents, Tonight entries, Trip state, notes, status, or snoozing.
- [x] Existing Capture ingestion, idempotency, source ownership, finish/removal reconciliation, and downstream behavior remain externally unchanged.
- [x] The interface supports both newly created and reused Items without exposing persistence layout to adapters; later tickets can attach memberships and evidence through the same transaction boundary.
- [x] Automated regression tests use a real test database and cover the new Intake success path, rollback on reconciliation failure, actor/Library trust boundaries, and preservation of existing Capture behavior.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

Shipped `commitIntakeItem(db, { libraryId, actor }, input)` in `server/intake/module.ts`. Capture insert now goes through `persistNewItem`. Items without a producer source_record have `source: null` (not `x`, not user/agent). Evidence: `tests/intake-module.test.ts`; `npx tsc --noEmit`, `npm test` (521 pass), `npm run build` green.
