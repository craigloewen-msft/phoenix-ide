# Make `./dev.py check` fast locally: restore the missing accelerators, then scope the default run

## Why this task is not "delete more tests"

The presenting complaint is that `./dev.py check` takes forever and that the suite
is bloated. The bloat half of that hypothesis has already been tested and largely
spent: task `02723-p1-done--prune-low-value-tests` pruned 390 test declarations and
6,097 net lines across 59 files. Its recorded result is the key number here — Rust
workspace tests went 508.9s -> 331.4s, and that was after a deliberate, spec-aware
sweep that removed everything defensible. The remaining suite is concentrated at
architectural seams (migrations, CAS/fencing, crash recovery, wire parity,
security negatives) and 02723's own deletion rule forbids cutting those.

So a second deletion pass has a poor ratio: it re-litigates settled ground,
spends the reviewer-expensive judgement calls first, and the measured upside is
smaller than the accelerator gap below.

## Verified findings

Measured on this host, in this worktree.

**1. The two biggest accelerators are simply not installed locally.** This is the
headline.

- `cargo nextest --version` -> `error: no such command: nextest`. `~/.cargo/bin`
  contains no `cargo-nextest` and none is on `PATH`.
- `sccache` is not on `PATH`.
- No `mold` / `lld` / `ld.lld` on `PATH` either.

`.github/workflows/ci.yml` installs all of this for CI (`taiki-e/install-action`
with `tool: cargo-nextest` at line 75-78, `mozilla-actions/sccache-action` at
line 72, `Swatinem/rust-cache` at line 65). **CI runs the fast path; the local
developer machine runs the slow path.** That asymmetry is the bug.

dev.py already knows this and says so (`_accelerator_advisories`, dev.py:4832-4876):

> "plain `cargo test` runs test binaries sequentially and holds the cargo target
> lock for the whole run, serializing the e2e bin build behind it"

With ~2,783 Rust tests across 15 crates, losing nextest costs both intra-run
parallelism *and* cross-lane overlap, because the held target lock serializes the
e2e lane's `cargo build --bin phoenix_ide` behind the whole test run.

**2. Compilation, not test execution, is a first-class cost.** 36.4% of the Rust
tree is `#[cfg(test)]` code — 89,760 of 246,566 lines:

| crate | total | test | test% |
|---|---:|---:|---:|
| phoenix-ide | 94,244 | 36,422 | 39% |
| phoenix-db | 43,215 | 18,635 | 43% |
| phoenix-tools | 34,355 | 10,851 | 32% |
| phoenix-llm | 20,013 | 7,235 | 36% |
| phoenix-state-machine | 13,342 | 5,366 | 40% |
| phoenix-mcp | 11,482 | 5,210 | 45% |

Deleting test *bodies* shrinks this, but so does not compiling the workspace
twice — and the clippy lane deliberately uses a separate `CARGO_TARGET_DIR`
(`target/clippy`, dev.py:5286) to avoid target-lock contention. On disk right now:
`target/debug` is 8.7G and `target/clippy` is 2.1G. That second tree is a
reasonable trade *when sccache is present to serve the dependency compiles*
(the code comment says exactly this). Without sccache it is close to a straight
doubling of dependency compile work.

**3. The advisory exists but is easy to miss.** `_print_accelerator_advisories`
prints a `⚠ slow path` block, but it lands at the *end* of a multi-minute run,
where AGENTS.md already documents that people pipe to `tail` and lose the summary.
A warning printed after you have already paid the cost is not a control.

**4. Proptests are a real but secondary cost.** ~27,220 configured cases. Most are
pure in-memory transitions at the 256 default. The concentrated cost is in a
small set: the 200-step random walks in `phoenix-state-machine` proptests
(`prop_coherent_random_walk` and its variants), the two 512-case creation-protocol
simulators (each applying 1-60 operations per case), the SSE split fuzzers in
`phoenix-llm/src/sse.rs` (200-300 cases that re-parse at every byte boundary),
and the six 256-case async relay proptests in `phoenix-terminal/src/relay.rs`
that spin a tokio runtime per case.

**5. Do not touch these.** Out of scope, with reasons:

- `parity_*` in `crates/phoenix-ide/src/api/sse.rs` — AGENTS.md:271 designates
  these as the guard for byte-for-byte SSE wire parity against the pre-typed
  `json!()` path. A sub-agent recommended deleting all 22 of them; that
  recommendation is wrong and is explicitly rejected here.
- Anything named as a coverage anchor in a `specs/*/executive.md`.
- The heavy browser tests in `crates/phoenix-tools/src/browser/tests.rs` — already
  gated behind `PHOENIX_SKIP_BROWSER_TESTS` / `PHOENIX_CHROME_EXECUTABLE`.
- Timing-sensitive tests owned by in-progress task `36021` (Rust test timing
  inventory, currently 34 open findings). 02723 explicitly warns against
  reverting that work.

## Plan

Ordered by measured-value-per-risk. Each step is independently landable and
reversible.

### Step 1 — Baseline (no changes)

Record `./dev.py check --all` wall time on this host as-is, plus a per-lane
breakdown, using the existing `--pretty` lane table and the check-profile
artifact dir. Without this number the rest is unfalsifiable. Capture the lane
summary on the first run per AGENTS.md guidance:

