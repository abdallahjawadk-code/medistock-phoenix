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
 *
 * Confirming also requires an explicit regulatory acknowledgement. That tick
 * is a LOCAL gate on this button only — see the comment on `regulatoryAck`.
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
  // DRAFT-REGULATORY-ACK: a LOCAL, mandatory acknowledgement — it gates this
  // dialog's own confirm button and nothing else. It is deliberately NOT sent
  // to phoenix_record_regulatory_ack: the formal, audited acknowledgement is
  // recorded once, later, when the resulting transfer request is submitted or
  // reviewed. Creating a draft must not manufacture a second audit event.
  const [regulatoryAck, setRegulatoryAck] = useState(false);
  const trimmed = value.trim();
  // BOTH conditions, always. A document number alone is not enough, and a
  // ticked box alone is not enough.
  const canConfirm = trimmed !== '' && regulatoryAck;

  // Every open starts from zero, so a previous open's acknowledgement can
  // never carry into the next suggestion.
  useEffect(() => {
    if (open) { setValue(''); setRegulatoryAck(false); }
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
        aria-describedby={trimmed === '' ? 'inventory-draft-document-number-hint' : undefined}
        aria-required="true"
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
        <div id="inventory-draft-document-number-hint" style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '6px' }}>{t('inv_draft_document_number_required', lang)}</div>
      )}
      <div style={{ marginTop: '14px', padding: '10px 12px', borderRadius: 'var(--r2)', background: 'var(--warn2)', border: '1px solid var(--warn)' }}>
        <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', cursor: 'pointer' }}>
          <input
            type="checkbox"
            data-testid="inv-draft-reg-ack"
            aria-describedby={regulatoryAck ? undefined : 'inventory-draft-regulatory-ack-hint'}
            checked={regulatoryAck}
            onChange={e => setRegulatoryAck(e.target.checked)}
          />
          <span dir="auto">{t('ts_ack_checkbox', lang)}</span>
        </label>
        {!regulatoryAck && (
          <p id="inventory-draft-regulatory-ack-hint" style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '5px' }} dir="auto">
            {t('ts_ack_required', lang)}
          </p>
        )}
      </div>
      <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end', marginTop: '18px' }}>
        <PhoenixButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
          {t('inv_cancel', lang)}
        </PhoenixButton>
        <PhoenixButton
          variant="primary"
          size="sm"
          loading={busy}
          disabled={!canConfirm || busy}
          onClick={() => { if (canConfirm) onConfirm(trimmed); }}
        >
          {t('inv_draft_create_action', lang)}
        </PhoenixButton>
      </div>
    </PhoenixDialog>
  );
}
