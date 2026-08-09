# Review focus mode can blank the whole screen

## Symptom

During a review, with the split-pane diff open, clicking the focus button
("Collapse conversation", `ReviewFocusToggleButton`) sometimes leaves nothing on
screen but the page background. No conversation, no diff, no header, no way back
except the browser back button or a reload.

## Reproduced

Against the running dev UI at 1600x1000 (wide desktop), conversation
`fix-evidence-edit-button` (Work mode):

1. Open `?viewer=diff&presentation=pane`, click "Collapse conversation".
   State: `#app` = `app-split-pane app-split-pane--review-focus`,
   `.conversation-column` computed `display: none`, pane text length 365. Good.
2. While still focused, drive the viewer slot to a prose file that the review
   manifest does not resolve (`?viewer=prose&file=/nonexistent/x.md&root=/nonexistent&mode=diff`).
   State: still `app-split-pane--review-focus`, `.conversation-column` still
   `display: none`, but pane text length collapses to 30.
   Screenshot: empty background, no chrome, nothing clickable.

The same shape occurs transiently on a conversation switch that keeps
`?viewer=diff` in the URL: for a frame `#app` renders `app-split-pane` with a
30-character pane while the atom rehydrates.

## Root cause

Two different predicates decide two halves of one layout, and they are allowed
to disagree.

**Half 1 — hide the conversation.** `ui/src/pages/ConversationPage.tsx`:

```ts
const reviewFocusEligible = isWideDesktop && (paneDiffOpen || proseSlot?.mode === 'diff');
const reviewFocusActive   = reviewFocusEligible && reviewFocus;
```

driving `#app.app-split-pane--review-focus > .conversation-column { display: none }`
in `ui/src/index.css`.

**Half 2 — what actually renders in the pane.** A separate ordered ternary chain
inside `.conversation-viewer-pane`:

```tsx
paneDiffOpen && conversationId ? <ConversationDiffViewer/>
  : splitPanePrs ? <FileViewer/>
  : browserViewerOpen && conversationId ? …
  : inspectViewerOpen && inspectSlot ? …
  : messageViewerOpen && messageSlot ? …
  : commissionReviewViewerOpen && commissionReviewSlot ? …
  : null
```

The chain carries guards the eligibility predicate does not (`&& conversationId`,
`&& inspectSlot`, manifest resolution inside `FileViewer`), so the chain can
reach `null` while `reviewFocusActive` is still true. `showSplitPaneViewer` has
yet a third spelling of "a viewer is open", so the `--review-focus` class stays
applied. Column hidden + pane empty = blank screen.

Two concrete paths reach it, and both are ordinary review behaviour:

- **`paneDiffOpen` with `conversationId` undefined.** `reviewFocusEligible` and
  `showSplitPaneViewer` both accept bare `paneDiffOpen`; the render branch
  requires `conversationId` too. During conversation switch / cold reload / atom
  reset the id is briefly undefined and every later branch is false → `null`.
- **Prose diff mode whose file leaves the review manifest.** This is the
  reported trigger: the user is *editing* files mid-review. `FileViewer` renders
  `FileReviewDiffView` only when `review?.conversationId && repoRelativePath &&
  reviewEntry` all hold; when the manifest refreshes and the entry no longer
  matches (renamed, reverted, moved out of the change set) it falls through to a
  near-empty shell while `proseSlot.mode === 'diff'` keeps focus latched on.

`reviewFocus` is latched `useState` reset only by `!reviewFocusEligible`, so it
survives these transitions rather than failing safe.

## Fix

Make "the conversation column is hidden" derive from the *same value* that
decides the pane's content, so the blank state is structurally unrepresentable
(correct-by-construction, per AGENTS.md).

1. In `ConversationPage`, compute the pane's content once as a discriminated
   value instead of an inline ternary chain:

   ```ts
   type PaneContent =
     | { kind: 'diff'; conversationId: string }
     | { kind: 'prose'; file: OpenFileState; mode: FileViewMode }
     | { kind: 'browser'; conversationId: string }
     | { kind: 'inspect'; handleId: string }
     | { kind: 'message'; slot: … }
     | { kind: 'commission-review'; slot: … };

   const paneContent: PaneContent | null = …;   // one place, all guards
   ```

2. Derive both halves from it:
   - `showSplitPaneViewer = isDesktop && isWideDesktop && paneContent !== null`
   - `reviewFocusEligible = isWideDesktop && paneContent !== null &&
      (paneContent.kind === 'diff' || (paneContent.kind === 'prose' && paneContent.mode === 'diff'))`

   The `&& conversationId` / `&& inspectSlot` guards move into `paneContent`'s
   construction and stop being duplicated (and mis-duplicated) at three sites.

3. Render the pane by switching on `paneContent.kind`. The `null` case no longer
   coexists with the `--review-focus` class, because the class is derived from
   the same non-null value.

4. Belt-and-braces escape hatch: `FileViewer`'s diff-mode fallthrough should
   render a `ViewerShell` with its header (close button + "Show conversation")
   in every state, so an unforeseen empty body still leaves a way out rather
   than a bare background.

## Verification

- Unit: `ConversationPage` test asserting that for every input combination that
  yields `reviewFocusActive === true`, `paneContent !== null` — the invariant the
  bug violates. Cover `paneDiffOpen && conversationId === undefined` explicitly.
- Unit: `FileViewer` in `mode=diff` with a path absent from the manifest renders
  a shell with a reachable close control.
- Manual: the two reproductions above, at 1600x1000.
- `./dev.py check`.
