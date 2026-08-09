# Remove the typed-count review UI and make "Since review" sticky

Two independent review-surface fixes.

## 1. Remove the pending line-number indicator

Typing digits on a review surface currently paints a banner at the top of the
viewer (`144` + `c to comment on this line`). Remove that surface.

**Changes**

- Delete `ReviewCountIndicator` from `ui/src/components/viewer/ReviewCountIndicator.tsx`
  and its `.review-count-indicator*` rules in `ReviewCountIndicator.css`. Keep
  `ReviewKeyboardNotice` and `.diff-keyboard-notice` — that is the "why did my
  key do nothing" message, unrelated.
- Drop the `pendingCount` banner branch in `DiffView.tsx` and
  `FileReviewDiffView.tsx`; the banner slot falls through to the find bar /
  keyboard notice as before.
- Stop returning `pendingCount` from `useReviewKeyboard`. The hook keeps the
  count in its ref (the `{n}c` behaviour is unchanged) but no longer needs the
  `useState` mirror — one less render per keystroke.
- Because the count is now invisible, give it the same expiry the multi-key
  prefix has: start `REVIEW_PREFIX_TIMEOUT_MS` on a pending count too, so a
  half-typed number cannot silently re-arm a later keypress.

**Spec**

`specs/iterative-review/requirements.md` REQ-RV-010 currently says the system
SHALL "display the count on that surface", with a Design paragraph explaining
why a count does *not* expire. Both become false. Update the requirement to
drop the display obligation and to state that a pending count expires like a
prefix, and rewrite the corresponding Design paragraph. Update the REQ-RV-010
row in `specs/iterative-review/executive.md` (drop the `ReviewCountIndicator`
anchor).

**Tests**

`ui/src/components/viewer/DiffView.keyboard.test.tsx` has
`shows the pending count while it is being typed` — replace it with a test that
`{n}c` still anchors the note and that no count UI is rendered.

## 2. "Since review" scope must stick across files

`FileReviewDiffView` owns the diff scope as `useState<ReviewDiffScope>('full')`.
Three consequences the user is hitting:

- **Lost per file.** The preference is component-local, and `FileViewer` drops
  back to source rendering (unmounting the diff view) whenever the open file
  isn't resolvable in the review manifest — so moving to another file resets to
  `full`.
- **Clobbered by the fallback effect.** `if (scope === 'since_review' &&
  !hasCheckpoint) setScope('full')` *writes* state, so any file without a
  checkpoint permanently discards the user's choice.
- **Toggle needs two clicks.** The first click's refetch races that reset +
  the `key={path:scope}` remount of `PhoenixDiffCodeView`, so the user lands
  back on the full diff and has to toggle again.

**Changes**

- Extract a `useReviewDiffScope()` hook beside `useDiffStyle.ts`, same shape:
  `localStorage`-persisted, shared by every review surface, so "Since review"
  is a standing preference rather than per-mount state. (`useDiffStyle` is the
  established precedent for a cross-surface viewer preference.)
- Replace the reset effect with a **render-time** derivation: the effective
  scope is `preference === 'since_review' && hasCheckpoint ? 'since_review'
  : 'full'`. A file with no checkpoint renders the full diff without
  overwriting the preference, so returning to a reviewed file shows the
  since-review diff immediately.
- Fetch and the `PhoenixDiffCodeView` key both use the effective scope, so a
  single click produces a single fetch and a single remount.
- Keep the `reviewed_stale` banner wording keyed off the effective scope.

**Tests**

- `FileReviewDiffView.test.tsx`: one click on `Since review` fetches
  `since_review` exactly once and renders it (no second click needed).
- Preference survives a remount with a different `path`, and a file with
  `review.kind === 'unreviewed'` renders `full` while leaving the stored
  preference intact.

## Verification

`./dev.py check`, plus a manual pass: mark a file reviewed, switch to
"Since review", walk to the next file with `]f` — the scope should still be
"Since review" wherever a checkpoint exists.
