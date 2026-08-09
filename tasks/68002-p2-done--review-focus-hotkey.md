# Hotkey to toggle review focus (collapse/restore the conversation)

## Why

Review focus — the `ReviewFocusToggleButton` labelled "Collapse conversation" /
"Show conversation" — is the one review-surface control with no keyboard route.
Every other action a reviewer takes (`j`/`k`, `]f`/`[f`, `m`, `c`, `R`, `q`) has
one, so a reviewer working the keymap has to reach for the mouse purely to widen
the reading area, which is exactly the rhythm break REQ-RV-010 exists to avoid.

REQ-RV-013 already requires an explicit control for the collapse; this makes that
control reachable the same way the rest of the pass is.

## Key: `F` (Shift+F)

Uppercase matches the existing convention for the less-frequent commands (`G`,
`N`, `R`). It is unclaimed:

- Bare lowercase `f` is unavailable — it is the second key of `]f` / `[f`, and a
  mis-tapped prefix must not silently reshape the layout.
- `mod+f` (viewer find) requires Meta or Ctrl, so the router's `matchesShortcut`
  cannot confuse the two.
- `isReviewKeyCandidate` is derived from the resolver, so the router hands `F`
  over automatically once the resolver claims it — no second key list to update.

## Changes

### 1. `ui/src/components/viewer/reviewKeymap.ts`

Add the command, the binding, and the resolver case:

```ts
export type ReviewCommand =
  | …
  | { kind: 'toggle-review-focus' };
```

```ts
// in REVIEW_BINDINGS, after the annotate rows and before `R`
{ keys: 'F', description: 'Collapse the conversation for a full-width review, and restore it' },
```

```ts
// in the unprefixed switch
case 'F':
  return resolved({ kind: 'toggle-review-focus' });
```

`F` takes no count, so it falls under the existing "any other key drops the
count" rule with no special handling. `useReviewKeyboard` needs no change.

### 2. Both `runCommand` switches

`DiffView.tsx` and `FileReviewDiffView.tsx` each gain:

```ts
case 'toggle-review-focus':
  if (!onToggleReviewFocus) {
    // Only the wide-desktop split-pane host supplies the handler; there is no
    // conversation column to collapse in a fullscreen/overlay diff.
    console.debug('[review] F pressed with no collapse target on this surface');
    return;
  }
  onToggleReviewFocus();
  return;
```

No banner notice for the no-target case (deliberate: the control is simply
absent from that surface's header, so there is nothing the reviewer is being
denied). The `console.debug` keeps the capability gap visible in logs per
AGENTS.md — the same shape as the existing `[FileViewer] diff mode requested but
unresolvable` log.

Add `onToggleReviewFocus` to each `runCommand` dependency array.

### 3. Make the command union exhaustive at both call sites

Both `runCommand` switches return `void` with no `default`, so today a new
`ReviewCommand` variant compiles cleanly while being silently unhandled on one
surface. Close that while adding a variant:

```ts
default:
  command satisfies never;
  return;
```

This is the repo's existing exhaustiveness idiom (`utils.ts`, `StateBar.tsx`,
`api.ts`) and makes "a review command that one surface forgot" a compile error
rather than a dead key.

### 4. Tooltip hint — `DiffHeaderControls.tsx`

`ReviewFocusToggleButton` gets the key in its `title` only:

```tsx
const label = reviewFocus ? 'Show conversation' : 'Collapse conversation';
…
aria-label={label}
title={`${label} (F)`}
```

The `aria-label` must stay bare: `DiffView.test.tsx`,
`FileReviewDiffView.test.tsx`, and `FileViewer.test.tsx` all query this button by
accessible name. Matches the `title="Refresh from disk (R)"` precedent on the
adjacent button, and satisfies REQ-KB-007.

The help-panel entry needs no work: `ShortcutHelpPanel` renders its "Diff Review"
group straight from `REVIEW_BINDINGS`.

## Tests

- `reviewKeymap.test.ts`
  - `commandFor('F')` → `{ kind: 'toggle-review-focus' }`.
  - `type(['9', 'F'])` yields the command with no count trace, and clears pending.
  - `F` carrying Ctrl / Meta / Alt resolves to `none` (Ctrl+F stays viewer find).
  - `isReviewKeyCandidate(key('F'))` is true; bare `f` outside a prefix stays
    `none` — add `'f'` to the existing "leaves unknown keys alone" list to pin
    the prefix-only role.
- `DiffView.keyboard.test.tsx`: pressing `F` invokes the supplied
  `onToggleReviewFocus`; with the prop omitted the press is a no-op and throws
  nothing.
- `FileReviewDiffView.keyboard.test.tsx`: same two cases.
- `ShortcutHelpPanel.test.tsx` covers the new row automatically via its
  `REVIEW_BINDINGS` loop — no edit expected. If it needs one, the derivation
  broke and that is the bug.
- Manual at ≥ wide-desktop width on the seeded `diff-review-fixture`
  conversation: open `?viewer=diff&presentation=pane`, press `F` to collapse and
  again to restore; repeat on a per-file `?mode=diff` review; confirm `F` typed
  into the find query and into the annotation dialog reaches the field instead of
  toggling.

## Spec updates

- `specs/iterative-review/requirements.md` — REQ-RV-013 gains a clause that the
  collapse control is reachable from the keyboard on the surfaces that offer it.
  It belongs here rather than in REQ-RV-010's command list: this is a
  screen-control concern, and stating it twice would be two representations of
  one requirement.
- `specs/iterative-review/executive.md` — add `F` to the **Keyboard** paragraph's
  binding sentence, extend the REQ-RV-013 surface cell to name the keymap, and
  add the two new keyboard-test bullets to Verification.
- `specs/keyboard-interaction/` — no change. `F` is a bare-letter review key
  already governed by REQ-KB-009, and the tooltip hint is REQ-KB-007 as written.

## Verification

`./dev.py check`, plus the manual pass above.
