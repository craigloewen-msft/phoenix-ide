# Prune low-value tests across Phoenix

## Observed journey

Phoenix has accumulated a very large test surface whose maintenance cost and failure noise are no longer justified uniformly. The repository contains approximately:

- 3,049 Rust `#[test]` / `#[tokio::test]` cases across 160 test-bearing files;
- 2,200 Vitest `it` / `test` cases across 147 UI test files;
- 321 Python test functions across 22 test-bearing files.

The desired outcome is not a mechanically smaller count. It is a durable suite that concentrates on core behavior, long-lived boundaries, meaningful regression classes, and overarching scenarios while removing tests that merely restate implementation details or enumerate equivalent fixtures.

## Verified findings

- The strongest unique coverage is concentrated at architectural seams: state transitions and multi-step scenarios, persistence/migration/recovery/CAS invariants, provider and wire translation, process/security boundaries, SSE replay/parity, user journeys, keyboard/accessibility routing, and deployment ownership/rollback.
- The most common low-value patterns are repeated fixture permutations, trivial getter/constructor/serde round trips, private-helper exports created only for tests, exact prose/string snapshots, subprocess argv/mock choreography, and component/browser tests that re-prove canonical reducer policy.
- Property tests already subsume some hand-written state-machine and parser examples, while some broad properties add little beyond specific deterministic transition tests. Redundancy must be assessed by the stronger witness rather than favoring one test style categorically.
- Executive docs contain explicit test anchors, including SSE `parity_*`, virtual transcript reducer tests, iterative-review keyboard suites, `MessageComponents.test.tsx`, `WorkActions.test.tsx`, and other named coverage. Deleted or renamed anchors must be reconciled so status documentation remains truthful.
- Active test-maintenance tasks overlap this work, notably Rust timing inventory task 36021 and UI/load-sensitive or flaky-test tasks 02718, 15002, 36015, 50005–50008, and 82005. Slowness or flakiness alone is not evidence that a behavioral test is valueless.

## Deletion rule

Delete or consolidate a test only when its assertion has no unique durable value after the change. Each removed group must be justified by at least one of:

1. an equal-or-stronger test covers the same contract at the same or a more meaningful boundary;
2. a property or table-driven scenario subsumes equivalent examples without losing distinct outcomes;
3. the type/schema/state-machine structure makes the asserted invalid state unrepresentable;
4. the assertion concerns a private helper, incidental call order, formatting detail, exact copy, CSS class, or fixture permutation rather than observable behavior;
5. a broader user or lifecycle scenario proves the behavior and the lower-layer test adds no independent failure signal.

Do not delete the sole executable witness for a normative requirement, Allium transition/invariant, negative/security case, migration/legacy row shape, race/recovery outcome, wire contract, or known meaningful bug class. Do not retain a test merely because an executive doc names it; either preserve the necessary coverage or update the executive truthfully.

## Initial high-confidence prune map

This is a starting set, not a quota. Apply the deletion rule across every test-bearing area and remove further cases when the same evidence holds.

### Rust

- `phoenix-state-machine`: remove example transitions already subsumed by properties (`test_idle_to_llm_requesting`, `test_reject_message_while_busy`, `test_error_recovery`); preserve multi-turn/tool/retry/cancellation/fork scenarios and exact effect sequences.
- `phoenix-core`: remove or fold redundant `ConvMode` serde smokes and trivial platform/runtime-env/accessor matrices; preserve strict/malformed/legacy persisted-shape tests and raw SQL shape contracts.
- `phoenix-db`: cut per-table CRUD round trips for settings, OAuth rows, auth sessions, work-scope baselines, and basic conversation/message getters where normalized-schema, migration, or stronger lifecycle tests already prove the contract. Preserve migrations, claims/fencing, atomic continuation, monotonic watermarks, child-table normalization, restart repair, and crash recovery.
- `phoenix-workflow`: remove helper-shape and clone smokes; fold equivalent invalid/stale permutations; preserve CAS, DAG/barrier, lease/authority, idempotency, cancellation, manual resolution, scheduling, migration, and invariant properties.
- `phoenix-ide`: collapse or delete fixture explosions in `runtime/executor.rs`, `message_expander.rs`, `git_ops.rs`, `api/git_handlers.rs`, `runtime.rs`, and recovery helpers. Prioritize branch-collision permutations, tokenizer/skill position permutations, UTF-8/capped-output helpers, git-status plumbing matrices, and replay helper examples. Preserve containment/symlink negatives, approval/recovery scenarios, PR freshness/coverage rules, SSE parity and replay failure modes, content-moved checks, and display-safe errors.
- `phoenix-llm`: sharply reduce exact plan-copy matrices, request-tag parser examples, duplicate request-shape snapshots, and hand-written SSE parser microcases covered by properties or streaming scenarios. Preserve provider wire translation, streaming assembly, error taxonomy, retry/capability, quota, registry/discovery, and telemetry contracts.
- `phoenix-mcp`: reduce SSE framer mechanics, callback/query helper tests, and fragmented config classification permutations. Preserve HTTP session/recovery, OAuth/PKCE/security, JSON-RPC behavior, supervisor fencing, concurrency, and authorization boundaries.
- `phoenix-tools`, `phoenix-browser`, and `phoenix-terminal`: remove duplicate browser-profile schema registration checks, literal dimension/getter smokes, repeated environment-field assertions, and equivalent actor-key permutations. Preserve bash/security walls, process/PTY lifecycle, sandboxing, protocol, isolation, and end-to-end tool behavior.

### UI

