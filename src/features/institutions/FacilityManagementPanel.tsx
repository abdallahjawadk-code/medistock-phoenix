import { useState } from 'react';
import { t, tRpcError } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import {
  listOrganizationFacilities,
  upsertOrganizationFacility,
  type OrganizationFacility,
} from './facilities.service';

const fieldStyle: React.CSSProperties = {
  width: '100%', maxWidth: '100%', boxSizing: 'border-box', minHeight: '44px',
  padding: '10px 12px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
  background: 'var(--s)', color: 'var(--t1)', fontSize: '13px',
};

/**
 * STAGE-E-E7-2 — subordinate health-centre facility management (Migration 164).
 *
 * Every write goes through `phoenix_upsert_organization_facility`, whose own
 * composite FK (`of_parent_class_fk`) structurally requires the OWNING
 * organization's institution_class to be `health_sector` — a hospital, a
 * specialized center, and a pharmacy_department_authority (whose
 * institution_class is always NULL, Migration 171) can never legally own a
 * facility. This panel is therefore only ever mounted for a health_sector
 * organization (see the gate in OrgDetailView); it never renders a control
 * that the database would categorically refuse.
 */
export function FacilityManagementPanel({
  orgId, lang, canManage,
}: {
  orgId: string;
  lang: 'ar' | 'en';
  canManage: boolean;
}) {
  const facilities = useAsync(() => listOrganizationFacilities(orgId), [orgId]);
  const [adding, setAdding] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);

  if (facilities.loading) return <PhoenixLoadingState label={t('loading', lang)} />;
  if (facilities.error) {
    return <PhoenixErrorState title={t('load_error', lang)} message={facilities.error} onRetry={facilities.reload} />;
  }

  const rows = facilities.data ?? [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 className="nexus-io-section-title" style={{ fontSize: '14px', fontWeight: 700 }}>{t('fac_section', lang)}</h3>
        {canManage && !adding && (
          <PhoenixButton variant="secondary" size="sm" onClick={() => setAdding(true)}>
            {t('fac_add', lang)}
          </PhoenixButton>
        )}
      </div>

      {adding && (
        <div style={{ marginBottom: '12px' }}>
          <FacilityForm
            orgId={orgId}
            lang={lang}
            onSaved={() => { setAdding(false); facilities.reload(); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {rows.length === 0 && !adding ? (
        <PhoenixEmptyState icon="hospital" title={t('fac_none', lang)} description={canManage ? t('fac_add', lang) : ''} />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {rows.map(f => (
            editingId === f.id ? (
              <FacilityForm
                key={f.id}
                orgId={orgId}
                lang={lang}
                facility={f}
                onSaved={() => { setEditingId(null); facilities.reload(); }}
                onCancel={() => setEditingId(null)}
              />
            ) : (
              <PhoenixCard key={f.id} padding="12px" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <div>
                  <div style={{ fontSize: '13px', fontWeight: 600 }}>{lang === 'ar' ? f.nameAr : f.name}</div>
                  <div style={{ fontSize: '11.5px', color: 'var(--t3)' }}>
                    {f.facilityClass === 'primary_health_center' ? t('fac_class_primary', lang) : t('fac_class_subordinate', lang)}
                    {' · '}{f.status === 'active' ? t('fac_active', lang) : f.status}
                    {f.code ? ` · ${f.code}` : ''}
                  </div>
                </div>
                {canManage && (
                  <PhoenixButton variant="ghost" size="sm" onClick={() => setEditingId(f.id)}>
                    {t('port_edit', lang)}
                  </PhoenixButton>
                )}
              </PhoenixCard>
            )
          ))}
        </div>
      )}
    </div>
  );
}

function FacilityForm({
  orgId, lang, facility, onSaved, onCancel,
}: {
  orgId: string;
  lang: 'ar' | 'en';
  facility?: OrganizationFacility;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(facility?.name ?? '');
  const [nameAr, setNameAr] = useState(facility?.nameAr ?? '');
  const [code, setCode] = useState(facility?.code ?? '');
  const [facilityClass, setFacilityClass] = useState<'primary_health_center' | 'subordinate_health_center'>(
    facility?.facilityClass ?? 'primary_health_center',
  );
  const [isActive, setIsActive] = useState(facility ? facility.status === 'active' : true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim().length > 0 && nameAr.trim().length > 0;

  async function onSubmit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    const res = await upsertOrganizationFacility({
      facilityId: facility?.id ?? null,
      organizationId: orgId,
      facilityClass,
      name: name.trim(),
      nameAr: nameAr.trim(),
      code: code.trim() || null,
      isActive,
    });
    setBusy(false);
    if (!res.ok) { setError(tRpcError(res.error, lang)); return; }
    onSaved();
  }

  return (
    <PhoenixCard padding="14px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label htmlFor="fac-name-en" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('fac_name_en', lang)} *</label>
            <input id="fac-name-en" type="text" value={name} onChange={e => setName(e.target.value)} style={fieldStyle} dir="ltr" />
          </div>
          <div>
            <label htmlFor="fac-name-ar" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('fac_name_ar', lang)} *</label>
            <input id="fac-name-ar" type="text" value={nameAr} onChange={e => setNameAr(e.target.value)} style={fieldStyle} dir="rtl" />
          </div>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
          <div>
            <label htmlFor="fac-code" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('fac_code', lang)}</label>
            <input id="fac-code" type="text" value={code} onChange={e => setCode(e.target.value)} style={fieldStyle} dir="ltr" />
          </div>
          <div>
            <label htmlFor="fac-class" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('fac_class', lang)}</label>
            <select
              id="fac-class"
              value={facilityClass}
              onChange={e => setFacilityClass(e.target.value as typeof facilityClass)}
              style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}
              dir="auto"
            >
              <option value="primary_health_center">{t('fac_class_primary', lang)}</option>
              <option value="subordinate_health_center">{t('fac_class_subordinate', lang)}</option>
            </select>
          </div>
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', color: 'var(--t2)' }}>
          <input type="checkbox" checked={isActive} onChange={e => setIsActive(e.target.checked)} />
          {t('fac_active', lang)}
        </label>
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <PhoenixButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="sm" loading={busy} disabled={!canSubmit} onClick={onSubmit}>
            {t('inst_save', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}
