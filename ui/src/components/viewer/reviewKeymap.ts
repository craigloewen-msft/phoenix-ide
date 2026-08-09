/**
 * reviewKeymap - the vim-style binding table for Phoenix's diff-review
 * surfaces, plus the pure resolver that turns key events into commands.
 *
 * Pure by construction: no React, no DOM, no side effects. The React shell
 * (`useReviewKeyboard`) owns the pending state and dispatches the commands;
 * this module owns *what* each key means.
 *
 * The binding table is the single source of truth: the resolver, the help
 * panel's "Diff Review" group, and the tests all read it, so a binding cannot
 * exist without appearing in the guide.
 */

/** Everything the review surfaces can be asked to do from the keyboard. */
export type ReviewCommand =
  | { kind: 'scroll-lines'; lines: number }
  | { kind: 'scroll-page'; direction: 'down' | 'up' }
  | { kind: 'scroll-edge'; edge: 'top' | 'bottom' }
  | { kind: 'toggle-reviewed' }
  | { kind: 'next-file' }
  | { kind: 'prev-file' }
  | { kind: 'next-unreviewed' }
  | { kind: 'annotate-file' }
  | { kind: 'annotate-line'; lineNumber: number }
  | { kind: 'refresh' }
  | { kind: 'close' }
  | { kind: 'help' };

/** A held multi-key prefix. */
export type ReviewKeyPrefix = 'g' | ']' | '[';

/**
 * Everything a half-typed command carries: a held multi-key prefix and a typed
 * count. One value rather than two independent ones, so a key press has a
 * single clearing rule and the two halves cannot disagree about what is in
 * flight.
 *
 * A prefix and a count are never held together: starting a prefix drops the
 * count, and a digit drops the prefix.
 */
export interface ReviewPending {
  prefix: ReviewKeyPrefix | null;
  count: number | null;
}

export const REVIEW_PENDING_NONE: ReviewPending = { prefix: null, count: null };

/**
 * Outcome of feeding one key event to the resolver.
 *
 * `pending` means the key did not complete a command and the caller must hold
 * the returned state; `none` means this surface does not own the key and must
 * leave the event alone (no preventDefault, pending state cleared).
 */
export type ReviewKeyResolution =
  | { kind: 'command'; command: ReviewCommand }
  | { kind: 'pending'; pending: ReviewPending }
  | { kind: 'none' };

/** The subset of KeyboardEvent the resolver reads, so it stays testable. */
export interface ReviewKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
}

/** How long a pending prefix waits for its second key. */
export const REVIEW_PREFIX_TIMEOUT_MS = 1000;

export interface ReviewBinding {
  /** Display form, e.g. `gg` or `Ctrl+d`. */
  keys: string;
  description: string;
}

/**
 * Display table for the help guide, in the order a reviewer learns them: move
 * within a file, move between files, act, then leave.
 */
export const REVIEW_BINDINGS: readonly ReviewBinding[] = [
  { keys: 'j / k', description: 'Scroll down / up one line' },
  { keys: '{n}j / {n}k', description: 'Scroll n lines down / up' },
  { keys: 'Ctrl+d / Ctrl+u', description: 'Scroll half a page down / up' },
  { keys: 'gg / G', description: 'Jump to the top / bottom' },
  { keys: ']f / [f', description: 'Next / previous file (also n / N)' },
  { keys: ']u', description: 'Next file still needing review' },
  { keys: 'm', description: 'Toggle reviewed, then advance to the next unreviewed file' },
  { keys: 'c', description: 'Add a note on the current file' },
  { keys: '{n}c', description: 'Add a note on line n of the current file' },
  { keys: 'R', description: 'Refresh the diff and review state from disk' },
  { keys: 'q', description: 'Close the review surface' },
  { keys: '?', description: 'Show this guide' },
];

function resolved(command: ReviewCommand): ReviewKeyResolution {
  return { kind: 'command', command };
}

const NONE: ReviewKeyResolution = { kind: 'none' };

/** Upper bound on a typed count. A reviewer types a line number they can see;
 *  anything longer is a stuck key, and capping keeps the accumulator away from
 *  precision loss. */
