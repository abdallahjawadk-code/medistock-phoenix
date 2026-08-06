// Pure scheduler-to-function authentication for phoenix-outbox-dispatcher
// (D3-2A). Deliberately NOT a reuse of ../../_shared/edge-auth.ts's
// parseBearerAuthorization: that helper authenticates a browser user's JWT,
// a different caller and a different threat model from a scheduler
// presenting one static shared secret. No Deno globals referenced.

export const DISPATCH_SECRET_HEADER = "x-phoenix-dispatch-secret";

export type SchedulerAuthFailure =
  | "missing"
  | "empty"
  | "ambiguous"
  | "incorrect";

export type SchedulerAuthResult = { ok: true } | {
  ok: false;
  reason: SchedulerAuthFailure;
};

type HeaderExtraction =
  | { present: false }
  | { present: true; ambiguous: true }
  | { present: true; ambiguous: false; value: string };

// The Fetch/WHATWG Headers contract coalesces repeated header instances of
// the same name into ONE comma-joined string before any application code
// ever sees it (Headers.get() never exposes multiple raw values, and
// Headers.append() on an existing name joins with ", "). This means the
// only signal left, by the time this function runs, that a header was sent
// more than once (or under multiple case variants — header names are
// case-insensitive) is a value containing more than one non-empty,
// comma-separated segment. A single legitimate secret must therefore never
// itself contain a comma (enforced at configuration time in lib/config.ts) —
// otherwise a valid secret would be indistinguishable from a duplicated
// header, and this function intentionally treats that ambiguity as a
// rejection rather than guessing which segment was "real".
export function extractSingleHeaderValue(
  headers: Headers,
  name: string,
): HeaderExtraction {
  const raw = headers.get(name);
  if (raw === null) return { present: false };
  const segments = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (segments.length > 1) return { present: true, ambiguous: true };
  return { present: true, ambiguous: false, value: segments[0] ?? "" };
}

// Timing-resistant, full-length comparison: always walks the full length of
// the longer input and never short-circuits on the first mismatching byte,
// so response timing does not leak how many leading characters of a guess
// were correct. This is NOT presented as an absolute cryptographic
// constant-time guarantee — JavaScript on a JIT-compiled VM has no such
// guarantee available (branch prediction, string/typed-array internals, and
// GC pauses are all outside this function's control) — only that the
// obvious early-exit timing side channel (`a[i] !== b[i] -> return false`)
// is deliberately avoided.
export function timingSafeEqual(expected: string, actual: string): boolean {
  const encoder = new TextEncoder();
  const a = encoder.encode(expected);
  const b = encoder.encode(actual);
  const length = Math.max(a.length, b.length);
  let diff = a.length === b.length ? 0 : 1;
  for (let i = 0; i < length; i++) {
    diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  }
  return diff === 0;
}

// The single entry point this endpoint uses. Every failure reason is
// tracked internally (and exercised individually in tests) but the HTTP
// layer (lib/handler.ts) must collapse all of them into one identical,
// generic response — differentiating "missing" from "incorrect" from
// "ambiguous" to the caller would hand an unauthenticated party a free
// oracle into the server's own state.
export function validateSchedulerAuth(
  headers: Headers,
  expectedSecret: string,
): SchedulerAuthResult {
  const extracted = extractSingleHeaderValue(headers, DISPATCH_SECRET_HEADER);
  if (!extracted.present) return { ok: false, reason: "missing" };
  if (extracted.ambiguous) return { ok: false, reason: "ambiguous" };
  if (extracted.value.length === 0) return { ok: false, reason: "empty" };
  if (!timingSafeEqual(expectedSecret, extracted.value)) {
    return { ok: false, reason: "incorrect" };
  }
  return { ok: true };
}
