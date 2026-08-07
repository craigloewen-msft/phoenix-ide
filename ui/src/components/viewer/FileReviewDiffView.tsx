/**
 * FileReviewDiffView — one file's review diff, with mark-reviewed controls.
 *
 * This is the DIFF mode of the file viewer: same open file as source mode,
 * different rendering. It reuses the diff CodeView and the diff-anchored
 * review notes so a comment made here carries the same (file, side, line)
 * anchor the whole-branch diff produces.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Loader2, AlertCircle } from 'lucide-react';
import { ViewerShell } from './ViewerShell';
import { NotesPanel } from './NotesPanel';
import { AnnotationDialog } from './AnnotationDialog';
import { useDiffReviewNotes } from './useDiffReviewNotes';
import type { AnnotateTarget } from './useDiffReviewNotes';
import { PhoenixDiffCodeView } from './PhoenixDiffCodeView';
import { useDiffStyle } from './useDiffStyle';
import { DiffStyleToggleButton, ReviewFocusToggleButton } from './DiffHeaderControls';
import { api, type FileReviewState, type ReviewDiffScope, type ReviewFileDiffResponse } from '../../api';
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
  onClose: () => void;
  onSendNotes: (notes: string) => void;
  /** Switch this file back to source rendering. */
  onShowSource: () => void;
  onMarkReviewed: (path: string, observedBlobSha: string) => void | Promise<void>;
  onUnmarkReviewed: (path: string) => void | Promise<void>;
  /** Advance to the next file still needing review, when there is one. */
  onNextUnreviewed?: (() => void) | undefined;
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

export function FileReviewDiffView({
  conversationId,
  path,
  fileName,
  absolutePath,
  review,
  onClose,
  onSendNotes,
  onShowSource,
  onMarkReviewed,
  onUnmarkReviewed,
  onNextUnreviewed,
  inline,
  reviewFocus = false,
  onToggleReviewFocus,
}: FileReviewDiffViewProps) {
  const notes = useDiffReviewNotes(onSendNotes);
  const { diffStyle, toggleDiffStyle } = useDiffStyle();
  const { diffNotes } = notes;
  const codeViewRef = useRef<React.ComponentRef<typeof PhoenixDiffCodeView>>(null);

  const [scope, setScope] = useState<ReviewDiffScope>('full');
  const [data, setData] = useState<ReviewFileDiffResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Refetch when the file's reviewed blob changes: after marking, the
  // since-review diff has a new baseline.
  const reviewedBlob = review.kind === 'unreviewed' ? null : review.at_blob;

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    api
      .getReviewFileDiff(conversationId, path, scope, controller.signal)
      .then((next) => setData(next))
      .catch((err: unknown) => {
        if (controller.signal.aborted) return;
        setError(err instanceof Error ? err.message : 'Failed to load diff');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [conversationId, path, scope, reviewedBlob]);

  // A file with no checkpoint has no "since review" to show; fall back rather
  // than leave the user on a scope the server will reject.
  const hasCheckpoint = review.kind !== 'unreviewed';
  useEffect(() => {
    if (scope === 'since_review' && !hasCheckpoint) setScope('full');
  }, [scope, hasCheckpoint]);

  const handleMark = useCallback(async () => {
    if (!data) return;
    await onMarkReviewed(path, data.current_blob_sha);
    onNextUnreviewed?.();
  }, [data, onMarkReviewed, path, onNextUnreviewed]);

  const reviewedNow = review.kind === 'reviewed';

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
              onClick={() => setScope((s) => (s === 'full' ? 'since_review' : 'full'))}
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
          <DiffStyleToggleButton diffStyle={diffStyle} onToggle={toggleDiffStyle} />
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
        {loading && !data ? (
          <div className="viewer-loading">
            <Loader2 size={32} className="spinning" />
            <span>Loading diff…</span>
          </div>
        ) : error ? (
          <div className="viewer-error">
            <AlertCircle size={32} />
            <span>{error}</span>
          </div>
        ) : !data?.diff.trim() ? (
          <div className="diff-viewer-empty">
            {scope === 'since_review'
              ? 'Nothing changed since you reviewed this file.'
              : `No changes vs ${data?.comparator ?? 'base'}.`}
          </div>
        ) : (
          <PhoenixDiffCodeView
            // The two scopes are different documents that happen to describe
            // the same path. Pierre's reconciler keys records by file path, so
            // without a remount it treats a scope switch as an update to the
            // record it is already showing and keeps the previous content.
            key={`${path}:${scope}`}
            ref={codeViewRef}
            committedDiff={data.diff}
            uncommittedDiff=""
            diffStyle={diffStyle}
            notes={diffNotes}
            highlightedNoteId={notes.highlightedNoteId}
            onAnnotateLine={notes.startAnnotateLine}
            onAnnotateFile={notes.startAnnotateFile}
          />
        )}
      </div>
    </ViewerShell>
  );
}
