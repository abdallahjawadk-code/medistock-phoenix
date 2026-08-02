/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render } from '@testing-library/react';

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({ lang: 'en', dir: 'ltr' }),
}));
vi.mock('@/shared/i18n/strings', () => ({ t: (key: string) => key }));
vi.mock('../PhoenixSidebar', () => ({ PhoenixSidebar: () => <aside data-testid="desktop-sidebar" /> }));
vi.mock('../PhoenixMobileDrawer', () => ({ PhoenixMobileDrawer: () => null }));
vi.mock('../PhoenixTopbar', () => ({ PhoenixTopbar: () => <header data-testid="topbar" /> }));
vi.mock('../PhoenixMobileBottomNav', () => ({
  PhoenixMobileBottomNav: () => <nav data-testid="mobile-bottom-nav" />,
}));
vi.mock('@/shared/pwa/PwaInstallPrompt', () => ({ PwaInstallPrompt: () => null }));
vi.mock('../CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/features/platform-broadcast/PlatformBroadcastGate', () => ({ PlatformBroadcastGate: () => null }));

import { PhoenixAppShell } from '../PhoenixAppShell';
import { PhoenixLoadingState } from '../PhoenixLoadingState';

const removedText = ['MASAR · PH. Abdallahjawadk', '© 2026', 'MASAR copyright'];
const shellCases: Array<[string, number, string]> = [
  ['desktop short operational page', 1440, 'short content'],
  ['desktop long operational page', 1440, 'long content '.repeat(600)],
  ['mobile short operational page', 390, 'short content'],
  ['mobile long operational page', 390, 'long content '.repeat(600)],
];

function setViewport(width: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
}

function expectSealAbsent(container: HTMLElement) {
  for (const text of removedText) expect(container).not.toHaveTextContent(text);
  expect(container.querySelector('.masar-seal')).toBeNull();
  expect(container.querySelector('.nexus-shell__brand')).toBeNull();
  expect(container.querySelector('.nexus-state__brand')).toBeNull();
  expect(container.querySelector('footer')).toBeNull();
}

afterEach(cleanup);

describe('application copyright seal removal', () => {
  it.each(shellCases)('keeps the %s free of the seal and an empty footer', (_label, width, content) => {
    setViewport(width);
    const result = render(
      <PhoenixAppShell currentScreen={3} onNavigate={vi.fn()} onLogout={vi.fn()}>
        <section>{content}</section>
      </PhoenixAppShell>,
    );

    expectSealAbsent(result.container);
    if (width < 768) expect(result.getByTestId('mobile-bottom-nav')).toBeInTheDocument();
    else expect(result.getByTestId('desktop-sidebar')).toBeInTheDocument();
  });

  it('renders full-screen loading with Phoenix loading content only', () => {
    const result = render(<PhoenixLoadingState fullScreen label="Loading" />);
    expect(result.getByRole('status')).toHaveTextContent('Loading');
    expectSealAbsent(result.container);
  });
});
