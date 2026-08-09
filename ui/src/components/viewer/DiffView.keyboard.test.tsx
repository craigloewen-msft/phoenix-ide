/**
 * Keyboard review wiring for the whole-branch diff surface.
 *
 * Scope is deliberately the command wiring, not a review walkthrough: the key
 * meanings are covered by `reviewKeymap.test.ts`, and Pierre's rendering is
 * mocked, so what remains to prove is that each command reaches the right
 * manifest mutation / scroll target.
 */

import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { DiffView } from './DiffView';
import { ReviewNotesProvider } from '../../contexts/ReviewNotesContext';
import { ReviewContext, type ReviewContextValue } from '../../contexts/reviewContextCore';
import { FocusScopeProvider } from '../../hooks/useFocusScope';
import { codeViewMockState, resetCodeViewMock } from './__testutils__/codeViewMock';
import type { FileReviewState, ReviewFileEntry } from '../../api';

vi.mock('@pierre/diffs/react', async () => {
  const { makeCodeViewMock } = await import('./__testutils__/codeViewMock');
  return makeCodeViewMock();
});

// Hunks start at line 41 so a counted-line test names a line the parse must
// actually resolve, not the trivial first one.
function fileDiff(name: string): string {
  return [
    `diff --git a/${name} b/${name}`,
    'index 0000000..1111111 100644',
    `--- a/${name}`,
    `+++ b/${name}`,
    '@@ -40,0 +41,2 @@',
    '+hello world',
    `+line 42 of ${name}`,
  ].join('\n');
}

const COMMITTED = `${fileDiff('a.ts')}\n${fileDiff('b.ts')}`;

const CHECKOUT_STATUS: import('../../api').CheckoutStatus = {
  kind: 'named_branch',
  branch_name: 'main',
  head_oid: '1234567890abcdef1234567890abcdef12345678',
  remote_status: { kind: 'no_known' },
};

function entry(path: string, review: FileReviewState): ReviewFileEntry {
  return {
    path,
    status: 'modified',
    insertions: 1,
    deletions: 0,
    current_blob_sha: `blob-${path}`,
    review,
  };
}

function harness(files: ReviewFileEntry[]) {
  const markReviewed = vi.fn(async () => undefined);
  const unmarkReviewed = vi.fn(async () => undefined);
  const refresh = vi.fn();
  const value: ReviewContextValue = {
    conversationId: 'conv-1',
    rootDir: '/repo',
    manifest: {
      comparator: 'origin/main',
      files,
      reviewed_count: files.filter((f) => f.review.kind === 'reviewed').length,
      total_count: files.length,
    },
    loading: false,
    error: null,
    outstanding: files.filter((f) => f.review.kind !== 'reviewed'),
    complete: false,
    refresh,
    markReviewed,
    unmarkReviewed,
  };
  return { value, markReviewed, unmarkReviewed, refresh };
}

function renderDiff(review: ReviewContextValue | null, onClose = vi.fn(), onRefresh = vi.fn()) {
  render(
    <FocusScopeProvider>
      <ReviewContext.Provider value={review}>
        <ReviewNotesProvider>
          <DiffView
            open
            comparator="origin/main"
            commitLog=""
            committedDiff={COMMITTED}
            uncommittedDiff=""
            checkoutStatus={CHECKOUT_STATUS}
            onClose={onClose}
            onSendNotes={() => undefined}
            onRefresh={onRefresh}
          />
        </ReviewNotesProvider>
      </ReviewContext.Provider>
    </FocusScopeProvider>,
  );
  return { onClose, onRefresh };
}

function press(key: string, init: KeyboardEventInit = {}) {
  fireEvent.keyDown(document.body, { key, ...init });
}

/** Item ids scrolled to, in order. */
function scrolledItemIds(): string[] {
  return codeViewMockState.scrollToCalls
    .filter((call): call is { type: string; id: string } =>
      typeof call === 'object' && call !== null && (call as { type?: string }).type === 'item')
    .map((call) => call.id);
}

