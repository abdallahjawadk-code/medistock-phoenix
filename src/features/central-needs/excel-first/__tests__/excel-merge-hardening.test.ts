/**
 * E1-MRG-001 — merge resource-bounding hardening: model-level proof.
 *
 * Complements the Director package's tests (excel-viewer-model.test.ts) with
 * the properties an independent reviewer needs to see proven, not asserted:
 *
 *   - SAME RULE: displayed merges equal a naive reference implementation of
 *     the package's rule (source order; exact duplicates dropped; the first
 *     non-overlapping range wins) on seeded random hostile input;
 *   - BOUNDED INTAKE: intake work is measured by a deterministic counter, is
 *     small for the pathological cases that used to take seconds, and has a
 *     hard ceiling (MERGE_INTAKE_WORK_BUDGET) that stops deterministically and
 *     discloses the unreached tail;
 *   - NOTHING SILENT: every source range is accounted for exactly once,
 *     including ranges lying outside the drawn used range;
 *   - CORRECT LOOKUP: window and point lookups return exactly the displayed
 *     merges a naive scan would, through both lookup strategies;
 *   - DETERMINISM: identical input → identical merges, counters, lookups;
 *   - BOUNDED INSPECTOR: a merge over 1 000 000 coordinates scans exactly
 *     MERGE_INSPECT_SCAN_LIMIT evidence cells and does not invent a total.
 */
import { describe, expect, it } from 'vitest';
import type { CellEvidence, SheetEvidence } from '../../import/contract';
import {
  MERGE_INSPECT_SCAN_LIMIT,
  MERGE_INTAKE_WORK_BUDGET,
  MERGE_PROCESS_LIMIT,
  a1Address,
  buildSheetGridModel,
  columnLetters as L,
  hiddenValuesInMerge,
  parseA1Range,
  sheetGridExtent,
  type GridWindow,
  type MergedRegion,
} from '../excelViewerModel';

function sheetOf(mergedRanges: string[], rows: number, cols: number, cells: CellEvidence[] = []): SheetEvidence {
  return {
    index: 0, name: 'hostile', hidden: 'visible',
    usedRange: { startRow: 0, endRow: rows - 1, startCol: 0, endCol: cols - 1 },
    nonEmptyCellCount: cells.length, cells, mergedRanges, duplicateHeaderGroups: [],
  };
}

type Rect = Pick<MergedRegion, 'startRow' | 'endRow' | 'startCol' | 'endCol'>;
const overlap = (a: Rect, b: Rect) =>
  a.endRow >= b.startRow && a.startRow <= b.endRow && a.endCol >= b.startCol && a.startCol <= b.endCol;

/** The package's selection rule, written as plainly as possible (O(n²)). */
function referenceDisplayedMerges(sheet: SheetEvidence): string[] {
  const extent = sheetGridExtent(sheet);
  if (!extent) return [];
  const box = {
    startRow: extent.originRow, endRow: extent.originRow + extent.rowCount - 1,
    startCol: extent.originCol, endCol: extent.originCol + extent.colCount - 1,
  };
  const accepted: MergedRegion[] = [];
  const seen = new Set<string>();
  for (const text of sheet.mergedRanges.slice(0, MERGE_PROCESS_LIMIT)) {
    const region = parseA1Range(text);
    if (!region || !overlap(region, box)) continue;
    const geometry = `${region.startRow}:${region.startCol}:${region.endRow}:${region.endCol}`;
    if (seen.has(geometry)) continue;
    seen.add(geometry);
    if (accepted.some((a) => overlap(a, region))) continue;
    accepted.push(region);
  }
  return accepted.map((m) => m.range);
}

/** Deterministic PRNG (mulberry32). */
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seeded hostile mix: small, medium, huge, duplicate, malformed and out-of-range merges. */
function hostileMix(seed: number, count: number, rows: number, cols: number): string[] {
  const rand = rng(seed);
  const out: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const kind = rand();
    if (kind < 0.04) { out.push('not-a-range'); continue; }
    if (kind < 0.10 && out.length > 0) { out.push(out[Math.floor(rand() * out.length)]); continue; }
    const r0 = Math.floor(rand() * rows);
    const c0 = Math.floor(rand() * cols);
    const size = rand();
    const h = size < 0.7 ? Math.floor(rand() * 3) : size < 0.95 ? Math.floor(rand() * 40) : Math.floor(rand() * rows);
    const w = size < 0.7 ? Math.floor(rand() * 3) : size < 0.95 ? Math.floor(rand() * 20) : Math.floor(rand() * cols);
    const r1 = Math.min(rows - 1, r0 + h);
    const c1 = Math.min(cols - 1, c0 + w);
    const outside = kind > 0.97 ? rows + 5 : 0;
    out.push(`${L(c0)}${r0 + 1 + outside}:${L(c1)}${r1 + 1 + outside}`);
  }
  return out;
}

