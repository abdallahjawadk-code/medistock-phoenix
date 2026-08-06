// Pure request handler for phoenix-outbox-dispatcher (D3-2A). Composes the
// other lib/ modules into the endpoint's full decision logic. No Deno
// globals — index.ts is the only file that touches Deno.serve/Deno.env, and
// it does so only to call this function.
//
// Absolute scope boundary: this file must never import, reference, or call
// any D3-1 Outbox claim/complete/fail/release RPC or either of the two
// D3-1 Outbox tables, must never construct a Supabase client, and must
// never make an outbound network call. lib/static_guards_test.ts asserts
// this mechanically by scanning this directory's own source text — see
// docs/phoenix/D3-2A-OUTBOX-DISPATCHER-AUTH-HEALTH.md for the full list of
// prohibited identifiers and why.

import {
  checkSecretKeyConfiguration,
  type EnvironmentReader,
  resolveDispatchSecret,
} from "./config.ts";
import { validateSchedulerAuth } from "./auth.ts";
import { buildHealthPayload } from "./health.ts";
import { hasUnexpectedBody, isSupportedMethod } from "./request.ts";

// Every response this endpoint ever returns goes through this one function,
// so "Cache-Control: no-store" here covers every status class (200, 400,
// 401, 405, 500, 503) by construction — there is no other return path.
// This is a caching directive only: no cookie, Vary, auth token, database
// identifier, or new body field is added, and no status code or body
// changes as a result.
function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export function handleDispatcherRequest(
  request: Request,
  readEnv: EnvironmentReader,
  now: Date = new Date(),
): Response {
  if (!isSupportedMethod(request.method)) {
    return jsonResponse({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }
  if (hasUnexpectedBody(request)) {
    return jsonResponse({ ok: false, error: "MALFORMED_REQUEST" }, 400);
  }

  // Resolve OUR OWN secret before looking at the caller's header at all. If
  // the server itself is misconfigured, no caller can be authenticated
  // regardless of what they present — respond 500, never 401, and never
  // touch or echo anything about the caller's own header in this branch.
  const secretResult = resolveDispatchSecret(readEnv);
  if (!secretResult.ok) {
    return jsonResponse({ ok: false, error: "NOT_CONFIGURED" }, 500);
  }

  // Every distinct auth failure reason (missing/empty/ambiguous/incorrect)
  // collapses to the same generic response — see lib/auth.ts for why.
  const authResult = validateSchedulerAuth(
    request.headers,
    secretResult.secret,
  );
  if (!authResult.ok) {
    return jsonResponse({ ok: false, error: "NOT_AUTHENTICATED" }, 401);
  }

  // Only an authenticated caller ever sees configuration-health detail.
  const secretKeyStatus = checkSecretKeyConfiguration(readEnv);
  const payload = buildHealthPayload({
    healthy: secretKeyStatus.configured,
    now,
  });
  return jsonResponse(payload, secretKeyStatus.configured ? 200 : 503);
}
