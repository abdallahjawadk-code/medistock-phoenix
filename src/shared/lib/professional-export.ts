/**
 * EXPORT-PROFESSIONAL-XLSX-PDF-A / EXPORT-PROFESSIONAL-XLSX-PDF-B
 *
 * Shared "professional export" config layer.
 *
 * EXPORT-PROFESSIONAL-XLSX-PDF-B: real `.xlsx` workbook generation via the
 * now-approved `exceljs` dependency (see package.json) replaces the earlier
 * CSV-as-"Excel" approach as the PRIMARY export path. `exportProfessionalCsv`
 * is kept only as a legacy/optional fallback (not wired to any screen) —
 * see its doc comment. PDF/print continues to use the existing
 * dependency-free browser print-to-PDF path (openPrintWindow /
 * MobilePrintFallbackModal) — no PDF library was added, per this phase's
 * explicit rules (jsPDF/pdfmake/pdf-lib are out of scope).
 *
 * Built on top of the existing primitives in reportExport.ts (escHtml,
 * buildStableFileName, downloadTextFile, buildCsvContent, openPrintWindow,
 * isLikelyMobilePrintContext) plus ExcelJS for the workbook.
 *
 * EXPORT-XLSX-DYNAMIC-IMPORT-A: ExcelJS (~900KB) is loaded via a lazy
 * `import('exceljs')` inside `buildProfessionalWorkbook`/`loadExcelJS`
 * instead of a top-level static import, so it code-splits into its own
 * chunk and is only fetched when a user actually triggers an Excel export —
 * not on initial app load. Only a `import type` (type-only, erased at
 * compile time, zero runtime cost) remains at module scope for TypeScript
 * signatures. `buildPremiumPrintHtml`/`triggerProfessionalPrint` (PDF/print)
 * never touch ExcelJS at all, at compile time or runtime.
 */

import type ExcelJS from 'exceljs';
import { displaySupplyType } from './supply-types';
import {
  REPORT_BRAND,
  escHtml,
  buildStableFileName,
  downloadTextFile,
  buildCsvContent,
  openPrintWindow,
  isLikelyMobilePrintContext,
  type ReportColumn,
} from './reportExport';
import { formatStableDateTime, formatStableDate } from './date';

export type { ReportColumn };

/** Matches a canonical UUID (v1-v5) string, case-insensitively. */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Column keys that are always treated as internal/raw identifiers unless explicitly allowed. */
const ID_LIKE_KEY_RE = /^(id|uuid|token|public_id)$/i;
const ID_LIKE_SUFFIX_RE = /_id$/i;

/** Brand teal/navy used across the premium XLSX/print templates (mirrors the app's --p/--t design tokens as fixed hex, since exports must not depend on the on-screen theme). */
const BRAND_TEAL = 'FF0D9488';
const BRAND_NAVY = 'FF0F2B4F';
const BRAND_ALT_ROW = 'FFF3F7FB';
const BRAND_BORDER = 'FFC7D3E0';
const SEVERITY_FILL: Record<'err' | 'warn' | 'ok', string> = { err: 'FFDC2626', warn: 'FFD97706', ok: 'FF059669' };

/**
 * A ReportColumn extended with optional Excel-specific hints. All extra
 * fields are optional, so any existing `ReportColumn<T>[]` (CSV/print-only)
 * remains a valid `ProfessionalReportColumn<T>[]` as-is.
 */
export interface ProfessionalReportColumn<T> extends ReportColumn<T> {
  /** Raw underlying value for the Excel cell (Date/number/ISO string/null) — used instead of value() so the workbook gets a real typed cell, not pre-formatted text. */
  excelValue?: (row: T) => string | number | Date | null | undefined;
  /** Marks a date/datetime column: real Excel Date cell + explicit numFmt + a wide-enough column (never `###`). */
  dateColumn?: 'date' | 'datetime';
  /** Marks a numeric column: real Excel number cell, right-aligned. */
  numeric?: boolean;
}

export interface ProfessionalExportLabels {
  generatedAt: string;
  filtersSummary: string;
  rowCount: string;
  /** Only rendered when `generatedBy` is also provided. */
  generatedBy?: string;
}

export interface ProfessionalExportConfig<T> {
  reportTitle: string;
  moduleName?: string;
  generatedAt: Date;
  /** Only surfaced if already known from existing session/auth state — never fetched for this. */
  generatedBy?: string | null;
  filtersSummary: string;
  columns: ProfessionalReportColumn<T>[];
  rows: T[];
  /** Defaults to rows.length; pass explicitly when rows is a truncated/paged sample of a larger result. */
  rowCount?: number;
  lang: 'ar' | 'en';
  fileNameBase: string;
  emptyMessage?: string;
  footerText: string;
  /** Must be true (and reviewed) to allow a column carrying a raw UUID/internal id through to the export. */
  allowRawIdColumns?: boolean;
  /** Optional per-row severity hint for premium print/XLSX color-coding — a semantic token, never a raw hex/color string. */
  rowAccent?: (row: T) => 'err' | 'warn' | 'ok' | undefined;
  labels: ProfessionalExportLabels;
}

/**
 * Neutralizes formula/control-sequence injection: any value beginning with
 * =, +, -, @, a tab, or an ASCII control character is prefixed with a plain
 * apostrophe, forcing spreadsheet software to treat it as literal text.
 * Superset of reportExport.ts's csvSafeCell (which only covers =+-@).
 */
export function neutralizeFormulaValue(v: string): string {
  return /^[=+\-@\t]|^[\x00-\x1F]/.test(v) ? `'${v}` : v;
}

/**
 * Drops id/uuid/token-named columns and, for the remaining columns, blanks
 * out any individual cell value that is itself a raw UUID string — both
 * guards are skipped when `allowRawIdColumns` is true (an explicit,
 * reviewed opt-in).
 */
export function sanitizeReportColumns<T>(columns: ProfessionalReportColumn<T>[], allowRawIdColumns = false): ProfessionalReportColumn<T>[] {
  if (allowRawIdColumns) return columns;
  return columns
    .filter(c => !ID_LIKE_KEY_RE.test(c.key) && !ID_LIKE_SUFFIX_RE.test(c.key))
    .map(c => ({
      ...c,
      value: (r: T) => {
        const v = c.value(r);
        return UUID_RE.test(v.trim()) ? '—' : v;
      },
    }));
}

/**
 * Converts an ISO string, date-only string, `Date` object, or null/
 * undefined/invalid input into a real `Date` — or `null` if the input is
 * missing or unparseable. Never returns an `Invalid Date`. Used to populate
 * real Excel date cells (paired with an explicit numFmt) instead of
 * pre-formatted text, so Excel can widen/sort/filter the column correctly.
 */
export function formatExportDateCell(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return isNaN(d.getTime()) ? null : d;
}

/** Locale-stable, bidi-safe date text (delegates to date.ts's formatStableDate) — the safe fallback for print/PDF and for any date whose value can't become a real Excel Date cell. Never "Invalid Date". */
export function formatExportDateText(value: string | Date | null | undefined, lang: 'ar' | 'en'): string {
  return formatStableDate(value, lang);
}

/** Wraps every column's value() with neutralizeFormulaValue. */
function withFormulaSafety<T>(columns: ProfessionalReportColumn<T>[]): ProfessionalReportColumn<T>[] {
  return columns.map(c => ({ ...c, value: (r: T) => neutralizeFormulaValue(c.value(r)) }));
}

function buildMetaLines<T>(config: ProfessionalExportConfig<T>): { label: string; value: string; ltr?: boolean }[] {
  const lines: { label: string; value: string; ltr?: boolean }[] = [
    { label: config.labels.generatedAt, value: formatStableDateTime(config.generatedAt, config.lang), ltr: true },
    { label: config.labels.filtersSummary, value: config.filtersSummary },
    { label: config.labels.rowCount, value: String(config.rowCount ?? config.rows.length) },
  ];
  if (config.generatedBy && config.labels.generatedBy) {
    lines.push({ label: config.labels.generatedBy, value: config.generatedBy });
  }
  return lines;
}

function sanitizedColumns<T>(config: ProfessionalExportConfig<T>): ProfessionalReportColumn<T>[] {
  return withFormulaSafety(sanitizeReportColumns(config.columns, config.allowRawIdColumns));
}

