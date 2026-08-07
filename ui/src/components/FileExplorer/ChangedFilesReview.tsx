/**
 * ChangedFilesReview — the review checklist in the grounding sidebar.
 *
 * One row per changed file: state, magnitude, and path in a single glance.
 * Clicking a row opens that file in the viewer's DIFF mode.
 */

import type { ReviewFileEntry } from '../../api';
import { GroundingState } from '../GroundingPanel';
import type { UseReviewManifest } from '../../hooks/useReviewManifest';
import './ChangedFilesReview.css';

interface Props {
  review: UseReviewManifest;
  activePath: string | null;
  onOpenDiff: (path: string) => void;
  onCompleteReview: () => void;
}

/** Repo-relative path shortened to its filename plus one parent for context. */
function shortPath(path: string): string {
  const parts = path.split('/');
  return parts.length <= 2 ? path : `…/${parts.slice(-2).join('/')}`;
}

function ReviewMarker({ entry }: { entry: ReviewFileEntry }) {
  switch (entry.review.kind) {
    case 'reviewed':
      return <span className="cfr-marker cfr-marker--reviewed" title="Reviewed">✓</span>;
    case 'reviewed_stale':
      return (
        <span className="cfr-marker cfr-marker--stale" title="Changed since you reviewed it">
          +
        </span>
      );
    default:
      return <span className="cfr-marker cfr-marker--unreviewed" title="Not reviewed" />;
  }
}

export function ChangedFilesReview({ review, activePath, onOpenDiff, onCompleteReview }: Props) {
  const { manifest, loading, error, complete } = review;

  if (error) return <GroundingState tone="error">{error}</GroundingState>;
  if (!manifest && loading) return <GroundingState tone="loading">Loading changed files…</GroundingState>;
  if (!manifest) return null;
  if (manifest.total_count === 0) {
    return <GroundingState>No changes against {manifest.comparator} yet.</GroundingState>;
  }

  return (
    <div className="cfr" aria-label="Changed files for review">
      <div className="cfr-head">
        <span className="cfr-progress">
          {manifest.reviewed_count}/{manifest.total_count} reviewed
        </span>
        <span className="cfr-comparator" title={`Diffing against ${manifest.comparator}`}>
          vs {manifest.comparator}
        </span>
      </div>

      <ul className="cfr-list">
        {manifest.files.map((entry) => (
          <li key={entry.path}>
            <button
              type="button"
              className={`cfr-row${entry.path === activePath ? ' cfr-row--active' : ''}`}
              onClick={() => onOpenDiff(entry.path)}
              title={`${entry.path} (${entry.status})`}
            >
              <ReviewMarker entry={entry} />
              <span className="cfr-path">{shortPath(entry.path)}</span>
              <span className="cfr-counts">
                {entry.insertions > 0 && <span className="cfr-ins">+{entry.insertions}</span>}
                {entry.deletions > 0 && <span className="cfr-del">-{entry.deletions}</span>}
              </span>
            </button>
          </li>
        ))}
      </ul>

      {/* Recording the pass, not gating the merge — the work actions bar keeps
          its own primary action. */}
      {complete && (
        <button type="button" className="cfr-complete" onClick={onCompleteReview}>
          Complete review
        </button>
      )}
    </div>
  );
}
