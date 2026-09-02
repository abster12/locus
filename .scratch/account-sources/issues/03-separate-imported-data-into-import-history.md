# 03: Separate imported data into Import history

**What to build:** Preserve imported Source identities as provenance without presenting them as active connections. People can inspect a concise Import history that identifies the provider, imported Item count, and import date, while the four live connection entries remain unaffected.

**Blocked by:** 01: Present one connection per Source

**Status:** resolved

- [x] Imported identities are summarized separately from live connection health.
- [x] Each history entry identifies its Source, date, and number of affected Items when that information is available.
- [x] Multiple imports for a Source do not create additional Source connection entries.
- [x] A partial or failed import is never presented as the latest live capture result.
- [x] Import history remains available after a live Source is disconnected.
- [x] Empty Import history is omitted or replaced by concise orientation rather than an empty card grid.
- [x] API and UI tests cover providers with imported-only, imported-plus-live, and repeated-import provenance.

## Answer

`GET /api/sources` returns `imports` from `account_kind = 'imported'` rows only. Each entry is `{ id, source, label, importedAt, itemCount }`. `itemCount` is distinct non-null `item_id`s that still exist in `items` — unlinked and tombstoned records are omitted, duplicate records for one Item count once. Connections stay four live rows; imported runs never fill `latestAttempt`, `lastSuccessfulCapture`, or `/health`. The Account page lists Import history when that array is non-empty and omits it when empty. Tests: `tests/sources-overview.test.ts`, `tests/sources-browser.test.ts`.
