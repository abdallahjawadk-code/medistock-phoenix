/**
 * C6 — REAL-CORPUS END-TO-END CERTIFICATION, layer A: FULL REAL-CORPUS REPLAY.
 *
 * The certified Annual Needs archive (PHOENIX_C6_CORPUS_ZIP, accepted ONLY at
 * its certified SHA-256 and byte size — tests/helpers/c6-certification.ts) is
 * replayed end to end through the CURRENT production parser/replay contract.
 * Nothing is mocked and nothing is normalized by this file; every comparison
 * goes through the product's own code:
 *
 *   * `replayArchive()` (node-replay.ts) — the trusted production Node replay
 *     that finalize-import runs, with its own clock;
 *   * `parseArchiveBytes()` (archive-core.ts) — runtime 'node' + `nodeInflate`
 *     with a FIXED clock, twice, for the determinism clause;
 *   * `parseArchiveBytes()` — runtime 'browser_worker' + `browserInflate`
 *     (`DecompressionStream`), exactly what worker.ts runs, for runtime parity;
 *   * `readZipSafely()` / `classifyEntry()` (zip-reader.ts) — an independent
 *     read of the same central directory;
 *   * `compareParsedResults()` / `maskArchiveResult()` (api/_lib/parity.ts) —
 *     the comparator finalize-import itself applies.
 *
 * CERTIFIED PROPERTIES (one `it` each):
 *   C1  IDENTITY — the bytes are the certified archive; the replay's container
 *       fingerprint and parser identity (contract 1.2.0, SheetJS 0.20.3 at its
 *       pinned tarball digest, runtime 'node') are exact.
 *   C2  STRUCTURE — 71 archive entries: 57 accepted, 0 rejected, 14 excluded
 *       (8 lock files, 6 directories), confirmed by an independent ZIP read;
 *       the twelve aggregate totals are exact, equal the field-wise sum of the
 *       57 per-workbook totals, and equal an independent recount from the cell
 *       evidence itself.
 *   C3  FAMILIES — 52 individual-institution, 5 all-institutions, 0 unknown.
 *   C4  DIAGNOSTICS — exactly 50 DUPLICATE_HEADER_TEXT (all 'info'), one per
 *       duplicate header group, and nothing else at any severity.
 *   C5  RECORDS — 113950 source records, 7512 distinct (entry, targetEntity)
 *       pairs, 57 distinct entry fingerprints.
 *   C6  RUNTIME PARITY — browser Worker vs Node replay on the real corpus, both
 *       in memory and ASYMMETRICALLY (browser JSON vs Node in memory), which is
 *       what finalize-import really compares; the comparator is shown not to be
 *       vacuous.
 *   C7  DETERMINISM — two Node parses are JSON-identical; the production replay
 *       equals them once only `extractedAt` (and `runtime`) is masked.
 *   C8  BLANK ≠ ZERO — on all 75 sheets: a record exists at exactly the value
 *       cells below the header row; never at an explicit blank, never at a
 *       missing coordinate; every numeric zero stays a numeric zero record.
 *   C9b NO SILENT TRANSFORMATION, ANCHORED INDEPENDENTLY — each entry's own
 *       inflated bytes are re-read with the pinned SheetJS (production read
 *       options) and every record equals the raw cell at its coordinate through
 *       a type map written in this file; conversely every SheetJS value cell
 *       below the header row produced exactly one record.
 *   C9  NO UNIT CONVERSION / NO ADDED FIELDS — the record builder copies each
 *       CellEvidence verbatim (a consistency check of buildSourceRecords; C9b is
 *       the independent proof), and no key anywhere in the result introduces a
 *       unit/quantity/beneficiary/material/conversion field.
 *   C10 EXACT PROVENANCE — every record points back to its exact file
 *       fingerprint, archive path, sheet and 0-based coordinate.
 *   C11 NO FUZZY IDENTITY — entries are identified by content hash and exact
 *       archive path; family detection is a pure function of the non-empty
 *       sheet count (parser-core.ts `detectFamily`), never of header wording.
 *
 * WHERE THE FIGURES COME FROM. Every figure pinned below was RE-MEASURED on
 * this baseline (contract 1.2.0, SheetJS 0.20.3, Node 22) by running this very
 * file against the certified archive — none is copied from an earlier report.
 * In particular DUPLICATE_HEADER_TEXT is 50, not the 51 that
 * CORPUS-CONTRACT.md §1 still records: §4a of that document explains that the
 * 1.2.0 header predicate (a header must carry a VISIBLE character) retired
 * exactly one duplicate group made of single-space headers, and the replay
 * here confirms 50.
 *
 * WHAT IS NEVER IN THIS FILE. No cell text, file name, sheet name or cell
 * value from the corpus: only counts, hashes and 0-based coordinates. Failure
 * messages likewise name entry/sheet ordinals and A1 addresses, never content.
 *
 * GATING. 'C6 corpus identity gate' ALWAYS runs and proves the corpus gate
 * fails closed. The replay block runs only when PHOENIX_C6_CORPUS_ZIP is set;
 * without it the block is skipped and must be reported NOT_RUN — never as a
 * pass. No database and no network are used.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { C6_CORPUS, corpusConfigured, loadCertifiedCorpus, sha256Hex, workerPreviewJson } from './helpers/c6-certification';
import { parseArchiveBytes } from '../src/features/central-needs/import/archive-core';
import { browserInflate } from '../src/features/central-needs/import/browser-inflate';
import { nodeInflate } from '../src/features/central-needs/import/node-inflate';
import { replayArchive } from '../src/features/central-needs/import/node-replay';
import { classifyEntry, readZipSafely, type ZipReadResult } from '../src/features/central-needs/import/zip-reader';
import { DEFAULT_PARSER_LIMITS } from '../src/features/central-needs/import/contract';
import type {
  ArchiveParseResult, CellEvidence, FileParseResult, SheetEvidence, SourceValueRecordDraft, WorkbookFamily, WorkbookTotals,
} from '../src/features/central-needs/import/contract';
import { compareParsedResults, maskArchiveResult } from '../api/_lib/parity';
import * as XLSX from 'xlsx';

// ---- pinned figures (re-measured on this baseline; see header) --------------
const CERTIFIED = {
  byteSize: 942720,
  identity: {
    contractVersion: '1.2.0',
    sheetjsVersion: '0.20.3',
    sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  },
  zipEntries: 71,
  reconciliation: { filesTotal: 71, filesAccepted: 57, filesRejected: 0, filesExcluded: 14 },
  excluded: { lock_file: 8, directory: 6 },
  aggregateTotals: {
    sheetCount: 75,
    hiddenSheetCount: 9,
    hiddenNonEmptySheetCount: 8,
    emptySheetCount: 4,
    mergedRangeCount: 1104,
    formulaCellCount: 684,
    cachedFormulaNumericZeroCount: 410,
    cachedFormulaNumericNonZeroCount: 253,
    cachedFormulaErrorCount: 21,
    numericZeroCellCount: 45009,
    commentCount: 122,
    explicitBlankCellCount: 31824,
  } satisfies WorkbookTotals,
  families: { individual_institution_annual_needs: 52, all_institutions_annual_needs: 5 },
  diagnostics: { DUPLICATE_HEADER_TEXT: 50 },
  sourceRecords: 113950,
  targetEntities: 7512,
  distinctEntrySha256: 57,
  /** Numeric-zero records. See C8(e) for why this equals numericZeroCellCount. */
  numericZeroRecords: 45009,
} as const;

