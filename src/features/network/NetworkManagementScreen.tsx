import { useMemo, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { roleLabelKey } from '@/shared/lib/roles';
import { useAsync } from '@/shared/lib/useAsync';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { getOrganizations, getProfilesByOrg } from '@/shared/supabase/services/organizations.service';
import { getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import {
  getAllWarehouses, createWarehouse, updateWarehouse, setWarehouseActive,
  getSupplyRoutes, createSupplyRoute, setSupplyRouteActive, updateSupplyRoute,
  getScopeAssignments, assignProfileScope, revokeProfileScope,
  type NetworkWarehouse, type SupplyRoute, type WarehouseKind, type ScopeKind, type RpcResult,
} from './network.service';
import { NetworkTopologyStage } from './NetworkTopologyStage';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';

/**
 * PHASE-B-NETWORK-UI-A — super_admin network structure management, plus the
 * scope-assignment tab for users.edit_scope holders. Every mutation goes through
 * the 074/075/076 RPCs (network.service); permission gates here are convenience,
 * the RPC is the boundary — a denied server response renders a clear message.
 */

type Lang = 'ar' | 'en';

/** Map an RPC error-code token to a localized, actionable message. */
export function networkErrorMessage(code: string | undefined, lang: Lang): string {
  const c = (code ?? '').toUpperCase();
  if (c.startsWith('NOT_AUTHORIZED') && c.includes('CROSS_ORG')) return t('net_err_cross_org', lang);
  if (c.startsWith('NOT_AUTHORIZED')) return t('net_err_not_authorized', lang);
  if (c.includes('CROSS_ORG')) return t('net_err_cross_org', lang);
  if (c.includes('EXISTS') || c.includes('CONFLICT')) return t('net_err_conflict', lang);
  if (c.endsWith('NOT_FOUND')) return t('net_err_not_found', lang);
  if (c.includes('INVALID') || c.endsWith('REQUIRED') || c.includes('INELIGIBLE') || c.includes('SELF') || c.includes('NOT_CENTRAL') || c.includes('NOT_INSTITUTION') || c.includes('INACTIVE') || c.includes('ARCHIVED')) {
    return t('net_err_invalid', lang);
  }
  return t('net_err_generic', lang);
}

const nameOf = (w: { name_ar: string; name: string } | undefined, lang: Lang): string =>
  !w ? '—' : (lang === 'ar' ? (w.name_ar || w.name) : (w.name || w.name_ar));

// ─────────────────────────────────────────────────────────────────────────────

type Tab = 'warehouses' | 'routes' | 'scopes';

export function NetworkManagementScreen() {
  const { lang, dir, role, myPermissions } = useApp();
  const isSuper = role === 'super_admin';
  const canEditScope = isSuper || myPermissions.has('users.edit_scope');

  const tabs = useMemo(() => {
    const list: { id: Tab; labelKey: string }[] = [];
    if (isSuper) {
      list.push({ id: 'warehouses', labelKey: 'net_tab_warehouses' });
      list.push({ id: 'routes', labelKey: 'net_tab_routes' });
    }
    if (canEditScope) list.push({ id: 'scopes', labelKey: 'net_tab_scopes' });
    return list;
  }, [isSuper, canEditScope]);

  const [tab, setTab] = useState<Tab>(() => (isSuper ? 'warehouses' : 'scopes'));

  if (tabs.length === 0) {
    return (
      <PhoenixEmptyState icon="lock" title={t('net_denied', lang)} />
    );
  }

  const activeTab = tabs.some(x => x.id === tab) ? tab : tabs[0].id;

  return (
    <div className="premium-page nexus-network-page" dir={dir}>
      <header className="nexus-network-page__header premium-page-header">
        <div className="nexus-network-page__mark" aria-hidden="true">
          <PhoenixIcon name="network" size={24} />
        </div>
        <div>
          <span className="nexus-dashboard__eyebrow">
            {lang === 'ar' ? 'شبكة PHOENIX · قراءة حيّة' : 'PHOENIX NETWORK · LIVE READ'}
          </span>
          <h2>{t('nav_network', lang)}</h2>
          <p>{lang === 'ar' ? 'إدارة مخازن قسم الصيدلة والمذاخر والمنافذ ومسارات التجهيز' : 'Pharmacy warehouses, institution stores, outlets and supply routes'}</p>
        </div>
      </header>

      <div className="nexus-network-tabs" role="tablist" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '16px' }}>
        {tabs.map(x => (
          <button
            key={x.id}
            role="tab"
            aria-selected={activeTab === x.id}
            onClick={() => setTab(x.id)}
            className="premium-focus-ring"
            style={{
              padding: '9px 14px', minHeight: '44px', borderRadius: 'var(--r2)',
              border: '1px solid var(--brd)', cursor: 'pointer', fontSize: '13px', fontWeight: 600,
              background: activeTab === x.id ? 'var(--p)' : 'var(--s)',
              color: activeTab === x.id ? '#fff' : 'var(--t2)',
            }}
          >
            {t(x.labelKey, lang)}
          </button>
        ))}
      </div>

      {activeTab === 'warehouses' && isSuper && <WarehousesPanel lang={lang} />}
      {activeTab === 'routes' && isSuper && <SupplyRoutesPanel lang={lang} />}
      {activeTab === 'scopes' && canEditScope && <ScopeAssignmentsPanel lang={lang} isSuper={isSuper} />}
    </div>
  );
}

