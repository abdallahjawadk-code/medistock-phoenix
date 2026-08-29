/**
 * PHOENIX-DSO-1 — RUNTIME identity contract of the direct-supply compose path.
 *
 * WHY THIS EXISTS ALONGSIDE supply-composer-contract.test.ts.
 *
 * Those tests are source scans: they read DirectSupplyComposer.tsx and
 * network.service.ts as TEXT and assert the mapping lines are present. They are
 * precise about WHERE the defect was, and they do fail on unpatched master —
 * but a source scan pins characters, not behaviour. It cannot observe what
 * `getWarehouseStock` actually RETURNS, and it cannot observe whether the line
 * that comes out of the compose path would satisfy the send RPC's matcher.
 *
 * WHAT IS ALREADY PROVEN ELSEWHERE, AND IS NOT RE-PROVEN HERE.
 *
 * The RPC half of the contract is pinned executably, against a real PostgreSQL
 * with the full canonical migration chain applied, by
 * supabase/migrations/__tests__/150-fefo-debit-hardening.dynamic.test.ts
 * ("guards raw direct send and rejects request-line material mismatch", and
 * "enforces direct guarded override on an approved matching line ..."). That is
 * the authority for what _phoenix_150_send_direct_v1 does, and it runs in the
 * required "PostgreSQL pg-rig" CI check. This file does NOT replace it and is
 * not evidence about the database.
 *
 * WHAT THIS FILE ADDS.
 *
 * The one link neither of those covers: that the FRONTEND now hands the RPC a
 * line the RPC can actually resolve. It runs the real `getWarehouseStock`
 * against a PostgREST-faithful stub — one that returns ONLY the columns the
 * call actually projects, exactly as PostgREST does — and then runs the real
 * `draftLineFromStock` over the result. That makes the projection load-bearing
 * at RUNTIME: on unpatched master the select omits the identity columns, the
 * stub therefore omits them from the row, and the composed line comes out with
 * no identity and is refused below. On the repaired branch it resolves.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

const db = vi.hoisted(() => ({
  /** Rows as they exist in warehouse_stock, BEFORE projection. */
  rows: [] as Record<string, unknown>[],
  /** The column list the code under test actually asked for. */
  projected: '',
}));

/**
 * A stub that behaves like PostgREST in the one way that matters here: a column
 * that was not named in .select() is NOT in the response. Returning the whole
 * row regardless would make this test pass on unpatched master and prove
 * nothing, because the defect WAS the projection.
 */
vi.mock('@/shared/supabase/client', () => {
  const builder: Record<string, unknown> = {};
  Object.assign(builder, {
    select: (columns: string) => { db.projected = columns; return builder; },
    eq: () => builder,
    gt: () => builder,
    order: () => {
      const columns = db.projected.split(',').map(c => c.trim()).filter(Boolean);
      const data = db.rows.map(row => {
        const projectedRow: Record<string, unknown> = {};
        for (const column of columns) {
          if (Object.prototype.hasOwnProperty.call(row, column)) projectedRow[column] = row[column];
        }
        return projectedRow;
      });
      return Promise.resolve({ data, error: null });
    },
  });
  return { supabaseConfigured: true, supabase: { from: () => builder } };
});

import { getWarehouseStock } from '@/features/network/network.service';
import { draftLineFromStock, type DraftLine, type StockCandidate } from '../composer-model';

const WAREHOUSE = '00000000-0000-0000-0000-0000000000a1';
const CENTRAL_ITEM = '00000000-0000-0000-0000-0000000000b1';

/** One warehouse_stock row, identity-bearing, as production stock actually is. */
const stockRow = (over: Record<string, unknown> = {}) => ({
  id: '00000000-0000-0000-0000-000000000501',
  warehouse_id: WAREHOUSE,
  scientific_name: 'Direct FEFO',
  central_item_id: CENTRAL_ITEM,
  concentration: '10 mg',
  dosage_form: 'tablet',
  unit: 'box',
  national_code: null,
  batch_number: 'DIRECT-EARLY',
  expiry_date: '2028-03-01',
  on_hand_quantity: 50,
  reserved_quantity: 0,
  available_quantity: 50,
  material_identity_key: 'identity-10mg-tablet-box',
  internal_batch_reference: null,
  supply_type: null,
  purchase_origin: null,
  ...over,
});

/**
 * A FAITHFUL TRANSCRIPTION of the resolution predicate in
 * _phoenix_150_send_direct_v1 (migration 150), which reads:
 *
 *   SELECT count(DISTINCT ws.material_identity_key), min(ws.material_identity_key)
 *     ...
 *     AND ws.central_item_id IS NOT DISTINCT FROM v_line.central_item_id
 *     AND lower(ws.scientific_name) = lower(v_line.scientific_name)
 *     AND lower(COALESCE(ws.concentration,'')) = lower(COALESCE(v_line.concentration,''))
 *     AND lower(COALESCE(ws.dosage_form,''))   = lower(COALESCE(v_line.dosage_form,''))
 *     AND lower(COALESCE(ws.unit,''))          = lower(COALESCE(v_line.unit,''))
 *   IF <count <> 1> OR <key mismatch> THEN
 *     RAISE EXCEPTION 'direct_request_line_material_mismatch'
 *
 * Transcribed, not invented — and deliberately NOT the authority: migration 150
 * is, and the pg-rig dynamic test cited in the header is what proves it. This
 * exists so the assertions below say something about SENDABILITY rather than
 * merely about field equality.
 */
