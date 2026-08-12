import { useState } from 'react';
import { t, tRpcError } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import type { Warehouse } from '@/shared/supabase/services/warehouses.service';
import type { OrganizationFacility } from './facilities.service';
import { createHealthCenterWarehouse } from '@/features/network/network.service';

/**
 * R1.1 / Migration 181 — atomic health-centre depot creation.
 *
 * The old generic-create-then-attach flow cannot produce a valid centre depot
 * under the final topology. This panel therefore calls the dedicated RPC that
 * inserts institution/facility-bound/non-main/active atomically.
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
  const availableFacilities = facilities.filter(
    f => f.status === 'active' && !warehouses.some(w => w.status === 'active' && w.facilityId === f.id),
  );
  const [facilityId, setFacilityId] = useState<string>(availableFacilities[0]?.id ?? '');
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [code, setCode] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  async function onSubmit() {
    if (!facilityId || !name.trim() || !nameAr.trim() || busy || !canManage) return;
    setBusy(true);
    setError(null);
    setSuccess(null);
    const facility = facilities.find(f => f.id === facilityId);
    if (!facility) { setBusy(false); return; }
    const res = await createHealthCenterWarehouse({
      organizationId: facility.organizationId,
      facilityId,
      name: name.trim(),
      nameAr: nameAr.trim(),
      code: code.trim() || null,
    });
    setBusy(false);
    if (!res.ok) { setError(tRpcError(res.error, lang)); return; }
    setSuccess(t('fac_warehouse_created', lang));
    onAssigned();
  }

  if (availableFacilities.length === 0) return null;

  return (
    <PhoenixCard padding="14px">
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '10px' }}>{t('fac_warehouse_create', lang)}</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <PhoenixSelect
          label={t('fac_section', lang)}
          value={facilityId}
          onChange={e => setFacilityId(e.target.value)}
          options={[
            ...availableFacilities.map(f => ({ value: f.id, label: lang === 'ar' ? f.nameAr : f.name })),
          ]}
          disabled={!canManage}
        />
        <PhoenixInput label={t('net_wh_name', lang)} value={name} onChange={e => setName(e.target.value)} />
        <PhoenixInput label={t('net_wh_name_ar', lang)} value={nameAr} onChange={e => setNameAr(e.target.value)} />
        <PhoenixInput label={t('net_wh_code', lang)} value={code} onChange={e => setCode(e.target.value)} />
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        {success && <p style={{ fontSize: '12px', color: 'var(--ok)' }}>{success}</p>}
        {canManage && (
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <PhoenixButton variant="primary" size="sm" loading={busy} disabled={!facilityId || !name.trim() || !nameAr.trim() || busy} onClick={onSubmit}>
              {t('fac_warehouse_create', lang)}
            </PhoenixButton>
          </div>
        )}
      </div>
    </PhoenixCard>
  );
}
