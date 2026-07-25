/**
 * MOVEMENT-COMPOSER-A — receipt actions (print · genuine XLSX · QR) for a
 * server-reloaded canonical document.
 *
 * This component NEVER fetches or builds a document itself: the caller passes a
 * ReceiptDocument that was mapped from canonical server rows (see
 * receipt-source.ts). That keeps the "documents come from server state, not a
 * client draft" rule structural — there is no draft in scope here to leak.
 *
 * The QR encodes ONLY the namespace, version, document kind and opaque uuid via
 * buildMovementQrPayload — no material, quantity, party or price data. It is a
 * locator that every reader must re-resolve through RLS.
 */
import { useState } from 'react';
import QRCode from 'qrcode';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { openPrintWindow, downloadPrintableHtml, isLikelyMobilePrintContext } from '@/shared/lib/reportExport';
import { buildReceiptHtml } from '../receipt-html';
import { exportReceiptXlsx, type ReceiptExceptionRow } from '../receipt-xlsx';
import { buildMovementQrPayload, shortTraceKey } from '../movement-trace';
import { fieldsForPreset, type ReceiptDocument, type ReceiptFieldKey } from '../receipt-model';
import { MovementPrintFieldSelector } from './MovementPrintFieldSelector';

interface Props {
  document: ReceiptDocument;
  lang: Lang;
  /** Only when the viewer is authorized to see pricing. Fail-closed default. */
  canSeePrices?: boolean;
  /** Discrepancies/warnings for the XLSX exceptions sheet. */
  exceptions?: readonly ReceiptExceptionRow[];
}

async function qrFor(doc: ReceiptDocument): Promise<string | null> {
  try {
    const payload = buildMovementQrPayload(doc.kind, doc.traceKey);
    return await QRCode.toDataURL(payload, { width: 240, margin: 2, color: { dark: '#111111', light: '#ffffff' } });
  } catch {
    // A trace key that is not a uuid (should never happen for a saved row) or a
    // QR failure must not fabricate a code — the receipt falls back to the short key.
    return null;
  }
}

export function MovementDocumentActions({ document: doc, lang, canSeePrices = false, exceptions = [] }: Props) {
  const isReturn = doc.kind === 'return_request' || doc.kind === 'return_shipment';
  const [pickerOpen, setPickerOpen] = useState(false);
  const [qrOpen, setQrOpen] = useState(false);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const print = async (selected: ReceiptFieldKey[]) => {
    setBusy(true);
    const qrDataUrl = await qrFor(doc);
    const html = buildReceiptHtml({ document: doc, selectedFields: selected, lang, qrDataUrl });
    // Same print infrastructure the reports use; mobile falls back to a download.
    const ok = isLikelyMobilePrintContext()
      ? downloadPrintableHtml(html, `${doc.kind}-${shortTraceKey(doc.traceKey)}`)
      : openPrintWindow(html);
    if (!ok) setNote(t('mv_print', lang));
    setBusy(false);
    setPickerOpen(false);
  };

  const exportXlsx = async () => {
    setBusy(true);
    // The workbook exports the FULL available column set (print lets the operator
    // narrow it); exceptions are always written, even when empty.
    const selected = fieldsForPreset('full', { isReturn, canSeePrices });
    const ok = await exportReceiptXlsx({ document: doc, selectedFields: selected, lang, exceptions });
    if (!ok) setNote(t('mv_print', lang));
    setBusy(false);
  };

  const showQr = async () => {
    setQrOpen(true);
    setQrUrl(await qrFor(doc));
  };

  return (
    <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
      <PhoenixButton variant="secondary" disabled={busy} onClick={() => setPickerOpen(true)} data-testid="mv-print">
        {t('mv_print', lang)}
      </PhoenixButton>
      <PhoenixButton variant="secondary" disabled={busy} onClick={() => void exportXlsx()} data-testid="mv-xlsx">
        {t('mv_export_xlsx', lang)}
      </PhoenixButton>
      <PhoenixButton variant="ghost" disabled={busy} onClick={() => void showQr()} data-testid="mv-qr">
        {t('mv_h_trace_key', lang)}
      </PhoenixButton>
      {note && <span style={{ fontSize: '11.5px', color: 'var(--t2)' }}>{note}</span>}

      <MovementPrintFieldSelector
        open={pickerOpen}
        lang={lang}
        isReturn={isReturn}
        canSeePrices={canSeePrices}
        onClose={() => setPickerOpen(false)}
        onPrint={selected => void print(selected)}
        renderPreview={selected => (
          <iframe
            title={t('mv_live_preview', lang)}
            style={{ width: '100%', height: '300px', border: 'none' }}
            srcDoc={buildReceiptHtml({ document: doc, selectedFields: selected, lang, qrDataUrl: null })}
          />
        )}
      />

      <PhoenixDialog open={qrOpen} onClose={() => setQrOpen(false)} title={t('mv_h_trace_key', lang)} maxWidth={340}>
        <div style={{ display: 'grid', gap: '10px', justifyItems: 'center', padding: '6px' }}>
          {qrUrl
            ? <img src={qrUrl} alt={t('mv_h_trace_key', lang)} style={{ width: '220px', height: '220px' }} />
            : <code style={{ fontSize: '13px' }}>{shortTraceKey(doc.traceKey)}</code>}
          <code style={{ fontSize: '11px', color: 'var(--t2)', wordBreak: 'break-all', textAlign: 'center' }}>{doc.traceKey}</code>
          {/* PAPER-REFERENCE-CONTRACT-110: informational text ONLY — never part
              of the QR payload above, which stays namespace/kind/uuid only. */}
          {doc.paperReferenceNumber && (
            <p style={{ fontSize: '11px', color: 'var(--t2)', textAlign: 'center', margin: 0 }}>
              {t('mv_h_paper_reference_number', lang)}: {doc.paperReferenceNumber}
            </p>
          )}
          <p style={{ fontSize: '11px', color: 'var(--t2)', textAlign: 'center', margin: 0 }}>
            {t('mv_external_reference_hint', lang)}
          </p>
        </div>
      </PhoenixDialog>
    </div>
  );
}
