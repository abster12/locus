# 02: Step 7 — the rest of the App on the Worker

**What to build:** The step-7 slice from the spec: deterministic summaries, link preview, frame-check, and the public Trip share page, with the SSRF policy for Worker `fetch` applied before any arbitrary URL fetch. Turn the Summary tab on in the hosted App.

**Blocked by:** None

**Status:** resolved

Type: task

## Do

- SSRF policy first: hosted arbitrary-URL fetches (link preview, frame-check) go through the reading-fetch policy (`publicHttpUrl`: scheme allowlist, no credentials, `isPublicHostname`, manual redirects revalidated per hop, bounded bytes/time). Record it in an ADR.
- Link preview: `GET /api/link-preview?url=` on the Worker, Library-scoped cache in D1 (`0011_link_previews.sql`), same response shape as local (`{ preview }`). Pure parsing/frame logic moves to `core/link-preview.ts` so local and hosted share it.
- Frame-check: `GET /api/frame-check?url=` on the Worker (headers only, no persistence) so hosted Stage can mount frameable pages.
- Summaries: `GET /api/summaries/:scope/:ref` deterministic snapshot over D1 (same blocks as local), prose returns the local shape with `pi.available: false` and prose POST says hosted AI waits for an approved Worker secret. Summary tab turns on in the hosted App.
- Trip share: public `GET /s/:token` renders the share snapshot HTML from D1; renderer moves to `core/trip-share-html.ts` (one source of truth). Revoked/unknown tokens get the same empty 404.

## Do not

- Add a Worker AI secret or call one.
- Store emails, tokens, or OAuth state in logs.
- Add Cloudflare Browser Rendering / Containers / Queues.

## Comments

Claimed 2026-09-03 to implement the spec's next milestone.

### 2026-09-03 — resolved

Deployed to staging (`deploy:staging`, version `9af72a07`). Live checks: `health ok`; anonymous `401` on `/api/link-preview`, `/api/frame-check`, `/api/summaries/*`; `GET /s/<unknown>` → the same empty 404 page as local.

- SSRF policy: hosted link preview and frame-check fetch through `publicHttpUrl`/`fetchReadingPage` (scheme allowlist, no credentials, public hostnames, manual redirects revalidated per hop, bounded bytes/time). Recorded as **ADR 0005**. Tests pin javascript:/loopback/private-address targets → preview `error`, frame-check `unknown` without egress.
- Link preview: `GET /api/link-preview?url=` Library-scoped via `0011_link_previews.sql` (unique `(library_id, url)`, ok rows cached, error rows 24h TTL). Pure parsing + frame decisions moved to `core/link-preview.ts`; local server reuses it (root `tests/preview.test.ts` 10/10 green unchanged).
- Frame-check: `GET /api/frame-check?url=` headers-only; hosted Stage can now mount frameable pages and YouTube/Instagram embeds.
- Summaries: `GET /api/summaries/:scope/:ref` deterministic blocks over D1 (bounded: 500 scope rows, 200 cited, real inbox count with 40 ids); cross-tenant refs resolve to empty snapshots; prose POST → 400 with `pi.available: false` detail. Summary tab turned on in the hosted App (`App.tsx` gates removed; `SummaryPage` disables "Write summary" when `pi.available` is false — same behavior as local without Pi installed).
- Trip share: public `GET /s/:token` renders the snapshot with `core/trip-share-html.ts` (renderer + snapshot types moved out of `server/trips/share.ts`; hosted imports the same module). Revoked/unknown → identical 404, no payload.
- `hosted/tests/step7.test.ts` covers tenancy (day/item/selection/collection), prose unavailability, SSRF-negative preview/frame-check, and the public share lifecycle (preview → publish → public 200 → revoke → 404). Full hosted suite: 58/58. `check:staging` clean.
