# Work Lifecycle: Terminal Actions on Work and Branch Conversations

## User Story

As a developer using PhoenixIDE, I need clear, safe terminal actions on my Work and Branch
conversations so that I can close out completed or abandoned work without accidentally
destroying git state I care about, and without being blocked by Phoenix when I already know
the outcome of my PR.

## Scope

This spec governs the **action semantics and git side effects** of:

- **Abandon** — discarding a Work or Branch conversation.
- **Mark as merged** — signalling that a Work or Branch conversation's work has shipped.
- **Merge to the local base branch** — landing a Work or Branch conversation's commits on the
  user's local base branch and then cleaning up.
- **PR merge state** as the advisory gate that guides (but never triggers) the cleanup path.

It does **not** own:

- **Transition legality** — when a terminal action is permitted based on conversation state
  (`core_status ∈ {idle, error, recoverable_continuation_failure}`, `parent_status ∈ {absent, context_exhausted}`,
  `mode ∈ {work, branch}`, no continuation pointer). That is bedrock's `TaskResolved` rule
  and `TerminalActionRequiresNoContinuation` invariant (REQ-BED-029, REQ-BED-031). The
  handlers in this spec validate against that gate; they do not define it.
- **PR feedback freshness, explicit active-PR targeting, auto-fix, and remediation context** —
  the `pr-association` spec.
- **UI surface composition** — button labels, action zones, disposition derivation, tooltips.
  The `work-actions-bar` spec owns these.

Each terminal action's branch disposition depends only on conversation mode, identically
across both actions:

| Mode | Worktree | Branch | Reason |
|------|----------|--------|--------|
| Managed (Work) | Deleted | Deleted | Phoenix created the task branch (`task-{ID}-{slug}`); it is Phoenix's artifact to clean up. |
| Branch | Deleted | Kept | The branch is the user's pre-existing PR branch; it is not Phoenix's to delete. |

---

## Requirements

### REQ-WL-001: Abandon a Conversation

WHEN the user initiates the Abandon action on a Work or Branch conversation
THE SYSTEM SHALL present a confirmation dialog warning that the worktree will be deleted and
  uncommitted work lost (subject to the diff snapshot)

WHEN the user confirms abandonment
THE SYSTEM SHALL capture a best-effort diff snapshot of the worktree *before* deleting it,
  bounded per diff section with a truncation indicator, and persist it to conversation
  history so the discarded work is recoverable from the record after the worktree is gone
AND delete the worktree
AND apply the mode-dependent branch disposition (Managed: delete the task branch; Branch:
  keep the branch)
AND resolve the conversation via bedrock's `TaskResolved` with outcome `abandoned`
AND emit a synthetic system message describing the outcome

WHEN the user cancels the confirmation dialog
THE SYSTEM SHALL take no action
AND the conversation SHALL remain in its current state

**Design:** The diff snapshot preserves context even when the work is discarded — it is the
recovery artifact, persisted with the conversation record so it is reviewable without git
infrastructure. The branch disposition follows mode: Phoenix-created task branches are
Phoenix's to clean up; user-owned PR branches survive abandon precisely because Phoenix did
not create them. Worktree deletion is irreversible, so abandon (and only abandon) requires an
explicit confirmation step before any git operation runs.

**Legality gate:** bedrock's `TaskResolved` rule (REQ-BED-029, REQ-BED-031) governs when
Abandon may be initiated. This requirement governs what happens after the user confirms.

---

### REQ-WL-002: Mark as Merged

WHEN the user initiates "Mark as merged" on a Work or Branch conversation
THE SYSTEM SHALL delete the worktree
AND apply the mode-dependent branch disposition (Managed: delete the task branch; Branch:
  keep the branch)
AND resolve the conversation via bedrock's `TaskResolved` with outcome `merged`
AND emit a synthetic system message describing the outcome

THE SYSTEM SHALL NOT merge the branch anywhere as part of this action
THE SYSTEM SHALL NOT push to origin (push is the agent's responsibility, run through the bash
  tool when the user requests it)
THE SYSTEM SHALL NOT perform any git operation before the user initiates the action

THE SYSTEM SHALL commit the task file on the task branch (never on main/base); that commit
  reaches main only when the PR is merged through the user's normal workflow

**Design:** "Mark as merged" is a user assertion that the work has shipped via the user's
normal PR workflow — the actual merge happened outside Phoenix. Phoenix performs worktree
cleanup only. Merging is the separate, explicitly-chosen action in REQ-WL-004; conflating the
two would let a cleanup click silently move a branch ref. The task branch is deleted for
Managed mode (Phoenix created it) and kept for Branch mode (the user owns it).

