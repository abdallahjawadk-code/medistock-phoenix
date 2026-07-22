/**
 * CONCURRENT COMMANDS AT THE SAME GENERATION.
 *
 * Generation alone does not separate two commands issued before canonical state
 * advances — two tabs acting on one row are both at generation N. Without the
 * intent in the token they derive the SAME id, and the server deduplicates the
 * second as a replay of the first: the operator who typed 50 is told it
 * succeeded when the 30 is what actually posted. That silent wrong answer is
 * what these tests exist to prevent.
 *
 * The fake server models the real contract: it deduplicates on request id, it
 * enforces a cap, and it counts GENUINE mutations. Every claim is measured
 * against that count, and against what the second operator is actually told.
 */
import { describe, it, expect } from 'vitest';
import {
  runStockMutation, PendingIntentLedger, type TokenedWriter, type MutationResult,
} from '../stock-mutation-runner';
import { canonicalIntent, sameIntent, NonCanonicalIntentError } from '../canonical-intent';
import { operationToken } from '../operation-token';

// A type alias, not an interface: only object-literal / alias shapes are
// assignable to IntentValue's index-signature arm, which runStockMutation's
// `P extends IntentValue` constraint requires. An interface would not be.
type Payload = {
  lineId: string;
  quantity: number;
  reason?: string | null;
};

/**
 * @param capacity total quantity the row may ever accept — models the server's
 *        own cap, which stays authoritative no matter what the client derives.
 */
function fakeServer(capacity = 100) {
  const committed = new Map<string, MutationResult>();
  const calls: Array<{ requestId: string; payload: Payload }> = [];
  const loseOn = new Set<number>();
  let posted = 0;
  let mutations = 0;
  let index = 0;

  const write: TokenedWriter<Payload> = async (requestId, payload) => {
    const i = index++;
    calls.push({ requestId, payload });

    const prior = committed.get(requestId);
    if (prior) return prior; // replay — no new mutation

    if (posted + payload.quantity > capacity) {
      return { ok: false, error: 'quantity_exceeds_cap' };
    }

    mutations += 1;
    posted += payload.quantity;
    const result: MutationResult = { ok: true };
    committed.set(requestId, result);

    if (loseOn.has(i)) return { ok: false, error: 'network_timeout' };
    return result;
  };

  return {
    write, calls,
    get mutations() { return mutations; },
    get posted() { return posted; },
    loseResponseOn: (i: number) => loseOn.add(i),
  };
}

const KIND = 'transfer_line_receive';
const item = (quantity: number, generation = 0, reason: string | null = null) => ({
  entityId: 'L1',
  generation,
  payload: { lineId: 'L1', quantity, reason } as Payload,
});

describe('(1) same logical retry ⇒ same token, one mutation', () => {
  it('deduplicates a retry of the identical command', async () => {
    const server = fakeServer();
    server.loseResponseOn(0);

    const first = await runStockMutation(server.write, KIND, item(30));
    expect(first.ok).toBe(false);
    const retry = await runStockMutation(server.write, KIND, item(30));

    expect(retry.requestId).toBe(first.requestId);
    expect(retry.ok).toBe(true);
    expect(server.mutations).toBe(1);
    expect(server.posted).toBe(30);
  });
});

describe('(2) same request after reload ⇒ same token', () => {
  it('re-derives the identical token with all client state discarded', async () => {
    const server = fakeServer();
    server.loseResponseOn(0);
    const before = await runStockMutation(server.write, KIND, item(30));

    // Reload: brand-new objects, no ledger, no memory of the attempt.
    const after = await runStockMutation(server.write, KIND, {
      entityId: 'L1', generation: 0, payload: { lineId: 'L1', quantity: 30, reason: null },
    });

    expect(after.requestId).toBe(before.requestId);
    expect(server.mutations).toBe(1);
  });

  it('is unaffected by property order or equivalent spellings of the payload', async () => {
    const a = await operationToken({
      kind: KIND, entityId: 'L1', generation: 0,
      intent: canonicalIntent({ lineId: 'L1', quantity: 30, reason: null }),
    });
    const b = await operationToken({
      kind: KIND, entityId: 'L1', generation: 0,
      // reordered, whitespace-padded reason, explicit undefined
      intent: canonicalIntent({ reason: '   ', quantity: 30, lineId: 'L1', notes: undefined }),
    });
    expect(b).toBe(a);
  });
});

