# Add a "Merge to main" finish action to the work actions bar

## Problem

When work is done, the only push-forward verbs are GitHub link-outs (`Create PR on
GitHub ↗`, `Merge on GitHub #N ↗`) plus `Clean up` / `Abandon`, which assume the merge
happened somewhere else. For local-only work there is no way to say "this is good, land
it on my local `main` and give me a fresh chat".

## Goal

Add a terminal verb — proposed label **`Merge to main`** (tooltip/aria: *"Merge this
branch into local `main`, then clean up the worktree and branch"*) — that:

1. Merges the conversation's branch into the repo's local default branch.
2. On merge conflict (or any unclean precondition), fails loudly and changes nothing.
3. On success, removes the worktree, deletes the task branch (Work mode; Branch mode keeps
   the user's branch, per `work-lifecycle` REQ-WL-002's mode table), resolves the
   conversation, archives it, and lands the user on a new-conversation screen.

## Decisions (confirmed with user)

- **Where the merge runs:** the repo root checkout, where `main` normally lives. Refuse if
  the root worktree is not on the default branch or has a dirty tree.
- **Strategy:** fast-forward when possible, merge commit otherwise (`git merge --no-edit`).
- **Placement:** always present in the FINISH zone whenever the bar is visible; never the
  glowing primary (the existing `WorkDisposition` primary selection is untouched).
- **After success:** archive the conversation and navigate to a fresh chat.

## Backend

New handler alongside `mark_merged` in
`crates/phoenix-ide/src/api/lifecycle_handlers.rs`, route
`POST /api/conversations/:id/merge-to-main` in `api/handlers.rs`.

Sequence (all preconditions checked *before* any destructive step):

1. Reuse `mark_merged`'s admission lock, `has_owed_work_for_conversation`,
   `allows_terminal_action`, `ensure_terminal_action_legal`, and Work/Branch mode gate.
2. Resolve repo root from the project, and the default branch via
   `phoenix_core::git::resolve_default_branch`.
3. Preconditions on the root checkout, each with a distinct actionable error message:
   - root worktree HEAD is on the default branch,
   - root worktree is clean (`git status --porcelain` empty),
   - the conversation's branch exists and has commits.
4. `git merge --no-edit <branch>` in the repo root. Non-zero exit → `git merge --abort`
   (best-effort), return `409` with the git stderr (conflict list) and **no** cleanup, no
   state transition. This is the "error and do not continue" requirement.
5. Only on success: `run_resource_cleanup_cascade` (worktree remove, branch delete for Work
   mode, bash/tmux/browser teardown) — identical to `mark_merged`.
6. `Event::TaskResolved` with a system message naming the merge (e.g. "Merged into `main`.
   Worktree removed, task branch deleted."), wait for `ConvState::Terminal`; on failure use
   `reopen_bash_after_failed_lifecycle_mutation` like the existing handlers.

Note: the merge moves `refs/heads/main`, which is exactly the operation AGENTS.md guards —
it is legal here *because* we require `main` to be the checked-out branch of the worktree we
run the merge in. Assert that rather than moving the ref behind a checkout's back.

## Frontend

- `ui/src/api.ts`: `mergeToMain(convId)`.
- `ui/src/components/workDisposition.ts`: add `showMergeToMain: boolean` to the disposition
  variants — `false` for `HiddenDisposition` and `ContinuedDisposition`, `true` for all
  visible non-continued variants. Keep the single-primary rule untouched: the new verb is
  never the `primary` slot.
- `ui/src/components/WorkActions.tsx`: render the button in the FINISH zone next to
  `Clean up` / `Abandon`, with a pending label ("Merging…"). Handler:
  `terminalActionStillSafe()` → `api.mergeToMain` → on success
  `api.archiveConversation(convId)` → `navigate('/')`. On error, surface the message
  (conflicts included) in the existing inline error slot and stay put.
- Same treatment in the compact/expanded PR rail path so mobile and multi-PR layouts get the
  verb too.

## Specs

- `specs/work-lifecycle/requirements.md`: new REQ-WL-00N "Merge to Local Default Branch" —
  preconditions, abort-on-conflict, ordering (merge strictly before cleanup), mode-dependent
  branch disposition, archive-and-reset outcome. Update the Scope list.
- `specs/work-actions-bar/requirements.md`: extend REQ-WAB-002's FINISH zone and REQ-WAB-003
  (explicitly non-primary), plus the `WorkDisposition` shape in REQ-WAB-004.
- Update both `.allium` files and `executive.md`s to match.

## Tests

- Rust: temp-repo integration tests for happy path (ff and non-ff), conflict → 409 with
  worktree and branch still intact and conversation still idle, dirty root → 4xx, root on a
  non-default branch → 4xx.
- UI: `workDisposition.test.ts` for the new flag across dispositions; `WorkActions.test.tsx`
  for click → merge → archive → navigate, and for conflict error rendering without archive.

## Open wording question

`Merge to main` is the working label; if the repo's default branch differs, render the actual
branch name (`Merge to master`). Alternative phrasings: `Land on main`, `Merge locally`.
