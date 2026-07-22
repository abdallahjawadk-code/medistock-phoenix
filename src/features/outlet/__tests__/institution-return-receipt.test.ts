/**
 * OUTLET-RETURN receipt (institution side) — behavioural, through an injected
 * fake 071 receive server.
 *
 * The receive is driven by the shared derived-token runner, so this exercises
 * the exact idempotency the surface relies on: a lost response replays the SAME
 * token (no second receipt), a restock and a hold of one line derive DIFFERENT
 * tokens (never silently merged), bulk receipt excludes confirmed/ineligible
 * lines, and a permission rejection posts nothing. Every claim is measured
 * against the count of GENUINE receipts, not client calls.
 */
import { describe, it, expect } from 'vitest';
import {
  runStockMutation, runStockMutations, confirmedEntityIds,
  type TokenedWriter, type MutationResult,
} from '@/shared/lib/stock-mutation-runner';
import { operationToken } from '@/shared/lib/operation-token';

// A type alias (not an interface) so it satisfies runStockMutation's
// `P extends IntentValue` constraint — an interface is not assignable to
// IntentValue's index-signature arm.
type Payload = {
  shipmentLineId: string;
  receivedQuantity: number;
  differenceReason: string | null;
  dispositionDecision: 'quarantined' | 'restockable';
};

/** Models the part of the 071 receive contract that decides double-receipt. */
function fakeServer(opts: { forbid?: Set<string> } = {}) {
  const { forbid = new Set<string>() } = opts;
  const committed = new Map<string, MutationResult>();       // requestId -> result (replay)
  const receiptsByLine = new Map<string, { qty: number; disposition: string }>();
  const loseOn = new Set<number>();
  let receipts = 0;
  let index = 0;

  const write: TokenedWriter<Payload> = async (requestId, payload) => {
    const i = index++;
    const prior = committed.get(requestId);
    if (prior) return prior; // idempotent replay — no new receipt

    if (forbid.has(payload.shipmentLineId)) return { ok: false, error: 'NOT_AUTHORIZED_RETURN_RECEIVE' };

    receipts += 1;
    receiptsByLine.set(payload.shipmentLineId, {
      qty: payload.receivedQuantity, disposition: payload.dispositionDecision,
    });
    const result: MutationResult = { ok: true };
    committed.set(requestId, result);
    if (loseOn.has(i)) return { ok: false, error: 'network_timeout' };
    return result;
  };

  return {
    write,
    loseResponseOn: (i: number) => loseOn.add(i),
    get receipts() { return receipts; },
    dispositionOf: (lineId: string) => receiptsByLine.get(lineId)?.disposition,
  };
}

const KIND = 'outlet_return_shipment_receive';
const item = (
  id: string, generation = 0,
  disposition: 'quarantined' | 'restockable' = 'quarantined', quantity = 10,
) => ({
  entityId: id, generation,
  payload: { shipmentLineId: id, receivedQuantity: quantity, differenceReason: null, dispositionDecision: disposition } as Payload,
});

describe('individual receipt', () => {
  it('receives one line once, recording its disposition', async () => {
    const s = fakeServer();
    const r = await runStockMutation(s.write, KIND, item('L1', 0, 'quarantined'));
    expect(r.ok).toBe(true);
    expect(s.receipts).toBe(1);
    expect(s.dispositionOf('L1')).toBe('quarantined');
  });
});

describe('lost response is safe to retry', () => {
  it('replays the same token and receives only once', async () => {
    const s = fakeServer();
    s.loseResponseOn(0);
    const first = await runStockMutation(s.write, KIND, item('L1', 0));
    expect(first.ok).toBe(false);
    const retry = await runStockMutation(s.write, KIND, item('L1', 0));
    expect(retry.requestId).toBe(first.requestId);
    expect(retry.ok).toBe(true);
    expect(s.receipts).toBe(1);
  });
});

describe('a restock and a hold of the same line are distinct intents', () => {
  it('derives different tokens so one can never be deduplicated as the other', async () => {
    const quarantine = await operationToken({
      kind: KIND, entityId: 'L1', generation: 0,
      intent: JSON.stringify({ d: 'quarantined' }),
    });
    // Real check: the runner folds the whole payload, so disposition changes the token.
    const a = await runStockMutation(fakeServer().write, KIND, item('L1', 0, 'quarantined'));
    const b = await runStockMutation(fakeServer().write, KIND, item('L1', 0, 'restockable'));
    expect(a.requestId).not.toBe(b.requestId);
    expect(quarantine).toBeTruthy();
  });
});

describe('safe bulk receipt to quarantine', () => {
  it('receives eligible lines, skips confirmed and ineligible ones', async () => {
    const s = fakeServer();
    const rows = [
      { id: 'L1', receivedQuantity: null },
      { id: 'L2', receivedQuantity: 10 },   // already confirmed
      { id: 'L3', receivedQuantity: null },
    ];
    const confirmed = confirmedEntityIds(rows, r => r.receivedQuantity !== null);

    const outcome = await runStockMutations(s.write, {
      kind: KIND,
      items: [item('L1'), item('L2'), item('L3'), item('L4')],
      eligibleIds: new Set(['L1', 'L2', 'L3']), // L4 not eligible
      confirmedIds: confirmed,                  // L2 already received
    });

    expect(outcome.succeeded.sort()).toEqual(['L1', 'L3']);
    expect(outcome.skipped.map(s => s.entityId).sort()).toEqual(['L2', 'L4']);
    expect(s.receipts).toBe(2);
    expect(s.dispositionOf('L1')).toBe('quarantined');
  });

  it('reports a permission rejection as a per-line failure, receiving nothing for it', async () => {
    const s = fakeServer({ forbid: new Set(['L2']) });
    const outcome = await runStockMutations(s.write, {
      kind: KIND,
      items: [item('L1'), item('L2')],
      eligibleIds: new Set(['L1', 'L2']),
    });
    expect(outcome.succeeded).toEqual(['L1']);
    expect(outcome.failed).toEqual([{ entityId: 'L2', error: 'NOT_AUTHORIZED_RETURN_RECEIVE' }]);
    expect(s.receipts).toBe(1);
  });
});

describe('advancing generation permits a later legitimate receipt', () => {
  it('a second receipt at a new generation is not a replay of the first', async () => {
    const s = fakeServer();
    const first = await runStockMutation(s.write, KIND, item('L1', 0, 'quarantined', 10));
    const later = await runStockMutation(s.write, KIND, item('L1', 10, 'restockable', 5));
    expect(later.requestId).not.toBe(first.requestId);
    expect(s.receipts).toBe(2);
  });
});
