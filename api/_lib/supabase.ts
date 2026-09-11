/**
 * CN-2B trusted server — the two Supabase identities, kept deliberately apart.
 *
 * USER-SCOPED (`userClient`) carries the caller's own JWT and the public anon
 * key. Every RLS policy and every `auth.uid()` inside a SECURITY DEFINER RPC
 * therefore sees the real person. All user-authorized workflow RPCs go through
 * this client, so CN-2B adds no authorization decisions of its own — it reuses
 * `phoenix_status_center_authorized` exactly as the database already does.
 *
 * TRUSTED (`serviceClient`) carries the service-role key. It is used for
 * exactly three things: private Storage operations, the M210 authoritative
 * replay, and the M211 batch registration — the operations the database itself
 * refuses to expose to `authenticated`. It is never used to perform an action
 * on a user's behalf that the user could not have authorized themselves; every
 * such action is gated by a prior user-scoped authorization check.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { supabaseAnonKey, supabaseServiceRoleKey, supabaseUrl } from './env.ts';

/** The caller, as proven by their bearer token. */
export interface AuthenticatedCaller {
  userId: string;
  accessToken: string;
  client: SupabaseClient;
}

function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization') ?? req.headers.get('Authorization');
  if (!header) return null;
  const match = header.match(/^Bearer\s+(.+)$/i);
  if (!match) return null;
  const token = match[1].trim();
  return token === '' ? null : token;
}

/** A client that acts AS the caller: RLS applies, auth.uid() is the caller. */
export function userClient(accessToken: string): SupabaseClient {
  return createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/** The trusted backend identity. Never constructed from request data. */
export function serviceClient(): SupabaseClient {
  return createClient(supabaseUrl(), supabaseServiceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

/**
 * AUTHENTICATE FIRST. Verifies the bearer token against Supabase Auth before
 * any endpoint does any work at all. A request without a valid token never
 * reaches an authorization check, a storage operation or a database read.
 */
export async function authenticate(req: Request): Promise<AuthenticatedCaller | null> {
  const accessToken = bearerToken(req);
  if (!accessToken) return null;

  const client = userClient(accessToken);
  const { data, error } = await client.auth.getUser();
  if (error || !data?.user?.id) return null;

  return { userId: data.user.id, accessToken, client };
}

/**
 * AUTHORIZE through the canonical model, as the caller.
 *
 * This is `public.phoenix_status_center_authorized`, the same function every
 * Central Needs RLS policy and every CN-1B guard calls. Running it on the
 * user-scoped client means the answer is computed for the real `auth.uid()`,
 * with no organization identity supplied by the browser being trusted.
 */
export async function callerIsAuthorized(
  caller: AuthenticatedCaller,
  organizationId: string,
  permissionKey: string,
): Promise<boolean> {
  const { data, error } = await caller.client.rpc('phoenix_status_center_authorized', {
    p_organization_id: organizationId,
    p_key: permissionKey,
  });
  if (error) return false;
  return data === true;
}

/**
 * Resolve a plan revision from CANONICAL DATABASE STATE.
 *
 * The organization is read from the row, never from the request. A browser
 * that supplies someone else's organization_id changes nothing: it is not an
 * input here. The read runs on the user-scoped client, so RLS
 * (`central_needs.view`) already governs visibility; a caller who cannot see
 * the revision gets `null` and the endpoint answers 404 rather than disclosing
 * that the revision exists.
 */
export interface ResolvedRevision {
  id: string;
  organizationId: string;
  planId: string;
  status: string;
  revisionNumber: number;
}

export async function resolveRevisionAsCaller(
  caller: AuthenticatedCaller,
  planRevisionId: string,
): Promise<ResolvedRevision | null> {
  const { data, error } = await caller.client
    .from('central_needs_plan_revisions')
    .select('id, organization_id, plan_id, status, revision_number')
    .eq('id', planRevisionId)
    .maybeSingle();

  if (error || !data) return null;
  return {
    id: data.id as string,
    organizationId: data.organization_id as string,
    planId: data.plan_id as string,
    status: data.status as string,
    revisionNumber: data.revision_number as number,
  };
}
