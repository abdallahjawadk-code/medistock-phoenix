import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

// RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A: nav_editor is intentionally
// visible while the frozen intake screen remains hidden from navigation.
const BOTTOM_NAV: { screen: number; icon: PhoenixIconName; labelKey: string }[] = [
  { screen: 12, icon: 'status', labelKey: 'nav_status_center' },
  { screen: 3, icon: 'editor', labelKey: 'nav_editor' },
  { screen: 11, icon: 'institutions', labelKey: 'nav_institutions' },
  { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
];

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
}

export function PhoenixMobileBottomNav({ currentScreen, onNavigate }: Props) {
  const { lang } = useApp();

  const bns = (n: number) => ({
    color: currentScreen === n ? 'var(--p)' : 'var(--t2)',
    fontWeight: currentScreen === n ? '700' : '500',
  });

  return (
    <nav className="premium-topbar" style={{
      position: 'fixed',
      bottom: 0,
      insetInlineStart: 0,
      insetInlineEnd: 0,
      height: 'var(--bnh)',
      background: 'var(--s)',
      borderTop: '1px solid var(--brd)',
      display: 'flex',
      alignItems: 'stretch',
      justifyContent: 'space-evenly',
      paddingInline: 'max(env(safe-area-inset-left, 0px), 4px) max(env(safe-area-inset-right, 0px), 4px)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      zIndex: 70,
      boxShadow: '0 -12px 34px rgba(7,28,52,.10)',
    }} aria-label="Bottom Navigation">
      {BOTTOM_NAV.map(item => {
        const s = bns(item.screen);
        return (
          <button
            key={item.screen}
            onClick={() => onNavigate(item.screen)}
            className="premium-bottom-nav-item"
            data-active={currentScreen === item.screen}
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: '3px',
              border: 'none',
              background: 'transparent',
              padding: '8px 6px',
              transition: 'all 120ms',
              minWidth: '44px', minHeight: '44px',
              cursor: 'pointer',
              ...s,
            }}
            aria-label={t(item.labelKey, lang)}
          >
            <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={20} /></span>
            <span style={{ fontSize: '9.5px', fontWeight: s.fontWeight, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '72px' }}>
              {t(item.labelKey, lang)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
