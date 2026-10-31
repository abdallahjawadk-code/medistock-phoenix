/** Pure, bounded identity adapter. No quantities, RPCs, registration, fuzzy matching or column discovery. */
import { CN2A_CONTRACT_VERSION, DEFAULT_PARSER_LIMITS, type CellEvidence, type FileParseResult } from '../import/contract';
import {
  SOURCE_IDENTITY_FIELDS, type AnnualCatalogScope, type AnnualSourceBlock,
  type AnnualSourceOccurrence, type SourceIdentityField, type SourceIdentityObservation,
  type SourceCellWitness,
} from './annual-catalog.contract';
import { assertAnnualScope, assertSameAnnualScope, annualScopeKey } from './annual-catalog.model';

export const ANNUAL_SOURCE_LIMITS = {
  maxRows: DEFAULT_PARSER_LIMITS.maxRows,
  maxColumns: DEFAULT_PARSER_LIMITS.maxCols,
  maxCells: DEFAULT_PARSER_LIMITS.maxCellsPerSheet,
  maxTextLength: 4000,
} as const;

export interface ExtractAnnualBlockInput {
  scope: AnnualCatalogScope;
  /** Confirmed year of THIS source use; never inferred from comparison/old-year columns. */
  sourceScope: AnnualCatalogScope;
  sourceId: string;
  parsed: FileParseResult;
  block: AnnualSourceBlock;
}

const natural = (n: number): boolean => Number.isInteger(n) && n >= 0;
const hasText = (value: string): boolean => typeof value === 'string' && value.trim().length > 0;
const controlText = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function address(row: number, col: number): string {
  let value = col + 1;
  let letters = '';
  while (value > 0) {
    value -= 1;
    letters = String.fromCharCode(65 + value % 26) + letters;
    value = Math.floor(value / 26);
  }
  return `${letters}${row + 1}`;
}

/** Copies only mapped identity/header cell evidence, never a reference to the input workbook. */
function copyCell(cell: CellEvidence): CellEvidence {
  return {
    coordinate: { ...cell.coordinate }, presence: cell.presence,
    ...(cell.valueType === undefined ? {} : { valueType: cell.valueType }), rawValue: cell.rawValue,
    ...(cell.errorCode === undefined ? {} : { errorCode: cell.errorCode }),
    ...(cell.formattedText === undefined ? {} : { formattedText: cell.formattedText }),
    isFormula: cell.isFormula, ...(cell.formula === undefined ? {} : { formula: cell.formula }),
    // Comments are not identity data; retain their existence without copying unrelated free text.
    hasComment: cell.hasComment,
  };
}

function observation(field: SourceIdentityField, cell: CellEvidence, header: CellEvidence): SourceIdentityObservation {
  const witness: SourceCellWitness = { field, cell: copyCell(cell), header: copyCell(header) };
  if (cell.presence === 'missing') return { state: 'missing', reason: 'missing_cell', witness };
  if (cell.presence === 'blank') return { state: 'missing', reason: 'blank', witness };
  if (cell.isFormula) return { state: 'invalid', reason: 'formula', witness };
  if (cell.valueType !== 'string' || typeof cell.rawValue !== 'string') return { state: 'invalid', reason: 'non_text', witness };
  if (cell.rawValue.length > ANNUAL_SOURCE_LIMITS.maxTextLength) return { state: 'invalid', reason: 'text_too_long', witness };
  if (controlText.test(cell.rawValue)) return { state: 'invalid', reason: 'control_text', witness };
  if (cell.rawValue.trim().length === 0) return { state: 'missing', reason: 'empty_text', witness };
  return { state: 'value', text: cell.rawValue, witness };
}

