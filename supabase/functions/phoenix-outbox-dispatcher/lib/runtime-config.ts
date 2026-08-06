// Pure runtime activation and dispatch configuration (D3-2D).
//
// PURE. No Deno globals, no client, no network, no logging, no global mutable
// state. Every environment lookup is dependency-injected through the same
// EnvironmentReader the D3-2A configuration module already uses.
//
// This module decides TWO separate things, deliberately kept apart:
//
//   1. IS DISPATCH ENABLED AT ALL — a single exact-value check that defaults
//      to DISABLED and that nothing else in this function may reinterpret;
//   2. IF ENABLED, WHAT IS THE RUNTIME CONFIGURATION — resolved fail-closed,
//      and only ever consulted after (1) has already said yes.
//
// Keeping them apart is what makes "disabled by default" structural rather
// than conventional: a misconfigured runtime cannot accidentally enable
// dispatch, and an enabled-but-misconfigured runtime fails closed instead of
// running with a guessed default.
//
// The resolved secret key is returned so the caller can construct a transport
// with it. It is never logged, never echoed into an error, and never placed
// in a response — every failure below reports a FIELD and a REASON only.

import type { EnvironmentReader } from "./config.ts";

// ── Activation ──────────────────────────────────────────────────────────────

export const DISPATCH_ENABLED_ENV_VAR = "PHOENIX_OUTBOX_DISPATCH_ENABLED";

/**
 * The ONE value that enables dispatch. Comparison is exact and
 * case-sensitive: no trimming, no lower-casing, no truthiness, no numeric or
 * yes/on synonyms.
 *
 * A permissive parser is how a flag meant to stay off gets switched on by a
 * stray "1", a trailing newline from a secrets manager, or a "TRUE" copied
 * from another system. Absent, empty, and every other string mean DISABLED.
 */
export const DISPATCH_ENABLED_ALLOWED_VALUE = "true";

export function isDispatchEnabled(readEnv: EnvironmentReader): boolean {
  return readEnv(DISPATCH_ENABLED_ENV_VAR) === DISPATCH_ENABLED_ALLOWED_VALUE;
}

// ── Runtime configuration ───────────────────────────────────────────────────

export const SUPABASE_URL_ENV_VAR = "SUPABASE_URL";
export const SECRET_KEYS_ENV_VAR = "SUPABASE_SECRET_KEYS";
export const CONSUMER_KEY_ENV_VAR = "PHOENIX_OUTBOX_CONSUMER_KEY";
export const BATCH_SIZE_ENV_VAR = "PHOENIX_OUTBOX_BATCH_SIZE";
export const TIMEOUT_MS_ENV_VAR = "PHOENIX_OUTBOX_RPC_TIMEOUT_MS";

const SECRET_KEY_PREFIX = "sb_secret_";

/**
 * Mirrors lib/supabase-rpc-adapter.ts's MAX_TIMEOUT_MS. Duplicated here rather
 * than imported so this module stays free of the adapter (the reachability
 * allow-list is deliberately tiny); lib/runtime-config_test.ts asserts the two
 * constants are equal, so they cannot drift apart silently.
 */
export const MAX_DISPATCH_TIMEOUT_MS = 300_000;
export const DEFAULT_DISPATCH_TIMEOUT_MS = 30_000;

/** Bounds mirror Migration 163's own batch_size_out_of_bounds constraint. */
export const MIN_BATCH_SIZE = 1;
export const MAX_BATCH_SIZE = 100;
export const DEFAULT_BATCH_SIZE = 10;

// Consumer keys are bare snake_case-ish identifiers, the same shape the D3-1
// foundation registers. Anything else is rejected rather than passed to the
// database and rejected there.
const CONSUMER_KEY_SHAPE = /^[a-z][a-z0-9_-]{2,63}$/;

export interface DispatchRuntimeConfig {
  readonly supabaseUrl: string;
  readonly secretKey: string;
  readonly consumerKey: string;
  readonly batchSize: number;
  readonly timeoutMs: number;
}

