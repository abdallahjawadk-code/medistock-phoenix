// =============================================================================
// MediStock Phoenix V2 — Edge Function: admin-user-lifecycle
//
// Secure server-side user disable / enable / hard-delete.
// The service_role key lives ONLY here in the Deno runtime.
//
// Deploy:
//   supabase functions deploy admin-user-lifecycle --project-ref <ref>
//   (SUPABASE_SERVICE_ROLE_KEY is already set from admin-create-user deploy)
//
// Contract:
//   POST { action, target_user_id, confirmation?, new_password? }  (Bearer = caller JWT)
//
//   action = 'disable'
//     - Bans the auth user (prevents login immediately).
//     - Sets profiles.status = 'suspended'.
//     - Sets profiles.disabled_at / disabled_by if columns exist (migration 011).
//     - Caller must be super_admin OR institution_admin (with users.disable).
//     - institution_admin: own org only; cannot disable super_admin/institution_admin.
//     - Cannot disable self.
//     - Cannot disable the last active super_admin
//       (USER-MANAGEMENT-CREATE-DELETE-ROTATE-FIX-A: this guard previously only
//       existed for 'delete' — disabling the only super_admin would have left
//       the platform with zero usable admin access just as surely as deleting
//       them would).
//
//   action = 'enable'
//     - Removes the auth ban.
//     - Sets profiles.status = 'active', clears disabled_at / disabled_by.
//     - Caller must be super_admin OR institution_admin (with users.disable).
//     - institution_admin: own org only; cannot enable super_admin/institution_admin.
//
//   action = 'rotate_password'
//     - Sets a new temporary password directly on the auth user
//       (auth.admin.updateUserById — server-side only).
//     - Sets profiles.must_change_password = true if the column exists
//       (migration 016) so the user is prompted to change it at next login.
//     - Caller must be super_admin OR institution_admin (with users.disable —
//       reuses the existing lifecycle permission key; no new key introduced).
//     - institution_admin: own org only; cannot rotate super_admin/institution_admin.
//     - Cannot rotate own password through this admin action (self-service
//       password change is a separate, already-existing flow).
//     - Requires { new_password } (min 8 chars). The temporary password is
//       never logged, never stored in profiles/audit_logs, and is only ever
//       known to the caller who already typed/generated it client-side —
//       this function does not echo it back.
//
//   action = 'delete'
//     - Caller must be super_admin ONLY (institution_admin cannot hard-delete).
//     - Cannot delete self.
//     - Cannot delete the last active super_admin.
//     - confirmation must equal 'DELETE_USER_' + target email.
//     - Deletes auth user (profile cascades via ON DELETE CASCADE).
//
//   Returns structured JSON. Never leaks raw provider errors.
// =============================================================================

