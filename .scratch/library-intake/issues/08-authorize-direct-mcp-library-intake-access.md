# 08: Authorize direct MCP Library Intake access

**What to build:** Let a user explicitly configure a chosen external agent for bounded Library Intake when no Locus page is open. Introduce Library-scoped, separately revocable read and write capabilities and expose only the direct MCP context and search operations at this stage. Direct MCP must remain distinct from producer Capture authorization and must not acquire general Library administration powers.

**Blocked by:** 03: Preview, classify, and organize a manual Item.

**Status:** done

**Transport:** `POST /mcp` JSON-RPC with a Bearer Library capability. Same path later on hosted. Not stdio, not session cookies, not Capture tokens.

**Management:** Account issues separately revocable `library:read` and `library:write` secrets, shown once, labelled with the agent name. Rows store `library_id` from day one.

**This ticket:** `get_library_intake_context` and `search_library` only. `create_items` is 09.

- [x] A user can create/configure, inspect, and revoke Library Intake access through an explicit private management flow; secret material is shown or handled according to existing secure credential conventions and is not recoverable through tool results.
- [x] `library:read` and `library:write` are distinguishable, Library-scoped capabilities. Revoking either takes effect without changing producer Capture tokens or unrelated access.
- [x] Direct `get_library_intake_context` requires only the minimum read authority and returns the same bounded vocabulary and context semantics as the page adapter.
- [x] Direct `search_library` requires read authority and returns bounded duplicate-check information without notes, unrelated bodies, credentials, raw queries, or full exports.
- [x] The adapter derives Library and actor identity from the authenticated capability; tool input cannot select another Library, claim to be the human, or broaden its scopes.
- [x] Capture tokens cannot call Library Intake tools, and Library Intake capabilities cannot start, batch, finish, cancel, or inspect producer Capture sessions.
- [x] No direct tool exposes tag/Collection creation, raw Item mutation, deletion, status/snooze/archive changes, arbitrary notes, Reading progress, Recipe/Tonight state, Atlas confirmation, Trips publishing, or general database access.
- [x] Revoked, malformed, wrong-scope, cross-Library, and unavailable capability requests return stable bounded errors without leaking whether private resources exist.
- [x] Capability secrets and transient authorization material are excluded from Library archives and logs; local-only explicit configuration works without hosted Locus.
- [x] Automated regression tests cover read/write separation, revocation, Capture-token isolation in both directions, actor and Library derivation, cross-Library denial, bounded result redaction, archive exclusion, and local-only operation.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

Account issues hashed `library:read` / `library:write` secrets (shown once). `POST /mcp` accepts Bearer Library capabilities only. Read tools call `getIntakeContext` / `searchLibrary`. Write tokens authenticate but list no tools until 09. Capture tokens stay on their own table.

Evidence: `tests/intake-mcp.test.ts`. `npx tsc --noEmit`, `npm test` (561 pass), `npm run build` green.
