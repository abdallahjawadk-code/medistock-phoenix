import { useCallback, useEffect, useMemo, useState } from 'react';
import { t, tRpcError } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import {
  getRecallableOutletInboundMovements,
  recallOutletStock,
  type RecallableOutletInboundMovement,
} from './outlet-return.service';

interface Props {
  distributionPointId: string;
  lang: 'ar' | 'en';
  onRecalled: () => void;
}

/** Warehouse-initiated recall anchored to one genuine outlet receipt movement. */
export function OutletRecallPanel({ distributionPointId, lang, onRecalled }: Props) {
  const [movements, setMovements] = useState<RecallableOutletInboundMovement[]>([]);
  const [selectedMovementId, setSelectedMovementId] = useState('');
  const [returnNumber, setReturnNumber] = useState('');
  const [notes, setNotes] = useState('');
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    setMovements([]);
    setSelectedMovementId('');
    try {
      const rows = await getRecallableOutletInboundMovements(distributionPointId);
      setMovements(rows);
    } catch {
      setMovements([]);
      setSelectedMovementId('');
      setError(t('load_error', lang));
    } finally {
      setLoading(false);
    }
  }, [distributionPointId, lang]);

  useEffect(() => { void load(); }, [load]);

  const options = useMemo(() => [
    { value: '', label: t('outlet_recall_select_placeholder', lang) },
    ...movements.map(movement => ({
      value: movement.id,
      label: `${movement.scientificName} · ${movement.batchNumber ?? '—'} · ${movement.dispatchNumber ?? '—'} · ${new Date(movement.occurredAt).toLocaleString(lang === 'ar' ? 'ar-IQ' : 'en-IQ')}`,
    })),
  ], [movements, lang]);

  const submit = async () => {
    if (loading || !selectedMovementId || !returnNumber.trim() || submitting) return;
    // selectedMovementId can only be one of the freshly loaded, RLS-scoped rows.
    if (!movements.some(movement => movement.id === selectedMovementId)) return;
    setSubmitting(true);
    setError(null);
    setSuccess(false);
    const result = await recallOutletStock({
      originalInboundMovementId: selectedMovementId,
      returnNumber: returnNumber.trim(),
      notes: notes.trim() || null,
    });
    setSubmitting(false);
    if (!result.ok) {
      setError(tRpcError(result.error, lang));
      return;
    }
    setSuccess(true);
    setSelectedMovementId('');
    setReturnNumber('');
    setNotes('');
    await load();
    onRecalled();
  };

  return (
    <PhoenixCard className="nexus-io-form-card" data-testid="outlet-recall-panel">
      <div style={{ display: 'grid', gap: '12px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700 }}>{t('outlet_recall_title', lang)}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('outlet_recall_hint', lang)}</div>
        </div>
        {loading ? <PhoenixLoadingState /> : (
          <PhoenixSelect
            data-testid="outlet-recall-movement-selector"
            label={t('outlet_recall_source', lang)}
            value={selectedMovementId}
            onChange={event => { setSelectedMovementId(event.target.value); setSuccess(false); }}
            options={options}
            disabled={movements.length === 0 || submitting}
          />
        )}
        {!loading && movements.length === 0 && !error && (
          <div style={{ fontSize: '12px', color: 'var(--t2)' }}>{t('outlet_recall_empty', lang)}</div>
        )}
        <PhoenixInput
          label={t('outlet_recall_number', lang)}
          value={returnNumber}
          onChange={event => { setReturnNumber(event.target.value); setSuccess(false); }}
          disabled={submitting}
        />
        <PhoenixInput
          label={t('inv_notes', lang)}
          value={notes}
          onChange={event => setNotes(event.target.value)}
          disabled={submitting}
        />
        {error && <div role="alert" style={{ color: 'var(--err)', fontSize: '12px' }}>{error}</div>}
        {success && <div role="status" style={{ color: 'var(--ok)', fontSize: '12px' }}>{t('outlet_recall_created', lang)}</div>}
        <div>
          <PhoenixButton
            data-testid="submit-outlet-recall"
            disabled={loading || !selectedMovementId || !returnNumber.trim() || submitting}
            onClick={() => { void submit(); }}
          >
            {t('outlet_recall_submit', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}
