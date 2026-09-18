/** @vitest-environment jsdom */
/**
 * E1 Excel-First — the read-only original workbook viewer, at runtime.
 *
 * Every workbook here goes through the REAL CN-2A parser (`parseWorkbookBytes`)
 * exactly once, and the viewer is handed that result — the same shape the
 * browser preview hands it in production. The parser module is wrapped in a
 * spy, so "switching sheets never re-parses" is observed, not assumed; the
 * Supabase client is replaced by a recorder, so "viewing never writes" is
 * observed too.
 *
 * Coverage map (E1 authorization §22):
 *   A name · B sheet order · C switch without re-parse · D Arabic text ·
 *   E zero / string / boolean / date / blank / missing · F A1 selection ·
 *   G raw value · H formula shown, not executed · I error cell ·
 *   J HTML/script literal · K no link navigation · L hidden sheets ·
 *   M merges without fabricated evidence · N bounded DOM · O read-only ·
 *   P RTL chrome with stable coordinates.
 */
import '@testing-library/jest-dom/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import type {
  ArchiveParseResult, CellEvidence, FileParseResult, SheetEvidence,
} from '../../import/contract';

const { backendCalls, workerConstructed } = vi.hoisted(() => ({
  backendCalls: [] as string[],
  workerConstructed: { count: 0 },
}));

/** Any use of the Supabase client — rpc, from, storage, auth — is recorded. */
vi.mock('@/shared/supabase/client', () => {
  const recorder = (path: string): unknown => new Proxy(function noop() {}, {
    get: (_target, prop) => (prop === 'then' ? undefined : recorder(`${path}.${String(prop)}`)),
    apply: () => {
      backendCalls.push(path);
      return recorder(`${path}()`);
    },
  });
  return { supabase: recorder('supabase') };
});

vi.mock('../../import/parser-core', async () => {
  const actual = await vi.importActual<typeof import('../../import/parser-core')>('../../import/parser-core');
  return { ...actual, parseWorkbookBytes: vi.fn(actual.parseWorkbookBytes) };
});

const { parseWorkbookBytes } = await import('../../import/parser-core');
const { parseArchiveBytes } = await import('../../import/archive-core');
const { nodeInflate } = await import('../../import/node-inflate');
const { ExcelWorkbookViewer } = await import('../ExcelWorkbookViewer');
const { CentralNeedsSimpleWorkspace } = await import('../../simple/CentralNeedsSimpleWorkspace');
const { GRID_MAX_RENDERED_CELLS, MERGE_PROCESS_LIMIT, a1Address } = await import('../excelViewerModel');

class WorkerSpy {
  constructor() { workerConstructed.count += 1; }
  postMessage() {}
  terminate() {}
}
vi.stubGlobal('Worker', WorkerSpy);

const FIXTURE_NAME = 'احتياج 2026.xlsx';

/**
 * One workbook carrying every case the viewer must present faithfully.
 * Sheet 1 "المجرد" (A1:D8):
 *   row 1  Arabic headers
 *   row 2  string / mixed Arabic-English / number 120
 *   row 3  numeric ZERO in D3
 *   row 4  boolean A4, date B4, EXPLICIT BLANK C4 (comment-anchored stub), D4 MISSING
 *   row 5  <script>, <img onerror>, javascript: and https: text
 *   row 6  formula "1+1" whose SAVED result is 5, #DIV/0! error, comment, 50%
 *   row 8  merge A8:C8 — anchor "مصرف الدم", plus a value Excel hides in B8
 * Sheet 2 "المقارنة" visible · Sheet 3 hidden · Sheet 4 very hidden.
 */