/** A fixed clock, so two Node parses can be compared byte for byte. */
const FIXED_NOW = () => '2026-01-01T00:00:00.000Z';

// ---- small, independent helpers ----------------------------------------------

/** 0-based (row, col) → conventional A1 address, written independently of SheetJS. */
function a1Of(row: number, col: number): string {
  let letters = '';
  for (let n = col + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    letters = String.fromCharCode(65 + ((n - 1) % 26)) + letters;
  }
  return `${letters}${row + 1}`;
}

const coordKey = (row: number, col: number) => `${row}:${col}`;
const sortedKeys = (o: object) => Object.keys(o).sort();
const hasOwn = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);

function tally<T>(items: Iterable<T>, key: (t: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const item of items) {
    const k = key(item);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/** Every string anywhere inside `node` (keys excluded). */
function* stringsIn(node: unknown): Generator<string> {
  if (typeof node === 'string') { yield node; return; }
  if (node === null || typeof node !== 'object') return;
  for (const v of Array.isArray(node) ? node : Object.values(node)) yield* stringsIn(v);
}

/** Every own key anywhere inside `root`, walked iteratively (the result holds millions of nodes). */
function allKeys(root: unknown): Set<string> {
  const keys = new Set<string>();
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const node = stack.pop();
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) { for (const v of node) stack.push(v); continue; }
    for (const [k, v] of Object.entries(node)) { keys.add(k); stack.push(v); }
  }
  return keys;
}

/** detectFamily's rule (parser-core.ts), restated: the non-empty sheet count alone decides the family. */
function familyByNonEmptySheetCount(nonEmptySheets: number): WorkbookFamily {
  if (nonEmptySheets >= 3) return 'all_institutions_annual_needs';
  if (nonEmptySheets >= 1) return 'individual_institution_annual_needs';
  return 'unknown';
}

/** One sheet of one accepted entry, with its records and a coordinate index of its cells. */
interface SheetView {
  entryIndex: number;
  entry: FileParseResult;
  sheet: SheetEvidence;
  cellAt: Map<string, CellEvidence>;
  records: SourceValueRecordDraft[];
}

function sheetViewsOf(result: ArchiveParseResult): SheetView[] {
  const views: SheetView[] = [];
  result.entries.forEach((entry, entryIndex) => {
    for (const sheet of entry.workbook!.sheets) {
      const cellAt = new Map<string, CellEvidence>();
      for (const cell of sheet.cells) cellAt.set(coordKey(cell.coordinate.row, cell.coordinate.col), cell);
      const records = entry.sourceRecords.filter((r) => r.sourceProvenance.sheetIndex === sheet.index);
      views.push({ entryIndex, entry, sheet, cellAt, records });
    }
  });
  return views;
}

