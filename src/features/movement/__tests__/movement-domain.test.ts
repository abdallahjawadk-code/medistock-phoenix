import { describe, it, expect } from 'vitest';
import {
  buildMovementQrPayload, parseMovementQrPayload, isTraceUuid, shortTraceKey,
  isOfficialReceiptKind, MOVEMENT_QR_NAMESPACE,
} from '../movement-trace';
import { computeProvenanceCaps, returnRiskFlags, type ProvenanceCandidate } from '../provenance';
import {
  validateDraft, draftIsConfirmable, lineIdentityKey, isExpired, recommendFefo,
  searchStock, draftLineFromStock, revalidateAgainstFreshStock,
  type DraftLine, type StockCandidate,
} from '../composer-model';

const UUID_A = '11111111-2222-4333-8444-555555555555';
const UUID_B = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TODAY = new Date('2026-07-21T00:00:00Z');

function stock(over: Partial<StockCandidate> = {}): StockCandidate {
  return {
    warehouseStockId: UUID_A, centralItemId: null,
    scientificName: 'Amoxicillin', tradeName: null, concentration: '500 mg',
    dosageForm: 'Capsule', unit: 'capsule', nationalCode: '1234567',
    batchNumber: 'B4471X', internalBatchReference: null, expiryDate: '2027-06-30',
    onHandQuantity: 200, reservedQuantity: 20, availableQuantity: 180,
    ...over,
  };
}

function line(over: Partial<DraftLine> = {}): DraftLine {
  return {
    idempotencyKey: 'k1', warehouseStockId: UUID_A, originalTransferLineId: null,
    centralItemId: null, scientificName: 'Amoxicillin', tradeName: null,
    concentration: null, dosageForm: null, unit: null, nationalCode: null,
    batchNumber: 'B4471X', internalBatchReference: null, expiryDate: '2027-06-30',
    quantity: 10, maxQuantity: 180, reasonCode: null, reasonText: null, notes: null,
    ...over,
  };
}

function provenance(over: Partial<ProvenanceCandidate> = {}): ProvenanceCandidate {
  return {
    originalTransferLineId: UUID_B, receivedQuantity: 100, returnedQuantity: 30,
    resultingWarehouseStockId: UUID_A, onHandQuantity: 90, reservedQuantity: 10,
    ...over,
  };
}

// ── trace key + QR ───────────────────────────────────────────────────────────

describe('movement trace key', () => {
  it('accepts a uuid and rejects anything else as a trace key', () => {
    expect(isTraceUuid(UUID_A)).toBe(true);
    expect(isTraceUuid('SUP-REQ-2026-000001')).toBe(false);
    expect(isTraceUuid('')).toBe(false);
    expect(isTraceUuid(undefined)).toBe(false);
  });

  it('only dispatch and shipment may be printed as official receipts', () => {
    expect(isOfficialReceiptKind('supply_dispatch')).toBe(true);
    expect(isOfficialReceiptKind('return_shipment')).toBe(true);
    // A request is editable and is NOT a stock movement.
    expect(isOfficialReceiptKind('supply_request')).toBe(false);
    expect(isOfficialReceiptKind('return_request')).toBe(false);
  });

  it('round-trips every document kind through the QR payload', () => {
    for (const kind of ['supply_request', 'supply_dispatch', 'return_request', 'return_shipment'] as const) {
      const payload = buildMovementQrPayload(kind, UUID_A);
      expect(parseMovementQrPayload(payload)).toEqual({ kind, id: UUID_A });
    }
  });

  it('QR payload leaks NO operational data — only namespace, version, kind, opaque id', () => {
    const payload = buildMovementQrPayload('supply_dispatch', UUID_A);
    expect(payload).toBe(`${MOVEMENT_QR_NAMESPACE}:1:sdsp:${UUID_A}`);
    // Nothing resembling quantities, names, prices or identities.
    expect(payload).not.toMatch(/amoxicillin|qty|quantity|price|[0-9]{1,4}\s*(mg|ml)/i);
    expect(payload.split(':')).toHaveLength(4);
  });

  it('refuses to build a QR from a non-uuid, so a typed number can never become the trace key', () => {
    expect(() => buildMovementQrPayload('supply_dispatch', 'SUP-DSP-2026-000001')).toThrow();
  });

  it('rejects foreign, malformed and future-version payloads', () => {
    expect(parseMovementQrPayload('')).toBeNull();
    expect(parseMovementQrPayload('https://example.com/qr/abc')).toBeNull();
    expect(parseMovementQrPayload(`other:1:sdsp:${UUID_A}`)).toBeNull();
    expect(parseMovementQrPayload(`${MOVEMENT_QR_NAMESPACE}:2:sdsp:${UUID_A}`)).toBeNull();
    expect(parseMovementQrPayload(`${MOVEMENT_QR_NAMESPACE}:1:zzzz:${UUID_A}`)).toBeNull();
    expect(parseMovementQrPayload(`${MOVEMENT_QR_NAMESPACE}:1:sdsp:not-a-uuid`)).toBeNull();
  });

  it('shortTraceKey is quotable and derived only from the uuid', () => {
    expect(shortTraceKey(UUID_A)).toBe('11111111');
    expect(shortTraceKey('nope')).toBe('');
  });
});

