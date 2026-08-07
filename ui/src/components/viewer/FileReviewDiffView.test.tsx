import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileReviewDiffView } from './FileReviewDiffView';
import { ReviewNotesProvider } from '../../contexts/ReviewNotesContext';
import { codeViewMockState, resetCodeViewMock } from './__testutils__/codeViewMock';
import { api } from '../../api';

vi.mock('@pierre/diffs/react', async () => {
  const { makeCodeViewMock } = await import('./__testutils__/codeViewMock');
  return makeCodeViewMock();
});

const DIFF = [
  'diff --git a/foo.txt b/foo.txt',
  'index 0000000..1111111 100644',
  '--- a/foo.txt',
  '+++ b/foo.txt',
  '@@ -0,0 +1,1 @@',
  '+hello world',
].join('\n');

function renderView(extra: Partial<React.ComponentProps<typeof FileReviewDiffView>> = {}) {
  return render(
    <ReviewNotesProvider>
      <FileReviewDiffView
        conversationId="conv-1"
        path="foo.txt"
        fileName="foo.txt"
        absolutePath="/repo/foo.txt"
        review={{ kind: 'unreviewed' }}
        onClose={() => undefined}
        onSendNotes={() => undefined}
        onShowSource={() => undefined}
        onMarkReviewed={() => undefined}
        onUnmarkReviewed={() => undefined}
        {...extra}
      />
    </ReviewNotesProvider>,
  );
}

describe('FileReviewDiffView', () => {
  beforeEach(() => {
    resetCodeViewMock();
    localStorage.removeItem('phoenix-diff-style');
    vi.spyOn(api, 'getReviewFileDiff').mockResolvedValue({
      path: 'foo.txt',
      comparator: 'origin/main',
      scope: 'full',
      diff: DIFF,
      current_blob_sha: 'abc123',
    });
  });

  it('renders the per-file diff in the shared rendering style and toggles it', async () => {
    renderView();
    await waitFor(() => expect(codeViewMockState.lastDiffStyle).toBe('unified'));

    fireEvent.click(screen.getByRole('button', { name: 'Switch to split view' }));
    await waitFor(() => expect(codeViewMockState.lastDiffStyle).toBe('split'));
    // Same persisted key as the whole-branch diff — one preference everywhere.
    expect(localStorage.getItem('phoenix-diff-style')).toBe('split');
  });

  it('starts from the shared preference a previous surface stored', async () => {
    localStorage.setItem('phoenix-diff-style', 'split');
    renderView();
    await waitFor(() => expect(codeViewMockState.lastDiffStyle).toBe('split'));
  });

  it('offers the conversation-collapse toggle only when the host supplies the handler', async () => {
    const onToggleReviewFocus = vi.fn();
    const view = renderView();
    await waitFor(() => expect(codeViewMockState.lastDiffStyle).toBe('unified'));
    expect(screen.queryByRole('button', { name: 'Collapse conversation' })).toBeNull();
    view.unmount();

    renderView({ inline: true, reviewFocus: false, onToggleReviewFocus });
    fireEvent.click(await screen.findByRole('button', { name: 'Collapse conversation' }));
    expect(onToggleReviewFocus).toHaveBeenCalledTimes(1);
  });
});
