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
//   POST { action, target_user_id, confirmation? }  (Bearer = caller JWT)
//
//   action = 'disable'
//     - Bans the auth user (prevents login immediately).
//     - Sets profiles.status = 'suspended'.
//     - Sets profiles.disabled_at / disabled_by if columns exist (migration 011).
//     - Caller must be super_admin.
//     - Cannot disable self.
//
//   action = 'enable'
//     - Removes the auth ban.
//     - Sets profiles.status = 'active', clears disabled_at / disabled_by.
//     - Caller must be super_admin.
//
//   action = 'delete'
//     - Caller must be super_admin.
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
  let body: { action?: string; target_user_id?: string; confirmation?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST' }, 400); }

  const action       = body.action ?? '';
  const targetId     = (body.target_user_id ?? '').trim();
  const confirmation = (body.confirmation ?? '').trim();

  if (!['disable', 'enable', 'delete'].includes(action)) {
    return json({ ok: false, error: 'INVALID_ACTION' }, 400);
  }
  if (!targetId) return json({ ok: false, error: 'MISSING_TARGET' }, 400);

  // Caller must be super_admin (resolved via privileged client, bypasses RLS).
  const { data: callerProfile } = await admin
    .from('profiles').select('role').eq('id', callerId).single();
  if (!callerProfile || callerProfile.role !== 'super_admin') {
    return json({ ok: false, error: 'INSUFFICIENT_PERMISSION' }, 403);
  }

  // Self-action guard.
  if (targetId === callerId) {
    return json({ ok: false, error: 'SELF_ACTION_FORBIDDEN' }, 403);
  }

  // Fetch target profile.
  const { data: targetProfile } = await admin
    .from('profiles').select('role, status').eq('id', targetId).single();
  if (!targetProfile) return json({ ok: false, error: 'TARGET_NOT_FOUND' }, 404);

  // ── action: disable ────────────────────────────────────────────────────────
  if (action === 'disable') {
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
    if (targetProfile.role === 'super_admin') {
      const { count } = await admin
        .from('profiles')
        .select('id', { count: 'exact', head: true })
        .eq('role', 'super_admin')
        .eq('status', 'active');
      if ((count ?? 0) <= 1) {
        return json({ ok: false, error: 'LAST_SUPER_ADMIN' }, 403);
      }
    }

    // Delete auth user — profile cascades (ON DELETE CASCADE from migration 001).
    const { error: deleteErr } = await admin.auth.admin.deleteUser(targetId);
    if (deleteErr) return json({ ok: false, error: 'ACTION_FAILED' }, 500);

    return json({ ok: true, action: 'deleted', user_id: targetId });
  }

  return json({ ok: false, error: 'UNHANDLED' }, 500);
});
