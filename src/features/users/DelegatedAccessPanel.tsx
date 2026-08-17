import { useEffect, useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { normalizeRole } from '@/shared/lib/roles';
import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';
import {
  getPointsByOrg, getWarehouses, type DistributionPoint, type Warehouse,
} from '@/shared/supabase/services/warehouses.service';
import {
  DELEGATED_RECIPIENT_ROLES, grantDelegatedNetworkSnapshot, grantDelegatedScope,
  listDelegatedScopes, revokeDelegatedScope, type DelegatedScopeRow,
  type DelegatedScopeType,
} from '@/shared/supabase/services/delegated-access.service';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';

const fieldStyle = {
  width: '100%', padding: '8px 10px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)',
  fontSize: '12px',
} as const;

interface Props {
  actorRole: string | null | undefined;
  target: { id: string; role: string; status: string; organization_id: string | null };
  lang: 'ar' | 'en';
  onToast: (message: string) => void;
}

const label = (lang: 'ar' | 'en', en: string | null, ar: string | null) =>
  (lang === 'ar' ? ar || en : en || ar) ?? '—';

export function DelegatedAccessPanel({ actorRole, target, lang, onToast }: Props) {
  const eligible = DELEGATED_RECIPIENT_ROLES.includes(normalizeRole(target.role) as never);
  const canGrant = eligible && target.status === 'active';
  const [rows, setRows] = useState<DelegatedScopeRow[]>([]);
  const [orgs, setOrgs] = useState<OrgRow[]>([]);
  const [warehouses, setWarehouses] = useState<Warehouse[]>([]);
  const [points, setPoints] = useState<DistributionPoint[]>([]);
  const [scopeType, setScopeType] = useState<DelegatedScopeType>('organization');
  const [orgId, setOrgId] = useState('');
  const [warehouseId, setWarehouseId] = useState('');
  const [pointId, setPointId] = useState('');
  const [includeChildren, setIncludeChildren] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [revokeTarget, setRevokeTarget] = useState<DelegatedScopeRow | null>(null);
  const [revokeReason, setRevokeReason] = useState('');

  const reload = async () => setRows(await listDelegatedScopes(target.id, true));

  useEffect(() => {
    if (normalizeRole(actorRole) !== 'super_admin') return;
    void Promise.all([
      reload(),
      canGrant ? getOrganizations().then(setOrgs) : Promise.resolve(),
    ]).catch(() => {
      setError(t('um_delegated_load_failed', lang));
    });
  }, [actorRole, canGrant, target.id, lang]);

  useEffect(() => {
    setWarehouseId(''); setPointId(''); setIncludeChildren(false);
    if (!orgId) { setWarehouses([]); setPoints([]); return; }
    void Promise.all([getWarehouses(orgId), getPointsByOrg(orgId)]).then(([w, p]) => {
      setWarehouses(w.filter(x => x.status === 'active'));
      setPoints(p.filter(x => x.status === 'active'));
    }).catch(() => setError(t('um_delegated_load_failed', lang)));
  }, [orgId]);

  const activeOrgs = useMemo(() => orgs.filter(o =>
    o.status === 'active' && o.id !== target.organization_id), [orgs, target.organization_id]);
  if (normalizeRole(actorRole) !== 'super_admin') return null;

  const submit = async () => {
    if (!orgId || (scopeType === 'warehouse' && !warehouseId)
      || (scopeType === 'distribution_point' && !pointId)) return;
    setBusy(true); setError('');
    try {
      await grantDelegatedScope({
        profileId: target.id, targetOrganizationId: orgId, scopeType,
        warehouseId: scopeType === 'warehouse' ? warehouseId : null,
        distributionPointId: scopeType === 'distribution_point' ? pointId : null,
        includeChildOutlets: scopeType === 'warehouse' && includeChildren,
      });
      await reload(); onToast(t('um_delegated_granted', lang));
    } catch { setError(t('um_delegated_grant_failed', lang)); }
    finally { setBusy(false); }
  };

  const snapshot = async () => {
    setBusy(true); setError('');
    try {
      const count = await grantDelegatedNetworkSnapshot(target.id);
      await reload(); onToast(`${t('um_delegated_snapshot_done', lang)} (${count})`);
    } catch { setError(t('um_delegated_grant_failed', lang)); }
    finally { setBusy(false); }
  };

  const revoke = async () => {
    if (!revokeTarget || !revokeReason.trim()) return;
    setBusy(true); setError('');
    try {
      await revokeDelegatedScope({ assignmentId: revokeTarget.assignmentId, reason: revokeReason });
      setRevokeTarget(null); setRevokeReason(''); await reload();
      onToast(t('um_delegated_revoked', lang));
    } catch { setError(t('um_delegated_revoke_failed', lang)); }
    finally { setBusy(false); }
  };

  return (
    <PhoenixCard className="nexus-ua-perm-card">
      <div style={{ display: 'grid', gap: 12 }} data-testid="delegated-access-panel">
        <div>
          <strong>{t('um_delegated_title', lang)}</strong>
          <div style={{ color: 'var(--warn)', fontSize: 12, marginTop: 4 }}>
            {t('um_delegated_scope_not_permission', lang)}
          </div>
        </div>

        {canGrant && <div style={{ display: 'grid', gap: 8 }}>
          <select aria-label={t('um_delegated_scope_type', lang)} style={fieldStyle}
            value={scopeType} onChange={e => {
              setScopeType(e.target.value as DelegatedScopeType);
              setWarehouseId(''); setPointId(''); setIncludeChildren(false);
            }}>
            <option value="organization">{t('um_delegated_org_scope', lang)}</option>
            <option value="warehouse">{t('um_delegated_warehouse_scope', lang)}</option>
            <option value="distribution_point">{t('um_delegated_point_scope', lang)}</option>
          </select>
          <select aria-label={t('um_organization', lang)} style={fieldStyle} value={orgId}
            onChange={e => setOrgId(e.target.value)}>
            <option value="">{t('um_organization', lang)}</option>
            {activeOrgs.map(o => <option key={o.id} value={o.id}>{label(lang, o.name, o.name_ar)}</option>)}
          </select>
          {scopeType === 'warehouse' && (
            <select aria-label={t('um_delegated_warehouse_scope', lang)} style={fieldStyle}
              value={warehouseId} onChange={e => setWarehouseId(e.target.value)}>
              <option value="">{t('um_delegated_select_warehouse', lang)}</option>
              {warehouses.map(w => <option key={w.id} value={w.id}>
                {label(lang, orgs.find(o => o.id === w.organizationId)?.name ?? null,
                  orgs.find(o => o.id === w.organizationId)?.name_ar ?? null)} — {label(lang,w.name,w.name_ar)}
              </option>)}
            </select>
          )}
          {scopeType === 'distribution_point' && (
            <select aria-label={t('um_delegated_point_scope', lang)} style={fieldStyle}
              value={pointId} onChange={e => setPointId(e.target.value)}>
              <option value="">{t('um_delegated_select_point', lang)}</option>
              {points.map(p => {
                const w=warehouses.find(x => x.id === p.warehouseId);
                return <option key={p.id} value={p.id}>
                  {label(lang,orgs.find(o=>o.id===p.organizationId)?.name ?? null,
                    orgs.find(o=>o.id===p.organizationId)?.name_ar ?? null)} — {label(lang,w?.name ?? null,w?.name_ar ?? null)} — {label(lang,p.name,p.name_ar)}
                </option>;
              })}
            </select>
          )}
          {scopeType === 'warehouse' && (
            <label style={{ fontSize: 12 }}>
              <input type="checkbox" checked={includeChildren}
                onChange={e => setIncludeChildren(e.target.checked)} />{' '}
              {t('um_delegated_include_children', lang)}
            </label>
          )}
          <PhoenixButton variant="primary" size="md" loading={busy} onClick={submit}>
            {t('um_delegated_add', lang)}
          </PhoenixButton>
        </div>}

        {canGrant && <div style={{ borderTop: '1px solid var(--brd)', paddingTop: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--t2)', marginBottom: 7 }}>
            {t('um_delegated_snapshot_warning', lang)}
          </div>
          <PhoenixButton variant="ghost" size="md" loading={busy} onClick={snapshot}>
            {t('um_delegated_network_snapshot', lang)}
          </PhoenixButton>
        </div>}

        <div style={{ display: 'grid', gap: 7 }}>
          <strong style={{ fontSize: 12 }}>{t('um_delegated_history', lang)}</strong>
          {rows.length === 0 && <span style={{ color: 'var(--t2)', fontSize: 12 }}>{t('um_delegated_none', lang)}</span>}
          {rows.map(row => <div key={row.assignmentId} style={{ border: '1px solid var(--brd)', borderRadius: 8, padding: 8, fontSize: 12 }}>
            <div>{label(lang,row.organizationName,row.organizationNameAr)} — {
              row.scopeType === 'warehouse' ? label(lang,row.warehouseName,row.warehouseNameAr)
                : row.scopeType === 'distribution_point' ? `${label(lang,row.parentWarehouseName,row.parentWarehouseNameAr)} — ${label(lang,row.distributionPointName,row.distributionPointNameAr)}`
                  : t('um_delegated_org_scope',lang)
            }</div>
            <div style={{ color: 'var(--t2)', marginTop: 3 }}>
              {row.grantOrigin} · {row.isActive ? t('active',lang) : t('inactive',lang)}
              {row.includeChildOutlets ? ` · ${t('um_delegated_include_children',lang)}` : ''}
            </div>
            {!row.isActive && row.revokeReason && <div>{row.revokeReason}</div>}
            {row.isActive && <PhoenixButton variant="danger" size="sm" onClick={() => setRevokeTarget(row)}>
              {t('um_delegated_revoke',lang)}
            </PhoenixButton>}
          </div>)}
        </div>

        {revokeTarget && <div style={{ display: 'grid', gap: 7 }}>
          <input style={fieldStyle} value={revokeReason} onChange={e => setRevokeReason(e.target.value)}
            placeholder={t('um_delegated_revoke_reason',lang)} />
          <div style={{ display: 'flex', gap: 6 }}>
            <PhoenixButton variant="ghost" size="sm" onClick={() => { setRevokeTarget(null); setRevokeReason(''); }}>
              {t('cancel',lang)}
            </PhoenixButton>
            <PhoenixButton variant="danger" size="sm" loading={busy} disabled={!revokeReason.trim()} onClick={revoke}>
              {t('um_delegated_revoke',lang)}
            </PhoenixButton>
          </div>
        </div>}
        {error && <div role="alert" style={{ color: 'var(--err)', fontSize: 12 }}>{error}</div>}
      </div>
    </PhoenixCard>
  );
}