describe('(3) identical concurrent commands ⇒ one mutation', () => {
  it('collapses two tabs issuing the SAME command', async () => {
    const server = fakeServer();
    // Two tabs, same row, same generation, same quantity.
    const tabA = await runStockMutation(server.write, KIND, item(30));
    const tabB = await runStockMutation(server.write, KIND, item(30));

    expect(tabB.requestId).toBe(tabA.requestId);
    expect(server.mutations).toBe(1);
    expect(server.posted).toBe(30);
  });
});

describe('(4) different quantities at the same generation are DISTINCT intents', () => {
  it('never silently deduplicates a different command as a replay', async () => {
    const server = fakeServer();
    const tabA = await runStockMutation(server.write, KIND, item(30));
    const tabB = await runStockMutation(server.write, KIND, item(50));

    // Distinct operations, so distinct tokens. If these collided, tab B would
    // be handed tab A's success and believe 50 had posted.
    expect(tabB.requestId).not.toBe(tabA.requestId);
    expect(tabA.ok).toBe(true);
  });

  it('lets the SERVER cap decide the second command, visibly', async () => {
    const server = fakeServer(60); // cap below 30 + 50
    await runStockMutation(server.write, KIND, item(30));
    const tabB = await runStockMutation(server.write, KIND, item(50));

    // The operator is told the truth by the server, not a fabricated success.
    expect(tabB.ok).toBe(false);
    expect(tabB.error).toBe('quantity_exceeds_cap');
    expect(server.posted).toBe(30);
  });

  it('also separates a changed reason, not just a changed quantity', async () => {
    const server = fakeServer();
    const a = await runStockMutation(server.write, KIND, item(30, 0, 'two vials broken'));
    const b = await runStockMutation(server.write, KIND, item(30, 0, 'carton crushed'));
    expect(b.requestId).not.toBe(a.requestId);
  });

  it('treats a trimmed-equal reason as the SAME intent', async () => {
    const server = fakeServer();
    const a = await runStockMutation(server.write, KIND, item(30, 0, 'damaged'));
    const b = await runStockMutation(server.write, KIND, item(30, 0, '  damaged  '));
    expect(b.requestId).toBe(a.requestId);
    expect(server.mutations).toBe(1);
  });
});

describe('(5) an ambiguous operation cannot have its payload changed', () => {
  it('refuses a different intent before canonical reconciliation', async () => {
    const server = fakeServer();
    const ledger = new PendingIntentLedger();
    server.loseResponseOn(0);

    // Ambiguous: the server committed 30 but the client never heard.
    const first = await runStockMutation(server.write, KIND, item(30), operationToken, ledger);
    expect(first.ok).toBe(false);
    expect(server.mutations).toBe(1);

    // Editing the quantity now would post ON TOP of a commit we cannot see.
    const edited = await runStockMutation(server.write, KIND, item(50), operationToken, ledger);
    expect(edited.ok).toBe(false);
    expect(edited.error).toBe('intent_changed_before_reconciliation');
    expect(server.mutations).toBe(1);
    expect(server.posted).toBe(30);
  });

  it('still allows retrying the SAME intent while ambiguous', async () => {
    const server = fakeServer();
    const ledger = new PendingIntentLedger();
    server.loseResponseOn(0);

    await runStockMutation(server.write, KIND, item(30), operationToken, ledger);
    const retry = await runStockMutation(server.write, KIND, item(30), operationToken, ledger);
    expect(retry.ok).toBe(true);
    expect(server.mutations).toBe(1);
  });

  it('permits a new intent once a canonical reload has reconciled', async () => {
    const server = fakeServer();
    const ledger = new PendingIntentLedger();
    server.loseResponseOn(0);

    await runStockMutation(server.write, KIND, item(30), operationToken, ledger);
    expect(ledger.isPending('L1')).toBe(true);

    // Canonical reload: the operator can now see what really happened.
    ledger.reconcile();
    expect(ledger.isPending('L1')).toBe(false);

    const next = await runStockMutation(server.write, KIND, item(20, 30), operationToken, ledger);
    expect(next.ok).toBe(true);
    expect(server.posted).toBe(50);
  });

  it('constrains only the row that is actually ambiguous', async () => {
    const server = fakeServer();
    const ledger = new PendingIntentLedger();
    server.loseResponseOn(0);
    await runStockMutation(server.write, KIND, item(30), operationToken, ledger);

    const other = await runStockMutation(server.write, KIND, {
      entityId: 'L2', generation: 0, payload: { lineId: 'L2', quantity: 10, reason: null },
    }, operationToken, ledger);
    expect(other.ok).toBe(true);
  });
});

