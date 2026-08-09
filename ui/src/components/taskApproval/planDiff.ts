/**
 * Plan revision diffing for the task approval reader (REQ-PF-018).
 *
 * Pure, React-free block/word alignment between the plan the reviewer last saw
 * and the plan they are looking at now. The output is expressed in the same
 * coordinate system the reader's Find plumbing already uses — a block id plus
 * character offsets into that block's `searchableText` — so change marks and
 * find highlights decorate rendered markdown the same way, and the reading
 * experience survives the diff being switched on.
 */

import { buildMarkdownDisplayBlocks, type MarkdownDisplayBlock } from '../viewer-find/searchProjections';

/** A half-open character range within a block's `searchableText`. */
export interface PlanDiffRange {
  start: number;
  end: number;
}

export type PlanDiffBlockStatus = 'unchanged' | 'added' | 'changed';

/**
 * How one block of the *current* plan relates to the baseline.
 *
 * `insertions` are ranges into this block's own `searchableText`; `deletions`
 * are the baseline words that no longer appear, kept as text because they have
 * no position in the current document to anchor to.
 */
export interface PlanDiffBlock {
  blockId: string;
  lineNumber: number;
  status: PlanDiffBlockStatus;
  insertions: PlanDiffRange[];
  deletions: string[];
}

/** Baseline text that vanished entirely, surfaced at its former position. */
export interface PlanDiffRemoval {
  /** Block id of the current-plan block this removal is shown before. */
  beforeBlockId: string | null;
  text: string;
}

/** Whether the revision touched the text a prior review note was anchored to. */
export type PlanNoteStatus = 'touched' | 'untouched';

export interface PlanDiffNote {
  lineNumber: number;
  lineContent: string;
  note: string;
  status: PlanNoteStatus;
  /** Block of the *current* plan to render this note beside, when one survives. */
  blockId: string | null;
}

export interface PlanDiff {
  blocks: PlanDiffBlock[];
  removals: PlanDiffRemoval[];
  notes: PlanDiffNote[];
  /** Count of blocks that were added or changed, plus wholly-removed blocks. */
  changeCount: number;
}

export interface PlanDiffInputNote {
  lineNumber: number;
  lineContent: string;
  note: string;
}

/**
 * Split text into words plus their offsets, treating runs of whitespace as
 * separators that belong to neither neighbour.
 */
function tokenize(text: string): { word: string; start: number; end: number }[] {
  const tokens: { word: string; start: number; end: number }[] = [];
  const re = /\S+/g;
  let match = re.exec(text);
  while (match !== null) {
    tokens.push({ word: match[0], start: match.index, end: match.index + match[0].length });
    match = re.exec(text);
  }
  return tokens;
}

/**
 * Indices of a longest common subsequence of two sequences, as pairs of
 * (left index, right index).
 */
function lcsPairs<T>(left: readonly T[], right: readonly T[], eq: (a: T, b: T) => boolean): [number, number][] {
  const rows = left.length;
  const cols = right.length;
  // table[i][j] = LCS length of left[i..] and right[j..]
  const table: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let i = rows - 1; i >= 0; i -= 1) {
    for (let j = cols - 1; j >= 0; j -= 1) {
      table[i]![j] = eq(left[i]!, right[j]!)
        ? table[i + 1]![j + 1]! + 1
        : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }
  const pairs: [number, number][] = [];
  let i = 0;
  let j = 0;
  while (i < rows && j < cols) {
    if (eq(left[i]!, right[j]!)) {
      pairs.push([i, j]);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      i += 1;
    } else {
      j += 1;
    }
  }
  return pairs;
}

/** Fraction of `a`'s words that also appear in `b`. 0 when `a` is empty. */
function wordOverlap(a: string, b: string): number {
  const aWords = tokenize(a).map((t) => t.word);
  if (aWords.length === 0) return 0;
  const bWords = new Set(tokenize(b).map((t) => t.word));
  const shared = aWords.filter((w) => bWords.has(w)).length;
  return shared / aWords.length;
}

/**
 * A removed and an added block are treated as one edited block when they share
 * enough vocabulary. Below this, they are genuinely different prose and pairing
 * them would produce a word diff that reads as noise.
 */
const PAIR_SIMILARITY_THRESHOLD = 0.3;

/** Word-level insertions (into `current`) and deletions (from `previous`). */
function diffWords(previous: string, current: string): { insertions: PlanDiffRange[]; deletions: string[] } {
  const prevTokens = tokenize(previous);
  const currTokens = tokenize(current);
  const common = lcsPairs(prevTokens, currTokens, (a, b) => a.word === b.word);

  const matchedPrev = new Set(common.map(([p]) => p));
  const matchedCurr = new Set(common.map(([, c]) => c));

  // Merge adjacent inserted tokens into one range so a rewritten phrase reads
  // as a single mark rather than a run of per-word underlines.
  const insertions: PlanDiffRange[] = [];
  currTokens.forEach((token, index) => {
    if (matchedCurr.has(index)) return;
    const last = insertions[insertions.length - 1];
    if (last && !matchedCurr.has(index - 1) && index > 0) {
      last.end = token.end;
      return;
    }
    insertions.push({ start: token.start, end: token.end });
  });

  const deletions: string[] = [];
  let run: string[] = [];
  prevTokens.forEach((token, index) => {
    if (matchedPrev.has(index)) {
      if (run.length > 0) {
        deletions.push(run.join(' '));
        run = [];
      }
      return;
    }
    run.push(token.word);
  });
  if (run.length > 0) deletions.push(run.join(' '));

  return { insertions, deletions };
}

