import './ReviewCountIndicator.css';

/**
 * The vim-style count the reviewer has typed so far (`144` of a pending
 * `144c`), rendered in the review surface's banner slot.
 *
 * A count changes what the next key does, so leaving it invisible would make
 * the surface modal without saying so.
 */
export function ReviewCountIndicator({ count }: { count: number }) {
  return (
    <div className="review-count-indicator" role="status" aria-label={`Pending line number ${count}`}>
      <span className="review-count-indicator-value">{count}</span>
      <span className="review-count-indicator-hint">c to comment on this line</span>
    </div>
  );
}

/** Why a review hotkey did nothing. Shares the banner slot with the count. */
export function ReviewKeyboardNotice({ notice }: { notice: string }) {
  return <div className="diff-keyboard-notice" role="status">{notice}</div>;
}
