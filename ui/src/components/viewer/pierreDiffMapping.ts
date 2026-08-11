/**
 * Pure mapping layer between Phoenix review-note anchors and Pierre's
 * `@pierre/diffs` model. This is the typed boundary: nothing here touches the
 * DOM, React, or Pierre's rendered output — it only converts raw diff text and
 * Phoenix anchors into Pierre `CodeViewDiffItem`s / `DiffLineAnnotation`s and
 * back. Unit-tested in `pierreDiffMapping.test.ts`.
 *
 * Identity is structural: an item id is `${section}:${filePath}`, so the same
 * file appearing in both the committed and uncommitted sections occupies two
 * distinct items that can never collide. A line note's identity is
 * (section, filePath, side, lineNumber); the full Phoenix anchor is carried in
 * the annotation metadata so the renderer never has to reconstruct it.
 */

import { parsePatchFiles, processFile } from '@pierre/diffs';
import type {
  AnnotationSide,
  CodeViewDiffItem,
  DiffLineAnnotation,
  FileDiffMetadata,
  LineTypes,
} from '@pierre/diffs';
import type { DiffSection, NoteAnchor, ReviewNote } from '../../contexts/ReviewNotesContext';

/**
 * Metadata stored on every Pierre annotation. The full Phoenix anchor is kept
 * verbatim so jump/indicator logic reads typed data rather than re-deriving the
 * anchor from line numbers (which would collide across sections).
 */
export interface PhoenixDiffAnnotationMeta {
  noteId: string;
  anchor: NoteAnchor;
}

export type PhoenixDiffItem = CodeViewDiffItem<PhoenixDiffAnnotationMeta>;
export type PhoenixDiffAnnotation = DiffLineAnnotation<PhoenixDiffAnnotationMeta>;

/** Stable item id. `filePath` may legally contain `:`; recovery never splits on
 *  it (see {@link sectionFromItemId} — section is a fixed prefix, file path is
 *  read from `fileDiff.name`). */
export function itemId(section: DiffSection, filePath: string): string {
  return `${section}:${filePath}`;
}

/** Recover the section from an item id by its fixed prefix. Returns null for an
 *  id that isn't one of ours. The file path is intentionally NOT parsed out of
 *  the id — callers read it from `item.fileDiff.name`, which survives the
 *  collision-suffix scheme in {@link buildSectionItems}. */
export function sectionFromItemId(id: string): DiffSection | null {
  if (id.startsWith('committed:')) return 'committed';
  if (id.startsWith('uncommitted:')) return 'uncommitted';
  return null;
}

export interface BuiltSection {
  /** Parsed file items for this section, with collision-free ids. */
  items: PhoenixDiffItem[];
  /** Per-item source patch text and blob ids, retained so a file can later be
   *  re-parsed with full contents to enable context expansion. Keyed by item id
   *  and ordered alongside `items`. */
  sources: SectionFileSource[];
  /** Non-null when the raw diff was non-empty but could not be parsed; the
   *  viewer shows a section-scoped fallback rather than crashing. */
  error: string | null;
}

/**
 * Parse one section's raw unified diff into Pierre diff items. Permissive: a
 * parse failure is captured as `error` (not thrown) so a malformed section
 * degrades to a fallback without taking down the conversation page.
 *
 * A well-formed unified diff lists each path once per section. Should the same
 * path nonetheless appear twice (a malformed/pathological diff), item ids are
 * de-duplicated with a `#n` suffix purely to preserve CodeView's unique-id
 * invariant. Notes remain anchored by `(section, filePath)`, so the rare
 * duplicate occurrences share notes — best-effort isolation is not attempted
 * for an input that should not occur.
 */
