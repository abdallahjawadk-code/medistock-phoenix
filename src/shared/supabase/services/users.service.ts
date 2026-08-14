import { FunctionsHttpError, FunctionsFetchError, FunctionsRelayError } from '@supabase/supabase-js';
import { supabase, supabaseConfigured } from '../client';
import type { OverrideMap } from '@/shared/lib/permissions';
import { isFacilityScopedRole, type OfficialRole } from '@/shared/lib/roles';

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

// ── Edge Function failure classification (USER-ACCOUNT-EDGE-ERROR-CLASSIFY-A) ─
//
// supabase-js reports EVERY non-2xx response from a DEPLOYED function as an
// `error` (FunctionsHttpError) — at a glance indistinguishable from a function
// that is genuinely not deployed (FunctionsFetchError / a bare platform 404).
// Earlier code collapsed BOTH into EDGE_NOT_DEPLOYED, which hid real, safe
// backend rejection codes: a 403 role/scope denial
// (CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER, CROSS_ORG_FORBIDDEN), a 400
// validation error, or a DB-constraint failure surfaced as
// CREATE_PROFILE_FAILED. That masking is exactly why a failing
// pharmacy-department (central_warehouse_manager) create/rotate looked like a
// deployment problem instead of the specific reason the server returned.
//
// These helpers separate the three real cases — unreachable / rejected /
// unknown — and stamp every attempt with a correlation id so an operator can
// match a failure to the server logs. Only structural, non-secret fields are
// ever read or surfaced; request payloads, passwords and tokens never are.

/** How an Edge Function attempt failed, without masking. */
export type EdgeOutcome = 'unreachable' | 'rejected' | 'unknown';

export interface EdgeFailure {
  outcome: EdgeOutcome;
  /** Safe, non-secret code: 'EDGE_NOT_DEPLOYED' | the function's own error code | 'UNKNOWN_ERROR'. */
  code: string;
  /** Optional safe message echoed from the function body (never secrets). */
  message?: string;
  /** HTTP status when the function actually responded. */
  status?: number;
  /** Correlation id for support/audit — never a secret. */
  correlationId: string;
}

/**
 * RFC-4122 id used to correlate a client attempt with server logs. Contains no
 * user data, credential material, or request content — safe to display/log.
 */
