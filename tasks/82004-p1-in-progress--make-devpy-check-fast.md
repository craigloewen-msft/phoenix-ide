# Make `./dev.py check` fast (12 min → target ~3-4 min warm)

`./dev.py check` is the most frequently run command in this repo and currently
takes ~12 minutes. This task carries the investigation of *why*, and a staged
fix.

## Investigation: where the 12 minutes goes

`cmd_check` fans out 13 lanes onto threads (dev.py `_lane_targets`). Wall clock
is therefore the **critical path**, which is essentially always the Rust side:
`lane_rust` (cargo test compile → codegen → codegen-stale → cargo test),
`lane_clippy` (own `CARGO_TARGET_DIR=target/clippy`), and `lane_e2e`
(`cargo build --bin phoenix_ide` on the shared workspace target lock). The UI
lanes (tsc/eslint/vitest/ast-grep/allium/spec-*) are tens of seconds and hide
entirely inside the Rust shadow.

The lane architecture is already good. The cost is **not** the lane graph — it
is that on this machine every accelerator the design assumes is missing, and
dev.py degrades silently to its slowest documented path.

### Finding 1 — `cargo-nextest` is not installed (biggest single lever)

`which cargo-nextest` → not found. `cmd_check` probes for it and, on failure,
prints one `reporter.info` line and falls back to plain `cargo test`.
The fallback is worse in three compounding ways, two of which dev.py documents
in its own docstrings:

- **`lane_e2e` serializes behind the whole Rust test run.** `lane_e2e`'s
  docstring is explicit: nextest splits build from run and *releases the cargo
  target lock for the run phase*, letting the e2e `--bin phoenix_ide` build
  overlap. Under plain `cargo test` the run phase holds the lock end-to-end, so
  the e2e bin's full non-test codegen + link is appended to the tail of the
  critical path. This is a large serial block added to the longest lane.
- **Per-binary sequential test execution.** `cargo test` runs each test binary
  one after another (threads only apply *within* a binary). With ~3000 `#[test]`
  fns spread across 15 crates — and a very lopsided distribution (phoenix-ide
  1113, phoenix-tools 549, phoenix-drive-turn 2) — the tail of small binaries is
  dead time that nextest's process-per-test scheduler fills.
- **No per-test attribution**, so `--profile-work` can't tell us which tests are
  slow (`rust_per_test_attribution = "unavailable_without_nextest"`).

### Finding 2 — no compiler cache is active

`_configure_compiler_cache` auto-detects `sccache` then `kache`; neither is on
PATH, so it returns `"none"` **silently** (unlike the kache-daemon-failure path,
which warns). Consequences:

- `target/clippy` is a *second, independent* target dir. Its docstring assumes
  "dependency compiles in the fresh dir are served by sccache (CI)". With no
  cache, every clippy lane in a cold worktree pays a **full second dependency
  compile** of the entire tree.
- Each git worktree has its own `target/`. Observed: 19 GB per worktree; a new
  worktree's first check is a from-scratch build of the whole dep graph with
  zero sharing against the identical objects sitting in the sibling worktree.

### Finding 3 — default `cc`/`ld` linker on a debug workspace this size

`.cargo/config.toml` sets only ts-rs `[env]` vars — no `[target.*] linker` /
`rustflags`. `ld.lld` **is** already installed (`/usr/sbin/ld.lld`) but unused.
Debug linking of ~15 crates' worth of test harnesses plus the e2e bin is a
serial, single-threaded phase at the very end of the critical path, and it is
exactly what lld/mold cut by 2-5×. `Cargo.toml` already did the cheap half of
this work (`debug = "line-tables-only"` on dev+test, with a comment naming
linker time as the motivation) — the linker itself was never swapped.

### Finding 4 — memory pressure caps test parallelism to well under the CPUs

Host: 16 cores, 15 GiB RAM, 4 GiB swap (3.3 GiB already in use), WSL2. dev.py's
`test_threads = max(2, min(cpus - 1, mem_gib // 1.5))` yields **10 of 16**
cores. That heuristic is sound for avoiding swap-stalls, but it means we leave
~37% of the box idle during the longest step, *and* it does not constrain the
concurrently-running clippy/e2e cargo builds at all, so the peak is still
oversubscribed. On a 15 GiB WSL2 box with swap already 80% consumed, that
oversubscription is likely causing real swap stalls.

