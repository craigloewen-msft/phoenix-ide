import { describe, expect, it } from 'vitest';
import { computePlanDiff } from './planDiff';

describe('computePlanDiff', () => {
  it('reports no changes when the plan is identical', () => {
    const plan = '# Title\n\nFirst paragraph.\n\nSecond paragraph.\n';
    const diff = computePlanDiff(plan, plan);

    expect(diff.changeCount).toBe(0);
    expect(diff.removals).toEqual([]);
    expect(diff.blocks.every((b) => b.status === 'unchanged')).toBe(true);
  });

  it('marks a wholly new block as added', () => {
    const previous = '# Title\n\nKept paragraph.\n';
    const current = '# Title\n\nKept paragraph.\n\nBrand new paragraph.\n';
    const diff = computePlanDiff(previous, current);

    const added = diff.blocks.filter((b) => b.status === 'added');
    expect(added).toHaveLength(1);
    expect(diff.changeCount).toBe(1);
    // The whole block is the insertion, so it renders fully marked.
    expect(added[0]!.insertions).toEqual([{ start: 0, end: 'Brand new paragraph.'.length }]);
  });

  it('reports a deleted block as a removal anchored before its successor', () => {
    const previous = '# Title\n\nDoomed paragraph.\n\nSurviving paragraph.\n';
    const current = '# Title\n\nSurviving paragraph.\n';
    const diff = computePlanDiff(previous, current);

    expect(diff.removals).toHaveLength(1);
    expect(diff.removals[0]!.text).toBe('Doomed paragraph.');
    const survivor = diff.blocks.find((b) => b.blockId === diff.removals[0]!.beforeBlockId);
    expect(survivor).toBeDefined();
    expect(diff.changeCount).toBe(1);
  });

  it('computes word-level insertions and deletions inside an edited paragraph', () => {
    const previous = 'We will use SQLite for storage.\n';
    const current = 'We will use Postgres for storage.\n';
    const diff = computePlanDiff(previous, current);

    const changed = diff.blocks.find((b) => b.status === 'changed');
    expect(changed).toBeDefined();
    expect(changed!.deletions).toEqual(['SQLite']);
    const insertedText = changed!.insertions.map(
      (r) => 'We will use Postgres for storage.'.slice(r.start, r.end),
    );
    expect(insertedText).toEqual(['Postgres']);
  });

  it('treats a moved-but-identical block as unchanged', () => {
    const previous = 'Alpha block.\n\nBeta block.\n\nGamma block.\n';
    const current = 'Alpha block.\n\nGamma block.\n\nBeta block.\n';
    const diff = computePlanDiff(previous, current);

    // Reordering cannot leave every block unchanged (something must account for
    // the move), but the identical text must not be reported as a word rewrite.
    expect(diff.blocks.every((b) => b.deletions.length === 0)).toBe(true);
  });

  it('treats a code fence as one opaque block', () => {
    const previous = 'Intro.\n\n```ts\nconst a = 1;\n```\n';
    const current = 'Intro.\n\n```ts\nconst a = 2;\n```\n';
    const diff = computePlanDiff(previous, current);

    const changed = diff.blocks.filter((b) => b.status === 'changed');
    expect(changed).toHaveLength(1);
    expect(changed[0]!.deletions).toEqual(['1;']);
  });

  it('marks a prior note as touched when its block was edited', () => {
    const previous = '# Plan\n\nUse SQLite for storage.\n';
    const current = '# Plan\n\nUse Postgres for storage.\n';
    const diff = computePlanDiff(previous, current, [
      { lineNumber: 3, lineContent: 'Use SQLite for storage.', note: 'why sqlite?' },
    ]);

    expect(diff.notes).toHaveLength(1);
    expect(diff.notes[0]!.status).toBe('touched');
    expect(diff.notes[0]!.blockId).not.toBeNull();
  });

  it('marks a prior note as untouched when its block survived verbatim', () => {
    const previous = '# Plan\n\nUse SQLite for storage.\n\nShip it.\n';
    const current = '# Plan\n\nUse SQLite for storage.\n\nShip it eventually.\n';
    const diff = computePlanDiff(previous, current, [
      { lineNumber: 3, lineContent: 'Use SQLite for storage.', note: 'why sqlite?' },
    ]);

    expect(diff.notes[0]!.status).toBe('untouched');
  });

  it('marks a prior note as touched when the annotated text was deleted', () => {
    const previous = '# Plan\n\nA doomed idea nobody liked.\n\nShip it.\n';
    const current = '# Plan\n\nShip it.\n';
    const diff = computePlanDiff(previous, current, [
      { lineNumber: 3, lineContent: 'A doomed idea nobody liked.', note: 'drop this' },
    ]);

    expect(diff.notes[0]!.status).toBe('touched');
    expect(diff.notes[0]!.blockId).toBeNull();
  });

  it('handles an empty baseline without throwing', () => {
    const diff = computePlanDiff('', '# New plan\n\nContent.\n');
    expect(diff.blocks.every((b) => b.status === 'added')).toBe(true);
    expect(diff.changeCount).toBe(diff.blocks.length);
  });
});