// ── provenance caps ──────────────────────────────────────────────────────────

describe('return provenance caps', () => {
  it('binds on the smaller of provenance remaining and physical available', () => {
    const caps = computeProvenanceCaps(provenance());
    expect(caps.provenanceRemaining).toBe(70);   // 100 received - 30 returned
    expect(caps.physicalAvailable).toBe(80);     // 90 on hand - 10 reserved
    expect(caps.safeReturnable).toBe(70);
    expect(caps.physicalUnknown).toBe(false);
  });

  it('binds on physical stock when it is the smaller of the two', () => {
    const caps = computeProvenanceCaps(provenance({ onHandQuantity: 15, reservedQuantity: 5 }));
    expect(caps.physicalAvailable).toBe(10);
    expect(caps.safeReturnable).toBe(10);
  });

  it('never returns a negative cap when more was returned than received', () => {
    const caps = computeProvenanceCaps(provenance({ receivedQuantity: 10, returnedQuantity: 40 }));
    expect(caps.provenanceRemaining).toBe(0);
    expect(caps.safeReturnable).toBe(0);
  });

  it('treats a never-received line as zero returnable', () => {
    expect(computeProvenanceCaps(provenance({ receivedQuantity: null, returnedQuantity: 0 })).safeReturnable).toBe(0);
  });

  it('flags rather than hides an unreadable physical row', () => {
    const caps = computeProvenanceCaps(provenance({ resultingWarehouseStockId: null, onHandQuantity: null, reservedQuantity: null }));
    expect(caps.physicalUnknown).toBe(true);
    expect(caps.physicalAvailable).toBeNull();
    expect(caps.safeReturnable).toBe(70);
  });

  it('keeps EXPIRED material returnable and flags it — expiry is a reason TO return', () => {
    const flags = returnRiskFlags(provenance(), '2020-01-01', TODAY);
    expect(flags).toContain('expired');
    // The cap is untouched by expiry.
    expect(computeProvenanceCaps(provenance()).safeReturnable).toBe(70);
  });

  it('flags near expiry and provenance exceeding physical stock', () => {
    expect(returnRiskFlags(provenance(), '2026-08-15', TODAY)).toContain('near_expiry');
    expect(returnRiskFlags(provenance({ onHandQuantity: 20, reservedQuantity: 0 }), null, TODAY)).toContain('exceeds_physical');
  });
});

// ── draft composer ───────────────────────────────────────────────────────────

describe('composer draft validation', () => {
  it('accepts a well-formed supply draft', () => {
    expect(validateDraft([line()], 'supply', TODAY)).toEqual([]);
    expect(draftIsConfirmable([line()], 'supply', TODAY)).toBe(true);
  });

  it('an empty draft is never confirmable', () => {
    expect(draftIsConfirmable([], 'supply', TODAY)).toBe(false);
  });

  it('rejects non-positive, fractional and over-available quantities', () => {
    const codes = (l: DraftLine) => validateDraft([l], 'supply', TODAY).map(i => i.code);
    expect(codes(line({ quantity: 0 }))).toContain('quantity_not_positive');
    expect(codes(line({ quantity: -5 }))).toContain('quantity_not_positive');
    expect(codes(line({ quantity: 2.5 }))).toContain('quantity_not_integer');
    expect(codes(line({ quantity: 500, maxQuantity: 180 }))).toContain('quantity_exceeds_available');
  });

  it('rejects a duplicate material/batch row', () => {
    const issues = validateDraft([line({ idempotencyKey: 'k1' }), line({ idempotencyKey: 'k2' })], 'supply', TODAY);
    expect(issues.map(i => i.code)).toContain('duplicate_material_batch');
  });

  it('blocks EXPIRED stock from being dispatched as supply', () => {
    const codes = validateDraft([line({ expiryDate: '2020-01-01' })], 'supply', TODAY).map(i => i.code);
    expect(codes).toContain('expired_not_dispatchable');
  });

  it('but allows expired stock on a RETURN, which is the whole point of returning it', () => {
    const returnLine = line({
      warehouseStockId: null, originalTransferLineId: UUID_B,
      expiryDate: '2020-01-01', reasonCode: 'expired',
    });
    expect(validateDraft([returnLine], 'return', TODAY)).toEqual([]);
  });

  it('a supply line without a stock id has no identity and is rejected', () => {
    const codes = validateDraft([line({ warehouseStockId: null })], 'supply', TODAY).map(i => i.code);
    expect(codes).toContain('missing_identity');
  });

  it('a return line without provenance is rejected — free-text return is impossible', () => {
    const codes = validateDraft([line({ warehouseStockId: null, originalTransferLineId: null, reasonCode: 'damaged' })], 'return', TODAY).map(i => i.code);
    expect(codes).toContain('missing_provenance');
  });

  it('a return line requires a reason code', () => {
    const codes = validateDraft([line({ warehouseStockId: null, originalTransferLineId: UUID_B, reasonCode: null })], 'return', TODAY).map(i => i.code);
    expect(codes).toContain('missing_reason_code');
  });

  it('identity prefers the stable id over the typed name', () => {
    expect(lineIdentityKey(line())).toBe(`stock:${UUID_A}`);
    expect(lineIdentityKey(line({ warehouseStockId: null, originalTransferLineId: UUID_B }))).toBe(`prov:${UUID_B}`);
  });
});