describe('DiffView keyboard review', () => {
  beforeEach(() => {
    resetCodeViewMock();
  });

  it('moves the file cursor to the next file', async () => {
    const { value } = harness([entry('a.ts', { kind: 'unreviewed' }), entry('b.ts', { kind: 'unreviewed' })]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press(']');
    press('f');

    await waitFor(() => expect(scrolledItemIds()).toEqual(['committed:b.ts']));
  });

  it('marks the cursor file reviewed and advances to the next outstanding file', async () => {
    const { value, markReviewed } = harness([
      entry('a.ts', { kind: 'unreviewed' }),
      entry('b.ts', { kind: 'unreviewed' }),
    ]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('m');

    await waitFor(() => expect(markReviewed).toHaveBeenCalledWith('a.ts', 'blob-a.ts'));
    expect(scrolledItemIds()).toEqual(['committed:b.ts']);
  });

  it('unmarks an already-reviewed file and stays put', async () => {
    const { value, markReviewed, unmarkReviewed } = harness([
      entry('a.ts', { kind: 'reviewed', at_blob: 'blob-a.ts' }),
      entry('b.ts', { kind: 'unreviewed' }),
    ]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('m');

    await waitFor(() => expect(unmarkReviewed).toHaveBeenCalledWith('a.ts'));
    expect(markReviewed).not.toHaveBeenCalled();
    expect(scrolledItemIds()).toEqual([]);
  });

  it('explains rather than silently ignoring a file the manifest does not track', async () => {
    const { value, markReviewed } = harness([entry('elsewhere.ts', { kind: 'unreviewed' })]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('m');

    expect(await screen.findByRole('status')).toHaveTextContent(/a\.ts is not on this conversation's review checklist/);
    expect(markReviewed).not.toHaveBeenCalled();
  });

  it('refreshes the diff payload and the manifest', async () => {
    const { value, refresh } = harness([entry('a.ts', { kind: 'unreviewed' })]);
    const { onRefresh } = renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('R');

    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
    expect(refresh).toHaveBeenCalled();
  });

  it('closes on q', async () => {
    const { value } = harness([entry('a.ts', { kind: 'unreviewed' })]);
    const onClose = vi.fn();
    renderDiff(value, onClose);
    await screen.findByTestId('codeview-mock');

    press('q');

    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('scrolls the viewport by a page without moving the file cursor', async () => {
    const { value } = harness([entry('a.ts', { kind: 'unreviewed' })]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('d', { ctrlKey: true });

    // Mock viewport is 400px tall, so a half page is 200px from a 0 start.
    await waitFor(() => expect(codeViewMockState.scrollToCalls).toContainEqual({
      type: 'position',
      position: 200,
      behavior: 'instant',
    }));
    expect(scrolledItemIds()).toEqual([]);
  });

  it('comments on the line named by a typed count, on the cursor file', async () => {
    const { value } = harness([entry('a.ts', { kind: 'unreviewed' })]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('4');
    press('2');
    press('c');

    await screen.findByPlaceholderText(/Add your note/);
    expect(screen.getByText('a.ts:42')).toBeInTheDocument();
    expect(screen.getByText('line 42 of a.ts')).toBeInTheDocument();
    // The commented line is brought into view, as a gutter click would.
    expect(codeViewMockState.scrollToCalls).toContainEqual(
      expect.objectContaining({ type: 'line', id: 'committed:a.ts', lineNumber: 42, side: 'additions' }),
    );
  });

  it('keeps a typed count out of the UI entirely', async () => {
    const { value } = harness([entry('a.ts', { kind: 'unreviewed' })]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('4');
    press('2');

    // The count is armed but never painted: no banner, no status region.
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    // ...and it still drives the next annotate command.
    press('c');
    await screen.findByPlaceholderText(/Add your note/);
    expect(screen.getByText('a.ts:42')).toBeInTheDocument();
  });

  it('explains rather than silently ignoring a line that is not in the diff', async () => {
    const { value } = harness([entry('a.ts', { kind: 'unreviewed' })]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('9');
    press('9');
    press('c');

    expect(await screen.findByRole('status')).toHaveTextContent(/Line 99 is not in the diff for a\.ts/);
    expect(screen.queryByPlaceholderText(/Add your note/)).not.toBeInTheDocument();
  });

  it('clears a typed count when another command intervenes', async () => {
    const { value } = harness([entry('a.ts', { kind: 'unreviewed' })]);
    renderDiff(value);
    await screen.findByTestId('codeview-mock');

    press('4');
    press('2');
    press('j');
    press('c');

    // The count went to the scroll, so `c` falls back to a file-level note.
    await screen.findByPlaceholderText(/Add your note/);
    expect(screen.getByText('a.ts (file-level)')).toBeInTheDocument();
  });

  it('does not act on review keys while the annotation dialog is open', async () => {
    const { value, markReviewed } = harness([entry('a.ts', { kind: 'unreviewed' })]);
    const onClose = vi.fn();
    renderDiff(value, onClose);
    await screen.findByTestId('codeview-mock');

    fireEvent.click(screen.getAllByRole('button', { name: /Add file-level note/ })[0]!);
    await screen.findByPlaceholderText(/Add your note/);

    press('m');
    press('q');

    expect(markReviewed).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
