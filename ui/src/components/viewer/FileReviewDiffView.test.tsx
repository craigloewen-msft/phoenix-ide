import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileReviewDiffView } from './FileReviewDiffView';
import { ReviewNotesProvider } from '../../contexts/ReviewNotesContext';
import { codeViewMockState, resetCodeViewMock } from './__testutils__/codeViewMock';
import { api, type FileReviewState } from '../../api';

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
    localStorage.removeItem('phoenix-review-diff-scope');
    vi.spyOn(api, 'getReviewFileDiff').mockResolvedValue({
      path: 'foo.txt',
      comparator: 'origin/main',
      scope: 'full',
      diff: DIFF,
      current_blob_sha: 'abc123',
    });
    // The spy persists across tests in this file; clear the call log so a test
    // asserting on "every call" sees only its own.
    vi.mocked(api.getReviewFileDiff).mockClear();
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

  const REVIEWED: FileReviewState = { kind: 'reviewed', at_blob: 'abc123' };

  it('switches to the since-review diff on a single click', async () => {
    renderView({ review: REVIEWED });
    await screen.findByTestId('codeview-mock');

    fireEvent.click(screen.getByRole('button', { name: /Since review/ }));

    // One click, one since_review fetch — no toggle-back-and-forth needed.
    await waitFor(() =>
      expect(vi.mocked(api.getReviewFileDiff).mock.calls.filter((c) => c[2] === 'since_review')).toHaveLength(1),
    );
    expect(await screen.findByRole('button', { name: /Full diff/ })).toBeInTheDocument();
  });

  it('keeps the since-review scope when the reviewer moves to another file', async () => {
    const first = renderView({ review: REVIEWED });
    await screen.findByTestId('codeview-mock');
    fireEvent.click(screen.getByRole('button', { name: /Since review/ }));
    await waitFor(() => expect(screen.getByRole('button', { name: /Full diff/ })).toBeInTheDocument());
    first.unmount();

    vi.mocked(api.getReviewFileDiff).mockClear();
    renderView({ path: 'bar.txt', fileName: 'bar.txt', review: REVIEWED });

    // The next file opens already scoped to since-review, without a click.
    await waitFor(() => expect(vi.mocked(api.getReviewFileDiff)).toHaveBeenCalled());
    expect(vi.mocked(api.getReviewFileDiff).mock.calls.every((c) => c[2] === 'since_review')).toBe(true);
  });

  it('renders the full diff for a file with no checkpoint without discarding the preference', async () => {
    localStorage.setItem('phoenix-review-diff-scope', 'since_review');
    const unreviewed = renderView({ review: { kind: 'unreviewed' } });

    // No checkpoint to diff against, so the full diff renders and the scope
    // toggle is not offered at all.
    await waitFor(() => expect(vi.mocked(api.getReviewFileDiff)).toHaveBeenCalled());
    expect(vi.mocked(api.getReviewFileDiff).mock.calls.every((c) => c[2] === 'full')).toBe(true);
    expect(screen.queryByRole('button', { name: /Since review|Full diff/ })).toBeNull();
    // The standing preference survives the file that could not honour it.
    expect(localStorage.getItem('phoenix-review-diff-scope')).toBe('since_review');
    unreviewed.unmount();

    vi.mocked(api.getReviewFileDiff).mockClear();
    renderView({ path: 'bar.txt', fileName: 'bar.txt', review: REVIEWED });
    await waitFor(() => expect(vi.mocked(api.getReviewFileDiff)).toHaveBeenCalled());
    expect(vi.mocked(api.getReviewFileDiff).mock.calls.every((c) => c[2] === 'since_review')).toBe(true);
  });
});
