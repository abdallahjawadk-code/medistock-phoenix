import { useApp } from '@/app/AppContext';
import { projectNavigation } from '@/shared/authz/nav-projection';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';
import { GUIDE_ANCHORS, guideAnchor } from '@/features/guide/guide.anchors';

// RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A: nav_editor is intentionally
// visible while the frozen intake screen remains hidden from navigation.
// REPORTING-UNIFICATION: points at the unified shell (screen 21) directly
// rather than the retired screen 12 — same content either way (12 redirects
// to 21's materials tab), but using 21 here keeps the active-state highlight
// correct for any other in-app navigation that already uses the canonical
// screen number.
const BOTTOM_NAV: { screen: number; icon: PhoenixIconName; labelKey: string }[] = [
  { screen: 22, icon: 'command', labelKey: 'rac3_nav' },
  { screen: 21, icon: 'status', labelKey: 'nav_decision_reports' },
  { screen: 3, icon: 'editor', labelKey: 'nav_editor' },
  { screen: 11, icon: 'institutions', labelKey: 'nav_institutions' },
  { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
];

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
}

export function PhoenixMobileBottomNav({ currentScreen, onNavigate }: Props) {
  const { lang, role, myPermissions } = useApp();
  /**
   * R1.1-P (P1-C): the same projection every other nav surface uses.
   *
   * Unauthorized entries are REMOVED, never re-pointed. Substituting a safe
   * destination behind an unauthorized label would keep advertising a surface
   * this operator cannot occupy, and would land them somewhere the label did
   * not promise — the shortcut bar must not lie about where it goes.
   *
   * This bar is a four-slot shortcut strip, not the full menu, so a narrowed
   * role legitimately sees fewer slots; the drawer still carries everything it
   * may reach. With nothing left to show the bar removes itself rather than
   * reserving empty chrome above the home indicator.
   */
  const visibleItems = projectNavigation(BOTTOM_NAV, { role, permissions: myPermissions });
  if (visibleItems.length === 0) return null;

  const bns = (n: number) => ({
    color: currentScreen === n ? 'var(--phoenix-gold)' : 'var(--muted)',
    fontWeight: currentScreen === n ? '700' : '500',
  });

  return (
    <nav {...guideAnchor(GUIDE_ANCHORS.shellNavigationBottom)} className="premium-bottom-nav" style={{
      position: 'fixed',
      bottom: 0,
      insetInlineStart: 0,
      insetInlineEnd: 0,
      minHeight: 'var(--bnh)',
      background: 'var(--surface)',
      borderTop: '1px solid var(--line)',
      display: 'flex',
      alignItems: 'stretch',
      justifyContent: 'space-evenly',
      // The design source pads the bar itself and folds the safe-area inset
      // into the bottom padding, so the row never sits under the home bar.
      padding: '6px max(env(safe-area-inset-right, 0px), 4px) calc(6px + env(safe-area-inset-bottom, 0px)) max(env(safe-area-inset-left, 0px), 4px)',
      zIndex: 'var(--z-sticky)',
      boxShadow: 'none',
    }} aria-label={t('shell_bottom_nav', lang)}>
      {visibleItems.map(item => {
        const s = bns(item.screen);
        return (
          <button
            key={item.screen}
            onClick={() => onNavigate(item.screen)}
            className="premium-bottom-nav-item"
            data-active={currentScreen === item.screen}
            aria-current={currentScreen === item.screen ? 'page' : undefined}
            style={{
              /* R1.1-P (P1-C): capped at one quarter so a narrowed projection
                 degrades gracefully. With the full four slots this resolves to
                 exactly the previous full-width row; with one or two authorized
                 slots the buttons keep their natural size and centre under
                 space-evenly instead of each stretching to half the screen. */
              flex: '1 1 0',
              maxWidth: '25%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              border: 'none',
              background: 'transparent',
              padding: '6px',
              transition: 'color var(--dur-fast) var(--ease-standard)',
              minWidth: 'var(--touch-target)', minHeight: '52px',
              cursor: 'pointer',
              ...s,
            }}
            aria-label={t(item.labelKey, lang)}
          >
            <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={21} /></span>
            <span style={{ fontSize: '10.5px', fontWeight: s.fontWeight, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '76px' }}>
              {t(item.labelKey, lang)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
