import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';

// UI-LEGACY-PAGES-NAV-HIDE-A: nav_reg and nav_qr_audit are intentionally NOT
// listed here (hidden from navigation only). Their routes (screens 4, 6 —
// RegistryScreen, QrScreen) remain fully wired in App.tsx; only the drawer
// entry point was removed.
// RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A: nav_editor was previously hidden
// here by mistake and is now restored. The owner only wants the frozen Input
// page (nav_intake, screen 8) hidden, which is why it no longer appears
// below. Its route (screen 8 — IntakeFrozenScreen) remains fully wired in
// App.tsx; only the drawer entry point was removed.
// SUPER-ADMIN-GLOBAL-MATERIAL-SEARCH-NAV-A: ReportsScreen is restored here
// for super_admin only so its responsive global material search is reachable
// on phones as well as desktop. Other roles retain the Phase-2 nav surface.
const ALL_NAV: {
  screen: number;
  icon: string;
  labelKey: string;
  frozen?: boolean;
  superAdminOnly?: boolean;
  /** NAV-USERS-PARITY-A: gated by users.view, matching the sidebar and palette. */
  requiresUsersView?: boolean;
  /** PHASE-B-NETWORK-UI-A: super_admin or users.edit_scope. */
  requiresNetwork?: boolean;
}[] = [
  { screen: 11, icon: '🏛️', labelKey: 'nav_institutions' },
  { screen: 12, icon: '📋', labelKey: 'nav_status_center' },
  { screen: 9,  icon: '📊', labelKey: 'nav_reports', superAdminOnly: true },
  { screen: 13, icon: '🔔', labelKey: 'nav_inter_alerts' },
  { screen: 14, icon: '👥', labelKey: 'nav_users', requiresUsersView: true },
  { screen: 17, icon: '🗺️', labelKey: 'nav_network', requiresNetwork: true },
  { screen: 3,  icon: '✏️', labelKey: 'nav_editor' },
];

// MOBILE-NAV-BRAND-POLISH-A: mirrors PhoenixSidebar's SECONDARY_ITEMS so the
// mobile drawer offers the exact same standalone pages as the desktop
// sidebar (previously only ALL_NAV's 7 items were mirrored — nav_my_account
// was missing from mobile).
const SECONDARY_NAV: { screen: number; icon: string; labelKey: string }[] = [
  { screen: 15, icon: '👤', labelKey: 'nav_my_account' },
];

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onClose: () => void;
  onLogout: () => void;
}

