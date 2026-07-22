/**
 * CANONICAL INTENT — a stable, unambiguous serialization of what a mutation
 * is actually asking the server to do.
 *
 * WHY THIS EXISTS
 *
 * Deriving an idempotency token from (kind, entity, generation) alone is not
 * enough. Two tabs acting on the same row before canonical state advances are
 * at the SAME generation, so they derive the SAME token — and the server
 * deduplicates the second as a replay of the first. If the two operators typed
 * different quantities, the second one is told their 50 succeeded when what
 * actually posted was the first one's 30. A silent wrong answer is worse than
 * either a rejection or a duplicate, because nothing surfaces it.
 *
 * Folding the payload into the token makes those two commands DIFFERENT
 * operations, which is what they are. Both then reach the server, and the
 * server's own caps and status checks decide the second one's fate — a
 * rejection the operator can see, instead of a fabricated success. The server
 * stays authoritative; this module only stops the client from hiding the
 * question.
 *
 * NORMALIZATION IS PART OF THE CONTRACT
 *
 * The token is only stable if the same intent always serializes identically.
 * So this is deliberately canonical rather than merely deterministic:
 *
 *   - object keys are sorted, so property order cannot change the token;
 *   - a key whose value is null, `undefined`, or a blank string is DROPPED, so
 *     an omitted optional field, an explicit null, and an explicit
 *     `notes: undefined` are one intent — this mirrors the RPC contract, where
 *     the server folds a missing argument, a null, and a blanked text field to
 *     the same null in its own fingerprint (NULLIF(btrim(...), '')). Keeping
 *     such a key would silently mint a new token for a server-identical request;
 *   - strings are trimmed, and empty strings collapse to absent, so " damaged "
 *     and "damaged" are one intent rather than two;
 *   - non-finite numbers are rejected rather than serialized, because NaN and
 *     Infinity cannot round-trip and must never reach a stock mutation;
 *   - every value is type-tagged, so the string "30" and the number 30 do not
 *     collide, and neither do null and the string "null".
 */

export class NonCanonicalIntentError extends Error {
  constructor(detail: string) {
    super(`non_canonical_intent: ${detail}`);
    this.name = 'NonCanonicalIntentError';
  }
}

/** Values a mutation payload may carry. */
export type IntentValue =
  | string | number | boolean | null | undefined
  | IntentValue[]
  | { [key: string]: IntentValue };

function encode(value: IntentValue, path: string): string {
  if (value === null || value === undefined) return 'n';

  if (typeof value === 'string') {
    const trimmed = value.trim();
    // An empty string is the absence of a value, not a distinct one.
    return trimmed === '' ? 'n' : `s${trimmed.length}:${trimmed}`;
  }

  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new NonCanonicalIntentError(`${path} is ${String(value)}`);
    }
    // Normalize -0 to 0 so they cannot produce different tokens.
    return `d:${Object.is(value, -0) ? 0 : value}`;
  }

  if (typeof value === 'boolean') return `b:${value ? 1 : 0}`;

  if (Array.isArray(value)) {
    // Order is meaningful in an array — do NOT sort.
    return `a${value.length}:[${value.map((v, i) => encode(v, `${path}[${i}]`)).join(',')}]`;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, IntentValue>)
      .map(([k, v]) => [k, encode(v, `${path}.${k}`)] as const)
      // A value that encodes to 'n' — null, undefined, or a blank string —
      // carries no information, and the server folds all three to the same null.
      // Drop the key so {}, {reason: null} and {reason: '  '} are one intent.
      // OBJECTS only: in an array a null holds a position and must be kept.
      .filter(([, enc]) => enc !== 'n')
      // Sorted, so property order in the source cannot change the token.
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, enc]) => `${k.length}:${k}=${enc}`);
    return `o${entries.length}:{${entries.join(',')}}`;
  }

  throw new NonCanonicalIntentError(`${path} has unsupported type ${typeof value}`);
}

/**
 * Serialize a mutation payload to its canonical intent string.
 *
 * Throws rather than guessing on anything that cannot round-trip. A mutation
 * whose intent cannot be pinned down must not acquire a stable token, because
 * the token would not actually describe it.
 */
export function canonicalIntent(payload: IntentValue): string {
  return encode(payload, '$');
}

/** True when two payloads express the same request. */
export function sameIntent(a: IntentValue, b: IntentValue): boolean {
  return canonicalIntent(a) === canonicalIntent(b);
}
