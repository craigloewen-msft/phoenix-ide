/**
 * TaskApprovalReader Component
 *
 * Renders a task for approval. The user MUST choose one of:
 * Approve, Discard, or Send Feedback. The overlay cannot be dismissed
 * by Escape, back button, or clicking outside.
 *
 * Annotations use the same long-press idiom as the file viewer, but this
 * component is intentionally separate from the MetaViewer file-review stack
 * (local approval-feedback notes, not the conversation ReviewNotesContext; a
 * non-dismissible phase overlay, not a viewer slot). See specs/prose-feedback/
 * for the rationale. Plan content comes from ConversationState, not from disk.
 */

import { Children, cloneElement, isValidElement, useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { SyntaxHighlighter, oneDark } from '../utils/syntaxHighlighter';
import { MermaidDiagram } from './MermaidDiagram';
import { generateUUID } from '../utils/uuid';
import type { TaskApprovalHandoff, TaskFeedbackNote, PlanDiffBaseline } from '../api';
import { api } from '../api';
import { computePlanDiff, type PlanDiff } from './taskApproval/planDiff';
import './taskApproval/planDiff.css';
import { useRegisterFocusScope } from '../hooks/useFocusScope';
import {
  FindBar,
  activeSessionMatchIndex,
  buildBlockSearchProjection,
  buildMarkdownDisplayBlocks,
  createSurfaceKey,
  projectionMatchesToSessionMatches,
  useFindSession,
  useViewerFindKeyboardShortcut,
  type BlockSearchMatchTarget,
  type FindSessionCommand,
} from './viewer-find';
import {
  X,
  MessageSquare,
  MessageSquarePlus,
  Trash2,
  Send,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Check,
  Loader2,
  GitCompare,
} from 'lucide-react';

/**
 * Remembered `Plan diff` toggle choice. Persisted per-browser so a reviewer who
 * has turned the diff off stays off across revisions within a review session.
 */
const PLAN_DIFF_PREF_KEY = 'phoenix.planDiff.enabled';

function readPlanDiffPreference(): boolean | null {
  try {
    const raw = window.localStorage.getItem(PLAN_DIFF_PREF_KEY);
    if (raw === 'true') return true;
    if (raw === 'false') return false;
  } catch {
    // Private-mode or blocked storage: fall back to the computed default.
  }
  return null;
}

function writePlanDiffPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(PLAN_DIFF_PREF_KEY, String(enabled));
  } catch {
    // Preference is a convenience; failing to persist it must not break review.
  }
}

// Reuse ReviewNote type shape
interface ReviewNote {
  id: string;
  lineNumber: number;
  lineContent: string;
  note: string;
  timestamp: number;
}

const formatTaskApprovalContextPercent = (used: number, max: number): string => {
  if (max <= 0) return '0%';
  const percent = Math.min(Math.max((used / max) * 100, 0), 100);
  return `${Math.round(percent)}%`;
};

type TaskApprovalContextRecommendation = 'start-here' | 'new-chat' | 'either';

function getTaskApprovalContextRecommendation(percent: number): {
  kind: TaskApprovalContextRecommendation;
  label: string;
} {
  if (percent < 60) return { kind: 'start-here', label: 'Start here recommended' };
  if (percent < 82) return { kind: 'either', label: 'Either path is fine' };
  if (percent < 94) return { kind: 'new-chat', label: 'New chat recommended' };
  return { kind: 'new-chat', label: 'New chat strongly recommended' };
}

export interface TaskApprovalReaderProps {
  title: string;
  priority: string;
  plan: string;
  /**
   * Conversation whose plan revision history supplies the diff baseline
   * (REQ-PF-018). Omitted in fixtures/stories that render the reader without a
   * live conversation — the diff affordance is then simply absent.
   */
  conversationId?: string | undefined;
  contextWindowUsed?: number | undefined;
  modelContextWindow?: number | undefined;
  approvalError?: string | null | undefined;
  onApprove: (handoff: TaskApprovalHandoff) => void;
  onReject: () => void;
  onSendFeedback: (notes: readonly TaskFeedbackNote[]) => void;
}

// Long-press hook (same as ProseReader)
function useLongPress(
  onLongPress: (lineNumber: number, lineContent: string) => void,
  threshold = 500,
  movementThreshold = 10
) {
  const timerRef = useRef<number | null>(null);
  const startPosRef = useRef<{ x: number; y: number } | null>(null);

  const cancel = useCallback(() => {
    if (timerRef.current) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    startPosRef.current = null;
  }, []);

  const start = useCallback(
    (
      e: React.TouchEvent | React.MouseEvent,
      lineNumber: number,
      lineContent: string
    ) => {
      const touch = 'touches' in e ? e.touches[0] : undefined;
      const pos = touch
        ? { x: touch.clientX, y: touch.clientY }
        : { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };

      startPosRef.current = pos;

      timerRef.current = window.setTimeout(() => {
        if ('vibrate' in navigator) {
          navigator.vibrate(50);
        }
        onLongPress(lineNumber, lineContent);
        cancel();
      }, threshold);
    },
    [onLongPress, threshold, cancel]
  );

  const move = useCallback(
    (e: React.TouchEvent | React.MouseEvent) => {
      if (!startPosRef.current) return;

      const touch = 'touches' in e ? e.touches[0] : undefined;
      const pos = touch
        ? { x: touch.clientX, y: touch.clientY }
        : { x: (e as React.MouseEvent).clientX, y: (e as React.MouseEvent).clientY };

      const deltaX = Math.abs(pos.x - startPosRef.current.x);
      const deltaY = Math.abs(pos.y - startPosRef.current.y);

      if (deltaX > movementThreshold || deltaY > movementThreshold) {
        cancel();
      }
    },
    [movementThreshold, cancel]
  );

  const end = useCallback(() => {
    cancel();
  }, [cancel]);

  return { start, move, end };
}

