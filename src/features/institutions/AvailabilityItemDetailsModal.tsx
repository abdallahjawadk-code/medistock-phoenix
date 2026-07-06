import type { ReactNode } from 'react';
import { t } from '@/shared/i18n/strings';
import { formatStableDate } from '@/shared/lib/date';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { ExpiryRiskBadge } from '@/shared/ui/ExpiryRiskBadge';
import { getExpiryRiskTier } from '@/shared/lib/expiry-risk';
import type { AvailRow } from './InstitutionScreen';

// Duplicated (not imported) from InstitutionScreen.tsx's module-local maps of
// the same name, deliberately — importing a value binding back from
// InstitutionScreen.tsx (which itself imports this component) would create a
// circular module dependency. `type AvailRow` above is erased at compile time
// so it doesn't have that problem; these two small, stable maps do not.
const CONDITION_LABEL_KEY: Record<string, string> = {
  available: 'cond_available', low_stock: 'cond_low_stock', missing: 'cond_missing',
  surplus: 'cond_surplus', near_expiry: 'cond_near_expiry', expired: 'cond_expired',
};
const CONDITION_VARIANT: Record<string, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

/**
 * PHASE2-AVAILABILITY-ITEM-DETAILS-MODAL-A
 *
 * Read-only inventory/availability details for a single outlet material row.
 * This is NOT a medical/drug-knowledge card — it never shows dosing,
 * mechanism of action, warnings, or any clinical/pharmacological content.
 * Every field below is already fetched by getAvailabilityByPoint for
 * PortAvailabilitySection; this component adds no query, no RPC, and no
 * mutation of any kind — it only formats/labels existing row data.
 */

const DASH = '—';

function textOrDash(v: string | null | undefined): string {
  const trimmed = v?.trim();
  return trimmed ? trimmed : DASH;
}

function priceOrDash(price: number | null | undefined): string {
  if (typeof price !== 'number' || !Number.isFinite(price) || price <= 0) return DASH;
  return price.toFixed(2);
}

/** Whole days from now until expiryDate (negative if already past) — null when unparseable/missing. */
function daysUntilExpiry(expiryDate: string | null | undefined): number | null {
  if (!expiryDate) return null;
  const d = new Date(expiryDate);
  if (isNaN(d.getTime())) return null;
  const dateOnly = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate());
  return Math.round((dateOnly(d).getTime() - dateOnly(new Date()).getTime()) / 86_400_000);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', padding: '6px 0', borderBottom: '1px solid var(--brd)', fontSize: '12.5px' }}>
      <span style={{ color: 'var(--t2)', fontWeight: 600 }}>{label}</span>
      <span style={{ color: 'var(--t1)', textAlign: 'end' }} dir="auto">{children}</span>
    </div>
  );
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** The row itself. Only known, already-fetched availability fields are read — no derived/inferred medical data. */
  row: AvailRow | null;
  lang: 'ar' | 'en';
  /** Display-only outlet/institution names, already known by the caller — no new query. */
  pointName?: string;
  orgName?: string;
}

export function AvailabilityItemDetailsModal({ open, onClose, row, lang, pointName, orgName }: Props) {
  if (!row) return null;

  const condKey = CONDITION_LABEL_KEY[row.condition];
  const variant = CONDITION_VARIANT[row.condition] ?? 'neutral';
  const days = daysUntilExpiry(row.expiry_date);
  const expiryTier = getExpiryRiskTier(row.expiry_date);
  const isRemoved = row.removed_at != null;

  return (
    <PhoenixDialog open={open} onClose={onClose} title={t('avail_details_title', lang)}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: '4px' }}>
        <button
          onClick={onClose}
          aria-label={t('close', lang)}
          style={{ background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '16px', color: 'var(--t2)', padding: '4px 8px' }}
        >
          ✕
        </button>
      </div>

      <div>
        <Row label={t('avail_scientific_name', lang)}>{textOrDash(row.scientific_name)}</Row>
        <Row label={t('avail_trade_name', lang)}>{textOrDash(row.trade_name)}</Row>
        <Row label={t('avail_dosage_form', lang)}>{textOrDash(row.dosage_form)}</Row>
        <Row label={t('avail_concentration', lang)}>{textOrDash(row.concentration)}</Row>
        <Row label={t('qty', lang)}>{row.quantity}</Row>
        <Row label={t('avail_condition', lang)}>
          <PhoenixStatusBadge variant={variant} label={condKey ? t(condKey, lang) : row.condition} />
        </Row>
        <Row label={t('sc_entered_price', lang)}>{priceOrDash(row.price)}</Row>
        <Row label={t('avail_supply_type', lang)}>{textOrDash(row.supply_type)}</Row>
        <Row label={t('batch_no', lang)}>{textOrDash(row.batch_number)}</Row>
        <Row label={t('expiry', lang)}>{formatStableDate(row.expiry_date, lang)}</Row>
        <Row label={t('avail_details_days_to_expiry', lang)}>{days === null ? DASH : days}</Row>
        <Row label={t('avail_details_early_monitoring', lang)}>
          {expiryTier === 'normal' || expiryTier === 'unknown'
            ? DASH
            : <ExpiryRiskBadge expiryDate={row.expiry_date} lang={lang} />}
        </Row>
        <Row label={t('sc_notes', lang)}>{textOrDash(row.notes)}</Row>
        <Row label={t('last_upd', lang)}>{formatStableDate(row.updated_at, lang)}</Row>
        <Row label={t('avail_details_outlet_label', lang)}>{textOrDash(pointName)}</Row>
        <Row label={t('avail_inst_label', lang)}>{textOrDash(orgName)}</Row>
        {isRemoved && (
          <>
            {/* getAvailabilityByPoint (this row's data source) selects removed_at
                but not removal_reason/removed_by — only removed_at is ever safely
                available here, so only that is shown (never a raw uuid). */}
            <Row label={t('sc_removed_badge', lang)}>
              <PhoenixStatusBadge variant="err" label={t('sc_removed_badge', lang)} />
            </Row>
            <Row label={t('sc_removed_at_label', lang)}>{formatStableDate(row.removed_at, lang)}</Row>
          </>
        )}
      </div>

      <div style={{ marginTop: '16px' }}>
        <PhoenixButton variant="ghost" size="md" style={{ width: '100%' }} onClick={onClose}>
          {t('close', lang)}
        </PhoenixButton>
      </div>
    </PhoenixDialog>
  );
}
