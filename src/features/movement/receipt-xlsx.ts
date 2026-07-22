/**
 * MOVEMENT-COMPOSER-A — genuine XLSX for supply/return documents.
 *
 * A real ExcelJS workbook, not a CSV renamed .xlsx. Three sheets, because a
 * receipt has three distinct audiences: the header facts, the material lines,
 * and the things that went wrong.
 *
 * SPREADSHEET FORMULA INJECTION: every string cell goes through the existing
 * neutralizeFormulaValue. A material name or note beginning =, +, -, @, TAB or
 * CR is data, and Excel must not evaluate it when the file is opened elsewhere.
 */
import ExcelJS from 'exceljs';
import { neutralizeFormulaValue } from '@/shared/lib/professional-export';
import { buildStableFileName } from '@/shared/lib/reportExport';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { shortTraceKey } from './movement-trace';
import { RECEIPT_FIELDS, receiptCellValue, type ReceiptDocument, type ReceiptFieldKey } from './receipt-model';

const TITLE_KEY: Record<ReceiptDocument['kind'], string> = {
  supply_request: 'mv_doc_supply_request',
  supply_dispatch: 'mv_doc_supply_dispatch',
  return_request: 'mv_doc_return_request',
  return_shipment: 'mv_doc_return_shipment',
  procurement_receipt: 'mv_doc_procurement_receipt',
};

/** Every string that reaches a cell is neutralized. Numbers stay numbers. */
function safeCell(value: string): string {
  return neutralizeFormulaValue(value);
}

const party = (p: { organizationName: string | null; warehouseName: string | null }) =>
  `${p.organizationName ?? '—'} — ${p.warehouseName ?? '—'}`;

export interface ReceiptExceptionRow {
  lineNumber: number | null;
  scientificName: string | null;
  kind: string;
  detail: string;
}

export interface ReceiptWorkbookConfig {
  document: ReceiptDocument;
  selectedFields: readonly ReceiptFieldKey[];
  lang: Lang;
  /** Failed lines, discrepancies and warnings. Never silently omitted. */
  exceptions?: readonly ReceiptExceptionRow[];
}

