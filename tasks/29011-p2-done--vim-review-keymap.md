# Vim-style keyboard review: mark reviewed, file/viewport nav, refresh, help

Make a full code-review pass possible without the mouse, on both review surfaces:

- **Per-file review diff** - `FileReviewDiffView` (opened from the changed-files checklist in `ChangedFilesReview`, via `openFileDiff` -> `FileViewer` diff mode).
- **Whole-branch diff** - `DiffView` / `PhoenixDiffCodeView`, one virtualized `CodeView` holding every file (committed items first, then uncommitted).

## Keymap

| Key | Action |
|---|---|
| `j` / `k` | Scroll viewport down / up one line |
| `Ctrl+d` / `Ctrl+u` | Half-page down / up |
| `gg` / `G` | Top / bottom of the diff surface |
| `m` | Toggle mark-reviewed for the current file, then advance to the next unreviewed file |
| `]f` / `[f` (aliases `n` / `N`) | Next / previous file |
| `]u` | Next file still needing review (unreviewed **or** `reviewed_stale`) |
| `c` | Add a note on the current file (routes to the existing `onAnnotateFile` lifecycle) |
| `R` | Refresh the current diff + review manifest from disk |
| `q` | Close the review surface (same action as the header close / Escape) |
| `?` | Keyboard guide (see below) |

Semantics:

- `m` is a **toggle**: on an unreviewed/stale file it calls `markReviewed(path, current_blob_sha)` then advances; on an already-reviewed file it calls `unmarkReviewed(path)` and stays put - un-marking is a correction, not progress.
- Auto-advance reuses the existing `onNextUnreviewed` seam in `FileReviewDiffView`, which today no caller passes. Wiring it is part of this task.
- In the whole-branch `DiffView`, "current file" is an explicit **file cursor** (index into the rendered `PhoenixDiffItem` list), not a scroll-position guess. `]f`/`[f`/`]u` move the cursor and scroll to it via Pierre's typed `scrollTo({ type: 'item', ... })`. The cursor'd file header carries a visible marker so keyboard state is never invisible.
- `m` in the whole-branch view acts only when the cursor'd file resolves to a `ReviewFileEntry` in the manifest (path from `item.fileDiff.name`, matched against repo-relative manifest paths). A PR/fork diff with no manifest entry is a no-op **with a toast** explaining why - never a silent swallow.

## Staying in sync with an external editor

The user edits the same files in another editor, so a review surface can show stale content. Phoenix has **no filesystem-watch infrastructure today** - no `notify` dependency, no fs-event SSE channel - so a real watcher means a new backend subsystem (watcher lifecycle per worktree, debounce, ignore rules, a new wire event, teardown on conversation close). That is a larger, separable piece of work, and it is not needed to unblock a keyboard-only review.

This task therefore does **pull-based** freshness:

1. `R` - explicit refresh. Refetches the open per-file diff (`getReviewFileDiff` for the current path+scope) and calls `review.refresh()` for the manifest. In `DiffView`, refetches the conversation diff payload. Shows a brief refreshing indicator; failures surface through the existing error paths, not silently.
2. **Refresh on window focus** - when the browser window/tab regains focus and a review surface is open, run the same refresh. This covers the actual workflow (edit in the other editor -> alt-tab back to Phoenix) with no polling and no new backend. Debounced so a rapid focus/blur does not stampede the API.

No interval polling: it burns requests on an idle tab and still lags.

A true watcher is filed as a follow-up (see below), so the choice here is explicit rather than a silent omission.

## Discoverability of the hotkeys

Two surfaces, both required:

1. **Global help panel** - `ShortcutHelpPanel` (already bound to `?` app-wide) gains a **"Diff Review"** group listing every binding above. This is the canonical list.
2. **In-surface affordance** - a small keyboard-icon button in the `ViewerShell` header of both review surfaces that opens the same panel, so a user who never learned `?` still finds it. Pressing `?` while a review surface is focused opens the panel scrolled to the Diff Review group.

The panel is generated from the same command table the keymap reducer uses, so a binding cannot exist without appearing in the guide.

