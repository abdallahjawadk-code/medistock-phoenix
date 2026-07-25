/**
 * WAREHOUSE-GENERATION-WIRING — Stage C activation contract.
 *
 * Migration 078/079 are live in production and MIGRATION_065_CONCURRENCY_RESOLVED
 * is flipped in this same commit. These tests pin the client half of that
 * bargain: every production accumulating write composes against a FRESH
 * canonical generation read, an absent lot is generation 0, any failed read
 * refuses before a writer is touched, a 40001 conflict is never auto-retried,
 * and a changed payload is a new logical attempt while an unchanged retry
 * replays the same request id.
 *
 * Behavioural claims run against injected transports (no DB, no network, no
 * renderer). Call-site structure (which cannot be rendered in this repo's test
 * setup) is pinned by source scans, newline-normalized so a CRLF working copy
 * matches CI's LF checkout.
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  receiveWarehouseStock,
  applyWarehouseStockMovement,
  getWarehouseReceiptLotGeneration,
  normalizedLotFilter,
  receiptInternalBatchReference,
  classifyIntakeError,
  GENERATION_UNAVAILABLE_CODE,
  type LotGenerationQuery,
  type ReceiveWarehouseStockInput,
} from '../warehouse-intake.service';

const read = (rel: string) =>
  readFileSync(join(process.cwd(), 'src', rel), 'utf8').replace(/\r\n/g, '\n');

const ALLOWED = () => true;

const RECEIPT: Omit<ReceiveWarehouseStockInput, 'expectedGeneration'> = {
  requestId: '11111111-1111-4111-8111-111111111111',
  warehouseId: '22222222-2222-4222-8222-222222222222',
  scientificName: 'Amoxicillin',
  quantity: 30,
  hasNoNationalCode: false,
  hasNoBatchNumber: false,
  nationalCode: '1234567',
  batchNumber: 'B4471X',
  expiryDate: '2027-01-31',
};

/** Records the RPC name + args, and reports success. */
function transport(result: Record<string, unknown> = { ok: true }) {
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const callRpc = vi.fn(async (fn: string, args: Record<string, unknown>) => {
    calls.push({ fn, args });
    return { ok: true as const, data: result as never };
  });
  return { calls, callRpc };
}

const queryOf = (result: Awaited<ReturnType<LotGenerationQuery>>): LotGenerationQuery =>
  async () => result;

// ─── The canonical receipt-lot read ──────────────────────────────────────────

describe('getWarehouseReceiptLotGeneration resolves the EXACT server identity', () => {
  it('normalizes exactly like the server: btrim, empty → null', () => {
    const filter = normalizedLotFilter({
      ...RECEIPT,
      scientificName: '  Amoxicillin ',
      concentration: '   ',
      dosageForm: undefined,
      nationalCode: ' 1234567 ',
      batchNumber: '',
      expiryDate: null,
    });
    expect(filter.scientific_name).toBe('Amoxicillin');
    expect(filter.concentration).toBeNull();
    expect(filter.dosage_form).toBeNull();
    expect(filter.national_code).toBe('1234567');
    expect(filter.batch_number).toBeNull();
    expect(filter.expiry_date).toBeNull();
  });

  it('a no-batch receipt targets the WSNB lot the server derives from the request id', () => {
    // Migration 065: internal_batch_reference = 'WSNB-' || replace(request_id,'-','')
    // — unique per request, so such a receipt ALWAYS creates a fresh lot.
    expect(receiptInternalBatchReference({ hasNoBatchNumber: true, requestId: RECEIPT.requestId }))
      .toBe('WSNB-11111111111141118111111111111111');
    expect(receiptInternalBatchReference({ hasNoBatchNumber: false, requestId: RECEIPT.requestId }))
      .toBeNull();
  });

  it('a brand-new lot is generation 0 — a first receipt, not an error', async () => {
    const r = await getWarehouseReceiptLotGeneration(RECEIPT, {
      query: queryOf({ data: null, error: null }),
    });
    expect(r).toEqual({ ok: true, generation: 0, absent: true });
  });

  it('an existing lot reports its exact server movement_seq', async () => {
    const r = await getWarehouseReceiptLotGeneration(RECEIPT, {
      query: queryOf({ data: { movement_seq: 7 }, error: null }),
    });
    expect(r).toEqual({ ok: true, generation: 7 });
  });

  it('movement_seq 0 on an existing row survives — never coerced away', async () => {
    const r = await getWarehouseReceiptLotGeneration(RECEIPT, {
      query: queryOf({ data: { movement_seq: 0 }, error: null }),
    });
    expect(r.ok).toBe(true);
    expect(r.ok && r.generation).toBe(0);
  });

  it('a missing column (078 not deployed) fails closed as not_deployed', async () => {
    const r = await getWarehouseReceiptLotGeneration(RECEIPT, {
      query: queryOf({ data: null, error: { code: '42703' } }),
    });
    expect(r).toEqual({ ok: false, reason: 'not_deployed' });
  });

  it('any other read failure — RLS, network, AMBIGUOUS identity — is unreadable', async () => {
    // maybeSingle reports >1 matching row as an error: an ambiguous identity
    // must refuse, never guess which lot the server would lock.
    const r = await getWarehouseReceiptLotGeneration(RECEIPT, {
      query: queryOf({ data: null, error: { code: 'PGRST116' } }),
    });
    expect(r).toEqual({ ok: false, reason: 'unreadable' });
  });

  it('a row without a numeric movement_seq is unreadable, never 0', async () => {
    const r = await getWarehouseReceiptLotGeneration(RECEIPT, {
      query: queryOf({ data: {}, error: null }),
    });
    expect(r).toEqual({ ok: false, reason: 'unreadable' });
  });
});

