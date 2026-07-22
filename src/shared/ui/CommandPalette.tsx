import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';
import { findNormalizedMatch, normalizedIncludes, type MatchRange } from '@/shared/lib/search-normalize';
import { PhoenixIcon, type PhoenixIconName } from './PhoenixIcon';

/**
 * UX-COMMAND-CENTER-SMART-A + SMART-SEARCH-HOTFIX-A — ONE smart search
 * controller for the whole shell.
 *
 * The floating magnifier is context-aware: on a screen that already renders
 * its own local search field (`input[type="search"]` or
 * `[data-phoenix-local-search]` inside the main region), tapping it scrolls
 * that field into view and focuses it — never a second competing search
 * surface. On every other screen it opens this palette.
 *
 * The palette searches two things, both already permitted to the caller:
 *   1. the static navigation targets below (no backend read), and
 *   2. the RLS-scoped institution list (getOrganizations() — the exact rows
 *      the Institutions screen itself shows this operator; nothing hidden is
 *      ever revealed, and nothing is fetched until the palette opens).
 * Arabic matches are normalized (hamza seats, ة/ه, ى/ي, harakat, tatweel) and
 * English matches case-insensitively; hits are highlighted in place.
 *
 * Keyboard: Ctrl/Cmd+K toggles the palette, `/` triggers the same smart
 * behavior as the floating button, Esc closes.
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
  // OUTLET-CORRIDOR: ungated like nav_editor — the screen self-gates by outlet scope.
  { screen: 18, icon: 'outlet', labelKey: 'nav_outlet_ops' },
  // INSTITUTION-LOCAL-PROCUREMENT-087: ungated — the screen self-gates by warehouse scope.
  { screen: 19, icon: 'warehouse', labelKey: 'nav_local_procurement' },
  { screen: 9,  icon: 'reports', labelKey: 'nav_reports', superAdminOnly: true },
  { screen: 6,  icon: 'qr', labelKey: 'nav_qr' },
  { screen: 15, icon: 'account', labelKey: 'nav_my_account' },
];

/** Selector for a screen-local search field inside the main region. */
const LOCAL_SEARCH_SELECTOR =
  '.premium-main input[type="search"], .premium-main [data-phoenix-local-search]';

/** Visible = laid out (not display:none / detached). */
function findLocalSearchField(): HTMLElement | null {
  const candidates = document.querySelectorAll<HTMLElement>(LOCAL_SEARCH_SELECTOR);
  for (const el of candidates) {
    if (el.offsetParent !== null || el.getClientRects().length > 0) return el;
  }
  return null;
}

/** Highlight one matched range of a label with <mark>. */
function Highlighted({ text, range }: { text: string; range: MatchRange | null }) {
  if (!range) return <>{text}</>;
  return (
    <>
      {text.slice(0, range.start)}
      <mark style={{ background: 'color-mix(in srgb, var(--p) 30%, transparent)', color: 'inherit', borderRadius: '3px', padding: '0 1px' }}>
        {text.slice(range.start, range.end)}
      </mark>
      {text.slice(range.end)}
    </>
  );
}

interface OrgHit {
  org: OrgRow;
  /** Which field matched, with its highlight range. */
  primaryText: string;
  primaryRange: MatchRange | null;
  secondaryText: string;
}

interface Props {
  onNavigate: (screen: number) => void;
}

