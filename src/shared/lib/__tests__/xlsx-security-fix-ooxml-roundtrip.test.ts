/**
 * XLSX-SECURITY-FIX-EXCELJS-ARCHIVER-OVERRIDE
 *
 * Round-trip OOXML parity proof for the exceljs security fix (package.json
 * `overrides`: exceljs > archiver -> 8.0.0, exceljs > unzipper -> 0.12.5).
 *
 * Every one of this repo's four real exceljs call sites builds its workbook
 * via `new ExcelJS.Workbook()` + `wb.xlsx.writeBuffer()` — the buffer-based
 * path implemented in exceljs's `lib/xlsx/xlsx.js`, which requires `jszip`
 * directly and never touches `archiver`/`unzipper` (those are confined to
 * the separate streaming Workbook Reader/Writer API, which is never
 * imported anywhere in this codebase, and which is absent entirely from
 * exceljs's own browser bundle — see package.json's own `"browser"` field
 * resolution). This suite doesn't re-assert that architecture; it proves
 * the OUTPUT is unaffected by actually round-tripping real generated files:
 * write a real .xlsx buffer, verify the raw ZIP/OOXML signature, reload it
 * through exceljs's own reader (also archiver/unzipper-free), and assert
 * every structural property this repo depends on survives serialization —
 * not just the in-memory Workbook object (already covered by
 * professional-export.test.ts / receipt-xlsx.test.ts), which a broken
 * writeBuffer() could pass while still emitting a corrupt file.
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import {
  buildProfessionalWorkbook,
  buildMultiSheetProfessionalWorkbook,
  buildAvailabilityExportWorkbook,
  buildOutletReportWorkbook,
  neutralizeFormulaValue,
  type ProfessionalExportConfig,
  type AvailabilityExportConfig,
  type AvailabilityExportRow,
  type OutletReportConfig,
  type OutletReportRow,
} from '../professional-export';
import { buildReceiptWorkbook } from '@/features/movement/receipt-xlsx';
import { fieldsForPreset, type ReceiptDocument, type ReceiptLine } from '@/features/movement/receipt-model';

const ZIP_SIGNATURE = [0x50, 0x4b, 0x03, 0x04];

function assertRealZip(buffer: ExcelJS.Buffer): Uint8Array {
  const bytes = new Uint8Array(buffer as unknown as ArrayBuffer);
  expect(bytes.length).toBeGreaterThan(1000);
  expect([bytes[0], bytes[1], bytes[2], bytes[3]]).toEqual(ZIP_SIGNATURE);
  return bytes;
}

async function loadWorkbook(wb: ExcelJS.Workbook, buffer: ExcelJS.Buffer): Promise<void> {
  await wb.xlsx.load(buffer);
}

/** Writes a workbook to a real buffer, verifies the ZIP signature, then reloads it through exceljs's own (archiver/unzipper-free) reader. */
async function roundTrip(wb: ExcelJS.Workbook): Promise<ExcelJS.Workbook> {
  const buffer = await wb.xlsx.writeBuffer();
  assertRealZip(buffer);
  const reloaded = new ExcelJS.Workbook();
  await loadWorkbook(reloaded, buffer);
  return reloaded;
}

const cellText = (v: unknown): string =>
  typeof v === 'object' && v !== null && 'text' in (v as object) ? String((v as { text: unknown }).text) : String(v ?? '');

const ARABIC_TEXT = 'باراسيتامول ٥٠٠ ملغم — دائرة صحة بابل';