function buildFixtureBytes(): Uint8Array {
  const ws: XLSX.WorkSheet = {};
  const put = (a1: string, cell: XLSX.CellObject) => { ws[a1] = cell; };
  put('A1', { t: 's', v: 'الرمز' });
  put('B1', { t: 's', v: 'المادة' });
  put('C1', { t: 's', v: 'الوحدة' });
  put('D1', { t: 's', v: 'مرجان' });
  put('A2', { t: 's', v: 'X-001' });
  put('B2', { t: 's', v: 'Paracetamol 500 mg باراسيتامول' });
  put('C2', { t: 's', v: 'علبة' });
  put('D2', { t: 'n', v: 120 });
  put('A3', { t: 's', v: 'X-002' });
  put('B3', { t: 's', v: 'Total Protein' });
  put('C3', { t: 's', v: 'Box' });
  put('D3', { t: 'n', v: 0 });
  put('A4', { t: 'b', v: true });
  put('B4', { t: 'n', v: 46037, z: 'yyyy-mm-dd' });
  put('C4', { t: 'z', c: [{ a: 'reviewer', t: 'blank anchor' }] as XLSX.Comment[] });
  put('A5', { t: 's', v: '<script>window.__e1_xss = 1</script>' });
  put('B5', { t: 's', v: '<img src=x onerror="window.__e1_xss = 2">' });
  put('C5', { t: 's', v: 'javascript:window.__e1_xss = 3' });
  put('D5', { t: 's', v: 'https://example.invalid/steal' });
  put('A6', { t: 'n', v: 5, f: '1+1' });
  put('B6', { t: 'e', v: 0x07, w: '#DIV/0!', f: '1/0' });
  put('C6', { t: 's', v: 'Cardiac sump', c: [{ a: 'reviewer', t: 'note text' }] as XLSX.Comment[] });
  put('D6', { t: 'n', v: 0.5, z: '0%' });
  put('A8', { t: 's', v: 'مصرف الدم' });
  put('B8', { t: 's', v: 'hidden-in-merge' });
  ws['!merges'] = [{ s: { r: 7, c: 0 }, e: { r: 7, c: 2 } }];
  ws['!ref'] = 'A1:D8';

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'المجرد');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['قسطرة', 42]]), 'المقارنة');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['secret']]), 'مخفية');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['very secret']]), 'مخفية بالكامل');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }, { Hidden: 2 }] };
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

let fixture: FileParseResult;

beforeAll(async () => {
  fixture = await parseWorkbookBytes(buildFixtureBytes(), FIXTURE_NAME, { runtime: 'browser_worker', now: () => '2026-09-18T00:00:00.000Z' });
  expect(fixture.outcome).toBe('accepted');
  expect(vi.mocked(parseWorkbookBytes)).toHaveBeenCalledTimes(1);
});

afterEach(() => {
  cleanup();
  backendCalls.length = 0;
  workerConstructed.count = 0;
  delete (window as unknown as Record<string, unknown>).__e1_xss;
});

function renderViewer(result: FileParseResult | ArchiveParseResult, kind: 'file' | 'archive' = 'file', lang: 'ar' | 'en' = 'ar') {
  return render(
    <div dir={lang === 'ar' ? 'rtl' : 'ltr'} data-testid="host">
      <ExcelWorkbookViewer lang={lang} kind={kind} result={result} />
    </div>,
  );
}

const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);
const inspector = () => screen.getByTestId('cn2b-xl-inspector');
const tabs = () => within(screen.getByTestId('cn2b-xl-tabs')).getAllByRole('tab');
const cellEvidence = (sheet: SheetEvidence, a1: string): CellEvidence | undefined =>
  sheet.cells.find((c) => c.coordinate.a1 === a1);

describe('A/B — identity and sheet order', () => {
  it('A · shows the workbook name and a read-only badge', () => {
    renderViewer(fixture);
    expect(screen.getByTestId('cn2b-xl-filename')).toHaveTextContent(FIXTURE_NAME);
    expect(screen.getByTestId('cn2b-xl-readonly')).toHaveTextContent('للقراءة فقط');
    expect(screen.getByRole('heading', { name: 'معاينة الملف الأصلي' })).toBeInTheDocument();
  });

  it('B · lists every sheet in the workbook\'s own order, hidden ones included', () => {
    renderViewer(fixture);
    const names = tabs().map((t) => t.querySelector('.cn2b-xl-tab__name')?.textContent);
    expect(names).toEqual(fixture.workbook!.sheets.map((s) => s.name));
    expect(names).toEqual(['المجرد', 'المقارنة', 'مخفية', 'مخفية بالكامل']);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
  });
});

