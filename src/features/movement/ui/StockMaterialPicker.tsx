/**
 * MOVEMENT-COMPOSER-A — authoritative stock selection for SUPPLY.
 *
 * Material identity is a stable id (warehouseStockId, and centralItemId where
 * the catalog has one), never a retyped scientific name. The previous flow let
 * an operator type "Amoxicilin" and created a line for a material that matched
 * nothing in stock; that is impossible here because there is no free-text
 * identity field at all.
 *
 * Every displayed field comes from the stock row. A missing field renders an
 * em dash and is never invented.
 */
import { useMemo, useState } from 'react';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/lib/types';
import { searchStock, recommendFefo, isExpired, type StockCandidate } from '../composer-model';

const dash = (v: string | null | undefined) => (v === null || v === undefined || v === '' ? '—' : v);

interface Props {
  lang: Lang;
  candidates: readonly StockCandidate[];
  /** Stock ids already on the draft, so a duplicate cannot be added twice. */
  usedStockIds: readonly string[];
  onAdd: (stock: StockCandidate, quantity: number) => void;
  loading?: boolean;
}

export function StockMaterialPicker({ lang, candidates, usedStockIds, onAdd, loading }: Props) {
  const [query, setQuery] = useState('');
  const [quantities, setQuantities] = useState<Record<string, string>>({});

  const used = useMemo(() => new Set(usedStockIds), [usedStockIds]);
  const results = useMemo(() => searchStock(candidates, query), [candidates, query]);
  const fefo = useMemo(() => recommendFefo(candidates), [candidates]);

  if (loading) return <p style={{ fontSize: '12.5px', color: 'var(--t2)' }}>…</p>;

  return (
    <div style={{ display: 'grid', gap: '12px' }}>
      <PhoenixInput
        label={t('mv_search_materials', lang)}
        value={query}
        onChange={e => setQuery(e.target.value)}
        placeholder={t('mv_search_materials', lang)}
      />

      {results.length === 0 ? (
        <PhoenixEmptyState icon="package" title={t('empty_hint', lang)} />
      ) : (
        <div style={{ display: 'grid', gap: '10px' }} data-testid="stock-picker-results">
          {results.map(stock => {
            const expired = isExpired(stock.expiryDate);
            const alreadyUsed = used.has(stock.warehouseStockId);
            // Expired or fully-committed stock is shown but not dispatchable —
            // hiding it would leave the operator wondering where it went.
            const blocked = expired || stock.availableQuantity <= 0 || alreadyUsed;
            const typed = quantities[stock.warehouseStockId] ?? '';
            const quantity = Number(typed);
            const quantityValid = Number.isInteger(quantity) && quantity > 0 && quantity <= stock.availableQuantity;

            return (
              <PhoenixCard key={stock.warehouseStockId}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 700 }}>
                      {stock.scientificName}
                      {fefo?.warehouseStockId === stock.warehouseStockId && (
                        <span style={{
                          marginInlineStart: '8px', fontSize: '10px', fontWeight: 700,
                          padding: '2px 8px', borderRadius: 'var(--rpill)',
                          background: 'var(--p2)', color: 'var(--pd)',
                        }}>
                          {t('mv_fefo_hint', lang)}
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '3px' }}>
                      {dash(stock.tradeName)} · {dash(stock.concentration)} · {dash(stock.dosageForm)} · {dash(stock.unit)}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_f_national_code', lang)}: {dash(stock.nationalCode)} ·{' '}
                      {t('mv_f_batch_number', lang)}: {dash(stock.batchNumber)} ·{' '}
                      {t('mv_f_expiry_date', lang)}: {dash(stock.expiryDate)}
                    </div>
                    <div style={{ fontSize: '11.5px', color: 'var(--t2)' }}>
                      {t('mv_available', lang)}: <strong>{stock.availableQuantity}</strong>
                      {' '}({stock.onHandQuantity} − {stock.reservedQuantity})
                    </div>
                    {expired && (
                      <div style={{ fontSize: '11.5px', color: 'var(--err)', fontWeight: 700, marginTop: '3px' }}>
                        {t('mv_e_expired_not_dispatchable', lang)}
                      </div>
                    )}
                    {alreadyUsed && (
                      <div style={{ fontSize: '11.5px', color: 'var(--warn)', fontWeight: 700, marginTop: '3px' }}>
                        {t('mv_e_duplicate_material_batch', lang)}
                      </div>
                    )}
                  </div>

                  <div style={{ display: 'flex', gap: '8px', alignItems: 'flex-end' }}>
                    <PhoenixInput
                      label={t('inv_quantity_received', lang)}
                      value={typed}
                      inputMode="numeric"
                      disabled={blocked}
                      onChange={e => setQuantities(q => ({ ...q, [stock.warehouseStockId]: e.target.value }))}
                      style={{ maxWidth: '110px' }}
                    />
                    <PhoenixButton
                      disabled={blocked || !quantityValid}
                      onClick={() => {
                        onAdd(stock, quantity);
                        setQuantities(q => ({ ...q, [stock.warehouseStockId]: '' }));
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
