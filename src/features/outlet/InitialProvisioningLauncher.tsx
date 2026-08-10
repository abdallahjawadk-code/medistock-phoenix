import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { getWarehouses } from '@/shared/supabase/services/warehouses.service';
import { getInitialProvisioningState } from './emergency-replenishment.service';
import { OutletDispatchComposer } from './OutletDispatchComposer';

/**
 * STAGE-E-E7-2 — the entry point for التجهيز الأولي (Migration 166).
 *
 * Eligibility is read from Migration 166's own columns
 * (`warehouse_dispatches.is_initial_provisioning` /
 * `initial_provisioning_consumed_at`) — NEVER from the outlet's current
 * balance. Once consumed, the lifecycle is closed for good: a later drop to
 * zero stock does not reopen it, and this component shows a non-actionable
 * status rather than a disabled button pretending the action might return.
 */
export function InitialProvisioningLauncher({
  orgId, distributionPointId, outletName, lang,
}: {
  orgId: string;
  distributionPointId: string;
  outletName: string;
  lang: 'ar' | 'en';
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const state = useAsync(
    () => getInitialProvisioningState(distributionPointId),
    [distributionPointId, reloadKey],
  );
  const warehouses = useAsync(() => getWarehouses(orgId), [orgId]);
  const [warehouseId, setWarehouseId] = useState('');
  const [composerOpen, setComposerOpen] = useState(false);

  if (state.loading || warehouses.loading) return <PhoenixLoadingState label={t('loading', lang)} />;

  if (state.data?.consumed) {
    return (
      <PhoenixCard padding="14px">
        <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>{t('prov_initial', lang)}</h4>
        <p style={{ fontSize: '12px', color: 'var(--t2)' }}>{t('prov_initial_consumed', lang)}</p>
      </PhoenixCard>
    );
  }
  if (state.data?.openDispatchId) {
    return (
      <PhoenixCard padding="14px">
        <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>{t('prov_initial', lang)}</h4>
        <p style={{ fontSize: '12px', color: 'var(--t2)' }}>{t('prov_initial_open', lang)}</p>
      </PhoenixCard>
    );
  }

  const institutionWarehouses = (warehouses.data ?? [])
    .filter(w => w.warehouseKind === 'institution' && w.status === 'active');

  if (composerOpen && warehouseId) {
    const wh = institutionWarehouses.find(w => w.id === warehouseId);
    return (
      <OutletDispatchComposer
        sourceWarehouseId={warehouseId}
        sourceWarehouseName={wh ? (lang === 'ar' ? wh.name_ar : wh.name) : ''}
        outlets={[{ id: distributionPointId, name: outletName }]}
        isInitialProvisioning
        onCancel={() => setComposerOpen(false)}
        onCreated={() => { setComposerOpen(false); setReloadKey(k => k + 1); }}
      />
    );
  }

  return (
    <PhoenixCard padding="14px">
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '6px' }}>{t('prov_initial', lang)}</h4>
      <p style={{ fontSize: '11.5px', color: 'var(--t3)', marginBottom: '10px', lineHeight: 1.5 }}>{t('prov_initial_hint', lang)}</p>
      {institutionWarehouses.length === 0 ? (
        <p style={{ fontSize: '12px', color: 'var(--warn)' }}>{t('port_no_wh', lang)}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          <PhoenixSelect
            label={t('port_warehouse', lang)}
            value={warehouseId}
            onChange={e => setWarehouseId(e.target.value)}
            options={[
              { value: '', label: t('port_select_wh', lang) },
              ...institutionWarehouses.map(w => ({ value: w.id, label: lang === 'ar' ? w.name_ar : w.name })),
            ]}
          />
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <PhoenixButton variant="primary" size="sm" disabled={!warehouseId} onClick={() => setComposerOpen(true)}>
              {t('prov_initial_start', lang)}
            </PhoenixButton>
          </div>
        </div>
      )}
    </PhoenixCard>
  );
}