describe('C — switching sheets never re-parses', () => {
  it('shows the other sheet from the same evidence, with no parser call and no Worker', () => {
    const callsBefore = vi.mocked(parseWorkbookBytes).mock.calls.length;
    renderViewer(fixture);
    expect(gridCell('A1')).toHaveTextContent('الرمز');
    fireEvent.click(tabs()[1]);
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(gridCell('A1')).toHaveTextContent('قسطرة');
    expect(gridCell('B1')).toHaveTextContent('42');
    fireEvent.click(tabs()[0]);
    expect(gridCell('A1')).toHaveTextContent('الرمز');
    expect(vi.mocked(parseWorkbookBytes).mock.calls.length).toBe(callsBefore);
    expect(workerConstructed.count).toBe(0);
  });

  it('supports the tabs keyboard pattern in RTL (ArrowLeft is "next")', () => {
    renderViewer(fixture);
    fireEvent.keyDown(tabs()[0], { key: 'ArrowLeft' });
    expect(tabs()[1]).toHaveAttribute('aria-selected', 'true');
    expect(tabs()[1]).toHaveFocus();
    fireEvent.keyDown(tabs()[1], { key: 'End' });
    expect(tabs()[3]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(tabs()[3], { key: 'Home' });
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
  });
});

describe('D/E — values are presented without collapsing their evidence', () => {
  it('D · renders Arabic and mixed text as plain text with automatic direction', () => {
    renderViewer(fixture);
    const header = gridCell('A1')!;
    expect(header).toHaveTextContent('الرمز');
    expect(header.querySelector('.cn2b-xl-cell__text')).toHaveAttribute('dir', 'auto');
    expect(gridCell('B2')).toHaveTextContent('Paracetamol 500 mg باراسيتامول');
    expect(gridCell('A8')).toHaveTextContent('مصرف الدم');
  });

  it('E · zero, string, boolean, date, explicit blank and missing all stay distinct', () => {
    renderViewer(fixture);
    const sheet = fixture.workbook!.sheets[0];

    const zero = gridCell('D3')!;
    expect(zero).toHaveTextContent('0');
    expect(zero).toHaveAttribute('data-presence', 'value');
    expect(zero).toHaveAttribute('data-value-type', 'number');

    expect(gridCell('A2')).toHaveAttribute('data-value-type', 'string');
    expect(gridCell('A4')).toHaveTextContent('TRUE');
    expect(gridCell('A4')).toHaveAttribute('data-value-type', 'boolean');
    expect(gridCell('B4')).toHaveTextContent('2026-01-15');
    expect(gridCell('B4')).toHaveAttribute('data-value-type', 'date');

    const blank = gridCell('C4')!;
    expect(blank).toHaveAttribute('data-presence', 'blank');
    expect(blank.textContent).toBe('');
    expect(cellEvidence(sheet, 'C4')?.presence).toBe('blank');

    const missing = gridCell('D4')!;
    expect(missing).toHaveAttribute('data-presence', 'missing');
    expect(missing.textContent).toBe('');
    // Missing stays absent in the evidence: the viewer drew a slot, it did not create a cell.
    expect(cellEvidence(sheet, 'D4')).toBeUndefined();

    fireEvent.click(zero);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-presence')).toHaveTextContent('تحتوي على قيمة');
    fireEvent.click(blank);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-presence')).toHaveTextContent('خلية موجودة بلا قيمة');
    fireEvent.click(missing);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-presence')).toHaveTextContent('لا توجد خلية في الملف');
    expect(within(inspector()).getByTestId('cn2b-xl-audit-record')).toHaveTextContent('D4: null');
  });
});

describe('F/G/H/I — the cell inspector shows exact provenance and raw evidence', () => {
  it('F/G · selecting a cell exposes its exact A1 coordinate and its raw value', () => {
    renderViewer(fixture);
    expect(within(inspector()).getByText('اختر خلية لعرض تفاصيلها.')).toBeInTheDocument();
    fireEvent.click(gridCell('D2')!);
    expect(gridCell('D2')).toHaveAttribute('aria-selected', 'true');
    expect(inspector()).toHaveAttribute('data-a1', 'D2');
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-a1')).toHaveTextContent('D2');
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-raw')).toHaveTextContent('120');
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-type')).toHaveTextContent('رقم');
  });

  it('G · the grid may show Excel formatting, the inspector always shows the raw value beside it', () => {
    renderViewer(fixture);
    expect(gridCell('D6')).toHaveTextContent('50%');
    fireEvent.click(gridCell('D6')!);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-raw')).toHaveTextContent('0.5');
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-formatted')).toHaveTextContent('50%');
  });

  it('H · a formula is shown as text with the value the FILE saved — never recalculated', () => {
    renderViewer(fixture);
    // "1+1" would evaluate to 2; the file saved 5, and 5 is what is shown.
    expect(gridCell('A6')).toHaveTextContent('5');
    expect(gridCell('A6')).not.toHaveTextContent('2');
    expect(gridCell('A6')).toHaveAttribute('data-formula', 'true');
    fireEvent.click(gridCell('A6')!);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-formula')).toHaveTextContent('1+1');
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-formula')).toHaveTextContent('لا يُحتسب');
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-raw')).toHaveTextContent('5');
  });

  it('I · an error cell shows its error code safely', () => {
    renderViewer(fixture);
    expect(gridCell('B6')).toHaveTextContent('#DIV/0!');
    expect(gridCell('B6')).toHaveAttribute('data-value-type', 'error');
    fireEvent.click(gridCell('B6')!);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-error')).toHaveTextContent('#DIV/0!');
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-formula')).toHaveTextContent('1/0');
  });

  it('shows a comment, and keeps parser vocabulary inside the collapsed audit section', () => {
    renderViewer(fixture);
    expect(gridCell('C6')).toHaveAttribute('data-comment', 'true');
    fireEvent.click(gridCell('C6')!);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-comment')).toHaveTextContent('note text');
    const audit = within(inspector()).getByTestId('cn2b-xl-audit');
    expect(audit.tagName).toBe('DETAILS');
    expect(audit).not.toHaveAttribute('open');
    expect(within(audit).getByTestId('cn2b-xl-audit-sha')).toHaveTextContent(fixture.input.sha256);
    // Outside the audit section, no parser/developer vocabulary is shown.
    const visible = [...inspector().childNodes].filter((n) => n !== audit).map((n) => n.textContent ?? '').join(' ');
    for (const term of ['Evidence', 'parser', 'rawValue', 'SourceRecord', 'presence']) {
      expect(visible).not.toContain(term);
    }
  });
});

describe('J/K — untrusted cell content can never execute or navigate', () => {
  it('J · HTML and script text render literally and create no elements', () => {
    const { container } = renderViewer(fixture);
    expect(gridCell('A5')).toHaveTextContent('<script>window.__e1_xss = 1</script>');
    expect(gridCell('B5')).toHaveTextContent('<img src=x onerror="window.__e1_xss = 2">');
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('iframe')).toBeNull();
    fireEvent.click(gridCell('A5')!);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-raw')).toHaveTextContent('<script>');
    expect(container.querySelector('script')).toBeNull();
    expect((window as unknown as Record<string, unknown>).__e1_xss).toBeUndefined();
  });

  it('K · link-looking text stays text: no anchor, no window.open, no navigation', () => {
    const open = vi.spyOn(window, 'open').mockImplementation(() => null);
    const before = window.location.href;
    const { container } = renderViewer(fixture);
    expect(container.querySelector('a')).toBeNull();
    expect(container.querySelector('[href]')).toBeNull();
    fireEvent.click(gridCell('C5')!);
    fireEvent.click(gridCell('D5')!);
    fireEvent.doubleClick(gridCell('D5')!);
    expect(open).not.toHaveBeenCalled();
    expect(window.location.href).toBe(before);
    expect((window as unknown as Record<string, unknown>).__e1_xss).toBeUndefined();
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-raw')).toHaveTextContent('https://example.invalid/steal');
    open.mockRestore();
  });
});

