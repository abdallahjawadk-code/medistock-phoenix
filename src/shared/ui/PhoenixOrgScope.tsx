import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { PhoenixIcon } from './PhoenixIcon';

/**
 * Org scope selector used by org-scoped screens.
 * - super_admin: a live dropdown of organizations bound to activeOrgId.
 * - other roles: a read-only chip pinned to their own organization.
 */
export function PhoenixOrgScope() {
  const { lang, role, activeOrgId, setActiveOrgId, profile } = useApp();
  const isSuper = role === 'super_admin';
  const { data: orgs } = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);

  if (!isSuper) {
    return (
      <span style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', padding: '4px 12px', borderRadius: 'var(--rpill)', background: 'var(--p2)', color: 'var(--pd)', fontSize: '11.5px', fontWeight: 700 }}>
        <PhoenixIcon name="hospital" size={14} inline />
        <span>{profile?.organization_id ? t('scope', lang) : t('no_org_scope', lang)}</span>
      </span>
    );
  }

  return (
    <select
      value={activeOrgId ?? ''}
      onChange={e => setActiveOrgId(e.target.value || null)}
      aria-label={t('select_org', lang)}
      style={{ padding: '8px 12px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12.5px', cursor: 'pointer', maxWidth: '220px' }}
    >
      <option value="">{t('all_orgs', lang)}</option>
      {(orgs ?? []).map(o => (
        <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>
      ))}
    </select>
  );
}
