/**
 * useReviewKeyboard - the React shell around the pure review keymap.
 *
 * Owns only what the resolver cannot: the pending state (a held multi-key
 * prefix or a typed count) and the prefix's expiry timer. Everything about
 * *meaning* lives in `reviewKeymap.ts`; this hook routes the resolved command
 * to the surface's handlers.
 *
 * Registration goes through the shared keyboard router rather than a raw
 * window listener, so a review surface only owns these keys while it is the
 * topmost scope and no text field has focus.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useKeyboardRouterShortcut } from '../../hooks/useFocusScope';
import {
  REVIEW_PENDING_NONE,
  REVIEW_PREFIX_TIMEOUT_MS,
  resolveReviewKey,
  type ReviewCommand,
  type ReviewPending,
} from './reviewKeymap';

export interface UseReviewKeyboardOptions {
  /** Focus scope this surface registered; the keys are live only while it is
   *  topmost. */
  scopeId: string;
  /** Distinguishes the two review surfaces in the router's registration map. */
  id: string;
  onCommand: (command: ReviewCommand) => void;
  enabled?: boolean;
  /** True while an annotation dialog (or similar) owns input. */
  dialogOpen?: boolean;
}

export interface UseReviewKeyboardResult {
  /** The count typed so far, for the surface to display. A count is modal
   *  state, and modal state the user cannot see is a trap. */
  pendingCount: number | null;
}

export function useReviewKeyboard({
  scopeId,
  id,
  onCommand,
  enabled = true,
  dialogOpen = false,
}: UseReviewKeyboardOptions): UseReviewKeyboardResult {
  // The ref is what the (non-reactive) key handler reads; the state exists only
  // to render the count. Both are written together in `setPending`.
  const pendingRef = useRef<ReviewPending>(REVIEW_PENDING_NONE);
  const [pendingCount, setPendingCount] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setPending = useCallback((next: ReviewPending) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pendingRef.current = next;
    setPendingCount(next.count);
  }, []);

  const clearPending = useCallback(() => setPending(REVIEW_PENDING_NONE), [setPending]);

  useEffect(() => clearPending, [clearPending]);

  const handler = useCallback(
    (event: KeyboardEvent) => {
      const resolution = resolveReviewKey(pendingRef.current, event);
      clearPending();
      if (resolution.kind === 'none') return;

      // Only claim the event once the surface is actually acting on it, so an
      // abandoned sequence leaves the key to whoever else wants it.
      event.preventDefault();
      event.stopPropagation();

      if (resolution.kind === 'pending') {
        setPending(resolution.pending);
        // A held prefix expires so a forgotten `g` doesn't swallow the next key
        // minutes later. A count does not: it is visible on screen, so it
        // vanishing under the reviewer mid-type would be the surprise.
        if (resolution.pending.prefix !== null) {
          timerRef.current = setTimeout(clearPending, REVIEW_PREFIX_TIMEOUT_MS);
        }
        return;
      }
      onCommand(resolution.command);
    },
    [clearPending, onCommand, setPending],
  );

  const registration = useMemo(
    () => ({
      id: `review-keys:${id}`,
      layer: 'viewer' as const,
      key: 'review-key' as const,
      scopeId,
      enabled,
      dialogOpen,
      handler,
    }),
    [dialogOpen, enabled, handler, id, scopeId],
  );

  useKeyboardRouterShortcut(registration);

  // A dialog opening mid-sequence must not leave a prefix or count armed for
  // when it closes.
  useEffect(() => {
    if (dialogOpen || !enabled) clearPending();
  }, [clearPending, dialogOpen, enabled]);

  return { pendingCount };
}
