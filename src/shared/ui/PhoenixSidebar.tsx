import { groupPharmaNavigation } from './pharmaNavigationGroups';
import { useState } from 'react';
import '@/shared/lib/pharma-navigation.css';
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
  { screen: 23, icon: 'reports', labelKey: 'cn2b_nav' },
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
  // PDA-PROC-1: the projection additionally admits it for care institutions only.
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
  const { lang, role, profile, myPermissions, activeOrganizationKind } = useApp();
  const [expanded, setExpanded] = useState(false);
  const ri = ROLE_MAP[role] ?? ROLE_MAP.viewer;
  /* R1.1-P (P1): ONE projection, shared with the drawer, the bottom bar and the
     command palette. It replaces the hand-copied users.view / users.edit_scope /
     institutions gates that used to live here — those predicates are reproduced
     exactly inside isScreenAuthorized, so no historical role's menu moves, while
     a facility-scoped role no longer sees a screen the guard would refuse.
     PDA-PROC-1: the active organization kind rides in the same actor, so the
     organization-eligibility answer (Screen 19) is the guard's, not a local one. */
  const primaryItems = projectNavigation(NAV_ITEMS, {
    role, permissions: myPermissions, organizationKind: activeOrganizationKind,
  });
  const secondaryItems = projectNavigation(SECONDARY_ITEMS, {
    role, permissions: myPermissions, organizationKind: activeOrganizationKind,
  });

  const ns = (n: number) => ({ fontWeight: currentScreen === n ? 700 : 500 });

  return (
    <aside className="premium-sidebar" data-pharma-nav="rail" data-prism-expanded={expanded} style={{
      width: 'var(--sw)', flexShrink: 0, background: 'var(--surface)',
      borderInlineEnd: '1px solid var(--line)', display: 'flex', flexDirection: 'column',
      position: 'sticky', top: 0, height: '100dvh', overflowY: 'hidden', zIndex: 'var(--z-sidebar)',
    }}>
      <div className="premium-sidebar-brand pharma-nav__masthead"><div className="nexus-brand-lockup">
            <div className="nexus-brand-mark nexus-brand-mark--phoenix"><PhoenixMark size={40} title="" /></div>
            <div className="pharma-nav__brand-copy">
              <span  className="pharma-nav__sr">MediStock-Babil Phoenix</span>
              <div className="nexus-brand-title" aria-hidden="true"><bdi>MediStock</bdi><small>Babil · Phoenix</small></div>
              <div className="nexus-brand-subtitle">{t('shell_brand_department', lang)}</div>
            </div>
          </div></div>
      <button type="button" className="prism-rail-toggle" onClick={() => setExpanded(value => !value)}
        aria-expanded={expanded} aria-controls="phoenix-desktop-navigation"
        aria-label={lang === 'ar' ? (expanded ? 'طي التنقل' : 'توسيع التنقل') : (expanded ? 'Collapse navigation' : 'Expand navigation')}>
        <PhoenixIcon name="menu" size={20} />
      </button>
      <div className="pharma-nav__workspace"><PhoenixIcon name="medical" size={16} /><span>{lang === 'ar' ? 'مساحة العمل الصيدلانية' : 'Pharmacy workspace'}</span><span className="pharma-nav__workspace-dot" aria-hidden="true" /></div>
      <nav id="phoenix-desktop-navigation" {...guideAnchor(GUIDE_ANCHORS.shellNavigationRail)} className="pharma-nav__body" aria-label={t('shell_primary_nav', lang)}>
        {groupPharmaNavigation(primaryItems, lang).map(group => (
          <section className="pharma-nav__section" key={group.key} aria-labelledby={`pharma-rail-${group.key}`}>
            <h2 id={`pharma-rail-${group.key}`} className="pharma-nav__section-title"><span>{group.label}</span><i aria-hidden="true" /></h2>
            {group.items.map(item => (
              <button type="button" className="premium-nav-item" data-active={currentScreen === item.screen} key={item.screen}
                title={t(item.labelKey, lang)} onClick={() => onNavigate(item.screen)} aria-current={currentScreen === item.screen ? 'page' : undefined} style={ns(item.screen)}>
                <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={19} /></span>
                <span className="pharma-nav__label">{t(item.labelKey, lang)}</span>
                {currentScreen === item.screen && <span className="pharma-nav__current" aria-hidden="true"><PhoenixIcon name="check" size={14} /></span>}
              </button>
            ))}
          </section>
        ))}
        <section className="pharma-nav__section pharma-nav__personal" aria-labelledby="pharma-rail-personal">
          <h2 id="pharma-rail-personal" className="pharma-nav__section-title"><span>{lang === 'ar' ? 'حسابك' : 'Your account'}</span><i aria-hidden="true" /></h2>
          {secondaryItems.map(item => (
            <button type="button" className="premium-nav-item" data-active={currentScreen === item.screen} key={item.screen}
              title={t(item.labelKey, lang)} onClick={() => onNavigate(item.screen)} aria-current={currentScreen === item.screen ? 'page' : undefined} style={ns(item.screen)}>
              <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={19} /></span>
              <span className="pharma-nav__label">{t(item.labelKey, lang)}</span>
              {currentScreen === item.screen && <span className="pharma-nav__current" aria-hidden="true"><PhoenixIcon name="check" size={14} /></span>}
            </button>
          ))}
        </section>
      </nav>
      <div className="premium-sidebar-user pharma-nav__footer">
        <div className="pharma-nav__identity">
          <div className="nexus-role-orb"><PhoenixIcon name={ri.icon} size={18} /></div>
          <div className="pharma-nav__identity-copy"><bdi>{profile?.full_name ?? t(roleLabelKey(role), lang)}</bdi><small>{t(roleLabelKey(role), lang)}</small></div>
        </div>
        <button type="button" onClick={onLogout} title={t('logout', lang)} className="pharma-nav__logout premium-focus-ring"><PhoenixIcon name="logout" size={17} /><span>{t('logout', lang)}</span></button>
      </div>
    </aside>
  );
}
