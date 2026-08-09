import { supabase, supabaseConfigured } from '../client';
import type { Role } from '../../lib/types';
import {
  isInstitutionClass,
  isOrganizationKind,
  type InstitutionClass,
  type OrganizationKind,
} from '../../lib/institution-hierarchy';

export interface OrgRow {
  id:      string;
  name:    string;
  name_ar: string;
  code:    string;
  status:  string;
  city:    string;
  contact_email: string;
  /**
   * STAGE-E-E7-2: the organizational-actor discriminator (Migration 171) and
   * the care-delivery classification (Migration 164). `institutionClass` is
   * non-null exactly when `organizationKind === 'care_institution'`; a
   * pharmacy_department_authority always carries null, never a sentinel.
   */
  organizationKind:  OrganizationKind | null;
  institutionClass:  InstitutionClass | null;
}

export interface OrgProfileRow {
  id: string;
  full_name: string;
  role: Role;
  status: string;
}

/**
 * DB-PRESSURE-QUICK-WINS-A: the full org list is fetched identically (no
 * params) by Status Center, Editor, Institution, User Management, and the
 * Platform Broadcast admin panel — it changes rarely, so a simple in-memory
 * cache + in-flight dedup avoids refetching it every time one of those
 * screens mounts. Only successful responses are cached (a failed fetch never
 * poisons the cache); createOrganization/updateOrganization invalidate it on
 * success so mutations are always reflected on the next read. This is
 * process-memory-only — it resets on a full page reload — and never changes
 * the returned data shape.
 */
let orgsCache: OrgRow[] | null = null;
let orgsInFlight: Promise<OrgRow[]> | null = null;

/**
 * STAGE-E-E7-2: one column list, used by every organization read, so the
 * classification pair can never be selected by one path and missed by another.
 */
const ORG_COLUMNS =
  'id, name, name_ar, code, status, city, contact_email, organization_kind, institution_class';

/**
 * STAGE-E-E7-2: fail-closed row mapping. An organization_kind this client does
 * not recognise is surfaced as `null`, never coerced to care_institution — so
 * a kind introduced by some later migration can never be mistaken here for a
 * care institution, and callers that gate on a specific kind simply decline to
 * offer the flow rather than offering a DB-illegal one.
 */
function mapOrgRow(r: {
  id: string; name: string; name_ar: string; code: string; status: string;
  city: string | null; contact_email: string | null;
  organization_kind: string | null; institution_class: string | null;
}): OrgRow {
  return {
    id: r.id,
    name: r.name,
    name_ar: r.name_ar,
    code: r.code,
    status: r.status,
    city: r.city ?? '',
    contact_email: r.contact_email ?? '',
    organizationKind: isOrganizationKind(r.organization_kind) ? r.organization_kind : null,
    institutionClass: isInstitutionClass(r.institution_class) ? r.institution_class : null,
  };
}

/** Drops the cached org list; the next getOrganizations() call refetches. */
export function invalidateOrganizationsCache(): void {
  orgsCache = null;
  orgsInFlight = null;
}

export async function getOrganizations(): Promise<OrgRow[]> {
  if (!supabaseConfigured) return [];
  if (orgsCache) return orgsCache;
  if (orgsInFlight) return orgsInFlight;

  orgsInFlight = (async () => {
    const { data, error } = await supabase
      .from('organizations')
      .select(ORG_COLUMNS)
      .order('name_ar');

    if (error) {
      orgsInFlight = null;
      throw error;
    }

    const rows = (data ?? []).map(mapOrgRow);
    orgsCache = rows;
    orgsInFlight = null;
    return rows;
  })();

  return orgsInFlight;
}

export async function getOrganization(id: string): Promise<OrgRow | null> {
  if (!supabaseConfigured) return null;

  const { data, error } = await supabase
    .from('organizations')
    .select(ORG_COLUMNS)
    .eq('id', id)
    .single();

  if (error) return null;
  return mapOrgRow(data);
}

