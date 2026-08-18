/**
 * Shared diff rendering-style preference for every Phoenix diff surface
 * (whole-branch DiffView and the per-file review diff). One persisted key means
 * a user who picks side-by-side once gets it everywhere.
 */

import { useCallback, useState } from 'react';
import { readLocalStorage, writeLocalStorage } from './storage';

export type DiffStyle = 'unified' | 'split';

const DIFF_STYLE_KEY = 'phoenix-diff-style';

function initialDiffStyle(): DiffStyle {
  return readLocalStorage(DIFF_STYLE_KEY) === 'split' ? 'split' : 'unified';
}

export function useDiffStyle(): { diffStyle: DiffStyle; toggleDiffStyle: () => void } {
  const [diffStyle, setDiffStyle] = useState<DiffStyle>(initialDiffStyle);
  const toggleDiffStyle = useCallback(() => {
    setDiffStyle((prev) => {
      const next = prev === 'unified' ? 'split' : 'unified';
      writeLocalStorage(DIFF_STYLE_KEY, next);
      return next;
    });
  }, []);
  return { diffStyle, toggleDiffStyle };
}