describe('L — hidden sheets are disclosed, never silently erased or unhidden', () => {
  it('labels hidden and very-hidden tabs and explains them when opened', () => {
    renderViewer(fixture);
    const [, , hidden, veryHidden] = tabs();
    expect(hidden).toHaveAttribute('data-visibility', 'hidden');
    expect(hidden).toHaveTextContent('ورقة مخفية');
    expect(veryHidden).toHaveAttribute('data-visibility', 'very_hidden');
    expect(veryHidden).toHaveTextContent('ورقة مخفية بالكامل');
    expect(screen.queryByTestId('cn2b-xl-hidden-notice')).toBeNull();

    fireEvent.click(hidden);
    expect(screen.getByTestId('cn2b-xl-hidden-notice')).toHaveTextContent('مخفية في الملف الأصلي');
    expect(gridCell('A1')).toHaveTextContent('secret');
    fireEvent.click(veryHidden);
    expect(screen.getByTestId('cn2b-xl-hidden-notice')).toHaveTextContent('مخفية بالكامل');
    // Viewing a hidden sheet does not change its recorded visibility.
    expect(fixture.workbook!.sheets.map((s) => s.hidden)).toEqual(['visible', 'visible', 'hidden', 'very_hidden']);
  });

  it('opens on the first visible sheet', () => {
    renderViewer(fixture);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
  });
});

describe('M — merged cells are presented once, with no fabricated evidence', () => {
  it('draws the merge as one block from its anchor and never repeats its value', () => {
    renderViewer(fixture);
    const block = gridCell('A8')!;
    expect(block).toHaveAttribute('data-merged', 'A8:C8');
    expect(block).toHaveAttribute('aria-colspan', '3');
    expect(block).toHaveTextContent('مصرف الدم');
    // Covered coordinates are not drawn as separate cells…
    expect(gridCell('B8')).toBeNull();
    expect(gridCell('C8')).toBeNull();
    // …and the anchor's value appears exactly once in the grid.
    const grid = screen.getByTestId('cn2b-xl-grid');
    expect(within(grid).getAllByText('مصرف الدم')).toHaveLength(1);
    // Evidence: C8 is still absent — nothing was copied into it.
    expect(cellEvidence(fixture.workbook!.sheets[0], 'C8')).toBeUndefined();
  });

  it('discloses a value Excel hides inside the merge instead of dropping it', () => {
    renderViewer(fixture);
    fireEvent.click(gridCell('A8')!);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-merged')).toHaveTextContent('A8:C8');
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-merged-hidden')).toHaveTextContent('B8: hidden-in-merge');
  });

  it('keyboard movement treats the merge as one stop', () => {
    renderViewer(fixture);
    const grid = screen.getByTestId('cn2b-xl-grid');
    fireEvent.click(gridCell('A7')!);
    fireEvent.keyDown(grid, { key: 'ArrowDown' });
    expect(inspector()).toHaveAttribute('data-a1', 'A8');
    expect(grid).toHaveAttribute('aria-activedescendant', gridCell('A8')!.id);
    fireEvent.keyDown(grid, { key: 'ArrowRight' });
    expect(inspector()).toHaveAttribute('data-a1', 'D8');
    fireEvent.keyDown(grid, { key: 'Home' });
    expect(inspector()).toHaveAttribute('data-a1', 'A8');
  });
});

