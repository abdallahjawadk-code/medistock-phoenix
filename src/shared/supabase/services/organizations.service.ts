import { supabase, supabaseConfigured } from '../client';
import type { Role } from '../../lib/types';

export interface OrgRow {
  id:      string;
  name:    string;
  name_ar: string;
  code:    string;
  status:  string;
  city:    string;
  contact_email: string;
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
      .select('id, name, name_ar, code, status, city, contact_email')
      .order('name_ar');

    if (error) {
      orgsInFlight = null;
      throw error;
    }

    const rows = (data ?? []).map(r => ({
      id:      r.id,
      name:    r.name,
      name_ar: r.name_ar,
      code:    r.code,
      status:  r.status,
      city:    r.city ?? '',
      contact_email: r.contact_email ?? '',
    }));
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
    .select('id, name, name_ar, code, status, city, contact_email')
    .eq('id', id)
    .single();

  if (error) return null;
  return {
    id:      data.id,
    name:    data.name,
    name_ar: data.name_ar,
    code:    data.code,
    status:  data.status,
    city:    data.city ?? '',
    contact_email: data.contact_email ?? '',
  };
}

export async function createOrganization(input: {
  name: string;
  name_ar: string;
  code: string;
  city?: string;
  contact_email?: string;
}): Promise<OrgRow> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase
    .from('organizations')
    .insert({
      name:          input.name,
      name_ar:       input.name_ar,
      code:          input.code,
      city:          input.city ?? null,
      contact_email: input.contact_email ?? null,
    })
    .select('id, name, name_ar, code, status, city, contact_email')
    .single();

  if (error) throw error;
  invalidateOrganizationsCache();
  return {
    id: data.id, name: data.name, name_ar: data.name_ar,
    code: data.code, status: data.status,
    city: data.city ?? '', contact_email: data.contact_email ?? '',
  };
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
