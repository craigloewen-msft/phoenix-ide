/**
 * Context object and value shape for conversation-scoped review state.
 *
 * Separated from the provider component so both the provider and the reader
 * hook can import it without either module mixing components and non-component
 * exports.
 */

import { createContext } from 'react';
import type { UseReviewManifest } from '../hooks/useReviewManifest';

export interface ReviewContextValue extends UseReviewManifest {
  conversationId: string | undefined;
  /** Worktree root; repo-relative manifest paths resolve against it. */
  rootDir: string | null;
}

export const ReviewContext = createContext<ReviewContextValue | null>(null);
