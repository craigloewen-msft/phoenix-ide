/**
 * Fetches the file contents that let the diff viewer reveal unmodified lines
 * around a hunk (GitHub-style "expand context").
 *
 * Files are requested by the blob object ids their patch recorded, so the
 * server can return content that is provably the version the diff was computed
 * against rather than whatever is on disk now.
 *
 * Expansion is strictly additive: until contents arrive — or if they never do —
 * the diff renders exactly as before, without expansion affordances. Fetch
 * failures are therefore not surfaced as errors; a reviewer who cannot expand
 * is in the same position they were before the feature existed.
 */

import { useEffect, useMemo, useState } from 'react';
import { api, type DiffExpansionFileRequest } from '../../api';
import type { SectionFileSource } from './pierreDiffMapping';

export interface ExpansionContents {
  oldContents: string;
  newContents: string;
}

export interface UseDiffExpansionArgs {
  /** Absent for hosts that supply a static diff and have no conversation to
   *  fetch against; expansion is then simply unavailable. */
  conversationId?: string | undefined;
  sources: readonly SectionFileSource[];
  /** Sections whose diff text the server truncated. Expansion is suppressed for
   *  them: the patch we hold is not the whole patch, so a hydrated parse would
   *  disagree with the file and be rejected anyway. */
  truncatedSections: ReadonlySet<SectionFileSource['section']>;
}

/** Item id → both file sides, for every file whose contents resolved. */
export function useDiffExpansion({
  conversationId,
  sources,
  truncatedSections,
}: UseDiffExpansionArgs): ReadonlyMap<string, ExpansionContents> {
  const [contents, setContents] = useState<ReadonlyMap<string, ExpansionContents>>(EMPTY);

  const requestable = useMemo(
    () => sources.filter((source) => !truncatedSections.has(source.section)),
    [sources, truncatedSections],
  );

  // Identity of the request, so a re-render with an equivalent file list does
  // not refetch, while a genuinely new diff (different blob ids) does.
  const requestKey = useMemo(
    () => requestable
      .map((s) => `${s.itemId}\u0000${s.prevObjectId}\u0000${s.newObjectId}`)
      .join('\u0001'),
    [requestable],
  );

  useEffect(() => {
    if (!conversationId || requestable.length === 0) {
      setContents(EMPTY);
      return undefined;
    }
    const controller = new AbortController();
    // Clear first: contents fetched for the previous diff must never be applied
    // to this one. The item ids would often match, so stale contents would
    // hydrate against the wrong patch — caught by hydration's verification, but
    // better not to offer them at all.
    setContents(EMPTY);

    const files: DiffExpansionFileRequest[] = requestable.map((s) => ({
      path: s.filePath,
      prev_object_id: s.prevObjectId,
      new_object_id: s.newObjectId,
      section: s.section,
    }));

    api.getDiffExpansion(conversationId, files, controller.signal)
      .then((response) => {
        if (controller.signal.aborted) return;
        const byId = new Map<string, ExpansionContents>();
        for (const file of response.files) {
          if (file.old_side.status !== 'available' || file.new_side.status !== 'available') {
            continue;
          }
          // Match the response back to the item by the same triple it was
          // requested with, so a file can never receive another file's content.
          const source = requestable.find(
            (s) => s.filePath === file.path
              && s.prevObjectId === file.prev_object_id
              && s.newObjectId === file.new_object_id,
          );
          if (!source) continue;
          byId.set(source.itemId, {
            oldContents: file.old_side.contents,
            newContents: file.new_side.contents,
          });
        }
        setContents(byId);
      })
      .catch(() => {
        // Expansion is an enhancement; failing to fetch it leaves the diff
        // fully readable, so this is logged rather than surfaced.
        if (!controller.signal.aborted) {
          console.debug('[diff-expansion] could not fetch file contents; expansion unavailable');
        }
      });

    return () => controller.abort();
    // `requestKey` stands in for `requestable`'s contents by value.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId, requestKey]);

  return contents;
}

const EMPTY: ReadonlyMap<string, ExpansionContents> = new Map();
