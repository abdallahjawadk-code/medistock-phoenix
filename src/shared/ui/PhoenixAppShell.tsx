import { ReactNode, useCallback, useMemo, useState, useEffect } from 'react';
import { useApp } from '@/app/AppContext';
import { useIsMobileViewport } from '@/shared/ui/useResponsiveViewport';
import { t } from '@/shared/i18n/strings';
import { PhoenixSidebar } from './PhoenixSidebar';
import { PhoenixMobileDrawer } from './PhoenixMobileDrawer';
import { PhoenixTopbar } from './PhoenixTopbar';
import { PhoenixMobileBottomNav } from './PhoenixMobileBottomNav';
import { PwaInstallPrompt } from '@/shared/pwa/PwaInstallPrompt';
import { CommandPalette } from './CommandPalette';
import { PlatformBroadcastGate } from '@/features/platform-broadcast/PlatformBroadcastGate';
import { useGuideHost } from '@/features/guide/GuideHost';
import type { GuideDrawerController } from '@/features/guide/useGuideDrawerStep';

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
  // Screen 22 (Statistics, RAC-3). Without this entry the topbar falls back to
  // nav_decision_reports and rendered «مركز التقارير والمواقف» above the
  // Statistics page — the exact failure recorded for screen 18 above, caught
  // again here by owner review of the RAC-3 preview.
  22: 'rac3_nav',
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
  const isMobile = useIsMobileViewport();
  const closeSidebar = useCallback(() => setSidebarOpen(false), []);
  const openSidebar = useCallback(() => setSidebarOpen(true), []);
  const toggleSidebar = useCallback(() => setSidebarOpen(open => !open), []);

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

  const title = t(SCREEN_TITLE_KEYS[currentScreen] ?? 'nav_decision_reports', lang);

  /* INTERACTIVE-GUIDE-IG1: the shell owns "is the guide open" and hands its
     Help entries one `open` callback. Nothing of the guide engine, its tours
     or its stylesheet is fetched until that callback fires — see GuideHost. */

  /**
   * IG-1.1 — the drawer the shell ALREADY owns, exposed to the guide.
   *
   * Two steps describe things that live inside it: the complete authorized
   * screen list, and the phone's Guide & Help entry. Rather than synthesising
   * a click on the menu button or keeping a second "is the drawer open"
   * boolean, the guide is handed this one — the same `sidebarOpen` state the
   * trigger, the drawer and the topbar's `aria-expanded` already read. There
   * is therefore exactly one source of truth for whether the drawer is open,
   * and `isAvailable` is false on desktop, where no drawer is rendered at all.
   */
  const guideDrawer = useMemo<GuideDrawerController>(() => ({
    isAvailable: isMobile,
    isOpen: sidebarOpen,
    open: openSidebar,
    close: closeSidebar,
  }), [isMobile, sidebarOpen, openSidebar, closeSidebar]);

  const { controller: guide, host: guideHost } = useGuideHost({
    currentScreen,
    onNavigate,
    drawer: guideDrawer,
  });

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
          onClose={closeSidebar}
          onLogout={onLogout}
          onOpenGuide={guide.open}
        />
      )}

      <div className="nexus-app-column" style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <PhoenixTopbar
          title={title}
          isMobile={isMobile}
          menuOpen={sidebarOpen}
          onMenuClick={toggleSidebar}
          onOpenGuide={guide.open}
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
            // bottom padding clears the fixed bottom nav and the device safe
            // area, so the final control of every screen can
            // always be scrolled fully into view.
            minHeight: 0,
            overflowY: 'auto',
            overflowX: 'hidden',
            padding: isMobile
              ? '16px calc(14px + env(safe-area-inset-right, 0px)) 16px calc(14px + env(safe-area-inset-left, 0px))'
              : '24px 28px',
            paddingBottom: isMobile
              ? 'calc(var(--bnh) + 14px + env(safe-area-inset-bottom, 0px))'
              : '28px',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: '1 0 auto', minWidth: 0 }}>{children}</div>
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

      {/* INTERACTIVE-GUIDE-IG1: renders null until the guide is opened. */}
      {guideHost}
    </div>
  );
}
