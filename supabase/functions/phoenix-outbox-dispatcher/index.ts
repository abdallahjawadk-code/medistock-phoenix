// =============================================================================
// MediStock Phoenix V2 — Edge Function: phoenix-outbox-dispatcher
//
// D3-2A SLICE — authentication, health, and configuration validation ONLY.
// This file and everything under ./lib/ contain no Outbox claim/complete/
// fail/release logic, no consumer registration, no database connection, and
// no scheduler. Deployment is NOT authorized for this slice. See
// docs/phoenix/D3-2A-OUTBOX-DISPATCHER-AUTH-HEALTH.md for the full contract,
// threat model, and the authorization boundary for the next slice (D3-2B).
//
// Contract:
//   GET /functions/v1/phoenix-outbox-dispatcher
//   X-Phoenix-Dispatch-Secret: <shared secret>
//   -> 200 { service, status: "ok",       version, timestamp }
//   -> 503 { service, status: "degraded", version, timestamp }
//   -> 401 { ok: false, error: "NOT_AUTHENTICATED" }
//   -> 405 { ok: false, error: "METHOD_NOT_ALLOWED" }
//   -> 400 { ok: false, error: "MALFORMED_REQUEST" }
//   -> 500 { ok: false, error: "NOT_CONFIGURED" }
//
// Unlike the three admin-* functions, this endpoint is never called from a
// browser — its only caller is a future scheduler (mechanism undecided; see
// the D3-2 architecture-amendment report). It therefore authenticates via a
// dedicated shared-secret header instead of a user JWT, and intentionally
// carries no CORS headers at all: a server-to-server endpoint has no browser
// origin to permit.
// =============================================================================

// D3-2D UPDATE — runtime wiring, DISABLED BY DEFAULT.
//   -> 200 { service, status: "dispatched", version, timestamp, claimed,
//            completed, failed, released }   (only when explicitly enabled)
//   -> 500 { ok: false, error: "DISPATCH_FAILED" }
//
// With PHOENIX_OUTBOX_DISPATCH_ENABLED unset — the default, and the only state
// this repository has ever deployed — every response above is byte-for-byte
// the D3-2A behavior documented here. lib/runtime.ts runs the unchanged D3-2A
// handler first and returns its response verbatim unless dispatch is
// explicitly switched on. No scheduler, consumer, or secret exists.

// @ts-nocheck — Deno edge runtime types are not part of the app's tsconfig.
import { handleDispatcherRuntime } from "./lib/runtime.ts";

Deno.serve((req: Request) =>
  handleDispatcherRuntime(req, (name) => Deno.env.get(name))
);
