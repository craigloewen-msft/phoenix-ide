# Diff viewer: click-to-expand unmodified context lines

GitHub-PR-style "expand context" in the Phoenix diff review surface: at every hunk
boundary, a clickable control that reveals more of the unmodified file above/below
the hunk, so a reviewer can see the enclosing function/signature without leaving
the diff.

## Current reality

- `ConversationDiffViewer` fetches `GET /api/conversations/:id/diff` (and the PR
  variant), which returns raw unified diff text produced by `capture_branch_diff`
  in `crates/phoenix-ide/src/git_ops.rs` (`git diff <comparator>...HEAD` and
  `git diff HEAD`) with git's default 3 lines of context.
- `DiffView` → `PhoenixDiffCodeView` is the **single boundary** to `@pierre/diffs`.
  `pierreDiffMapping.buildSectionItems` parses the raw text into Pierre
  `CodeViewDiffItem`s; note anchors, find, and keyboard jumps are all derived from
  the parsed hunks (`resolveDiffAnchorLine`, `lineTextAt`, `itemRenderSignature`).
- There is no expansion affordance today, and no endpoint that serves file content
  at an arbitrary revision (`/api/files/read` reads the worktree only, and only for
  the current on-disk state).

## Approach

Expand at the **diff-text layer**, not by hacking Pierre's renderer. Expanded
context is spliced into the unified diff text for the affected file (hunk headers
recomputed, context lines carrying real old/new line numbers), and the existing
parse pipeline re-runs. That keeps line numbers absolute and truthful, so notes,
find, `{n}c`, and jump-to-note keep working with no change to the anchor model.

### 1. Backend: revision-scoped file content

New read-only endpoint (conversation-scoped, worktree-bounded, path-traversal
checked) returning a **line range** of a file at a given side of the comparison:

- committed section: old side = `<comparator>`, new side = `HEAD`
- uncommitted section: old side = `HEAD`, new side = worktree file on disk

Implemented over `git show <rev>:<path>` (and a plain read for the worktree side),
reusing the existing comparator resolution in `git_ops.rs` so the viewer and the
expansion can never disagree about what they are comparing. Response carries the
requested range, the returned lines, and the file's total line count (needed to
know when the tail is fully expanded). Binary/too-large/deleted files return a
typed "not expandable" outcome rather than an error string.

### 2. Expansion state + splice (pure module, unit-tested)

A new pure module beside `pierreDiffMapping` owns:

- gap computation: for each file, the ranges of unmodified lines *before the first
  hunk*, *between consecutive hunks*, and *after the last hunk*.
- expansion state keyed by `(section, filePath, gapIndex)`, tracking how many lines
  have been revealed from each end of the gap.
- the splice: given the original file's diff text plus fetched context lines,
  produce the augmented unified diff text with corrected `@@` headers, merging two
  hunks into one when an expansion closes the gap between them.

This is where the correctness risk lives, so it is pure and directly tested:
round-trip splice → parse → assert every context line's number matches the source
file.

### 3. UI affordance

- Each gap gets a clickable row: expand up, expand down, and *expand all* when the
  gap is small (mirrors GitHub). Expanding fetches only the missing range and
  reveals a bounded chunk (20 lines) per click.
- Fully-expanded gaps stop rendering the control; the file-start/file-end gaps
  render only the direction that exists.
- Keyboard: reachable via the existing review focus scope, and a keymap binding
  consistent with `useReviewKeyboard`.
- Expansion state resets on refresh/refetch (the underlying diff may have moved).

### SPIKE RESULT (completed) — steps 1-3 above are SUPERSEDED

`@pierre/diffs@1.2.0` **already implements hunk expansion natively.** Verified by
running the real package:

- `FileDiffMetadata.isPartial` is `false` exactly when `processFile` is given both
  `oldFile` and `newFile` full contents. Then `additionLines`/`deletionLines` hold
  the *entire* file, and `DiffHunksRenderer` sets `isExpandable: !fileDiff.isPartial`.
- With that, Pierre renders clickable expanders in its hunk separators
  (`hunkSeparators: 'line-info'`, the default Phoenix already uses) and wires
  `onHunkExpand` → `expandHunk(hunkIndex, direction, count)` internally.
  Shift-click expands the whole gap. `expansionLineCount` (default 100) tunes the
  per-click chunk.
- Confirmed empirically: the same patch parsed partial → `additionLines.length === 7`,
  `isPartial: true`; parsed with contents → `additionLines.length === 40`,
  `isPartial: false`, and hunk offsets (`additionLineIndex: 16` for
  `additionStart: 17`) line up exactly with the real file.

