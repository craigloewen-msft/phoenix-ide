# ADR-028: The expansion resolution route is stated by the caller, not inferred from the diff section

- **Status:** Accepted
- **Date:** 2026-01-15
- **Affects:** REQ-DIFFEXP-002, REQ-DIFFEXP-004

## Context

Expansion resolves a file's two sides by object id (ADR-027). The server has two
routes for doing so, chosen by a `section` field on each requested file:
`committed` reads both sides from the object database, while `uncommitted` reads
the new side from the working tree and hash-verifies it against the recorded id.

The whole-branch diff made these two questions look like one. Its committed
section really is blob-to-blob and its uncommitted section really is
blob-to-working-tree, so the section a file was parsed under also named the right
route, and `SectionFileSource.section` served as both.

The per-file review diff breaks that coincidence. It renders a single file
through the same wrapper, always in the committed slot, but its two scopes
compare different things: the full scope diffs the merge base against the working
tree, whose new side is generally not in the object database; the since-review
scope diffs two stored blobs. A section-derived route would ask the `committed`
route for a working-tree side and get `object_missing` — and because expansion
degrades silently by design (REQ-DIFFEXP-004), the affordance would simply not
appear, with nothing distinguishing that from a file that is legitimately not
expandable.

## Options considered

1. **Keep deriving the route from the file's section.** No new API surface, and
   correct for the whole-branch diff. But it is only correct there by
   coincidence, and it is silently wrong for any surface whose diff text arrives
   in a slot that does not describe how its content is stored — with no signal
   when it is wrong.
2. **Infer the route from the section slot plus the calling surface.** Keeps
   callers from having to think about it, but encodes each surface's quirk in
   shared mapping code, so a new surface is wrong by default until that code
   learns about it.
3. **Have the caller state the route.** The surface that chose the comparison
   also states how its sides are stored, since that is the same piece of
   knowledge. Costs one explicit parameter.

## Decision

The caller states the route, as an optional `route` on `useDiffExpansion` that
defaults to the file's own section.

The knowledge is the caller's: whichever code decided to diff a merge base
against a working tree, or one blob against another, is the only place that knows
how the resulting sides are stored. Deriving it downstream from the section slot
re-infers a fact that was already known upstream, and infers it from something
that does not actually carry it — the section names where a file sits in the
rendered diff, not where its bytes live. Defaulting to the section keeps the
whole-branch diff unchanged, since there the two genuinely coincide.

## Consequences

- **Positive:** a surface whose diff compares against the working tree gets
  working-tree verification regardless of which slot its text arrived in. The
  per-file review diff can offer expansion in both scopes.
- **Positive:** the failure this prevents is invisible by construction — silent
  loss of an affordance — so moving the choice to where the knowledge is beats
  relying on someone noticing it missing.
- **Negative:** a new expansion caller must now decide the route rather than
  inheriting a default that happens to be right. The default (the file's own
  section) softens this, but a caller in the per-file diff's position that
  ignores it is wrong silently, exactly as before.
- **Neutral:** `section` retains its rendering meaning; `route` is purely about
  content resolution. The two staying distinct is the point.

## References

- ADR-027 (Expanded diff context is addressed by blob object id) — this refines
  *how* the addressed content is fetched, not the addressing itself.
- `useDiffExpansion`, `FileReviewDiffView`, `get_conversation_diff_expansion`,
  `read_blob_by_oid`, `read_worktree_file_verified`.
- `specs/diff-review/`, `specs/iterative-review/`.