// ─── shared bits ─────────────────────────────────────────────────────────────

function StatusLine({ msg, error }: { msg: string | null; error: boolean }) {
  if (!msg) return null;
  return (
    <div role="status" style={{
      margin: '10px 0', padding: '9px 12px', borderRadius: 'var(--r2)', fontSize: '12.5px',
      background: error ? 'var(--err2)' : 'var(--ok2, #ecfdf5)',
      color: error ? 'var(--err)' : 'var(--ok, #047857)',
      border: `1px solid ${error ? 'var(--err)' : 'var(--ok, #047857)'}`,
    }}>
      {msg}
    </div>
  );
}

function useOrgSelector(lang: Lang, includeAll: boolean) {
  const orgs = useAsync(() => getOrganizations(), []);
  const [orgId, setOrgId] = useState<string>('');
  const options = useMemo(() => {
    const base = (orgs.data ?? []).map(o => ({ value: o.id, label: lang === 'ar' ? o.name_ar : o.name }));
    return includeAll ? [{ value: '', label: t('net_org_all', lang) }, ...base] : base;
  }, [orgs.data, lang, includeAll]);
  // Default to the first org when not "all".
  const effectiveOrgId = orgId || (includeAll ? '' : (orgs.data?.[0]?.id ?? ''));
  return { orgs, orgId: effectiveOrgId, setOrgId, options };
}

// ─── Warehouses panel (074) ──────────────────────────────────────────────────