export function buildSectionItems(section: DiffSection, rawDiff: string | null | undefined): BuiltSection {
  if (!rawDiff?.trim()) return { items: [], sources: [], error: null };

  let parsed;
  try {
    // cacheKeyPrefix keyed by section so Pierre's parse cache can't alias the
    // same path across committed/uncommitted. throwOnError=false: we surface
    // partial results and report below rather than crash.
    parsed = parsePatchFiles(rawDiff, section, false);
  } catch (err) {
    return { items: [], sources: [], error: err instanceof Error ? err.message : 'Failed to parse diff' };
  }

  // The parser does not hand back the slice of text each file came from, so
  // split the raw diff the same way to pair each item with its own patch text
  // for later hydration.
  const patchTexts = splitPatchByFile(rawDiff);

  const items: PhoenixDiffItem[] = [];
  const sources: SectionFileSource[] = [];
  const seen = new Set<string>();
  let fileIndex = 0;
  for (const patch of parsed) {
    for (const fileDiff of patch.files) {
      const base = itemId(section, fileDiff.name);
      let id = base;
      let n = 1;
      while (seen.has(id)) id = `${base}#${n++}`;
      seen.add(id);
      items.push({
        id,
        type: 'diff',
        fileDiff: { ...fileDiff, prevName: fileDiff.prevName ?? '' },
      });
      const patchText = patchTexts[fileIndex];
      fileIndex += 1;
      // Expansion needs all three: the text to re-parse and the blob ids that
      // let the server prove which version of the file to return. A file
      // missing any of them is simply not hydratable, so it is left out
      // rather than recorded in a half-usable state.
      if (patchText !== undefined && fileDiff.prevObjectId && fileDiff.newObjectId) {
        sources.push({
          itemId: id,
          section,
          filePath: fileDiff.name,
          prevObjectId: fileDiff.prevObjectId,
          newObjectId: fileDiff.newObjectId,
          patchText,
        });
      }
    }
  }

  // Non-empty input that yielded no files is itself a malformed/unsupported
  // diff — report it so the section shows a fallback instead of silent blank.
  if (items.length === 0) return { items, sources, error: 'Could not parse any files from this diff.' };
  return { items, sources, error: null };
}

/** Split a multi-file patch into its per-file slices, in the same order the
 *  parser yields files, so each item can be paired with the text it came from. */
function splitPatchByFile(rawDiff: string): string[] {
  const slices: string[] = [];
  let current: string[] | null = null;
  for (const line of rawDiff.split('\n')) {
    if (line.startsWith('diff --git ')) {
      if (current) slices.push(current.join('\n'));
      current = [line];
      continue;
    }
    if (current) current.push(line);
  }
  if (current) slices.push(current.join('\n'));
  return slices;
}

/**
 * Convert a single Phoenix review note into a Pierre line annotation. Returns
 * null for notes that are not line-anchored diff notes (file-level diff notes
 * are rendered through the header, not as line annotations; file-viewer notes
 * belong to a different surface entirely).
 */
export function noteToAnnotation(note: ReviewNote): PhoenixDiffAnnotation | null {
  const a = note.anchor;
  if (a.kind !== 'diff') return null;
  const metadata: PhoenixDiffAnnotationMeta = { noteId: note.id, anchor: a };
  if (a.newLine !== undefined) return { side: 'additions', lineNumber: a.newLine, metadata };
  if (a.oldLine !== undefined) return { side: 'deletions', lineNumber: a.oldLine, metadata };
  return null;
}

/**
 * Resolve a Pierre (side, lineNumber) pair to a diff note's line fields. The
 * additions side and a changed/added line anchor on the new-file number
 * (`newLine`); a genuinely removed line anchors on the old-file number
 * (`oldLine`).
 *
 * A *context* (unchanged) line is the subtle case: in split view it is
 * clickable from the deletions (left) pane, where Pierre reports it on the
 * `deletions` side with its old-file number — but it was not removed. Treating
 * that as `oldLine` would label the note "Removed line N". Context lines exist
 * on both sides, so this normalises them to their new-file number (the same
 * `newLine` field additions use), walking the hunk's content blocks to map the
 * old-file number across intervening changes. Purely structural — derived from
 * the parsed hunks, no Pierre line-type input required.
 */
