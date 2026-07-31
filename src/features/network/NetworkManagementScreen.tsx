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
  getSupplyRoutes,
  getScopeAssignments, assignProfileScope, revokeProfileScope,
  type NetworkWarehouse, type WarehouseKind, type ScopeKind, type RpcResult,
} from './network.service';
import { NetworkTopologyStage, type NodeAlert } from './NetworkTopologyStage';
import { DirectSupplyOperations } from './DirectSupplyOperations';
import { getInventoryAlerts } from '@/features/inventory/inventory-intelligence.service';
import type { SuggestionDocumentTarget } from '@/features/inventory/suggestion-document-navigation';

const ALERT_SEVERITY_RANK = { high: 0, medium: 1, low: 2 } as const;

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

// W077: the manual "supply routes" tab is retired from the product. Central
// officers supply institutions DIRECTLY (route-free). Warehouses + scope tabs
// are unchanged. warehouse_supply_routes remains only as legacy compatibility.
type Tab = 'warehouses' | 'supply' | 'scopes';

export function NetworkManagementScreen({
  initialSuggestionDocument,
}: {
  initialSuggestionDocument?: SuggestionDocumentTarget;
} = {}) {
  const { lang, dir, role, myPermissions } = useApp();
  const isSuper = role === 'super_admin';
  const canEditScope = isSuper || myPermissions.has('users.edit_scope');
  // Convenience gate only — the RPC re-checks source-warehouse scope server-side.
  const canSupply = isSuper || myPermissions.has('warehouse_transfer.send');

  const tabs = useMemo(() => {
    const list: { id: Tab; labelKey: string }[] = [];
    if (isSuper) list.push({ id: 'warehouses', labelKey: 'net_tab_warehouses' });
    if (canSupply) list.push({ id: 'supply', labelKey: 'net_tab_supply' });
    if (canEditScope) list.push({ id: 'scopes', labelKey: 'net_tab_scopes' });
    return list;
  }, [isSuper, canSupply, canEditScope]);

  const opensTransferRequest =
    initialSuggestionDocument?.documentKind === 'warehouse_transfer_request';
  const [tab, setTab] = useState<Tab>(() =>
    opensTransferRequest && canSupply ? 'supply' : isSuper ? 'warehouses' : canSupply ? 'supply' : 'scopes',
  );

  if (tabs.length === 0) {
    return (
      <PhoenixEmptyState icon="lock" title={t('net_denied', lang)} />
    );
  }

  const activeTab = tabs.some(x => x.id === tab) ? tab : tabs[0].id;

  return (
    <div dir={dir} className="nexus-inventory-transfers nexus-inventory-transfers--network">
      <div role="tablist" style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginBottom: '16px' }}>
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
      {activeTab === 'supply' && canSupply && (
        <DirectSupplyOperations
          lang={lang}
          initialTransferRequestId={
            opensTransferRequest ? initialSuggestionDocument.documentId : undefined
          }
        />
      )}
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
  const inventoryAlerts = useAsync(
    () => orgId ? getInventoryAlerts(orgId) : Promise.resolve([]),
    [orgId, reloadKey],
  );
  const outlets = useAsync(
    () => orgId ? getPointsByOrg(orgId) : Promise.resolve([]),
    [orgId, reloadKey],
  );
  const [status, setStatus] = useState<{ msg: string; error: boolean } | null>(null);
  const [adding, setAdding] = useState(false);

  // Aggregate real RLS-scoped inventory alerts by node (warehouse/outlet) id.
  // Highest severity wins for the node's badge; count is the node's open total.
  const nodeAlerts = useMemo(() => {
    const map = new Map<string, NodeAlert>();
    for (const alert of inventoryAlerts.data ?? []) {
      const prev = map.get(alert.scopeId);
      if (!prev) {
        map.set(alert.scopeId, { severity: alert.severity, count: 1, topSignal: alert.signalType });
      } else {
        const escalates = ALERT_SEVERITY_RANK[alert.severity] < ALERT_SEVERITY_RANK[prev.severity];
        map.set(alert.scopeId, {
          severity: escalates ? alert.severity : prev.severity,
          count: prev.count + 1,
          topSignal: escalates ? alert.signalType : prev.topSignal,
        });
      }
    }
    return map;
  }, [inventoryAlerts.data]);

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
          alerts={nodeAlerts}
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

// The full operational direct-supply surface (forward + return lifecycle) lives
// in DirectSupplyOperations.tsx and is rendered by the 'supply' tab above. The
// legacy "supply routes" tab stays retired; warehouse_supply_routes is never
// shown or consulted here.

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

      {orgId && !assigns.loading && (assigns.data ?? []).length === 0 && <PhoenixEmptyState icon="scope" title={t('net_sc_empty', lang)} />}

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
