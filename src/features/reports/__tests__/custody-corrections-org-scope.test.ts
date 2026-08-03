/**
 * PHASE-C2 — ORGANIZATION SCOPE & EXPORT INTEGRITY.
 *
 * Behavioral contract tests (not source-scans) proving the org-scope filter
 * actually RESTRICTS rows at the query level, not just that the right
 * expression string was constructed. The fake PostgREST client below applies
 * `.eq()`/`.or()`/`.in()` to canned multi-organization datasets exactly the
 * way Postgres would — the same "behaviorally accurate fake" style already
 * used by checkSnapshotParity's fakeExecutiveOverviewClient in
 * decision-intelligence-reports.test.ts, generalized to a `.from()` table
 * query builder (material-resolver.test.ts's fakeClient records calls but
 * always returns the full canned set; this one additionally FILTERS them,
 * which is required to prove restriction, not just call shape).
 *
 * Scenario mirrored throughout: a super_admin whose RLS lets them see BOTH
 * orgA and orgB's rows, viewing the reports screen with orgA selected. Every
 * assertion proves orgB's rows never leak into orgA's result.
 */
import { describe, it, expect, vi } from 'vitest';
import { getWarehouseDispatches } from '@/features/outlet/dispatch.service';
import { getOutletReturnRequests, getOutletReturnShipments } from '@/features/outlet/outlet-return.service';
import { listCustodyDispatches, listCustodyReturnRequests, listCustodyReturnShipments } from '../custody-chain.service';
import { listCorrectionHistory } from '../differences-corrections.service';

type Row = Record<string, unknown>;

interface FakeQueryState {
  table: string;
  eq: Array<[string, unknown]>;
  or: string | null;
  in: [string, unknown[]] | null;
}

/** A `.from()` PostgREST fake that actually applies eq/or/in to canned rows — proves restriction, not just call shape. */
function makeFakeSupabase(rowsByTable: Record<string, Row[]>) {
  const calls: FakeQueryState[] = [];

  function parseOr(expr: string, row: Row): boolean {
    // Format this codebase always uses: "col.eq.val,col2.eq.val2" (OR of equalities).
    return expr.split(',').some(clause => {
      const [col, , ...valParts] = clause.split('.');
      const val = valParts.join('.');
      return String(row[col]) === val;
    });
  }

  function compute(state: FakeQueryState): { data: Row[]; error: null } {
    let result = rowsByTable[state.table] ?? [];
    for (const [col, val] of state.eq) result = result.filter(r => r[col] === val);
    if (state.or) result = result.filter(r => parseOr(state.or!, r));
    if (state.in) {
      const [col, vals] = state.in;
      result = result.filter(r => vals.includes(r[col]));
    }
    calls.push(state);
    return { data: result, error: null };
  }

  function from(table: string) {
    const state: FakeQueryState = { table, eq: [], or: null, in: null };
    const builder: Record<string, unknown> = {
      select() { return builder; },
      order() { return builder; },
      eq(col: string, val: unknown) { state.eq.push([col, val]); return builder; },
      or(expr: string) { state.or = expr; return builder; },
      in(col: string, vals: unknown[]) { state.in = [col, vals]; return builder; },
      limit() { return Promise.resolve(compute(state)); },
      then(onFulfilled: (v: unknown) => unknown, onRejected?: (e: unknown) => unknown) {
        return Promise.resolve(compute(state)).then(onFulfilled, onRejected);
      },
    };
    return builder;
  }

  return { client: { from }, calls };
}

