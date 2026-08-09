import './ReviewKeyboardNotice.css';

/** Why a review hotkey did nothing. Rendered in the review surface's banner slot. */
export function ReviewKeyboardNotice({ notice }: { notice: string }) {
  return <div className="diff-keyboard-notice" role="status">{notice}</div>;
}
