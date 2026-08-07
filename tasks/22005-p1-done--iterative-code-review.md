# Iterative code review: per-file diffs, review checkpoints, re-review across turns

Add a first-class iterative review loop to work conversations: see the files an
agent changed, open each one in a diff view, annotate it, mark it reviewed, and
on the next agent turn see only what changed *since* you reviewed it — without
hijacking the git index.

## Why this is mostly composition, not new architecture

Much of the substrate exists:

- `GET /api/conversations/:id/git-status` already returns `changed_paths` and is
  already rendered in the sidebar (`FileExplorerPanel`, `FileTree` git badges).
- `GET /api/conversations/:id/diff` already returns branch-scoped committed +
  uncommitted diffs (`git_ops::capture_branch_diff`).
- `ViewerSlot` already has a `diff` kind, and `MetaViewer` already routes payload
  kinds to body renderers with header-mounted mode toggles (see `HtmlViewMode`).
- Per-file annotation already exists: `useFileReviewNotes`, `AnnotationDialog`,
  `NotesPanel`, `formatNotes` — notes are collected and injected into the input.

What is missing is (a) a *per-file* diff rather than a whole-branch blob, (b) a
durable notion of "I reviewed this file at this content", and (c) a sidebar
surface that drives the loop.

## Design decision: review checkpoints, not `git add`

The manual workflow uses `git add` as a review ledger: staged content is "what I
already looked at", and `git diff` shows only what arrived since. That works, but
it makes the index unusable for the agent — which needs to stage and commit
freely.

**Decision:** replicate the semantics, not the mechanism. When the user marks a
file reviewed, persist the file's *content blob SHA* at that instant
(`git hash-object` on the working-tree bytes, or a null-blob sentinel for a
deleted file). That is a review checkpoint.

This yields exactly the properties asked for:

| Question | Answer |
| --- | --- |
| Is this file reviewed? | a checkpoint row exists |
| Is the review stale? | current blob SHA != checkpoint blob SHA |
| What is new since I reviewed? | `git diff <checkpoint_sha> <current_sha>` |
| Full diff vs base? | `git diff <base>...HEAD -- <path>` (unchanged) |
| Does the agent committing break it? | no — the index is never read or written |

A checkpoint survives commits, rebases, amends, and stashes because it is keyed
on content, not on a ref or an index entry. It is also idempotent to recompute.

ADR required: `specs/adrs/NNN_review_checkpoints_over_git_index.md`, recording
the rejected alternative (a Phoenix-owned second index via `GIT_INDEX_FILE`) and
why content-hash checkpoints won — no lockfile contention, no worktree coupling,
survives history rewrites.

## Base ref: local `main`, not `origin/main`

The review comparator must be the *local* base branch. `capture_branch_diff`
currently prefers the remote-tracking ref when it exists, which is wrong for this
loop: the user reviews what the agent wrote relative to the branch they will
merge into locally, and `origin/main` can be arbitrarily stale or ahead.

Make comparator selection an explicit typed parameter rather than a buried
heuristic: the review surface requests the local `base_branch`, falling back to
the remote-tracking ref only when no local ref exists. The resolved comparator is
already surfaced as `ConversationDiffResponse::comparator`; the review surface
must display it so the user is never guessing what they are diffing against. Do
not silently change the existing whole-branch `View Diff` behaviour.

## Scope of work

### 1. Persistence (`crates/phoenix-db`)

New table `work_scope_review_checkpoints`, added to `ddl.rs` **and** a new
migration in `migrations.rs` (fresh DBs replay the chain):

- `work_scope_id` FK -> `work_scopes_new(id)` `ON DELETE CASCADE`
- `file_path` (repo-relative, canonicalized)
- `reviewed_blob_sha` `NOT NULL` (null-blob sentinel encodes "reviewed as absent")
- `comparator` `NOT NULL` — the base the review was performed against
- `created_at`, `updated_at`
- `PRIMARY KEY (work_scope_id, file_path)`