/** A content-free label for a failure message: entry ordinal, sheet index, A1 address. */
const where = (v: SheetView, row: number, col: number) => `e${v.entryIndex}/s${v.sheet.index}/${a1Of(row, col)}`;

// ---------------------------------------------------------------------------
// (1) The corpus gate — always runs, needs no corpus
// ---------------------------------------------------------------------------

describe('C6 corpus identity gate', () => {
  it('fails closed: a substitute file, a relative path and a directory are refused; unset means not configured', () => {
    const original = process.env[C6_CORPUS.env];
    const dir = mkdtempSync(join(tmpdir(), 'c6-gate-'));
    try {
      // A few bytes that are not the certified archive.
      const impostor = join(dir, 'impostor.zip');
      writeFileSync(impostor, new Uint8Array([0x50, 0x4b, 0x05, 0x06, 0x00, 0x00, 0x00, 0x00]));
      process.env[C6_CORPUS.env] = impostor;
      expect(corpusConfigured()).toBe(true);
      expect(() => loadCertifiedCorpus()).toThrow(/refusing to substitute/);

      // Right size, wrong bytes: the SHA-256 check, not only the size check, refuses it.
      const sameSize = join(dir, 'same-size.zip');
      writeFileSync(sameSize, new Uint8Array(C6_CORPUS.byteSize));
      process.env[C6_CORPUS.env] = sameSize;
      expect(() => loadCertifiedCorpus()).toThrow(/refusing to substitute/);

      process.env[C6_CORPUS.env] = join('relative', 'corpus.zip');
      expect(() => loadCertifiedCorpus()).toThrow(/absolute/);

      process.env[C6_CORPUS.env] = dir;
      expect(() => loadCertifiedCorpus()).toThrow(/is not a file/);

      delete process.env[C6_CORPUS.env];
      expect(corpusConfigured()).toBe(false);
      expect(() => loadCertifiedCorpus()).toThrow(/is not set/);
    } finally {
      if (original === undefined) delete process.env[C6_CORPUS.env];
      else process.env[C6_CORPUS.env] = original;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// (2) The full real-corpus replay — only with the certified corpus
// ---------------------------------------------------------------------------

const run = corpusConfigured() ? describe : describe.skip;

run('C6 — full real-corpus replay against the certified archive (production parser contract)', { timeout: 300_000 }, () => {
  let bytes: Uint8Array;
  /** The production trusted path: replayArchive(), own clock. */
  let production: ArchiveParseResult;
  /** Two Node parses with a fixed clock (determinism). */
  let nodeFixedA: ArchiveParseResult;
  let nodeFixedB: ArchiveParseResult;
  /** The browser Worker's parse: runtime 'browser_worker', DecompressionStream inflate, own clock. */
  let browser: ArchiveParseResult;
  /** An independent read of the same central directory. */
  let zip: ZipReadResult;
  let views: SheetView[];

  beforeAll(async () => {
    bytes = loadCertifiedCorpus();
    production = await replayArchive(bytes, C6_CORPUS.archiveName);
    nodeFixedA = await parseArchiveBytes(bytes, C6_CORPUS.archiveName, { runtime: 'node', inflate: nodeInflate, now: FIXED_NOW });
    nodeFixedB = await parseArchiveBytes(bytes, C6_CORPUS.archiveName, { runtime: 'node', inflate: nodeInflate, now: FIXED_NOW });
    browser = await parseArchiveBytes(bytes, C6_CORPUS.archiveName, { runtime: 'browser_worker', inflate: browserInflate });
    zip = await readZipSafely(bytes, DEFAULT_PARSER_LIMITS, nodeInflate);
    views = sheetViewsOf(production);
  }, 600_000);

  it('C1 IDENTITY — the certified bytes, the exact container fingerprint and the pinned parser identity', () => {
    expect(sha256Hex(bytes)).toBe(C6_CORPUS.sha256);
    expect(bytes.byteLength).toBe(CERTIFIED.byteSize);
    expect(production.archive).toStrictEqual({
      originalFilename: C6_CORPUS.archiveName,
      sha256: C6_CORPUS.sha256,
      byteSize: CERTIFIED.byteSize,
    });
    const identity = { ...CERTIFIED.identity, runtime: 'node' };
    expect(production.identity).toStrictEqual(identity);
    // Every per-workbook result carries the same identity as the archive.
    for (const entry of production.entries) expect(entry.identity).toStrictEqual(identity);
  });

  it('C2 STRUCTURE — 71 entries (57 accepted, 0 rejected, 14 excluded) and the exact aggregate totals', () => {
    const { aggregateTotals, ...counts } = production.reconciliation;
    expect(counts).toStrictEqual(CERTIFIED.reconciliation);
    expect(production.excludedEntries).toHaveLength(CERTIFIED.reconciliation.filesExcluded);
    expect(tally(production.excludedEntries, (e) => e.reason)).toStrictEqual(CERTIFIED.excluded);
    expect(production.entries).toHaveLength(CERTIFIED.reconciliation.filesAccepted);
    expect(production.entries.every((e) => e.outcome === 'accepted')).toBe(true);
    expect(production.diagnostics).toStrictEqual([]);

    // Independent ZIP read: 71 safe entries; the excluded ones are exactly the
    // lock files and directories, and the accepted entries are the rest, in
    // central-directory order.
    expect(zip.safe).toBe(true);
    expect(zip.diagnostics).toStrictEqual([]);
    expect(zip.entries).toHaveLength(CERTIFIED.zipEntries);
    const classified = zip.entries.map((e) => ({ entry: e, c: classifyEntry(e.path) }));
    expect(classified.filter((x) => x.c.excluded).map((x) => ({ path: x.entry.path, reason: x.c.reason })))
      .toStrictEqual(production.excludedEntries);
    expect(classified.filter((x) => !x.c.excluded).map((x) => x.entry.path))
      .toStrictEqual(production.entries.map((e) => e.input.archiveEntryPath));

    // The exact aggregate totals.
    expect(aggregateTotals).toStrictEqual(CERTIFIED.aggregateTotals);

    // ...equal to the field-wise sum of the 57 per-workbook totals.
    const keys = sortedKeys(aggregateTotals) as Array<keyof WorkbookTotals>;
    for (const entry of production.entries) expect(sortedKeys(entry.workbook!.totals)).toStrictEqual(keys);
    const summed = Object.fromEntries(keys.map((k) => [k, production.entries.reduce((s, e) => s + e.workbook!.totals[k], 0)]));
    expect(summed).toStrictEqual(aggregateTotals);

    // ...and to an independent recount from the sheet and cell evidence itself.
    const sheets = production.entries.flatMap((e) => e.workbook!.sheets);
    expect(sheets).toHaveLength(CERTIFIED.aggregateTotals.sheetCount);
    expect(sheets.filter((s) => s.hidden !== 'visible')).toHaveLength(CERTIFIED.aggregateTotals.hiddenSheetCount);
    expect(sheets.filter((s) => s.nonEmptyCellCount === 0)).toHaveLength(CERTIFIED.aggregateTotals.emptySheetCount);
    const recount: WorkbookTotals = {
      sheetCount: 0, hiddenSheetCount: 0, hiddenNonEmptySheetCount: 0, emptySheetCount: 0, mergedRangeCount: 0,
      formulaCellCount: 0, cachedFormulaNumericZeroCount: 0, cachedFormulaNumericNonZeroCount: 0,
      cachedFormulaErrorCount: 0, numericZeroCellCount: 0, commentCount: 0, explicitBlankCellCount: 0,
    };
    const nonEmptyMismatches: string[] = [];
    for (const sheet of sheets) {
      const valueCells = sheet.cells.filter((c) => c.presence === 'value').length;
      if (valueCells !== sheet.nonEmptyCellCount) nonEmptyMismatches.push(`sheet ${sheet.index}`);
      recount.sheetCount += 1;
      if (sheet.hidden !== 'visible') {
        recount.hiddenSheetCount += 1;
        if (valueCells > 0) recount.hiddenNonEmptySheetCount += 1;
      }
      if (valueCells === 0) recount.emptySheetCount += 1;
      recount.mergedRangeCount += sheet.mergedRanges.length;
      for (const cell of sheet.cells) {
        if (cell.presence === 'blank') recount.explicitBlankCellCount += 1;
        if (cell.hasComment) recount.commentCount += 1;
        const numericZero = cell.presence === 'value' && cell.valueType === 'number' && cell.rawValue === 0;
        if (numericZero) recount.numericZeroCellCount += 1;
        if (!cell.isFormula) continue;
        recount.formulaCellCount += 1;
        if (cell.presence !== 'value') continue;
        if (cell.valueType === 'error') recount.cachedFormulaErrorCount += 1;
        else if (numericZero) recount.cachedFormulaNumericZeroCount += 1;
        else if (cell.valueType === 'number') recount.cachedFormulaNumericNonZeroCount += 1;
      }
    }
    expect(nonEmptyMismatches).toStrictEqual([]);
    expect(recount).toStrictEqual(CERTIFIED.aggregateTotals);
  });

  it('C3 FAMILIES — 52 individual-institution and 5 all-institutions workbooks, none unknown', () => {
    expect(tally(production.entries, (e) => e.family!.family)).toStrictEqual(CERTIFIED.families);
    expect(production.entries.some((e) => e.family!.family === 'unknown')).toBe(false);
    expect(production.entries.flatMap((e) => e.diagnostics).some((d) => d.code === 'FAMILY_UNRECOGNIZED')).toBe(false);
  });

  it('C4 DIAGNOSTICS — exactly 50 DUPLICATE_HEADER_TEXT (info), one per duplicate header group, nothing else', () => {
    const perEntry = production.entries.flatMap((e) => e.diagnostics);
    expect(tally(perEntry, (d) => d.code)).toStrictEqual(CERTIFIED.diagnostics);
    expect(perEntry.every((d) => d.severity === 'info')).toBe(true);
    const all = [...production.diagnostics, ...perEntry];
    expect(all.filter((d) => d.severity === 'fatal' || d.severity === 'error' || d.severity === 'warning')).toStrictEqual([]);

    // Each diagnostic is one duplicate header group of that very workbook.
    const groups = production.entries.map((e) => e.workbook!.sheets.reduce((n, s) => n + s.duplicateHeaderGroups.length, 0));
    expect(groups.reduce((a, b) => a + b, 0)).toBe(CERTIFIED.diagnostics.DUPLICATE_HEADER_TEXT);
    expect(production.entries.map((e) => e.diagnostics.length)).toStrictEqual(groups);
  });

  it('C5 RECORDS — 113950 source records over 7512 target entities in 57 distinct workbooks', () => {
    expect(production.entries.reduce((n, e) => n + e.sourceRecords.length, 0)).toBe(CERTIFIED.sourceRecords);
    const pairs = new Set<string>();
    production.entries.forEach((e, i) => { for (const r of e.sourceRecords) pairs.add(`${i}|${r.targetEntity}`); });
    expect(pairs.size).toBe(CERTIFIED.targetEntities);
    expect(new Set(production.entries.map((e) => e.input.sha256)).size).toBe(CERTIFIED.distinctEntrySha256);
  });

  it('C6 RUNTIME PARITY — the browser Worker parse equals the Node replay, in memory and as the uploaded JSON', () => {
    expect(browser.identity.runtime).toBe('browser_worker');
    expect(browser.entries.every((e) => e.identity.runtime === 'browser_worker')).toBe(true);

    // Symmetric: both in memory.
    expect(compareParsedResults(browser, production, 'archive')).toStrictEqual({ equal: true });

    // Asymmetric — the product path: the Worker result crosses postMessage and
    // JSON, and finalize-import compares that JSON with the Node replay held in
    // memory. An absent-vs-undefined key would fail here and nowhere else.
    const uploaded = JSON.parse(workerPreviewJson(browser));
    expect(compareParsedResults(uploaded, production, 'archive')).toStrictEqual({ equal: true });

    // Not vacuous: one reconciliation figure off by one is caught at its path.
    const tampered = { ...browser, reconciliation: { ...browser.reconciliation, filesAccepted: browser.reconciliation.filesAccepted - 1 } };
    expect(compareParsedResults(tampered, production, 'archive'))
      .toStrictEqual({ equal: false, difference: { path: 'reconciliation.filesAccepted', kind: 'value' } });
  });

  it('C7 DETERMINISM — two Node parses are JSON-identical; the production replay differs only by extractedAt', () => {
    const a = JSON.stringify(nodeFixedA);
    const b = JSON.stringify(nodeFixedB);
    expect(a.length).toBe(b.length);
    expect(sha256Hex(a)).toBe(sha256Hex(b));
    expect(a === b).toBe(true);
    expect(nodeFixedA.entries.every((e) => e.sourceRecords.every((r) => r.sourceProvenance.extractedAt === FIXED_NOW()))).toBe(true);

    // The production replay ran on its own clock; masked, it is byte-identical.
    expect(production.entries.every((e) => e.sourceRecords.every((r) => !Number.isNaN(Date.parse(r.sourceProvenance.extractedAt))))).toBe(true);
    const maskedProduction = JSON.stringify(maskArchiveResult(production));
    const maskedFixed = JSON.stringify(maskArchiveResult(nodeFixedA));
    expect(sha256Hex(maskedProduction)).toBe(sha256Hex(maskedFixed));
    expect(maskedProduction === maskedFixed).toBe(true);
    expect(compareParsedResults(production, nodeFixedA, 'archive')).toStrictEqual({ equal: true });
  });

  it('C8 BLANK ≠ ZERO — records exist at exactly the value cells below the header, never at a blank or missing cell', () => {
    const recordSetMismatches: string[] = [];
    const duplicateRecords: string[] = [];
    const recordsAtBlank: string[] = [];
    const recordsAtMissing: string[] = [];
    const zeroWithoutExactRecord: string[] = [];
    const nonBlankOrValueCells: string[] = [];
    let blankCells = 0;
    let zeroValueCellsBelowHeader = 0;
    let zeroValueCellsInHeaderRow = 0;
    let zeroRecords = 0;

    expect(views).toHaveLength(CERTIFIED.aggregateTotals.sheetCount);
    for (const v of views) {
      const { sheet, records, cellAt } = v;
      if (!sheet.usedRange) {
        // No declared extent: no cell was walked and no record can exist.
        expect(sheet.cells).toStrictEqual([]);
        expect(records).toStrictEqual([]);
        continue;
      }
      const header = sheet.usedRange.startRow;

      const expected = new Set<string>();
      for (const cell of sheet.cells) {
        const { row, col } = cell.coordinate;
        if (cell.presence !== 'blank' && cell.presence !== 'value') nonBlankOrValueCells.push(where(v, row, col));
        if (cell.presence === 'blank') blankCells += 1;
        if (cell.presence !== 'value') continue;
        if (row !== header) expected.add(coordKey(row, col));
        if (cell.valueType === 'number' && cell.rawValue === 0) {
          if (row === header) zeroValueCellsInHeaderRow += 1;
          else zeroValueCellsBelowHeader += 1;
        }
      }

      const recordAt = new Map<string, SourceValueRecordDraft>();
      for (const r of records) {
        const { row, col } = r.sourceProvenance.coordinate;
        const k = coordKey(row, col);
        if (recordAt.has(k)) duplicateRecords.push(where(v, row, col));
        recordAt.set(k, r);
        const cell = cellAt.get(k);
        if (!cell) recordsAtMissing.push(where(v, row, col));
        else if (cell.presence === 'blank') recordsAtBlank.push(where(v, row, col));
        const sv = r.sourceValues as { value: unknown; valueType: unknown };
        if (sv.valueType === 'number' && sv.value === 0) zeroRecords += 1;
      }

      // (a) record coordinates == value cells off the header row, exactly.
      const actual = [...recordAt.keys()].sort();
      const wanted = [...expected].sort();
      if (actual.length !== wanted.length || actual.some((k, i) => k !== wanted[i])) {
        recordSetMismatches.push(`e${v.entryIndex}/s${sheet.index}: ${actual.length} records vs ${wanted.length} value cells`);
      }

      // (d) every numeric zero below the header is a numeric-zero record, verbatim.
      for (const cell of sheet.cells) {
        if (cell.presence !== 'value' || cell.valueType !== 'number' || cell.rawValue !== 0) continue;
        const { row, col } = cell.coordinate;
        if (row === header) continue;
        const r = recordAt.get(coordKey(row, col));
        const sv = r?.sourceValues as Record<string, unknown> | undefined;
        const exact = sv !== undefined
          && sortedKeys(sv).join(',') === 'formula,isFormula,value,valueType'
          && Object.is(sv.value, 0)
          && sv.valueType === 'number'
          && sv.isFormula === cell.isFormula
          && sv.formula === (cell.formula ?? null);
        if (!exact) zeroWithoutExactRecord.push(where(v, row, col));
      }
    }

    expect(nonBlankOrValueCells).toStrictEqual([]);
    expect(recordSetMismatches).toStrictEqual([]);
    expect(duplicateRecords).toStrictEqual([]);
    // (b) never at an explicit blank, never at a coordinate with no cell.
    expect(recordsAtBlank).toStrictEqual([]);
    expect(recordsAtMissing).toStrictEqual([]);
    // (c) every explicit blank is still counted as a blank.
    expect(blankCells).toBe(CERTIFIED.aggregateTotals.explicitBlankCellCount);
    // (d)
    expect(zeroWithoutExactRecord).toStrictEqual([]);
    // (e) No numeric zero sits on any sheet's header row in this corpus, so all
    // 45009 numeric-zero cells (numericZeroCellCount) become numeric-zero
    // records — none dropped, none added, none turned blank.
    expect(zeroValueCellsInHeaderRow).toBe(0);
    expect(zeroValueCellsBelowHeader).toBe(CERTIFIED.numericZeroRecords);
    expect(zeroRecords).toBe(CERTIFIED.numericZeroRecords);
    expect(CERTIFIED.numericZeroRecords).toBe(CERTIFIED.aggregateTotals.numericZeroCellCount);
  });

  it('C9b NO SILENT TRANSFORMATION, ANCHORED — every record equals the cell an INDEPENDENT SheetJS read of the entry bytes finds at its coordinate', () => {
    // The anchor is NOT the parser's CellEvidence (from which records are built):
    // each entry's own inflated bytes (read by readZipSafely, fingerprint-checked)
    // are re-read here with the pinned SheetJS under the production XLS/XLSX read
    // options (parser-core.ts), and the record is compared with that raw cell
    // through a type map written in this file. A scaled number, a stripped unit
    // suffix, a re-typed text or a rewritten formula would all fail here.
    const dataByPath = new Map(zip.entries.filter((e) => e.data).map((e) => [e.path, e.data!]));
    const violations: string[] = [];
    let checked = 0;
    let sheetjsValueCells = 0;
    let headerRowValueCells = 0;
    for (const [entryIndex, entry] of production.entries.entries()) {
      const data = dataByPath.get(entry.input.archiveEntryPath!)!;
      expect(sha256Hex(data), `e${entryIndex}`).toBe(entry.input.sha256);
      expect(entry.workbook!.format, `e${entryIndex}`).not.toBe('csv'); // CSV would need raw:true
      const wb = XLSX.read(data, {
        type: 'array', cellFormula: true, cellHTML: false, cellText: true, cellDates: true,
        sheetStubs: true, bookVBA: true, WTF: false, dense: false,
      });
      for (const sheet of entry.workbook!.sheets) {
        const ws = wb.Sheets[wb.SheetNames[sheet.index]];
        const at = (a1: string) => `e${entryIndex}/s${sheet.index}/${a1}`;
        if (wb.SheetNames[sheet.index] !== sheet.name) violations.push(`e${entryIndex}/s${sheet.index}: sheet name`);
        const records = entry.sourceRecords.filter((r) => r.sourceProvenance.sheetIndex === sheet.index);
        const recordAt = new Set(records.map((r) => r.sourceProvenance.coordinate.a1));
        for (const r of records) {
          checked += 1;
          const { a1 } = r.sourceProvenance.coordinate;
          const c = ws[a1] as XLSX.CellObject | undefined;
          const sv = r.sourceValues as { value: unknown; valueType: string; isFormula: boolean; formula: string | null };
          if (!c) { violations.push(`${at(a1)}: no SheetJS cell`); continue; }
          if (c.t === 'z') { violations.push(`${at(a1)}: record at a SheetJS stub (blank)`); continue; }
          const want = ({
            n: () => ({ valueType: 'number', ok: Object.is(sv.value, c.v) }),
            s: () => ({ valueType: 'string', ok: sv.value === c.v }),
            b: () => ({ valueType: 'boolean', ok: sv.value === c.v }),
            d: () => ({ valueType: 'date', ok: c.v instanceof Date && sv.value === c.v.toISOString() }),
            e: () => ({ valueType: 'error', ok: typeof sv.value === 'string' && sv.value.startsWith('#')
              && (typeof c.w === 'string' && c.w.startsWith('#') ? sv.value === c.w : true) }),
          } as Record<string, () => { valueType: string; ok: boolean }>)[c.t]?.();
          if (!want) { violations.push(`${at(a1)}: unexpected SheetJS type ${c.t}`); continue; }
          if (sv.valueType !== want.valueType) violations.push(`${at(a1)}: valueType ${sv.valueType} for SheetJS type ${c.t}`);
          if (!want.ok) violations.push(`${at(a1)}: value differs from the SheetJS cell`);
          if (sv.formula !== (typeof c.f === 'string' ? c.f : null)) violations.push(`${at(a1)}: formula`);
          if (sv.isFormula !== (typeof c.f === 'string')) violations.push(`${at(a1)}: isFormula`);
        }
        // Converse: every SheetJS value cell inside the parser's used range, below its
        // header row, produced exactly one record — none dropped, none invented.
        const ur = sheet.usedRange;
        for (const key of Object.keys(ws)) {
          if (key.startsWith('!')) continue;
          const c = ws[key] as XLSX.CellObject;
          if (c.t === 'z') continue;
          const { r: row, c: col } = XLSX.utils.decode_cell(key);
          if (!ur || row < ur.startRow || row > ur.endRow || col < ur.startCol || col > ur.endCol) {
            violations.push(`${at(key)}: SheetJS value cell outside the parser's used range`);
            continue;
          }
          sheetjsValueCells += 1;
          if (row === ur.startRow) { headerRowValueCells += 1; continue; }
          if (!recordAt.has(a1Of(row, col))) violations.push(`${at(key)}: SheetJS value cell without a record`);
        }
      }
    }
    expect(violations).toStrictEqual([]);
    expect(checked).toBe(CERTIFIED.sourceRecords);
    expect(sheetjsValueCells - headerRowValueCells).toBe(CERTIFIED.sourceRecords);
  });

  it('C9 NO SILENT TRANSFORMATION / NO UNIT CONVERSION — the record builder copies each cell verbatim and adds no unit, quantity or identity field', () => {
    const allowedProvenance = new Set([
      'fileFingerprintSha256', 'originalFilename', 'parserVersion', 'archiveEntryPath', 'sheetIndex', 'sheetName',
      'sheetHidden', 'coordinate', 'extractedAt', 'columnHeaderEvidence',
    ]);
    const expectedTypeOf: Record<string, string> = { number: 'number', string: 'string', boolean: 'boolean', date: 'string', error: 'string' };
    const violations: string[] = [];
    let checked = 0;

    for (const v of views) {
      for (const r of v.records) {
        checked += 1;
        const { row, col } = r.sourceProvenance.coordinate;
        const at = where(v, row, col);
        if (sortedKeys(r).join(',') !== 'fieldName,sourceProvenance,sourceValues,targetEntity') violations.push(`${at}: record keys`);
        const sv = r.sourceValues as Record<string, unknown>;
        if (sortedKeys(sv).join(',') !== 'formula,isFormula,value,valueType') violations.push(`${at}: sourceValues keys`);
        const cell = v.cellAt.get(coordKey(row, col));
        if (!cell) { violations.push(`${at}: no cell`); continue; }
        if (!Object.is(sv.value, cell.rawValue)) violations.push(`${at}: value is not the raw cell value`);
        if (sv.valueType !== cell.valueType) violations.push(`${at}: valueType`);
        if (sv.isFormula !== cell.isFormula) violations.push(`${at}: isFormula`);
        if (sv.formula !== (cell.formula ?? null)) violations.push(`${at}: formula`);
        if (typeof sv.value !== expectedTypeOf[String(sv.valueType)]) violations.push(`${at}: JS type does not match valueType`);
        if (typeof sv.value === 'number' && !Number.isFinite(sv.value)) violations.push(`${at}: non-finite number`);
        for (const s of stringsIn(r)) if (s.includes('\u0000')) violations.push(`${at}: U+0000 in a string`);
        for (const k of Object.keys(r.sourceProvenance)) if (!allowedProvenance.has(k)) violations.push(`${at}: provenance key ${k}`);
      }
    }
    expect(checked).toBe(CERTIFIED.sourceRecords);
    expect(violations).toStrictEqual([]);

    // Unit evidence stays evidence: no key anywhere in the whole ArchiveParseResult
    // names a unit, quantity, beneficiary, institution, organization, catalog
    // item, material or conversion.
    const forbidden = /unit|quantit|beneficiar|institution|organization|central_?item|material|convert/i;
    expect([...allKeys(production)].filter((k) => forbidden.test(k))).toStrictEqual([]);
  });

  it('C10 EXACT PROVENANCE — every record names its exact file, archive path, sheet and 0-based coordinate', () => {
    const violations: string[] = [];
    for (const v of views) {
      const { entry, sheet } = v;
      const parserVersion = `${entry.identity.contractVersion}/${entry.identity.sheetjsVersion}`;
      const anchored = new Set<number>();
      for (const r of v.records) {
        const p = r.sourceProvenance;
        const { row, col } = p.coordinate;
        const at = where(v, row, col);
        if (p.fileFingerprintSha256 !== entry.input.sha256) violations.push(`${at}: fingerprint`);
        if (p.archiveEntryPath !== entry.input.archiveEntryPath) violations.push(`${at}: archiveEntryPath`);
        if (p.originalFilename !== entry.input.originalFilename) violations.push(`${at}: originalFilename`);
        if (p.parserVersion !== parserVersion) violations.push(`${at}: parserVersion`);
        const own = entry.workbook!.sheets[p.sheetIndex];
        if (own !== sheet || own.index !== p.sheetIndex) violations.push(`${at}: sheetIndex`);
        if (p.sheetName !== sheet.name) violations.push(`${at}: sheetName`);
        if (p.sheetHidden !== sheet.hidden) violations.push(`${at}: sheetHidden`);
        if (r.targetEntity !== `sheet:${p.sheetIndex}:row:${row}`) violations.push(`${at}: targetEntity`);
        if (sortedKeys(p.coordinate).join(',') !== 'a1,col,row') violations.push(`${at}: coordinate keys`);
        if (p.coordinate.a1 !== a1Of(row, col)) violations.push(`${at}: a1`);
        if (row === sheet.usedRange!.startRow) violations.push(`${at}: record on the header row`);
        // B2: header evidence rides only on the first-emitted record of its physical column.
        const isAnchor = !anchored.has(col);
        anchored.add(col);
        if (hasOwn(p, 'columnHeaderEvidence') !== isAnchor) violations.push(`${at}: columnHeaderEvidence anchor`);
        if (isAnchor && !Array.isArray(p.columnHeaderEvidence)) violations.push(`${at}: columnHeaderEvidence shape`);
      }
    }
    expect(violations).toStrictEqual([]);
    expect(CERTIFIED.identity.contractVersion + '/' + CERTIFIED.identity.sheetjsVersion).toBe('1.2.0/0.20.3');
    expect(production.entries.every((e) => e.sourceRecords.every((r) => r.sourceProvenance.parserVersion === '1.2.0/0.20.3'))).toBe(true);
  });

  it('C11 NO FUZZY IDENTITY — entries are content hashes at exact paths; family is decided by non-empty sheet count alone', () => {
    const dataByPath = new Map(zip.entries.filter((e) => e.data).map((e) => [e.path, e.data!]));
    const violations: string[] = [];
    production.entries.forEach((entry, i) => {
      if (sortedKeys(entry).join(',') !== 'diagnostics,family,identity,input,outcome,sourceRecords,workbook') violations.push(`e${i}: result keys`);
      if (sortedKeys(entry.input).join(',') !== 'archiveEntryPath,byteSize,originalFilename,sha256') violations.push(`e${i}: input keys`);
      if (sortedKeys(entry.family!).join(',') !== 'confidence,evidence,family') violations.push(`e${i}: family keys`);

      // The fingerprint is the SHA-256 of the exact inflated bytes, read independently.
      const data = dataByPath.get(entry.input.archiveEntryPath!);
      if (!data) violations.push(`e${i}: no independently read entry at its archive path`);
      else {
        if (sha256Hex(data) !== entry.input.sha256) violations.push(`e${i}: sha256`);
        if (data.byteLength !== entry.input.byteSize) violations.push(`e${i}: byteSize`);
      }
      if (entry.input.originalFilename !== entry.input.archiveEntryPath!.split('/').pop()) violations.push(`e${i}: basename`);

      // detectFamily (parser-core.ts): >= 3 non-empty sheets -> all_institutions,
      // 1..2 -> individual_institution, 0 -> unknown. Header wording can only
      // move the confidence (0.75 vs 0.55), never the family.
      const nonEmpty = entry.workbook!.sheets.filter((s) => s.nonEmptyCellCount > 0).length;
      if (entry.family!.family !== familyByNonEmptySheetCount(nonEmpty)) violations.push(`e${i}: family`);
      if (entry.family!.family === 'individual_institution_annual_needs' && entry.family!.confidence !== 0.55) violations.push(`e${i}: confidence`);
      if (entry.family!.family === 'all_institutions_annual_needs' && ![0.55, 0.75].includes(entry.family!.confidence)) violations.push(`e${i}: confidence`);
      if (entry.family!.evidence.length === 0) violations.push(`e${i}: family evidence empty`);
    });
    expect(violations).toStrictEqual([]);
    expect(production.entries).toHaveLength(CERTIFIED.reconciliation.filesAccepted);
  });
});