// Annotatable block wrapper
interface AnnotatableBlockProps {
  as?: React.ElementType;
  lineNumber: number;
  lineContent: string;
  onAnnotate: (lineNumber: number, lineContent: string) => void;
  isHighlighted?: boolean;
  lineRef?: (el: HTMLElement | null) => void;
  className?: string;
  children?: React.ReactNode;
  [key: string]: unknown;
}

function AnnotatableBlock({
  as: Tag = 'div',
  lineNumber,
  lineContent,
  onAnnotate,
  isHighlighted,
  lineRef,
  className,
  children,
  ...rest
}: AnnotatableBlockProps) {
  
  const { start, move, end } = useLongPress(onAnnotate);
  const cls = [
    'annotatable',
    className,
    isHighlighted && 'annotatable--highlighted',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <Tag
      ref={(el: HTMLElement | null) => lineRef?.(el)}
      className={cls}
      onTouchStart={(e: React.TouchEvent) => start(e, lineNumber, lineContent)}
      onTouchMove={move}
      onTouchEnd={end}
      onMouseDown={(e: React.MouseEvent) => start(e, lineNumber, lineContent)}
      onMouseMove={move}
      onMouseUp={end}
      onMouseLeave={end}
      data-line={lineNumber}
      {...rest}
    >
      {children}
      <button
        className="annotatable__btn"
        onClick={(e: React.MouseEvent) => {
          e.stopPropagation();
          onAnnotate(lineNumber, lineContent);
        }}
        aria-label={`Add note to line ${lineNumber}`}
        title="Add note"
      >
        <MessageSquarePlus size={14} />
      </button>
    </Tag>
  );
}

function renderFindFragments(
  text: string,
  matches: readonly { start: number; end: number; occurrenceIndex: number }[],
  activeOccurrence: number,
): React.ReactNode[] {
  if (matches.length === 0) return [text];
  const fragments: React.ReactNode[] = [];
  let cursor = 0;
  matches.forEach((match) => {
    const start = Math.max(match.start, cursor);
    if (start > cursor) fragments.push(text.slice(cursor, start));
    if (match.end <= start) return;
    fragments.push(
      <mark
        key={`${match.start}-${match.end}-${match.occurrenceIndex}`}
        className={match.occurrenceIndex === activeOccurrence ? 'viewer-find-match viewer-find-match--active' : 'viewer-find-match'}
        data-find-occurrence={match.occurrenceIndex}
      >
        {text.slice(start, match.end)}
      </mark>
    );
    cursor = match.end;
  });
  if (cursor < text.length) fragments.push(text.slice(cursor));
  return fragments;
}

function renderedInlineTextLength(node: React.ReactNode): number {
  let length = 0;
  Children.forEach(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      length += String(child).length;
      return;
    }
    if (isValidElement<{ children?: React.ReactNode }>(child)) {
      length += renderedInlineTextLength(child.props.children);
    }
  });
  return length;
}

function isReactMarkdownInlineElement(
  element: React.ReactElement<{
    children?: React.ReactNode;
    node?: { tagName?: string; type?: string };
  }>,
): boolean {
  return ['a', 'code', 'strong', 'em', 'del', 'span'].includes(element.props.node?.tagName ?? '');
}

function isDecoratableInlineElement(
  element: React.ReactElement<{
    children?: React.ReactNode;
    node?: { tagName?: string; type?: string };
  }>,
): boolean {
  if (element.type === 'mark') return false;
  if (isReactMarkdownInlineElement(element)) return true;
  return typeof element.type === 'string'
    && ['a', 'code', 'strong', 'em', 'del', 'span'].includes(element.type);
}

function decorateFindChildren(
  children: React.ReactNode,
  matches: readonly { start: number; end: number; occurrenceIndex: number }[],
  activeOccurrence: number,
): React.ReactNode {
  let cursor = 0;
  const decorate = (node: React.ReactNode): React.ReactNode => Children.map(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      const text = String(child);
      const start = cursor;
      cursor += text.length;
      const localMatches = matches
        .filter((match) => match.start < cursor && match.end > start)
        .map((match) => ({
          ...match,
          start: Math.max(0, match.start - start),
          end: Math.min(text.length, match.end - start),
        }));
      return localMatches.length > 0 ? renderFindFragments(text, localMatches, activeOccurrence) : child;
    }
    if (!isValidElement<{ children?: React.ReactNode; node?: { tagName?: string; type?: string } }>(child)) return child;
    if (!isDecoratableInlineElement(child)) {
      cursor += renderedInlineTextLength(child.props.children);
      return child;
    }
    return cloneElement(child, {}, decorate(child.props.children));
  });
  return decorate(children);
}