const ACCOUNTED = (s: ReturnType<typeof buildSheetGridModel>['mergeSafety']) =>
  s.renderableMergeCount + s.duplicateMergeCount + s.overlappingMergeCount
  + s.unparsedMergeCount + s.outOfExtentMergeCount + s.unprocessedMergeCount;

describe('E1-MRG-001 — the selection rule is unchanged (reference equivalence)', () => {
  for (const seed of [1, 7, 20260918]) {
    it(`seed ${seed}: displayed merges equal the naive reference rule`, () => {
      const sheet = sheetOf(hostileMix(seed, 3_000, 2_000, 120), 2_000, 120);
      const model = buildSheetGridModel(sheet);
      expect(model.merges.map((m) => m.range)).toEqual(referenceDisplayedMerges(sheet));
      // Displayed merges never overlap each other (one plain pass, one assertion).
      let overlappingPairs = 0;
      for (let i = 0; i < model.merges.length; i += 1) {
        for (let j = i + 1; j < model.merges.length; j += 1) {
          if (overlap(model.merges[i], model.merges[j])) overlappingPairs += 1;
        }
      }
      expect(overlappingPairs).toBe(0);
      expect(model.merges.length).toBeGreaterThan(100);
    });
  }
});

describe('E1-MRG-001 — every source range is accounted for exactly once', () => {
  it('renderable + duplicate + overlapping + unparsed + outside + unprocessed = source', () => {
    const ranges = [
      ...hostileMix(99, 9_000, 3_000, 200),
      ...Array.from({ length: 1_500 }, (_, i) => `A${i + 1}:B${i + 1}`), // pushes past the 10 000 intake ceiling
    ];
    const model = buildSheetGridModel(sheetOf(ranges, 3_000, 200));
    const s = model.mergeSafety;
    expect(s.sourceMergeCount).toBe(10_500);
    expect(s.unprocessedMergeCount).toBe(500);
    expect(s.intakeStoppedBy).toBe('merge-limit');
    expect(s.outOfExtentMergeCount).toBeGreaterThan(0);
    expect(s.unparsedMergeCount).toBeGreaterThan(0);
    expect(s.duplicateMergeCount).toBeGreaterThan(0);
    expect(s.overlappingMergeCount).toBeGreaterThan(0);
    expect(ACCOUNTED(s)).toBe(s.sourceMergeCount);
    expect(s.safetySuppressedMergeCount).toBe(s.unprocessedMergeCount + s.duplicateMergeCount
      + s.overlappingMergeCount + s.unparsedMergeCount);
    expect(s.limited).toBe(true);
  });

  it('a range wholly outside the used range is counted, not silently skipped', () => {
    const model = buildSheetGridModel(sheetOf(['A1:B2', 'A50:B60', 'Z1:Z3'], 10, 5));
    expect(model.merges.map((m) => m.range)).toEqual(['A1:B2']);
    expect(model.mergeSafety.outOfExtentMergeCount).toBe(2);
    expect(ACCOUNTED(model.mergeSafety)).toBe(3);
    // Outside the drawn area is not a safety suppression, and it is reported separately.
    expect(model.mergeSafety.safetySuppressedMergeCount).toBe(0);
  });

  it('the source merge list is never mutated', () => {
    const sheet = sheetOf(hostileMix(5, 2_000, 500, 60), 500, 60);
    const before = structuredClone(sheet);
    buildSheetGridModel(sheet);
    expect(sheet).toEqual(before);
  });
});

