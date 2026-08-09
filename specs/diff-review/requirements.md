# Diff Context Expansion — Requirements

## Background

The diff review surface renders `git diff` output, which carries three lines of
context around each change. A reviewer deciding whether a change is correct
frequently needs to see more of the surrounding file — which function encloses
the change, what a modified line sits between — and otherwise has to leave the
review surface to get it.

Phoenix renders diffs through `@pierre/diffs`, whose renderer already draws
expand controls into hunk separators and owns the reveal interaction. It offers
them only for a file parsed with both sides' full contents. Phoenix's role is
therefore to supply those contents — and to guarantee they are the versions the
diff was computed against.

That guarantee is the substance of this spec. The renderer applies supplied
contents without validating them against the patch, so contents from a different
version of the file yield context lines that silently do not belong to the diff.
See `specs/adrs/027_expanded-diff-context-is-addressed-by-blob-object-id.md`.

## User Stories

### Story 1: Read around a change without leaving review

As a reviewer, I want to reveal unmodified lines above and below a hunk, so that
I can tell what function or scope a change sits in without opening the file
separately and losing my place in the review.

### Story 2: Trust what I am shown

As a reviewer, I want any context I reveal to be the same version of the file the
diff was computed against, so that I am never reasoning about a change using
surrounding lines that belong to some other state of the file.

## Requirements

### REQ-DIFFEXP-001 — Reveal unmodified context around hunks

Where a file's diff has unmodified lines before its first hunk, between two
hunks, or after its last hunk, the diff viewer shall offer a control to reveal
those lines, and shall report how many remain hidden.

When a control is activated, the viewer shall reveal a bounded run of lines from
the adjoining hidden region; when the reviewer asks to expand the whole region,
it shall reveal all of it. A region with no remaining hidden lines shall offer
no control. A region adjoining the start of the file shall offer only downward
reveal, and one adjoining the end only upward.

### REQ-DIFFEXP-002 — Revealed context matches the diff

Revealed lines shall come from the versions of the file the diff was computed
against. Content shall be addressed by the blob object ids recorded in the
diff. Where a side has no stored blob — the working tree, for uncommitted
changes — its content shall be verified against the recorded object id before
use.

Where content cannot be shown to match, the viewer shall render the file without
expansion rather than reveal unverified lines.

### REQ-DIFFEXP-003 — Unavailability is typed and total

Where a file side has no content available for expansion, the reason shall be
reported as one of a closed set of outcomes: the side does not exist, the
content is not text, it exceeds the size limit, the object is absent, the path
escapes the worktree, or the content no longer matches the diff.

An absent side shall never be represented merely by missing data.

### REQ-DIFFEXP-004 — Expansion never degrades the diff

Where expansion content is unavailable, not yet loaded, or fails to load, the
diff shall render as it does without the feature. Failure to obtain expansion
content shall not be surfaced as a review error.

### REQ-DIFFEXP-005 — Truncated sections are not expandable

Where a diff section was truncated at capture, the viewer shall not offer
expansion for its files. The retained diff text is incomplete, so context
derived from it could not be shown to match.

### REQ-DIFFEXP-006 — Expansion preserves review anchoring

Revealing context shall not change the line numbers, note anchors, search
results, or keyboard navigation targets of a file. Notes taken on revealed
context lines shall anchor to those lines and quote their text, on the same
terms as notes on lines the diff already displayed.

### REQ-DIFFEXP-007 — Expansion reads only files under review

Expansion shall resolve content only for files within the worktree of the
conversation being reviewed. A path that resolves outside that worktree,
whether by traversal or by symbolic link, shall be refused.
