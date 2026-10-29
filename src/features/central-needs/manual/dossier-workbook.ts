import type { CellEvidence, FileParseResult, SheetEvidence } from '../import/contract';
import { checkManualQuantityText } from './manual-quantity';
import { supabase } from '@/shared/supabase/client';
import { centralNeedsErrorFromPostgrest } from '../central-needs.service';

export interface WorkbookColumns { headerRow: number; name: number; code: number | null; quantity: number; unit: number }
export interface WorkbookSelection {
  sheet: number; row: number; quantity_column: number; name_column: number; code_column: number | null; unit_column: number; source_name: string; source_code: string | null;
  quantity_text: string; unit: string; item_id: string; beneficiary_id: string;
}
export interface WorkbookPreviewRow {
  sheet: number; row: number; quantityColumn: number; name: string; code: string | null;
  quantityText: string; unit: string; error: string | null;
}
export interface DossierSource { id: string; filename: string; file_hash: string; rows: number; revision_id: string }

export function quantityCellText(cell: CellEvidence | undefined): string | null {
  if (!cell || cell.presence !== 'value' || cell.isFormula) return null;
  if (cell.valueType === 'string' && typeof cell.rawValue === 'string') {
    return checkManualQuantityText(cell.rawValue).ok ? cell.rawValue : null;
  }
  // Numeric XLS cells are accepted only as safe integers. Decimal quantities must
  // be stored as text: never pretend JS floating-point restored source precision.
  if (cell.valueType === 'number' && typeof cell.rawValue === 'number' && Number.isSafeInteger(cell.rawValue) && cell.rawValue >= 0) {
    return String(cell.rawValue);
  }
  return null;
}

export function previewWorkbookRows(sheet: SheetEvidence, columns: WorkbookColumns): WorkbookPreviewRow[] {
  const required = [columns.name, columns.quantity, columns.unit, ...(columns.code === null ? [] : [columns.code])];
  if (!Number.isInteger(columns.headerRow) || columns.headerRow < 0 || required.some((i) => !Number.isInteger(i) || i < 0)
      || new Set(required).size !== required.length) throw new Error('workbook_columns_invalid');
  const cells = new Map(sheet.cells.map((c) => [`${c.coordinate.row}:${c.coordinate.col}`, c]));
  const rowIds = [...new Set(sheet.cells.map((c) => c.coordinate.row))].filter((r) => r > columns.headerRow).sort((a,b) => a-b);
  const text = (c: CellEvidence | undefined) => c?.presence === 'value' && c.valueType === 'string' && !c.isFormula ? String(c.rawValue) : '';
  const out: WorkbookPreviewRow[] = [];
  for (const row of rowIds) {
    if (!required.some((col) => cells.get(`${row}:${col}`)?.presence === 'value')) continue;
    const name = text(cells.get(`${row}:${columns.name}`));
    const unit = text(cells.get(`${row}:${columns.unit}`));
    const codeCell = columns.code === null ? undefined : cells.get(`${row}:${columns.code}`);
    const code = codeCell ? text(codeCell) || null : null;
    const quantity = quantityCellText(cells.get(`${row}:${columns.quantity}`));
    const badCode = codeCell?.presence === 'value' && (!code || code !== code.trim());
    out.push({ sheet: sheet.index, row: row + 1, quantityColumn: columns.quantity, name, code, quantityText: quantity ?? '', unit,
      error: quantity === null ? 'quantity_requires_canonical_text_or_safe_integer' : badCode ? 'national_code_requires_text' : !name.trim() || !unit.trim() ? 'name_and_unit_required' : null });
    if (out.length > 100) throw new Error('workbook_row_limit_100');
  }
  if (out.length === 0) throw new Error('workbook_no_rows');
  return out;
}

export async function parseDossierWorkbook(file: File): Promise<{ parsed: FileParseResult; bytes: Uint8Array }> {
  if (file.size === 0 || file.size > 3 * 1024 * 1024 || !/\.(xlsx|xls|csv)$/i.test(file.name)) throw new Error('workbook_file_limit_3mb');
  const bytes = new Uint8Array(await file.arrayBuffer());
  const parsed = await new Promise<FileParseResult>((resolve, reject) => {
    const worker = new Worker(new URL('../import/worker.ts', import.meta.url), { type: 'module' });
    const requestId = crypto.randomUUID();
    const timer = setTimeout(() => { worker.terminate(); reject(new Error('preview_timeout')); }, 30_000);
    const finish = () => { clearTimeout(timer); worker.terminate(); };
    worker.onmessage = (event) => {
      if (event.data.requestId !== requestId) return;
      finish();
      if (event.data.type !== 'result') reject(new Error('workbook_parse_failed'));
      else resolve(event.data.result as FileParseResult);
    };
    worker.onerror = () => { finish(); reject(new Error('preview_worker_error')); };
    // Original bytes remain available for source evidence; the worker gets a copy.
    const copy = bytes.slice().buffer;
    worker.postMessage({ type: 'parseWorkbook', requestId, bytes: copy, filename: file.name }, [copy]);
  });
  if (parsed.outcome === 'rejected' || !parsed.workbook) throw new Error('workbook_rejected');
  return { parsed, bytes };
}

export async function importDossierWorkbook(revisionId: string, filename: string, bytes: Uint8Array, rows: WorkbookSelection[]) {
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const fileHash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2, '0')).join('');
  let binary = '';
  for (let offset=0; offset<bytes.length; offset+=16_384) binary += String.fromCharCode(...bytes.subarray(offset, offset+16_384));
  const { data, error } = await supabase.rpc('phoenix_central_needs_import_dossier_workbook', {
    p_revision_id: revisionId, p_filename: filename, p_file_hash: fileHash, p_original_base64: btoa(binary), p_rows: rows,
  });
  if (error) {
    // supabase-js can return a transport failure as {error}, rather than throw.
    // Do not relabel an uncertain commit as a definitive business rejection.
    const code=typeof error.code==='string'?error.code:'';
    const definitive=(/^(22|23|25|28|40|42|55|P0)[0-9A-Z]{3}$/.test(code) && code!=='40003') || /^PGRST[23][0-9]{2}$/.test(code);
    if(definitive) throw centralNeedsErrorFromPostgrest(error);
    throw new Error('dossier_intake_outcome_unknown');
  }
  if (!data || data.ok !== true || typeof data.intake_id !== 'string' || data.rows !== rows.length) throw new Error('unconfirmed_dossier_intake');
  return { id: data.intake_id as string, rows: data.rows as number, replay: data.idempotent_replay === true };
}

export async function listDossierSources(planId: string): Promise<DossierSource[]> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_dossier_sources', { p_plan_id: planId });
  if (error) throw centralNeedsErrorFromPostgrest(error);
  return data ?? [];
}

export async function downloadDossierSource(intakeId: string): Promise<{ filename: string; bytes: Uint8Array }> {
  const { data, error } = await supabase.rpc('phoenix_central_needs_download_dossier_source', { p_intake_id: intakeId });
  if (error) throw centralNeedsErrorFromPostgrest(error);
  const binary = atob(data.base64);
  const bytes = Uint8Array.from(binary, (c) => c.charCodeAt(0));
  const digest = await crypto.subtle.digest('SHA-256', bytes.slice().buffer);
  const hash = [...new Uint8Array(digest)].map((v) => v.toString(16).padStart(2,'0')).join('');
  if (hash !== data.file_hash) throw new Error('dossier_source_integrity_failed');
  return { filename: data.filename, bytes };
}
