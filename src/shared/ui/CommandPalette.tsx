import { useCallback, useEffect, useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

/**
 * UX-COMMAND-CENTER-SMART-A — lightweight Ctrl+K / Cmd+K command palette.
 *
 * Search is local/static only: it filters this fixed list of existing
 * navigation targets (both languages) — no Supabase reads, no new backend
 * actions. Selecting an item calls the SAME `onNavigate` screen-switch
 * function App.tsx already passes to PhoenixAppShell; no new routes/targets
 * are introduced.
 */

interface PaletteItem {
  screen: number;
  icon: PhoenixIconName;
  labelKey: string;
  superAdminOnly?: boolean;
}

// Mirrors the routes already reachable via the sidebar / mobile drawer
// (PhoenixSidebar.tsx, PhoenixMobileDrawer.tsx), plus the QR screen — its
// route (screen 6) remains fully wired in App.tsx even though it was
// deliberately hidden from the primary nav (UI-LEGACY-PAGES-NAV-HIDE-A).
const PALETTE_ITEMS: PaletteItem[] = [
  { screen: 12, icon: 'status', labelKey: 'nav_status_center' },
  { screen: 11, icon: 'institutions', labelKey: 'nav_institutions' },
  { screen: 13, icon: 'alerts', labelKey: 'nav_inter_alerts' },
  { screen: 14, icon: 'users', labelKey: 'nav_users' },
  { screen: 17, icon: 'network', labelKey: 'nav_network' },
  { screen: 3,  icon: 'editor', labelKey: 'nav_editor' },
  { screen: 9,  icon: 'reports', labelKey: 'nav_reports', superAdminOnly: true },
  { screen: 6,  icon: 'qr', labelKey: 'nav_qr' },
  { screen: 15, icon: 'account', labelKey: 'nav_my_account' },
];

interface Props {
  onNavigate: (screen: number) => void;
}

export function CommandPalette({ onNavigate }: Props) {
  const { lang, role, myPermissions } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');

  // Keep the command palette consistent with every visible navigation surface:
  // User Management follows users.view, while Reports is deliberately exposed
  // only to super_admin because it contains the cross-organization global stock
  // search. Hidden legacy QR remains an intentional quick jump.
  const canSeeUsers = role === 'super_admin' || myPermissions.has('users.view');
  // PHASE-B-NETWORK-UI-A: identical predicate to PhoenixSidebar.tsx /
  // PhoenixMobileDrawer.tsx — network structure (super_admin) or scope
  // assignment (users.edit_scope).
  const canSeeNetwork = role === 'super_admin' || myPermissions.has('users.edit_scope');

  const items = useMemo(
    () => PALETTE_ITEMS.filter(i =>
      (!i.superAdminOnly || role === 'super_admin') &&
      (i.screen !== 14 || canSeeUsers) &&
      (i.screen !== 17 || canSeeNetwork),
    ),
    [canSeeUsers, canSeeNetwork, role],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter(i => {
      const ar = t(i.labelKey, 'ar').toLowerCase();
      const en = t(i.labelKey, 'en').toLowerCase();
      return ar.includes(q) || en.includes(q);
    });
  }, [items, query]);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const isMod = e.ctrlKey || e.metaKey;
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      } else if (e.key === 'Escape') {
        setOpen(o => (o ? false : o));
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  function choose(screen: number) {
    onNavigate(screen);
    close();
  }

  return (
    <>
      {/* Mobile/desktop trigger — a visible search action button, per the
          "expose it as a search/action button" mobile requirement. */}
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-label={t('cc_palette_open', lang)}
        title={t('cc_palette_hint', lang)}
        className="premium-focus-ring premium-command-trigger"
        style={{
          position: 'fixed', insetInlineEnd: '16px', bottom: 'calc(var(--bnh, 0px) + 18px)',
          zIndex: 60, width: '44px', height: '44px', minWidth: '44px', minHeight: '44px',
          borderRadius: 'var(--rpill)', border: '1px solid var(--brd)',
          background: 'var(--s)', color: 'var(--t)', fontSize: '18px',
          cursor: 'pointer', boxShadow: 'var(--sh-md)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        <PhoenixIcon name="search" size={19} />
      </button>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={t('cc_palette_title', lang)}
          onClick={close}
          className="nexus-command-backdrop"
          style={{
            position: 'fixed', inset: 0, zIndex: 300,
            background: 'rgba(15, 23, 42, .45)',
            display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
            padding: '10vh 16px 16px',
          }}
        >
          <div
            className="nexus-command-panel"
            onClick={e => e.stopPropagation()}
            style={{
              width: '100%', maxWidth: '480px', maxHeight: '80vh',
              background: 'var(--s)', borderRadius: 'var(--r4)',
              border: '1px solid var(--brd)', boxShadow: 'var(--sh-xl)',
              overflow: 'hidden', display: 'flex', flexDirection: 'column',
            }}
          >
            <input
              autoFocus
              type="text"
              dir="auto"
              value={query}
              onChange={e => setQuery(e.target.value)}
              placeholder={t('cc_palette_placeholder', lang)}
              aria-label={t('cc_palette_title', lang)}
              style={{
                width: '100%', padding: '14px 16px', minHeight: '44px',
                border: 'none', borderBottom: '1px solid var(--brd)',
                background: 'transparent', color: 'var(--t)',
                fontSize: '14px', outline: 'none',
              }}
            />
            <div style={{ overflowY: 'auto', padding: '6px' }}>
              {filtered.length === 0 && (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--t2)', fontSize: '12.5px' }}>
                  {t('cc_palette_no_results', lang)}
                </div>
              )}
              {filtered.map(item => (
                <button
                  key={item.screen}
                  type="button"
                  onClick={() => choose(item.screen)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 12px', minHeight: '44px', borderRadius: 'var(--r2)',
                    border: 'none', background: 'transparent', color: 'var(--t)',
                    fontSize: '13px', fontWeight: 600, textAlign: 'start', cursor: 'pointer',
                    transition: 'background 100ms',
                  }}
                >
                  <span className="nexus-nav-icon"><PhoenixIcon name={item.icon} size={18} /></span>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {t(item.labelKey, lang)}
                  </span>
                </button>
              ))}
            </div>
            <div style={{ padding: '8px 14px', borderTop: '1px solid var(--brd)', fontSize: '10.5px', color: 'var(--t2)' }}>
              {t('cc_palette_hint', lang)}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
