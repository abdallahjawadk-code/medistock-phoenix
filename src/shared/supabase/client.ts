import { createClient, SupabaseClient } from '@supabase/supabase-js';

const url = import.meta.env.VITE_PHOENIX_SUPABASE_URL  as string | undefined;
const key = import.meta.env.VITE_PHOENIX_SUPABASE_ANON_KEY as string | undefined;

/** True when env vars are present and non-empty. */
export const supabaseConfigured = Boolean(url && key);

/** The real anon client — the only client production ever uses. */
const realClient: SupabaseClient = supabaseConfigured
  ? createClient(url!, key!, {
      auth: {
        persistSession: true,
        autoRefreshToken: true,
        detectSessionInUrl: true,
      },
    })
  : (null as unknown as SupabaseClient);

// VISUAL-QA-HARNESS-A: production exports `realClient` verbatim (the ternary
// below folds to it because import.meta.env.DEV === false), so there is ZERO QA
// indirection, no proxy, and no fixture code in a production bundle. Only a DEV
// build wraps the client in a swappable forwarder so the dev-only visual-QA
// harness can install a network-free fixture client before rendering screens.
// This is not a permanent monkey-patch: the swap hook is a no-op in production
// and the forwarder itself is tree-shaken out.
let active: SupabaseClient = realClient;

/** DEV-only: install a network-free client for the visual-QA harness. No-op in production. */
export function __installQaSupabaseClient(client: SupabaseClient): void {
  if (!import.meta.env.DEV) return;
  active = client;
}

/** Supabase client — only use after checking supabaseConfigured. */
export const supabase: SupabaseClient = import.meta.env.DEV
  ? new Proxy({} as SupabaseClient, {
      get(_t, prop) {
        const target = active as unknown as Record<string | symbol, unknown>;
        const value = target?.[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(active) : value;
      },
    })
  : realClient;
