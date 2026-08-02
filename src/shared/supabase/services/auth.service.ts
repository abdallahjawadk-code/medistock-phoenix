import { supabase, supabaseConfigured } from '../client';
import { isAuthSessionMissingError, type AuthChangeEvent, type Session } from '@supabase/supabase-js';
import type { Role } from '../../lib/types';

/** SPA path that handles the Supabase recovery/confirmation redirect. */
export const AUTH_CALLBACK_PATH = '/auth/callback';

/** Absolute redirect target for auth emails — always the current origin. */
export function authCallbackUrl(): string {
  return `${window.location.origin}${AUTH_CALLBACK_PATH}`;
}

/** Profile row as stored in public.profiles (frontend-safe subset). */
export interface Profile {
  id: string;
  organization_id: string | null;
  full_name: string;
  role: Role;
  status: 'active' | 'suspended' | 'archived';
  /** Local-credentials username (LOCAL-CREDENTIALS-MODE-A). Null for email-mode accounts. */
  username: string | null;
  /** 'email' (default, real Supabase email) or 'local' (synthetic internal email). */
  login_mode: 'email' | 'local';
  /** Optional informational contact email for local accounts. Never used for login. */
  contact_email: string | null;
  /** True until a local user changes their temporary password. */
  must_change_password: boolean;
  /**
   * UX-MY-ACCOUNT-WHATSAPP-SAVE-A: the user's own WhatsApp contact number
   * (migration 044_phoenix_profiles_whatsapp_phone.sql). Nullable — most
   * rows have never set one. Digits-only, 8-15 chars when present (enforced
   * by the DB CHECK constraint and mirrored client-side by
   * isValidWhatsappPhone). Never used by inter-institution alerts in this
   * phase — that remains a separate, later reviewed integration.
   */
  whatsapp_phone: string | null;
}

export interface SignInResult {
  ok: boolean;
  error?: string;
}

/**
 * Email + password sign-in against the live Supabase Auth.
 * Uses the anon/publishable key only — never a privileged server key.
 */
