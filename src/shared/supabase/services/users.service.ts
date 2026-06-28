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
  username: string | null;
  login_mode: 'email' | 'local';
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
    .select('id, organization_id, full_name, role, status, username, login_mode, organizations ( name, name_ar )')
    .order('full_name');

  if (orgId) query = query.eq('organization_id', orgId);

  const { data, error } = await query;
  if (error) throw error;

  type OrgEmbed = { name: string; name_ar: string };
  type Row = {
    id: string; organization_id: string | null; full_name: string; role: string; status: string;
    username: string | null; login_mode: 'email' | 'local';
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
      username: r.username,
      login_mode: r.login_mode,
      org_name: org?.name ?? null,
      org_name_ar: org?.name_ar ?? null,
    };
  });
}

// ── Permission matrix readiness (PERMISSION-MATRIX-010-GUARD-FIX-A) ──────────
//
// IMPORTANT: a Postgrest/RPC `error` can mean many things — a genuinely
// missing table/RPC (migration 010 not applied), a transient network
// failure, an RLS denial, or an unrelated runtime bug introduced by a later
// migration. Earlier code collapsed ALL of these into "migration 010
// missing", which falsely blocked editing even when the DB capability was
// fully present (migrations 011-016 had already been applied on top of it).
// These two classifiers narrow "migration missing" down to its true,
// specific signatures only — every other failure surfaces as a distinct,
// honest error instead.

interface RpcErrorLike { code?: string; message?: string }

/** True only for Postgrest "relation does not exist" (table truly missing). */
function isMissingRelationError(error: RpcErrorLike): boolean {
  return error.code === '42P01' || /relation .* does not exist/i.test(error.message ?? '');
}

/** True only for Postgrest "function not found" (RPC truly missing). */
function isMissingFunctionError(error: RpcErrorLike): boolean {
  return error.code === 'PGRST202' || error.code === '42883'
    || /could not find the function|function .* does not exist/i.test(error.message ?? '');
}

export interface PermissionMatrixReadiness {
  ready: boolean;
  /** Only set when ready is false. */
  reason?: 'NOT_CONFIGURED' | 'TABLES_MISSING' | 'RPC_MISSING' | 'UNKNOWN_ERROR';
}

/**
 * Lightweight, read-only probe of whether the permission-matrix DB
 * capability (permission_keys, role_permission_defaults,
 * profile_permission_overrides, get_effective_permissions) actually exists.
 * Never assumes "migration 010 missing" just because some other call
 * failed — this is the one place that tests real DB capability directly.
 * Never writes data. Safe to call at any time.
 */
export async function checkPermissionMatrixReady(profileId?: string): Promise<PermissionMatrixReadiness> {
  if (!supabaseConfigured) return { ready: false, reason: 'NOT_CONFIGURED' };

  try {
    const [pk, rpd, ppo] = await Promise.all([
      supabase.from('permission_keys').select('key').limit(1),
      supabase.from('role_permission_defaults').select('role').limit(1),
      supabase.from('profile_permission_overrides').select('profile_id').limit(1),
    ]);
    const tableError = pk.error ?? rpd.error ?? ppo.error;
    if (tableError) {
      return { ready: false, reason: isMissingRelationError(tableError) ? 'TABLES_MISSING' : 'UNKNOWN_ERROR' };
    }

    // A bogus (but well-formed) profile id is a safe, non-mutating probe:
    // if the RPC exists, it returns { ok: false, error: 'TARGET_NOT_FOUND' }
    // (a normal JSON response, no Postgrest error) rather than a real error.
    const probeId = profileId ?? '00000000-0000-0000-0000-000000000000';
    const { error: rpcError } = await supabase.rpc('get_effective_permissions', { p_profile_id: probeId });
    if (rpcError) {
      return { ready: false, reason: isMissingFunctionError(rpcError) ? 'RPC_MISSING' : 'UNKNOWN_ERROR' };
    }

    return { ready: true };
  } catch {
    return { ready: false, reason: 'UNKNOWN_ERROR' };
  }
}

export interface EffectivePermissionsResult {
  permissions: Record<string, boolean> | null;
  /** True only when the permission-matrix RPC is genuinely missing (true migration gap). */
  migrationMissing: boolean;
  /** Set when permissions could not be loaded for a reason OTHER than a missing migration. */
  loadError?: 'NOT_CONFIGURED' | 'NETWORK_ERROR' | 'UNKNOWN_ERROR';
}

