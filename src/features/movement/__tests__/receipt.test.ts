import { describe, it, expect } from 'vitest';
import {
  LOCKED_FIELD_KEYS, MANDATORY_HEADER_FIELDS,
  availableFields, fieldsForPreset, normalizeSelection, clearOptionalFields,
  orientationFor, receiptCellValue,
  type ReceiptDocument, type ReceiptLine, type ReceiptFieldKey,
} from '../receipt-model';
import { buildReceiptHtml } from '../receipt-html';
import { isOfficialReceiptKind } from '../movement-trace';

const TRACE = '11111111-2222-4333-8444-555555555555';

function line(over: Partial<ReceiptLine> = {}): ReceiptLine {
  return {
    lineNumber: 1, scientificName: 'Amoxicillin', tradeName: null,
    concentration: '500 mg', dosageForm: 'Capsule', unit: 'capsule',
    nationalCode: '1234567', batchNumber: 'B4471X', internalBatchReference: null,
    expiryDate: '2027-06-30', requestedQuantity: 240, approvedQuantity: 240,
    movedQuantity: 240, receivedQuantity: null, onHandSnapshot: null,
    returnReason: null, disposition: null, custodyState: null,
    unitPrice: 1250, currency: 'IQD', priceBasis: 'invoice', supplyType: 'central',
    notes: null, originalSupplyReference: null,
    ...over,
  };
}

function doc(over: Partial<ReceiptDocument> = {}): ReceiptDocument {
  return {
    kind: 'supply_dispatch', traceKey: TRACE, externalReference: 'OPS-77',
    requestTraceKey: null, originalSupplyTraceKey: null, status: 'in_transit',
    eventAt: '2026-07-21T09:00:00Z',
    source: { organizationName: 'Babil Health', warehouseName: 'Central Store' },
    destination: { organizationName: 'Al-Sadiq Hospital', warehouseName: 'Hospital Depot' },
    actorName: null, actorRole: null, counterpartyName: null,
    watermark: 'none', reprintedAt: null, lines: [line()],
    ...over,
  };
}

const SUPPLY = { isReturn: false, canSeePrices: true };
const RETURN = { isReturn: true, canSeePrices: true };
const NO_PRICE = { isReturn: false, canSeePrices: false };

describe('mandatory traceability fields', () => {
  it('locks the header fields that make a document traceable', () => {
    expect([...MANDATORY_HEADER_FIELDS]).toEqual(
      ['documentType', 'traceKey', 'qr', 'eventAt', 'source', 'destination', 'status'],
    );
  });

  it('locks line number and scientific name at row level', () => {
    expect([...LOCKED_FIELD_KEYS]).toEqual(['lineNumber', 'scientificName']);
  });

  it('re-adds locked fields even when a caller explicitly drops them', () => {
    const selection = normalizeSelection(['batchNumber'], SUPPLY);
    expect(selection).toContain('lineNumber');
    expect(selection).toContain('scientificName');
    expect(selection).toContain('batchNumber');
  });

  it('"clear optional fields" leaves exactly the locked ones, never an empty document', () => {
    expect(clearOptionalFields(SUPPLY)).toEqual(['lineNumber', 'scientificName']);
  });
});

