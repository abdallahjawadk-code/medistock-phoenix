// =============================================================================
// MediStock Phoenix V2 — Edge Function: admin-create-user
//
// Secure server-side user creation. The service_role key lives ONLY here, in
// the Deno edge runtime — it must NEVER appear in the frontend bundle.
//
// Deploy (manual, when ready):
//   supabase functions deploy admin-create-user
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...   (URL/ANON are provided)
//
// Contract:
//   POST { full_name, email, organization_id, role }  (Bearer = caller JWT)
//   - Caller must be authenticated.
//   - super_admin: may create any official role in any organization.
//   - Non-super: may create users ONLY if they hold users.create AND only in
//     their own organization; may NOT create super_admin.
//   - Only super_admin may create super_admin.
//   - Official roles only.
//   Returns structured JSON; never leaks raw service errors.
// =============================================================================

// @ts-nocheck — Deno edge runtime types are not part of the app's tsconfig.
// Updated: supports optional password field (Mode 1) or invite-only (Mode 2).
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const OFFICIAL_ROLES = [
  'super_admin',
  'warehouse_officer',
  'port_officer',
  'monthly_status_officer',
  'viewer',
];

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
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

  // Caller-scoped client (RLS applies) — to resolve the caller identity.
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  // Privileged client — server-only admin operations.
  const admin = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'NOT_AUTHENTICATED' }, 401);
  const callerId = userData.user.id;

  let body: { full_name?: string; email?: string; organization_id?: string; role?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  }

  const fullName  = (body.full_name ?? '').trim();
  const email     = (body.email ?? '').trim();
  const orgId     = body.organization_id ?? null;
  const role      = body.role ?? '';
  const password  = (body.password ?? '').trim();  // optional; not logged or stored in profile

  if (!fullName || !email || !orgId) return json({ ok: false, error: 'MISSING_FIELDS' }, 400);
  if (!OFFICIAL_ROLES.includes(role)) return json({ ok: false, error: 'INVALID_ROLE' }, 400);

  // Resolve caller profile (role + org) with the privileged client.
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role, organization_id')
    .eq('id', callerId)
    .single();
  if (!callerProfile) return json({ ok: false, error: 'ACTOR_PROFILE_NOT_FOUND' }, 403);

  const isSuper = callerProfile.role === 'super_admin';

  // Only super_admin may create super_admin.
  if (role === 'super_admin' && !isSuper) {
    return json({ ok: false, error: 'CANNOT_CREATE_SUPER_ADMIN' }, 403);
  }

  if (!isSuper) {
    // Must hold users.create (effective permission) and stay in own org.
    const { data: canCreate } = await admin.rpc('phoenix_profile_has_permission', {
      p_profile_id: callerId,
      p_key: 'users.create',
    });
    if (canCreate !== true) return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
    if (orgId !== callerProfile.organization_id) {
      return json({ ok: false, error: 'CROSS_ORG_FORBIDDEN' }, 403);
    }
  }

  const passwordMode = password.length >= 8;
  if (body.password !== undefined && !passwordMode) {
    // Password was supplied but is too short — reject before creating anything.
    return json({ ok: false, error: 'PASSWORD_TOO_SHORT' }, 400);
  }

  // Create the auth user.
  // Mode 1 (password provided): user can log in immediately; email is auto-confirmed.
  // Mode 2 (no password): email not confirmed; invite email attempted below.
  const createParams: Record<string, unknown> = {
    email,
    email_confirm: passwordMode,
    user_metadata: { full_name: fullName },
  };
  if (passwordMode) createParams.password = password;

  const { data: created, error: createErr } = await admin.auth.admin.createUser(createParams);
  if (createErr || !created?.user) {
    // Do not leak raw provider errors to the UI.
    return json({ ok: false, error: 'CREATE_AUTH_USER_FAILED' }, 400);
  }
  const newId = created.user.id;

  // Create / upsert the matching profile row (password never stored here).
  const { error: profileErr } = await admin
    .from('profiles')
    .upsert({ id: newId, organization_id: orgId, full_name: fullName, role, status: 'active' });
  if (profileErr) {
    // Roll back the orphan auth user to keep state consistent.
    await admin.auth.admin.deleteUser(newId);
    return json({ ok: false, error: 'CREATE_PROFILE_FAILED' }, 400);
  }

  // Invite email only in Mode 2 (no password). Best-effort, non-fatal.
  let invited = false;
  if (!passwordMode) {
    try {
      const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
      invited = !inviteErr;
    } catch {
      invited = false;
    }
  }

  return json({ ok: true, user_id: newId, role, invited, password_mode: passwordMode });
});
