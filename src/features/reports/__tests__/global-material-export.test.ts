/**
 * @vitest-environment jsdom
 *
 * XLSX-SECURITY-FIX-EXCELJS-ARCHIVER-OVERRIDE
 *
 * global-material-export.ts had zero test coverage before this fix, and is
 * the ONLY one of this repo's four exceljs call sites that sets
 * `worksheet.pageSetup.printArea`/`printTitlesRow` — a capability this
 * repo's chosen fix (package.json overrides: exceljs > archiver -> 8.0.0,
 * exceljs > unzipper -> 0.12.5) had to preserve untouched, since it never
 * rewrote any application code. This suite captures the real Blob the
 * module hands to the browser download anchor, verifies it's a genuine
 * ZIP/OOXML file, and reloads it through exceljs's own reader to prove
 * every structural property — including printArea — survives
 * serialization with the overridden dependency versions in place.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import ExcelJS from 'exceljs';
import { exportGlobalMaterialSearchWorkbook, type GlobalMaterialExportContext } from '../global-material-export';
import type { GlobalMaterialSearchRow } from '../global-material-search.service';

const ARABIC_TEXT = 'باراسيتامول ٥٠٠ ملغم';

function row(overrides: Partial<GlobalMaterialSearchRow> = {}): GlobalMaterialSearchRow {
  return {
    key: 'k1', organizationId: 'org-1', organizationName: 'Al-Sadiq Hospital',
    organizationNameAr: ARABIC_TEXT, scopeKind: 'warehouse', scopeId: 'wh-1',
    scopeName: 'Central Store', scopeNameAr: 'المذخر المركزي',
    scientificName: 'Paracetamol', tradeNames: ['Panadol'], concentration: ['500mg'],
    dosageForm: ['Tablet'], unit: ['Tablet'], nationalCode: '1234567',
    onHand: 100, reserved: 10, available: 90, batchCount: 2,
    nearestExpiry: '2027-01-01', expiredAvailable: 0, nearExpiryAvailable: 5,
    signals: [],
    ...overrides,
  };
}

function context(overrides: Partial<GlobalMaterialExportContext> = {}): GlobalMaterialExportContext {
  return {
    lang: 'ar',
    query: 'Paracetamol',
    organizations: [{ id: 'org-1', name: 'Al-Sadiq Hospital', nameAr: ARABIC_TEXT }],
    result: { rows: [row()], totalRows: 1, truncated: false, searchedAt: '2026-06-01T12:00:00Z' },
    ...overrides,
  };
}

/** Captures the Blob passed to URL.createObjectURL, standing in for the real download click. */
function captureDownloadBlob(): { get: () => Blob } {
  let captured: Blob | undefined;
  const origCreate = URL.createObjectURL;
  const origRevoke = URL.revokeObjectURL;
  URL.createObjectURL = vi.fn((blob: Blob) => {
    captured = blob;
    return 'blob:mock-url';
  });
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  afterEachRestore.push(() => {
    URL.createObjectURL = origCreate;
    URL.revokeObjectURL = origRevoke;
  });
  return { get: () => { if (!captured) throw new Error('no blob captured'); return captured; } };
}

const afterEachRestore: Array<() => void> = [];
afterEach(() => {
  vi.restoreAllMocks();
  afterEachRestore.splice(0).forEach(fn => fn());
});

async function blobToBuffer(blob: Blob): Promise<Buffer> {
  const arrayBuffer = await blob.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

async function loadWorkbook(wb: ExcelJS.Workbook, buffer: Buffer): Promise<void> {
  await wb.xlsx.load(buffer as unknown as ExcelJS.Buffer);
}

describe('exceljs security-fix round-trip: exportGlobalMaterialSearchWorkbook (global material search, 3 sheets)', () => {
  it('downloads a real .xlsx (ZIP signature) that reloads with all 3 sheets, RTL, frozen header and Arabic text intact', async () => {
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context());

    const buffer = await blobToBuffer(capture.get());
    expect([buffer[0], buffer[1], buffer[2], buffer[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);

    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, buffer);
    expect(wb.worksheets.map(ws => ws.name)).toEqual([
      'تفاصيل الأرصدة', 'ملخص المؤسسات', 'التعاريف والسياسة',
    ]);

    const details = wb.getWorksheet('تفاصيل الأرصدة')!;
    expect(details.views.some(v => v.rightToLeft === true)).toBe(true);
    const frozen = details.views.find(v => v.state === 'frozen') as ExcelJS.WorksheetViewFrozen | undefined;
    expect(frozen?.ySplit).toBe(4);

    const text: string[] = [];
    details.eachRow(r => r.eachCell(c => text.push(String(c.value ?? ''))));
    expect(text.join(' | ')).toContain(ARABIC_TEXT);
  });

  it('the details sheet\'s printArea and printTitlesRow survive serialization (the one capability unique to this module)', async () => {
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context());

    const buffer = await blobToBuffer(capture.get());
    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, buffer);
    const details = wb.getWorksheet('تفاصيل الأرصدة')!;

    expect(details.pageSetup.printTitlesRow).toBe('1:4');
    expect(details.pageSetup.printArea).toMatch(/^A1:Q\d+$/);
  });

  it('the details and summary sheets each carry their configured autoFilter after reopening', async () => {
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context());

    const buffer = await blobToBuffer(capture.get());
    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, buffer);
    expect(wb.getWorksheet('تفاصيل الأرصدة')!.autoFilter).toBeDefined();
    expect(wb.getWorksheet('ملخص المؤسسات')!.autoFilter).toBeDefined();
  });

  it('a zero-row search result still downloads a real workbook with all 3 sheets present (no crash, no empty/missing sheet)', async () => {
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context({
      result: { rows: [], totalRows: 0, truncated: false, searchedAt: '2026-06-01T12:00:00Z' },
    }));

    const buffer = await blobToBuffer(capture.get());
    expect([buffer[0], buffer[1], buffer[2], buffer[3]]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, buffer);
    expect(wb.worksheets.map(ws => ws.name)).toEqual([
      'تفاصيل الأرصدة', 'ملخص المؤسسات', 'التعاريف والسياسة',
    ]);
  });
});
