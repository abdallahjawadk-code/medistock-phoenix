// Production Outbox RPC adapter (D3-2C) — UNWIRED.
//
// This is the ONLY file in this function permitted to name the four Migration
// 163 routines or to invoke a remote procedure. lib/static_guards_test.ts
// allow-lists exactly this path for those identifiers and asserts that no
// non-test production file imports it, so the adapter exists but is
// unreachable: index.ts and lib/handler.ts are unchanged and do not know it
// exists. Wiring is D3-2D and separately owner-authorized.
//
// D1 RULING — NO supabase-js RUNTIME DEPENDENCY IN THIS SLICE.
// This module imports nothing remote: no npm: specifier, no https: module, no
// import map, no lockfile. It defines a MINIMAL STRUCTURAL BOUNDARY for the
// one capability it needs — invoking a remote procedure with an abort signal —
// and takes the transport in by injection. Consequences, all deliberate:
//
//   * D3-2C is fully offline-validatable: fmt/lint/check/test need no network,
//     no module cache, and no dependency resolution;
//   * selecting and exactly pinning a reviewed supabase-js version is D3-2D's
//     job, at runtime composition, not this slice's;
//   * these unit tests prove ADAPTER LOGIC ONLY. They do not and cannot prove
//     the real HTTP/Data-API transport — that is the D3-2E hosted gate.
//
// Everything else is injected too: URL, credential, timeout, and (for
// deterministic tests) the abort-signal factory. There is NO environment
// lookup, NO global mutable state, NO session, NO retry, NO table access, NO
// outbound request construction, and NO logging of any kind in this file.

import type {
  ClaimBatchInput,
  ClaimedOutboxEvent,
  MarkCompletedInput,
  MarkCompletedResult,
  MarkFailedInput,
  MarkFailedResult,
  OutboxRpcClient,
  ReleaseLeaseInput,
  ReleaseLeaseResult,
} from "./rpc-client.ts";
import {
  validateClaimedEvents,
  validateMarkCompletedResult,
  validateMarkFailedResult,
  validateReleaseLeaseResult,
} from "./rpc-result-validation.ts";

// ── Structural transport boundary ───────────────────────────────────────────

/** What a Data-API-style client resolves with. Deliberately untyped error. */
export interface RpcResult<T> {
  readonly data: T | null;
  readonly error: unknown | null;
}

/**
 * A pending remote-procedure request. Thenable so it can be awaited directly,
 * and carrying the one builder method this adapter uses. Every call in this
 * file chains abortSignal(...) exactly once — a request without a deadline is
 * not permitted.
 */
export interface RpcRequest<T> extends PromiseLike<RpcResult<T>> {
  abortSignal(signal: AbortSignal): PromiseLike<RpcResult<T>>;
}

/** The single capability this adapter requires of any transport. */
export interface SupabaseRpcTransport {
  rpc<T>(functionName: string, args: Record<string, unknown>): RpcRequest<T>;
}

/**
 * Constructs a transport. The auth options are passed exactly as declared —
 * a server-to-server caller has no session to refresh, nothing to persist, and
 * no URL to inspect for one.
 */
export type SupabaseRpcTransportFactory = (options: {
  supabaseUrl: string;
  secretKey: string;
  auth: {
    autoRefreshToken: false;
    persistSession: false;
    detectSessionInUrl: false;
  };
}) => SupabaseRpcTransport;

export type AbortSignalFactory = (timeoutMs: number) => AbortSignal;

// ── Errors ──────────────────────────────────────────────────────────────────

/**
 * A sanitized transport/database failure.
 *
 * Carries the `code` ONLY when the transport supplied one in a shape this
 * system can actually produce (see SAFE_SQLSTATE_SHAPE / SAFE_PGRST_SHAPE),
 * plus a `reason` ONLY when the database's own message is a bare snake_case
 * identifier — which is exactly the form Migration 163 raises
 * (`consumer_disabled`, `stale_or_foreign_lease_token`, `consumer_not_found`,
 * `delivery_state_not_found`, `batch_size_out_of_bounds`, ...). Any richer
 * message is dropped, because a generic Postgres error can embed row values,
 * constraint contents, or parameters. The raw error object is never attached,
 * never serialized, and never logged.
 */
export class OutboxRpcTransportError extends Error {
  readonly code: string | null;
  readonly reason: string | null;