describe('FEFO recommendation and search', () => {
  it('recommends the earliest non-expired batch but does not auto-select', () => {
    const soon = stock({ warehouseStockId: UUID_B, expiryDate: '2026-09-30' });
    const later = stock({ expiryDate: '2028-01-31' });
    expect(recommendFefo([later, soon], TODAY)?.warehouseStockId).toBe(UUID_B);
  });

  it('never recommends expired or zero-available stock', () => {
    expect(recommendFefo([stock({ expiryDate: '2020-01-01' })], TODAY)).toBeNull();
    expect(recommendFefo([stock({ availableQuantity: 0 })], TODAY)).toBeNull();
  });

  it('sorts undated stock last rather than treating unknown as distant', () => {
    const dated = stock({ warehouseStockId: UUID_B, expiryDate: '2029-01-01' });
    const undated = stock({ expiryDate: null });
    expect(recommendFefo([undated, dated], TODAY)?.warehouseStockId).toBe(UUID_B);
  });

  it('searches across name, code, batch and expiry', () => {
    const rows = [stock(), stock({ warehouseStockId: UUID_B, scientificName: 'Omeprazole', nationalCode: '9999', batchNumber: 'OMP1' })];
    expect(searchStock(rows, 'amoxi')).toHaveLength(1);
    expect(searchStock(rows, '9999')).toHaveLength(1);
    expect(searchStock(rows, 'OMP1')).toHaveLength(1);
    expect(searchStock(rows, '')).toHaveLength(2);
    expect(searchStock(rows, 'amoxi B4471X')).toHaveLength(1);
    expect(searchStock(rows, 'nonexistent')).toHaveLength(0);
  });

  it('builds a draft line carrying the stable ids, never a retyped identity', () => {
    const l = draftLineFromStock(stock({ centralItemId: UUID_B }), 5, 'k9');
    expect(l.warehouseStockId).toBe(UUID_A);
    expect(l.centralItemId).toBe(UUID_B);
    expect(l.maxQuantity).toBe(180);
    expect(l.idempotencyKey).toBe('k9');
  });
});

describe('stale-stock revalidation', () => {
  it('lowers the cap when availability dropped under a concurrent operator', () => {
    const result = revalidateAgainstFreshStock([line({ quantity: 150 })], [stock({ availableQuantity: 100 })]);
    expect(result.changed).toEqual(['k1']);
    expect(result.lines[0].maxQuantity).toBe(100);
    // And the draft now fails validation rather than being sent.
    expect(validateDraft(result.lines, 'supply', TODAY).map(i => i.code)).toContain('quantity_exceeds_available');
  });

  it('zeroes a line whose stock row disappeared entirely', () => {
    const result = revalidateAgainstFreshStock([line()], []);
    expect(result.lines[0].maxQuantity).toBe(0);
    expect(result.changed).toEqual(['k1']);
  });

  it('reports no change when availability is unchanged', () => {
    expect(revalidateAgainstFreshStock([line()], [stock()]).changed).toEqual([]);
  });
});

describe('expiry helper', () => {
  it('treats today as not expired and yesterday as expired', () => {
    expect(isExpired('2026-07-21', TODAY)).toBe(false);
    expect(isExpired('2026-07-20', TODAY)).toBe(true);
    expect(isExpired(null, TODAY)).toBe(false);
    expect(isExpired('not-a-date', TODAY)).toBe(false);
  });
});
