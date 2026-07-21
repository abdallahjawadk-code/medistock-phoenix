/**
 * STOCK-MUTATION IDEMPOTENCY — deterministic operation tokens.
 *
 * Every stock-moving RPC in this app (065/070/071) deduplicates on a
 * caller-supplied `p_request_id`: replaying a token returns the original result
 * instead of posting again. That makes the token the single thing standing
 * between a lost response and double-posted pharmaceutical stock.
 *
 * WHY THIS IS DERIVED RATHER THAN REMEMBERED
 *
 * The obvious implementation — mint a random uuid and keep it in a Map — is
 * only as durable as the component holding it. A page reload, a remount, or an
 * operator reopening the screen in a second tab all lose the Map, and the next
 * "Retry" mints a FRESH token, which the server sees as a brand-new operation.
 * That is the exact double-post the token was supposed to prevent, just moved
 * one step further away from where anyone would look for it.
 *
 * So a token is not stored at all. It is DERIVED from facts the server itself
 * reports:
 *
 *     token = uuid(SHA-256( namespace | kind | entityId | generation ))
 *
 * Recomputing it after a reload yields the same value, because the inputs are
 * the same. Nothing is persisted, so there is no per-tab or per-session hole.
 *
 * THE `generation` FIELD IS WHAT MAKES PARTIAL OPERATIONS SAFE
 *
 * `generation` is a monotonic, SERVER-derived measure of how much of this
 * entity's work is already done — a received quantity, a sent quantity, a
 * returned quantity, a count of prior movements. It does two jobs at once:
 *
 *   - While an attempt is unresolved, the server state has not moved, so the
 *     generation is unchanged and a retry derives the SAME token. Ambiguous
 *     failures and lost responses are therefore safe by construction.
 *
 *   - Once an operation is canonically confirmed, the generation advances, so
 *     the NEXT legitimate operation on the same entity derives a DIFFERENT
 *     token. A genuine second partial send/receive is never mistaken for a
 *     replay of the first — which a naive "one token per line, forever" scheme
 *     would get wrong in the opposite direction.
 *
 * Fail-closed: if no Web Crypto digest is available we refuse to produce a
 * token rather than fall back to randomness. A caller that cannot derive a
 * stable token must not mutate stock; declining is recoverable, double-posting
 * is not.
 */

/** Bumping this invalidates every derived token. Do not change casually. */
const TOKEN_NAMESPACE = 'medistock.phoenix.stock-mutation.v1';

export interface OperationIdentity {
  /** The logical mutation, e.g. 'outlet_dispatch_receive'. Namespaces entityId. */
  kind: string;
  /** The row the mutation acts on — dispatch line, transfer line, shipment line. */
  entityId: string;
  /**
   * Server-derived progress already completed for this entity. MUST come from a
   * canonical read, never from local optimism, or the token stops being stable
   * across a reload.
   */
  generation: number;
  /**
   * Canonical serialization of every mutation-relevant input (see
   * canonical-intent.ts).
   *
   * Generation alone is not sufficient. Two tabs acting before canonical state
   * advances sit at the SAME generation, so without the intent they derive the
   * same token and the server deduplicates the second as a replay of the first
   * — telling an operator their 50 succeeded when the 30 is what posted. Two
   * different commands are two operations, and the token has to say so; the
   * server's caps then reject the one that must not proceed, visibly.
   */
  intent: string;
}

export class OperationTokenUnavailableError extends Error {
  constructor() {
    super('operation_token_unavailable: no Web Crypto digest; refusing to mutate stock without a stable token');
    this.name = 'OperationTokenUnavailableError';
  }
}

/**
 * The exact string hashed. Exported so tests can pin the shape.
 *
 * Each component is length-prefixed rather than merely delimited: plain
 * `join('|')` lets `kind='a|b', entity='c'` collide with `kind='a', entity='b|c'`.
 * Today's inputs are a hardcoded literal and a uuid, so neither contains a
 * pipe — but an encoding whose safety depends on that is one careless caller
 * away from two different mutations sharing a token, which is precisely the
 * failure this module exists to prevent.
 */
export function operationFingerprint(identity: OperationIdentity): string {
  const part = (s: string) => `${s.length}:${s}`;
  return [
    TOKEN_NAMESPACE,
    identity.kind,
    identity.entityId,
    String(identity.generation),
    identity.intent,
  ].map(part).join('|');
}

function uuidFromBytes(bytes: Uint8Array): string {
  const b = bytes.slice(0, 16);
  // RFC 9562 §5.8 custom version + RFC 4122 variant, so the value is a
  // well-formed uuid for the `uuid`-typed RPC parameters.
  b[6] = (b[6] & 0x0f) | 0x80;
  b[8] = (b[8] & 0x3f) | 0x80;
  const hex = Array.from(b, x => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * Derive the stable token for one logical stock mutation.
 *
 * Deterministic: the same identity always yields the same uuid, in this tab, in
 * another tab, and after a full page reload.
 */
export async function operationToken(identity: OperationIdentity): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle?.digest) throw new OperationTokenUnavailableError();

  const data = new TextEncoder().encode(operationFingerprint(identity));
  const digest = await subtle.digest('SHA-256', data);
  return uuidFromBytes(new Uint8Array(digest));
}

/** Convenience for the common case: derive tokens for many entities at once. */
export async function operationTokens(
  identities: readonly OperationIdentity[],
): Promise<Map<string, string>> {
  const entries = await Promise.all(
    identities.map(async id => [id.entityId, await operationToken(id)] as const),
  );
  return new Map(entries);
}
