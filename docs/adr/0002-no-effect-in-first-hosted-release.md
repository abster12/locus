# ADR 0002 — No Effect dependency in the first hosted release

Status: accepted
Date: 2026-09-01

## Context

Locus is moving from a persistent Node process with synchronous `node:sqlite` to Cloudflare Workers, D1, R2, and Queues. The same effort also introduces authenticated users, Library ownership, and strict tenant isolation.

Effect v4 is a relevant option because it supplies typed failures, dependency composition, schedules, tracing, schemas, and an official Cloudflare D1 adapter. As of this decision, however, npm publishes Effect 3.22.1 under `latest`; Effect v4 is at release candidate `4.0.0-rc.112`, and the stable `4.0.0` package is not published.

More importantly, the v4 D1 adapter explicitly does not support transactions or streaming. It exposes D1 atomic batches, but does not remove the core work Locus must do: replace arbitrary synchronous read/decide/write transactions with guarded SQL, idempotency, optimistic revisions, and fixed atomic command plans.

## Decision

The first hosted release will not add Effect as a foundational dependency.

- The Worker uses the native `fetch` interface and Cloudflare bindings.
- Each domain exposes a small, asynchronous module interface that owns its authorization, invariants, atomic command plan, and errors.
- Node SQLite and D1 are adapters at those domain seams where both local and hosted editions genuinely vary.
- Request validation uses a focused schema library or owned codecs selected during the Worker foundation spike.
- Queue retry and timeout policy uses Cloudflare delivery controls plus small owned functions.
- React and pure domain policy remain independent of runtime libraries.

This is not a decision against Effect generally. Reopen it after all of the following are true:

1. stable Effect v4 is published under npm's `latest` tag;
2. the first hosted domain slice has established the real D1, Queue, R2, and test seams;
3. there is a concrete cluster of repeated failure, retry, dependency, or observability logic that Effect can hide behind a smaller interface; and
4. an Effect implementation demonstrably improves that module's depth without exposing Effect requirements across unrelated callers.

Background enrichment is the most likely future evaluation target. The HTTP entrypoint and domain interfaces are not.

## Why

- Effect does not solve D1's transaction limitation.
- Effect v4's HTTP, SQL, workflow, and related modules are still documented under unstable import paths even as v4 approaches general availability.
- The codebase's immediate complexity is ownership and runtime migration. Combining that with a new programming model makes failures harder to localize and rollback.
- Locus already has substantial domain policy and tests. The valuable refactor is to deepen domain modules and place adapters at real local/hosted seams, not to expose a generic SQL or Effect interface to every query.
- A native Worker interface avoids coupling startup and request lifetime to a framework runtime while the Cloudflare execution model is being proven.

## Consequences

- The deployment tickets will not contain an Effect adoption or comparison spike.
- Typed application errors, cancellation, retries, and observability must still be designed explicitly.
- This decision keeps the hosted migration smaller but gives up some ready-made Effect infrastructure in the short term.
- A later Effect adoption must remain internal to a deep module; it must not require a broad rewrite merely for consistency.