// ─── Read feeds the writer; failure never does ───────────────────────────────

/** The exact compose-then-post sequence every call site performs. */
async function submitReceiptLikeCallSites(
  queryResult: Awaited<ReturnType<LotGenerationQuery>>,
  callRpc: ReturnType<typeof transport>['callRpc'],
) {
  const generation = await getWarehouseReceiptLotGeneration(RECEIPT, { query: queryOf(queryResult) });
  if (!generation.ok) return { refused: true as const, error: GENERATION_UNAVAILABLE_CODE };
  return receiveWarehouseStock(
    { ...RECEIPT, expectedGeneration: generation.generation },
    { callRpc, allowed: ALLOWED },
  );
}

describe('the fresh read feeds the guarded writer', () => {
  it('NEW lot → the wire carries expectedGeneration 0, not null', async () => {
    const t = transport();
    await submitReceiptLikeCallSites({ data: null, error: null }, t.callRpc);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0].fn).toBe('phoenix_receive_warehouse_stock_guarded');
    expect(t.calls[0].args.p_expected_generation).toBe(0);
  });

  it('EXISTING lot → the wire carries the exact server movement_seq', async () => {
    const t = transport();
    await submitReceiptLikeCallSites({ data: { movement_seq: 42 }, error: null }, t.callRpc);
    expect(t.calls[0].args.p_expected_generation).toBe(42);
  });

  it('an unreadable generation posts NOTHING', async () => {
    const t = transport();
    const r = await submitReceiptLikeCallSites({ data: null, error: { code: '500' } }, t.callRpc);
    expect(r).toEqual({ refused: true, error: GENERATION_UNAVAILABLE_CODE });
    expect(t.callRpc).not.toHaveBeenCalled();
  });

  it('a not-deployed column posts NOTHING', async () => {
    const t = transport();
    const r = await submitReceiptLikeCallSites({ data: null, error: { code: '42703' } }, t.callRpc);
    expect(r).toEqual({ refused: true, error: GENERATION_UNAVAILABLE_CODE });
    expect(t.callRpc).not.toHaveBeenCalled();
  });
});

// ─── Conflict, replay and distinct-attempt behaviour ─────────────────────────

describe('40001 conflict is surfaced, reloaded against, and never auto-reposted', () => {
  it('the writer is called exactly once and the conflict maps to its own key', async () => {
    const callRpc = vi.fn(async () =>
      ({ ok: false as const, error: 'warehouse_receipt_generation_conflict' }));
    const r = await receiveWarehouseStock(
      { ...RECEIPT, expectedGeneration: 3 },
      { callRpc: callRpc as never, allowed: ALLOWED },
    );
    expect(r.ok).toBe(false);
    expect(callRpc).toHaveBeenCalledTimes(1); // no automatic repost
    expect(classifyIntakeError(r.error)).toBe('inv_err_generation_conflict');
  });
});

