/**
 * Review state for the changed-files list, shared by the sidebar and the
 * file viewer's diff mode.
 *
 * The manifest is server-owned: every mutation returns the fresh manifest
 * rather than patching a local copy, so the two surfaces cannot drift.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type ReviewFileEntry, type ReviewManifestResponse } from '../api';

export interface UseReviewManifest {
  manifest: ReviewManifestResponse | null;
  loading: boolean;
  error: string | null;
  /** Files still needing attention: never reviewed, or changed since review. */
  outstanding: ReviewFileEntry[];
  /** True when every changed file is reviewed and none went stale. */
  complete: boolean;
  refresh: () => void;
  markReviewed: (path: string, observedBlobSha: string) => Promise<void>;
  unmarkReviewed: (path: string) => Promise<void>;
}

export function useReviewManifest(
  conversationId: string | undefined,
  enabled: boolean,
): UseReviewManifest {
  const [manifest, setManifest] = useState<ReviewManifestResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!conversationId || !enabled) {
      setManifest(null);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    api
      .getReviewFiles(conversationId, controller.signal)
      .then((next) => {
        setManifest(next);
        setError(null);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load review files');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conversationId, enabled, reloadToken]);

  const refresh = useCallback(() => setReloadToken((n) => n + 1), []);

  const markReviewed = useCallback(
    async (path: string, observedBlobSha: string) => {
      if (!conversationId) return;
      try {
        setManifest(await api.markFileReviewed(conversationId, path, observedBlobSha));
        setError(null);
      } catch (err) {
        // A rejected mark means the file moved under the user. Resync so they
        // see the new state rather than a stale row they think they approved.
        setError(err instanceof Error ? err.message : 'Failed to mark reviewed');
        refresh();
      }
    },
    [conversationId, refresh],
  );

  const unmarkReviewed = useCallback(
    async (path: string) => {
      if (!conversationId) return;
      try {
        setManifest(await api.unmarkFileReviewed(conversationId, path));
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to unmark file');
        refresh();
      }
    },
    [conversationId, refresh],
  );

  const outstanding = useMemo(
    () => (manifest?.files ?? []).filter((f) => f.review.kind !== 'reviewed'),
    [manifest],
  );

  return {
    manifest,
    loading,
    error,
    outstanding,
    complete: manifest !== null && manifest.total_count > 0 && outstanding.length === 0,
    refresh,
    markReviewed,
    unmarkReviewed,
  };
}
