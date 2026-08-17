# Repository hygiene maintenance sweep

## Observed journey

- The requested maintenance pass is broad but behavior-preserving: remove unused files and dependencies, simplify dead plumbing, retire misleading artifacts, and leave the repository easier to understand.
- The audit ran from clean worktree branch `task-pending-3cc8ccfc` and inspected all tracked top-level surfaces, Cargo/package manifests, Rust module reachability, UI imports and assets, check-lane ownership, scripts, skills, docs, fixtures, tasks, and relevant specs.
- Existing gates already cover Rust warnings/clippy, TypeScript unused locals/parameters, ESLint, Stylelint, formatting, tests, generated SSE files, specs, lockfile drift, and task filenames. This task targets verified gaps those gates do not catch.

## Verified findings

### Proven orphaned files and assets

- `static/{index.html,app.js,style.css}` is the pre-React frontend. The current server embeds and serves `ui/dist` in `api/assets.rs`; `create_router` has no `/static/*` route; the only non-task references are the files' references to each other.
- `ui/src/components/DiffViewer.tsx` is a wrapper around `DiffView` with zero importers. Its comment falsely claims `WorkActions` still uses it.
- `ui/src/components/CommandPalette/index.ts` is an unused re-export entrypoint with zero importers; the actual command-palette modules remain live.
- The nine committed grounding-panel PNGs under `docs/qa/artifacts/grounding-panel/final/` total 1.48 MiB. `docs/qa/grounding-panel.md` says current captures go to gitignored `ui/qa-artifacts/grounding-panel/` and the workflow no longer depends on committed binaries.
- `ui/ARCHITECTURE.md` is unreferenced and describes a cache hierarchy, retention policy, debug dashboard, and app machine that are not the current frontend architecture.

### Dead or redundant code and dependencies

- `crates/phoenix-ide/src/task_listing.rs` is compiled only because `lib.rs` declares it. All symbols are otherwise self-contained and test-only behind `#![allow(dead_code)]`; live API task listing calls `taskmd_core::tasks::list_tasks` directly.
- Direct Cargo edges have no source imports:
  - `axum-extra` in `phoenix-ide` (only direct inverse-tree edge);
  - `vte` in `phoenix-ide` (the live use belongs to `phoenix-terminal`, which already supplies the transitive edge);
  - `taskmd-core` in `phoenix-tools` (live uses belong to other crates, including its existing `phoenix-core` dependency).
  Workspace lints do not enable `unused_crate_dependencies`, so normal clippy misses these.
- `mdast-util-to-string` appears only in `ui/package.json` and the generated lockfile; no UI source/config/test imports it.
- `toolExecutingStartedAt` is written into the conversation atom, included in `ConversationPageView`, passed to `StateBar`, then explicitly ignored. No widget reads it. `phaseStateUpdatedAt` is the live server-authoritative timer. REQ-WPV-001 explicitly rejects a parallel client-arrival timestamp because it resets on reconnect and diverges across tabs.
- `git_start.rs` has a file-wide `dead_code` allowance. `GitStartPoint::for_create_request` and `for_default_task_start` have no production callers; their only callers are their own tests. `CheckoutRef` and its accessor likewise have no production reader. The default-origin refresh helpers are reachable only through the dead constructor. Other `git_start` paths (`for_inline_discovery`, `for_approval`, branch ownership checks) are live and must remain.
- Two comments are demonstrably false: the `phoenix-tls` manifest comment says its extraction keeps cost off itself, and the Explore sandbox test calls its fixture HOME the user's real home.

### Stranded test coverage

- `tests/test_phoenix_client.py` contains three focused tests for recoverable-continuation state parsing, but `./dev.py check` discovers Python unit tests only under `tests/devpy`; the file is never run.
- `phoenix-client.py` is classified only into the E2E lane. The stranded test imports the client's PEP 723 dependencies (`click`, `httpx`, `httpx-sse`), so a plain system-Python invocation fails before tests. It needs an explicit managed-dependency runner and lane ownership, not deletion.

### Skill and guidance drift

- `skills/` is documented as canonical and `.agents/skills/` as its discovery projection, but `phoenix-ladle-fixture` is documented/routed without a projection symlink, so it is not discoverable.
- `.agents/skills/phoenix-perf-shared` projects a resource-only directory with no `SKILL.md`; discovery ignores it and all consumers already reference the canonical `skills/phoenix-perf-shared/...` paths.
- `skills/phoenix-development/SKILL.md` routes to unavailable skills (`rust-dev`, `allium:tend`, `allium:weed`).
- `skills/phoenix-release/SKILL.md` first requires seven assets including both macOS targets and `SHA256SUMS`, then falsely says those assets are not produced. The release workflow confirms the seven-asset contract.