describe('(6) server caps and canonical reload remain authoritative', () => {
  it('a distinct token never buys a client past the cap', async () => {
    const server = fakeServer(50);
    await runStockMutation(server.write, KIND, item(40));
    // A genuinely different intent — but the server still refuses.
    const over = await runStockMutation(server.write, KIND, item(30, 0, 'different'));
    expect(over.ok).toBe(false);
    expect(server.posted).toBe(40);
  });

  it('generation still advances legitimate partials after canonical reload', async () => {
    const server = fakeServer();
    const a = await runStockMutation(server.write, KIND, item(30, 0));
    const b = await runStockMutation(server.write, KIND, item(20, 30));
    expect(b.requestId).not.toBe(a.requestId);
    expect(server.mutations).toBe(2);
    expect(server.posted).toBe(50);
  });
});

describe('(7) requestId and volatile client-only fields cannot influence the token', () => {
  it('carries no timestamp or nonce — re-derivation is identical over time', async () => {
    const identity = {
      kind: KIND, entityId: 'L1', generation: 0,
      intent: canonicalIntent({ lineId: 'L1', quantity: 30, reason: null }),
    };
    const first = await operationToken(identity);
    // A later attempt: nothing about "when" it runs is an input to the token.
    const later = await operationToken({ ...identity });
    expect(later).toBe(first);
  });

  it('treats the derived requestId as output-only — it is never fed back in', async () => {
    const server = fakeServer();
    const a = await runStockMutation(server.write, KIND, item(30));
    // The second derivation has no knowledge of a.requestId, yet lands on the
    // same value: the token is a function of the intent, not of any prior id.
    const b = await runStockMutation(server.write, KIND, item(30));
    expect(b.requestId).toBe(a.requestId);
  });

  it('refuses a client-only callback rather than folding it into the intent', async () => {
    const server = fakeServer();
    const withCallback = {
      entityId: 'L1', generation: 0,
      // onDone is UI plumbing, not a server argument — it must never reach a
      // fingerprint, and being unserializable it fails closed instead.
      payload: { lineId: 'L1', quantity: 30, onDone: () => {} } as unknown as Payload,
    };
    const r = await runStockMutation(server.write, KIND, withCallback);
    expect(r.ok).toBe(false);
    expect(r.error).toBe('operation_token_unavailable');
    expect(server.calls.length).toBe(0);
  });
});

describe('(8) malformed or unsupported payloads call no writer', () => {
  it('fails closed on a NaN quantity and never touches the server', async () => {
    const server = fakeServer();
    const r = await runStockMutation(server.write, KIND, {
      entityId: 'L1', generation: 0, payload: { lineId: 'L1', quantity: NaN },
    });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('operation_token_unavailable');
    expect(r.requestId).toBe('');
    expect(server.calls.length).toBe(0);
    expect(server.mutations).toBe(0);
  });

  it('fails closed on an Infinite quantity and never touches the server', async () => {
    const server = fakeServer();
    const r = await runStockMutation(server.write, KIND, {
      entityId: 'L1', generation: 0, payload: { lineId: 'L1', quantity: Infinity },
    });
    expect(r.ok).toBe(false);
    expect(server.calls.length).toBe(0);
  });

  it('does not let one malformed row abandon the rows after it', async () => {
    const server = fakeServer();
    // A bad row in the middle must fail closed on itself alone, leaving the
    // ledger untouched and the writer uncalled for it — the loop lives on.
    const bad = await runStockMutation(server.write, KIND, {
      entityId: 'L1', generation: 0, payload: { lineId: 'L1', quantity: NaN },
    });
    const good = await runStockMutation(server.write, KIND, item(30));
    expect(bad.ok).toBe(false);
    expect(good.ok).toBe(true);
    expect(server.mutations).toBe(1);
    expect(server.posted).toBe(30);
  });
});

describe('canonical serialization refuses what it cannot pin down', () => {
  it('rejects non-finite numbers rather than tokenizing them', () => {
    expect(() => canonicalIntent({ quantity: NaN })).toThrow(NonCanonicalIntentError);
    expect(() => canonicalIntent({ quantity: Infinity })).toThrow(NonCanonicalIntentError);
  });

  it('does not confuse a numeric string with a number', () => {
    expect(sameIntent({ q: 30 }, { q: '30' })).toBe(false);
  });

  it('does not confuse null with the string "null"', () => {
    expect(sameIntent({ q: null }, { q: 'null' })).toBe(false);
  });

  it('preserves array order', () => {
    expect(sameIntent({ ids: ['a', 'b'] }, { ids: ['b', 'a'] })).toBe(false);
  });

  it('cannot be spoofed by a delimiter inside a value', () => {
    expect(sameIntent({ a: 'x', b: 'y' }, { a: 'x=n,1:b', b: 'y' })).toBe(false);
  });
});
