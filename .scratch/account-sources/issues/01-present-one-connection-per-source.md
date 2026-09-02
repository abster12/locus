# 01: Present one connection per Source

**What to build:** Make the Sources experience present one authoritative connection entry for each supported Source. A person should see X, Instagram, YouTube, and Reddit exactly once, regardless of how many live, pending, or imported provenance records exist underneath. The server owns the aggregation and connection-state precedence so every client receives the same answer.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [x] The overview returns exactly one connection presentation for each supported Source.
- [x] A resolved live account is selected ahead of a stale pending account for the same Source.
- [x] An active pending account is presented as setup in progress when no resolved live account exists.
- [x] Imported identities never become connection entries or determine live capture health.
- [x] The screenshot scenario renders four provider entries rather than seven, with the connected X and Instagram handles shown.
- [x] API and UI regression tests cover mixed live, pending, imported, and unconnected states.

## Answer

`GET /api/sources` returns `connections: SourceConnection[]` — one row per Source, no `accounts[]`. The server picks the resolved live account over pending via `pickConnectionAccount`. React renders `data.connections` as-is. Tests: `tests/sources-overview.test.ts`, `tests/sources-browser.test.ts`.