So **the hand-rolled splice layer in step 2 is unnecessary** — writing it would
duplicate, less well, logic the pinned dependency already ships. Dropped.

The real work is only: *give Pierre the full file contents*, safely.

#### The correctness hazard this exposes (and how it is closed)

Pierre trusts supplied contents blindly. Verified empirically: feeding contents
that do not match the diff's base makes Pierre report `deletionStart: 17` while the
line actually at that index is `line 12` — **silently wrong context, no error**. A
naive "read the file from disk" implementation would hit this whenever the file
changed after the diff was captured.

Git already solves this: the `index <old>..<new>` line in every git diff carries
blob OIDs, and Pierre parses them into `prevObjectId` / `newObjectId`. Content is
therefore fetched **by OID, not by path+revision**:

- old side: `git cat-file blob <prevObjectId>` — the OID *is* the content identity,
  so a stale read is not representable.
- new side: committed diffs resolve by OID the same way. For the uncommitted
  section the new side is the working-tree file, whose blob may not be in the
  object database, so the server reads the file and verifies `git hash-object`
  equals `newObjectId`; a mismatch returns a typed not-expandable outcome instead
  of wrong content.

That makes "expanded context that doesn't match the diff" structurally impossible
rather than something a reviewer must notice.

(Checked and cleared: Phoenix's `git_command()` already pins `diff.mnemonicPrefix=false`
and `a/`+`b/` prefixes, so the `c/`..`w/` prefixes a user's global
`diff.mnemonicPrefix=true` would otherwise produce — which crash Pierre's parser —
cannot reach the viewer.)

### Revised implementation

1. **Backend**: one read-only conversation-scoped endpoint resolving a batch of
   `(path, prevObjectId, newObjectId)` to old/new file contents by OID, with the
   working-tree hash verification above. Binary, oversized, added/deleted, and
   hash-mismatch cases each return a typed non-expandable reason.
2. **Frontend**: `pierreDiffMapping` gains a pure hydration step that re-parses a
   file's diff chunk through `processFile` with fetched contents, yielding a
   non-partial item. Pierre then renders and drives expansion itself.
3. **Wiring**: `PhoenixDiffCodeView` stays the only Pierre boundary; hydration is
   fetched once per diff load, skipped for truncated sections (expansion there
   would lie), and the item `version` bump carries hydrated content through
   Pierre's controlled reconciler.

No DOM scraping, no bespoke diff splicing, and note/find/keyboard anchoring is
untouched because line numbers come from the same parse as before.

### 4. Original renderer-slot spike plan (superseded by the result above)

`@pierre/diffs@1.2.0` is pinned and its render slots in use are
`renderAnnotation` / `renderHeaderPrefix` / `renderHeaderMetadata` /
`renderGutterUtility`. **Before implementing**, verify whether it exposes a
supported hunk-separator/expander slot.

- If yes → render the control through that typed slot.
- If no → render the control as a Phoenix-owned row *outside* Pierre per gap is
  not possible inside a virtualized surface, so the fallback is the
  already-chosen text-layer trick: represent each collapsed gap as a synthetic
  first-context-line marker and drive expansion from `renderGutterUtility` on that
  line. **No DOM scraping of Pierre's shadow DOM under any circumstance** — that
  constraint is inherited from `tasks/29011` and is non-negotiable.

The spike's outcome is recorded in the task before the UI work proceeds.

## Out of scope

- Expanding context for truncated/saturated diff sections (the 256KiB cap already
  drops content; expansion there would lie). The control is suppressed with a
  reason when the section was truncated.
- Changing git's default 3-line context in the capture itself.

## Acceptance

- Clicking expand above/below a hunk reveals real, correctly-numbered unmodified
  lines from the file, in both committed and uncommitted sections, in unified and
  split styles.
- Line notes taken on expanded context lines anchor correctly and survive a jump
  from the notes panel; existing notes are unaffected by expansion.
- Find results and `{n}c` still resolve against the expanded content.
- Fully-expanded gaps hide the control; file head/tail behave correctly.
- Unit tests on the splice module; component tests for the affordance; backend
  tests for the revision-content endpoint including traversal rejection, binary,
  and deleted-file cases.
- `./dev.py check` clean.

## Spec work

No `specs/` entry exists for the diff viewer today (`REQ-DIFF-*` does not exist).
This adds a `specs/diff-review/` requirements + executive pair covering the
expansion behaviour, since expansion introduces a real state model (per-gap
reveal state, truncation interaction) that future work will need to honour.
