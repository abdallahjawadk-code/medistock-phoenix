/**
 * OUTLET-RETURN receipt surface — structural contract.
 *
 * Static scans (no DOM test env) pin the safety properties the component cannot
 * be rendered to prove: one write RPC only, derived-token idempotency, bulk goes
 * to quarantine (never auto-restock), canonical reload after every mutation, and
 * no free-text / OCR / manual-balance path.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const src = readFileSync(
  join(process.cwd(), 'src', 'features', 'outlet', 'InstitutionReturnReceipts.tsx'),
  'utf8',
);
const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

describe('the return receipt writes only through the 071 receive RPC', () => {
  it('uses the derived-token runner, never a minted id', () => {
    expect(code).toContain('runStockMutation(');
    expect(code).toContain('receiveOutletReturnShipmentLine(');
    expect(code).not.toMatch(/randomUUID|crypto\.randomUUID/);
  });

  it('creates no stock, uses no OCR, and changes no balance manually', () => {
    for (const forbidden of [
      'receiveWarehouseStock', 'applyWarehouseStockMovement', 'phoenix_receive_warehouse_stock',
      'Ocr', 'OCR', 'set_exact', '.insert(', '.update(', '.upsert(',
    ]) {
      expect(code, forbidden).not.toContain(forbidden);
    }
  });
});

describe('disposition and quarantine handling', () => {
  it('offers both dispositions the RPC accepts', () => {
    expect(code).toContain("'quarantined'");
    expect(code).toContain("'restockable'");
    expect(code).toContain('dispositionDecision');
  });

  it('bulk receipt goes to quarantine, never auto-restock', () => {
    const bulk = code.slice(code.indexOf('receiveAllSafeToQuarantine'));
    expect(bulk).toContain("dispositionDecision: 'quarantined'");
    expect(bulk).not.toContain("dispositionDecision: 'restockable'");
  });
});

describe('a canonical shipment receipt is reachable after receipt', () => {
  it('renders MovementDocumentActions from a server-built shipment document', () => {
    expect(code).toContain('<MovementDocumentActions');
    expect(code).toContain('buildOutletReturnShipmentReceipt(');
    expect(code).toContain('getOutletReturnShipmentLines(receiptShipmentId)');
  });

  it('offers the receipt after both individual and bulk receive', () => {
    const individual = code.slice(code.indexOf('const receiveIndividually'), code.indexOf('const receiveAllSafeToQuarantine'));
    const bulk = code.slice(code.indexOf('const receiveAllSafeToQuarantine'), code.indexOf('// ── render'));
    expect(individual).toContain('setReceiptShipmentId(line.shipmentId)');
    expect(bulk).toContain('setReceiptShipmentId(firstReceived.shipmentId)');
  });

  it('builds the receipt only from freshly reloaded rows, keyed to reloadKey', () => {
    const loader = code.slice(code.indexOf('const receipt = useAsync'), code.indexOf('const receipt = useAsync') + 600);
    expect(loader).toContain('getOutletReturnShipmentLines(receiptShipmentId)');
    expect(loader).toContain('[receiptShipmentId, reloadKey]');
  });
});

describe('canonical reload after every mutation', () => {
  it('both the individual and bulk receive call reload()', () => {
    const individual = code.slice(code.indexOf('const receiveIndividually'), code.indexOf('const receiveAllSafeToQuarantine'));
    const bulk = code.slice(code.indexOf('const receiveAllSafeToQuarantine'));
    expect(individual).toContain('reload();');
    expect(bulk).toContain('reload();');
  });

  it('generation is the server-confirmed received quantity, driving stable tokens', () => {
    expect(code).toContain('generation: line.receivedQuantity ?? 0');
  });
});
