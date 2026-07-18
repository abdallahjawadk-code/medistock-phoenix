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
//   POST { full_name, organization_id, role, login_mode, ... }  (Bearer = caller JWT)
//   - Caller must be authenticated.
//   - super_admin: may create any official role in any organization.
//   - institution_admin: may create warehouse_officer/port_officer/
//     monthly_status_officer/viewer in own org only (requires users.create).
//   - Non-super: may create users ONLY if they hold users.create AND only in
//     their own organization; may NOT create super_admin or institution_admin.
//   - Only super_admin may create super_admin or institution_admin.
//   - Official roles only.
//
//   login_mode = 'local' (default, LOCAL-CREDENTIALS-MODE-A):
//     { username, temporary_password, contact_email? }
//     - No real email required. Auth identifier is synthesized as
//       <username>@local.medistock.invalid (never deliverable, never shown
//       to the user as a contact address).
//     - email_confirm is always true (no email to confirm/deliver).
//     - No invite email is ever attempted for local accounts.
//     - profiles.must_change_password is set true.
//
//   login_mode = 'email' (secondary/advanced, unchanged from prior behavior):
//     { email, password? }
//     - password provided → immediate-login mode (email_confirm true).
//     - password absent → invite-email mode (email_confirm false).
//
//   Returns structured JSON; never leaks raw service errors.
// =============================================================================

// @ts-nocheck — Deno edge runtime types are not part of the app's tsconfig.
// Updated: supports login_mode 'local' (username + temporary password) and
// 'email' (password or invite). Local mode never depends on SMTP delivery.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const LOCAL_AUTH_DOMAIN = 'local.medistock.invalid';
const USERNAME_PATTERN = /^[a-z0-9._-]{3,32}$/;

const OFFICIAL_ROLES = [
  'super_admin',
  'institution_admin',
  'central_warehouse_manager',
  'warehouse_officer',
  'outlet_officer',
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

  let body: {
    full_name?: string; organization_id?: string; role?: string; login_mode?: string;
    username?: string; temporary_password?: string; contact_email?: string;
    email?: string; password?: string;
  };
  try {
    body = await req.json();
  } catch {
    return json({ ok: false, error: 'BAD_REQUEST' }, 400);
  }

  const fullName  = (body.full_name ?? '').trim();
  const orgId     = body.organization_id ?? null;
  const role      = body.role ?? '';
  const loginMode = body.login_mode === 'email' ? 'email' : 'local'; // default: local

  if (!fullName || !orgId) return json({ ok: false, error: 'MISSING_FIELDS' }, 400);
  if (!OFFICIAL_ROLES.includes(role)) return json({ ok: false, error: 'INVALID_ROLE' }, 400);

  // ── Resolve identity fields per mode ───────────────────────────────────────
  let username = '';
  let temporaryPassword = ''; // never logged or stored in profile
  let contactEmail = '';
  let email = '';
  let password = ''; // optional; not logged or stored in profile

  if (loginMode === 'local') {
    username = (body.username ?? '').trim().toLowerCase();
    temporaryPassword = (body.temporary_password ?? '').trim();
    contactEmail = (body.contact_email ?? '').trim();
    if (!username || !temporaryPassword) return json({ ok: false, error: 'MISSING_FIELDS' }, 400);
    if (!USERNAME_PATTERN.test(username)) return json({ ok: false, error: 'INVALID_USERNAME' }, 400);
    if (temporaryPassword.length < 8) return json({ ok: false, error: 'PASSWORD_TOO_SHORT' }, 400);
    email = `${username}@${LOCAL_AUTH_DOMAIN}`;
  } else {
    email = (body.email ?? '').trim();
    password = (body.password ?? '').trim();
    if (!email) return json({ ok: false, error: 'MISSING_FIELDS' }, 400);
  }

  // Resolve caller profile (role + org) with the privileged client.
  const { data: callerProfile } = await admin
    .from('profiles')
    .select('role, organization_id')
    .eq('id', callerId)
    .single();
  if (!callerProfile) return json({ ok: false, error: 'ACTOR_PROFILE_NOT_FOUND' }, 403);

  const isSuper = callerProfile.role === 'super_admin';

  // Only super_admin may create platform, institution-admin, or central-
  // warehouse-manager identities. Operational institution/outlet roles remain
  // subject to users.create and the organization boundary below.
  if (role === 'super_admin' && !isSuper) {
    return json({ ok: false, error: 'CANNOT_CREATE_SUPER_ADMIN' }, 403);
  }
  if (role === 'institution_admin' && !isSuper) {
    return json({ ok: false, error: 'CANNOT_CREATE_INSTITUTION_ADMIN' }, 403);
  }
  if (role === 'central_warehouse_manager' && !isSuper) {
    return json({ ok: false, error: 'CANNOT_CREATE_CENTRAL_WAREHOUSE_MANAGER' }, 403);
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

  // passwordMode: local accounts always log in immediately (no email to confirm).
  // Email-mode accounts use Mode 1 (password) or Mode 2 (invite) as before.
  const passwordMode = loginMode === 'local' || password.length >= 8;
  if (loginMode === 'email' && body.password !== undefined && password.length > 0 && password.length < 8) {
    // Password was supplied but is too short — reject before creating anything.
    return json({ ok: false, error: 'PASSWORD_TOO_SHORT' }, 400);
  }

  // Create the auth user.
  // Local mode: email_confirm always true (synthetic email, nothing to confirm).
  // Email Mode 1 (password provided): user can log in immediately; email auto-confirmed.
  // Email Mode 2 (no password): email not confirmed; invite email attempted below.
  const createParams: Record<string, unknown> = {
    email,
    email_confirm: passwordMode,
    user_metadata: { full_name: fullName },
  };
  if (loginMode === 'local') createParams.password = temporaryPassword;
  else if (passwordMode) createParams.password = password;

  const { data: created, error: createErr } = await admin.auth.admin.createUser(createParams);
  if (createErr || !created?.user) {
    // Do not leak raw provider errors to the UI.
    return json({ ok: false, error: 'CREATE_AUTH_USER_FAILED' }, 400);
  }
  const newId = created.user.id;

  // Create / upsert the matching profile row (password never stored here).
  const profileRow: Record<string, unknown> = {
    id: newId, organization_id: orgId, full_name: fullName, role, status: 'active',
    login_mode: loginMode,
  };
  if (loginMode === 'local') {
    profileRow.username = username;
    profileRow.contact_email = contactEmail || null;
    profileRow.must_change_password = true;
  }
  const { error: profileErr } = await admin.from('profiles').upsert(profileRow);
  if (profileErr) {
    // Roll back the orphan auth user to keep state consistent.
    await admin.auth.admin.deleteUser(newId);
    return json({ ok: false, error: 'CREATE_PROFILE_FAILED' }, 400);
  }

  // Invite email only in email-mode Mode 2 (no password). Local accounts never
  // get an invite — there is no deliverable mailbox to send it to.
  let invited = false;
  if (loginMode === 'email' && !passwordMode) {
    try {
      const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email);
      invited = !inviteErr;
    } catch {
      invited = false;
    }
  }

  return json({ ok: true, user_id: newId, role, invited, password_mode: passwordMode, login_mode: loginMode });
});
