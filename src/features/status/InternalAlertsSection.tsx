import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import type { InternalAlertMatch } from './internalAlerts';

/**
 * AVAILABILITY-ALERTS-QR-POLISH-B
 *
 * Read-only display of same-institution surplus/near-expiry -> missing/
 * low-stock matches, computed client-side by computeInternalAlerts() from
 * data StatusCenterScreen already has loaded. No IDs (distribution point
 * ids) are ever rendered — only their display names. No action button is
 * shown (reporting only, matching the rest of Status Center's "no
 * auto-transfer" convention) — this deliberately does not link to or
 * mention the inter-org exchange RPCs/UI.
 */

interface Props {
  matches: InternalAlertMatch[];
}

export function InternalAlertsSection({ matches }: Props) {
  const { lang } = useApp();

  const pointName = (name: string, nameAr: string) => (lang === 'ar' ? (nameAr || name) : (name || nameAr));

  return (
    <PhoenixCard padding="16px" style={{ marginBottom: '16px' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: '8px', marginBottom: '4px' }}>
        <div>
          <div style={{ fontSize: '15px', fontWeight: 700 }}>🏥 {t('sc_internal_alerts_title', lang)}</div>
          <div style={{ fontSize: '11.5px', color: 'var(--t2)', marginTop: '2px' }}>{t('sc_internal_alerts_sub', lang)}</div>
        </div>
        {matches.length > 0 && (
          <span style={{ fontSize: '10px', fontWeight: 700, color: 'var(--warn)', background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--rpill)', padding: '2px 9px' }}>
            {matches.length}
          </span>
        )}
      </div>

      {matches.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '20px 12px', color: 'var(--t2)', fontSize: '12.5px' }}>
          {t('sc_internal_alerts_empty', lang)}
        </div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))', gap: '10px', marginTop: '10px' }}>
          {matches.map((m, i) => (
            <div
              key={i}
              style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r3)', padding: '12px 14px' }}
            >
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '6px' }}>
                <span style={{ fontSize: '12.5px', fontWeight: 700 }} dir="auto">{m.scientificName}</span>
                <PhoenixStatusBadge variant={m.severity === 'high' ? 'err' : 'warn'} label={t(m.severity === 'high' ? 'lia_severity_high' : 'lia_severity_medium', lang)} />
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '11.5px', color: 'var(--t2)' }}>
                <div dir="auto">
                  <span style={{ fontWeight: 600, color: 'var(--ok)' }}>{t('alertLifecycle_institution_from', lang)}:</span>{' '}
                  {pointName(m.sourcePointName, m.sourcePointNameAr)} — {t('cond_' + m.sourceStatus, lang)} ({m.sourceQuantity})
                </div>
                <div dir="auto">
                  <span style={{ fontWeight: 600, color: 'var(--err)' }}>{t('alertLifecycle_institution_to', lang)}:</span>{' '}
                  {pointName(m.targetPointName, m.targetPointNameAr)} — {t('cond_' + m.targetStatus, lang)} ({m.targetQuantity})
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </PhoenixCard>
  );
}