  constructor(operation: string, code: string | null, reason: string | null) {
    const suffix = [code ? `code=${code}` : null, reason]
      .filter((part) => part !== null)
      .join(" ");
    super(
      suffix.length > 0
        ? `outbox rpc ${operation} failed: ${suffix}`
        : `outbox rpc ${operation} failed`,
    );
    this.name = "OutboxRpcTransportError";
    this.code = code;
    this.reason = reason;
  }
}

/** Rejects configuration without ever echoing the offending value. */
export class OutboxRpcConfigurationError extends Error {
  constructor(field: string, expectation: string) {
    super(`outbox rpc adapter misconfigured: ${field} ${expectation}`);
    this.name = "OutboxRpcConfigurationError";
  }
}

// Migration 163 raises bare snake_case identifiers. Anything else is treated
// as potentially value-bearing and discarded.
const SAFE_REASON_SHAPE = /^[a-z][a-z0-9_]{0,63}$/;

// A transport `code` is admitted ONLY in one of the two shapes this stack can
// actually produce. Everything else — a prose sentence, a URL, a credential, a
// row value, a control character, an over-long string — is dropped rather than
// trusted, exactly as a rich `message` already is. These anchors are strict:
// JavaScript `$` (without the `m` flag) matches end-of-input only, so a
// trailing newline cannot smuggle a payload past them, and neither character
// class admits whitespace, punctuation, or control characters.
//
// A rejected value is DISCARDED, never repaired: nothing here trims, upcases,
// truncates, or otherwise normalizes an unsafe value into a safe one, because
// a normalized value still originated outside this boundary.
const SAFE_SQLSTATE_SHAPE = /^[0-9A-Z]{5}$/; // e.g. 23505, 42501, P0001
const SAFE_PGRST_SHAPE = /^PGRST[0-9]{3}$/; // e.g. PGRST116, PGRST202

// Upper bound on an injected deadline. A dispatch cycle that has not returned
// within five minutes has already outlived any reasonable lease, and an
// unbounded timeout would let one stuck call pin a worker indefinitely.
export const MAX_TIMEOUT_MS = 300_000;

/**
 * Reads one property without letting the source decide what happens next.
 *
 * A throwing getter, or a Proxy whose `get` trap throws, is treated exactly
 * like an absent property: the thrown value is swallowed unread — never
 * inspected, never serialized, never re-thrown — so a hostile or merely broken
 * error object cannot replace the real transport failure with a message of its
 * own choosing, and cannot smuggle a value out through an exception.
 */
