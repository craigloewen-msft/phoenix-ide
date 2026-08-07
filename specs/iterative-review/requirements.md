# Iterative Review: Reviewing an Agent's Changes Across Turns

## User Story

As a developer working with an agent, I need to review the code it wrote the way
I review a colleague's — file by file, keeping track of what I have already read,
leaving comments, and asking for fixes — and then, after the agent responds, see
only *what changed since I last looked* rather than re-reading everything.

## Scope

This spec governs the **per-file review loop** on Work and Branch conversations:

- The **review manifest** — which files changed, and the review state of each.
- **Review checkpoints** — the durable record of "I reviewed this file at this
  content", and the staleness that follows an agent's later edit.
- **Per-file diffs**, in full or restricted to what changed since review.
- **Completing a review pass.**

It does **not** own:

- **The whole-branch diff** (`View Diff`) — `specs/viewer_slot/`, which owns the
  diff slot and its payload.
- **Review note capture, formatting, and injection into the composer** —
  `specs/prose-feedback/`. This spec requires diff-mode annotation to route
  through that machinery; it does not redefine it.
- **Terminal actions and their git side effects** — `specs/work-lifecycle/`.
- **Action-bar composition and primary-action selection** —
  `specs/work-actions-bar/`. Completing a review does not participate in that
  selection (REQ-RV-009).
- **File tree listing and git status decorations** — `specs/file-explorer/`.

---

## Requirements

### REQ-RV-001: Review Against the Local Base Branch

WHEN the system resolves the ref to review a conversation's changes against
THE SYSTEM SHALL use the conversation's local base branch when a local ref for it
  exists
AND SHALL fall back to the remote-tracking ref only when no local ref exists
AND SHALL surface the resolved comparator on the review surface

**Design:** The user reviews what the agent wrote relative to the branch they will
merge into locally. A remote-tracking ref can be arbitrarily stale or ahead of the
local branch, so diffing against it would attribute other people's commits to the
agent, or hide the agent's work behind an outdated base. Because the choice is
consequential and not self-evident, the resolved comparator is displayed rather
than left implicit.

---

### REQ-RV-002: Per-File Review Manifest

WHEN the user views a Work or Branch conversation
THE SYSTEM SHALL list every file changed between the comparator's merge base and
  the current working tree, including files the agent has not committed and files
  it created but never staged
AND SHALL report, for each file, its change status, its insertion and deletion
  counts, and its review state
AND SHALL report how many of the changed files are reviewed

**Design:** The manifest is merge-base-relative and working-tree-inclusive so it
answers one question consistently: "what has this work changed?" Whether the agent
has committed yet is an implementation detail of its workflow, not a property of
what the user must review — so a file's presence in the manifest does not change
when the agent commits.

---

### REQ-RV-003: Review State Is Reviewed, Stale, or Unreviewed

THE SYSTEM SHALL represent a file's review state as exactly one of:
  **unreviewed** (no checkpoint), **reviewed** (checkpoint matches current
  content), or **reviewed-stale** (checkpoint exists but current content differs)
AND SHALL distinguish these three states visually in the changed-files list

**Design:** Reviewed-stale is the state that makes the loop iterative: it is how a
file the user already approved returns for re-review after the agent revises it.
Modelling the three as a sum type rather than independent flags makes
"reviewed and also not reviewed" unrepresentable rather than merely unlikely.

---

### REQ-RV-004: Marking Reviewed Records the Content the User Saw

WHEN the user marks a file as reviewed
THE SYSTEM SHALL record a checkpoint holding the content hash of the file as
  displayed to the user, together with the comparator it was reviewed against
AND SHALL reject the mark when the file's current content differs from what the
  user was shown
AND SHALL reject the mark when the file's stored review state changed concurrently

**Design:** A checkpoint is a claim that a human read specific bytes. If the agent
rewrites the file between render and click, accepting the mark would record a
review that never happened — and worse, would suppress the staleness that should
have brought the file back for re-review. Rejection is therefore correct even
though it costs the user a re-open.

