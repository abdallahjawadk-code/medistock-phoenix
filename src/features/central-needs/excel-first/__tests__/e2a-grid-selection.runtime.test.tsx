/** @vitest-environment jsdom */
/**
 * E2-A.3 / E2-A.4 — human physical selection in the read-only viewer, at runtime.
 *
 * Every workbook here is REAL CN-2A parser output. The viewer is given trusted
 * identities directly (as the stored-source panel does after the bridge), and
 * `onChange` is observed. Proven here: cell, column and range selection by
 * pointer and keyboard; exact physical coordinates and source identity; hidden
 * and very hidden sheets; merged regions resolved without fabricating
 * evidence; selection cleared by every change of context; the E1 grid left
 * exactly as it was when no identity is available; nothing persisted and no
 * backend touched.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import * as XLSX from 'xlsx';
import type { ArchiveParseResult, FileParseResult } from '../../import/contract';
import type { WorkbookSelection, WorkbookSourceIdentity } from '../workbookSelection';

const { backendCalls } = vi.hoisted(() => ({ backendCalls: [] as string[] }));

/** Any use of the Supabase client is recorded — the viewer must never reach it. */
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

const { parseWorkbookBytes } = await import('../../import/parser-core');
const { ExcelWorkbookViewer } = await import('../ExcelWorkbookViewer');

/**
 * Sheet 0 "المجرد" (visible)  A1:D6 — headers, values, a merge A5:C5 whose
 *                              anchor holds a value and whose covered B5 holds
 *                              another (hidden) value; D5 is left MISSING.
 * Sheet 1 "ثانية" (visible) · Sheet 2 "مخفية" (hidden) · Sheet 3 "مخفية بالكامل" (very hidden).
 */
function fixtureBytes(label = 'X-001'): Uint8Array {
  const ws = XLSX.utils.aoa_to_sheet([
    ['الرمز', 'المادة', 'الوحدة', 'الكمية'],
    [label, 'Paracetamol 500 mg', 'علبة', 120],
    ['X-002', 'Total Protein', 'Box', 0],
    ['X-003', 'قسطرة', 'قطعة', 7],
    ['مصرف الدم', 'hidden-in-merge', null, null],
    ['X-004', 'last', 'Box', 3],
  ]);
  delete ws.C5;
  delete ws.D5;
  ws['!merges'] = [{ s: { r: 4, c: 0 }, e: { r: 4, c: 2 } }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'المجرد');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['ثانية', 1], ['x', 2]]), 'ثانية');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['secret', 1], ['s2', 2]]), 'مخفية');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['very', 1], ['v2', 2]]), 'مخفية بالكامل');
  wb.Workbook = { Sheets: [{ Hidden: 0 }, { Hidden: 0 }, { Hidden: 1 }, { Hidden: 2 }] };
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

let file: FileParseResult;
let second: FileParseResult;
let archive: ArchiveParseResult;
let FILE_ID: WorkbookSourceIdentity;
let ZIP_IDS: WorkbookSourceIdentity[];

beforeAll(async () => {
  file = await parseWorkbookBytes(fixtureBytes(), 'احتياج 2027.xlsx', { runtime: 'node' });
  expect(file.outcome).toBe('accepted');
  const a = await parseWorkbookBytes(fixtureBytes('A-1'), 'a.xlsx', { runtime: 'node' }, 'needs/a.xlsx');
  second = await parseWorkbookBytes(fixtureBytes('B-1'), 'b.xlsx', { runtime: 'node' }, 'needs/b.xlsx');
  archive = {
    identity: file.identity,
    archive: { originalFilename: 'احتياج 2027.zip', sha256: 'c'.repeat(64), byteSize: 1 },
    entries: [a, second],
    excludedEntries: [],
    diagnostics: [],
    reconciliation: { filesTotal: 2, filesAccepted: 2, filesRejected: 0, filesExcluded: 0, aggregateTotals: file.workbook!.totals },
  };
  FILE_ID = {
    batchId: 'batch-1', entryId: 'entry-1', entryOrdinal: 1, entrySha256: file.input.sha256,
    importSessionId: 'session-file', workbookIndex: 0,
  };
  ZIP_IDS = [
    { batchId: 'batch-z', entryId: 'entry-a', entryOrdinal: 1, entrySha256: a.input.sha256, importSessionId: 'session-A', workbookIndex: 0 },
    { batchId: 'batch-z', entryId: 'entry-b', entryOrdinal: 2, entrySha256: second.input.sha256, importSessionId: 'session-B', workbookIndex: 1 },
  ];
});

