// Pure configuration resolution for phoenix-outbox-dispatcher (D3-2A).
//
// No Deno globals are referenced here — every environment lookup is
// dependency-injected via an EnvironmentReader, matching the same pattern
// ../../_shared/edge-auth.ts already uses. This keeps the module runnable
// and testable under both Deno and any other JS host without modification.
//
// Deliberately does NOT import ../../_shared/edge-auth.ts's
// resolveEdgeApiKeys here. That function requires BOTH SUPABASE_SECRET_KEYS
// and SUPABASE_PUBLISHABLE_KEYS to be present and well-formed, because the
// three existing admin-* functions genuinely need both: a caller-scoped
// client (publishable key) to verify a browser user's JWT, plus a
// privileged client (secret key). This endpoint has no caller-scoped
// client and no browser-JWT concept at all — it has no use for
// SUPABASE_PUBLISHABLE_KEYS, and reporting itself "degraded" because that
// unrelated variable happens to be absent would be a false signal, and an
// unnecessary coupling to a shared helper this endpoint only half-needs.
// checkSecretKeyConfiguration below re-implements just the SECRET_KEYS half
// of that same validation shape (a JSON object with a "default" property of
// the correct key-class prefix) locally, without modifying the shared
// helper (out of scope for D3-2A) and without depending on its bundled
// dual-key requirement.

export type EnvironmentReader = (name: string) => string | undefined;

export const DISPATCH_SECRET_ENV_VAR = "PHOENIX_OUTBOX_DISPATCH_SECRET";

// A cryptographically random value of at least this many characters is
// expected (e.g. `openssl rand -base64 32` or longer). This is a floor, not
// a target — see docs/phoenix/D3-2A-OUTBOX-DISPATCHER-AUTH-HEALTH.md.
export const MINIMUM_SECRET_LENGTH = 32;

export type SecretResolutionFailure =
  | "missing"
  | "empty"
  | "too_short"
  | "invalid_format";

export type SecretResolutionResult =
  | { ok: true; secret: string }
  | { ok: false; reason: SecretResolutionFailure };

// Resolves the scheduler-to-function shared secret. No default value, no
// fallback to any other key (public or otherwise) — absent or malformed
// configuration always fails closed.
export function resolveDispatchSecret(
  readEnv: EnvironmentReader,
): SecretResolutionResult {
  const raw = readEnv(DISPATCH_SECRET_ENV_VAR);
  if (raw === undefined) return { ok: false, reason: "missing" };
  if (raw.length === 0) return { ok: false, reason: "empty" };
  if (raw.length < MINIMUM_SECRET_LENGTH) {
    return { ok: false, reason: "too_short" };
  }
  // A comma in the configured secret would make it structurally
  // indistinguishable from a duplicated/ambiguous header value (see
  // lib/auth.ts) and would permanently lock every caller out — reject this
  // at configuration-resolution time rather than let it manifest later as an
  // unexplained authentication failure.
  if (raw.includes(",")) return { ok: false, reason: "invalid_format" };
  return { ok: true, secret: raw };
}

const SECRET_KEY_ENV_VAR = "SUPABASE_SECRET_KEYS";
const SECRET_KEY_PREFIX = "sb_secret_";

export type SecretKeyConfigIssue =
  | "missing_env"
  | "invalid_json"
  | "missing_default"
  | "invalid_key_type";

export type SecretKeyConfigStatus =
  | { configured: true }
  | { configured: false; issue: SecretKeyConfigIssue };

// Structural-only check of the SECRET half of the modern Supabase key
// convention — proves SUPABASE_SECRET_KEYS is present and well-formed the
// same way every existing Edge Function validates it, WITHOUT ever
// constructing a Supabase client, WITHOUT requiring
// SUPABASE_PUBLISHABLE_KEYS (see the file header for why), and WITHOUT ever
// retaining, logging, or returning the resolved key value itself — only a
// boolean plus a non-sensitive issue code survives this call.
export function checkSecretKeyConfiguration(
  readEnv: EnvironmentReader,
): SecretKeyConfigStatus {
  const raw = readEnv(SECRET_KEY_ENV_VAR);
  if (!raw) return { configured: false, issue: "missing_env" };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { configured: false, issue: "invalid_json" };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { configured: false, issue: "invalid_json" };
  }

  const value = (parsed as Record<string, unknown>).default;
  if (typeof value !== "string" || value.length === 0) {
    return { configured: false, issue: "missing_default" };
  }
  if (value !== value.trim() || !value.startsWith(SECRET_KEY_PREFIX)) {
    return { configured: false, issue: "invalid_key_type" };
  }
  return { configured: true };
}
