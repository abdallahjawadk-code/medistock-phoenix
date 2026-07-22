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
      minHeight: 'var(--tbh)',
      background: 'var(--surface)',
      borderBottom: '1px solid var(--line)',
      display: 'flex',
      alignItems: 'center',
      padding: '10px 18px',
      gap: '10px',
      flexWrap: 'wrap',
      position: 'sticky',
      top: 0,
      zIndex: 'var(--z-topbar)',
      flexShrink: 0,
    }}>
      {isMobile && (
        <button
          onClick={onMenuClick}
          className="premium-drawer-trigger premium-focus-ring nexus-control"
          style={{ flexShrink: 0 }}
          aria-label={t('menu', lang)}
        >
          {/* The legacy ☰ control is rendered as a deterministic accessible SVG. */}
          <PhoenixIcon name="menu" size={20} />
        </button>
      )}

      {/* The design source leads with the screen title and sets the scope line
          beneath it, and drops the scope line on phones where the row has to
          stay one line tall. */}
      <div className="nexus-topbar-title">
        <h1 className="nexus-topbar-heading">{title}</h1>
        {!isMobile && (
          <span className="nexus-topbar-scope">
            {lang === 'ar' ? 'دائرة صحة بابل · قسم الصيدلة' : 'Babil Health Directorate · Pharmacy Department'}
          </span>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: '8px', flexShrink: 0, marginInlineStart: 'auto' }}>
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
          aria-label={theme === 'dark' ? 'Activate light theme' : 'Activate dark theme'}
        >
          <PhoenixIcon name={theme === 'dark' ? 'sun' : 'moon'} size={17} />
        </button>
      </div>
    </header>
  );
}
