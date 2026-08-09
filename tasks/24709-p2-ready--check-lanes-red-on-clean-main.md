Three `./dev.py check` lanes fail on a clean checkout of main in this
environment, unrelated to any one change. Verified by stashing all working-tree
changes and re-running each in isolation.

## 1. `allium specs`

    specs/browser-tool/browser-lifecycle.allium: 1 error(s)
      L414: Reference 'SseEvent/BrowserSessionState' uses unknown import alias 'SseEvent'.

The file references an alias it never declares in its header. Either add the
`use "./..." as SseEvent` import or drop the qualifier. Note `allium check` on
that file alone reports 0 *findings* — the lane reads diagnostics, so the two
disagree about what counts as failure; worth reconciling while fixing.

## 2. `cargo test` — two failures

- `phoenix-llm registry::tests::test_no_api_keys_no_models`
- `phoenix-tools bash::operations::tests::dropping_unregistered_spawn_kills_the_process_group`

The first looks environment-sensitive: the dev shell exports provider keys, so a
test asserting "no API keys" sees the ambient environment. If so the test needs
to clear the vars it is asserting the absence of rather than trusting the shell.

## 3. `dev.py unit tests`

    ERROR: test_supervisor_directly_owns_exact_fixture_and_stop_leaves_owner_alive
    bare_supervisor_test.SupervisorError: managed child exited with status 1

## Why this matters

A check that is red before you start trains everyone to skim the summary, which
is how a genuine regression gets waved through. Each lane should either pass or
declare its environmental precondition.