Columns, not a JSON blob: this is a child collection addressed field-wise by SQL
("which files are reviewed", "clear all checkpoints"), so per the repo's
persistence rule it is a table.

Accessors in `crates/phoenix-db/src/lib.rs` following the
`upsert_work_scope_pr_observations` / `list_work_scope_pr_associations` pattern:
`upsert_review_checkpoint`, `list_review_checkpoints`, `clear_review_checkpoint`,
`clear_all_review_checkpoints`.

### 2. Backend API (`crates/phoenix-ide/src/api/git_handlers.rs`)

- `GET /api/conversations/:id/review/files` — per-file review manifest. For each
  changed path: status (added/modified/deleted/renamed), insertions/deletions,
  current blob SHA, and a **typed** review state so invalid combinations are
  unrepresentable:

  ```rust
  pub enum FileReviewState {
      Unreviewed,
      Reviewed { at_blob: String },
      ReviewedStale { at_blob: String, current_blob: String },
  }
  ```

  `ReviewedStale` — you reviewed it, then the agent touched it again — drives the
  whole iterative loop. It must be a distinct variant, not a boolean pair that can
  be set inconsistently.

- `GET /api/conversations/:id/review/file-diff?path=…&scope=full|since_review` —
  a single-file unified diff. `full` diffs `<comparator>...HEAD` plus uncommitted;
  `since_review` diffs the checkpoint blob against current content. Requesting
  `since_review` for a file with no checkpoint is a 409, not a silent degrade to
  `full`.

- `POST /api/conversations/:id/review/files/mark` — body carries path plus the
  client's observed blob SHA. Compare-and-set: if the file changed underneath the
  user between render and click, return a conflict rather than checkpointing
  content the user never saw. This is the correctness crux of the feature.

- `DELETE …/review/files/mark` — unmark.

- `POST /api/conversations/:id/review/complete` — records the review pass as
  concluded. Deliberately advisory; see "Complete review" below.

Respect existing diff size caps (`MAX_DIFF_BYTES`) and the saturation/truncation
fields already on `ConversationDiffResponse`; per-file diffs should rarely hit
them but must degrade the same way.

### 3. SSE

New `SseWireEvent` variant so an agent turn that touches a reviewed file makes
the sidebar go stale live, without polling. Add the runtime `SseEvent` variant,
the `From<SseEvent>` arm, and the `event_type()` arm, then regenerate with
`./dev.py codegen` and update `ui/src/sseSchemas.ts`. Never hand-edit
`ui/src/generated/`.

The event carries only identity (conversation + affected paths); the client
refetches the manifest. Pushing the manifest itself would create a second
representation of state the endpoint already owns.

### 4. Viewer: DIFF mode for a single file