/** Excel sheet names: max 31 chars, no : \ / ? * [ ]. Falls back to "Report" if the cleaned name is empty. */
function safeSheetName(name: string): string {
  const cleaned = name.replace(/[:\\/?*[\]]/g, ' ').replace(/\s+/g, ' ').trim();
  return (cleaned || 'Report').slice(0, 31);
}

/** Column width tuned to avoid the classic Excel "###" narrow-date-column problem, and to give numeric/text columns sane defaults. */
function columnWidth<T>(c: ProfessionalReportColumn<T>): number {
  if (c.dateColumn === 'datetime') return 20;
  if (c.dateColumn === 'date') return 16;
  if (c.numeric) return 12;
  return Math.min(40, Math.max(14, c.label.length + 6));
}

function resolveCellValue<T>(c: ProfessionalReportColumn<T>, row: T): { value: string | number | Date; numFmt?: string } {
  if (c.dateColumn) {
    const raw = c.excelValue ? c.excelValue(row) : c.value(row);
    const d = formatExportDateCell(raw as string | Date | null | undefined);
    if (d) return { value: d, numFmt: c.dateColumn === 'datetime' ? 'yyyy-mm-dd hh:mm' : 'yyyy-mm-dd' };
    return { value: '—' }; // null/undefined/invalid date — never "Invalid Date", never left blank-and-ambiguous
  }
  if (c.numeric) {
    const raw = c.excelValue ? c.excelValue(row) : c.value(row);
    const n = typeof raw === 'number' ? raw : Number(raw);
    if (Number.isFinite(n)) return { value: n };
  }
  return { value: c.value(row) }; // already formula-safe + UUID-blanked by sanitizedColumns()
}

/**
 * Lazily loads the ExcelJS module on first use and caches it — the dynamic
 * `import()` (rather than a top-level static import) is what lets bundlers
 * split ExcelJS into its own chunk, fetched only when an Excel export is
 * actually triggered.
 */
let excelJsModulePromise: Promise<typeof ExcelJS> | null = null;
function loadExcelJS(): Promise<typeof ExcelJS> {
  if (!excelJsModulePromise) {
    excelJsModulePromise = import('exceljs').then(m => (m as unknown as { default: typeof ExcelJS }).default ?? (m as unknown as typeof ExcelJS));
  }
  return excelJsModulePromise;
}

/**
 * Builds a true ExcelJS workbook: Creator/Created/Modified metadata, one
 * worksheet (safe sheet name, RTL view when Arabic), a premium
 * title/module/brand/metadata block, a frozen+auto-filtered, bold/colored
 * header row, alternating-row-fill data rows with date-safe cells (real
 * Date + explicit numFmt, never `###`/`Invalid Date`), numeric-right-aligned
 * cells, wrapped text on regular columns, and an optional per-row severity
 * fill hint. Does not download anything — see exportProfessionalXlsx.
 *
 * Async (EXPORT-XLSX-DYNAMIC-IMPORT-A): the ExcelJS module itself is loaded
 * on demand via loadExcelJS() rather than a top-level import, so this
 * function must await that load before constructing the workbook.
 */
export async function buildProfessionalWorkbook<T>(config: ProfessionalExportConfig<T>): Promise<ExcelJS.Workbook> {
  const ExcelJSRuntime = await loadExcelJS();
  const wb = new ExcelJSRuntime.Workbook();
  wb.creator = 'MediStock Phoenix';
  wb.created = config.generatedAt;
  wb.modified = config.generatedAt;
  addProfessionalDataSheet(wb, config);
  return wb;
}

/**
 * Adds one data sheet (title/module/brand/metadata block + frozen,
 * auto-filtered, bold/colored header + alternating-row data table) to an
 * existing workbook, using the same styling as buildProfessionalWorkbook's
 * single sheet. Extracted so a multi-sheet workbook (e.g. parent rows on one
 * sheet, drill-down detail rows on another) can reuse the exact same
 * per-sheet rendering without duplicating it — see
 * buildMultiSheetProfessionalWorkbook.
 */
function addProfessionalDataSheet<T>(wb: ExcelJS.Workbook, config: ProfessionalExportConfig<T>): void {
  const columns = sanitizedColumns(config);
  const metaLines = buildMetaLines(config);
  const isRtl = config.lang === 'ar';
  const colCount = Math.max(columns.length, 1);

  const ws = wb.addWorksheet(safeSheetName(config.moduleName || config.reportTitle), {
    views: [{ rightToLeft: isRtl }],
  });

  ws.columns = columns.map(c => ({ key: c.key, width: columnWidth(c) }));

  // Premium title block.
  const titleRow = ws.addRow([config.reportTitle]);
  ws.mergeCells(titleRow.number, 1, titleRow.number, colCount);
  titleRow.getCell(1).font = { bold: true, size: 15, color: { argb: BRAND_NAVY } };
  titleRow.height = 22;

  if (config.moduleName) {
    const moduleRow = ws.addRow([config.moduleName]);
    ws.mergeCells(moduleRow.number, 1, moduleRow.number, colCount);
    moduleRow.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF333333' } };
  }

  const brandRow = ws.addRow([REPORT_BRAND]);
  ws.mergeCells(brandRow.number, 1, brandRow.number, colCount);
  brandRow.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  for (const m of metaLines) {
    const row = ws.addRow([`${m.label}: ${m.value}`]);
    ws.mergeCells(row.number, 1, row.number, colCount);
    row.getCell(1).font = { size: 10, color: { argb: 'FF333333' } };
  }

  ws.addRow([]); // blank spacer row before the table

  const headerRow = ws.addRow(columns.map(c => c.label));
  headerRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_TEAL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = {
      top: { style: 'thin', color: { argb: BRAND_BORDER } },
      bottom: { style: 'thin', color: { argb: BRAND_BORDER } },
      left: { style: 'thin', color: { argb: BRAND_BORDER } },
      right: { style: 'thin', color: { argb: BRAND_BORDER } },
    };
  });

  config.rows.forEach((r, i) => {
    const cells = columns.map(c => resolveCellValue(c, r));
    const dataRow = ws.addRow(cells.map(c => c.value));
    const accent = config.rowAccent?.(r);
    dataRow.eachCell((cell, colNumber) => {
      const col = columns[colNumber - 1];
      const cellInfo = cells[colNumber - 1];
      if (cellInfo.numFmt) cell.numFmt = cellInfo.numFmt;
      cell.alignment = {
        vertical: 'middle',
        horizontal: col.numeric ? 'right' : col.dateColumn ? 'center' : (isRtl ? 'right' : 'left'),
        wrapText: !col.numeric && !col.dateColumn,
      };
      const fill = i % 2 === 1 ? BRAND_ALT_ROW : undefined;
      if (fill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
      cell.border = {
        top: { style: 'thin', color: { argb: BRAND_BORDER } },
        bottom: { style: 'thin', color: { argb: BRAND_BORDER } },
        left: { style: 'thin', color: { argb: BRAND_BORDER } },
        right: { style: 'thin', color: { argb: BRAND_BORDER } },
      };
      if (accent && colNumber === 1) {
        cell.border = { ...cell.border, left: { style: 'medium', color: { argb: SEVERITY_FILL[accent] } } };
      }
    });
  });

  if (config.rows.length === 0) {
    const emptyRow = ws.addRow([config.emptyMessage || '—']);
    ws.mergeCells(emptyRow.number, 1, emptyRow.number, colCount);
    emptyRow.getCell(1).alignment = { horizontal: 'center' };
    emptyRow.getCell(1).font = { italic: true, color: { argb: 'FF666666' } };
  } else {
    const lastRow = headerRow.number + config.rows.length;
    ws.autoFilter = { from: { row: headerRow.number, column: 1 }, to: { row: lastRow, column: colCount } };
  }

  // Freeze everything above and including the header row so it stays visible while scrolling.
  ws.views = [{ rightToLeft: isRtl, state: 'frozen', ySplit: headerRow.number }];
}