describe('N — large sheets render a bounded window', () => {
  function largeResult(rows: number, cols: number): FileParseResult {
    const cells: CellEvidence[] = [];
    for (let r = 0; r < rows; r += 1) {
      for (let c = 0; c < cols; c += 1) {
        cells.push({
          coordinate: { row: r, col: c, a1: a1Address(r, c) },
          presence: 'value', valueType: 'number', rawValue: r * cols + c, isFormula: false, hasComment: false,
        });
      }
    }
    const sheet: SheetEvidence = {
      index: 0, name: 'كبير', hidden: 'visible',
      usedRange: { startRow: 0, endRow: rows - 1, startCol: 0, endCol: cols - 1 },
      nonEmptyCellCount: cells.length, cells, mergedRanges: [], duplicateHeaderGroups: [],
    };
    return { ...fixture, workbook: { ...fixture.workbook!, sheets: [sheet] } };
  }

  it('mounts only the visible window of a 10 000 x 40 sheet, before and after scrolling', () => {
    const big = largeResult(10_000, 40);
    renderViewer(big);
    const grid = screen.getByTestId('cn2b-xl-grid');
    const mounted = () => grid.querySelectorAll('[role="gridcell"]').length;
    expect(mounted()).toBeGreaterThan(0);
    expect(mounted()).toBeLessThanOrEqual(GRID_MAX_RENDERED_CELLS);
    expect(mounted()).toBeLessThan(500);
    expect(grid).toHaveAttribute('aria-rowcount', '10000');
    expect(gridCell('A1')).not.toBeNull();

    Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 5_000 * 28 });
    fireEvent.scroll(grid);
    expect(gridCell('A1')).toBeNull();
    expect(gridCell('A5001')).not.toBeNull();
    expect(gridCell('A5001')).toHaveTextContent(String(5_000 * 40));
    expect(mounted()).toBeLessThan(500);
  });

  it('never draws past the current sheet when a smaller sheet replaces a deeply scrolled one', () => {
    // Same fingerprint and sheet index, so the grid is NOT remounted: this
    // exercises the render-time clamp, not the remount.
    const big = largeResult(10_000, 40);
    const { rerender } = renderViewer(big);
    const grid = screen.getByTestId('cn2b-xl-grid');
    Object.defineProperty(grid, 'scrollTop', { configurable: true, value: 5_000 * 28 });
    fireEvent.scroll(grid);
    expect(gridCell('A5001')).not.toBeNull();
    // Record EVERY cell drawn during the swap — inserted, or kept and updated in
    // place (React reuses keyed nodes) — including any short-lived intermediate
    // commit that a later effect would have corrected.
    const observer = new MutationObserver(() => {});
    observer.observe(grid, { childList: true, subtree: true, attributes: true });
    rerender(
      <div dir="rtl" data-testid="host">
        <ExcelWorkbookViewer lang="ar" kind="file" result={fixture} />
      </div>,
    );
    const drawn: number[] = [];
    const rowOf = (el: HTMLElement) => Number(el.dataset.a1!.replace(/^[A-Z]+/, ''));
    for (const record of observer.takeRecords()) {
      if (record.type === 'attributes' && record.target instanceof HTMLElement
        && record.target.getAttribute('role') === 'gridcell') drawn.push(rowOf(record.target));
      for (const node of record.addedNodes) {
        if (!(node instanceof HTMLElement)) continue;
        const cells = [node, ...node.querySelectorAll<HTMLElement>('[role="gridcell"]')]
          .filter((el) => el.getAttribute('role') === 'gridcell');
        for (const el of cells) drawn.push(rowOf(el));
      }
    }
    observer.disconnect();
    expect(drawn.length).toBeGreaterThan(0);
    expect(Math.max(...drawn)).toBeLessThanOrEqual(8);
    const rows = [...screen.getByTestId('cn2b-xl-grid').querySelectorAll<HTMLElement>('[role="gridcell"]')]
      .map((el) => Number(el.dataset.a1!.replace(/^[A-Z]+/, '')));
    expect(Math.max(...rows)).toBeLessThanOrEqual(8);
    expect(gridCell('A5001')).toBeNull();
  });
});