describe('a lost response retried with the SAME request id mutates exactly once', () => {
  it('the replaying server posts one movement across two identical submissions', async () => {
    // Fake of migration 065's request-id idempotency: the first post commits,
    // the second (same id) replays the stored result instead of posting again.
    const posted = new Map<string, Record<string, unknown>>();
    const callRpc = vi.fn(async (_fn: string, args: Record<string, unknown>) => {
      const id = args.p_request_id as string;
      if (posted.has(id)) return { ok: true as const, data: { ok: true, replayed: true } as never };
      posted.set(id, args);
      return { ok: true as const, data: { ok: true } as never };
    });

    const attempt = () => receiveWarehouseStock(
      { ...RECEIPT, expectedGeneration: 0 },
      { callRpc: callRpc as never, allowed: ALLOWED },
    );
    const first = await attempt();   // response "lost" after commit
    const second = await attempt();  // unchanged retry — SAME request id
    expect(first.ok).toBe(true);
    expect(second.ok).toBe(true);
    expect((second.data as { replayed?: boolean }).replayed).toBe(true);
    expect(posted.size).toBe(1);     // exactly one server mutation
    expect(callRpc.mock.calls[0][1]).toHaveProperty('p_request_id', RECEIPT.requestId);
    expect(callRpc.mock.calls[1][1]).toHaveProperty('p_request_id', RECEIPT.requestId);
  });

  it('the adjustment path carries the same request id across a retry too', async () => {
    const t = transport();
    const input = {
      requestId: RECEIPT.requestId, warehouseStockId: 'ws-1',
      movementType: 'add' as const, amount: 5, expectedGeneration: 2,
    };
    await applyWarehouseStockMovement(input, { callRpc: t.callRpc, allowed: ALLOWED });
    await applyWarehouseStockMovement(input, { callRpc: t.callRpc, allowed: ALLOWED });
    expect(t.calls[0].args.p_request_id).toBe(RECEIPT.requestId);
    expect(t.calls[1].args.p_request_id).toBe(RECEIPT.requestId);
  });
});