### Finding 5 — gating rarely fires on real branches

`_gate_lanes` skips lanes by changed-path category vs merge-base. Real branches
touch `crates/` and `ui/`, which activates RUST + UI = every expensive lane.
Crate-level scoping (`_pflags`) helps clippy/test scope but not the compile of
the reverse-dep closure, which for `phoenix-core` is the whole workspace. So the
incremental machinery, while correct, does not bound the common case.

### Non-finding (ruled out)

Duplicate-compile contention between lanes was already investigated and closed
in task 76001; lock-wait telemetry exists in `run_step` and peaks around 40 s on
a warm target. Real, but second-order compared to findings 1-3.

## Diagnosis, in one sentence

The check pipeline is architected for a machine with nextest + a compiler cache
+ CI's sccache-backed second target dir, and on this laptop none of those exist
— so it silently runs the slowest path it has, and nothing tells the user.

---

## Answers to the review questions

### `cargo-nextest` — what it is, disk cost, risks

A drop-in replacement test *runner* (not a compiler). Same `#[test]` fns, same
compilation; it changes only how the already-built test binaries are executed:
one process per test, work-stealing across all binaries, with real timeouts and
per-test timing.

- **Disk: negligible.** One ~10-15 MB static binary in `~/.cargo/bin`. It keeps
  **no cache** of its own and creates no new target directory. Installing via
  the prebuilt tarball (not `cargo install`) avoids even a build.
- **Risk: low, and reversible.** dev.py already supports both paths and probes
  at runtime; `rm ~/.cargo/bin/cargo-nextest` restores today's behaviour
  exactly. CI already assumes it.
- **One real caveat:** nextest does **not run doctests**. dev.py's `test_cmd`
  would silently stop covering them. This repo's doc-comment volume means that
  is probably a non-issue, but the task must *verify* it (count runnable
  doctests; if any exist, add a separate `cargo test --doc` step) rather than
  assume. This is the one place installing nextest could quietly lose coverage.

### Compiler cache — disk cost, and how to pay for it

This one **does** cost disk, and honestly so:

- `sccache`: dev.py sets `SCCACHE_CACHE_SIZE=20G`. That is a 20 GB ceiling (it
  evicts LRU, it does not preallocate); realistically it settles at a few GB for
  this workspace. Configurable — 8 GB is plenty here.
- `kache` (also supported): daemon-based, similar footprint.

**But the net is a large disk *win*, not a loss.** Right now each worktree holds
a 19 GB `target/` containing near-identical dependency objects, and the main
checkout has another 19 GB. A shared cache is what lets those stay small. Pair
the install with a `cargo-sweep` pass (already installed) over stale target
dirs; expect to free far more than the cache consumes.

- **Risk: low.** `RUSTC_WRAPPER` is respected by cargo natively; if the cache
  misbehaves you unset one env var. dev.py already has `--compiler-cache none`
  and a `PHOENIX_COMPILER_CACHE` escape hatch, plus `tests/devpy/
  test_compiler_cache.py` covering the selection logic.
- **Caveat to verify:** sccache does not cache crates with proc-macro/build.rs
  side effects as aggressively; ts-rs and sqlx are heavy here, so measure the
  real hit rate rather than assuming.

---

## Proposed fix, staged

### Stage 1 — stop degrading silently (no new commands)

1. In the **existing** `check` summary output (end of `cmd_check`, alongside the
   lane results), print a warning block when an accelerator is missing:
   `⚠ slow path: cargo-nextest not installed (adds ~Ns) — install: <cmd>`, and
   the same for the compiler cache and the linker. No `doctor` command, no new
   subcommand — just a warning where the user already looks.
2. The existing missing-nextest `reporter.info` becomes part of that block; the
   silent `"none"` return from `_configure_compiler_cache` gains one too.

### Stage 2 — install and wire the accelerators (the actual 12→~4 min)

3. Install `cargo-nextest` (prebuilt binary). Verify the doctest question above
   before relying on it.
