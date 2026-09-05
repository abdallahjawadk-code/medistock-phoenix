import { useApp } from '@/app/AppContext';
import { projectNavigation } from '@/shared/authz/nav-projection';
import { t } from '@/shared/i18n/strings';
import { roleLabelKey } from '@/shared/lib/roles';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';
import { PhoenixMark } from './PhoenixMark';
import { GUIDE_ANCHORS, guideAnchor } from '@/features/guide/guide.anchors';

interface NavItem {
  screen: number;
  icon: PhoenixIconName;
  labelKey: string;
  frozen?: boolean;
  superAdminOnly?: boolean;
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
// was removed here — App.tsx now redirects screen 2 to the unified shell
// (screen 21, nav_decision_reports below), the real-data landing screen.
// REPORTING-UNIFICATION: this used to be four separate entries — nav_reports
// (screen 9, super_admin only), nav_status_center (screen 12),
// nav_monthly_status (screen 20), and nav_decision_reports (screen 21).
// All four screens' content is now one unified shell reached through this
// single entry; the old screen numbers still work (App.tsx redirects each
// to the matching tab) for anything that still deep-links to them by
// number, but there is exactly one menu entry point.
// R1.1-P (P1): these are CANDIDATES, not the rendered menu. Every entry is
// intersected with isScreenAuthorized through projectNavigation below, so this
// list can never offer a screen the route guard would refuse.
const NAV_ITEMS: NavItem[] = [
  { screen: 22, icon: 'command', labelKey: 'rac3_nav' },
  { screen: 11, icon: 'institutions', labelKey: 'nav_institutions' },
  { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
  { screen: 14, icon: 'users', labelKey: 'nav_users' },
  { screen: 17, icon: 'network', labelKey: 'nav_network' },
  { screen: 3,  icon: 'editor', labelKey: 'nav_editor' },
  // OUTLET-CORRIDOR: ungated like nav_editor — the screen self-gates by the
  // profile's 062 outlet assignments (manageableOutlets), and every action is
  // re-checked server-side. Never gated on a raw role name.
  { screen: 18, icon: 'outlet', labelKey: 'nav_outlet_ops' },
  // INSTITUTION-LOCAL-PROCUREMENT-087: ungated like nav_editor — the screen
  // self-gates by 062 warehouse assignments plus the scoped local_procurement.*
  // keys, and every action is re-checked server-side.
  { screen: 19, icon: 'warehouse', labelKey: 'nav_local_procurement' },
  // DECISION-INTELLIGENCE-REPORTS-119/REPORTING-UNIFICATION: ungated like
  // nav_editor. Screen 21 preserves each tab's original boundary: legacy
  // authenticated reads remain RLS-authoritative, Movements uses
  // status_center.view, Audit uses audit.view, and Global Search is
  // super_admin-only.
  { screen: 21, icon: 'reports', labelKey: 'nav_decision_reports' },
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
  /* R1.1-P (P1): ONE projection, shared with the drawer, the bottom bar and the
     command palette. It replaces the hand-copied users.view / users.edit_scope /
     institutions gates that used to live here — those predicates are reproduced
     exactly inside isScreenAuthorized, so no historical role's menu moves, while
     a facility-scoped role no longer sees a screen the guard would refuse. */
  const primaryItems = projectNavigation(NAV_ITEMS, { role, permissions: myPermissions });
  const secondaryItems = projectNavigation(SECONDARY_ITEMS, { role, permissions: myPermissions });

  /* PHASE-A7-VISUAL-CONVERGENCE: active/inactive fill and colour now live in
     phase-a-visual-convergence.css, keyed off the data-active attribute
     already rendered below (and already read by aria-current for the
     non-visual equivalent). The active state is a solid gold fill — a
     shape+colour change together, so selection never depends on hue alone
     (WCAG 1.4.1). Only weight stays here since nothing else needs to fight
     it via !important. */
  const ns = (n: number) => ({ fontWeight: currentScreen === n ? 700 : 500 });

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
          <div className="nexus-brand-mark nexus-brand-mark--phoenix">
            <PhoenixMark size={40} title="" />
          </div>
          <div style={{ minWidth: 0 }}>
            <div className="nexus-brand-title">MediStock-Babil Phoenix</div>
            <div className="nexus-brand-subtitle">{t('shell_brand_department', lang)}</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav {...guideAnchor(GUIDE_ANCHORS.shellNavigationRail)} style={{ flex: 1, padding: '12px 10px', display: 'flex', flexDirection: 'column', gap: '2px' }} aria-label={t('shell_primary_nav', lang)}>
        {primaryItems.map(item => {
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

        {secondaryItems.map(item => {
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
            {/* R1.1-P (P1-D): the user row is a user-facing surface, so it shows
                the canonical translated role label. It used to print the raw DB
                value, which reads as "health_center_manager" to an operator and
                leaks the authorization identity as if it were a job title.
                roleLabelKey also marks a retained legacy role AS legacy, which a
                raw value silently hid. Authorization identity is unchanged. */}
            <div style={{ fontSize: '11.5px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: 'var(--phoenix-sidebar-text-strong)' }}>{profile?.full_name ?? t(roleLabelKey(role), lang)}</div>
            <div style={{ fontSize: '10px', color: 'var(--phoenix-sidebar-text)' }}>{t(roleLabelKey(role), lang)}</div>
          </div>
          <button
            onClick={onLogout}
            style={{
              padding: '4px 8px', borderRadius: 'var(--r1)',
              border: '1px solid var(--phoenix-sidebar-border)', background: 'transparent',
              color: 'var(--phoenix-sidebar-text)', fontSize: '10.5px', flexShrink: 0,
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
