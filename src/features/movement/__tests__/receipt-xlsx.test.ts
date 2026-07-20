import { describe, it, expect } from 'vitest';
import { buildReceiptWorkbook } from '../receipt-xlsx';
import { fieldsForPreset, normalizeSelection, type ReceiptDocument, type ReceiptLine } from '../receipt-model';

const TRACE = '11111111-2222-4333-8444-555555555555';
const SUPPLY = { isReturn: false, canSeePrices: true };

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

const cellText = (v: unknown): string => (typeof v === 'object' && v !== null && 'text' in (v as object))
  ? String((v as { text: unknown }).text)
  : String(v ?? '');

describe('receipt workbook structure', () => {
  it('is a genuine workbook with exactly the three required sheets', async () => {
    const wb = await buildReceiptWorkbook({ document: doc(), selectedFields: fieldsForPreset('compact', SUPPLY), lang: 'en' });
    expect(wb.worksheets.map(s => s.name)).toEqual(['Summary', 'Material Lines', 'Exceptions']);
  });

  it('writes a real xlsx buffer with the ZIP signature, not a renamed CSV', async () => {
    const wb = await buildReceiptWorkbook({ document: doc(), selectedFields: fieldsForPreset('compact', SUPPLY), lang: 'en' });
    const buffer = await wb.xlsx.writeBuffer();
    const bytes = new Uint8Array(buffer as ArrayBuffer);
    expect(bytes.length).toBeGreaterThan(1000);
    // "PK\x03\x04"
    expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
  });

  it('the Summary sheet carries every mandatory trace field', async () => {
    const wb = await buildReceiptWorkbook({ document: doc(), selectedFields: fieldsForPreset('compact', SUPPLY), lang: 'en' });
    const text: string[] = [];
    wb.getWorksheet('Summary')!.eachRow(row => row.eachCell(c => text.push(cellText(c.value))));
    const joined = text.join(' | ');
    expect(joined).toContain('Supply Dispatch Receipt');
    expect(joined).toContain(TRACE);
    expect(joined).toContain('External / operator reference');
    expect(joined).toContain('OPS-77');
    expect(joined).toContain('Babil Health — Central Store');
    expect(joined).toContain('Al-Sadiq Hospital — Hospital Depot');
    expect(joined).toContain('Event date and time');
  });

  it('the Material Lines sheet has exactly the selected columns', async () => {
    const selected = normalizeSelection(['batchNumber', 'expiryDate'], SUPPLY);
    const wb = await buildReceiptWorkbook({ document: doc(), selectedFields: selected, lang: 'en' });
    const header = wb.getWorksheet('Material Lines')!.getRow(1).values as unknown[];
    const labels = header.slice(1).map(cellText);
    expect(labels).toEqual(['#', 'Scientific name', 'Batch number', 'Expiry date']);
    expect(labels).not.toContain('Unit price');
  });

  it('keeps genuine numbers numeric so the sheet can be summed', async () => {
    const wb = await buildReceiptWorkbook({
      document: doc(), selectedFields: normalizeSelection(['movedQuantity'], SUPPLY), lang: 'en',
    });
    const sheet = wb.getWorksheet('Material Lines')!;
    const value = sheet.getRow(2).getCell(3).value;
    expect(typeof value).toBe('number');
    expect(value).toBe(240);
  });

  it('always includes an Exceptions sheet, even with nothing to report', async () => {
    const wb = await buildReceiptWorkbook({ document: doc(), selectedFields: fieldsForPreset('compact', SUPPLY), lang: 'en' });
    const sheet = wb.getWorksheet('Exceptions')!;
    // An absent sheet would be indistinguishable from "not checked".
    expect(sheet.rowCount).toBeGreaterThanOrEqual(2);
    expect(cellText(sheet.getRow(2).getCell(3).value)).toBe('No exceptions');
  });

  it('lists reported exceptions', async () => {
    const wb = await buildReceiptWorkbook({
      document: doc(), selectedFields: fieldsForPreset('compact', SUPPLY), lang: 'en',
      exceptions: [{ lineNumber: 1, scientificName: 'Amoxicillin', kind: 'send_failed', detail: 'insufficient stock' }],
    });
    const sheet = wb.getWorksheet('Exceptions')!;
    expect(cellText(sheet.getRow(2).getCell(3).value)).toBe('send_failed');
    expect(cellText(sheet.getRow(2).getCell(4).value)).toBe('insufficient stock');
  });

  it('records a non-final status in the workbook, not only on the printout', async () => {
    const wb = await buildReceiptWorkbook({
      document: doc({ watermark: 'partial' }), selectedFields: fieldsForPreset('compact', SUPPLY), lang: 'en',
    });
    const text: string[] = [];
    wb.getWorksheet('Summary')!.eachRow(row => row.eachCell(c => text.push(cellText(c.value))));
    expect(text.join(' | ')).toContain('PARTIAL');
  });

  it('renders Arabic sheets right-to-left', async () => {
    const wb = await buildReceiptWorkbook({ document: doc(), selectedFields: fieldsForPreset('compact', SUPPLY), lang: 'ar' });
    expect(wb.worksheets.map(s => s.name)).toEqual(['الملخّص', 'أسطر المواد', 'الاستثناءات']);
    expect(wb.worksheets[0].views[0]).toMatchObject({ rightToLeft: true });
  });
});

describe('spreadsheet formula injection is neutralized', () => {
  const payloads = ['=cmd|calc', '+1+1', '-1+1', '@SUM(A1)', '\tHIDDEN', '\rHIDDEN'];

  it('neutralizes a hostile material name in the lines sheet', async () => {
    for (const payload of payloads) {
      const wb = await buildReceiptWorkbook({
        document: doc({ lines: [line({ scientificName: payload })] }),
        selectedFields: normalizeSelection([], SUPPLY),
        lang: 'en',
      });
      const value = cellText(wb.getWorksheet('Material Lines')!.getRow(2).getCell(2).value);
      expect(value.startsWith('='), payload).toBe(false);
      expect(value.startsWith('+'), payload).toBe(false);
      expect(value.startsWith('-'), payload).toBe(false);
      expect(value.startsWith('@'), payload).toBe(false);
    }
  });

  it('neutralizes a hostile external reference in the summary sheet', async () => {
    const wb = await buildReceiptWorkbook({
      document: doc({ externalReference: '=HYPERLINK("http://evil","x")' }),
      selectedFields: normalizeSelection([], SUPPLY), lang: 'en',
    });
    const text: string[] = [];
    wb.getWorksheet('Summary')!.eachRow(row => row.eachCell(c => text.push(cellText(c.value))));
    expect(text.some(v => v.startsWith('=HYPERLINK'))).toBe(false);
  });

  it('neutralizes a hostile exception detail', async () => {
    const wb = await buildReceiptWorkbook({
      document: doc(), selectedFields: normalizeSelection([], SUPPLY), lang: 'en',
      exceptions: [{ lineNumber: 1, scientificName: '=EVIL()', kind: '=EVIL()', detail: '=EVIL()' }],
    });
    const row = wb.getWorksheet('Exceptions')!.getRow(2);
    for (const col of [2, 3, 4]) {
      expect(cellText(row.getCell(col).value).startsWith('=')).toBe(false);
    }
  });
});
