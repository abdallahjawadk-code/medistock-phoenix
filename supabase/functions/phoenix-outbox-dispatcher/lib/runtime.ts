// Runtime composition for phoenix-outbox-dispatcher (D3-2D).
//
// This is the wiring slice, and it is DISABLED BY DEFAULT. The order below is
// the whole safety argument, so it is worth stating plainly:
//
//   1. lib/handler.ts runs FIRST, completely unchanged from D3-2A. Method,
//      body, own-configuration (500) and caller authentication (401) are all
//      decided there, before this module looks at anything else.
//   2. Any non-200 gate result is returned VERBATIM. A 503 "degraded" is a
//      non-200, so a function whose secret keys are missing or malformed never
//      reaches dispatch either.
//   3. Only then is activation consulted. Disabled — the default — returns the
//      SAME response object the handler already built, so with dispatch off
//      this function's observable behavior is byte-for-byte D3-2A.
//   4. Only an enabled, fully authenticated, fully configured request ever
//      reaches runtime configuration, and only a valid configuration ever
//      reaches client construction.
//
// Consequently there is NO code path on which a client is constructed, or an
// RPC issued, for an unauthenticated caller, a misconfigured function, or a
// disabled dispatcher. That is enforced structurally by this ordering and
// asserted behaviorally by lib/runtime_test.ts.
//
// Still absent, deliberately: no scheduler, no timer, no cron, no background
// task, no queue, no polling loop, no retry (Migration 163 owns retry and
// backoff), and no second cycle — one request drives at most one cycle.

import type { EnvironmentReader } from "./config.ts";
import { handleDispatcherRequest } from "./handler.ts";
import { ARTIFACT_VERSION, SERVICE_NAME } from "./health.ts";
import { isDispatchEnabled, resolveRuntimeConfig } from "./runtime-config.ts";
import {
  createSupabaseOutboxRpcClient,
  type SupabaseRpcTransportFactory,
} from "./supabase-rpc-adapter.ts";
import { type EventProcessor, runDispatchCycle } from "./dispatch.ts";
import { createSupabaseRpcTransport } from "./supabase-client.ts";

/**
 * Until a consumer is registered and authorized (D3-2F), the dispatcher has no
 * side effect to perform. Releasing hands every claimed row straight back
 * WITHOUT burning an attempt, which is the only outcome that is correct for a
 * row nothing has processed. It is never "completed" (that would silently
 * discard an undelivered event) and never "failed" (that would consume the
 * row's retry budget for a delivery nobody attempted).
 */
const releaseEveryRow: EventProcessor = () =>
  Promise.resolve({ kind: "released" as const });

export interface DispatcherRuntimeDeps {
  /** Injected for tests; production uses the pinned supabase-js transport. */
  readonly clientFactory?: SupabaseRpcTransportFactory;
  readonly newLeaseToken?: () => string;
  readonly processEvent?: EventProcessor;
}

function jsonResponse(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
  });
}

export async function handleDispatcherRuntime(
  request: Request,
  readEnv: EnvironmentReader,
  now: Date = new Date(),
  deps: DispatcherRuntimeDeps = {},
): Promise<Response> {
  // (1) + (2) Unchanged D3-2A gates. Nothing below runs unless this is 200.
  const gate = handleDispatcherRequest(request, readEnv, now);
  if (gate.status !== 200) return gate;

  // (3) Disabled is the default and returns the handler's own response.
  if (!isDispatchEnabled(readEnv)) return gate;

  // (4) Enabled: resolve fail-closed before anything is constructed.
  const resolved = resolveRuntimeConfig(readEnv);
  if (!resolved.ok) {
    return jsonResponse({ ok: false, error: "NOT_CONFIGURED" }, 500);
  }
  const { supabaseUrl, secretKey, consumerKey, batchSize, timeoutMs } =
    resolved.config;

  const client = createSupabaseOutboxRpcClient({
    supabaseUrl,
    secretKey,
    timeoutMs,
    clientFactory: deps.clientFactory ?? createSupabaseRpcTransport,
  });

  const leaseToken = (deps.newLeaseToken ?? (() => crypto.randomUUID()))();

  try {
    const summary = await runDispatchCycle({
      client,
      consumerKey,
      leaseToken,
      batchSize,
      processEvent: deps.processEvent ?? releaseEveryRow,
    });
    return jsonResponse({
      service: SERVICE_NAME,
      status: "dispatched",
      version: ARTIFACT_VERSION,
      timestamp: now.toISOString(),
      claimed: summary.claimed,
      completed: summary.completed,
      failed: summary.failed,
      released: summary.released,
    }, 200);
  } catch {
    // One attempt, no retry, no fallback summary. The caught value is
    // discarded unread: a database or transport error can carry row values,
    // and this response is the one thing a caller always sees.
    return jsonResponse({ ok: false, error: "DISPATCH_FAILED" }, 500);
  }
}
