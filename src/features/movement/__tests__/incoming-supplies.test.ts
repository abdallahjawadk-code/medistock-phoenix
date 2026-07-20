import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  assessReceive, bulkEligibleLines, validateReceive, isLineExpired,
  type ReceivableLine,
} from '../receive-model';

const TODAY = new Date('2026-07-21T00:00:00Z');

function rline(over: Partial<ReceivableLine> = {}): ReceivableLine {
  return {
    id: 'l1', scientificName: 'Amoxicillin', batchNumber: 'B4471X',
    expiryDate: '2027-06-30', sentQuantity: 100, receivedQuantity: null,
    status: 'in_transit', differenceReason: null,
    ...over,
  };
}

describe('bulk acceptance is conservative', () => {
  it('accepts a clean in-transit line', () => {
    const e = assessReceive(rline(), TODAY);
    expect(e.bulkEligible).toBe(true);
    expect(e.individuallyReceivable).toBe(true);
    expect(e.exclusions).toEqual([]);
  });

  it('excludes an already-received line from bulk AND from receiving again', () => {
    const e = assessReceive(rline({ receivedQuantity: 100, status: 'received' }), TODAY);
    expect(e.bulkEligible).toBe(false);
    expect(e.individuallyReceivable).toBe(false);
    expect(e.exclusions).toContain('already_received');
  });

  it('excludes EXPIRED stock from bulk but still allows a deliberate receipt', () => {
    const e = assessReceive(rline({ expiryDate: '2020-01-01' }), TODAY);
    expect(e.bulkEligible).toBe(false);
    expect(e.exclusions).toContain('expired');
    // Expiry is a decision, not an impossibility.
    expect(e.individuallyReceivable).toBe(true);
  });

  it('excludes a line already carrying a difference note from bulk', () => {
    const e = assessReceive(rline({ differenceReason: 'carton damaged' }), TODAY);
    expect(e.bulkEligible).toBe(false);
    expect(e.exclusions).toContain('has_difference_reason');
    expect(e.individuallyReceivable).toBe(true);
  });

  it('excludes a line whose status is not in transit', () => {
    for (const status of ['cancelled', 'draft', 'returned', 'unknown']) {
      const e = assessReceive(rline({ status }), TODAY);
      expect(e.exclusions, status).toContain('not_in_transit');
      expect(e.individuallyReceivable, status).toBe(false);
    }
  });

  it('excludes a quantity-adjusted receipt from bulk', () => {
    const e = assessReceive(rline(), TODAY, 60);
    expect(e.exclusions).toContain('quantity_adjusted');
    expect(e.bulkEligible).toBe(false);
  });

  it('rejects a non-positive dispatched quantity outright', () => {
    const e = assessReceive(rline({ sentQuantity: 0 }), TODAY);
    expect(e.individuallyReceivable).toBe(false);
    expect(e.exclusions).toContain('non_positive_quantity');
  });

  it('bulkEligibleLines returns ONLY the clean subset', () => {
    const lines = [
      rline({ id: 'clean' }),
      rline({ id: 'expired', expiryDate: '2020-01-01' }),
      rline({ id: 'flagged', differenceReason: 'short' }),
      rline({ id: 'done', receivedQuantity: 100, status: 'received' }),
      rline({ id: 'clean2' }),
    ];
    expect(bulkEligibleLines(lines, TODAY).map(l => l.id)).toEqual(['clean', 'clean2']);
  });
});

describe('quantity differences must be explained', () => {
  it('accepts an exact-quantity receipt with no reason', () => {
    expect(validateReceive(rline(), 100, null)).toEqual([]);
  });

  it('REQUIRES a reason when the quantity differs from what was dispatched', () => {
    expect(validateReceive(rline(), 60, null).map(i => i.code)).toContain('difference_reason_required');
    expect(validateReceive(rline(), 60, '   ').map(i => i.code)).toContain('difference_reason_required');
    expect(validateReceive(rline(), 60, 'two cartons short')).toEqual([]);
  });

  it('refuses to receive MORE than was dispatched, reason or not', () => {
    // Over-receipt is impossible and would corrupt the return provenance cap.
    expect(validateReceive(rline(), 150, 'found extra').map(i => i.code)).toContain('quantity_exceeds_sent');
  });

  it('rejects zero, negative and fractional quantities', () => {
    expect(validateReceive(rline(), 0, null).map(i => i.code)).toContain('quantity_not_positive');
    expect(validateReceive(rline(), -5, null).map(i => i.code)).toContain('quantity_not_positive');
    expect(validateReceive(rline(), 2.5, null).map(i => i.code)).toContain('quantity_not_integer');
  });

  it('treats today as not expired', () => {
    expect(isLineExpired('2026-07-21', TODAY)).toBe(false);
    expect(isLineExpired('2026-07-20', TODAY)).toBe(true);
    expect(isLineExpired(null, TODAY)).toBe(false);
  });
});