describe('E1-MRG-001 — bounded intake (deterministic work counter)', () => {
  const last = L(255);

  it('10 000 unique overlapping full-sheet ranges: one displayed, work stays linear in the input', () => {
    const model = buildSheetGridModel(sheetOf(Array.from({ length: 10_000 }, (_, i) => `A${i + 1}:${last}10000`), 10_000, 256));
    expect(model.merges.map((m) => m.range)).toEqual([`A1:${last}10000`]);
    expect(model.mergeSafety.overlappingMergeCount).toBe(9_999);
    // Was a walk over ~5 000 buckets per range (seconds); now a few steps per range.
    expect(model.mergeSafety.intakeWorkUnits).toBeLessThan(10_000 * 3 + 5_008);
    expect(model.mergeSafety.intakeStoppedBy).toBe('complete');
  });

  it('10 000 duplicate ranges cost one step each after the first', () => {
    const model = buildSheetGridModel(sheetOf(Array.from({ length: 10_000 }, () => 'A1:B2'), 100, 30));
    expect(model.merges).toHaveLength(1);
    expect(model.mergeSafety.duplicateMergeCount).toBe(9_999);
    expect(model.mergeSafety.intakeWorkUnits).toBeLessThanOrEqual(10_000 + 10);
  });

  it('a geometry crafted to make every probe expensive hits the work budget, stops deterministically and discloses the rest', () => {
    // 5 100 accepted 1x1 merges fill the first bucket row; one accepted merge
    // sits at the bottom; every later range spans the whole sheet from the
    // first bucket row down, overlapping only that bottom merge — so each
    // probe must look through the whole column of buckets before it is refused.
    const small = Array.from({ length: 5_100 }, (_, i) => `${L(i % 256)}${Math.floor(i / 256) + 1}`);
    const bottom = [`A9969:${last}10000`];
    const probes: string[] = [];
    for (let r = 21; r <= 32; r += 1) {
      for (let c = 0; c < 16; c += 1) {
        for (let e = 240; e < 256; e += 1) probes.push(`${L(c)}${r}:${L(e)}10000`);
      }
    }
    const sheet = sheetOf([...small, ...bottom, ...probes], 10_000, 256);
    const a = buildSheetGridModel(sheet);
    const s = a.mergeSafety;
    expect(s.sourceMergeCount).toBe(5_101 + probes.length);
    expect(s.intakeStoppedBy).toBe('work-budget');
    expect(s.processedMergeCount).toBeLessThan(s.sourceMergeCount);
    expect(s.unprocessedMergeCount).toBe(s.sourceMergeCount - s.processedMergeCount);
    expect(s.limited).toBe(true);
    expect(ACCOUNTED(s)).toBe(s.sourceMergeCount);
    // Hard bound: the budget, plus at most one range's own cost in this extent
    // (1 parse + 5 008 bucket lookups + ≤ 10 000 entries + 5 008 insertions).
    expect(s.intakeWorkUnits).toBeGreaterThanOrEqual(MERGE_INTAKE_WORK_BUDGET);
    expect(s.intakeWorkUnits).toBeLessThanOrEqual(MERGE_INTAKE_WORK_BUDGET + 20_017);
    // Same input, same cutoff, same result.
    const b = buildSheetGridModel(structuredClone(sheet));
    expect(b.mergeSafety).toEqual(a.mergeSafety);
    expect(b.merges).toEqual(a.merges);
  }, 30_000);

  it('realistic dense layouts stay under the budget and are processed completely', () => {
    const rows = buildSheetGridModel(sheetOf(Array.from({ length: 10_000 }, (_, i) => `A${i + 1}:${last}${i + 1}`), 10_000, 256));
    const cells = buildSheetGridModel(sheetOf(Array.from({ length: 10_000 }, (_, i) => `${L(i % 256)}${Math.floor(i / 256) + 1}`), 10_000, 256));
    for (const m of [rows, cells]) {
      expect(m.mergeSafety.intakeStoppedBy).toBe('complete');
      expect(m.mergeSafety.renderableMergeCount).toBe(10_000);
      expect(m.mergeSafety.intakeWorkUnits).toBeLessThan(MERGE_INTAKE_WORK_BUDGET);
    }
  }, 30_000);
});

