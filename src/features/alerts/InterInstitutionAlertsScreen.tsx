import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import {
  getLiveInterInstitutionAlerts,
  type LiveInterInstitutionAlert,
  type LiveAlertType,
  type LiveAlertSeverity,
} from './live-inter-institution-alerts.service';

/**
 * LIVE-INTER-INSTITUTION-ALERTS-UI-A
 *
 * Rebuilt to read exclusively from getLiveInterInstitutionAlerts()
 * (migration 036's phoenix_get_live_inter_institution_alerts RPC) — a live,
 * item_availability-based computation. This screen has no dependency on the
 * manual report layer's data path anywhere in its imports or types.
 * Permission enforcement (the inter-institution-alerts view permission or
 * its legacy backward-compatible equivalent, super_admin bypass, org-scoped
 * visibility) happens entirely server-side inside the RPC; this screen only
 * renders whatever it is given and surfaces a FORBIDDEN response as a
 * permission-denied state.
 */

const ALERT_TYPE_LABEL_KEY: Record<LiveAlertType, string> = {
  surplus_to_shortage: 'lia_type_surplus',
  near_expiry_to_shortage: 'lia_type_near_expiry',
};

const SEVERITY_BORDER: Record<LiveAlertSeverity, string> = {
  high: 'var(--err)',
  medium: 'var(--warn)',
};

function statusLabelKey(status: string): string {
  switch (status) {
    case 'surplus': return 'cond_surplus';
    case 'near_expiry': return 'cond_near_expiry';
    case 'missing': return 'cond_missing';
    case 'low_stock': return 'cond_low_stock';
    default: return '';
  }
}

function statusVariant(status: string): 'ok' | 'warn' | 'err' | 'neutral' {
  switch (status) {
    case 'surplus': return 'ok';
    case 'near_expiry': return 'warn';
    case 'missing': return 'err';
    case 'low_stock': return 'warn';
    default: return 'neutral';
  }
}

function orgName(name: string | null, nameAr: string | null, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return nameAr || name || '—';
  return name || nameAr || '—';
}

function pointName(name: string | null, nameAr: string | null, lang: 'ar' | 'en'): string | null {
  const v = lang === 'ar' ? (nameAr || name) : (name || nameAr);
  return v || null;
}

function alertKey(a: LiveInterInstitutionAlert): string {
  return [
    a.sourceDistributionPointId, a.targetDistributionPointId,
    a.scientificName, a.concentration, a.dosageForm, a.alertType,
  ].join(':');
}

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

// ─── Main screen ─────────────────────────────────────────────────────────────

