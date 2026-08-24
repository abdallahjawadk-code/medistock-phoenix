/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MOBILE_VIEWPORT_QUERY, useIsMobileViewport } from '../useResponsiveViewport';

function Probe() {
  const mobile = useIsMobileViewport();
  return <output data-testid="viewport-mode">{mobile ? 'mobile' : 'desktop'}</output>;
}

const originalMatchMedia = window.matchMedia;
const originalInnerWidth = window.innerWidth;

afterEach(() => {
  cleanup();
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: originalMatchMedia,
  });
  Object.defineProperty(window, 'innerWidth', {
    configurable: true,
    writable: true,
    value: originalInnerWidth,
  });
  vi.restoreAllMocks();
});

describe('responsive viewport subscription', () => {
  it('reacts to matchMedia changes without a page reload', () => {
    let matches = false;
    const listeners = new Set<(event: MediaQueryListEvent) => void>();
    const media = {
      get matches() { return matches; },
      media: MOBILE_VIEWPORT_QUERY,
      onchange: null,
      addEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => listeners.add(cb),
      removeEventListener: (_type: string, cb: (event: MediaQueryListEvent) => void) => listeners.delete(cb),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: () => true,
    } as unknown as MediaQueryList;

    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: vi.fn(() => media),
    });

    render(<Probe />);
    expect(screen.getByTestId('viewport-mode')).toHaveTextContent('desktop');

    act(() => {
      matches = true;
      for (const listener of listeners) {
        listener({ matches: true, media: MOBILE_VIEWPORT_QUERY } as MediaQueryListEvent);
      }
    });
    expect(screen.getByTestId('viewport-mode')).toHaveTextContent('mobile');

    act(() => {
      matches = false;
      for (const listener of listeners) {
        listener({ matches: false, media: MOBILE_VIEWPORT_QUERY } as MediaQueryListEvent);
      }
    });
    expect(screen.getByTestId('viewport-mode')).toHaveTextContent('desktop');
  });

  it('falls back to resize events when matchMedia is unavailable', () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      writable: true,
      value: undefined,
    });
    Object.defineProperty(window, 'innerWidth', {
      configurable: true,
      writable: true,
      value: 1024,
    });

    render(<Probe />);
    expect(screen.getByTestId('viewport-mode')).toHaveTextContent('desktop');

    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 390,
      });
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('viewport-mode')).toHaveTextContent('mobile');

    act(() => {
      Object.defineProperty(window, 'innerWidth', {
        configurable: true,
        writable: true,
        value: 844,
      });
      window.dispatchEvent(new Event('resize'));
    });
    expect(screen.getByTestId('viewport-mode')).toHaveTextContent('desktop');
  });
});
