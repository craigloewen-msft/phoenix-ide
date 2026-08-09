import { describe, expect, it } from 'vitest';
import {
  REVIEW_BINDINGS,
  REVIEW_PENDING_NONE,
  isReviewKeyCandidate,
  resolveReviewKey,
  type ReviewCommand,
  type ReviewKeyEvent,
  type ReviewPending,
} from './reviewKeymap';

function key(k: string, modifiers: Partial<ReviewKeyEvent> = {}): ReviewKeyEvent {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, ...modifiers };
}

function commandFor(
  k: string,
  pending: ReviewPending = REVIEW_PENDING_NONE,
  modifiers: Partial<ReviewKeyEvent> = {},
): ReviewCommand | null {
  const resolution = resolveReviewKey(pending, key(k, modifiers));
  return resolution.kind === 'command' ? resolution.command : null;
}

function prefix(p: 'g' | ']' | '['): ReviewPending {
  return { prefix: p, count: null };
}

function count(n: number): ReviewPending {
  return { prefix: null, count: n };
}

/** Feed a key sequence through the resolver the way the hook does, returning
 *  the commands produced. Proves accumulation end-to-end rather than one step
 *  at a time. */
function type(keys: string[]): { commands: ReviewCommand[]; pending: ReviewPending } {
  let pending = REVIEW_PENDING_NONE;
  const commands: ReviewCommand[] = [];
  for (const k of keys) {
    const resolution = resolveReviewKey(pending, key(k));
    pending = resolution.kind === 'pending' ? resolution.pending : REVIEW_PENDING_NONE;
    if (resolution.kind === 'command') commands.push(resolution.command);
  }
  return { commands, pending };
}

describe('resolveReviewKey', () => {
  it('maps the viewport motions', () => {
    expect(commandFor('j')).toEqual({ kind: 'scroll-lines', lines: 1 });
    expect(commandFor('k')).toEqual({ kind: 'scroll-lines', lines: -1 });
    expect(commandFor('d', REVIEW_PENDING_NONE, { ctrlKey: true })).toEqual({ kind: 'scroll-page', direction: 'down' });
    expect(commandFor('u', REVIEW_PENDING_NONE, { ctrlKey: true })).toEqual({ kind: 'scroll-page', direction: 'up' });
    expect(commandFor('G')).toEqual({ kind: 'scroll-edge', edge: 'bottom' });
  });

  it('maps the review actions', () => {
    expect(commandFor('m')).toEqual({ kind: 'toggle-reviewed' });
    expect(commandFor('c')).toEqual({ kind: 'annotate-file' });
    expect(commandFor('F')).toEqual({ kind: 'toggle-review-focus' });
    expect(commandFor('R')).toEqual({ kind: 'refresh' });
    expect(commandFor('q')).toEqual({ kind: 'close' });
    expect(commandFor('?')).toEqual({ kind: 'help' });
  });

  it('treats n / N as aliases for file motion', () => {
    expect(commandFor('n')).toEqual({ kind: 'next-file' });
    expect(commandFor('N')).toEqual({ kind: 'prev-file' });
  });

  it('holds a prefix and resolves the sequence on the second key', () => {
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('g'))).toEqual({ kind: 'pending', pending: prefix('g') });
    expect(commandFor('g', prefix('g'))).toEqual({ kind: 'scroll-edge', edge: 'top' });

    expect(resolveReviewKey(REVIEW_PENDING_NONE, key(']'))).toEqual({ kind: 'pending', pending: prefix(']') });
    expect(commandFor('f', prefix(']'))).toEqual({ kind: 'next-file' });
    expect(commandFor('u', prefix(']'))).toEqual({ kind: 'next-unreviewed' });
    expect(commandFor('f', prefix('['))).toEqual({ kind: 'prev-file' });
  });

  it('abandons a sequence rather than falling back to the unprefixed meaning', () => {
    // `g` then `j` must not scroll: the user was mid-sequence.
    expect(resolveReviewKey(prefix('g'), key('j'))).toEqual({ kind: 'none' });
    expect(resolveReviewKey(prefix(']'), key('m'))).toEqual({ kind: 'none' });
  });

  it('ignores keys carrying Meta or Alt, and unclaimed Ctrl combos', () => {
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('j', { metaKey: true }))).toEqual({ kind: 'none' });
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('j', { altKey: true }))).toEqual({ kind: 'none' });
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('m', { ctrlKey: true }))).toEqual({ kind: 'none' });
    // Ctrl+F belongs to viewer find, not to the review keymap.
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('f', { ctrlKey: true }))).toEqual({ kind: 'none' });
    // ...and neither modifier form of the collapse key is ours either, so the
    // find shortcut survives a held Shift.
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('F', { ctrlKey: true }))).toEqual({ kind: 'none' });
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('F', { metaKey: true }))).toEqual({ kind: 'none' });
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('F', { altKey: true }))).toEqual({ kind: 'none' });
  });

  it('leaves unknown keys alone', () => {
    // `f` is listed deliberately: it is the second key of `]f` / `[f` and has no
    // unprefixed meaning, so a mis-tapped prefix must not reach a command.
    for (const unknown of ['a', 'z', 'f', 'Enter', 'Escape', 'ArrowDown']) {
      expect(resolveReviewKey(REVIEW_PENDING_NONE, key(unknown))).toEqual({ kind: 'none' });
    }
  });
});