/**
 * Wrap the inserted ranges of a changed block in change marks, reusing the
 * find-decoration walk so marks land on text nodes inside inline markup rather
 * than replacing the rendered children wholesale.
 */
function decorateDiffChildren(
  children: React.ReactNode,
  insertions: readonly { start: number; end: number }[],
): React.ReactNode {
  if (insertions.length === 0) return children;
  let cursor = 0;
  const decorate = (node: React.ReactNode): React.ReactNode => Children.map(node, (child) => {
    if (typeof child === 'string' || typeof child === 'number') {
      const text = String(child);
      const start = cursor;
      cursor += text.length;
      const local = insertions
        .filter((range) => range.start < cursor && range.end > start)
        .map((range) => ({
          start: Math.max(0, range.start - start),
          end: Math.min(text.length, range.end - start),
        }));
      if (local.length === 0) return child;
      const fragments: React.ReactNode[] = [];
      let offset = 0;
      local.forEach((range) => {
        if (range.start > offset) fragments.push(text.slice(offset, range.start));
        fragments.push(
          <ins key={`${range.start}-${range.end}`} className="plan-diff-ins">
            {text.slice(range.start, range.end)}
          </ins>,
        );
        offset = range.end;
      });
      if (offset < text.length) fragments.push(text.slice(offset));
      return fragments;
    }
    if (!isValidElement<{ children?: React.ReactNode; node?: { tagName?: string; type?: string } }>(child)) return child;
    if (!isDecoratableInlineElement(child)) {
      cursor += renderedInlineTextLength(child.props.children);
      return child;
    }
    return cloneElement(child, {}, decorate(child.props.children));
  });
  return decorate(children);
}

