// =============================================================================
// MediStock Phoenix V2 — Edge Function: admin-create-user
//
// Secure server-side user creation. Privileged access uses a server-only
// modern secret key resolved from SUPABASE_SECRET_KEYS.
//
// SECURE-USER-PROVISIONING-146:
//   After Auth Admin creates a user, the auth trigger creates a fail-closed
//   outlet_officer placeholder. The profile is then converted exactly once by
//   phoenix_admin_provision_profile (migration 146), called through the
//   privileged server client.
//   The database contract re-derives the acting administrator's status, role,
//   permissions and organization scope, and accepts only a fresh placeholder
//   bound to an unguessable Auth app-metadata nonce. The legacy authenticated
//   UPSERT contract is revoked. If provisioning is denied, the orphan Auth user
//   is rolled back and rollback failure is surfaced with a correlation id.
//   Input validation (role/username/password shape) remains here.
//
// Contract (unchanged wire shape):
//   POST { full_name, organization_id, role, login_mode, ... }  (Bearer = caller JWT)
// =============================================================================

// @ts-nocheck — Deno edge runtime types are not part of the app's tsconfig.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  parseBearerAuthorization,
  resolveEdgeApiKeys,
} from '../_shared/edge-auth.ts';

const LOCAL_AUTH_DOMAIN = 'local.medistock.invalid';
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const OFFICIAL_ROLES = [
  'super_admin',
  'institution_admin',
  'central_warehouse_manager',
  'warehouse_officer',
  'outlet_officer',
  'health_center_manager',
];

