/**
 * STOCK-MUTATION RUNNER — behaviour, driven through an injected writer.
 *
 * The fake server models the part of the 065/070/071 contract that decides
 * whether stock double-posts: it deduplicates on request id and counts GENUINE
 * mutations. Every claim below is measured against that count, not against how
 * many times the client called.
 *
 * Token derivation is NOT stubbed here — these tests run the real
 * operationToken, because the property under test (a reload derives the same
 * token) is a property of the derivation, and stubbing it would assume away
 * the thing being proven.
 */
import { describe, it, expect } from 'vitest';
import {
  runStockMutation, runStockMutations, confirmedEntityIds,
  type TokenedWriter, type MutationResult,
} from '../stock-mutation-runner';

// A type alias, not an interface, so it satisfies runStockMutation's
// `P extends IntentValue` constraint (an interface is not assignable to
// IntentValue's index-signature arm).
type Payload = { quantity: number };

interface FakeServer {
  write: TokenedWriter<Payload>;
  calls: Array<{ requestId: string; payload: Payload }>;
  readonly mutations: number;
  loseResponseFor(entityHint: number[]): void;
  rejectOnce(error: string): void;
}

/**
 * @param onCall lets a test decide, per call, whether the response is lost.
 */
function fakeServer(): FakeServer {
  const committed = new Map<string, MutationResult>();
  const calls: Array<{ requestId: string; payload: Payload }> = [];
  const loseOn = new Set<number>();
  let rejectNext: string | null = null;
  let mutations = 0;
  let callIndex = 0;

  const write: TokenedWriter<Payload> = async (requestId, payload) => {
    const index = callIndex++;
    calls.push({ requestId, payload });

    // Replay of an already-committed token: original result, no new mutation.
    const prior = committed.get(requestId);
    if (prior) return prior;

    if (rejectNext !== null) {
      const error = rejectNext;
      rejectNext = null;
      return { ok: false, error };
    }

    mutations += 1;
    const result: MutationResult = { ok: true };
    committed.set(requestId, result);

    // The server committed, but the client never hears it.
    if (loseOn.has(index)) return { ok: false, error: 'network_timeout' };
    return result;
  };

  return {
    write,
    calls,
    get mutations() { return mutations; },
    loseResponseFor: (indexes) => indexes.forEach(i => loseOn.add(i)),
    rejectOnce: (error) => { rejectNext = error; },
  };
}

const item = (entityId: string, generation = 0, quantity = 10) =>
  ({ entityId, generation, payload: { quantity } });

const KIND = 'transfer_receive';

describe('(1) server success + lost response + retry ⇒ exactly one mutation', () => {
  it('derives the same token and the server posts once', async () => {
    const server = fakeServer();
    server.loseResponseFor([0]);

    const first = await runStockMutation(server.write, KIND, item('L1'));
    expect(first.ok).toBe(false);
    expect(server.mutations).toBe(1);

    // Retry: server state has not moved, so generation is unchanged.
    const second = await runStockMutation(server.write, KIND, item('L1'));
    expect(second.requestId).toBe(first.requestId);
    expect(second.ok).toBe(true);
    expect(server.mutations).toBe(1);
  });
});

describe('(2) ambiguous retry reuses the token', () => {
  it('holds one token across repeated ambiguous failures', async () => {
    const server = fakeServer();
    server.rejectOnce('network_timeout');
    const a = await runStockMutation(server.write, KIND, item('L1'));
    server.rejectOnce('network_timeout');
    const b = await runStockMutation(server.write, KIND, item('L1'));
    const c = await runStockMutation(server.write, KIND, item('L1'));

    expect(new Set([a.requestId, b.requestId, c.requestId]).size).toBe(1);
    expect(server.mutations).toBe(1);
  });

  it('holds the token even when the failure looks definitive', async () => {
    // A client cannot distinguish a rejection from a committed write whose
    // response was lost, so it must not treat either as licence to re-mint.
    const server = fakeServer();
    server.rejectOnce('quantity_must_be_positive');
    const first = await runStockMutation(server.write, KIND, item('L1'));
    const retry = await runStockMutation(server.write, KIND, item('L1'));
    expect(retry.requestId).toBe(first.requestId);
  });
});

describe('(3) confirmed lines are excluded from bulk retry', () => {
  it('skips a confirmed row instead of re-sending it', async () => {
    const server = fakeServer();
    server.rejectOnce('boom'); // L2 fails on the first pass

    const pass1 = await runStockMutations(server.write, {
      kind: KIND, items: [item('L2'), item('L1')],
    });
    expect(pass1.failed.map(f => f.entityId)).toEqual(['L2']);
    expect(pass1.succeeded).toEqual(['L1']);

    // Canonical reload confirms L1 only.
    const rows = [{ id: 'L1', received: true }, { id: 'L2', received: false }];
    const confirmed = confirmedEntityIds(rows, r => r.received);

    const pass2 = await runStockMutations(server.write, {
      kind: KIND, items: [item('L1'), item('L2')], confirmedIds: confirmed,
    });
    expect(pass2.skipped).toEqual([{ entityId: 'L1', reason: 'already_confirmed' }]);
    expect(pass2.attempted).toEqual(['L2']);
    expect(server.mutations).toBe(2);
  });
});