export function TaskApprovalReader({
  title,
  priority,
  plan,
  conversationId,
  contextWindowUsed,
  modelContextWindow,
  approvalError,
  onApprove,
  onReject,
  onSendFeedback,
}: TaskApprovalReaderProps) {
  useRegisterFocusScope('task-approval');

  const [approvingHandoff, setApprovingHandoff] = useState<TaskApprovalHandoff | null>(null);
  const [notes, setNotes] = useState<ReviewNote[]>([]);
  const [annotatingLine, setAnnotatingLine] = useState<{
    lineNumber: number;
    lineContent: string;
  } | null>(null);
  const [noteInput, setNoteInput] = useState('');
  const [showNotesPanel, setShowNotesPanel] = useState(false);
  const [highlightedLine, setHighlightedLine] = useState<number | null>(null);
  const [discardConfirmOpen, setDiscardConfirmOpen] = useState(false);
  const [baseline, setBaseline] = useState<PlanDiffBaseline | null>(null);
  const [diffEnabled, setDiffEnabled] = useState<boolean | null>(readPlanDiffPreference);
  const [activeChangeIndex, setActiveChangeIndex] = useState(0);
  const hasUnsentNotes = notes.length > 0;
  const noteCountLabel = `${notes.length} note${notes.length !== 1 ? 's' : ''}`;

  const contextUsage =
    contextWindowUsed !== undefined && modelContextWindow !== undefined && modelContextWindow > 0
      ? Math.min(Math.max((contextWindowUsed / modelContextWindow) * 100, 0), 100)
      : null;
  const contextUsagePercent = contextUsage !== null
    ? formatTaskApprovalContextPercent(contextWindowUsed ?? 0, modelContextWindow ?? 0)
    : null;
  const contextRecommendation = contextUsage !== null
    ? getTaskApprovalContextRecommendation(contextUsage)
    : null;

  const toggleDiff = useCallback(() => {
    setDiffEnabled((prev) => {
      const next = !(prev ?? true);
      writePlanDiffPreference(next);
      return next;
    });
  }, []);

  const markdownDisplayBlocks = useMemo(() => buildMarkdownDisplayBlocks(plan), [plan]);

  // Fetch the plan the reviewer last saw. A 204 (first proposal) leaves
  // `baseline` null, which is what withholds the diff affordance entirely.
  useEffect(() => {
    if (!conversationId) return undefined;
    let cancelled = false;
    void api
      .getPlanDiffBaseline(conversationId)
      .then((result) => {
        if (!cancelled) setBaseline(result);
      })
      .catch((err: unknown) => {
        // A missing baseline degrades to today's plain reader; it must never
        // block the approval decision.
        console.warn('Failed to load plan diff baseline:', err);
      });
    return () => {
      cancelled = true;
    };
  }, [conversationId, plan]);

  const planDiff: PlanDiff | null = useMemo(
    () => (baseline ? computePlanDiff(baseline.plan, plan, baseline.notes.map((n) => ({
      lineNumber: n.line_number,
      lineContent: n.line_content,
      note: n.note,
    }))) : null),
    [baseline, plan],
  );

  // Default on when there is something to see: the value of the diff is lost if
  // the reviewer has to go looking for it. An explicit prior choice wins.
  const hasDiff = planDiff !== null && planDiff.changeCount > 0;
  const showDiff = hasDiff && (diffEnabled ?? true);

  const diffBlocksById = useMemo(() => {
    const map = new Map<string, PlanDiff['blocks'][number]>();
    if (showDiff && planDiff) {
      for (const block of planDiff.blocks) map.set(block.blockId, block);
    }
    return map;
  }, [planDiff, showDiff]);

  const diffNotesByBlockId = useMemo(() => {
    const map = new Map<string, PlanDiff['notes']>();
    if (showDiff && planDiff) {
      for (const note of planDiff.notes) {
        if (!note.blockId) continue;
        const bucket = map.get(note.blockId);
        if (bucket) bucket.push(note);
        else map.set(note.blockId, [note]);
      }
    }
    return map;
  }, [planDiff, showDiff]);

  const removalsByBlockId = useMemo(() => {
    const map = new Map<string, PlanDiff['removals']>();
    if (showDiff && planDiff) {
      for (const removal of planDiff.removals) {
        if (!removal.beforeBlockId) continue;
        const bucket = map.get(removal.beforeBlockId);
        if (bucket) bucket.push(removal);
        else map.set(removal.beforeBlockId, [removal]);
      }
    }
    return map;
  }, [planDiff, showDiff]);

  /** Changed blocks in document order — the jump-to-next-change itinerary. */
  const changedBlockIds = useMemo(
    () =>
      showDiff && planDiff
        ? planDiff.blocks.filter((b) => b.status !== 'unchanged').map((b) => b.blockId)
        : [],
    [planDiff, showDiff],
  );
  const findablePlanBlocks = useMemo(
    () => markdownDisplayBlocks.map((block) => ({ id: block.id, lineNumber: block.lineNumber, text: block.searchableText })),
    [markdownDisplayBlocks],
  );

  const noteInputRef = useRef<HTMLTextAreaElement>(null);
  const findButtonRef = useRef<HTMLButtonElement>(null);
  const lineRefs = useRef<Map<number, HTMLElement>>(new Map());
  const blockRefs = useRef<Map<string, HTMLElement>>(new Map());
  const registerBlockRef = useCallback((blockId: string, element: HTMLElement | null) => {
    if (element) blockRefs.current.set(blockId, element);
    else blockRefs.current.delete(blockId);
  }, []);

  // Focus note input when dialog opens
  useEffect(() => {
    if (annotatingLine && noteInputRef.current) {
      noteInputRef.current.focus();
    }
  }, [annotatingLine]);

  // Clear highlight after animation
  useEffect(() => {
    if (highlightedLine !== null) {
      const timer = setTimeout(() => setHighlightedLine(null), 2000);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [highlightedLine]);

  useEffect(() => {
    if (approvalError) {
      setApprovingHandoff(null);
    }
  }, [approvalError]);

  const handleAddNote = useCallback(() => {
    if (!annotatingLine || !noteInput.trim()) return;

    const note: ReviewNote = {
      id: generateUUID(),
      lineNumber: annotatingLine.lineNumber,
      lineContent: annotatingLine.lineContent,
      note: noteInput.trim(),
      timestamp: Date.now(),
    };

    setNotes((prev) => [...prev, note]);
    setAnnotatingLine(null);
    setNoteInput('');
  }, [annotatingLine, noteInput]);

  const handleLongPress = useCallback(
    (lineNumber: number, lineContent: string) => {
      setAnnotatingLine({ lineNumber, lineContent });
      setNoteInput('');
    },
    []
  );

  const handleDeleteNote = useCallback((id: string) => {
    setNotes((prev) => prev.filter((n) => n.id !== id));
  }, []);

  const handleClearAll = useCallback(() => {
    setNotes([]);
    setShowNotesPanel(false);
  }, []);

  const handleJumpToLine = useCallback((lineNumber: number) => {
    const lineEl = lineRefs.current.get(lineNumber);
    if (lineEl) {
      lineEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setHighlightedLine(lineNumber);
    }
    setShowNotesPanel(false);
  }, []);

  const revealFindTarget = useCallback((target: BlockSearchMatchTarget) => {
    queueMicrotask(() => {
      blockRefs.current.get(target.blockId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      if (target.lineNumber > 0) setHighlightedLine(target.lineNumber);
    });
  }, []);
  const handleFindCommands = useCallback((commands: readonly FindSessionCommand<BlockSearchMatchTarget, HTMLElement | null>[]) => {
    commands.forEach((command) => {
      switch (command.kind) {
        case 'focus-query':
        case 'clear-decorations':
          break;
        case 'restore-focus':
          queueMicrotask(() => (command.focusOrigin ?? findButtonRef.current)?.focus());
          break;
        case 'reveal-match':
          revealFindTarget(command.target);
          break;
      }
    });
  }, [revealFindTarget]);
  const { state: findState, send: sendFind } = useFindSession<BlockSearchMatchTarget, HTMLElement | null>({
    onCommands: handleFindCommands,
  });
  const findSession = findState.status === 'open' ? findState : null;
  const findOpen = findSession !== null;
  const findQuery = findSession?.query ?? '';
  const findSurfaceKey = useMemo(() => createSurfaceKey(`task-approval:${plan}`), [plan]);
  const findProjection = useMemo(
    () => (findOpen ? buildBlockSearchProjection(findablePlanBlocks, findQuery) : { sources: [], matches: [] }),
    [findOpen, findablePlanBlocks, findQuery],
  );
  const findSessionMatches = useMemo(
    () => projectionMatchesToSessionMatches(findProjection.matches, (match) => `${match.sourceId}:${match.start}:${match.end}`),
    [findProjection.matches],
  );
  const activeFindIndex = findSession ? activeSessionMatchIndex(findSession.matches, findSession.activeMatchId) : -1;
  const openFind = useCallback(() => {
    const focusOrigin = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    sendFind({ type: 'open', surface: { key: findSurfaceKey, query: '', matches: [], focusOrigin } });
  }, [findSurfaceKey, sendFind]);
  const closeFind = useCallback(() => sendFind({ type: 'close' }), [sendFind]);

  // Block Escape from closing — note/dialog/discard/find each get precedence, but
  // the approval reader itself still cannot be dismissed by Escape.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        if (annotatingLine) {
          setAnnotatingLine(null);
          return;
        }
        if (discardConfirmOpen) {
          setDiscardConfirmOpen(false);
          return;
        }
        if (findOpen) {
          closeFind();
          return;
        }
        return;
      }
      if (annotatingLine && (e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        handleAddNote();
        return;
      }
      // `d` toggles the diff, but only when no text-entry surface owns the key.
      if (
        e.key === 'd'
        && !e.ctrlKey && !e.metaKey && !e.altKey
        && !annotatingLine && !discardConfirmOpen && !findOpen
        && !(document.activeElement instanceof HTMLInputElement)
        && !(document.activeElement instanceof HTMLTextAreaElement)
      ) {
        e.preventDefault();
        toggleDiff();
      }
    };

    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [annotatingLine, closeFind, discardConfirmOpen, findOpen, handleAddNote, toggleDiff]);

  useViewerFindKeyboardShortcut({
    scopeId: 'task-approval',
    onOpen: openFind,
    dialogOpen: annotatingLine !== null || discardConfirmOpen,
  });
  useEffect(() => {
    if (!findOpen || findQuery.length === 0) return;
    sendFind({ type: 'replace-results', matches: findSessionMatches });
  }, [findOpen, findQuery, findSessionMatches, sendFind]);
  useEffect(() => {
    sendFind({ type: 'reset' });
  }, [findSurfaceKey, sendFind]);

  const handleFindQueryChange = useCallback((query: string) => sendFind({ type: 'set-query', query }), [sendFind]);
  const handleFindNext = useCallback(() => sendFind({ type: 'next' }), [sendFind]);
  const handleFindPrevious = useCallback(() => sendFind({ type: 'previous' }), [sendFind]);

  // Send the annotations structurally; the LLM-facing prose is rendered
  // server-side so the agent's message and the persisted review record (which
  // the next revision's diff replays) cannot drift apart.
  const handleSendFeedback = useCallback(() => {
    if (notes.length === 0) return;

    onSendFeedback(
      notes.map((n) => ({
        line_number: n.lineNumber,
        line_content: n.lineContent,
        note: n.note,
      })),
    );
    setNotes([]);
    setShowNotesPanel(false);
  }, [notes, onSendFeedback]);

  /** Scroll the nth changed block into view and flash it. */
  const jumpToChange = useCallback(
    (delta: number) => {
      if (changedBlockIds.length === 0) return;
      const next =
        (activeChangeIndex + delta + changedBlockIds.length) % changedBlockIds.length;
      setActiveChangeIndex(next);
      const element = blockRefs.current.get(changedBlockIds[next]!);
      element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [activeChangeIndex, changedBlockIds],
  );

  const handleDiscard = useCallback(() => {
    setDiscardConfirmOpen(true);
  }, []);

  const handleApprove = useCallback(
    (handoff: TaskApprovalHandoff) => {
      setApprovingHandoff(handoff);
      onApprove(handoff);
    },
    [onApprove]
  );

  const confirmDiscard = useCallback(() => {
    setDiscardConfirmOpen(false);
    onReject();
  }, [onReject]);

  // Render plan as markdown with annotatable blocks.
  const renderPlanMarkdown = useMemo(() => {
    const rawLines = plan.split('\n');
    const matchesByBlockId = new Map<string, Array<{ start: number; end: number; occurrenceIndex: number }>>();
    findProjection.matches.forEach((match, occurrenceIndex) => {
      const blockMatches = matchesByBlockId.get(match.target.blockId) ?? [];
      blockMatches.push({
        start: match.target.startOffset,
        end: match.target.endOffset,
        occurrenceIndex,
      });
      matchesByBlockId.set(match.target.blockId, blockMatches);
    });

    const claimDisplayBlock = (lineNumber: number, startOffset?: number, kind?: string): string => {
      const compatible = kind
        ? markdownDisplayBlocks.filter((block) => block.kind === kind)
        : markdownDisplayBlocks;
      const containing = startOffset === undefined
        ? []
        : compatible
            .filter((block) => block.sourceRange.start <= startOffset && startOffset < block.sourceRange.end)
            .sort((left, right) =>
              (left.sourceRange.end - left.sourceRange.start) - (right.sourceRange.end - right.sourceRange.start));
      const match = containing[0] ?? compatible.find((block) => block.lineNumber === lineNumber);
      return match?.id ?? `markdown:line:${lineNumber}`;
    };

    const annotatable = (Tag: React.ElementType, kind?: string, decorateChildren = true) =>
      ({
        children,
        node,
        ...props
      }: {
        children?: React.ReactNode;
        node?: {
          position?: {
            start?: { line?: number; offset?: number };
            end?: { line?: number; offset?: number };
          };
        };
        [key: string]: unknown;
      }) => {
        const ln = node?.position?.start?.line ?? 0;
        const startLine = (node?.position?.start?.line ?? 1) - 1;
        const endLine = (node?.position?.end?.line ?? startLine + 1) - 1;
        const rawLineContent = rawLines
          .slice(startLine, endLine + 1)
          .join(' ')
          .slice(0, 200);
        const blockId = claimDisplayBlock(ln, node?.position?.start?.offset, kind);
        const blockMatches = matchesByBlockId.get(blockId) ?? [];
        const shouldDecorateChildren = decorateChildren && blockMatches.length > 0;
        const diffBlock = diffBlocksById.get(blockId);
        const blockRemovals = removalsByBlockId.get(blockId) ?? [];
        const blockNotes = diffNotesByBlockId.get(blockId) ?? [];
        const isActiveChange =
          changedBlockIds[activeChangeIndex] === blockId && changedBlockIds.length > 0;
        // Find highlighting wins over change marks when both apply: the reviewer
        // asked for the search, so it is the more specific intent.
        const body = shouldDecorateChildren
          ? decorateFindChildren(children, blockMatches, activeFindIndex)
          : diffBlock && decorateChildren
            ? decorateDiffChildren(children, diffBlock.insertions)
            : children;
        const rendered = (
          <AnnotatableBlock
            as={Tag}
            lineNumber={ln}
            lineContent={rawLineContent}
            onAnnotate={handleLongPress}
            className={[
              'viewer-markdown-block',
              showDiff && 'plan-diff-active',
              diffBlock && `plan-diff-block--${diffBlock.status}`,
              isActiveChange && 'plan-diff-block--current',
            ]
              .filter(Boolean)
              .join(' ')}
            isHighlighted={highlightedLine === ln}
            lineRef={(el) => {
              if (el) {
                lineRefs.current.set(ln, el);
                blockRefs.current.set(blockId, el);
              } else {
                lineRefs.current.delete(ln);
                blockRefs.current.delete(blockId);
              }
            }}
            {...props}
          >
            {body}
            {diffBlock && diffBlock.deletions.length > 0 && (
              <span className="plan-diff-deletions">
                {diffBlock.deletions.map((text, index) => (
                  <del key={index} className="plan-diff-del">{text}</del>
                ))}
              </span>
            )}
            {blockNotes.length > 0 && (
              <span className="plan-diff-notes">
                {blockNotes.map((note, index) => (
                  <span
                    key={index}
                    className={`plan-diff-note plan-diff-note--${note.status}`}
                    title={`Your note: ${note.note}`}
                  >
                    <MessageSquare size={12} />
                    {note.status === 'touched' ? 'addressed here' : 'not changed'}
                  </span>
                ))}
              </span>
            )}
          </AnnotatableBlock>
        );
        if (blockRemovals.length === 0) return rendered;
        return (
          <>
            {blockRemovals.map((removal, index) => (
              <div key={index} className="plan-diff-removed-block">
                <del>{removal.text}</del>
              </div>
            ))}
            {rendered}
          </>
        );
      };


    return (
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={
          {
            p: annotatable('p', 'paragraph'),
            h1: annotatable('h1', 'heading'),
            h2: annotatable('h2', 'heading'),
            h3: annotatable('h3', 'heading'),
            h4: annotatable('h4', 'heading'),
            h5: annotatable('h5', 'heading'),
            h6: annotatable('h6', 'heading'),
            td: annotatable('td', 'tableCell'),
            th: annotatable('th', 'tableCell'),
            li: annotatable('li'),
            blockquote: annotatable('blockquote', undefined, false),
            code: ({
              className,
              children,
              node,
              ...props
            }: {
              className?: string;
              children?: React.ReactNode;
              node?: {
                position?: {
                  start?: { line?: number; offset?: number };
                };
              };
              [key: string]: unknown;
            }) => {
              const match = /language-([^\s]+)/.exec(className || '');
              const language = match?.[1]?.toLowerCase();
              const codeText = String(children).replace(/\n$/, '');
              const lineNumber = node?.position?.start?.line ?? 0;
              const startOffset = node?.position?.start?.offset;
              const codeBlock = startOffset === undefined
                ? undefined
                : markdownDisplayBlocks.find((block) =>
                    block.kind === 'code'
                    && block.sourceRange.start <= startOffset
                    && startOffset < block.sourceRange.end);
              const codeBlockId = codeBlock?.id ?? `markdown:inline-code:${startOffset ?? lineNumber}`;
              const codeMatches = matchesByBlockId.get(codeBlockId) ?? [];
              const isBlockCode = codeBlock !== undefined;
              if (isBlockCode && language === 'mermaid') {
                return (
                  <div ref={(element) => registerBlockRef(codeBlockId, element)}>
                    {codeMatches.length > 0 ? (
                      <pre className="language-mermaid">
                        <code>{renderFindFragments(codeText, codeMatches, activeFindIndex)}</code>
                      </pre>
                    ) : (
                      <MermaidDiagram code={String(children)} />
                    )}
                  </div>
                );
              }
              if (isBlockCode) {
                return (
                  <div ref={(element) => registerBlockRef(codeBlockId, element)}>
                    {codeMatches.length > 0 ? (
                      <pre className={match ? `language-${match[1]}` : undefined}>
                        <code>{renderFindFragments(codeText, codeMatches, activeFindIndex)}</code>
                      </pre>
                    ) : match ? (
                      <SyntaxHighlighter
                        style={oneDark}
                        language={match[1]}
                        PreTag="div"
                        {...props}
                      >
                        {codeText}
                      </SyntaxHighlighter>
                    ) : (
                      <pre><code {...props}>{codeText}</code></pre>
                    )}
                  </div>
                );
              }
              return <code className={className} {...props}>{children}</code>;
            },
          } as unknown as Components
        }
      >
        {plan}
      </ReactMarkdown>
    );
  }, [plan, highlightedLine, handleLongPress, findProjection.matches, activeFindIndex, markdownDisplayBlocks, registerBlockRef, diffBlocksById, removalsByBlockId, diffNotesByBlockId, changedBlockIds, activeChangeIndex, showDiff]);

  return (
    <div className="task-approval-reader">
      {/* Header */}
      <div className="task-approval-header">
        <div className="task-approval-title-row">
          <h2 className="task-approval-title">{title}</h2>
          <span className="task-approval-priority">{priority}</span>
        </div>
        <div className="task-approval-header-actions">
          {hasDiff && (
            <>
              <button
                className={`task-approval-badge plan-diff-toggle${showDiff ? ' plan-diff-toggle--on' : ''}`}
                onClick={toggleDiff}
                aria-pressed={showDiff}
                aria-label={showDiff ? 'Hide plan diff' : 'Show plan diff'}
                title={
                  showDiff
                    ? 'Hide what changed since your last review'
                    : 'Show what changed since your last review'
                }
              >
                <GitCompare size={16} />
                <span>
                  {planDiff!.changeCount} change{planDiff!.changeCount === 1 ? '' : 's'}
                </span>
              </button>
              {showDiff && changedBlockIds.length > 0 && (
                <span className="plan-diff-nav">
                  <button
                    className="task-approval-badge"
                    onClick={() => jumpToChange(-1)}
                    aria-label="Previous change"
                    title="Previous change"
                  >
                    <ChevronLeft size={16} />
                  </button>
                  <span className="plan-diff-nav__position">
                    {activeChangeIndex + 1}/{changedBlockIds.length}
                  </span>
                  <button
                    className="task-approval-badge"
                    onClick={() => jumpToChange(1)}
                    aria-label="Next change"
                    title="Next change"
                  >
                    <ChevronRight size={16} />
                  </button>
                </span>
              )}
            </>
          )}
          {notes.length > 0 && (
            <button
              className="task-approval-badge"
              onClick={() => setShowNotesPanel(!showNotesPanel)}
              aria-label={`${notes.length} notes`}
            >
              <MessageSquare size={18} />
              <span>{notes.length}</span>
            </button>
          )}
          <button
            ref={findButtonRef}
            className="task-approval-badge"
            onClick={openFind}
            aria-label="Find in task approval"
            title="Find in task approval"
          >
            Find
          </button>
          <button
            className="task-approval-header-discard"
            onClick={handleDiscard}
            aria-label="Discard task"
            title="Discard task"
          >
            <X size={18} />
          </button>
        </div>
      </div>

      {findOpen && (
        <FindBar
          query={findQuery}
          activeIndex={activeFindIndex}
          matchCount={findSession?.matches.length ?? 0}
          focusVersion={findSession?.focusVersion ?? 0}
          onQueryChange={handleFindQueryChange}
          onNext={handleFindNext}
          onPrevious={handleFindPrevious}
          onClose={closeFind}
          autoFocus
        />
      )}

      {/* Plan content */}
      <div className={`task-approval-content${showDiff ? ' task-approval-content--diffing' : ''}`}>
        <div className="viewer-markdown">{renderPlanMarkdown}</div>
      </div>

      {hasUnsentNotes && (
        <div className="task-approval-feedback-cue" role="status">
          You have {noteCountLabel} of unsent feedback. Send feedback, or approve
          without sending those notes.
        </div>
      )}

      {contextUsagePercent && contextRecommendation && (
        <div className={`task-approval-context-cue task-approval-context-cue--${contextRecommendation.kind}`}>
          <span className="task-approval-context-cue__label">Context</span>
          <span className="task-approval-context-cue__value">{contextUsagePercent} used</span>
          <span className="task-approval-context-cue__recommendation">
            {contextRecommendation.label}
          </span>
          <span className="task-approval-context-cue__hint">
            Start here keeps this discussion; New chat starts a summarized continuation.
          </span>
        </div>
      )}

      {approvalError && (
        <div className="task-approval-error" role="alert">
          {approvalError}
        </div>
      )}

      {/* Action toolbar */}
      <div className="task-approval-actions">
        <button
          className={[
            'task-approval-btn',
            'task-approval-btn--feedback',
            hasUnsentNotes && 'task-approval-btn--recommended',
          ]
            .filter(Boolean)
            .join(' ')}
          onClick={handleSendFeedback}
          disabled={!hasUnsentNotes}
          aria-label={`Request changes (${notes.length})`}
          title={
            !hasUnsentNotes
              ? 'Add annotations to the plan before sending feedback'
              : `Send ${noteCountLabel} as feedback`
          }
        >
          <Send size={18} />
          <span className="task-approval-btn-label-full">Request changes ({notes.length})</span>
          <span className="task-approval-btn-label-compact">Revise</span>
        </button>
        <button
          className={[
            'task-approval-btn',
            'task-approval-btn--approve',
            hasUnsentNotes && 'task-approval-btn--subdued',
            !hasUnsentNotes && contextRecommendation?.kind === 'start-here' && 'task-approval-btn--recommended-decision',
          ]
            .filter(Boolean)
            .join(' ')}
          disabled={approvingHandoff !== null}
          onClick={() => handleApprove('continue_in_current_conversation')}
          aria-label="Approve and start here"
        >
          {approvingHandoff === 'continue_in_current_conversation' ? (
            <>
              <Loader2 size={18} className="spinning" />
              Approving...
            </>
          ) : (
            <>
              <Check size={18} />
              <span className="task-approval-btn-label-full">Start here</span>
              <span className="task-approval-btn-label-compact">Start here</span>
            </>
          )}
        </button>
        <button
          className={[
            'task-approval-btn',
            'task-approval-btn--approve',
            hasUnsentNotes && 'task-approval-btn--subdued',
            !hasUnsentNotes && contextRecommendation?.kind === 'new-chat' && 'task-approval-btn--recommended-decision',
          ]
            .filter(Boolean)
            .join(' ')}
          disabled={approvingHandoff !== null}
          onClick={() => handleApprove('start_fresh_work_conversation')}
          aria-label="Approve and start a new continuation conversation"
        >
          {approvingHandoff === 'start_fresh_work_conversation' ? (
            <>
              <Loader2 size={18} className="spinning" />
              Approving...
            </>
          ) : (
            <>
              <Check size={18} />
              <span className="task-approval-btn-label-full">New chat</span>
              <span className="task-approval-btn-label-compact">New chat</span>
            </>
          )}
        </button>
      </div>

      {/* Annotation Dialog */}
      {annotatingLine && (
        <div
          className="task-approval-annotation-overlay"
          onClick={() => setAnnotatingLine(null)}
        >
          <div
            className="task-approval-annotation-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="task-approval-annotation-header">
              <span>Line {annotatingLine.lineNumber}</span>
              <button onClick={() => setAnnotatingLine(null)}>
                <X size={18} />
              </button>
            </div>
            <div className="task-approval-annotation-preview">
              {annotatingLine.lineContent.slice(0, 100)}
              {annotatingLine.lineContent.length > 100 && '...'}
            </div>
            <textarea
              ref={noteInputRef}
              className="task-approval-annotation-input"
              placeholder="Add your note..."
              value={noteInput}
              onChange={(e) => setNoteInput(e.target.value)}
              rows={3}
            />
            <div className="task-approval-annotation-actions">
              <button onClick={() => setAnnotatingLine(null)}>Cancel</button>
              <button
                className="primary"
                onClick={handleAddNote}
                disabled={!noteInput.trim()}
              >
                Add Note
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Notes Panel */}
      {showNotesPanel && (
        <div className="task-approval-notes-panel">
          <div className="task-approval-notes-header">
            <span>Notes ({notes.length})</span>
            <button onClick={() => setShowNotesPanel(false)}>
              <ChevronDown size={18} />
            </button>
          </div>
          <div className="task-approval-notes-list">
            {notes.map((note) => (
              <div key={note.id} className="task-approval-note">
                <div className="task-approval-note-header">
                  <button
                    className="task-approval-note-line"
                    onClick={() => handleJumpToLine(note.lineNumber)}
                  >
                    Line {note.lineNumber}
                  </button>
                  <button
                    className="task-approval-note-delete"
                    onClick={() => handleDeleteNote(note.id)}
                  >
                    <Trash2 size={14} />
                  </button>
                </div>
                <div className="task-approval-note-preview">
                  {note.lineContent.slice(0, 60)}
                  {note.lineContent.length > 60 && '...'}
                </div>
                <div className="task-approval-note-text">{note.note}</div>
              </div>
            ))}
          </div>
          <div className="task-approval-notes-actions">
            <button onClick={handleClearAll}>Clear All</button>
            <button className="primary" onClick={handleSendFeedback}>
              <Send size={16} />
              Send All
            </button>
          </div>
        </div>
      )}

      {/* Discard Confirmation */}
      {discardConfirmOpen && (
        <div className="task-approval-confirm-overlay">
          <div
            className="task-approval-confirm-dialog"
            onClick={(e) => e.stopPropagation()}
          >
            <p>
              Discard this task? The agent will be informed the task was
              rejected.
            </p>
            <div className="task-approval-confirm-actions">
              <button onClick={() => setDiscardConfirmOpen(false)}>
                Cancel
              </button>
              <button className="danger" onClick={confirmDiscard}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
