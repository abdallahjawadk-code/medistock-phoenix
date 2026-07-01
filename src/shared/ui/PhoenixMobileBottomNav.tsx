import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';

// RESTORE-AVAILABILITY-EDITOR-HIDE-INTAKE-A: nav_editor was previously hidden
// here by mistake and is now restored. nav_intake was never part of the
// bottom nav, so there is nothing to hide here for that page.
const BOTTOM_NAV = [
  { screen: 2, icon: '📊', labelKey: 'nav_dash' },
  { screen: 3, icon: '✏️', labelKey: 'nav_editor' },
  { screen: 11, icon: '🏛️', labelKey: 'nav_institutions' },
  { screen: 13, icon: '🔔', labelKey: 'nav_inter_alerts' },
];

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
}

// MOBILE-NAV-BRAND-POLISH-A: the hamburger/"More" (previously the localized
// 'more' string key) item was removed from the bottom nav — drawer access is
// preserved via the icon-only menu button already in PhoenixTopbar (no text
// label, same setSidebarOpen toggle), so no page/feature access was lost.
export function PhoenixMobileBottomNav({ currentScreen, onNavigate }: Props) {
  const { lang } = useApp();

  const bns = (n: number) => ({
    color:      currentScreen === n ? 'var(--p)' : 'var(--t2)',
    fontWeight: currentScreen === n ? '700' : '500',
  });

  return (
    <nav className="premium-topbar" style={{
      position: 'fixed', bottom: 0,
      insetInlineStart: 0, insetInlineEnd: 0,
      height: 'var(--bnh)',
      background: 'var(--s)',
      borderTop: '1px solid var(--brd)',
      display: 'flex',
      alignItems: 'stretch',
      justifyContent: 'space-evenly',
      paddingInline: 'max(env(safe-area-inset-left, 0px), 4px) max(env(safe-area-inset-right, 0px), 4px)',
      paddingBottom: 'env(safe-area-inset-bottom, 0px)',
      zIndex: 70,
      boxShadow: '0 -4px 16px rgba(15,43,79,.07)',
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
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: '3px', border: 'none', background: 'transparent',
              padding: '8px 6px', transition: 'all 120ms',
              minWidth: '44px', minHeight: '44px', cursor: 'pointer',
              ...s,
            }}
            aria-label={t(item.labelKey, lang)}
          >
            <span style={{ fontSize: '20px' }}>{item.icon}</span>
            <span style={{ fontSize: '9.5px', fontWeight: s.fontWeight, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '68px' }}>
              {t(item.labelKey, lang)}
            </span>
          </button>
        );
      })}
    </nav>
  );
}
