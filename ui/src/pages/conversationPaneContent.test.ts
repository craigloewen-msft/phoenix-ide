import { describe, it, expect } from 'vitest';
import fc from 'fast-check';
import { isReviewFocusEligible, resolvePaneContent, type PaneContentInputs } from './conversationPaneContent';
import type { ViewerSlot } from '../contexts/ViewerSlotContext';

const messageSlot = (presentation: 'pane' | 'fullscreen'): Extract<ViewerSlot, { kind: 'message' }> =>
  ({ kind: 'message', presentation, sequenceId: 7 });
const commissionSlot: Extract<ViewerSlot, { kind: 'commission-review' }> =
  { kind: 'commission-review', presentation: 'pane', requestSequenceId: 3 };
const inspectSlot: Extract<ViewerSlot, { kind: 'inspect' }> = { kind: 'inspect', handleId: 'h-1' };
const proseSlot = (mode: 'source' | 'diff'): Extract<ViewerSlot, { kind: 'prose' }> => ({
  kind: 'prose',
  presentation: 'pane',
  file: { path: '/repo/a.ts', rootDir: '/repo' },
  patchContext: null,
  mode,
});

const NOTHING_OPEN: PaneContentInputs = {
  conversationId: 'conv-1',
  paneDiffOpen: false,
  openFileState: null,
  proseSlot: null,
  browserViewerOpen: false,
  inspectViewerOpen: false,
  inspectSlot: null,
  messageViewerOpen: false,
  messageSlot: null,
  commissionReviewViewerOpen: false,
  commissionReviewSlot: null,
};

describe('resolvePaneContent', () => {
  it('resolves the workspace diff when the conversation id is known', () => {
    expect(resolvePaneContent({ ...NOTHING_OPEN, paneDiffOpen: true }))
      .toEqual({ kind: 'diff', conversationId: 'conv-1' });
  });

  // The blank-screen bug: the diff pane was considered "open" for layout purposes
  // while its render branch required a conversation id it did not have.
  it('resolves to null when the diff is open but the conversation id is not yet known', () => {
    expect(resolvePaneContent({ ...NOTHING_OPEN, paneDiffOpen: true, conversationId: undefined }))
      .toBeNull();
  });

  it('resolves to null when the browser viewer is open without a conversation id', () => {
    expect(resolvePaneContent({ ...NOTHING_OPEN, browserViewerOpen: true, conversationId: undefined }))
      .toBeNull();
  });

  it('resolves to null when a viewer is flagged open but its slot payload is absent', () => {
    expect(resolvePaneContent({ ...NOTHING_OPEN, inspectViewerOpen: true })).toBeNull();
    expect(resolvePaneContent({ ...NOTHING_OPEN, messageViewerOpen: true })).toBeNull();
    expect(resolvePaneContent({ ...NOTHING_OPEN, commissionReviewViewerOpen: true })).toBeNull();
  });

  it('keeps a fullscreen message out of the split pane', () => {
    expect(resolvePaneContent({
      ...NOTHING_OPEN,
      messageViewerOpen: true,
      messageSlot: messageSlot('fullscreen'),
    })).toBeNull();

    expect(resolvePaneContent({
      ...NOTHING_OPEN,
      messageViewerOpen: true,
      messageSlot: messageSlot('pane'),
    })).toEqual({ kind: 'message', slot: messageSlot('pane') });
  });

  it('carries the prose render mode so review focus can key off it', () => {
    const file = { path: '/repo/a.ts', rootDir: '/repo' };
    expect(resolvePaneContent({ ...NOTHING_OPEN, openFileState: file, proseSlot: proseSlot('diff') }))
      .toEqual({ kind: 'prose', file, mode: 'diff', presentation: 'pane' });
  });

  it('prefers the diff over an open file, matching the surface precedence', () => {
    expect(resolvePaneContent({
      ...NOTHING_OPEN,
      paneDiffOpen: true,
      openFileState: { path: '/repo/a.ts', rootDir: '/repo' },
    })).toEqual({ kind: 'diff', conversationId: 'conv-1' });
  });
});

describe('isReviewFocusEligible', () => {
  it('is offered on both diff surfaces', () => {
    expect(isReviewFocusEligible({ kind: 'diff', conversationId: 'c' }, true)).toBe(true);
    expect(isReviewFocusEligible(
      { kind: 'prose', file: { path: '/a', rootDir: '/' }, mode: 'diff', presentation: 'pane' },
      true,
    )).toBe(true);
  });

  it('is withheld from non-diff surfaces and from narrow viewports', () => {
    expect(isReviewFocusEligible(
      { kind: 'prose', file: { path: '/a', rootDir: '/' }, mode: 'source', presentation: 'pane' },
      true,
    )).toBe(false);
    expect(isReviewFocusEligible({ kind: 'browser', conversationId: 'c' }, true)).toBe(false);
    expect(isReviewFocusEligible({ kind: 'diff', conversationId: 'c' }, false)).toBe(false);
  });

  /**
   * The invariant the blank-screen bug violated: review focus hides the
   * conversation column, so it must never be eligible when the pane would
   * render nothing.
   */
  it('is never eligible while the pane has no content', () => {
    fc.assert(fc.property(fc.boolean(), (isWideDesktop) => {
      expect(isReviewFocusEligible(null, isWideDesktop)).toBe(false);
    }));
  });

  it('never hides the conversation behind an empty pane, over arbitrary inputs', () => {
    const slotArb = <T,>(value: T) => fc.oneof(fc.constant(null), fc.constant(value));
    fc.assert(fc.property(
      fc.record({
        conversationId: fc.oneof(fc.constant(undefined), fc.constant('conv-1')),
        paneDiffOpen: fc.boolean(),
        openFileState: slotArb({ path: '/repo/a.ts', rootDir: '/repo' }),
        proseSlot: fc.oneof(fc.constant(null), fc.constantFrom(proseSlot('source'), proseSlot('diff'))),
        browserViewerOpen: fc.boolean(),
        inspectViewerOpen: fc.boolean(),
        inspectSlot: slotArb(inspectSlot),
        messageViewerOpen: fc.boolean(),
        messageSlot: fc.oneof(fc.constant(null), fc.constantFrom(messageSlot('pane'), messageSlot('fullscreen'))),
        commissionReviewViewerOpen: fc.boolean(),
        commissionReviewSlot: slotArb(commissionSlot),
      }),
      fc.boolean(),
      (input, isWideDesktop) => {
        const content = resolvePaneContent(input);
        if (isReviewFocusEligible(content, isWideDesktop)) {
          expect(content).not.toBeNull();
        }
      },
    ));
  });
});
