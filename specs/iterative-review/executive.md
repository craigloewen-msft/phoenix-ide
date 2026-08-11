# Iterative Review — Executive Summary

**Status:** Implemented.

Reviewing an agent's work file by file, keeping a durable record of what has
already been read, and — after asking for fixes — seeing only what changed since
that review. The loop is repeatable: every agent turn that touches an
already-reviewed file returns it for re-review.

The governing design decision is ADR-026: review progress is a **content-addressed
checkpoint**, not the git index. This reproduces the semantics of using `git add`
as a review ledger while leaving the index entirely free for the agent to stage
and commit with.

## Requirement coverage

| Requirement | Status | Surface |
|---|---|---|
| **REQ-RV-001:** Review against the local base branch | ✅ Complete | `git_ops::review::review_comparator`; comparator rendered by `ChangedFilesReview` |
| **REQ-RV-002:** Per-file review manifest | ✅ Complete | `GET /api/conversations/:id/review/files` → `get_review_files`; `git_ops::review::list_changed_files` |
| **REQ-RV-003:** Reviewed / stale / unreviewed | ✅ Complete | `FileReviewState` (Rust + TS); `resolve_review_state`; markers in `ChangedFilesReview` |
| **REQ-RV-004:** Marking records the content the user saw | ✅ Complete | `POST …/review/files/mark` → `mark_file_reviewed`; `Database::upsert_review_checkpoint` compare-and-set |
| **REQ-RV-005:** No interference with staging or committing | ✅ Complete | `git_ops::review::temp_index_env` (isolated `GIT_INDEX_FILE`); guarded by `review_plumbing_never_touches_the_index` |
| **REQ-RV-006:** Reviewing a single file | ✅ Complete | `?mode=diff` slot param; `FileReviewDiffView`; FILE⇄DIFF toggle in `MetaViewer` and the diff header; Edit button reaches the armed source editor directly |
| **REQ-RV-007:** Only what changed since last review | ✅ Complete | `git_ops::review::file_diff_since_review` (header relabelling stops at the first hunk, so body lines that begin `-- ` / `++ ` survive); `scope=since_review`; 409 when no checkpoint; `useReviewDiffScope` persists the choice across files, with a no-checkpoint file rendering `full` without clearing it; `FileReviewDiffView` renders a response only when its echoed `path`/`scope` match the open request |
| **REQ-RV-008:** Checkpoints live and die with the work scope | ✅ Complete | `ON DELETE CASCADE` on scope deletion; re-scope clears in `update_work_scope_environment_tx`; comparator mismatch → unreviewed |
| **REQ-RV-009:** Completing a pass does not gate merging | ✅ Complete | `ChangedFilesReview` complete action; `WorkActions` untouched |
| **REQ-RV-010:** Keyboard-complete review pass | ✅ Complete | `reviewKeymap.ts` (binding table + `ReviewPending` resolver, incl. the vim-style count); `useReviewKeyboard` (pending state is a ref, expires on `REVIEW_PREFIX_TIMEOUT_MS`, never rendered); `PhoenixDiffCodeView.annotateLineNumber`; `DiffView` file cursor; `FileReviewDiffView` |
| **REQ-RV-011:** Reconciles with edits made outside Phoenix | ✅ Complete | `R` command and header button on both surfaces; `useRefreshOnWindowFocus`; `FileReviewDiffView` refetches on either side of the comparison moving (`currentBlobSha` from the manifest, `at_blob` from the checkpoint) |
| **REQ-RV-012:** Keyboard commands are discoverable | ✅ Complete | `REVIEW_BINDINGS` → `ShortcutHelpPanel` "Diff Review" group; keyboard button in both viewer headers |
| **REQ-RV-013:** Reader controls the review's screen | ✅ Complete | `useDiffStyle` + `DiffStyleToggleButton` shared by `DiffView` and `FileReviewDiffView`; `ConversationPage` review-focus state → `.app-split-pane--review-focus`; `F` in `reviewKeymap.ts` reaches the same toggle |

## Current reality

**Persistence.** `work_scope_review_checkpoints` (migration 61) stores
`(work_scope_id, file_path) → reviewed_blob_sha, comparator`. Columns and rows,
not a JSON blob — the review surface queries it field-wise.

**Comparator.** Review resolves the *local* base branch first, unlike
`capture_branch_diff`, which prefers the remote-tracking ref. The existing
whole-branch `View Diff` behaviour is deliberately unchanged.

**Liveness.** The manifest refreshes on the agent's working→idle edge, derived
from the existing SSE-driven conversation state. No new SSE event was added: the
edge already exists on the wire, and the manifest endpoint already owns the state,
so pushing it would have created a second representation.

**Notes.** Diff-mode annotation reuses `useDiffReviewNotes`, so review comments
carry `(file, side, line)` anchors and flow into the composer through the existing
`specs/prose-feedback/` machinery. Notes remain session-local; durable review
comments are not implemented.

