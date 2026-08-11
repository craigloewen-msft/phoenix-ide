# Reach edit mode in one click from the file diff review page

## Problem

Reviewing a file's diff and wanting to fix what you just read is a single
intent, but the UI makes it a three-step scavenger hunt:

1. Click **FILE** in the `FileReviewDiffView` header (drops you into source).
2. Find the `Edit mode: Off` toggle among the source header's controls.
3. Click it.

`FileReviewDiffView`'s header offers FILE/DIFF, Since review, Mark reviewed,
diff style, refresh, shortcuts, and review focus — every review action except
the one a reviewer most often wants next. Editing exists only in `MetaViewer`
(source mode) behind the `Edit mode` toggle.

## Approach

Add an **Edit** button to the per-file review diff header. One click switches
the open file to source rendering *with edit mode already armed*.

Scope is deliberately the per-file review diff only. The whole-branch diff
(`DiffView`) and a keyboard binding are explicitly out of scope — the
whole-branch surface would need a one-shot arm channel plumbed through
`ViewerSlotContext`, which touches a normative Allium spec for a second-order
convenience.

### Why the state lives where it does

The arm request must **not** persist. `specs/file-explorer/requirements.md`
REQ-FE-013 forbids armed state in the viewer URL, browser storage,
conversation state, or reconnect state. So this is an in-memory one-shot, not
a `?edit=1` param — the same shape `ChainPage` already uses for its
`autoEdit` / `onAutoEditConsumed` rename intent.

`FileViewer` is the right owner: it renders *both* `FileReviewDiffView` and
`MetaViewer` and stays mounted across the mode flip (mode comes from a URL
param read by the same component instance). `MetaViewer` is keyed by
`absolutePath`, so it mounts fresh on the flip — exactly when a lazy state
initializer should read the flag.

## Plan

### 1. `ui/src/components/FileViewer.tsx`

- Hold the one-shot intent in `useScopedState(absolutePath, false)`. The
  scoped hook resets synchronously when the path changes, so an unconsumed
  intent cannot leak into the next file's session (REQ-FE-013's
  "opens another file → begins disarmed").
- The load effect already runs before the diff-mode early return, so
  `fileData.capability` is available while the diff renders. No new request.
- Pass `onEdit` to `FileReviewDiffView` **only** when the file is genuinely
  text-editable: `capability.kind === 'mutable_text'`, plus the
  `conversationId` / `conversationRelativePath` / `fileExplorer` conditions the
  existing `mutation` object already requires. Absence of the prop means no
  button — matching the file's established "no disabled-as-status control"
  convention.
  - Deliberately excluded: `delete_only` (images). A button labelled *Edit*
    that can only delete is a lie.
- `onEdit` runs `slotCommands.setFileViewMode('source')` and sets the intent.

### 2. `ui/src/components/viewer/metaViewerTypes.ts`

Add the one-shot to `FileMutationActions` — the bundle that exists *only* when
mutation is possible, so "arm requested on a file with no mutation capability"
stays structurally unrepresentable:

```ts
/** Open this session already armed, honouring an explicit edit request made
 *  from another render mode of the same file. One-shot: consumed on mount. */
armOnOpen: boolean;
onArmConsumed: () => void;
```

### 3. `ui/src/components/viewer/MetaViewer.tsx`

- `useState(() => mutation?.armOnOpen ?? false)` for `editMode` (lazy, so it
  reads the flag once per file session).
- Effect calls `onArmConsumed()` when the flag was set, so a later re-render or
  manual disarm cannot silently re-arm.
- No other change: `sourceEditorOpen`, the Save/Delete controls, the
  "Edit mode is enabled for this file only." banner, and the dirty-draft
  transition guard all already key off `editMode`.

### 4. `ui/src/components/viewer/FileReviewDiffView.tsx`

- New optional prop `onEdit?: (() => void) | undefined`, documented as "absent
  when the file is not editable text".
- Render the button after **Mark reviewed**, before the diff-style toggle:
  `[FILE|DIFF] [Since review] [Mark reviewed] [Edit] [style] [⟳] [⌨]`.

## Behaviour after the change

Clicking **Edit** lands on source rendering with the textarea editor live and
Save/Delete armed. The FILE/DIFF group hides while the editor is open
(existing behaviour), so returning to the diff means disarming first — which
runs the existing dirty-draft discard guard. No new escape path around it.

## Specs

- `specs/file-explorer/requirements.md` — REQ-FE-013 needs one clarifying
  clause. Its literal text ("WHEN a viewer-openable file opens ... SHALL keep
  editing and deletion controls disarmed") would otherwise contradict an
  arm-on-open. State that the disarmed-on-open rule governs *navigational*
  opens, and that an explicit edit request naming the open file arms it for
  that viewer session only. The prohibition on persisting armed state is
  unchanged and still binding.
- `specs/file-explorer/file-editing.allium` — **no change**. `EditModeEnabled`
  requires `session.state = read_only`; a fresh session is `read_only`, so
  arming at mount is just `UserEnablesEditMode` fired immediately. The
  `ReadOnlyCarriesNoMutationDraft` and `ArmedStatesCarryVersion` invariants
  hold unchanged.
- `specs/file-explorer/executive.md` — note the new entry point on REQ-FE-013.
- `specs/iterative-review/requirements.md` — REQ-RV-006 currently says the
  system shall allow switching between a file's diff and its source. Worth a
  sentence that the source route can be entered ready to edit; the diff/source
  pair remains two renderings of one open file.

## Tests

- `FileReviewDiffView.test.tsx` — Edit button renders when `onEdit` is
  supplied and is absent when it is not.
- `FileViewer.test.tsx` — extend the existing `FileViewer safe editing`
  describe (it already has `mutable_text` / `delete_only` / `read_only`
  fixtures):
  - clicking Edit from diff mode lands on source with the editor live;
  - no Edit button for a `delete_only` (image) file in the manifest;
  - the intent does not leak — arming, then opening a different file, yields a
    disarmed session (REQ-FE-013 regression guard).

## Verification

`./dev.py check`, then manually: open a Work conversation with changed files,
open one from the review checklist, click Edit, confirm the editor is live and
Save is disabled until the draft is dirty.
