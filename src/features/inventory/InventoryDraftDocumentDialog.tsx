import { useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

/**
 * Human document-number capture for phoenix_create_transfer_draft_from_
 * suggestion (migration 147). Deliberately NOT a generic "accept" dialog —
 * the label and confirm-button text always say "create draft", and the
 * warning that this never moves stock is always shown, not just implied.
 * The RPC itself rejects an empty document number server-side
 * (document_number_required).
 */
interface Props {
  open: boolean;
  busy?: boolean;
  onCancel: () => void;
  onConfirm: (documentNumber: string) => void;
}

export function InventoryDraftDocumentDialog({ open, busy = false, onCancel, onConfirm }: Props) {
  const { lang } = useApp();
  const [value, setValue] = useState('');
  const trimmed = value.trim();

  useEffect(() => {
    if (open) setValue('');
  }, [open]);

  return (
    <PhoenixDialog open={open} onClose={onCancel} title={t('inv_draft_dialog_title', lang)}>
      <div
        role="note"
        style={{
          fontSize: '11.5px', color: 'var(--warn)', background: 'var(--warn2)',
          border: '1px solid var(--warn)', borderRadius: 'var(--r2)', padding: '8px 10px', marginBottom: '12px',
        }}
        dir="auto"
      >
        <PhoenixIcon name="warning" size={12} inline /> {t('inv_draft_dialog_note', lang)}
      </div>
      <label htmlFor="inventory-draft-document-number" style={{ display: 'block', fontSize: '12px', fontWeight: 600, marginBottom: '6px', color: 'var(--t2)' }}>
        {t('inv_draft_document_number_label', lang)}
      </label>
      <input
        id="inventory-draft-document-number"
        type="text"
        value={value}
        onChange={e => setValue(e.target.value)}
        placeholder={t('inv_draft_document_number_placeholder', lang)}
        dir="auto"
        style={{
          width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)',
          border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)',
          fontSize: '13px', outline: 'none',
        }}
      />
      {trimmed === '' && (
        <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '6px' }}>{t('inv_draft_document_number_required', lang)}</div>
      )}
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '18px' }}>
        <PhoenixButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('inv_cancel', lang)}
        </PhoenixButton>
        <PhoenixButton
          variant="primary"
          size="sm"
          loading={busy}
          disabled={trimmed === '' || busy}
          onClick={() => { if (trimmed !== '') onConfirm(trimmed); }}
        >
          {t('inv_draft_create_action', lang)}
        </PhoenixButton>
      </div>
    </PhoenixDialog>
  );
}
