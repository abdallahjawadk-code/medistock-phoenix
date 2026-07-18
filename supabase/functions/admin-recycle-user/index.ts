// =============================================================================
// MediStock Phoenix V2 — Edge Function: admin-recycle-user
//
// Recycle a suspended user account: reassign their identity (name, email, role)
// and reactivate the account under a new identity version. The old identity is
// preserved in user_identity_history for audit purposes.
//
// The service_role key lives ONLY here in the Deno runtime — it must NEVER
// appear in the frontend bundle.
//
// Deploy:
//   supabase functions deploy admin-recycle-user --project-ref <ref>
//   (SUPABASE_SERVICE_ROLE_KEY is already set from admin-create-user deploy)
//
// Contract:
//   POST { target_profile_id, new_full_name, new_role, login_mode,
//          new_organization_id?, confirmation, ... }
//   Bearer = caller JWT
//
//   - Caller must be authenticated.
//   - Caller must be super_admin OR institution_admin (with users.recycle).
//   - Target must be suspended.
//   - Cannot recycle super_admin accounts.
//   - institution_admin: own org only; cannot recycle institution_admin targets;
//     cannot assign super_admin or institution_admin as new_role;
//     cannot change organization.
//   - confirmation must equal RECYCLE_USER_<target_profile_id>.
//
//   login_mode = 'local' (default, LOCAL-CREDENTIALS-MODE-A):
//     { new_username, new_temporary_password, contact_email? }
//     - Auth email is set to the synthetic <new_username>@local.medistock.invalid.
//     - Auth password is set directly server-side — no recovery link, no email.
//     - profiles.must_change_password is set true.
//
//   login_mode = 'email' (secondary/advanced, unchanged from prior behavior):
//     { new_email }
//     - Auth email is updated to new_email; a best-effort recovery link is
//       generated (delivery depends on SMTP configuration).
//
// PARTIAL FAILURE SAFETY:
//   Auth email update is performed FIRST (most likely to fail — duplicate email,
//   provider error). If subsequent DB updates fail, the auth email is already
//   changed but the profile remains suspended and banned. This is the safest
//   failure mode: the old suspended account still cannot log in, and the admin
//   can retry the recycle operation. The identity history will be consistent on
//   retry because we close the old row by identity_version match.
//
//   Returns structured JSON. Never leaks raw provider errors.
// =============================================================================