export function PhoenixMobileDrawer({ currentScreen, onNavigate, onClose, onLogout }: Props) {
  const { lang, dir, role, myPermissions } = useApp();
  // NAV-USERS-PARITY-A: identical predicate to CommandPalette.tsx / PhoenixSidebar.tsx.
  const canSeeUsers = role === 'super_admin' || myPermissions.has('users.view');
  // PHASE-B-NETWORK-UI-A: network structure (super_admin) or scope assignment (users.edit_scope).
  const canSeeNetwork = role === 'super_admin' || myPermissions.has('users.edit_scope');

  const ns = (n: number) => ({
    background: currentScreen === n ? 'var(--p2)' : 'transparent',
    color:      currentScreen === n ? 'var(--pd)' : 'var(--t2)',
    fontWeight: currentScreen === n ? '700' : '500',
  });

  return (
    <div
      dir={dir}
      style={{ position: 'fixed', inset: 0, zIndex: 200, display: 'flex' }}
      role="dialog"
      aria-modal="true"
    >
      <div onClick={onClose} className="premium-drawer-backdrop" style={{ position: 'absolute', inset: 0 }} />
      <aside className="premium-sidebar premium-dialog-panel premium-mobile-drawer" style={{
        position: 'relative',
        width: 'min(var(--sw), 88vw)',
        background: 'var(--s)',
        height: '100%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '14px 8px calc(env(safe-area-inset-bottom, 0px) + 14px)',
        boxShadow: 'var(--sh-xl)',
        animation: `${dir === 'rtl' ? 'si-rtl' : 'si'} .2s ease`,
      }}>
        <div className="premium-sidebar-brand premium-drawer-brand" style={{ padding: '10px 10px 14px', borderBottom: '1px solid var(--brd)', marginBottom: '8px', borderRadius: 'var(--r3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="premium-sidebar-logo premium-drawer-logo" style={{ width: '38px', height: '38px', borderRadius: 'var(--r2)', background: 'linear-gradient(145deg, var(--p), var(--pd))', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '19px', color: '#fff', flexShrink: 0 }}>⚕</div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>MediStock-Babil</div>
              <div style={{ fontSize: '10px', color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{t('shell_brand_department', lang)}</div>
            </div>
            <button
              onClick={onClose}
              className="premium-drawer-close premium-focus-ring"
              aria-label={t('close', lang)}
              style={{
                width: '34px', height: '34px', flexShrink: 0, borderRadius: 'var(--r2)',
                border: '1px solid var(--brd)', background: 'var(--s2)', color: 'var(--t2)',
                fontSize: '15px', display: 'flex', alignItems: 'center', justifyContent: 'center',
                cursor: 'pointer', transition: 'all 120ms',
              }}
            >
              ✕
            </button>
          </div>
        </div>

        <nav className="premium-drawer-nav" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto' }} aria-label="Navigation">
          {ALL_NAV
            .filter(item => !item.superAdminOnly || role === 'super_admin')
            .filter(item => !item.requiresUsersView || canSeeUsers)
            .map(item => {
            const s = ns(item.screen);
            return (
              <button
                className="premium-nav-item"
                data-active={currentScreen === item.screen}
                key={item.screen}
                onClick={() => { onNavigate(item.screen); onClose(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '12px 10px', borderRadius: 'var(--r2)',
                  border: 'none', width: '100%', textAlign: 'start',
                  fontSize: '14px', transition: 'all 100ms', minHeight: '44px',
                  opacity: item.frozen ? 0.7 : 1,
                  cursor: 'pointer',
                  ...s,
                }}
              >
                <span style={{ fontSize: '16px', flexShrink: 0 }}>{item.icon}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(item.labelKey, lang)}</span>
              </button>
            );
          })}

          <div style={{ height: '1px', background: 'var(--brd)', margin: '6px 4px' }} />

          {SECONDARY_NAV.map(item => {
            const s = ns(item.screen);
            return (
              <button
                className="premium-nav-item"
                data-active={currentScreen === item.screen}
                key={item.screen}
                onClick={() => { onNavigate(item.screen); onClose(); }}
                style={{
                  display: 'flex', alignItems: 'center', gap: '10px',
                  padding: '12px 10px', borderRadius: 'var(--r2)',
                  border: 'none', width: '100%', textAlign: 'start',
                  fontSize: '14px', transition: 'all 100ms', minHeight: '44px',
                  cursor: 'pointer',
                  ...s,
                }}
              >
                <span style={{ fontSize: '16px', flexShrink: 0 }}>{item.icon}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(item.labelKey, lang)}</span>
              </button>
            );
          })}
        </nav>

        <button
          type="button"
          className="premium-drawer-logout premium-focus-ring"
          onClick={() => { onLogout(); onClose(); }}
          style={{
            display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px',
            width: '100%', minHeight: '44px', marginTop: '8px', padding: '12px 10px',
            borderRadius: 'var(--r2)', border: '1px solid color-mix(in srgb, var(--err) 30%, var(--brd))',
            background: 'var(--err2)', color: 'var(--err)', fontSize: '14px', fontWeight: 700,
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          <span aria-hidden="true">⏻</span>
          <span>{t('auth_sign_out', lang)}</span>
        </button>
      </aside>
    </div>
  );
}
