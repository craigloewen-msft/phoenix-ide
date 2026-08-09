import { describe, it, expect } from 'vitest';
import {
  annotationsForFile,
  buildSectionItems,
  hydrateItem,
  fileNotesFor,
  itemId,
  itemRenderSignature,
  lineTextAt,
  noteToAnnotation,
  resolveDiffAnchorLine,
  resolveTouchedLine,
  scrollTargetForNote,
  sectionFromItemId,
} from './pierreDiffMapping';
import type { ReviewNote } from '../../contexts/ReviewNotesContext';

const ADD_FILE = [
  'diff --git a/src/foo.ts b/src/foo.ts',
  'index 0000000..1111111 100644',
  '--- a/src/foo.ts',
  '+++ b/src/foo.ts',
  '@@ -1,3 +1,4 @@',
  ' const a = 1;',
  '-const b = 2;',
  '+const b = 3;',
  '+const c = 4;',
  ' const d = 5;',
].join('\n');

const SECOND_FILE = [
  'diff --git a/src/bar.ts b/src/bar.ts',
  '--- a/src/bar.ts',
  '+++ b/src/bar.ts',
  '@@ -1,1 +1,1 @@',
  '-old line',
  '+new line',
].join('\n');

function note(anchor: ReviewNote['anchor'], extra?: Partial<ReviewNote>): ReviewNote {
  return { id: 'n1', anchor, lineContent: '', body: 'b', createdAt: 0, ...extra };
}

describe('itemId / sectionFromItemId', () => {
  it('round-trips section as a fixed prefix', () => {
    expect(itemId('committed', 'src/foo.ts')).toBe('committed:src/foo.ts');
    expect(itemId('uncommitted', 'src/foo.ts')).toBe('uncommitted:src/foo.ts');
    expect(sectionFromItemId('committed:src/foo.ts')).toBe('committed');
    expect(sectionFromItemId('uncommitted:a/b:c.ts')).toBe('uncommitted');
  });

  it('returns null for foreign ids', () => {
    expect(sectionFromItemId('weird:thing')).toBeNull();
    expect(sectionFromItemId('nocolon')).toBeNull();
  });
});

describe('buildSectionItems', () => {
  it('returns empty (no error) for blank or missing diff', () => {
    expect(buildSectionItems('committed', '')).toEqual({ items: [], sources: [], error: null });
    expect(buildSectionItems('committed', '   \n')).toEqual({ items: [], sources: [], error: null });
    expect(buildSectionItems('committed', undefined)).toEqual({ items: [], sources: [], error: null });
  });

  it('parses multiple files into section-prefixed diff items', () => {
    const { items, error } = buildSectionItems('committed', `${ADD_FILE}\n${SECOND_FILE}`);
    expect(error).toBeNull();
    expect(items.map((i) => i.id)).toEqual(['committed:src/foo.ts', 'committed:src/bar.ts']);
    expect(items.every((i) => i.type === 'diff')).toBe(true);
    expect(items[0]!.fileDiff.name).toBe('src/foo.ts');
    expect(items[0]!.fileDiff.prevName).toBe('');
  });

  it('namespaces the same path across sections so they never collide', () => {
    const c = buildSectionItems('committed', ADD_FILE);
    const u = buildSectionItems('uncommitted', ADD_FILE);
    expect(c.items[0]!.id).toBe('committed:src/foo.ts');
    expect(u.items[0]!.id).toBe('uncommitted:src/foo.ts');
    expect(c.items[0]!.id).not.toBe(u.items[0]!.id);
  });

  it('de-duplicates a repeated path within one section with a #n suffix', () => {
    const { items } = buildSectionItems('committed', `${ADD_FILE}\n${ADD_FILE}`);
    expect(items.map((i) => i.id)).toEqual(['committed:src/foo.ts', 'committed:src/foo.ts#1']);
    // File path identity is preserved on both (read from fileDiff.name, not id).
    expect(items[1]!.fileDiff.name).toBe('src/foo.ts');
  });

  it('reports an error for non-empty unparseable input rather than throwing', () => {
    const { items, error } = buildSectionItems('committed', 'this is not a diff at all');
    expect(items).toEqual([]);
    expect(error).toBeTruthy();
  });
});