afterEach(() => {
  cleanup();
  backendCalls.length = 0;
});

const gridCell = (a1: string) => document.querySelector<HTMLElement>(`[role="gridcell"][data-a1="${a1}"]`);
const grid = () => screen.getByTestId('cn2b-xl-grid');
const colButton = (letters: string) =>
  within(grid()).getAllByTestId('cn2b-xl-colbutton').find((b) => b.textContent === letters)!;
const tabs = () => within(screen.getByTestId('cn2b-xl-tabs')).getAllByRole('tab');

function renderTrusted(identities: WorkbookSourceIdentity[] = [FILE_ID], result: FileParseResult | ArchiveParseResult = file,
  kind: 'file' | 'archive' = 'file') {
  const onChange = vi.fn<(selection: WorkbookSelection | null) => void>();
  const view = render(<ExcelWorkbookViewer lang="ar" kind={kind} result={result} selection={{ identities, onChange }} />);
  const last = () => onChange.mock.calls.at(-1)?.[0] ?? null;
  return { ...view, onChange, last };
}

describe('1 · CELL selection', () => {
  it('a click selects one cell: exact sheet, 0-based row/column, A1 and source identity', () => {
    const { onChange, last } = renderTrusted();
    expect(onChange).toHaveBeenCalledWith(null);
    fireEvent.click(gridCell('C2')!);
    expect(last()).toEqual({
      kind: 'cell', source: FILE_ID, sheetIndex: 0, sheetName: 'المجرد', rowIndex: 1, columnIndex: 2, a1: 'C2', mergedRange: null,
    });
    expect(gridCell('C2')).toHaveAttribute('aria-selected', 'true');
    expect(gridCell('C2')).toHaveAttribute('data-in-selection', 'true');
    expect(gridCell('D2')).toHaveAttribute('aria-selected', 'false');
    // The E1 inspector still follows the same cell.
    expect(screen.getByTestId('cn2b-xl-inspector')).toHaveAttribute('data-a1', 'C2');
  });
});

describe('2 · COLUMN selection', () => {
  it('a column header is a button; clicking it selects that physical column — no role, just the column', () => {
    const { last } = renderTrusted();
    fireEvent.click(colButton('D'));
    expect(last()).toEqual({ kind: 'column', source: FILE_ID, sheetIndex: 0, sheetName: 'المجرد', columnIndex: 3 });
    expect(Object.keys(last()!).sort()).toEqual(['columnIndex', 'kind', 'sheetIndex', 'sheetName', 'source']);
    expect(colButton('D')).toHaveAttribute('aria-pressed', 'true');
    expect(colButton('C')).toHaveAttribute('aria-pressed', 'false');
    for (const a1 of ['D1', 'D2', 'D3', 'D4', 'D6']) expect(gridCell(a1)).toHaveAttribute('data-in-selection', 'true');
    expect(gridCell('C2')).toHaveAttribute('data-in-selection', 'false');
  });
});

describe('3 · RANGE selection', () => {
  it('Shift+click extends from the anchor to a normalized forward rectangle', () => {
    const { last } = renderTrusted();
    fireEvent.click(gridCell('B2')!);
    fireEvent.click(gridCell('D4')!, { shiftKey: true });
    expect(last()).toEqual({
      kind: 'range', source: FILE_ID, sheetIndex: 0, sheetName: 'المجرد',
      startRow: 1, endRow: 3, startColumn: 1, endColumn: 3, a1Range: 'B2:D4',
    });
    for (const a1 of ['B2', 'C3', 'D4', 'B4', 'D2']) expect(gridCell(a1)).toHaveAttribute('aria-selected', 'true');
    expect(gridCell('A1')).toHaveAttribute('aria-selected', 'false');
  });

  it('a reverse gesture normalizes to the same rectangle', () => {
    const { last } = renderTrusted();
    fireEvent.click(gridCell('D4')!);
    fireEvent.click(gridCell('B2')!, { shiftKey: true });
    expect(last()).toMatchObject({ kind: 'range', startRow: 1, endRow: 3, startColumn: 1, endColumn: 3, a1Range: 'B2:D4' });
  });

  it('a Shift gesture never extends the browser\'s own text selection across cells', () => {
    renderTrusted();
    expect(fireEvent.mouseDown(gridCell('D4')!, { shiftKey: true })).toBe(false);
    expect(fireEvent.mouseDown(gridCell('D4')!)).toBe(true);
  });

  it('the anchor stays put across further Shift+clicks; a plain click starts over', () => {
    const { last } = renderTrusted();
    fireEvent.click(gridCell('B2')!);
    fireEvent.click(gridCell('D4')!, { shiftKey: true });
    fireEvent.click(gridCell('C3')!, { shiftKey: true });
    expect(last()).toMatchObject({ kind: 'range', a1Range: 'B2:C3' });
    fireEvent.click(gridCell('A1')!);
    expect(last()).toMatchObject({ kind: 'cell', a1: 'A1' });
  });
});

