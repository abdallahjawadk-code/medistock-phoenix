import type { SupabaseClient } from '@supabase/supabase-js';
/** Fixture-only fail-closed boundary. Never imported by the application build. */
export const supabaseConfigured = false;
export const supabase = new Proxy({} as SupabaseClient, {
  get() { throw new Error('UI_A1_FIXTURE_HOSTED_ACCESS_FORBIDDEN'); },
});
