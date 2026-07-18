import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from './PhoenixIcon';

interface Props {
  title: string;
  isMobile: boolean;
  onMenuClick: () => void;
}

export function PhoenixTopbar({ title, isMobile, onMenuClick }: Props) {
  const { lang, toggleLang, toggleTheme, theme } = useApp();

  return (
    <header className="premium-topbar" style={{
      height: 'var(--tbh)',
      background: 'var(--s)',
      borderBottom: '1px solid var(--brd)',
      display: 'flex',
      alignItems: 'center',
      padding: '0 18px',
      gap: '12px',
      position: 'sticky',
      top: 0,
      zIndex: 60,
      flexShrink: 0,
    }}>
      {isMobile && (
        <button
          onClick={onMenuClick}
          className="premium-drawer-trigger premium-focus-ring nexus-control"
          style={{ width: '42px', height: '42px', flexShrink: 0 }}
          aria-label={t('menu', lang)}
        >
          {/* The legacy ☰ control is rendered as a deterministic accessible SVG. */}
          <PhoenixIcon name="menu" size={20} />
        </button>
      )}

      <div className="nexus-topbar-title">
        <span className="nexus-topbar-eyebrow">
          {lang === 'ar' ? 'دائرة صحة بابل · قسم الصيدلة' : 'BABIL HEALTH · PHARMACY DEPARTMENT'}
        </span>
        <h1 className="nexus-topbar-heading">{title}</h1>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexShrink: 0 }}>
        <button
          onClick={toggleLang}
          className="nexus-control nexus-control--language"
          aria-label={lang === 'ar' ? 'Switch to English' : 'التبديل إلى العربية'}
        >
          {lang === 'ar' ? 'EN' : 'عربي'}
        </button>

        <button
          onClick={toggleTheme}
          className="nexus-control"
          style={{ width: '36px', height: '36px' }}
          aria-label={theme === 'dark' ? 'Activate light theme' : 'Activate dark theme'}
        >
          <PhoenixIcon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
      </div>
    </header>
  );
}