export async function buildReceiptWorkbook(config: ReceiptWorkbookConfig): Promise<ExcelJS.Workbook> {
  const { document: doc, selectedFields, lang, exceptions = [] } = config;
  const rtl = lang === 'ar';

  const workbook = new ExcelJS.Workbook();
  workbook.creator = 'MediStock-Babil / MASAR';
  workbook.created = new Date();

  // ── Sheet 1: Summary — the mandatory, locked trace header ────────────────
  const summary = workbook.addWorksheet(t('mv_sheet_summary', lang), {
    views: [{ rightToLeft: rtl }],
  });
  summary.columns = [{ width: 34 }, { width: 62 }];

  const headerRows: Array<[string, string]> = [
    [t('mv_h_document_type', lang), t(TITLE_KEY[doc.kind], lang)],
    [t('mv_h_trace_key', lang), doc.traceKey],
    [t('mv_h_trace_key', lang) + ' (short)', shortTraceKey(doc.traceKey)],
    [t('mv_external_reference', lang), doc.externalReference ?? '—'],
    [t('mv_h_status', lang), doc.status],
    [t('mv_h_event_at', lang), doc.eventAt ?? '—'],
    [t('mv_h_source', lang), party(doc.source)],
    [t('mv_h_destination', lang), party(doc.destination)],
    [t('mv_h_request_reference', lang), doc.requestTraceKey ?? '—'],
    [t('mv_h_original_supply_reference', lang), doc.originalSupplyTraceKey ?? '—'],
    [
      t(doc.kind === 'return_shipment' ? 'mv_h_returned_by' : 'mv_h_dispatched_by', lang),
      doc.actorName ? `${doc.actorName}${doc.actorRole ? ` (${doc.actorRole})` : ''}` : t('mv_not_available', lang),
    ],
    [t('mv_h_receiver', lang), doc.counterpartyName ?? t('mv_not_available', lang)],
  ];

  // A non-final document says so in the workbook, not only on the printout.
  if (doc.watermark !== 'none') {
    headerRows.unshift([
      t('mv_h_status', lang),
      t(`mv_wm_${doc.watermark}`, lang),
    ]);
  }

  const titleRow = summary.addRow([safeCell(t(TITLE_KEY[doc.kind], lang)), '']);
  titleRow.font = { bold: true, size: 14 };
  summary.addRow([]);

  for (const [key, value] of headerRows) {
    const row = summary.addRow([safeCell(key), safeCell(value)]);
    row.getCell(1).font = { bold: true };
  }

  // ── Sheet 2: Material Lines — exactly the selected columns ───────────────
  const linesSheet = workbook.addWorksheet(t('mv_sheet_lines', lang), {
    views: [{ rightToLeft: rtl, state: 'frozen', ySplit: 1 }],
  });

  const labelFor = (key: ReceiptFieldKey) => {
    const def = RECEIPT_FIELDS.find(f => f.key === key);
    return def ? t(def.labelKey, lang) : key;
  };

  linesSheet.columns = selectedFields.map(key => ({
    header: safeCell(labelFor(key)),
    key,
    width: key === 'scientificName' ? 32 : key === 'notes' ? 30 : 16,
  }));
  linesSheet.getRow(1).font = { bold: true };
  linesSheet.getRow(1).fill = {
    type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFECECEC' },
  };

  for (const line of doc.lines) {
    const row: Record<string, string | number> = {};
    for (const key of selectedFields) {
      const raw = (line as unknown as Record<string, unknown>)[key];
      // Genuine numbers stay numeric so the sheet can be summed; everything
      // else is neutralized text.
      row[key] = typeof raw === 'number' ? raw : safeCell(receiptCellValue(line, key));
    }
    linesSheet.addRow(row);
  }
  linesSheet.autoFilter = {
    from: { row: 1, column: 1 },
    to: { row: 1, column: Math.max(selectedFields.length, 1) },
  };

  // ── Sheet 3: Exceptions — always present, even when empty ────────────────
  // An absent sheet would be indistinguishable from "not checked".
  const exceptionsSheet = workbook.addWorksheet(t('mv_sheet_exceptions', lang), {
    views: [{ rightToLeft: rtl, state: 'frozen', ySplit: 1 }],
  });
  exceptionsSheet.columns = [
    { header: safeCell(t('mv_f_line_number', lang)), key: 'lineNumber', width: 10 },
    { header: safeCell(t('mv_f_scientific_name', lang)), key: 'scientificName', width: 32 },
    { header: safeCell(t('mv_exception_kind', lang)), key: 'kind', width: 24 },
    { header: safeCell(t('mv_exception_detail', lang)), key: 'detail', width: 60 },
  ];
  exceptionsSheet.getRow(1).font = { bold: true };

  if (exceptions.length === 0) {
    exceptionsSheet.addRow({ lineNumber: null, scientificName: null, kind: safeCell(t('mv_no_exceptions', lang)), detail: '' });
  } else {
    for (const row of exceptions) {
      exceptionsSheet.addRow({
        lineNumber: row.lineNumber ?? '',
        scientificName: safeCell(row.scientificName ?? '—'),
        kind: safeCell(row.kind),
        detail: safeCell(row.detail),
      });
    }
  }

  return workbook;
}

/** Write the workbook to a real .xlsx download. Returns false if blocked. */
export async function exportReceiptXlsx(config: ReceiptWorkbookConfig): Promise<boolean> {
  try {
    const workbook = await buildReceiptWorkbook(config);
    const buffer = await workbook.xlsx.writeBuffer();
    const blob = new Blob([buffer], {
      type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });
    const name = buildStableFileName(
      `${config.document.kind}-${shortTraceKey(config.document.traceKey)}`,
      'xlsx',
    );
    const url = URL.createObjectURL(blob);
    try {
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = name;
      anchor.click();
    } finally {
      URL.revokeObjectURL(url);
    }
    return true;
  } catch {
    return false;
  }
}
