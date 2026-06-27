import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_PHOENIX_SUPABASE_URL  as string | undefined;
const key = import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY as string | undefined;

/** True when env vars are present and non-empty. */
export const supabaseConfigured = Boolean(url && key);

/** Supabase client — only use after checking supabaseConfigured. */
export const supabase: SupabaseClient = supabaseConfigured
  ? createClient(url!, key!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : (null as unknown as SupabaseClient);