describe('a changed payload is a DISTINCT logical attempt with a fresh read', () => {
  it('every submission performs its own generation read — nothing is cached', async () => {
    const query = vi.fn(async () => ({ data: { movement_seq: 1 }, error: null }));
    await getWarehouseReceiptLotGeneration(RECEIPT, { query });
    await getWarehouseReceiptLotGeneration({ ...RECEIPT, batchNumber: 'B9999' }, { query });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('a different no-batch attempt resolves a DIFFERENT lot identity', () => {
    const a = normalizedLotFilter({ ...RECEIPT, hasNoBatchNumber: true, batchNumber: null });
    const b = normalizedLotFilter({
      ...RECEIPT, hasNoBatchNumber: true, batchNumber: null,
      requestId: '33333333-3333-4333-8333-333333333333',
    });
    expect(a.internal_batch_reference).not.toBe(b.internal_batch_reference);
  });
});

// ─── Call-site structure (source scans — this repo renders no components) ────

describe('all three production call sites read fresh and pass a non-null generation', () => {
  const screen = read('features/inventory/InventoryCenterScreen.tsx');
  const ocr = read('features/inventory/ocr/OcrIntakeFlow.tsx');

  it('IntakeForm: fresh receipt-lot read, refusal branch, then the guarded post', () => {
    const submitBlock = screen.slice(
      screen.indexOf('const base: Omit<ReceiveWarehouseStockInput'),
      screen.indexOf('function StockList'),
    );
    expect(submitBlock).toContain('await getWarehouseReceiptLotGeneration(base)');
    expect(submitBlock).toContain('if (!generation.ok)');
    expect(submitBlock).toContain('classifyIntakeError(GENERATION_UNAVAILABLE_CODE)');
    expect(submitBlock).toContain('expectedGeneration: generation.generation');
    // Order: read → refusal → post.
    expect(submitBlock.indexOf('getWarehouseReceiptLotGeneration'))
      .toBeLessThan(submitBlock.indexOf('await receiveWarehouseStock'));
    expect(submitBlock.indexOf('if (!generation.ok)'))
      .toBeLessThan(submitBlock.indexOf('await receiveWarehouseStock'));
  });

  it('BatchRow: fresh per-lot read, refusal branch, then the guarded movement', () => {
    const rowBlock = screen.slice(screen.indexOf('function BatchRow'), screen.indexOf('function LedgerList'));
    expect(rowBlock).toContain('await getWarehouseStockGeneration(batch.id)');
    expect(rowBlock).toContain('if (!generation.ok)');
    expect(rowBlock).toContain('expectedGeneration: generation.generation');
    expect(rowBlock.indexOf('getWarehouseStockGeneration'))
      .toBeLessThan(rowBlock.indexOf('await applyWarehouseStockMovement'));
  });

  it('OCR: the read happens only inside confirmAndSubmit, AFTER the review gate', () => {
    const submit = ocr.slice(ocr.indexOf('const confirmAndSubmit'), ocr.indexOf('// ── Render'));
    expect(submit).toContain('await getWarehouseReceiptLotGeneration(base)');
    expect(submit).toContain('expectedGeneration: generation.generation');
    // canSubmit (preview stage + every confirmation + warehouse confirmation)
    // gates the WHOLE submit, so the generation read is unreachable pre-review.
    expect(submit.indexOf('if (!canSubmit) return;'))
      .toBeLessThan(submit.indexOf('getWarehouseReceiptLotGeneration'));
    expect(submit.indexOf('getWarehouseReceiptLotGeneration'))
      .toBeLessThan(submit.indexOf('await receiveWarehouseStock(payload)'));
    // And it is the ONLY generation read in the whole OCR module.
    expect((ocr.match(/getWarehouseReceiptLotGeneration\(/g) ?? []).length).toBe(1);
  });

  it('no call site ever passes a null/undefined expectedGeneration', () => {
    for (const source of [screen, ocr]) {
      expect(source).not.toMatch(/expectedGeneration:\s*(null|undefined)/);
      // The only expectedGeneration ever written is the fresh read's value.
      for (const match of source.match(/expectedGeneration:\s*[\w.]+/g) ?? []) {
        expect(match).toBe('expectedGeneration: generation.generation');
      }
    }
  });

  it('a generation conflict triggers a canonical reload at every call site', () => {
    expect(screen).toContain("if (errorKey === 'inv_err_generation_conflict') onConflictReload();");
    expect(ocr).toContain("if (failureKey === 'inv_err_generation_conflict') onConflict?.();");
    // The reload re-reads canonical stock; the retry stays an explicit act.
    expect(screen).toContain('const reloadCanonicalStock = () => setReloadKey(k => k + 1);');
  });

  it('editing any payload field mints a fresh request id (a new logical attempt)', () => {
    // Manual form + adjustment row share the same touch() discipline…
    expect(screen).toContain('const touch = () => setRequestId(newRequestId());');
    expect(screen).toContain('/** A changed payload is a NEW logical attempt; only an unchanged retry replays. */');
    // …and every manually-entered payload field invokes it. Migration 118
    // restores the Pharmacy Department's manual identity corridor and forbids
    // an optional catalog selection.
    const intakeForm = screen.slice(screen.indexOf('function IntakeForm'), screen.indexOf('function StockList'));
    const handlers = intakeForm.match(/onChange=\{e => \{[^}]*\}\}/g) ?? [];
    expect(handlers.length).toBeGreaterThanOrEqual(15);
    for (const handler of handlers) expect(handler).toContain('touch();');
    expect(intakeForm).toContain('centralItemId: null');
    expect(intakeForm).toContain("purchaseOrigin: supplyType === 'purchase' ? 'central' : null");
    expect(intakeForm).not.toContain('searchCentralItems');
    expect(intakeForm).not.toContain('selectedItem');
    // OCR: editing a reviewed value re-keys the attempt too.
    const ocrEdit = ocr.slice(ocr.indexOf('const onChangeField'), ocr.indexOf('const onToggleConfirm'));
    expect(ocrEdit).toContain('setRequestId(newRequestId());');
    expect(ocr).toContain('centralItemId: null');
    expect(ocr).toContain("purchaseOrigin: normalizedSupplyType === 'purchase' ? 'central' : null");
    expect(ocr).toContain('&& quantityValid && supplyTypeValid');
  });
});