describe('(4) only selected eligible lines may mutate', () => {
  it('never writes an unselected row', async () => {
    const server = fakeServer();
    const outcome = await runStockMutations(server.write, {
      kind: KIND, items: [item('L1')], eligibleIds: new Set(['L1', 'L2', 'L3']),
    });
    expect(outcome.attempted).toEqual(['L1']);
    expect(server.mutations).toBe(1);
  });

  it('never writes a selected row the model judged ineligible', async () => {
    const server = fakeServer();
    const outcome = await runStockMutations(server.write, {
      kind: KIND, items: [item('L1'), item('BAD')], eligibleIds: new Set(['L1']),
    });
    expect(outcome.skipped).toEqual([{ entityId: 'BAD', reason: 'not_eligible' }]);
    expect(server.mutations).toBe(1);
  });

  it('mutates nothing when the selection is empty', async () => {
    const server = fakeServer();
    const outcome = await runStockMutations<Payload>(server.write, { kind: KIND, items: [] });
    expect(outcome.attempted).toEqual([]);
    expect(server.mutations).toBe(0);
  });
});

describe('(5) later legitimate partial operations are NOT deduplicated', () => {
  it('gives a second partial receipt its own token once the server has advanced', async () => {
    const server = fakeServer();

    // Receive 30 of 100. Server now reports 30 received.
    const first = await runStockMutation(server.write, KIND, item('L1', 0, 30));
    expect(server.mutations).toBe(1);

    // A genuinely NEW operation on the same row: receive 20 more. The
    // generation has advanced, so this must NOT be swallowed as a replay.
    const second = await runStockMutation(server.write, KIND, item('L1', 30, 20));
    expect(second.requestId).not.toBe(first.requestId);
    expect(second.ok).toBe(true);
    expect(server.mutations).toBe(2);
  });

  it('keeps send and receive on one row distinct', async () => {
    const server = fakeServer();
    const sent = await runStockMutation(server.write, 'return_send', item('L1'));
    const received = await runStockMutation(server.write, 'return_receive', item('L1'));
    expect(received.requestId).not.toBe(sent.requestId);
    expect(server.mutations).toBe(2);
  });

  it('still deduplicates a retry of the SECOND partial', async () => {
    const server = fakeServer();
    await runStockMutation(server.write, KIND, item('L1', 0, 30));
    server.loseResponseFor([1]);
    const a = await runStockMutation(server.write, KIND, item('L1', 30, 20));
    expect(a.ok).toBe(false);
    const b = await runStockMutation(server.write, KIND, item('L1', 30, 20));
    expect(b.requestId).toBe(a.requestId);
    expect(server.mutations).toBe(2); // not 3
  });
});

describe('(6) remount / page reload cannot create a duplicate mutation', () => {
  it('re-derives the identical token after ALL client state is discarded', async () => {
    const server = fakeServer();
    server.loseResponseFor([0]);

    // Attempt 1, then the operator's tab reloads. Nothing is carried over —
    // no store, no ref, no module state, no storage.
    const before = await runStockMutation(server.write, KIND, item('L1'));
    expect(server.mutations).toBe(1);

    // Simulate the reload: a brand-new item object built from a fresh server
    // read, going through the runner again.
    const afterReload = await runStockMutation(server.write, KIND, {
      entityId: 'L1', generation: 0, payload: { quantity: 10 },
    });

    expect(afterReload.requestId).toBe(before.requestId);
    expect(server.mutations).toBe(1);
  });

  it('a random token per attempt WOULD double-post — the regression this pins', async () => {
    const server = fakeServer();
    server.loseResponseFor([0]);
    await server.write(crypto.randomUUID(), { quantity: 10 });
    await server.write(crypto.randomUUID(), { quantity: 10 });
    expect(server.mutations).toBe(2);
  });
});

describe('progress reporting stays truthful', () => {
  it('counts resolved attempts over the actionable set only', async () => {
    const server = fakeServer();
    server.rejectOnce('boom');
    const seen: Array<[number, number]> = [];
    await runStockMutations(server.write, {
      kind: KIND,
      items: [item('L1'), item('L2'), item('L3')],
      confirmedIds: new Set(['L3']),
      onProgress: (done, total) => seen.push([done, total]),
    });
    expect(seen).toEqual([[1, 2], [2, 2]]);
  });
});
