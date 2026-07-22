/**
 * OUTLET-CORRIDOR-070 UI — the institution→outlet dispatch composer is the draft-
 * first authoring entry, mounted in the Inventory Center behind a dispatch gate,
 * sourcing ONLY canonical warehouse stock and committing through the exact 070
 * RPCs (one writer). Static source assertions.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const OUTLET = join(__dirname, '..');
const read = (base: string, rel: string) => readFileSync(join(base, rel), 'utf8');
const composer = read(OUTLET, 'OutletDispatchComposer.tsx');
const ops = read(OUTLET, 'OutletDispatchOperations.tsx');
const center = readFileSync(join(OUTLET, '..', 'inventory', 'InventoryCenterScreen.tsx'), 'utf8');

describe('composer sources canonical stock and commits via 070 RPCs only', () => {
  it('reads canonical institution stock for the picker (never invents identity)', () => {
    expect(composer).toMatch(/getWarehouseStock\(/);
    expect(composer).toMatch(/StockMaterialPicker/);
    // Line identity comes from the PICKED stock candidate, not typed input, and
    // no OCR flow is imported/rendered here.
    expect(composer).toMatch(/draftLineFromStock\(candidate/);
    expect(composer).not.toMatch(/OcrIntakeFlow|features\/inventory\/ocr/);
  });

  it('persists only via createWarehouseDispatch + addDispatchLine (draft-first)', () => {
    expect(composer).toMatch(/createWarehouseDispatch\(\{/);
    expect(composer).toMatch(/addDispatchLine\(\{/);
    expect(composer).toMatch(/warehouseStockId: line\.warehouseStockId as string/);
    // The only persistence is in confirmAndCreate/retry, never on party/material steps.
    expect(composer).toMatch(/const confirmAndCreate = async/);
  });

  it('is a single hop: warehouse source, outlet destination — no central shortcut', () => {
    expect(composer).toMatch(/sourceWarehouseId: string/);
    expect(composer).toMatch(/destinationDistributionPointId: outletId/);
  });
});

describe('send is a deliberate, separate, idempotent step', () => {
  it('sends under a DERIVED idempotency token, never a freshly minted one', () => {
    // A minted token makes each retry a new operation and double-ships whenever
    // a success response is lost; a derived one is stable across a page reload
    // too. Behaviour is proven in shared/lib/__tests__/stock-mutation-runner.
    expect(ops).toMatch(/runStockMutation\(writeSend, SEND_KIND/);
    expect(ops).not.toMatch(/requestId: uuid\(\)/);
    expect(ops).toMatch(/generation: dispatch\.sentAt \? 1 : 0/);
  });
  it('outlet balances change only after the OUTLET confirms receipt (not here)', () => {
    expect(ops).not.toMatch(/receiveOutletDispatchLine/);
  });
});

describe('mounted in the Inventory Center behind a dispatch gate', () => {
  it('renders OutletDispatchOperations gated on warehouse_dispatch.create', () => {
    expect(center).toMatch(/import \{ OutletDispatchOperations \}/);
    expect(center).toMatch(/myPermissions\.has\('warehouse_dispatch\.create'\)/);
    expect(center).toMatch(/<OutletDispatchOperations/);
    expect(center).toMatch(/canDispatch \? \[\{ id: 'dispatch'/);
  });
  it('offers only outlets that belong to the selected warehouse (scope)', () => {
    expect(center).toMatch(/o\.warehouseId === activeWarehouseId/);
  });
});
