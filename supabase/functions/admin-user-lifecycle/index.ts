// =============================================================================
// MediStock Phoenix V2 — Edge Function: admin-user-lifecycle
//
// Secure server-side user disable / enable / rotate_password / hard-delete.
// The service_role key lives ONLY here in the Deno runtime.
//
// SECURITY-ARCH-HARDENING-A (D1 + D2):
//   This function no longer checks the last-super-admin invariant nor mutates
//   profile role/status directly. Every authority decision and every profile
//   state transition goes through the atomic server-side contract in migration
//   093 (phoenix_lifecycle_reserve / _commit / _note_delete / _compensate /
//   _enable / _authorize_rotation), called with the CALLER's JWT so auth.uid()
//   is the acting admin. The invariant + the state change happen under one
//   advisory lock and are COMMITTED together, so two concurrent disable/delete
//   calls can never drain the platform to zero super_admins; if the external
//   Auth Admin call then fails, we compensate to restore the exact prior state
//   (no half-deleted account, no privilege expansion).
//
//   Authorization / existence denials come back as a single generic
//   REQUEST_DENIED (never TARGET_NOT_FOUND vs CROSS_ORG vs INSUFFICIENT_*), so
//   the response can't be used as a user-/org-existence oracle. The real reason
//   is recorded server-side in the RLS-protected audit_logs with the same
//   correlation id the client already stamps on the request.
//
// Contract (unchanged wire shape):
//   POST { action, target_user_id, confirmation?, new_password? }  (Bearer = caller JWT)
//   action ∈ { disable, enable, rotate_password, delete }
//   Returns structured JSON. Never leaks raw provider errors or the password.
// =============================================================================

// @ts-nocheck — Deno edge runtime; not part of app tsconfig.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