export function resolveDiffAnchorLine(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number,
): { newLine?: number; oldLine?: number } {
  if (side === 'additions') return { newLine: lineNumber };
  for (const h of fileDiff.hunks) {
    if (lineNumber < h.deletionStart || lineNumber >= h.deletionStart + h.deletionCount) continue;
    let delLine = h.deletionStart;
    let addLine = h.additionStart;
    for (const seg of h.hunkContent) {
      if (seg.type === 'context') {
        if (lineNumber >= delLine && lineNumber < delLine + seg.lines) {
          return { newLine: addLine + (lineNumber - delLine) };
        }
        delLine += seg.lines;
        addLine += seg.lines;
      } else {
        if (lineNumber >= delLine && lineNumber < delLine + seg.deletions) return { oldLine: lineNumber };
        delLine += seg.deletions;
        addLine += seg.additions;
      }
    }
    break;
  }
  return { oldLine: lineNumber };
}

/** Stable 32-bit FNV-1a hash of a string, base-36 encoded. Used to fold a
 *  file's line *content* into the render signature without carrying the full
 *  text around for equality comparison. */
function hashContent(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}

/**
 * A signature of everything PhoenixDiffCodeView draws for one diff item: the
 * parsed file fingerprint plus the line/file notes (and which one is flashed).
 * The wrapper turns a change in this string into a bumped `CodeViewItem.version`
 * so Pierre's controlled reconciler re-renders the item — without a version
 * bump it keeps the prior record and the inline annotation / flash / file-note
 * count would go stale even though the items array is new.
 */
export function itemRenderSignature(
  fileDiff: FileDiffMetadata,
  notes: readonly ReviewNote[],
  section: DiffSection,
  highlightedNoteId: string | null,
): string {
  const filePath = fileDiff.name;
  // Content fingerprint: line counts alone miss an edit that changes line text
  // without changing the shape (e.g. `foo`→`bar` becoming `foo`→`baz`), so the
  // actual addition/deletion text is hashed in. Otherwise the version wouldn't
  // bump on a refetch and Pierre would keep rendering the stale line content.
  const fp = [
    fileDiff.name,
    fileDiff.prevName ?? '',
    fileDiff.type,
    fileDiff.unifiedLineCount,
    fileDiff.hunks.length,
    fileDiff.additionLines.length,
    fileDiff.deletionLines.length,
    hashContent(`${fileDiff.additionLines.join('\n')} ${fileDiff.deletionLines.join('\n')}`),
  ].join('|');
  const lineNotes: string[] = [];
  const fileNotes: string[] = [];
  for (const n of notes) {
    const a = n.anchor;
    const flash = n.id === highlightedNoteId ? '*' : '';
    if (a.kind === 'diff' && a.section === section && a.filePath === filePath) {
      lineNotes.push(`${n.id}:${a.newLine ?? ''}:${a.oldLine ?? ''}:${n.body}:${flash}`);
    } else if (a.kind === 'diff-file' && a.section === section && a.filePath === filePath) {
      fileNotes.push(`${n.id}:${n.body}:${flash}`);
    }
  }
  return `${fp}#L[${lineNotes.join(',')}]#F[${fileNotes.join(',')}]`;
}

/** All line annotations for a given (section, filePath), in note order. */
export function annotationsForFile(
  notes: readonly ReviewNote[],
  section: DiffSection,
  filePath: string,
): PhoenixDiffAnnotation[] {
  const out: PhoenixDiffAnnotation[] = [];
  for (const note of notes) {
    if (note.anchor.kind !== 'diff') continue;
    if (note.anchor.section !== section || note.anchor.filePath !== filePath) continue;
    const ann = noteToAnnotation(note);
    if (ann) out.push(ann);
  }
  return out;
}

/** File-level (header) diff notes for a given (section, filePath). */
export function fileNotesFor(
  notes: readonly ReviewNote[],
  section: DiffSection,
  filePath: string,
): ReviewNote[] {
  return notes.filter(
    (n) =>
      n.anchor.kind === 'diff-file' &&
      n.anchor.section === section &&
      n.anchor.filePath === filePath,
  );
}

