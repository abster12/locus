# End-to-end Trips fix execution prompt

Use the following prompt to assign the complete repair sequence to an implementation agent.

```text
Execute the remaining Trips repair plan end to end.

Authoritative inputs

- Read `.scratch/trips/spec.md` completely before changing code.
- Read `CONTEXT.md` and the applicable guidance under `docs/agents/` and `docs/adr/`.
- Read every ticket below completely before beginning its stage:
  1. `.scratch/trips/issues/13-mutation-idempotency.md`
  2. `.scratch/trips/issues/14-review-intent-security.md`
  3. `.scratch/trips/issues/15-contracts-and-time-parsing.md`
  4. `.scratch/trips/issues/16-client-feature-decomposition.md`
  5. `.scratch/trips/issues/17-responsive-ui-alignment.md`
  6. `.scratch/trips/issues/18-server-facade-and-test-suites.md`

Execution contract

Complete the tickets in numerical order. Treat each ticket as a hard stage gate: implement its full scope, run its focused tests, run typecheck and build, then run the complete test suite. Advance only when that stage is green. Fix regressions before moving forward.

Agent coordination

- Use Terra at high reasoning for security, transaction, architecture, and cross-module work: tickets 13, 14, 16, and 18.
- Use Luna at high reasoning for bounded contract, test, CSS, and visual-verification work: tickets 15 and 17.
- Do not use Sol directly.
- Keep one agent accountable for each ticket from implementation through verification.
- Parallelize only read-only investigation or tests with disjoint state. Execute dependent edits and shared-file refactors sequentially in ticket order.
- Before accepting a subagent result, inspect its diff and rerun the ticket's required verification from the coordinating agent.

At the start, inspect the worktree and preserve every unrelated modification. Work only on Trips implementation code, Trips tests, and the six issue files. Leave unrelated specs, prototypes, scratch files, and application features untouched.

For each ticket:

1. Reinspect the current code because earlier stages may have moved the referenced lines or files.
2. Translate every requirement and completion criterion into a checklist.
3. Add or update focused tests that fail for the reported defect before relying on the implementation.
4. Implement the smallest cohesive design that satisfies the ticket and the Trips spec.
5. Preserve transactional, authorization, accessibility, responsive, and WebMCP lifecycle behavior outside the ticket's intended change.
6. Run the focused test files independently.
7. Run `npm run typecheck`.
8. Run `npm run build` before browser tests so browser verification never uses stale `dist` assets.
9. Run `npm test` and resolve every regression caused by the work.
10. When every criterion is demonstrably satisfied, change that ticket's `Status:` to `resolved` and append a concise `## Comments` entry listing the implementation, tests, and verification commands. Leave it open if any criterion remains unmet.

Architecture constraints

- Decompose along responsibilities while touching the affected behavior. Do not perform a blind rewrite.
- Keep route components and HTTP handlers thin.
- Use narrow facades; a barrel that exports all internals does not qualify.
- Keep idempotency and review-intent authorization in the same transaction as their protected writes.
- Preserve server-derived identity and existing CSRF/session protections.
- Preserve the visible design during the decomposition stage; make visual changes only in the responsive UI stage.
- Give extracted stateful workflows and domain modules direct tests.

Verification contract

The overall task is complete only when all six ticket statuses are `resolved` and:

- Trip creation is replay-safe and cannot duplicate a Trip.
- Trip deletion remains replay-safe after the Trip is gone.
- Review intent is session-bound, Trip-bound, expiring, atomic, and single-use.
- Setup validation has one boundary contract.
- Projections and exports share strict whole-range time parsing.
- `TripsPage.tsx` is a thin composition layer with cohesive feature modules.
- The server Trips facade hides cohesive internal modules.
- Empty-day actions are not duplicated at any breakpoint.
- Desktop, tablet, and 320px layouts are aligned and have no horizontal overflow.
- WebMCP exposes three tools on the Trips index and the intended nine-tool surface in a Trip Document, with correct cleanup during navigation.
- Split browser test files pass independently and together without ordering dependencies.
- `npm run typecheck`, `npm run build`, and `npm test` all finish with zero failures.

Continue through all six stages without asking for routine implementation choices. Stop only for a genuine blocker requiring new authority, an unavailable external dependency, or an ambiguity that would materially change the Trips spec. When blocked, report the exact completed stage, failing command or invariant, evidence gathered, and the smallest decision needed to continue.

Final report

Return:

1. One section per ticket mapping requirements to changed files and tests.
2. The final client and server module boundaries and their public seams.
3. Visual verification results for desktop, tablet, and 320px mobile.
4. Exact focused and full verification commands with pass counts.
5. Any remaining limitation. State that the plan is complete only if every completion criterion and test is green.
```
