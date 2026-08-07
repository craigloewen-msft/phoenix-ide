The `dev.py unit tests` lane of `./dev.py check` fails on a clean tree:

    ERROR: test_supervisor_directly_owns_exact_fixture_and_stop_leaves_owner_alive
      (test_bare_supervisor.BareSupervisorLinuxIntegrationTests)
    ...
    File "scripts/bare_supervisor.py", line 181, in wait_for_identity
      raise SupervisorError(f"managed child exited with status {child.returncode}")
    bare_supervisor_test.SupervisorError: managed child exited with status 1

Reproduced with all working-tree changes stashed, so it is not caused by any in-flight
branch. The lane also runs unconditionally regardless of `--lanes` selection, so this
single error makes every `./dev.py check` invocation red, which trains people to ignore
the summary line.

Investigate why the supervised child exits 1 during the fixture: the run log shows
"activation helper failed" messages (`Expecting value: line 1 column 1`, `busy`,
`status write failed`) that may be related, plus unclosed-sqlite ResourceWarnings from
the same suite worth cleaning up while in there.
