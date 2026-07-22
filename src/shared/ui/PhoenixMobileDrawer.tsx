import { useApp } from '@/app/AppContext';
import { institutionsScreenAccess } from '@/shared/authz/screen-access';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';
import { PhoenixMark } from './PhoenixMark';

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
  icon: PhoenixIconName;
  labelKey: string;
  frozen?: boolean;
  superAdminOnly?: boolean;
  /** NAV-USERS-PARITY-A: gated by users.view, matching the sidebar and palette. */
  requiresUsersView?: boolean;
  /** PHASE-B-NETWORK-UI-A: super_admin or users.edit_scope. */
  requiresNetwork?: boolean;
}[] = [
  { screen: 11, icon: 'institutions', labelKey: 'nav_institutions' },
  { screen: 12, icon: 'status', labelKey: 'nav_status_center' },
  { screen: 9,  icon: 'reports', labelKey: 'nav_reports', superAdminOnly: true },
  { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
  { screen: 14, icon: 'users', labelKey: 'nav_users', requiresUsersView: true },
  { screen: 17, icon: 'network', labelKey: 'nav_network', requiresNetwork: true },
  { screen: 3,  icon: 'editor', labelKey: 'nav_editor' },
  // OUTLET-CORRIDOR: ungated like nav_editor — the screen self-gates by the
  // profile's 062 outlet assignments; every action is re-checked server-side.
  { screen: 18, icon: 'outlet', labelKey: 'nav_outlet_ops' },
  // INSTITUTION-LOCAL-PROCUREMENT-087: mirrors the desktop sidebar entry so
  // Screen 19 is reachable on mobile too; the screen self-gates by 062
  // warehouse scope + the scoped local_procurement.* keys, re-checked server-side.
  { screen: 19, icon: 'warehouse', labelKey: 'nav_local_procurement' },
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
  const { lang, dir, role, myPermissions } = useApp();
  // NAV-USERS-PARITY-A: identical predicate to CommandPalette.tsx / PhoenixSidebar.tsx.
  const canSeeUsers = role === 'super_admin' || myPermissions.has('users.view');
  // PHASE-B-NETWORK-UI-A: network structure (super_admin) or scope assignment (users.edit_scope).
  const canSeeNetwork = role === 'super_admin' || myPermissions.has('users.edit_scope');

  /* Same state map as PhoenixSidebar, so the drawer and the desktop rail agree
     on what "active" looks like: --chip fill, --cyanDim text, weight 700 and a
     3px ember rail on the inline start. */
  const ns = (n: number) => {
    const active = currentScreen === n;
    return {
      background: active ? 'var(--chip)' : 'transparent',
      color:      active ? 'var(--cyanDim)' : 'var(--muted)',
      fontWeight: active ? 700 : 500,
      borderInlineStart: `3px solid ${active ? 'var(--ember)' : 'transparent'}`,
    };
  };

  return (
    <div
      dir={dir}
      style={{ position: 'fixed', inset: 0, zIndex: 'var(--z-drawer)', display: 'flex' }}
      role="dialog"
      aria-modal="true"
    >
      <div onClick={onClose} className="premium-drawer-backdrop" style={{ position: 'absolute', inset: 0 }} />
      <aside className="premium-sidebar premium-dialog-panel premium-mobile-drawer" style={{
        position: 'relative',
        width: 'min(var(--sw), 88vw)',
        background: 'var(--surface)',
        height: '100%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '14px 8px calc(env(safe-area-inset-bottom, 0px) + 14px)',
        boxShadow: 'var(--sh-xl)',
        animation: `${dir === 'rtl' ? 'si-rtl' : 'si'} .2s ease`,
      }}>
        {/* The close button gets its own row so the brand lockup below keeps the
            full drawer width. Sharing one row with a 44px button left the text
            about 100px wide, which wrapped the title and the department line
            into a five-line stack. */}
        <div style={{ display: 'flex', justifyContent: 'flex-end', paddingInline: '8px' }}>
          <button
            onClick={onClose}
            className="premium-drawer-close premium-focus-ring"
            aria-label={t('close', lang)}
            style={{
              minInlineSize: 'var(--touch-target)', minBlockSize: 'var(--touch-target)',
              flexShrink: 0, borderRadius: 'var(--r2)',
              border: '1px solid var(--line)', background: 'var(--field)', color: 'var(--text)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              cursor: 'pointer', transition: 'all 120ms',
            }}
          >
            <PhoenixIcon name="close" size={18} />
          </button>
        </div>

        <div className="premium-sidebar-brand premium-drawer-brand" style={{ marginBottom: '8px' }}>
          <div className="nexus-brand-lockup">
            <div className="nexus-brand-mark">
              <PhoenixMark size={39} title="" />
            </div>
            <div style={{ minWidth: 0, flex: 1 }}>
              <div className="nexus-brand-title">MediStock-Babil Phoenix</div>
              <div className="nexus-brand-subtitle">{t('shell_brand_department', lang)}</div>
            </div>
          </div>
        </div>

        <nav className="premium-drawer-nav" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '2px', overflowY: 'auto' }} aria-label="Navigation">
          {ALL_NAV
            .filter(item => item.screen !== 11 || institutionsScreenAccess(role) !== false)
            .map(item => item.screen === 11 && institutionsScreenAccess(role) === 'own'
              ? { ...item, labelKey: 'nav_my_organization' } : item)
            .filter(item => !item.superAdminOnly || role === 'super_admin')
            .filter(item => !item.requiresUsersView || canSeeUsers)
            .filter(item => !item.requiresNetwork || canSeeNetwork)
            .map(item => {
            const s = ns(item.screen);
            return (
              <button
                className="premium-nav-item"
                data-active={currentScreen === item.screen}
                key={item.screen}
                onClick={() => { onNavigate(item.screen); onClose(); }}
                aria-current={currentScreen === item.screen ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '0 12px', borderRadius: 'var(--r2)',
                  borderBlock: 'none', borderInlineEnd: 'none', width: '100%', textAlign: 'start',
                  fontSize: '14px',
                  transition: 'background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard)',
                  minHeight: 'var(--touch-target)',
                  opacity: item.frozen ? 0.7 : 1,
                  cursor: 'pointer',
                  ...s,
                }}
              >
                <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={19} /></span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t(item.labelKey, lang)}</span>
              </button>
            );
          })}

          <div style={{ height: '1px', background: 'var(--line)', margin: '10px 4px 6px' }} />

          {SECONDARY_NAV.map(item => {
            const s = ns(item.screen);
            return (
              <button
                className="premium-nav-item"
                data-active={currentScreen === item.screen}
                key={item.screen}
                onClick={() => { onNavigate(item.screen); onClose(); }}
                aria-current={currentScreen === item.screen ? 'page' : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: '12px',
                  padding: '0 12px', borderRadius: 'var(--r2)',
                  borderBlock: 'none', borderInlineEnd: 'none', width: '100%', textAlign: 'start',
                  fontSize: '14px',
                  transition: 'background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard)',
                  minHeight: 'var(--touch-target)',
                  cursor: 'pointer',
                  ...s,
                }}
              >
                <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={19} /></span>
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
            borderRadius: 'var(--r2)', border: '1px solid color-mix(in srgb, var(--danger) 45%, var(--line))',
            background: 'var(--chipD)', color: 'var(--danger)', fontSize: '14px', fontWeight: 700,
            cursor: 'pointer', flexShrink: 0,
          }}
        >
          <PhoenixIcon name="logout" size={18} />
          <span>{t('auth_sign_out', lang)}</span>
        </button>
      </aside>
    </div>
  );
}
