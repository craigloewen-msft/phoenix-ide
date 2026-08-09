/**
 * Resolution of the wide-desktop split-pane viewer's content.
 *
 * `ConversationPage` renders several mutually-exclusive surfaces beside the
 * conversation, and two layout decisions hang off "which one is showing":
 * whether the split pane exists at all, and whether review focus may collapse
 * the conversation column to give a diff review the full window.
 *
 * Both are derived from the single `PaneContent | null` this module produces.
 * That is what makes the layout safe: the class that hides the conversation
 * column is a function of a *non-null* `PaneContent`, so the column cannot be
 * hidden while the pane has nothing to render. Guards that decide whether a
 * surface can render (a conversation id for the conversation-keyed viewers, a
 * slot payload for the slot-keyed ones) live here and nowhere else, so they
 * cannot drift out of agreement with the surface that consumes them.
 */

import type { OpenFileState } from '../components/FileExplorer/fileExplorerTypes';
import type { FileViewMode, ViewerPresentation, ViewerSlot } from '../contexts/ViewerSlotContext';

export type PaneContent =
  | { kind: 'diff'; conversationId: string }
  | { kind: 'prose'; file: OpenFileState; mode: FileViewMode; presentation: ViewerPresentation }
  | { kind: 'browser'; conversationId: string }
  | { kind: 'inspect'; handleId: string }
  | { kind: 'message'; slot: Extract<ViewerSlot, { kind: 'message' }> }
  | { kind: 'commission-review'; slot: Extract<ViewerSlot, { kind: 'commission-review' }> };

export interface PaneContentInputs {
  conversationId: string | undefined;
  paneDiffOpen: boolean;
  openFileState: OpenFileState | null;
  proseSlot: Extract<ViewerSlot, { kind: 'prose' }> | null;
  browserViewerOpen: boolean;
  inspectViewerOpen: boolean;
  inspectSlot: Extract<ViewerSlot, { kind: 'inspect' }> | null;
  messageViewerOpen: boolean;
  messageSlot: Extract<ViewerSlot, { kind: 'message' }> | null;
  commissionReviewViewerOpen: boolean;
  commissionReviewSlot: Extract<ViewerSlot, { kind: 'commission-review' }> | null;
}

/** Precedence order matches the order the surfaces are offered to the user. */
export function resolvePaneContent(input: PaneContentInputs): PaneContent | null {
  const {
    conversationId,
    paneDiffOpen,
    openFileState,
    proseSlot,
    browserViewerOpen,
    inspectViewerOpen,
    inspectSlot,
    messageViewerOpen,
    messageSlot,
    commissionReviewViewerOpen,
    commissionReviewSlot,
  } = input;

  if (paneDiffOpen && conversationId) return { kind: 'diff', conversationId };
  if (openFileState) {
    return {
      kind: 'prose',
      file: openFileState,
      mode: proseSlot?.mode ?? 'source',
      presentation: proseSlot?.presentation ?? 'pane',
    };
  }
  if (browserViewerOpen && conversationId) return { kind: 'browser', conversationId };
  if (inspectViewerOpen && inspectSlot) return { kind: 'inspect', handleId: inspectSlot.handleId };
  // A fullscreen message uses the takeover surface, not the split pane.
  if (messageViewerOpen && messageSlot && messageSlot.presentation === 'pane') {
    return { kind: 'message', slot: messageSlot };
  }
  if (commissionReviewViewerOpen && commissionReviewSlot) {
    return { kind: 'commission-review', slot: commissionReviewSlot };
  }
  return null;
}

/**
 * Whether review focus may collapse the conversation column.
 *
 * Only the diff surfaces benefit, and only when something is actually rendering
 * in the pane — the `null` case is what stops a focused review from hiding the
 * conversation behind an empty pane.
 */
export function isReviewFocusEligible(paneContent: PaneContent | null, isWideDesktop: boolean): boolean {
  if (!isWideDesktop || paneContent === null) return false;
  return paneContent.kind === 'diff' || (paneContent.kind === 'prose' && paneContent.mode === 'diff');
}
