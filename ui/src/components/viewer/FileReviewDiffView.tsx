/**
 * FileReviewDiffView — one file's review diff, with mark-reviewed controls.
 *
 * This is the DIFF mode of the file viewer: same open file as source mode,
 * different rendering. It reuses the diff CodeView and the diff-anchored
 * review notes so a comment made here carries the same (file, side, line)
 * anchor the whole-branch diff produces.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Loader2, AlertCircle, Keyboard, RefreshCw } from 'lucide-react';
import { ViewerShell } from './ViewerShell';
import { NotesPanel } from './NotesPanel';
import { AnnotationDialog } from './AnnotationDialog';
import { useDiffReviewNotes } from './useDiffReviewNotes';
import type { AnnotateTarget } from './useDiffReviewNotes';
import { PhoenixDiffCodeView } from './PhoenixDiffCodeView';
import type { SectionFileSource } from './pierreDiffMapping';
import { useDiffExpansion } from './useDiffExpansion';
import { openShortcutHelp } from './openShortcutHelp';
import { useReviewKeyboard } from './useReviewKeyboard';
import { useRefreshOnWindowFocus } from './useRefreshOnWindowFocus';
import type { ReviewCommand } from './reviewKeymap';
import { useRegisterFocusScope } from '../../hooks/useFocusScope';
import { useDiffStyle } from './useDiffStyle';
import { DiffStyleToggleButton, ReviewFocusToggleButton } from './DiffHeaderControls';
import { ReviewKeyboardNotice } from './ReviewKeyboardNotice';
import { useReviewDiffScope } from './useReviewDiffScope';
import { api, type FileReviewState, type ReviewFileDiffResponse } from '../../api';
import './FileReviewDiffView.css';

export interface FileReviewDiffViewProps {
  conversationId: string;
  /** Repo-relative path — the identity the review manifest uses. */
  path: string;
  fileName: string;
  absolutePath: string;
  /**
   * Review state from the shared manifest — the single source of truth.
   *
   * The diff response also reports review state, but that snapshot goes stale
   * the moment the user marks the file; reading the manifest instead keeps this
   * header and the sidebar checklist from disagreeing.
   */
  review: FileReviewState;
  /**
   * Blob sha of the file's current working-tree content, from the manifest.
   *
   * A review diff is a function of *two* blobs. The checkpoint side alone
   * cannot report that the rendered diff has gone out of date, because the
   * event that invalidates it — the agent editing the file — moves only this
   * side. Carrying it is what makes the surface follow an agent turn instead of
   * leaving the previous turn's answer on screen under a stale-marked header.
   */
  currentBlobSha: string;
  onClose: () => void;
  onSendNotes: (notes: string) => void;
  /** Switch this file back to source rendering. */
  onShowSource: () => void;
  /**
   * Switch to source rendering with edit mode already armed.
   *
   * Absent when the file is not editable text — a read-only file, an image
   * (deletable but not text-editable), or a file outside a live conversation
   * environment. Absence removes the affordance rather than disabling it.
   */
  onEdit?: (() => void) | undefined;
  onMarkReviewed: (path: string, observedBlobSha: string) => void | Promise<void>;
  onUnmarkReviewed: (path: string) => void | Promise<void>;
  /** Advance to the next file still needing review, when there is one. */
  onNextUnreviewed?: (() => void) | undefined;
  /** Move to the previous / next file in the changed-files list. Absent when
   *  the surface has no list to walk (a lone file opened outside review). */
  onPreviousFile?: (() => void) | undefined;
  onNextFile?: (() => void) | undefined;
  /** Re-read the review manifest; the diff itself is refetched locally. */
  onRefreshManifest?: (() => void) | undefined;
  inline?: boolean | undefined;
  /** Split-pane review focus state; meaningful only with `onToggleReviewFocus`. */
  reviewFocus?: boolean | undefined;
  /** Supplied only by the split-pane host that owns the conversation collapse. */
  onToggleReviewFocus?: (() => void) | undefined;
}

