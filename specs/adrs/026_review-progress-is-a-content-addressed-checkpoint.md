# ADR-026: Review progress is a content-addressed checkpoint, not the git index

- **Status:** Accepted
- **Date:** 2026-01-06
- **Affects:** REQ-RV-001 … REQ-RV-009

## Context

Reviewing an agent's work is iterative: the user reads a diff, comments, asks for
fixes, and then needs to see *what changed since they last looked* rather than
re-reading the whole diff. Doing this by hand, developers use `git add` as a
review ledger — staged content is "what I already read", and `git diff` shows
only what arrived after. It works because the index stores content, so it
survives the rewrites that follow.

Phoenix cannot adopt that mechanism directly. The index is a single shared
resource, and in Phoenix the agent is also using it: it stages and commits
throughout the same period the user is reviewing. Making review own the index
would either break the agent's ability to commit or let the agent's commits
silently destroy review state.

The forces: review progress must survive commits, amends, and rebases (an agent
rewrites history routinely); it must be per-file and comparable to current
content; and it must leave the agent's normal git workflow untouched.

## Options considered

1. **Use the real git index** — stage a file to mark it reviewed. Matches the
   habit exactly and requires no new storage. But it takes the index away from
   the agent: `git commit` would sweep up whatever the user had "reviewed", and
   an agent's `git add` would silently mark files as reviewed that the user never
   opened. The two writers cannot be separated, because the index has no notion
   of who staged an entry.

2. **A Phoenix-owned second index via `GIT_INDEX_FILE`** — keep a private index
   file holding reviewed content. Preserves index-like semantics and leaves the
   real index alone. But it inherits the index's operational baggage for no
   benefit: lockfiles, a file whose lifetime must be tied to a worktree that can
   be deleted, and a format that must stay coherent with a working tree it does
   not track. It also answers a question we never ask — the index is optimised
   for building a commit, and review never builds one.

3. **Content-addressed checkpoints in Phoenix's own storage** — on marking a file
   reviewed, record the blob SHA of the content the user saw. "Reviewed" is a row;
   "stale" is a SHA mismatch; "what's new" is a blob-to-blob diff.

## Decision

Option 3. Replicate the *semantics* of the `git add` ledger without borrowing the
mechanism.

A checkpoint stores `(work_scope, file_path) -> reviewed_blob_sha` plus the
comparator it was taken against. This wins because content-addressing is exactly
the property that made the index work for this purpose in the first place, and it
is the *only* property needed. Keying on content rather than on a ref or an index
entry means a checkpoint survives commit, amend, rebase, and stash for free — the
blob hash of unchanged bytes does not move. Nothing about the agent's git usage
can disturb it, because review never reads or writes the index or any ref.

Marking is compare-and-set against the client's observed blob: if the file changed
between render and click, the mark is rejected rather than recording that the user
reviewed bytes they never saw.

The blob is written to the object database with `git hash-object -w`. This is the
one piece of git state review does create, and it is deliberate: the since-review
diff must be able to read the checkpointed content on a later turn. A loose object
is invisible to `git status`, unreferenced by any ref, and collectable by `git gc`
once no checkpoint points at it.

## Consequences

- **Positive:** the agent's index and commit workflow are entirely unaffected —
  the user can review while the agent commits, and neither disturbs the other.
  Review state survives history rewrites, which an agent performs routinely.
  "Reviewed", "stale", and "what changed since" all reduce to comparing two SHAs.
- **Positive:** review state is queryable relationally — progress counts and
  "which files are outstanding" are SQL, not git plumbing.
- **Negative:** review state is Phoenix-local. A user who reviews in Phoenix and
  then inspects the repository with plain git sees no trace of their progress;
  there is no `git status` equivalent for "reviewed".
- **Negative:** checkpointed blobs are loose objects with no ref keeping them
  alive. An aggressive `git gc --prune=now` between turns can collect a
  checkpointed blob, which degrades the since-review diff for that file.
- **Neutral:** checkpoints are scoped to a work scope and die with it, including
  on re-scope. Review is meaningful only against the body of work it was
  performed on, so carrying it across a base-branch change would be wrong.

## References

- `specs/iterative-review/requirements.md` — REQ-RV-001 … REQ-RV-009.
- `specs/iterative-review/iterative-review.allium` — the checkpoint lifecycle.
- Code: `git_ops::review::current_blob_sha`, `git_ops::review::file_diff_since_review`,
  `Database::upsert_review_checkpoint`, `resolve_review_state`.
- `specs/work-lifecycle/` — work scope termination, which cascades checkpoints away.