describe('noteToAnnotation', () => {
  it('maps newLine to the additions side', () => {
    const ann = noteToAnnotation(
      note({ kind: 'diff', section: 'committed', filePath: 'src/foo.ts', newLine: 3 }),
    );
    expect(ann).toMatchObject({ side: 'additions', lineNumber: 3 });
    expect(ann!.metadata!.noteId).toBe('n1');
  });

  it('maps oldLine to the deletions side', () => {
    const ann = noteToAnnotation(
      note({ kind: 'diff', section: 'committed', filePath: 'src/foo.ts', oldLine: 2 }),
    );
    expect(ann).toMatchObject({ side: 'deletions', lineNumber: 2 });
  });

  it('returns null for non-line notes (file-level, file-viewer)', () => {
    expect(noteToAnnotation(note({ kind: 'diff-file', section: 'committed', filePath: 'x' }))).toBeNull();
    expect(noteToAnnotation(note({ kind: 'file', filePath: '/x', lineNumber: 1 }))).toBeNull();
  });
});

describe('annotationsForFile / fileNotesFor', () => {
  const notes: ReviewNote[] = [
    note({ kind: 'diff', section: 'committed', filePath: 'src/foo.ts', newLine: 3 }, { id: 'c1' }),
    note({ kind: 'diff', section: 'uncommitted', filePath: 'src/foo.ts', newLine: 3 }, { id: 'u1' }),
    note({ kind: 'diff-file', section: 'committed', filePath: 'src/foo.ts' }, { id: 'f1' }),
  ];

  it('scopes line annotations by section + file', () => {
    const c = annotationsForFile(notes, 'committed', 'src/foo.ts');
    expect(c.map((a) => a.metadata!.noteId)).toEqual(['c1']);
    const u = annotationsForFile(notes, 'uncommitted', 'src/foo.ts');
    expect(u.map((a) => a.metadata!.noteId)).toEqual(['u1']);
  });

  it('scopes file-level notes by section + file', () => {
    expect(fileNotesFor(notes, 'committed', 'src/foo.ts').map((n) => n.id)).toEqual(['f1']);
    expect(fileNotesFor(notes, 'uncommitted', 'src/foo.ts')).toEqual([]);
  });
});

describe('lineTextAt', () => {
  const fileDiff = buildSectionItems('committed', ADD_FILE).items[0]!.fileDiff;

  it('recovers addition-side line text from typed hunk data (no DOM)', () => {
    // New file: 1 const a, 2 const b = 3, 3 const c, 4 const d
    expect(lineTextAt(fileDiff, 'additions', 2)).toBe('const b = 3;');
    expect(lineTextAt(fileDiff, 'additions', 3)).toBe('const c = 4;');
  });

  it('recovers deletion-side line text', () => {
    // Old file: 1 const a, 2 const b = 2, 3 const d
    expect(lineTextAt(fileDiff, 'deletions', 2)).toBe('const b = 2;');
  });

  it('returns undefined for an out-of-range line', () => {
    expect(lineTextAt(fileDiff, 'additions', 999)).toBeUndefined();
  });
});

