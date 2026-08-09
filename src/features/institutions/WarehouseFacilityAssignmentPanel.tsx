import { useState } from 'react';
import { t, tRpcError } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import type { Warehouse } from '@/shared/supabase/services/warehouses.service';
import { assignWarehouseFacility } from './facilities.service';
import type { OrganizationFacility } from './facilities.service';

/**
 * STAGE-E-E7-2 — warehouse → subordinate-facility assignment (Migration 170).
 *
 * The sole write is `phoenix_assign_warehouse_facility`, which sits behind a
 * hard trigger boundary: once a warehouse carries an operational dependency
 * (a dispatch, a stock row, an outlet under it — the 19-table guard), the
 * reassignment is refused server-side. That rejection is surfaced verbatim
 * here, never pre-empted by a client-side guess. There is no direct
 * `UPDATE warehouses SET facility_id = ...` path in this codebase.
 */
export function WarehouseFacilityAssignmentPanel({
  warehouses, facilities, lang, canManage, onAssigned,
}: {
  warehouses: Warehouse[];
  facilities: OrganizationFacility[];
  lang: 'ar' | 'en';
  canManage: boolean;
  onAssigned: () => void;
}) {
  const [warehouseId, setWarehouseId] = useState(warehouses[0]?.id ?? '');
  const [facilityId, setFacilityId] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const selectedWarehouse = warehouses.find(w => w.id === warehouseId);
  const currentFacility = facilities.find(f => f.id === selectedWarehouse?.facilityId);

  async function onSubmit() {
    if (!warehouseId || busy || !canManage) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const res = await assignWarehouseFacility({
      warehouseId,
      facilityId: facilityId === '' ? null : facilityId,
    });
    setBusy(false);
    if (!res.ok) { setError(tRpcError(res.error, lang)); return; }
    setSuccess(t('fac_warehouse_assigned', lang));
    onAssigned();
  }

  if (warehouses.length === 0) return null;

  return (
    <PhoenixCard padding="14px">
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{t('fac_warehouse_assign', lang)}</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <PhoenixSelect
          label={t('inst_warehouses', lang)}
          value={warehouseId}
          onChange={e => { setWarehouseId(e.target.value); setError(null); setSuccess(null); }}
          options={warehouses.map(w => ({ value: w.id, label: lang === 'ar' ? w.name_ar : w.name }))}
        />
        {selectedWarehouse && (
          <p style={{ fontSize: '11.5px', color: 'var(--t3)' }}>
            {currentFacility ? (lang === 'ar' ? currentFacility.nameAr : currentFacility.name) : t('fac_warehouse_none', lang)}
          </p>
        )}
        <PhoenixSelect
          label={t('fac_section', lang)}
          value={facilityId}
          onChange={e => setFacilityId(e.target.value)}
          options={[
            { value: '', label: t('fac_warehouse_none', lang) },
            ...facilities.map(f => ({ value: f.id, label: lang === 'ar' ? f.nameAr : f.name })),
          ]}
          disabled={!canManage}
        />
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        {success && <p style={{ fontSize: '12px', color: 'var(--ok)' }}>{success}</p>}
        {canManage && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <PhoenixButton variant="primary" size="sm" loading={busy} disabled={!warehouseId || busy} onClick={onSubmit}>
              {t('fac_warehouse_assign', lang)}
            </PhoenixButton>
          </div>
        )}
      </div>
    </PhoenixCard>
  );
}
