/**
 * Keyboard review wiring for the per-file review diff surface.
 *
 * Key meanings live in `reviewKeymap.test.ts`; this covers only that each
 * command reaches the right callback on this surface.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { FileReviewDiffView } from './FileReviewDiffView';
import { ReviewNotesProvider } from '../../contexts/ReviewNotesContext';
import { FocusScopeProvider } from '../../hooks/useFocusScope';
import { resetCodeViewMock } from './__testutils__/codeViewMock';
import { api, type FileReviewState } from '../../api';

vi.mock('@pierre/diffs/react', async () => {
  const { makeCodeViewMock } = await import('./__testutils__/codeViewMock');
  return makeCodeViewMock();
});

const DIFF = [
  'diff --git a/a.ts b/a.ts',
  'index 0000000..1111111 100644',
  '--- a/a.ts',
  '+++ b/a.ts',
  '@@ -40,0 +41,2 @@',
  '+hello world',
  '+line 42 of a.ts',
].join('\n');

function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(document.body, { key, ...init });
}

function renderView(review: FileReviewState) {
  const handlers = {
    onClose: vi.fn(),
    onMarkReviewed: vi.fn(async () => undefined),
    onUnmarkReviewed: vi.fn(async () => undefined),
    onNextUnreviewed: vi.fn(),
    onNextFile: vi.fn(),
    onPreviousFile: vi.fn(),
    onRefreshManifest: vi.fn(),
  };
  render(
    <FocusScopeProvider>
      <ReviewNotesProvider>
        <FileReviewDiffView
          conversationId="conv-1"
          path="a.ts"
          fileName="a.ts"
          absolutePath="/repo/a.ts"
          review={review}
          onSendNotes={() => undefined}
          onShowSource={() => undefined}
          {...handlers}
        />
      </ReviewNotesProvider>
    </FocusScopeProvider>,
  );
  return handlers;
}

describe('FileReviewDiffView keyboard review', () => {
  beforeEach(() => {
    resetCodeViewMock();
    vi.spyOn(api, 'getReviewFileDiff').mockResolvedValue({
      path: 'a.ts',
      diff: DIFF,
      comparator: 'origin/main',
      current_blob_sha: 'blob-a',
      scope: 'full',
    } as Awaited<ReturnType<typeof api.getReviewFileDiff>>);
  });

  it('marks reviewed at the rendered blob, then advances', async () => {
    const handlers = renderView({ kind: 'unreviewed' });
    await screen.findByTestId('codeview-mock');

    press('m');

    await waitFor(() => expect(handlers.onMarkReviewed).toHaveBeenCalledWith('a.ts', 'blob-a'));
    await waitFor(() => expect(handlers.onNextUnreviewed).toHaveBeenCalled());
  });

  it('unmarks a reviewed file without advancing', async () => {
    const handlers = renderView({ kind: 'reviewed', at_blob: 'blob-a' });
    await screen.findByTestId('codeview-mock');

    press('m');

    await waitFor(() => expect(handlers.onUnmarkReviewed).toHaveBeenCalledWith('a.ts'));
    expect(handlers.onMarkReviewed).not.toHaveBeenCalled();
    expect(handlers.onNextUnreviewed).not.toHaveBeenCalled();
  });

  it('walks files with ]f and [f', async () => {
    const handlers = renderView({ kind: 'unreviewed' });
    await screen.findByTestId('codeview-mock');

    press(']');
    press('f');
    await waitFor(() => expect(handlers.onNextFile).toHaveBeenCalled());

    press('[');
    press('f');
    await waitFor(() => expect(handlers.onPreviousFile).toHaveBeenCalled());
  });

  it('refetches the diff and the manifest on R', async () => {
    const handlers = renderView({ kind: 'unreviewed' });
    await screen.findByTestId('codeview-mock');
    const callsBefore = vi.mocked(api.getReviewFileDiff).mock.calls.length;

    press('R');

    await waitFor(() => expect(vi.mocked(api.getReviewFileDiff).mock.calls.length).toBeGreaterThan(callsBefore));
    expect(handlers.onRefreshManifest).toHaveBeenCalled();
  });

  it('closes on q', async () => {
    const handlers = renderView({ kind: 'unreviewed' });
    await screen.findByTestId('codeview-mock');

    press('q');

    await waitFor(() => expect(handlers.onClose).toHaveBeenCalled());
  });

  it('comments on the line named by a typed count', async () => {
    renderView({ kind: 'unreviewed' });
    await screen.findByTestId('codeview-mock');

    press('4');
    press('2');
    press('c');

    await screen.findByPlaceholderText(/Add your note/);
    expect(screen.getByText('a.ts:42')).toBeInTheDocument();
    expect(screen.getByText('line 42 of a.ts')).toBeInTheDocument();
  });

  it('explains rather than silently ignoring a line that is not in the diff', async () => {
    renderView({ kind: 'unreviewed' });
    await screen.findByTestId('codeview-mock');

    press('9');
    press('9');
    press('c');

    expect(await screen.findByRole('status')).toHaveTextContent(/Line 99 is not in this diff/);
    expect(screen.queryByPlaceholderText(/Add your note/)).not.toBeInTheDocument();
  });
});