describe('N2 — hostile merge geometry stays bounded and disclosed', () => {
  function hostileResult(mergedRanges: string[], rows = 100, cols = 30): FileParseResult {
    const sheet: SheetEvidence = {
      index: 0, name: 'دمج عدائي', hidden: 'visible',
      usedRange: { startRow: 0, endRow: rows - 1, startCol: 0, endCol: cols - 1 },
      nonEmptyCellCount: 1,
      cells: [{
        coordinate: { row: 0, col: 0, a1: 'A1' }, presence: 'value', valueType: 'string', rawValue: 'anchor',
        isFormula: false, hasComment: false,
      }],
      mergedRanges,
      duplicateHeaderGroups: [],
    };
    return { ...fixture, workbook: { ...fixture.workbook!, sheets: [sheet] } };
  }

  it('10,000 duplicate merges render once, keep unique DOM ids, and stay under the grid ceiling', () => {
    const hostile = hostileResult(Array.from({ length: MERGE_PROCESS_LIMIT }, () => 'A1:B2'));
    renderViewer(hostile);
    const grid = screen.getByTestId('cn2b-xl-grid');
    const cells = [...grid.querySelectorAll<HTMLElement>('[role="gridcell"]')];
    expect(cells.length).toBeLessThanOrEqual(GRID_MAX_RENDERED_CELLS);
    expect(cells.filter((el) => el.dataset.merged === 'A1:B2')).toHaveLength(1);
    const ids = cells.map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(screen.getByTestId('cn2b-xl-merge-safety-notice')).toHaveTextContent(String(MERGE_PROCESS_LIMIT - 1));
  });

  it('10,000 overlapping merges keep the first source range and render no overlapping blocks', () => {
    const ranges = Array.from({ length: MERGE_PROCESS_LIMIT }, (_, i) => `A1:A${i + 1}`);
    const hostile = hostileResult(ranges, 10_000, 2);
    renderViewer(hostile);
    const grid = screen.getByTestId('cn2b-xl-grid');
    const merges = [...grid.querySelectorAll<HTMLElement>('[role="gridcell"][data-merged]')];
    expect(merges).toHaveLength(1);
    expect(merges[0]).toHaveAttribute('data-merged', 'A1:A1');
    expect(grid.querySelectorAll('[role="gridcell"]').length).toBeLessThanOrEqual(GRID_MAX_RENDERED_CELLS);
  });

  it('a merge beyond the intake ceiling is disclosed instead of silently treated as rendered evidence', () => {
    const ranges = Array.from({ length: MERGE_PROCESS_LIMIT + 3 }, (_, i) => `A${i + 1}:B${i + 1}`);
    const hostile = hostileResult(ranges, MERGE_PROCESS_LIMIT + 3, 2);
    renderViewer(hostile);
    expect(screen.getByTestId('cn2b-xl-merge-safety-notice')).toHaveTextContent('3');
    expect(screen.getByTestId('cn2b-xl-merge-safety-notice')).toHaveTextContent(String(MERGE_PROCESS_LIMIT + 3));
  });

  it('a huge merge bounds inspector work and discloses that its hidden-value total is not estimated', () => {
    const count = 4_200;
    const cells: CellEvidence[] = Array.from({ length: count }, (_, i) => ({
      coordinate: { row: i, col: 0, a1: `A${i + 1}` },
      presence: 'value', valueType: 'number', rawValue: i, isFormula: false, hasComment: false,
    }));
    const sheet: SheetEvidence = {
      index: 0, name: 'دمج ضخم', hidden: 'visible',
      usedRange: { startRow: 0, endRow: count - 1, startCol: 0, endCol: 0 },
      nonEmptyCellCount: cells.length, cells, mergedRanges: [`A1:A${count}`], duplicateHeaderGroups: [],
    };
    renderViewer({ ...fixture, workbook: { ...fixture.workbook!, sheets: [sheet] } });
    fireEvent.click(gridCell('A1')!);
    const limited = within(inspector()).getByTestId('cn2b-xl-inspect-merged-limited');
    expect(limited).toHaveTextContent('4096');
    expect(limited).toHaveTextContent('قد توجد قيم أخرى');
    expect(within(inspector()).queryByTestId('cn2b-xl-inspect-merged-hidden')).toBeNull();
  });
});

