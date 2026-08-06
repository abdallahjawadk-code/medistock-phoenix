// Pure health-payload construction for phoenix-outbox-dispatcher (D3-2A).
// No Deno globals, no environment access — the caller supplies everything
// this module needs, which is what makes it trivially deterministic to test.

export const SERVICE_NAME = "phoenix-outbox-dispatcher";

// Bump this string when this slice's observable behavior changes.
// Deliberately not tied to a git SHA or build id — no build/version
// metadata pipeline exists for Edge Functions in this repository yet, and
// inventing one is out of scope for D3-2A.
export const ARTIFACT_VERSION = "d3-2a.1";

export interface HealthPayload {
  service: string;
  status: "ok" | "degraded";
  version: string;
  timestamp: string;
}

export function buildHealthPayload(
  params: { healthy: boolean; now: Date },
): HealthPayload {
  return {
    service: SERVICE_NAME,
    status: params.healthy ? "ok" : "degraded",
    version: ARTIFACT_VERSION,
    timestamp: params.now.toISOString(),
  };
}
