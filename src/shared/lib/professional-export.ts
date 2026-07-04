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
  const columns = sanitizedColumns(config);
  const metaLines = buildMetaLines(config);
  const isRtl = config.lang === 'ar';
  const colCount = Math.max(columns.length, 1);

  const wb = new ExcelJSRuntime.Workbook();
  wb.creator = 'MediStock Phoenix';
  wb.created = config.generatedAt;
  wb.modified = config.generatedAt;

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

  return wb;
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
