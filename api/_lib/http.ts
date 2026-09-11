/**
 * CN-2B trusted server — HTTP plumbing.
 *
 * Every response body this module produces is constructed field by field.
 * Nothing ever spreads a Supabase error object, an environment value or a
 * caught exception into a response, so a misconfiguration cannot leak a key
 * or a connection string to a caller.
 */
import { TRANSPORT_LIMITS } from './env.ts';

export interface ErrorBody {
  ok: false;
  error: string;
  detail?: string;
}

const JSON_HEADERS: Record<string, string> = {
  'content-type': 'application/json; charset=utf-8',
  // These endpoints are same-origin only and must never be cached by a shared
  // cache: responses can carry authorized, organization-scoped evidence.
  'cache-control': 'no-store',
  'x-content-type-options': 'nosniff',
};

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export function errorResponse(status: number, error: string, detail?: string): Response {
  const body: ErrorBody = detail === undefined ? { ok: false, error } : { ok: false, error, detail };
  return jsonResponse(status, body);
}

/** Refuses anything but the single verb an endpoint implements. */
export function requireMethod(req: Request, method: 'GET' | 'POST'): Response | null {
  if (req.method !== method) {
    return errorResponse(405, 'method_not_allowed', `expected ${method}`);
  }
  return null;
}

/**
 * Reads a bounded JSON body. The Content-Length preflight is an optimisation;
 * the byte count of what was actually read is authoritative, because a
 * chunked request can under-declare or omit its length entirely.
 */
export async function readJsonBody<T>(req: Request): Promise<{ value: T } | { error: Response }> {
  const declared = req.headers.get('content-length');
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > TRANSPORT_LIMITS.maxRequestBodyBytes) {
      return { error: errorResponse(413, 'request_body_too_large') };
    }
  }

  let text: string;
  try {
    text = await req.text();
  } catch {
    return { error: errorResponse(400, 'request_body_unreadable') };
  }

  if (new TextEncoder().encode(text).byteLength > TRANSPORT_LIMITS.maxRequestBodyBytes) {
    return { error: errorResponse(413, 'request_body_too_large') };
  }

  try {
    return { value: JSON.parse(text) as T };
  } catch {
    return { error: errorResponse(400, 'request_body_not_json') };
  }
}

/**
 * Maps a thrown value to a response WITHOUT echoing it.
 *
 * PostgreSQL RPC failures are surfaced by their stable machine-readable
 * message (`forbidden_central_needs`, `plan_revision_not_editable`, ...) which
 * every CN-1B RPC raises deliberately for exactly this purpose. Anything not
 * recognised becomes a generic 500 with no detail at all.
 */
export function failureResponse(err: unknown): Response {
  const message = err instanceof Error ? err.message : '';

  if (message.startsWith('server_not_configured:')) {
    // The variable NAME is safe to report; the value is never read here.
    return errorResponse(503, 'server_not_configured', message.slice('server_not_configured:'.length).trim());
  }
  if (message === 'not_authenticated') return errorResponse(401, 'not_authenticated');
  if (message === 'forbidden_central_needs') return errorResponse(403, 'forbidden');

  return errorResponse(500, 'internal_error');
}

/**
 * A PostgREST/PostgREST-shaped error carries the RPC's RAISE message. These are
 * the stable, intentionally machine-readable identifiers CN-1B/CN-2B raise; they
 * describe a refusal, never a secret.
 */
export function rpcErrorResponse(error: { message?: string } | null): Response | null {
  if (!error) return null;
  const message = typeof error.message === 'string' ? error.message : '';

  if (message.includes('not_authenticated')) return errorResponse(401, 'not_authenticated');
  if (message.includes('forbidden_central_needs')) return errorResponse(403, 'forbidden');
  if (message.includes('_not_found')) return errorResponse(404, 'not_found', firstToken(message));
  if (message.includes('archived_organization')) {
    return errorResponse(409, 'organization_archived');
  }
  if (message.includes('not_editable') || message.includes('not_open') || message.includes('not_ready')) {
    return errorResponse(409, 'conflict', firstToken(message));
  }
  if (message !== '') return errorResponse(422, 'rejected', firstToken(message));
  return errorResponse(500, 'internal_error');
}

/** The leading machine-readable token of a RAISE message, with no free text. */
function firstToken(message: string): string {
  const match = message.match(/[a-z0-9_]{4,}/i);
  return match ? match[0] : 'unspecified';
}
