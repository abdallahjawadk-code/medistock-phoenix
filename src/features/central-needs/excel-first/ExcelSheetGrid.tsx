/**
 * E1 — the sheet grid of the read-only original-workbook viewer.
 *
 * READ-ONLY SOURCE EVIDENCE, NOT AN EDITOR. Cells are plain elements holding
 * React text children: there is no input, no contentEditable, no link, and
 * no HTML is ever built from cell content, so a cell reading
 * `<script>…</script>` or `javascript:…` is shown as those characters.
 *
 * ORIENTATION. The page around the viewer follows the app direction (RTL for
 * Arabic); the grid itself is pinned `dir="ltr"` so column A is always the
 * first column and A1 always means A1. Each cell's own text uses
 * `dir="auto"`, so Arabic content still reads right-to-left inside its cell.
 *
 * BOUNDED DOM. Only the rows and columns inside the scroll viewport (plus a
 * small overscan, under hard ceilings in `excelViewerModel.ts`) are mounted.
 * Merge geometry is pre-hardened into non-overlapping, spatially indexed
 * regions, so hostile duplicate/overlapping merges cannot add extra DOM nodes
 * beyond the same cell-window ceiling. A 10 000-row sheet costs the same DOM
 * as a 30-row one.
 */
import { useCallback, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  GRID_COL_WIDTH,
  GRID_HEADER_HEIGHT,
  GRID_ROW_HEADER_WIDTH,
  GRID_ROW_HEIGHT,
  a1Address,
  cellDisplayText,
  columnLetters,
  computeGridWindow,
  coordinateKey,
  moveSelection,
  sameWindow,
  scrollToReveal,
  type GridExtent,
  type GridPoint,
  type GridWindow,
  type MergedRegion,
  type SheetGridModel,
} from './excelViewerModel';

interface Props {
  model: SheetGridModel;
  extent: GridExtent;
  selected: GridPoint | null;
  onSelect: (point: GridPoint) => void;
  /** Accessible name of the grid (the sheet it shows). */
  label: string;
  /** Unique per viewer instance; prefixes cell ids for aria-activedescendant. */
  idPrefix: string;
}

const NAV_KEYS: Record<string, [number, number]> = {
  ArrowUp: [-1, 0],
  ArrowDown: [1, 0],
  ArrowLeft: [0, -1],
  ArrowRight: [0, 1],
};

function clampWindow(win: GridWindow, extent: GridExtent): GridWindow {
  return {
    firstRow: Math.max(win.firstRow, extent.originRow),
    lastRow: Math.min(win.lastRow, extent.originRow + extent.rowCount - 1),
    firstCol: Math.max(win.firstCol, extent.originCol),
    lastCol: Math.min(win.lastCol, extent.originCol + extent.colCount - 1),
  };
}

function range(first: number, last: number): number[] {
  const out: number[] = [];
  for (let i = first; i <= last; i += 1) out.push(i);
  return out;
}

