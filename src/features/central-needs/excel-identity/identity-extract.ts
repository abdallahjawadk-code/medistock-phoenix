/**
 * R1-A3 — OPTIONAL Excel assistance for medicine IDENTITY only.
 *
 * Product invariant (D27 / EXT-EXCEL-IDENTITY-v1.0): a workbook may help the person find the right
 * registered medicine. It never supplies an annual requirement. This module therefore:
 *   * REQUIRES the person to have confirmed the header row. There is no automatic header discovery: without a
 *     confirmed `headerRow` nothing is read and the result asks for the confirmation (type level AND run time);
 *   * reads, for a confirmed header, ONLY (a) the header row, to locate columns by their label, and (b) the cells of the
 *     identity columns of each data row. Every other cell — in particular any column that looks like a quantity, and
 *     every row above the header — is never touched;
 *   * accepts identity values as TEXT only (a numeric cell is never a name, strength, form or unit; a code may be a
 *     6–14 digit integer), so a quantity column sitting under a header that merely looks like an identity header
 *     yields nothing instead of leaking its numbers;
 *   * returns text identity candidates with provenance (sheet / row / column) and no numeric field.
 * It is a pure function: no network, no storage, no clock.
 */

export type CellValue = string | number | boolean | null | undefined;
export type SheetCells = ReadonlyArray<ReadonlyArray<CellValue>>;

export type IdentityField = 'name' | 'tradeName' | 'strength' | 'form' | 'unit' | 'code';

export interface IdentityCandidate {
  sheetIndex: number;
  /** Zero-based row of the source sheet. */
  row: number;
  name: string;
  tradeName: string | null;
  strength: string | null;
  form: string | null;
  unit: string | null;
  code: string | null;
  /** Where each identity value came from (column indexes only). */
  columns: Partial<Record<IdentityField, number>>;
}

export type IdentityWarning =
  | 'header_confirmation_required' | 'no_header'
  | 'no_name_column' | 'ambiguous_name_column' | 'name_column_not_text'
  | 'sheet_too_large' | 'row_without_name' | 'header_like_row';

export interface IdentityExtraction {
  headerRow: number | null;
  candidates: IdentityCandidate[];
  warnings: IdentityWarning[];
}

/** The person-confirmed header row (zero-based). REQUIRED: there is deliberately no default and no discovery. */
export interface ExtractOptions {
  headerRow: number;
}

const MAX_ROWS = 5000;
const MAX_COLS = 64;
const MAX_CELL_CHARS = 300;

const norm = (v: CellValue): string =>
  String(v ?? '')
    .normalize('NFKC')
    .replace(/[ً-ٰٟـ]/g, '')           // tashkeel + tatweel
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه')
    .toLowerCase()
    .replace(/[\s_\-./\\:()[\]]+/g, ' ')
    .trim();

const ALIASES: Record<IdentityField | 'quantity', readonly string[]> = {
  name: ['name', 'item', 'item name', 'drug', 'drug name', 'medicine', 'medicine name', 'generic', 'generic name', 'scientific name', 'description',
    'اسم المادة', 'اسم الدواء', 'اسم', 'المادة', 'الدواء', 'الاسم العلمي', 'الاسم', 'وصف المادة', 'البيان'],
  tradeName: ['trade name', 'brand', 'brand name', 'اسم تجاري', 'الاسم التجاري', 'العلامه التجاريه'],
  strength: ['strength', 'concentration', 'dose', 'dosage', 'potency', 'التركيز', 'القوه', 'الجرعه', 'العيار'],
  form: ['form', 'dosage form', 'pharmaceutical form', 'الشكل الصيدلاني', 'الشكل', 'نوع الدواء'],
  unit: ['unit', 'uom', 'pack', 'package', 'package unit', 'الوحده', 'العبوه', 'وحده القياس'],
  code: ['code', 'item code', 'national code', 'drug code', 'barcode', 'الرمز', 'رمز المادة', 'الكود', 'الرقم الوطني', 'الباركود', 'رمز'],
  // recognised so the column can be IGNORED; its cells are never read
  quantity: ['qty', 'quantity', 'amount', 'annual need', 'annual requirement', 'annual quantity', 'required quantity', 'need', 'total', 'count',
    'الكميه', 'الكمية', 'الاحتياج', 'الاحتياج السنوي', 'الكميه المطلوبه', 'العدد', 'المجموع'],
};
const ALIAS_SETS = Object.fromEntries(
  (Object.keys(ALIASES) as Array<keyof typeof ALIASES>).map((k) => [k, new Set(ALIASES[k].map(norm))]),
) as Record<keyof typeof ALIASES, Set<string>>;

