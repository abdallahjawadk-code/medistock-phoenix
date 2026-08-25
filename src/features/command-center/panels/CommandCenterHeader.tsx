import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { roleLabelKey } from '@/shared/lib/roles';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { CommandCenterScopeKind } from '@/shared/supabase/services/command-center.service';

interface Props {
  scopeKind: CommandCenterScopeKind | null;
  refreshing: boolean;
  onRefresh: () => void;
}

/**
 * RAC-3 — the Command Center context band.
 *
 * The kicker states the scope the SERVER answered at, not the scope this
 * client asked for. Those differ by design: a caller may pass an organization
 * id it is not authorized for, and Migration 199 either refuses or re-derives
 * the effective scope itself. Echoing the requested scope back would present a
 * client-side wish as an established fact.
 *
 * Refresh is manual and explicit. There is no interval and no focus/visibility
 * listener anywhere in this feature — an operations screen left open on a ward
 * terminal must not quietly generate traffic all day.
 */
export function CommandCenterHeader({ scopeKind, refreshing, onRefresh }: Props) {
  const { lang, profile, role } = useApp();

  // `roleLabelKey` is the canonical role→label mapping the sidebar already
  // uses. It covers every current and retained-legacy role and marks legacy
  // ones as such; composing `role_${role}` by hand would silently print raw
  // database identifiers for the roles that have no such key.
  const displayName = profile?.full_name?.trim() ?? '';

  return (
    <header className="rac3-header">
      <div className="rac3-header__identity">
        <p className="rac3-header__kicker">
          {scopeKind ? t(`rac3_scope_${scopeKind}`, lang) : t('rac3_scope_pending', lang)}
        </p>
        {/* h2, not h1: PhoenixAppShell's topbar renders the page-level h1 for
            every authenticated screen, and screens 18 and 21 both title
            themselves with an h2 beneath it. An h1 here would put two
            page headings in one document. */}
        <h2 className="rac3-header__title">{t('rac3_title', lang)}</h2>
        <p className="rac3-header__sub">
          {displayName
            ? t('rac3_subtitle_named', lang).replace('{name}', displayName)
            : t('rac3_subtitle', lang)}
          {role ? <span className="rac3-header__role">{t(roleLabelKey(role), lang)}</span> : null}
        </p>
      </div>

      <button
        type="button"
        onClick={onRefresh}
        disabled={refreshing}
        className="rac3-refresh premium-focus-ring"
        aria-label={t('rac3_refresh', lang)}
      >
        <span className={refreshing ? 'rac3-refresh__spin' : undefined} aria-hidden="true">
          <PhoenixIcon name="refresh" size={16} />
        </span>
        <span className="rac3-refresh__text">
          {t(refreshing ? 'rac3_status_refreshing' : 'rac3_refresh', lang)}
        </span>
      </button>
    </header>
  );
}
