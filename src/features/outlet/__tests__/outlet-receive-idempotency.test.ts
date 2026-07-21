/**
 * OUTLET-CORRIDOR-070 §2A — receipt idempotency, driven through an INJECTED
 * writer rather than scanned from source.
 *
 * The fake server below models the part of the 070/065 contract that actually
 * matters here: it deduplicates on `p_request_id`, so replaying a token returns
 * the original result and does NOT post again. Every claim about retry safety
 * is measured against `mutations` — the number of times stock genuinely moved —
 * not against how many times the client called.
 *
 * This is the test that catches the bug source-scanning could not: a component
 * that mints a fresh token per attempt still "looks" idempotent in source,
 * because it does pass a request id. It is only when a lost response is
 * replayed that the difference shows up as double-posted stock.
 */
import { describe, it, expect } from 'vitest';
import {
  ReceiptTokenStore, runSingleReceive, runBulkReceive, confirmedLineIds,
  type ReceiveRpcInput, type ReceiveRpcResult, type ReceiveWriter,
} from '../outlet-receive-runner';

/** Deterministic token minting, so assertions can name exact values. */
function counterMint() {
  let n = 0;
  return () => `tok-${++n}`;
}

interface FakeServer {
  write: ReceiveWriter;
  calls: ReceiveRpcInput[];
  readonly mutations: number;
  /** Commit server-side but lose the response for these line ids, once each. */
  loseResponseFor(lineIds: string[]): void;
  /** Fail outright (no commit) for these line ids, once each. */
  rejectOnce(lineIds: string[], error: string): void;
}

function fakeServer(): FakeServer {
  const committed = new Map<string, ReceiveRpcResult>();
  const calls: ReceiveRpcInput[] = [];
  const loseFor = new Set<string>();
  const rejectFor = new Map<string, string>();
  let mutations = 0;

  const write: ReceiveWriter = async (input) => {
    calls.push({ ...input });

    // Replay of a token the server already committed: return the original
    // result, post nothing. This is the real 070 behaviour.
    const prior = committed.get(input.requestId);
    if (prior) return prior;

    // A hard rejection never commits.
    const rejection = rejectFor.get(input.dispatchLineId);
    if (rejection !== undefined) {
      rejectFor.delete(input.dispatchLineId);
      return { ok: false, error: rejection };
    }

    // Otherwise the server commits.
    mutations += 1;
    const result: ReceiveRpcResult = { ok: true };
    committed.set(input.requestId, result);

    // ...but the response may be lost in transit. The client sees a failure
    // even though stock HAS moved. This is the case idempotency exists for.
    if (loseFor.has(input.dispatchLineId)) {
      loseFor.delete(input.dispatchLineId);
      return { ok: false, error: 'network_timeout' };
    }
    return result;
  };

  return {
    write,
    calls,
    get mutations() { return mutations; },
    loseResponseFor: (ids) => ids.forEach(id => loseFor.add(id)),
    rejectOnce: (ids, error) => ids.forEach(id => rejectFor.set(id, error)),
  };
}

const sel = (lineId: string, receivedQuantity = 10) =>
  ({ lineId, receivedQuantity, differenceReason: null });

describe('§2A(1) a lost response after server success must not post stock twice', () => {
  it('reuses the SAME token on retry, and the server posts exactly once', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());
    server.loseResponseFor(['L1']);

    // Attempt 1: the server commits, the response is lost, the client sees a failure.
    const first = await runSingleReceive(server.write, store, sel('L1'));
    expect(first.ok).toBe(false);
    expect(first.error).toBe('network_timeout');
    expect(server.mutations).toBe(1);

    // Attempt 2: the retry must go out under the SAME token.
    const second = await runSingleReceive(server.write, store, sel('L1'));
    expect(second.requestId).toBe(first.requestId);

    // The replay is deduplicated: the client now learns it succeeded, and
    // stock moved exactly once across both attempts.
    expect(second.ok).toBe(true);
    expect(server.mutations).toBe(1);
    expect(server.calls).toHaveLength(2);
    expect(server.calls[0].requestId).toBe(server.calls[1].requestId);
  });

  it('a fresh token per attempt WOULD double-post — the regression this pins', async () => {
    const server = fakeServer();
    const mint = counterMint();
    server.loseResponseFor(['L1']);

    // Simulate the old behaviour: a new token each attempt.
    await server.write({ requestId: mint(), dispatchLineId: 'L1', receivedQuantity: 10, differenceReason: null });
    await server.write({ requestId: mint(), dispatchLineId: 'L1', receivedQuantity: 10, differenceReason: null });

    // Two logical operations, two postings. This is the bug.
    expect(server.mutations).toBe(2);
  });

  it('holds the token until a canonical reload proves receipt, then releases it', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());
    server.loseResponseFor(['L1']);

    const first = await runSingleReceive(server.write, store, sel('L1'));
    // A reload that does NOT yet show the line as received keeps the token.
    store.releaseConfirmed([{ id: 'L1', receivedQuantity: null }]);
    expect(store.has('L1')).toBe(true);
    expect(store.tokenFor('L1')).toBe(first.requestId);

    // Once the server proves the outcome, the token is done.
    const released = store.releaseConfirmed([{ id: 'L1', receivedQuantity: 10 }]);
    expect(released).toEqual(['L1']);
    expect(store.has('L1')).toBe(false);
  });
});

