/**
 * MOVEMENT-COMPOSER-A — returnable material, chosen from PROVENANCE.
 *
 * A return is not generic material entry. Every candidate here is an actual
 * received transfer line whose resulting stock belongs to the selected
 * institution warehouse, and `originalTransferLineId` travels with it into the
 * RPC — migration 069 makes that column NOT NULL, so a free-text return is
 * impossible at the schema level as well as here.
 *
 * Expired, damaged, recalled and quality-issue material is deliberately
 * SELECTABLE. Those are among the most legitimate reasons to send something
 * back; filtering them out would block exactly the returns that matter most.
 * They are flagged conspicuously instead.
 */
import { useMemo, useState } from 'react';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { RETURN_REASON_CODES } from '@/features/network/network.service';
import { computeProvenanceCaps, returnRiskFlags, type ProvenanceCandidate } from '../provenance';

const dash = (v: string | number | null | undefined) =>
  (v === null || v === undefined || v === '' ? '—' : String(v));

/** A received line plus the display data the operator needs to recognise it. */
export interface ReturnCandidate extends ProvenanceCandidate {
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  internalBatchReference: string | null;
  expiryDate: string | null;
  /** The original supply document this line came from. */
  originalTransferNumber: string | null;
  originalTransferId: string;
  receivedAt: string | null;
  sourceWarehouseName: string | null;
}

interface Props {
  lang: Lang;
  candidates: readonly ReturnCandidate[];
  usedProvenanceIds: readonly string[];
  onAdd: (candidate: ReturnCandidate, quantity: number, reasonCode: string, reasonText: string | null) => void;
  loading?: boolean;
}

export function ProvenanceReturnPicker({ lang, candidates, usedProvenanceIds, onAdd, loading }: Props) {
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
        c.nationalCode, c.batchNumber, c.internalBatchReference, c.expiryDate,
        c.originalTransferNumber, c.sourceWarehouseName,
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
        <div style={{ display: 'grid', gap: '10px' }} data-testid="provenance-picker-results">
          {results.map(candidate => {
            const caps = computeProvenanceCaps(candidate);
            const flags = returnRiskFlags(candidate, candidate.expiryDate);
            const alreadyUsed = used.has(candidate.originalTransferLineId);
            const typed = quantities[candidate.originalTransferLineId] ?? '';
            const quantity = Number(typed);
            const reasonCode = reasons[candidate.originalTransferLineId] ?? RETURN_REASON_CODES[0];
            const reasonText = reasonTexts[candidate.originalTransferLineId] ?? '';
            // 'other' is the one code that explains nothing on its own.
            const needsText = reasonCode === 'other';
            const quantityValid =
              Number.isInteger(quantity) && quantity > 0 && quantity <= caps.safeReturnable;
            const blocked = alreadyUsed || caps.safeReturnable <= 0;

            return (
              <PhoenixCard key={candidate.originalTransferLineId}>
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

                    {/* Where it came from — a return must be traceable to its supply. */}
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_f_original_supply_reference', lang)}: {dash(candidate.originalTransferNumber)} ·{' '}
                      {t('mv_h_source', lang)}: {dash(candidate.sourceWarehouseName)} ·{' '}
                      {t('mv_ev_received', lang)}: {dash(candidate.receivedAt)}
                    </div>

                    <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                      {t('mv_safe_returnable', lang)}: <strong>{caps.safeReturnable}</strong>
                      {' · '}{t('mv_f_received_quantity', lang)}: {dash(candidate.receivedQuantity)}
                      {' · '}{t('mv_returned_against', lang)}: {candidate.returnedQuantity}
                      {caps.physicalAvailable !== null && ` · ${t('mv_available', lang)}: ${caps.physicalAvailable}`}
                    </div>

                    {flags.length > 0 && (
                      <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '4px' }}>
                        {flags.map(f => t(`mv_risk_${f}`, lang)).join(' · ')}
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
                      label={`${t('inv_quantity_received', lang)} / ${caps.safeReturnable}`}
                      value={typed}
                      inputMode="numeric"
                      disabled={blocked}
                      onChange={e => setQuantities(q => ({ ...q, [candidate.originalTransferLineId]: e.target.value }))}
                    />
                    <PhoenixSelect
                      label={t('mv_f_return_reason', lang)}
                      value={reasonCode}
                      disabled={blocked}
                      onChange={e => setReasons(r => ({ ...r, [candidate.originalTransferLineId]: e.target.value }))}
                      options={RETURN_REASON_CODES.map(code => ({ value: code, label: t(`net_op_reason_${code}`, lang) }))}
                    />
                    {needsText && (
                      <PhoenixInput
                        label={t('mv_reason_text', lang)}
                        value={reasonText}
                        disabled={blocked}
                        onChange={e => setReasonTexts(x => ({ ...x, [candidate.originalTransferLineId]: e.target.value }))}
                      />
                    )}
                    <PhoenixButton
                      disabled={blocked || !quantityValid || (needsText && !reasonText.trim())}
                      onClick={() => {
                        onAdd(candidate, quantity, reasonCode, reasonText.trim() || null);
                        setQuantities(q => ({ ...q, [candidate.originalTransferLineId]: '' }));
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