vi.mock('@/shared/supabase/client', () => ({
  get supabase() { return (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase; },
  supabaseConfigured: true,
}));

function withClient<T>(rowsByTable: Record<string, Row[]>, fn: () => Promise<T>): Promise<T> {
  const { client } = makeFakeSupabase(rowsByTable);
  (globalThis as { __fakeSupabase?: unknown }).__fakeSupabase = client;
  return fn();
}

const DISPATCH_A: Row = {
  id: 'dA', organization_id: 'orgA', warehouse_id: 'w1', destination_distribution_point_id: 'dp1',
  dispatch_number: 'DSP-A', status: 'sent', document_number: null, default_currency: null,
  notes: null, sent_at: '2026-07-20T00:00:00Z', created_at: '2026-07-19T00:00:00Z',
};
const DISPATCH_B: Row = { ...DISPATCH_A, id: 'dB', organization_id: 'orgB', dispatch_number: 'DSP-B' };

describe('PHASE C2 — warehouse_dispatches org restriction (a super_admin with two orgs of data)', () => {
  it('getWarehouseDispatches(undefined, orgA) returns ONLY orgA rows even though orgB rows are RLS-visible in the canned set', async () => {
    const rows = await withClient({ warehouse_dispatches: [DISPATCH_A, DISPATCH_B] },
      () => getWarehouseDispatches(undefined, 'orgA'));
    expect(rows.map(r => r.id)).toEqual(['dA']);
    expect(rows.map(r => r.id)).not.toContain('dB');
  });

  it('listCustodyDispatches(orgA) — the reports-screen entry point — inherits the same restriction', async () => {
    const rows = await withClient({ warehouse_dispatches: [DISPATCH_A, DISPATCH_B] },
      () => listCustodyDispatches('orgA'));
    expect(rows.map(r => r.id)).toEqual(['dA']);
  });

  it('an unfiltered call (no organizationId — the pre-existing operational-screen shape) is unaffected: still returns everything RLS allows', async () => {
    const rows = await withClient({ warehouse_dispatches: [DISPATCH_A, DISPATCH_B] },
      () => getWarehouseDispatches());
    expect(rows.map(r => r.id).sort()).toEqual(['dA', 'dB']);
  });
});

const RETURN_REQ_A_SRC: Row = {
  id: 'rA', distribution_point_id: 'dp1', source_organization_id: 'orgA',
  destination_warehouse_id: 'w1', destination_organization_id: 'orgA',
  return_number: 'RET-A', status: 'submitted', requested_by_side: 'outlet', notes: null, created_at: '2026-07-21T00:00:00Z',
};
const RETURN_REQ_B: Row = {
  ...RETURN_REQ_A_SRC, id: 'rB', source_organization_id: 'orgB', destination_organization_id: 'orgB', return_number: 'RET-B',
};

describe('PHASE C2 — outlet_return_requests org restriction (source OR destination)', () => {
  it('getOutletReturnRequests(undefined, orgA) returns ONLY the rows where orgA is source or destination', async () => {
    const rows = await withClient({ outlet_return_requests: [RETURN_REQ_A_SRC, RETURN_REQ_B] },
      () => getOutletReturnRequests(undefined, 'orgA'));
    expect(rows.map(r => r.id)).toEqual(['rA']);
    expect(rows.map(r => r.id)).not.toContain('rB');
  });

  it('listCustodyReturnRequests(orgA) inherits the same restriction', async () => {
    const rows = await withClient({ outlet_return_requests: [RETURN_REQ_A_SRC, RETURN_REQ_B] },
      () => listCustodyReturnRequests('orgA'));
    expect(rows.map(r => r.id)).toEqual(['rA']);
  });

  it('a row where the selected org is the DESTINATION (not source) still shows — the contract is source OR destination, never source-only', async () => {
    const destOnly: Row = { ...RETURN_REQ_A_SRC, id: 'rDest', source_organization_id: 'orgC', destination_organization_id: 'orgA' };
    const rows = await withClient({ outlet_return_requests: [destOnly, RETURN_REQ_B] },
      () => getOutletReturnRequests(undefined, 'orgA'));
    expect(rows.map(r => r.id)).toEqual(['rDest']);
  });
});

const SHIPMENT_A: Row = {
  id: 'sA', return_request_id: 'rA', distribution_point_id: 'dp1', destination_warehouse_id: 'w1',
  shipment_number: 'SHP-A', status: 'in_transit', source_organization_id: 'orgA', destination_organization_id: 'orgA',
};
const SHIPMENT_B: Row = { ...SHIPMENT_A, id: 'sB', shipment_number: 'SHP-B', source_organization_id: 'orgB', destination_organization_id: 'orgB' };

describe('PHASE C2 — outlet_return_shipments org restriction (source OR destination)', () => {
  it('getOutletReturnShipments(undefined, orgA) returns ONLY orgA rows', async () => {
    const rows = await withClient({ outlet_return_shipments: [SHIPMENT_A, SHIPMENT_B] },
      () => getOutletReturnShipments(undefined, 'orgA'));
    expect(rows.map(r => r.id)).toEqual(['sA']);
  });

  it('listCustodyReturnShipments(orgA) inherits the same restriction', async () => {
    const rows = await withClient({ outlet_return_shipments: [SHIPMENT_A, SHIPMENT_B] },
      () => listCustodyReturnShipments('orgA'));
    expect(rows.map(r => r.id)).toEqual(['sA']);
  });
});

const WH_CORRECTION_A: Row = {
  id: 'wcA', organization_id: 'orgA', warehouse_stock_id: 'ws1', on_hand_before: 10, new_quantity: 8,
  variance: -2, reason: 'damage', status: 'approved', decision_reason: null, proposed_by: 'u1',
  proposed_at: '2026-07-19T00:00:00Z', decided_at: null, applied_movement_id: null,
};
const WH_CORRECTION_B: Row = { ...WH_CORRECTION_A, id: 'wcB', organization_id: 'orgB' };
const OUTLET_CORRECTION_A: Row = {
  id: 'ocA', organization_id: 'orgA', outlet_stock_id: 'os1', on_hand_before: 5, counted_quantity: 4,
  variance: -1, reason: 'stocktake', status: 'pending', decision_reason: null, proposed_by: 'u2',
  proposed_at: '2026-07-20T00:00:00Z', decided_at: null, applied_movement_id: null,
};
const OUTLET_CORRECTION_B: Row = { ...OUTLET_CORRECTION_A, id: 'ocB', organization_id: 'orgB' };

describe('PHASE C2 — correction-history org restriction (both warehouse- and outlet-scope tables)', () => {
  it('listCorrectionHistory(orgA) returns ONLY orgA rows from BOTH the warehouse and outlet correction tables', async () => {
    const rows = await withClient({
      phoenix_warehouse_correction_requests: [WH_CORRECTION_A, WH_CORRECTION_B],
      phoenix_stock_correction_requests: [OUTLET_CORRECTION_A, OUTLET_CORRECTION_B],
    }, () => listCorrectionHistory('orgA'));

    expect(rows.map(r => r.id).sort()).toEqual(['ocA', 'wcA']);
    expect(rows.map(r => r.id)).not.toContain('wcB');
    expect(rows.map(r => r.id)).not.toContain('ocB');
  });

  it('a different selected org (orgB) sees the complementary, disjoint set — proving this is a real per-org partition, not an accidental pass-through', async () => {
    const rowsA = await withClient({
      phoenix_warehouse_correction_requests: [WH_CORRECTION_A, WH_CORRECTION_B],
      phoenix_stock_correction_requests: [OUTLET_CORRECTION_A, OUTLET_CORRECTION_B],
    }, () => listCorrectionHistory('orgA'));
    const rowsB = await withClient({
      phoenix_warehouse_correction_requests: [WH_CORRECTION_A, WH_CORRECTION_B],
      phoenix_stock_correction_requests: [OUTLET_CORRECTION_A, OUTLET_CORRECTION_B],
    }, () => listCorrectionHistory('orgB'));

    expect(rowsA.map(r => r.id).sort()).toEqual(['ocA', 'wcA']);
    expect(rowsB.map(r => r.id).sort()).toEqual(['ocB', 'wcB']);
    // Disjoint — no id appears in both org's results.
    const idsA = new Set(rowsA.map(r => r.id));
    expect(rowsB.some(r => idsA.has(r.id))).toBe(false);
  });

  it('an org with NO correction rows at all gets an empty, honest result — never a fallback to another org\'s data', async () => {
    const rows = await withClient({
      phoenix_warehouse_correction_requests: [WH_CORRECTION_A, WH_CORRECTION_B],
      phoenix_stock_correction_requests: [OUTLET_CORRECTION_A, OUTLET_CORRECTION_B],
    }, () => listCorrectionHistory('orgC'));
    expect(rows).toEqual([]);
  });
});
