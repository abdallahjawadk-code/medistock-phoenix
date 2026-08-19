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

/**
 * G3.2 — the fixture now satisfies the explicit result contract.
 *
 * The added fields are given DELIBERATE, semantically valid values rather than
 * filler: this row is a Central Store warehouse row that carries a real
 * Migration 150 identity key, is therefore NOT isolated, and — being a central
 * store in a hospital rather than a health sector — has no facility and no
 * proven sector role. That combination is the one most likely to be misread
 * (`facilityId: null` + a real warehouse), so it is the right default to pin.
 */
function row(overrides: Partial<GlobalMaterialSearchRow> = {}): GlobalMaterialSearchRow {
  return {
    key: 'k1', organizationId: 'org-1', organizationName: 'Al-Sadiq Hospital',
    organizationNameAr: ARABIC_TEXT, scopeKind: 'warehouse', scopeId: 'wh-1',
    scopeName: 'Central Store', scopeNameAr: 'المذخر المركزي',
    // No facility association, and NOT a sector main: this is a hospital's
    // central store, so nothing proves a health-sector role (DECISION D).
    facilityId: null, sectorRole: 'unclassified',
    // A real generated key from the stock row, so this group aggregated
    // canonically rather than standing alone (DECISION C).
    materialIdentityKey: 'material:v1|central=ci-1|scientific=paracetamol',
    isolated: false,
    // Backed by real `warehouse_stock` rows, which is what makes the quantities
    // below stock truth rather than an alert's observed snapshot.
    stockBacked: true, alertCount: 0,
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
    result: {
      rows: [row()], totalRows: 1, truncated: false,
      // The ordinary case: every source query returned inside its cap, so the
      // exported totals are the real totals.
      sourceTruncated: false,
      searchedAt: '2026-06-01T12:00:00Z',
    },
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
      result: {
        rows: [], totalRows: 0, truncated: false, sourceTruncated: false,
        searchedAt: '2026-06-01T12:00:00Z',
      },
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

/**
 * G3.2 — the export against the new explicit result contract.
 *
 * The export layer itself was NOT changed by G3.2; what changed is the SHAPE of
 * the result it is handed. These cases pin that the new fields flow through
 * without disturbing the workbook, and — more importantly — that the two values
 * most easily misread (`isolated` and a null `facilityId`) are not silently
 * reinterpreted on the way out.
 */
describe('G3.2 — export against the canonical result contract', () => {
  /** Read every cell of the details sheet as text, for absence assertions. */
  async function detailsText(blob: Blob): Promise<string> {
    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, await blobToBuffer(blob));
    const sheet = wb.getWorksheet('تفاصيل الأرصدة')!;
    const out: string[] = [];
    sheet.eachRow(r => r.eachCell(cell => out.push(String(cell.value ?? ''))));
    return out.join('\n');
  }

  it('A — sourceTruncated=false preserves the ordinary complete export unchanged', async () => {
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context());

    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, await blobToBuffer(capture.get()));
    expect(wb.worksheets.map(ws => ws.name)).toEqual([
      'تفاصيل الأرصدة', 'ملخص المؤسسات', 'التعاريف والسياسة',
    ]);
    const text = await detailsText(capture.get());
    expect(text).toContain('Paracetamol');
    expect(text).toContain('90');
  });

  it('B — a source-truncated result still exports, and the workbook makes no completeness claim', async () => {
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context({
      result: {
        rows: [row()], totalRows: 1, truncated: false,
        sourceTruncated: true,
        searchedAt: '2026-06-01T12:00:00Z',
      },
    }));

    // It must not crash on the flag.
    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, await blobToBuffer(capture.get()));
    expect(wb.worksheets).toHaveLength(3);

    // KNOWN LIMITATION, asserted rather than assumed: the export contract
    // exposes no completeness metadata at all — it prints a result COUNT, and
    // has never printed a "complete"/"total" claim (it ignores the pre-existing
    // `truncated` flag too). So there is no completeness statement here for a
    // truncated source to falsify. Surfacing incompleteness IN THE WORKBOOK
    // would mean changing global-material-export.ts, which G3.2 did not
    // authorize; the operator sees the warning in the panel instead.
    const text = await detailsText(capture.get());
    for (const completenessClaim of ['مكتمل', 'الإجمالي الكامل', 'Complete', 'Full total']) {
      expect(text).not.toContain(completenessClaim);
    }
  });

  it('C — an isolated row exports as itself and never regains a name-based identity', async () => {
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context({
      result: {
        rows: [
          row({ key: 'iso-1', materialIdentityKey: null, isolated: true, onHand: 10, available: 10 }),
          row({ key: 'iso-2', materialIdentityKey: null, isolated: true, onHand: 5, available: 5 }),
        ],
        totalRows: 2, truncated: false, sourceTruncated: false,
        searchedAt: '2026-06-01T12:00:00Z',
      },
    }));

    const wb = new ExcelJS.Workbook();
    await loadWorkbook(wb, await blobToBuffer(capture.get()));
    const sheet = wb.getWorksheet('تفاصيل الأرصدة')!;

    // Two isolated rows sharing EVERY display value must stay two rows. The
    // export must not re-merge on the labels the service refused to merge on.
    const available: number[] = [];
    sheet.eachRow((r, index) => {
      if (index <= 4) return; // title + meta + spacer + header
      const value = r.getCell(12).value;
      if (typeof value === 'number') available.push(value);
    });
    expect(available).toEqual([10, 5]);
  });

  it('D — a NULL facilityId is never rendered as Sector Main without structural proof', async () => {
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context({
      result: {
        // facilityId null + sectorRole 'unclassified' — exactly the shape that
        // must NOT be read as the sector root (DECISION D).
        rows: [row({ facilityId: null, sectorRole: 'unclassified' })],
        totalRows: 1, truncated: false, sourceTruncated: false,
        searchedAt: '2026-06-01T12:00:00Z',
      },
    }));

    const text = await detailsText(capture.get());
    expect(text).not.toContain('المذخر الرئيسي للقطاع');
    expect(text).not.toContain('Sector Main');
  });

  it('D2 — even a PROVEN sector main is not asserted by the export, which carries no such column', async () => {
    // Stated so the absence above is understood as "this export has no sector
    // column", not as "sector main is suppressed". Either way, no row can gain
    // the label from a null.
    const capture = captureDownloadBlob();
    await exportGlobalMaterialSearchWorkbook(context({
      result: {
        rows: [row({ facilityId: null, sectorRole: 'sector_main' })],
        totalRows: 1, truncated: false, sourceTruncated: false,
        searchedAt: '2026-06-01T12:00:00Z',
      },
    }));
    const text = await detailsText(capture.get());
    expect(text).not.toContain('المذخر الرئيسي للقطاع');
  });
});