describe('edge-case diffs', () => {
  const BINARY = [
    'diff --git a/img.png b/img.png',
    'new file mode 100644',
    'index 0000000..1111111',
    'Binary files /dev/null and b/img.png differ',
  ].join('\n');

  const RENAME = [
    'diff --git a/old.ts b/new.ts',
    'similarity index 80%',
    'rename from old.ts',
    'rename to new.ts',
    'index aaa..bbb 100644',
    '--- a/old.ts',
    '+++ b/new.ts',
    '@@ -1,2 +1,2 @@',
    ' keep',
    '-was',
    '+now',
  ].join('\n');

  it('produces a header-only item for a binary/added file (no hunks)', () => {
    const { items, error } = buildSectionItems('committed', BINARY);
    expect(error).toBeNull();
    expect(items).toHaveLength(1);
    expect(items[0]!.id).toBe('committed:img.png');
    expect(items[0]!.fileDiff.hunks).toHaveLength(0);
  });

  it('gives a renamed file a stable identity via name + prevName', () => {
    const { items } = buildSectionItems('uncommitted', RENAME);
    expect(items[0]!.id).toBe('uncommitted:new.ts');
    expect(items[0]!.fileDiff.name).toBe('new.ts');
    expect(items[0]!.fileDiff.prevName).toBe('old.ts');
  });

  it('recovers context-line text on either side', () => {
    const fileDiff = buildSectionItems('committed', ADD_FILE).items[0]!.fileDiff;
    // Line 1 is the context line ` const a = 1;` — present on both sides.
    expect(lineTextAt(fileDiff, 'additions', 1)).toBe('const a = 1;');
    expect(lineTextAt(fileDiff, 'deletions', 1)).toBe('const a = 1;');
  });
});

describe('legacy diffPos compatibility', () => {
  // A note created by the previous viewer may still carry diffPos. The new
  // renderer must ignore it: identity is side + line number.
  const legacy = note({
    kind: 'diff',
    section: 'committed',
    filePath: 'src/foo.ts',
    newLine: 3,
    diffPos: 7,
  });

  it('maps to an annotation by side+line, not diffPos', () => {
    expect(noteToAnnotation(legacy)).toMatchObject({ side: 'additions', lineNumber: 3 });
  });

  it('scrolls by line, not diffPos', () => {
    expect(scrollTargetForNote(legacy)).toEqual({
      id: 'committed:src/foo.ts',
      line: { lineNumber: 3, side: 'additions' },
    });
  });
});

describe('itemRenderSignature (drives CodeView item version bumps)', () => {
  const fileDiff = buildSectionItems('committed', ADD_FILE).items[0]!.fileDiff;
  const base = () => itemRenderSignature(fileDiff, [], 'committed', null);

  it('is stable for identical inputs', () => {
    expect(base()).toBe(base());
  });

  it('changes when a line note is added', () => {
    const withNote = itemRenderSignature(
      fileDiff,
      [note({ kind: 'diff', section: 'committed', filePath: 'src/foo.ts', newLine: 2 })],
      'committed',
      null,
    );
    expect(withNote).not.toBe(base());
  });

  it('changes when a note body is edited', () => {
    const a = itemRenderSignature(fileDiff, [note({ kind: 'diff', section: 'committed', filePath: 'src/foo.ts', newLine: 2 }, { body: 'one' })], 'committed', null);
    const b = itemRenderSignature(fileDiff, [note({ kind: 'diff', section: 'committed', filePath: 'src/foo.ts', newLine: 2 }, { body: 'two' })], 'committed', null);
    expect(a).not.toBe(b);
  });

  it('changes when the flashed note changes', () => {
    const n = note({ kind: 'diff', section: 'committed', filePath: 'src/foo.ts', newLine: 2 }, { id: 'x1' });
    const noFlash = itemRenderSignature(fileDiff, [n], 'committed', null);
    const flash = itemRenderSignature(fileDiff, [n], 'committed', 'x1');
    expect(noFlash).not.toBe(flash);
  });

  it('changes when a file-level note is added (header count)', () => {
    const withFile = itemRenderSignature(
      fileDiff,
      [note({ kind: 'diff-file', section: 'committed', filePath: 'src/foo.ts' })],
      'committed',
      null,
    );
    expect(withFile).not.toBe(base());
  });

  it('ignores notes from the other section / other files', () => {
    const other = itemRenderSignature(
      fileDiff,
      [
        note({ kind: 'diff', section: 'uncommitted', filePath: 'src/foo.ts', newLine: 2 }),
        note({ kind: 'diff', section: 'committed', filePath: 'src/bar.ts', newLine: 2 }),
      ],
      'committed',
      null,
    );
    expect(other).toBe(base());
  });
});

