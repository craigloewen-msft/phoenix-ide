import { describe, expect, it } from 'vitest';
import {
  REVIEW_BINDINGS,
  isReviewKeyCandidate,
  resolveReviewKey,
  type ReviewCommand,
  type ReviewKeyEvent,
  type ReviewKeyPrefix,
} from './reviewKeymap';

function key(k: string, modifiers: Partial<ReviewKeyEvent> = {}): ReviewKeyEvent {
  return { key: k, ctrlKey: false, metaKey: false, altKey: false, ...modifiers };
}

function commandFor(k: string, prefix: ReviewKeyPrefix | null = null, modifiers: Partial<ReviewKeyEvent> = {}): ReviewCommand | null {
  const resolution = resolveReviewKey(prefix, key(k, modifiers));
  return resolution.kind === 'command' ? resolution.command : null;
}

describe('resolveReviewKey', () => {
  it('maps the viewport motions', () => {
    expect(commandFor('j')).toEqual({ kind: 'scroll-lines', lines: 1 });
    expect(commandFor('k')).toEqual({ kind: 'scroll-lines', lines: -1 });
    expect(commandFor('d', null, { ctrlKey: true })).toEqual({ kind: 'scroll-page', direction: 'down' });
    expect(commandFor('u', null, { ctrlKey: true })).toEqual({ kind: 'scroll-page', direction: 'up' });
    expect(commandFor('G')).toEqual({ kind: 'scroll-edge', edge: 'bottom' });
  });

  it('maps the review actions', () => {
    expect(commandFor('m')).toEqual({ kind: 'toggle-reviewed' });
    expect(commandFor('c')).toEqual({ kind: 'annotate-file' });
    expect(commandFor('R')).toEqual({ kind: 'refresh' });
    expect(commandFor('q')).toEqual({ kind: 'close' });
    expect(commandFor('?')).toEqual({ kind: 'help' });
  });

  it('treats n / N as aliases for file motion', () => {
    expect(commandFor('n')).toEqual({ kind: 'next-file' });
    expect(commandFor('N')).toEqual({ kind: 'prev-file' });
  });

  it('holds a prefix and resolves the sequence on the second key', () => {
    expect(resolveReviewKey(null, key('g'))).toEqual({ kind: 'pending', prefix: 'g' });
    expect(commandFor('g', 'g')).toEqual({ kind: 'scroll-edge', edge: 'top' });

    expect(resolveReviewKey(null, key(']'))).toEqual({ kind: 'pending', prefix: ']' });
    expect(commandFor('f', ']')).toEqual({ kind: 'next-file' });
    expect(commandFor('u', ']')).toEqual({ kind: 'next-unreviewed' });
    expect(commandFor('f', '[')).toEqual({ kind: 'prev-file' });
  });

  it('abandons a sequence rather than falling back to the unprefixed meaning', () => {
    // `g` then `j` must not scroll: the user was mid-sequence.
    expect(resolveReviewKey('g', key('j'))).toEqual({ kind: 'none' });
    expect(resolveReviewKey(']', key('m'))).toEqual({ kind: 'none' });
  });

  it('ignores keys carrying Meta or Alt, and unclaimed Ctrl combos', () => {
    expect(resolveReviewKey(null, key('j', { metaKey: true }))).toEqual({ kind: 'none' });
    expect(resolveReviewKey(null, key('j', { altKey: true }))).toEqual({ kind: 'none' });
    expect(resolveReviewKey(null, key('m', { ctrlKey: true }))).toEqual({ kind: 'none' });
    // Ctrl+F belongs to viewer find, not to the review keymap.
    expect(resolveReviewKey(null, key('f', { ctrlKey: true }))).toEqual({ kind: 'none' });
  });

  it('leaves unknown keys alone', () => {
    for (const unknown of ['a', 'z', 'Enter', 'Escape', 'ArrowDown', '1']) {
      expect(resolveReviewKey(null, key(unknown))).toEqual({ kind: 'none' });
    }
  });
});

describe('isReviewKeyCandidate', () => {
  it('accepts keys the surface owns under some prefix state', () => {
    for (const owned of ['j', 'k', 'm', 'q', 'g', ']', '[', 'f', 'u', '?']) {
      expect(isReviewKeyCandidate(key(owned))).toBe(true);
    }
    expect(isReviewKeyCandidate(key('d', { ctrlKey: true }))).toBe(true);
  });

  it('rejects keys no prefix state can claim', () => {
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
});
