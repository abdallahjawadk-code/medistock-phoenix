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

interface RpcErrorLike { code?: string; message?: string; details?: string; hint?: string }

/**
 * Logs the real Postgrest/Postgres error signature for a failed RPC call —
 * developer diagnostics only, never shown to the end user. Safe to log:
 * these are structural error fields (code/message/details/hint) describing
 * *why the call failed*, never the request payload, permission values, or
 * any credential material (PERMISSION-SAVE-RPC-DIAGNOSTIC-FIX-A).
 */
function logRpcDiagnostic(rpcName: string, error: RpcErrorLike): void {
  console.error(`[phoenix] ${rpcName} RPC failed:`, {
    code: error.code, message: error.message, details: error.details, hint: error.hint,
  });
}

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
      logRpcDiagnostic('get_effective_permissions', error);
      return { permissions: null, migrationMissing: false, loadError: 'UNKNOWN_ERROR' };
    }

    const res = data as { ok: boolean; permissions?: Record<string, boolean>; error?: string };
    if (!res?.ok) return { permissions: null, migrationMissing: false };
    return { permissions: res.permissions ?? {}, migrationMissing: false };
  } catch {
    return { permissions: null, migrationMissing: false, loadError: 'NETWORK_ERROR' };
  }
}

// ── Permission save diagnostics (PERMISSION-RPC-CONTRACT-FIX-B) ─────────────
//
// assign_profile_permissions(p_profile_id uuid, p_permissions jsonb) expects
// p_permissions as a FLAT jsonb object keyed by permission key string,
// e.g. { "users.recycle": true, "qr.revoke": null } — exactly what
// OverrideMap already is. There is no separate "key"/"permission_key" field
// name to get wrong; the object's own keys ARE the permission keys. The
// payload/argument-name contract was re-verified against migration 010 and
// is correct. This diagnostics layer exists so that if a save still fails
// for an unrecognized reason, the real Postgrest error code/message and the
// RPC's own business-logic response are captured and (safely) surfaced,
// instead of being silently collapsed into a single generic message.

export interface PermissionSaveDiagnostics {
  ok: boolean;
  status: 'SUCCESS' | 'RPC_ERROR' | 'BUSINESS_REJECTED' | 'PARTIAL_REJECTED' | 'NETWORK_ERROR' | 'NOT_CONFIGURED';
  /** The single most specific token available — shown to the user as a last-resort diagnostic code. */
  diagnostic_code: string;
  rpc_error_code?: string;
  rpc_error_message?: string;
  returned_error?: string;
  rejected_codes?: string[];
  rejected_keys?: string[];
  target_profile_id: string;
  payload_key_count: number;
  /** Only set when the caller supplies it — never inferred here. */
  actor_has_users_manage_permissions?: boolean;
}

function buildSaveDiagnostics(params: {
  status: PermissionSaveDiagnostics['status'];
  targetProfileId: string;
  payloadKeyCount: number;
  rpcError?: RpcErrorLike;
  returnedError?: string;
  rejected?: { key: string; error: string }[];
  actorHasManagePermissions?: boolean;
}): PermissionSaveDiagnostics {
  const rejected_codes = params.rejected?.map(r => r.error);
  const rejected_keys = params.rejected?.map(r => r.key);
  const diagnostic_code =
    params.rpcError?.code ?? params.returnedError ?? rejected_codes?.[0] ?? 'SUCCESS';
  return {
    ok: params.status === 'SUCCESS',
    status: params.status,
    diagnostic_code,
    rpc_error_code: params.rpcError?.code,
    rpc_error_message: params.rpcError?.message,
    returned_error: params.returnedError,
    rejected_codes,
    rejected_keys,
    target_profile_id: params.targetProfileId,
    payload_key_count: params.payloadKeyCount,
    actor_has_users_manage_permissions: params.actorHasManagePermissions,
  };
}

