// =============================================================================
// MediStock Phoenix V2 — Edge Function: admin-recycle-user
//
// Recycle a suspended account: reassign identity (name, email, role) and
// reactivate it under a new identity version, preserving the old identity in
// user_identity_history. Privileged access uses a server-only modern key.
//
// SECURITY-ARCH-HARDENING-A (D1 + D2):
//   The whole DB transition (close old identity row, bump version, update the
//   profile's role/status/login fields, insert the new identity row) now runs
//   ATOMICALLY inside phoenix_recycle_apply (migration 093), called with the
//   CALLER's JWT so the contract is the single authority. Authorization /
//   existence denials return a generic REQUEST_DENIED (real reason logged
//   server-side with the request correlation id).
//
//   ORDER: DB transition FIRST, then the Auth email/password update, then the
//   unban. A recycle target is by definition suspended (hence banned), so it
//   stays unusable until the very end — if the Auth step fails after the DB
//   transition, the account is simply left banned (safe, retryable), never a
//   working old credential and never a half-authorized change (the contract
//   rejected unauthorized callers BEFORE any Auth mutation).
//
// Contract (unchanged wire shape):
//   POST { target_profile_id, new_full_name, new_role, login_mode,
//          new_organization_id?, confirmation, ... }  (Bearer = caller JWT)
// =============================================================================

// @ts-nocheck — Deno edge runtime; not part of app tsconfig.
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import {
  parseBearerAuthorization,
  resolveEdgeApiKeys,
} from '../_shared/edge-auth.ts';

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

  const correlationId = req.headers.get('x-correlation-id') || crypto.randomUUID();

  const caller = createClient(url, apiKeys.publishableKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(url, apiKeys.secretKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

  const { data: userData, error: userErr } = await caller.auth.getUser();
  if (userErr || !userData?.user) return json({ ok: false, error: 'NOT_AUTHENTICATED', correlation_id: correlationId }, 401);

  let body: {
    target_profile_id?: string; new_full_name?: string; new_role?: string;
    new_organization_id?: string; confirmation?: string; login_mode?: string;
    new_username?: string; new_temporary_password?: string; contact_email?: string; new_email?: string;
  };
  try { body = await req.json(); } catch { return json({ ok: false, error: 'BAD_REQUEST', correlation_id: correlationId }, 400); }

  const targetProfileId = (body.target_profile_id ?? '').trim();
  const newFullName     = (body.new_full_name ?? '').trim();
  const newRole         = body.new_role ?? '';
  const newOrgId        = body.new_organization_id ?? null;
  const confirmation    = (body.confirmation ?? '').trim();
  const loginMode       = body.login_mode === 'email' ? 'email' : 'local';

  if (!targetProfileId || !newFullName || !newRole) {
    return json({ ok: false, error: 'MISSING_FIELDS', correlation_id: correlationId }, 400);
  }
  if (!OFFICIAL_ROLES.includes(newRole)) {
    return json({ ok: false, error: 'INVALID_ROLE', correlation_id: correlationId }, 400);
  }

  // Confirmation embeds the target profile id (already known to the caller) —
  // not an existence oracle.
  if (confirmation !== `RECYCLE_USER_${targetProfileId}`) {
    return json({ ok: false, error: 'INVALID_CONFIRMATION', correlation_id: correlationId }, 400);
  }

  // ── Resolve identity fields per mode (input validation only) ────────────────
  let newUsername = '';
  let newTemporaryPassword = '';
  let contactEmail = '';
  let newEmail = '';

  if (loginMode === 'local') {
    newUsername = (body.new_username ?? '').trim().toLowerCase();
    newTemporaryPassword = (body.new_temporary_password ?? '').trim();
    contactEmail = (body.contact_email ?? '').trim();
    if (!newUsername || !newTemporaryPassword) return json({ ok: false, error: 'MISSING_FIELDS', correlation_id: correlationId }, 400);
    if (!USERNAME_PATTERN.test(newUsername)) return json({ ok: false, error: 'INVALID_USERNAME', correlation_id: correlationId }, 400);
    if (newTemporaryPassword.length < 8) return json({ ok: false, error: 'PASSWORD_TOO_SHORT', correlation_id: correlationId }, 400);
    newEmail = `${newUsername}@${LOCAL_AUTH_DOMAIN}`;
  } else {
    newEmail = (body.new_email ?? '').trim();
    if (!newEmail) return json({ ok: false, error: 'MISSING_FIELDS', correlation_id: correlationId }, 400);
  }

  // ── Step 1: atomic DB transition through the contract (authority + write) ────
  // Runs first so an unauthorized caller is rejected BEFORE any Auth mutation.
  // The target stays banned throughout, so no old credential can be used even
  // if a later Auth step fails.
  const { data: applied, error: applyErr } = await caller.rpc('phoenix_recycle_apply', {
    p_target_id: targetProfileId,
    p_new_full_name: newFullName,
    p_new_role: newRole,
    p_new_org: newOrgId,
    p_login_mode: loginMode,
    p_username: loginMode === 'local' ? newUsername : null,
    p_contact_email: loginMode === 'local' ? (contactEmail || null) : null,
    p_new_email: newEmail,
    p_expected_version: null,
    p_correlation_id: correlationId,
  });
  if (applyErr || !applied?.ok) {
    const code = applied?.error ?? 'RECYCLE_DB_FAILED';
    const status = code === 'REQUEST_DENIED' ? 403 : 400;
    return json({ ok: false, error: code, correlation_id: applied?.correlation_id ?? correlationId }, status);
  }
  const newVersion = applied.new_identity_version;

  // ── Step 2: Auth email (+ password for local) update ────────────────────────
  const authUpdate: Record<string, unknown> = { email: newEmail, email_confirm: true };
  if (loginMode === 'local') authUpdate.password = newTemporaryPassword;
  const { error: emailErr } = await admin.auth.admin.updateUserById(targetProfileId, authUpdate);
  if (emailErr) {
    // DB is recycled but Auth still holds the old email and the account stays
    // banned → not usable. Admin retries; the identity history is already
    // consistent (the new open row exists).
    return json({ ok: false, error: 'EMAIL_UPDATE_FAILED', correlation_id: correlationId, new_identity_version: newVersion }, 400);
  }

  // ── Step 3: Unban only after the credential is in place ──────────────────────
  const { error: unbanErr } = await admin.auth.admin.updateUserById(targetProfileId, { ban_duration: 'none' });
  if (unbanErr) {
    return json({ ok: false, error: 'UNBAN_FAILED', correlation_id: correlationId, new_identity_version: newVersion }, 500);
  }

  // ── Step 4: email-mode recovery link (best-effort; never returned/logged) ────
  let passwordSetupStatus: 'link_generated' | 'link_failed' | undefined;
  if (loginMode === 'email') {
    passwordSetupStatus = 'link_failed';
    try {
      const { error: linkErr } = await admin.auth.admin.generateLink({ type: 'recovery', email: newEmail });
      passwordSetupStatus = linkErr ? 'link_failed' : 'link_generated';
    } catch { passwordSetupStatus = 'link_failed'; }
  }

  return json({
    ok: true,
    target_profile_id: targetProfileId,
    new_email: loginMode === 'email' ? newEmail : undefined,
    new_identity_version: newVersion,
    password_setup_status: passwordSetupStatus,
    credential_mode: loginMode,
    new_username: loginMode === 'local' ? newUsername : undefined,
    temporary_password_set: loginMode === 'local' ? true : undefined,
    correlation_id: correlationId,
  });
});