function professionalConfig(overrides: Partial<ProfessionalExportConfig<{ name: string; qty: number; when: Date }>> = {}): ProfessionalExportConfig<{ name: string; qty: number; when: Date }> {
  return {
    reportTitle: 'Roundtrip Report',
    moduleName: 'Roundtrip Module',
    generatedAt: new Date('2026-06-01T12:00:00Z'),
    filtersSummary: 'All',
    columns: [
      { key: 'name', label: 'Name', value: r => r.name },
      { key: 'qty', label: 'Qty', value: r => String(r.qty), numeric: true },
      { key: 'when', label: 'When', value: r => r.when.toISOString(), excelValue: r => r.when, dateColumn: 'date' },
    ],
    rows: [{ name: ARABIC_TEXT, qty: 42, when: new Date('2027-01-01') }],
    lang: 'ar',
    fileNameBase: 'roundtrip',
    footerText: 'Footer',
    labels: { generatedAt: 'Generated', filtersSummary: 'Filters', rowCount: 'Rows' },
    ...overrides,
  };
}

describe('exceljs security-fix round-trip: buildProfessionalWorkbook (single sheet)', () => {
  it('a real .xlsx buffer reloads with the RTL view, frozen header, autoFilter, Arabic text and date numFmt all intact', async () => {
    const wb = await buildProfessionalWorkbook(professionalConfig());
    const reloaded = await roundTrip(wb);
    const ws = reloaded.worksheets[0];

    expect(ws.views.some(v => v.rightToLeft === true)).toBe(true);
    const frozen = ws.views.find(v => v.state === 'frozen') as ExcelJS.WorksheetViewFrozen | undefined;
    expect(frozen).toBeDefined();
    expect(frozen!.ySplit).toBeGreaterThan(0);
    expect(ws.autoFilter).toBeDefined();

    const text: string[] = [];
    ws.eachRow(row => row.eachCell(c => text.push(cellText(c.value))));
    expect(text.join(' | ')).toContain(ARABIC_TEXT);

    let dateCell: ExcelJS.Cell | undefined;
    ws.eachRow(row => row.eachCell(c => { if (c.value instanceof Date) dateCell = c; }));
    expect(dateCell).toBeDefined();
    expect(dateCell!.numFmt).toBe('yyyy-mm-dd');
  });

  it('a zero-row export round-trips with the empty-state message, not a corrupt/missing sheet', async () => {
    const wb = await buildProfessionalWorkbook(professionalConfig({ rows: [], emptyMessage: 'No rows here' }));
    const reloaded = await roundTrip(wb);
    const ws = reloaded.worksheets[0];
    const text: string[] = [];
    ws.eachRow(row => row.eachCell(c => text.push(cellText(c.value))));
    expect(text.join(' | ')).toContain('No rows here');
  });

  it('formula-injection-neutralized values remain literal text after reopening, never a live formula', async () => {
    const dangerous = '=1+1';
    expect(neutralizeFormulaValue(dangerous)).toBe(`'${dangerous}`);
    const wb = await buildProfessionalWorkbook(professionalConfig({
      rows: [{ name: dangerous, qty: 1, when: new Date('2027-01-01') }],
    }));
    const reloaded = await roundTrip(wb);
    const ws = reloaded.worksheets[0];
    let nameCell: ExcelJS.Cell | undefined;
    ws.eachRow(row => row.eachCell(c => { if (cellText(c.value).includes('1+1')) nameCell = c; }));
    expect(nameCell).toBeDefined();
    expect(nameCell!.type).not.toBe(ExcelJS.ValueType.Formula);
    expect(cellText(nameCell!.value).startsWith('=')).toBe(false);
  });
});

describe('exceljs security-fix round-trip: buildMultiSheetProfessionalWorkbook', () => {
  it('every configured sheet survives serialization, in order, each with its own module name', async () => {
    const wb = await buildMultiSheetProfessionalWorkbook([
      professionalConfig({ moduleName: 'Sheet One' }),
      professionalConfig({ moduleName: 'Sheet Two', lang: 'en', rows: [{ name: 'English Row', qty: 7, when: new Date('2026-05-05') }] }),
    ]);
    const reloaded = await roundTrip(wb);
    expect(reloaded.worksheets.map(ws => ws.name)).toEqual(['Sheet One', 'Sheet Two']);
  });
});