export interface AssignPermissionsResult {
  ok: boolean;
  applied?: number;
  rejected?: { key: string; error: string }[];
  /** 'MIGRATION_MISSING' | 'SAVE_FAILED' | 'NETWORK_ERROR' | 'NOT_CONFIGURED' | an RPC business-logic error code. */
  error?: string;
  /** True only when the permission-matrix RPC is genuinely missing (true migration gap). */
  migrationMissing?: boolean;
  /** Structured, safe diagnostic detail — never secrets/tokens/passwords. */
  diagnostics?: PermissionSaveDiagnostics;
}

/**
 * Persist permission overrides for a profile via the scoped RPC.
 * `actorHasManagePermissions` is optional, frontend-supplied context (e.g.
 * `isSuper || myPermissions.has('users.manage_permissions')`) included only
 * in the returned diagnostics for troubleshooting — it never changes
 * behavior; the RPC remains the sole authority.
 */
export async function assignProfilePermissions(
  profileId: string,
  overrides: OverrideMap,
  actorHasManagePermissions?: boolean,
): Promise<AssignPermissionsResult> {
  const payloadKeyCount = Object.keys(overrides).length;
  if (!supabaseConfigured) {
    return {
      ok: false, error: 'NOT_CONFIGURED',
      diagnostics: buildSaveDiagnostics({ status: 'NOT_CONFIGURED', targetProfileId: profileId, payloadKeyCount, actorHasManagePermissions }),
    };
  }

  try {
    const { data, error } = await supabase.rpc('assign_profile_permissions', {
      p_profile_id: profileId,
      p_permissions: overrides,
    });
    if (error) {
      if (isMissingFunctionError(error)) {
        return {
          ok: false, migrationMissing: true, error: 'MIGRATION_MISSING',
          diagnostics: buildSaveDiagnostics({ status: 'RPC_ERROR', targetProfileId: profileId, payloadKeyCount, rpcError: error, actorHasManagePermissions }),
        };
      }
      // A real RPC exists but failed for some other reason (RLS, bad args,
      // an ambiguous-overload dispatch error, an unrelated runtime bug) —
      // never misreport this as "migration missing". The exact Postgrest
      // code/message is preserved in diagnostics for troubleshooting.
      logRpcDiagnostic('assign_profile_permissions', error);
      return {
        ok: false, migrationMissing: false, error: 'SAVE_FAILED',
        diagnostics: buildSaveDiagnostics({ status: 'RPC_ERROR', targetProfileId: profileId, payloadKeyCount, rpcError: error, actorHasManagePermissions }),
      };
    }
    const result = data as AssignPermissionsResult;
    // Surface exactly which keys the RPC rejected and why — most useful for
    // UNKNOWN_PERMISSION, which signals a frontend/DB permission_keys catalog
    // mismatch (e.g. a key in PERMISSION_KEYS that a later migration never
    // inserted). Never blocks the response; diagnostics only.
    if (result.rejected && result.rejected.length > 0) {
      console.warn('[phoenix] assign_profile_permissions rejected keys:', result.rejected);
    }
    result.diagnostics = buildSaveDiagnostics({
      status: !result.ok
        ? 'BUSINESS_REJECTED'
        : (result.rejected && result.rejected.length > 0 ? 'PARTIAL_REJECTED' : 'SUCCESS'),
      targetProfileId: profileId,
      payloadKeyCount,
      returnedError: result.ok ? undefined : result.error,
      rejected: result.rejected,
      actorHasManagePermissions,
    });
    return result;
  } catch {
    return {
      ok: false, error: 'NETWORK_ERROR',
      diagnostics: buildSaveDiagnostics({ status: 'NETWORK_ERROR', targetProfileId: profileId, payloadKeyCount, actorHasManagePermissions }),
    };
  }
}