describe('itemRenderSignature content fingerprint', () => {
  // Two diffs of the same shape (one context, one deletion, two additions, one
  // context) but different added text. Line counts/hunk shape are identical, so
  // only a content hash distinguishes them.
  const shaped = (added: string) =>
    [
      'diff --git a/src/foo.ts b/src/foo.ts',
      '--- a/src/foo.ts',
      '+++ b/src/foo.ts',
      '@@ -1,3 +1,4 @@',
      ' const a = 1;',
      '-const b = 2;',
      `+const b = ${added};`,
      '+const c = 4;',
      ' const d = 5;',
    ].join('\n');

  it('bumps when line text changes without changing the diff shape', () => {
    const a = buildSectionItems('committed', shaped('3')).items[0]!.fileDiff;
    const b = buildSectionItems('committed', shaped('9')).items[0]!.fileDiff;
    expect(a.additionLines.length).toBe(b.additionLines.length);
    expect(a.hunks.length).toBe(b.hunks.length);
    expect(itemRenderSignature(a, [], 'committed', null)).not.toBe(
      itemRenderSignature(b, [], 'committed', null),
    );
  });
});

describe('resolveDiffAnchorLine', () => {
  // @@ -1,3 +1,4 @@   1:context  2:-del  ->2,3:+add   3:context(->4)
  const fileDiff = buildSectionItems('committed', ADD_FILE).items[0]!.fileDiff;

  it('keeps an addition-side line on the new-file number', () => {
    expect(resolveDiffAnchorLine(fileDiff, 'additions', 2)).toEqual({ newLine: 2 });
  });

  it('keeps a genuinely removed line on the old-file number', () => {
    expect(resolveDiffAnchorLine(fileDiff, 'deletions', 2)).toEqual({ oldLine: 2 });
  });

  it('normalises a context line touched on the deletions pane to its new-file number', () => {
    // Old line 1 (` const a = 1;`) is context → new line 1, not "Removed line 1".
    expect(resolveDiffAnchorLine(fileDiff, 'deletions', 1)).toEqual({ newLine: 1 });
    // Old line 3 (` const d = 5;`) is context after a +1 net change → new line 4.
    expect(resolveDiffAnchorLine(fileDiff, 'deletions', 3)).toEqual({ newLine: 4 });
  });
});

describe('resolveTouchedLine', () => {
  const item = buildSectionItems('committed', ADD_FILE).items[0]!;

  /** Build a Pierre-like line subtree and return its composed-path order. */
  function buildPath(opts: {
    line: number;
    lineType: string;
    sideAttr: 'data-additions' | 'data-deletions';
    attr?: 'data-line' | 'data-column-number';
  }): { path: HTMLElement[]; container: HTMLElement } {
    const container = document.createElement('div');
    const code = document.createElement('div');
    code.setAttribute('data-code', '');
    code.setAttribute(opts.sideAttr, '');
    const lineEl = document.createElement('span');
    lineEl.setAttribute(opts.attr ?? 'data-line', String(opts.line));
    lineEl.setAttribute('data-line-type', opts.lineType);
    code.appendChild(lineEl);
    container.appendChild(code);
    // composed path is innermost-first, up through the item container.
    return { path: [lineEl, code, container], container };
  }

  it('resolves an addition line to its item, side, and number', () => {
    const { path, container } = buildPath({ line: 2, lineType: 'change-addition', sideAttr: 'data-additions' });
    expect(resolveTouchedLine(path, [{ element: container, item }])).toEqual({
      item,
      side: 'additions',
      lineNumber: 2,
    });
  });

  it('resolves a deletion line to the deletions side', () => {
    const { path, container } = buildPath({ line: 2, lineType: 'change-deletion', sideAttr: 'data-deletions' });
    expect(resolveTouchedLine(path, [{ element: container, item }])).toMatchObject({
      side: 'deletions',
      lineNumber: 2,
    });
  });

  it('takes a context line side from the touched code column', () => {
    const left = buildPath({ line: 3, lineType: 'context', sideAttr: 'data-deletions' });
    expect(resolveTouchedLine(left.path, [{ element: left.container, item }])).toMatchObject({
      side: 'deletions',
      lineNumber: 3,
    });
    const right = buildPath({ line: 4, lineType: 'context', sideAttr: 'data-additions', attr: 'data-column-number' });
    expect(resolveTouchedLine(right.path, [{ element: right.container, item }])).toMatchObject({
      side: 'additions',
      lineNumber: 4,
    });
  });

  it('returns null when the path is not within a known item', () => {
    const { path } = buildPath({ line: 2, lineType: 'change-addition', sideAttr: 'data-additions' });
    expect(resolveTouchedLine(path, [])).toBeNull();
  });

  it('returns null when no resolvable line is in the path', () => {
    const container = document.createElement('div');
    expect(resolveTouchedLine([container], [{ element: container, item }])).toBeNull();
  });
});

