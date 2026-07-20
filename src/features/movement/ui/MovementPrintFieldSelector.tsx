/**
 * MOVEMENT-COMPOSER-A — the print field selector.
 *
 * Follows the established PHASE2-EXPORT-FIELD-SELECTOR-A pattern from
 * OutletAvailabilityReportModal (definitions + presets + localStorage recall),
 * with one addition that pattern lacks: LOCKED fields.
 *
 * The mandatory traceability header (document type, canonical key, QR, event
 * time, source, destination, status) is not offered here at all, and the locked
 * row fields render as disabled ticks with an explanation. A document that can
 * be stripped of its trace identity is not a document.
 */
import { useEffect, useMemo, useState } from 'react';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import {
  availableFields, fieldsForPreset, normalizeSelection, clearOptionalFields,
  orientationFor, MANDATORY_HEADER_FIELDS,
  type ReceiptFieldKey, type ReceiptPreset,
} from '../receipt-model';

const STORAGE_KEY = 'phoenix_movement_receipt_fields';

function loadStored(): ReceiptFieldKey[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as ReceiptFieldKey[]) : null;
  } catch {
    return null;
  }
}

function store(keys: readonly ReceiptFieldKey[]) {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(keys));
  } catch { /* a blocked storage must never prevent printing */ }
}

interface Props {
  open: boolean;
  lang: Lang;
  isReturn: boolean;
  canSeePrices: boolean;
  onClose: () => void;
  onPrint: (selected: ReceiptFieldKey[]) => void;
  /** Rendered live as the operator ticks fields. */
  renderPreview: (selected: ReceiptFieldKey[]) => React.ReactNode;
}

export function MovementPrintFieldSelector({
  open, lang, isReturn, canSeePrices, onClose, onPrint, renderPreview,
}: Props) {
  const options = useMemo(() => ({ isReturn, canSeePrices }), [isReturn, canSeePrices]);
  const defaults = useMemo(() => fieldsForPreset('full', options), [options]);

  const [preset, setPreset] = useState<ReceiptPreset>('full');
  const [selected, setSelected] = useState<ReceiptFieldKey[]>(defaults);

  // Recall the operator's last choice, but always re-normalize: a stored
  // selection from a supply document must not smuggle return-only or price
  // fields into a document that may not show them.
  useEffect(() => {
    if (!open) return;
    const stored = loadStored();
    setSelected(normalizeSelection(stored ?? defaults, options));
    setPreset(stored ? 'custom' : 'full');
  }, [open, defaults, options]);

  const apply = (keys: ReceiptFieldKey[], nextPreset: ReceiptPreset) => {
    const normalized = normalizeSelection(keys, options);
    setSelected(normalized);
    setPreset(nextPreset);
    store(normalized);
  };

  const fields = availableFields(options);
  const orientation = orientationFor(selected);

  return (
    <PhoenixDialog open={open} onClose={onClose} title={t('mv_print_fields_title', lang)} maxWidth={880}>
      <div style={{ display: 'grid', gap: '14px' }}>
        {/* Presets */}
        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {([
            { id: 'full' as const, key: 'mv_preset_full' },
            { id: 'compact' as const, key: 'mv_preset_compact' },
          ]).map(p => (
            <PhoenixButton
              key={p.id}
              variant={preset === p.id ? 'primary' : 'secondary'}
              onClick={() => apply(fieldsForPreset(p.id, options), p.id)}
            >
              {t(p.key, lang)}
            </PhoenixButton>
          ))}
          <PhoenixButton variant="secondary" onClick={() => apply(fields.map(f => f.key), 'custom')}>
            {t('mv_select_all', lang)}
          </PhoenixButton>
          <PhoenixButton variant="secondary" onClick={() => apply(clearOptionalFields(options), 'custom')}>
            {t('mv_clear_optional', lang)}
          </PhoenixButton>
          <PhoenixButton variant="ghost" onClick={() => apply(defaults, 'full')}>
            {t('mv_restore_defaults', lang)}
          </PhoenixButton>
        </div>

        {/* Mandatory header fields — shown as locked, never as choices. */}
        <div style={{
          background: 'var(--p2)', border: '1px solid var(--p)', borderRadius: 'var(--r3)',
          padding: '10px 14px', fontSize: '11.5px', color: 'var(--pd)',
        }}>
          <strong>{t('mv_locked_field_hint', lang)}</strong>
          <div style={{ marginTop: '4px' }}>
            {MANDATORY_HEADER_FIELDS.map(f => t(`mv_h_${f === 'documentType' ? 'document_type' : f === 'traceKey' ? 'trace_key' : f === 'eventAt' ? 'event_at' : f}`, lang))
              .filter(Boolean).join(' · ')}
          </div>
        </div>

        {/* Selectable line fields */}
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '4px' }}>
          {fields.map(field => {
            const checked = selected.includes(field.key);
            return (
              <label
                key={field.key}
                title={field.locked ? t('mv_locked_field_hint', lang) : undefined}
                style={{
                  display: 'flex', alignItems: 'center', gap: '8px', minHeight: '44px',
                  fontSize: '12px', opacity: field.locked ? 0.75 : 1,
                  cursor: field.locked ? 'not-allowed' : 'pointer',
                }}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={field.locked}
                  onChange={e => {
                    const next = new Set(selected);
                    if (e.target.checked) next.add(field.key);
                    else next.delete(field.key);
                    apply([...next], 'custom');
                  }}
                />
                {t(field.labelKey, lang)}
                {field.locked && ' 🔒'}
              </label>
            );
          })}
        </div>

        {/* Live preview */}
        <div>
          <div style={{ fontSize: '12px', fontWeight: 700, marginBottom: '6px' }}>
            {t('mv_live_preview', lang)} · A4 {orientation} · {selected.length}
          </div>
          <div style={{
            border: '1px solid var(--brd)', borderRadius: 'var(--r3)',
            maxHeight: '320px', overflow: 'auto', background: '#fff',
          }}>
            {renderPreview(selected)}
          </div>
        </div>

        <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          <PhoenixButton onClick={() => onPrint(selected)}>{t('mv_print', lang)}</PhoenixButton>
          <PhoenixButton variant="ghost" onClick={onClose}>{t('mv_cancel', lang)}</PhoenixButton>
        </div>
      </div>
    </PhoenixDialog>
  );
}