function resolveIdentityKey(line: DraftLine, rows: readonly Record<string, unknown>[]): string | null {
  const norm = (v: unknown) => String(v ?? '').toLowerCase();
  const matches = rows.filter(ws =>
    (ws.central_item_id ?? null) === (line.centralItemId ?? null)
    && norm(ws.scientific_name) === norm(line.scientificName)
    && norm(ws.concentration) === norm(line.concentration)
    && norm(ws.dosage_form) === norm(line.dosageForm)
    && norm(ws.unit) === norm(line.unit));
  const keys = new Set(matches.map(m => m.material_identity_key as string));
  // count(DISTINCT ...) <> 1 is the refusal condition.
  return keys.size === 1 ? [...keys][0] : null;
}

/** The compose path exactly as the composer drives it, minus the React shell. */
async function composeLineFromWarehouse(): Promise<DraftLine> {
  const batches = await getWarehouseStock(WAREHOUSE);
  expect(batches, 'the stub returned no stock').toHaveLength(1);
  const candidate: StockCandidate = {
    warehouseStockId: batches[0].id,
    centralItemId: batches[0].centralItemId,
    scientificName: batches[0].scientificName,
    tradeName: null,
    concentration: batches[0].concentration,
    dosageForm: batches[0].dosageForm,
    unit: batches[0].unit,
    nationalCode: batches[0].nationalCode,
    batchNumber: batches[0].batchNumber,
    internalBatchReference: null,
    expiryDate: batches[0].expiryDate,
    onHandQuantity: batches[0].onHandQuantity,
    reservedQuantity: batches[0].reservedQuantity,
    availableQuantity: batches[0].availableQuantity,
  };
  return draftLineFromStock(candidate, 10, 'idempotency-key-1');
}

beforeEach(() => {
  db.rows = [stockRow()];
  db.projected = '';
});

describe('PHOENIX-DSO-1 runtime: the projection is load-bearing', () => {
  it('getWarehouseStock returns the identity the send RPC matches on', async () => {
    const [batch] = await getWarehouseStock(WAREHOUSE);
    // On unpatched master these are absent from the projection, so the
    // PostgREST-faithful stub never returns them and each of these is undefined.
    expect(batch.centralItemId, 'centralItemId did not survive the read').toBe(CENTRAL_ITEM);
    expect(batch.concentration, 'concentration did not survive the read').toBe('10 mg');
    expect(batch.dosageForm, 'dosageForm did not survive the read').toBe('tablet');
    expect(batch.unit, 'unit did not survive the read').toBe('box');
  });

  it('a genuinely null identity is preserved as null, never defaulted', async () => {
    db.rows = [stockRow({ central_item_id: null, concentration: null, dosage_form: null, unit: null })];
    const [batch] = await getWarehouseStock(WAREHOUSE);
    expect(batch.centralItemId).toBeNull();
    expect(batch.concentration).toBeNull();
    expect(batch.dosageForm).toBeNull();
    expect(batch.unit).toBeNull();
  });
});

describe('PHOENIX-DSO-1 runtime: the composed line is sendable', () => {
  it('a line composed from identity-bearing stock RESOLVES (the send proceeds)', async () => {
    const line = await composeLineFromWarehouse();
    expect(line.centralItemId).toBe(CENTRAL_ITEM);
    expect(resolveIdentityKey(line, db.rows), 'the composed line would be refused at send time')
      .toBe('identity-10mg-tablet-box');
  });

  it('the pre-repair line shape is REFUSED — this is the defect, reproduced', async () => {
    const line = await composeLineFromWarehouse();
    // Exactly what both mapping sites used to build: identity forced to null.
    const preRepair: DraftLine = {
      ...line, centralItemId: null, concentration: null, dosageForm: null, unit: null,
    };
    expect(resolveIdentityKey(preRepair, db.rows), 'a null-identity line must not resolve')
      .toBeNull();
  });

  it('a DIFFERENT material is still REFUSED — the repair did not loosen matching', async () => {
    const line = await composeLineFromWarehouse();
    const variant = stockRow({ id: 'variant', concentration: '20 mg', material_identity_key: 'identity-20mg' });
    // The 20 mg line resolves to the 20 mg stock, and to nothing else.
    expect(resolveIdentityKey({ ...line, concentration: '20 mg' }, [variant, ...db.rows]))
      .toBe('identity-20mg');
    // A line whose concentration matches nothing on hand resolves to nothing.
    expect(resolveIdentityKey({ ...line, concentration: '30 mg' }, [variant, ...db.rows]))
      .toBeNull();
  });

  it('an ambiguous match is REFUSED — count(DISTINCT key) <> 1 still holds', async () => {
    const line = await composeLineFromWarehouse();
    // Same material identity fields, two different canonical keys.
    const twin = stockRow({ id: 'twin', material_identity_key: 'identity-other' });
    expect(resolveIdentityKey(line, [...db.rows, twin]), 'ambiguity must refuse')
      .toBeNull();
  });
});