/**
 * Recover the raw text of a diff line from typed Pierre hunk data — no DOM
 * scraping. `additionLines`/`deletionLines` hold the per-side content in source
 * order; each hunk records where its slice starts (`additionLineIndex`) and the
 * file line number of that slice's first row (`additionStart`), so a side+line
 * number maps to an array index by simple offset.
 */
export function lineTextAt(
  fileDiff: FileDiffMetadata,
  side: AnnotationSide,
  lineNumber: number,
): string | undefined {
  for (const h of fileDiff.hunks) {
    if (side === 'additions') {
      if (lineNumber >= h.additionStart && lineNumber < h.additionStart + h.additionCount) {
        return stripEol(fileDiff.additionLines[h.additionLineIndex + (lineNumber - h.additionStart)]);
      }
    } else if (lineNumber >= h.deletionStart && lineNumber < h.deletionStart + h.deletionCount) {
      return stripEol(fileDiff.deletionLines[h.deletionLineIndex + (lineNumber - h.deletionStart)]);
    }
  }
  // A hydrated file holds every line, including the unmodified ones outside any
  // hunk that the reviewer can reveal via context expansion. Those are
  // annotatable, so resolve them from the whole-file arrays, where the 1-based
  // file line number indexes directly. Only safe when the parse is non-partial:
  // a partial file's arrays hold just the patched lines, where the same
  // arithmetic would silently return an unrelated line.
  if (!fileDiff.isPartial) {
    const lines = side === 'additions' ? fileDiff.additionLines : fileDiff.deletionLines;
    return stripEol(lines[lineNumber - 1]);
  }
  return undefined;
}

/** Pierre's per-side line arrays retain the source line ending; strip a single
 *  trailing newline so the quoted note line is the bare source line. */
function stripEol(line: string | undefined): string | undefined {
  return line === undefined ? undefined : line.replace(/\r?\n$/, '');
}

/** The Pierre scroll target for a note's anchor, or null when the note isn't a
 *  diff note. File-level notes target the item; line notes target the line. */
export interface NoteScrollTarget {
  id: string;
  /** Present for line notes; absent for file-level (item-level) targets. */
  line?: { lineNumber: number; side: AnnotationSide };
}

export function scrollTargetForNote(note: ReviewNote): NoteScrollTarget | null {
  const a = note.anchor;
  if (a.kind === 'diff-file') return { id: itemId(a.section, a.filePath) };
  if (a.kind !== 'diff') return null;
  const id = itemId(a.section, a.filePath);
  if (a.newLine !== undefined) return { id, line: { lineNumber: a.newLine, side: 'additions' } };
  if (a.oldLine !== undefined) return { id, line: { lineNumber: a.oldLine, side: 'deletions' } };
  return { id };
}

/** A diff line resolved from a touch point: which item it belongs to plus the
 *  Pierre annotation side and line number, ready to feed annotation logic. */
export interface TouchedLine {
  item: PhoenixDiffItem;
  side: AnnotationSide;
  lineNumber: number;
}

function lineTypeFromElement(el: HTMLElement): LineTypes | undefined {
  const t = el.getAttribute('data-line-type');
  if (t === 'change-deletion' || t === 'change-addition' || t === 'context' || t === 'context-expanded') {
    return t;
  }
  return undefined;
}

/** Mirror of Pierre's `getAnnotationSide`: a changed line's side is fixed by its
 *  type; a context line takes the side of the code column it was touched in. */
function annotationSideFor(lineType: LineTypes, codeElement: HTMLElement): AnnotationSide {
  if (lineType === 'change-deletion') return 'deletions';
  if (lineType === 'change-addition') return 'additions';
  return codeElement.hasAttribute('data-deletions') ? 'deletions' : 'additions';
}