const MAX_COUNT = 9_999_999;

function digitOf(key: string): number | null {
  if (key.length !== 1 || key < '0' || key > '9') return null;
  return key.charCodeAt(0) - 48;
}

/**
 * Resolve one key press against the currently-held pending state.
 *
 * A prefix consumes exactly one following key: an unrecognised second key
 * resolves to `none` (the sequence is abandoned) rather than falling back to
 * the unprefixed meaning, so `g` then `j` never silently scrolls.
 *
 * A count accumulates across digits and is consumed by the next command that
 * takes one (`c`, `j`, `k`); any other key resolves with the count simply
 * dropped, which is what makes the state neovim-like rather than sticky.
 */
export function resolveReviewKey(
  pending: ReviewPending,
  event: ReviewKeyEvent,
): ReviewKeyResolution {
  // Ctrl is claimed only by the half-page motions; Meta and Alt are never ours
  // (they belong to the browser and to app-level shortcuts).
  if (event.metaKey || event.altKey) return NONE;

  if (event.ctrlKey) {
    if (pending.prefix !== null) return NONE;
    const key = event.key.toLowerCase();
    if (key === 'd') return resolved({ kind: 'scroll-page', direction: 'down' });
    if (key === 'u') return resolved({ kind: 'scroll-page', direction: 'up' });
    return NONE;
  }

  if (pending.prefix === 'g') {
    return event.key === 'g' ? resolved({ kind: 'scroll-edge', edge: 'top' }) : NONE;
  }
  if (pending.prefix === ']') {
    if (event.key === 'f') return resolved({ kind: 'next-file' });
    if (event.key === 'u') return resolved({ kind: 'next-unreviewed' });
    return NONE;
  }
  if (pending.prefix === '[') {
    return event.key === 'f' ? resolved({ kind: 'prev-file' }) : NONE;
  }

  const digit = digitOf(event.key);
  if (digit !== null) {
    // A leading `0` is not a count (vim reserves it as a motion), so it only
    // counts once digits are already accumulating.
    if (pending.count === null && digit === 0) return NONE;
    const next = Math.min((pending.count ?? 0) * 10 + digit, MAX_COUNT);
    return { kind: 'pending', pending: { prefix: null, count: next } };
  }

  const count = pending.count;

  switch (event.key) {
    case 'j':
      return resolved({ kind: 'scroll-lines', lines: count ?? 1 });
    case 'k':
      return resolved({ kind: 'scroll-lines', lines: -(count ?? 1) });
    case 'G':
      return resolved({ kind: 'scroll-edge', edge: 'bottom' });
    case 'm':
      return resolved({ kind: 'toggle-reviewed' });
    case 'n':
      return resolved({ kind: 'next-file' });
    case 'N':
      return resolved({ kind: 'prev-file' });
    case 'c':
      return count === null
        ? resolved({ kind: 'annotate-file' })
        : resolved({ kind: 'annotate-line', lineNumber: count });
    case 'R':
      return resolved({ kind: 'refresh' });
    case 'q':
      return resolved({ kind: 'close' });
    case '?':
      return resolved({ kind: 'help' });
    case 'g':
    case ']':
    case '[':
      return { kind: 'pending', pending: { prefix: event.key, count: null } };
    default:
      return NONE;
  }
}

/** Every shape of pending state that changes what a key means. A count of 1
 *  stands for "some count": the resolver branches on presence, not value. */
const ALL_PENDING: readonly ReviewPending[] = [
  REVIEW_PENDING_NONE,
  { prefix: null, count: 1 },
  { prefix: 'g', count: null },
  { prefix: ']', count: null },
  { prefix: '[', count: null },
];

/**
 * Whether this event could mean something to a review surface under *some*
 * pending state. The keyboard router matches registrations before the hook's
 * pending state is in scope, so eligibility is defined as "resolves to anything
 * other than none for at least one state" - derived from the resolver rather
 * than restated as a second key list that could drift from it.
 */
export function isReviewKeyCandidate(event: ReviewKeyEvent): boolean {
  return ALL_PENDING.some((pending) => resolveReviewKey(pending, event).kind !== 'none');
}