/**
 * Builds one workbook containing a data sheet per config, in order — e.g.
 * parent rows on sheet 1, drill-down detail rows on sheet 2+. Each config's
 * `moduleName` becomes its sheet name, so callers must give each a distinct
 * `moduleName` (sanitizedColumns/safeSheetName already dedupe illegal
 * characters and length, but not cross-sheet name collisions). Does not
 * download anything — see exportProfessionalMultiSheetXlsx.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- each sheet's ProfessionalExportConfig<T> has its own row type; a heterogeneous array (e.g. orders + receipts + lines) needs type erasure at this boundary, same as procurement.service.ts's row mappers.
export async function buildMultiSheetProfessionalWorkbook(configs: ProfessionalExportConfig<any>[]): Promise<ExcelJS.Workbook> {
  const ExcelJSRuntime = await loadExcelJS();
  const wb = new ExcelJSRuntime.Workbook();
  const generatedAt = configs[0]?.generatedAt ?? new Date();
  wb.creator = 'MediStock Phoenix';
  wb.created = generatedAt;
  wb.modified = generatedAt;
  for (const config of configs) addProfessionalDataSheet(wb, config);
  return wb;
}

/**
 * Builds a multi-sheet workbook via buildMultiSheetProfessionalWorkbook and
 * downloads it as a true `.xlsx` file. Mirrors exportProfessionalXlsx's
 * error-handling contract (returns false, never throws).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see buildMultiSheetProfessionalWorkbook above.
export async function exportProfessionalMultiSheetXlsx(configs: ProfessionalExportConfig<any>[], fileNameBase: string): Promise<boolean> {
  try {
    const wb = await buildMultiSheetProfessionalWorkbook(configs);
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return await downloadBlob(buildStableFileName(fileNameBase, 'xlsx'), blob);
  } catch {
    return false;
  }
}

async function downloadBlob(filename: string, blob: Blob): Promise<boolean> {
  try {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * Builds the premium ExcelJS workbook for the given config and downloads it
 * as a true `.xlsx` file (correct OOXML spreadsheet MIME type). This is the
 * PRIMARY "Excel export" path. Returns false (never throws) on failure.
 */
export async function exportProfessionalXlsx<T>(config: ProfessionalExportConfig<T>): Promise<boolean> {
  try {
    const wb = await buildProfessionalWorkbook(config);
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return await downloadBlob(buildStableFileName(config.fileNameBase, 'xlsx'), blob);
  } catch {
    return false;
  }
}

/**
 * @deprecated Legacy/optional CSV fallback — NOT the primary export path.
 * `exportProfessionalXlsx` (real `.xlsx` via ExcelJS) is the primary "Excel"
 * export as of EXPORT-PROFESSIONAL-XLSX-PDF-B. Kept only in case a future
 * consumer needs a plain-text fallback (e.g. an environment where a binary
 * download is undesirable); no screen is wired to this anymore.
 */
export function exportProfessionalCsv<T>(config: ProfessionalExportConfig<T>): boolean {
  const columns = sanitizedColumns(config);
  const metaLines = buildMetaLines(config);
  const metadataLines = [
    config.reportTitle,
    ...(config.moduleName ? [config.moduleName] : []),
    ...metaLines.map(m => `${m.label}: ${m.value}`),
  ];
  try {
    const csv = buildCsvContent(columns, config.rows, metadataLines);
    return downloadTextFile(buildStableFileName(config.fileNameBase, 'csv'), csv, 'text/csv;charset=utf-8;');
  } catch {
    return false;
  }
}

/**
 * Builds a premium print/PDF-via-print HTML document: branded header bar,
 * title + module name, a boxed metadata panel (generated-at/filters/row
 * count/generated-by), a bold-header/alternating-row table with an optional
 * per-row severity accent stripe, wrapped long text on non-LTR columns, and
 * a branded footer. Intended to be printed via the browser's native
 * "Save as PDF" destination (openPrintWindow) or downloaded as HTML via
 * MobilePrintFallbackModal — no PDF-generation library is used or added.
 */