**Legality gate:** bedrock's `TaskResolved` rule (REQ-BED-029, REQ-BED-031) governs when Mark
as Merged may be initiated.

---

### REQ-WL-003: PR Merge State Is the Cleanup Gate

WHEN a Work or Branch conversation has an associated pull request
AND `gh` can observe the pull request's state for the branch
THE SYSTEM SHALL use the observed PR state to guide the cleanup action:
WHEN a Work or Branch conversation has multiple associated pull requests
THE SYSTEM SHALL summarize their mixed states honestly to the user-facing cleanup surface
AND SHALL preserve cleanup as one task/worktree action rather than one lifecycle per PR

WHEN one explicit active PR is selected by `pr-association`
THE SYSTEM SHALL allow sibling cleanup surfaces to name that PR specifically where PR-specific
  wording is needed
AND SHALL NOT treat that selected PR as the sole owner of task cleanup when other associated PR
  history exists

- a `gh`-confirmed merged PR is presented as the happy path for cleanup
- an open, draft, failing, pending, or closed-unmerged PR annotates or discourages cleanup
  with explanatory text while leaving terminal disposition user-initiated

WHEN `gh` is unavailable or the conversation has no associated PR
THE SYSTEM SHALL permit the user to initiate merged-work cleanup without `gh` confirmation

THE SYSTEM SHALL NOT use PR merge state as an automatic trigger for the terminal transition —
  cleanup occurs only when the user initiates the action
THE SYSTEM SHALL NOT display local commits-ahead or commits-behind badges as the branch
  health signal; PR state is the branch health signal
THE SYSTEM SHALL NOT mutate, close, merge, or retarget any associated PR as part of cleanup
AND SHALL NOT make PR feedback freshness a cleanup gate

**Design:** PR state makes the happy-path cleanup self-describing while preserving user-initiated
cleanup for repositories where `gh` is not authenticated or configured. The advisory character
 of PR state is essential:
Phoenix observes no push event and cannot continuously poll every branch, so it must not
auto-terminate a conversation based on inferred remote state. "The PR is merged" is a
condition the user is always better positioned to assert than Phoenix is to detect — the user
knows when they clicked Merge. The data source is `GET /api/conversations/:id/pr-status`;
`gh` failures are logged at `debug` and surfaced as compact, non-blocking UI hints so the
conversation page stays usable without `gh`.

---

### REQ-WL-004: Merge to the Local Base Branch

WHEN the user initiates "Merge to the base branch" on a Work or Branch conversation
THE SYSTEM SHALL evaluate every precondition before performing any git write:

- the repository root checkout SHALL have the target branch checked out
- the repository root checkout SHALL have no uncommitted changes
- the conversation's branch SHALL exist
- the conversation's branch SHALL NOT already be contained in the target branch

WHEN any precondition fails
THE SYSTEM SHALL refuse the action with a reason naming the failed precondition
AND SHALL make no change to any branch, worktree, or conversation state

WHEN all preconditions hold
THE SYSTEM SHALL merge the branch into the target branch, fast-forwarding when the target has
  not diverged and creating a merge commit otherwise

WHEN the merge reports conflicts
THE SYSTEM SHALL abort the merge
AND SHALL surface git's conflict output to the user
AND SHALL make no change to any branch, worktree, or conversation state

WHEN the merge succeeds
THE SYSTEM SHALL delete the worktree
AND apply the mode-dependent branch disposition (Managed: delete the task branch; Branch:
  keep the branch)
AND resolve the conversation via bedrock's `TaskResolved` with outcome `merged`
AND emit a synthetic system message naming the target branch and whether the merge
  fast-forwarded

THE SYSTEM SHALL NOT push to origin
THE SYSTEM SHALL NOT move the target branch ref through any checkout other than the one that
  has it checked out

**Design:** This is the local-only counterpart to the GitHub link-outs: work that never needs
a pull request can be landed and cleaned up in one action. The merge runs in the checkout that
owns the target branch — required, not incidental. Moving `refs/heads/<target>` behind a
checkout's back would leave that checkout's index and working tree describing a commit that is
no longer its branch tip; running the merge through the owning checkout updates ref, index, and
working tree together. Requiring that checkout to be clean means a conflicted or unexpected
merge cannot destroy uncommitted work. Every precondition is evaluated, and a conflicting merge
aborted, strictly before the irreversible cleanup, so a refusal is always a no-op the user can
retry after fixing the cause.

A branch already contained in the target is refused rather than reported as a successful no-op:
the user asked to land work, and silently cleaning up a branch that contributed nothing would
misreport what happened. `Mark as merged` is the action for that case.

**Legality gate:** bedrock's `TaskResolved` rule (REQ-BED-029, REQ-BED-031) governs when this
action may be initiated.
