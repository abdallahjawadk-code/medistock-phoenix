/** @vitest-environment jsdom */
/**
 * E1-MRG-001 — merge hardening at the DOM level.
 *
 * The package's runtime tests use jsdom's small fallback viewport, so their
 * DOM counts never approach the ceiling. Here the viewport is forced to be
 * enormous and the grid is scrolled so the mounted window is exactly the hard
 * maximum (100 rows × 30 columns = GRID_MAX_RENDERED_CELLS coordinates). The
 * invariant is then checked where it matters:
 *
 *   gridcell DOM ≤ GRID_MAX_RENDERED_CELLS, with unique ids,
 *
 * under hostile merge geometry (duplicates, overlaps, blocks crossing the
 * window edge). It also checks the two disclosures (safety-limited merges and
 * merges outside the used area) and that nothing reaches a backend.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { emptyWorkbookTotals, type FileParseResult, type SheetEvidence } from '../../import/contract';

const { backendCalls } = vi.hoisted(() => ({ backendCalls: [] as string[] }));
vi.mock('@/shared/supabase/client', () => {
  const recorder = (path: string): unknown => new Proxy(function noop() {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : recorder(`${path}.${String(prop)}`)),
    apply: () => { backendCalls.push(path); return recorder(`${path}()`); },
  });
  return { supabase: recorder('supabase') };
});

const { ExcelWorkbookViewer } = await import('../ExcelWorkbookViewer');
const {
  GRID_COL_WIDTH, GRID_MAX_RENDERED_CELLS, GRID_ROW_HEIGHT, MERGE_PROCESS_LIMIT, a1Address, columnLetters: L,
} = await import('../excelViewerModel');

function fileWith(sheet: SheetEvidence): FileParseResult {
  return {
    outcome: 'accepted',
    identity: { contractVersion: '1.1.0', sheetjsVersion: '0.20.3', sheetjsTarballSha256: 'x', runtime: 'browser_worker' },
    input: { originalFilename: 'hostile.xlsx', sha256: 'c'.repeat(64), byteSize: 1 },
    workbook: { format: 'xlsx', sheets: [sheet], vbaPresent: false, totals: emptyWorkbookTotals() },
    family: null,
    diagnostics: [],
    sourceRecords: [],
  };
}

function sheetOf(mergedRanges: string[], rows = 10_000, cols = 256): SheetEvidence {
  return {
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
}

// Window at the hard maximum: rows 1000..1099, columns 100..129 (CW..DZ).
const WIN = { firstRow: 1_000, lastRow: 1_099, firstCol: 100, lastCol: 129 };

function renderAtMaximumWindow(sheet: SheetEvidence) {
  render(<div dir="rtl"><ExcelWorkbookViewer lang="ar" kind="file" result={fileWith(sheet)} /></div>);
  const grid = screen.getByTestId('cn2b-xl-grid');
  Object.defineProperty(grid, 'scrollTop', { configurable: true, value: (WIN.firstRow + 6) * GRID_ROW_HEIGHT });
  Object.defineProperty(grid, 'scrollLeft', { configurable: true, value: (WIN.firstCol + 2) * GRID_COL_WIDTH });
  fireEvent.scroll(grid);
  return grid;
}

const cellsOf = (grid: HTMLElement) => [...grid.querySelectorAll<HTMLElement>('[role="gridcell"]')];

beforeEach(() => {
  // An enormous viewport: the window is limited only by the hard ceilings.
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 100_000 });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 100_000 });
});

afterEach(() => {
  cleanup();
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientWidth;
  delete (HTMLElement.prototype as unknown as Record<string, unknown>).clientHeight;
  backendCalls.length = 0;
});

describe('E1-MRG-001 — DOM ceiling at the maximum window', () => {
  it('without merges the mounted window is exactly the ceiling (the test really reaches the limit)', () => {
    const grid = renderAtMaximumWindow(sheetOf([]));
    const cells = cellsOf(grid);
    expect(cells).toHaveLength(GRID_MAX_RENDERED_CELLS);
    expect(cells.some((el) => el.dataset.a1 === a1Address(WIN.firstRow, WIN.firstCol))).toBe(true);
    expect(cells.some((el) => el.dataset.a1 === a1Address(WIN.lastRow, WIN.lastCol))).toBe(true);
  }, 30_000);

  it('10 000 hostile merges (edge-crossing blocks, 1x1 tiles, duplicates, overlaps) never exceed it', () => {
    const ranges: string[] = [];
    // 30 blocks crossing the window's top edge (anchors outside the window).
    for (let c = WIN.firstCol; c <= WIN.lastCol; c += 1) ranges.push(`${L(c)}${WIN.firstRow - 9}:${L(c)}${WIN.firstRow + 1}`);
    // A 1x1 merge on every other window coordinate.
    for (let r = WIN.firstRow + 1; r <= WIN.lastRow; r += 1) {
      for (let c = WIN.firstCol; c <= WIN.lastCol; c += 1) ranges.push(`${L(c)}${r + 1}`);
    }
    // Fill to the intake ceiling with duplicates and overlaps of what is already there.
    let k = 0;
    while (ranges.length < MERGE_PROCESS_LIMIT) {
      const r = WIN.firstRow + (k % 100);
      const c = WIN.firstCol + (Math.floor(k / 100) % 30);
      ranges.push(k % 2 === 0 ? `${L(c)}${r + 1}` : `${L(c)}${r + 1}:${L(Math.min(c + 1, 255))}${r + 2}`);
      k += 1;
    }
    expect(ranges).toHaveLength(MERGE_PROCESS_LIMIT);

    const grid = renderAtMaximumWindow(sheetOf(ranges));
    const cells = cellsOf(grid);
    expect(cells.length).toBeGreaterThan(0);
    expect(cells.length).toBeLessThanOrEqual(GRID_MAX_RENDERED_CELLS);
    const ids = cells.map((el) => el.id);
    expect(new Set(ids).size).toBe(ids.length);
    const merged = cells.filter((el) => el.dataset.merged);
    expect(new Set(merged.map((el) => el.dataset.merged)).size).toBe(merged.length);
    // Every coordinate of the window is covered by exactly one displayed merge here.
    expect(cells.filter((el) => !el.dataset.merged)).toHaveLength(0);
    expect(screen.getByTestId('cn2b-xl-merge-safety-notice')).toHaveTextContent(String(MERGE_PROCESS_LIMIT));
    expect(backendCalls).toEqual([]);
  }, 30_000);

  it('10 000 overlapping full-sheet ranges: one block, bounded DOM, disclosed', () => {
    const ranges = Array.from({ length: 10_000 }, (_, i) => `A${i + 1}:${L(255)}10000`);
    const grid = renderAtMaximumWindow(sheetOf(ranges));
    const cells = cellsOf(grid);
    expect(cells).toHaveLength(1);
    expect(cells[0]).toHaveAttribute('data-merged', `A1:${L(255)}10000`);
    expect(screen.getByTestId('cn2b-xl-merge-safety-notice')).toHaveTextContent('9999');
  }, 30_000);
});

describe('E1-MRG-001 — nothing about merge evidence is silent', () => {
  it('merges outside the used area are disclosed separately', () => {
    render(<div dir="rtl"><ExcelWorkbookViewer lang="ar" kind="file" result={fileWith(sheetOf(['A1:B2', 'A50:B60', 'Z1:Z3'], 10, 5))} /></div>);
    const notice = screen.getByTestId('cn2b-xl-merge-outside-notice');
    expect(notice).toHaveTextContent('2');
    expect(notice).toHaveTextContent('خارج المنطقة المستخدمة');
    expect(screen.queryByTestId('cn2b-xl-merge-safety-notice')).toBeNull();
  });

  it('English copy states the same facts', () => {
    render(<div dir="ltr"><ExcelWorkbookViewer lang="en" kind="file" result={fileWith(sheetOf(['A50:B60'], 10, 5))} /></div>);
    expect(screen.getByTestId('cn2b-xl-merge-outside-notice')).toHaveTextContent('1 merged range(s) lie outside the used area');
  });

  it('a clean sheet shows neither notice', () => {
    render(<div dir="rtl"><ExcelWorkbookViewer lang="ar" kind="file" result={fileWith(sheetOf(['A1:B2', 'C3:D4'], 10, 5))} /></div>);
    expect(screen.queryByTestId('cn2b-xl-merge-safety-notice')).toBeNull();
    expect(screen.queryByTestId('cn2b-xl-merge-outside-notice')).toBeNull();
  });
});
