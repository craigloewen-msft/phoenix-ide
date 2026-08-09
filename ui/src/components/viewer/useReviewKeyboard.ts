/**
 * useReviewKeyboard - the React shell around the pure review keymap.
 *
 * Owns only what the resolver cannot: the pending state (a held multi-key
 * prefix or a typed count) and its expiry timer. Everything about *meaning*
 * lives in `reviewKeymap.ts`; this hook routes the resolved command to the
 * surface's handlers. The pending state never renders, so it is a ref and the
 * hook returns nothing.
 *
 * Registration goes through the shared keyboard router rather than a raw
 * window listener, so a review surface only owns these keys while it is the
 * topmost scope and no text field has focus.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
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

export function useReviewKeyboard({
  scopeId,
  id,
  onCommand,
  enabled = true,
  dialogOpen = false,
}: UseReviewKeyboardOptions): void {
  // The key handler is non-reactive, so the pending prefix/count lives in a ref
  // rather than state: nothing renders from it.
  const pendingRef = useRef<ReviewPending>(REVIEW_PENDING_NONE);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const setPending = useCallback((next: ReviewPending) => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    pendingRef.current = next;
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
        // Neither a held prefix nor a typed count is visible on screen, so both
        // expire: a forgotten `g` or a half-typed line number must not silently
        // change what a key pressed minutes later does.
        timerRef.current = setTimeout(clearPending, REVIEW_PREFIX_TIMEOUT_MS);
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
}
