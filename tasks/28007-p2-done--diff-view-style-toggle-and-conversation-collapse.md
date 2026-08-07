# Diff view: shared inline/side-by-side toggle + collapse the conversation while reviewing

Two small UX gaps in the new review/diff surfaces:

1. The whole-branch `DiffView` has a unified↔split toggle, but the per-file review diff
   (`FileReviewDiffView`) hardcodes `diffStyle="unified"` — reviewing file-by-file gives
   you no side-by-side option, and the two surfaces don't share a preference.
2. In the desktop split pane the conversation column always keeps its share of the width.
   While reviewing files and diffs the user wants maximum screen space.

## Scope

### A. Shared diff-style preference

- Extract the `DiffStyle` type, the `phoenix-diff-style` localStorage key, the initial-read
  helper, and the toggle into a small `ui/src/components/viewer/useDiffStyle.ts` hook
  (returns `{ diffStyle, toggleDiffStyle }`), plus a shared `DiffStyleToggleButton`
  (Columns2 / Rows3 icon button, current aria-label/title wording preserved).
- `DiffView` uses the hook instead of its local `useState` + `toggleDiffStyle` +
  `initialDiffStyle` (behaviour unchanged, same key, same button markup).
- `FileReviewDiffView` uses the same hook, renders the toggle in its `headerExtras`
  alongside the existing scope controls, and passes `diffStyle` to `PhoenixDiffCodeView`
  instead of the hardcoded `"unified"`.
- One persisted preference across both surfaces (same localStorage key), so a user who
  picks side-by-side once gets it everywhere.
- Check the existing `key={`${path}:${scope}`}` remount on `FileReviewDiffView`'s
  CodeView: a style switch must not need a remount (Pierre takes `diffStyle` via
  options), but verify the switch actually re-renders the pane; if Pierre needs it,
  include `diffStyle` in the key rather than adding DOM pokes.

### B. Collapse the conversation while reviewing (explicit header toggle)

Desktop split-pane only (`showSplitPaneViewer`), no click-anywhere behaviour.

- `ConversationPage` owns a `reviewFocus` boolean (component state; not URL — it is a
  transient layout preference, and the viewer slot's `presentation` already owns the
  durable pane/fullscreen distinction). Reset it when the viewer slot closes or the
  split pane stops being shown, so a reopened viewer never starts in a stale collapsed
  layout.
- When on: `.conversation-column` is hidden and `--viewer-pane-width` is driven to the
  full width (add an `#app.app-split-pane--review-focus` rule in `index.css` rather than
  a second imperative writer on the CSS var — the existing var has exactly two writers
  by design and that invariant should hold).
- The divider is hidden (or disabled) while focused so a drag can't leave the layout in
  an inconsistent state.
- Plumb `reviewFocus` + `onToggleReviewFocus` through `ConversationDiffViewer` into
  `DiffView` as optional props; render a `Maximize2`/`Minimize2` header button
  ("Collapse conversation" / "Show conversation") in `headerExtras`, only when the
  handler is supplied (i.e. inline pane mode). Overlay/takeover diff already owns the
  screen and gets no button — enforce that structurally by not passing the prop.
- Same treatment for `FileReviewDiffView` when it is rendered inline, so the per-file
  review path gets the same affordance.

## Non-goals

- No change to viewer-slot URL params, presentation semantics, or the fullscreen
  takeover path.
- No auto-collapse on click into the pane.

## Tests

Affected paths only (no full suite):

- `ui/src/components/viewer/DiffView.test.tsx` — toggle still switches style; new
  conversation-collapse button appears only when the handler is passed.
- `ui/src/components/viewer/ConversationDiffViewer.test.tsx` — props threading.
- New/updated coverage for `FileReviewDiffView` style toggle + shared preference.
- Run `pnpm vitest run` scoped to `ui/src/components/viewer/`, plus `tsc`/eslint on the
  touched files.

## Spec follow-up

`specs/iterative-review/` REQ-RV-006 describes per-file review rendering; add a short
requirement for the rendering-style choice and the review-focus collapse, and update
`executive.md` coverage rows.
