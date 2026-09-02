# 04: Reuse duplicate URLs and make Intake batches retry-safe

**What to build:** Make every Intake write safe to repeat and safe when a submitted URL is already in the Library. Deterministically normalize URLs without network access, reuse exact normalized matches, add only missing requested organization, and preserve the existing Item's content and ownership history. Give batch writes atomic validation and a client mutation identity so browser and agent retries cannot duplicate work.

**Blocked by:** 03: Preview, classify, and organize a manual Item.

**Status:** done

- [x] Intake deterministically normalizes non-semantic URL representation differences such as protocol/host casing and default ports, without fetching, following redirects, or consulting external canonical metadata.
- [x] An exact normalized-URL match in the authenticated Library returns the existing Item as `reused`; no fuzzy title, author, body, or confidence-based merge occurs.
- [x] Reuse adds only requested missing tag and Collection memberships and reports memberships that were already present.
- [x] Reuse never overwrites the Item's title, body, author, dates, media, original provenance, existing membership actor/evidence, producer source records, or Capture history.
- [x] Each mutation carries a client mutation ID scoped to the authenticated Library and adapter authority. Replaying the same ID with the same normalized payload returns the original bounded result without applying work again.
- [x] Reusing a mutation ID with a changed normalized payload returns a stable invalid result and performs no writes.
- [x] A batch validates every Item, organization target, bound, actor rule, and context-dependent input before commit; any invalid member rolls back Items, memberships, activity, history, and reconciliation for the entire batch.
- [x] Private batch history records actor, time, mutation reference/digest, context version when present, originating instruction when present, and per-draft `created` or `reused` outcomes.
- [x] Producer Capture finish/removal reconciliation ignores Intake-created Items, and duplicate Intake against a producer-owned Item leaves producer source records unchanged.
- [x] Automated regression tests use a real database and cover normalization equivalents, exact reuse, non-merge of similar Items, missing-membership addition, no-overwrite guarantees, same-payload retry, changed-payload rejection, concurrent/repeated delivery where supported, complete rollback, audit history, and Capture isolation.
- [x] Relevant existing tests, typecheck, and production build remain green.

## Comments

`commitIntakeItem` reuses exact WHATWG-normalized URLs and only adds missing memberships. `commitIntakeBatch` requires a Library-scoped client mutation id, validates the whole batch before write, stores history/receipts in `intake_batches`, and replays or rejects changed payloads. Manual HTTP stays a one-item commit without a mutation id.

Follow-up: WHATWG URL identity; no fuzzy merge; mutation receipts like Kitchen/Trips. Evidence: `tests/intake-module.test.ts`. `npx tsc --noEmit` and `npm run build` green.
