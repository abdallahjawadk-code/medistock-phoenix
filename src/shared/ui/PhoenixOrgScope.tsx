import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { DELEGATED_RECIPIENT_ROLES, getMyOperationalResourceCatalog } from '@/shared/supabase/services/delegated-access.service';
import { PhoenixIcon } from './PhoenixIcon';

/**
 * Org scope selector used by org-scoped screens.
 * - super_admin: a live dropdown of organizations bound to activeOrgId.
 * - delegated operational roles: primary plus server-projected delegated orgs.
 * - governance/facility roles: a read-only chip pinned to their own organization.
 */
export function PhoenixOrgScope() {
  const { lang, role, activeOrgId, setActiveOrgId, profile } = useApp();
  const isSuper = role === 'super_admin';
  const canHoldDelegated = DELEGATED_RECIPIENT_ROLES.some(candidate => candidate === role);
  const { data: orgs } = useAsync(async () => {
    if (isSuper) return getOrganizations();
    if (!canHoldDelegated) return [];
    const rows = await getMyOperationalResourceCatalog();
    return [...new Map(rows.map(row => [row.organizationId, {
      id: row.organizationId, name: row.organizationName, name_ar: row.organizationNameAr,
    }])).values()];
  }, [isSuper, canHoldDelegated]);

  // Fail SAFE, not empty. An operational role only gets a chooser once the
  // server has actually projected more than one organization for it. While the
  // catalog is loading, if the projection fails, or if this actor simply holds
  // no delegated scope, the pre-187 read-only own-organization chip is what
  // renders — so an unapplied 187 can never degrade these roles into an empty
  // selector with no way back to their own organization.
  if (!isSuper && (orgs === null || orgs.length < 2)) {
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
      // minHeight keeps this a 44px touch target on mobile, where it is the
      // control that decides which organization every screen below is scoped to.
      style={{ padding: '8px 12px', minHeight: '44px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12.5px', cursor: 'pointer', maxWidth: '220px' }}
    >
      {isSuper && <option value="">{t('all_orgs', lang)}</option>}
      {(orgs ?? []).map(o => (
        <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>
      ))}
    </select>
  );
}
