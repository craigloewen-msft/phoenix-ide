/**
 * useReviewKeyboard - the React shell around the pure review keymap.
 *
 * Owns only what the resolver cannot: the pending multi-key prefix and its
 * expiry timer. Everything about *meaning* lives in `reviewKeymap.ts`; this
 * hook routes the resolved command to the surface's handlers.
 *
 * Registration goes through the shared keyboard router rather than a raw
 * window listener, so a review surface only owns these keys while it is the
 * topmost scope and no text field has focus.
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useKeyboardRouterShortcut } from '../../hooks/useFocusScope';
import {
  REVIEW_PREFIX_TIMEOUT_MS,
  resolveReviewKey,
  type ReviewCommand,
  type ReviewKeyPrefix,
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
}: UseReviewKeyboardOptions) {
  const prefixRef = useRef<ReviewKeyPrefix | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const clearPrefix = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = undefined;
    prefixRef.current = null;
  }, []);

  useEffect(() => clearPrefix, [clearPrefix]);

  const handler = useCallback(
    (event: KeyboardEvent) => {
      const resolution = resolveReviewKey(prefixRef.current, event);
      clearPrefix();
      if (resolution.kind === 'none') return;

      // Only claim the event once the surface is actually acting on it, so an
      // abandoned sequence leaves the key to whoever else wants it.
      event.preventDefault();
      event.stopPropagation();

      if (resolution.kind === 'pending') {
        prefixRef.current = resolution.prefix;
        timerRef.current = setTimeout(clearPrefix, REVIEW_PREFIX_TIMEOUT_MS);
        return;
      }
      onCommand(resolution.command);
    },
    [clearPrefix, onCommand],
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

  // A dialog opening mid-sequence must not leave a prefix armed for when it
  // closes.
  useEffect(() => {
    if (dialogOpen || !enabled) clearPrefix();
  }, [clearPrefix, dialogOpen, enabled]);
}
