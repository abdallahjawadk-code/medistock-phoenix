import { groupPharmaNavigation } from './pharmaNavigationGroups';
import { roleLabelKey } from '@/shared/lib/roles';
import '@/shared/lib/pharma-navigation.css';
import { useEffect, useRef } from 'react';
import { useApp } from '@/app/AppContext';
import { projectNavigation } from '@/shared/authz/nav-projection';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';
import { PhoenixMark } from './PhoenixMark';
import { GUIDE_ANCHORS, guideAnchor } from '@/features/guide/guide.anchors';

// UI-LEGACY-PAGES-NAV-HIDE-A: nav_reg and nav_qr_audit are intentionally NOT
// listed here (hidden from navigation only). Their routes (screens 4, 6 —
// RegistryScreen, QrScreen) remain fully wired in App.tsx; only the drawer
// entry point was removed.
// RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A: nav_editor was previously hidden
// here by mistake and is now restored. The owner only wants the frozen Input
// page (nav_intake, screen 8) hidden, which is why it no longer appears
// below. Its route (screen 8 — IntakeFrozenScreen) remains fully wired in
// App.tsx; only the drawer entry point was removed.
// REPORTING-UNIFICATION: mirrors the desktop sidebar's single entry — the
// former nav_reports (screen 9, super_admin only)/nav_status_center (screen
// 12)/nav_monthly_status (screen 20)/nav_decision_reports (screen 21) are
// now one entry. Screen 21 preserves per-tab parity: legacy authenticated
// reads remain RLS-authoritative, while Movements, Audit, and Global Search
// retain their explicit permission/role gates.
// R1.1-P (P1): CANDIDATES only — projectNavigation intersects them with
// isScreenAuthorized so this surface agrees with the sidebar, the bottom bar,
// the palette and the route guard by construction.
const ALL_NAV: {
  screen: number;
  icon: PhoenixIconName;
  labelKey: string;
  frozen?: boolean;
  superAdminOnly?: boolean;
}[] = [
  { screen: 22, icon: 'command', labelKey: 'rac3_nav' },
  { screen: 23, icon: 'reports', labelKey: 'cn2b_nav' },
  { screen: 11, icon: 'institutions', labelKey: 'nav_institutions' },
  { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
  { screen: 14, icon: 'users', labelKey: 'nav_users' },
  { screen: 17, icon: 'network', labelKey: 'nav_network' },
  { screen: 3,  icon: 'editor', labelKey: 'nav_editor' },
  // OUTLET-CORRIDOR: ungated like nav_editor — the screen self-gates by the
  // profile's 062 outlet assignments; every action is re-checked server-side.
  { screen: 18, icon: 'outlet', labelKey: 'nav_outlet_ops' },
  // INSTITUTION-LOCAL-PROCUREMENT-087: mirrors the desktop sidebar entry so
  // Screen 19 is reachable on mobile too; the screen self-gates by 062
  // warehouse scope + the scoped local_procurement.* keys, re-checked server-side.
  // PDA-PROC-1: the projection additionally admits it for care institutions only.
  { screen: 19, icon: 'warehouse', labelKey: 'nav_local_procurement' },
  { screen: 21, icon: 'reports', labelKey: 'nav_decision_reports' },
];

// MOBILE-NAV-BRAND-POLISH-A: mirrors PhoenixSidebar's SECONDARY_ITEMS so the
// mobile drawer offers the exact same standalone pages as the desktop
// sidebar (previously only ALL_NAV's 7 items were mirrored — nav_my_account
// was missing from mobile).
const SECONDARY_NAV: { screen: number; icon: PhoenixIconName; labelKey: string }[] = [
  { screen: 15, icon: 'account', labelKey: 'nav_my_account' },
];

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onClose: () => void;
  onLogout: () => void;
}

