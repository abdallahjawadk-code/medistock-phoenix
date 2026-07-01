import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';

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
          className="premium-drawer-trigger premium-focus-ring"
          style={{
            width: '42px', height: '42px', borderRadius: 'var(--r2)',
            border: '1px solid var(--brd)', background: 'var(--s2)',
            color: 'var(--t)', fontSize: '18px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            flexShrink: 0, cursor: 'pointer', transition: 'all 120ms',
          }}
          aria-label={t('menu', lang)}
        >
          ☰
        </button>
      )}

      <h1 style={{ flex: 1, fontSize: '15px', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
        {title}
      </h1>

      <div style={{ display: 'flex', alignItems: 'center', gap: '7px', flexShrink: 0 }}>
        <span style={{
          padding: '3px 8px', borderRadius: 'var(--rpill)',
          background: 'var(--warn2)', color: 'var(--warn)',
          fontSize: '10px', fontWeight: 700, whiteSpace: 'nowrap',
        }}>
          ⚠ {t('demoData', lang)}
        </span>

        <button
          onClick={toggleLang}
          style={{
            padding: '4px 10px', borderRadius: 'var(--rpill)',
            border: '1px solid var(--brd)', background: 'var(--s2)',
            color: 'var(--t)', fontSize: '11.5px', fontWeight: 600,
            cursor: 'pointer', transition: 'all 120ms', whiteSpace: 'nowrap',
          }}
        >
          {lang === 'ar' ? 'EN' : 'عربي'}
        </button>

        <button
          onClick={toggleTheme}
          style={{
            width: '32px', height: '32px', borderRadius: 'var(--rpill)',
            border: '1px solid var(--brd)', background: 'var(--s2)',
            color: 'var(--t)', fontSize: '14px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            cursor: 'pointer', transition: 'all 120ms',
          }}
          aria-label="Toggle theme"
        >
          {theme === 'dark' ? '☀️' : '🌙'}
        </button>
      </div>
    </header>
  );
}
