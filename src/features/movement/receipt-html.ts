/**
 * MOVEMENT-COMPOSER-A — the printable receipt document.
 *
 * Reuses the established print infrastructure (escHtml, openPrintWindow,
 * isLikelyMobilePrintContext, downloadPrintableHtml, MobilePrintFallbackModal).
 * This is NOT a second print engine — it is one more document built on the same
 * primitives the reports already use.
 *
 * EVERY interpolated value passes through escHtml. Material names, notes,
 * institution names and operator references are all user- or DB-supplied, and a
 * receipt is exactly the kind of document that gets forwarded onward.
 */
import { escHtml, REPORT_BRAND } from '@/shared/lib/reportExport';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { shortTraceKey } from './movement-trace';
import {
  orientationFor, receiptCellValue, RECEIPT_FIELDS,
  type ReceiptDocument, type ReceiptFieldKey,
} from './receipt-model';

const TITLE_KEY: Record<ReceiptDocument['kind'], string> = {
  supply_request: 'mv_doc_supply_request',
  supply_dispatch: 'mv_doc_supply_dispatch',
  return_request: 'mv_doc_return_request',
  return_shipment: 'mv_doc_return_shipment',
  procurement_receipt: 'mv_doc_procurement_receipt',
};

const WATERMARK_KEY: Record<Exclude<ReceiptDocument['watermark'], 'none'>, string> = {
  draft: 'mv_wm_draft',
  partial: 'mv_wm_partial',
  cancelled: 'mv_wm_cancelled',
  reprint: 'mv_wm_reprint',
};

export interface ReceiptHtmlOptions {
  document: ReceiptDocument;
  selectedFields: readonly ReceiptFieldKey[];
  lang: Lang;
  /** Data URL for the trace QR. Omitted only when generation failed. */
  qrDataUrl?: string | null;
}

const dash = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);

function partyText(party: { organizationName: string | null; warehouseName: string | null }): string {
  // The institution and its depot are ALWAYS shown together — a warehouse name
  // alone is ambiguous across institutions.
  const org = dash(party.organizationName);
  const wh = dash(party.warehouseName);
  return `${org} — ${wh}`;
}

/**
 * Build the complete, self-contained receipt HTML.
 *
 * Print styling is a fixed white high-contrast theme regardless of the app
 * theme: a dark-theme receipt wastes ink and reads badly on paper.
 */
