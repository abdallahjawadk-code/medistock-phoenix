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
const ALL_NAV: { screen: number; icon: string; labelKey: string; frozen?: boolean }[] = [
  { screen: 2,  icon: '📊', labelKey: 'nav_dash' },
  { screen: 11, icon: '🏛️', labelKey: 'nav_institutions' },
  { screen: 12, icon: '📋', labelKey: 'nav_status_center' },
  { screen: 13, icon: '🔔', labelKey: 'nav_inter_alerts' },
  { screen: 14, icon: '👥', labelKey: 'nav_users' },
  { screen: 3,  icon: '✏️', labelKey: 'nav_editor' },
  { screen: 9,  icon: '📈', labelKey: 'nav_reports' },
];

interface Props {
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onClose: () => void;
}

export function PhoenixMobileDrawer({ currentScreen, onNavigate, onClose }: Props) {
  const { lang, dir } = useApp();

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
      <div onClick={onClose} style={{ position: 'absolute', inset: 0, background: 'rgba(0,0,0,.5)' }} />
      <aside className="premium-sidebar premium-dialog-panel" style={{
        position: 'relative',
        width: 'min(var(--sw), 88vw)',
        background: 'var(--s)',
        height: '100%',
        overflowY: 'auto',
        display: 'flex',
        flexDirection: 'column',
        gap: '2px',
        padding: '16px 8px',
        boxShadow: 'var(--sh-xl)',
        animation: `${dir === 'rtl' ? 'si-rtl' : 'si'} .2s ease`,
      }}>
        <div className="premium-sidebar-brand" style={{ padding: '10px 8px 14px', borderBottom: '1px solid var(--brd)', marginBottom: '6px', borderRadius: 'var(--r3)' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
            <div className="premium-sidebar-logo" style={{ width: '36px', height: '36px', borderRadius: 'var(--r2)', background: 'var(--p)', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: '18px' }}>⚕</div>
            <div>
              <div style={{ fontSize: '13px', fontWeight: 700 }}>MediStock-Babil</div>
              <div style={{ fontSize: '10px', color: 'var(--t2)' }}>MASAR Health Network</div>
            </div>
          </div>
        </div>

        {ALL_NAV.map(item => {
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
                fontSize: '14px', transition: 'all 100ms',
                opacity: item.frozen ? 0.7 : 1,
                cursor: 'pointer',
                ...s,
              }}
            >
              {item.icon} {t(item.labelKey, lang)}
            </button>
          );
        })}
      </aside>
    </div>
  );
}