const fieldOfHeader = (cell: CellValue): keyof typeof ALIASES | null => {
  const n = norm(cell);
  if (n === '') return null;
  for (const k of Object.keys(ALIAS_SETS) as Array<keyof typeof ALIASES>) if (ALIAS_SETS[k].has(n)) return k;
  return null;
};

const HAS_LETTER = /\p{L}/u;
const cleanText = (v: CellValue): string | null => {
  if (typeof v !== 'string') return null;
  const s = v.normalize('NFKC').replace(/[\u0000-\u001F\u007F]/g, ' ').replace(/\s+/g, ' ').trim();
  if (s === '') return null;
  // formula text is data, never an instruction
  const safe = /^[=+\-@]/.test(s) ? `'${s}` : s;
  return safe.slice(0, MAX_CELL_CHARS);
};
const cleanCode = (v: CellValue): string | null => {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 1e5 && v < 1e14 ? String(v) : null;
  return cleanText(v);
};

const refuse = (warning: IdentityWarning, headerRow: number | null = null): IdentityExtraction => ({ headerRow, candidates: [], warnings: [warning] });

export function extractIdentityCandidates(sheet: SheetCells, sheetIndex: number, options: ExtractOptions): IdentityExtraction {
  // FAIL SAFE: no confirmed header => nothing is read. Checked at run time as well as by the type, because the options
  // object may come from untyped UI state.
  const requested = (options as { headerRow?: unknown } | null | undefined)?.headerRow;
  if (requested === undefined || requested === null) return refuse('header_confirmation_required');
  if (!Number.isInteger(requested) || (requested as number) < 0 || (requested as number) >= sheet.length) return refuse('no_header');
  if (sheet.length > MAX_ROWS) return refuse('sheet_too_large');
  const headerRow = requested as number;

  const header = sheet[headerRow].slice(0, MAX_COLS);
  const cols: Partial<Record<IdentityField, number[]>> = {};
  header.forEach((cell, c) => {
    const f = fieldOfHeader(cell);
    if (f === null || f === 'quantity') return;          // quantity (and unrecognised) columns: never read
    (cols[f] ??= []).push(c);
  });

  if (!cols.name) return refuse('no_name_column', headerRow);
  if (cols.name.length > 1) return refuse('ambiguous_name_column', headerRow);

  const pick = (f: IdentityField): number | undefined => (cols[f] && cols[f]!.length === 1 ? cols[f]![0] : undefined);
  const idx: Partial<Record<IdentityField, number>> = {};
  for (const f of ['name', 'tradeName', 'strength', 'form', 'unit', 'code'] as const) {
    const c = pick(f);
    if (c !== undefined) idx[f] = c;
  }

  const warnings: IdentityWarning[] = [];
  const candidates: IdentityCandidate[] = [];
  let emptyNameRows = 0;
  let rejectedNames = 0;
  let headerLike = 0;
  for (let r = headerRow + 1; r < sheet.length; r += 1) {
    const row = sheet[r];
    const text = (f: IdentityField) => (idx[f] === undefined ? null : cleanText(row[idx[f]!]));
    const name = text('name');
    if (name !== null && fieldOfHeader(name) !== null) { headerLike += 1; continue; }   // a repeated / misplaced header line
    if (name === null || !HAS_LETTER.test(name)) {
      if (name !== null || (idx.name !== undefined && typeof row[idx.name] === 'number')) rejectedNames += 1;
      // a row with any other identity text but no name is reported, never guessed
      if (name === null && (text('tradeName') !== null || (idx.code !== undefined && cleanCode(row[idx.code]) !== null))) emptyNameRows += 1;
      continue;
    }
    candidates.push({
      sheetIndex, row: r, name, tradeName: text('tradeName'), strength: text('strength'), form: text('form'),
      unit: text('unit'), code: idx.code === undefined ? null : cleanCode(row[idx.code]), columns: { ...idx },
    });
  }
  if (candidates.length === 0 && rejectedNames > 0) return refuse('name_column_not_text', headerRow);
  if (headerLike > 0) warnings.push('header_like_row');
  if (emptyNameRows > 0) warnings.push('row_without_name');
  return { headerRow, candidates, warnings };
}