describe('presets and availability', () => {
  it('full selects every available field; compact is a strict subset', () => {
    const full = fieldsForPreset('full', SUPPLY);
    const compact = fieldsForPreset('compact', SUPPLY);
    expect(full.length).toBe(availableFields(SUPPLY).length);
    expect(compact.length).toBeLessThan(full.length);
    expect(compact.every(k => full.includes(k))).toBe(true);
  });

  it('every preset still contains the locked fields', () => {
    for (const preset of ['full', 'compact'] as const) {
      for (const locked of LOCKED_FIELD_KEYS) {
        expect(fieldsForPreset(preset, SUPPLY)).toContain(locked);
      }
    }
  });

  it('return-only fields are offered on returns and hidden on supply', () => {
    const returnKeys = availableFields(RETURN).map(f => f.key);
    const supplyKeys = availableFields(SUPPLY).map(f => f.key);
    for (const key of ['returnReason', 'disposition', 'custodyState', 'originalSupplyReference'] as ReceiptFieldKey[]) {
      expect(returnKeys).toContain(key);
      expect(supplyKeys).not.toContain(key);
    }
  });

  it('price fields DISAPPEAR without permission rather than printing a blank column', () => {
    const keys = availableFields(NO_PRICE).map(f => f.key);
    for (const key of ['unitPrice', 'currency', 'priceBasis', 'supplyType'] as ReceiptFieldKey[]) {
      expect(keys).not.toContain(key);
    }
    // And an unauthorized caller cannot smuggle one in through a custom selection.
    expect(normalizeSelection(['unitPrice', 'currency'], NO_PRICE)).not.toContain('unitPrice');
  });

  it('selection order follows the canonical field order, not tick order', () => {
    const a = normalizeSelection(['notes', 'batchNumber', 'unit'], SUPPLY);
    const b = normalizeSelection(['unit', 'notes', 'batchNumber'], SUPPLY);
    expect(a).toEqual(b);
  });

  it('chooses landscape only once the column count would squeeze a portrait page', () => {
    expect(orientationFor(['lineNumber', 'scientificName'])).toBe('portrait');
    expect(orientationFor(fieldsForPreset('full', SUPPLY))).toBe('landscape');
  });
});

describe('receipt cells never fabricate data', () => {
  it('renders an em dash for null, undefined and empty values', () => {
    expect(receiptCellValue(line({ tradeName: null }), 'tradeName')).toBe('—');
    expect(receiptCellValue(line({ batchNumber: '' }), 'batchNumber')).toBe('—');
    expect(receiptCellValue(line(), 'scientificName')).toBe('Amoxicillin');
  });
});

describe('official receipt availability', () => {
  it('only a dispatch or shipment is an official receipt — a request never is', () => {
    expect(isOfficialReceiptKind('supply_dispatch')).toBe(true);
    expect(isOfficialReceiptKind('return_shipment')).toBe(true);
    expect(isOfficialReceiptKind('supply_request')).toBe(false);
    expect(isOfficialReceiptKind('return_request')).toBe(false);
  });
});