function readOwnProperty(source: unknown, key: string): unknown {
  if (typeof source !== "object" || source === null) return undefined;
  try {
    return (source as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

function readSafeString(source: unknown, key: string): string | null {
  const value = readOwnProperty(source, key);
  return typeof value === "string" && value.length > 0 ? value : null;
}

/**
 * Fail-closed code extraction: a code is preserved only when it matches one of
 * the two admitted shapes. Absent stays absent, non-string is dropped, and
 * anything else — including a value that merely contains a safe-looking code —
 * is omitted entirely rather than trimmed or truncated into acceptance.
 */
function readSafeCode(error: unknown): string | null {
  const value = readSafeString(error, "code");
  if (value === null) return null;
  return SAFE_SQLSTATE_SHAPE.test(value) || SAFE_PGRST_SHAPE.test(value)
    ? value
    : null;
}

function toTransportError(
  operation: string,
  error: unknown,
): OutboxRpcTransportError {
  const code = readSafeCode(error);
  const rawMessage = readSafeString(error, "message");
  const reason = rawMessage !== null && SAFE_REASON_SHAPE.test(rawMessage)
    ? rawMessage
    : null;
  return new OutboxRpcTransportError(operation, code, reason);
}

// ── Configuration ───────────────────────────────────────────────────────────

export interface SupabaseOutboxRpcClientOptions {
  readonly supabaseUrl: string;
  readonly secretKey: string;
  readonly timeoutMs: number;
  readonly clientFactory: SupabaseRpcTransportFactory;
  readonly abortSignalFactory?: AbortSignalFactory;
}

/**
 * Validates the URL is a non-empty HTTPS origin. The value itself is never
 * placed in an error message, never logged, and never returned.
 */
function assertHttpsUrl(supabaseUrl: string): void {
  if (typeof supabaseUrl !== "string" || supabaseUrl.length === 0) {
    throw new OutboxRpcConfigurationError(
      "supabaseUrl",
      "must be a non-empty string",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(supabaseUrl);
  } catch {
    throw new OutboxRpcConfigurationError(
      "supabaseUrl",
      "must be a parseable absolute URL",
    );
  }
  if (parsed.protocol !== "https:") {
    throw new OutboxRpcConfigurationError("supabaseUrl", "must use https");
  }
}

/**
 * Presence-only check. Deliberately does NOT report the credential's length,
 * prefix, or any derived property — each of those narrows a guess.
 */
function assertSecretKey(secretKey: string): void {
  if (typeof secretKey !== "string" || secretKey.length === 0) {
    throw new OutboxRpcConfigurationError(
      "secretKey",
      "must be a non-empty string",
    );
  }
}

function assertTimeout(timeoutMs: number): void {
  if (
    typeof timeoutMs !== "number" ||
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs <= 0
  ) {
    throw new OutboxRpcConfigurationError(
      "timeoutMs",
      "must be a positive safe integer",
    );
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new OutboxRpcConfigurationError(
      "timeoutMs",
      `must not exceed ${MAX_TIMEOUT_MS}`,
    );
  }
}

// ── Factory ─────────────────────────────────────────────────────────────────

/**
 * Builds an OutboxRpcClient over an injected transport.
 *
 * The transport is constructed EXACTLY ONCE per adapter instance, at factory
 * time, so no per-call construction, caching, or lazy global can creep in.
 * Every method performs exactly one remote-procedure attempt: there is no
 * retry here by design, because retry policy, backoff, and the dead-letter
 * ceiling already live in Migration 163 and a second, divergent policy is
 * precisely what the D3-2B contract forbids.
 */
export function createSupabaseOutboxRpcClient(
  options: SupabaseOutboxRpcClientOptions,
): OutboxRpcClient {
  const {
    supabaseUrl,
    secretKey,
    timeoutMs,
    clientFactory,
    abortSignalFactory,
  } = options;

  assertHttpsUrl(supabaseUrl);
  assertSecretKey(secretKey);
  assertTimeout(timeoutMs);
  if (typeof clientFactory !== "function") {
    throw new OutboxRpcConfigurationError(
      "clientFactory",
      "must be a function",
    );
  }

  const newSignal: AbortSignalFactory = abortSignalFactory ??
    ((ms) => AbortSignal.timeout(ms));

  const transport = clientFactory({
    supabaseUrl,
    secretKey,
    auth: {
      autoRefreshToken: false,
      persistSession: false,
      detectSessionInUrl: false,
    },
  });

  /**
   * One attempt, one deadline, one validation pass.
   *
   * A transport-reported error is sanitized and thrown; malformed data is
   * rejected by the shared validator; a rejection is never converted into a
   * resolved value and there is no fallback result. An abort surfaces as a
   * rejection and propagates unchanged.
   */
  async function invoke<T>(
    operation: string,
    functionName: string,
    args: Record<string, unknown>,
    validate: (raw: unknown) => T,
  ): Promise<T> {
    const result = await transport
      .rpc<unknown>(functionName, args)
      .abortSignal(newSignal(timeoutMs));

    if (result.error !== null && result.error !== undefined) {
      throw toTransportError(operation, result.error);
    }
    return validate(result.data);
  }

  return {
    claimBatch(
      input: ClaimBatchInput,
    ): Promise<readonly ClaimedOutboxEvent[]> {
      return invoke(
        "claimBatch",
        "phoenix_outbox_claim_batch",
        {
          p_consumer_key: input.consumerKey,
          p_lease_token: input.leaseToken,
          p_batch_size: input.batchSize,
        },
        validateClaimedEvents,
      );
    },

    markCompleted(input: MarkCompletedInput): Promise<MarkCompletedResult> {
      return invoke(
        "markCompleted",
        "phoenix_outbox_mark_completed",
        {
          p_consumer_key: input.consumerKey,
          p_delivery_state_id: input.deliveryStateId,
          p_lease_token: input.leaseToken,
        },
        validateMarkCompletedResult,
      );
    },

    markFailed(input: MarkFailedInput): Promise<MarkFailedResult> {
      return invoke(
        "markFailed",
        "phoenix_outbox_mark_failed",
        {
          p_consumer_key: input.consumerKey,
          p_delivery_state_id: input.deliveryStateId,
          p_lease_token: input.leaseToken,
          p_error_code: input.errorCode,
          p_error_summary: input.errorSummary,
        },
        validateMarkFailedResult,
      );
    },

    releaseLease(input: ReleaseLeaseInput): Promise<ReleaseLeaseResult> {
      return invoke(
        "releaseLease",
        "phoenix_outbox_release_lease",
        {
          p_consumer_key: input.consumerKey,
          p_delivery_state_id: input.deliveryStateId,
          p_lease_token: input.leaseToken,
        },
        validateReleaseLeaseResult,
      );
    },
  };
}