/** Reset a profile's overrides back to its role defaults. */
export async function resetProfilePermissions(
  profileId: string,
  actorHasManagePermissions?: boolean,
): Promise<{ ok: boolean; cleared?: number; error?: string; migrationMissing?: boolean; diagnostics?: PermissionSaveDiagnostics }> {
  if (!supabaseConfigured) {
    return {
      ok: false, error: 'NOT_CONFIGURED',
      diagnostics: buildSaveDiagnostics({ status: 'NOT_CONFIGURED', targetProfileId: profileId, payloadKeyCount: 0, actorHasManagePermissions }),
    };
  }

  try {
    const { data, error } = await supabase.rpc('reset_profile_permissions', { p_profile_id: profileId });
    if (error) {
      if (isMissingFunctionError(error)) {
        return {
          ok: false, migrationMissing: true, error: 'MIGRATION_MISSING',
          diagnostics: buildSaveDiagnostics({ status: 'RPC_ERROR', targetProfileId: profileId, payloadKeyCount: 0, rpcError: error, actorHasManagePermissions }),
        };
      }
      logRpcDiagnostic('reset_profile_permissions', error);
      return {
        ok: false, migrationMissing: false, error: 'SAVE_FAILED',
        diagnostics: buildSaveDiagnostics({ status: 'RPC_ERROR', targetProfileId: profileId, payloadKeyCount: 0, rpcError: error, actorHasManagePermissions }),
      };
    }
    const result = data as { ok: boolean; cleared?: number };
    return {
      ...result,
      diagnostics: buildSaveDiagnostics({
        status: result.ok ? 'SUCCESS' : 'BUSINESS_REJECTED',
        targetProfileId: profileId,
        payloadKeyCount: 0,
        returnedError: result.ok ? undefined : (result as { error?: string }).error,
        actorHasManagePermissions,
      }),
    };
  } catch {
    return {
      ok: false, error: 'NETWORK_ERROR',
      diagnostics: buildSaveDiagnostics({ status: 'NETWORK_ERROR', targetProfileId: profileId, payloadKeyCount: 0, actorHasManagePermissions }),
    };
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
 * Rotate an active user's password to a new admin-chosen/generated temporary
 * value, without touching their identity (name/username/role/org). Distinct
 * from recycleUserViaEdge, which requires the target to already be suspended
 * and reassigns their whole identity. The password is sent over HTTPS to the
 * Edge Function only — never logged, never stored, never echoed back (the
 * caller already has it, since they typed/generated it before calling this).
 */
export async function rotatePasswordViaEdge(targetUserId: string, newPassword: string): Promise<LifecycleResult> {
  return invokeLifecycle({ action: 'rotate_password', target_user_id: targetUserId, new_password: newPassword });
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

/**
 * UX-WHATSAPP-ALERT-CONTACT-WIRING-A: batched variant of getOrgStatusContacts
 * for multiple organization ids in one read (avoids N+1 queries when showing
 * a WhatsApp contact per inter-institution alert card). Same table, same
 * columns, same read-only PostgREST select — no new SQL/RPC/migration.
 *
 * RLS (migration 008) scopes direct table access to the caller's OWN
 * organization only, except super_admin who can read every organization's
 * contacts. For a non-super caller this means rows for any OTHER
 * organization id in `orgIds` are silently omitted by RLS (not an error) —
 * callers must treat a missing entry as "no contact available", never as a
 * bug, and never substitute a fake number.
 */
export async function getOrgStatusContactsForOrgs(orgIds: string[]): Promise<OrgContactRow[]> {
  if (!supabaseConfigured) return [];
  const ids = [...new Set(orgIds.filter(Boolean))];
  if (ids.length === 0) return [];
  try {
    const { data, error } = await supabase
      .from('organization_status_contacts')
      .select('id, organization_id, display_name, phone, is_primary, is_active')
      .in('organization_id', ids)
      .eq('is_active', true)
      .order('is_primary', { ascending: false });
    if (error) return [];
    return (data ?? []) as OrgContactRow[];
  } catch {
    return [];
  }
}