export type RuntimeConfigFailure =
  | "supabase_url_missing"
  | "supabase_url_invalid"
  | "secret_keys_missing"
  | "secret_keys_invalid_json"
  | "secret_keys_missing_default"
  | "secret_keys_invalid_key_type"
  | "consumer_key_missing"
  | "consumer_key_invalid"
  | "batch_size_invalid"
  | "timeout_invalid";

export type RuntimeConfigResult =
  | { ok: true; config: DispatchRuntimeConfig }
  | { ok: false; reason: RuntimeConfigFailure };

function fail(reason: RuntimeConfigFailure): RuntimeConfigResult {
  return { ok: false, reason };
}

/**
 * Resolves everything one dispatch cycle needs, or fails closed.
 *
 * Never partially succeeds: either every field validated, or nothing is
 * returned. No field falls back to a value read from a different variable, and
 * the two OPTIONAL fields (batch size, timeout) fall back only to the explicit
 * constants above — never to an unbounded or caller-supplied value.
 */
export function resolveRuntimeConfig(
  readEnv: EnvironmentReader,
): RuntimeConfigResult {
  const rawUrl = readEnv(SUPABASE_URL_ENV_VAR);
  if (rawUrl === undefined || rawUrl.length === 0) {
    return fail("supabase_url_missing");
  }
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return fail("supabase_url_invalid");
  }
  if (parsedUrl.protocol !== "https:") return fail("supabase_url_invalid");

  const rawKeys = readEnv(SECRET_KEYS_ENV_VAR);
  if (rawKeys === undefined || rawKeys.length === 0) {
    return fail("secret_keys_missing");
  }
  let parsedKeys: unknown;
  try {
    parsedKeys = JSON.parse(rawKeys);
  } catch {
    return fail("secret_keys_invalid_json");
  }
  if (
    parsedKeys === null || typeof parsedKeys !== "object" ||
    Array.isArray(parsedKeys)
  ) {
    return fail("secret_keys_invalid_json");
  }
  const secretKey = (parsedKeys as Record<string, unknown>).default;
  if (typeof secretKey !== "string" || secretKey.length === 0) {
    return fail("secret_keys_missing_default");
  }
  if (
    secretKey !== secretKey.trim() || !secretKey.startsWith(SECRET_KEY_PREFIX)
  ) {
    return fail("secret_keys_invalid_key_type");
  }

  const rawConsumer = readEnv(CONSUMER_KEY_ENV_VAR);
  if (rawConsumer === undefined || rawConsumer.length === 0) {
    return fail("consumer_key_missing");
  }
  if (!CONSUMER_KEY_SHAPE.test(rawConsumer)) {
    return fail("consumer_key_invalid");
  }

  const batchSize = parseBoundedInteger(
    readEnv(BATCH_SIZE_ENV_VAR),
    DEFAULT_BATCH_SIZE,
    MIN_BATCH_SIZE,
    MAX_BATCH_SIZE,
  );
  if (batchSize === null) return fail("batch_size_invalid");

  const timeoutMs = parseBoundedInteger(
    readEnv(TIMEOUT_MS_ENV_VAR),
    DEFAULT_DISPATCH_TIMEOUT_MS,
    1,
    MAX_DISPATCH_TIMEOUT_MS,
  );
  if (timeoutMs === null) return fail("timeout_invalid");

  return {
    ok: true,
    config: {
      supabaseUrl: rawUrl,
      secretKey,
      consumerKey: rawConsumer,
      batchSize,
      timeoutMs,
    },
  };
}

/**
 * An absent value takes the default; a present value must be a plain decimal
 * integer inside the bounds. Deliberately strict — no whitespace tolerance, no
 * "10.0", no "1e1", no hex, no sign — because a silently coerced bound is
 * indistinguishable from a correctly configured one until it matters.
 */
function parseBoundedInteger(
  raw: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number | null {
  if (raw === undefined || raw.length === 0) return fallback;
  if (!/^[0-9]+$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) return null;
  if (value < min || value > max) return null;
  return value;
}
