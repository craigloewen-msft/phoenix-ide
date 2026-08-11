import { render, screen } from '@testing-library/react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { PhoenixDiffCodeView } from './PhoenixDiffCodeView';
import { ReviewNotesProvider } from '../../contexts/ReviewNotesContext';

// Pierre lays a diff out inside a layout effect and throws there when it is
// handed a file it cannot measure. React treats a throw in that phase as fatal
// to the whole tree, so the question this file answers is not "does the diff
// render" but "does the rest of the window survive when it cannot".
vi.mock('@pierre/diffs/react', () => ({
  CodeView: () => {
    throw new Error('iterateOverDiff: trailing context mismatch (additions=16, deletions=15)');
  },
}));

const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => consoleError.mockClear());

const DIFF = [
  'diff --git a/foo.txt b/foo.txt',
  'index aaaaaaa..bbbbbbb 100644',
  '--- a/foo.txt',
  '+++ b/foo.txt',
  '@@ -1,1 +1,1 @@',
  '-hello',
  '+hello world',
].join('\n');

describe('PhoenixDiffCodeView — renderer failure containment', () => {
  it('reports the failing diff instead of taking the session down with it', () => {
    render(
      <ReviewNotesProvider>
        <div>
          <span>conversation still here</span>
          <PhoenixDiffCodeView
            committedDiff={DIFF}
            uncommittedDiff=""
            diffStyle="unified"
            notes={[]}
            highlightedNoteId={null}
            onAnnotateLine={() => undefined}
            onAnnotateFile={() => undefined}
          />
        </div>
      </ReviewNotesProvider>,
    );

    // The surrounding UI is intact — this is what "the whole screen goes blank"
    // looked like before, and the assertion that would have failed.
    expect(screen.getByText('conversation still here')).toBeTruthy();

    // And the failure is stated rather than silently blank.
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain('could not be displayed');
    expect(alert.textContent).toContain('trailing context mismatch');
  });
});