- Delete thin/private-helper suites such as `storage/lastViewerStorage.test.ts` and `ui/scripts/capture-ladle-surface.test.mjs`; remove production `__testables` exports made solely for those tests.
- Absorb and then delete redundant helper suites where only a small durable subset remains: `ToolOutputRenderers.test.tsx` into its message-rendering owner, `pierreFileMapping.test.ts` into diff mapping, `viewerFileTypes.test.ts` into `MetaViewer`, and `useDiffExpansion.test.ts` into viewer behavior tests.
- Remove mirror direction/case tests in recent files, pane resizing, File Explorer task/skill state, context-menu event payloads, and PR-status cache permutations when one representative plus the distinct failure/race outcomes remain.
- Reduce browser-level notification tests that duplicate `notifications/policy.test.ts`; keep canonical policy, one click/ack journey, and one fail-closed path.
- Reduce trivial/idempotent atom actions, equality-field permutations, generated-slug variants, and broad overlapping connection-machine properties.
- Preserve conversation atom/store authority, SSE schema validation, message reconciliation and streaming isolation, archived-page journeys, active PR targeting/freshness/coverage, viewer ownership, keyboard/accessibility routing, stale-result fencing, and File Explorer URL/scope/race behavior.
- Do not preserve component tests whose only assertion is exact text presentation, CSS/class placement, or mock invocation when no accessibility, contract, or regression behavior depends on it.

### Python and scripts

- Delete the Ladle screenshot filename/viewport private-helper tests rather than maintaining test-only exports.
- Heavily reduce `test_dev_tracing.py` mock plumbing and exact `execvpe`/message assertions to bootstrap, fallback, cleanup/idempotence, and return-code behavior.
- Remove deploy-test assertions of exact argv ordering, call counts, guidance copy, and private helper sequencing when backend selection, ownership, verification, rollback, durable status, and handoff are covered at a meaningful boundary.
- Parameterize or trim repeated identity, validation, compiler-cache selection, and profile-normalization matrices.
- Preserve e2e turn barriers, readiness and CPU attribution; real launchd/systemd/bare process lifecycle scenarios; check/profile data contracts; repository projection/shape checks; and Phoenix client continuation behavior.

## Implementation sequence

1. Record a reproducible baseline by runner, test count, relevant wall time, and slow/flaky inventory. Do not use line coverage percentage as a retention proxy.
2. Audit all test-bearing files using the deletion rule. Maintain a temporary keep/delete/consolidate ledger grouped by durable contract, not one entry per trivial case.
3. Land small logical commits by subsystem. Prefer outright deletion over table-driving assertions that remain valueless; table-drive only when distinct durable outcomes still need proof.
4. Remove test-only helpers, fixtures, mocks, exports, and dependencies made unreachable by the deleted tests. Do not leave dead scaffolding.
5. Reconcile affected `specs/*/executive.md` coverage anchors and overlapping ready/in-progress test tasks. Requirements and Allium behavior must not be weakened to justify deletion.
6. Run targeted suites after each tranche, then the full repository check once at the end. Capture the final count and timing using the same baseline method.

## Acceptance evidence

- Every removed test group has a reviewable rationale: stronger witness, structural guarantee, non-contract detail, or duplicated layer coverage.
- No normative requirement or Allium rule loses its only executable witness without an equal-or-stronger replacement.
- Security negatives, migration/legacy compatibility, crash/restart recovery, concurrency/fencing, wire parity, process ownership, and meaningful user journeys remain covered.
- Test-only production APIs and now-unused fixtures/mocks/dependencies are removed.
- Executive coverage tables and named test anchors match the resulting suite.
- Overlapping open test/flakiness tasks are updated or closed when their target is removed or consolidated; active deterministic timing work is not accidentally reverted.
- The final report records before/after test counts by Rust/UI/Python and wall-time measurements, and explains any major suite intentionally left intact.
- `./dev.py check` passes, with targeted reruns for affected process/browser suites where full-check parallelism is behaviorally relevant.

## Completion results

- Removed 390 counted source-test declarations and 6,097 net lines across 59 files while retaining the durable suites named above.
- Count changes: Rust 3,049 → 2,783 (-266, -8.7%); UI 2,200 → 2,086 (-114, -5.2%); Python 321 → 311 (-10, -3.1%).
- The same-command wall-time comparison was: Rust workspace tests 508.927s → 331.430s (-177.497s, -34.9%); Vitest 31.411s → 35.772s (+4.361s, +13.9%); dev.py Python tests 230.528s → 46.470s (-184.058s, -79.8%); Phoenix client tests 0.689s → 0.297s (-0.392s, -56.9%). Single-run figures are environment-sensitive, especially the parallel UI/Python runs.
- Both Rust timing runs stopped at the same ambient-environment failure in `registry::tests::test_no_api_keys_no_models`, tracked by task 82005. The full runtime crate separately ran 1,077 passing tests plus one unrelated filesystem race that passed on exact rerun.
- Both Vitest timing runs retained the same baseline `localStorage` environment failure family. Modified non-storage suites passed targeted runs; TypeScript and ESLint pass after pruning.
- The final all-lane check reached all 19 lanes through ignored local Corepack/pnpm shims. Task validation, spec shape/anchors, formatting, lint, typecheck, codegen, package-lock, client, compile, and Python lanes passed. Remaining red lanes were the baseline Vitest storage failures, ambient model configuration affecting Rust and E2E, and target-specific conversion warnings in unchanged `conversation_files.rs` under this host toolchain.

## Risks and non-goals

- This is not an exercise in maximizing deletion count or optimizing for code coverage percentage.
- Do not change product behavior merely to make remaining tests pass.
- Do not delete timing tests solely because they are slow or flaky; retain or replace them according to whether elapsed time is a contract and whether a deterministic witness exists.
- Do not collapse distinct closed outcomes into a happy-path-only test.
- Avoid a single kitchen-sink commit: the breadth is intentional, but each subsystem tranche must remain independently reviewable and reversible.
