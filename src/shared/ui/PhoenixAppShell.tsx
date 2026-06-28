import { ReactNode, useState, useEffect } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixSidebar } from './PhoenixSidebar';
import { PhoenixMobileDrawer } from './PhoenixMobileDrawer';
import { PhoenixTopbar } from './PhoenixTopbar';
import { PhoenixMobileBottomNav } from './PhoenixMobileBottomNav';

const SCREEN_TITLE_KEYS: Record<number, string> = {
  2: 'nav_dash', 3: 'nav_editor', 4: 'nav_reg', 5: 'nav_mesh',
  6: 'nav_qr', 7: 'nav_health', 8: 'nav_intake', 9: 'nav_reports', 10: 'nav_mobile',
  11: 'nav_institutions', 12: 'nav_status_center', 13: 'nav_inter_alerts',
  14: 'nav_users',
  15: 'nav_my_account',
};

interface Props {
  children: ReactNode;
  currentScreen: number;
  onNavigate: (screen: number) => void;
  onLogout: () => void;
}

export function PhoenixAppShell({ children, currentScreen, onNavigate, onLogout }: Props) {
  const { lang, dir } = useApp();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const onResize = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const title = t(SCREEN_TITLE_KEYS[currentScreen] ?? 'nav_dash', lang);

  return (
    <div dir={dir} style={{
      display: 'flex',
      flexDirection: 'row',
      minHeight: '100dvh',
      position: 'relative',
    }}>
      {!isMobile && (
        <PhoenixSidebar
          currentScreen={currentScreen}
          onNavigate={onNavigate}
          onLogout={onLogout}
        />
      )}

      {isMobile && sidebarOpen && (
        <PhoenixMobileDrawer
          currentScreen={currentScreen}
          onNavigate={onNavigate}
          onClose={() => setSidebarOpen(false)}
        />
      )}

      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden' }}>
        <PhoenixTopbar
          title={title}
          isMobile={isMobile}
          onMenuClick={() => setSidebarOpen(s => !s)}
        />

        <main style={{
          flex: 1,
          overflowY: 'auto',
          overflowX: 'hidden',
          padding: isMobile ? '16px 14px' : '24px 28px',
          paddingBottom: isMobile ? 'calc(var(--bnh) + 14px)' : '28px',
        }}>
          {children}
        </main>
      </div>

      {isMobile && (
        <PhoenixMobileBottomNav
          currentScreen={currentScreen}
          onNavigate={onNavigate}
          onMoreClick={() => setSidebarOpen(s => !s)}
        />
      )}
    </div>
  );
}
