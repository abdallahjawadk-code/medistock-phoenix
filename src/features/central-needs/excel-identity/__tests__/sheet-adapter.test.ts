import { describe, expect, it, vi } from 'vitest';
import { lazySheetCells, runIdentityAssist, type EvidenceCellLike, type ResolverHit } from '../index';

/** A cell whose VALUE read is recorded; coordinates are free to read. */
function cell(row: number, col: number, value: string | number | null, log: string[], presence: EvidenceCellLike['presence'] = 'value', valueType?: string): EvidenceCellLike {
  const c = { coordinate: { row, col }, presence, valueType } as EvidenceCellLike;
  Object.defineProperty(c, 'rawValue', { get() { log.push(`${row}:${col}`); return value; }, enumerable: true });
  return c;
}

const hit = (o: Partial<ResolverHit> = {}): ResolverHit => ({ source: 'catalog', centralItemId: 'item-1', scientificName: 'Aspirin', tradeName: null,
  concentration: '100 mg', dosageForm: 'Tablet', unit: 'box', nationalCode: null, grade: 'confirmed', ...o });

describe('lazySheetCells', () => {
  const build = () => {
    const log: string[] = [];
    const sheet = {
      usedRange: { endRow: 3, endCol: 3 },
      cells: [
        cell(0, 0, 'Medicine name', log), cell(0, 1, 'Strength', log), cell(0, 2, 'Annual quantity', log),
        cell(1, 0, 'Aspirin', log), cell(1, 1, '100 mg', log), cell(1, 2, 987001, log),
        cell(2, 0, 'Zinc', log), cell(2, 1, '20 mg', log), cell(2, 2, 987002, log),
        cell(3, 0, 'Iron', log), cell(3, 1, '5 mg', log), cell(3, 2, 987003, log),
      ],
    };
    return { sheet, log };
  };

  it('indexing the evidence reads NO value; a value is read only when the extractor asks for that exact cell', () => {
    const { sheet, log } = build();
    const grid = lazySheetCells(sheet);
    expect(log).toEqual([]);                                           // building the grid read nothing
    expect(grid.length).toBe(4);
    expect(grid[1][0]).toBe('Aspirin');
    expect(log).toEqual(['1:0']);
    expect(grid[9]).toBeUndefined();                                   // beyond the used range
  });

  it('runIdentityAssist over the lazy grid NEVER reads a quantity cell (value getters on column 2 stay untouched)', async () => {
    const { sheet, log } = build();
    const resolve = vi.fn(async () => [hit()]);
    const r = await runIdentityAssist({ sheet: lazySheetCells(sheet), sheetIndex: 0, confirmedHeaderRow: 0, resolve });
    expect(r.extraction.candidates.map((c) => c.name)).toEqual(['Aspirin', 'Zinc', 'Iron']);
    const dataReads = log.filter((k) => !k.startsWith('0:'));                         // everything outside the header row
    expect(dataReads.length).toBeGreaterThan(0);
    expect(dataReads.every((k) => /:(0|1)$/.test(k))).toBe(true);                    // only the identity columns (name, strength)
    expect(log.some((k) => /^[123]:2$/.test(k))).toBe(false);                        // no data-row quantity cell, ever
    expect(JSON.stringify(r)).not.toMatch(/98700\d/);
  });

  it('without a confirmed header the lazy grid is not touched at all', async () => {
    const { sheet, log } = build();
    const r = await runIdentityAssist({ sheet: lazySheetCells(sheet), sheetIndex: 0, confirmedHeaderRow: undefined, resolve: async () => [] });
    expect(r.extraction.warnings).toEqual(['header_confirmation_required']);
    expect(log).toEqual([]);
  });

  it('error cells, blanks and missing cells read as null; columns beyond the bound do not exist', () => {
    const log: string[] = [];
    const grid = lazySheetCells({ usedRange: { endRow: 1, endCol: 100 }, cells: [cell(0, 0, '#DIV/0!', log, 'value', 'error'), cell(0, 1, null, log, 'blank'), cell(0, 70, 'far', log)] });
    expect(grid[0][0]).toBeNull();
    expect(grid[0][1]).toBeNull();
    expect(grid[0][2]).toBeNull();
    expect(grid[0][70]).toBeUndefined();
    expect(log).toEqual([]);
  });
});