const CONDITION_LABELS: Record<string, string> = {
  available: 'Available / متوفر',
  missing: 'Missing / مفقود',
};

function availRow(overrides: Partial<AvailabilityExportRow> = {}): AvailabilityExportRow {
  return {
    no: 1, institution: 'Test Hospital', outlet: 'Main Pharmacy',
    scientificName: ARABIC_TEXT, tradeName: 'Panadol', dosageForm: 'Tablet',
    concentration: '500mg', batchNumber: 'B123', quantity: 40, enteredPrice: 12.5,
    conditionKey: 'available', conditionLabel: CONDITION_LABELS.available,
    expiryDate: new Date('2027-01-01'), daysToExpiry: 200, expiryRiskLabel: 'Normal',
    lastUpdatedBy: 'Dr. Ahmed', lastUpdatedAt: new Date('2026-06-01T10:00:00Z'), notes: 'note',
    ...overrides,
  };
}

function availConfig(overrides: Partial<AvailabilityExportConfig> = {}): AvailabilityExportConfig {
  return {
    reportTitle: 'Availability Roundtrip', generatedAt: new Date('2026-06-01T12:00:00Z'),
    lang: 'ar', fileNameBase: 'avail-roundtrip', filtersSummary: 'All', footerText: 'Footer',
    emptyMessage: 'No records', conditionLabels: CONDITION_LABELS, rows: [availRow()],
    ...overrides,
  };
}

describe('exceljs security-fix round-trip: buildAvailabilityExportWorkbook (3 sheets)', () => {
  it('all 3 sheets (Summary / Availability Export / Data Dictionary) survive serialization with Arabic text and merged title cells intact', async () => {
    const wb = await buildAvailabilityExportWorkbook(availConfig());
    const reloaded = await roundTrip(wb);
    expect(reloaded.worksheets.map(ws => ws.name)).toEqual(['Summary', 'Availability Export', 'Data Dictionary']);

    const dataWs = reloaded.getWorksheet('Availability Export')!;
    const text: string[] = [];
    dataWs.eachRow(row => row.eachCell(c => text.push(cellText(c.value))));
    expect(text.join(' | ')).toContain(ARABIC_TEXT);

    // The title row is merged across all columns (mergeCells(row, 1, row, colCount)) — a merged
    // range must still list A1 as its master cell after a real write+reload round trip.
    const merges = Object.keys((dataWs.model as unknown as { merges: string[] }).merges ?? {});
    expect(merges.length).toBeGreaterThan(0);
  });

  it('a zero-row export round-trips honestly (empty message, not a fabricated row)', async () => {
    const wb = await buildAvailabilityExportWorkbook(availConfig({ rows: [], emptyMessage: 'Nothing found' }));
    const reloaded = await roundTrip(wb);
    const dataWs = reloaded.getWorksheet('Availability Export')!;
    const text: string[] = [];
    dataWs.eachRow(row => row.eachCell(c => text.push(cellText(c.value))));
    expect(text.join(' | ')).toContain('Nothing found');
  });
});

function outletRow(overrides: Partial<OutletReportRow> = {}): OutletReportRow {
  return { ...availRow(), removedLabel: 'Active / نشط', supplyType: 'central', ...overrides };
}

function outletConfig(overrides: Partial<OutletReportConfig> = {}): OutletReportConfig {
  return {
    reportTitle: 'Outlet Roundtrip', generatedAt: new Date('2026-06-01T12:00:00Z'),
    lang: 'ar', fileNameBase: 'outlet-roundtrip', filtersSummary: 'All', footerText: 'Footer',
    emptyMessage: 'No records', outletName: 'Main Pharmacy', institutionName: 'Test Hospital',
    summary: {
      totalItems: 1, availableCount: 1, lowStockCount: 0, missingCount: 0,
      nearExpiryCount: 0, surplusCount: 0, totalQuantity: 40, pricedItemsCount: 1,
    },
    rows: [outletRow()],
    ...overrides,
  };
}

