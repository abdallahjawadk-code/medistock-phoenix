import { useApp } from '@/app/AppContext';
import { institutionsScreenAccess } from '@/shared/authz/screen-access';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';
import { PhoenixMark } from './PhoenixMark';

interface NavItem {
  screen: number;
  icon: PhoenixIconName;
  labelKey: string;
  frozen?: boolean;
  superAdminOnly?: boolean;
  /** NAV-USERS-PARITY-A: shown only to super_admin or holders of users.view,
   *  matching the CommandPalette gate so every nav surface agrees. */
  requiresUsersView?: boolean;
  /** PHASE-B-NETWORK-UI-A: super_admin (structure) or users.edit_scope (scope tab). */
  requiresNetwork?: boolean;
  /** ROLE-REORG-§5: screen 11 — platform admin (directory) or institution
   *  admin ("My Organization"); hidden for everyone else. */
  institutionsGate?: boolean;
}

// UI-LEGACY-PAGES-NAV-HIDE-A: nav_status_editor, nav_reg, and nav_qr_audit are
// intentionally NOT listed here (hidden from navigation only). Their routes
// (screens 16, 4, 6 — StatusEditorScreen, RegistryScreen, QrScreen) remain
// fully wired in App.tsx; only the sidebar entry point was removed.
// RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A: nav_editor was previously hidden
// here by mistake (AVAILABILITY-EDITOR-NAV-HIDE-A intended to hide nav_intake,
// not nav_editor) and is now restored. The owner only wants the frozen Input
// page (nav_intake, screen 8) hidden — see SECONDARY_ITEMS below, which no
// longer lists it. Its route (screen 8 — IntakeFrozenScreen) remains fully
// wired in App.tsx; only the sidebar entry point was removed.
// PRODUCTION-READINESS-CLEANUP-A: nav_dash (screen 2, the central dashboard)
// was removed here — App.tsx now redirects screen 2 to Status Center
// (screen 12, nav_status_center below), the real-data landing screen.
// SUPER-ADMIN-GLOBAL-MATERIAL-SEARCH-NAV-A: ReportsScreen remains available
// at screen 9, and its global material search is a super_admin-only feature.
// Restore the sidebar entry for super_admin only; other roles retain the
// Phase-2 navigation surface and Audit Log remains in Status Center.
const NAV_ITEMS: NavItem[] = [
  { screen: 11, icon: 'institutions', labelKey: 'nav_institutions', institutionsGate: true },
  { screen: 12, icon: 'status', labelKey: 'nav_status_center' },
  { screen: 9,  icon: 'reports', labelKey: 'nav_reports', superAdminOnly: true },
  { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
  { screen: 14, icon: 'users', labelKey: 'nav_users', requiresUsersView: true },
  { screen: 17, icon: 'network', labelKey: 'nav_network', requiresNetwork: true },
  { screen: 3,  icon: 'editor', labelKey: 'nav_editor' },
  // OUTLET-CORRIDOR: ungated like nav_editor — the screen self-gates by the
  // profile's 062 outlet assignments (manageableOutlets), and every action is
  // re-checked server-side. Never gated on a raw role name.
  { screen: 18, icon: 'outlet', labelKey: 'nav_outlet_ops' },
  // INSTITUTION-LOCAL-PROCUREMENT-087: ungated like nav_editor — the screen
  // self-gates by 062 warehouse assignments plus the scoped local_procurement.*
  // keys, and every action is re-checked server-side.
  { screen: 19, icon: 'warehouse', labelKey: 'nav_local_procurement' },
];

const SECONDARY_ITEMS: NavItem[] = [
  { screen: 15, icon: 'account', labelKey: 'nav_my_account' },
];

const ROLE_MAP: Record<string, { icon: PhoenixIconName }> = {
  super_admin:       { icon: 'role' },
  hospital_admin:    { icon: 'institutions' },
  warehouse_manager: { icon: 'warehouse' },
  point_operator:    { icon: 'outlet' },
  viewer:            { icon: 'account' },
};

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onLogout: () => void;
}