**Keyboard.** Bindings are vim-flavoured: `j`/`k` and `Ctrl+d`/`Ctrl+u` for the
viewport, `gg`/`G` for the edges, `]f`/`[f` (aliased `n`/`N`) between files, `]u`
for the next outstanding file, `m` to toggle reviewed, `c` to annotate, `F` to
collapse the conversation for a full-width read, `R` to refresh, `q` to close.
`reviewKeymap.ts` holds the resolver and the binding table; `useReviewKeyboard`
adds only the pending-prefix state for the two-key sequences.
Registration goes through the shared keyboard router
(`specs/keyboard-interaction/`) on the `viewer` layer, so bare letters reach a
review surface only while it is topmost and no field has focus.

Uppercase `F` rather than bare `f`, which is reserved as the second key of `]f` /
`[f`: a mis-tapped prefix must not reshape the layout. Only the wide-desktop
split-pane host supplies a collapse handler, so on a fullscreen or overlay diff
the key resolves to a command that finds no target and logs at debug — the
header control is absent there too, so there is nothing the reviewer is denied.

In the whole-branch diff, the "current file" is an explicit cursor over the parsed
item list, marked in the file header; `PhoenixDiffCodeView` publishes that list and
exposes typed scroll motions, so the keymap never reaches into Pierre's DOM.

**Freshness.** Pull-based: explicit `R` plus a debounced refresh when the window
regains focus. Phoenix has no filesystem-watch subsystem, and adding one (a
`notify` watcher per worktree, a new SSE event, ignore rules, teardown) is a
separable piece of work; a real watcher would replace the focus trigger without
changing the requirement.

**Reading posture.** Rendering style is one `phoenix-diff-style` preference read
by `useDiffStyle` on every diff surface. Review focus lives in `ConversationPage`
component state and applies `.app-split-pane--review-focus`, which overrides the
reserved chat width in CSS — `--viewer-pane-width` keeps its two imperative
writers (the pane layout effect and the divider's live-drag channel). The header
button and the `F` key are two routes to that one piece of state, not two states.

## Verification

- Rust (`git_ops::review::tests`): checkpoint stability across commit/amend/rebase;
  manifest invariance under the agent committing; since-review scoping;
  truncation accounting after header relabelling; that a removed `-- ` comment
  and an added `++ ` line survive that relabelling and CRLF endings round-trip;
  local-vs-remote comparator selection; and an explicit assertion that the
  repository index is unchanged across a full manifest-plus-diff pass.
- Rust (`phoenix-db`): checkpoint round-trip, compare-and-set rejection of a stale
  mark, individual and wholesale clearing, and that re-scoping a conversation
  discards its review.
- UI (`ChangedFilesReview.test.tsx`): progress and comparator display, the
  three-state markers, open-for-review, and that completion is withheld while any
  file is stale.
- UI (`ViewerSlotContext.test.tsx`): `?mode=diff` derivation and its default.
- UI (`reviewKeymap.test.ts`): every binding, prefix sequences and their
  abandonment, modifier guards, and that unknown keys are left alone.
- UI (`DiffView.keyboard.test.tsx`): file-cursor motion, mark-and-advance versus
  unmark-and-stay, the untracked-file report, refresh, close, the review-focus
  toggle and its inert no-target case, and that review keys stand down while the
  annotation dialog is open.
- UI (`FileReviewDiffView.keyboard.test.tsx`): mark at the rendered blob then
  advance, unmark without advancing, file motion, refresh, close, and the
  review-focus toggle with and without a collapse target.
- UI (`ShortcutHelpPanel.test.tsx`): every binding in the table reaches the guide.
- UI (`DiffView.test.tsx`, `FileReviewDiffView.test.tsx`): the unified/split toggle
  driving Pierre's `diffStyle`, the shared persisted preference across both diff
  surfaces, that the conversation-collapse control appears only on the
  split-pane surfaces that supply the handler, that an agent edit to the open
  file refetches without a user gesture, and that a scope switch shows the
  loading state rather than the outgoing scope's diff.
- Manual: the full loop exercised against the seeded `diff-review-fixture`
  conversation — mark → agent edit → stale marker → since-review delta.

## Known gaps

- **Checkpointed blobs are unreferenced loose objects.** An aggressive
  `git gc --prune=now` between turns can collect one, degrading the since-review
  diff for that file. Accepted per ADR-026.
- **Review comments are session-local.** They survive until sent to the composer,
  not across a reload.
- **No filesystem watcher.** A diff edited outside Phoenix updates on explicit
  refresh or on window focus, not the moment the file changes.
- **The keyboard cursor is per-file, not per-line.** `c` therefore annotates the
  file; line-anchored annotation remains a pointer action.