describe('E1-MRG-001 — lookups return exactly the displayed merges (both strategies)', () => {
  function checkLookups(sheetRows: number, sheetCols: number, ranges: string[], seed: number) {
    const model = buildSheetGridModel(sheetOf(ranges, sheetRows, sheetCols));
    const rand = rng(seed);
    for (let k = 0; k < 300; k += 1) {
      const firstRow = Math.floor(rand() * sheetRows);
      const firstCol = Math.floor(rand() * sheetCols);
      const window: GridWindow = {
        firstRow, firstCol,
        lastRow: Math.min(sheetRows - 1, firstRow + Math.floor(rand() * 100)),
        lastCol: Math.min(sheetCols - 1, firstCol + Math.floor(rand() * 30)),
      };
      const rect = { startRow: window.firstRow, endRow: window.lastRow, startCol: window.firstCol, endCol: window.lastCol };
      const expected = model.merges.filter((m) => overlap(m, rect)).map((m) => m.range);
      expect(model.mergesInWindow(window).map((m) => m.range)).toEqual(expected);
      const row = Math.floor(rand() * sheetRows);
      const col = Math.floor(rand() * sheetCols);
      const point = { startRow: row, endRow: row, startCol: col, endCol: col };
      expect(model.mergeAt(row, col)?.range).toBe(model.merges.find((m) => overlap(m, point))?.range);
    }
  }

  it('many displayed merges (bucket strategy)', () => {
    checkLookups(2_000, 120, hostileMix(11, 3_000, 2_000, 120), 11);
  });

  it('few displayed merges (direct strategy)', () => {
    checkLookups(2_000, 120, ['A1:DP2000', 'B5:C9'], 12);
    checkLookups(500, 60, ['C3:D4', 'J10:Z400', 'A450:BH500'], 13);
  });
});

describe('E1-MRG-001 — determinism', () => {
  it('identical input gives identical merges, counters and lookups', () => {
    const ranges = hostileMix(314, 6_000, 4_000, 150);
    const a = buildSheetGridModel(sheetOf(ranges, 4_000, 150));
    const b = buildSheetGridModel(sheetOf([...ranges], 4_000, 150));
    expect(b.merges).toEqual(a.merges);
    expect(b.mergeSafety).toEqual(a.mergeSafety);
    const windows: GridWindow[] = [
      { firstRow: 0, lastRow: 99, firstCol: 0, lastCol: 29 },
      { firstRow: 1_950, lastRow: 2_049, firstCol: 60, lastCol: 89 },
      { firstRow: 3_900, lastRow: 3_999, firstCol: 120, lastCol: 149 },
    ];
    for (const w of windows) expect(b.mergesInWindow(w)).toEqual(a.mergesInWindow(w));
  });
});

describe('E1-MRG-001 — inspector work is bounded by MERGE_INSPECT_SCAN_LIMIT', () => {
  it('a merge over 1 000 000 coordinates scans exactly the budget and does not invent a total', () => {
    expect(MERGE_INSPECT_SCAN_LIMIT).toBe(4_096);
    const cells: CellEvidence[] = Array.from({ length: 200_000 }, (_, i) => ({
      coordinate: { row: Math.floor(i / 100), col: i % 100, a1: a1Address(Math.floor(i / 100), i % 100) },
      presence: 'value', valueType: 'number', rawValue: i, isFormula: false, hasComment: false,
    }));
    const model = buildSheetGridModel(sheetOf([`A1:${L(99)}10000`], 10_000, 100, cells));
    const region = model.merges[0];
    expect((region.endRow - region.startRow + 1) * (region.endCol - region.startCol + 1)).toBe(1_000_000);
    const hidden = hiddenValuesInMerge(model, region);
    expect(hidden.scannedEvidenceCount).toBe(MERGE_INSPECT_SCAN_LIMIT);
    expect(hidden.scanComplete).toBe(false);
    expect(hidden.total).toBeNull();
    expect(hidden.cells).toHaveLength(10);
    expect(hidden.cells[0].coordinate.a1).toBe('B1');
  }, 30_000);

  it('a late merge starts scanning at its own first row (no walk over earlier evidence)', () => {
    const cells: CellEvidence[] = Array.from({ length: 200_000 }, (_, i) => ({
      coordinate: { row: Math.floor(i / 100), col: i % 100, a1: a1Address(Math.floor(i / 100), i % 100) },
      presence: 'value', valueType: 'number', rawValue: i, isFormula: false, hasComment: false,
    }));
    const model = buildSheetGridModel(sheetOf([`A1990:B2000`], 2_000, 100, cells));
    const hidden = hiddenValuesInMerge(model, model.merges[0]);
    // Rows 1990..2000 hold 11 × 100 = 1 100 cells, well under the budget: complete and exact.
    expect(hidden.scanComplete).toBe(true);
    expect(hidden.scannedEvidenceCount).toBe(1_100);
    expect(hidden.total).toBe(11 * 2 - 1);
  }, 30_000);
});