describe('4 · KEYBOARD selection', () => {
  it('arrows move the cell; Shift+Arrow extends a range; Ctrl+Space selects the current column', () => {
    const { last } = renderTrusted();
    fireEvent.click(gridCell('B2')!);
    fireEvent.keyDown(grid(), { key: 'ArrowRight' });
    expect(last()).toMatchObject({ kind: 'cell', a1: 'C2' });
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    expect(last()).toMatchObject({ kind: 'cell', a1: 'C3' });
    fireEvent.keyDown(grid(), { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(grid(), { key: 'ArrowDown', shiftKey: true });
    expect(last()).toMatchObject({ kind: 'range', a1Range: 'C3:D4' });
    fireEvent.keyDown(grid(), { key: 'ArrowLeft', shiftKey: true });
    fireEvent.keyDown(grid(), { key: 'ArrowLeft', shiftKey: true });
    expect(last()).toMatchObject({ kind: 'range', a1Range: 'B3:C4' });
    fireEvent.keyDown(grid(), { key: ' ', code: 'Space', ctrlKey: true });
    expect(last()).toEqual({ kind: 'column', source: FILE_ID, sheetIndex: 0, sheetName: 'المجرد', columnIndex: 1 });
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    expect(last()).toMatchObject({ kind: 'cell' });
  });

  it('column header buttons are real, reachable buttons with an explicit accessible name', () => {
    renderTrusted();
    const button = colButton('C');
    expect(button.tagName).toBe('BUTTON');
    expect(button).toHaveAttribute('type', 'button');
    expect(button).not.toHaveAttribute('tabindex', '-1');
    expect(button).toHaveAccessibleName('تحديد العمود C');
    expect(button.closest('[role="columnheader"]')).toHaveAttribute('aria-colindex', '3');
    expect(button.closest('[role="row"]')).toHaveAttribute('aria-rowindex', '1');
    // Keys pressed ON the button are the button's own; the grid does not move.
    fireEvent.click(gridCell('A1')!);
    fireEvent.keyDown(button, { key: 'ArrowDown' });
    expect(screen.getByTestId('cn2b-xl-inspector')).toHaveAttribute('data-a1', 'A1');
  });

  it('keeps role=grid / gridcell, aria-readonly, multiselection and stable A1 labels', () => {
    renderTrusted();
    expect(grid()).toHaveAttribute('role', 'grid');
    expect(grid()).toHaveAttribute('aria-readonly', 'true');
    expect(grid()).toHaveAttribute('aria-multiselectable', 'true');
    expect(grid()).toHaveAttribute('aria-rowcount', String(6 + 1));
    expect(gridCell('A1')?.closest('[role="row"]')).toHaveAttribute('aria-rowindex', '2');
    expect(gridCell('D2')).toHaveAttribute('aria-label', 'D2: 120');
    expect(grid()).toHaveAttribute('dir', 'ltr');
  });
});

describe('5 · SHEET switch — and 7/8 hidden and very hidden sheets', () => {
  it('switching sheet clears the selection', () => {
    const { last } = renderTrusted();
    fireEvent.click(gridCell('C2')!);
    expect(last()).not.toBeNull();
    fireEvent.click(tabs()[1]);
    expect(last()).toBeNull();
    expect(grid().querySelectorAll('[aria-selected="true"]')).toHaveLength(0);
  });

  it('a HIDDEN sheet selects its own physical sheet index and name', () => {
    const { last } = renderTrusted();
    fireEvent.click(tabs()[2]);
    expect(screen.getByTestId('cn2b-xl-hidden-notice')).toBeInTheDocument();
    fireEvent.click(gridCell('B2')!);
    expect(last()).toEqual({
      kind: 'cell', source: FILE_ID, sheetIndex: 2, sheetName: 'مخفية', rowIndex: 1, columnIndex: 1, a1: 'B2', mergedRange: null,
    });
    fireEvent.click(colButton('A'));
    expect(last()).toEqual({ kind: 'column', source: FILE_ID, sheetIndex: 2, sheetName: 'مخفية', columnIndex: 0 });
  });

  it('a VERY HIDDEN sheet selects its own physical sheet index and name', () => {
    const { last } = renderTrusted();
    fireEvent.click(tabs()[3]);
    expect(screen.getByTestId('cn2b-xl-hidden-notice')).toBeInTheDocument();
    fireEvent.click(gridCell('A1')!);
    fireEvent.click(gridCell('B2')!, { shiftKey: true });
    expect(last()).toEqual({
      kind: 'range', source: FILE_ID, sheetIndex: 3, sheetName: 'مخفية بالكامل',
      startRow: 0, endRow: 1, startColumn: 0, endColumn: 1, a1Range: 'A1:B2',
    });
  });
});

describe('9 · MERGED cells — deterministic, and no fabricated evidence', () => {
  it('the merged block selects its anchor with its verbatim range; covered cells are never gridcells', () => {
    const snapshot = structuredClone(file);
    const { last } = renderTrusted();
    const block = gridCell('A5')!;
    expect(block).toHaveAttribute('data-merged', 'A5:C5');
    fireEvent.click(block);
    expect(last()).toMatchObject({ kind: 'cell', a1: 'A5', rowIndex: 4, columnIndex: 0, mergedRange: 'A5:C5' });
    expect(gridCell('B5')).toBeNull();
    expect(gridCell('C5')).toBeNull();
    // D5 is MISSING in the file: it may be drawn and selected, but it gains no evidence.
    fireEvent.click(gridCell('D5')!);
    expect(gridCell('D5')).toHaveAttribute('data-presence', 'missing');
    expect(last()).toMatchObject({ kind: 'cell', a1: 'D5', mergedRange: null });
    expect(file).toEqual(snapshot);
  });

  it('a range ending on the merged block covers the whole block, deterministically', () => {
    const { last } = renderTrusted();
    fireEvent.click(gridCell('A2')!);
    fireEvent.click(gridCell('A5')!, { shiftKey: true });
    expect(last()).toMatchObject({ kind: 'range', a1Range: 'A2:C5' });
    fireEvent.click(gridCell('B3')!);
    fireEvent.click(gridCell('A5')!, { shiftKey: true });
    expect(last()).toMatchObject({ kind: 'range', a1Range: 'A3:C5' });
  });

  it('keyboard entry into a merged block lands on its anchor', () => {
    const { last } = renderTrusted();
    fireEvent.click(gridCell('B4')!);
    fireEvent.keyDown(grid(), { key: 'ArrowDown' });
    expect(last()).toMatchObject({ kind: 'cell', a1: 'A5', mergedRange: 'A5:C5' });
  });
});

describe('6 · WORKBOOK switch in a ZIP', () => {
  it('clears the selection and switches to the chosen workbook\'s own import session', () => {
    const { last } = renderTrusted(ZIP_IDS, archive, 'archive');
    fireEvent.click(gridCell('A2')!);
    expect(last()).toMatchObject({ kind: 'cell', a1: 'A2', source: ZIP_IDS[0] });
    expect(last()!.source.importSessionId).toBe('session-A');

    fireEvent.change(screen.getByTestId('cn2b-xl-workbook-select'), { target: { value: '1' } });
    expect(last()).toBeNull();
    fireEvent.click(gridCell('A2')!);
    expect(last()).toMatchObject({ kind: 'cell', a1: 'A2', source: ZIP_IDS[1] });
    expect(last()!.source).toEqual({
      batchId: 'batch-z', entryId: 'entry-b', entryOrdinal: 2, entrySha256: second.input.sha256,
      importSessionId: 'session-B', workbookIndex: 1,
    });
  });

  it('a workbook without exactly one identity is shown read-only with no selection output', () => {
    const { onChange } = renderTrusted([ZIP_IDS[0]], archive, 'archive');
    fireEvent.change(screen.getByTestId('cn2b-xl-workbook-select'), { target: { value: '1' } });
    expect(grid()).not.toHaveAttribute('data-selectable');
    fireEvent.click(gridCell('A2')!);
    expect(onChange.mock.calls.at(-1)?.[0]).toBeNull();
    // Two identities claiming the same workbook: ambiguous, so none.
    cleanup();
    const again = renderTrusted([ZIP_IDS[0], { ...ZIP_IDS[1], workbookIndex: 0 }], archive, 'archive');
    expect(grid()).not.toHaveAttribute('data-selectable');
    fireEvent.click(gridCell('A2')!);
    expect(again.onChange.mock.calls.every(([s]) => s === null)).toBe(true);
  });
});

describe('Context changes never let a stale selection survive', () => {
  it('a new parsed result clears the selection', async () => {
    const { last, rerender, onChange } = renderTrusted();
    fireEvent.click(gridCell('C2')!);
    const reparsed = await parseWorkbookBytes(fixtureBytes(), 'احتياج 2027.xlsx', { runtime: 'node' });
    rerender(<ExcelWorkbookViewer lang="ar" kind="file" result={reparsed} selection={{ identities: [FILE_ID], onChange }} />);
    expect(last()).toBeNull();
  });

  it('a new source identity clears the selection; the next one carries the new identity', () => {
    const { last, rerender, onChange } = renderTrusted();
    fireEvent.click(gridCell('C2')!);
    const other = { ...FILE_ID, entryId: 'entry-9', importSessionId: 'session-9' };
    rerender(<ExcelWorkbookViewer lang="ar" kind="file" result={file} selection={{ identities: [other], onChange }} />);
    expect(last()).toBeNull();
    fireEvent.click(gridCell('C2')!);
    expect(last()!.source).toEqual(other);
  });

  it('unmounting reports null', () => {
    const { last, unmount } = renderTrusted();
    fireEvent.click(gridCell('C2')!);
    act(() => unmount());
    expect(last()).toBeNull();
  });
});

describe('Without a trusted identity the E1 viewer is unchanged', () => {
  it('no selection prop: header row hidden, no buttons, Shift and Ctrl+Space are plain E1 behaviour', () => {
    render(<ExcelWorkbookViewer lang="ar" kind="file" result={file} />);
    expect(grid()).not.toHaveAttribute('data-selectable');
    expect(grid()).not.toHaveAttribute('aria-multiselectable');
    expect(grid()).toHaveAttribute('aria-rowcount', '6');
    expect(within(grid()).queryAllByTestId('cn2b-xl-colbutton')).toHaveLength(0);
    expect(within(grid()).getAllByTestId('cn2b-xl-colhead')[0].parentElement).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(gridCell('B2')!);
    expect(fireEvent.mouseDown(gridCell('D4')!, { shiftKey: true })).toBe(true);
    fireEvent.click(gridCell('D4')!, { shiftKey: true });
    expect(gridCell('D4')).toHaveAttribute('aria-selected', 'true');
    expect(gridCell('B2')).toHaveAttribute('aria-selected', 'false');
    expect(grid().querySelector('[data-in-selection]')).toBeNull();
  });

  it('empty identities: the grid stays E1 and only null is ever reported', () => {
    const { onChange } = renderTrusted([]);
    expect(within(grid()).queryAllByTestId('cn2b-xl-colbutton')).toHaveLength(0);
    fireEvent.click(gridCell('C2')!);
    fireEvent.keyDown(grid(), { key: ' ', code: 'Space', ctrlKey: true });
    expect(onChange.mock.calls.every(([s]) => s === null)).toBe(true);
  });
});

describe('18 · MEMORY ONLY — no persistence, no backend, no evidence mutation', () => {
  it('selecting in every way writes no browser storage, calls no backend or network, and mutates nothing', () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const snapshot = structuredClone(file);
    const { last } = renderTrusted();
    fireEvent.click(gridCell('B2')!);
    fireEvent.click(gridCell('D4')!, { shiftKey: true });
    fireEvent.click(colButton('C'));
    fireEvent.keyDown(grid(), { key: ' ', code: 'Space', ctrlKey: true });
    fireEvent.keyDown(grid(), { key: 'ArrowDown', shiftKey: true });
    for (const tab of tabs()) fireEvent.click(tab);
    expect(last()).toBeNull();
    expect(setItem).not.toHaveBeenCalled();
    expect(window.localStorage.length).toBe(0);
    expect(window.sessionStorage.length).toBe(0);
    expect(document.cookie).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(backendCalls).toEqual([]);
    expect(file).toEqual(snapshot);
    setItem.mockRestore();
    vi.unstubAllGlobals();
  });
});