describe('§2A(2) confirmed lines are excluded from bulk retry', () => {
  it('never re-attempts a line the server already confirmed', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());

    // First pass: L1 succeeds, L2 is rejected outright.
    server.rejectOnce(['L2'], 'quantity_must_be_positive');
    const pass1 = await runBulkReceive(server.write, store, {
      selected: [sel('L1'), sel('L2')],
      eligibleIds: new Set(['L1', 'L2']),
      confirmedIds: new Set(),
    });
    expect(pass1.succeeded).toEqual(['L1']);
    expect(pass1.failed.map(f => f.lineId)).toEqual(['L2']);
    expect(server.mutations).toBe(1);

    // Canonical reload: the server confirms L1 only.
    const serverLines = [{ id: 'L1', receivedQuantity: 10 }, { id: 'L2', receivedQuantity: null }];
    store.releaseConfirmed(serverLines);

    // Retry pass: L1 must be skipped, not re-sent.
    const pass2 = await runBulkReceive(server.write, store, {
      selected: [sel('L1'), sel('L2')],
      eligibleIds: new Set(['L1', 'L2']),
      confirmedIds: confirmedLineIds(serverLines),
    });
    expect(pass2.skipped).toEqual([{ lineId: 'L1', reason: 'already_confirmed' }]);
    expect(pass2.attempted).toEqual(['L2']);
    expect(server.mutations).toBe(2); // L2 only; L1 was never touched again
  });
});

describe('§2A(3) ambiguous failures retain the same token', () => {
  it('keeps one token across repeated ambiguous failures', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());

    server.rejectOnce(['L1'], 'network_timeout');
    const a = await runSingleReceive(server.write, store, sel('L1'));
    server.rejectOnce(['L1'], 'network_timeout');
    const b = await runSingleReceive(server.write, store, sel('L1'));
    const c = await runSingleReceive(server.write, store, sel('L1'));

    expect(a.ok).toBe(false);
    expect(b.ok).toBe(false);
    expect(new Set([a.requestId, b.requestId, c.requestId]).size).toBe(1);
    // Only the attempt that actually committed moved stock.
    expect(server.mutations).toBe(1);
  });

  it('keeps the token even on a failure that looks definitive', async () => {
    // The client cannot tell "server rejected" from "server committed, response
    // lost". Holding is safe under both readings; re-minting is not.
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());

    server.rejectOnce(['L1'], 'quantity_must_be_positive');
    const first = await runSingleReceive(server.write, store, sel('L1'));
    expect(first.ok).toBe(false);
    expect(store.has('L1')).toBe(true);
    expect(store.tokenFor('L1')).toBe(first.requestId);
  });

  it('a failed bulk pass leaves every unconfirmed token intact', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());
    server.rejectOnce(['L1'], 'boom');
    server.rejectOnce(['L2'], 'boom');

    const pass1 = await runBulkReceive(server.write, store, {
      selected: [sel('L1'), sel('L2')],
      eligibleIds: new Set(['L1', 'L2']),
      confirmedIds: new Set(),
    });
    expect(pass1.failed).toHaveLength(2);

    const tokens = ['L1', 'L2'].map(id => store.tokenFor(id));
    await runBulkReceive(server.write, store, {
      selected: [sel('L1'), sel('L2')],
      eligibleIds: new Set(['L1', 'L2']),
      confirmedIds: new Set(),
    });
    expect(['L1', 'L2'].map(id => store.tokenFor(id))).toEqual(tokens);
  });
});

describe('§2A(4) only explicitly selected eligible lines may mutate', () => {
  it('writes nothing for a line that was never selected', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());

    const outcome = await runBulkReceive(server.write, store, {
      selected: [sel('L1')],
      eligibleIds: new Set(['L1', 'L2', 'L3']),
      confirmedIds: new Set(),
    });

    expect(outcome.attempted).toEqual(['L1']);
    expect(server.calls.map(c => c.dispatchLineId)).toEqual(['L1']);
    expect(server.mutations).toBe(1);
  });

  it('refuses to write a selected line the model judged ineligible', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());

    const outcome = await runBulkReceive(server.write, store, {
      selected: [sel('L1'), sel('BAD')],
      eligibleIds: new Set(['L1']),
      confirmedIds: new Set(),
    });

    expect(outcome.skipped).toEqual([{ lineId: 'BAD', reason: 'not_eligible' }]);
    expect(server.calls.map(c => c.dispatchLineId)).toEqual(['L1']);
    expect(server.mutations).toBe(1);
    // A skipped line must not even acquire a token — it was never an operation.
    expect(store.has('BAD')).toBe(false);
  });

  it('mutates nothing at all when the selection is empty', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());
    const outcome = await runBulkReceive(server.write, store, {
      selected: [], eligibleIds: new Set(['L1']), confirmedIds: new Set(),
    });
    expect(outcome.attempted).toEqual([]);
    expect(server.mutations).toBe(0);
    expect(store.size).toBe(0);
  });

  it('carries the operator quantity and reason through untouched', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());
    await runBulkReceive(server.write, store, {
      selected: [{ lineId: 'L1', receivedQuantity: 7, differenceReason: 'two vials broken' }],
      eligibleIds: new Set(['L1']),
      confirmedIds: new Set(),
    });
    expect(server.calls[0]).toMatchObject({
      dispatchLineId: 'L1', receivedQuantity: 7, differenceReason: 'two vials broken',
    });
  });
});

describe('§2A progress reporting stays truthful', () => {
  it('counts attempts RESOLVED, failures included, over the actionable set only', async () => {
    const server = fakeServer();
    const store = new ReceiptTokenStore(counterMint());
    server.rejectOnce(['L2'], 'boom');
    const seen: Array<[number, number]> = [];

    await runBulkReceive(server.write, store, {
      // L3 is confirmed already, so the denominator must be 2, not 3.
      selected: [sel('L1'), sel('L2'), sel('L3')],
      eligibleIds: new Set(['L1', 'L2', 'L3']),
      confirmedIds: new Set(['L3']),
      onProgress: (done, total) => seen.push([done, total]),
    });

    expect(seen).toEqual([[1, 2], [2, 2]]);
  });
});
