// The single Supabase client-construction site for this function (D3-2D).
//
// This is the ONLY file in phoenix-outbox-dispatcher permitted to import a
// remote module or to call createClient(. lib/static_guards_test.ts allow-lists
// exactly this path for both, asserts the pinned specifier below is EXACT, and
// asserts no second production file acquires either capability.
//
// EXACT PIN, NOT A RANGE. The three pre-existing admin-* functions import
// "@supabase/supabase-js@2", a floating major: the code that runs in Production
// can therefore change without a commit, a review, or a test run. This function
// pins the exact version the repository's own package-lock.json already
// resolves for the application bundle (2.108.2), so the Edge runtime and the
// reviewed lockfile agree, and so upgrading is a visible, reviewable diff.
//
// Nothing else lives here. No URL is built, no header is constructed, no
// request is issued, no credential is stored, logged, or returned — the caller
// passes the URL and key in, the client is handed straight back, and the
// adapter (lib/supabase-rpc-adapter.ts) owns every actual call.

// An inline specifier is this repository's established Edge convention (all
// three admin-* functions use one) and is what the hosted runtime already
// deploys successfully. The no-import-prefix rule exists to stop scattered,
// UNPINNED URL imports; this is a single EXACT pin, asserted by
// lib/static_guards_test.ts, which additionally proves that no second
// production file carries a remote import at all. Introducing a per-function
// deno.json import map instead would add hosting configuration that cannot be
// verified locally and that no deployment gate in this repository covers yet.
// deno-lint-ignore no-import-prefix
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.108.2";

import type {
  SupabaseRpcTransport,
  SupabaseRpcTransportFactory,
} from "./supabase-rpc-adapter.ts";

/** The exact pinned specifier, re-exported so a guard can assert on it. */
export const SUPABASE_JS_PINNED_SPECIFIER =
  "https://esm.sh/@supabase/supabase-js@2.108.2";

/**
 * Builds the real transport the adapter will drive.
 *
 * The auth options arrive already decided by the adapter and are forwarded
 * unchanged: a server-to-server caller has no session to refresh, nothing to
 * persist, and no URL to detect one in. The single cast is the transport
 * boundary itself — supabase-js's builder is structurally the minimal
 * `rpc(name, args).abortSignal(signal)` surface the adapter declares, and this
 * is the one place that correspondence is asserted rather than inferred.
 */
export const createSupabaseRpcTransport: SupabaseRpcTransportFactory = (
  options,
) => {
  const client = createClient(options.supabaseUrl, options.secretKey, {
    auth: options.auth,
  });
  return client as unknown as SupabaseRpcTransport;
};