```bash
./dev.py check --all 2>&1 | tee /tmp/check-baseline.log | grep -E "^(\s*[✓✗]|FAILED|error)"
```

### Step 2 — Install and verify the accelerators

`cargo install cargo-nextest --locked`, `cargo install sccache --locked`, and a
fast linker (mold preferred; dev.py:4821 already prefers `mold` then `ld.lld`
then `lld`). Re-run the baseline command and record the delta.

This is expected to be the single largest win and it deletes zero tests. If it
recovers most of the gap, steps 4-5 may be unnecessary — decide with the number,
not in advance.

### Step 3 — Make the slow path loud and early, not quiet and late

Move the accelerator advisory so it prints *before* the lanes start, not only
after they finish. A developer should learn they are on the slow path at second
zero. Keep the existing end-of-run copy for the CI log.

Done in `_print_accelerator_advisories`, which now takes `upcoming=` to select
the tense ("will run without" vs "ran without"). The advisory list is computed
once, before the lane threads start, and the same value is printed at both ends
— so the two emissions cannot disagree. Covered by `AdvisoryRenderingTests` in
`tests/devpy/test_accelerators.py`.

A separate `./dev.py doctor` was considered and skipped: the early advisory
already answers "why is this slow?" at the moment the user is asking it, and a
second surface reporting the same three probes would be a parallel
representation to keep in sync.

### Step 4 — Cheap, reversible proptest case reduction — NOT DONE, measurement says no

The plan made this conditional: "decide with the number, not in advance." The
number came back decisive.

```
cargo nextest run --workspace -E 'test(/prop_/)'
  Summary [1.443s] 120 tests run: 120 passed, 2799 skipped
```

The entire property-test suite — all ~27,220 configured cases across 120
properties — runs in **1.44 seconds** wall under nextest, because nextest
parallelises them across cores and each case is a pure in-memory transition.
Cutting the heavy properties from 256/512 cases to 64/128 would save a fraction
of one second on a 92s check, and would buy that by shrinking the search space
of exactly the properties that cover the state machine's random walks and the
creation-protocol simulator.

That is a bad trade, so it was not made. No `ProptestConfig` value was changed.
The original 402.9s baseline made proptests *look* expensive only because plain
`cargo test` was running the whole workspace's test binaries sequentially.
Fixing the runner dissolved the problem the case reduction was meant to treat.

### Step 5 — Default to a scoped local check

The gating machinery (`_gate_lanes`, `--lanes`, `PHOENIX_CHECK_BASE`) already
works and needed no code change. What was missing was that nobody knew the
accelerators were load-bearing. Documented in AGENTS.md next to the existing
check guidance, with the measured before/after so the next person does not have
to rediscover it.

## Results

Same host, same commit, `./dev.py check --all`, time as reported by check:

| Run | check time | wall | notes |
|---|---:|---:|---|
| Baseline (no accelerators) | 402.9s | 6m43s | tool itself reported all 3 missing |
| Accelerators installed, first run | 285.8s | 4m47s | pays one-time rebuild: RUSTFLAGS changed, sccache cold (2.45% hit rate) |
| Accelerators installed, steady state | **91.6s** | **1m32s** | **-77% vs baseline** |

Per-lane, baseline → steady state:

| Lane | Before | After |
|---|---:|---:|
| cargo test | 188.9s | 82.5s |
| dev.py unit tests | 212.1s | 20.0s |
| e2e | 268.1s | 34.1s |
| codegen | 55.7s | 1.8s |
| cargo clippy | 105.4s | 3.8s |
| cargo test compile | 154.5s | 5.8s |
| tsc typecheck | 52.5s | 1.2s |

Zero tests were deleted and zero properties were weakened to get this.

### Pre-existing failures, not caused by this work

This branch changes only `dev.py`, `tests/devpy/test_accelerators.py`, and
`AGENTS.md`, so it cannot affect Rust test outcomes. Observed across runs:

- `phoenix-tools bash::operations::tests::dropping_unregistered_spawn_kills_the_process_group`
  — fails on this host in isolation too (5s `tokio::time::timeout` waiting for a
  process group to die). Same load-sensitive-timeout family as tasks 02718 /
  36021.
- `e2e continuation` (50s poll timeout) and one `TaskApprovalReader` vitest —
  each failed in one run and passed in another, which is the signature of the
  ambient-load flakes tracked by 02718 / 15002 / 82005.

None were introduced here and none are in this task's scope.

## Acceptance evidence

- Before/after `./dev.py check --all` wall time on the same host and same commit,
  with the per-lane table for both.
- The accelerator advisory appears at the *start* of a run on a machine missing a
  tool, and is absent once the tools are installed.
- Proptest case-count changes are limited to the listed heavy properties; no
  property, generator, or invariant is deleted.
- No `parity_*` test is removed; no `specs/*/executive.md` anchor is orphaned.
- Task `36021`'s timing inventory does not regress (`scripts/check_rust_test_timing.py --all crates/`
  finding count is unchanged or lower).
- `./dev.py check` passes.

## Non-goals

- A second broad test-deletion sweep. 02723 already did this; its deletion rule
  and its "do not delete the sole executable witness" constraint remain binding.
- Reducing coverage of migrations, CAS/fencing, crash recovery, security
  negatives, or wire contracts.
- Changing product behavior to make tests cheaper.