---

### REQ-RV-005: Review Never Interferes With Staging or Committing

WHILE a review is in progress
THE SYSTEM SHALL NOT read or write the repository index, and SHALL NOT move any ref

**Design:** The agent stages and commits throughout the period the user is
reviewing. Review that borrowed the index would either break the agent's commits
or let those commits silently destroy review state. See ADR-026 for the mechanism
chosen instead and the alternatives rejected.

---

### REQ-RV-006: Reviewing a Single File

WHEN the user opens a changed file for review
THE SYSTEM SHALL present that file's diff against the comparator
AND SHALL allow switching between the file's diff and its current source without
  changing which file is open
AND SHALL allow annotating diff lines, anchored to the file, side, and line number

**Design:** Diff and source are two renderings of one open file, not two viewers;
preserving the open file across the toggle is what makes "read the diff, check the
surrounding code, mark it, move on" a single continuous act. Annotations carry
side identity because a comment on a removed line means something different from a
comment on the line that replaced it.

---

### REQ-RV-007: Reviewing Only What Changed Since Last Review

WHERE a file has a review checkpoint
THE SYSTEM SHALL offer a diff restricted to the changes made after that checkpoint
AND SHALL report an error, rather than substituting the full diff, when a
  since-review diff is requested for a file with no checkpoint

**Design:** This is the requirement the whole loop exists to serve: after asking
for fixes, the user reads the delta, not the file again. Silently widening the
scope to the full diff would answer a different question than the one asked, and
the user would have no way to tell that had happened.

---

### REQ-RV-008: Checkpoints Live and Die With the Work Scope

WHEN a work scope is deleted
THE SYSTEM SHALL discard its review checkpoints

WHEN a work scope's branch, base branch, or worktree changes
THE SYSTEM SHALL discard that scope's review checkpoints

WHERE a checkpoint's recorded comparator does not match the scope's current
  comparator
THE SYSTEM SHALL treat the affected file as unreviewed and record the discrepancy
  in logs

**Design:** Review is meaningful only relative to the body of work it was performed
against. A checkpoint that outlived its base would render a reviewed marker for a
review that never happened against the current comparator — strictly worse than
showing no marker, because it invites the user to skip a file they never read. The
comparator column is therefore a consistency check, not a second source of truth.

---

### REQ-RV-009: Completing a Review Records a Pass, It Does Not Gate Merging

WHERE every changed file is reviewed and none is stale
THE SYSTEM SHALL offer an action to complete the review pass

WHEN the user completes a review pass
THE SYSTEM SHALL NOT alter the availability of any terminal or PR action

**Design:** Completing a review is the user recording their own state, not the
tool granting permission. Making it a merge precondition would insert a blocking
step into a flow whose value is informational, and would compete with the work
action bar's single-primary-action rule (`specs/work-actions-bar/` REQ-WAB-003).
The completion affordance appears only when there is nothing outstanding, so it
reports a fact rather than inviting a premature claim.

---

### REQ-RV-010: The Reader Controls How Much Screen the Review Gets

WHERE a diff is presented for review
THE SYSTEM SHALL let the user choose between an inline and a side-by-side rendering
AND SHALL apply that choice to every diff surface and remember it across sessions

WHERE a diff is presented beside the conversation
THE SYSTEM SHALL offer an explicit control that collapses the conversation so the
  review occupies the full window, and restores it on demand
AND SHALL restore the conversation when the diff is no longer presented beside it

**Design:** Rendering style is a property of the reader, not of a particular
diff — a user who reads side-by-side reads side-by-side everywhere, so one
remembered choice governs both the whole-branch diff and the per-file review
diff. Collapsing is an explicit act rather than a side effect of clicking into
the diff: reviewing involves clicking constantly (lines, notes, files), and a
layout that moved under those clicks would be unpredictable. Because collapsing
is a transient reading posture rather than an addressable place, it is not part
of the viewer's addressable state, and it lapses when the surface it belongs to
goes away.
