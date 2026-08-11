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
        currentBlobSha="abc123"
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
    // The real endpoint echoes the path and scope it answered; the view relies
    // on that to tell its own response from the previous request's.
    vi.spyOn(api, 'getReviewFileDiff').mockImplementation(async (_conv, path, scope) => ({
      path,
      comparator: 'origin/main',
      scope,
      diff: DIFF,
      current_blob_sha: 'abc123',
    }));
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

  it('offers a direct route to the source editor only when the host says the file is editable', async () => {
    const onEdit = vi.fn();
    const { unmount } = renderView({ onEdit });
    await waitFor(() => expect(codeViewMockState.lastDiffStyle).toBe('unified'));

    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    expect(onEdit).toHaveBeenCalledTimes(1);
    unmount();

    // No handler means the file is not editable text; the affordance is absent
    // rather than present-but-disabled.
    renderView();
    await waitFor(() => expect(codeViewMockState.lastDiffStyle).toBe('unified'));
    expect(screen.queryByRole('button', { name: 'Edit' })).not.toBeInTheDocument();
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

  it('refetches when the agent edits the open file, even though the checkpoint is unmoved', async () => {
    // Reviewed and up to date, so the since-review diff is empty.
    vi.mocked(api.getReviewFileDiff).mockImplementation(async (_conv, path, scope) => ({
      path,
      comparator: 'origin/main',
      scope,
      diff: scope === 'since_review' ? '' : DIFF,
      current_blob_sha: 'abc123',
    }));

    const view = renderView({ review: REVIEWED, currentBlobSha: 'abc123' });
    fireEvent.click(await screen.findByRole('button', { name: /Since review/ }));
    await waitFor(() =>
      expect(screen.getByText('Nothing changed since you reviewed this file.')).toBeInTheDocument(),
    );
    vi.mocked(api.getReviewFileDiff).mockClear();

    // The agent edits the file. Only the *current* side moves — the checkpoint
    // the user reviewed at is by definition unchanged.
    view.rerender(
      <ReviewNotesProvider>
        <FileReviewDiffView
          conversationId="conv-1"
          path="foo.txt"
          fileName="foo.txt"
          absolutePath="/repo/foo.txt"
          review={{ kind: 'reviewed_stale', at_blob: 'abc123', current_blob: 'def456' }}
          currentBlobSha="def456"
          onClose={() => undefined}
          onSendNotes={() => undefined}
          onShowSource={() => undefined}
          onMarkReviewed={() => undefined}
          onUnmarkReviewed={() => undefined}
        />
      </ReviewNotesProvider>,
    );

    await waitFor(() =>
      expect(vi.mocked(api.getReviewFileDiff).mock.calls.filter((c) => c[2] === 'since_review')).toHaveLength(1),
    );
  });

  it('does not render the previous scope while the new scope is still loading', async () => {
    // Distinguishable payloads, and a since-review fetch that never settles, so
    // the in-flight window is observable rather than a race to catch.
    vi.mocked(api.getReviewFileDiff).mockImplementation(async (_conv, path, scope) => {
      if (scope === 'since_review') return new Promise(() => {});
      return { path, comparator: 'origin/main', scope, diff: DIFF, current_blob_sha: 'abc123' };
    });

    renderView({ review: REVIEWED });
    await screen.findByTestId('codeview-mock');

    fireEvent.click(screen.getByRole('button', { name: /Since review/ }));

    // The control already reports since-review; the full diff underneath it
    // would be an answer to a question the user is no longer asking.
    expect(await screen.findByRole('button', { name: /Full diff/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByTestId('codeview-mock')).toBeNull());
    expect(screen.getByText('Loading diff…')).toBeInTheDocument();
    // And it must not read as "nothing changed" before its own answer arrives.
    expect(screen.queryByText('Nothing changed since you reviewed this file.')).toBeNull();
  });

  describe('context expansion', () => {
    beforeEach(() => {
      vi.spyOn(api, 'getDiffExpansion').mockResolvedValue({ files: [] });
      vi.mocked(api.getDiffExpansion).mockClear();
    });

    it('requests expansion content for the file so hunk separators can reveal context', async () => {
      renderView();
      await screen.findByTestId('codeview-mock');

      await waitFor(() => expect(api.getDiffExpansion).toHaveBeenCalled());
      const [, files] = vi.mocked(api.getDiffExpansion).mock.calls[0]!;
      expect(files).toEqual([
        expect.objectContaining({
          path: 'foo.txt',
          prev_object_id: '0000000',
          new_object_id: '1111111',
        }),
      ]);
    });

    it('resolves the full diff against the working tree, since its new side is not a stored blob', async () => {
      renderView();
      await screen.findByTestId('codeview-mock');

      await waitFor(() => expect(api.getDiffExpansion).toHaveBeenCalled());
      expect(
        vi.mocked(api.getDiffExpansion).mock.calls.every((call) => call[1].every((f) => f.section === 'uncommitted')),
      ).toBe(true);
    });

    it('resolves the since-review diff from the object database, where both its blobs live', async () => {
      renderView({ review: REVIEWED });
      await screen.findByTestId('codeview-mock');

      fireEvent.click(screen.getByRole('button', { name: /Since review/ }));

      await waitFor(() =>
        expect(
          vi.mocked(api.getDiffExpansion).mock.calls.filter((call) =>
            call[1].some((f) => f.section === 'committed'),
          ),
        ).toHaveLength(1),
      );
    });

    it('does not request expansion for a truncated diff', async () => {
      vi.mocked(api.getReviewFileDiff).mockImplementation(async (_conv, path, scope) => ({
        path,
        comparator: 'origin/main',
        scope,
        diff: DIFF,
        truncated_kib: 512,
        saturated: false,
        current_blob_sha: 'abc123',
      }));

      renderView();
      await screen.findByTestId('codeview-mock');

      // The retained patch is not the whole patch, so revealed context could not
      // be shown to match the file.
      await waitFor(() => expect(codeViewMockState.lastDiffStyle).toBe('unified'));
      expect(api.getDiffExpansion).not.toHaveBeenCalled();
    });

    it('still renders the diff when expansion content cannot be fetched', async () => {
      vi.mocked(api.getDiffExpansion).mockRejectedValue(new Error('nope'));

      renderView();

      // Expansion is an enhancement; losing it must not cost the reviewer the diff.
      expect(await screen.findByTestId('codeview-mock')).toBeInTheDocument();
      expect(screen.queryByText('nope')).toBeNull();
    });
  });
});
