/**
 * Header controls shared by the diff surfaces: the unified/side-by-side
 * rendering toggle, and the review-focus toggle that collapses the conversation
 * column so a split-pane review gets the full window width.
 */

import { Columns2, PanelLeftClose, PanelLeftOpen, Rows3 } from 'lucide-react';
import type { DiffStyle } from './useDiffStyle';

export function DiffStyleToggleButton({
  diffStyle,
  onToggle,
}: {
  diffStyle: DiffStyle;
  onToggle: () => void;
}) {
  const label = diffStyle === 'unified' ? 'Switch to split view' : 'Switch to unified view';
  return (
    <button
      type="button"
      className="viewer-shell-btn"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={diffStyle === 'split'}
      title={diffStyle === 'unified' ? 'Split view' : 'Unified view'}
    >
      {diffStyle === 'unified' ? <Columns2 size={18} /> : <Rows3 size={18} />}
    </button>
  );
}

export function ReviewFocusToggleButton({
  reviewFocus,
  onToggle,
}: {
  reviewFocus: boolean;
  onToggle: () => void;
}) {
  const label = reviewFocus ? 'Show conversation' : 'Collapse conversation';
  return (
    <button
      type="button"
      className="viewer-shell-btn"
      onClick={onToggle}
      aria-label={label}
      aria-pressed={reviewFocus}
      title={label}
    >
      {reviewFocus ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
    </button>
  );
}
