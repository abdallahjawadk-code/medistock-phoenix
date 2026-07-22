import { useEffect, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { downloadPrintableHtml, openPrintWindow } from '@/shared/lib/reportExport';
import { PhoenixDialog } from './PhoenixDialog';
import { PhoenixButton } from './PhoenixButton';
import { PhoenixToast } from './PhoenixToast';
import { PhoenixIcon } from './PhoenixIcon';

/**
 * BUGFIX-MOBILE-PRINT-DOES-NOT-EXIT-APP-A
 *
 * In-app fallback shown instead of immediately calling `window.print()` on
 * mobile/PWA/webview contexts, where that call can switch to a native print
 * UI, open an external tab, or otherwise make the app appear to exit.
 *
 * Offers three actions on an already-built, already-escaped report HTML
 * document (from `buildPrintDocument`/`buildReportHtml`):
 *   1. Preview the report in-app (iframe `srcDoc` — never
 *      `dangerouslySetInnerHTML`; the HTML is rendered in its own isolated
 *      document, not injected into this page's DOM).
 *   2. Download it as a standalone `.html` file (never mislabeled as PDF).
 *   3. "Use system print" — requires an explicit second tap (a warning +
 *      confirm step) before calling the same desktop `openPrintWindow` path.
 */

interface Props {
  open: boolean;
  html: string;
  title: string;
  fileNameBase: string;
  lang: 'ar' | 'en';
  onClose: () => void;
}

export function MobilePrintFallbackModal({ open, html, title, fileNameBase, lang, onClose }: Props) {
  const [previewOpen, setPreviewOpen] = useState(false);
  const [confirmingSystemPrint, setConfirmingSystemPrint] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  // Reset transient UI state every time the modal is (re)opened/closed so a
  // stale confirm/preview state never leaks into the next report.
  useEffect(() => {
    if (!open) {
      setPreviewOpen(false);
      setConfirmingSystemPrint(false);
      setToast(null);
    }
  }, [open]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  function handleDownload() {
    const ok = downloadPrintableHtml(html, fileNameBase);
    showToast(t(ok ? 'mobile_print_download_ok' : 'mobile_print_download_failed', lang));
  }

  function handleConfirmSystemPrint() {
    const ok = openPrintWindow(html);
    setConfirmingSystemPrint(false);
    if (!ok) showToast(t('mobile_print_open_failed', lang));
  }

  function handleClose() {
    setPreviewOpen(false);
    setConfirmingSystemPrint(false);
    onClose();
  }

  const rowBtnStyle = { minHeight: '44px', justifyContent: 'flex-start' as const };

  return (
    <>
      <PhoenixDialog open={open} onClose={handleClose} title={t('mobile_print_title', lang)} maxWidth={640}>
        <p style={{ fontSize: '13px', color: 'var(--t2)', lineHeight: 1.6, marginBottom: '18px' }} dir="auto">
          {t('mobile_print_message', lang)}
        </p>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <PhoenixButton variant="secondary" fullWidth style={rowBtnStyle} onClick={() => setPreviewOpen(v => !v)}>
<PhoenixIcon name="eye" size={15} inline /> {t('mobile_print_preview', lang)}
          </PhoenixButton>

          {previewOpen && (
            <iframe
              title={title}
              srcDoc={html}
              style={{
                width: '100%', height: '50vh', border: '1px solid var(--brd)',
                borderRadius: 'var(--r2)', background: '#fff',
              }}
            />
          )}

          <PhoenixButton variant="secondary" fullWidth style={rowBtnStyle} onClick={handleDownload}>
<PhoenixIcon name="download" size={15} inline /> {t('mobile_print_download_html', lang)}
          </PhoenixButton>

          <PhoenixButton variant="ghost" fullWidth style={rowBtnStyle} onClick={() => setConfirmingSystemPrint(v => !v)}>
<PhoenixIcon name="print" size={15} inline /> {t('mobile_print_use_system', lang)}
          </PhoenixButton>

          {confirmingSystemPrint && (
            <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)', padding: '12px 14px' }}>
              <p style={{ fontSize: '12px', color: 'var(--warn)', marginBottom: '10px' }} dir="auto">
<PhoenixIcon name="warning" size={13} inline /> {t('mobile_print_system_warning', lang)}
              </p>
              <PhoenixButton variant="warn" fullWidth style={{ minHeight: '44px' }} onClick={handleConfirmSystemPrint}>
                {t('mobile_print_system_confirm', lang)}
              </PhoenixButton>
            </div>
          )}

          <PhoenixButton variant="ghost" fullWidth style={{ minHeight: '44px', marginTop: '4px' }} onClick={handleClose}>
            {t('mobile_print_close', lang)}
          </PhoenixButton>
        </div>
      </PhoenixDialog>
      {toast && <PhoenixToast message={toast} />}
    </>
  );
}
