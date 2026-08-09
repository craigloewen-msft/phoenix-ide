# Vim-style count prefix in diff review: `144c` comments on line 144

## Problem

The review surfaces (`DiffView` for the whole-branch diff, `FileReviewDiffView`
for the per-file review diff) already have a vim-style keymap: `j/k`, `Ctrl+d/u`,
`gg/G`, `]f/[f`, `m`, `c`, `R`, `q`, `?`. But `c` only annotates the *file*.
Annotating a specific line requires the mouse (gutter `+` or a line click).

A reviewer reading a diff knows the line number they want to talk about — it's
printed in the gutter. They should be able to type `144c` and get the annotation
dialog anchored to line 144 of the file under the cursor.

## Behaviour to add

- **Digits accumulate a count.** Typing `1`, `4`, `4` builds a pending count of
  `144`. A leading `0` is not a count (reserved / ignored) — `0` is only
  meaningful as a subsequent digit.
- **`c` with a pending count** opens the annotation dialog anchored to that line
  of the file the review cursor is on, exactly as a gutter click would (same
  quoted line content, same `newLine`/`oldLine` anchor resolution), and scrolls
  the line into view.
- **`c` with no count** keeps its current meaning: a file-level note.
- **Any other key clears the count** (neovim semantics). An unrecognised key
  clears it too. The count is *not* consumed by the multi-key prefixes
  (`g`/`[`/`]`); starting a prefix clears the count rather than composing with
  it — no `3]f` in this change.
- **The pending count is visible.** Invisible modal state is a bug generator;
  render it in the viewer shell (same banner slot as `keyboardNotice`, e.g. a
  small right-aligned `144` indicator) so the reviewer can see what they've
  typed. Unlike the prefix, the count has **no expiry timer** — it is cleared by
  the next non-digit key or by leaving/blurring the surface.
- **Line not in the diff** (a number outside every rendered hunk for that file):
  no dialog; set `keyboardNotice` explaining it, consistent with REQ-RV-010's
  "report why the command had no effect" clause for untracked files.

Optional, decide during implementation (cheap once the count exists, and both
are what a vim user will try next):

- `{count}j` / `{count}k` — scroll N lines.
- `{count}G` — jump the viewport to that line instead of the bottom.

If they land, they must land in `REVIEW_BINDINGS` too.

## Implementation sketch

**`ui/src/components/viewer/reviewKeymap.ts`** (pure, the source of truth)

- Add `{ kind: 'annotate-line'; lineNumber: number }` to `ReviewCommand`.
- Replace the resolver's `prefix: ReviewKeyPrefix | null` parameter with a small
  pending-state record (`{ prefix: ReviewKeyPrefix | null; count: number | null }`)
  so count and prefix are one value with one clearing rule rather than two
  parallel pieces of state in the hook.
- Resolution gains a `pending` variant carrying the new state (digits →
  `count * 10 + digit`).
- `isReviewKeyCandidate` is derived from the resolver, so digits become
  candidates automatically — but check the enumeration of "all prefixes" still
  covers the new state space (it must include a non-null count so `c` is a
  candidate under both meanings; it already is).
- Add `REVIEW_BINDINGS` row: `{N}c` — *Add a note on line N of the current file*.

**`ui/src/components/viewer/useReviewKeyboard.ts`**

- Hold the combined pending state. Keep the existing 1s expiry for a held
  *prefix*; do not expire a count.

**`ui/src/components/viewer/PhoenixDiffCodeView.tsx`**

- Extend `PhoenixDiffCodeViewHandle` with something like
  `annotateLine(itemId: string, lineNumber: number): boolean` — it owns the
  parsed `FileDiffMetadata`, so it can reuse `lineTextAt` /
  `resolveDiffAnchorLine` (prefer the additions side, fall back to deletions)
  and route through the existing `annotateLine` callback, then scroll to the
  line. Returns false when the line isn't in any hunk so the caller can post the
  notice. Do **not** re-parse the diff in the caller — the wrapper is the single
  owner of the parse (see the `files` memo comment).

**`DiffView.tsx`** — handle `annotate-line` using `cursorFile.itemId`; notice
when there is no cursor file or the handle reports the line is absent.

**`FileReviewDiffView.tsx`** — same, for its single item.

## Specs

- `specs/iterative-review/requirements.md` REQ-RV-010: the enumerated keyboard
  capabilities say "annotate the current file"; extend to annotating a named
  line, and state the count semantics (accumulates on digits, cleared by any
  other key, visible while pending) in timeless form. Add a short design note on
  why the count has no expiry while the prefix does.
- `specs/iterative-review/executive.md`: update the REQ-RV-010 / REQ-RV-012 rows'
  anchors if the resolver signature changes.

## Tests

- `reviewKeymap` unit tests: digit accumulation, `144c` → `annotate-line 144`,
  bare `c` → `annotate-file`, `1` then `j` → scroll (count cleared, no repeat
  unless the optional `{count}j` lands), `1` then `g` → prefix pending with count
  cleared, unrecognised key clears count.
- `DiffView.keyboard.test.tsx` and `FileReviewDiffView.keyboard.test.tsx`:
  typing `4` `2` `c` opens the annotation dialog labelled for line 42 with the
  right quoted content; an out-of-hunk number shows the notice instead.
- Help panel test: the new binding appears in the "Diff Review" group (the guide
  is generated from `REVIEW_BINDINGS`, so this should be automatic).

## Out of scope

- Counts for file motions (`3]f`), registers, or any other vim mode machinery.
- Changing the annotation dialog itself.