/**
 * Resolve a touched diff line from a pointer event's composed path — Pierre
 * drives `onLineEnter` off mouse pointer-moves only (a stationary touch never
 * fires it), so the touch long-press cannot read the hovered line and must
 * resolve the line under the finger itself. This mirrors Pierre's internal
 * `resolvePointerTarget`: walk the composed path reading the line number /
 * line-type / enclosing code column off Pierre's own data attributes, and
 * identify the owning item by matching the path against the rendered items'
 * container elements (which appear in the composed path as shadow hosts).
 *
 * This is the single sanctioned exception to the wrapper's "no DOM scraping"
 * rule: there is no typed Pierre callback for a touch press target, so the
 * attributes Pierre itself emits are read here. Returns null when the path does
 * not land on a resolvable line within a known item.
 */
export function resolveTouchedLine(
  path: readonly EventTarget[],
  renderedItems: ReadonlyArray<{ element: HTMLElement; item: PhoenixDiffItem }>,
): TouchedLine | null {
  let item: PhoenixDiffItem | undefined;
  let lineNumber: number | undefined;
  let lineType: LineTypes | undefined;
  let codeElement: HTMLElement | undefined;
  for (const node of path) {
    if (!(node instanceof HTMLElement)) continue;
    if (item === undefined) {
      const match = renderedItems.find((r) => r.element === node);
      if (match) item = match.item;
    }
    if (lineNumber === undefined) {
      const raw = node.getAttribute('data-column-number') ?? node.getAttribute('data-line');
      if (raw != null) {
        const n = Number.parseInt(raw, 10);
        if (!Number.isNaN(n)) {
          lineNumber = n;
          lineType = lineTypeFromElement(node);
        }
      }
    }
    if (codeElement === undefined && node.hasAttribute('data-code')) codeElement = node;
  }
  if (!item || lineNumber === undefined || lineType === undefined || !codeElement) return null;
  return { item, side: annotationSideFor(lineType, codeElement), lineNumber };
}
/**
 * Hydration: turning a *partial* diff item (only the lines the patch carried)
 * into a *complete* one (the whole file on both sides), which is what unlocks
 * `@pierre/diffs`' built-in "expand unchanged lines" affordance.
 *
 * Pierre gates expansion on `FileDiffMetadata.isPartial`, which `processFile`
 * sets to false only when handed both file sides in full. Nothing else about
 * the item changes: hunk offsets, line numbers and note anchors are produced by
 * the same parser from the same patch text, so hydration is transparent to
 * every consumer of the parse.
 *
 * Pierre trusts the supplied contents without checking them against the patch.
 * Contents that do not match the patch's base yield hunk offsets that point at
 * the wrong lines, with no error raised — so callers must only ever pass
 * content the server resolved by the patch's own blob object ids. Hydration
 * additionally verifies the result before returning it (see below); a file that
 * fails verification stays partial and simply renders without expansion.
 */

/** The per-file patch text, retained at parse time so hydration can re-run the
 *  parser with file contents attached. Pierre's `FileDiffMetadata` does not
 *  retain the source patch, so it has to be kept alongside. */
export interface SectionFileSource {
  itemId: string;
  section: DiffSection;
  filePath: string;
  /** Blob object ids from the patch's `index` line. Empty when the patch
   *  carried no index line, which makes the file non-hydratable: without an id
   *  there is no way to fetch content that is provably the right version. */
  prevObjectId: string;
  newObjectId: string;
  /** The single-file slice of the raw patch this item was parsed from. */
  patchText: string;
}

/**
 * Re-parse one file's patch with full contents attached, yielding an item Pierre
 * will render with expansion affordances.
 *
 * Returns null when the hydrated parse cannot be trusted, in which case the
 * caller keeps the partial item. Verification compares the hydrated file's
 * context lines against the lines the patch itself carried: if the supplied
 * contents belong to a different version of the file, those disagree, and
 * rendering would show context that silently does not match the diff. It also
 * checks that the patch accounts for the file's whole line-count delta, since a
 * patch missing hunks describes a file that cannot be laid out.
 */
