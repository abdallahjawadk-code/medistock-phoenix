/**
 * STOCK-MUTATION IDEMPOTENCY — the token must be derivable, not remembered.
 *
 * The property under test is the one a Map in component memory cannot provide:
 * after a remount, a page reload, or in a second tab, recomputing the token
 * from the same server-observed facts must yield the SAME uuid — while a
 * genuinely NEW operation on the same row must yield a different one.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  operationToken, operationTokens, operationFingerprint,
  OperationTokenUnavailableError, type OperationIdentity,
} from '../operation-token';

// Intent is held constant here so these cases isolate the kind / entityId /
// generation axes; the token's dependence on the intent itself is proven in
// concurrent-intent.test.ts.
const id = (over: Partial<OperationIdentity> = {}): OperationIdentity => ({
  kind: 'outlet_dispatch_receive', entityId: 'line-1', generation: 0, intent: '', ...over,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

afterEach(() => { vi.unstubAllGlobals(); });

describe('the token is a well-formed uuid', () => {
  it('matches the uuid shape the RPC parameters require', async () => {
    expect(await operationToken(id())).toMatch(UUID_RE);
  });

  it('carries the RFC variant bits', async () => {
    const token = await operationToken(id());
    // Variant nibble (first char of group 4) must be 8, 9, a or b.
    expect('89ab').toContain(token[19]);
  });
});

describe('same logical operation → same token, with nothing stored', () => {
  it('is deterministic across repeated derivation', async () => {
    expect(await operationToken(id())).toBe(await operationToken(id()));
  });

  it('survives a remount / page reload / second tab', async () => {
    // Derived twice from independently constructed identities — no shared
    // object, no module state, nothing persisted. This is exactly what a
    // reloaded page does.
    const before = await operationToken({
      kind: 'outlet_dispatch_receive', entityId: 'line-1', generation: 0, intent: '',
    });
    const afterReload = await operationToken({
      kind: 'outlet_dispatch_receive', entityId: 'line-1', generation: 0, intent: '',
    });
    expect(afterReload).toBe(before);
  });

  it('is unchanged while an attempt stays unresolved', async () => {
    // An ambiguous failure does not move server state, so generation holds and
    // the retry derives the same token.
    const first = await operationToken(id({ generation: 0 }));
    const retryAfterAmbiguousFailure = await operationToken(id({ generation: 0 }));
    expect(retryAfterAmbiguousFailure).toBe(first);
  });
});

describe('a genuinely new operation → a different token', () => {
  it('advances when the server reports progress, so later partials are not deduplicated', async () => {
    // Receive 30 of 100, then later receive 20 more. Two real mutations.
    const firstPartial = await operationToken(id({ generation: 0 }));
    const secondPartial = await operationToken(id({ generation: 30 }));
    expect(secondPartial).not.toBe(firstPartial);
  });

  it('separates every distinct generation', async () => {
    const tokens = await Promise.all([0, 1, 2, 30, 99].map(g => operationToken(id({ generation: g }))));
    expect(new Set(tokens).size).toBe(tokens.length);
  });

  it('separates different rows', async () => {
    expect(await operationToken(id({ entityId: 'line-1' })))
      .not.toBe(await operationToken(id({ entityId: 'line-2' })));
  });

  it('separates different mutation kinds on the same row', async () => {
    // A send and a receive against one row must never share a token.
    expect(await operationToken(id({ kind: 'outlet_return_send' })))
      .not.toBe(await operationToken(id({ kind: 'outlet_return_receive' })));
  });
});

describe('the fingerprint is namespaced and fully specified', () => {
  it('includes namespace, kind, entity, generation and intent, each length-prefixed', () => {
    expect(operationFingerprint(id({ generation: 7, intent: 'i5' })))
      .toBe('35:medistock.phoenix.stock-mutation.v1|23:outlet_dispatch_receive|6:line-1|1:7|2:i5');
  });

  it('cannot be confused by a delimiter in the inputs', async () => {
    // 'a|b' + 'c' must not collide with 'a' + 'b|c'.
    expect(await operationToken(id({ kind: 'a|b', entityId: 'c' })))
      .not.toBe(await operationToken(id({ kind: 'a', entityId: 'b|c' })));
  });
});

describe('fail-closed when no stable token can be derived', () => {
  it('refuses rather than falling back to randomness', async () => {
    vi.stubGlobal('crypto', {});
    await expect(operationToken(id())).rejects.toBeInstanceOf(OperationTokenUnavailableError);
  });

  it('refuses when subtle exists but cannot digest', async () => {
    vi.stubGlobal('crypto', { subtle: {} });
    await expect(operationToken(id())).rejects.toBeInstanceOf(OperationTokenUnavailableError);
  });
});

describe('batch derivation', () => {
  it('keys tokens by entity id and agrees with single derivation', async () => {
    const ids = [id({ entityId: 'a' }), id({ entityId: 'b', generation: 5 })];
    const map = await operationTokens(ids);
    expect(map.get('a')).toBe(await operationToken(ids[0]));
    expect(map.get('b')).toBe(await operationToken(ids[1]));
    expect(map.size).toBe(2);
  });
});
