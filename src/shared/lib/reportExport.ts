/**
 * FINAL-EXPORT-REPORTS-PRO-A
 *
 * Shared, dependency-free helpers for building professional CSV exports and
 * printable/PDF-able report HTML. Extracted to stop the CSV-injection guard,
 * HTML escaper, and print-popup boilerplate from drifting out of sync across
 * screens (StatusEditorScreen previously had none of this at all).
 *
 * This module intentionally stays plain-text/CSV — it does NOT produce a real
 * .xlsx workbook (no xlsx/exceljs/sheetjs dependency exists in this repo).
 * Every "Excel" export in the product is a UTF-8-BOM CSV file that Excel can
 * open correctly; label copy must say "CSV" or "Excel-compatible CSV", never
 * claim real .xlsx.
 */

export const REPORT_BRAND = 'MediStock-Babil / MASAR Health Network';

/** HTML-entity escape for safe interpolation into generated print documents. */
export function escHtml(s: string): string {
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/**
 * CSV-injection guard: a cell value beginning with =, +, -, or @ can be
 * interpreted as a formula by Excel/Sheets when the file is opened. A
 * leading apostrophe forces plain-text treatment without altering the value.
 */
export function csvSafeCell(v: string): string {
  return /^[=+\-@]/.test(v) ? `'${v}` : v;
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * Stable, filesystem-safe file name: `<base>_YYYY-MM-DD_HH-mm.<ext>`.
 * Strips characters download managers/OSes commonly reject, without altering
 * the human-readable base text.
 */
export function buildStableFileName(base: string, ext: string, when: Date = new Date()): string {
  const safeBase = base
    .replace(/[^\p{L}\p{N}_-]+/gu, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '') || 'report';
  const stamp = `${when.getFullYear()}-${pad2(when.getMonth() + 1)}-${pad2(when.getDate())}_${pad2(when.getHours())}-${pad2(when.getMinutes())}`;
  return `${safeBase}_${stamp}.${ext}`;
}

export interface ReportColumn<T> {
  key: string;
  label: string;
  value: (row: T) => string;
  /** Digit/date-shaped columns that must render dir="ltr" to avoid bidi reordering in RTL layout. */
  ltr?: boolean;
}

/**
 * Builds a UTF-8-BOM CSV string (Excel-compatible) with an optional leading
 * report-metadata block (title / org / generated-at / filters / row count),
 * a blank separator line, the column header row, then data rows. All cells
 * are quote-wrapped, quote-doubled, and passed through csvSafeCell.
 */
export function buildCsvContent<T>(
  columns: ReportColumn<T>[],
  rows: T[],
  metadataLines?: string[],
): string {
  const bom = '﻿';
  const cell = (v: string) => `"${csvSafeCell(v).replace(/"/g, '""')}"`;
  const lines: string[] = [];
  if (metadataLines?.length) {
    for (const line of metadataLines) lines.push(cell(line));
    lines.push('');
  }
  lines.push(columns.map(c => cell(c.label)).join(','));
  for (const r of rows) lines.push(columns.map(c => cell(String(c.value(r)))).join(','));
  return bom + lines.join('\r\n');
}

/** Client-side Blob download. Returns false (never throws) if the browser blocks/fails it. */
export function downloadTextFile(filename: string, content: string, mime: string): boolean {
  try {
    const blob = new Blob([content], { type: mime });
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

export interface PrintDocumentOptions<T> {
  lang: 'ar' | 'en';
  title: string;
  /** e.g. organization / institution / outlet name, shown under the title. */
  subtitle?: string;
  /** Metadata lines rendered above the table (label already-translated, value raw). */
  metaLines: { label: string; value: string; ltr?: boolean }[];
  columns: ReportColumn<T>[];
  rows: T[];
  footerText: string;
  emptyMessage?: string;
}

/**
 * Builds a full, self-contained print/PDF HTML document: brand header,
 * title/subtitle, metadata block, data table (or empty-state message), and
 * footer. Always uses a fixed light theme (never the app's dark-mode CSS
 * vars) so printed/PDF output stays legible regardless of the on-screen
 * theme. Every user/DB-derived value is passed through escHtml.
 */
export function buildPrintDocument<T>(opts: PrintDocumentOptions<T>): string {
  const { lang, title, subtitle, metaLines, columns, rows, footerText, emptyMessage } = opts;
  const dir = lang === 'ar' ? 'rtl' : 'ltr';
  const headCells = columns.map(c => `<th>${escHtml(c.label)}</th>`).join('');
  const bodyRows = rows.map(r =>
    '<tr>' + columns.map(c => `<td${c.ltr ? ' dir="ltr"' : ''}>${escHtml(c.value(r))}</td>`).join('') + '</tr>'
  ).join('');
  const metaHtml = metaLines
    .map(m => `<div class="meta">${escHtml(m.label)}: <span${m.ltr ? ' class="val" dir="ltr"' : ''}>${escHtml(m.value)}</span></div>`)
    .join('');
  const bodyHtml = rows.length > 0
    ? `<table><thead><tr>${headCells}</tr></thead><tbody>${bodyRows}</tbody></table>`
    : `<div class="empty">${escHtml(emptyMessage || '—')}</div>`;

  return `<!doctype html><html dir="${dir}" lang="${lang}"><head><meta charset="utf-8">
<title>${escHtml(title)}</title>
<style>
  @page { size: A4 landscape; margin: 12mm; }
  * { box-sizing: border-box; }
  html, body { background: #fff; }
  body { font-family: ${lang === 'ar' ? "'Segoe UI', Tahoma, Arial" : 'Arial, sans-serif'}; color: #111; direction: ${dir}; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 2px; }
  .subtitle { font-size: 12.5px; color: #333; margin: 0 0 8px; font-weight: 600; }
  .brand { font-size: 11px; color: #555; margin-bottom: 10px; }
  .meta { font-size: 11px; color: #333; margin: 2px 0; }
  .meta .val { unicode-bidi: isolate; }
  table { width: 100%; border-collapse: collapse; margin-top: 12px; font-size: 10px; table-layout: auto; }
  th, td { border: 1px solid #999; padding: 4px 6px; text-align: ${lang === 'ar' ? 'right' : 'left'}; white-space: nowrap; }
  th { background: #eee; }
  thead { display: table-header-group; }
  tr { page-break-inside: avoid; }
  .empty { padding: 24px 0; text-align: center; color: #555; font-size: 12.5px; }
  .footer { margin-top: 18px; padding-top: 8px; border-top: 1px solid #ccc; font-size: 10px; color: #666; }
  @media print {
    body { padding: 0; }
    a { color: inherit; text-decoration: none; }
  }
</style></head><body>
  <h1>${escHtml(title)}</h1>
  ${subtitle ? `<div class="subtitle">${escHtml(subtitle)}</div>` : ''}
  <div class="brand">${escHtml(REPORT_BRAND)}</div>
  ${metaHtml}
  ${bodyHtml}
  <div class="footer">${escHtml(footerText)}</div>
</body></html>`;
}

/**
 * Opens a popup window, writes the given print document into it, and
 * triggers the browser print dialog. Returns false (does nothing further)
 * if the popup was blocked — callers must show a translated toast in that
 * case (see the `print_popup_blocked` i18n key, shared across every print
 * flow in the app).
 *
 * window.open is called synchronously by the caller's onClick handler (never
 * after an intervening await) — Safari's user-gesture heuristics silently
 * block window.open once a microtask/await boundary has been crossed.
 *
 * BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A: this is a DESKTOP-ONLY primitive.
 * On mobile browsers/PWA/webview contexts, `window.open('', '_blank')` +
 * `window.print()` can switch to a native print UI, open an external tab, or
 * otherwise make the app appear to exit. Callers must check
 * `isLikelyMobilePrintContext()` first and route mobile users through the
 * in-app fallback (see `MobilePrintFallbackModal`) instead of calling this
 * directly.
 */
export function openPrintWindow(html: string): boolean {
  const win = window.open('', '_blank');
  if (!win) return false;
  win.document.write(html);
  win.document.close();
  win.focus();
  win.print();
  win.close();
  return true;
}

/**
 * BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A
 *
 * Best-effort, defensive detection of a "mobile print is risky" context.
 * Any one of the three signals is enough to treat the context as mobile:
 *  - narrow viewport (<=768px) — matches the app's existing isMobile checks;
 *  - a mobile-indicating User-Agent substring;
 *  - standalone/PWA display-mode (installed home-screen app), where
 *    `window.open` most commonly breaks out of the app shell entirely.
 *
 * Never throws: every browser API touched here is optional/inconsistently
 * supported, so each check is wrapped defensively and any failure is treated
 * as "not mobile" (falls back to the existing desktop print behavior rather
 * than blocking it).
 */
export function isLikelyMobilePrintContext(): boolean {
  try {
    if (typeof window === 'undefined') return false;

    let narrow = false;
    try {
      narrow = typeof window.innerWidth === 'number' && window.innerWidth <= 768;
    } catch { /* ignore */ }

    let uaMobile = false;
    try {
      const ua = typeof navigator !== 'undefined' ? (navigator.userAgent || '') : '';
      uaMobile = /Android|iPhone|iPad|iPod|Mobile|IEMobile|BlackBerry|webOS|Opera Mini/i.test(ua);
    } catch { /* ignore */ }

    let standalone = false;
    try {
      standalone = typeof window.matchMedia === 'function' && window.matchMedia('(display-mode: standalone)').matches;
    } catch { /* ignore */ }

    return narrow || uaMobile || standalone;
  } catch {
    return false;
  }
}

/**
 * Downloads the already-built print/report HTML as a standalone `.html`
 * file the user can open/share/print later from their own file manager or
 * browser — the mobile-safe alternative to immediately calling
 * `window.print()`. This is plain HTML, never a real PDF; callers must label
 * it accordingly (e.g. "Download printable HTML" / "تحميل نسخة HTML قابلة
 * للطباعة") and never claim it is a `.pdf`.
 */
export function downloadPrintableHtml(html: string, fileNameBase: string, when: Date = new Date()): boolean {
  return downloadTextFile(buildStableFileName(fileNameBase, 'html', when), html, 'text/html;charset=utf-8;');
}
