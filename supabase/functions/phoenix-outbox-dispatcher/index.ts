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

// @ts-nocheck — Deno edge runtime types are not part of the app's tsconfig.
import { handleDispatcherRequest } from "./lib/handler.ts";

Deno.serve((req: Request) =>
  handleDispatcherRequest(req, (name) => Deno.env.get(name))
);
