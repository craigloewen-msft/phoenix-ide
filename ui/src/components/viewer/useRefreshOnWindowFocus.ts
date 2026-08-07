/**
 * Refresh a review surface when the window regains focus.
 *
 * Reviewers edit the same files in another editor, so the diff on screen goes
 * stale while Phoenix is in the background. Returning to the tab is both the
 * moment staleness matters and a signal the user generated, which makes it a
 * better trigger than interval polling (which spends requests on an idle tab
 * and still lags behind the edit).
 */

import { useEffect, useRef } from 'react';

/** Ignore a second focus within this window, so alt-tabbing through Phoenix
 *  does not fire a burst of refetches. */
const FOCUS_DEBOUNCE_MS = 1500;

export function useRefreshOnWindowFocus(refresh: () => void, enabled = true) {
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const lastRunRef = useRef(0);

  useEffect(() => {
    if (!enabled) return undefined;
    const onFocus = () => {
      // A hidden document's focus event is not the user looking at the diff.
      if (document.visibilityState === 'hidden') return;
      const now = Date.now();
      if (now - lastRunRef.current < FOCUS_DEBOUNCE_MS) return;
      lastRunRef.current = now;
      refreshRef.current();
    };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [enabled]);
}