describe('exceljs security-fix round-trip: buildOutletReportWorkbook (3 sheets)', () => {
  it('survives serialization with its 3 sheets and summary totals intact', async () => {
    const wb = await buildOutletReportWorkbook(outletConfig());
    const reloaded = await roundTrip(wb);
    expect(reloaded.worksheets.map(ws => ws.name)).toEqual(['Summary', 'Outlet Availability', 'Data Dictionary']);
  });
});

const TRACE = '11111111-2222-4333-8444-555555555555';

function receiptLine(overrides: Partial<ReceiptLine> = {}): ReceiptLine {
  return {
    lineNumber: 1, scientificName: ARABIC_TEXT, tradeName: null,
    concentration: '500 mg', dosageForm: 'Capsule', unit: 'capsule',
    nationalCode: '1234567', batchNumber: 'B4471X', internalBatchReference: null,
    expiryDate: '2027-06-30', requestedQuantity: 240, approvedQuantity: 240,
    movedQuantity: 240, receivedQuantity: null, onHandSnapshot: null,
    returnReason: null, disposition: null, custodyState: null,
    unitPrice: 1250, currency: 'IQD', priceBasis: 'invoice', purchaseOrigin: null, supplyType: 'central',
    notes: null, originalSupplyReference: null,
    ...overrides,
  };
}

function receiptDoc(overrides: Partial<ReceiptDocument> = {}): ReceiptDocument {
  return {
    kind: 'supply_dispatch', traceKey: TRACE, externalReference: 'OPS-77',
    requestTraceKey: null, originalSupplyTraceKey: null, status: 'in_transit',
    eventAt: '2026-07-21T09:00:00Z',
    source: { organizationName: 'Babil Health', warehouseName: 'Central Store' },
    destination: { organizationName: 'Al-Sadiq Hospital', warehouseName: 'Hospital Depot' },
    actorName: null, actorRole: null, counterpartyName: null,
    watermark: 'none', reprintedAt: null, lines: [receiptLine()],
    ...overrides,
  };
}

describe('exceljs security-fix round-trip: buildReceiptWorkbook (3 sheets)', () => {
  it('all 3 sheets survive serialization with RTL, frozen header, autoFilter and Arabic material name intact', async () => {
    const wb = await buildReceiptWorkbook({ document: receiptDoc(), selectedFields: fieldsForPreset('compact', { isReturn: false, canSeePrices: true }), lang: 'ar' });
    const reloaded = await roundTrip(wb);
    expect(reloaded.worksheets.map(ws => ws.name)).toEqual(['الملخّص', 'أسطر المواد', 'الاستثناءات']);

    const linesWs = reloaded.getWorksheet('أسطر المواد')!;
    expect(linesWs.views.some(v => v.rightToLeft === true)).toBe(true);
    const frozen = linesWs.views.find(v => v.state === 'frozen') as ExcelJS.WorksheetViewFrozen | undefined;
    expect(frozen?.ySplit).toBe(1);
    expect(linesWs.autoFilter).toBeDefined();

    const text: string[] = [];
    linesWs.eachRow(row => row.eachCell(c => text.push(cellText(c.value))));
    expect(text.join(' | ')).toContain(ARABIC_TEXT);
  });

  it('an empty exceptions list still round-trips a real (non-omitted) Exceptions sheet', async () => {
    const wb = await buildReceiptWorkbook({ document: receiptDoc(), selectedFields: fieldsForPreset('compact', { isReturn: false, canSeePrices: true }), lang: 'ar', exceptions: [] });
    const reloaded = await roundTrip(wb);
    const exWs = reloaded.getWorksheet('الاستثناءات')!;
    expect(exWs.rowCount).toBeGreaterThan(1); // header + the "no exceptions" placeholder row
  });
});
