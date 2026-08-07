import { describe, expect, it, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ChangedFilesReview } from './ChangedFilesReview';
import type { ReviewFileEntry } from '../../api';
import type { UseReviewManifest } from '../../hooks/useReviewManifest';

function entry(path: string, review: ReviewFileEntry['review']): ReviewFileEntry {
  return {
    path,
    status: 'modified',
    insertions: 3,
    deletions: 1,
    current_blob_sha: 'blob-current',
    review,
  };
}

function harness(files: ReviewFileEntry[]): UseReviewManifest {
  const outstanding = files.filter((f) => f.review.kind !== 'reviewed');
  return {
    manifest: {
      comparator: 'main',
      files,
      reviewed_count: files.length - outstanding.length,
      total_count: files.length,
    },
    loading: false,
    error: null,
    outstanding,
    complete: files.length > 0 && outstanding.length === 0,
    refresh: vi.fn(),
    markReviewed: vi.fn(),
    unmarkReviewed: vi.fn(),
  };
}

function renderList(review: UseReviewManifest, onOpenDiff = vi.fn(), onComplete = vi.fn()) {
  render(
    <ChangedFilesReview
      review={review}
      activePath={null}
      onOpenDiff={onOpenDiff}
      onCompleteReview={onComplete}
    />,
  );
  return { onOpenDiff, onComplete };
}

describe('ChangedFilesReview', () => {
  beforeEach(() => vi.clearAllMocks());

  it('shows progress and the comparator being reviewed against', () => {
    renderList(
      harness([
        entry('src/a.ts', { kind: 'reviewed', at_blob: 'blob-current' }),
        entry('src/b.ts', { kind: 'unreviewed' }),
      ]),
    );

    expect(screen.getByText('1/2 reviewed')).toBeTruthy();
    // The user must never have to guess what the diff is relative to.
    expect(screen.getByText('vs main')).toBeTruthy();
  });

  it('distinguishes reviewed from reviewed-but-changed-since', () => {
    renderList(
      harness([
        entry('src/done.ts', { kind: 'reviewed', at_blob: 'blob-current' }),
        entry('src/stale.ts', {
          kind: 'reviewed_stale',
          at_blob: 'blob-old',
          current_blob: 'blob-current',
        }),
        entry('src/fresh.ts', { kind: 'unreviewed' }),
      ]),
    );

    expect(screen.getByTitle('Reviewed')).toBeTruthy();
    expect(screen.getByTitle('Changed since you reviewed it')).toBeTruthy();
    expect(screen.getByTitle('Not reviewed')).toBeTruthy();
  });

  it('opens the clicked file for review', () => {
    const { onOpenDiff } = renderList(harness([entry('src/a.ts', { kind: 'unreviewed' })]));

    fireEvent.click(screen.getByTitle('src/a.ts (modified)'));

    expect(onOpenDiff).toHaveBeenCalledWith('src/a.ts');
  });

  it('offers Complete review only when nothing is outstanding', () => {
    const { unmount } = render(
      <ChangedFilesReview
        review={harness([
          entry('src/a.ts', { kind: 'reviewed', at_blob: 'blob-current' }),
          entry('src/b.ts', { kind: 'unreviewed' }),
        ])}
        activePath={null}
        onOpenDiff={vi.fn()}
        onCompleteReview={vi.fn()}
      />,
    );
    expect(screen.queryByText('Complete review')).toBeNull();
    unmount();

    renderList(harness([entry('src/a.ts', { kind: 'reviewed', at_blob: 'blob-current' })]));
    expect(screen.getByText('Complete review')).toBeTruthy();
  });

  it('withholds Complete review while a reviewed file has gone stale', () => {
    // The whole point of the loop: an agent edit after review reopens the work,
    // so a fully-marked-then-edited set must not read as done.
    renderList(
      harness([
        entry('src/a.ts', {
          kind: 'reviewed_stale',
          at_blob: 'blob-old',
          current_blob: 'blob-current',
        }),
      ]),
    );

    expect(screen.queryByText('Complete review')).toBeNull();
    expect(screen.getByText('0/1 reviewed')).toBeTruthy();
  });
});