// R1.1-U: roles that are meaningless without at least one facility assignment.
const FACILITY_SCOPED_ROLES = ['health_center_manager'];
// A defensive upper bound only; the database applies the same limit.
const MAX_FACILITY_IDS = 64;

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-correlation-id',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: CORS });
  if (req.method !== 'POST') return json({ ok: false, error: 'METHOD_NOT_ALLOWED' }, 405);

  const authHeader = parseBearerAuthorization(req.headers.get('Authorization'));
  if (!authHeader) return json({ ok: false, error: 'NOT_AUTHENTICATED' }, 401);

  const url = Deno.env.get('SUPABASE_URL');
  let apiKeys: { secretKey: string; publishableKey: string };
  try {
    apiKeys = resolveEdgeApiKeys();
  } catch {
    return json({ ok: false, error: 'NOT_CONFIGURED' }, 500);
  }
  if (!url) return json({ ok: false, error: 'NOT_CONFIGURED' }, 500);

  const suppliedCorrelationId = (req.headers.get('x-correlation-id') ?? '').trim();
  const correlationId = UUID_PATTERN.test(suppliedCorrelationId)
    ? suppliedCorrelationId
    : crypto.randomUUID();
  const provisioningNonce = crypto.randomUUID();

  // Caller-scoped client → verifies the presented JWT belongs to a real user.
  const caller = createClient(url, apiKeys.publishableKey, {
    global: { headers: { Authorization: authHeader } },
  });
  // Privileged client → Auth Admin operations + the service-only provisioning
  // contract. The service key is never sent to the browser.
  const admin = createClient(url, apiKeys.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'NOT_AUTHENTICATED', correlation_id: correlationId }, 401);

  let body: {
    full_name?: string; organization_id?: string; role?: string; login_mode?: string;
    username?: string; temporary_password?: string; contact_email?: string;
    email?: string; password?: string; facility_ids?: unknown;
  };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST', correlation_id: correlationId }, 400); }

  const fullName  = (body.full_name ?? '').trim();
  const orgId     = body.organization_id ?? null;
  const role      = body.role ?? '';
  const loginMode = body.login_mode === 'email' ? 'email' : 'local';

  if (!fullName || !orgId) return json({ ok: false, error: 'MISSING_FIELDS', correlation_id: correlationId }, 400);
  if (!OFFICIAL_ROLES.includes(role)) return json({ ok: false, error: 'INVALID_ROLE', correlation_id: correlationId }, 400);

  // ── R1.1-U facility scope: SHAPE validation only ────────────────────────────
  // The browser's facility ids are never trusted as authorization. Every id is
  // re-validated inside phoenix_admin_assign_facility_scopes against the target
  // profile's own organization, and the whole set is written or none of it is.
  const requiresFacilityScope = FACILITY_SCOPED_ROLES.includes(role);
  let facilityIds: string[] = [];
  if (requiresFacilityScope) {
    const raw = body.facility_ids;
    if (!Array.isArray(raw) || raw.length === 0) {
      return json({ ok: false, error: 'FACILITY_SCOPE_REQUIRED', correlation_id: correlationId }, 400);
    }
    if (raw.length > MAX_FACILITY_IDS) {
      return json({ ok: false, error: 'FACILITY_SCOPE_TOO_LARGE', correlation_id: correlationId }, 400);
    }
    if (!raw.every(id => typeof id === 'string' && UUID_PATTERN.test(id))) {
      return json({ ok: false, error: 'FACILITY_SCOPE_INVALID', correlation_id: correlationId }, 400);
    }
    // Deterministic de-duplication, so a repeated id is not an error.
    facilityIds = [...new Set(raw as string[])];
  } else if (body.facility_ids !== undefined) {
    // A role that does not use facility scope must not smuggle assignments in.
    return json({ ok: false, error: 'FACILITY_SCOPE_NOT_APPLICABLE', correlation_id: correlationId }, 400);
  }

  // ── Resolve identity fields per mode (input validation only) ────────────────
  let username = '';
  let temporaryPassword = '';
  let contactEmail = '';
  let email = '';
  let password = '';

  if (loginMode === 'local') {
    username = (body.username ?? '').trim().toLowerCase();
    temporaryPassword = (body.temporary_password ?? '').trim();
    contactEmail = (body.contact_email ?? '').trim();
    if (!username || !temporaryPassword) return json({ ok: false, error: 'MISSING_FIELDS', correlation_id: correlationId }, 400);
    if (!USERNAME_PATTERN.test(username)) return json({ ok: false, error: 'INVALID_USERNAME', correlation_id: correlationId }, 400);
    if (temporaryPassword.length < 8) return json({ ok: false, error: 'PASSWORD_TOO_SHORT', correlation_id: correlationId }, 400);
    email = `${username}@${LOCAL_AUTH_DOMAIN}`;
  } else {
    email = (body.email ?? '').trim();
    password = (body.password ?? '').trim();
    if (!email) return json({ ok: false, error: 'MISSING_FIELDS', correlation_id: correlationId }, 400);
    if (body.password !== undefined && password.length > 0 && password.length < 8) {
      return json({ ok: false, error: 'PASSWORD_TOO_SHORT', correlation_id: correlationId }, 400);
    }
  }

  const passwordMode = loginMode === 'local' || password.length >= 8;

  // Authority PRE-CHECK (reads only; no profile mutation). The authoritative
  // gate is still the database contract, which repeats every check.
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role, organization_id, status')
    .eq('id', userData.user.id)
    .single();
  if (!callerProfile) return json({ ok: false, error: 'ACTOR_PROFILE_NOT_FOUND', correlation_id: correlationId }, 403);
  if (callerProfile.status !== 'active') {
    return json({ ok: false, error: 'ACTOR_NOT_ACTIVE', correlation_id: correlationId }, 403);
  }
  const isSuper = callerProfile.role === 'super_admin';
  const isInstitutionAdmin = callerProfile.role === 'institution_admin';
  if (!isSuper && !isInstitutionAdmin) {
    return json({ ok: false, error: 'INSUFFICIENT_PERMISSION', correlation_id: correlationId }, 403);
  }
  if (role === 'super_admin' && !isSuper)              return json({ ok: false, error: 'CANNOT_CREATE_SUPER_ADMIN', correlation_id: correlationId }, 403);
  if (role === 'institution_admin' && !isSuper)        return json({ ok: false, error: 'CANNOT_CREATE_INSTITUTION_ADMIN', correlation_id: correlationId }, 403);
  if (role === 'central_warehouse_manager' && !isSuper) return json({ ok: false, error: 'CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER', correlation_id: correlationId }, 403);
  if (!isSuper) {
    const [{ data: canCreate, error: createPermissionError }, { data: canAssign, error: assignPermissionError }] =
      await Promise.all([
        admin.rpc('phoenix_profile_has_permission', {
          p_profile_id: userData.user.id, p_key: 'users.create',
        }),
        admin.rpc('phoenix_profile_has_permission', {
          p_profile_id: userData.user.id, p_key: 'users.assign_role',
        }),
      ]);
    if (createPermissionError || assignPermissionError || canCreate !== true || canAssign !== true) {
      return json({ ok: false, error: 'INSUFFICIENT_PERMISSION', correlation_id: correlationId }, 403);
    }
    if (orgId !== callerProfile.organization_id) return json({ ok: false, error: 'CROSS_ORG_FORBIDDEN', correlation_id: correlationId }, 403);
  }

  // Create the Auth user first (so we have its id for the profile).
  const createParams: Record<string, unknown> = {
    email,
    email_confirm: passwordMode,
    user_metadata: { full_name: fullName },
    app_metadata: {
      phoenix_provisioning_nonce: provisioningNonce,
      phoenix_provisioning_actor_id: userData.user.id,
    },
  };
  if (loginMode === 'local') createParams.password = temporaryPassword;
  else if (passwordMode) createParams.password = password;

  const { data: created, error: createErr } = await admin.auth.admin.createUser(createParams);
  if (createErr || !created?.user) {
    return json({ ok: false, error: 'CREATE_AUTH_USER_FAILED', correlation_id: correlationId }, 400);
  }
  const newId = created.user.id;

  // Convert only the fresh auth-trigger placeholder through the service-only
  // atomic contract. No direct profile write happens in this function.
  const { data: prov, error: provErr } = await admin.rpc('phoenix_admin_provision_profile', {
    p_actor_id: userData.user.id,
    p_new_id: newId,
    p_provisioning_nonce: provisioningNonce,
    p_organization_id: orgId,
    p_full_name: fullName,
    p_role: role,
    p_login_mode: loginMode,
    p_username: loginMode === 'local' ? username : null,
    p_contact_email: loginMode === 'local' ? (contactEmail || null) : null,
    p_correlation_id: correlationId,
  });
  if (provErr || !prov?.ok) {
    // Roll back the orphan Auth user so no half-provisioned identity survives.
    const { error: rollbackErr } = await admin.auth.admin.deleteUser(newId);
    if (rollbackErr) {
      // Never log the password, email or service key. The correlation id lets
      // an operator find the Auth row through its provisioning app metadata.
      console.error(JSON.stringify({
        event: 'admin-create-user.rollback-failed',
        correlation_id: correlationId,
      }));
      return json({
        ok: false,
        error: 'ROLLBACK_FAILED',
        correlation_id: correlationId,
      }, 500);
    }
    const code = prov?.error ?? 'CREATE_PROFILE_FAILED';
    const status = code === 'REQUEST_DENIED' ? 403 : 400;
    return json({ ok: false, error: code, correlation_id: prov?.correlation_id ?? correlationId }, status);
  }

  // ── R1.1-U: facility scope, all-or-nothing, with the SAME rollback contract ──
  // Auth Admin createUser cannot join this PostgreSQL transaction, so a
  // facility-scoped identity is only safe if the assignment set either lands
  // completely or the Auth user is removed. phoenix_admin_assign_facility_scopes
  // validates every id before writing any row, so there is no partial DB state
  // to unwind — only the Auth user, exactly as the provisioning failure path
  // above already does.
  if (requiresFacilityScope) {
    const { data: scopes, error: scopeErr } = await admin.rpc('phoenix_admin_assign_facility_scopes', {
      p_actor_id: userData.user.id,
      p_profile_id: newId,
      p_facility_ids: facilityIds,
    });
    if (scopeErr || !scopes?.ok) {
      const { error: rollbackErr } = await admin.auth.admin.deleteUser(newId);
      if (rollbackErr) {
        console.error(JSON.stringify({
          event: 'admin-create-user.facility-scope-rollback-failed',
          correlation_id: correlationId,
        }));
        return json({ ok: false, error: 'ROLLBACK_FAILED', correlation_id: correlationId }, 500);
      }
      // The DB message is not echoed verbatim: it can name facilities the caller
      // may not be allowed to learn about. The correlation id ties this to the
      // audit trail.
      return json({
        ok: false,
        error: 'FACILITY_SCOPE_ASSIGNMENT_FAILED',
        correlation_id: correlationId,
      }, 400);
    }
  }

  // Invite email only in email-mode Mode 2 (no password).
  let invited = false;
  if (loginMode === 'email' && !passwordMode) {
    try {
      const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
      invited = !inviteErr;
    } catch { invited = false; }
  }

  return json({
    ok: true, user_id: newId, role, invited, password_mode: passwordMode,
    login_mode: loginMode, correlation_id: correlationId,
    facility_scope_count: requiresFacilityScope ? facilityIds.length : 0,
  });
});
