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

// ── User creation (secure Edge Function path only) ───────────────────────────

export interface CreateUserInput {
  fullName: string;
  email: string;
  organizationId: string;
  role: OfficialRole;
  /** Mode 1: password provided → user can log in immediately.
   *  Mode 2: absent/empty → invite email attempted. Min 8 chars when provided. */
  password?: string;
}

export interface CreateUserResult {
  ok: boolean;
  userId?: string;
  invited?: boolean;
  /** True when user was created with an explicit password (can log in immediately). */
  passwordMode?: boolean;
  error?: string;
  /** True when the admin-create-user Edge Function is not deployed. */
  edgeMissing?: boolean;
}

/**
 * Create a user through the secure server-side Edge Function only.
 * The privileged server key NEVER touches the browser.
 * If password is provided it is sent over HTTPS only to the Edge Function
 * and is never stored in the profiles table.
 */
export async function createUserViaEdge(input: CreateUserInput): Promise<CreateUserResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };

  try {
    const body: Record<string, string> = {
      full_name:       input.fullName,
      email:           input.email,
      organization_id: input.organizationId,
      role:            input.role,
    };
    // Include password only when the caller explicitly provides one.
    if (input.password) body.password = input.password;

    const { data, error } = await supabase.functions.invoke('admin-create-user', { body });

    if (error) {
      return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };
    }

    const res = data as { ok: boolean; user_id?: string; invited?: boolean; password_mode?: boolean; error?: string };
    if (!res) return { ok: false, error: 'UNKNOWN' };
    return {
      ok:           res.ok,
      userId:       res.user_id,
      invited:      res.invited,
      passwordMode: res.password_mode,
      error:        res.error,
    };
  } catch {
    return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };
  }
}

// ── User lifecycle (disable / enable / delete via Edge Function) ──────────────

export interface LifecycleResult {
  ok: boolean;
  action?: string;
  error?: string;
  /** True when the admin-user-lifecycle Edge Function is not deployed. */
  edgeMissing?: boolean;
}

async function invokeLifecycle(payload: Record<string, string>): Promise<LifecycleResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  try {
    const { data, error } = await supabase.functions.invoke('admin-user-lifecycle', { body: payload });
    if (error) return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };
    const res = data as LifecycleResult;
    return res ?? { ok: false, error: 'UNKNOWN' };
  } catch {
    return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };
  }
}

/** Disable a user (ban from auth + suspend profile). Caller must be super_admin. */
export async function disableUserViaEdge(targetUserId: string): Promise<LifecycleResult> {
  return invokeLifecycle({ action: 'disable', target_user_id: targetUserId });
}

/** Re-enable a previously disabled user. Caller must be super_admin. */
export async function enableUserViaEdge(targetUserId: string): Promise<LifecycleResult> {
  return invokeLifecycle({ action: 'enable', target_user_id: targetUserId });
}

/**
 * Hard-delete a user from auth and profiles (cascade).
 * confirmation must equal 'DELETE_USER_<target-email>' (built by UI, verified server-side).
 */
export async function deleteUserViaEdge(targetUserId: string, confirmation: string): Promise<LifecycleResult> {
  return invokeLifecycle({ action: 'delete', target_user_id: targetUserId, confirmation });
}

// ── Account recycling (USER-ACCOUNT-RECYCLING-A) ────────────────────────────

export interface RecycleUserInput {
  targetProfileId: string;
  newFullName: string;
  newEmail: string;
  newRole: OfficialRole;
  newOrganizationId?: string;
  confirmation: string;
}

export interface RecycleUserResult {
  ok: boolean;
  targetProfileId?: string;
  newEmail?: string;
  newIdentityVersion?: number;
  passwordSetupSent?: boolean;
  error?: string;
  edgeMissing?: boolean;
}

export async function recycleUserViaEdge(input: RecycleUserInput): Promise<RecycleUserResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };

  try {
    const body: Record<string, string> = {
      target_profile_id: input.targetProfileId,
      new_full_name:     input.newFullName,
      new_email:         input.newEmail,
      new_role:          input.newRole,
      confirmation:      input.confirmation,
    };
    if (input.newOrganizationId) body.new_organization_id = input.newOrganizationId;

    const { data, error } = await supabase.functions.invoke('admin-recycle-user', { body });

    if (error) return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };

    const res = data as {
      ok: boolean;
      target_profile_id?: string;
      new_email?: string;
      new_identity_version?: number;
      password_setup_sent?: boolean;
      error?: string;
    };
    if (!res) return { ok: false, error: 'UNKNOWN' };
    return {
      ok:                 res.ok,
      targetProfileId:    res.target_profile_id,
      newEmail:           res.new_email,
      newIdentityVersion: res.new_identity_version,
      passwordSetupSent:  res.password_setup_sent,
      error:              res.error,
    };
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