export function buildPremiumPrintHtml<T>(config: ProfessionalExportConfig<T>): string {
  const columns = sanitizedColumns(config);
  const metaLines = buildMetaLines(config);
  const dir = config.lang === 'ar' ? 'rtl' : 'ltr';
  const align = config.lang === 'ar' ? 'right' : 'left';

  const headCells = columns.map(c => `<th>${escHtml(c.label)}</th>`).join('');
  const bodyRows = config.rows.map(r => {
    const accent = config.rowAccent?.(r);
    const accentColor = accent === 'err' ? '#DC2626' : accent === 'warn' ? '#D97706' : accent === 'ok' ? '#059669' : 'transparent';
    const cells = columns.map(c => {
      const wrap = c.ltr ? 'white-space:nowrap;' : 'white-space:normal;word-break:break-word;';
      const text = c.dateColumn ? formatExportDateText(c.excelValue ? (c.excelValue(r) as string | Date | null) : c.value(r), config.lang) : c.value(r);
      return `<td${c.ltr || c.dateColumn ? ' dir="ltr"' : ''} style="${wrap}">${escHtml(text)}</td>`;
    }).join('');
    return `<tr style="border-inline-start:3px solid ${accentColor};">${cells}</tr>`;
  }).join('');

  const metaHtml = metaLines
    .map(m => `<div class="meta">${escHtml(m.label)}: <span${m.ltr ? ' class="val" dir="ltr"' : ''}>${escHtml(m.value)}</span></div>`)
    .join('');

  const bodyHtml = config.rows.length > 0
    ? `<table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
    : `<div class="empty">${escHtml(config.emptyMessage || '—')}</div>`;

  return `<!doctype html><html dir="${dir}" lang="${config.lang}"><head><meta charset="utf-8">
<title>${escHtml(config.reportTitle)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { background: #fff; }
  body { font-family: ${config.lang === 'ar' ? "'Segoe UI', Tahoma, Arial" : 'Arial, sans-serif'}; color: #111; direction: ${dir}; margin: 0; padding: 16px; }
  .brand-bar { height: 4px; background: linear-gradient(90deg, #0D9488, #3B82F6); border-radius: 3px; margin-bottom: 10px; }
  h1 { font-size: 19px; margin: 0 0 2px; color: #0F2B4F; }
  .subtitle { font-size: 12.5px; color: #333; margin: 0 0 8px; font-weight: 600; }
  .brand { font-size: 11px; color: #555; margin-bottom: 10px; }
  .meta-box { background: #F3F7FB; border: 1px solid #D6E0EC; border-radius: 8px; padding: 8px 12px; margin-bottom: 12px; }
  .meta { font-size: 11px; color: #333; margin: 2px 0; }
  .meta .val { unicode-bidi: isolate; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 4px; font-size: 10px; table-layout: auto; }
  th, td { border: 1px solid #C7D3E0; padding: 6px 8px; text-align: ${align}; vertical-align: middle; }
  th { background: #0D9488; color: #fff; font-weight: 700; }
  tbody tr:nth-child(even) { background: #F3F7FB; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .empty { padding: 24px 0; text-align: center; color: #555; font-size: 12.5px; }
  .footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ccc; font-size: 10px; color: #666; display: flex; justify-content: space-between; gap: 10px; flex-wrap: wrap; }
  @media print {
    body { padding: 0; }
    a { color: inherit; text-decoration: none; }
  }
</style></head><body>
  <div class="brand-bar"></div>
  <h1>${escHtml(config.reportTitle)}</h1>
  ${config.moduleName ? `<div class="subtitle">${escHtml(config.moduleName)}</div>` : ''}
  <div class="brand">${escHtml(REPORT_BRAND)}</div>
  <div class="meta-box">${metaHtml}</div>
  ${bodyHtml}
  <div class="footer"><span>${escHtml(config.footerText)}</span></div>
</body></html>`;
}

export interface PrintTriggerResult {
  ok: boolean;
  /** Present only on mobile/PWA/webview contexts — caller must route this into MobilePrintFallbackModal instead of assuming the popup path ran. */
  mobileHtml?: string;
}

/**
 * Builds the premium print HTML and either opens the desktop print popup
 * (openPrintWindow) or — on mobile/PWA/webview contexts, where window.open
 * can make the app appear to exit — returns the HTML for the caller to hand
 * to MobilePrintFallbackModal, exactly like the existing per-screen
 * printReport() implementations already do.
 */
export function triggerProfessionalPrint<T>(config: ProfessionalExportConfig<T>): PrintTriggerResult {
  const html = buildPremiumPrintHtml(config);
  if (isLikelyMobilePrintContext()) {
    return { ok: true, mobileHtml: html };
  }
  return { ok: openPrintWindow(html) };
}

/**
 * SAFE-PROFESSIONAL-XLSX-EXPORT-A: multi-sheet "Availability Export" workbook
 * (Summary / Availability Export / Data Dictionary), used to replace
 * StatusCenterScreen's ad-hoc hand-rolled CSV export with a real, styled
 * `.xlsx`. Purely ADDITIVE to this file — does not modify, rename, or remove
 * `buildProfessionalWorkbook`/`exportProfessionalXlsx`/`exportProfessionalCsv`,
 * which StatusEditorScreen already depends on.
 *
 * Header/sheet-name/dictionary text is fixed bilingual (English / Arabic
 * together in one string), per this phase's explicit "bilingual headers"
 * requirement — independent of the viewer's current app language. Only the
 * worksheet's reading direction (RTL/LTR) and per-row data alignment follow
 * `config.lang`, since the underlying institution/material names in the data
 * itself may be Arabic or English regardless of header language.
 *
 * All per-row display strings (conditionLabel, expiryRiskLabel, institution,
 * outlet, lastUpdatedBy, notes, etc.) are supplied already-localized by the
 * caller — this module never imports i18n/canonical-status modules, keeping
 * it a pure rendering layer, exactly like the existing ProfessionalExportConfig
 * design above.
 */

export interface AvailabilityExportRow {
  no: number;
  institution: string;
  outlet: string;
  scientificName: string;
  tradeName: string;
  dosageForm: string;
  concentration: string;
  batchNumber: string;
  quantity: number;
  /**
   * PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: the existing,
   * user-entered availability `price` field only (never calculated/inferred/
   * overwritten by this module). null/undefined means no price was entered;
   * an actual entered 0 is a distinct, real value — see availExportCellValue,
   * which exports null/undefined as blank ("—") but a real 0 as 0.00.
   */
  enteredPrice: number | null;
  /** Raw/effective condition key (e.g. 'missing', 'low_stock') — used ONLY for row styling + Summary-sheet grouping, never rendered directly. */
  conditionKey: string;
  /** Already-localized (bilingual) display text for the Condition column. */
  conditionLabel: string;
  expiryDate: Date | null;
  /** Whole days until expiry (negative if already expired); null when expiryDate is null. */
  daysToExpiry: number | null;
  /** Already-localized (bilingual) display text for the Expiry Risk column. */
  expiryRiskLabel: string;
  lastUpdatedBy: string;
  lastUpdatedAt: Date | null;
  notes: string;
}

export interface AvailabilityExportConfig {
  reportTitle: string;
  moduleName?: string;
  generatedAt: Date;
  lang: 'ar' | 'en';
  fileNameBase: string;
  filtersSummary: string;
  footerText: string;
  emptyMessage: string;
  /** Bilingual display label per conditionKey, in the stable order the Summary sheet's totals should list them. */
  conditionLabels: Record<string, string>;
  rows: AvailabilityExportRow[];
}

/** Fixed bilingual column headers — exact wording from the SAFE-PROFESSIONAL-XLSX-EXPORT-A spec. */
const AVAIL_EXPORT_HEADERS = {
  no:            'No. / الرقم',
  institution:   'Institution / المؤسسة',
  outlet:        'Outlet / المنفذ',
  scientificName:'Scientific Name / الاسم العلمي',
  tradeName:     'Trade Name / الاسم التجاري',
  dosageForm:    'Dosage Form / الشكل',
  concentration: 'Concentration / التركيز',
  batchNumber:   'Batch No. / رقم الوجبة',
  quantity:      'Quantity / الكمية',
  enteredPrice:  'Entered Price / السعر المدخل',
  condition:     'Condition / الحالة',
  expiryDate:    'Expiry Date / تاريخ النفاد',
  daysToExpiry:  'Days to Expiry / أيام النفاد',
  expiryRisk:    'Expiry Risk / خطورة النفاد',
  lastUpdatedBy: 'Last Updated By / آخر محدث',
  lastUpdatedAt: 'Last Updated At / وقت التحديث',
  notes:         'Notes / ملاحظات',
} as const;

const AVAIL_META_LABELS = {
  generatedAt:    'Generated At / تاريخ الإنشاء',
  filters:        'Filters / الفلاتر المطبقة',
  totalRows:      'Total Rows / إجمالي الصفوف',
  summaryTitle:   'Summary / الملخص',
  condition:      'Condition / الحالة',
  count:          'Count / العدد',
  dictionaryTitle:'Data Dictionary / قاموس البيانات',
  field:          'Field / الحقل',
  description:    'Description / الوصف',
} as const;

/** Excel sheet tab names — plain (not bilingual), matching this phase's literal required sheet names exactly, within the 31-char Excel sheet-name limit. */
const AVAIL_SHEET_NAMES = {
  summary: 'Summary',
  data: 'Availability Export',
  dictionary: 'Data Dictionary',
} as const;

/** Column-name / description pairs for the Data Dictionary sheet, bilingual. */
const AVAIL_EXPORT_DICTIONARY: { field: string; description: string }[] = [
  { field: AVAIL_EXPORT_HEADERS.no, description: 'Sequential row number within this export. / رقم تسلسلي للصف ضمن هذا التصدير.' },
  { field: AVAIL_EXPORT_HEADERS.institution, description: 'The institution/organization this outlet belongs to. / المؤسسة التي يتبع لها هذا المنفذ.' },
  { field: AVAIL_EXPORT_HEADERS.outlet, description: 'The distribution point (outlet/port) within the institution. / نقطة التوزيع (المنفذ) داخل المؤسسة.' },
  { field: AVAIL_EXPORT_HEADERS.scientificName, description: 'The material\'s scientific (generic) name. / الاسم العلمي (الجنيس) للمادة.' },
  { field: AVAIL_EXPORT_HEADERS.tradeName, description: 'The material\'s trade (brand) name, if recorded. / الاسم التجاري للمادة، إن وُجد.' },
  { field: AVAIL_EXPORT_HEADERS.dosageForm, description: 'The pharmaceutical dosage form (tablet, syrup, injection, etc.). / الشكل الدوائي (أقراص، شراب، حقن، إلخ).' },
  { field: AVAIL_EXPORT_HEADERS.concentration, description: 'The material\'s strength/concentration. / تركيز أو قوة المادة.' },
  { field: AVAIL_EXPORT_HEADERS.batchNumber, description: 'The recorded batch/lot number, if any. / رقم الوجبة/الدفعة المسجل، إن وُجد.' },
  { field: AVAIL_EXPORT_HEADERS.quantity, description: 'Current recorded quantity on hand. / الكمية الحالية المسجلة.' },
  { field: AVAIL_EXPORT_HEADERS.enteredPrice, description: 'The user-entered price already recorded in the Availability/Status Editor (not a market price, and never calculated automatically) — blank if no price was entered. / السعر الذي أدخله المستخدم مسبقًا في محرر التوفر/الحالة (وليس سعر السوق، ولا يُحتسب تلقائيًا) — يترك فارغًا إذا لم يُدخل سعر.' },
  { field: AVAIL_EXPORT_HEADERS.condition, description: 'The material\'s current status: Available, Low Stock, Missing, Surplus, Near Expiry, or Expired. / حالة المادة الحالية: متوفر، منخفض، مفقود، فائض، قريب الانتهاء، أو منتهي الصلاحية.' },
  { field: AVAIL_EXPORT_HEADERS.expiryDate, description: 'The material\'s recorded expiry date (yyyy-mm-dd), if any. / تاريخ انتهاء صلاحية المادة المسجل، إن وُجد.' },
  { field: AVAIL_EXPORT_HEADERS.daysToExpiry, description: 'Whole days remaining until expiry as of the generation date (negative if already expired). / عدد الأيام المتبقية حتى انتهاء الصلاحية بتاريخ إنشاء هذا التصدير (رقم سالب إذا كانت منتهية بالفعل).' },
  { field: AVAIL_EXPORT_HEADERS.expiryRisk, description: 'Risk tier derived from the expiry date: Expired, Critical (≤3 months), Warning (≤6 months), Watch (≤9 months), or Normal. / مستوى الخطورة المشتق من تاريخ الانتهاء: منتهي، حرج (خلال 3 أشهر)، تحذير (خلال 6 أشهر)، مراقبة (خلال 9 أشهر)، أو طبيعي.' },
  { field: AVAIL_EXPORT_HEADERS.lastUpdatedBy, description: 'Display name of the user who last updated this record (never a raw user ID). / اسم آخر مستخدم قام بتحديث هذا السجل (وليس معرّف المستخدم الخام).' },
  { field: AVAIL_EXPORT_HEADERS.lastUpdatedAt, description: 'Date and time this record was last updated. / تاريخ ووقت آخر تحديث لهذا السجل.' },
  { field: AVAIL_EXPORT_HEADERS.notes, description: 'Free-text notes recorded against this material, if any. / ملاحظات نصية حرة مسجلة على هذه المادة، إن وُجدت.' },
  { field: 'Scope / النطاق', description: 'This export excludes materials intentionally removed from an outlet (removed_at marker) — only active and genuinely out-of-stock/shortage materials are listed. / يستثني هذا التصدير المواد التي تمت إزالتها عمداً من المنفذ (علامة removed_at) — يتم إدراج المواد الفعالة والنواقص الحقيقية فقط.' },
];

/** Condition → row style (fill/border/font) used on the Availability Export sheet's data rows and the Summary sheet's totals. */
const AVAIL_CONDITION_STYLE: Record<string, { fill: string; border: string; font: string }> = {
  missing:     { fill: 'FFFCE8E8', border: 'FFDC2626', font: 'FF991B1B' }, // red
  expired:     { fill: 'FFFCE8E8', border: 'FFDC2626', font: 'FF991B1B' }, // red
  low_stock:   { fill: 'FFFFF3E0', border: 'FFD97706', font: 'FF92400E' }, // amber
  near_expiry: { fill: 'FFFFE8D1', border: 'FFEA580C', font: 'FF9A3412' }, // orange
  surplus:     { fill: 'FFE6F4EA', border: 'FF059669', font: 'FF065F46' }, // green
  available:   { fill: 'FFF1FBF5', border: 'FF10B981', font: 'FF065F46' }, // green/neutral
};

const AVAIL_THIN_BORDER = { style: 'thin' as const, color: { argb: BRAND_BORDER } };
const AVAIL_ALL_BORDERS = { top: AVAIL_THIN_BORDER, bottom: AVAIL_THIN_BORDER, left: AVAIL_THIN_BORDER, right: AVAIL_THIN_BORDER };

interface AvailExportColumnDef {
  key: keyof typeof AVAIL_EXPORT_HEADERS;
  width: number;
  kind: 'numeric' | 'text' | 'date' | 'datetime' | 'ltr-text' | 'price';
}

const AVAIL_EXPORT_COLUMNS: AvailExportColumnDef[] = [
  { key: 'no', width: 6, kind: 'numeric' },
  { key: 'institution', width: 22, kind: 'text' },
  { key: 'outlet', width: 22, kind: 'text' },
  { key: 'scientificName', width: 24, kind: 'text' },
  { key: 'tradeName', width: 22, kind: 'text' },
  { key: 'dosageForm', width: 16, kind: 'text' },
  { key: 'concentration', width: 16, kind: 'text' },
  { key: 'batchNumber', width: 16, kind: 'ltr-text' },
  { key: 'quantity', width: 12, kind: 'numeric' },
  // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: placed right after
  // Quantity, before Condition, per the task's explicit placement preference.
  { key: 'enteredPrice', width: 14, kind: 'price' },
  { key: 'condition', width: 26, kind: 'text' },
  { key: 'expiryDate', width: 16, kind: 'date' },
  { key: 'daysToExpiry', width: 14, kind: 'numeric' },
  { key: 'expiryRisk', width: 30, kind: 'text' },
  { key: 'lastUpdatedBy', width: 22, kind: 'text' },
  { key: 'lastUpdatedAt', width: 20, kind: 'datetime' },
  { key: 'notes', width: 30, kind: 'text' },
];

function availExportCellValue(row: AvailabilityExportRow, key: AvailExportColumnDef['key']): string | number | Date {
  switch (key) {
    case 'no': return row.no;
    case 'institution': return neutralizeFormulaValue(row.institution || '—');
    case 'outlet': return neutralizeFormulaValue(row.outlet || '—');
    case 'scientificName': return neutralizeFormulaValue(row.scientificName || '—');
    case 'tradeName': return neutralizeFormulaValue(row.tradeName || '—');
    case 'dosageForm': return neutralizeFormulaValue(row.dosageForm || '—');
    case 'concentration': return neutralizeFormulaValue(row.concentration || '—');
    case 'batchNumber': return neutralizeFormulaValue(row.batchNumber || '—');
    case 'quantity': return row.quantity;
    // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: EXPORT CHOICE
    // (documented per task): null/undefined price exports as blank ("—"),
    // matching every other absent-value column in this sheet. An actual
    // entered 0 is a distinct, real value and exports as a real numeric 0
    // (formatted 0.00 by the numFmt applied below) — never blanked, never
    // calculated/inferred/overwritten.
    case 'enteredPrice': return typeof row.enteredPrice === 'number' && Number.isFinite(row.enteredPrice) ? row.enteredPrice : '—';
    case 'condition': return neutralizeFormulaValue(row.conditionLabel || '—');
    case 'expiryDate': return row.expiryDate ?? '—';
    case 'daysToExpiry': return row.daysToExpiry ?? '—';
    case 'expiryRisk': return neutralizeFormulaValue(row.expiryRiskLabel || '—');
    case 'lastUpdatedBy': return neutralizeFormulaValue(row.lastUpdatedBy || '—');
    case 'lastUpdatedAt': return row.lastUpdatedAt ?? '—';
    case 'notes': return neutralizeFormulaValue(row.notes || '—');
    default: return '—';
  }
}

/**
 * Builds the 3-sheet (Summary / Availability Export / Data Dictionary)
 * ExcelJS workbook. Does not download anything — see exportAvailabilityXlsx.
 */
export async function buildAvailabilityExportWorkbook(config: AvailabilityExportConfig): Promise<ExcelJS.Workbook> {
  const ExcelJSRuntime = await loadExcelJS();
  const isRtl = config.lang === 'ar';

  const wb = new ExcelJSRuntime.Workbook();
  wb.creator = 'MediStock Phoenix';
  wb.created = config.generatedAt;
  wb.modified = config.generatedAt;

  // ── Summary sheet ──────────────────────────────────────────────────────
  const summaryWs = wb.addWorksheet(safeSheetName(AVAIL_SHEET_NAMES.summary), { views: [{ rightToLeft: isRtl }] });
  summaryWs.columns = [{ key: 'label', width: 36 }, { key: 'value', width: 26 }];

  const summaryTitleRow = summaryWs.addRow([AVAIL_META_LABELS.summaryTitle]);
  summaryWs.mergeCells(summaryTitleRow.number, 1, summaryTitleRow.number, 2);
  summaryTitleRow.getCell(1).font = { bold: true, size: 15, color: { argb: BRAND_NAVY } };
  summaryTitleRow.height = 22;

  const summaryReportRow = summaryWs.addRow([config.reportTitle]);
  summaryWs.mergeCells(summaryReportRow.number, 1, summaryReportRow.number, 2);
  summaryReportRow.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF333333' } };

  const summaryBrandRow = summaryWs.addRow([REPORT_BRAND]);
  summaryWs.mergeCells(summaryBrandRow.number, 1, summaryBrandRow.number, 2);
  summaryBrandRow.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  summaryWs.addRow([AVAIL_META_LABELS.generatedAt, formatStableDateTime(config.generatedAt, config.lang)]);
  summaryWs.addRow([AVAIL_META_LABELS.filters, config.filtersSummary]);
  summaryWs.addRow([AVAIL_META_LABELS.totalRows, config.rows.length]);
  summaryWs.addRow([]);

  const summaryHeaderRow = summaryWs.addRow([AVAIL_META_LABELS.condition, AVAIL_META_LABELS.count]);
  summaryHeaderRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_TEAL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = AVAIL_ALL_BORDERS;
  });

  const conditionCounts: Record<string, number> = {};
  for (const r of config.rows) conditionCounts[r.conditionKey] = (conditionCounts[r.conditionKey] ?? 0) + 1;

  for (const key of Object.keys(config.conditionLabels)) {
    const row = summaryWs.addRow([config.conditionLabels[key], conditionCounts[key] ?? 0]);
    const style = AVAIL_CONDITION_STYLE[key];
    row.eachCell(cell => {
      cell.border = AVAIL_ALL_BORDERS;
      if (style) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: style.fill } };
    });
  }

  summaryWs.views = [{ rightToLeft: isRtl }];

  // ── Availability Export sheet ──────────────────────────────────────────
  const dataWs = wb.addWorksheet(safeSheetName(AVAIL_SHEET_NAMES.data), { views: [{ rightToLeft: isRtl }] });
  const colCount = AVAIL_EXPORT_COLUMNS.length;
  dataWs.columns = AVAIL_EXPORT_COLUMNS.map(c => ({ key: c.key, width: c.width }));

  const dataTitleRow = dataWs.addRow([config.reportTitle]);
  dataWs.mergeCells(dataTitleRow.number, 1, dataTitleRow.number, colCount);
  dataTitleRow.getCell(1).font = { bold: true, size: 15, color: { argb: BRAND_NAVY } };
  dataTitleRow.height = 22;

  if (config.moduleName) {
    const moduleRow = dataWs.addRow([config.moduleName]);
    dataWs.mergeCells(moduleRow.number, 1, moduleRow.number, colCount);
    moduleRow.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF333333' } };
  }

  const dataBrandRow = dataWs.addRow([REPORT_BRAND]);
  dataWs.mergeCells(dataBrandRow.number, 1, dataBrandRow.number, colCount);
  dataBrandRow.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  const metaPairs: [string, string][] = [
    [AVAIL_META_LABELS.generatedAt, formatStableDateTime(config.generatedAt, config.lang)],
    [AVAIL_META_LABELS.filters, config.filtersSummary],
    [AVAIL_META_LABELS.totalRows, String(config.rows.length)],
  ];
  for (const [label, value] of metaPairs) {
    const row = dataWs.addRow([`${label}: ${value}`]);
    dataWs.mergeCells(row.number, 1, row.number, colCount);
    row.getCell(1).font = { size: 10, color: { argb: 'FF333333' } };
  }
  dataWs.addRow([]);

  const dataHeaderRow = dataWs.addRow(AVAIL_EXPORT_COLUMNS.map(c => AVAIL_EXPORT_HEADERS[c.key]));
  dataHeaderRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_TEAL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = AVAIL_ALL_BORDERS;
  });

  config.rows.forEach((r, i) => {
    const rowValues = AVAIL_EXPORT_COLUMNS.map(c => availExportCellValue(r, c.key));
    const dataRow = dataWs.addRow(rowValues);
    const style = AVAIL_CONDITION_STYLE[r.conditionKey];
    const altFill = i % 2 === 1 ? BRAND_ALT_ROW : undefined;

    dataRow.eachCell((cell, colNumber) => {
      const col = AVAIL_EXPORT_COLUMNS[colNumber - 1];
      if (col.kind === 'date' && cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd';
      if (col.kind === 'datetime' && cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd hh:mm';
      // PHASE2-STATUS-CENTER-ENTERED-PRICE-FILTER-XLSX-A: only apply the
      // 2-decimal numFmt when the cell actually holds a real number (a blank
      // "—" for a null/undefined price must not get a numeric format).
      if (col.kind === 'price' && typeof cell.value === 'number') cell.numFmt = '0.00';
      cell.alignment = {
        vertical: 'middle',
        horizontal: (col.kind === 'numeric' || col.kind === 'price') ? 'right'
          : (col.kind === 'date' || col.kind === 'datetime') ? 'center'
          : (isRtl ? 'right' : 'left'),
        wrapText: col.kind === 'text',
      };
      const fillColor = style?.fill ?? altFill;
      if (fillColor) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
      cell.border = AVAIL_ALL_BORDERS;
      if (col.key === 'condition' && style) {
        cell.font = { bold: true, color: { argb: style.font } };
      }
    });
  });

  if (config.rows.length === 0) {
    const emptyRow = dataWs.addRow([config.emptyMessage || '—']);
    dataWs.mergeCells(emptyRow.number, 1, emptyRow.number, colCount);
    emptyRow.getCell(1).alignment = { horizontal: 'center' };
    emptyRow.getCell(1).font = { italic: true, color: { argb: 'FF666666' } };
  } else {
    const lastRow = dataHeaderRow.number + config.rows.length;
    dataWs.autoFilter = { from: { row: dataHeaderRow.number, column: 1 }, to: { row: lastRow, column: colCount } };
  }

  dataWs.views = [{ rightToLeft: isRtl, state: 'frozen', ySplit: dataHeaderRow.number }];

  // ── Data Dictionary sheet ──────────────────────────────────────────────
  const dictWs = wb.addWorksheet(safeSheetName(AVAIL_SHEET_NAMES.dictionary), { views: [{ rightToLeft: isRtl }] });
  dictWs.columns = [{ key: 'field', width: 28 }, { key: 'description', width: 70 }];

  const dictTitleRow = dictWs.addRow([AVAIL_META_LABELS.dictionaryTitle]);
  dictWs.mergeCells(dictTitleRow.number, 1, dictTitleRow.number, 2);
  dictTitleRow.getCell(1).font = { bold: true, size: 14, color: { argb: BRAND_NAVY } };
  dictTitleRow.height = 22;

  const dictHeaderRow = dictWs.addRow([AVAIL_META_LABELS.field, AVAIL_META_LABELS.description]);
  dictHeaderRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_TEAL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = AVAIL_ALL_BORDERS;
  });

  AVAIL_EXPORT_DICTIONARY.forEach((entry, i) => {
    const row = dictWs.addRow([entry.field, entry.description]);
    const altFill = i % 2 === 1 ? BRAND_ALT_ROW : undefined;
    row.eachCell((cell, colNumber) => {
      cell.alignment = { vertical: 'top', horizontal: isRtl ? 'right' : 'left', wrapText: colNumber === 2 };
      cell.border = AVAIL_ALL_BORDERS;
      if (altFill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: altFill } };
    });
    row.getCell(1).font = { bold: true };
  });

  dictWs.views = [{ rightToLeft: isRtl, state: 'frozen', ySplit: dictHeaderRow.number }];

  return wb;
}

/**
 * Builds the 3-sheet availability workbook and downloads it as a true
 * `.xlsx` file. Returns false (never throws) on failure — mirrors
 * exportProfessionalXlsx's error-handling contract.
 */
export async function exportAvailabilityXlsx(config: AvailabilityExportConfig): Promise<boolean> {
  try {
    const wb = await buildAvailabilityExportWorkbook(config);
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return await downloadBlob(buildStableFileName(config.fileNameBase, 'xlsx'), blob);
  } catch {
    return false;
  }
}

/**
 * PHASE2-STATUS-CENTER-OUTLET-REPORT-MODAL-A
 *
 * Purely ADDITIVE sibling of AvailabilityExportRow/Config/
 * buildAvailabilityExportWorkbook/exportAvailabilityXlsx above — does not
 * modify, rename, or remove any of them, so Status Center's existing main
 * XLSX export is completely unaffected. Backs the read-only outlet
 * availability report modal opened from Status Center's outlet-selector
 * dropdown.
 *
 * Unlike the main export (which always excludes removed_at rows — see
 * AVAIL_EXPORT_DICTIONARY's Scope note above), this is documented as an
 * OPERATIONS report: it may include intentionally-removed rows, but only
 * when the modal's own "removed status" filter is set to include them, and
 * every such row is clearly labeled via `removedLabel` (never a raw
 * `removed_by` uuid — that field is never part of this row shape at all).
 */
export interface OutletReportRow extends AvailabilityExportRow {
  /** Already-localized "Active / نشط" or "Removed / مُزالة" label — never a raw removed_by uuid. */
  removedLabel: string;
  /**
   * PHASE2-EXPORT-FIELD-SELECTOR-A: the raw supply_type text value (already
   * displayed on-screen and in the modal's print columns), added here so the
   * Excel export can include it too. Additive to OutletReportRow only — NOT
   * added to AvailabilityExportRow, so Status Center's main export (which
   * has never included a Supply Type column) is completely unaffected.
   */
  supplyType: string;
}

export interface OutletReportSummary {
  totalItems: number;
  availableCount: number;
  lowStockCount: number;
  missingCount: number;
  nearExpiryCount: number;
  surplusCount: number;
  totalQuantity: number;
  /** Count of rows with a real, positive entered price — deliberately NOT a monetary total (no existing app concept of inventory value to sum against). */
  pricedItemsCount: number;
}

export interface OutletReportConfig {
  reportTitle: string;
  moduleName?: string;
  generatedAt: Date;
  lang: 'ar' | 'en';
  fileNameBase: string;
  filtersSummary: string;
  footerText: string;
  emptyMessage: string;
  outletName: string;
  institutionName: string;
  summary: OutletReportSummary;
  rows: OutletReportRow[];
  /**
   * PHASE2-EXPORT-FIELD-SELECTOR-A: optional column allowlist, keyed by the
   * SAME OutletReportColumnKey names as OUTLET_REPORT_COLUMNS below.
   * DEFAULT-PRESERVING: omitted/undefined (every existing caller before this
   * phase, and any future caller that doesn't opt in) still exports every
   * column, exactly as before. The three columns not exposed to the field
   * selector UI ('no', 'expiryRisk', 'lastUpdatedBy') are ALWAYS included
   * regardless of this set — see NON_FILTERABLE_OUTLET_COLUMNS below.
   */
  selectedColumnKeys?: Set<string>;
}

const OUTLET_REPORT_HEADERS = {
  ...AVAIL_EXPORT_HEADERS,
  supplyType: 'Supply Type / نوع التجهيز',
  removed: 'Removed Status / حالة الإزالة',
} as const;

/**
 * PHASE2-EXPORT-FIELD-SELECTOR-A: columns never offered by the field
 * selector UI and therefore always exported regardless of
 * config.selectedColumnKeys — 'no' (row index) and the two Excel-only
 * columns the task explicitly protects (Expiry Risk, Last Updated By).
 */
const NON_FILTERABLE_OUTLET_COLUMNS = new Set<OutletReportColumnKey>(['no', 'expiryRisk', 'lastUpdatedBy']);

const OUTLET_REPORT_META_LABELS = {
  ...AVAIL_META_LABELS,
  outlet: 'Outlet / المنفذ',
  institution: 'Institution / المؤسسة',
  totalItems: 'Total Items / إجمالي الأصناف',
  availableCount: 'Available / متوفر',
  lowStockCount: 'Low Stock / منخفض',
  missingCount: 'Missing / مفقود',
  nearExpiryCount: 'Near Expiry / قريب الانتهاء',
  surplusCount: 'Surplus / فائض',
  totalQuantity: 'Total Quantity / إجمالي الكمية',
  pricedItemsCount: 'Priced Items Count / عدد الأصناف المسعّرة',
} as const;

const OUTLET_REPORT_SHEET_NAMES = {
  summary: 'Summary',
  data: 'Outlet Availability',
  dictionary: 'Data Dictionary',
} as const;

type OutletReportColumnKey = keyof typeof OUTLET_REPORT_HEADERS;

const OUTLET_REPORT_COLUMNS: { key: OutletReportColumnKey; width: number; kind: AvailExportColumnDef['kind'] }[] = [
  ...AVAIL_EXPORT_COLUMNS,
  // PHASE2-EXPORT-FIELD-SELECTOR-A: Supply Type, additive — not present on
  // the shared AvailabilityExportRow/main export, only on OutletReportRow.
  { key: 'supplyType', width: 18, kind: 'text' },
  { key: 'removed', width: 18, kind: 'text' },
];

/** Extra Data Dictionary entries for the outlet-report-only "Supply Type"/"Removed" columns, plus a corrected Scope note (this report CAN include removed rows, unlike the main export). */
const OUTLET_REPORT_DICTIONARY: { field: string; description: string }[] = [
  ...AVAIL_EXPORT_DICTIONARY.slice(0, -1), // drop the main export's "excludes removed materials" Scope line — replaced below
  { field: OUTLET_REPORT_HEADERS.supplyType, description: 'Canonical supply category recorded for this material: aid, purchases (central/supplementary) or Kimadia. / تصنيف التجهيز المعتمد لهذه المادة: مساعدات أو مشتريات (مركزية/فرعية) أو كيماديا.' },
  { field: OUTLET_REPORT_HEADERS.removed, description: 'Whether this material is currently active at the outlet or was intentionally removed (removed_at marker) — never a raw removed-by user id. / يوضح ما إذا كانت هذه المادة فعالة حالياً في المنفذ أو تمت إزالتها عمداً (علامة removed_at) — لا يعرض معرّف المستخدم الخام لمن قام بالإزالة.' },
  { field: 'Scope / النطاق', description: 'This is an outlet operations report: it includes removed materials only when the modal\'s "Removed status" filter is set to show them, and every such row is clearly labeled Removed above. / هذا تقرير تشغيلي للمنفذ: يتضمن المواد المُزالة فقط عند ضبط فلتر "حالة الإزالة" في النافذة لعرضها، ويتم وسم كل صف من هذا النوع بوضوح كمُزال أعلاه.' },
];

function outletReportCellValue(row: OutletReportRow, key: OutletReportColumnKey): string | number | Date {
  if (key === 'supplyType') {
    // CANONICAL-SUPPLY-PROVENANCE: exports carry the canonical bilingual
    // category (donations never appear — legacy values map to aid); an
    // unmappable legacy value falls back to its raw text.
    const canonical = displaySupplyType(row.supplyType);
    const label = canonical === 'aid' ? 'Aid / مساعدات'
      : canonical === 'kimadia' ? 'Kimadia / كيماديا'
      : canonical === 'purchase' ? 'Purchases / مشتريات'
      : (row.supplyType || '—');
    return neutralizeFormulaValue(label);
  }
  if (key === 'removed') return neutralizeFormulaValue(row.removedLabel || '—');
  return availExportCellValue(row, key as AvailExportColumnDef['key']);
}

/**
 * Builds the 3-sheet (Summary / Outlet Availability / Data Dictionary)
 * ExcelJS workbook for the outlet report modal. Does not download anything —
 * see exportOutletReportXlsx. Does not touch buildAvailabilityExportWorkbook
 * or any of its module-scope helpers beyond reading them (styling constants,
 * availExportCellValue, AVAIL_EXPORT_DICTIONARY) — Status Center's own main
 * export path is untouched.
 */
export async function buildOutletReportWorkbook(config: OutletReportConfig): Promise<ExcelJS.Workbook> {
  const ExcelJSRuntime = await loadExcelJS();
  const isRtl = config.lang === 'ar';

  const wb = new ExcelJSRuntime.Workbook();
  wb.creator = 'MediStock Phoenix';
  wb.created = config.generatedAt;
  wb.modified = config.generatedAt;

  // ── Summary sheet ──────────────────────────────────────────────────────
  const summaryWs = wb.addWorksheet(safeSheetName(OUTLET_REPORT_SHEET_NAMES.summary), { views: [{ rightToLeft: isRtl }] });
  summaryWs.columns = [{ key: 'label', width: 36 }, { key: 'value', width: 26 }];

  const summaryTitleRow = summaryWs.addRow([OUTLET_REPORT_META_LABELS.summaryTitle]);
  summaryWs.mergeCells(summaryTitleRow.number, 1, summaryTitleRow.number, 2);
  summaryTitleRow.getCell(1).font = { bold: true, size: 15, color: { argb: BRAND_NAVY } };
  summaryTitleRow.height = 22;

  const summaryReportRow = summaryWs.addRow([config.reportTitle]);
  summaryWs.mergeCells(summaryReportRow.number, 1, summaryReportRow.number, 2);
  summaryReportRow.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF333333' } };

  const summaryBrandRow = summaryWs.addRow([REPORT_BRAND]);
  summaryWs.mergeCells(summaryBrandRow.number, 1, summaryBrandRow.number, 2);
  summaryBrandRow.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  summaryWs.addRow([OUTLET_REPORT_META_LABELS.institution, config.institutionName || '—']);
  summaryWs.addRow([OUTLET_REPORT_META_LABELS.outlet, config.outletName || '—']);
  summaryWs.addRow([OUTLET_REPORT_META_LABELS.generatedAt, formatStableDateTime(config.generatedAt, config.lang)]);
  summaryWs.addRow([OUTLET_REPORT_META_LABELS.filters, config.filtersSummary]);
  summaryWs.addRow([OUTLET_REPORT_META_LABELS.totalRows, config.rows.length]);
  summaryWs.addRow([]);

  const summaryHeaderRow = summaryWs.addRow([OUTLET_REPORT_META_LABELS.summaryTitle, OUTLET_REPORT_META_LABELS.count]);
  summaryHeaderRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_TEAL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center' };
    cell.border = AVAIL_ALL_BORDERS;
  });

  const summaryTotals: [string, number][] = [
    [OUTLET_REPORT_META_LABELS.totalItems, config.summary.totalItems],
    [OUTLET_REPORT_META_LABELS.availableCount, config.summary.availableCount],
    [OUTLET_REPORT_META_LABELS.lowStockCount, config.summary.lowStockCount],
    [OUTLET_REPORT_META_LABELS.missingCount, config.summary.missingCount],
    [OUTLET_REPORT_META_LABELS.nearExpiryCount, config.summary.nearExpiryCount],
    [OUTLET_REPORT_META_LABELS.surplusCount, config.summary.surplusCount],
    [OUTLET_REPORT_META_LABELS.totalQuantity, config.summary.totalQuantity],
    [OUTLET_REPORT_META_LABELS.pricedItemsCount, config.summary.pricedItemsCount],
  ];
  for (const [label, value] of summaryTotals) {
    const row = summaryWs.addRow([label, value]);
    row.eachCell(cell => { cell.border = AVAIL_ALL_BORDERS; });
  }

  summaryWs.views = [{ rightToLeft: isRtl }];

  // ── Outlet Availability sheet ──────────────────────────────────────────
  // PHASE2-EXPORT-FIELD-SELECTOR-A: when config.selectedColumnKeys is
  // provided, narrow OUTLET_REPORT_COLUMNS down to just those keys plus the
  // always-included NON_FILTERABLE_OUTLET_COLUMNS (no/expiryRisk/
  // lastUpdatedBy). Omitted (undefined) — the default, every pre-existing
  // caller's behavior — keeps every column, unchanged from before this phase.
  const dataColumns = config.selectedColumnKeys
    ? OUTLET_REPORT_COLUMNS.filter(c => NON_FILTERABLE_OUTLET_COLUMNS.has(c.key) || config.selectedColumnKeys!.has(c.key))
    : OUTLET_REPORT_COLUMNS;
  const dataWs = wb.addWorksheet(safeSheetName(OUTLET_REPORT_SHEET_NAMES.data), { views: [{ rightToLeft: isRtl }] });
  const colCount = dataColumns.length;
  dataWs.columns = dataColumns.map(c => ({ key: c.key, width: c.width }));

  const dataTitleRow = dataWs.addRow([config.reportTitle]);
  dataWs.mergeCells(dataTitleRow.number, 1, dataTitleRow.number, colCount);
  dataTitleRow.getCell(1).font = { bold: true, size: 15, color: { argb: BRAND_NAVY } };
  dataTitleRow.height = 22;

  if (config.moduleName) {
    const moduleRow = dataWs.addRow([config.moduleName]);
    dataWs.mergeCells(moduleRow.number, 1, moduleRow.number, colCount);
    moduleRow.getCell(1).font = { bold: true, size: 11, color: { argb: 'FF333333' } };
  }

  const dataBrandRow = dataWs.addRow([REPORT_BRAND]);
  dataWs.mergeCells(dataBrandRow.number, 1, dataBrandRow.number, colCount);
  dataBrandRow.getCell(1).font = { italic: true, size: 9, color: { argb: 'FF666666' } };

  const metaPairs: [string, string][] = [
    [OUTLET_REPORT_META_LABELS.outlet, config.outletName || '—'],
    [OUTLET_REPORT_META_LABELS.institution, config.institutionName || '—'],
    [OUTLET_REPORT_META_LABELS.generatedAt, formatStableDateTime(config.generatedAt, config.lang)],
    [OUTLET_REPORT_META_LABELS.filters, config.filtersSummary],
    [OUTLET_REPORT_META_LABELS.totalRows, String(config.rows.length)],
  ];
  for (const [label, value] of metaPairs) {
    const row = dataWs.addRow([`${label}: ${value}`]);
    dataWs.mergeCells(row.number, 1, row.number, colCount);
    row.getCell(1).font = { size: 10, color: { argb: 'FF333333' } };
  }
  dataWs.addRow([]);

  const dataHeaderRow = dataWs.addRow(dataColumns.map(c => OUTLET_REPORT_HEADERS[c.key]));
  dataHeaderRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_TEAL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = AVAIL_ALL_BORDERS;
  });

  config.rows.forEach((r, i) => {
    const rowValues = dataColumns.map(c => outletReportCellValue(r, c.key));
    const dataRow = dataWs.addRow(rowValues);
    const style = AVAIL_CONDITION_STYLE[r.conditionKey];
    const altFill = i % 2 === 1 ? BRAND_ALT_ROW : undefined;

    dataRow.eachCell((cell, colNumber) => {
      const col = dataColumns[colNumber - 1];
      if (col.kind === 'date' && cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd';
      if (col.kind === 'datetime' && cell.value instanceof Date) cell.numFmt = 'yyyy-mm-dd hh:mm';
      if (col.kind === 'price' && typeof cell.value === 'number') cell.numFmt = '0.00';
      cell.alignment = {
        vertical: 'middle',
        horizontal: (col.kind === 'numeric' || col.kind === 'price') ? 'right'
          : (col.kind === 'date' || col.kind === 'datetime') ? 'center'
          : (isRtl ? 'right' : 'left'),
        wrapText: col.kind === 'text',
      };
      const fillColor = style?.fill ?? altFill;
      if (fillColor) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
      cell.border = AVAIL_ALL_BORDERS;
      if (col.key === 'condition' && style) {
        cell.font = { bold: true, color: { argb: style.font } };
      }
    });
  });

  if (config.rows.length === 0) {
    const emptyRow = dataWs.addRow([config.emptyMessage || '—']);
    dataWs.mergeCells(emptyRow.number, 1, emptyRow.number, colCount);
    emptyRow.getCell(1).alignment = { horizontal: 'center' };
    emptyRow.getCell(1).font = { italic: true, color: { argb: 'FF666666' } };
  } else {
    const lastRow = dataHeaderRow.number + config.rows.length;
    dataWs.autoFilter = { from: { row: dataHeaderRow.number, column: 1 }, to: { row: lastRow, column: colCount } };
  }

  dataWs.views = [{ rightToLeft: isRtl, state: 'frozen', ySplit: dataHeaderRow.number }];

  // ── Data Dictionary sheet ──────────────────────────────────────────────
  const dictWs = wb.addWorksheet(safeSheetName(OUTLET_REPORT_SHEET_NAMES.dictionary), { views: [{ rightToLeft: isRtl }] });
  dictWs.columns = [{ key: 'field', width: 28 }, { key: 'description', width: 70 }];

  const dictTitleRow = dictWs.addRow([OUTLET_REPORT_META_LABELS.dictionaryTitle]);
  dictWs.mergeCells(dictTitleRow.number, 1, dictTitleRow.number, 2);
  dictTitleRow.getCell(1).font = { bold: true, size: 14, color: { argb: BRAND_NAVY } };
  dictTitleRow.height = 22;

  const dictHeaderRow = dictWs.addRow([OUTLET_REPORT_META_LABELS.field, OUTLET_REPORT_META_LABELS.description]);
  dictHeaderRow.eachCell(cell => {
    cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: BRAND_TEAL } };
    cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
    cell.border = AVAIL_ALL_BORDERS;
  });

  OUTLET_REPORT_DICTIONARY.forEach((entry, i) => {
    const row = dictWs.addRow([entry.field, entry.description]);
    const altFill = i % 2 === 1 ? BRAND_ALT_ROW : undefined;
    row.eachCell((cell, colNumber) => {
      cell.alignment = { vertical: 'top', horizontal: isRtl ? 'right' : 'left', wrapText: colNumber === 2 };
      cell.border = AVAIL_ALL_BORDERS;
      if (altFill) cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: altFill } };
    });
    row.getCell(1).font = { bold: true };
  });

  dictWs.views = [{ rightToLeft: isRtl, state: 'frozen', ySplit: dictHeaderRow.number }];

  return wb;
}

/**
 * Builds the outlet report workbook and downloads it as a true `.xlsx` file.
 * Returns false (never throws) on failure — mirrors exportAvailabilityXlsx's
 * error-handling contract.
 */
export async function exportOutletReportXlsx(config: OutletReportConfig): Promise<boolean> {
  try {
    const wb = await buildOutletReportWorkbook(config);
    const buffer = await wb.xlsx.writeBuffer();
    const blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
    return await downloadBlob(buildStableFileName(config.fileNameBase, 'xlsx'), blob);
  } catch {
    return false;
  }
}