/** Read effective permissions for a profile via the scoped RPC (graceful). */
export async function getEffectivePermissions(profileId: string): Promise<EffectivePermissionsResult> {
  if (!supabaseConfigured) return { permissions: null, migrationMissing: false, loadError: 'NOT_CONFIGURED' };

  try {
    const { data, error } = await supabase.rpc('get_effective_permissions', { p_profile_id: profileId });
    if (error) {
      if (isMissingFunctionError(error)) return { permissions: null, migrationMissing: true };
      return { permissions: null, migrationMissing: false, loadError: 'UNKNOWN_ERROR' };
    }

    const res = data as { ok: boolean; permissions?: Record<string, boolean>; error?: string };
    if (!res?.ok) return { permissions: null, migrationMissing: false };
    return { permissions: res.permissions ?? {}, migrationMissing: false };
  } catch {
    return { permissions: null, migrationMissing: false, loadError: 'NETWORK_ERROR' };
  }
}

export interface AssignPermissionsResult {
  ok: boolean;
  applied?: number;
  rejected?: { key: string; error: string }[];
  /** 'MIGRATION_MISSING' | 'SAVE_FAILED' | 'NETWORK_ERROR' | 'NOT_CONFIGURED' | an RPC business-logic error code. */
  error?: string;
  /** True only when the permission-matrix RPC is genuinely missing (true migration gap). */
  migrationMissing?: boolean;
}

/** Persist permission overrides for a profile via the scoped RPC. */
export async function assignProfilePermissions(
  profileId: string,
  overrides: OverrideMap,
): Promise<AssignPermissionsResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };

  try {
    const { data, error } = await supabase.rpc('assign_profile_permissions', {
      p_profile_id: profileId,
      p_permissions: overrides,
    });
    if (error) {
      if (isMissingFunctionError(error)) return { ok: false, migrationMissing: true, error: 'MIGRATION_MISSING' };
      // A real RPC exists but failed for some other reason (RLS, bad args,
      // an unrelated runtime bug) — never misreport this as "migration missing".
      return { ok: false, migrationMissing: false, error: 'SAVE_FAILED' };
    }
    return data as AssignPermissionsResult;
  } catch {
    return { ok: false, error: 'NETWORK_ERROR' };
  }
}

/** Reset a profile's overrides back to its role defaults. */
export async function resetProfilePermissions(profileId: string): Promise<{ ok: boolean; cleared?: number; error?: string; migrationMissing?: boolean }> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };

  try {
    const { data, error } = await supabase.rpc('reset_profile_permissions', { p_profile_id: profileId });
    if (error) {
      if (isMissingFunctionError(error)) return { ok: false, migrationMissing: true, error: 'MIGRATION_MISSING' };
      return { ok: false, migrationMissing: false, error: 'SAVE_FAILED' };
    }
    return data as { ok: boolean; cleared?: number };
  } catch {
    return { ok: false, error: 'NETWORK_ERROR' };
  }
}

// ── User creation (secure Edge Function path only) ───────────────────────────

export interface CreateUserInput {
  fullName: string;
  organizationId: string;
  role: OfficialRole;
  /** 'local' (default): username + temporary password, no email required.
   *  'email': real-email invite/password mode (secondary/advanced). */
  loginMode: 'local' | 'email';
  /** Required when loginMode === 'local'. Internal auth email is derived server-side. */
  username?: string;
  /** Required when loginMode === 'local'. Never logged or stored. */
  temporaryPassword?: string;
  /** Optional informational contact email for local accounts. Never used for login. */
  contactEmail?: string;
  /** Required when loginMode === 'email'. */
  email?: string;
  /** Mode 1: password provided → user can log in immediately.
   *  Mode 2: absent/empty → invite email attempted. Min 8 chars when provided.
   *  Only relevant when loginMode === 'email'. */
  password?: string;
}

export interface CreateUserResult {
  ok: boolean;
  userId?: string;
  invited?: boolean;
  /** True when user was created with an explicit password (can log in immediately). */
  passwordMode?: boolean;
  /** Echoes loginMode back so the UI can show the right success message. */
  loginMode?: 'local' | 'email';
  error?: string;
  /** True when the admin-create-user Edge Function is not deployed. */
  edgeMissing?: boolean;
}