export function hydrateItem(
  source: SectionFileSource,
  oldContents: string,
  newContents: string,
): PhoenixDiffItem | null {
  let hydrated: FileDiffMetadata | undefined;
  try {
    hydrated = processFile(source.patchText, {
      cacheKey: `${source.itemId}:hydrated`,
      oldFile: { name: source.filePath, contents: oldContents },
      newFile: { name: source.filePath, contents: newContents },
    });
  } catch {
    return null;
  }
  if (!hydrated || hydrated.isPartial) return null;
  if (!hydratedMatchesPatch(hydrated, source.patchText)) return null;
  if (!hydratedAccountsForWholeFile(hydrated)) return null;
  return {
    id: source.itemId,
    type: 'diff',
    fileDiff: { ...hydrated, prevName: hydrated.prevName ?? '' },
  };
}

/**
 * Check that a hydrated file's lines agree with the patch that described them.
 *
 * This is the guard against Pierre's silent-misalignment failure mode. The
 * server resolves content by blob object id, so a mismatch should be
 * unreachable; verifying anyway means a bug in that chain degrades to "no
 * expansion for this file" instead of "context lines that quietly lie".
 *
 * Every hunk's first addition-side line is compared against the file content at
 * the line number the hunk claims. One anchor per hunk is enough: the failure
 * being guarded against is a whole-file offset shift, which moves every hunk.
 */
function hydratedMatchesPatch(hydrated: FileDiffMetadata, patchText: string): boolean {
  const patchAdditions = additionLinesFromPatch(patchText);
  let consumed = 0;
  for (const hunk of hydrated.hunks) {
    const expected = patchAdditions[consumed];
    consumed += hunk.additionCount;
    if (expected === undefined) continue;
    const actual = hydrated.additionLines[hunk.additionLineIndex];
    if (actual === undefined) return false;
    if (stripEol(actual) !== stripEol(expected)) return false;
  }
  return true;
}

/**
 * Check that the patch accounts for the entire difference between the two file
 * versions it was hydrated against.
 *
 * Everything past a diff's final hunk is trailing context — the same lines on
 * both sides — so both sides must have an equal number of lines left over. That
 * holds exactly when the hunks account for the whole line-count delta between
 * the two versions, and fails when the patch is missing hunks: a patch abridged
 * upstream still anchors correctly at every hunk it kept, so
 * `hydratedMatchesPatch` cannot see the loss, while the leftover counts can.
 *
 * This matters because a partial parse and a whole-file parse fail differently.
 * A partial parse renders only the lines the patch carried, so missing hunks are
 * merely missing. A whole-file parse claims to describe the file end to end, and
 * Pierre lays it out on that basis: it derives the same two leftover counts and
 * throws when they disagree. That throw happens inside a layout effect, where
 * React's only recovery is to unmount the tree — so a diff Pierre cannot lay out
 * must never reach it.
 *
 * A file that exists on only one side — added or deleted — has no shared
 * trailing context for the two counts to describe, and Pierre skips the
 * comparison for it. The condition is scoped to match, so a one-sided file keeps
 * expanding rather than being rejected by a rule that does not apply to it.
 */
function hydratedAccountsForWholeFile(hydrated: FileDiffMetadata): boolean {
  const finalHunk = hydrated.hunks.at(-1);
  if (finalHunk === undefined) return true;
  if (hydrated.additionLines.length === 0 || hydrated.deletionLines.length === 0) return true;
  const additionsRemaining = hydrated.additionLines.length
    - (finalHunk.additionLineIndex + finalHunk.additionCount);
  const deletionsRemaining = hydrated.deletionLines.length
    - (finalHunk.deletionLineIndex + finalHunk.deletionCount);
  return additionsRemaining === deletionsRemaining;
}

/** The addition-side lines (context + additions) a patch carries, in order —
 *  the same sequence a hydrated parse reproduces from the real file. */
function additionLinesFromPatch(patchText: string): string[] {
  const out: string[] = [];
  let inHunk = false;
  for (const line of patchText.split('\n')) {
    if (line.startsWith('@@')) {
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    // `\ No newline at end of file` is a marker, not content.
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+') || line.startsWith(' ')) out.push(line.slice(1));
  }
  return out;
}
