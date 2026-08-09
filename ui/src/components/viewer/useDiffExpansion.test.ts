/**
 * `useDiffExpansion` decides *which* files may be expanded and matches fetched
 * contents back to them. Both are correctness-bearing: requesting a truncated
 * section would derive context from an incomplete patch, and mismatching a
 * response to the wrong file would hand Pierre content for a different file.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useDiffExpansion } from './useDiffExpansion';
import type { SectionFileSource } from './pierreDiffMapping';
import { api } from '../../api';

vi.mock('../../api', () => ({ api: { getDiffExpansion: vi.fn() } }));

const getDiffExpansion = api.getDiffExpansion as ReturnType<typeof vi.fn>;

function source(overrides: Partial<SectionFileSource> = {}): SectionFileSource {
  return {
    itemId: 'committed:src/a.ts',
    section: 'committed',
    filePath: 'src/a.ts',
    prevObjectId: 'aaaaaaa',
    newObjectId: 'bbbbbbb',
    patchText: 'diff --git a/src/a.ts b/src/a.ts',
    ...overrides,
  };
}

beforeEach(() => {
  getDiffExpansion.mockReset();
  getDiffExpansion.mockResolvedValue({ files: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('useDiffExpansion', () => {
  // REQ-DIFFEXP-005. A truncated section's patch text is incomplete, so context
  // derived from it could not be shown to match the diff.
  it('does not request files from a truncated section', async () => {
    renderHook(() => useDiffExpansion({
      conversationId: 'c1',
      sources: [source(), source({ itemId: 'uncommitted:src/b.ts', section: 'uncommitted', filePath: 'src/b.ts' })],
      truncatedSections: new Set(['committed']),
    }));

    await waitFor(() => expect(getDiffExpansion).toHaveBeenCalled());
    const [, files] = getDiffExpansion.mock.calls[0]!;
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ path: 'src/b.ts', section: 'uncommitted' });
  });

  it('requests nothing when every section is truncated', async () => {
    const { result } = renderHook(() => useDiffExpansion({
      conversationId: 'c1',
      sources: [source()],
      truncatedSections: new Set(['committed', 'uncommitted']),
    }));

    await waitFor(() => expect(result.current.size).toBe(0));
    expect(getDiffExpansion).not.toHaveBeenCalled();
  });

  // Without a conversation there is no worktree to resolve against, so the diff
  // simply renders without expansion.
  it('requests nothing when there is no conversation', async () => {
    const { result } = renderHook(() => useDiffExpansion({
      conversationId: undefined,
      sources: [source()],
      truncatedSections: new Set(),
    }));

    await waitFor(() => expect(result.current.size).toBe(0));
    expect(getDiffExpansion).not.toHaveBeenCalled();
  });

  it('exposes contents keyed by item id when both sides resolve', async () => {
    getDiffExpansion.mockResolvedValue({
      files: [{
        path: 'src/a.ts',
        prev_object_id: 'aaaaaaa',
        new_object_id: 'bbbbbbb',
        old_side: { status: 'available', contents: 'old\n' },
        new_side: { status: 'available', contents: 'new\n' },
      }],
    });

    const { result } = renderHook(() => useDiffExpansion({
      conversationId: 'c1',
      sources: [source()],
      truncatedSections: new Set(),
    }));

    await waitFor(() => expect(result.current.size).toBe(1));
    expect(result.current.get('committed:src/a.ts')).toEqual({
      oldContents: 'old\n',
      newContents: 'new\n',
    });
  });

  // A file is only expandable when *both* sides resolved; half a file would
  // leave Pierre parsing against content it cannot align.
  it('omits a file when either side is unavailable', async () => {
    getDiffExpansion.mockResolvedValue({
      files: [{
        path: 'src/a.ts',
        prev_object_id: 'aaaaaaa',
        new_object_id: 'bbbbbbb',
        old_side: { status: 'unavailable', reason: 'binary' },
        new_side: { status: 'available', contents: 'new\n' },
      }],
    });

    const { result } = renderHook(() => useDiffExpansion({
      conversationId: 'c1',
      sources: [source()],
      truncatedSections: new Set(),
    }));

    await waitFor(() => expect(getDiffExpansion).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });

  // The object ids are what tie a response to a specific version of a file, so
  // a response naming different ids must not be applied.
  it('ignores a response whose object ids do not match the request', async () => {
    getDiffExpansion.mockResolvedValue({
      files: [{
        path: 'src/a.ts',
        prev_object_id: 'different',
        new_object_id: 'other',
        old_side: { status: 'available', contents: 'old\n' },
        new_side: { status: 'available', contents: 'new\n' },
      }],
    });

    const { result } = renderHook(() => useDiffExpansion({
      conversationId: 'c1',
      sources: [source()],
      truncatedSections: new Set(),
    }));

    await waitFor(() => expect(getDiffExpansion).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });

  // Expansion is an enhancement; a failure leaves the diff fully readable.
  it('leaves contents empty when the fetch fails', async () => {
    getDiffExpansion.mockRejectedValue(new Error('network'));

    const { result } = renderHook(() => useDiffExpansion({
      conversationId: 'c1',
      sources: [source()],
      truncatedSections: new Set(),
    }));

    await waitFor(() => expect(getDiffExpansion).toHaveBeenCalled());
    expect(result.current.size).toBe(0);
  });
});