function anchorDialogLabel(target: AnnotateTarget): string {
  if (target.kind === 'file') return target.filePath;
  const line = target.newLine ?? target.oldLine;
  return `${target.filePath}:${line ?? '?'}`;
}

const FILE_REVIEW_SCOPE = 'file-review-diff';

export function FileReviewDiffView({
  conversationId,
  path,
  fileName,
  absolutePath,
  review,
  currentBlobSha,
  onClose,
  onSendNotes,
  onShowSource,
  onEdit,
  onMarkReviewed,
  onUnmarkReviewed,
  onNextUnreviewed,
  onPreviousFile,
  onNextFile,
  onRefreshManifest,
  inline,
  reviewFocus = false,
  onToggleReviewFocus,
}: FileReviewDiffViewProps) {
  useRegisterFocusScope(FILE_REVIEW_SCOPE);
  const notes = useDiffReviewNotes(onSendNotes);
  const { diffStyle, toggleDiffStyle } = useDiffStyle();
  const { diffNotes } = notes;
  const codeViewRef = useRef<React.ComponentRef<typeof PhoenixDiffCodeView>>(null);

  const { scopePreference, toggleScopePreference } = useReviewDiffScope();
  // A file with no checkpoint has no "since review" to show. Deriving the
  // effective scope rather than writing the preference back means such a file
  // renders the full diff without discarding the reviewer's standing choice.
  const hasCheckpoint = review.kind !== 'unreviewed';
  const scope = scopePreference === 'since_review' && hasCheckpoint ? 'since_review' : 'full';
  // The single rendered file's structural item id, published by the wrapper's
  // parse. Reconstructing it from `path` would duplicate the id scheme; a
  // renamed file would then silently miss.
  const [itemId, setItemId] = useState<string | null>(null);
  // Why a keyboard action did nothing. A silently ignored key is
  // indistinguishable from a broken one.
  const [keyboardNotice, setKeyboardNotice] = useState<string | null>(null);
  const [data, setData] = useState<ReviewFileDiffResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Bumping this refetches the diff without changing which file or scope is
  // shown, so an external edit can be pulled in on demand.
  const [reloadToken, setReloadToken] = useState(0);

  // Both sides of the comparison are dependencies: the checkpoint moves when the
  // user marks or unmarks, the current content moves when the agent edits. A
  // diff that watched only one side would keep rendering an answer to the other
  // side's previous value.
  const reviewedBlob = review.kind === 'unreviewed' ? null : review.at_blob;

  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    api
      .getReviewFileDiff(conversationId, path, scope, controller.signal)
      .then((next) => setData(next))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load diff');
      });
    return () => controller.abort();
  }, [conversationId, path, scope, reviewedBlob, currentBlobSha, reloadToken]);

  // A response answers one request. Matching on the path and scope the server
  // echoes back means "the previous scope's diff rendered under the new scope's
  // label" is not a state this component can occupy — a switch shows the loading
  // state until its own answer arrives. A refetch of the *same* request keeps
  // the current content on screen, so pulling in an edit does not flash.
  const shown = data !== null && data.path === path && data.scope === scope ? data : null;

  // Context expansion. The code view publishes which files carry the blob ids
  // needed to fetch their contents, and the fetched contents flow back in.
  const [expandableSources, setExpandableSources] = useState<readonly SectionFileSource[]>([]);
  // A truncated diff is not the whole patch, so a whole-file parse of it would
  // disagree with the file. The wrapper is fed this diff in the committed slot,
  // so that is the section its published sources carry.
  const truncatedSections = useMemo(() => {
    const sections = new Set<SectionFileSource['section']>();
    if (shown?.truncated_kib !== undefined) sections.add('committed');
    return sections;
  }, [shown?.truncated_kib]);
  // The two scopes resolve content by different routes. `full` diffs the merge
  // base against the working tree, whose new side is generally not in the object
  // database and must be hash-verified — the `uncommitted` route.
  // `since_review` diffs two blobs that are both stored, so it is `committed`.
  const expansionRoute = scope === 'since_review' ? 'committed' : 'uncommitted';
  const expansionContents = useDiffExpansion({
    conversationId,
    sources: expandableSources,
    truncatedSections,
    route: expansionRoute,
  });

  const handleMark = useCallback(async () => {
    if (!shown) return;
    await onMarkReviewed(path, shown.current_blob_sha);
    onNextUnreviewed?.();
  }, [shown, onMarkReviewed, path, onNextUnreviewed]);

  const reviewedNow = review.kind === 'reviewed';

  const refresh = useCallback(() => {
    setReloadToken((token) => token + 1);
    onRefreshManifest?.();
  }, [onRefreshManifest]);

  // The user edits these files in another editor; coming back to the tab is the
  // moment the rendered diff is most likely stale.
  useRefreshOnWindowFocus(refresh);

  // Un-marking is a correction, not progress, so only marking advances.
  const toggleReviewed = useCallback(() => {
    if (reviewedNow) {
      void onUnmarkReviewed(path);
      return;
    }
    void handleMark();
  }, [handleMark, onUnmarkReviewed, path, reviewedNow]);

  const runCommand = useCallback(
    (command: ReviewCommand) => {
      const codeView = codeViewRef.current;
      switch (command.kind) {
        case 'scroll-lines':
          codeView?.scrollByLines(command.lines);
          return;
        case 'scroll-page':
          codeView?.scrollPage(command.direction);
          return;
        case 'scroll-edge':
          codeView?.scrollToEdge(command.edge);
          return;
        case 'toggle-reviewed':
          toggleReviewed();
          return;
        case 'next-file':
          onNextFile?.();
          return;
        case 'prev-file':
          onPreviousFile?.();
          return;
        case 'next-unreviewed':
          onNextUnreviewed?.();
          return;
        case 'annotate-file':
          notes.startAnnotateFile('committed', path);
          return;
        case 'annotate-line': {
          if (itemId === null) return;
          const found = codeView?.annotateLineNumber(itemId, command.lineNumber) ?? false;
          setKeyboardNotice(found ? null : `Line ${command.lineNumber} is not in this diff.`);
          return;
        }
        case 'refresh':
          refresh();
          return;
        case 'close':
          onClose();
          return;
        case 'help':
          openShortcutHelp();
          return;
        case 'toggle-review-focus':
          if (!onToggleReviewFocus) {
            console.debug('[review] F pressed with no collapse target on this surface');
            return;
          }
          onToggleReviewFocus();
          return;
        default:
          command satisfies never;
          return;
      }
    },
    [itemId, notes, onClose, onNextFile, onNextUnreviewed, onPreviousFile, onToggleReviewFocus, path, refresh, toggleReviewed],
  );

  useReviewKeyboard({
    scopeId: FILE_REVIEW_SCOPE,
    id: 'file-review-diff',
    onCommand: runCommand,
    dialogOpen: notes.annotating !== null,
  });

  const handleFilesChange = useCallback((files: readonly { itemId: string }[]) => {
    setItemId(files[0]?.itemId ?? null);
  }, []);

  return (
    <ViewerShell
      mode={inline ? 'inline' : 'overlay'}
      ariaLabel={`Review diff: ${fileName}`}
      title={
        <span>
          {fileName} <span className="frd-title-mode">DIFF</span>
        </span>
      }
      titleTooltip={absolutePath}
      banner={keyboardNotice ? <ReviewKeyboardNotice notice={keyboardNotice} /> : undefined}
      headerExtras={
        <>
          <div className="frd-modes" role="group" aria-label="File view mode">
            <button type="button" className="viewer-shell-btn" onClick={onShowSource} title="Show file source">
              FILE
            </button>
            <button type="button" className="viewer-shell-btn frd-mode--active" aria-pressed="true" title="Showing diff">
              DIFF
            </button>
          </div>
          {/* Offered only when there is a checkpoint to diff against — no
              disabled-as-status control. */}
          {hasCheckpoint && (
            <button
              type="button"
              className="viewer-shell-btn"
              onClick={toggleScopePreference}
              title={scope === 'full' ? 'Show only what changed since you reviewed' : 'Show the full diff'}
            >
              {scope === 'full' ? 'Since review' : 'Full diff'}
            </button>
          )}
          {reviewedNow ? (
            <button type="button" className="viewer-shell-btn" onClick={() => void onUnmarkReviewed(path)} title="Unmark this file">
              ✓ Reviewed
            </button>
          ) : (
            <button type="button" className="viewer-shell-btn frd-mark" onClick={() => void handleMark()} title="Mark reviewed and move on">
              Mark reviewed
            </button>
          )}
          {/* Reading a diff and wanting to fix it is one intent; this lands on
              the source editor directly rather than via FILE then Edit mode. */}
          {onEdit && (
            <button type="button" className="viewer-shell-btn" onClick={onEdit} title="Edit this file's source">
              Edit
            </button>
          )}
          <DiffStyleToggleButton diffStyle={diffStyle} onToggle={toggleDiffStyle} />
          <button
            type="button"
            className="viewer-shell-btn"
            onClick={refresh}
            aria-label="Refresh diff from disk"
            title="Refresh from disk (R)"
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="viewer-shell-btn"
            onClick={openShortcutHelp}
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <Keyboard size={16} />
          </button>
          {onToggleReviewFocus && (
            <ReviewFocusToggleButton reviewFocus={reviewFocus} onToggle={onToggleReviewFocus} />
          )}
        </>
      }
      noteCount={diffNotes.length}
      onToggleNotes={notes.togglePanel}
      onSend={notes.send}
      onClose={onClose}
      bodyScroll="children"
      panel={
        notes.showPanel ? (
          <NotesPanel
            notes={diffNotes}
            onRemove={notes.removeNote}
            onClearAll={notes.clearAll}
            onSend={notes.send}
            onClose={notes.closePanel}
          />
        ) : null
      }
      dialog={
        notes.annotating ? (
          <AnnotationDialog
            anchorLabel={anchorDialogLabel(notes.annotating)}
            lineContent={notes.annotating.kind === 'line' ? notes.annotating.lineContent : ''}
            onSubmit={notes.submitNote}
            onCancel={notes.cancelAnnotate}
          />
        ) : null
      }
    >
      <div className="frd-body">
        {review.kind === 'reviewed_stale' && scope === 'full' && (
          <div className="frd-banner">
            Changed since you reviewed it — switch to <strong>Since review</strong> to see only what is new.
          </div>
        )}
        {error ? (
          <div className="viewer-error">
            <AlertCircle size={32} />
            <span>{error}</span>
          </div>
        ) : shown === null ? (
          <div className="viewer-loading">
            <Loader2 size={32} className="spinning" />
            <span>Loading diff…</span>
          </div>
        ) : !shown.diff.trim() ? (
          <div className="diff-viewer-empty">
            {scope === 'since_review'
              ? 'Nothing changed since you reviewed this file.'
              : `No changes vs ${shown.comparator}.`}
          </div>
        ) : (
          <PhoenixDiffCodeView
            // The two scopes are different documents that happen to describe
            // the same path. Pierre's reconciler keys records by file path, so
            // without a remount it treats a scope switch as an update to the
            // record it is already showing and keeps the previous content.
            key={`${path}:${scope}`}
            ref={codeViewRef}
            committedDiff={shown.diff}
            uncommittedDiff=""
            diffStyle={diffStyle}
            notes={diffNotes}
            highlightedNoteId={notes.highlightedNoteId}
            onAnnotateLine={notes.startAnnotateLine}
            onAnnotateFile={notes.startAnnotateFile}
            onFilesChange={handleFilesChange}
            expansionContents={expansionContents}
            onExpandableFilesChange={setExpandableSources}
          />
        )}
      </div>
    </ViewerShell>
  );
}