export function CommandPalette({ onNavigate }: Props) {
  const { lang, role, myPermissions } = useApp();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [orgs, setOrgs] = useState<OrgRow[] | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Efficient debounce: matching runs against the settled query only.
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedQuery(query), 150);
    return () => clearTimeout(timer);
  }, [query]);

  // Institutions are fetched lazily on first open — an RLS-scoped read of the
  // same rows the Institutions screen shows this operator. A failed read just
  // leaves the section absent; navigation search still works.
  useEffect(() => {
    if (!open || orgs !== null) return;
    let cancelled = false;
    getOrganizations()
      .then(rows => { if (!cancelled) setOrgs(rows); })
      .catch(() => { if (!cancelled) setOrgs([]); });
    return () => { cancelled = true; };
  }, [open, orgs]);

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
    const q = debouncedQuery.trim();
    if (!q) return items;
    return items.filter(i =>
      normalizedIncludes(t(i.labelKey, 'ar'), q) || normalizedIncludes(t(i.labelKey, 'en'), q));
  }, [items, debouncedQuery]);

  // Institution record hits — Arabic/English name, code and city, normalized.
  const orgHits: OrgHit[] = useMemo(() => {
    const q = debouncedQuery.trim();
    if (!q || !orgs || orgs.length === 0) return [];
    const hits: OrgHit[] = [];
    for (const org of orgs) {
      const primary = lang === 'ar' ? (org.name_ar || org.name) : (org.name || org.name_ar);
      const fields = [primary, org.name_ar, org.name, org.code, org.city];
      let matched: MatchRange | null = null;
      let matchedText = '';
      for (const field of fields) {
        const range = field ? findNormalizedMatch(field, q) : null;
        if (range) { matched = range; matchedText = field; break; }
      }
      if (!matched) continue;
      hits.push({
        org,
        primaryText: matchedText === primary ? primary : matchedText,
        primaryRange: matched,
        secondaryText: [
          matchedText === primary ? null : primary,
          org.code, org.city,
        ].filter(Boolean).join(' · '),
      });
      if (hits.length >= 12) break;
    }
    return hits;
  }, [orgs, debouncedQuery, lang]);

  const hasQuery = debouncedQuery.trim() !== '';
  const totalResults = filtered.length + (hasQuery ? orgHits.length : 0);

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
    setDebouncedQuery('');
  }, []);

  // The context-aware entry point shared by the floating button and `/`:
  // focus the screen's own search when one exists, otherwise open the palette.
  const smartOpen = useCallback(() => {
    const local = findLocalSearchField();
    if (local) {
      local.scrollIntoView({ block: 'center', behavior: 'smooth' });
      local.focus({ preventScroll: true });
      return;
    }
    setOpen(true);
  }, []);

  useEffect(() => {
    function isTypingContext(target: EventTarget | null): boolean {
      const el = target as HTMLElement | null;
      if (!el) return false;
      const tag = el.tagName;
      return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
    }
    function onKeyDown(e: KeyboardEvent) {
      const isMod = e.ctrlKey || e.metaKey;
      if (isMod && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen(o => !o);
      } else if (e.key === '/' && !isMod && !e.altKey && !isTypingContext(e.target)) {
        e.preventDefault();
        smartOpen();
      } else if (e.key === 'Escape') {
        setOpen(o => (o ? false : o));
      }
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [smartOpen]);

  function choose(screen: number) {
    onNavigate(screen);
    close();
  }

  const sectionLabelStyle = {
    padding: '8px 12px 2px', fontSize: '10.5px', fontWeight: 700, letterSpacing: '.06em',
    textTransform: 'uppercase' as const, color: 'var(--t3)',
  };

  return (
    <>
      {/* The single floating search action. Context-aware (see smartOpen);
          CSS retreats it while the on-screen keyboard is open. */}
      <button
        type="button"
        onClick={smartOpen}
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
              width: '100%', maxWidth: '480px', maxHeight: 'min(80vh, 80dvh)',
              background: 'var(--s)', borderRadius: 'var(--r4)',
              border: '1px solid var(--brd)', boxShadow: 'var(--sh-xl)',
              overflow: 'hidden', display: 'flex', flexDirection: 'column',
            }}
          >
            <div style={{ position: 'relative', display: 'flex', alignItems: 'center' }}>
              <input
                ref={inputRef}
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
              {query !== '' && (
                <button
                  type="button"
                  onClick={() => { setQuery(''); setDebouncedQuery(''); inputRef.current?.focus(); }}
                  aria-label={t('cc_palette_clear', lang)}
                  style={{
                    position: 'absolute', insetInlineEnd: '8px',
                    width: '32px', height: '32px', borderRadius: 'var(--rpill)',
                    border: 'none', background: 'transparent', color: 'var(--t2)',
                    cursor: 'pointer', fontSize: '15px', lineHeight: 1,
                  }}
                >
                  ✕
                </button>
              )}
            </div>

            {hasQuery && (
              <div aria-live="polite" style={{ padding: '6px 14px 0', fontSize: '11px', color: 'var(--t2)' }}>
                {totalResults} {t('cc_palette_results', lang)}
              </div>
            )}

            <div style={{ overflowY: 'auto', padding: '6px' }}>
              {totalResults === 0 && (
                <div style={{ padding: '20px', textAlign: 'center', color: 'var(--t2)', fontSize: '12.5px' }}>
                  {t('cc_palette_no_results', lang)}
                </div>
              )}

              {filtered.length > 0 && hasQuery && (
                <div style={sectionLabelStyle}>{t('cc_palette_screens', lang)}</div>
              )}
              {filtered.map(item => {
                const label = t(item.labelKey, lang);
                return (
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
                      <Highlighted text={label} range={hasQuery ? findNormalizedMatch(label, debouncedQuery) : null} />
                    </span>
                  </button>
                );
              })}

              {hasQuery && orgHits.length > 0 && (
                <div style={sectionLabelStyle}>{t('cc_palette_institutions', lang)}</div>
              )}
              {hasQuery && orgHits.map(hit => (
                <button
                  key={hit.org.id}
                  type="button"
                  onClick={() => choose(11)}
                  style={{
                    width: '100%', display: 'flex', alignItems: 'center', gap: '10px',
                    padding: '10px 12px', minHeight: '44px', borderRadius: 'var(--r2)',
                    border: 'none', background: 'transparent', color: 'var(--t)',
                    fontSize: '13px', fontWeight: 600, textAlign: 'start', cursor: 'pointer',
                    transition: 'background 100ms',
                  }}
                >
                  <span className="nexus-nav-icon"><PhoenixIcon name="hospital" size={18} /></span>
                  <span style={{ minWidth: 0 }}>
                    <span dir="auto" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      <Highlighted text={hit.primaryText} range={hit.primaryRange} />
                    </span>
                    {hit.secondaryText && (
                      <span dir="auto" style={{ display: 'block', fontSize: '10.5px', fontWeight: 500, color: 'var(--t2)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {hit.secondaryText}
                      </span>
                    )}
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