4. Enable a compiler cache pointed at one shared cache dir so worktrees share
   compiled dependencies — which is what makes `target/clippy` cheap, as its
   docstring already assumes.
5. Add lld as the linker via a dev.py-generated `.cargo/config.local.toml`
   (gated on the linker actually being present), never a hard requirement that
   breaks a fresh clone.
6. `cargo-sweep` stale artifacts across worktrees.

### Stage 3 — bound the critical path

7. Start `lane_e2e`'s bin build first — it is a pure prerequisite with no
   dependents, so its link should never be the tail.
8. Revisit the `mem_gib // 1.5` cap so it accounts for the concurrent cargo
   builds instead of sizing test threads in isolation.

### Stage 4 — cut the test suite down (evidence-led, not vibes)

You're right that I shouldn't assume every test earns its place. Data collected:

- ~3000 Rust `#[test]`/`#[tokio::test]` fns; **2164** vitest cases; 18 dev.py
  unittest modules; plus a generated `export_bindings_*` test per `#[ts(export)]`
  type.
- **187** test fns whose names match pure-plumbing patterns (`*serializ*`,
  `*round_trip*`, `*_default*`, `*display*`, `*debug*`) — the classic
  "asserts serde works" cluster.
- **26** `parity_*` tests pinning byte-for-byte SSE wire output against the
  pre-typed `json!()` path — a *migration scaffold*. If that migration is
  complete, these are 26 tests defending a code path that no longer exists.
- **34** tests containing literal `sleep(...)`, plus 46 `timeout(Duration::
  from_secs(...))`. These are the ones that burn genuine wall clock. Task
  **36021** is already mid-flight on exactly this (58 findings → 34 remaining)
  and should be finished, not duplicated.
- Browser tests across 8 files driving real Chromium via CDP — the slowest and
  flakiest class.

**An honest caveat on the payoff, so we don't over-promise:** most of the 12
minutes is *compile and link*, not test execution. 3000 unit tests that each run
in microseconds cost seconds in aggregate. So deleting tests is worth doing for
**maintenance and clarity**, and it does trim compile time (less code to
compile), but the wall-clock win concentrates in a narrow set: the sleep-bearing
tests, the browser tests, and the e2e scenarios. Stages 2-3 are where the
minutes are.

Concretely, in priority order:

- **a.** Finish task 36021's remaining 34 timing findings — direct wall clock.
- **b.** Audit the 26 `parity_*` tests: if the `json!()` path is gone, delete the
  scaffold.
- **c.** Audit the 187 plumbing-named tests. Delete ones that assert `serde`
  works or that a `Default` impl returns its defaults. Keep ones pinning a
  **wire contract** (those are real). Expect a meaningful but not dramatic cut.
- **d.** Look for duplicate coverage across the seam: behaviour asserted in a
  unit test, again in an integration test, again in an e2e scenario. Keep the
  outermost one that would actually catch the regression.
- **e.** Gate the browser tests behind the existing `PHOENIX_SKIP_BROWSER_TESTS`
  mechanism for local checks, keeping them mandatory in CI.

Each deletion lands as its own reviewable commit with a one-line justification
— no bulk `rm`. Anything ambiguous stays and becomes a follow-up task.

### Stage 5 — verify

9. Use the existing `--profile-work` harness for before/after per-lane wall
   clock on the same tree, warm and cold; record numbers in `specs/`
   (executive), not in this task file.

## Sequencing recommendation

Stages 1+2 are "install the tools the design already assumes" — near-zero risk,
largest win, and they're what turn 12 minutes into ~4. Land and measure those
first. Stage 3 changes scheduling logic; Stage 4 is a slower, judgement-heavy
grind worth doing on its own merits. Don't block the speed win on the cleanup.

## Acceptance

- A warm `./dev.py check` on a branch touching both `crates/` and `ui/`
  completes materially faster, with before/after **measured** by
  `--profile-work`, not asserted.
- No accelerator can be absent without the `check` summary saying so and naming
  the fix.
- No coverage is lost by accident: the doctest question is answered explicitly,
  and every deleted test is deleted deliberately, one commit at a time.
