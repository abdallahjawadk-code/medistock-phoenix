import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { useOutletCountPermission } from '@/features/inventory/useOutletCountPermission';
import { getOutletStock, type OutletStockRow } from '@/features/outlet/outlet-stock.service';
import { OutletStockCorrectionModal } from '@/features/outlet/OutletStockCorrectionModal';

/**
 * CANONICAL-STOCK-CUTOVER — the Status Center "correct stock" launcher.
 *
 * item_availability is a read-only projection (migration 083). A Status Center
 * row is an AGGREGATE (a material at an outlet) and must NEVER be edited
 * directly. To correct a physical count the operator must pick an explicit
 * canonical outlet_stock LOT (batch) and go through the guarded RPC
 * phoenix_count_outlet_stock_guarded (migration 086) — expected-generation,
 * non-negative, reservation-safe, reason-mandatory, append-only movement + audit,
 * scoped to outlet_stock.count on THAT outlet. This modal is the bridge: it loads
 * the canonical lots for the row's material at the row's outlet, requires the
 * operator to select one, then hands off to OutletStockCorrectionModal. It writes
 * nothing itself; the guarded RPC is the only write, adjudicated server-side.
 */

/** The minimal aggregate-row shape this launcher needs — a read-only
 *  item_availability projection row (material identity + its outlet). */
export interface AvailabilityCorrectionRow {
  scientific_name: string | null;
  trade_name: string | null;
  concentration: string | null;
  dosage_form: string | null;
  national_code?: string | null;
  distribution_points: { id: string; name: string; name_ar: string } | null;
}

interface Props {
  open: boolean;
  row: AvailabilityCorrectionRow | null;
  orgId: string | null;
  lang: 'ar' | 'en';
  onClose: () => void;
  onCorrected: () => void;
}

const norm = (s: string | null | undefined) => (s ?? '').trim().toLowerCase();

/** Canonical lots for this row's material at this row's outlet. A material row
 *  may aggregate several batches, so the operator selects the exact lot. */
function matchesRow(lot: OutletStockRow, row: AvailabilityCorrectionRow): boolean {
  if (row.national_code && lot.nationalCode && norm(lot.nationalCode) === norm(row.national_code)) return true;
  return norm(lot.scientificName) === norm(row.scientific_name);
}

export function AvailabilityStockCorrectionModal({ open, row, orgId, lang, onClose, onCorrected }: Props) {
  const outletId = row?.distribution_points?.id ?? null;
  const countPerm = useOutletCountPermission(orgId, outletId);
  const canCorrect = countPerm.data === true;
  const [selectedLot, setSelectedLot] = useState<OutletStockRow | null>(null);

  // Canonical lots at this outlet, loaded only while the picker is open.
  const stock = useAsync(
    () => (open && outletId ? getOutletStock(outletId) : Promise.resolve([] as OutletStockRow[])),
    [open, outletId],
  );

  const lots = (stock.data ?? []).filter(l => row && matchesRow(l, row));

  function closePicker() {
    setSelectedLot(null);
    onClose();
  }

  const outletName = row?.distribution_points
    ? (lang === 'ar' ? (row.distribution_points.name_ar || row.distribution_points.name) : row.distribution_points.name)
    : '—';

  return (
    <>
      <PhoenixDialog open={open && selectedLot === null} onClose={closePicker} title={t('sc_correct_stock_title', lang)} maxWidth={520}>
        {!row ? null : !outletId ? (
          <p style={{ fontSize: '12.5px', color: 'var(--err)', textAlign: 'center' }}>{t('sc_correct_stock_no_outlet', lang)}</p>
        ) : !canCorrect ? (
          <p style={{ fontSize: '12.5px', color: 'var(--err)', textAlign: 'center' }}>{t('oc_no_permission', lang)}</p>
        ) : (
          <>
            <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '12px 14px', marginBottom: '12px', fontSize: '12.5px' }}>
              <div style={{ fontWeight: 700, marginBottom: '4px' }} dir="auto">
                {row.scientific_name || '—'}{row.trade_name ? ` (${row.trade_name})` : ''}
              </div>
              <div style={{ color: 'var(--t2)', display: 'flex', flexWrap: 'wrap', gap: '10px' }}>
                {row.concentration && <span dir="auto">{row.concentration}</span>}
                {row.dosage_form && <span dir="auto">{row.dosage_form}</span>}
                <span dir="auto"><PhoenixIcon name="hospital" size={13} inline /> {outletName}</span>
              </div>
            </div>

            <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '12px' }} dir="auto">{t('sc_correct_stock_pick_lot', lang)}</p>

            {stock.loading && !stock.data ? (
              <PhoenixLoadingState />
            ) : lots.length === 0 ? (
              <PhoenixEmptyState icon="package" title={t('sc_correct_stock_no_lots', lang)} />
            ) : (
              <div style={{ display: 'grid', gap: '8px' }} data-testid="availability-correction-lot-list">
                {lots.map(lot => (
                  <div key={lot.id} style={{ display: 'flex', justifyContent: 'space-between', gap: '10px', alignItems: 'center', padding: '10px 12px', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', background: 'var(--s)' }}>
                    <div style={{ minWidth: 0, fontSize: '12px' }}>
                      <div style={{ color: 'var(--t2)' }}>
                        <span dir="ltr">{t('mv_f_batch_number', lang)}: {lot.batchNumber || '—'}</span>
                        {lot.expiryDate ? <span dir="ltr"> · {t('mv_f_expiry_date', lang)}: {lot.expiryDate}</span> : null}
                      </div>
                      <div style={{ fontWeight: 700, marginTop: '2px' }}>
                        {t('mvmt_current_qty', lang)}: {lot.onHandQuantity}
                        {lot.reservedQuantity > 0 && <span style={{ fontWeight: 400, color: 'var(--t3)' }}> · {t('mv_returned_against', lang)}: {lot.reservedQuantity}</span>}
                      </div>
                    </div>
                    <PhoenixButton variant="ghost" size="sm" onClick={() => setSelectedLot(lot)}>
                      {t('oc_correct_action', lang)}
                    </PhoenixButton>
                  </div>
                ))}
              </div>
            )}
          </>
        )}
      </PhoenixDialog>

      <OutletStockCorrectionModal
        open={selectedLot !== null}
        lot={selectedLot}
        lang={lang}
        canCorrect={canCorrect}
        onClose={() => setSelectedLot(null)}
        onSuccess={() => { setSelectedLot(null); onCorrected(); onClose(); }}
        // requiresApproval is not surfaced here — the Status Center's onCorrected
        // just triggers a reload; OutletOperationsScreen is the surface that
        // shows the applied-vs-pending distinction to the operator.
      />
    </>
  );
}