export function PhoenixSidebar({ currentScreen, onNavigate, onLogout }: Props) {
  const { lang, role, profile, myPermissions } = useApp();
  const ri = ROLE_MAP[role] ?? ROLE_MAP.viewer;
  // NAV-USERS-PARITY-A: identical predicate to CommandPalette.tsx.
  const canSeeUsers = role === 'super_admin' || myPermissions.has('users.view');
  // PHASE-B-NETWORK-UI-A: network structure (super_admin) or scope assignment (users.edit_scope).
  const canSeeNetwork = role === 'super_admin' || myPermissions.has('users.edit_scope');
  // ROLE-REORG-§5: institutions management is platform-admin only; an
  // institution admin sees the same entry relabelled "My Organization".
  const instAccess = institutionsScreenAccess(role);

  /* Nav item states, transcribed from the design source's mkNav():
     active   → --chip fill, --cyanDim text, weight 700, 3px ember rail
     inactive → no fill,     --muted text,   weight 500, transparent rail
     The rail is what makes the active item read by SHAPE as well as by colour
     and weight, so selection never depends on hue alone (WCAG 1.4.1). It pairs
     with aria-current="page" below for the non-visual equivalent. */
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
    <aside className="premium-sidebar" style={{
      width: 'var(--sw)',
      flexShrink: 0,
      background: 'var(--surface)',
      borderInlineEnd: '1px solid var(--line)',
      display: 'flex',
      flexDirection: 'column',
      position: 'sticky',
      top: 0,
      height: '100dvh',
      overflowY: 'auto',
      zIndex: 'var(--z-sidebar)',
    }}>
      {/* Brand */}
      <div className="premium-sidebar-brand">
        <div className="nexus-brand-lockup">
          <div className="nexus-brand-mark">
            <PhoenixMark size={39} title="" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="nexus-brand-title">MediStock-Babil Phoenix</div>
            <div className="nexus-brand-subtitle">{t('shell_brand_department', lang)}</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '2px' }} aria-label={t('shell_primary_nav', lang)}>
        {NAV_ITEMS
          .filter(item => !item.superAdminOnly || role === 'super_admin')
          .filter(item => !item.requiresUsersView || canSeeUsers)
          .filter(item => !item.requiresNetwork || canSeeNetwork)
          .filter(item => !item.institutionsGate || instAccess !== false)
          .map(item => item.institutionsGate && instAccess === 'own'
            ? { ...item, labelKey: 'nav_my_organization' } : item)
          .map(item => {
          const s = ns(item.screen);
          return (
            <button
              className="premium-nav-item"
              data-active={currentScreen === item.screen}
              key={item.screen}
              onClick={() => onNavigate(item.screen)}
              aria-current={currentScreen === item.screen ? 'page' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                minHeight: 'var(--touch-target)', padding: '0 12px',
                borderRadius: 'var(--r2)', borderBlock: 'none', borderInlineEnd: 'none',
                width: '100%', textAlign: 'start',
                transition: 'background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard)',
                fontSize: '13.5px',
                ...s,
              }}
            >
              <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={19} /></span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t(item.labelKey, lang)}
              </span>
            </button>
          );
        })}

        <div style={{ height: '1px', background: 'var(--line)', margin: '10px 4px 6px' }} />

        {SECONDARY_ITEMS.map(item => {
          const s = ns(item.screen);
          return (
            <button
              className="premium-nav-item"
              data-active={currentScreen === item.screen}
              key={item.screen}
              onClick={() => onNavigate(item.screen)}
              aria-current={currentScreen === item.screen ? 'page' : undefined}
              style={{
                display: 'flex', alignItems: 'center', gap: '12px',
                minHeight: 'var(--touch-target)', padding: '0 12px',
                borderRadius: 'var(--r2)', borderBlock: 'none', borderInlineEnd: 'none',
                width: '100%', textAlign: 'start',
                transition: 'background-color var(--dur-fast) var(--ease-standard), color var(--dur-fast) var(--ease-standard)',
                fontSize: '13.5px',
                opacity: item.frozen ? 0.7 : 1,
                ...s,
              }}
            >
              <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={19} /></span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {t(item.labelKey, lang)}
              </span>
              {item.frozen && (
                <span style={{
                  padding: '2px 6px', borderRadius: 'var(--rpill)',
                  background: 'var(--chipW)', color: 'var(--warn)',
                  border: '1px solid color-mix(in srgb, var(--warn) 40%, transparent)',
                  fontSize: '9px', fontWeight: 700, flexShrink: 0,
                }}>
                  {t('frozen', lang)}
                </span>
              )}
            </button>
          );
        })}
      </nav>

      {/* User row */}
      <div className="premium-sidebar-user" style={{ padding: '12px 14px' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div className="nexus-role-orb">
            <PhoenixIcon name={ri.icon} size={17} />
          </div>
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{profile?.full_name ?? role}</div>
            <div style={{ fontSize: '10px', color: 'var(--t2)' }}>{role}</div>
          </div>
          <button
            onClick={onLogout}
            style={{
              padding: '4px 8px', borderRadius: 'var(--r1)',
              border: '1px solid var(--brd)', background: 'transparent',
              color: 'var(--t2)', fontSize: '10.5px', flexShrink: 0,
              cursor: 'pointer', transition: 'all 120ms',
              // Sign-out is a real touch target on tablet, where the sidebar is
              // rendered but the pointer is a finger. It measured 86×26.
              minHeight: '44px', minWidth: '44px',
            }}
          >
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: '5px' }}>
              <PhoenixIcon name="logout" size={13} />
              {t('logout', lang)}
            </span>
          </button>
        </div>
      </div>
    </aside>
  );
}
