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

export async function getOrganizations(): Promise<OrgRow[]> {
  if (!supabaseConfigured) return [];

  const { data, error } = await supabase
    .from('organizations')
    .select('id, name, name_ar, code, status, city, contact_email')
    .order('name_ar');

  if (error) throw error;
  return (data ?? []).map(r => ({
    id:      r.id,
    name:    r.name,
    name_ar: r.name_ar,
    code:    r.code,
    status:  r.status,
    city:    r.city ?? '',
    contact_email: r.contact_email ?? '',
  }));
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