/** The block whose source range covers `lineNumber`, preferring the tightest. */
function blockForLine(
  blocks: readonly MarkdownDisplayBlock[],
  lineNumber: number,
): MarkdownDisplayBlock | undefined {
  let best: MarkdownDisplayBlock | undefined;
  for (const block of blocks) {
    if (block.lineNumber > lineNumber) continue;
    if (!best || block.lineNumber > best.lineNumber) best = block;
  }
  return best;
}

/**
 * Diff the plan currently under review against the plan the reviewer last saw.
 *
 * Blocks are aligned by exact text first; the leftovers are paired positionally
 * when they are similar enough to be an edit of one another, which is what turns
 * a rewritten paragraph into a word-level `changed` block instead of an
 * unrelated add/remove pair.
 */
export function computePlanDiff(
  previousPlan: string,
  currentPlan: string,
  previousNotes: readonly PlanDiffInputNote[] = [],
): PlanDiff {
  const prevBlocks = buildMarkdownDisplayBlocks(previousPlan);
  const currBlocks = buildMarkdownDisplayBlocks(currentPlan);

  const anchored = lcsPairs(prevBlocks, currBlocks, (a, b) => a.searchableText === b.searchableText);
  const anchoredPrev = new Map(anchored.map(([p, c]) => [p, c]));
  const anchoredCurr = new Map(anchored.map(([p, c]) => [c, p]));

  // Walk both sequences together, pairing the unanchored runs between anchors.
  const pairedCurrToPrev = new Map<number, number>();
  const unpairedPrev: number[] = [];
  let prevCursor = 0;
  let currCursor = 0;
  const anchorList = [...anchored, [prevBlocks.length, currBlocks.length] as [number, number]];

  for (const [prevAnchor, currAnchor] of anchorList) {
    const prevRun: number[] = [];
    for (let i = prevCursor; i < prevAnchor; i += 1) prevRun.push(i);
    const currRun: number[] = [];
    for (let j = currCursor; j < currAnchor; j += 1) currRun.push(j);

    const consumedPrev = new Set<number>();
    for (const currIndex of currRun) {
      let bestPrev: number | undefined;
      let bestScore = PAIR_SIMILARITY_THRESHOLD;
      for (const prevIndex of prevRun) {
        if (consumedPrev.has(prevIndex)) continue;
        const score = wordOverlap(
          prevBlocks[prevIndex]!.searchableText,
          currBlocks[currIndex]!.searchableText,
        );
        if (score > bestScore) {
          bestScore = score;
          bestPrev = prevIndex;
        }
      }
      if (bestPrev !== undefined) {
        consumedPrev.add(bestPrev);
        pairedCurrToPrev.set(currIndex, bestPrev);
      }
    }
    for (const prevIndex of prevRun) {
      if (!consumedPrev.has(prevIndex)) unpairedPrev.push(prevIndex);
    }

    prevCursor = prevAnchor + 1;
    currCursor = currAnchor + 1;
  }

  const blocks: PlanDiffBlock[] = currBlocks.map((block, index) => {
    if (anchoredCurr.has(index)) {
      return {
        blockId: block.id,
        lineNumber: block.lineNumber,
        status: 'unchanged',
        insertions: [],
        deletions: [],
      };
    }
    const pairedPrev = pairedCurrToPrev.get(index);
    if (pairedPrev === undefined) {
      return {
        blockId: block.id,
        lineNumber: block.lineNumber,
        status: 'added',
        insertions: [{ start: 0, end: block.searchableText.length }],
        deletions: [],
      };
    }
    const { insertions, deletions } = diffWords(
      prevBlocks[pairedPrev]!.searchableText,
      block.searchableText,
    );
    return {
      blockId: block.id,
      lineNumber: block.lineNumber,
      status: 'changed',
      insertions,
      deletions,
    };
  });

  // A wholly-removed block is shown at the position it used to occupy: before
  // the next surviving block, or at the end when it was trailing.
  const removals: PlanDiffRemoval[] = unpairedPrev.map((prevIndex) => {
    let beforeBlockId: string | null = null;
    for (let i = prevIndex + 1; i < prevBlocks.length; i += 1) {
      const currIndex = anchoredPrev.get(i);
      if (currIndex !== undefined) {
        beforeBlockId = currBlocks[currIndex]!.id;
        break;
      }
    }
    return { beforeBlockId, text: prevBlocks[prevIndex]!.searchableText };
  });

  const prevIndexToCurr = new Map<number, number>([
    ...anchoredPrev.entries(),
    ...[...pairedCurrToPrev.entries()].map(([c, p]) => [p, c] as [number, number]),
  ]);

  const notes: PlanDiffNote[] = previousNotes.map((note) => {
    const prevBlock = blockForLine(prevBlocks, note.lineNumber);
    const prevIndex = prevBlock ? prevBlocks.indexOf(prevBlock) : -1;
    if (prevIndex < 0) {
      return { ...note, status: 'untouched', blockId: null };
    }
    const currIndex = prevIndexToCurr.get(prevIndex);
    if (currIndex === undefined) {
      // The annotated text is gone entirely — the revision certainly touched it.
      return { ...note, status: 'touched', blockId: null };
    }
    const currBlockId = currBlocks[currIndex]!.id;
    const diffBlock = blocks.find((b) => b.blockId === currBlockId);
    return {
      ...note,
      status: diffBlock && diffBlock.status !== 'unchanged' ? 'touched' : 'untouched',
      blockId: currBlockId,
    };
  });

  const changeCount =
    blocks.filter((block) => block.status !== 'unchanged').length + removals.length;

  return { blocks, removals, notes, changeCount };
}