describe('receipt HTML', () => {
  const selection = fieldsForPreset('compact', SUPPLY);

  it('renders the mandatory header fields and the canonical trace key', () => {
    const html = buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' });
    expect(html).toContain('Supply Dispatch Receipt');
    expect(html).toContain(TRACE);
    expect(html).toContain('11111111');           // short quotable form
    expect(html).toContain('Permanent trace key');
    expect(html).toContain('Event date and time');
    expect(html).toContain('Status');
  });

  it('labels an operator-typed number as an external reference, never a serial', () => {
    const html = buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' });
    expect(html).toContain('Official letter / external document number — optional');
    expect(html).toContain('OPS-77');
    expect(html).not.toMatch(/official serial|serial number/i);
  });

  it('always pairs an institution with its warehouse', () => {
    const html = buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' });
    expect(html).toContain('Babil Health — Central Store');
    expect(html).toContain('Al-Sadiq Hospital — Hospital Depot');
  });

  it('escapes every hostile value instead of emitting markup', () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const html = buildReceiptHtml({
      document: doc({
        externalReference: hostile,
        source: { organizationName: hostile, warehouseName: hostile },
        lines: [line({ scientificName: hostile, notes: hostile })],
      }),
      selectedFields: normalizeSelection(['notes'], SUPPLY),
      lang: 'en',
    });
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('onerror="alert(1)"');
    expect(html).toContain('&lt;img');
  });

  it('escapes a hostile QR data URL rather than trusting it', () => {
    const html = buildReceiptHtml({
      document: doc(), selectedFields: selection, lang: 'en',
      qrDataUrl: '"><script>alert(1)</script>',
    });
    expect(html).not.toContain('<script>alert(1)</script>');
  });

  it('renders RTL for Arabic and LTR for English', () => {
    expect(buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'ar' })).toContain('dir="rtl"');
    expect(buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' })).toContain('dir="ltr"');
    expect(buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'ar' })).toContain('وصل تجهيز');
  });

  it('prints a fixed white high-contrast theme regardless of app theme', () => {
    const html = buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' });
    expect(html).toContain('background: #fff');
    expect(html).toContain('color: #111');
  });

  it('repeats the table header and never splits a material row across pages', () => {
    const html = buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' });
    expect(html).toContain('display: table-header-group');
    expect(html).toContain('page-break-inside: avoid');
  });

  it('carries page numbering', () => {
    expect(buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' })).toContain('counter-increment: page');
  });

  it('prints exactly the selected columns — no more, no fewer', () => {
    const chosen = normalizeSelection(['batchNumber', 'expiryDate'], SUPPLY);
    const html = buildReceiptHtml({ document: doc(), selectedFields: chosen, lang: 'en' });
    expect(html).toContain('Batch number');
    expect(html).toContain('Expiry date');
    expect(html).not.toContain('National code');   // available but not selected
    expect(html).not.toContain('Unit price');
  });

  it('stamps DRAFT, PARTIAL and CANCELLED watermarks honestly', () => {
    expect(buildReceiptHtml({ document: doc({ watermark: 'draft' }), selectedFields: selection, lang: 'en' })).toContain('DRAFT');
    expect(buildReceiptHtml({ document: doc({ watermark: 'partial' }), selectedFields: selection, lang: 'en' })).toContain('PARTIAL');
    expect(buildReceiptHtml({ document: doc({ watermark: 'cancelled' }), selectedFields: selection, lang: 'en' })).toContain('CANCELLED');
    expect(buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' })).not.toContain('class="watermark"');
  });

  it('marks a reprint and shows when, without changing the reference', () => {
    const html = buildReceiptHtml({
      document: doc({ watermark: 'reprint', reprintedAt: '2026-07-22T10:00:00Z' }),
      selectedFields: selection, lang: 'en',
    });
    expect(html).toContain('REPRINT');
    expect(html).toContain('2026-07-22T10:00:00Z');
    expect(html).toContain(TRACE);      // same canonical key
  });

  it('says "not available" for an identity RLS did not expose, instead of inventing one', () => {
    const html = buildReceiptHtml({ document: doc({ actorName: null, counterpartyName: null }), selectedFields: selection, lang: 'en' });
    expect(html).toContain('Not available');
  });

  it('shows an actor only when it was genuinely provided', () => {
    const html = buildReceiptHtml({
      document: doc({ actorName: 'PH. Sara', actorRole: 'warehouse_officer' }),
      selectedFields: selection, lang: 'en',
    });
    expect(html).toContain('PH. Sara (warehouse_officer)');
  });

  it('links a return line back to its original supply reference', () => {
    const html = buildReceiptHtml({
      document: doc({
        kind: 'return_shipment', originalSupplyTraceKey: 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',
        lines: [line({ originalSupplyReference: 'TR-9', returnReason: 'expired' })],
      }),
      selectedFields: normalizeSelection(['returnReason', 'originalSupplyReference'], RETURN),
      lang: 'en',
    });
    expect(html).toContain('Return Shipment Receipt');
    expect(html).toContain('Original supply reference');
    expect(html).toContain('TR-9');
    expect(html).toContain('expired');
  });

  it('renders an empty-lines document without collapsing the table', () => {
    const html = buildReceiptHtml({ document: doc({ lines: [] }), selectedFields: selection, lang: 'en' });
    expect(html).toContain('No materials');
  });

  it('carries no operational emoji', () => {
    const html = buildReceiptHtml({ document: doc(), selectedFields: selection, lang: 'en' });
    expect(html).not.toMatch(/[\u{1F300}-\u{1FAFF}\u{2700}-\u{27BF}]/u);
  });
});
