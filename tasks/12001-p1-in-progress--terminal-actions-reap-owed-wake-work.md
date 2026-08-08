# Terminal lifecycle actions reap owed wake work instead of rejecting

## Symptom

Clicking "Merge to main" on an idle, finished conversation fails with
`409 Conversation has pending background work` (`error_type: pending_wake`).
Nothing the user can do in-product clears it; only a server restart does.

Observed on conversation `76973f73-e731-4963-8200-7089ec6f50ff`
("Can you add in some way for an"), state `{"type":"idle"}`.

## Diagnosis (confirmed against the live DB)

The conversation has seven wake bindings, all from `tmux` window
registrations, all on workflows in status `Cancelled`. Six have
`workflow_deliveries.status = 'Suppressed'`. One does not:

| workflow | contract | wf status | delivery status |
|---|---|---|---|
| 14, 23, 24, 27, 29, 31 | `tmux:…:@1…@5` | Cancelled | Suppressed |
| **35** | `tmux:toolu_019uSdc83QeUkMVPdC6QBn3H:@6` | Cancelled | **Pending** |

Workflow 35 was cancelled with `reason: ExplicitCancel` at `1786149793`.
The cancellation wrote the terminal receipt and moved the workflow to
`Cancelled`, but left delivery `(35, 1)` at `status = 'Pending'`. It is the
only pending/owed delivery in the entire database.

`WakeRepository::has_owed_work_for_conversation` returns true via its
`OR EXISTS (… d.status = 'Pending' OR d.runtime_acceptance_status = 'Owed')`
branch, and `admit_terminal_action` (plus the four other copies of the same
check) rejects the request.

Neither drain path can clear it while the server is up:

- `deliver_pending` (the wake worker) resolves pending deliveries, but
  `start_wake_worker()` is gated on
  `AGENT_FACING_WAKE_REGISTRATION = AgentFacingWakeRegistrationAvailable(false)`
  in `api.rs`, so it never runs.
- `retire_all_registrations` does exactly the right thing — selects every
  `Pending` delivery joined to a wake binding and calls
  `resolve_pending_exact(decision: Suppress)` — but only on server startup.
  That is what suppressed the other six.

So any tmux window cancelled during a live session strands a delivery that
bricks merge/archive/abandon/delete for that conversation until restart.

## The design error

The gate treats "owed wake work" as a reason to *refuse* a user's explicit
terminal action. But the user clicking "Merge to main" is saying "I am done,
shut down whatever is still attached." A wake obligation on a tmux window is
precisely the kind of resource a terminal action is supposed to tear down —
the same cascade already kills bash handles, tmux sessions, and worktrees.
Refusing on its behalf inverts the intent.

`specs/wake-contracts/requirements.md` REQ-WAKE-004 already permits this:
destructive lifecycle operations "SHALL reject **or serialize** the lifecycle
transition until those obligations are resolved." Today we only ever reject.
This task implements the serialize arm.

## Plan

### 1. Reap owed wake work as part of the terminal cascade

Add a `reap_owed_wake_work(state, conversation_id)` helper (alongside
`admit_terminal_action` in `api/lifecycle_handlers.rs`) that, under the
existing admission lock, suppresses every owed delivery and cancels every
unresolved binding for the conversation. It should reuse the existing
primitives rather than inventing a new resolution path:

- `cancel_allocated` for `Active` workflows with unresolved bindings
- `resolve_pending_exact(decision: Suppress)` for pending deliveries

This is the per-conversation form of what `retire_all_registrations` already
does globally at startup; factor the shared body so the two cannot drift.

Call it from the terminal paths that currently reject:

- `admit_terminal_action` (mark-merged, and the other callers it fronts)
- `abandon_task`
- `run_archive_cascade`
- `run_hard_delete_cascade`

Replace the `pending_wake` rejection in those paths with the reap. Log at
`info` with the workflow ids and contract ids reaped, so the teardown is
visible rather than silent.

### 2. Keep the rejection where it is still correct

`chains.rs` refuses to archive/delete a chain whose *member* has pending work.
That is a different situation — the user did not ask to terminate that member —
so leave it rejecting, but have it name the blocking member and contract.

### 3. Make the remaining rejections diagnosable

When a `pending_wake` conflict is still returned, include the blocking
contract ids in `ConflictErrorResponse` so the message says what is blocking
rather than that something is. Add the field alongside the existing
`conflict_slug` / `continuation_id` optionals.

### 4. Fix the status endpoint's blind spot

`GET /api/conversations/:id/wake` calls
`list_active_unresolved_for_conversation`, which reports only unresolved
bindings. In this exact scenario it returns `pending_count: 0` while the
lifecycle gate reports pending work — the endpoint cannot observe the
condition that blocks the user. Extend `WakeStatusResponse` to include owed
deliveries so the two agree. Regenerate TS via `./dev.py codegen`.

## Tests

- Regression reproducing the exact shape: cancelled workflow + `Pending`
  delivery + idle conversation → `mark-merged` succeeds and leaves no owed
  work. This fails before the change.
- Same for abandon, archive, hard-delete.
- Chain archive with a blocked member still rejects, and names the member.
- `GET …/wake` reports a nonzero count when only an owed delivery exists.

## Immediate workaround (unblocks the user now, independent of the fix)

`./dev.py restart` — startup retirement suppresses delivery `(35, 1)`, the
gate goes false, and the merge proceeds.

## Out of scope

Why `AGENT_FACING_WAKE_REGISTRATION` is `false` and whether the wake worker
should run. This task makes the system correct with the flag off; the flag's
fate is a separate decision.