describe('O — the viewer is read-only and has no write path', () => {
  it('offers no editable control over worksheet values', () => {
    const { container } = renderViewer(fixture);
    const viewer = screen.getByTestId('cn2b-xl-viewer');
    expect(viewer.querySelector('input, textarea')).toBeNull();
    expect(viewer.querySelector('[contenteditable]')).toBeNull();
    expect(viewer.querySelector('select')).toBeNull();
    expect(screen.getByTestId('cn2b-xl-grid')).toHaveAttribute('aria-readonly', 'true');
    for (const el of container.querySelectorAll<HTMLElement>('[role="gridcell"]')) {
      expect(el).not.toHaveAttribute('contenteditable');
      expect(el.tagName).toBe('DIV');
    }
  });

  it('selecting, navigating and switching sheets never reaches a backend, fetch or Worker', () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const snapshot = structuredClone(fixture);
    renderViewer(fixture);
    const grid = screen.getByTestId('cn2b-xl-grid');
    for (const a1 of ['A1', 'D2', 'D3', 'C4', 'D4', 'A6', 'B6', 'A8']) fireEvent.click(gridCell(a1)!);
    for (const key of ['ArrowDown', 'ArrowRight', 'ArrowUp', 'ArrowLeft', 'PageDown', 'End', 'Home']) {
      fireEvent.keyDown(grid, { key });
    }
    for (const tab of tabs()) fireEvent.click(tab);
    expect(backendCalls).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(workerConstructed.count).toBe(0);
    // CELL_EVIDENCE_MUTATION = 0: the evidence is byte-for-byte what the parser returned.
    expect(fixture).toEqual(snapshot);
    vi.unstubAllGlobals();
    vi.stubGlobal('Worker', WorkerSpy);
  });
});

describe('P — RTL chrome, stable spreadsheet coordinates', () => {
  it('inherits the page direction while the grid keeps A, B, C… left to right', () => {
    renderViewer(fixture, 'file', 'ar');
    const viewer = screen.getByTestId('cn2b-xl-viewer');
    expect(viewer).not.toHaveAttribute('dir');
    expect(screen.getByTestId('host')).toHaveAttribute('dir', 'rtl');
    const grid = screen.getByTestId('cn2b-xl-grid');
    expect(grid).toHaveAttribute('dir', 'ltr');
    const letters = within(grid).getAllByTestId('cn2b-xl-colhead').map((h) => h.textContent);
    expect(letters.slice(0, 4)).toEqual(['A', 'B', 'C', 'D']);
    // A1 is the Arabic header cell, not a mirrored coordinate.
    expect(gridCell('A1')).toHaveTextContent('الرمز');
    expect(gridCell('D1')).toHaveTextContent('مرجان');
  });

  it('renders the same coordinates in English', () => {
    renderViewer(fixture, 'file', 'en');
    expect(screen.getByTestId('cn2b-xl-readonly')).toHaveTextContent('Read-only');
    expect(gridCell('A1')).toHaveTextContent('الرمز');
    fireEvent.click(gridCell('D2')!);
    expect(within(inspector()).getByTestId('cn2b-xl-inspect-a1')).toHaveTextContent('D2');
  });
});

describe('ZIP previews — choosing among already-parsed workbooks', () => {
  it('lists every entry, labels an unreadable one, and switches without re-parsing', async () => {
    const rejected = await parseWorkbookBytes(new Uint8Array([0x00, 0xff, 0x00, 0xfe]), 'broken.xls',
      { runtime: 'browser_worker' }, 'احتياج 2026/broken.xls');
    expect(rejected.outcome).toBe('rejected');
    const accepted: FileParseResult = { ...fixture, input: { ...fixture.input, archiveEntryPath: 'احتياج 2026/مرجان.xlsx' } };
    const archive: ArchiveParseResult = {
      identity: fixture.identity,
      archive: { originalFilename: 'احتياج 2026.zip', sha256: 'b'.repeat(64), byteSize: 1 },
      entries: [rejected, accepted],
      excludedEntries: [],
      diagnostics: [],
      reconciliation: {
        filesTotal: 2, filesAccepted: 1, filesRejected: 1, filesExcluded: 0,
        aggregateTotals: fixture.workbook!.totals,
      },
    };
    const callsBefore = vi.mocked(parseWorkbookBytes).mock.calls.length;
    renderViewer(archive, 'archive');
    expect(screen.getByTestId('cn2b-xl-filename')).toHaveTextContent('احتياج 2026.zip');
    const select = screen.getByTestId('cn2b-xl-workbook-select') as HTMLSelectElement;
    const options = [...select.options].map((o) => o.textContent);
    expect(options).toEqual(['احتياج 2026/broken.xls — تعذّرت قراءته', 'احتياج 2026/مرجان.xlsx']);
    // Opens on the first READABLE entry.
    expect(select.value).toBe('1');
    expect(gridCell('A1')).toHaveTextContent('الرمز');

    fireEvent.change(select, { target: { value: '0' } });
    expect(screen.getByTestId('cn2b-xl-unreadable')).toBeInTheDocument();
    expect(screen.queryByTestId('cn2b-xl-grid')).toBeNull();
    fireEvent.change(select, { target: { value: '1' } });
    expect(gridCell('D2')).toHaveTextContent('120');
    expect(vi.mocked(parseWorkbookBytes).mock.calls.length).toBe(callsBefore);
  });

  it('renders a real archive parse result (the parser\'s own synthetic ZIP fixture)', async () => {
    const zip = new Uint8Array(readFileSync(join(__dirname, '../../import/__tests__/fixtures/synthetic-archive.zip')));
    const result = await parseArchiveBytes(zip, 'synthetic-archive.zip', { runtime: 'node', inflate: nodeInflate });
    renderViewer(result, 'archive');
    const select = screen.getByTestId('cn2b-xl-workbook-select') as HTMLSelectElement;
    expect(select.options).toHaveLength(result.entries.length);
    const firstReadable = result.entries.findIndex((e) => e.workbook !== null);
    expect(firstReadable).toBeGreaterThanOrEqual(0);
    const firstSheet = result.entries[firstReadable].workbook!.sheets[0];
    const firstCell = firstSheet.cells.find((c) => c.presence === 'value');
    expect(firstCell).toBeDefined();
    expect(gridCell(firstCell!.coordinate.a1)).not.toBeNull();
  });
});

