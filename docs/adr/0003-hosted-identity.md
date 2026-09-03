# ADR 0003 — Hosted identity with Better Auth and request identity

Status: accepted
Date: 2026-09-02

## Decision

Hosted Locus authenticates with **Better Auth 1.7.2** (pinned) on a Cloudflare Worker + D1. Google OAuth is identity-only. Each user gets one private Library and one owner membership. Private handlers receive `RequestIdentity` from `hosted/src/identity.ts`; they do not import Better Auth or parse cookies.

- Session cookies: host-only `HttpOnly`, `SameSite=Lax`, `Secure` on HTTPS. Better Auth owns the cookie.
- Mutations: exact `Origin === BETTER_AUTH_URL` and `x-csrf-token` HMAC'd with dedicated `CSRF_SECRET` over `sessionId`.
- Registration: Worker `REGISTRATION_MODE` `open` | `closed`. Browser cannot override it. Judging stays open through 2026-09-21 17:00 PDT unless a safety close has another judge path.
- Access: `user_access.status` `active` | `disabled`. Disabled is `403` even with a valid session cookie.
- Client runtime is an explicit `local` | `hosted` build. Hosted never falls back to `LOCAL_LIBRARY_ID`.

Detail: `.scratch/hosted-identity/spec.md`. Effect remains excluded by ADR 0002. Later domains follow ADR 0004 and `.scratch/hosted-deployment/spec.md`.

## Deviations from the 2026-09-01 spike

- Spike dashboard discarded; hosted UI is the Vite Account shell served as Worker static assets.
- No `/api/account`. Account reads `/api/session`.
- Added CSRF secret, registration switch, per-user disable, rate limits, security headers, and redacted structured logs.
- Database hooks null Google access, refresh, and ID tokens before persist.

## Why

The spike proved Google callback, D1 persistence, one Library per user, distinct Libraries across users, and cross-user `404`. Production keeps that shape and puts authorization behind one request-identity module so later domains do not re-parse sessions.