export function PhoenixMobileDrawer({ currentScreen, onNavigate, onClose, onLogout }: Props) {
  const { lang, dir, role, profile, myPermissions, activeOrganizationKind } = useApp();
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previouslyFocused = useRef<HTMLElement | null>(null);
  // R1.1-P (P1): the same projection the desktop rail uses — see nav-projection.ts.
  // PDA-PROC-1: including the same active organization kind.
  const primaryItems = projectNavigation(ALL_NAV, {
    role, permissions: myPermissions, organizationKind: activeOrganizationKind,
  });
  const secondaryItems = projectNavigation(SECONDARY_NAV, {
    role, permissions: myPermissions, organizationKind: activeOrganizationKind,
  });

  const ns = (n: number) => ({ fontWeight: currentScreen === n ? 700 : 500 });

  useEffect(() => {
    const overlay = overlayRef.current;
    const panel = panelRef.current;
    if (!overlay || !panel) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;

    // Make every shell sibling genuinely non-interactive while the modal
    // drawer is open; restore pre-existing accessibility state on close.
    const background = Array.from(overlay.parentElement?.children ?? [])
      .filter((node): node is HTMLElement => node instanceof HTMLElement && node !== overlay);
    const previous = background.map(node => ({
      node,
      inert: node.hasAttribute('inert'),
      ariaHidden: node.getAttribute('aria-hidden'),
    }));
    for (const { node } of previous) {
      node.setAttribute('inert', '');
      node.setAttribute('aria-hidden', 'true');
    }

    const focusables = () => Array.from(panel.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    ));
    (focusables()[0] ?? panel).focus();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !panel.contains(active))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (active === last || !panel.contains(active))) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      for (const item of previous) {
        if (!item.inert) item.node.removeAttribute('inert');
        if (item.ariaHidden === null) item.node.removeAttribute('aria-hidden');
        else item.node.setAttribute('aria-hidden', item.ariaHidden);
      }
      previouslyFocused.current?.focus?.();
    };
  }, [onClose]);

  return (
    <div ref={overlayRef} id="phoenix-mobile-drawer" data-pharma-navigation="open" dir={dir}
      style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-drawer)', display: 'flex' }}
      role="dialog" aria-modal="true" aria-labelledby="phoenix-mobile-drawer-title">
      <div aria-hidden="true" onClick={onClose} className="premium-drawer-backdrop" style={{ position: 'absolute', inset: 0 }} />
      <aside ref={panelRef} tabIndex={-1} className="premium-sidebar premium-dialog-panel premium-mobile-drawer" data-pharma-nav="drawer" style={{
        position: 'relative', width: 'min(var(--sw), 88vw)', background: 'var(--surface)',
        height: '100dvh', maxHeight: '100dvh', overflowY: 'hidden', overscrollBehavior: 'contain',
        display: 'flex', flexDirection: 'column', gap: '2px',
        padding: 'calc(env(safe-area-inset-top, 0px) + 10px) calc(env(safe-area-inset-right, 0px) + 8px) calc(env(safe-area-inset-bottom, 0px) + 14px) calc(env(safe-area-inset-left, 0px) + 8px)',
        boxShadow: 'var(--sh-xl)',
        animation: `${dir === 'rtl' ? 'si-rtl' : 'si'} .2s ease`,
      }}>
        <header className="pharma-nav__masthead">
          <button type="button" onClick={onClose} className="premium-drawer-close premium-focus-ring" style={{ minInlineSize: 'var(--touch-target)', minBlockSize: 'var(--touch-target)' }} aria-label={t('close', lang)}><PhoenixIcon name="close" size={20} /></button>
          <div className="premium-sidebar-brand premium-drawer-brand"><div className="nexus-brand-lockup">
            <div className="nexus-brand-mark nexus-brand-mark--phoenix"><PhoenixMark size={44} title="" /></div>
            <div className="pharma-nav__brand-copy">
              <span id="phoenix-mobile-drawer-title" className="pharma-nav__sr">MediStock-Babil Phoenix</span>
              <div className="nexus-brand-title" aria-hidden="true"><bdi>MediStock</bdi><small>Babil · Phoenix</small></div>
              <div className="nexus-brand-subtitle">{t('shell_brand_department', lang)}</div>
            </div>
          </div></div>
        </header>
        <div className="pharma-nav__workspace"><PhoenixIcon name="medical" size={16} /><span>{lang === 'ar' ? 'مساحة العمل الصيدلانية' : 'Pharmacy workspace'}</span><span className="pharma-nav__workspace-dot" aria-hidden="true" /></div>
        <nav {...guideAnchor(GUIDE_ANCHORS.shellNavigationDrawer)} className="premium-drawer-nav" style={{ flex: 1, minHeight: 0, overflowY: 'auto' }} aria-label={t('shell_primary_nav', lang)}>
          {groupPharmaNavigation(primaryItems, lang).map(group => (
          <section className="pharma-nav__section" key={group.key} aria-labelledby={`pharma-drawer-${group.key}`}>
            <h2 id={`pharma-drawer-${group.key}`} className="pharma-nav__section-title"><span>{group.label}</span><i aria-hidden="true" /></h2>
            {group.items.map(item => (
              <button type="button" className="premium-nav-item" data-active={currentScreen === item.screen} key={item.screen}
                onClick={() => { onNavigate(item.screen); onClose(); }} aria-current={currentScreen === item.screen ? 'page' : undefined} style={{ ...ns(item.screen), minHeight: '44px', textAlign: 'start' }}>
                <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={19} /></span>
                <span className="pharma-nav__label">{t(item.labelKey, lang)}</span>
                {currentScreen === item.screen && <span className="pharma-nav__current" aria-hidden="true"><PhoenixIcon name="check" size={14} /></span>}
              </button>
            ))}
          </section>
        ))}
        <section className="pharma-nav__section pharma-nav__personal" aria-labelledby="pharma-drawer-personal">
          <h2 id="pharma-drawer-personal" className="pharma-nav__section-title"><span>{lang === 'ar' ? 'حسابك' : 'Your account'}</span><i aria-hidden="true" /></h2>
          {secondaryItems.map(item => (
            <button type="button" className="premium-nav-item" data-active={currentScreen === item.screen} key={item.screen}
              onClick={() => { onNavigate(item.screen); onClose(); }} aria-current={currentScreen === item.screen ? 'page' : undefined} style={{ ...ns(item.screen), minHeight: '44px', textAlign: 'start' }}>
              <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={19} /></span>
              <span className="pharma-nav__label">{t(item.labelKey, lang)}</span>
              {currentScreen === item.screen && <span className="pharma-nav__current" aria-hidden="true"><PhoenixIcon name="check" size={14} /></span>}
            </button>
          ))}
        </section>
        </nav>
        <div className="pharma-nav__footer">
          <div className="pharma-nav__identity">
            <div className="nexus-role-orb"><PhoenixIcon name="account" size={18} /></div>
            <div className="pharma-nav__identity-copy"><bdi>{profile?.full_name ?? t(roleLabelKey(role), lang)}</bdi><small>{t(roleLabelKey(role), lang)}</small></div>
          </div>
          <button type="button" className="premium-drawer-logout pharma-nav__logout premium-focus-ring" style={{ minHeight: '44px' }} onClick={() => { onLogout(); onClose(); }}><PhoenixIcon name="logout" size={17} /><span>{t('auth_sign_out', lang)}</span></button>
        </div>
      </aside>
    </div>
  );
}
