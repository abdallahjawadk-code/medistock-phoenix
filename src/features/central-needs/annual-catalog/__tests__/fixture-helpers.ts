import { readFileSync } from 'node:fs';
import {
  CN2A_CONTRACT_VERSION, SHEETJS_VERSION, SHEETJS_TARBALL_SHA256, emptyWorkbookTotals,
  type CellEvidence, type FileParseResult,
} from '../../import/contract';
import type { AnnualSourceBlock, SourceIdentityField } from '../annual-catalog.contract';
import type { ExtractAnnualBlockInput } from '../annual-catalog-source';

export const SCOPE = { ownerOrgId: 'owner-a', planningYear: 2026 };

interface StructuralSample {
  sampleId: string;
  year: number;
  syntheticSource: { filename: string; sha256: string; sheetIndex: number; sheetName: string; classification: string };
  blockSelection: {
    blockId: string; headerRow: number; firstRow: number; lastRow: number;
    columnMap: Partial<Record<SourceIdentityField, number>>;
  };
  cells: CellEvidence[];
}

export const structuralFixture = JSON.parse(readFileSync(new URL('./fixtures/2026-catalog-structural.json', import.meta.url), 'utf8')) as {
  fixtureKind: string; originalQuantityOrInstitutionCellsIncluded: boolean; samples: StructuralSample[];
};

export function parsedEvidence(cells: CellEvidence[]): FileParseResult {
  return {
    outcome: 'accepted',
    identity: { contractVersion: CN2A_CONTRACT_VERSION, sheetjsVersion: SHEETJS_VERSION,
      sheetjsTarballSha256: SHEETJS_TARBALL_SHA256, runtime: 'node' },
    input: { originalFilename: 'synthetic.xlsx', sha256: 'a'.repeat(64), byteSize: 100 },
    workbook: { format: 'xlsx', vbaPresent: false, totals: emptyWorkbookTotals(), sheets: [{
      index: 0, name: 'Identity', hidden: 'visible', usedRange: null, nonEmptyCellCount: cells.length,
      cells, mergedRanges: [], duplicateHeaderGroups: [],
    }] },
    family: null, diagnostics: [], sourceRecords: [],
  };
}

export function cell(row: number, col: number, rawValue: string | number | null, a1?: string): CellEvidence {
  return {
    coordinate: { row, col, a1: a1 ?? `${String.fromCharCode(65 + col)}${row + 1}` },
    presence: rawValue === null ? 'blank' : 'value',
    ...(rawValue === null ? {} : { valueType: typeof rawValue === 'string' ? 'string' as const : 'number' as const }),
    rawValue, isFormula: false, hasComment: false,
  };
}

export function simpleInput(): ExtractAnnualBlockInput {
  return { scope: { ...SCOPE }, sourceScope: { ...SCOPE }, sourceId: 'source-a',
    parsed: parsedEvidence([
      cell(0, 0, 'Name'), cell(0, 1, 'National code'), cell(0, 2, 'Unit'),
      cell(1, 0, 'Amoxicillin 500 mg'), cell(1, 1, '000123-04'), cell(1, 2, 'box'),
    ]), block: { blockId: 'medicines', sheetIndex: 0, headerRow: 0, firstRow: 1, lastRow: 1,
      mappingReference: 'synthetic-reviewed-profile', classification: null,
      columns: { scientificName: { column: 0, expectedHeaderText: 'Name' },
        nationalCode: { column: 1, expectedHeaderText: 'National code' }, unit: { column: 2, expectedHeaderText: 'Unit' } },
    },
  };
}

export function structuralInput(sampleId: string): ExtractAnnualBlockInput {
  const sample = structuralFixture.samples.find((entry) => entry.sampleId === sampleId);
  if (!sample) throw new Error('fixture_sample_missing');
  const { blockSelection: region, syntheticSource: source } = sample;
  const columns: AnnualSourceBlock['columns'] = {};
  for (const [field, column] of Object.entries(region.columnMap)) {
    const header = sample.cells.find((entry) => entry.coordinate.col === column && entry.coordinate.row <= region.headerRow);
    if (!header || typeof header.rawValue !== 'string') throw new Error('fixture_header_missing');
    columns[field as SourceIdentityField] = { column, headerRow: header.coordinate.row, expectedHeaderText: header.rawValue };
  }
  const parsed = parsedEvidence(structuredClone(sample.cells));
  parsed.input = { originalFilename: source.filename, sha256: source.sha256, byteSize: 100 };
  parsed.workbook!.sheets[0].name = source.sheetName;
  return { scope: { ...SCOPE }, sourceScope: { ...SCOPE, planningYear: sample.year }, sourceId: source.filename,
    parsed, block: { blockId: region.blockId, sheetIndex: 0, headerRow: region.headerRow,
      firstRow: region.firstRow, lastRow: region.lastRow, columns,
      mappingReference: 'sanitized-2026-structural-fixture-not-original-replay',
      classification: { label: source.classification, origin: 'proposed', reference: 'synthetic-classification' } },
  };
}
