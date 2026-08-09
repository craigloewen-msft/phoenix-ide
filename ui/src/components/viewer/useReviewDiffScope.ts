/**
 * Shared review-diff scope preference for the per-file review diff: full diff
 * against the review comparator, or only what changed since the user last
 * marked the file reviewed.
 *
 * Persisted and shared rather than per-mount, because "only show me what is
 * new" is a standing intent for a whole review pass. Component-local state
 * would silently drop back to the full diff on every file the reviewer opens.
 */

import { useCallback, useState } from 'react';
import type { ReviewDiffScope } from '../../api';

const REVIEW_DIFF_SCOPE_KEY = 'phoenix-review-diff-scope';

function initialReviewDiffScope(): ReviewDiffScope {
  return localStorage.getItem(REVIEW_DIFF_SCOPE_KEY) === 'since_review' ? 'since_review' : 'full';
}

export function useReviewDiffScope(): {
  scopePreference: ReviewDiffScope;
  toggleScopePreference: () => void;
} {
  const [scopePreference, setScopePreference] = useState<ReviewDiffScope>(initialReviewDiffScope);
  const toggleScopePreference = useCallback(() => {
    setScopePreference((prev) => {
      const next = prev === 'full' ? 'since_review' : 'full';
      localStorage.setItem(REVIEW_DIFF_SCOPE_KEY, next);
      return next;
    });
  }, []);
  return { scopePreference, toggleScopePreference };
}
