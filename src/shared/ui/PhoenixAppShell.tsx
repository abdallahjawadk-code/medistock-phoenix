import { ReactNode, useState, useEffect } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixSidebar } from './PhoenixSidebar';
import { PhoenixMobileDrawer } from './PhoenixMobileDrawer';
import { PhoenixTopbar } from './PhoenixTopbar';
import { PhoenixMobileBottomNav } from './PhoenixMobileBottomNav';
import { PwaInstallPrompt } from '@/shared/pwa/PwaInstallPrompt';
import { CommandPalette } from './CommandPalette';
import { MasarCopyrightSeal } from './MasarCopyrightSeal';
import { PlatformBroadcastGate } from '@/features/platform-broadcast/PlatformBroadcastGate';

// PRODUCTION-READINESS-CLEANUP-A: screen 2 (the former central dashboard) no
// longer has an entry — App.tsx redirects it to the unified shell, so the
// fallback below (nav_decision_reports) already covers it correctly.
// REPORTING-UNIFICATION: screens 9, 12, and 20 are retired and now redirect
// to screen 21's unified shell on the matching tab (see AuthenticatedApp.tsx)
// — the topbar title follows, showing the same unified name rather than the
// old per-screen labels, since the content shown is the same shell.
const SCREEN_TITLE_KEYS: Record<number, string> = {
  3: 'nav_editor', 4: 'nav_reg', 5: 'nav_mesh',
  6: 'nav_qr', 7: 'nav_health', 8: 'nav_intake', 9: 'nav_decision_reports', 10: 'nav_mobile',
  11: 'nav_institutions', 12: 'nav_decision_reports', 13: 'nav_inter_alerts',
  14: 'nav_users',
  15: 'nav_my_account',
  16: 'nav_status_editor',
  17: 'nav_network',
  // Screen 18 (Outlet Operations). Without this entry the topbar falls back to
  // nav_decision_reports, so the corridor rendered the wrong title above an
  // Outlet Operations page — caught by the outlet-corridor visual evidence capture.
  18: 'nav_outlet_ops',
  // Screen 19 (Local Procurement, migration 087).
  19: 'nav_local_procurement',
  // Screen 20 (Monthly Status, migration 092) — retired, redirects to screen 21.
  20: 'nav_decision_reports',
  // Screen 21: the unified "مركز التقارير والمواقف" shell.
  21: 'nav_decision_reports',
};

interface Props {
  children: ReactNode;
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onLogout: () => void;
}

export function PhoenixAppShell({ children, currentScreen, onNavigate, onLogout }: Props) {
  const { lang, dir } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // PHARMACY-PULSE-LOADER: pause decorative animations while the page is
  // hidden (background tab) — CSS reads html[data-page-hidden].
  useEffect(() => {
    const onVisibility = () => {
      if (document.hidden) document.documentElement.setAttribute('data-page-hidden', '');
      else document.documentElement.removeAttribute('data-page-hidden');
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      document.documentElement.removeAttribute('data-page-hidden');
    };
  }, []);

  // MOBILE-SCROLL-OWNER-HOTFIX-A: mark the document while the on-screen
  // keyboard is open (visual viewport shrinks well below the layout viewport)
  // so CSS can retreat the floating search control and nothing floats over a
  // focused field. Purely presentational; browsers without visualViewport
  // simply never set the attribute.
  useEffect(() => {
    const viewport = window.visualViewport;
    if (!viewport) return;
    const onViewport = () => {
      const keyboardOpen = viewport.height < window.innerHeight * 0.75;
      if (keyboardOpen) document.documentElement.setAttribute('data-keyboard', 'open');
      else document.documentElement.removeAttribute('data-keyboard');
    };
    viewport.addEventListener('resize', onViewport);
    return () => {
      viewport.removeEventListener('resize', onViewport);
      document.documentElement.removeAttribute('data-keyboard');
    };
  }, []);

  const title = t(SCREEN_TITLE_KEYS[currentScreen] ?? 'nav_decision_reports', lang);

  return (
    <div dir={dir} className="premium-shell nexus-shell" style={{
      display: 'flex',
      flexDirection: 'row',
      minHeight: '100dvh',
      position: 'relative',
    }}>
      {/* A11Y-SHELL-LANDMARKS-A: keyboard-only skip link — first focusable
          element, visually hidden until focused (WCAG 2.4.1). */}
      <a href="#phoenix-main" className="nexus-skip-link">{t('skip_to_content', lang)}</a>

      {!isMobile && (
        <PhoenixSidebar
          currentScreen={currentScreen}
          onNavigate={onNavigate}
          onLogout={onLogout}
        />
      )}

      {isMobile && sidebarOpen && (
        <PhoenixMobileDrawer
          currentScreen={currentScreen}
          onNavigate={onNavigate}
          onClose={() => setSidebarOpen(false)}
          onLogout={onLogout}
        />
      )}

      <div className="nexus-app-column" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <PhoenixTopbar
          title={title}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(s => !s)}
        />

        <main
          id="phoenix-main"
          tabIndex={-1}
          aria-label={t('shell_main_region', lang)}
          className="premium-main"
          style={{
            flex: 1,
            // MOBILE-SCROLL-OWNER-HOTFIX-A: minHeight 0 + the shell's fixed
            // dvh frame make THIS element the single scroll owner. The mobile
            // bottom padding clears the fixed bottom nav, the pinned seal and
            // the device safe area, so the final control of every screen can
            // always be scrolled fully into view.
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: isMobile ? '16px 14px' : '24px 28px',
            paddingBottom: isMobile
              ? 'calc(var(--bnh) + 14px + env(safe-area-inset-bottom, 0px))'
              : '28px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          {/* The page content grows; the footer below it stays in NORMAL flow. */}
          <div style={{ flex: '1 0 auto', minWidth: 0 }}>{children}</div>

          {/* PART 5 choke point: exactly ONE MASAR copyright seal per
              operational route, inherited by every screen — a REAL footer in
              normal document flow at the END of the scrollable content. On a
              short page the flex column pushes it to the bottom of the
              scroller; on a long page it appears only when the operator
              reaches the end. It never floats, never covers a card/button or
              the bottom navigation, and scrolls WITH the page. */}
          <footer className="nexus-shell__brand" aria-label={lang === 'ar' ? 'حقوق النشر' : 'Copyright'}>
            <MasarCopyrightSeal variant={isMobile ? 'minimal' : 'compact'} />
          </footer>
        </main>
      </div>

      {isMobile && (
        <PhoenixMobileBottomNav
          currentScreen={currentScreen}
          onNavigate={onNavigate}
        />
      )}

      <PwaInstallPrompt isMobile={isMobile} />

      {/* UX-COMMAND-CENTER-SMART-A: global Ctrl+K/Cmd+K command palette —
          navigates via the same onNavigate screen-switch already passed
          down; no new routes, no new backend reads. */}
      <CommandPalette onNavigate={onNavigate} />

      {/* PHASE3-PLATFORM-BROADCAST-NOTICES-A: institution-level broadcast
          popup. Self-gates on authReady/session/profile/activeOrgId and
          renders null until a pending broadcast exists — safe to always
          mount here alongside the other always-present overlays above. */}
      <PlatformBroadcastGate />
    </div>
  );
}