// @ts-nocheck — Deno edge runtime; not part of app tsconfig.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  const admin  = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Verify caller identity.
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'NOT_AUTHENTICATED' }, 401);
  const callerId = userData.user.id;

  // Parse body.
  let body: { action?: string; target_user_id?: string; confirmation?: string; new_password?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST' }, 400); }

  const action       = body.action ?? '';
  const targetId     = (body.target_user_id ?? '').trim();
  const confirmation = (body.confirmation ?? '').trim();
  const newPassword  = (body.new_password ?? '').trim(); // never logged

  if (!['disable', 'enable', 'delete', 'rotate_password'].includes(action)) {
    return json({ ok: false, error: 'INVALID_ACTION' }, 400);
  }
  if (!targetId) return json({ ok: false, error: 'MISSING_TARGET' }, 400);
  if (action === 'rotate_password') {
    if (!newPassword) return json({ ok: false, error: 'MISSING_FIELDS' }, 400);
    if (newPassword.length < 8) return json({ ok: false, error: 'PASSWORD_TOO_SHORT' }, 400);
  }

  // Caller profile (role + org) — resolved via privileged client, bypasses RLS.
  const { data: callerProfile } = await admin
    .from('profiles').select('role, organization_id').eq('id', callerId).single();
  if (!callerProfile) return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);

  const isCallerSuper          = callerProfile.role === 'super_admin';
  const isCallerInstitutionAdmin = callerProfile.role === 'institution_admin';

  // Only super_admin and institution_admin may call lifecycle actions.
  if (!isCallerSuper && !isCallerInstitutionAdmin) {
    return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
  }

  // institution_admin must hold users.disable effective permission.
  if (isCallerInstitutionAdmin) {
    const { data: canDisable } = await admin.rpc('phoenix_profile_has_permission', {
      p_profile_id: callerId,
      p_key: 'users.disable',
    });
    if (canDisable !== true) {
      return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
    }
  }

  // Self-action guard.
  if (targetId === callerId) {
    return json({ ok: false, error: 'SELF_ACTION_FORBIDDEN' }, 403);
  }

  // Fetch target profile.
  const { data: targetProfile } = await admin
    .from('profiles').select('role, status, organization_id').eq('id', targetId).single();
  if (!targetProfile) return json({ ok: false, error: 'TARGET_NOT_FOUND' }, 404);

  // institution_admin scope guards: own org only, cannot act on super_admin /
  // institution_admin, and cannot hard-delete anyone.
  if (isCallerInstitutionAdmin) {
    if (['super_admin', 'institution_admin'].includes(targetProfile.role)) {
      return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
    }
    if (callerProfile.organization_id !== targetProfile.organization_id) {
      return json({ ok: false, error: 'CROSS_ORG_FORBIDDEN' }, 403);
    }
    if (action === 'delete') {
      return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
    }
  }

  // Shared guard: cannot disable/delete the last active super_admin. Reused by
  // both 'disable' and 'delete' so the platform can never end up with zero
  // usable super_admin access (USER-MANAGEMENT-CREATE-DELETE-ROTATE-FIX-A).
  async function isLastActiveSuperAdmin(): Promise<boolean> {
    if (targetProfile.role !== 'super_admin') return false;
    const { count } = await admin
      .from('profiles')
      .select('id', { count: 'exact', head: true })
      .eq('role', 'super_admin')
      .eq('status', 'active');
    return (count ?? 0) <= 1;
  }

  // ── action: disable ────────────────────────────────────────────────────────
  if (action === 'disable') {
    if (await isLastActiveSuperAdmin()) {
      return json({ ok: false, error: 'LAST_SUPER_ADMIN' }, 403);
    }

    // Ban the auth user so they cannot log in.
    const { error: banErr } = await admin.auth.admin.updateUserById(targetId, {
      ban_duration: '876000h', // ~100 years
    });
    if (banErr) return json({ ok: false, error: 'ACTION_FAILED' }, 500);

    // Mark profile suspended. Set optional audit columns if they exist.
    const updatePayload: Record<string, unknown> = { status: 'suspended' };
    // Best-effort: if migration 011 added these columns, set them.
    try {
      updatePayload.disabled_at = new Date().toISOString();
      updatePayload.disabled_by = callerId;
      await admin.from('profiles').update(updatePayload).eq('id', targetId);
    } catch {
      // Columns may not exist yet (migration 011 not applied); fall back.
      await admin.from('profiles').update({ status: 'suspended' }).eq('id', targetId);
    }

    return json({ ok: true, action: 'disabled', user_id: targetId });
  }

  // ── action: enable ─────────────────────────────────────────────────────────
  if (action === 'enable') {
    const { error: unbanErr } = await admin.auth.admin.updateUserById(targetId, {
      ban_duration: 'none',
    });
    if (unbanErr) return json({ ok: false, error: 'ACTION_FAILED' }, 500);

    const updatePayload: Record<string, unknown> = { status: 'active' };
    try {
      updatePayload.disabled_at = null;
      updatePayload.disabled_by = null;
      await admin.from('profiles').update(updatePayload).eq('id', targetId);
    } catch {
      await admin.from('profiles').update({ status: 'active' }).eq('id', targetId);
    }

    return json({ ok: true, action: 'enabled', user_id: targetId });
  }

  // ── action: rotate_password ────────────────────────────────────────────────
  // Sets a brand-new temporary password on the SAME identity (username/email/
  // role/org untouched) — distinct from admin-recycle-user, which requires the
  // target to already be suspended and reassigns the whole identity. This is
  // for an active user who forgot/needs a reset of their credential only.
  if (action === 'rotate_password') {
    const { error: pwErr } = await admin.auth.admin.updateUserById(targetId, {
      password: newPassword,
    });
    if (pwErr) return json({ ok: false, error: 'ACTION_FAILED' }, 500);

    // Best-effort: must_change_password / password_changed_at exist since
    // migration 016; degrade gracefully if a project hasn't applied it yet.
    try {
      await admin.from('profiles').update({ must_change_password: true }).eq('id', targetId);
    } catch {
      // Column may not exist yet — the password itself is still rotated.
    }

    return json({ ok: true, action: 'password_rotated', user_id: targetId });
  }

  // ── action: delete ─────────────────────────────────────────────────────────
  if (action === 'delete') {
    // Fetch target auth user to get email for confirmation check.
    const { data: targetAuthData } = await admin.auth.admin.getUserById(targetId);
    const targetEmail = targetAuthData?.user?.email ?? '';

    // Confirmation string must equal DELETE_USER_<email>.
    const expected = `DELETE_USER_${targetEmail}`;
    if (confirmation !== expected) {
      return json({ ok: false, error: 'INVALID_CONFIRMATION' }, 400);
    }

    // Guard: cannot delete the last active super_admin.
    if (await isLastActiveSuperAdmin()) {
      return json({ ok: false, error: 'LAST_SUPER_ADMIN' }, 403);
    }

    // Delete auth user — profile cascades (ON DELETE CASCADE from migration 001).
    const { error: deleteErr } = await admin.auth.admin.deleteUser(targetId);
    if (deleteErr) return json({ ok: false, error: 'ACTION_FAILED' }, 500);

    return json({ ok: true, action: 'deleted', user_id: targetId });
  }

  return json({ ok: false, error: 'UNHANDLED' }, 500);
});
