/**
 * @vitest-environment jsdom
 *
 * ReportsTabErrorBoundary — genuine component/runtime test. Proves that an
 * unexpected render-time failure inside one report tab produces the
 * localized fallback WITHOUT unmounting sibling/surrounding content, that
 * retry actually clears the caught error, and that a `key` change (the
 * documented reset contract: tab/org change) remounts a fresh, uncrashed
 * subtree.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { useState } from 'react';
import { ReportsTabErrorBoundary } from '../ReportsTabErrorBoundary';

function ThrowingChild({ shouldThrow }: { shouldThrow: boolean }): React.JSX.Element {
  if (shouldThrow) throw new Error('deliberate test failure');
  return <div data-testid="throwing-child-ok">ok</div>;
}

describe('ReportsTabErrorBoundary', () => {
  afterEach(cleanup);

  it('renders the localized fallback instead of crashing when a child throws, WITHOUT unmounting surrounding content', () => {
    // React logs the caught error to console.error by default during
    // development-mode error reporting; suppress just for this assertion so
    // the expected-failure path doesn't pollute test output as if it were
    // an unexpected console error.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <div data-testid="surrounding-shell">
          <div data-testid="nav">Navigation stays mounted</div>
          <ReportsTabErrorBoundary lang="en">
            <ThrowingChild shouldThrow />
          </ReportsTabErrorBoundary>
        </div>,
      );

      // The surrounding shell/navigation must survive — the whole point of
      // R04's boundary is that one tab's crash never blanks the app.
      expect(screen.getByTestId('surrounding-shell')).toBeInTheDocument();
      expect(screen.getByTestId('nav')).toBeInTheDocument();
      expect(screen.getByText('This section could not be displayed')).toBeInTheDocument();
      expect(screen.queryByTestId('throwing-child-ok')).not.toBeInTheDocument();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('logs only a developer-safe message/stack, never the thrown error object or any extra context', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      render(
        <ReportsTabErrorBoundary lang="en">
          <ThrowingChild shouldThrow />
        </ReportsTabErrorBoundary>,
      );
      const boundaryLog = consoleSpy.mock.calls.find(call => call[0] === '[phoenix] report tab crashed:');
      expect(boundaryLog).toBeDefined();
      expect(boundaryLog![1]).toBe('deliberate test failure');
      expect(typeof boundaryLog![2]).toBe('string'); // stack, not the raw Error object
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('retry clears the caught error and re-renders the child when it no longer throws', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    function Harness() {
      const [broken, setBroken] = useState(true);
      return (
        <div>
          <button onClick={() => setBroken(false)}>fix it</button>
          <ReportsTabErrorBoundary lang="en">
            <ThrowingChild shouldThrow={broken} />
          </ReportsTabErrorBoundary>
        </div>
      );
    }
    try {
      render(<Harness />);
      expect(screen.getByText('This section could not be displayed')).toBeInTheDocument();

      // Fix the underlying condition, THEN click Retry — matches the real
      // PhoenixErrorState "Retry" button, which only clears the boundary's
      // own caught-error state; it does not re-run the failed data load.
      fireEvent.click(screen.getByText('fix it'));
      fireEvent.click(screen.getByRole('button', { name: /retry/i }));

      expect(screen.getByTestId('throwing-child-ok')).toBeInTheDocument();
      expect(screen.queryByText('This section could not be displayed')).not.toBeInTheDocument();
    } finally {
      consoleSpy.mockRestore();
    }
  });

  it('a changed `key` (the documented tab/org reset contract) remounts a fresh boundary, clearing any previously caught error', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const { rerender } = render(
        <ReportsTabErrorBoundary key="tab-a:org-1" lang="en">
          <ThrowingChild shouldThrow />
        </ReportsTabErrorBoundary>,
      );
      expect(screen.getByText('This section could not be displayed')).toBeInTheDocument();

      // Simulate switching to a different tab/org: a different `key` forces
      // React to unmount the old boundary instance and mount a brand new
      // one, discarding its caught-error state.
      rerender(
        <ReportsTabErrorBoundary key="tab-b:org-1" lang="en">
          <ThrowingChild shouldThrow={false} />
        </ReportsTabErrorBoundary>,
      );

      expect(screen.getByTestId('throwing-child-ok')).toBeInTheDocument();
      expect(screen.queryByText('This section could not be displayed')).not.toBeInTheDocument();
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