/**
 * Create a user through the secure server-side Edge Function only.
 * The privileged server key NEVER touches the browser.
 * Temporary/explicit passwords are sent over HTTPS only to the Edge Function
 * and are never stored in the profiles table.
 */
export async function createUserViaEdge(input: CreateUserInput): Promise<CreateUserResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };

  try {
    const body: Record<string, string> = {
      full_name:       input.fullName,
      organization_id: input.organizationId,
      role:            input.role,
      login_mode:      input.loginMode,
    };
    if (input.loginMode === 'local') {
      if (input.username) body.username = input.username;
      if (input.temporaryPassword) body.temporary_password = input.temporaryPassword;
      if (input.contactEmail) body.contact_email = input.contactEmail;
    } else {
      if (input.email) body.email = input.email;
      // Include password only when the caller explicitly provides one.
      if (input.password) body.password = input.password;
    }

    const { data, error } = await supabase.functions.invoke('admin-create-user', { body });

    if (error) {
      return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };
    }

    const res = data as {
      ok: boolean; user_id?: string; invited?: boolean; password_mode?: boolean;
      login_mode?: 'local' | 'email'; error?: string;
    };
    if (!res) return { ok: false, error: 'UNKNOWN' };
    return {
      ok:           res.ok,
      userId:       res.user_id,
      invited:      res.invited,
      passwordMode: res.password_mode,
      loginMode:    res.login_mode,
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
  newRole: OfficialRole;
  newOrganizationId?: string;
  confirmation: string;
  /** 'local' (default): new username + temporary password, no email required.
   *  'email': real-email recycle (secondary/advanced) — generates a recovery link. */
  loginMode: 'local' | 'email';
  /** Required when loginMode === 'local'. */
  newUsername?: string;
  /** Required when loginMode === 'local'. Never logged, stored, or returned. */
  newTemporaryPassword?: string;
  /** Optional informational contact email for local accounts. Never used for login. */
  contactEmail?: string;
  /** Required when loginMode === 'email'. */
  newEmail?: string;
}

export interface RecycleUserResult {
  ok: boolean;
  targetProfileId?: string;
  newEmail?: string;
  newIdentityVersion?: number;
  passwordSetupStatus?: 'link_generated' | 'link_failed';
  /** Echoed back for local-mode recycles. */
  credentialMode?: 'local' | 'email';
  newUsername?: string;
  temporaryPasswordSet?: boolean;
  error?: string;
  edgeMissing?: boolean;
}

export async function recycleUserViaEdge(input: RecycleUserInput): Promise<RecycleUserResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };

  try {
    const body: Record<string, string> = {
      target_profile_id: input.targetProfileId,
      new_full_name:     input.newFullName,
      new_role:          input.newRole,
      confirmation:      input.confirmation,
      login_mode:        input.loginMode,
    };
    if (input.newOrganizationId) body.new_organization_id = input.newOrganizationId;
    if (input.loginMode === 'local') {
      if (input.newUsername) body.new_username = input.newUsername;
      if (input.newTemporaryPassword) body.new_temporary_password = input.newTemporaryPassword;
      if (input.contactEmail) body.contact_email = input.contactEmail;
    } else {
      if (input.newEmail) body.new_email = input.newEmail;
    }

    const { data, error } = await supabase.functions.invoke('admin-recycle-user', { body });

    if (error) return { ok: false, edgeMissing: true, error: 'EDGE_NOT_DEPLOYED' };

    const res = data as {
      ok: boolean;
      target_profile_id?: string;
      new_email?: string;
      new_identity_version?: number;
      password_setup_status?: 'link_generated' | 'link_failed';
      credential_mode?: 'local' | 'email';
      new_username?: string;
      temporary_password_set?: boolean;
      error?: string;
    };
    if (!res) return { ok: false, error: 'UNKNOWN' };
    return {
      ok:                   res.ok,
      targetProfileId:      res.target_profile_id,
      newEmail:             res.new_email,
      newIdentityVersion:   res.new_identity_version,
      passwordSetupStatus:  res.password_setup_status,
      credentialMode:       res.credential_mode,
      newUsername:          res.new_username,
      temporaryPasswordSet: res.temporary_password_set,
      error:                res.error,
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
