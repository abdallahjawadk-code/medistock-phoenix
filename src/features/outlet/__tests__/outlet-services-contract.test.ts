/**
 * OUTLET-CORRIDOR-070/071 — service contract: every mutation targets the EXACT
 * existing RPC with the exact parameter names, and every read is an RLS-scoped
 * SELECT (no direct table write, no privileged key, no invented backend). Static
 * source assertions, matching the repo convention.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const read = (rel: string) => readFileSync(join(__dirname, '..', rel), 'utf8');
const dispatch = read('dispatch.service.ts');
const ret = read('outlet-return.service.ts');

describe('070 dispatch service maps to the exact 070 RPCs', () => {
  const pairs: Array<[string, string]> = [
    ['createWarehouseDispatch', 'phoenix_create_warehouse_dispatch'],
    // 097/102 FEFO enforcement: the real add-line RPC is the guarded wrapper,
    // not the bare 070 RPC it delegates to internally.
    ['addDispatchLine', 'phoenix_add_dispatch_line_fefo_guarded'],
    ['updateDispatchLineQuantity', 'phoenix_update_dispatch_line_quantity'],
    ['deleteDispatchLine', 'phoenix_delete_dispatch_line'],
    ['sendWarehouseDispatch', 'phoenix_send_warehouse_dispatch'],
    ['cancelWarehouseDispatch', 'phoenix_cancel_warehouse_dispatch'],
    ['receiveOutletDispatchLine', 'phoenix_receive_outlet_dispatch_line'],
  ];
  for (const [fn, rpc] of pairs) {
    it(`${fn} → ${rpc}`, () => {
      expect(dispatch).toContain(`export function ${fn}`);
      expect(dispatch).toContain(`'${rpc}'`);
    });
  }
  it('add-line sources a CANONICAL warehouse_stock lot (p_warehouse_stock_id), never free text', () => {
    expect(dispatch).toMatch(/p_warehouse_stock_id: input\.warehouseStockId/);
    expect(dispatch).not.toMatch(/p_scientific_name/);
  });
  it('send carries a fresh idempotency token', () => {
    expect(dispatch).toMatch(/p_request_id: input\.requestId/);
  });
  it('never writes a table directly or uses a privileged key', () => {
    expect(dispatch).not.toMatch(/\.from\([^)]*\)\.(insert|update|upsert|delete)/);
    expect(dispatch).not.toMatch(/service_role|auth\.admin/);
  });
});

describe('071 return service maps to the exact 071 RPCs', () => {
  const pairs: Array<[string, string]> = [
    ['requestOutletReturn', 'phoenix_request_outlet_return'],
    ['recallOutletStock', 'phoenix_recall_outlet_stock'],
    ['addOutletReturnLine', 'phoenix_add_outlet_return_request_line'],
    ['deleteOutletReturnLine', 'phoenix_delete_outlet_return_request_line'],
    ['submitOutletReturnRequest', 'phoenix_submit_outlet_return_request'],
    ['cancelOutletReturnRequest', 'phoenix_cancel_outlet_return_request'],
    ['reviewOutletReturnRequest', 'phoenix_review_outlet_return_request'],
    ['sendOutletReturnShipmentLine', 'phoenix_send_outlet_return_shipment_line'],
    ['receiveOutletReturnShipmentLine', 'phoenix_receive_outlet_return_shipment_line'],
  ];
  for (const [fn, rpc] of pairs) {
    it(`${fn} → ${rpc}`, () => {
      expect(ret).toContain(`export function ${fn}`);
      expect(ret).toContain(`'${rpc}'`);
    });
  }
  it('return line is provenance-anchored (original_dispatch_line_id mandatory)', () => {
    expect(ret).toMatch(/p_original_dispatch_line_id: input\.originalDispatchLineId/);
  });
  it('receive carries a disposition decision (quarantine-first custody)', () => {
    expect(ret).toMatch(/p_disposition_decision: input\.dispositionDecision/);
  });
  it('never writes a table directly or uses a privileged key', () => {
    expect(ret).not.toMatch(/\.from\([^)]*\)\.(insert|update|upsert|delete)/);
    expect(ret).not.toMatch(/service_role|auth\.admin/);
  });
});
