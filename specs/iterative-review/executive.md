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
| **REQ-RV-006:** Reviewing a single file | ✅ Complete | `?mode=diff` slot param; `FileReviewDiffView`; FILE⇄DIFF toggle in `MetaViewer` and the diff header |
| **REQ-RV-007:** Only what changed since last review | ✅ Complete | `git_ops::review::file_diff_since_review`; `scope=since_review`; 409 when no checkpoint |
| **REQ-RV-008:** Checkpoints live and die with the work scope | ✅ Complete | `ON DELETE CASCADE` on scope deletion; re-scope clears in `update_work_scope_environment_tx`; comparator mismatch → unreviewed |
| **REQ-RV-009:** Completing a pass does not gate merging | ✅ Complete | `ChangedFilesReview` complete action; `WorkActions` untouched |

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

## Verification

- Rust (`git_ops::review::tests`): checkpoint stability across commit/amend/rebase;
  manifest invariance under the agent committing; since-review scoping;
  truncation accounting after header relabelling; local-vs-remote comparator
  selection; and an explicit assertion that the repository index is unchanged
  across a full manifest-plus-diff pass.
- Rust (`phoenix-db`): checkpoint round-trip, compare-and-set rejection of a stale
  mark, individual and wholesale clearing, and that re-scoping a conversation
  discards its review.
- UI (`ChangedFilesReview.test.tsx`): progress and comparator display, the
  three-state markers, open-for-review, and that completion is withheld while any
  file is stale.
- UI (`ViewerSlotContext.test.tsx`): `?mode=diff` derivation and its default.
- Manual: the full loop exercised against the seeded `diff-review-fixture`
  conversation — mark → agent edit → stale marker → since-review delta.

## Known gaps

- **Checkpointed blobs are unreferenced loose objects.** An aggressive
  `git gc --prune=now` between turns can collect one, degrading the since-review
  diff for that file. Accepted per ADR-026.
- **Review comments are session-local.** They survive until sent to the composer,
  not across a reload.
