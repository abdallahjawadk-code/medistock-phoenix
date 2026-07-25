// =============================================================================
// MediStock Phoenix V2 — Edge Function: admin-create-user
//
// Secure server-side user creation. The service_role key lives ONLY here.
//
// SECURITY-ARCH-HARDENING-A (D1 + D2):
//   The profile row is no longer written directly. After the Auth user is
//   created, the profile is provisioned through phoenix_provision_profile
//   (migration 093), called with the CALLER's JWT so the contract re-derives
//   authority from auth.uid() and is the single source of truth for who may
//   create which role in which organization. Authorization/existence denials
//   return a generic REQUEST_DENIED (the real reason is logged server-side with
//   the request's correlation id); if the contract denies, the orphan Auth user
//   is rolled back. Input validation (role/username/password shape) stays here.
//
// Contract (unchanged wire shape):
//   POST { full_name, organization_id, role, login_mode, ... }  (Bearer = caller JWT)
// =============================================================================

// @ts-nocheck — Deno edge runtime types are not part of the app's tsconfig.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const LOCAL_AUTH_DOMAIN = 'local.medistock.invalid';
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

const OFFICIAL_ROLES = [
  'super_admin',
  'institution_admin',
  'central_warehouse_manager',
  'warehouse_officer',
  'outlet_officer',
];

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

  const url = Deno.env.get('SUPABASE_URL');
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ ok: false, error: 'NOT_CONFIGURED' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ ok: false, error: 'NOT_AUTHENTICATED' }, 401);

  const correlationId = req.headers.get('x-correlation-id') || crypto.randomUUID();

  // Caller-scoped client → the provision RPC sees auth.uid() = the acting admin.
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  // Privileged client → Auth Admin user creation only.
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'NOT_AUTHENTICATED', correlation_id: correlationId }, 401);

  let body: {
    full_name?: string; organization_id?: string; role?: string; login_mode?: string;
    username?: string; temporary_password?: string; contact_email?: string;
    email?: string; password?: string;
  };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST', correlation_id: correlationId }, 400); }

  const fullName  = (body.full_name ?? '').trim();
  const orgId     = body.organization_id ?? null;
  const role      = body.role ?? '';
  const loginMode = body.login_mode === 'email' ? 'email' : 'local';

  if (!fullName || !orgId) return json({ ok: false, error: 'MISSING_FIELDS', correlation_id: correlationId }, 400);
  if (!OFFICIAL_ROLES.includes(role)) return json({ ok: false, error: 'INVALID_ROLE', correlation_id: correlationId }, 400);

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

  // Authority PRE-CHECK (reads only; no profile mutation). Create has no
  // existence-oracle surface (there is no pre-existing target) and no
  // last-super-admin invariant, so it keeps its distinct, actionable role
  // messages for the admin UI. The authoritative gate is still server-side:
  // phoenix_provision_profile re-verifies all of this before writing.
  const { data: callerProfile } = await admin
    .from('profiles').select('role, organization_id').eq('id', userData.user.id).single();
  if (!callerProfile) return json({ ok: false, error: 'ACTOR_PROFILE_NOT_FOUND', correlation_id: correlationId }, 403);
  const isSuper = callerProfile.role === 'super_admin';
  if (role === 'super_admin' && !isSuper)              return json({ ok: false, error: 'CANNOT_CREATE_SUPER_ADMIN', correlation_id: correlationId }, 403);
  if (role === 'institution_admin' && !isSuper)        return json({ ok: false, error: 'CANNOT_CREATE_INSTITUTION_ADMIN', correlation_id: correlationId }, 403);
  if (role === 'central_warehouse_manager' && !isSuper) return json({ ok: false, error: 'CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER', correlation_id: correlationId }, 403);
  if (!isSuper) {
    const { data: canCreate } = await admin.rpc('phoenix_profile_has_permission', {
      p_profile_id: userData.user.id, p_key: 'users.create',
    });
    if (canCreate !== true) return json({ ok: false, error: 'INSUFFICIENT_PERMISSION', correlation_id: correlationId }, 403);
    if (orgId !== callerProfile.organization_id) return json({ ok: false, error: 'CROSS_ORG_FORBIDDEN', correlation_id: correlationId }, 403);
  }

  // Create the Auth user first (so we have its id for the profile).
  const createParams: Record<string, unknown> = {
    email,
    email_confirm: passwordMode,
    user_metadata: { full_name: fullName },
  };
  if (loginMode === 'local') createParams.password = temporaryPassword;
  else if (passwordMode) createParams.password = password;

  const { data: created, error: createErr } = await admin.auth.admin.createUser(createParams);
  if (createErr || !created?.user) {
    return json({ ok: false, error: 'CREATE_AUTH_USER_FAILED', correlation_id: correlationId }, 400);
  }
  const newId = created.user.id;

  // Provision the profile through the atomic contract (authority re-checked
  // server-side). No direct profile write happens in this function.
  const { data: prov, error: provErr } = await caller.rpc('phoenix_provision_profile', {
    p_new_id: newId,
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
    await admin.auth.admin.deleteUser(newId);
    const code = prov?.error ?? 'CREATE_PROFILE_FAILED';
    const status = code === 'REQUEST_DENIED' ? 403 : 400;
    return json({ ok: false, error: code, correlation_id: prov?.correlation_id ?? correlationId }, status);
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
  });
});
