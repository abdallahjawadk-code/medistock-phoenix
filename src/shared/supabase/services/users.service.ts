import { supabase, supabaseConfigured } from '../client';
import type { OverrideMap } from '@/shared/lib/permissions';
import type { OfficialRole } from '@/shared/lib/roles';

export interface ManagedUser {
  id: string;
  organization_id: string | null;
  full_name: string;
  role: string;
  status: string;
  org_name: string | null;
  org_name_ar: string | null;
}

/**
 * List users visible to the caller. RLS scopes the result: super_admin sees
 * all; others see only their own organization. An optional orgId narrows the
 * super_admin view.
 */
export async function listUsers(orgId?: string | null): Promise<ManagedUser[]> {
  if (!supabaseConfigured) return [];

  let query = supabase
    .from('profiles')
    .select('id, organization_id, full_name, role, status, organizations ( name, name_ar )')
    .order('full_name');

  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query;
  if (error) throw error;

  type OrgEmbed = { name: string; name_ar: string };
  type Row = {
    id: string; organization_id: string | null; full_name: string; role: string; status: string;
    organizations: OrgEmbed | OrgEmbed[] | null;
  };

  return ((data ?? []) as unknown as Row[]).map(r => {
    const org = Array.isArray(r.organizations) ? r.organizations[0] : r.organizations;
    return {
      id: r.id,
      organization_id: r.organization_id,
      full_name: r.full_name,
      role: r.role,
      status: r.status,
      org_name: org?.name ?? null,
      org_name_ar: org?.name_ar ?? null,
    };
  });
}

export interface EffectivePermissionsResult {
  permissions: Record<string, boolean> | null;
  /** True when migration 010 / the RPC is not yet applied. */
  migrationMissing: boolean;
}

/** Read effective permissions for a profile via the scoped RPC (graceful). */
export async function getEffectivePermissions(profileId: string): Promise<EffectivePermissionsResult> {
  if (!supabaseConfigured) return { permissions: null, migrationMissing: false };

  const { data, error } = await supabase.rpc('get_effective_permissions', { p_profile_id: profileId });
  if (error) return { permissions: null, migrationMissing: true };

  const res = data as { ok: boolean; permissions?: Record<string, boolean>; error?: string };
  if (!res?.ok) return { permissions: null, migrationMissing: false };
  return { permissions: res.permissions ?? {}, migrationMissing: false };
}

export interface AssignPermissionsResult {
  ok: boolean;
  applied?: number;
  rejected?: { key: string; error: string }[];
  error?: string;
  migrationMissing?: boolean;
}

/** Persist permission overrides for a profile via the scoped RPC. */
export async function assignProfilePermissions(
  profileId: string,
  overrides: OverrideMap,
): Promise<AssignPermissionsResult> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('assign_profile_permissions', {
    p_profile_id: profileId,
    p_permissions: overrides,
  });
  if (error) return { ok: false, migrationMissing: true, error: 'MIGRATION_MISSING' };

  return data as AssignPermissionsResult;
}

/** Reset a profile's overrides back to its role defaults. */
export async function resetProfilePermissions(profileId: string): Promise<{ ok: boolean; cleared?: number; error?: string; migrationMissing?: boolean }> {
  if (!supabaseConfigured) throw new Error('Supabase not configured');

  const { data, error } = await supabase.rpc('reset_profile_permissions', { p_profile_id: profileId });
  if (error) return { ok: false, migrationMissing: true, error: 'MIGRATION_MISSING' };
  return data as { ok: boolean; cleared?: number };
}

export interface CreateUserInput {
  fullName: string;
  email: string;
  organizationId: string;
  role: OfficialRole;
}

export interface CreateUserResult {
  ok: boolean;
  userId?: string;
  invited?: boolean;
  error?: string;
  /** True when the admin-create-user Edge Function is not deployed. */
  edgeMissing?: boolean;
}

/**
 * Create a user through the secure server-side Edge Function only.
 * The privileged server key NEVER touches the browser. If the function is not
 * deployed yet, returns edgeMissing=true so the UI can stay safely disabled.
 */
export async function createUserViaEdge(input: CreateUserInput): Promise<CreateUserResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };

  try {
    const { data, error } = await supabase.functions.invoke('admin-create-user', {
      body: {
        full_name: input.fullName,
        email: input.email,
        organization_id: input.organizationId,
        role: input.role,
      },
    });

    if (error) {
      // FunctionsFetchError / not-found ⇒ treat as not deployed.
      return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };
    }

    const res = data as CreateUserResult;
    return res ?? { ok: false, error: 'UNKNOWN' };
  } catch {
    return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };
  }
}

// ── Monthly Status Officer contacts (organization_status_contacts, migration 008) ──

export interface OrgContactRow {
  id: string;
  organization_id: string;
  display_name: string;
  phone: string;
  is_primary: boolean;
  is_active: boolean;
}

/** Read an organization's status-officer contacts (scoped by RLS). */
export async function getOrgStatusContacts(orgId: string): Promise<OrgContactRow[]> {
  if (!supabaseConfigured) return [];
  try {
    const { data, error } = await supabase
      .from('organization_status_contacts')
      .select('id, organization_id, display_name, phone, is_primary, is_active')
      .eq('organization_id', orgId)
      .order('is_primary', { ascending: false });
    if (error) return [];
    return (data ?? []) as OrgContactRow[];
  } catch {
    return [];
  }
}