describe('Simple Mode integration — the viewer is fed the existing preview result', () => {
  type WorkspaceProps = Parameters<typeof CentralNeedsSimpleWorkspace>[0];

  function workspaceProps(over: Partial<WorkspaceProps> = {}): WorkspaceProps {
    return {
      lang: 'ar', planYear: 2026, onPlanYearChange: () => {}, revisionsLoading: false,
      revision: { id: 'rev-1', planId: 'plan-1', organizationId: 'org-1', planYear: 2026, revisionNumber: 1, status: 'draft' },
      isDraft: true, revisionDataReady: true, canImport: true, canEdit: true, busy: false, activity: null,
      onOpenRevision: () => {}, preview: { phase: 'idle' }, pendingFile: null, onPickFile: () => {}, onVerify: () => {},
      error: null, notice: null, readiness: null, beneficiaryColumns: [], careInstitutions: [], records: [],
      dispositions: [], activeSessionId: null, onChanged: () => {}, onSwitchToAdvanced: () => {},
      ...over,
    };
  }

  it('appears in the upload step once the preview is ready, and only then', () => {
    const callsBefore = vi.mocked(parseWorkbookBytes).mock.calls.length;
    const file = new File([new Uint8Array([1])], FIXTURE_NAME);
    const { rerender } = render(<CentralNeedsSimpleWorkspace {...workspaceProps()} />);
    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();

    rerender(<CentralNeedsSimpleWorkspace {...workspaceProps({ pendingFile: file })} />);
    expect(screen.queryByTestId('cn2b-xl-viewer')).toBeNull();

    const ready = { phase: 'ready' as const, filename: FIXTURE_NAME, outcome: { kind: 'file' as const, result: fixture, json: '{}' } };
    rerender(<CentralNeedsSimpleWorkspace {...workspaceProps({ pendingFile: file, preview: ready })} />);
    const upload = screen.getByTestId('cn2b-simple-upload');
    expect(within(upload).getByTestId('cn2b-xl-viewer')).toBeInTheDocument();
    // The existing upload action is still there, untouched by the viewer.
    expect(within(upload).getByTestId('cn2b-simple-upload-submit')).toBeEnabled();

    fireEvent.click(gridCell('D2')!);
    fireEvent.click(tabs()[1]);
    expect(backendCalls).toEqual([]);
    expect(workerConstructed.count).toBe(0);
    expect(vi.mocked(parseWorkbookBytes).mock.calls.length).toBe(callsBefore);
  });

  it('a newly previewed file replaces the previous view instead of keeping a stale sheet or selection', async () => {
    const file = new File([new Uint8Array([1])], FIXTURE_NAME);
    const ready = (result: FileParseResult) =>
      ({ phase: 'ready' as const, filename: result.input.originalFilename, outcome: { kind: 'file' as const, result, json: '{}' } });
    const { rerender } = render(<CentralNeedsSimpleWorkspace {...workspaceProps({ pendingFile: file, preview: ready(fixture) })} />);
    fireEvent.click(tabs()[1]);
    fireEvent.click(gridCell('B1')!);

    const second = await parseWorkbookBytes(
      new Uint8Array(XLSX.write((() => {
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['second-file']]), 'Only');
        return wb;
      })(), { type: 'array', bookType: 'xlsx' })),
      'second.xlsx', { runtime: 'browser_worker' },
    );
    await act(async () => {
      rerender(<CentralNeedsSimpleWorkspace {...workspaceProps({ pendingFile: file, preview: ready(second) })} />);
    });
    expect(tabs()).toHaveLength(1);
    expect(tabs()[0]).toHaveAttribute('aria-selected', 'true');
    expect(gridCell('A1')).toHaveTextContent('second-file');
    expect(within(inspector()).getByText('اختر خلية لعرض تفاصيلها.')).toBeInTheDocument();
  });
});