export function newCorrelationId(): string {
  try {
    const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (c?.randomUUID) return c.randomUUID();
  } catch { /* fall through to the non-crypto id */ }
  return `cid-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Classify a `supabase.functions.invoke` error WITHOUT masking. A DEPLOYED
 * function that returns a non-2xx arrives as FunctionsHttpError carrying the
 * original Response in `.context`; we read its safe JSON `error` code so the
 * caller can surface the true reason instead of a false "not deployed". A
 * genuine transport failure (offline/DNS/TLS) or a bare 404 with no JSON
 * contract is the only thing mapped to EDGE_NOT_DEPLOYED.
 */
export async function classifyEdgeError(error: unknown, correlationId: string): Promise<EdgeFailure> {
  // Genuinely unreachable: fetch-level failure (offline/DNS/TLS) or relay/edge routing.
  if (error instanceof FunctionsFetchError || error instanceof FunctionsRelayError) {
    return { outcome: 'unreachable', code: 'EDGE_NOT_DEPLOYED', correlationId };
  }

  // Deployed, but the function itself responded with a non-2xx status.
  if (error instanceof FunctionsHttpError) {
    const res = (error as { context?: Response }).context;
    const status = res?.status;
    let bodyCode: string | undefined;
    let message: string | undefined;
    if (res && typeof res.clone === 'function' && typeof res.json === 'function') {
      try {
        const body = (await res.clone().json()) as { error?: string; message?: string };
        if (typeof body?.error === 'string') bodyCode = body.error;
        if (typeof body?.message === 'string') message = body.message;
      } catch { /* non-JSON body — no safe code to extract */ }
    }
    // A parseable business error (e.g. TARGET_NOT_FOUND at 404, or a 403 role
    // denial) is always a real rejection. Only a bare 404 with no JSON contract
    // means the route/function is not actually there.
    if (bodyCode) return { outcome: 'rejected', code: bodyCode, message, status, correlationId };
    if (status === 404) return { outcome: 'unreachable', code: 'EDGE_NOT_DEPLOYED', status, correlationId };
    return { outcome: 'rejected', code: status ? `HTTP_${status}` : 'EDGE_REJECTED', message, status, correlationId };
  }

  // Anything else: an unexpected client-side throw or an unrecognised shape.
  return { outcome: 'unknown', code: 'UNKNOWN_ERROR', correlationId };
}

/** Shared, non-masking failure fields attached to every Edge account result. */
export interface EdgeResultMeta {
  /** True ONLY when the Edge Function is unreachable / not deployed. */
  edgeMissing?: boolean;
  /** True when a DEPLOYED function rejected the request (real code in `error`). */
  edgeRejected?: boolean;
  /** True on an unexpected client-side failure (distinct from the above). */
  unknownError?: boolean;
  /** Safe human message echoed from the function (never secrets). */
  errorMessage?: string;
  /** Correlation id stamped on every attempt for support/audit. */
  correlationId?: string;
}

/** Fold a classified EdgeFailure into the flat result-meta shape callers return. */
function edgeFailureMeta(f: EdgeFailure): EdgeResultMeta & { error: string } {
  return {
    error: f.code,
    errorMessage: f.message,
    edgeMissing: f.outcome === 'unreachable',
    edgeRejected: f.outcome === 'rejected',
    unknownError: f.outcome === 'unknown',
    correlationId: f.correlationId,
  };
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
  /**
   * R1.1-U — the health-centre facilities a FACILITY-SCOPED role is assigned to.
   *
   * Required, and non-empty, when `role` is facility-scoped
   * (see FACILITY_SCOPED_ROLES); rejected outright for every other role, so a
   * caller cannot smuggle assignments onto a role that does not use them.
   *
   * These ids are a REQUEST, never an authorization. The Edge function validates
   * only their shape; phoenix_admin_assign_facility_scopes re-validates every id
   * against the new profile's own organization and writes the whole set or none
   * of it, rolling the Auth user back if it cannot.
   */
  facilityIds?: string[];
}

export interface CreateUserResult extends EdgeResultMeta {
  ok: boolean;
  userId?: string;
  invited?: boolean;
  /** True when user was created with an explicit password (can log in immediately). */
  passwordMode?: boolean;
  /** Echoes loginMode back so the UI can show the right success message. */
  loginMode?: 'local' | 'email';
  error?: string;
}

/**
 * Create a user through the secure server-side Edge Function only.
 * The privileged server key NEVER touches the browser.
 * Temporary/explicit passwords are sent over HTTPS only to the Edge Function
 * and are never stored in the profiles table.
 */
export async function createUserViaEdge(input: CreateUserInput): Promise<CreateUserResult> {
  const correlationId = newCorrelationId();
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED', correlationId };

  try {
    const body: Record<string, string | string[]> = {
      full_name:       input.fullName,
      organization_id: input.organizationId,
      role:            input.role,
      login_mode:      input.loginMode,
    };
    // R1.1-U: send facility ids ONLY for a facility-scoped role, and only when
    // there are some. The Edge function rejects the field outright on any other
    // role, so this must not be sent speculatively.
    if (isFacilityScopedRole(input.role)) {
      const ids = [...new Set(input.facilityIds ?? [])].filter(Boolean);
      if (ids.length === 0) return { ok: false, error: 'FACILITY_SCOPE_REQUIRED', correlationId };
      body.facility_ids = ids;
    }
    if (input.loginMode === 'local') {
      if (input.username) body.username = input.username;
      if (input.temporaryPassword) body.temporary_password = input.temporaryPassword;
      if (input.contactEmail) body.contact_email = input.contactEmail;
    } else {
      if (input.email) body.email = input.email;
      // Include password only when the caller explicitly provides one.
      if (input.password) body.password = input.password;
    }

    const { data, error } = await supabase.functions.invoke('admin-create-user', {
      body,
      headers: { 'x-correlation-id': correlationId },
    });

    // Never collapse a deployed function's real rejection into "not deployed":
    // classify unreachable vs. rejected (safe code preserved) vs. unknown.
    if (error) return { ok: false, ...edgeFailureMeta(await classifyEdgeError(error, correlationId)) };

    const res = data as {
      ok: boolean; user_id?: string; invited?: boolean; password_mode?: boolean;
      login_mode?: 'local' | 'email'; error?: string;
    };
    if (!res) return { ok: false, error: 'UNKNOWN_ERROR', unknownError: true, correlationId };
    return {
      ok:           res.ok,
      userId:       res.user_id,
      invited:      res.invited,
      passwordMode: res.password_mode,
      loginMode:    res.login_mode,
      error:        res.error,
      correlationId,
    };
  } catch {
    // A throw here is an unexpected client-side failure — NOT proof the
    // function is undeployed. Surface it as its own honest state.
    return { ok: false, error: 'UNKNOWN_ERROR', unknownError: true, correlationId };
  }
}

// ── User lifecycle (disable / enable / delete via Edge Function) ──────────────

export interface LifecycleResult extends EdgeResultMeta {
  ok: boolean;
  action?: string;
  error?: string;
  /** rotate_password: whether prior sessions were revoked server-side. */
  sessions_revoked?: boolean;
  /** rotate_password: whether the target is forced to change password next login. */
  must_change_password?: boolean;
}

async function invokeLifecycle(payload: Record<string, string>): Promise<LifecycleResult> {
  const correlationId = newCorrelationId();
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED', correlationId };
  try {
    const { data, error } = await supabase.functions.invoke('admin-user-lifecycle', {
      body: payload,
      headers: { 'x-correlation-id': correlationId },
    });
    if (error) return { ok: false, ...edgeFailureMeta(await classifyEdgeError(error, correlationId)) };
    const res = data as LifecycleResult | null;
    if (!res) return { ok: false, error: 'UNKNOWN_ERROR', unknownError: true, correlationId };
    return { ...res, correlationId };
  } catch {
    return { ok: false, error: 'UNKNOWN_ERROR', unknownError: true, correlationId };
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
 * confirmation must equal 'DELETE_USER_<target-user-id>' (built by UI from data
 * already visible in the user list, never the target's Auth email; verified
 * server-side after authorization passes).
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

export interface RecycleUserResult extends EdgeResultMeta {
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
}

export async function recycleUserViaEdge(input: RecycleUserInput): Promise<RecycleUserResult> {
  const correlationId = newCorrelationId();
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED', correlationId };

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

    const { data, error } = await supabase.functions.invoke('admin-recycle-user', {
      body,
      headers: { 'x-correlation-id': correlationId },
    });

    if (error) return { ok: false, ...edgeFailureMeta(await classifyEdgeError(error, correlationId)) };

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
    if (!res) return { ok: false, error: 'UNKNOWN_ERROR', unknownError: true, correlationId };
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
      correlationId,
    };
  } catch {
    return { ok: false, error: 'UNKNOWN_ERROR', unknownError: true, correlationId };
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
