# ADR-027: Expanded diff context is addressed by blob object id

- **Status:** Accepted
- **Date:** 2026-06-08
- **Affects:** REQ-DIFFEXP-001 … REQ-DIFFEXP-007

## Context

The diff review surface renders `git diff` output, which carries three lines of
context around each change. Reviewers routinely need more — to see the enclosing
function, or what a changed line sits between — and today must leave the viewer
to get it.

Phoenix renders diffs through `@pierre/diffs`, which already implements this
affordance: `DiffHunksRenderer` draws expand controls into its hunk separators
and owns the reveal interaction. It gates them on `FileDiffMetadata.isPartial`,
which `processFile` clears only when handed both file sides in full. So the
capability exists; what is missing is the file content that unlocks it.

That content is where the decision lies. Pierre applies supplied contents
without validating them against the patch. Contents drawn from a *different*
version of the file produce hunk offsets that point at the wrong lines, with no
error raised — a diff that renders confidently and shows context lines that do
not belong to it. Since a reviewer's whole purpose is deciding whether code is
correct, context that silently lies is worse than no expansion at all.

The naive source of that content — read the file at `<rev>:<path>` — is exactly
the unsafe one: an agent editing the worktree during review, or a branch moving
under a stale viewer, both yield a successful read of the wrong bytes.

## Options considered

1. **Re-derive context in Phoenix by splicing the unified diff** — fetch the
   surrounding lines, rewrite `@@` headers, merge hunks as gaps close, and feed
   the augmented patch through the existing parse. Keeps Phoenix in control of
   the format, but reimplements — less well — logic the pinned dependency
   already ships, and puts a bespoke hunk-arithmetic layer on the path of every
   note anchor.
2. **Read file content by path at a revision** (`git show <rev>:<path>`) — the
   obvious source, and correct whenever the file has not moved. But nothing in
   the value ties it to the diff, so "unchanged since capture" becomes an
   assumption the code cannot check, and violating it is silent.
3. **Read file content by blob object id**, taken from the `index <old>..<new>`
   line the diff already carries. The id is a hash of the bytes, so a successful
   lookup cannot return content that disagrees with the diff that named it.

## Decision

Option 3: expanded context is addressed by blob object id, never by path plus
revision.

The object id is not merely *an* identifier for the content — it is derived
from the content, which is what makes the guarantee structural rather than
procedural. There is no window in which the id resolves to the wrong bytes,
so no staleness check, cache invalidation, or ordering discipline is needed to
make expansion trustworthy; correctness does not depend on anyone remembering
to verify.

The working tree is the one side with no stored blob (the uncommitted section's
new side). It is therefore read and hashed, and the hash must equal the id the
diff recorded — the same guarantee reached by a different route. A mismatch is
reported as `ContentMoved` and expansion is refused for that file.

Unavailability is modelled as a typed enum rather than an absent value, so a
file that cannot be expanded always carries why (binary, oversized, side absent,
object missing, path escaping the worktree, content moved). This keeps "nothing
to show" distinguishable from "we failed to fetch".

Because Pierre's expansion is driven entirely from a non-partial parse of the
*same patch text*, hunk offsets and line numbers are produced by the same parser
as before. Note anchors, find, and keyboard navigation are unaffected by
construction rather than by careful re-derivation.

## Consequences

- **Positive:** context that disagrees with the diff is unrepresentable, not
  merely unlikely. Expansion needs no cache-invalidation or staleness protocol.
  Phoenix ships no hunk-splicing code, and the review affordance tracks upstream
  improvements to Pierre's renderer for free.
- **Positive:** expansion is strictly additive — a file whose contents cannot be
  resolved renders exactly as it did before, so every failure mode degrades to
  the prior behaviour rather than to a broken view.
- **Negative:** files whose patch carries no `index` line cannot be expanded at
  all, since there is no id to address. This is accepted over falling back to a
  path read, which would reintroduce the silent-mismatch failure for exactly the
  cases the id was protecting.
- **Negative:** expansion sends whole files over the wire, bounded by a size cap,
  where a line-range protocol would send less. The whole-file shape is what
  Pierre's parser requires, and the cap bounds the cost.
- **Neutral:** truncated diff sections are excluded from expansion. Their patch
  text is incomplete, so a whole-file parse would disagree with it and be
  rejected by verification regardless.

## References

- `specs/diff-review/requirements.md` — REQ-DIFFEXP-001 … 007.
- `read_blob_by_oid`, `read_worktree_file_verified`, `ExpansionUnavailable` —
  the server-side resolution and its typed outcomes.
- `hydrateItem`, `buildSectionItems` — the client-side re-parse and the
  verification that a hydrated file agrees with its patch.
- `@pierre/diffs` `DiffHunksRenderer` (`isExpandable: !fileDiff.isPartial`) and
  `processFile` — the upstream behaviour this decision unlocks.
- ADR-028 refines how the addressed content is fetched, without changing this
  addressing decision.
