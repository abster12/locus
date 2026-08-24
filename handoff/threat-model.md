# Locus threat model (V1)

## Assets

- The local SQLite library (saves, notes, tags, collections)
- Capture tokens (ingest-only)
- The capture-browser profile on disk (Chrome’s own cookies — Locus never reads them)

## Trust boundaries

- Loopback HTTP server is the only listener.
- Dashboard session cookie + CSRF token + Host/Origin checks.
- Capture producers authenticate with a revocable, source-bound bearer token.
- Site packs run in the capture page or extension isolated world. They have no database access.
- Imported post text is untrusted data. It is never a system or developer instruction.

## What we refuse

- Exporting cookies, passwords, or platform tokens
- Driving the user’s everyday Chrome profile
- Headless silent capture as the default
- Remote site-pack JavaScript
- Auto-loading remote media

## Failures we show

`logged-out`, `login-timeout`, `session-expired`, `challenge`, `wrong-page`, `site-changed`, `scan-stalled`, `tab-closed`, `server-unreachable`, `storage-full`, `interrupted`.

Partial coverage never implies deletion.
