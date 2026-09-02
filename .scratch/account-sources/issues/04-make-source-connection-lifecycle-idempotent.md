# 04: Make Source connection lifecycle idempotent

**What to build:** Make Source setup and teardown safe to repeat. Connecting, continuing setup, cancelling, completing pairing, capturing, and disconnecting should converge on one live connection per Source without losing captured Items or historical provenance. Existing stale pending records are merged or removed only after all referenced capture data is preserved.

**Blocked by:** 02: Create one coherent Capture setup

**Status:** resolved

- [x] Starting or continuing setup reuses the existing pending connection for that Source.
- [x] Completing setup resolves the pending connection or merges it into the canonical live connection instead of leaving a duplicate.
- [x] Repeating Connect, Continue setup, Cancel setup, or pairing completion does not create additional visible connections.
- [x] Cleanup selects a deterministic canonical live account and preserves Source collections, capture runs, Source records, and capture sessions.
- [x] Tokens attached to discarded pending accounts are revoked before those accounts are removed.
- [x] Disconnect revokes connection access while retaining captured Items and imported provenance.
- [x] Cleanup leaves any record with irreplaceable provenance intact and reports it for recovery instead of deleting it silently.
- [x] Migration and lifecycle tests cover stale pending rows, uniqueness collisions, repeated operations, disconnect, and rollback on failure.

## Answer

Connect/pair reuse one live or pending row per Source. Completing capture merges a pending row into the existing live account. Cancel setup drops an empty pending row; Disconnect marks the live account `disconnected` (tokens revoked, Items and imports kept). Schema v25 cleanup merges stale pending rows, keeps the newest record on uniqueness collisions, and reports incompatible live identities instead of deleting them. Pending accounts store no display name (`NULL`, not the provider label). Resolving a pending account replaces placeholder names (`X` / `Instagram` / `pending` / `unknown` / `extension`) with the discovered identity and keeps a meaningful name, including across merge into a canonical account. Tests: `tests/source-lifecycle.test.ts`.