/**
 * STAGE-E-E7-2: the organization classification an operator must choose. The
 * union is closed and discriminated, so "a care institution with no class" and
 * "an authority carrying a class" are both unrepresentable at the type level —
 * exactly the two shapes Migration 171's conditional CHECK
 * (organizations_kind_institution_class_chk) rejects at the database boundary.
 */
export type OrganizationClassification =
  | { organizationKind: 'care_institution'; institutionClass: InstitutionClass }
  | { organizationKind: 'pharmacy_department_authority'; institutionClass?: null };

/**
 * STAGE-E-E7-2: creates an organization with an EXPLICIT classification.
 *
 * Before this, the writer sent neither `organization_kind` nor
 * `institution_class`. Migration 164 introduced institution_class, Migration
 * 170 made it NOT NULL, and Migration 171 replaced that with a conditional
 * CHECK that still requires a non-NULL class for the default
 * `care_institution` kind — so every call through this path failed at the
 * database against a post-170 schema. The class is now collected from the
 * operator and sent explicitly.
 *
 * `organization_kind` is written explicitly rather than relying on the column
 * DEFAULT: the default exists so historical fixtures keep applying, and a real
 * production writer must state its intent rather than inherit it silently.
 */
export async function createOrganization(input: {
  name: string;
  name_ar: string;
  code: string;
  city?: string;
  contact_email?: string;
} & OrganizationClassification): Promise<OrgRow> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  // Fail closed BEFORE the round trip. This mirrors the DB contract; it never
  // replaces it — Migration 171's CHECK remains the authority.
  if (input.organizationKind === 'care_institution') {
    if (!isInstitutionClass(input.institutionClass)) {
      throw new Error('INSTITUTION_CLASS_REQUIRED');
    }
  } else if (input.organizationKind === 'pharmacy_department_authority') {
    if (input.institutionClass != null) {
      throw new Error('AUTHORITY_MUST_NOT_HAVE_INSTITUTION_CLASS');
    }
  } else {
    throw new Error('ORGANIZATION_KIND_REQUIRED');
  }

  const { data, error } = await supabase
    .from('organizations')
    .insert({
      name:              input.name,
      name_ar:           input.name_ar,
      code:              input.code,
      city:              input.city ?? null,
      contact_email:     input.contact_email ?? null,
      organization_kind: input.organizationKind,
      institution_class: input.organizationKind === 'care_institution'
        ? input.institutionClass
        : null,
    })
    .select(ORG_COLUMNS)
    .single();

  if (error) throw error;
  invalidateOrganizationsCache();
  return mapOrgRow(data);
}

export async function updateOrganization(
  id: string,
  input: { name?: string; name_ar?: string; city?: string; contact_email?: string; status?: string },
): Promise<void> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const update: Record<string, unknown> = {};
  if (input.name !== undefined) update.name = input.name;
  if (input.name_ar !== undefined) update.name_ar = input.name_ar;
  if (input.city !== undefined) update.city = input.city;
  if (input.contact_email !== undefined) update.contact_email = input.contact_email;
  if (input.status !== undefined) update.status = input.status;

  const { error } = await supabase
    .from('organizations')
    .update(update)
    .eq('id', id);

  if (error) throw error;
  invalidateOrganizationsCache();
}

export async function getProfilesByOrg(orgId: string): Promise<OrgProfileRow[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('profiles')
    .select('id, full_name, role, status')
    .eq('organization_id', orgId)
    .order('role')
    .order('full_name');

  if (error) throw error;
  return (data ?? []) as OrgProfileRow[];
}

export interface RoleAssignResult {
  ok: boolean;
  changed?: boolean;
  error?: string;
  previous_role?: string;
  new_role?: string;
}

export async function updateProfileRole(
  profileId: string,
  newRole: Role,
): Promise<RoleAssignResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('assign_profile_role', {
    p_target_id: profileId,
    p_new_role:  newRole,
  });

  if (error) throw error;

  const result = data as RoleAssignResult;
  if (!result.ok) {
    throw new Error(result.error ?? 'ROLE_ASSIGN_FAILED');
  }
  return result;
}
