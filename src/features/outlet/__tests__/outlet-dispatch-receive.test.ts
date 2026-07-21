/**
 * OUTLET dispatch receipt (070) — behavioural, through an injected fake server.
 *
 * The Incoming Supplies tab receives via the shared derived-token runner, so
 * this pins the idempotency it depends on across the failure modes the mandate
 * calls out: a lost response replays the SAME token (no second receipt), a
 * repeated batch is deduplicated, two concurrent tabs receive once, a bulk run
 * survives a per-line permission rejection, and an advanced generation permits a
 * later legitimate receipt. Every claim is measured against GENUINE receipts.
 */
import { describe, it, expect } from 'vitest';
import {
  runStockMutation, runStockMutations, confirmedEntityIds,
  type TokenedWriter, type MutationResult,
} from '@/shared/lib/stock-mutation-runner';

type Payload = {
  dispatchLineId: string;
  receivedQuantity: number;
  differenceReason: string | null;
};

function fakeServer(opts: { forbid?: Set<string> } = {}) {
  const { forbid = new Set<string>() } = opts;
  const committed = new Map<string, MutationResult>();     // requestId -> result (replay)
  const receivedLines = new Set<string>();
  const loseOn = new Set<number>();
  let receipts = 0;
  let index = 0;

  const write: TokenedWriter<Payload> = async (requestId, payload) => {
    const i = index++;
    const prior = committed.get(requestId);
    if (prior) return prior; // idempotent replay

    if (forbid.has(payload.dispatchLineId)) return { ok: false, error: 'NOT_AUTHORIZED_RECEIVE' };

    receipts += 1;
    receivedLines.add(payload.dispatchLineId);
    const result: MutationResult = { ok: true };
    committed.set(requestId, result);
    if (loseOn.has(i)) return { ok: false, error: 'network_timeout' };
    return result;
  };

  return {
    write,
    loseResponseOn: (i: number) => loseOn.add(i),
    get receipts() { return receipts; },
    received: (id: string) => receivedLines.has(id),
  };
}

const KIND = 'outlet_dispatch_receive';
const item = (id: string, generation = 0, quantity = 10) => ({
  entityId: id, generation,
  payload: { dispatchLineId: id, receivedQuantity: quantity, differenceReason: null } as Payload,
});

describe('lost responses and retries', () => {
  it('replays the same token after a lost response and receives once', async () => {
    const s = fakeServer();
    s.loseResponseOn(0);
    const first = await runStockMutation(s.write, KIND, item('L1'));
    expect(first.ok).toBe(false);
    const retry = await runStockMutation(s.write, KIND, item('L1'));
    expect(retry.requestId).toBe(first.requestId);
    expect(retry.ok).toBe(true);
    expect(s.receipts).toBe(1);
  });
});

describe('repeated batches and concurrency', () => {
  it('a repeated receive of the same line is deduplicated', async () => {
    const s = fakeServer();
    await runStockMutation(s.write, KIND, item('L1'));
    await runStockMutation(s.write, KIND, item('L1'));
    expect(s.receipts).toBe(1);
  });

  it('two concurrent tabs receiving one line yield exactly one receipt', async () => {
    const s = fakeServer();
    await Promise.all([
      runStockMutation(s.write, KIND, item('L1')),
      runStockMutation(s.write, KIND, item('L1')),
    ]);
    expect(s.receipts).toBe(1);
  });
});

describe('bulk partial failure and permissions', () => {
  it('receives eligible lines, skips confirmed/ineligible, and isolates a rejection', async () => {
    const s = fakeServer({ forbid: new Set(['L3']) });
    const rows = [
      { id: 'L1', receivedQuantity: null },
      { id: 'L2', receivedQuantity: 10 },   // already confirmed
      { id: 'L3', receivedQuantity: null },  // rejected by permission
      { id: 'L4', receivedQuantity: null },
    ];
    const confirmed = confirmedEntityIds(rows, r => r.receivedQuantity !== null);

    const outcome = await runStockMutations(s.write, {
      kind: KIND,
      items: [item('L1'), item('L2'), item('L3'), item('L4'), item('L5')],
      eligibleIds: new Set(['L1', 'L2', 'L3', 'L4']), // L5 not eligible
      confirmedIds: confirmed,
    });

    expect(outcome.succeeded.sort()).toEqual(['L1', 'L4']);
    expect(outcome.failed).toEqual([{ entityId: 'L3', error: 'NOT_AUTHORIZED_RECEIVE' }]);
    expect(outcome.skipped.map(x => x.entityId).sort()).toEqual(['L2', 'L5']);
    expect(s.receipts).toBe(2);
  });
});

describe('generation advances a later legitimate receipt', () => {
  it('a second receipt at a new generation is not a replay of the first', async () => {
    const s = fakeServer();
    const first = await runStockMutation(s.write, KIND, item('L1', 0, 10));
    const later = await runStockMutation(s.write, KIND, item('L1', 10, 5));
    expect(later.requestId).not.toBe(first.requestId);
    expect(s.receipts).toBe(2);
  });
});