export function InterInstitutionAlertsScreen() {
  const { lang } = useApp();
  const isMobile = window.innerWidth < 768;

  const [severityFilter, setSeverityFilter] = useState<LiveAlertSeverity | ''>('');
  const [typeFilter, setTypeFilter] = useState<LiveAlertType | ''>('');
  const [instFilter, setInstFilter] = useState('');
  const [search, setSearch] = useState('');

  const result = useAsync(() => getLiveInterInstitutionAlerts(200), []);

  const ok = result.data?.ok ?? false;
  const rpcError = result.data?.error;
  const forbidden = rpcError === 'FORBIDDEN';
  const allAlerts = result.data?.alerts ?? [];

  const summaryTotal = allAlerts.length;
  const summaryHigh = allAlerts.filter(a => a.severity === 'high').length;
  const summarySurplus = allAlerts.filter(a => a.alertType === 'surplus_to_shortage').length;
  const summaryNearExpiry = allAlerts.filter(a => a.alertType === 'near_expiry_to_shortage').length;

  const instMap = useMemo(() => {
    const map = new Map<string, string>();
    for (const a of allAlerts) {
      if (!map.has(a.sourceOrganizationId)) map.set(a.sourceOrganizationId, orgName(a.sourceOrganizationName, a.sourceOrganizationNameAr, lang));
      if (!map.has(a.targetOrganizationId)) map.set(a.targetOrganizationId, orgName(a.targetOrganizationName, a.targetOrganizationNameAr, lang));
    }
    return map;
  }, [allAlerts, lang]);

  const filtered = useMemo(() => allAlerts.filter(a => {
    if (severityFilter && a.severity !== severityFilter) return false;
    if (typeFilter && a.alertType !== typeFilter) return false;
    if (instFilter && a.sourceOrganizationId !== instFilter && a.targetOrganizationId !== instFilter) return false;
    if (search.trim()) {
      const q = search.trim().toLowerCase();
      const haystack = [
        a.scientificName, a.concentration, a.dosageForm,
        a.sourceTradeName, a.targetTradeName,
        a.sourceOrganizationName, a.sourceOrganizationNameAr,
        a.targetOrganizationName, a.targetOrganizationNameAr,
      ].filter(Boolean).join(' ').toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  }), [allAlerts, severityFilter, typeFilter, instFilter, search]);

  return (
    <div style={{ maxWidth: '1040px', animation: 'fs .3s ease' }}>
      {/* Header */}
      <div style={{ marginBottom: '16px' }}>
        <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
          {t('lia_title', lang)}
        </h2>
        <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px', maxWidth: '640px' }} dir="auto">
          {t('lia_sub', lang)}
        </p>
      </div>

      {/* No auto-transfer disclaimer */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        ℹ️ {t('iia_no_transfer', lang)}
      </div>

      {/* Summary cards */}
      {ok && allAlerts.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? 'repeat(2, 1fr)' : 'repeat(4, 1fr)', gap: '10px', marginBottom: '16px' }}>
          <div style={{ background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--info)' }}>{summaryTotal}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_total', lang)}</div>
          </div>
          <div style={{ background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--err)' }}>{summaryHigh}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_high', lang)}</div>
          </div>
          <div style={{ background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--ok)' }}>{summarySurplus}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_surplus', lang)}</div>
          </div>
          <div style={{ background: 'var(--s)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}>
            <div style={{ fontSize: '20px', fontWeight: 700, color: 'var(--warn)' }}>{summaryNearExpiry}</div>
            <div style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('lia_summary_near_expiry', lang)}</div>
          </div>
        </div>
      )}

      {/* Filters */}
      {ok && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '16px', alignItems: 'center' }}>
          <select
            id="lia-severity"
            value={severityFilter}
            onChange={e => setSeverityFilter(e.target.value as LiveAlertSeverity | '')}
            style={{ ...fieldStyle, width: 'auto', minWidth: '150px', appearance: 'none', cursor: 'pointer' }}
            aria-label={t('lia_severity_label', lang)}
          >
            <option value="">{t('lia_severity_label', lang)}: {t('sc_all', lang)}</option>
            <option value="high">{t('lia_severity_high', lang)}</option>
            <option value="medium">{t('lia_severity_medium', lang)}</option>
          </select>

          <select
            id="lia-type"
            value={typeFilter}
            onChange={e => setTypeFilter(e.target.value as LiveAlertType | '')}
            style={{ ...fieldStyle, width: 'auto', minWidth: '170px', appearance: 'none', cursor: 'pointer' }}
            aria-label={t('lia_type_label', lang)}
          >
            <option value="">{t('lia_type_label', lang)}: {t('sc_all', lang)}</option>
            <option value="surplus_to_shortage">{t('lia_type_surplus', lang)}</option>
            <option value="near_expiry_to_shortage">{t('lia_type_near_expiry', lang)}</option>
          </select>

          {instMap.size > 1 && (
            <select
              id="lia-inst"
              value={instFilter}
              onChange={e => setInstFilter(e.target.value)}
              style={{ ...fieldStyle, width: 'auto', minWidth: '160px', appearance: 'none', cursor: 'pointer' }}
              aria-label={t('avail_inst_label', lang)}
            >
              <option value="">{t('avail_inst_label', lang)}: {t('sc_all', lang)}</option>
              {[...instMap.entries()].map(([id, name]) => (
                <option key={id} value={id}>{name}</option>
              ))}
            </select>
          )}

          <div style={{ position: 'relative', flex: 1, minWidth: '150px' }}>
            <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', pointerEvents: 'none' }}>🔍</span>
            <input
              id="lia-search"
              type="search"
              dir="auto"
              placeholder={t('lia_search_ph', lang)}
              value={search}
              onChange={e => setSearch(e.target.value)}
              style={{ ...fieldStyle, paddingInlineStart: '34px' }}
              aria-label={t('lia_search_ph', lang)}
            />
          </div>
        </div>
      )}

      {/* States */}
      {result.loading && <PhoenixLoadingState label={t('loading', lang)} />}

      {!result.loading && result.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={result.error} onRetry={result.reload} />
      )}

      {!result.loading && !result.error && !ok && forbidden && (
        <PhoenixEmptyState icon="🔒" title={t('lia_forbidden', lang)} />
      )}

      {!result.loading && !result.error && !ok && !forbidden && (
        <PhoenixErrorState title={t('load_error', lang)} message={rpcError ?? t('load_error', lang)} onRetry={result.reload} />
      )}

      {!result.loading && !result.error && ok && filtered.length === 0 && (
        <PhoenixEmptyState icon="🔔" title={t('lia_empty', lang)} />
      )}

      {/* Alert cards */}
      {!result.loading && !result.error && ok && filtered.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          {filtered.map(a => (
            <AlertCard key={alertKey(a)} a={a} lang={lang} isMobile={isMobile} />
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Alert card ───────────────────────────────────────────────────────────────

function AlertCard({ a, lang, isMobile }: {
  a: LiveInterInstitutionAlert;
  lang: 'ar' | 'en';
  isMobile: boolean;
}) {
  const borderColor = SEVERITY_BORDER[a.severity] ?? 'var(--brd)';
  const severityVariant = a.severity === 'high' ? 'err' as const : 'warn' as const;
  const severityLabelKey = a.severity === 'high' ? 'lia_severity_high' : 'lia_severity_medium';

  const srcPoint = pointName(a.sourceDistributionPointName, a.sourceDistributionPointNameAr, lang);
  const tgtPoint = pointName(a.targetDistributionPointName, a.targetDistributionPointNameAr, lang);

  return (
    <PhoenixCard padding="16px" style={{ borderInlineStart: `3px solid ${borderColor}` }}>
      {/* Title + alert type + severity */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', marginBottom: '10px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '10.5px', color: 'var(--t2)', fontWeight: 600 }}>{t('avail_scientific_name', lang)}</div>
          <div style={{ fontSize: '14px', fontWeight: 700 }} dir="auto">{a.scientificName}</div>
          <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }}>
            {a.concentration && <span dir="auto">{t('avail_concentration', lang)}: {a.concentration}</span>}
            {a.dosageForm && <span dir="auto">{t('avail_dosage_form', lang)}: {a.dosageForm}</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
          <PhoenixStatusBadge variant="neutral" label={t(ALERT_TYPE_LABEL_KEY[a.alertType], lang)} />
          <PhoenixStatusBadge variant={severityVariant} label={t(severityLabelKey, lang)} />
        </div>
      </div>

      {/* Source / Target */}
      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
        <PartyBlock
          roleLabel={t('source_institution', lang)}
          statusLabelKey={statusLabelKey(a.sourceStatus)}
          statusVar={statusVariant(a.sourceStatus)}
          orgLabel={orgName(a.sourceOrganizationName, a.sourceOrganizationNameAr, lang)}
          pointLabel={srcPoint}
          tradeName={a.sourceTradeName}
          quantity={a.sourceQuantity}
          expiryDate={a.alertType === 'near_expiry_to_shortage' ? a.sourceExpiryDate : null}
          lang={lang}
        />
        <PartyBlock
          roleLabel={t('destination_institution', lang)}
          statusLabelKey={statusLabelKey(a.targetStatus)}
          statusVar={statusVariant(a.targetStatus)}
          orgLabel={orgName(a.targetOrganizationName, a.targetOrganizationNameAr, lang)}
          pointLabel={tgtPoint}
          tradeName={a.targetTradeName}
          quantity={a.targetQuantity}
          expiryDate={null}
          lang={lang}
        />
      </div>

      {/* Footer: required action + computed_at */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap', borderTop: '1px solid var(--brd)', paddingTop: '10px' }}>
        <span style={{ fontSize: '11px', color: 'var(--warn)', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '6px' }}>
          ⚠ {t('lia_required_action', lang)}
        </span>
        <span style={{ fontSize: '10.5px', color: 'var(--t3)' }} dir="ltr">
          {t('lia_computed_at', lang)}: {new Date(a.computedAt).toLocaleString(lang === 'ar' ? 'ar' : 'en')}
        </span>
      </div>
    </PhoenixCard>
  );
}

// ─── Party block ──────────────────────────────────────────────────────────────

function PartyBlock({ roleLabel, statusLabelKey: statusKey, statusVar, orgLabel, pointLabel, tradeName, quantity, expiryDate, lang }: {
  roleLabel: string;
  statusLabelKey: string;
  statusVar: 'ok' | 'warn' | 'err' | 'neutral';
  orgLabel: string;
  pointLabel: string | null;
  tradeName: string | null;
  quantity: number;
  expiryDate: string | null;
  lang: 'ar' | 'en';
}) {
  return (
    <div style={{ background: 'var(--s2)', borderRadius: 'var(--r2)', padding: '10px 12px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', marginBottom: '4px' }}>
        <span style={{ fontSize: '10.5px', color: 'var(--t2)', fontWeight: 600 }}>{roleLabel}</span>
        {statusKey && <PhoenixStatusBadge variant={statusVar} label={t(statusKey, lang)} />}
      </div>
      <div style={{ fontSize: '12.5px', fontWeight: 600 }} dir="auto">{orgLabel}</div>
      {pointLabel && <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">🏥 {pointLabel}</div>}
      <div style={{ marginTop: '6px', fontSize: '11.5px', color: 'var(--t2)' }}>
        {t('qty', lang)}: <strong style={{ color: 'var(--t)' }}>{quantity}</strong>
      </div>
      {tradeName && (
        <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }} dir="auto">
          {t('avail_trade_name', lang)}: {tradeName}
        </div>
      )}
      {expiryDate && (
        <div style={{ fontSize: '11px', color: 'var(--warn)', marginTop: '2px' }} dir="ltr">
          ⏱ {t('expiry', lang)}: {expiryDate}
        </div>
      )}
    </div>
  );
}
