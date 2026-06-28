import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';

interface NavItem {
  screen: number;
  icon: string;
  labelKey: string;
  frozen?: boolean;
}

const NAV_ITEMS: NavItem[] = [
  { screen: 2,  icon: '📊', labelKey: 'nav_dash' },
  { screen: 11, icon: '🏛️', labelKey: 'nav_institutions' },
  { screen: 3,  icon: '✏️', labelKey: 'nav_editor' },
  { screen: 4,  icon: '📋', labelKey: 'nav_reg' },
  { screen: 5,  icon: '🌐', labelKey: 'nav_mesh' },
  { screen: 6,  icon: '📱', labelKey: 'nav_qr' },
  { screen: 7,  icon: '🏥', labelKey: 'nav_health' },
  { screen: 9,  icon: '📈', labelKey: 'nav_reports' },
];

const SECONDARY_ITEMS: NavItem[] = [
  { screen: 8,  icon: '🔒', labelKey: 'nav_intake', frozen: true },
  { screen: 10, icon: '📲', labelKey: 'nav_mobile' },
];

const ROLE_MAP: Record<string, { emoji: string }> = {
  super_admin:       { emoji: '🔑' },
  hospital_admin:    { emoji: '🏥' },
  warehouse_manager: { emoji: '🏬' },
  point_operator:    { emoji: '💊' },
  viewer:            { emoji: '👁' },
};

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onLogout: () => void;
}

export function PhoenixSidebar({ currentScreen, onNavigate, onLogout }: Props) {
  const { lang, role, profile } = useApp();
  const ri = ROLE_MAP[role] ?? ROLE_MAP.viewer;

  const ns = (n: number) => ({
    background: currentScreen === n ? 'var(--p2)' : 'transparent',
    color:      currentScreen === n ? 'var(--pd)' : 'var(--t2)',
    fontWeight: currentScreen === n ? '700' : '500',
  });

  return (
    <aside style={{
      width: 'var(--sw)',
      flexShrink: 0,
      background: 'var(--s)',
      borderInlineEnd: '1px solid var(--brd)',
      display: 'flex',
      flexDirection: 'column',
      position: 'sticky',
      top: 0,
      height: '100dvh',
      overflowY: 'auto',
      zIndex: 50,
    }}>
      {/* Brand */}
      <div style={{ padding: '18px 14px 14px', borderBottom: '1px solid var(--brd)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '36px', height: '36px', borderRadius: 'var(--r2)',
            background: 'var(--p)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '18px', flexShrink: 0,
          }}>⚕</div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: '13px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>MediStock-Babil</div>
            <div style={{ fontSize: '10px', color: 'var(--t2)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>MASAR Health Network</div>
          </div>
        </div>
      </div>

      {/* Nav */}
      <nav style={{ flex: 1, padding: '10px 8px', display: 'flex', flexDirection: 'column', gap: '2px' }} aria-label="Navigation">
        {NAV_ITEMS.map(item => {
          const s = ns(item.screen);
          return (
            <button
              key={item.screen}
              onClick={() => onNavigate(item.screen)}
              style={{
                display: 'flex', alignItems: 'center', gap: '9px',
                padding: '9px 10px', borderRadius: 'var(--r2)',
                border: 'none', width: '100%', textAlign: 'start',
                transition: 'all 100ms', fontSize: '13px',
                ...s,
              }}
            >
              <span style={{ fontSize: '15px', flexShrink: 0 }}>{item.icon}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {t(item.labelKey, lang)}
              </span>
            </button>
          );
        })}

        <div style={{ height: '1px', background: 'var(--brd)', margin: '6px 4px' }} />

        {SECONDARY_ITEMS.map(item => {
          const s = ns(item.screen);
          return (
            <button
              key={item.screen}
              onClick={() => onNavigate(item.screen)}
              style={{
                display: 'flex', alignItems: 'center', gap: '9px',
                padding: '9px 10px', borderRadius: 'var(--r2)',
                border: 'none', width: '100%', textAlign: 'start',
                transition: 'all 100ms', fontSize: '13px',
                opacity: item.frozen ? 0.7 : 1,
                ...s,
              }}
            >
              <span style={{ fontSize: '15px', flexShrink: 0 }}>{item.icon}</span>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flex: 1 }}>
                {t(item.labelKey, lang)}
              </span>
              {item.frozen && (
                <span style={{
                  padding: '2px 6px', borderRadius: 'var(--rpill)',
                  background: 'var(--warn2)', color: 'var(--warn)',
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
      <div style={{ padding: '12px 14px', borderTop: '1px solid var(--brd)' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
          <div style={{
            width: '30px', height: '30px', borderRadius: 'var(--rpill)',
            background: 'var(--p2)', display: 'flex', alignItems: 'center',
            justifyContent: 'center', fontSize: '14px', flexShrink: 0,
          }}>
            {ri.emoji}
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
            }}
          >
            {t('logout', lang)}
          </button>
        </div>
      </div>
    </aside>
  );
}