### Historical material in current-document locations

- Root `BLOAT_REPORT.md` is an unreferenced, dated measurement snapshot. It claims a two-member workspace and a `phoenix-monitor` binary; the current workspace has fifteen members and no such binary. The historical measurements may be useful, but the root location makes them look current.
- `docs/ux-audit-adaptive-layout.md` is explicitly tied to commit `38fc610c` but is outside `docs/research/` and describes the pre-sidebar UI as current state.

### Audit boundaries / false positives

- A skeptical reachability pass found all 213 Rust files reachable from Cargo roots and no additional surviving Rust/TS/test/spec/generated orphan candidates.
- Legacy persisted-data/wire fallbacks in `syncQueue`, `api.ts`, tool input rendering, image rendering, and viewer projections have explicit tests/fixtures and must remain.
- Keep generated TS, virtual-transcript fixtures, `patches/kache`, font assets and their license, `CLAUDE.md`, `SPEARS_AGENT.md`, convention-discovered tests, vendor-managed skills, and manual scripts whose out-of-repo users cannot be disproved.
- `ISSUE_TRIAGE.md` contains unresolved/unique observations as well as stale resolved entries. It must not be deleted in this cleanup without independently establishing durable ownership for every unresolved item.
- Existing ready/in-progress tasks already own legacy `design.md` migration, stale tool-result work, test-timing cleanup, and several behavioral refactors. This task must not absorb or duplicate them.

## Inferences and unknowns

- Removing the proven orphan files should have no runtime effect; a production-shape UI build and route smoke test will falsify that inference.
- Removing unused direct dependencies should leave the resolved capabilities supplied by their owning crates; clean Cargo checks and inverse-tree inspection after lockfile update will falsify that inference.
- The exact best home for the Phoenix client unit test is an implementation choice. The invariant is that the test runs with its declared dependencies whenever either the client or test changes, and the check planner has regression coverage for that ownership.
- Historical reports should be archived/reframed rather than rewritten as present truth. If preserving git history in place is preferable, a short current root pointer to a clearly historical research path is acceptable; leaving false current-state claims at root is not.

## Interaction map

- React source (`ui/index.html` / `src/main.tsx`) → Vite build → `ui/dist` → RustEmbed/filesystem fallback in `api/assets.rs` → SPA/static routes. The old `static/` tree is outside this chain.
- Conversation `StateChange.state_updated_at` → SSE boundary parse → `ConversationAtom.phaseStateUpdatedAt` → `ConversationPageView` → `StateBar` elapsed display. `toolExecutingStartedAt` is a parallel client timestamp with no consumer.
- `phoenix-client.py` PEP 723 dependencies → focused Python unit test → `./dev.py` lane runner → changed-path planner → CI lane selection.
- Canonical `skills/<name>/SKILL.md` → `.agents/skills/<name>` projection → `phoenix-skills` discovery. Resource-only shared directories are consumed by path, not invoked as skills.
- Cargo manifest direct edge → crate source import/capability. Transitive presence does not justify a redundant direct edge when the crate has no source use.

## Proposed scope

### 1. Remove verified orphans and stale binary artifacts

- Delete `static/`.
- Delete the unused `DiffViewer.tsx` wrapper and `CommandPalette/index.ts` barrel; leave their live replacement modules untouched.
- Remove committed grounding-panel PNGs and update the QA doc to state that review captures are generated locally/CI and are not committed.
- Delete the false, unowned `ui/ARCHITECTURE.md` rather than replacing it with another architecture document that can drift.

### 2. Simplify Rust and dependency ownership

- Remove `task_listing.rs` and its `lib.rs` module declaration.
- Remove the verified unused direct Cargo dependencies (`phoenix-ide`'s `axum-extra` and `vte`; `phoenix-tools`' `taskmd-core`) and refresh `Cargo.lock` only as produced by Cargo.
- In `git_start.rs`, compiler-led prune the production-unreachable constructors, their test-only assertions, the unused checkout-ref representation, and helpers made unreachable by that deletion. Remove or narrowly replace the file-wide `dead_code` allowance. Preserve and test live inline-discovery/approval/worktree branch behavior.
- Correct the two false comments with local factual wording.
- Do not remove the direct `libsqlite3-sys` feature edge in this pass; its bundled-SQLite build contract needs clean-machine verification beyond this cleanup.

