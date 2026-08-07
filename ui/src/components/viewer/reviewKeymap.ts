/**
 * reviewKeymap - the vim-style binding table for Phoenix's diff-review
 * surfaces, plus the pure resolver that turns key events into commands.
 *
 * Pure by construction: no React, no DOM, no side effects. The React shell
 * (`useReviewKeyboard`) owns the pending-prefix state and dispatches the
 * commands; this module owns *what* each key means.
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
  | { kind: 'refresh' }
  | { kind: 'close' }
  | { kind: 'help' };

/** A held multi-key prefix. */
export type ReviewKeyPrefix = 'g' | ']' | '[';

/**
 * Outcome of feeding one key event to the resolver.
 *
 * `pending` means the key started a sequence and the caller must hold the
 * prefix; `none` means this surface does not own the key and must leave the
 * event alone (no preventDefault, prefix cleared).
 */
export type ReviewKeyResolution =
  | { kind: 'command'; command: ReviewCommand }
  | { kind: 'pending'; prefix: ReviewKeyPrefix }
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
  { keys: 'Ctrl+d / Ctrl+u', description: 'Scroll half a page down / up' },
  { keys: 'gg / G', description: 'Jump to the top / bottom' },
  { keys: ']f / [f', description: 'Next / previous file (also n / N)' },
  { keys: ']u', description: 'Next file still needing review' },
  { keys: 'm', description: 'Toggle reviewed, then advance to the next unreviewed file' },
  { keys: 'c', description: 'Add a note on the current file' },
  { keys: 'R', description: 'Refresh the diff and review state from disk' },
  { keys: 'q', description: 'Close the review surface' },
  { keys: '?', description: 'Show this guide' },
];

function resolved(command: ReviewCommand): ReviewKeyResolution {
  return { kind: 'command', command };
}

const NONE: ReviewKeyResolution = { kind: 'none' };

/**
 * Resolve one key press against the currently-held prefix.
 *
 * A prefix consumes exactly one following key: an unrecognised second key
 * resolves to `none` (the sequence is abandoned) rather than falling back to
 * the unprefixed meaning, so `g` then `j` never silently scrolls.
 */
export function resolveReviewKey(
  prefix: ReviewKeyPrefix | null,
  event: ReviewKeyEvent,
): ReviewKeyResolution {
  // Ctrl is claimed only by the half-page motions; Meta and Alt are never ours
  // (they belong to the browser and to app-level shortcuts).
  if (event.metaKey || event.altKey) return NONE;

  if (event.ctrlKey) {
    if (prefix !== null) return NONE;
    const key = event.key.toLowerCase();
    if (key === 'd') return resolved({ kind: 'scroll-page', direction: 'down' });
    if (key === 'u') return resolved({ kind: 'scroll-page', direction: 'up' });
    return NONE;
  }

  if (prefix === 'g') {
    return event.key === 'g' ? resolved({ kind: 'scroll-edge', edge: 'top' }) : NONE;
  }
  if (prefix === ']') {
    if (event.key === 'f') return resolved({ kind: 'next-file' });
    if (event.key === 'u') return resolved({ kind: 'next-unreviewed' });
    return NONE;
  }
  if (prefix === '[') {
    return event.key === 'f' ? resolved({ kind: 'prev-file' }) : NONE;
  }

  switch (event.key) {
    case 'j':
      return resolved({ kind: 'scroll-lines', lines: 1 });
    case 'k':
      return resolved({ kind: 'scroll-lines', lines: -1 });
    case 'G':
      return resolved({ kind: 'scroll-edge', edge: 'bottom' });
    case 'm':
      return resolved({ kind: 'toggle-reviewed' });
    case 'n':
      return resolved({ kind: 'next-file' });
    case 'N':
      return resolved({ kind: 'prev-file' });
    case 'c':
      return resolved({ kind: 'annotate-file' });
    case 'R':
      return resolved({ kind: 'refresh' });
    case 'q':
      return resolved({ kind: 'close' });
    case '?':
      return resolved({ kind: 'help' });
    case 'g':
    case ']':
    case '[':
      return { kind: 'pending', prefix: event.key };
    default:
      return NONE;
  }
}

const ALL_PREFIXES: readonly (ReviewKeyPrefix | null)[] = [null, 'g', ']', '['];

/**
 * Whether this event could mean something to a review surface under *some*
 * prefix state. The keyboard router matches registrations before the hook's
 * prefix state is in scope, so eligibility is defined as "resolves to anything
 * other than none for at least one prefix" - derived from the resolver rather
 * than restated as a second key list that could drift from it.
 */
export function isReviewKeyCandidate(event: ReviewKeyEvent): boolean {
  return ALL_PREFIXES.some((prefix) => resolveReviewKey(prefix, event).kind !== 'none');
}