Add a `diff` render kind to the `MetaViewerPayload` union in `metaViewerTypes.ts`
— that file explicitly anticipates this ("the typed boundary the diff-renderer
replacement plugs into"). Route it in `MetaViewer` to a body built on the
existing `DiffView` / `PhoenixDiffCodeView` / `pierreDiffMapping`.

Header toggle `FILE <-> DIFF`, implemented like the existing `HtmlViewMode`
source/preview toggle. Within DIFF, a second control selects
`Full <-> Since last review`, shown only when a checkpoint exists (no
disabled-as-status controls, per REQ-WAB-008's spirit).

Annotation must work in diff mode: extend `useDiffReviewNotes` so a note anchors
to `(file path, side, line)` and `formatNotes` emits that anchor, so the prompt
the agent receives is unambiguous about which side of the diff a comment refers
to. Notes stay session-local per `specs/prose-feedback`; durable comments would be
a separate task.

The mark-reviewed control lives in the viewer header and advances to the next
unreviewed file — "mark and move on" is the described loop.

### 5. Sidebar: Changed Files review list

In `FileExplorerPanel`, beneath the existing git grounding summary, a
`ChangedFilesReview` section listing the manifest: path, plus/minus counts, and a
review-state indicator using the repo's feedback vocabulary — green `✓` reviewed,
yellow `+` reviewed-but-changed-since, unmarked otherwise. Progress reads
`7/11 reviewed`. Clicking a row opens that file in the viewer in DIFF mode.

Information density over minimalism: state, magnitude, and path in one row; no
separate legend.

### 6. Complete review

When every changed file is reviewed and none are stale, surface a **Complete
review** primary action in the section. It records the pass and returns the review
surface to a resting state. The existing `WorkActions` verbs (`Clean up`,
`Merge on GitHub`, `Abandon`) remain exactly as they are and are *not* gated on
it.

Rationale: `specs/work-actions-bar` REQ-WAB-003 permits exactly one glowing
primary action. Making review completion a merge precondition would fight that
invariant and insert a blocking step into a flow described as "I would just want
to review it, and then I would want the existing buttons of merge etc. to exist."
Review completion is a state the user records, not a gate the tool enforces.

## Specs

- New `specs/iterative-review/requirements.md` with `REQ-IR-*` IDs covering:
  local-base comparator, per-file manifest, checkpoint semantics, stale detection,
  since-review diffing, compare-and-set marking, index non-interference, advisory
  completion.
- New `specs/iterative-review/iterative-review.allium` — a genuine lifecycle with
  preconditions (unreviewed -> reviewed -> stale -> reviewed) and an invariant
  worth stating: a file is `ReviewedStale` iff a checkpoint exists and its blob
  differs from current. It meets the Allium bar.
- New ADR for the checkpoint-vs-index decision.
- Update the `file-explorer`, `viewer_slot`, and `prose-feedback` executives for
  the surfaces they gain.

## Testing

- Rust: checkpoint survives commit, amend, and rebase; stale detection on
  re-modification; compare-and-set rejects a stale mark; deleted-then-restored
  file; renamed file; `since_review` without a checkpoint returns 409; the index is
  provably untouched (assert the `git status --porcelain` staged set is unchanged
  across a full mark/unmark cycle).
- UI: manifest rendering and state indicators; FILE<->DIFF toggle; annotation
  anchoring in diff mode; SSE-driven staleness; complete-review appears only when
  the manifest is fully clean.
- `./dev.py check` including the codegen-stale guard.

## Sequencing

Each step is independently shippable:

1. DB table + accessors + migration.
2. Manifest + per-file diff endpoints (exercisable via `phoenix-client.py`).
3. Sidebar changed-files list with mark/unmark — the loop is usable here.
4. Viewer DIFF mode + since-review scope.
5. Diff-anchored annotations.
6. SSE liveness + Complete review.

## Checkpoint lifetime

Checkpoints are keyed on `work_scope_id` and die with it. Review state is
meaningful only relative to the specific body of work it was performed against,
so when the work scope ends or changes — the work is completed or abandoned, the
conversation moves on, or the scope itself is re-pointed at a different
branch/base — the review is discarded rather than carried forward.

The `ON DELETE CASCADE` on `work_scope_id` gives this for free on scope deletion.
The re-scope case must be handled explicitly: any mutation of a work scope's
identity-defining fields (`branch_name`, `base_branch`, `worktree_path`) clears
that scope's checkpoints in the same transaction. Do not preserve them "just in
case" — a checkpoint whose comparator no longer matches the scope is worse than
no checkpoint, because it renders a green `✓` for a review that never happened
against the current base.

This makes the `comparator` column a consistency check rather than a second
source of truth: a checkpoint row whose `comparator` disagrees with its scope's
current base is a bug, and the manifest handler should treat it as `Unreviewed`
and log at `debug` rather than trusting it. Covered by a test that re-points a
scope's base and asserts the manifest reports every file unreviewed.
