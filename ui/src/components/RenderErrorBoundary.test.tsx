import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { useState } from 'react';
import { RenderErrorBoundary } from './RenderErrorBoundary';

function Boom({ message }: { message: string }): JSX.Element {
  throw new Error(message);
}

function Fine(): JSX.Element {
  return <div>rendered fine</div>;
}

// React logs caught render errors to console.error; silencing keeps the
// expected failures from reading as test noise.
const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
afterEach(() => consoleError.mockClear());

describe('RenderErrorBoundary', () => {
  // The behaviour that matters is what *survives*: React's default for an
  // uncaught render error is to unmount the whole tree, so a sibling still being
  // on screen is the difference between losing one view and losing the session.
  it('keeps the surrounding app mounted when a child throws', () => {
    render(
      <div>
        <span>sibling</span>
        <RenderErrorBoundary label="test" fallback={(e) => <p>failed: {e.message}</p>}>
          <Boom message="layout exploded" />
        </RenderErrorBoundary>
      </div>,
    );

    expect(screen.getByText('sibling')).toBeTruthy();
    expect(screen.getByText('failed: layout exploded')).toBeTruthy();
  });

  it('reports the failure so it is not silently swallowed', () => {
    render(
      <RenderErrorBoundary label="diff viewer" fallback={() => <p>fallback</p>}>
        <Boom message="nope" />
      </RenderErrorBoundary>,
    );

    expect(consoleError.mock.calls.some(
      (args) => typeof args[0] === 'string' && args[0].includes('diff viewer'),
    )).toBe(true);
  });

  // Re-rendering the same failing input would throw again, so the error latches
  // rather than retrying — otherwise the boundary spins instead of settling.
  it('keeps showing the fallback while the failing input is unchanged', () => {
    function Host(): JSX.Element {
      const [, force] = useState(0);
      return (
        <div>
          <button type="button" onClick={() => force((n) => n + 1)}>rerender</button>
          <RenderErrorBoundary label="test" resetKey="same" fallback={() => <p>fallback</p>}>
            <Boom message="still broken" />
          </RenderErrorBoundary>
        </div>
      );
    }
    render(<Host />);
    screen.getByRole('button', { name: 'rerender' }).click();
    expect(screen.getByText('fallback')).toBeTruthy();
  });

  // A new input is a new attempt: the previous failure says nothing about it, so
  // a reviewer who moves to a different file must not inherit a stuck fallback.
  it('retries when the input it failed on is replaced', () => {
    const { rerender } = render(
      <RenderErrorBoundary label="test" resetKey="file-a" fallback={() => <p>fallback</p>}>
        <Boom message="bad file" />
      </RenderErrorBoundary>,
    );
    expect(screen.getByText('fallback')).toBeTruthy();

    rerender(
      <RenderErrorBoundary label="test" resetKey="file-b" fallback={() => <p>fallback</p>}>
        <Fine />
      </RenderErrorBoundary>,
    );
    expect(screen.getByText('rendered fine')).toBeTruthy();
  });
});