### 3. Simplify UI state and package ownership

- Remove `mdast-util-to-string` and regenerate `pnpm-lock.yaml` with the pinned pnpm version.
- Remove `toolExecutingStartedAt` end to end from the atom shape/default/reducer writes, page-view selector, prop plumbing, and stale comments. Keep all elapsed displays sourced from `phaseStateUpdatedAt` or per-tool server timestamps as required by `specs/working-phase-visibility/`.
- Update focused reducer/selector/StateBar/performance-isolation tests only where needed to prove no observable behavior or render-isolation regression.

### 4. Make Phoenix client unit coverage real

- Put the focused client test under an explicitly owned check surface and run it through `uv`/PEP 723 dependency resolution (or an equivalent isolated managed environment), never ambient system Python.
- Ensure changes to both `phoenix-client.py` and its focused test activate that lane.
- Add check-planner regression coverage and retain the existing E2E API-boundary suite.

### 5. Repair skill discovery and contradictory guidance

- Add the missing `phoenix-ladle-fixture` discovery projection.
- Remove the misleading `phoenix-perf-shared` projection while retaining its canonical internal resources.
- Synchronize the Phoenix-maintained skill index with actually invokable skills and label internal shared resources as non-invokable.
- Replace unavailable routes in `phoenix-development` with skills actually present in this repository/environment.
- Remove the contradicted release follow-up and keep the workflow-backed seven-asset expectation.

### 6. Reframe historical documents without erasing evidence

- Move/relabel `BLOAT_REPORT.md` under `docs/research/` as a dated historical baseline with an explicit non-current warning.
- Move/relabel the commit-pinned adaptive-layout audit under `docs/research/` so it cannot be mistaken for current architecture.
- Do not delete or rewrite `ISSUE_TRIAGE.md` in this pass; record its ledger-retirement need as a follow-up only after unresolved observations are mapped to current tasks/code.

## Acceptance evidence

- Exact-reference searches show no remaining references to deleted modules/files/dependencies or removed `toolExecutingStartedAt` plumbing.
- `cargo tree` no longer has direct `phoenix_ide → axum-extra`, direct `phoenix_ide → vte`, or direct `phoenix-tools → taskmd-core` edges; owning transitive/live edges remain.
- Focused Rust tests for `git_start`, task/API listing, terminal behavior, and Explore sandbox pass; focused UI StateBar/conversation atom/performance-isolation tests pass.
- The Phoenix client unit tests demonstrably execute through the selected `./dev.py` check lane, and planner tests prove both source and test changes trigger it.
- `pnpm typecheck`, lint, Vitest, and a production UI build pass; `/`, `/assets/*`, `/phoenix.svg`, and `/service-worker.js` continue to use the `ui/dist` path.
- Skill discovery lists `phoenix-ladle-fixture`, does not list `phoenix-perf-shared`, and documentation names only invokable skills.
- `./dev.py check --all` runs with the lane summary captured on the first implementation run. A failure is classified as unrelated only when it names an exact failure already recorded by task 24709 or the exact failed test/lane passes in isolation while its owning code is untouched; no broader baseline waiver is allowed.
- Review `git diff --stat`, deleted-file list, manifests/lockfiles, and docs moves before committing; split code/dependency, test-wiring, and docs/skill cleanup into logical commits if the diff warrants it.

## Risks and explicit non-goals

- No product feature redesign, schema/wire change, CSS architecture rewrite, spec migration, compatibility-shim removal, broad dependency upgrade, or behavior change.
- No deletion based solely on the words “legacy,” “unused,” or zero grep hits when dynamic discovery, persisted data, generated outputs, licenses, fixtures, or external/manual workflows may own the file.
- Do not touch ready/in-progress task scopes such as legacy `design.md` migration, stale tool-result clearing, durable workflow consolidation, or Rust test-timing cleanup.
- Do not remove undocumented standalone scripts in this pass; their potential human users cannot be disproved from repository references alone.
- Full validation record: the all-lanes run passed 15/19 lanes. Complete Vitest (2,304 tests), E2E (including Phoenix-client unit coverage), and the exact MCP recovery test passed in isolation after their parallel-run failures. The exact `phoenix-llm registry::tests::test_no_api_keys_no_models` and bare-supervisor failures reproduced and match task 24709; their code is untouched. The changed dev.py/spec suites (`test_check_plan`, `test_skill_projections`, `test_spears_shape`) pass all 24 tests, and final allium/spec-anchor/task lanes pass. No other red result is waived.
