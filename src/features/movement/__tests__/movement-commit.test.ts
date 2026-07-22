import { describe, it, expect, vi } from 'vitest';
import {
  commitDraft, planRetry, dispatchBatch, retryableDispatchLines, receiptStatusFor,
  type CommitDeps, type DispatchLineInput, type ServerRequestLine,
} from '../movement-commit';
import type { DraftLine } from '../composer-model';

const REQ_ID = '11111111-2222-4333-8444-555555555555';

function line(key: string, over: Partial<DraftLine> = {}): DraftLine {
  return {
    idempotencyKey: key, warehouseStockId: `stock-${key}`, originalTransferLineId: null,
    centralItemId: null, scientificName: 'Amoxicillin', tradeName: null,
    concentration: null, dosageForm: null, unit: null, nationalCode: null,
    batchNumber: `B-${key}`, internalBatchReference: null, expiryDate: '2027-06-30',
    quantity: 10, maxQuantity: 100, reasonCode: null, reasonText: null, notes: null,
    ...over,
  };
}

const okHeader = () => Promise.resolve({ ok: true, data: { id: REQ_ID } });

describe('commitDraft — header then lines', () => {
  it('creates the header exactly once and adds every line', async () => {
    const createHeader = vi.fn(okHeader);
    const addLine = vi.fn(() => Promise.resolve({ ok: true, data: { id: 'srv' } }));
    const result = await commitDraft([line('a'), line('b')], { createHeader, addLine });

    expect(createHeader).toHaveBeenCalledTimes(1);
    expect(addLine).toHaveBeenCalledTimes(2);
    expect(result.requestId).toBe(REQ_ID);
    expect(result.complete).toBe(true);
    expect(result.partial).toBe(false);
    expect(result.lines.every(l => l.state === 'succeeded')).toBe(true);
  });

  it('makes NO add-line call when the header fails, and reports the error', async () => {
    const addLine = vi.fn();
    const result = await commitDraft([line('a')], {
      createHeader: () => Promise.resolve({ ok: false, error: 'denied' }),
      addLine,
    });
    expect(addLine).not.toHaveBeenCalled();
    expect(result.requestId).toBeNull();
    expect(result.headerError).toBe('denied');
    expect(result.lines[0].state).toBe('pending');
  });

  it('reports precisely which lines succeeded and which failed', async () => {
    const addLine = vi.fn()
      .mockResolvedValueOnce({ ok: true, data: { id: 's1' } })
      .mockResolvedValueOnce({ ok: false, error: 'insufficient_stock' })
      .mockResolvedValueOnce({ ok: true, data: { id: 's3' } });

    const result = await commitDraft([line('a'), line('b'), line('c')], { createHeader: okHeader, addLine });

    expect(result.partial).toBe(true);
    expect(result.complete).toBe(false);
    // The header id survives so the partial request is never abandoned.
    expect(result.requestId).toBe(REQ_ID);
    expect(result.lines.map(l => l.state)).toEqual(['succeeded', 'failed', 'succeeded']);
    expect(result.lines[1].error).toBe('insufficient_stock');
    expect(result.lines[0].serverLineId).toBe('s1');
  });

  it('treats a thrown add-line as a failed line, not a crashed commit', async () => {
    const addLine = vi.fn().mockRejectedValueOnce(new Error('network down')).mockResolvedValueOnce({ ok: true });
    const result = await commitDraft([line('a'), line('b')], { createHeader: okHeader, addLine });
    expect(result.lines[0].state).toBe('failed');
    expect(result.lines[0].error).toContain('network down');
    expect(result.lines[1].state).toBe('succeeded');
  });

  it('does not invent an id when the header returns none', async () => {
    const addLine = vi.fn();
    const result = await commitDraft([line('a')], {
      createHeader: () => Promise.resolve({ ok: true, data: {} }),
      addLine,
    });
    expect(result.requestId).toBeNull();
    expect(result.headerError).toBe('header_created_but_id_missing');
    expect(addLine).not.toHaveBeenCalled();
  });

  it('emits per-line progress', async () => {
    const seen: number[] = [];
    const deps: CommitDeps = {
      createHeader: okHeader,
      addLine: () => Promise.resolve({ ok: true }),
      onProgress: p => seen.push(p.completed),
    };
    await commitDraft([line('a'), line('b')], deps);
    expect(seen).toEqual([0, 1, 1, 2]);
  });
});

