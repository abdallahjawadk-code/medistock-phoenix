import { supabase, supabaseConfigured } from '../client';
import type { Session } from '@supabase/supabase-js';
import type { Role } from '../../lib/types';

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
export function onAuthChange(cb: (session: Session | null) => void): () => void {
  if (!supabaseConfigured) return () => undefined;
  const { data } = supabase.auth.onAuthStateChange((_event, session) => cb(session));
  return () => data.subscription.unsubscribe();
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
