import { useMemo } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import type { InternalAlertMatch } from './internalAlerts';

/**
 * AVAILABILITY-ALERTS-QR-POLISH-B / -C
 *
 * Read-only display of same-institution surplus/near-expiry -> missing/
 * low-stock matches, computed client-side by computeInternalAlerts() from
 * data StatusCenterScreen already has loaded. No IDs (distribution point
 * ids) are ever rendered — only their display names. No action button is
 * shown (reporting only, matching the rest of Status Center's "no
 * auto-transfer" convention) — this deliberately does not link to or
 * mention the inter-org exchange RPCs/UI.
 *
 * -C polish: severity-count summary chips (computed from the same `matches`
 * prop, no new data source), a clearer from/to visual flow with an arrow
 * separator, and a friendlier empty state — purely visual, read-only
 * behavior unchanged.
 */

interface Props {
  matches: InternalAlertMatch[];
}

export function InternalAlertsSection({ matches }: Props) {
  const { lang } = useApp();

  const pointName = (name: string, nameAr: string) => (lang === 'ar' ? (nameAr || name) : (name || nameAr));

  // Summary counts derived entirely from the already-computed `matches` prop
  // — no new computation source, purely a display aggregation.
  const highCount = useMemo(() => matches.filter(m => m.severity === 'high').length, [matches]);
  const mediumCount = useMemo(() => matches.filter(m => m.severity === 'medium').length, [matches]);

  return (
    <PhoenixCard padding="16px" style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '4px' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 700 }}><PhoenixIcon name="hospital" size={15} inline /> {t('sc_internal_alerts_title', lang)}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('sc_internal_alerts_sub', lang)}</div>
        </div>
        {matches.length > 0 && (
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexWrap: 'wrap' }}>
            {highCount > 0 && (
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--err)', background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--rpill)', padding: '2px 9px' }}>
                {t('lia_severity_high', lang)}: {highCount}
              </span>
            )}
            {mediumCount > 0 && (
              <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--warn)', background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--rpill)', padding: '2px 9px' }}>
                {t('lia_severity_medium', lang)}: {mediumCount}
              </span>
            )}
          </div>
        )}
      </div>

      {matches.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '28px 12px', color: 'var(--t2)' }}>
          <div style={{ marginBottom: '6px', opacity: 0.6, color: 'var(--ok)' }}><PhoenixIcon name="check" size={26} /></div>
          <div style={{ fontSize: '12.5px' }}>{t('sc_internal_alerts_empty', lang)}</div>
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px', marginTop: '10px' }}>
          {matches.map((m, i) => (
            <div
              key={i}
              style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} dir="auto">{m.scientificName}</span>
                <PhoenixStatusBadge variant={m.severity === 'high' ? 'err' : 'warn'} label={t(m.severity === 'high' ? 'lia_severity_high' : 'lia_severity_medium', lang)} />
              </div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '11.5px' }}>
                <div style={{ flex: 1, minWidth: 0 }} dir="auto">
                  <div style={{ fontSize: '9.5px', fontWeight: 700, color: 'var(--ok)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{t('alertLifecycle_institution_from', lang)}</div>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pointName(m.sourcePointName, m.sourcePointNameAr)}</div>
                  <div style={{ color: 'var(--t2)', fontSize: '10.5px' }}>{t('cond_' + m.sourceStatus, lang)} · {m.sourceQuantity}</div>
                </div>
                <div style={{ fontSize: '14px', color: 'var(--t3)', flexShrink: 0 }} aria-hidden="true">{lang === 'ar' ? '←' : '→'}</div>
                <div style={{ flex: 1, minWidth: 0 }} dir="auto">
                  <div style={{ fontSize: '9.5px', fontWeight: 700, color: 'var(--err)', textTransform: 'uppercase', letterSpacing: '.4px' }}>{t('alertLifecycle_institution_to', lang)}</div>
                  <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{pointName(m.targetPointName, m.targetPointNameAr)}</div>
                  <div style={{ color: 'var(--t2)', fontSize: '10.5px' }}>{t('cond_' + m.targetStatus, lang)} · {m.targetQuantity}</div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </PhoenixCard>
  );
}