export async function signIn(email: string, password: string): Promise<SignInResult> {
  if (!supabaseConfigured) {
    return { ok: false, error: 'NOT_CONFIGURED' };
  }
  const { error } = await supabase.auth.signInWithPassword({
    email: email.trim(),
    password,
  });
  if (error) {
    console.error('[phoenix] sign-in failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

export async function signOut(): Promise<void> {
  if (!supabaseConfigured) return;
  try {
    const { error } = await supabase.auth.signOut();
    if (!error) return;
    console.error('[phoenix] global sign-out failed; clearing the local session:', error);
  } catch (err) {
    console.error('[phoenix] global sign-out threw; clearing the local session:', err);
  }

  try {
    const { error } = await supabase.auth.signOut({ scope: 'local' });
    if (error) throw error;
  } catch (err) {
    console.error('[phoenix] local sign-out fallback failed:', err);
    throw err;
  }
}

export async function getSession(): Promise<Session | null> {
  if (!supabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

/**
 * PHASE-B1-AUTH-RESILIENCE: the outcome of reading the stored session.
 *
 * `getSession()` above collapses every outcome into `Session | null`, so a
 * transport failure, an expired refresh token and "nobody is signed in" all
 * look identical to the caller — which is how a failed boot became an
 * indistinguishable "no session" and, upstream, a permanent spinner. This
 * result keeps the two apart: `failed` means we do NOT know whether a session
 * exists, and the caller must say so rather than present a login form.
 *
 * `getSession()` itself is deliberately left byte-for-byte unchanged —
 * ResetPasswordScreen's independent recovery flow keeps its exact contract.
 */
export type SessionLoad =
  | { status: 'ok'; session: Session | null }
  | { status: 'failed' };

/** Read the stored session, reporting failure instead of hiding it as `null`. */
export async function getSessionResult(): Promise<SessionLoad> {
  // An unconfigured build genuinely has no session; that is not a failure.
  if (!supabaseConfigured) return { status: 'ok', session: null };
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      console.error('[phoenix] session load failed:', error);
      return { status: 'failed' };
    }
    return { status: 'ok', session: data.session ?? null };
  } catch (err) {
    console.error('[phoenix] session load threw:', err);
    return { status: 'failed' };
  }
}

/** Subscribe to auth changes. Returns an unsubscribe function. */
export function onAuthChange(
  cb: (event: AuthChangeEvent, session: Session | null) => void,
): () => void {
  if (!supabaseConfigured) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((event, session) => cb(event, session));
  return () => data.subscription.unsubscribe();
}

/**
 * Sends a password-reset email. The link returns the user to this app's
 * /auth/callback on the CURRENT origin — never a hardcoded legacy URL.
 */
export async function requestPasswordReset(email: string): Promise<SignInResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: authCallbackUrl(),
  });
  if (error) {
    console.error('[phoenix] reset request failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Sets a new password for the user. Only valid while a recovery session is
 * active (i.e. the user arrived via the reset email). Supabase Auth only.
 */
export async function updatePassword(newPassword: string): Promise<SignInResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  const { error } = await supabase.auth.updateUser({ password: newPassword });
  if (error) {
    console.error('[phoenix] password update failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * Explicitly exchange a PKCE code for a session. Used on /auth/callback
 * landing when detectSessionInUrl may not have completed.
 */
export async function exchangeCodeForSession(code: string): Promise<Session | null> {
  if (!supabaseConfigured) return null;
  try {
    const { data, error } = await supabase.auth.exchangeCodeForSession(code);
    if (error) return null;
    return data.session ?? null;
  } catch {
    return null;
  }
}

/**
 * Set session from hash tokens (implicit grant flow).
 */
export async function setSessionFromTokens(accessToken: string, refreshToken: string): Promise<Session | null> {
  if (!supabaseConfigured) return null;
  try {
    const { data, error } = await supabase.auth.setSession({ access_token: accessToken, refresh_token: refreshToken });
    if (error) return null;
    return data.session ?? null;
  } catch {
    return null;
  }
}

/**
 * PHASE-B1-AUTH-RESILIENCE: the outcome of loading the caller's own profile.
 *
 * `missing` — the read completed and there is no profile row this session may
 *             read (deleted row, or RLS hides it). Retrying will not help.
 * `failed`  — the read could not complete (transport, auth, RLS error). The
 *             row may well exist; a retry is meaningful.
 *
 * Collapsing both into `null` (see getMyProfile below) is what made a failed
 * profile read indistinguishable from "still loading" upstream.
 */
export type ProfileLoad =
  | { status: 'ok'; profile: Profile }
  | { status: 'missing' }
  /**
   * `getUser()` found no auth session. The AppContext generation guard decides
   * whether this is an expected, superseded no-session result or a real
   * mismatch against the session it is still holding.
   */
  | { status: 'session_missing'; error: unknown }
  | { status: 'failed' };

/**
 * Loads the current user's profile (role + org) from public.profiles, and says
 * which of the three outcomes happened. RLS ensures a user can only read their
 * own profile row — this function widens the REPORTING of the result only, and
 * grants no additional read.
 */
export async function getMyProfileResult(): Promise<ProfileLoad> {
  if (!supabaseConfigured) return { status: 'missing' };

  try {
    const { data: auth, error: authError } = await supabase.auth.getUser();
    if (authError) {
      // Missing auth during a profile read can be the normal end of a stale
      // request after SIGNED_OUT. Do not log before AppContext has checked
      // whether this request still belongs to the current auth generation.
      if (isAuthSessionMissingError(authError)) {
        return { status: 'session_missing', error: authError };
      }
      console.error('[phoenix] profile load failed:', authError);
      return { status: 'failed' };
    }
    const uid = auth.user?.id;
    // No authenticated user id: there is no profile to read, and no error to
    // retry away either.
    if (!uid) return { status: 'missing' };

    const { data, error } = await supabase
      .from('profiles')
      .select('id, organization_id, full_name, role, status, username, login_mode, contact_email, must_change_password, whatsapp_phone')
      .eq('id', uid)
      .maybeSingle();

    if (error) {
      console.error('[phoenix] profile load failed:', error);
      return { status: 'failed' };
    }
    // maybeSingle() returns null rows without raising — that is the honest
    // "no readable profile" signal single() used to turn into an error.
    if (!data) return { status: 'missing' };
    return { status: 'ok', profile: data as Profile };
  } catch (err) {
    if (isAuthSessionMissingError(err)) {
      return { status: 'session_missing', error: err };
    }
    console.error('[phoenix] profile load threw:', err);
    return { status: 'failed' };
  }
}

/**
 * Loads the current user's profile (role + org) from public.profiles.
 * RLS ensures a user can only read their own profile row.
 *
 * Kept as the historical convenience contract for callers that genuinely have
 * nothing different to do for "missing" vs "failed". Callers that must tell
 * those apart use getMyProfileResult() above.
 */
export async function getMyProfile(): Promise<Profile | null> {
  const res = await getMyProfileResult();
  return res.status === 'ok' ? res.profile : null;
}

/**
 * Marks the current session's password as changed (clears must_change_password,
 * stamps password_changed_at). Server-side RPC only — the frontend never
 * writes profiles.must_change_password directly. No-op error is swallowed:
 * this is a best-effort bookkeeping call after a successful password update.
 */
export async function markPasswordChanged(): Promise<SignInResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  const { error } = await supabase.rpc('phoenix_mark_password_changed');
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

/**
 * UX-MY-ACCOUNT-WHATSAPP-SAVE-A: updates ONLY the current session's own
 * profiles.whatsapp_phone — never another user's row, never role/status/
 * organization_id/full_name. Pass null to clear a previously-saved number.
 *
 * Server-side RPC only, matching markPasswordChanged() above — this project's
 * profiles-table write guardrail (phoenix-guardrails.test.ts) requires every
 * self-service profiles mutation to go through a SECURITY DEFINER RPC scoped
 * to auth.uid(), never a direct client-side table update call.
 *
 * IMPORTANT — DEPLOYMENT PREREQUISITE: this calls
 * `phoenix_update_my_whatsapp_phone(p_phone text)`, provided by migration
 * 045_phoenix_update_my_whatsapp_phone_rpc.sql (companion to 044). That
 * migration must be manually applied in the Supabase SQL Editor before this
 * function will succeed — until it is applied, calling this function
 * surfaces an honest failure (function not found), never a fake success.
 */
export async function updateMyWhatsappPhone(phone: string | null): Promise<SignInResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  const { error } = await supabase.rpc('phoenix_update_my_whatsapp_phone', { p_phone: phone });
  if (error) {
    console.error('[phoenix] whatsapp phone update failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}

/**
 * UX-OFFICIAL-ORG-WHATSAPP-CONTACT-TOGGLE-A: publishes (or withdraws) the
 * CURRENT user's own already-saved profiles.whatsapp_phone as their
 * organization's official WhatsApp contact in organization_status_contacts.
 * Never accepts a phone value or a profile/user/organization id — the RPC
 * resolves everything from auth.uid() server-side and is the sole authority
 * on eligibility (role/status/organization_id), exactly like
 * updateMyWhatsappPhone() above.
 *
 * IMPORTANT — DEPLOYMENT PREREQUISITE: this calls
 * `phoenix_set_my_org_whatsapp_contact(p_enabled boolean)`, provided by
 * migration 046_phoenix_set_my_org_whatsapp_contact_rpc.sql. That migration
 * must be manually applied in the Supabase SQL Editor before this succeeds.
 */
export async function setMyOrgWhatsappContact(enabled: boolean): Promise<SignInResult> {
  if (!supabaseConfigured) return { ok: false, error: 'NOT_CONFIGURED' };
  const { error } = await supabase.rpc('phoenix_set_my_org_whatsapp_contact', { p_enabled: enabled });
  if (error) {
    console.error('[phoenix] org whatsapp contact update failed:', error);
    return { ok: false, error: error.message };
  }
  return { ok: true };
}
