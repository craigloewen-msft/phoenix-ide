# Expand unmodified context in the per-file review diff (focus mode)

## Problem

The GitHub-style "reveal unmodified lines" affordance on hunk separators works in
the whole-branch diff (`DiffView`) but is absent in the per-file review surface
(`FileReviewDiffView` — what a reviewer sees in focus mode, and via
`FileViewer` DIFF mode). Clicking the separator does nothing because no expander
is drawn there.

Cause: both surfaces render the same `PhoenixDiffCodeView`, which already accepts
`expansionContents` and `onExpandableFilesChange` and drives hydration via
`hydrateItem`. `DiffView` wires those props to `useDiffExpansion`;
`FileReviewDiffView` passes neither, so every item stays `isPartial` and Pierre
renders a plain `line-info` separator with no reveal control.

This is a wiring gap, not a missing capability — the server endpoint
(`POST /api/conversations/:id/diff/expansion`), the blob-id addressing, the
hydration verification, and the note/line-number preservation all already exist
and are covered by `specs/diff-review/`.

## Plan

1. **Wire expansion into `FileReviewDiffView`** (`ui/src/components/viewer/FileReviewDiffView.tsx`):
   - Add `const [expandableSources, setExpandableSources] = useState<readonly SectionFileSource[]>([])`.
   - Call `useDiffExpansion({ conversationId, sources: expandableSources, truncatedSections })`.
   - Pass `expansionContents` and `onExpandableFilesChange={setExpandableSources}`
     to `PhoenixDiffCodeView`.

2. **Get the section right.** `PhoenixDiffCodeView` is fed the file diff as
   `committedDiff`, so parsed sources carry `section: 'committed'` — but the two
   review scopes have different content routes on the server:
   - `scope=full` → `git diff <merge-base> -- <path>`: old side is a stored blob,
     **new side is the working tree**, which is the `uncommitted` resolution
     route (`read_worktree_file_verified`). Requesting it as `committed` will
     resolve `object_missing` for the new side whenever the working-tree blob was
     never written to the ODB, and expansion silently won't appear.
   - `scope=since_review` → blob-to-blob diff between the checkpoint blob and
     `current_blob_sha`; `current_blob_sha` is produced by `hash-object -w`, so
     **both** sides are in the ODB → the `committed` route is correct.

   So the request section must be derived from the review scope, not from the
   `committedDiff` prop slot. Preferred shape (correct-by-construction): let the
   caller state the expansion route explicitly rather than having it inferred
   from which prop the diff text arrived in — e.g. an optional
   `expansionSection?: DiffExpansionSection` on `PhoenixDiffCodeView` (or on the
   `useDiffExpansion` args) that overrides the section attached to published
   sources. Verify the blob-to-blob patch's `index` line survives
   `relabel_blob_diff` (it does — only `diff --git`/`---`/`+++` are rewritten) so
   `buildSectionItems` still records both object ids.

3. **Respect truncation** (REQ-DIFFEXP-005): `ReviewFileDiffResponse` carries
   `truncated_kib` / `saturated`. When `shown.truncated_kib !== undefined`, mark
   the section truncated so expansion is suppressed, mirroring `DiffView`.

4. **Remount/refetch hygiene:** the `key={path}:{scope}` remount plus
   `useDiffExpansion`'s clear-then-fetch already prevent one scope's contents
   hydrating the other's patch; confirm with a test rather than by inspection.

## Verification

- Unit tests in `ui/src/components/viewer/FileReviewDiffView.test.tsx`:
  - publishes expandable sources and requests expansion with the section implied
    by the current scope (`uncommitted` for `full`, `committed` for `since_review`);
  - requests nothing when the response is truncated;
  - renders unchanged when the fetch fails (REQ-DIFFEXP-004).
- In-browser check against a seeded long-file fixture: open a file in review /
  focus mode, click a hunk separator, confirm bounded reveal, shift-click
  whole-region reveal, and that a note taken on a revealed line anchors correctly
  (REQ-DIFFEXP-006).
- `./dev.py check`.

## Spec updates

- `specs/diff-review/executive.md`: Current Reality currently describes only the
  whole-branch surface; state that the per-file review diff also supplies
  expansion contents, and record how the expansion section is chosen per review
  scope. Add the new tests to the verification table.
- `specs/diff-review/requirements.md` is surface-agnostic and needs no change;
  if the scope→section mapping turns out to be a real design decision worth
  preserving, add a short ADR under `specs/adrs/` rather than a code comment.

## Out of scope

- Keyboard-driven expansion (listed as a known gap in `specs/diff-review/executive.md`).
- Files whose patch carries no `index` line — still non-expandable by design (ADR-027).