// Map an atomic-contract RPC result to an HTTP status. All authorization /
// existence denials share REQUEST_DENIED (403); the invariant and operational
// states keep their own distinct, non-oracle codes.
function statusForCode(code: string): number {
  switch (code) {
    case 'NOT_AUTHENTICATED': return 401;
    case 'REQUEST_DENIED': return 403;
    case 'LAST_SUPER_ADMIN': return 403;
    case 'LIFECYCLE_IN_PROGRESS': return 409;
    case 'INVALID_ACTION': return 400;
    default: return 400;
  }
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

  // Correlation id: reuse the client's stamp so client and server logs line up.
  const correlationId = req.headers.get('x-correlation-id') || crypto.randomUUID();

  // Caller-scoped client: RPCs run with the caller's JWT, so auth.uid() inside
  // the atomic contract is the acting admin (the contract does its own authz).
  const caller = createClient(url, anonKey, { global: { headers: { Authorization: authHeader } } });
  // Privileged client: used ONLY for Auth Admin operations (ban/unban/password/
  // delete/session-revoke). It never mutates profile role/status directly.
  const admin  = createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } });

  // Verify the caller is authenticated at all (the contract re-checks authority).
  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'NOT_AUTHENTICATED', correlation_id: correlationId }, 401);

  let body: { action?: string; target_user_id?: string; confirmation?: string; new_password?: string };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST', correlation_id: correlationId }, 400); }

  const action       = body.action ?? '';
  const targetId     = (body.target_user_id ?? '').trim();
  const confirmation = (body.confirmation ?? '').trim();
  const newPassword  = (body.new_password ?? '').trim(); // never logged

  if (!['disable', 'enable', 'delete', 'rotate_password'].includes(action)) {
    return json({ ok: false, error: 'INVALID_ACTION', correlation_id: correlationId }, 400);
  }
  if (!targetId) return json({ ok: false, error: 'MISSING_TARGET', correlation_id: correlationId }, 400);
  if (action === 'rotate_password') {
    if (!newPassword) return json({ ok: false, error: 'MISSING_FIELDS', correlation_id: correlationId }, 400);
    if (newPassword.length < 8) return json({ ok: false, error: 'PASSWORD_TOO_SHORT', correlation_id: correlationId }, 400);
  }

  // Small helper: surface an RPC failure verbatim (generic code + correlation).
  const rpcDenied = (r: { error?: string; correlation_id?: string }) =>
    json({ ok: false, error: r.error ?? 'REQUEST_DENIED', correlation_id: r.correlation_id ?? correlationId },
         statusForCode(r.error ?? 'REQUEST_DENIED'));

  // ── action: enable ─ authorize + set active via the contract, then unban ────
  if (action === 'enable') {
    const { data: en } = await caller.rpc('phoenix_lifecycle_enable',
      { p_target_id: targetId, p_correlation_id: correlationId });
    if (!en?.ok) return rpcDenied(en ?? {});
    const { error: unbanErr } = await admin.auth.admin.updateUserById(targetId, { ban_duration: 'none' });
    if (unbanErr) {
      // Profile is active but auth still banned — safe, retryable (idempotent).
      return json({ ok: false, error: 'ACTION_FAILED', correlation_id: correlationId }, 500);
    }
    return json({ ok: true, action: 'enabled', user_id: targetId, correlation_id: correlationId });
  }

  // ── action: rotate_password ─ authorize via contract, then rotate in Auth ───
  if (action === 'rotate_password') {
    const { data: az } = await caller.rpc('phoenix_lifecycle_authorize_rotation',
      { p_target_id: targetId, p_correlation_id: correlationId });
    if (!az?.ok) return rpcDenied(az ?? {});

    const { error: pwErr } = await admin.auth.admin.updateUserById(targetId, { password: newPassword });
    if (pwErr) return json({ ok: false, error: 'ACTION_FAILED', correlation_id: correlationId }, 500);

    // Revoke every existing session so the OLD credential is dead everywhere.
    let sessionsRevoked = false;
    try {
      const anyAdmin = admin.auth.admin as unknown as {
        signOut?: (id: string, scope?: string) => Promise<{ error: unknown }>;
      };
      if (typeof anyAdmin.signOut === 'function') {
        const { error: soErr } = await anyAdmin.signOut(targetId, 'global');
        sessionsRevoked = !soErr;
      } else {
        const resp = await fetch(`${url}/auth/v1/admin/users/${targetId}/sessions`, {
          method: 'DELETE',
          headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` },
        });
        sessionsRevoked = resp.ok;
      }
    } catch { sessionsRevoked = false; }

    return json({
      ok: true, action: 'password_rotated', user_id: targetId,
      sessions_revoked: sessionsRevoked, must_change_password: true, correlation_id: correlationId,
    });
  }

  // ── action: disable ─ reserve (atomic invariant + suspend), ban, commit ─────
  if (action === 'disable') {
    const { data: rv } = await caller.rpc('phoenix_lifecycle_reserve',
      { p_target_id: targetId, p_action: 'disable', p_correlation_id: correlationId });
    if (!rv?.ok) return rpcDenied(rv ?? {});

    const { error: banErr } = await admin.auth.admin.updateUserById(targetId, { ban_duration: '876000h' });
    if (banErr) {
      // External failure → compensate: restore the exact prior status.
      await caller.rpc('phoenix_lifecycle_compensate', { p_target_id: targetId, p_correlation_id: correlationId });
      return json({ ok: false, error: 'ACTION_FAILED', correlation_id: correlationId }, 500);
    }
    await caller.rpc('phoenix_lifecycle_commit', { p_target_id: targetId, p_correlation_id: correlationId });
    return json({ ok: true, action: 'disabled', user_id: targetId, correlation_id: correlationId });
  }

  // ── action: delete ─ reserve, confirm, delete in Auth, note (or compensate) ─
  if (action === 'delete') {
    const { data: rv } = await caller.rpc('phoenix_lifecycle_reserve',
      { p_target_id: targetId, p_action: 'delete', p_correlation_id: correlationId });
    if (!rv?.ok) return rpcDenied(rv ?? {});
    const targetRole = rv.target_role ?? null;

    // Confirmation string must equal DELETE_USER_<target-user-id> — the id is
    // already visible to the caller in the user list, so this never requires
    // exposing the target's Auth email to build a valid confirmation. The
    // check happens AFTER reserve so target existence stays behind the
    // generic gate; a mismatch compensates the reservation back to active.
    if (confirmation !== `DELETE_USER_${targetId}`) {
      await caller.rpc('phoenix_lifecycle_compensate', { p_target_id: targetId, p_correlation_id: correlationId });
      return json({ ok: false, error: 'INVALID_CONFIRMATION', correlation_id: correlationId }, 400);
    }

    const { error: deleteErr } = await admin.auth.admin.deleteUser(targetId);
    if (deleteErr) {
      await caller.rpc('phoenix_lifecycle_compensate', { p_target_id: targetId, p_correlation_id: correlationId });
      return json({ ok: false, error: 'ACTION_FAILED', correlation_id: correlationId }, 500);
    }
    // Profile (+ its reservation) cascaded away; record the completed deletion.
    await caller.rpc('phoenix_lifecycle_note_delete',
      { p_target_id: targetId, p_target_role: targetRole, p_correlation_id: correlationId });
    return json({ ok: true, action: 'deleted', user_id: targetId, correlation_id: correlationId });
  }

  return json({ ok: false, error: 'UNHANDLED', correlation_id: correlationId }, 500);
});
