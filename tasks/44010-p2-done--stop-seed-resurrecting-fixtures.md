# Stop `./dev.py up` resurrecting QA fixture conversations into the active list

## Symptom

Every `./dev.py up` re-adds fixture conversations (`Fixture Diff Review`, grounding-panel QA,
conversation-load perf fixture, heavy-prod-shape fixture) to the active conversation list, even
after the developer archived them.

## Root cause

`cmd_up` calls `cmd_seed(quiet_if_populated=True)` before starting Phoenix (dev.py ~2156).
`cmd_seed`'s documented idempotence — "if any active conversations exist the seeder skips" — is
not what the code does: the populated branch (dev.py ~3134) unconditionally runs four
`_ensure_*_fixture()` repair calls.

Each repair helper treats `archived != 0` as *staleness*: e.g. `_ensure_diff_review_fixture`
returns early only when `archived == 0 and message_count == 1 and scope_valid is not None`;
otherwise it deletes the conversation and re-inserts it unarchived. So archiving a fixture is
silently undone on the next `up`.

## Change

1. **Archived means archived.** In each `_ensure_*_fixture` helper, if the fixture conversation
   exists and is archived, return `False` without touching it. An archived fixture is a developer
   decision, not drift. (Structural, not a flag check bolted on: the existence query already reads
   `archived`; branch on it before the staleness comparison.)
2. **Repair becomes opt-in.** The populated-DB branch of `cmd_seed` should not repair by default.
   Add `./dev.py seed --repair-fixtures` for the QA/perf skills that genuinely need a known-good
   fixture, and have the populated branch simply report and return otherwise.
3. Update the `cmd_seed` docstring and the seed section comment so the stated contract matches the
   code (currently it claims populated DBs are "unchanged unless a required fixture is missing or
   stale" — omitting that archived counts as stale).

## Callers to update

- `.agents/skills/phoenix-perf-*` and any QA skill/doc that assumes `./dev.py up` guarantees the
  fixtures exist — point them at `./dev.py seed --repair-fixtures`.

## Tests

`tests/devpy/test_seed.py`:

- archived fixture stays archived across a `cmd_seed(quiet_if_populated=True)` run;
- populated DB with a deleted fixture is left alone by default, and repaired with
  `--repair-fixtures`;
- empty-DB first seed behaviour unchanged.

## Out of scope

Production never seeds (seeding lives only in `dev.py`); nothing changes there.