## Design constraints

- **No DOM scraping of Pierre.** `PhoenixDiffCodeView` is the single boundary to `@pierre/diffs` and stays that way. Scrolling goes through the typed handle: extend `PhoenixDiffCodeViewHandle` with `scrollByLines(n)`, `scrollPage(direction)`, `scrollToEdge('top' | 'bottom')` and `scrollToItem(id)`, all implemented over `CodeViewHandle.scrollTo` (`position` / `item` targets) plus `subscribeToScroll` for the current `scrollTop`. No `querySelector` into the shadow DOM.
- **Route through the existing keyboard router**, not a raw `window` listener. `useKeyboardRouterShortcut` in `hooks/useFocusScope.tsx` currently accepts only the `KeyboardRouterKey` union `'mod+f' | 'Escape'`. Widen it to a typed key descriptor (not free-form strings) so review keys register on the `viewer` layer scoped to `diff-viewer` / the file-review scope. This preserves REQ-KB-002A topmost-eligible ownership and keeps the `isEditableTarget` guard: no review key may fire while a note dialog, the find bar, or any input is focused.
- **One source of truth for bindings.** A single exported command table drives the reducer, the help panel group, and the tests.
- Multi-key sequences (`gg`, `]f`, `[f`) need a pending-prefix state with a timeout. Keep it in one pure, unit-testable reducer (`reviewKeymap.ts`) mapping `(pendingPrefix, key-event-ish)` to a command, `'pending'`, or `null`. The React hook is a thin shell over it.
- Manifest mutation stays server-owned - `useReviewManifest` returns the fresh manifest; the keymap only calls the existing `markReviewed` / `unmarkReviewed` / `refresh`.

## Plan

1. `ui/src/components/viewer/reviewKeymap.ts` - command union, binding table, pure reducer.
2. Widen `KeyboardRouterKey` in `useFocusScope.tsx` to a typed descriptor; add the review registrations. Existing `mod+f` / `Escape` behaviour unchanged.
3. Extend `PhoenixDiffCodeViewHandle` with the scroll/nav methods.
4. `useReviewKeyboard` hook: reducer -> commands, shared by both surfaces.
5. `FileReviewDiffView`: mark/unmark toggle, `q`, `c`, `R`, viewport keys; wire `onNextUnreviewed` from `FileViewer` via `useReviewContext().outstanding`.
6. `DiffView`: file cursor state, cursor marker in `renderHeaderPrefix`, `]f` / `[f` / `]u` / `m` / `c` / `R`.
7. Refresh-on-window-focus (debounced) for whichever review surface is open.
8. `ShortcutHelpPanel`: "Diff Review" group generated from the binding table; header button on both surfaces that opens it.
9. Specs: new REQ in `specs/iterative-review/requirements.md` for keyboard-complete review, the mark/advance semantics, and pull-based freshness; record the new scoped key layer in `specs/keyboard-interaction/`; update both `executive.md`s.

## Testing

Isolated tests only, per the request - no full end-to-end review walkthrough:

- Vitest unit tests for `reviewKeymap.ts`: every binding, `gg` prefix + timeout expiry, modifier guards, unknown keys return null.
- One RTL test per surface with a mocked `PhoenixDiffCodeView` handle: `m` calls `markReviewed` with the observed blob sha and then `onNextUnreviewed`; `m` on a reviewed file calls `unmarkReviewed` and does *not* advance; `]f` calls `scrollToItem` with the next item id; `R` refetches.
- One test that review keys do **not** fire while the annotation dialog is open.
- One test that every entry in the binding table appears in the help panel.
- `./dev.py check` for lint / tsc / codegen-stale.

## Out of scope / follow-ups

- **Real filesystem watching** (backend `notify` watcher + SSE fs-change event + auto-refresh). File as a separate task once this lands; `R` and focus-refresh are the interim.
- A per-**line** cursor, and therefore line-anchored `c`. `c` here is file-level; a line cursor needs a rendered caret decoration and its own motion set. Natural follow-up once the file-level loop is proven.
- Remappable / user-configurable bindings.