export function extractAnnualIdentityBlock(input: ExtractAnnualBlockInput): AnnualSourceOccurrence[] {
  const { scope, sourceScope, sourceId, parsed, block } = input;
  assertAnnualScope(scope);
  assertSameAnnualScope(scope, sourceScope);
  if (parsed.outcome !== 'accepted' || !parsed.workbook) throw new Error('annual_catalog_source_rejected');
  if (parsed.identity.contractVersion !== CN2A_CONTRACT_VERSION) throw new Error('annual_catalog_parser_contract_mismatch');
  if (!hasText(sourceId) || !hasText(parsed.input.originalFilename) || !/^[0-9a-f]{64}$/.test(parsed.input.sha256)
      || !Number.isSafeInteger(parsed.input.byteSize) || parsed.input.byteSize < 1) {
    throw new Error('annual_catalog_source_identity_invalid');
  }
  if (!hasText(block.blockId) || !hasText(block.mappingReference) || !natural(block.sheetIndex)
      || !natural(block.headerRow) || !natural(block.firstRow) || !natural(block.lastRow)
      || block.firstRow <= block.headerRow || block.lastRow < block.firstRow
      || block.lastRow - block.firstRow + 1 > ANNUAL_SOURCE_LIMITS.maxRows
      || block.lastRow >= ANNUAL_SOURCE_LIMITS.maxRows) throw new Error('annual_catalog_block_invalid');
  const sheets = parsed.workbook.sheets.filter((sheet) => sheet.index === block.sheetIndex);
  if (sheets.length !== 1) throw new Error('annual_catalog_sheet_unavailable');
  const sheet = sheets[0];
  if (sheet.cells.length > ANNUAL_SOURCE_LIMITS.maxCells) throw new Error('annual_catalog_cell_limit');
  if (Object.keys(block.columns).some((key) => !SOURCE_IDENTITY_FIELDS.includes(key as SourceIdentityField))) {
    throw new Error('annual_catalog_unknown_identity_field');
  }
  const columns = SOURCE_IDENTITY_FIELDS.flatMap((field) => block.columns[field] ? [block.columns[field]!] : []);
  if (!block.columns.scientificName || columns.some((binding) => !natural(binding.column)
      || binding.column >= ANNUAL_SOURCE_LIMITS.maxColumns || !hasText(binding.expectedHeaderText)
      || !natural(binding.headerRow ?? block.headerRow) || (binding.headerRow ?? block.headerRow) >= block.firstRow)
      || new Set(columns.map((binding) => binding.column)).size !== columns.length) {
    throw new Error('annual_catalog_columns_invalid');
  }
  const wanted = new Set(columns.map((binding) => binding.column));
  const headerCoordinates = new Set(columns.map((binding) => `${binding.headerRow ?? block.headerRow}:${binding.column}`));
  const cells = new Map<string, CellEvidence>();
  for (const cell of sheet.cells) {
    // Inspect coordinates only outside the requested identity block. Quantity and institution values are never read.
    const { row, col } = cell.coordinate;
    if (!natural(row) || !natural(col)) throw new Error('annual_catalog_coordinate_invalid');
    if (!wanted.has(col) || (!headerCoordinates.has(`${row}:${col}`) && (row < block.firstRow || row > block.lastRow))) continue;
    const key = `${row}:${col}`;
    if (cells.has(key) || cell.coordinate.a1 !== address(row, col)) throw new Error('annual_catalog_coordinate_invalid');
    cells.set(key, cell);
  }
  for (const binding of columns) {
    const header = cells.get(`${binding.headerRow ?? block.headerRow}:${binding.column}`);
    if (!header || header.presence !== 'value' || header.valueType !== 'string' || header.isFormula
        || header.rawValue !== binding.expectedHeaderText) throw new Error('annual_catalog_header_mismatch');
  }
  const out: AnnualSourceOccurrence[] = [];
  for (let row = block.firstRow; row <= block.lastRow; row += 1) {
    const fields = {} as Record<SourceIdentityField, SourceIdentityObservation>;
    let anyValue = false;
    for (const field of SOURCE_IDENTITY_FIELDS) {
      const binding = block.columns[field];
      if (!binding) { fields[field] = { state: 'missing', reason: 'unmapped', witness: null }; continue; }
      const cell = cells.get(`${row}:${binding.column}`) ?? {
        coordinate: { row, col: binding.column, a1: address(row, binding.column) },
        presence: 'missing' as const, rawValue: null, isFormula: false, hasComment: false,
      };
      if (cell.presence === 'value') anyValue = true;
      fields[field] = observation(field, cell, cells.get(`${binding.headerRow ?? block.headerRow}:${binding.column}`)!);
    }
    // Blank rows/quantity-only rows are not invented materials; incomplete identity rows remain reviewable.
    if (!anyValue) continue;
    out.push({
      occurrenceKey: JSON.stringify([annualScopeKey(scope), sourceId, parsed.input.sha256, sheet.index, block.blockId, row]),
      scope: { ...scope }, source: { sourceId, filename: parsed.input.originalFilename, sha256: parsed.input.sha256,
        parser: { ...parsed.identity }, sheetIndex: sheet.index, sheetName: sheet.name, row,
        blockId: block.blockId, mappingReference: block.mappingReference },
      classification: block.classification ? { ...block.classification } : null, fields,
    });
  }
  return out;
}
