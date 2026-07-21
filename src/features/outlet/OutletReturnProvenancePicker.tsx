/**
 * OUTLET-RETURN — returnable material, chosen from DISPATCH-LINE PROVENANCE.
 *
 * Every candidate is an actual received dispatch line (070) still held by this
 * outlet, and `originalDispatchLineId` travels with it into 071's ADD-LINE RPC —
 * that column is mandatory, so a free-text return is impossible at the schema
 * level as well as here. This component performs NO writes: it only proposes a
 * line for the composer's in-memory draft.
 *
 * Expired, damaged, recalled and quality-issue material is deliberately
 * SELECTABLE — those are among the most legitimate reasons to send something
 * back. Expiry is flagged conspicuously rather than filtered out.
 */
import { useMemo, useState } from 'react';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import {
  RETURN_REASON_CODES, safeReturnable, type ExistingReturnLine,
} from './outlet-return-model';
import type { OutletReturnableLine } from './outlet-return-draft';

const dash = (v: string | number | null | undefined) =>
  (v === null || v === undefined || v === '' ? '—' : String(v));

function isExpired(expiryDate: string | null, today = new Date()): boolean {
  if (!expiryDate) return false;
  const expiry = new Date(`${expiryDate}T00:00:00Z`);
  if (Number.isNaN(expiry.getTime())) return false;
  const midnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return expiry < midnight;
}

interface Props {
  lang: Lang;
  candidates: readonly OutletReturnableLine[];
  /** Live return-request lines, so caps subtract unshipped reservations. */
  existingLines: readonly ExistingReturnLine[];
  /** Dispatch-line ids already in the draft — offered once. */
  usedProvenanceIds: readonly string[];
  onAdd: (candidate: OutletReturnableLine, quantity: number, reasonCode: string, reasonText: string | null) => void;
  loading?: boolean;
}

export function OutletReturnProvenancePicker({
  lang, candidates, existingLines, usedProvenanceIds, onAdd, loading,
}: Props) {
  const [query, setQuery] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [reasonTexts, setReasonTexts] = useState<Record<string, string>>({});

  const used = useMemo(() => new Set(usedProvenanceIds), [usedProvenanceIds]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [...candidates];
    const terms = q.split(/\s+/);
    return candidates.filter(c => {
      const haystack = [
        c.scientificName, c.tradeName, c.concentration, c.dosageForm, c.unit,
        c.nationalCode, c.batchNumber, c.internalBatchReference, c.expiryDate, c.dispatchNumber,
      ].filter(Boolean).join(' ').toLowerCase();
      return terms.every(term => haystack.includes(term));
    });
  }, [candidates, query]);

  if (loading) return <p style={{ fontSize: '12.5px', color: 'var(--t2)' }}>…</p>;
  if (candidates.length === 0) {
    return <PhoenixEmptyState icon="package" title={t('mv_return_no_provenance', lang)} />;
  }

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <PhoenixInput
        label={t('mv_return_search_received', lang)}
        value={query}
        onChange={e => setQuery(e.target.value)}
      />

      {results.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('empty_hint', lang)} />
      ) : (
        <div style={{ display: 'grid', gap: '10px' }} data-testid="outlet-return-picker-results">
          {results.map(candidate => {
            const cap = safeReturnable(candidate, existingLines);
            const expired = isExpired(candidate.expiryDate);
            const alreadyUsed = used.has(candidate.dispatchLineId);
            const typed = quantities[candidate.dispatchLineId] ?? '';
            const quantity = Number(typed);
            const reasonCode = reasons[candidate.dispatchLineId] ?? RETURN_REASON_CODES[0];
            const reasonText = reasonTexts[candidate.dispatchLineId] ?? '';
            const needsText = reasonCode === 'other';
            const quantityValid = Number.isInteger(quantity) && quantity > 0 && quantity <= cap;
            const blocked = alreadyUsed || cap <= 0;

            return (
              <PhoenixCard key={candidate.dispatchLineId}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div style={{ fontSize: '13px', fontWeight: 700 }}>{candidate.scientificName}</div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                      {dash(candidate.tradeName)} · {dash(candidate.concentration)} ·{' '}
                      {dash(candidate.dosageForm)} · {dash(candidate.unit)}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_f_national_code', lang)}: {dash(candidate.nationalCode)} ·{' '}
                      {t('mv_f_batch_number', lang)}: {dash(candidate.batchNumber)} ·{' '}
                      {t('mv_f_expiry_date', lang)}: {dash(candidate.expiryDate)}
                    </div>

                    {/* Provenance: the dispatch this material arrived on. */}
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_f_original_supply_reference', lang)}: {dash(candidate.dispatchNumber)} ·{' '}
                      {t('mv_ev_received', lang)}: {dash(candidate.dispatchSentAt)}
                    </div>

                    <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                      {t('mv_safe_returnable', lang)}: <strong>{cap}</strong>
                      {' · '}{t('mv_f_received_quantity', lang)}: {dash(candidate.receivedQuantity)}
                      {' · '}{t('mv_returned_against', lang)}: {candidate.returnedQuantity}
                    </div>

                    {expired && (
                      <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '4px' }}>
                        {t('net_op_reason_expired', lang)}
                      </div>
                    )}
                    {alreadyUsed && (
                      <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '3px' }}>
                        {t('mv_e_duplicate_material_batch', lang)}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'grid', gap: '6px', minWidth: '230px' }}>
                    <PhoenixInput
                      label={`${t('inv_quantity_received', lang)} / ${cap}`}
                      value={typed}
                      inputMode="numeric"
                      disabled={blocked}
                      onChange={e => setQuantities(q => ({ ...q, [candidate.dispatchLineId]: e.target.value }))}
                    />
                    <PhoenixSelect
                      label={t('mv_f_return_reason', lang)}
                      value={reasonCode}
                      disabled={blocked}
                      onChange={e => setReasons(r => ({ ...r, [candidate.dispatchLineId]: e.target.value }))}
                      options={RETURN_REASON_CODES.map(code => ({ value: code, label: t(`net_op_reason_${code}`, lang) }))}
                    />
                    {needsText && (
                      <PhoenixInput
                        label={t('mv_reason_text', lang)}
                        value={reasonText}
                        disabled={blocked}
                        onChange={e => setReasonTexts(x => ({ ...x, [candidate.dispatchLineId]: e.target.value }))}
                      />
                    )}
                    <PhoenixButton
                      disabled={blocked || !quantityValid || (needsText && !reasonText.trim())}
                      onClick={() => {
                        onAdd(candidate, quantity, reasonCode, reasonText.trim() || null);
                        setQuantities(q => ({ ...q, [candidate.dispatchLineId]: '' }));
                      }}
                    >
                      {t('mv_add_line', lang)}
                    </PhoenixButton>
                  </div>
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}
    </div>
  );
}
