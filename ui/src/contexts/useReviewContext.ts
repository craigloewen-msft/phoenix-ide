/**
 * Reader for the conversation-scoped review state provided by
 * `ReviewProvider`.
 *
 * Split from the provider module so the context file only exports components
 * (React Fast Refresh requirement).
 */

import { useContext } from 'react';
import { ReviewContext, type ReviewContextValue } from './reviewContextCore';

/** Null outside a ReviewProvider — callers render their non-review path. */
export function useReviewContext(): ReviewContextValue | null {
  return useContext(ReviewContext);
}
