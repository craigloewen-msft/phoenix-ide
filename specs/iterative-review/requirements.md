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

WHEN the user chooses the since-review diff
THE SYSTEM SHALL treat that choice as a standing preference across the files
  they subsequently open
AND SHALL render the full diff for a file with no checkpoint without discarding
  that preference

**Design:** This is the requirement the whole loop exists to serve: after asking
for fixes, the user reads the delta, not the file again. Silently widening the
scope to the full diff would answer a different question than the one asked, and
the user would have no way to tell that had happened.

"Show me only what is new" is an intent for a whole review pass, not for one
file: a reviewer walking the changed-files list is asking the same question of
every file. Resetting per file would make them re-state it at each step. A file
with no checkpoint cannot answer that question, so it shows the full diff — but
it answers for itself only, and does not speak for the next file.

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

### REQ-RV-010: A Review Pass Is Completable From the Keyboard Alone

WHILE a review surface is the topmost focus scope and no text field has focus
THE SYSTEM SHALL accept keyboard commands to scroll the viewport, move between
  changed files, toggle a file's reviewed state, annotate the current file,
  annotate a named line of the current file, refresh the surface, and dismiss
  the surface
AND SHALL apply those commands to the whole-branch diff and the per-file review
  diff alike

WHILE the user types digits on a review surface
THE SYSTEM SHALL accumulate them into a count and apply it to the next command
  that takes one

WHEN a pending count or held prefix is not completed within the review prefix
  timeout
THE SYSTEM SHALL discard it

WHEN a key that takes no count is pressed
THE SYSTEM SHALL discard the count

WHERE a count precedes the annotate command
THE SYSTEM SHALL anchor the note to that line of the current file, bring the
  line into view, and quote the same source text a pointer-driven note on that
  line would quote

WHERE a counted annotate command names a line the current file's diff does not
  contain
THE SYSTEM SHALL report why the command had no effect

WHEN the user toggles a file that is unreviewed or stale
THE SYSTEM SHALL mark it reviewed and then move to the next file still needing
  review

WHEN the user toggles a file that is already reviewed
THE SYSTEM SHALL clear its checkpoint and leave the current file selected

WHERE a keyboard command names a file the review manifest does not track
THE SYSTEM SHALL report why the command had no effect

**Design:** Reviewing a colleague's change is a reading task, and reaching for the
mouse between every file is what breaks its rhythm. The commands are the ones the
loop already has as buttons, so the keyboard is a second route to the same
behaviour rather than a parallel one that can diverge.

The count exists because the line a reviewer wants to comment on is already on
screen with its number printed beside it; typing that number is a shorter path
than hunting for the line's gutter affordance. Borrowing vim's count semantics
means the behaviour is already known to the audience that wants it.

A count is not displayed. The line number is already printed in the gutter
beside the line the reviewer is looking at, so echoing the digits back adds a
banner that shifts the diff while they type without telling them anything the
screen does not already show. Because the count is therefore invisible, it
expires on the same timeout a held multi-key prefix does: unseen modal state
that never lapses would silently change what a key pressed much later means.

Marking advances because it is the act that completes a file; un-marking is a
correction to the file in front of the user, so moving away from it would discard
the context that prompted the correction.

The whole-branch diff can render files outside the manifest (a diff taken against
another branch), so marking there can find no file to mark. A named line can
likewise fall outside the rendered hunks. Doing nothing is indistinguishable from
a broken key, hence the explicit report in both cases.

---

### REQ-RV-011: The Review Surface Reconciles With Edits Made Outside Phoenix

WHEN the user requests a refresh of a review surface
THE SYSTEM SHALL re-read the rendered diff and the review manifest from the
  working tree

WHEN the browser window regains focus while a review surface is open
THE SYSTEM SHALL perform the same refresh

**Design:** The working tree is shared with whatever editor the user also has
open, so a rendered diff is a snapshot that can silently fall behind. Returning to
the Phoenix window is both the moment the staleness starts to matter and an action
the user took, which makes it a truthful trigger; polling would spend requests
while nobody is looking and still lag the edit that prompted the switch.

Refreshing re-reads rather than patching: the manifest is server-owned
(REQ-RV-002), so the surface asks again instead of reconciling a local copy.

---

### REQ-RV-012: Keyboard Commands Are Discoverable Without Being Known

WHERE a review surface offers keyboard commands
THE SYSTEM SHALL provide an affordance on that surface that opens the keyboard
  guide
AND the guide SHALL list every keyboard command the review surfaces accept

**Design:** A keymap nobody can find is a keymap nobody uses. The guide is
generated from the same table that resolves the key presses, so a command cannot
be added without becoming documented — the alternative, a hand-maintained list,
drifts on the first change and then actively misinforms.

---

### REQ-RV-013: The Reader Controls How Much Screen the Review Gets

WHERE a diff is presented for review
THE SYSTEM SHALL let the user choose between an inline and a side-by-side rendering
AND SHALL apply that choice to every diff surface and remember it across sessions

WHERE a diff is presented beside the conversation
THE SYSTEM SHALL offer an explicit control that collapses the conversation so the
  review occupies the full window, and restores it on demand
AND that control SHALL be operable from both the pointer and the keyboard
AND SHALL restore the conversation when the diff is no longer presented beside it

**Design:** Rendering style is a property of the reader, not of a particular
diff — a user who reads side-by-side reads side-by-side everywhere, so one
remembered choice governs both the whole-branch diff and the per-file review
diff. Collapsing is an explicit act rather than a side effect of clicking into
the diff: reviewing involves clicking constantly (lines, notes, files), and a
layout that moved under those clicks would be unpredictable. It is nonetheless
reachable from the keyboard, because widening the reading area is part of the
reading rhythm REQ-RV-010 protects, and a control that forces a reach for the
mouse breaks that rhythm exactly as moving between files would. Because
collapsing is a transient reading posture rather than an addressable place, it is
not part of the viewer's addressable state, and it lapses when the surface it
belongs to goes away.
