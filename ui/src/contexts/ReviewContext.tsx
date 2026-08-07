/**
 * Conversation-scoped review state.
 *
 * Both the sidebar checklist and the file viewer's diff mode read from one
 * manifest here, so marking a file reviewed in the viewer updates the sidebar
 * (and the reverse) without either surface owning a private copy that could
 * drift from the server.
 */

import { useEffect, useMemo, useRef } from 'react';
import type { ReactNode } from 'react';
import { useReviewManifest } from '../hooks/useReviewManifest';
import { ReviewContext, type ReviewContextValue } from './reviewContextCore';

interface ProviderProps {
  children: ReactNode;
  conversationId: string | undefined;
  rootDir: string | null;
  /** Only fetch where a base branch exists to diff against. */
  enabled: boolean;
  /** Live conversation state type; a working->idle edge means new changes. */
  agentState: string | undefined;
}

export function ReviewProvider({ children, conversationId, rootDir, enabled, agentState }: ProviderProps) {
  const manifest = useReviewManifest(conversationId, enabled);
  const { refresh } = manifest;

  // Refresh when the agent stops working: that transition is exactly when new
  // changes have landed, so previously-reviewed files can go stale. Watching
  // the existing SSE-driven conversation state avoids polling and avoids a
  // second server-side notion of "the review changed".
  const working = agentState !== undefined && agentState !== 'idle';
  const wasWorking = useRef(working);
  useEffect(() => {
    if (wasWorking.current && !working && enabled) refresh();
    wasWorking.current = working;
  }, [working, enabled, refresh]);

  const value = useMemo<ReviewContextValue>(
    () => ({ ...manifest, conversationId, rootDir }),
    [manifest, conversationId, rootDir],
  );
  return <ReviewContext.Provider value={value}>{children}</ReviewContext.Provider>;
}
