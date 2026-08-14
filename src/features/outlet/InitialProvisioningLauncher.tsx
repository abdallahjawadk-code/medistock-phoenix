import { useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
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
 *
 * ── R1.1-P (P3-A) — THE SOURCE IS PAIRED, NOT PICKED ────────────────────────
 * This component used to offer EVERY active institution warehouse in the
 * organization as a free choice. Inside a health sector that list contains the
 * SECTOR MAIN and every OTHER health centre's depot, so commissioning a
 * centre's crash cabinet invited the operator to select a warehouse that does
 * not own it. An outlet has exactly one owning warehouse
 * (`distribution_points.warehouse_id`), and initial provisioning must come from
 * that one — for a health-centre crash cabinet, THAT centre's depot; never the
 * sector main, never a sibling centre.
 *
 * So the source is no longer a question put to the operator. It is resolved
 * from the selected outlet's own pairing, carried down from
 * OutletOperationsScreen (which already resolves it through useInventoryScopes)
 * and shown read-only. The pairing is never inferred from names.
 *
 * Migrations 180/183 remain the authority; this only stops the screen offering
 * a source the server would refuse.
 */
export function InitialProvisioningLauncher({
  orgId, distributionPointId, outletName, owningWarehouseId, lang,
}: {
  orgId: string;
  distributionPointId: string;
  outletName: string;
  /**
   * `distribution_points.warehouse_id` of the selected emergency outlet — its
   * ONE owning warehouse. Null (an outlet with no pairing) offers nothing
   * rather than falling back to an organization-wide list: fail closed.
   */
  owningWarehouseId: string | null;
  lang: 'ar' | 'en';
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const state = useAsync(
    () => getInitialProvisioningState(distributionPointId),
    [distributionPointId, reloadKey],
  );
  const warehouses = useAsync(() => getWarehouses(orgId), [orgId]);
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

  /**
   * The outlet's own owning warehouse, and only if it is still an ACTIVE
   * institution warehouse. A deactivated or archived depot cannot dispatch, so
   * an unresolvable pairing yields no source at all rather than the next-best
   * warehouse in the organization.
   */
  const pairedWarehouse = owningWarehouseId
    ? (warehouses.data ?? []).find(w =>
        w.id === owningWarehouseId && w.warehouseKind === 'institution' && w.status === 'active')
      ?? null
    : null;
  const pairedWarehouseName = pairedWarehouse
    ? (lang === 'ar' ? pairedWarehouse.name_ar : pairedWarehouse.name)
    : '';

  if (composerOpen && pairedWarehouse) {
    return (
      <OutletDispatchComposer
        sourceWarehouseId={pairedWarehouse.id}
        sourceWarehouseName={pairedWarehouseName}
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
      {pairedWarehouse === null ? (
        <p style={{ fontSize: '12px', color: 'var(--warn)' }}>{t('port_no_wh', lang)}</p>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
          {/* Read-only by design — see the P3-A note above. The operator is told
              which depot commissions this outlet; they are not asked to choose,
              because there is exactly one correct answer and every other option
              would be refused by Migration 180/183. */}
          <div data-testid="prov-initial-source">
            <span style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '4px' }}>
              {t('port_warehouse', lang)}
            </span>
            <span dir="auto" style={{ fontSize: '13px', fontWeight: 600, color: 'var(--t1)' }}>
              {pairedWarehouseName}
            </span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <PhoenixButton variant="primary" size="sm" onClick={() => setComposerOpen(true)}>
              {t('prov_initial_start', lang)}
            </PhoenixButton>
          </div>
        </div>
      )}
    </PhoenixCard>
  );
}
