import { useState } from 'react';
import { t, tRpcError } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import type { DistributionPoint } from '@/shared/supabase/services/warehouses.service';
import { listReplenishmentRoutes, upsertReplenishmentRoute } from '../outlet/emergency-replenishment.service';

/**
 * STAGE-E-E7-2 — replenishment route management (Migration 164).
 *
 * The sole write is `phoenix_upsert_outlet_replenishment_route`, which owns
 * the entire eligibility contract server-side (source must be a pharmacy,
 * destination must be an emergency outlet, both in the same organization, at
 * most one ACTIVE route per destination, plus the health-sector same-facility
 * rule). Source/destination options are restricted here to real point types
 * that already exist (`pharmacy`, `rescue_cart`, `crash_cabinet`) — no
 * invented point type — but the final legality call is always the server's.
 */
export function ReplenishmentRouteManagementPanel({
  orgId, points, lang, canManage,
}: {
  orgId: string;
  points: DistributionPoint[];
  lang: 'ar' | 'en';
  canManage: boolean;
}) {
  const [reloadKey, setReloadKey] = useState(0);
  const routes = useAsync(() => listReplenishmentRoutes(orgId), [orgId, reloadKey]);
  const [adding, setAdding] = useState(false);

  const pharmacies = points.filter(p => p.pointType === 'pharmacy');
  const emergencyOutlets = points.filter(p => p.pointType === 'rescue_cart' || p.pointType === 'crash_cabinet');
  const byId = new Map(points.map(p => [p.id, p]));

  if (routes.loading) return <PhoenixLoadingState label={t('loading', lang)} />;
  if (routes.error) return <PhoenixErrorState title={t('load_error', lang)} message={routes.error} onRetry={routes.reload} />;

  const rows = routes.data ?? [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
        <h3 className="nexus-io-section-title" style={{ fontSize: '14px', fontWeight: 700 }}>{t('route_section', lang)}</h3>
        {canManage && !adding && pharmacies.length > 0 && emergencyOutlets.length > 0 && (
          <PhoenixButton variant="secondary" size="sm" onClick={() => setAdding(true)}>{t('route_add', lang)}</PhoenixButton>
        )}
      </div>

      {canManage && pharmacies.length === 0 && (
        <p style={{ fontSize: '12px', color: 'var(--t3)', marginBottom: '10px' }}>{t('route_no_sources', lang)}</p>
      )}
      {canManage && pharmacies.length > 0 && emergencyOutlets.length === 0 && (
        <p style={{ fontSize: '12px', color: 'var(--t3)', marginBottom: '10px' }}>{t('route_no_destinations', lang)}</p>
      )}

      {adding && (
        <div style={{ marginBottom: '12px' }}>
          <RouteForm
            pharmacies={pharmacies}
            emergencyOutlets={emergencyOutlets}
            lang={lang}
            onSaved={() => { setAdding(false); setReloadKey(k => k + 1); }}
            onCancel={() => setAdding(false)}
          />
        </div>
      )}

      {rows.length === 0 && !adding ? (
        <PhoenixEmptyState icon="package" title={t('route_none', lang)} description="" />
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {rows.map(r => {
            const src = byId.get(r.sourcePointId);
            const dst = byId.get(r.destinationPointId);
            return (
              <PhoenixCard key={r.id} padding="12px" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '8px' }}>
                <div style={{ fontSize: '13px' }}>
                  <strong>{src ? (lang === 'ar' ? src.name_ar : src.name) : r.sourcePointId.slice(0, 8)}</strong>
                  {' → '}
                  <strong>{dst ? (lang === 'ar' ? dst.name_ar : dst.name) : r.destinationPointId.slice(0, 8)}</strong>
                  <span style={{ fontSize: '11.5px', color: 'var(--t3)', marginInlineStart: '8px' }}>
                    {r.destinationPointType === 'rescue_cart' ? t('port_type_rescue_cart', lang) : t('port_type_crash_cabinet', lang)}
                    {' · '}
                    {r.isActive ? t('route_active', lang) : t('e_route_inactive', lang)}
                  </span>
                </div>
              </PhoenixCard>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RouteForm({
  pharmacies, emergencyOutlets, lang, onSaved, onCancel,
}: {
  pharmacies: DistributionPoint[];
  emergencyOutlets: DistributionPoint[];
  lang: 'ar' | 'en';
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [sourceId, setSourceId] = useState(pharmacies[0]?.id ?? '');
  const [destId, setDestId] = useState(emergencyOutlets[0]?.id ?? '');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = Boolean(sourceId && destId && sourceId !== destId);

  async function onSubmit() {
    if (!canSubmit || busy) return;
    setBusy(true);
    setError(null);
    const res = await upsertReplenishmentRoute({
      sourcePointId: sourceId,
      destinationPointId: destId,
      isActive: true,
      notes: notes.trim() || null,
    });
    setBusy(false);
    if (!res.ok) { setError(tRpcError(res.error, lang)); return; }
    onSaved();
  }

  return (
    <PhoenixCard padding="14px">
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px' }}>
        <PhoenixSelect
          label={t('route_source', lang)}
          value={sourceId}
          onChange={e => setSourceId(e.target.value)}
          options={pharmacies.map(p => ({ value: p.id, label: lang === 'ar' ? p.name_ar : p.name }))}
        />
        <PhoenixSelect
          label={t('route_destination', lang)}
          value={destId}
          onChange={e => setDestId(e.target.value)}
          options={emergencyOutlets.map(p => ({
            value: p.id,
            label: `${lang === 'ar' ? p.name_ar : p.name} (${p.pointType === 'rescue_cart' ? t('port_type_rescue_cart', lang) : t('port_type_crash_cabinet', lang)})`,
          }))}
        />
        <div>
          <label htmlFor="route-notes" style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('route_notes', lang)}</label>
          <input
            id="route-notes"
            type="text"
            value={notes}
            onChange={e => setNotes(e.target.value)}
            style={{
              width: '100%', maxWidth: '100%', boxSizing: 'border-box', minHeight: '44px',
              padding: '10px 12px', borderRadius: 'var(--r3)', border: '1px solid var(--brd)',
              background: 'var(--s)', color: 'var(--t1)', fontSize: '13px',
            }}
            dir="auto"
          />
        </div>
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <PhoenixButton variant="ghost" size="sm" onClick={onCancel} disabled={busy}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="sm" loading={busy} disabled={!canSubmit} onClick={onSubmit}>{t('inst_save', lang)}</PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}
