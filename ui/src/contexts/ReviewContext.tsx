/**
 * Conversation-scoped review state.
 *
 * Both the sidebar checklist and the file viewer's diff mode read from one
 * manifest here, so marking a file reviewed in the viewer updates the sidebar
 * (and the reverse) without either surface owning a private copy that could
 * drift from the server.
 */

import { useMemo } from 'react';
import type { ReactNode } from 'react';
import { useReviewManifest } from '../hooks/useReviewManifest';
import { ReviewContext, type ReviewContextValue } from './reviewContextCore';

interface ProviderProps {
  children: ReactNode;
  conversationId: string | undefined;
  rootDir: string | null;
  /** Only fetch where a base branch exists to diff against. */
  enabled: boolean;
}

export function ReviewProvider({ children, conversationId, rootDir, enabled }: ProviderProps) {
  const manifest = useReviewManifest(conversationId, enabled);
  const value = useMemo<ReviewContextValue>(
    () => ({ ...manifest, conversationId, rootDir }),
    [manifest, conversationId, rootDir],
  );
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}