export function ExcelSheetGrid({ model, extent, selected, onSelect, label, idPrefix }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [storedWin, setWin] = useState<GridWindow>(() =>
    computeGridWindow(extent, { top: 0, left: 0, width: 0, height: 0 }));
  // Never draw outside the CURRENT extent, even for the one render between a
  // new sheet arriving and the layout effect recomputing the window.
  const win = clampWindow(storedWin, extent);

  const measure = useCallback(() => {
    const el = scrollerRef.current;
    return el
      ? { top: el.scrollTop, left: el.scrollLeft, width: el.clientWidth, height: el.clientHeight }
      : { top: 0, left: 0, width: 0, height: 0 };
  }, []);

  /** Recomputes the mounted window; re-renders only when it actually moved. */
  const refresh = useCallback(() => {
    const next = computeGridWindow(extent, measure());
    setWin((prev) => (sameWindow(prev, next) ? prev : next));
  }, [extent, measure]);

  useLayoutEffect(() => {
    refresh();
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => refresh());
    observer.observe(el);
    return () => observer.disconnect();
  }, [refresh]);

  function reveal(point: GridPoint) {
    const el = scrollerRef.current;
    if (!el) return;
    const next = scrollToReveal(extent, point, measure());
    el.scrollTop = next.top;
    el.scrollLeft = next.left;
    refresh();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const lastCol = extent.originCol + extent.colCount - 1;
    const pageRows = Math.max(1, win.lastRow - win.firstRow - 2);
    let next: GridPoint | null = null;
    if (event.key in NAV_KEYS) {
      const [dRow, dCol] = NAV_KEYS[event.key];
      next = moveSelection(model, selected, dRow, dCol);
    } else if (event.key === 'PageDown' || event.key === 'PageUp') {
      next = moveSelection(model, selected, event.key === 'PageDown' ? pageRows : -pageRows, 0);
    } else if (event.key === 'Home' || event.key === 'End') {
      const row = selected?.row ?? extent.originRow;
      next = moveSelection(model, { row, col: event.key === 'Home' ? extent.originCol : lastCol }, 0, 0);
    } else {
      return;
    }
    event.preventDefault();
    if (!next) return;
    onSelect(next);
    reveal(next);
  }

  // Merged regions touching the window are drawn once, as one block, from
  // their anchor's own evidence. Every coordinate they cover (anchor included)
  // is skipped by the ordinary cell loop, so no value is ever repeated.
  const visibleMerges: readonly MergedRegion[] = model.mergesInWindow(win);
  const covered = new Set<number>();
  for (const m of visibleMerges) {
    for (let r = Math.max(m.startRow, win.firstRow); r <= Math.min(m.endRow, win.lastRow); r += 1) {
      for (let c = Math.max(m.startCol, win.firstCol); c <= Math.min(m.endCol, win.lastCol); c += 1) {
        covered.add(coordinateKey(r, c));
      }
    }
  }
  const mergesByHostRow = new Map<number, MergedRegion[]>();
  for (const m of visibleMerges) {
    const host = Math.max(m.startRow, win.firstRow);
    mergesByHostRow.set(host, [...(mergesByHostRow.get(host) ?? []), m]);
  }

  const lastRow = extent.originRow + extent.rowCount - 1;
  const lastCol = extent.originCol + extent.colCount - 1;
  const bodyWidth = extent.colCount * GRID_COL_WIDTH;
  const bodyHeight = extent.rowCount * GRID_ROW_HEIGHT;
  const rows = range(win.firstRow, win.lastRow);
  const cols = range(win.firstCol, win.lastCol);
  const selectedRegion = selected ? model.mergeAt(selected.row, selected.col) : undefined;
  const isSelected = (row: number, col: number) =>
    selected !== null && selected.row === row && selected.col === col;
  // Only ever points at an element that is actually mounted.
  const selectedMounted = selected !== null && (selectedRegion
    ? visibleMerges.includes(selectedRegion)
    : selected.row >= win.firstRow && selected.row <= win.lastRow
      && selected.col >= win.firstCol && selected.col <= win.lastCol);
  const activeId = selected && selectedMounted ? `${idPrefix}-${a1Address(selected.row, selected.col)}` : undefined;
  const colActive = (col: number) =>
    selected !== null && (selectedRegion ? col >= selectedRegion.startCol && col <= selectedRegion.endCol : col === selected.col);
  const rowActive = (row: number) =>
    selected !== null && (selectedRegion ? row >= selectedRegion.startRow && row <= selectedRegion.endRow : row === selected.row);

  function cellElement(row: number, col: number, region?: MergedRegion) {
    const cell = model.cellAt(row, col);
    const text = cellDisplayText(cell);
    const a1 = a1Address(row, col);
    const hostRow = region ? Math.max(region.startRow, win.firstRow) : row;
    const spanRows = region ? Math.min(region.endRow, lastRow) - region.startRow + 1 : 1;
    const spanCols = region ? Math.min(region.endCol, lastCol) - region.startCol + 1 : 1;
    const chosen = isSelected(row, col);
    return (
      <div
        key={a1}
        role="gridcell"
        id={`${idPrefix}-${a1}`}
        className={region ? 'cn2b-xl-cell cn2b-xl-cell--merged' : 'cn2b-xl-cell'}
        data-a1={a1}
        data-presence={cell ? cell.presence : 'missing'}
        data-value-type={cell?.valueType}
        data-formula={cell?.isFormula ? 'true' : undefined}
        data-comment={cell?.hasComment ? 'true' : undefined}
        data-merged={region ? region.range : undefined}
        data-selected={chosen}
        aria-selected={chosen}
        aria-colindex={col - extent.originCol + 1}
        aria-colspan={region ? spanCols : undefined}
        aria-rowspan={region ? spanRows : undefined}
        aria-label={text === '' ? a1 : `${a1}: ${text}`}
        style={{
          insetBlockStart: (row - hostRow) * GRID_ROW_HEIGHT,
          insetInlineStart: (col - extent.originCol) * GRID_COL_WIDTH,
          inlineSize: spanCols * GRID_COL_WIDTH,
          blockSize: spanRows * GRID_ROW_HEIGHT,
        }}
        onClick={() => onSelect({ row, col })}
      >
        {text !== '' && <span className="cn2b-xl-cell__text" dir="auto">{text}</span>}
      </div>
    );
  }

  return (
    <div
      ref={scrollerRef}
      className="cn2b-xl-grid"
      dir="ltr"
      role="grid"
      aria-label={label}
      aria-readonly="true"
      aria-rowcount={extent.rowCount}
      aria-colcount={extent.colCount}
      aria-activedescendant={activeId}
      tabIndex={0}
      data-testid="cn2b-xl-grid"
      onScroll={refresh}
      onKeyDown={onKeyDown}
    >
      <div
        className="cn2b-xl-grid__canvas"
        style={{ inlineSize: GRID_ROW_HEADER_WIDTH + bodyWidth, blockSize: GRID_HEADER_HEIGHT + bodyHeight }}
      >
        <div className="cn2b-xl-grid__colheads" aria-hidden="true" style={{ blockSize: GRID_HEADER_HEIGHT }}>
          <div className="cn2b-xl-grid__corner" style={{ inlineSize: GRID_ROW_HEADER_WIDTH, blockSize: GRID_HEADER_HEIGHT }} />
          {cols.map((col) => (
            <div
              key={col}
              className="cn2b-xl-grid__colhead"
              data-testid="cn2b-xl-colhead"
              data-active={colActive(col)}
              style={{
                insetInlineStart: GRID_ROW_HEADER_WIDTH + (col - extent.originCol) * GRID_COL_WIDTH,
                inlineSize: GRID_COL_WIDTH,
                blockSize: GRID_HEADER_HEIGHT,
              }}
            >
              {columnLetters(col)}
            </div>
          ))}
        </div>
        <div
          className="cn2b-xl-grid__rowheads"
          aria-hidden="true"
          style={{ inlineSize: GRID_ROW_HEADER_WIDTH, blockSize: bodyHeight }}
        >
          {rows.map((row) => (
            <div
              key={row}
              className="cn2b-xl-grid__rowhead"
              data-active={rowActive(row)}
              style={{
                insetBlockStart: (row - extent.originRow) * GRID_ROW_HEIGHT,
                inlineSize: GRID_ROW_HEADER_WIDTH,
                blockSize: GRID_ROW_HEIGHT,
              }}
            >
              {row + 1}
            </div>
          ))}
        </div>
        <div
          className="cn2b-xl-grid__body"
          style={{
            insetBlockStart: GRID_HEADER_HEIGHT,
            insetInlineStart: GRID_ROW_HEADER_WIDTH,
            inlineSize: bodyWidth,
            blockSize: bodyHeight,
          }}
        >
          {rows.map((row) => (
            <div
              key={row}
              role="row"
              aria-rowindex={row - extent.originRow + 1}
              className="cn2b-xl-grid__row"
              style={{ insetBlockStart: (row - extent.originRow) * GRID_ROW_HEIGHT, inlineSize: bodyWidth, blockSize: GRID_ROW_HEIGHT }}
            >
              {cols.map((col) => (covered.has(coordinateKey(row, col)) ? null : cellElement(row, col)))}
              {(mergesByHostRow.get(row) ?? []).map((m) => cellElement(m.startRow, m.startCol, m))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