function WarehousesPanel({ lang }: { lang: Lang }) {
  const [reloadKey, setReloadKey] = useState(0);
  const warehouses = useAsync(() => getAllWarehouses(), [reloadKey]);
  const { orgs, orgId, setOrgId, options } = useOrgSelector(lang, false);
  const routes = useAsync(() => getSupplyRoutes(), [reloadKey]);
  const outlets = useAsync(
    () => orgId ? getPointsByOrg(orgId) : Promise.resolve([]),
    [orgId, reloadKey],
  );
  const [status, setStatus] = useState<{ msg: string; error: boolean } | null>(null);
  const [adding, setAdding] = useState(false);

  const reload = () => setReloadKey(k => k + 1);
  const inOrg = (warehouses.data ?? []).filter(w => w.organizationId === orgId);
  const central = inOrg.filter(w => w.warehouseKind === 'central');
  const institution = inOrg.filter(w => w.warehouseKind === 'institution');
  const selectedWarehouseIds = new Set(inOrg.map(w => w.id));
  const relatedWarehouseIds = new Set(selectedWarehouseIds);
  (routes.data ?? []).forEach(route => {
    if (selectedWarehouseIds.has(route.sourceWarehouseId) || selectedWarehouseIds.has(route.targetWarehouseId)) {
      relatedWarehouseIds.add(route.sourceWarehouseId);
      relatedWarehouseIds.add(route.targetWarehouseId);
    }
  });
  const topologyWarehouses = (warehouses.data ?? []).filter(w => relatedWarehouseIds.has(w.id));
  const topologyRoutes = (routes.data ?? []).filter(
    route => relatedWarehouseIds.has(route.sourceWarehouseId) && relatedWarehouseIds.has(route.targetWarehouseId),
  );

  if (orgs.loading || warehouses.loading) return <PhoenixLoadingState />;
  if (orgs.error) return <PhoenixErrorState message={orgs.error} onRetry={reload} />;
  if (warehouses.error) return <PhoenixErrorState message={warehouses.error} onRetry={reload} />;

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' }}>
        <div style={{ minWidth: '220px', flex: 1 }}>
          <PhoenixSelect label={t('net_org_select', lang)} options={options} value={orgId}
            onChange={e => setOrgId(e.target.value)} />
        </div>
        <PhoenixButton onClick={() => setAdding(a => !a)} disabled={!orgId}>{t('net_wh_add', lang)}</PhoenixButton>
      </div>

      {status && <StatusLine msg={status.msg} error={status.error} />}

      {orgId && (
        <NetworkTopologyStage
          lang={lang}
          warehouses={topologyWarehouses}
          routes={topologyRoutes}
          outlets={outlets.data ?? []}
          organizationName={options.find(option => option.value === orgId)?.label}
        />
      )}

      {adding && orgId && (
        <WarehouseForm
          lang={lang} organizationId={orgId}
          onCancel={() => setAdding(false)}
          onDone={(res) => {
            if (res.ok) { setStatus({ msg: t('net_wh_saved', lang), error: false }); setAdding(false); reload(); }
            else setStatus({ msg: networkErrorMessage(res.error, lang), error: true });
          }}
        />
      )}

      {!orgId && <PhoenixEmptyState icon="institutions" title={t('net_select_org_first', lang)} />}
      {orgId && inOrg.length === 0 && <PhoenixEmptyState icon="warehouse" title={t('net_wh_empty', lang)} />}

      {central.length > 0 && <WarehouseGroup lang={lang} title={t('net_wh_central', lang)} rows={central} onChanged={(r) => { setStatus(r); reload(); }} />}
      {institution.length > 0 && <WarehouseGroup lang={lang} title={t('net_wh_institution', lang)} rows={institution} onChanged={(r) => { setStatus(r); reload(); }} />}
    </div>
  );
}

function WarehouseGroup({ lang, title, rows, onChanged }: {
  lang: Lang; title: string; rows: NetworkWarehouse[];
  onChanged: (s: { msg: string; error: boolean }) => void;
}) {
  return (
    <div style={{ marginTop: '14px' }}>
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '8px', color: 'var(--t2)' }}>{title}</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {rows.map(w => <WarehouseRow key={w.id} lang={lang} w={w} onChanged={onChanged} />)}
      </div>
    </div>
  );
}