// ── structural contract of the screen ────────────────────────────────────────

const ROOT = process.cwd();
const incomingRaw = readFileSync(join(ROOT, 'src', 'features', 'movement', 'InstitutionIncomingSupplies.tsx'), 'utf8');

/**
 * Scan CODE, not prose. The file's own docblock names the things it refuses to
 * use ("deliberately NO StockMaterialPicker…"), and a comment saying a thing is
 * absent must not read as that thing being present.
 */
const stripComments = (source: string) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const incoming = stripComments(incomingRaw);

describe('the incoming screen creates nothing', () => {
  it('contains NO material picker, manual entry or catalog reconstruction', () => {
    for (const forbidden of ['StockMaterialPicker', 'draftLineFromStock', 'getAllCentralItems', 'toCatalogMaterials', 'searchStock']) {
      expect(incoming, forbidden).not.toContain(forbidden);
    }
  });

  it('contains NO OCR of any kind', () => {
    for (const forbidden of ['Ocr', 'ocr', 'tesseract', 'extractPharmaFields']) {
      expect(incoming, forbidden).not.toContain(forbidden);
    }
  });

  it('never calls a create/add-line/intake writer', () => {
    for (const forbidden of ['createDirectTransferRequest', 'addTransferRequestLine', 'receiveWarehouseStock', 'sendDirectTransferLine']) {
      expect(incoming, forbidden).not.toContain(forbidden);
    }
  });

  it('receives through the EXISTING per-line receive RPC only', () => {
    expect(incoming).toContain('receiveTransferLine(');
    expect((incoming.match(/receiveTransferLine\(/g) ?? []).length).toBe(1);
  });

  it('reads lines from the server in ONE batched query, not an N+1 loop', () => {
    expect(incoming).toContain('getIncomingTransferLines(list.map(x => x.id))');
    expect(incoming).not.toMatch(/for\s*\([^)]*\)\s*\{[^}]*getTransferLines\(/);
  });

  it('reloads canonical server state after every receive attempt', () => {
    // Both the individual and the bulk path end with a reload.
    const individual = incoming.slice(incoming.indexOf('const receiveIndividually'));
    expect(individual.slice(0, 900)).toContain('await reload()');
    const bulk = incoming.slice(incoming.indexOf('const acceptAllSafe'));
    expect(bulk.slice(0, 1200)).toContain('await reload()');
  });

  it('never writes stock optimistically into local state', () => {
    // No local mutation of quantities as if a receive had already succeeded.
    expect(incoming).not.toMatch(/setLines\(previous =>[^)]*receivedQuantity/);
  });

  it('bulk acceptance acts only on the conservative eligible set', () => {
    expect(incoming).toContain('bulkEligibleLines(');
    const bulk = incoming.slice(incoming.indexOf('const acceptAllSafe'), incoming.indexOf('const acceptAllSafe') + 1200);
    expect(bulk).toContain('for (const safe of bulkSet)');
  });

  it('QR only locates a transfer by opaque uuid and supplies no material data', () => {
    expect(incoming).toContain('parseMovementQrPayload(');
    expect(incoming).toContain('setQrFilter(payload.id)');
    // The scan never becomes a line; it only filters server-loaded lines.
    expect(incoming).not.toMatch(/setLines\([^)]*payload/);
  });

  it('shows the institution beside its warehouse', () => {
    expect(incoming).toContain('pairedPartyLabel(institutionName, warehouseName)');
  });

  it('gates every write on the caller-supplied permission flag', () => {
    expect(incoming).toContain('if (busy || !canReceive) return;');
    expect(incoming).toContain('if (busy || !canReceive || bulkSet.length === 0) return;');
  });
});
