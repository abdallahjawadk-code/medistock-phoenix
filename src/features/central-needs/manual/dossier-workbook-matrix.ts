import type { SheetEvidence } from '../import/contract';
import type { CatalogOption } from './manual-journey.service';
import { previewWorkbookRows, type WorkbookColumns, type WorkbookPreviewRow, type WorkbookSelection } from './dossier-workbook';

export interface MatrixRegion extends WorkbookColumns { sheet: number; firstRow: number; lastRow: number; beneficiaryId: string; quantityHeader?: string; beneficiaryLabel?: string }
export interface MatrixRow extends WorkbookPreviewRow {
  nameColumn: number; codeColumn: number | null; unitColumn: number; beneficiaryId: string;
  excluded: boolean; exclusionReason: string; matches: CatalogOption[]; selected: string;
}
export const cellKey = (r: Pick<WorkbookPreviewRow, 'sheet' | 'row' | 'quantityColumn'>) => `${r.sheet}:${r.row}:${r.quantityColumn}`;
// Typographic equivalence only. Never kit->test, pack->piece, or an implicit factor.
export const sameWorkbookUnit = (source: string, catalog: string) => source.replace(/^ +| +$/g, '').toLowerCase() === catalog.toLowerCase();
export function matrixRows(sheet: SheetEvidence, region: MatrixRegion): MatrixRow[] {
  if (region.sheet !== sheet.index || !region.beneficiaryId) throw new Error('workbook_region_invalid');
  return previewWorkbookRows(sheet, region, region).map((r) => ({ ...r, nameColumn: region.name, codeColumn: region.code,
    unitColumn: region.unit, beneficiaryId: region.beneficiaryId, excluded: false, exclusionReason: '', matches: [], selected: '' }));
}
export function appendMatrixRegion(old: MatrixRow[], added: MatrixRow[]): MatrixRow[] {
  const seen = new Set(old.map(cellKey));
  if (old.length + added.length > 10000 || added.some((r) => seen.has(cellKey(r)))) throw new Error('workbook_duplicate_or_excessive_region');
  return [...old, ...added];
}
export function matchingOption(row: MatrixRow): CatalogOption | undefined {
  return row.matches.find((m) => m.id === row.selected && sameWorkbookUnit(row.unit, m.unit)
    && (!row.code || m.nationalCode === row.code));
}
export function capturedMatrix(rows: MatrixRow[]): { selections: WorkbookSelection[]; exclusions: {sheet: number; row: number; quantity_column: number; reason: string}[] } {
  const selections: (WorkbookSelection & { source_unit: string })[] = [];
  const exclusions: {sheet: number; row: number; quantity_column: number; reason: string}[] = [];
  const scopes = new Set<string>(); const cells = new Set<string>();
  for (const row of rows) {
    const key = cellKey(row);
    if (cells.has(key)) throw new Error('workbook_duplicate_cell');
    cells.add(key);
    if (row.excluded) {
      if (row.exclusionReason.trim().length < 3 || row.exclusionReason.length > 500) throw new Error('workbook_exclusion_reason_required');
      exclusions.push({sheet: row.sheet, row: row.row, quantity_column: row.quantityColumn, reason: row.exclusionReason});
      continue;
    }
    const material = matchingOption(row);
    if (row.error || !material) throw new Error('workbook_unresolved_row');
    const scope = `${row.beneficiaryId}:${material.id}`;
    if (scopes.has(scope)) throw new Error('workbook_duplicate_scope');
    scopes.add(scope);
    selections.push({sheet: row.sheet, row: row.row, quantity_column: row.quantityColumn, name_column: row.nameColumn,
      code_column: row.codeColumn, unit_column: row.unitColumn, source_name: row.name, source_code: row.code,
      source_unit: row.unit, quantity_text: row.quantityText, unit: material.unit, item_id: material.id, beneficiary_id: row.beneficiaryId});
  }
  if (!selections.length || selections.length > 10000 || exclusions.length > 20000) throw new Error('workbook_no_resolved_rows');
  return {selections, exclusions};
}