function WarehouseRow({ lang, w, onChanged }: {
  lang: Lang; w: NetworkWarehouse; onChanged: (s: { msg: string; error: boolean }) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const active = w.status === 'active';

  async function toggle() {
    setBusy(true);
    const res = await setWarehouseActive(w.id, !active);
    setBusy(false);
    onChanged(res.ok ? { msg: t('net_wh_saved', lang), error: false } : { msg: networkErrorMessage(res.error, lang), error: true });
  }

  if (editing) {
    return (
      <WarehouseForm
        lang={lang} organizationId={w.organizationId} existing={w}
        onCancel={() => setEditing(false)}
        onDone={(res) => {
          setEditing(false);
          onChanged(res.ok ? { msg: t('net_wh_saved', lang), error: false } : { msg: networkErrorMessage(res.error, lang), error: true });
        }}
      />
    );
  }

  return (
    <PhoenixCard padding="12px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: '13.5px', fontWeight: 700, display: 'flex', alignItems: 'center', gap: '8px' }}>
            <span>{nameOf(w, lang)}</span>
            {w.isMain && <Badge text={t('net_wh_main_badge', lang)} tone="p" />}
            <Badge text={active ? t('net_wh_active', lang) : t('net_wh_inactive', lang)} tone={active ? 'ok' : 'muted'} />
          </div>
          {w.code && <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('net_wh_code', lang)}: {w.code}</div>}
        </div>
        <PhoenixButton size="sm" variant="ghost" onClick={() => setEditing(true)}>{t('net_wh_edit', lang)}</PhoenixButton>
        <PhoenixButton size="sm" variant={active ? 'warn' : 'primary'} loading={busy} onClick={toggle}>
          {active ? t('net_wh_deactivate', lang) : t('net_wh_activate', lang)}
        </PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

function WarehouseForm({ lang, organizationId, existing, onCancel, onDone }: {
  lang: Lang; organizationId: string; existing?: NetworkWarehouse;
  onCancel: () => void; onDone: (res: RpcResult) => void;
}) {
  const [nameAr, setNameAr] = useState(existing?.name_ar ?? '');
  const [name, setName] = useState(existing?.name ?? '');
  const [code, setCode] = useState(existing?.code ?? '');
  const [kind, setKind] = useState<WarehouseKind>(existing?.warehouseKind ?? 'institution');
  const [isMain, setIsMain] = useState(existing?.isMain ?? false);
  const [busy, setBusy] = useState(false);
  const canSubmit = nameAr.trim() !== '' && name.trim() !== '';

  async function submit() {
    if (!canSubmit) return;
    setBusy(true);
    const res = existing
      ? await updateWarehouse({ warehouseId: existing.id, name: name.trim(), nameAr: nameAr.trim(), code: code.trim() === '' ? '' : code.trim() })
      : await createWarehouse({ organizationId, name: name.trim(), nameAr: nameAr.trim(), warehouseKind: kind, code: code.trim() || null, isMain });
    setBusy(false);
    onDone(res);
  }

  return (
    <PhoenixCard padding="16px" style={{ marginBottom: '10px', borderColor: 'var(--p)' }}>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <PhoenixInput label={t('net_wh_name_ar', lang)} value={nameAr} onChange={e => setNameAr(e.target.value)} />
        <PhoenixInput label={t('net_wh_name', lang)} value={name} onChange={e => setName(e.target.value)} />
        <PhoenixInput label={t('net_wh_code', lang)} value={code} onChange={e => setCode(e.target.value)} />
        {!existing && (
          <PhoenixSelect label={t('net_wh_kind', lang)} value={kind}
            onChange={e => setKind(e.target.value as WarehouseKind)}
            options={[
              { value: 'institution', label: t('net_wh_institution', lang) },
              { value: 'central', label: t('net_wh_central', lang) },
            ]} />
        )}
      </div>
      {!existing && (
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '10px', fontSize: '12.5px', cursor: 'pointer' }}>
          <input type="checkbox" checked={isMain} onChange={e => setIsMain(e.target.checked)} />
          {t('net_wh_is_main', lang)}
        </label>
      )}
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <PhoenixButton loading={busy} disabled={!canSubmit} onClick={submit}>{t('net_save', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={onCancel}>{t('net_cancel', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

// ─── Supply routes panel (075) ───────────────────────────────────────────────

function SupplyRoutesPanel({ lang }: { lang: Lang }) {
  const [reloadKey, setReloadKey] = useState(0);
  const warehouses = useAsync(() => getAllWarehouses(), [reloadKey]);
  const routes = useAsync(() => getSupplyRoutes(), [reloadKey]);
  const [status, setStatus] = useState<{ msg: string; error: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const reload = () => setReloadKey(k => k + 1);

  const whById = useMemo(() => {
    const m = new Map<string, NetworkWarehouse>();
    (warehouses.data ?? []).forEach(w => m.set(w.id, w));
    return m;
  }, [warehouses.data]);
  const centrals = (warehouses.data ?? []).filter(w => w.warehouseKind === 'central' && w.status === 'active');
  const institutions = (warehouses.data ?? []).filter(w => w.warehouseKind === 'institution' && w.status === 'active');

  if (warehouses.loading || routes.loading) return <PhoenixLoadingState />;
  if (warehouses.error) return <PhoenixErrorState message={warehouses.error} onRetry={reload} />;
  if (routes.error) return <PhoenixErrorState message={routes.error} onRetry={reload} />;

  const list = routes.data ?? [];

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '10px', marginBottom: '10px' }}>
        <p style={{ fontSize: '11.5px', color: 'var(--t2)', margin: 0 }}>{t('net_sr_hint', lang)}</p>
        <PhoenixButton onClick={() => setAdding(a => !a)} disabled={centrals.length === 0 || institutions.length === 0}>
          {t('net_sr_add', lang)}
        </PhoenixButton>
      </div>

      {status && <StatusLine msg={status.msg} error={status.error} />}

      {adding && (
        <SupplyRouteForm
          lang={lang} centrals={centrals} institutions={institutions}
          onCancel={() => setAdding(false)}
          onDone={(res) => {
            if (res.ok) { setStatus({ msg: t('net_sr_saved', lang), error: false }); setAdding(false); reload(); }
            else setStatus({ msg: networkErrorMessage(res.error, lang), error: true });
          }}
        />
      )}

      {list.length === 0 && <PhoenixEmptyState icon="route" title={t('net_sr_empty', lang)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
        {list.map(r => (
          <RouteRow key={r.id} lang={lang} route={r} whById={whById} onChanged={(res) => {
            setStatus(res.ok
              ? { msg: t('net_sr_saved', lang), error: false }
              : { msg: networkErrorMessage(res.error, lang), error: true });
            if (res.ok) reload();
          }} />
        ))}
      </div>
    </div>
  );
}

function RouteRow({ lang, route, whById, onChanged }: {
  lang: Lang; route: SupplyRoute; whById: Map<string, NetworkWarehouse>;
  onChanged: (res: RpcResult) => void;
}) {
  const [editing, setEditing] = useState(false);
  const active = route.isActive;

  if (editing) {
    return (
      <SupplyRouteEditForm
        lang={lang} route={route}
        onCancel={() => setEditing(false)}
        onDone={(res) => { if (res.ok) setEditing(false); onChanged(res); }}
      />
    );
  }

  return (
    <PhoenixCard padding="12px 14px">
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 0, fontSize: '13px' }}>
          <span style={{ fontWeight: 700 }}>{nameOf(whById.get(route.sourceWarehouseId), lang)}</span>
          <span style={{ color: 'var(--t2)', margin: '0 6px' }}>→</span>
          <span style={{ fontWeight: 700 }}>{nameOf(whById.get(route.targetWarehouseId), lang)}</span>
          <span style={{ marginInlineStart: '8px' }}>
            <Badge text={route.priority === 1 ? t('net_sr_primary', lang) : `${t('net_sr_fallback', lang)} ${route.priority}`} tone={route.priority === 1 ? 'p' : 'muted'} />
            <Badge text={active ? t('net_wh_active', lang) : t('net_wh_inactive', lang)} tone={active ? 'ok' : 'muted'} />
          </span>
          {route.notes && <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }}>{route.notes}</div>}
        </div>
        <PhoenixButton size="sm" variant="ghost" onClick={() => setEditing(true)}>{t('net_wh_edit', lang)}</PhoenixButton>
        <RouteToggle lang={lang} routeId={route.id} active={active} onDone={onChanged} />
      </div>
    </PhoenixCard>
  );
}

function SupplyRouteEditForm({ lang, route, onCancel, onDone }: {
  lang: Lang; route: SupplyRoute; onCancel: () => void; onDone: (res: RpcResult) => void;
}) {
  const [priority, setPriority] = useState(String(route.priority));
  const [notes, setNotes] = useState(route.notes ?? '');
  const [busy, setBusy] = useState(false);
  const p = parseInt(priority, 10);
  const canSubmit = Number.isFinite(p) && p >= 1;

  return (
    <PhoenixCard padding="16px" style={{ borderColor: 'var(--p)' }}>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <PhoenixInput label={t('net_sr_priority', lang)} type="number" min={1} value={priority} onChange={e => setPriority(e.target.value)} />
        <PhoenixInput label={t('net_sr_notes', lang)} value={notes} onChange={e => setNotes(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <PhoenixButton loading={busy} disabled={!canSubmit} onClick={async () => {
          setBusy(true);
          const res = await updateSupplyRoute({ routeId: route.id, priority: p, notes: notes.trim() === '' ? '' : notes.trim() });
          setBusy(false); onDone(res);
        }}>{t('net_save', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={onCancel}>{t('net_cancel', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

function RouteToggle({ lang, routeId, active, onDone }: {
  lang: Lang; routeId: string; active: boolean; onDone: (res: RpcResult) => void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <PhoenixButton size="sm" variant={active ? 'warn' : 'primary'} loading={busy} onClick={async () => {
      setBusy(true); const res = await setSupplyRouteActive(routeId, !active); setBusy(false); onDone(res);
    }}>
      {active ? t('net_wh_deactivate', lang) : t('net_wh_activate', lang)}
    </PhoenixButton>
  );
}

function SupplyRouteForm({ lang, centrals, institutions, onCancel, onDone }: {
  lang: Lang; centrals: NetworkWarehouse[]; institutions: NetworkWarehouse[];
  onCancel: () => void; onDone: (res: RpcResult) => void;
}) {
  const [source, setSource] = useState(centrals[0]?.id ?? '');
  const [target, setTarget] = useState(institutions[0]?.id ?? '');
  const [priority, setPriority] = useState('1');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const p = parseInt(priority, 10);
  const canSubmit = source !== '' && target !== '' && Number.isFinite(p) && p >= 1;

  return (
    <PhoenixCard padding="16px" style={{ marginBottom: '10px', borderColor: 'var(--p)' }}>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <PhoenixSelect label={t('net_sr_source', lang)} value={source} onChange={e => setSource(e.target.value)}
          options={centrals.map(w => ({ value: w.id, label: nameOf(w, lang) }))} />
        <PhoenixSelect label={t('net_sr_target', lang)} value={target} onChange={e => setTarget(e.target.value)}
          options={institutions.map(w => ({ value: w.id, label: nameOf(w, lang) }))} />
        <PhoenixInput label={t('net_sr_priority', lang)} type="number" min={1} value={priority} onChange={e => setPriority(e.target.value)} />
        <PhoenixInput label={t('net_sr_notes', lang)} value={notes} onChange={e => setNotes(e.target.value)} />
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <PhoenixButton loading={busy} disabled={!canSubmit} onClick={async () => {
          setBusy(true);
          const res = await createSupplyRoute({ sourceWarehouseId: source, targetWarehouseId: target, priority: p, notes: notes.trim() || null });
          setBusy(false); onDone(res);
        }}>{t('net_save', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={onCancel}>{t('net_cancel', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

// ─── Scope assignments panel (076) ───────────────────────────────────────────

function ScopeAssignmentsPanel({ lang, isSuper }: { lang: Lang; isSuper: boolean }) {
  const { orgs, orgId, setOrgId, options } = useOrgSelector(lang, false);
  const [reloadKey, setReloadKey] = useState(0);
  const profiles = useAsync(() => (orgId ? getProfilesByOrg(orgId) : Promise.resolve([])), [orgId, reloadKey]);
  const warehouses = useAsync(() => getAllWarehouses(), [reloadKey]);
  const outlets = useAsync(() => (orgId ? getPointsByOrg(orgId) : Promise.resolve([])), [orgId, reloadKey]);
  const assigns = useAsync(() => (orgId ? getScopeAssignments(orgId) : Promise.resolve([])), [orgId, reloadKey]);
  const [status, setStatus] = useState<{ msg: string; error: boolean } | null>(null);
  const [adding, setAdding] = useState(false);
  const reload = () => setReloadKey(k => k + 1);

  const orgWarehouses = (warehouses.data ?? []).filter(w => w.organizationId === orgId && w.status === 'active');
  const orgOutlets = (outlets.data ?? []).filter(o => o.status !== 'archived');
  const profileById = useMemo(() => new Map((profiles.data ?? []).map(p => [p.id, p])), [profiles.data]);
  const whById = useMemo(() => new Map(orgWarehouses.map(w => [w.id, w])), [orgWarehouses]);
  const outletById = useMemo(() => new Map(orgOutlets.map(o => [o.id, o])), [orgOutlets]);

  if (orgs.loading) return <PhoenixLoadingState />;
  if (orgs.error) return <PhoenixErrorState message={orgs.error} onRetry={reload} />;

  return (
    <div>
      <div style={{ display: 'flex', gap: '10px', flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: '12px' }}>
        <div style={{ minWidth: '220px', flex: 1 }}>
          <PhoenixSelect label={t('net_org_select', lang)} options={options} value={orgId} onChange={e => setOrgId(e.target.value)} />
        </div>
        <PhoenixButton onClick={() => setAdding(a => !a)} disabled={!orgId}>{t('net_sc_add', lang)}</PhoenixButton>
      </div>

      {status && <StatusLine msg={status.msg} error={status.error} />}
      {!orgId && <PhoenixEmptyState icon="institutions" title={t('net_select_org_first', lang)} />}

      {orgId && (profiles.loading || warehouses.loading || outlets.loading || assigns.loading) && <PhoenixLoadingState />}

      {orgId && adding && !profiles.loading && (
        <ScopeForm
          lang={lang}
          profiles={(profiles.data ?? []).map(p => ({ id: p.id, label: p.full_name || t(roleLabelKey(p.role), lang) }))}
          warehouses={orgWarehouses.map(w => ({ id: w.id, label: nameOf(w, lang) }))}
          outlets={orgOutlets.map(o => ({ id: o.id, label: nameOf(o, lang) }))}
          onCancel={() => setAdding(false)}
          onDone={(res) => {
            if (res.ok) { setStatus({ msg: t('net_sc_saved', lang), error: false }); setAdding(false); reload(); }
            else setStatus({ msg: networkErrorMessage(res.error, lang), error: true });
          }}
        />
      )}

      {orgId && !assigns.loading && (assigns.data ?? []).length === 0 && <PhoenixEmptyState icon="route" title={t('net_sc_empty', lang)} />}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', marginTop: '10px' }}>
        {orgId && (assigns.data ?? []).map(a => {
          const who = profileById.get(a.profileId);
          const targetLabel = a.scopeType === 'warehouse'
            ? nameOf(whById.get(a.warehouseId ?? ''), lang)
            : nameOf(outletById.get(a.distributionPointId ?? ''), lang);
          return (
            <PhoenixCard key={a.id} padding="12px 14px">
              <div style={{ display: 'flex', alignItems: 'center', gap: '10px', flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0, fontSize: '13px' }}>
                  <span style={{ fontWeight: 700 }}>{who ? who.full_name : '—'}</span>
                  {who && <span style={{ color: 'var(--t2)', fontSize: '11px', marginInlineStart: '6px' }}>{t(roleLabelKey(who.role), lang)}</span>}
                  <div style={{ fontSize: '12px', color: 'var(--t2)', marginTop: '2px' }}>
                    <Badge text={a.scopeType === 'warehouse' ? t('net_sc_warehouse', lang) : t('net_sc_outlet', lang)} tone="muted" />
                    {targetLabel}
                  </div>
                </div>
                <RevokeControl lang={lang} assignmentId={a.id} onDone={(res) => {
                  setStatus(res.ok ? { msg: t('net_sc_revoked', lang), error: false } : { msg: networkErrorMessage(res.error, lang), error: true });
                  if (res.ok) reload();
                }} />
              </div>
            </PhoenixCard>
          );
        })}
      </div>
      {!isSuper && (
        <p style={{ fontSize: '10.5px', color: 'var(--t2)', marginTop: '14px' }}>
          {t('net_err_cross_org', lang)}
        </p>
      )}
    </div>
  );
}

function RevokeControl({ lang, assignmentId, onDone }: {
  lang: Lang; assignmentId: string; onDone: (res: RpcResult) => void;
}) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  if (!open) return <PhoenixButton size="sm" variant="danger" onClick={() => setOpen(true)}>{t('net_sc_revoke', lang)}</PhoenixButton>;
  return (
    <div style={{ display: 'flex', gap: '6px', alignItems: 'center', flexWrap: 'wrap' }}>
      <PhoenixInput placeholder={t('net_sc_revoke_reason', lang)} value={reason} onChange={e => setReason(e.target.value)} style={{ minWidth: '160px' }} />
      <PhoenixButton size="sm" variant="danger" loading={busy} disabled={reason.trim() === ''} onClick={async () => {
        setBusy(true); const res = await revokeProfileScope(assignmentId, reason.trim()); setBusy(false);
        if (res.ok) { setOpen(false); setReason(''); }
        onDone(res);
      }}>{t('net_sc_revoke', lang)}</PhoenixButton>
      <PhoenixButton size="sm" variant="ghost" onClick={() => setOpen(false)}>{t('net_cancel', lang)}</PhoenixButton>
    </div>
  );
}

function ScopeForm({ lang, profiles, warehouses, outlets, onCancel, onDone }: {
  lang: Lang;
  profiles: { id: string; label: string }[];
  warehouses: { id: string; label: string }[];
  outlets: { id: string; label: string }[];
  onCancel: () => void; onDone: (res: RpcResult) => void;
}) {
  const [profileId, setProfileId] = useState(profiles[0]?.id ?? '');
  const [scopeType, setScopeType] = useState<ScopeKind>('warehouse');
  const targets = scopeType === 'warehouse' ? warehouses : outlets;
  const [targetId, setTargetId] = useState('');
  const [busy, setBusy] = useState(false);
  const effTarget = targetId || (targets[0]?.id ?? '');
  const canSubmit = profileId !== '' && effTarget !== '';

  return (
    <PhoenixCard padding="16px" style={{ marginBottom: '10px', borderColor: 'var(--p)' }}>
      <div style={{ display: 'grid', gap: '10px', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))' }}>
        <PhoenixSelect label={t('net_sc_user', lang)} value={profileId} onChange={e => setProfileId(e.target.value)}
          options={profiles.map(p => ({ value: p.id, label: p.label }))} />
        <PhoenixSelect label={t('net_sc_scope_type', lang)} value={scopeType}
          onChange={e => { setScopeType(e.target.value as ScopeKind); setTargetId(''); }}
          options={[
            { value: 'warehouse', label: t('net_sc_warehouse', lang) },
            { value: 'distribution_point', label: t('net_sc_outlet', lang) },
          ]} />
        <PhoenixSelect label={t('net_sc_target', lang)} value={effTarget} onChange={e => setTargetId(e.target.value)}
          options={targets.map(x => ({ value: x.id, label: x.label }))} />
      </div>
      <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
        <PhoenixButton loading={busy} disabled={!canSubmit} onClick={async () => {
          setBusy(true);
          const res = await assignProfileScope({ profileId, scopeType, targetId: effTarget });
          setBusy(false); onDone(res);
        }}>{t('net_sc_assign', lang)}</PhoenixButton>
        <PhoenixButton variant="ghost" onClick={onCancel}>{t('net_cancel', lang)}</PhoenixButton>
      </div>
    </PhoenixCard>
  );
}

// ─── tiny badge ──────────────────────────────────────────────────────────────

function Badge({ text, tone }: { text: string; tone: 'p' | 'ok' | 'muted' }) {
  const bg = tone === 'p' ? 'var(--p2)' : tone === 'ok' ? 'var(--ok2, #ecfdf5)' : 'var(--s2, #f1f5f9)';
  const fg = tone === 'p' ? 'var(--pd)' : tone === 'ok' ? 'var(--ok, #047857)' : 'var(--t2)';
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 'var(--rpill)', fontSize: '10px',
      fontWeight: 700, background: bg, color: fg, marginInlineEnd: '5px',
    }}>{text}</span>
  );
}