describe('planRetry — never blindly re-send a non-idempotent add-line', () => {
  const server: ServerRequestLine[] = [
    { id: 's1', scientificName: 'Amoxicillin', batchNumber: 'B-a', expiryDate: '2027-06-30', originalTransferLineId: null, requestedQuantity: 10 },
  ];

  it('re-sends only the lines with no canonical server counterpart', () => {
    const plan = planRetry([line('a'), line('b')], server, 'supply');
    expect(plan.alreadyPresent).toEqual(['a']);
    expect(plan.toSend.map(l => l.idempotencyKey)).toEqual(['b']);
  });

  it('re-sends nothing when every line already landed', () => {
    expect(planRetry([line('a')], server, 'supply').toSend).toEqual([]);
  });

  it('re-sends everything when the server has no lines at all', () => {
    expect(planRetry([line('a'), line('b')], [], 'supply').toSend).toHaveLength(2);
  });

  it('matches RETURN lines on provenance, not on the typed name', () => {
    const returnDraft = [line('a', { originalTransferLineId: 'otl-1', scientificName: 'renamed by operator' })];
    const returnServer: ServerRequestLine[] = [
      { id: 's1', scientificName: 'Amoxicillin', batchNumber: null, expiryDate: null, originalTransferLineId: 'otl-1', requestedQuantity: 5 },
    ];
    expect(planRetry(returnDraft, returnServer, 'return').toSend).toEqual([]);
  });
});

describe('dispatchBatch — one reference, stable per-line idempotency', () => {
  const inputs: DispatchLineInput[] = [
    { idempotencyKey: 'k1', requestLineId: 'rl1', warehouseStockId: 'ws1', quantity: 5 },
    { idempotencyKey: 'k2', requestLineId: 'rl2', warehouseStockId: 'ws2', quantity: 7 },
  ];

  it('applies ONE external reference to every line in the batch', async () => {
    const seen: string[] = [];
    const result = await dispatchBatch(inputs, 'OPS-REF-9', {
      sendLine: (_i, ref) => { seen.push(ref); return Promise.resolve({ ok: true }); },
    });
    expect(seen).toEqual(['OPS-REF-9', 'OPS-REF-9']);
    expect(result.externalReference).toBe('OPS-REF-9');
    expect(result.complete).toBe(true);
  });

  it('passes each line its own stable idempotency key', async () => {
    const keys: string[] = [];
    await dispatchBatch(inputs, 'REF', { sendLine: i => { keys.push(i.idempotencyKey); return Promise.resolve({ ok: true }); } });
    expect(keys).toEqual(['k1', 'k2']);
  });

  it('marks a mixed outcome PARTIAL rather than complete', async () => {
    const result = await dispatchBatch(inputs, 'REF', {
      sendLine: i => Promise.resolve(i.idempotencyKey === 'k2' ? { ok: false, error: 'boom' } : { ok: true }),
    });
    expect(result.partial).toBe(true);
    expect(result.complete).toBe(false);
    expect(receiptStatusFor(result)).toBe('partial');
  });

  it('retries ONLY unsent lines, each keeping its original key so no movement duplicates', async () => {
    const first = await dispatchBatch(inputs, 'REF', {
      sendLine: i => Promise.resolve(i.idempotencyKey === 'k2' ? { ok: false, error: 'boom' } : { ok: true }),
    });
    const retry = retryableDispatchLines(inputs, first);
    expect(retry).toHaveLength(1);
    expect(retry[0].idempotencyKey).toBe('k2');       // unchanged, so the RPC dedupes
    expect(retry.map(r => r.requestLineId)).toEqual(['rl2']);
  });

  it('an all-failed batch yields no receipt at all', async () => {
    const result = await dispatchBatch(inputs, 'REF', { sendLine: () => Promise.resolve({ ok: false, error: 'x' }) });
    expect(receiptStatusFor(result)).toBe('none');
    expect(result.complete).toBe(false);
  });

  it('an empty batch is never an official receipt', () => {
    expect(receiptStatusFor({ externalReference: 'R', lines: [], complete: true, partial: false })).toBe('none');
  });

  it('treats a thrown send as a failed line', async () => {
    const result = await dispatchBatch(inputs, 'REF', {
      sendLine: i => (i.idempotencyKey === 'k1' ? Promise.reject(new Error('offline')) : Promise.resolve({ ok: true })),
    });
    expect(result.lines[0].state).toBe('failed');
    expect(result.lines[0].error).toContain('offline');
  });

  it('a fully successful batch may print an official receipt', async () => {
    const result = await dispatchBatch(inputs, 'REF', { sendLine: () => Promise.resolve({ ok: true }) });
    expect(receiptStatusFor(result)).toBe('official');
  });
});
