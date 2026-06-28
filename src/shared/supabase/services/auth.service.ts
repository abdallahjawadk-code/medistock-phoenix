import { supabase, supabaseConfigured } from '../client';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
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
  await supabase.auth.signOut();
}

export async function getSession(): Promise<Session | null> {
  if (!supabaseConfigured) return null;
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
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
 * Loads the current user's profile (role + org) from public.profiles.
 * RLS ensures a user can only read their own profile row.
 */
export async function getMyProfile(): Promise<Profile | null> {
  if (!supabaseConfigured) return null;

  const { data: auth } = await supabase.auth.getUser();
  const uid = auth.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from('profiles')
    .select('id, organization_id, full_name, role, status')
    .eq('id', uid)
    .single();

  if (error) {
    console.error('[phoenix] profile load failed:', error);
    return null;
  }
  return data as Profile;
}
