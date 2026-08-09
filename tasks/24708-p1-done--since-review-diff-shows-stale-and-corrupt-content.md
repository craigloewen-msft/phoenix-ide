# Fix the since-review diff: stale content after an agent edit, wrong-scope render on toggle, and header relabelling that corrupts content lines

The user reports that "diff view since last review" does not change correctly when
clicked, and shows wrong information afterwards. Both symptoms reproduce. There
are three independent defects, verified against the running dev server and the
seeded `add-maintainable-testing-and-seed-data` conversation
(`97be7fa6-3e5b-46be-a9b7-d4aeba757d5f`).

The backend `since_review` payload is *correct* for the simple case — I confirmed
`GET …/review/file-diff?path=docs/TESTING.md&scope=since_review` returns the
5-line post-checkpoint delta (849 bytes) while `scope=full` returns the whole
245-line file (8982 bytes). The failures are elsewhere.

---

## Defect 1 — the open diff never refetches when the agent edits the file (primary)

`FileReviewDiffView` fetches on:

```ts
const reviewedBlob = review.kind === 'unreviewed' ? null : review.at_blob;
useEffect(() => { … api.getReviewFileDiff(conversationId, path, scope, …) … },
  [conversationId, path, scope, reviewedBlob, reloadToken]);
```

`reviewedBlob` is the **checkpoint** side of the comparison. When the agent edits
the file, the *current* side changes and the checkpoint does not — so the effect
never refires and the rendered diff keeps answering the previous turn's question.
The comment above it ("Refetch when the file's reviewed blob changes: after
marking, the since-review diff has a new baseline") describes the one case it
*does* cover and misses the case the whole feature exists for.

**Reproduced.** With `AGENTS.md` open in DIFF mode, scope = since-review, state
`reviewed`; I then made the manifest report the file as the agent had edited it
(`current_blob` changed, `at_blob` unchanged) and called
`ReviewContext.refresh()` — the same call the working→idle edge makes:

| | before | after |
|---|---|---|
| sidebar marker | `cfr-marker--reviewed` | `cfr-marker--stale` ✓ |
| header action | `✓ Reviewed` | `Mark reviewed` ✓ |
| **diff body** | `Nothing changed since you reviewed this file.` | **unchanged — still says it** ✗ |
| **diff refetches** | — | **0** ✗ |

Control: mutating `at_blob` instead *did* fire
`path=AGENTS.md&scope=since_review`, confirming the dependency tracks the wrong
side of the diff.

Same failure on the `full` scope (`docs/TESTING.md`: manifest went stale, 0
refetches, body unchanged) — this is not a since-review-only bug, but it is worst
there because the surface asserts a *negative* ("nothing changed") that is false.

Secondary consequence: the header offers `Mark reviewed`, which posts the stale
`data.current_blob_sha`, so the server correctly 409s
(`review_target_changed`). The user is told the file changed under them while the
viewer insists nothing changed.

**Fix.** The since-review diff is a function of *both* blobs, so the fetch must
depend on both. Add the current-content side to the dependency — the manifest
already carries it (`ReviewFileEntry.current_blob_sha`, and
`FileReviewState::ReviewedStale.current_blob`). Prefer threading the manifest
entry's `current_blob_sha` into `FileReviewDiffView` as an explicit prop over
re-deriving it from the `review` union, so "which content is this diff of" is a
single typed value rather than a case analysis that can miss an arm.

**Spec.** REQ-RV-011 covers refresh-on-request and refresh-on-window-focus but
not the in-Phoenix case where the agent edits a file the user has open. The
manifest already refreshes on the working→idle edge (`ReviewProvider`); the
rendered diff must follow it. Add that obligation to REQ-RV-011 (or REQ-RV-007)
rather than leaving it as an emergent property of a dependency array.

---

## Defect 2 — the previous scope's content renders under the new scope

```jsx
{loading && !data ? <spinner/> : error ? … : !data?.diff.trim() ? <empty/>
  : <PhoenixDiffCodeView key={`${path}:${scope}`} committedDiff={data.diff} … />}
```

On a scope toggle, `scope` flips immediately but `data` still holds the previous
scope's response. The `loading && !data` guard is false, so the old diff is
rendered — and remounted under the *new* scope's key.

**Reproduced.** Clicking `Since review` on `docs/TESTING.md`: the button
immediately read `Full diff` (effective scope = since-review) while the rendered
virtualizer height stayed `4952px` — the 245-line **full** diff. The since-review
render is `312px`. With the endpoint delayed to 3s the wrong-scope content stayed
on screen for the whole fetch, with no spinner. This is the "doesn't change
correctly when I click it" symptom.

The empty branch inverts the same lie: toggling *away* from a since-review diff
that was empty briefly renders `No changes vs main.` for a file with 245
insertions.

**Fix.** Make "data that belongs to a different scope" unrepresentable rather
than merely unlikely. The server already echoes `path` and `scope` in
`ReviewFileDiffResponse`, so hold the response in state and render only when its
`scope`/`path` match the requested ones; otherwise fall through to the loading
state. Clearing `data` at the top of the effect also works but re-introduces a
flash on refetch — prefer the typed match.

---

## Defect 3 — `relabel_blob_diff` rewrites content lines, not just headers

`crates/phoenix-ide/src/git_ops/review.rs`:

```rust
for line in captured.stdout.lines() {
    if line.starts_with("--- ") { let _ = write!(out, "--- a/{path}"); }
    else if line.starts_with("+++ ") { let _ = write!(out, "+++ b/{path}"); }
    else if line.starts_with("diff --git ") { … }
    else { out.push_str(line); }
    out.push('\n');
}
```

The loop runs over the **whole diff**, not the header. In a unified diff a
removed line is its source text prefixed with `-`, so a removed line reading
`-- foo` is emitted as `--- foo` and is silently replaced with `--- a/<path>`.
Likewise an added line reading `++ foo` becomes `+++ b/<path>`.

This is reachable in ordinary code: SQL, Lua, Haskell, Ada and SPARK comments all
begin `-- `, as do this repo's own `.allium` specs (`-- @guidance`, `-- IR 1.`).
The seeded `admin-volunteers-tab-components` worktree already contains such
lines — `migrations/0015_volunteers_and_clients.sql` has 9+ lines matching
`^[+\- ]-- `. Any of them removed after a checkpoint would render as the file
path instead of the deleted text.

`relabel_blob_diff` is called only from `file_diff_since_review`, so the full diff
is unaffected — which is exactly the reported shape: correct until you switch to
since-review.

Two smaller losses in the same loop: `str::lines()` strips a trailing `\r`, so a
CRLF file's since-review diff is silently converted to LF; and `push('\n')` runs
unconditionally, appending a newline the capture may not have had.

**Fix.** Relabel only the header. A blob-to-blob diff has exactly one file
section, so tracking whether the first `@@ ` hunk header has been passed is
sufficient — after it, copy lines verbatim. Split on `\n` (retaining `\r`) rather
than using `.lines()`, and preserve the presence or absence of the final newline.
The existing `total_bytes` shift must stay so a complete diff is still not
reported as truncated.

**Tests.** `git_ops::review::tests` — a since-review diff of a file whose removed
line is `-- a comment` must keep that text and must still carry exactly one
`--- a/<path>` header; a CRLF file must round-trip its line endings.

---

## Verification

- `./dev.py check`.
- New Rust tests above.
- New UI tests in `FileReviewDiffView.test.tsx`: (a) a manifest update that
  changes only the current blob triggers exactly one refetch for the open scope;
  (b) while a scope switch is in flight, the previous scope's diff is not
  rendered.
- Manual, against the seeded `add-maintainable-testing-and-seed-data`
  conversation: open `docs/TESTING.md` (state `reviewed_stale`), toggle
  `Since review` and confirm the rendered body changes on the first click with no
  interval showing full-diff content; mark it reviewed; edit the file in the
  worktree; confirm the open viewer moves to the new delta without a manual `R`.

## Spec updates

- `specs/iterative-review/requirements.md` — REQ-RV-011 (or REQ-RV-007) must
  require the rendered diff to follow a manifest change to the file's current
  content, not only an explicit refresh.
- `specs/iterative-review/executive.md` — the REQ-RV-007 and REQ-RV-011 rows read
  `✅ Complete`; re-derive them once the fix lands, and record the header-relabel
  constraint next to the `file_diff_since_review` anchor.