describe('resolveReviewKey - count prefix', () => {
  it('accumulates digits into a count', () => {
    expect(type(['1', '4', '4']).pending).toEqual(count(144));
  });

  it('comments on the counted line, and on the file when there is no count', () => {
    expect(type(['1', '4', '4', 'c']).commands).toEqual([{ kind: 'annotate-line', lineNumber: 144 }]);
    expect(type(['c']).commands).toEqual([{ kind: 'annotate-file' }]);
  });

  it('does not start a count on a leading zero, but accepts zero as a later digit', () => {
    expect(resolveReviewKey(REVIEW_PENDING_NONE, key('0'))).toEqual({ kind: 'none' });
    expect(type(['1', '0', 'c']).commands).toEqual([{ kind: 'annotate-line', lineNumber: 10 }]);
  });

  it('repeats the line motions by the count', () => {
    expect(commandFor('j', count(12))).toEqual({ kind: 'scroll-lines', lines: 12 });
    expect(commandFor('k', count(12))).toEqual({ kind: 'scroll-lines', lines: -12 });
  });

  it('drops the count on any command that does not take one', () => {
    // The count is consumed by the resolution either way; what matters is the
    // command carries no trace of it and the caller clears the state.
    expect(commandFor('m', count(9))).toEqual({ kind: 'toggle-reviewed' });
    expect(commandFor('G', count(9))).toEqual({ kind: 'scroll-edge', edge: 'bottom' });
    expect(type(['9', 'q']).commands).toEqual([{ kind: 'close' }]);

    const focus = type(['9', 'F']);
    expect(focus.commands).toEqual([{ kind: 'toggle-review-focus' }]);
    expect(focus.pending).toEqual(REVIEW_PENDING_NONE);
  });

  it('drops the count when a multi-key prefix starts, rather than composing', () => {
    expect(resolveReviewKey(count(3), key(']'))).toEqual({ kind: 'pending', pending: prefix(']') });
    expect(type(['3', ']', 'f']).commands).toEqual([{ kind: 'next-file' }]);
  });

  it('drops the count on an unrecognised key', () => {
    const { commands, pending } = type(['4', '2', 'z', 'c']);
    expect(pending).toEqual(REVIEW_PENDING_NONE);
    expect(commands).toEqual([{ kind: 'annotate-file' }]);
  });

  it('does not treat a digit as a count while a prefix is held', () => {
    expect(resolveReviewKey(prefix('g'), key('4'))).toEqual({ kind: 'none' });
  });
});

describe('isReviewKeyCandidate', () => {
  it('accepts keys the surface owns under some pending state', () => {
    for (const owned of ['j', 'k', 'm', 'q', 'g', ']', '[', 'f', 'u', 'F', '?', '1', '9']) {
      expect(isReviewKeyCandidate(key(owned))).toBe(true);
    }
    // `0` is only meaningful once a count is accumulating — but the router has
    // to hand it over for that case to be reachable at all.
    expect(isReviewKeyCandidate(key('0'))).toBe(true);
    expect(isReviewKeyCandidate(key('d', { ctrlKey: true }))).toBe(true);
  });

  it('rejects keys no pending state can claim', () => {
    for (const foreign of ['a', 'Escape', 'Enter', 'ArrowUp']) {
      expect(isReviewKeyCandidate(key(foreign))).toBe(false);
    }
  });
});

describe('REVIEW_BINDINGS', () => {
  it('documents every binding exactly once', () => {
    const keys = REVIEW_BINDINGS.map((binding) => binding.keys);
    expect(new Set(keys).size).toBe(keys.length);
    expect(REVIEW_BINDINGS.every((binding) => binding.description.length > 0)).toBe(true);
  });

  it('documents the counted line comment', () => {
    expect(REVIEW_BINDINGS.map((binding) => binding.keys)).toContain('{n}c');
  });
});
