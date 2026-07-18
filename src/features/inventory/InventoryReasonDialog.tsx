import { useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';

/**
 * Reusable required-reason capture for the alert resolve/dismiss and the
 * suggestion reject flows. The 072 RPCs all reject an empty reason server-side
 * (resolve_reason_required / dismiss_reason_required / reject_reason_required),
 * so the confirm button stays disabled until a non-blank reason is entered.
 */
interface Props {
  open: boolean;
  title: string;
  /** danger for reject/dismiss, primary for resolve. */
  variant?: 'primary' | 'danger' | 'warn';
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (reason: string) => void;
}

export function InventoryReasonDialog({ open, title, variant = 'primary', busy = false, onCancel, onConfirm }: Props) {
  const { lang } = useApp();
  const [reason, setReason] = useState('');
  const trimmed = reason.trim();

  // A reason is audit evidence for one specific lifecycle action. Never carry
  // text from a previous resolve/dismiss/reject into a newly opened action.
  useEffect(() => {
    if (open) setReason('');
  }, [open, title]);

  return (
    <PhoenixDialog open={open} onClose={onCancel} title={title}>
      <label style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--t2)' }}>
        {t('inv_reason_label', lang)}
      </label>
      <textarea
        value={reason}
        onChange={e => setReason(e.target.value)}
        placeholder={t('inv_reason_placeholder', lang)}
        rows={3}
        dir="auto"
        style={{
          width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)',
          border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)',
          fontSize: '13px', outline: 'none', resize: 'vertical',
        }}
      />
      {trimmed === '' && (
        <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '6px' }}>{t('inv_reason_required', lang)}</div>
      )}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '18px' }}>
        <PhoenixButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('inv_cancel', lang)}
        </PhoenixButton>
        <PhoenixButton
          variant={variant}
          size="sm"
          loading={busy}
          disabled={trimmed === '' || busy}
          onClick={() => { if (trimmed !== '') onConfirm(trimmed); }}
        >
          {t('inv_confirm', lang)}
        </PhoenixButton>
      </div>
    </PhoenixDialog>
  );
}