describe('scrollTargetForNote', () => {
  it('targets a line for a diff note', () => {
    expect(
      scrollTargetForNote(note({ kind: 'diff', section: 'committed', filePath: 'src/foo.ts', newLine: 3 })),
    ).toEqual({ id: 'committed:src/foo.ts', line: { lineNumber: 3, side: 'additions' } });
  });

  it('targets the item for a file-level note', () => {
    expect(
      scrollTargetForNote(note({ kind: 'diff-file', section: 'uncommitted', filePath: 'src/foo.ts' })),
    ).toEqual({ id: 'uncommitted:src/foo.ts' });
  });

  it('returns null for a file-viewer note', () => {
    expect(scrollTargetForNote(note({ kind: 'file', filePath: '/x', lineNumber: 1 }))).toBeNull();
  });
});

// A file whose diff carries only 3 lines of context, plus the real content of
// both sides. Hydration should turn this into a whole-file item that Pierre can
// expand, while leaving the hunk's own line numbers untouched.
const CONTEXT_OLD = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`).join('\n') + '\n';
const CONTEXT_NEW = CONTEXT_OLD.replace('line 20\n', 'line 20 CHANGED\n');
const CONTEXT_PATCH = [
  'diff --git a/src/ctx.ts b/src/ctx.ts',
  'index aaaaaaa..bbbbbbb 100644',
  '--- a/src/ctx.ts',
  '+++ b/src/ctx.ts',
  '@@ -17,7 +17,7 @@',
  ' line 17',
  ' line 18',
  ' line 19',
  '-line 20',
  '+line 20 CHANGED',
  ' line 21',
  ' line 22',
  ' line 23',
  '',
].join('\n');

function contextSource() {
  const built = buildSectionItems('committed', CONTEXT_PATCH);
  const source = built.sources[0];
  if (!source) throw new Error('expected a hydratable source');
  return source;
}

describe('buildSectionItems — expansion sources', () => {
  it('retains each file\u2019s patch text and blob ids for later hydration', () => {
    const built = buildSectionItems('committed', CONTEXT_PATCH);
    expect(built.sources).toHaveLength(1);
    expect(built.sources[0]).toMatchObject({
      itemId: itemId('committed', 'src/ctx.ts'),
      section: 'committed',
      filePath: 'src/ctx.ts',
      prevObjectId: 'aaaaaaa',
      newObjectId: 'bbbbbbb',
    });
    expect(built.sources[0]!.patchText).toContain('@@ -17,7 +17,7 @@');
  });

  it('pairs each file with its own patch slice in a multi-file diff', () => {
    const built = buildSectionItems('committed', `${ADD_FILE}\n${CONTEXT_PATCH}`);
    const ctx = built.sources.find((s) => s.filePath === 'src/ctx.ts');
    expect(ctx?.patchText).toContain('src/ctx.ts');
    expect(ctx?.patchText).not.toContain('src/foo.ts');
  });

  // Without an index line there is no object id, so there is no way to fetch
  // content that is provably the right version — the file must not be offered
  // for expansion at all.
  it('omits files whose patch carries no blob ids', () => {
    const built = buildSectionItems('committed', SECOND_FILE);
    expect(built.items).toHaveLength(1);
    expect(built.sources).toHaveLength(0);
  });
});

describe('hydrateItem', () => {
  it('produces a non-partial item carrying the whole file', () => {
    const hydrated = hydrateItem(contextSource(), CONTEXT_OLD, CONTEXT_NEW);
    expect(hydrated).not.toBeNull();
    expect(hydrated!.fileDiff.isPartial).toBe(false);
    // The partial parse only ever held the 7 patched lines.
    expect(hydrated!.fileDiff.additionLines).toHaveLength(40);
    expect(hydrated!.fileDiff.deletionLines).toHaveLength(40);
  });

  it('keeps the item id and line numbering the notes are anchored to', () => {
    const source = contextSource();
    const partial = buildSectionItems('committed', CONTEXT_PATCH).items[0]!;
    const hydrated = hydrateItem(source, CONTEXT_OLD, CONTEXT_NEW)!;

    expect(hydrated.id).toBe(partial.id);
    // Anchoring is what must not move: the same line number resolves to the
    // same text before and after hydration.
    expect(lineTextAt(hydrated.fileDiff, 'additions', 20)).toBe('line 20 CHANGED');
    expect(lineTextAt(partial.fileDiff, 'additions', 20)).toBe('line 20 CHANGED');
    // And a line only reachable once expanded now resolves correctly.
    expect(lineTextAt(hydrated.fileDiff, 'additions', 3)).toBe('line 3');
  });

  // The failure this guards against: Pierre accepts mismatched contents without
  // complaint and renders context lines that silently disagree with the diff.
  it('refuses contents that do not match the patch', () => {
    const shifted = `x\nx\nx\nx\nx\n${CONTEXT_OLD}`;
    expect(hydrateItem(contextSource(), shifted, shifted)).toBeNull();
  });

  it('refuses contents from an unrelated file', () => {
    const unrelated = 'totally\ndifferent\nfile\n';
    expect(hydrateItem(contextSource(), unrelated, unrelated)).toBeNull();
  });
});

describe('lineTextAt — expanded context lines', () => {
  it('resolves a line outside every hunk once the file is hydrated', () => {
    const hydrated = hydrateItem(contextSource(), CONTEXT_OLD, CONTEXT_NEW)!;
    // Line 3 is nowhere near the single hunk (which starts at 17), so it is
    // only reachable after the reviewer expands context. Annotating it must
    // still quote the right source text.
    expect(lineTextAt(hydrated.fileDiff, 'additions', 3)).toBe('line 3');
    expect(lineTextAt(hydrated.fileDiff, 'deletions', 3)).toBe('line 3');
    expect(lineTextAt(hydrated.fileDiff, 'additions', 40)).toBe('line 40');
  });

  it('still reports nothing for an out-of-range line in a hydrated file', () => {
    const hydrated = hydrateItem(contextSource(), CONTEXT_OLD, CONTEXT_NEW)!;
    expect(lineTextAt(hydrated.fileDiff, 'additions', 999)).toBeUndefined();
  });

  // A partial file's line arrays hold only the patched lines, so indexing them
  // by file line number would return an unrelated line. Absence is correct.
  it('reports nothing for a non-hunk line while the file is still partial', () => {
    const partial = buildSectionItems('committed', CONTEXT_PATCH).items[0]!;
    expect(lineTextAt(partial.fileDiff, 'additions', 3)).toBeUndefined();
  });
});