export function buildReceiptHtml({ document: doc, selectedFields, lang, qrDataUrl }: ReceiptHtmlOptions): string {
  const rtl = lang === 'ar';
  const dir = rtl ? 'rtl' : 'ltr';
  const orientation = orientationFor(selectedFields);
  const isReturn = doc.kind === 'return_request' || doc.kind === 'return_shipment';

  const labelFor = (key: ReceiptFieldKey) => {
    const def = RECEIPT_FIELDS.find(f => f.key === key);
    return def ? t(def.labelKey, lang) : key;
  };

  const headerRows: Array<[string, string]> = [
    [t('mv_h_document_type', lang), t(TITLE_KEY[doc.kind], lang)],
    [t('mv_h_trace_key', lang), `${shortTraceKey(doc.traceKey)} · ${doc.traceKey}`],
    [t('mv_h_status', lang), dash(doc.status)],
    [t('mv_h_event_at', lang), dash(doc.eventAt)],
    [t('mv_h_source', lang), partyText(doc.source)],
    [t('mv_h_destination', lang), partyText(doc.destination)],
  ];
  // Operator-typed value is labelled as an external reference, never a serial.
  headerRows.push([t('mv_external_reference', lang), dash(doc.externalReference)]);
  if (doc.requestTraceKey) headerRows.push([t('mv_h_request_reference', lang), doc.requestTraceKey]);
  if (isReturn && doc.originalSupplyTraceKey) {
    headerRows.push([t('mv_h_original_supply_reference', lang), doc.originalSupplyTraceKey]);
  }
  // PAPER-REFERENCE-CONTRACT-110: shown only when a caller has fetched and
  // attached one — additive, never replacing the trace key above. Matches
  // receipt-xlsx.ts's identical rendering rule.
  if (doc.paperReferenceNumber) {
    headerRows.push([t('mv_h_paper_reference_number', lang), doc.paperReferenceNumber]);
    headerRows.push([t('mv_h_paper_reference_date', lang), dash(doc.paperReferenceDate)]);
    headerRows.push([t('mv_h_issuing_authority', lang), dash(doc.issuingAuthority)]);
  }
  // Identity is shown only when RLS actually exposed it; never inferred.
  headerRows.push([
    t(isReturn ? 'mv_h_returned_by' : 'mv_h_dispatched_by', lang),
    doc.actorName ? `${doc.actorName}${doc.actorRole ? ` (${doc.actorRole})` : ''}` : t('mv_not_available', lang),
  ]);
  headerRows.push([
    t(isReturn ? 'mv_h_received_disposition' : 'mv_h_receiver', lang),
    dash(doc.counterpartyName) === '—' ? t('mv_not_available', lang) : (doc.counterpartyName as string),
  ]);
  if (doc.reprintedAt) headerRows.push([t('mv_h_reprinted_at', lang), doc.reprintedAt]);

  const headerHtml = headerRows
    .map(([k, v]) => `<div class="meta-row"><span class="meta-k">${escHtml(k)}</span><span class="meta-v">${escHtml(v)}</span></div>`)
    .join('');

  const theadHtml = selectedFields.map(k => `<th>${escHtml(labelFor(k))}</th>`).join('');
  const bodyHtml = doc.lines.length === 0
    ? `<tr><td class="empty" colspan="${selectedFields.length}">${escHtml(t('mv_no_lines', lang))}</td></tr>`
    : doc.lines
      .map(line => `<tr>${selectedFields.map(k => `<td>${escHtml(receiptCellValue(line, k))}</td>`).join('')}</tr>`)
      .join('');

  const watermarkHtml = doc.watermark === 'none'
    ? ''
    : `<div class="watermark" aria-hidden="true">${escHtml(t(WATERMARK_KEY[doc.watermark], lang))}</div>`;

  const qrHtml = qrDataUrl
    ? `<img class="qr" src="${escHtml(qrDataUrl)}" alt="${escHtml(t('mv_h_trace_key', lang))}" />`
    : `<div class="qr qr-missing">${escHtml(shortTraceKey(doc.traceKey))}</div>`;

  return `<!DOCTYPE html>
<html lang="${escHtml(lang)}" dir="${dir}">
<head>
<meta charset="utf-8" />
<title>${escHtml(t(TITLE_KEY[doc.kind], lang))} · ${escHtml(shortTraceKey(doc.traceKey))}</title>
<style>
  @page { size: A4 ${orientation}; margin: 14mm 12mm 16mm; }
  /* Fixed white high-contrast print theme in BOTH app themes. */
  html, body { background: #fff; color: #111; }
  body {
    font-family: ${rtl ? "'IBM Plex Sans Arabic','Noto Sans Arabic'," : ''}'Inter','DM Sans',system-ui,sans-serif;
    font-size: 10.5pt; line-height: 1.45; margin: 0; -webkit-print-color-adjust: exact; print-color-adjust: exact;
  }
  .sheet { position: relative; }
  header.doc { display: flex; justify-content: space-between; align-items: flex-start; gap: 12mm;
    border-bottom: 1.4pt solid #111; padding-bottom: 4mm; margin-bottom: 5mm; }
  .brand { font-size: 8.5pt; letter-spacing: .04em; text-transform: uppercase; color: #444; }
  h1 { font-size: 15pt; margin: 1mm 0 0; font-weight: 700; }
  .qr { width: 26mm; height: 26mm; flex: 0 0 auto; }
  .qr-missing { display: flex; align-items: center; justify-content: center;
    border: 1pt dashed #777; font: 700 9pt/1 monospace; color: #444; }
  .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 1.2mm 8mm; margin-bottom: 5mm; }
  .meta-row { display: flex; gap: 3mm; border-bottom: .4pt dotted #bbb; padding-bottom: .8mm; }
  .meta-k { color: #444; font-weight: 600; min-width: 34mm; }
  .meta-v { font-weight: 600; }
  table { width: 100%; border-collapse: collapse; }
  th, td { border: .5pt solid #999; padding: 1.6mm 2mm; text-align: ${rtl ? 'right' : 'left'}; vertical-align: top; }
  thead th { background: #ececec; font-weight: 700; font-size: 9.5pt; }
  /* Header repeats on every page; a material row is never split across pages. */
  thead { display: table-header-group; }
  tfoot { display: table-footer-group; }
  tr { break-inside: avoid; page-break-inside: avoid; }
  td.empty { text-align: center; color: #666; padding: 6mm; }
  .sign { display: flex; gap: 14mm; margin-top: 10mm; break-inside: avoid; }
  .sign div { flex: 1; border-top: .8pt solid #111; padding-top: 2mm; font-size: 9pt; color: #333; }
  footer.doc { margin-top: 6mm; border-top: .5pt solid #bbb; padding-top: 2mm;
    font-size: 8pt; color: #555; display: flex; justify-content: space-between; }
  .watermark { position: fixed; inset: 0; display: flex; align-items: center; justify-content: center;
    font-size: 58pt; font-weight: 800; color: rgba(17,17,17,.10); transform: rotate(-28deg);
    pointer-events: none; letter-spacing: .06em; }
  /* Page numbering via a counter in the running footer. */
  .page-counter::after { counter-increment: page; content: counter(page); }
  @media print { .noprint { display: none !important; } }
</style>
</head>
<body>
<div class="sheet">
  ${watermarkHtml}
  <header class="doc">
    <div>
      <div class="brand">${escHtml(REPORT_BRAND)}</div>
      <h1>${escHtml(t(TITLE_KEY[doc.kind], lang))}</h1>
    </div>
    ${qrHtml}
  </header>
  <section class="meta">${headerHtml}</section>
  <table>
    <thead><tr>${theadHtml}</tr></thead>
    <tbody>${bodyHtml}</tbody>
  </table>
  <div class="sign">
    <div>${escHtml(t('mv_sign_issuer', lang))}</div>
    <div>${escHtml(t('mv_sign_receiver', lang))}</div>
  </div>
  <footer class="doc">
    <span>${escHtml(shortTraceKey(doc.traceKey))} · ${escHtml(doc.traceKey)}</span>
    <span>${escHtml(t('mv_page', lang))} <span class="page-counter"></span></span>
  </footer>
</div>
</body>
</html>`;
}
