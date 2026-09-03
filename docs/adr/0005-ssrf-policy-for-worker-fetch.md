# ADR 0005 — SSRF policy for Worker `fetch`

Status: accepted
Date: 2026-09-03

## Decision

Every Worker fetch of a user-supplied URL (Reading extract today; link preview and frame-check from step 7) passes one policy before any request leaves the Worker, and again on every redirect hop:

1. **Scheme allowlist** — `http:` and `https:` only.
2. **No credentials in the URL** — `user:pass@host` is rejected, not forwarded.
3. **Public hostnames only** — `isPublicHostname` (server/reading/policy.ts) blocks `localhost`, `*.localhost`, `*.local`, `*.internal`, and every literal loopback / private / link-local / CGNAT / multicast address form (v4 and v6).
4. **Manual redirects** — `fetch(redirect: "manual")`; each `Location` is revalidated by rule 1–3 before the next hop, with a hard hop cap.
5. **Bounded responses** — byte cap and a hard `AbortSignal.timeout` on every fetch.

The hosted implementation is `hosted/src/reading-fetch.ts` (`publicHttpUrl`, `fetchReadingPage`). Link preview reuses it with preview-sized bounds; frame-check revalidates the same way and reads only headers. The DNS-level check the local server does (resolve, then test the address) is **not** possible in Workers — Workers cannot resolve DNS — so the hosted check is hostname-level. Cloudflare egress cannot route to RFC1918/link-local targets, which closes the resolved-address gap for the platform's part; hostname checks close the URL-form part.

## Why

Step 7 turns the Worker into a fetcher of arbitrary URLs on behalf of signed-in users (Desk link previews, Stage frame checks). A Worker that fetches whatever a caller names is an SSRF foothold unless targets are constrained before the first request. The same constraints must apply to redirects, because a public URL that 302s to an internal one is the standard bypass.

## Consequences

- No new dependency and no second policy: Reading, preview, and frame-check share one module and one test suite.
- A hostile URL degrades to a normal failure (preview `error` row, frame-check `unknown`), never a Worker error page.
- DNS rebinding by an attacker-controlled authoritative server is out of scope at the hostname level, consistent with what the platform allows; if size or abuse evidence appears, a Cloudflare-level egress control is the next lever, not a second in-Worker policy.

Detail: `.scratch/hosted-deployment/spec.md` (step 7), `hosted/src/reading-fetch.ts`.
