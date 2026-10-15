import { isFacilityScopedRole } from '@/shared/lib/roles';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';

export type ReportTab =
  | 'overview'
  | 'institutions'
  | 'materials'
  | 'movements'
  | 'custody'
  | 'supplementary'
  | 'corrections'
  | 'audit'
  | 'monthly'
  | 'library'
  | 'global';

export const REPORT_TAB_ORDER: readonly ReportTab[] = [
  'overview',
  'institutions',
  'materials',
  'movements',
  'custody',
  'supplementary',
  'corrections',
  'audit',
  'monthly',
  'library',
  'global',
];

type ReportTabAccessRule =
  | { readonly kind: 'authenticated_rls' }
  | { readonly kind: 'permission'; readonly permission: 'status_center.view' | 'audit.view' }
  | { readonly kind: 'role'; readonly role: 'super_admin' };

/**
 * Exact pre-C3 frontend parity, tab by tab. `authenticated_rls` means the
 * legacy surface had no frontend view gate: its service/RPC/RLS boundary
 * remains authoritative. It must never be replaced by an inferred key based
 * on where the tab happens to be rendered.
 */
export const REPORT_TAB_ACCESS = {
  overview: { kind: 'authenticated_rls' },
  institutions: { kind: 'authenticated_rls' },
  materials: { kind: 'authenticated_rls' },
  movements: { kind: 'permission', permission: 'status_center.view' },
  custody: { kind: 'authenticated_rls' },
  supplementary: { kind: 'authenticated_rls' },
  corrections: { kind: 'authenticated_rls' },
  audit: { kind: 'permission', permission: 'audit.view' },
  monthly: { kind: 'authenticated_rls' },
  library: { kind: 'authenticated_rls' },
  global: { kind: 'role', role: 'super_admin' },
} as const satisfies Record<ReportTab, ReportTabAccessRule>;

/**
 * Phase C3 UNION contract. A tab is visible when its own existing frontend
 * permission (or role, for Global Search) allows it. Nothing here grants a
 * backend capability: every service/RPC/RLS check remains authoritative.
 *
 * `organizationKind` is the ACTIVE organization's canonical
 * organization_kind (AppContext's activeOrganizationKind). Only the
 * supplementary tab reads it; omitted, null or unknown means "not a care
 * institution" (see PDA-PROC-1 below).
 */
export function allowedReportTabs(
  permissions: ReadonlySet<string>,
  role: string | null,
  organizationKind?: OrganizationKind | null,
): ReportTab[] {
  if (role === null) return [];

  /**
   * R1.1-U SAFE ACTIVATION — `authenticated_rls` is not facility-safe.
   *
   * That rule means "this tab had no frontend gate; its RLS boundary is
   * authoritative". For every role that existed before Migration 182 that is
   * still exactly right. For a FACILITY-SCOPED role it is not: several read
   * models behind those tabs authorize on ORGANIZATION MEMBERSHIP ALONE, which
   * is precisely the boundary this role must not inherit, so "RLS is
   * authoritative" would silently mean "the whole health sector is visible".
   *
   * A tab is therefore withheld from a facility-scoped role unless it carries
   * an explicit gate the role can satisfy. This is a DENIAL, never a filter:
   * the tab is not rendered at all, rather than rendered over client-side
   * filtered data. Migration 182 closes the corresponding surfaces at the
   * database for the ones that matter most; this denies the remainder rather
   * than presenting a surface whose backend cannot yet be proven facility-safe.
   *
   * REPORT_TAB_ACCESS itself is deliberately unchanged, so every pre-existing
   * role's tab set is byte-identical to before.
   */
  const facilityScoped = isFacilityScopedRole(role);

  return REPORT_TAB_ORDER.filter(tab => {
    /**
     * PDA-PROC-1 — supplementary procurement is a care-institution domain.
     *
     * A pharmacy department authority never possesses supplementary
     * purchases, so the tab is DENIED (not rendered empty) unless the active
     * organization is canonically a care institution. A null, unknown or
     * still-loading kind is denied too, and no role is an exception, not even
     * super_admin. Like the facility denial above, this is layered on top of
     * the tab's own rule: REPORT_TAB_ACCESS is unchanged, and the tab keeps
     * every pre-existing gate for a care institution.
     */
    if (tab === 'supplementary' && organizationKind !== 'care_institution') return false;
    const rule: ReportTabAccessRule = REPORT_TAB_ACCESS[tab];
    if (rule.kind === 'authenticated_rls') return !facilityScoped;
    if (rule.kind === 'permission') return permissions.has(rule.permission);
    return role === rule.role;
  });
}

/** Keep the requested tab when allowed; otherwise land on the first allowed tab. */
export function resolveAllowedReportTab(
  requested: ReportTab,
  allowed: readonly ReportTab[],
): ReportTab | null {
  if (allowed.includes(requested)) return requested;
  return allowed[0] ?? null;
}