// @ts-nocheck — Deno edge runtime; not part of app tsconfig.
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

  const url        = Deno.env.get('SUPABASE_URL');
  const anonKey    = Deno.env.get('SUPABASE_ANON_KEY');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !anonKey || !serviceKey) return json({ ok: false, error: 'NOT_CONFIGURED' }, 500);

  const authHeader = req.headers.get('Authorization') ?? '';
  if (!authHeader.startsWith('Bearer ')) return json({ ok: false, error: 'NOT_AUTHENTICATED' }, 401);

  // Caller-scoped client (RLS applies) — to resolve the caller identity.
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  // Privileged client — server-only admin operations.
  const admin  = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Verify caller identity.
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'NOT_AUTHENTICATED' }, 401);
  const callerId = userData.user.id;

  // Parse body.
  let body: {
    target_profile_id?: string;
    new_full_name?: string;
    new_role?: string;
    new_organization_id?: string;
    confirmation?: string;
    login_mode?: string;
    new_username?: string;
    new_temporary_password?: string;
    contact_email?: string;
    new_email?: string;
  };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST' }, 400); }

  const targetProfileId = (body.target_profile_id ?? '').trim();
  const newFullName     = (body.new_full_name ?? '').trim();
  const newRole         = body.new_role ?? '';
  const newOrgId        = body.new_organization_id ?? null;
  const confirmation    = (body.confirmation ?? '').trim();
  const loginMode       = body.login_mode === 'email' ? 'email' : 'local'; // default: local

  // ── Validate required fields ───────────────────────────────────────────────
  if (!targetProfileId || !newFullName || !newRole) {
    return json({ ok: false, error: 'MISSING_FIELDS' }, 400);
  }
  if (!OFFICIAL_ROLES.includes(newRole)) {
    return json({ ok: false, error: 'INVALID_ROLE' }, 400);
  }

  // ── Resolve identity fields per mode ───────────────────────────────────────
  let newUsername = '';
  let newTemporaryPassword = ''; // never logged, stored, or returned
  let contactEmail = '';
  let newEmail = '';

  if (loginMode === 'local') {
    newUsername = (body.new_username ?? '').trim().toLowerCase();
    newTemporaryPassword = (body.new_temporary_password ?? '').trim();
    contactEmail = (body.contact_email ?? '').trim();
    if (!newUsername || !newTemporaryPassword) return json({ ok: false, error: 'MISSING_FIELDS' }, 400);
    if (!USERNAME_PATTERN.test(newUsername)) return json({ ok: false, error: 'INVALID_USERNAME' }, 400);
    if (newTemporaryPassword.length < 8) return json({ ok: false, error: 'PASSWORD_TOO_SHORT' }, 400);
    newEmail = `${newUsername}@${LOCAL_AUTH_DOMAIN}`;
  } else {
    newEmail = (body.new_email ?? '').trim();
    if (!newEmail) return json({ ok: false, error: 'MISSING_FIELDS' }, 400);
  }

  // ── Resolve caller profile ─────────────────────────────────────────────────
  const { data: callerProfile } = await admin
    .from('profiles').select('role, organization_id').eq('id', callerId).single();
  if (!callerProfile) return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);

  const isCallerSuper            = callerProfile.role === 'super_admin';
  const isCallerInstitutionAdmin = callerProfile.role === 'institution_admin';

  // Only super_admin and institution_admin may recycle users.
  if (!isCallerSuper && !isCallerInstitutionAdmin) {
    return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
  }

  // Permission check: caller must hold users.recycle.
  const { data: canRecycle } = await admin.rpc('phoenix_profile_has_permission', {
    p_profile_id: callerId,
    p_key: 'users.recycle',
  });
  if (canRecycle !== true) {
    return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
  }

  // ── Self-recycle guard ─────────────────────────────────────────────────────
  if (targetProfileId === callerId) {
    return json({ ok: false, error: 'SELF_ACTION_FORBIDDEN' }, 403);
  }

  // ── Fetch target profile ───────────────────────────────────────────────────
  const { data: targetProfile } = await admin
    .from('profiles')
    .select('role, status, organization_id, full_name, identity_version')
    .eq('id', targetProfileId)
    .single();
  if (!targetProfile) return json({ ok: false, error: 'TARGET_NOT_FOUND' }, 404);

  // Target must be suspended.
  if (targetProfile.status !== 'suspended') {
    return json({ ok: false, error: 'TARGET_NOT_SUSPENDED' }, 400);
  }

  // Cannot recycle super_admin accounts.
  if (targetProfile.role === 'super_admin') {
    return json({ ok: false, error: 'CANNOT_RECYCLE_SUPER_ADMIN' }, 403);
  }

  // ── institution_admin scope guards ─────────────────────────────────────────
  if (isCallerInstitutionAdmin) {
    // Cannot recycle institution_admin targets.
    if (targetProfile.role === 'institution_admin') {
      return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
    }
    // Cannot recycle outside own org.
    if (callerProfile.organization_id !== targetProfile.organization_id) {
      return json({ ok: false, error: 'CROSS_ORG_FORBIDDEN' }, 403);
    }
    // Cannot assign super_admin or institution_admin as new_role.
    if (
      newRole === 'super_admin'
      || newRole === 'institution_admin'
      || newRole === 'central_warehouse_manager'
    ) {
      return json({ ok: false, error: 'CANNOT_ASSIGN_ELEVATED_ROLE' }, 403);
    }
    // institution_admin cannot change organization (can only recycle within own org).
    if (newOrgId) {
      return json({ ok: false, error: 'CROSS_ORG_FORBIDDEN' }, 403);
    }
  }

  // ── Confirmation check ─────────────────────────────────────────────────────
  const expectedConfirmation = `RECYCLE_USER_${targetProfileId}`;
  if (confirmation !== expectedConfirmation) {
    return json({ ok: false, error: 'INVALID_CONFIRMATION' }, 400);
  }

  // ── Fetch old auth email for audit ─────────────────────────────────────────
  const { data: targetAuthData } = await admin.auth.admin.getUserById(targetProfileId);
  const oldEmail = targetAuthData?.user?.email ?? '';

  // ═══════════════════════════════════════════════════════════════════════════
  // ATOMIC RECYCLING — CRITICAL ORDERING FOR SAFETY
  //
  // DB changes (user_identity_history, profiles) and Auth changes (email update,
  // unban) span two systems. We cannot wrap both in a single transaction.
  //
  // Safest order:
  //   1. Auth email update FIRST (most likely to fail — duplicate email, etc.)
  //   2. DB changes (close old identity, update profile, insert new identity)
  //   3. Unban auth user (only after all state is consistent)
  //   4. Send password setup email (best-effort, non-fatal)
  //   5. Audit log
  //
  // PARTIAL FAILURE NOTE: If DB updates fail after auth email update,
  // the auth email is already changed but the profile is not updated.
  // This is the safest failure mode: the old suspended account cannot
  // log in (still banned), and the admin can retry the recycle operation.
  // The identity history will be consistent on retry because of
  // identity_version matching on the close-old-row step.
  // ═══════════════════════════════════════════════════════════════════════════

  // ── Step 1: Auth email (+ password for local mode) update FIRST ───────────
  const authUpdate: Record<string, unknown> = { email: newEmail, email_confirm: true };
  if (loginMode === 'local') authUpdate.password = newTemporaryPassword;
  const { error: emailErr } = await admin.auth.admin.updateUserById(targetProfileId, authUpdate);
  if (emailErr) return json({ ok: false, error: 'EMAIL_UPDATE_FAILED' }, 400);

  // ── Step 2: DB changes ─────────────────────────────────────────────────────

  // 2a. Close old identity in user_identity_history.
  const { error: closeErr } = await admin
    .from('user_identity_history')
    .update({ valid_until: new Date().toISOString() })
    .eq('profile_id', targetProfileId)
    .eq('identity_version', targetProfile.identity_version)
    .is('valid_until', null);

  if (closeErr) {
    // PARTIAL FAILURE: Auth email updated, but identity history not closed.
    // Admin can retry safely; old account remains banned.
    return json({ ok: false, error: 'RECYCLE_DB_FAILED', detail: 'close_identity' }, 500);
  }

  // 2b. Increment identity_version and update profile.
  const newVersion = targetProfile.identity_version + 1;
  const profileUpdate: Record<string, unknown> = {
    identity_version: newVersion,
    full_name: newFullName,
    role: newRole,
    status: 'active',
    login_mode: loginMode,
    username: loginMode === 'local' ? newUsername : null,
    contact_email: loginMode === 'local' ? (contactEmail || null) : null,
    must_change_password: loginMode === 'local',
  };
  // Only super_admin can change organization.
  if (isCallerSuper && newOrgId) {
    profileUpdate.organization_id = newOrgId;
  }
  // Clear disable audit columns (migration 011).
  try {
    profileUpdate.disabled_at = null;
    profileUpdate.disabled_by = null;
  } catch {}

  const { error: profileErr } = await admin
    .from('profiles')
    .update(profileUpdate)
    .eq('id', targetProfileId);

  if (profileErr) {
    // PARTIAL FAILURE: Auth email updated, old identity closed, but profile not updated.
    // Admin can retry; old account remains banned.
    return json({ ok: false, error: 'RECYCLE_DB_FAILED', detail: 'update_profile' }, 500);
  }

  // 2c. Insert new identity history row.
  const effectiveOrgId = (isCallerSuper && newOrgId) ? newOrgId : targetProfile.organization_id;
  const { error: histErr } = await admin
    .from('user_identity_history')
    .insert({
      profile_id: targetProfileId,
      identity_version: newVersion,
      full_name: newFullName,
      email: newEmail,
      role: newRole,
      organization_id: effectiveOrgId,
      valid_from: new Date().toISOString(),
      valid_until: null,
      change_reason: 'account_recycled',
      recycled_by: callerId,
    });

  if (histErr) {
    // PARTIAL FAILURE: Profile updated but new identity row not inserted.
    // Admin can retry; the profile is now active but identity history is incomplete.
    return json({ ok: false, error: 'RECYCLE_DB_FAILED', detail: 'insert_identity' }, 500);
  }

  // ── Step 3: Unban auth user ────────────────────────────────────────────────
  const { error: unbanErr } = await admin.auth.admin.updateUserById(targetProfileId, {
    ban_duration: 'none',
  });
  if (unbanErr) {
    // Profile is active but auth user still banned — admin must retry or manually enable.
    return json({ ok: false, error: 'UNBAN_FAILED' }, 500);
  }

  // ── Step 4: Password setup ──────────────────────────────────────────────────
  // Local mode: password was already set directly server-side in Step 1 — no
  // email, no recovery link, no SMTP dependency.
  // Email mode: generateLink creates a recovery link server-side but does NOT
  // guarantee email delivery. Whether the email is actually sent depends on
  // the Supabase project's email provider (SMTP) configuration. The generated
  // link is intentionally discarded — never returned, logged, or stored.
  let passwordSetupStatus: 'link_generated' | 'link_failed' | undefined;
  if (loginMode === 'email') {
    passwordSetupStatus = 'link_failed';
    try {
      const { error: linkErr } = await admin.auth.admin.generateLink({
        type: 'recovery',
        email: newEmail,
      });
      passwordSetupStatus = linkErr ? 'link_failed' : 'link_generated';
    } catch {
      passwordSetupStatus = 'link_failed';
    }
  }

  // ── Step 5: Audit log ──────────────────────────────────────────────────────
  const { error: auditErr } = await admin.from('audit_logs').insert({
    organization_id: effectiveOrgId,
    actor_id: callerId,
    actor_role: callerProfile.role,
    action: 'user.account_recycled',
    entity_type: 'profile',
    entity_id: targetProfileId,
    payload: {
      old_full_name: targetProfile.full_name,
      old_email: oldEmail,
      old_role: targetProfile.role,
      old_identity_version: targetProfile.identity_version,
      new_full_name: newFullName,
      new_email: newEmail,
      new_role: newRole,
      new_identity_version: newVersion,
    },
  });
  // Audit log failure is non-fatal — do not block the recycled user.

  // ── Step 6: Return ─────────────────────────────────────────────────────────
  // Never return the temporary password — only a safe "was set" boolean.
  return json({
    ok: true,
    target_profile_id: targetProfileId,
    new_email: loginMode === 'email' ? newEmail : undefined,
    new_identity_version: newVersion,
    password_setup_status: passwordSetupStatus,
    credential_mode: loginMode,
    new_username: loginMode === 'local' ? newUsername : undefined,
    temporary_password_set: loginMode === 'local' ? true : undefined,
  });
});
