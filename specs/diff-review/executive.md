# Diff Context Expansion — Executive Summary

## Scope and Boundary

This spec governs **revealing unmodified file context around diff hunks** in the
review surface — the GitHub-style "show more lines" affordance — and, centrally,
the guarantee that revealed lines belong to the versions of the file the diff was
computed against.

**In scope:**
- The expand affordance on hunk separators and its bounded/whole-region reveal
- Resolution of file content by blob object id, and hash verification of the
  working-tree side that has no stored blob
- The closed set of reasons a file side may be unavailable for expansion
- Suppression of expansion for truncated diff sections
- Preservation of line numbers, note anchors, find, and keyboard targets across
  expansion

**Owned by other specs:**
- `specs/api/` — the HTTP router and handler registration
- `specs/iterative-review/` — the per-file review manifest and review marks
- The diff capture itself (`capture_branch_diff`), including its size caps

## Current Reality

Expansion is served by `POST /api/conversations/:id/diff/expansion`, which
resolves a batch of `(path, prev_object_id, new_object_id, section)` triples to
file contents. Committed-section sides and the uncommitted old side are read
from the object database by id (`read_blob_by_oid`); the uncommitted new side is
the working tree, so it is read and hash-verified against the recorded id
(`read_worktree_file_verified`).

On the client, `buildSectionItems` retains each file's patch slice and blob ids,
`useDiffExpansion` fetches contents for them, and `hydrateItem` re-parses the
patch with contents attached to produce a non-partial item. `@pierre/diffs` then
renders and drives the expansion itself. Hydration re-verifies that the result
agrees with the patch and falls back to the partial item otherwise, so a fault
anywhere in the chain degrades to "no expansion" rather than to wrong context.

Both review surfaces supply expansion contents: the whole-branch diff
(`DiffView`) and the per-file review diff (`FileReviewDiffView`), which is what
a reviewer works in under review focus and in the file viewer's DIFF mode.

Which resolution route a request asks for is stated by the caller
(`useDiffExpansion`'s `route`) rather than inferred from the file's diff section,
because the two questions come apart. The whole-branch diff answers them the
same way. The per-file review diff does not: its full scope compares the merge
base against the working tree, whose new side is generally not in the object
database and must be hash-verified, so it takes the `uncommitted` route; its
since-review scope compares two stored blobs and takes the `committed` one.

`lineTextAt` resolves lines outside every hunk for hydrated files, which is what
lets notes on revealed context lines quote their source text.

## Verification

| Requirement | Surface | Covered by |
|---|---|---|
| REQ-DIFFEXP-001 | Pierre hunk separators, `expansionLineCount` | Verified in-browser against the seeded long-file fixture on both the whole-branch and per-file surfaces: head/tail/middle regions, bounded reveal, and whole-region expand |
| REQ-DIFFEXP-002 | `read_blob_by_oid`, `read_worktree_file_verified`, `hydrateItem` | `read_blob_by_oid_returns_committed_content`, `read_worktree_file_verified_returns_content_when_hash_matches`, `read_worktree_file_verified_refuses_content_that_moved_on`, `read_worktree_file_verified_accepts_abbreviated_oid`, `hydrateItem` refusal tests |
| REQ-DIFFEXP-003 | `ExpansionUnavailable`, `DiffExpansionSide` | `read_blob_by_oid_reports_absent_side_for_null_oid`, `read_blob_by_oid_reports_missing_object`, `read_blob_by_oid_reports_binary`, `read_worktree_file_verified_reports_absent_side_for_null_oid` |
| REQ-DIFFEXP-004 | `useDiffExpansion`, `hydrateItem` fallback | Hydration-refusal tests; `leaves contents empty when the fetch fails`, `still renders the diff when expansion content cannot be fetched` |
| REQ-DIFFEXP-005 | `useDiffExpansion` truncated-section gate | `does not request files from a truncated section`, `requests nothing when every section is truncated`, `does not request expansion for a truncated diff` |
| REQ-DIFFEXP-006 | `hydrateItem`, `lineTextAt` | `keeps the item id and line numbering the notes are anchored to`, `lineTextAt — expanded context lines` suite; annotation on a revealed line verified in-browser on both surfaces |
| REQ-DIFFEXP-007 | `read_worktree_file_verified` containment check | `read_worktree_file_verified_rejects_path_escaping_the_worktree`, `read_worktree_file_verified_rejects_symlink_escaping_the_worktree` |
| Expansion route per review scope | `useDiffExpansion` `route`, `FileReviewDiffView` | `resolves the full diff against the working tree, since its new side is not a stored blob`, `resolves the since-review diff from the object database, where both its blobs live` |

## Known Gaps

- The expand affordance is driven by pointer interaction only. The review
  keymap (`useReviewKeyboard`) has no binding for it, so expansion is not
  reachable from the keyboard.
- A file whose patch carries no `index` line (and therefore no blob ids) is
  never expandable. This is deliberate — see ADR-027 — but means expansion is
  unavailable for diffs from sources that omit index lines.
