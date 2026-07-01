import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';

// AVAILABILITY-EDITOR-NAV-HIDE-A: nav_editor is intentionally NOT listed here
// (hidden from navigation only). Its route (screen 3 — EditorScreen) remains
// fully wired in App.tsx; only the bottom-nav entry point was removed.
const BOTTOM_NAV = [
  { screen: 2, icon: '📊', labelKey: 'nav_dash' },
  { screen: 11, icon: '🏛️', labelKey: 'nav_institutions' },
  { screen: 13, icon: '🔔', labelKey: 'nav_inter_alerts' },
];

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onMoreClick: () => void;
}

export function PhoenixMobileBottomNav({ currentScreen, onNavigate, onMoreClick }: Props) {
  const { lang } = useApp();

  const bns = (n: number) => ({
    color:      currentScreen === n ? 'var(--p)' : 'var(--t2)',
    fontWeight: currentScreen === n ? '700' : '500',
  });

  return (
    <nav style={{
      position: 'fixed', bottom: 0,
      insetInlineStart: 0, insetInlineEnd: 0,
      height: 'var(--bnh)',
      background: 'var(--s)',
      borderTop: '1px solid var(--brd)',
      display: 'flex',
      alignItems: 'stretch',
      zIndex: 70,
      boxShadow: '0 -4px 16px rgba(15,43,79,.07)',
    }} aria-label="Bottom Navigation">
      {BOTTOM_NAV.map(item => {
        const s = bns(item.screen);
        return (
          <button
            key={item.screen}
            onClick={() => onNavigate(item.screen)}
            style={{
              flex: 1,
              display: 'flex', flexDirection: 'column',
              alignItems: 'center', justifyContent: 'center',
              gap: '3px', border: 'none', background: 'transparent',
              padding: '8px 4px', transition: 'all 120ms',
              minWidth: '44px', minHeight: '44px', cursor: 'pointer',
              ...s,
            }}
            aria-label={t(item.labelKey, lang)}
          >
            <span style={{ fontSize: '20px' }}>{item.icon}</span>
            <span style={{ fontSize: '9.5px', fontWeight: s.fontWeight, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: '60px' }}>
              {t(item.labelKey, lang)}
            </span>
          </button>
        );
      })}

      <button
        onClick={onMoreClick}
        style={{
          flex: 1,
          display: 'flex', flexDirection: 'column',
          alignItems: 'center', justifyContent: 'center',
          gap: '3px', border: 'none', background: 'transparent',
          color: 'var(--t2)', padding: '8px 4px',
          transition: 'all 120ms', minWidth: '44px', minHeight: '44px', cursor: 'pointer',
        }}
        aria-label="More"
      >
        <span style={{ fontSize: '20px' }}>☰</span>
        <span style={{ fontSize: '9.5px', fontWeight: 500 }}>{t('more', lang)}</span>
      </button>
    </nav>
  );
}
