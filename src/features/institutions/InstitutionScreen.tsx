import { useState, useEffect } from 'react';
import QRCode from 'qrcode';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { formatStableDate } from '@/shared/lib/date';
import { canManageOrg, canAssignRole, ASSIGNABLE_ROLES_BY_ACTOR } from '@/shared/lib/types';
import type { Role } from '@/shared/lib/types';
import { roleLabelKey } from '@/shared/lib/roles';
import {
  getOrganizations,
  getOrganization,
  createOrganization,
  updateOrganization,
  getProfilesByOrg,
  updateProfileRole,
  type OrgRow,
  type OrgProfileRow,
} from '@/shared/supabase/services/organizations.service';
import {
  getPointsByOrg,
  createDistributionPoint,
  updateDistributionPoint,
  type DistributionPoint,
  type PointType,
} from '@/shared/supabase/services/warehouses.service';
import {
  createQrForTarget,
  disableQrToken,
  getQrForPoint,
  regenerateQrForPoint,
} from '@/shared/supabase/services/qr.service';
import {
  archiveEntity,
  getEntityPurgeImpact,
  getOrgDeleteImpact,
  clearPortAvailability,
  classifyClearPortItemsError,
  archiveOrganization,
} from '@/shared/supabase/services/lifecycle.service';
import {
  getAvailabilityByPoint,
  upsertAvailability,
  applyAvailabilityMovement,
  classifyAvailabilityMovementError,
  classifyAvailabilitySaveError,
} from '@/shared/supabase/services/availability.service';
import { getLocalItems } from '@/shared/supabase/services/registry.service';
import type { AvailabilityCondition } from '@/shared/lib/types';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixDialog } from '@/shared/ui/PhoenixDialog';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';

// Display legacy DB roles with the official role labels (no old labels in UI).
const ROLE_LABEL_KEY: Record<Role, string> = {
  super_admin: roleLabelKey('super_admin'),
  hospital_admin: roleLabelKey('hospital_admin'),
  warehouse_manager: roleLabelKey('warehouse_manager'),
  point_operator: roleLabelKey('point_operator'),
  viewer: roleLabelKey('viewer'),
};

const STATUS_VARIANT: Record<string, 'ok' | 'warn' | 'err' | 'neutral'> = {
  active: 'ok', inactive: 'neutral', suspended: 'warn', archived: 'neutral',
};

function statusLabel(status: string, lang: 'ar' | 'en'): string {
  if (status === 'active') return t('active', lang);
  if (status === 'inactive') return t('inactive', lang);
  if (status === 'suspended') return t('suspended', lang);
  if (status === 'archived') return t('archived', lang);
  return status;
}

/**
 * BUGFIX-OUTLET-MATERIAL-AND-OUTLET-DELETE-A: map archive_entity's
 * { ok: false, error } codes (migration 003) to an honest, translated
 * message instead of a raw code or a false "success" toast.
 */
function archiveErrorKey(error: string | undefined): string {
  if (error === 'INSUFFICIENT_ROLE') return 'port_archive_forbidden';
  if (error === 'NOT_FOUND_OR_ALREADY_ARCHIVED') return 'port_already_archived';
  return 'load_error';
}

function orgDisplayName(org: OrgRow, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return org.name_ar || org.name;
  return org.name || org.name_ar;
}

const fieldStyle = {
  width: '100%', padding: '10px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '13px',
} as const;

export function InstitutionScreen() {
  const { lang, role, activeOrgId, profile, myPermissions, reloadMyPermissions } = useApp();
  useEffect(() => { if (myPermissions.size === 0) reloadMyPermissions(); }, []);
  const isMobile = window.innerWidth < 768;
  const isSuper = role === 'super_admin';

  const [selectedOrgId, setSelectedOrgId] = useState<string | null>(null);
  const [view, setView] = useState<'list' | 'detail' | 'add'>('list');
  const [toast, setToast] = useState<string | null>(null);

  const effectiveOrgId = isSuper ? selectedOrgId : (activeOrgId ?? profile?.organization_id ?? null);

  const orgs = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);

  function showToast(msg: string) {
    setToast(msg);
    setTimeout(() => setToast(null), 3000);
  }

  function onSelectOrg(id: string) {
    setSelectedOrgId(id);
    setView('detail');
  }

  function onBack() {
    setSelectedOrgId(null);
    setView('list');
    orgs.reload();
  }

  return (
    <div className="premium-page premium-institutions-page" style={{ animation: 'fs .3s ease' }}>
      <div className="premium-page-header" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '22px' }}>
        <div>
          <div className="premium-command-kicker">MediStock-Babil</div>
          <h2 className="premium-section-header" style={{ fontSize: isMobile ? '20px' : '25px', fontWeight: 700, letterSpacing: '-.3px' }}>
            {t('nav_institutions', lang)}
          </h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>
            {t('inst_sub', lang)}
          </p>
        </div>
        {view !== 'list' && (
          <PhoenixButton variant="ghost" size="sm" onClick={onBack}>
            {t('inst_back', lang)}
          </PhoenixButton>
        )}
      </div>

      {/* Super admin: org list */}
      {isSuper && view === 'list' && (
        <OrgListView
          lang={lang}
          isMobile={isMobile}
          orgs={orgs}
          onSelect={onSelectOrg}
          onAdd={() => setView('add')}
        />
      )}

      {/* Super admin: add org form */}
      {isSuper && view === 'add' && (
        <AddOrgForm
          lang={lang}
          onCreated={() => { onBack(); showToast(t('inst_created', lang)); }}
          onCancel={onBack}
        />
      )}

      {/* Detail view: super_admin selected org or hospital_admin own org */}
      {view === 'detail' && effectiveOrgId && (
        <OrgDetailView
          lang={lang}
          isMobile={isMobile}
          orgId={effectiveOrgId}
          actorRole={role}
          actorPermissions={myPermissions}
          onToast={showToast}
        />
      )}

      {/* Non-super: show own org directly */}
      {!isSuper && view === 'list' && effectiveOrgId && (
        <OrgDetailView
          lang={lang}
          isMobile={isMobile}
          orgId={effectiveOrgId}
          actorRole={role}
          actorPermissions={myPermissions}
          onToast={showToast}
        />
      )}

      {!isSuper && view === 'list' && !effectiveOrgId && (
        <PhoenixEmptyState icon="🏥" title={t('no_org_scope', lang)} description={t('empty_hint', lang)} />
      )}

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

/* ── Org List (super_admin only) ── */

function OrgListView({ lang, isMobile, orgs, onSelect, onAdd }: {
  lang: 'ar' | 'en';
  isMobile: boolean;
  orgs: { data: OrgRow[] | null; loading: boolean; error: string | null; reload: () => void };
  onSelect: (id: string) => void;
  onAdd: () => void;
}) {
  const [search, setSearch] = useState('');

  const rows = orgs.data ?? [];
  const filtered = rows.filter(o => {
    if (!search) return true;
    const q = search.toLowerCase();
    return o.name.toLowerCase().includes(q) ||
           o.name_ar.includes(search) ||
           o.code.toLowerCase().includes(q) ||
           o.city.toLowerCase().includes(q);
  });

  return (
    <>
      <div className="premium-org-toolbar" style={{ display: 'flex', gap: '10px', marginBottom: '18px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
          <span style={{ position: 'absolute', insetInlineStart: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '15px', pointerEvents: 'none' }}>🔍</span>
          <input
            type="search"
            placeholder={t('search', lang)}
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="premium-field"
            style={{ ...fieldStyle, paddingInlineStart: '38px' }}
            aria-label={t('search', lang)}
          />
        </div>
        <PhoenixButton variant="primary" size="md" onClick={onAdd}>
          + {t('inst_add', lang)}
        </PhoenixButton>
      </div>

      {orgs.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!orgs.loading && orgs.error && <PhoenixErrorState title={t('load_error', lang)} message={orgs.error} onRetry={orgs.reload} />}
      {!orgs.loading && !orgs.error && filtered.length === 0 && (
        <PhoenixEmptyState icon="🏥" title={t('empty_orgs', lang)} description={t('empty_hint', lang)} />
      )}

      {!orgs.loading && !orgs.error && filtered.length > 0 && (
        <div className="premium-org-grid" style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: '12px' }}>
          {filtered.map(org => (
            <PhoenixCard className="premium-org-card" key={org.id} hover padding="16px" onClick={() => onSelect(org.id)}>
              <div className="premium-org-card__head">
                <div className="premium-org-card__icon" aria-hidden="true">🏥</div>
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px' }}>
                    <span style={{ fontSize: '14px', fontWeight: 750, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {orgDisplayName(org, lang)}
                    </span>
                    <PhoenixStatusBadge variant={STATUS_VARIANT[org.status] ?? 'neutral'} label={statusLabel(org.status, lang)} />
                  </div>
                  {lang === 'ar' && org.name && <div dir="ltr" style={{ color: 'var(--t2)', fontSize: '10.5px', marginTop: '3px' }}>{org.name}</div>}
                  {lang === 'en' && org.name_ar && <div dir="rtl" style={{ color: 'var(--t2)', fontSize: '10.5px', marginTop: '3px' }}>{org.name_ar}</div>}
                </div>
              </div>
              <div className="premium-org-card__meta">
                <div className="premium-org-card__meta-item">
                  <span className="premium-org-card__meta-label">{t('inst_code', lang)}</span>
                  <span className="premium-org-card__meta-value" dir="ltr" style={{ fontFamily: 'monospace' }}>{org.code}</span>
                </div>
                <div className="premium-org-card__meta-item">
                  <span className="premium-org-card__meta-label">{t('inst_city', lang)}</span>
                  <span className="premium-org-card__meta-value" dir="auto">{org.city || '—'}</span>
                </div>
              </div>
            </PhoenixCard>
          ))}
        </div>
      )}
    </>
  );
}

/* ── Add Org Form (super_admin only) ── */

function AddOrgForm({ lang, onCreated, onCancel }: {
  lang: 'ar' | 'en';
  onCreated: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState('');
  const [nameAr, setNameAr] = useState('');
  const [code, setCode] = useState('');
  const [city, setCity] = useState('');
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = name.trim() && nameAr.trim() && code.trim();

  async function onSubmit() {
    if (!canSubmit) { setError(t('inst_required', lang)); return; }
    setBusy(true);
    setError(null);
    try {
      await createOrganization({
        name: name.trim(), name_ar: nameAr.trim(), code: code.trim().toLowerCase(),
        city: city.trim() || undefined, contact_email: email.trim() || undefined,
      });
      onCreated();
    } catch (e) {
      // Developer-safe console log; user sees a friendly message only (mirrors useAsync).
      console.error('[phoenix] createOrganization failed:', e);
      setError(e instanceof Error ? e.message : t('load_error', lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixCard padding="20px" style={{ maxWidth: '560px' }}>
      <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '18px' }}>{t('inst_add', lang)}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_name_en', lang)} *</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} style={fieldStyle} dir="ltr" />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_name_ar', lang)} *</label>
          <input type="text" value={nameAr} onChange={e => setNameAr(e.target.value)} style={fieldStyle} dir="rtl" />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_code', lang)} *</label>
          <input type="text" value={code} onChange={e => setCode(e.target.value)} style={{ ...fieldStyle, fontFamily: 'monospace' }} dir="ltr" placeholder="babil-main" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_city', lang)}</label>
            <input type="text" value={city} onChange={e => setCity(e.target.value)} style={fieldStyle} dir="auto" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_email', lang)}</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={fieldStyle} dir="ltr" />
          </div>
        </div>
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <PhoenixButton variant="ghost" size="md" onClick={onCancel}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" loading={busy} disabled={!canSubmit} onClick={onSubmit}>
            {t('inst_save', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}

/* ── Org Detail + Users ── */

function OrgDetailView({ lang, isMobile, orgId, actorRole, actorPermissions, onToast }: {
  lang: 'ar' | 'en';
  isMobile: boolean;
  orgId: string;
  actorRole: Role;
  actorPermissions: Set<string>;
  onToast: (msg: string) => void;
}) {
  const isSuper = canManageOrg(actorRole);
  const canEditRoles = actorRole === 'super_admin' || actorRole === 'hospital_admin';
  const canViewPorts    = actorPermissions.has('ports.view');
  const canCreatePorts  = actorPermissions.has('ports.create');
  const canEditPorts    = actorPermissions.has('ports.edit');
  const canArchivePorts = actorPermissions.has('ports.archive');
  // BUGFIX-OUTLET-MATERIAL-DELETE-EDIT-A (permission-matrix fix): the
  // permission key alone (ports.archive) is not sufficient — archive_entity
  // (migration 003) hardcodes role IN ('super_admin', 'hospital_admin') and
  // will reject any other role (e.g. institution_admin) with
  // INSUFFICIENT_ROLE even if that role holds ports.archive. Mirrors the
  // exact same actorRole check already used two lines above for canEditRoles.
  const canArchivePortsEffective = canArchivePorts
    && (actorRole === 'super_admin' || actorRole === 'hospital_admin');
  // "Remove from outlet" writes through TWO existing RPCs in sequence
  // (phoenix_apply_availability_movement then phoenix_upsert_availability —
  // see onConfirmRemove in PortAvailabilitySection below), each independently
  // permission-checked server-side. ports.edit alone (e.g. port_officer) is
  // not sufficient — the button must only appear when every permission the
  // backend will actually check is present.
  const canRemoveOutletMaterial = canEditPorts
    && actorPermissions.has('availability.quantity.set')
    && (actorPermissions.has('availability.update') || actorPermissions.has('availability.create'));
  const canGenerateQr   = actorPermissions.has('qr.generate');
  const canRevokeQr     = actorPermissions.has('qr.revoke');

  const org = useAsync(() => getOrganization(orgId), [orgId]);
  const users = useAsync(() => getProfilesByOrg(orgId), [orgId]);
  const points = useAsync(() => getPointsByOrg(orgId), [orgId]);

  const [editing, setEditing] = useState(false);

  const o = org.data;
  const ptCount = points.data?.length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '16px' }}>
      {/* Org info card */}
      {org.loading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!org.loading && org.error && <PhoenixErrorState title={t('load_error', lang)} message={org.error} onRetry={org.reload} />}
      {!org.loading && !org.error && o && !editing && (
        <PhoenixCard padding="18px">
          <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '12px', flexWrap: 'wrap', marginBottom: '14px' }}>
            <div>
              <h3 style={{ fontSize: '16px', fontWeight: 700, marginBottom: '4px' }}>
                {orgDisplayName(o, lang)}
              </h3>
              {lang === 'ar' && o.name && (
                <div style={{ fontSize: '12px', color: 'var(--t2)' }} dir="ltr">{o.name}</div>
              )}
              {lang === 'en' && o.name_ar && (
                <div style={{ fontSize: '12px', color: 'var(--t2)' }} dir="rtl">{o.name_ar}</div>
              )}
            </div>
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <PhoenixStatusBadge variant={STATUS_VARIANT[o.status] ?? 'neutral'} label={statusLabel(o.status, lang)} />
              {isSuper && (
                <PhoenixButton variant="ghost" size="sm" onClick={() => setEditing(true)}>
                  {t('inst_edit', lang)}
                </PhoenixButton>
              )}
            </div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1fr 1fr', gap: '10px', fontSize: '12.5px' }}>
            <div>
              <span style={{ color: 'var(--t2)' }}>{t('inst_code', lang)}:</span>{' '}
              <span dir="ltr" style={{ fontFamily: 'monospace', fontWeight: 600 }}>{o.code}</span>
            </div>
            <div>
              <span style={{ color: 'var(--t2)' }}>{t('inst_city', lang)}:</span>{' '}
              <span dir="auto">{o.city || '—'}</span>
            </div>
            <div>
              <span style={{ color: 'var(--t2)' }}>{t('inst_email', lang)}:</span>{' '}
              <span dir="ltr">{o.contact_email || '—'}</span>
            </div>
          </div>

          {/* Summary counts */}
          <div style={{ display: 'flex', gap: '16px', marginTop: '14px', paddingTop: '14px', borderTop: '1px solid var(--brd)', fontSize: '12.5px' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '16px' }}>📍</span>
              <span><strong>{ptCount}</strong> {t('inst_points', lang)}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
              <span style={{ fontSize: '16px' }}>👥</span>
              <span><strong>{users.data?.length ?? 0}</strong> {t('inst_users', lang)}</span>
            </div>
          </div>
        </PhoenixCard>
      )}

      {/* Inline edit form (super_admin) */}
      {!org.loading && o && editing && (
        <EditOrgForm
          lang={lang}
          org={o}
          onSaved={() => {
            setEditing(false);
            org.reload();
            onToast(t('inst_updated', lang));
          }}
          onCancel={() => setEditing(false)}
        />
      )}

      {/* Users section */}
      <div>
        <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('inst_users', lang)}</h3>

        {/* Notice: user creation requires server-side */}
        <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '12px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
          ℹ️ {t('user_create_notice', lang)}
        </div>

        {users.loading && <PhoenixLoadingState label={t('loading', lang)} />}
        {!users.loading && users.error && <PhoenixErrorState title={t('load_error', lang)} message={users.error} onRetry={users.reload} />}
        {!users.loading && !users.error && (users.data ?? []).length === 0 && (
          <PhoenixEmptyState icon="👥" title={t('inst_no_users', lang)} description={t('empty_hint', lang)} />
        )}

        {!users.loading && !users.error && (users.data ?? []).length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {(users.data ?? []).map(u => (
              <UserRow
                key={u.id}
                user={u}
                lang={lang}
                actorRole={actorRole}
                canEditRoles={canEditRoles}
                onRoleChanged={() => { users.reload(); onToast(t('role_updated', lang)); }}
              />
            ))}
          </div>
        )}
      </div>

      {/* Ports section */}
      {canViewPorts ? (
        <PortSection
          lang={lang}
          isMobile={isMobile}
          orgId={orgId}
          canCreatePorts={canCreatePorts}
          canEditPorts={canEditPorts}
          canArchivePorts={canArchivePorts}
          canArchivePortsEffective={canArchivePortsEffective}
          canRemoveOutletMaterial={canRemoveOutletMaterial}
          canGenerateQr={canGenerateQr}
          canRevokeQr={canRevokeQr}
          orgName={o ? orgDisplayName(o, lang) : undefined}
          points={points.data ?? []}
          pointsLoading={points.loading}
          pointsError={points.error}
          onReload={() => { points.reload(); }}
          onToast={onToast}
        />
      ) : (
        <div style={{ fontSize: '12px', color: 'var(--t2)', padding: '12px', background: 'var(--s2)', borderRadius: 'var(--r2)' }}>
          {t('perm_no_view_ports', lang)}
        </div>
      )}

      {/* Organization cleanup wizard */}
      <OrgCleanupWizard
        orgId={orgId}
        lang={lang}
        actorRole={actorRole}
        onDone={() => { org.reload(); points.reload(); }}
        onToast={onToast}
      />
    </div>
  );
}

/* ── Edit Org Form ── */

function EditOrgForm({ lang, org, onSaved, onCancel }: {
  lang: 'ar' | 'en';
  org: OrgRow;
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState(org.name);
  const [nameAr, setNameAr] = useState(org.name_ar);
  const [city, setCity] = useState(org.city);
  const [email, setEmail] = useState(org.contact_email);
  const [status, setStatus] = useState(org.status);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit() {
    if (!name.trim() || !nameAr.trim()) { setError(t('inst_required', lang)); return; }
    setBusy(true);
    setError(null);
    try {
      await updateOrganization(org.id, {
        name: name.trim(), name_ar: nameAr.trim(),
        city: city.trim() || undefined, contact_email: email.trim() || undefined,
        status,
      });
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('load_error', lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixCard padding="20px">
      <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '18px' }}>{t('inst_edit', lang)}</h3>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_name_en', lang)} *</label>
          <input type="text" value={name} onChange={e => setName(e.target.value)} style={fieldStyle} dir="ltr" />
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_name_ar', lang)} *</label>
          <input type="text" value={nameAr} onChange={e => setNameAr(e.target.value)} style={fieldStyle} dir="rtl" />
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_city', lang)}</label>
            <input type="text" value={city} onChange={e => setCity(e.target.value)} style={fieldStyle} dir="auto" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('inst_email', lang)}</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={fieldStyle} dir="ltr" />
          </div>
        </div>
        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '6px' }}>{t('m_inst', lang)}</label>
          <select value={status} onChange={e => setStatus(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
            <option value="active">{t('active', lang)}</option>
            <option value="inactive">{t('inactive', lang)}</option>
            <option value="suspended">{t('suspended', lang)}</option>
          </select>
        </div>
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <PhoenixButton variant="ghost" size="md" onClick={onCancel}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" loading={busy} onClick={onSubmit}>
            {t('inst_save', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}

/* ── User Row with Role Editing ── */

function UserRow({ user, lang, actorRole, canEditRoles, onRoleChanged }: {
  user: OrgProfileRow;
  lang: 'ar' | 'en';
  actorRole: Role;
  canEditRoles: boolean;
  onRoleChanged: () => void;
}) {
  const [changing, setChanging] = useState(false);
  const [newRole, setNewRole] = useState<Role>(user.role);
  const [busy, setBusy] = useState(false);

  const assignable = ASSIGNABLE_ROLES_BY_ACTOR[actorRole] ?? [];
  const canChange = canEditRoles && canAssignRole(actorRole, user.role) && user.role !== 'super_admin';

  const [roleError, setRoleError] = useState<string | null>(null);

  async function onSaveRole() {
    if (!canAssignRole(actorRole, newRole)) return;
    setBusy(true);
    setRoleError(null);
    try {
      await updateProfileRole(user.id, newRole);
      setChanging(false);
      onRoleChanged();
    } catch (e) {
      const msg = e instanceof Error ? e.message : '';
      if (msg.includes('CANNOT_ESCALATE_TO_SUPER_ADMIN')) {
        setRoleError(t('role_no_escalate', lang));
      } else if (msg.includes('CANNOT_MODIFY_OTHER_ORG')) {
        setRoleError(t('load_error', lang));
      } else if (msg.includes('CANNOT_CHANGE_OWN_ROLE')) {
        setRoleError(t('role_no_escalate', lang));
      } else {
        setRoleError(t('load_error', lang));
      }
      console.error('[phoenix] role update failed:', e);
    } finally {
      setBusy(false);
    }
  }

  const roleVariant: Record<string, 'ok' | 'warn' | 'neutral'> = {
    super_admin: 'warn', hospital_admin: 'ok', warehouse_manager: 'ok',
    point_operator: 'neutral', viewer: 'neutral',
  };

  return (
    <PhoenixCard padding="12px 16px">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '10px', flexWrap: 'wrap' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {user.full_name}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--t2)', display: 'flex', alignItems: 'center', gap: '6px', marginTop: '2px' }}>
            <PhoenixStatusBadge variant={roleVariant[user.role] ?? 'neutral'} label={t(ROLE_LABEL_KEY[user.role], lang)} />
            <PhoenixStatusBadge variant={STATUS_VARIANT[user.status] ?? 'neutral'} label={statusLabel(user.status, lang)} />
          </div>
        </div>

        {canChange && !changing && (
          <PhoenixButton variant="ghost" size="sm" onClick={() => { setChanging(true); setNewRole(user.role); }}>
            {t('role_change', lang)}
          </PhoenixButton>
        )}

        {changing && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', alignItems: 'flex-end' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              <select
                value={newRole}
                onChange={e => { setNewRole(e.target.value as Role); setRoleError(null); }}
                style={{ padding: '6px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px' }}
              >
                {assignable
                  .filter(r => actorRole === 'super_admin' || r !== 'super_admin')
                  .map(r => (
                    <option key={r} value={r}>{t(ROLE_LABEL_KEY[r], lang)}</option>
                  ))}
              </select>
              <PhoenixButton variant="primary" size="sm" loading={busy} onClick={onSaveRole}>
                {t('inst_save', lang)}
              </PhoenixButton>
              <PhoenixButton variant="ghost" size="sm" onClick={() => { setChanging(false); setRoleError(null); }}>
                {t('cancel', lang)}
              </PhoenixButton>
            </div>
            {roleError && (
              <div style={{ fontSize: '11px', color: 'var(--err)', fontWeight: 600 }}>{roleError}</div>
            )}
          </div>
        )}
      </div>
    </PhoenixCard>
  );
}

/* ── Port / Distribution Point Section ── */

const POINT_TYPES: { value: PointType; labelKey: string }[] = [
  { value: 'dispensing', labelKey: 'port_type_dispensing' },
  { value: 'storage',   labelKey: 'port_type_storage' },
  { value: 'returns',   labelKey: 'port_type_returns' },
  { value: 'emergency', labelKey: 'port_type_emergency' },
];

function pointDisplayName(p: DistributionPoint, lang: 'ar' | 'en'): string {
  if (lang === 'ar') return p.name_ar || p.name;
  return p.name || p.name_ar;
}

const CONDITION_LABEL_KEY: Record<string, string> = {
  available: 'cond_available', low_stock: 'cond_low_stock', missing: 'cond_missing',
  surplus: 'cond_surplus', near_expiry: 'cond_near_expiry', expired: 'cond_expired',
};

const CONDITION_VARIANT: Record<string, 'ok' | 'warn' | 'err' | 'neutral'> = {
  available: 'ok', surplus: 'ok', low_stock: 'warn', near_expiry: 'warn', missing: 'err', expired: 'err',
};

const CONDITIONS: AvailabilityCondition[] = ['available', 'low_stock', 'surplus', 'near_expiry', 'missing', 'expired'];

function PortSection({ lang, isMobile, orgId, canCreatePorts, canEditPorts, canArchivePorts, canArchivePortsEffective, canRemoveOutletMaterial, canGenerateQr, canRevokeQr, orgName, points, pointsLoading, pointsError, onReload, onToast }: {
  lang: 'ar' | 'en';
  isMobile: boolean;
  orgId: string;
  canCreatePorts: boolean;
  canEditPorts: boolean;
  canArchivePorts: boolean;
  canArchivePortsEffective: boolean;
  canRemoveOutletMaterial: boolean;
  canGenerateQr: boolean;
  canRevokeQr: boolean;
  orgName?: string;
  points: DistributionPoint[];
  pointsLoading: boolean;
  pointsError: string | null;
  onReload: () => void;
  onToast: (msg: string) => void;
}) {
  const [showAdd, setShowAdd] = useState(false);

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '12px' }}>
        <h3 style={{ fontSize: '14px', fontWeight: 700 }}>{t('inst_points', lang)}</h3>
        {canCreatePorts && (
          <PhoenixButton variant="primary" size="sm" onClick={() => setShowAdd(true)}>
            + {t('port_add', lang)}
          </PhoenixButton>
        )}
      </div>

      {/* Safety notice */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '12px', fontSize: '11.5px', color: 'var(--info)', display: 'flex', flexDirection: 'column', gap: '4px' }}>
        <span>🔒 {t('port_revoke_safe', lang)}</span>
        <span>📋 {t('port_archive_warn', lang)}</span>
        <span>⚠ {t('port_archive_deps', lang)}</span>
      </div>

      {showAdd && (
        <AddPortForm
          lang={lang}
          orgId={orgId}
          canCreate={canCreatePorts}
          onCreated={() => { setShowAdd(false); onReload(); }}
          onCancel={() => setShowAdd(false)}
          onToast={onToast}
        />
      )}

      {pointsLoading && <PhoenixLoadingState label={t('loading', lang)} />}
      {!pointsLoading && pointsError && <PhoenixErrorState title={t('load_error', lang)} message={pointsError} onRetry={onReload} />}
      {!pointsLoading && !pointsError && points.length === 0 && !showAdd && (
        <PhoenixEmptyState icon="📍" title={t('empty_avail', lang)} description={t('empty_hint', lang)} />
      )}

      {!pointsLoading && !pointsError && points.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(min(100%, 320px), 1fr))', gap: '10px' }}>
          {points.map(pt => (
            <PortCard
              key={pt.id}
              point={pt}
              lang={lang}
              canEditPorts={canEditPorts}
              canArchivePorts={canArchivePorts}
              canArchivePortsEffective={canArchivePortsEffective}
              canRemoveOutletMaterial={canRemoveOutletMaterial}
              canGenerateQr={canGenerateQr}
              canRevokeQr={canRevokeQr}
              orgName={orgName}
              onReload={onReload}
              onToast={onToast}
            />
          ))}
        </div>
      )}
    </div>
  );
}

/* ── Add Port Form ── */

function AddPortForm({ lang, orgId, canCreate, onCreated, onCancel, onToast }: {
  lang: 'ar' | 'en';
  orgId: string;
  canCreate: boolean;
  onCreated: () => void;
  onCancel: () => void;
  onToast: (msg: string) => void;
}) {
  const [portName, setPortName] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = portName.trim().length > 0;

  async function onSubmit() {
    if (!canSubmit) return;
    if (!canCreate) { setError(t('perm_no_create_ports', lang)); return; }
    if (import.meta.env.DEV) {
      console.info('[phoenix] AddPortForm.submit:', {
        orgId, canCreate, portName: portName.trim(),
        payload: { organization_id: orgId, name: portName.trim(), name_ar: portName.trim(), point_type: 'dispensing' },
      });
    }
    setBusy(true);
    setError(null);
    try {
      // name and name_ar both use the same visible value; type defaults to 'dispensing'
      const pt = await createDistributionPoint({
        organizationId: orgId,
        name:      portName.trim(),
        name_ar:   portName.trim(),
        pointType: 'dispensing',
      });
      try {
        await createQrForTarget('distribution_point', pt.id, pt.name);
        onToast(t('port_created', lang) + ' + ' + t('qr_generated', lang));
      } catch {
        onToast(t('port_created', lang) + ' — ' + t('qr_gen_failed', lang));
      }
      onCreated();
    } catch (e) {
      const msg = (e instanceof Error ? e.message : '') ||
                  ((e as { message?: string })?.message ?? '');
      console.error('[phoenix] port create failed:', e);
      // At this point canCreate = true (the !canCreate guard returns early above),
      // so a DB failure is not a permission gap — show migration-pending or generic.
      if (msg.includes('warehouse_id') || msg.includes('not-null') || msg.includes('null value')) {
        setError(t('port_create_021_pending', lang));
      } else {
        setError(t('port_create_error', lang));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixCard padding="18px" style={{ marginBottom: '14px' }}>
      <h4 style={{ fontSize: '13px', fontWeight: 700, marginBottom: '14px' }}>{t('port_add', lang)}</h4>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>
            {t('port_name', lang)} *
          </label>
          <input
            type="text"
            value={portName}
            onChange={e => setPortName(e.target.value)}
            style={fieldStyle}
            dir="auto"
            autoFocus
          />
        </div>
        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }}>{error}</p>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <PhoenixButton variant="ghost" size="sm" onClick={onCancel}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="sm" loading={busy} disabled={!canSubmit} onClick={onSubmit}>
            {t('inst_save', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}

/* ── Port Card with QR Actions ── */

function PortCard({ point, lang, canEditPorts, canArchivePorts, canArchivePortsEffective, canRemoveOutletMaterial, canGenerateQr, canRevokeQr, orgName, onReload, onToast }: {
  point: DistributionPoint;
  lang: 'ar' | 'en';
  canEditPorts: boolean;
  canArchivePorts: boolean;
  canArchivePortsEffective: boolean;
  canRemoveOutletMaterial: boolean;
  canGenerateQr: boolean;
  canRevokeQr: boolean;
  orgName?: string;
  onReload: () => void;
  onToast: (msg: string) => void;
}) {
  const [qr, setQr] = useState<{ tokenId: string; publicId: string } | null | undefined>(undefined);
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmAction, setConfirmAction] = useState<'regenerate' | 'revoke' | 'archive' | 'edit' | null>(null);
  const [archiveReason, setArchiveReason] = useState('');
  const [qrSrc, setQrSrc] = useState<string | null>(null);
  const [qrSrcErr, setQrSrcErr] = useState(false);
  const [showPreview, setShowPreview] = useState(false);

  // BUGFIX-OUTLET-MATERIAL-DELETE-EDIT-A: "Edit outlet" — uses the existing
  // updateDistributionPoint() service (a direct PostgREST update, RLS-gated
  // by the same dp_update_perm policy — super_admin OR org + ports.edit —
  // that already governs this button's visibility via canEditPorts). Only
  // name/name_ar/pointType are edited here; status changes stay exclusively
  // in the archive flow above (a separate trigger-guarded path).
  const [editName, setEditName] = useState(point.name);
  const [editNameAr, setEditNameAr] = useState(point.name_ar);
  const [editPointType, setEditPointType] = useState<PointType>(point.pointType as PointType);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  function openEdit() {
    setEditName(point.name);
    setEditNameAr(point.name_ar);
    setEditPointType(point.pointType as PointType);
    setEditError(null);
    setConfirmAction('edit');
  }

  async function onSaveEdit() {
    if (!editName.trim() || !editNameAr.trim()) {
      setEditError(t('port_name_required', lang));
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      await updateDistributionPoint(point.id, {
        name: editName.trim(),
        name_ar: editNameAr.trim(),
        pointType: editPointType,
      });
      setConfirmAction(null);
      onToast(t('port_updated', lang));
      onReload();
    } catch (e) {
      console.error('[phoenix] port update failed:', e);
      setEditError(t('port_update_error', lang));
    } finally {
      setEditBusy(false);
    }
  }

  const ptTypeKey = POINT_TYPES.find(p => p.value === point.pointType)?.labelKey;

  useState(() => {
    getQrForPoint(point.id).then(r => setQr(r)).catch(() => setQr(null));
  });

  const publicUrl = qr?.publicId ? `${window.location.origin}/?qid=${qr.publicId}` : null;

  useEffect(() => {
    if (!publicUrl) { setQrSrc(null); setQrSrcErr(false); return; }
    let cancelled = false;
    setQrSrc(null);
    setQrSrcErr(false);
    QRCode.toDataURL(publicUrl, { width: 240, margin: 2, color: { dark: '#1a1a1a', light: '#ffffff' } })
      .then(src => { if (!cancelled) setQrSrc(src); })
      .catch(() => { if (!cancelled) setQrSrcErr(true); });
    return () => { cancelled = true; };
  }, [publicUrl]);

  async function onGenerateQr() {
    setBusy('generate');
    try {
      const res = await createQrForTarget('distribution_point', point.id, point.name);
      setQr({ tokenId: res.token_id, publicId: res.public_id });
      onToast(t('qr_generated', lang));
    } catch (e) {
      const msg = (e instanceof Error ? e.message : '') || ((e as { message?: string })?.message ?? '');
      console.error('[phoenix] QR generate failed:', e);
      if (msg.includes('INSUFFICIENT') || msg.includes('permission')) {
        onToast(t('perm_no_qr_generate', lang));
      } else {
        onToast(t('qr_create_error', lang));
      }
    } finally {
      setBusy(null);
    }
  }

  async function onRegenerateQr() {
    setConfirmAction(null);
    setBusy('regenerate');
    try {
      const res = await regenerateQrForPoint(point.id, point.name);
      setQr({ tokenId: '', publicId: res.public_id });
      onToast(t('qr_regenerated', lang));
      onReload();
    } catch (e) {
      const msg = (e instanceof Error ? e.message : '') || ((e as { message?: string })?.message ?? '');
      console.error('[phoenix] QR regenerate failed:', e);
      if (msg.includes('INSUFFICIENT') || msg.includes('permission')) {
        onToast(t('perm_no_qr_generate', lang));
      } else {
        onToast(t('qr_create_error', lang));
      }
    } finally {
      setBusy(null);
    }
  }

  async function onRevokeQr() {
    setConfirmAction(null);
    if (!qr?.tokenId) return;
    setBusy('revoke');
    try {
      await disableQrToken(qr.tokenId, 'manual_revoke');
      setQr(null);
      onToast(t('qr_revoked', lang));
      onReload();
    } catch (e) {
      const msg = (e instanceof Error ? e.message : '') || ((e as { message?: string })?.message ?? '');
      console.error('[phoenix] QR revoke failed:', e);
      if (msg.includes('INSUFFICIENT') || msg.includes('permission')) {
        onToast(t('perm_no_qr_generate', lang));
      } else {
        onToast(t('qr_create_error', lang));
      }
    } finally {
      setBusy(null);
    }
  }

  async function onArchivePort() {
    setConfirmAction(null);
    setBusy('archive');
    try {
      if (qr?.tokenId) {
        await disableQrToken(qr.tokenId, 'port_archived');
      }
      // BUGFIX-OUTLET-MATERIAL-AND-OUTLET-DELETE-A: archive_entity reports
      // failure via { ok: false, error } rather than a thrown exception — the
      // previous code always showed "archived successfully" even when the
      // RPC silently declined (e.g. insufficient role), which is exactly the
      // "outlet won't delete/disable" symptom reported by the user.
      const result = await archiveEntity('distribution_point', point.id, archiveReason || 'archived_via_ui');
      if (!result.ok) {
        onToast(t(archiveErrorKey(result.error), lang));
        return;
      }
      setQr(null);
      onToast(t('port_archived', lang));
      onReload();
    } catch (e) {
      onToast(e instanceof Error ? e.message : t('load_error', lang));
    } finally {
      setBusy(null);
      setArchiveReason('');
    }
  }

  async function onCopyUrl() {
    if (!publicUrl) return;
    try {
      await navigator.clipboard.writeText(publicUrl);
      onToast(t('qr_copied', lang));
    } catch { /* clipboard not available */ }
  }

  return (
    <PhoenixCard padding="14px">
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {pointDisplayName(point, lang)}
          </div>
          <div style={{ fontSize: '11px', color: 'var(--t2)', marginTop: '2px' }}>
            {ptTypeKey ? t(ptTypeKey, lang) : point.pointType}
          </div>
        </div>
        <PhoenixStatusBadge variant={point.status === 'active' ? 'ok' : 'neutral'} label={statusLabel(point.status, lang)} />
      </div>

      {/* QR status / thumbnail */}
      {qr === undefined && (
        <div style={{ fontSize: '11px', color: 'var(--t3)', marginBottom: '8px' }}>{t('loading', lang)}</div>
      )}
      {qr === null && (
        <div style={{ fontSize: '11px', color: 'var(--t3)', marginBottom: '8px' }}>📱 {t('qr_no_token', lang)}</div>
      )}
      {qr && publicUrl && (
        <div style={{ marginBottom: '10px' }}>
          {qrSrcErr ? (
            <div style={{ fontSize: '11px', color: 'var(--err)', marginBottom: '6px' }}>{t('qr_display_error', lang)}</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: '10px' }}>
              <button
                onClick={() => setShowPreview(true)}
                title={t('qr_open_preview', lang)}
                aria-label={t('qr_open_preview', lang)}
                style={{ padding: 0, border: '1.5px solid var(--brd)', borderRadius: '7px', background: '#fff', cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center', flexShrink: 0, overflow: 'hidden', transition: 'border-color .15s' }}
              >
                {qrSrc ? (
                  <img src={qrSrc} width={80} height={80} alt="QR Code" style={{ display: 'block' }} />
                ) : (
                  <div style={{ width: 80, height: 80, background: 'var(--s2)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <span style={{ fontSize: '28px' }}>📱</span>
                  </div>
                )}
                <span style={{ fontSize: '9px', color: 'var(--p)', fontWeight: 700, padding: '2px 0 4px', letterSpacing: '.3px' }}>{t('qr_preview', lang)}</span>
              </button>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: '10px', color: 'var(--t2)', marginBottom: '3px' }}>{t('qr_url', lang)}:</div>
                <div
                  onClick={onCopyUrl}
                  style={{ fontSize: '10px', fontFamily: 'monospace', color: 'var(--p)', cursor: 'pointer', wordBreak: 'break-all', lineHeight: 1.4 }}
                  dir="ltr"
                  title={t('qr_copied', lang)}
                >
                  {publicUrl}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Actions */}
      {(canEditPorts || canGenerateQr || canRevokeQr || canArchivePortsEffective) && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: '6px', marginTop: '6px' }}>
          {canEditPorts && (
            <PhoenixButton variant="ghost" size="sm" onClick={openEdit} style={{ minHeight: '32px' }}>
              ✏️ {t('port_edit', lang)}
            </PhoenixButton>
          )}
          {canGenerateQr && !qr && qr !== undefined && (
            <PhoenixButton variant="primary" size="sm" loading={busy === 'generate'} onClick={onGenerateQr}>
              📱 {t('qr_generate', lang)}
            </PhoenixButton>
          )}
          {canGenerateQr && canRevokeQr && qr && (
            <PhoenixButton variant="ghost" size="sm" loading={busy === 'regenerate'} onClick={() => setConfirmAction('regenerate')}>
              🔄 {t('qr_regenerate', lang)}
            </PhoenixButton>
          )}
          {canRevokeQr && qr && (
            <PhoenixButton variant="warn" size="sm" loading={busy === 'revoke'} onClick={() => setConfirmAction('revoke')}>
              🚫 {t('qr_revoke', lang)}
            </PhoenixButton>
          )}
          {canArchivePortsEffective && (
            <PhoenixButton variant="ghost" size="sm" loading={busy === 'archive'} onClick={() => setConfirmAction('archive')}>
              📦 {t('port_disable_action', lang)}
            </PhoenixButton>
          )}
        </div>
      )}

      {/* Availability section */}
      <PortAvailabilitySection
        pointId={point.id}
        orgId={point.organizationId}
        lang={lang}
        canMutate={canEditPorts}
        canRemove={canRemoveOutletMaterial}
        onToast={onToast}
      />

      {/* Port cleanup wizard — deletion_wizard.clear_port_items is a separate
          permission from ports.archive/archive_entity; left as-is (out of
          scope for this permission-matrix fix, which targets only the
          archive_entity-backed "Disable outlet" button above). */}
      {canArchivePorts && (
        <PortCleanupWizard pointId={point.id} lang={lang} onDone={onReload} onToast={onToast} />
      )}

      {/* Confirmation dialogs */}
      <PhoenixDialog
        open={confirmAction === 'regenerate'}
        onClose={() => setConfirmAction(null)}
        title={t('qr_regenerate', lang)}
      >
        <p style={{ fontSize: '13px', color: 'var(--t2)', marginBottom: '16px', lineHeight: 1.6 }}>
          {t('qr_confirm_regenerate', lang)}
        </p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={() => setConfirmAction(null)}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} onClick={onRegenerateQr}>{t('qr_regenerate', lang)}</PhoenixButton>
        </div>
      </PhoenixDialog>

      <PhoenixDialog
        open={confirmAction === 'revoke'}
        onClose={() => setConfirmAction(null)}
        title={t('qr_revoke', lang)}
      >
        <p style={{ fontSize: '13px', color: 'var(--t2)', marginBottom: '8px', lineHeight: 1.6 }}>
          {t('qr_confirm_revoke', lang)}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--ok)', fontWeight: 600, marginBottom: '16px' }}>
          🔒 {t('port_revoke_safe', lang)}
        </p>
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={() => setConfirmAction(null)}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="warn" size="md" style={{ flex: 2 }} onClick={onRevokeQr}>🚫 {t('qr_revoke', lang)}</PhoenixButton>
        </div>
      </PhoenixDialog>

      <PhoenixDialog
        open={confirmAction === 'edit'}
        onClose={() => { if (!editBusy) setConfirmAction(null); }}
        title={t('port_edit', lang)}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', marginBottom: '16px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>
              {t('port_name_ar', lang)} *
            </label>
            <input type="text" value={editNameAr} onChange={e => setEditNameAr(e.target.value)} style={fieldStyle} dir="auto" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>
              {t('port_name_en', lang)} *
            </label>
            <input type="text" value={editName} onChange={e => setEditName(e.target.value)} style={fieldStyle} dir="auto" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>
              {t('port_type', lang)}
            </label>
            <select value={editPointType} onChange={e => setEditPointType(e.target.value as PointType)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
              {POINT_TYPES.map(pt => <option key={pt.value} value={pt.value}>{t(pt.labelKey, lang)}</option>)}
            </select>
          </div>
        </div>
        {editError && <p style={{ fontSize: '12px', color: 'var(--err)', marginBottom: '12px' }}>{editError}</p>}
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} disabled={editBusy} onClick={() => setConfirmAction(null)}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" style={{ flex: 2 }} loading={editBusy} onClick={onSaveEdit}>💾 {t('port_save_action', lang)}</PhoenixButton>
        </div>
      </PhoenixDialog>

      <PhoenixDialog
        open={confirmAction === 'archive'}
        onClose={() => setConfirmAction(null)}
        title={t('port_confirm_archive', lang)}
      >
        <p style={{ fontSize: '13px', color: 'var(--t2)', marginBottom: '8px', lineHeight: 1.6 }}>
          {t('port_confirm_archive', lang)}
        </p>
        <p style={{ fontSize: '12px', color: 'var(--warn)', fontWeight: 600, marginBottom: '12px' }}>
          ⚠ {t('port_archive_warn', lang)}
        </p>
        <div style={{ marginBottom: '16px' }}>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('port_archive_reason', lang)}</label>
          <input type="text" value={archiveReason} onChange={e => setArchiveReason(e.target.value)} style={fieldStyle} dir="auto" />
        </div>
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} onClick={() => setConfirmAction(null)}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="warn" size="md" style={{ flex: 2 }} loading={busy === 'archive'} onClick={onArchivePort}>📦 {t('port_disable_action', lang)}</PhoenixButton>
        </div>
      </PhoenixDialog>

      {/* QR Preview Modal */}
      <QrPreviewModal
        open={showPreview}
        onClose={() => setShowPreview(false)}
        src={qrSrc}
        srcErr={qrSrcErr}
        url={publicUrl ?? ''}
        portName={pointDisplayName(point, lang)}
        orgName={orgName}
        lang={lang}
        canRegenerate={canGenerateQr && canRevokeQr}
        onRegenerate={() => { setShowPreview(false); setConfirmAction('regenerate'); }}
        busy={busy === 'regenerate'}
        onToast={onToast}
      />
    </PhoenixCard>
  );
}

/* ── QR Preview / Print Modal ── */

function QrPreviewModal({ open, onClose, src, srcErr, url, portName, orgName, lang, canRegenerate, onRegenerate, busy, onToast }: {
  open: boolean;
  onClose: () => void;
  src: string | null;
  srcErr: boolean;
  url: string;
  portName: string;
  orgName?: string;
  lang: 'ar' | 'en';
  canRegenerate: boolean;
  onRegenerate: () => void;
  busy: boolean;
  onToast: (msg: string) => void;
}) {
  function esc(s: string) {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function handlePrint() {
    if (!src) return;
    const generated = formatStableDate(new Date(), lang);
    const win = window.open('', '_blank', 'width=520,height=680');
    if (!win) {
      onToast(t('print_popup_blocked', lang));
      return;
    }
    win.document.write(`<!DOCTYPE html>
<html dir="${lang === 'ar' ? 'rtl' : 'ltr'}" lang="${lang === 'ar' ? 'ar' : 'en'}">
<head>
  <meta charset="UTF-8">
  <title>QR — ${esc(portName)}</title>
  <style>
    * { box-sizing: border-box; }
    body { font-family: system-ui, -apple-system, sans-serif; text-align: center; padding: 40px 24px; color: #111; margin: 0; background: #fff; }
    h2 { font-size: 22px; font-weight: 700; margin: 0 0 4px; }
    .org { font-size: 14px; color: #555; margin: 0 0 20px; }
    img { display: block; margin: 0 auto 16px; width: 200px; height: 200px; border: 1px solid #e5e7eb; border-radius: 8px; padding: 8px; }
    .url { font-size: 10.5px; color: #666; word-break: break-all; font-family: monospace; direction: ltr; margin: 0 0 6px; }
    .date { font-size: 10px; color: #888; margin: 0 0 16px; direction: ltr; }
    .brand { font-size: 10px; color: #aaa; border-top: 1px solid #eee; padding-top: 12px; }
    @media print { body { padding: 20px; } }
  </style>
</head>
<body>
  <h2>${esc(portName)}</h2>
  ${orgName ? `<p class="org">${esc(orgName)}</p>` : ''}
  <img src="${src}" alt="QR Code">
  <p class="url">${esc(url)}</p>
  <p class="date" dir="ltr">${esc(generated)}</p>
  <p class="brand">MediStock-Babil / MASAR Health Network</p>
</body>
</html>`);
    win.document.close();
    win.focus();
    win.print();
    win.close();
  }

  if (!open) return null;

  return (
    <PhoenixDialog open={open} onClose={onClose} title={t('qr_large_preview', lang)} maxWidth={460}>
      <div style={{ textAlign: 'center' }}>
        {/* Port and org label */}
        <div style={{ fontSize: '15px', fontWeight: 700, marginBottom: '2px' }}>{portName}</div>
        {orgName && <div style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '14px' }}>{orgName}</div>}

        {/* QR image */}
        {srcErr ? (
          <div style={{ padding: '24px', color: 'var(--err)', fontSize: '13px' }}>{t('qr_display_error', lang)}</div>
        ) : (
          <div style={{ display: 'inline-block', background: '#fff', borderRadius: '10px', padding: '10px', border: '1px solid var(--brd)', marginBottom: '14px' }}>
            {src ? (
              <img src={src} width={200} height={200} alt="QR Code" style={{ display: 'block', borderRadius: '4px' }} />
            ) : (
              <div style={{ width: 200, height: 200, background: 'var(--s2)', display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: '4px' }}>
                <span style={{ fontSize: '36px' }}>📱</span>
              </div>
            )}
          </div>
        )}

        {/* Public URL */}
        {url && (
          <div style={{ fontSize: '10.5px', fontFamily: 'monospace', color: 'var(--t2)', wordBreak: 'break-all', marginBottom: '18px', lineHeight: 1.5, padding: '0 8px' }} dir="ltr">
            {url}
          </div>
        )}

        {/* Actions */}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'center', flexWrap: 'wrap' }}>
          {canRegenerate && (
            <PhoenixButton variant="ghost" size="sm" loading={busy} onClick={onRegenerate}>
              🔄 {t('qr_regenerate', lang)}
            </PhoenixButton>
          )}
          <PhoenixButton variant="ghost" size="md" disabled={!src} onClick={handlePrint}>
            🖨 {t('qr_print', lang)}
          </PhoenixButton>
          <PhoenixButton variant="primary" size="md" onClick={onClose}>
            {t('qr_close', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixDialog>
  );
}

/* ── Port Availability Section ── */

interface AvailRow {
  id: string;
  quantity: number;
  condition: string;
  batch_number: string | null;
  expiry_date: string | null;
  notes: string | null;
  updated_at: string;
  // BUGFIX-OUTLET-MATERIAL-AND-OUTLET-DELETE-A: getAvailabilityByPoint already
  // selects these identity fields (availability.service.ts) — needed to call
  // upsertAvailability's identity-matched update when removing a material.
  scientific_name?: string | null;
  trade_name?: string | null;
  dosage_form?: string | null;
  concentration?: string | null;
  price?: number | null;
  supply_type?: string | null;
  local_items: {
    id: string;
    local_code: string | null;
    central_items: { id: string; name: string; name_ar: string; unit: string; barcode?: string } |
                   { id: string; name: string; name_ar: string; unit: string; barcode?: string }[] | null;
  } | null;
}

interface LocalRow {
  id: string;
  local_code: string | null;
  local_name: string | null;
  central_items: { name: string; name_ar: string; unit: string } |
                 { name: string; name_ar: string; unit: string }[] | null;
}

function centralOf(row: LocalRow | AvailRow['local_items']): { name: string; name_ar: string; unit: string } | null {
  if (!row) return null;
  const c = 'central_items' in row ? row.central_items : null;
  if (!c) return null;
  return Array.isArray(c) ? c[0] ?? null : c;
}

function PortAvailabilitySection({ pointId, orgId, lang, canMutate, canRemove, onToast }: {
  pointId: string;
  orgId: string;
  lang: 'ar' | 'en';
  canMutate: boolean;
  // BUGFIX-OUTLET-MATERIAL-DELETE-EDIT-A (permission-matrix fix): separate
  // from canMutate (which only reflects ports.edit, gating the "+ Add"
  // button) because "Remove from outlet" writes through TWO additional
  // permission-checked RPCs (phoenix_apply_availability_movement then
  // phoenix_upsert_availability) — see canRemoveOutletMaterial in
  // OrgDetailView, which already folds in availability.quantity.set and
  // availability.update/create alongside ports.edit.
  canRemove: boolean;
  onToast: (msg: string) => void;
}) {
  const avail = useAsync(() => getAvailabilityByPoint(pointId), [pointId]);
  const [showAdd, setShowAdd] = useState(false);
  const rows = (avail.data ?? []) as unknown as AvailRow[];

  // BUGFIX-OUTLET-MATERIAL-AND-OUTLET-DELETE-A: "Remove from outlet" — no hard
  // DELETE exists (or is allowed) for item_availability rows tied to movement
  // history/audit, so this performs the same safe pattern already used by the
  // Status Center's quantity-movement UI: zero the quantity via the audited
  // phoenix_apply_availability_movement RPC (the only permitted quantity-write
  // path — migration 035's hard guard blocks direct quantity writes), then
  // mark condition = 'missing' via the existing upsert RPC now that the
  // stored quantity matches. History/reports/QR audit trail are untouched.
  const [removeTarget, setRemoveTarget] = useState<AvailRow | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removeError, setRemoveError] = useState<string | null>(null);

  async function onConfirmRemove() {
    if (!removeTarget) return;
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      if (removeTarget.quantity !== 0) {
        await applyAvailabilityMovement({
          itemAvailabilityId: removeTarget.id,
          movementType: 'set_exact',
          amount: 0,
          reason: 'removed_from_outlet',
        });
      }
      await upsertAvailability({
        distributionPointId: pointId,
        organizationId: orgId,
        scientificName: removeTarget.scientific_name ?? '',
        tradeName: removeTarget.trade_name ?? undefined,
        dosageForm: removeTarget.dosage_form ?? undefined,
        concentrationValue: removeTarget.concentration ?? undefined,
        price: removeTarget.price ?? undefined,
        quantity: 0,
        condition: 'missing',
        batchNumber: removeTarget.batch_number ?? undefined,
        expiryDate: removeTarget.expiry_date ?? undefined,
        notes: removeTarget.notes ?? undefined,
        supplyType: removeTarget.supply_type ?? undefined,
      });
      setRemoveTarget(null);
      onToast(t('avail_removed_from_outlet', lang));
      avail.reload();
    } catch (e) {
      setRemoveError(t(classifyAvailabilityMovementError(e), lang));
    } finally {
      setRemoveBusy(false);
    }
  }

  return (
    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--brd)' }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '6px' }}>
        <span style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--t2)' }}>
          💊 {t('avail_manage', lang)} ({rows.length} {t('avail_count', lang)})
        </span>
        {canMutate && !showAdd && (
          <button
            onClick={() => setShowAdd(true)}
            style={{ fontSize: '11px', color: 'var(--p)', fontWeight: 600, border: 'none', background: 'none', cursor: 'pointer', padding: '2px 6px' }}
          >
            + {t('avail_add', lang)}
          </button>
        )}
      </div>

      {showAdd && (
        <QuickAvailForm
          pointId={pointId}
          orgId={orgId}
          lang={lang}
          onSaved={() => { setShowAdd(false); avail.reload(); onToast(t('avail_saved', lang)); }}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {avail.loading && <div style={{ fontSize: '11px', color: 'var(--t3)' }}>{t('loading', lang)}</div>}

      {!avail.loading && rows.length === 0 && !showAdd && (
        <div style={{ fontSize: '11px', color: 'var(--t3)', textAlign: 'center', padding: '8px' }}>
          {t('empty_avail', lang)}
        </div>
      )}

      {!avail.loading && rows.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
          {rows.map(r => {
            const ci = centralOf(r.local_items);
            const itemName = lang === 'ar' ? (ci?.name_ar ?? ci?.name) : (ci?.name ?? ci?.name_ar);
            const condKey = CONDITION_LABEL_KEY[r.condition];
            const variant = CONDITION_VARIANT[r.condition] ?? 'neutral';
            const alreadyRemoved = r.quantity === 0 && r.condition === 'missing';
            return (
              <div key={r.id} style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '6px', padding: '6px 8px', borderRadius: 'var(--r2)', background: 'var(--s2)', fontSize: '11.5px' }}>
                <div style={{ minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 }}>
                  {itemName ?? '—'}
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: '10.5px', color: 'var(--t2)' }}>{r.quantity} {ci?.unit ?? ''}</span>
                  <PhoenixStatusBadge variant={variant} label={condKey ? t(condKey, lang) : r.condition} />
                  {r.expiry_date && r.condition === 'near_expiry' && (
                    <span style={{ fontSize: '9.5px', color: 'var(--warn)' }} dir="ltr">{r.expiry_date}</span>
                  )}
                  {canRemove && !alreadyRemoved && (
                    <button
                      onClick={() => { setRemoveError(null); setRemoveTarget(r); }}
                      aria-label={t('avail_remove_from_outlet', lang)}
                      style={{ fontSize: '10.5px', color: 'var(--err)', border: '1px solid var(--err)', background: 'transparent', borderRadius: 'var(--r1)', padding: '3px 8px', cursor: 'pointer', minHeight: '28px' }}
                    >
                      🗑 {t('avail_remove_from_outlet', lang)}
                    </button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <PhoenixDialog
        open={removeTarget !== null}
        onClose={() => { if (!removeBusy) { setRemoveTarget(null); setRemoveError(null); } }}
        title={t('avail_remove_from_outlet', lang)}
      >
        <p style={{ fontSize: '13px', color: 'var(--t2)', marginBottom: '8px', lineHeight: 1.6 }}>
          {t('avail_remove_confirm', lang)}
        </p>
        {removeError && <p style={{ fontSize: '12px', color: 'var(--err)', marginBottom: '12px' }}>{removeError}</p>}
        <div style={{ display: 'flex', gap: '10px' }}>
          <PhoenixButton variant="ghost" size="md" style={{ flex: 1 }} disabled={removeBusy} onClick={() => { setRemoveTarget(null); setRemoveError(null); }}>
            {t('cancel', lang)}
          </PhoenixButton>
          <PhoenixButton variant="warn" size="md" style={{ flex: 2 }} loading={removeBusy} onClick={onConfirmRemove}>
            🗑 {t('avail_remove_from_outlet', lang)}
          </PhoenixButton>
        </div>
      </PhoenixDialog>
    </div>
  );
}

/* ── Quick Availability Add Form ── */

function QuickAvailForm({ pointId, orgId, lang, onSaved, onCancel }: {
  pointId: string;
  orgId: string;
  lang: 'ar' | 'en';
  onSaved: () => void;
  onCancel: () => void;
}) {
  const items = useAsync(() => getLocalItems(orgId), [orgId]);
  const itemRows = (items.data ?? []) as unknown as LocalRow[];
  const [itemId, setItemId] = useState('');
  const [qty, setQty] = useState(0);
  const [condition, setCondition] = useState<AvailabilityCondition>('available');
  const [batch, setBatch] = useState('');
  const [expiry, setExpiry] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSubmit = itemId && qty >= 0;

  async function onSubmit() {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const selectedItem = itemRows.find(r => r.id === itemId);
      const ci = selectedItem ? centralOf(selectedItem) : null;
      const sciName = ci ? (ci.name ?? ci.name_ar ?? itemId) : itemId;
      await upsertAvailability({
        distributionPointId: pointId,
        organizationId: orgId,
        scientificName: sciName,
        quantity: qty,
        condition,
        batchNumber: batch || undefined,
        expiryDate: expiry || undefined,
      });
      onSaved();
    } catch (e) {
      // Developer-safe console log; user sees a classified, translated
      // message only (mirrors EditorScreen.tsx's doApply, instead of the
      // previous raw/untranslated e.message fallback).
      console.error('[phoenix] availability quick-add failed:', e);
      setError(t(classifyAvailabilitySaveError(e), lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ background: 'var(--s2)', borderRadius: 'var(--r2)', padding: '10px', marginBottom: '8px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
      <select value={itemId} onChange={e => setItemId(e.target.value)} style={{ ...fieldStyle, fontSize: '11.5px', padding: '7px 10px' }}>
        <option value="">{items.loading ? t('loading', lang) : t('avail_select_item', lang)}</option>
        {itemRows.map(row => {
          const ci = centralOf(row);
          return <option key={row.id} value={row.id}>{lang === 'ar' ? (ci?.name_ar ?? ci?.name) : (ci?.name ?? ci?.name_ar)} ({row.local_code ?? ''})</option>;
        })}
      </select>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <input type="number" min={0} value={qty} onChange={e => setQty(Number(e.target.value))} placeholder={t('qty', lang)} style={{ ...fieldStyle, fontSize: '11.5px', padding: '7px 10px' }} />
        <select value={condition} onChange={e => setCondition(e.target.value as AvailabilityCondition)} style={{ ...fieldStyle, fontSize: '11.5px', padding: '7px 10px', appearance: 'none' }}>
          {CONDITIONS.map(c => <option key={c} value={c}>{t(CONDITION_LABEL_KEY[c], lang)}</option>)}
        </select>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
        <input type="text" dir="ltr" value={batch} onChange={e => setBatch(e.target.value)} placeholder={t('batch_no', lang)} style={{ ...fieldStyle, fontSize: '11.5px', padding: '7px 10px', fontFamily: 'monospace' }} />
        <input type="date" value={expiry} onChange={e => setExpiry(e.target.value)} style={{ ...fieldStyle, fontSize: '11.5px', padding: '7px 10px' }} />
      </div>
      {error && <p style={{ fontSize: '11px', color: 'var(--err)' }}>{error}</p>}
      <div style={{ display: 'flex', gap: '6px', justifyContent: 'flex-end' }}>
        <button onClick={onCancel} style={{ fontSize: '11px', color: 'var(--t2)', border: 'none', background: 'none', cursor: 'pointer' }}>{t('cancel', lang)}</button>
        <PhoenixButton variant="primary" size="sm" loading={busy} disabled={!canSubmit} onClick={onSubmit}>
          {t('inst_save', lang)}
        </PhoenixButton>
      </div>
    </div>
  );
}

/* ── Port Cleanup Wizard ── */

function PortCleanupWizard({ pointId, lang, onDone, onToast }: {
  pointId: string;
  lang: 'ar' | 'en';
  onDone: () => void;
  onToast: (msg: string) => void;
}) {
  const impact = useAsync(() => getEntityPurgeImpact('distribution_point', pointId), [pointId]);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const d = impact.data as { ok?: boolean; item_availability?: number; qr_tokens?: number } | null;
  const itemCount = d?.item_availability ?? 0;
  const qrCount = d?.qr_tokens ?? 0;
  const hasItems = itemCount > 0;
  const phrase = 'CLEAR PORT ITEMS';

  async function onClearItems() {
    if (confirm !== phrase) return;
    setBusy(true);
    try {
      await clearPortAvailability(pointId);
      onToast(t('dw_cleared', lang));
      setConfirm('');
      impact.reload();
      onDone();
    } catch (e) {
      console.error('[phoenix] clearPortAvailability failed:', e);
      onToast(t(classifyClearPortItemsError(e), lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ marginTop: '10px', paddingTop: '10px', borderTop: '1px solid var(--brd)' }}>
      <div style={{ fontSize: '11.5px', fontWeight: 700, color: 'var(--t2)', marginBottom: '8px' }}>
        🗑️ {t('dw_title', lang)}
      </div>

      {impact.loading && <div style={{ fontSize: '11px', color: 'var(--t3)' }}>{t('loading', lang)}</div>}

      {!impact.loading && d && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
          {/* Impact counts */}
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', fontSize: '11px' }}>
            <span style={{ color: itemCount > 0 ? 'var(--err)' : 'var(--ok)' }}>
              📋 {itemCount} {t('dw_items_count', lang)}
            </span>
            <span style={{ color: qrCount > 0 ? 'var(--warn)' : 'var(--ok)' }}>
              📱 {qrCount} {t('dw_qr_count', lang)}
            </span>
          </div>

          {/* Safety warnings */}
          <div style={{ fontSize: '10.5px', color: 'var(--info)', display: 'flex', flexDirection: 'column', gap: '2px' }}>
            {hasItems && <span>⚠ {t('dw_clear_items_warn', lang)}</span>}
            {qrCount > 0 && <span>📱 {t('dw_revoke_qr_warn', lang)}</span>}
            <span>🔒 {t('dw_revoke_qr_safe', lang)}</span>
            <span>📦 {t('dw_archive_safe', lang)}</span>
          </div>

          {/* Clear items action */}
          {hasItems && (
            <div style={{ marginTop: '4px' }}>
              <label style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>
                {t('dw_confirm_label', lang)}: <code dir="ltr" style={{ fontWeight: 700 }}>{phrase}</code>
              </label>
              <div style={{ display: 'flex', gap: '6px' }}>
                <input
                  type="text" dir="ltr" value={confirm} onChange={e => setConfirm(e.target.value)}
                  placeholder={phrase}
                  style={{ flex: 1, padding: '6px 8px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '11px', fontFamily: 'monospace' }}
                />
                <PhoenixButton variant="warn" size="sm" loading={busy} disabled={confirm !== phrase} onClick={onClearItems}>
                  {t('dw_clear_items', lang)}
                </PhoenixButton>
              </div>
            </div>
          )}

          {!hasItems && (
            <div style={{ fontSize: '10.5px', color: 'var(--ok)', fontWeight: 600 }}>
              ✅ {t('dw_ready', lang)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/* ── Organization Cleanup Wizard ── */

function OrgCleanupWizard({ orgId, lang, actorRole, onDone, onToast }: {
  orgId: string;
  lang: 'ar' | 'en';
  actorRole: string;
  onDone: () => void;
  onToast: (msg: string) => void;
}) {
  const impact = useAsync(() => getOrgDeleteImpact(orgId), [orgId]);
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);

  const d = impact.data;
  const phrase = 'ARCHIVE ORGANIZATION';
  const isSuper = actorRole === 'super_admin';

  async function onArchiveOrg() {
    if (confirm !== phrase || !d?.canArchive) return;
    setBusy(true);
    try {
      await archiveOrganization(orgId);
      onToast(t('dw_org_archived', lang));
      onDone();
    } catch (e) {
      onToast(e instanceof Error ? e.message : t('load_error', lang));
    } finally {
      setBusy(false);
    }
  }

  if (!isSuper) return null;

  return (
    <div style={{ marginTop: '16px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '10px' }}>🗑️ {t('dw_title', lang)}</h3>

      {impact.loading && <PhoenixLoadingState label={t('loading', lang)} />}

      {!impact.loading && impact.error && (
        <PhoenixErrorState title={t('load_error', lang)} message={impact.error} onRetry={impact.reload} />
      )}

      {!impact.loading && d && (
        <PhoenixCard padding="16px">
          <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '10px' }}>{t('dw_impact', lang)}</div>

          {/* Impact grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '8px', marginBottom: '12px', fontSize: '11.5px' }}>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, color: d.activeWarehouses > 0 ? 'var(--err)' : 'var(--ok)' }}>{d.activeWarehouses}</div>
              <div style={{ color: 'var(--t2)', fontSize: '10px' }}>{t('dw_wh_count', lang)}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, color: d.activePorts > 0 ? 'var(--err)' : 'var(--ok)' }}>{d.activePorts}</div>
              <div style={{ color: 'var(--t2)', fontSize: '10px' }}>{t('dw_ports_count', lang)}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, color: d.activeQrTokens > 0 ? 'var(--warn)' : 'var(--ok)' }}>{d.activeQrTokens}</div>
              <div style={{ color: 'var(--t2)', fontSize: '10px' }}>{t('dw_qr_count', lang)}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '18px', fontWeight: 700, color: d.availabilityRows > 0 ? 'var(--warn)' : 'var(--ok)' }}>{d.availabilityRows}</div>
              <div style={{ color: 'var(--t2)', fontSize: '10px' }}>{t('dw_items_count', lang)}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>{d.activeStatusReports}</div>
              <div style={{ color: 'var(--t2)', fontSize: '10px' }}>{t('dw_reports_count', lang)}</div>
            </div>
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: '18px', fontWeight: 700 }}>{d.profiles}</div>
              <div style={{ color: 'var(--t2)', fontSize: '10px' }}>{t('dw_users_count', lang)}</div>
            </div>
          </div>

          {/* Warnings */}
          <div style={{ fontSize: '11px', color: 'var(--info)', display: 'flex', flexDirection: 'column', gap: '3px', marginBottom: '12px', padding: '10px', background: 'var(--info2)', borderRadius: 'var(--r2)' }}>
            {!d.canArchive && <span>🚫 {t('dw_org_blocked', lang)}</span>}
            {d.profiles > 0 && <span>👥 {t('dw_users_safe', lang)}</span>}
            <span>📦 {t('dw_archive_safe', lang)}</span>
          </div>

          {/* Status */}
          {d.canArchive ? (
            <div style={{ marginBottom: '10px', fontSize: '12px', color: 'var(--ok)', fontWeight: 600 }}>
              ✅ {t('dw_ready', lang)}
            </div>
          ) : (
            <div style={{ marginBottom: '10px', fontSize: '12px', color: 'var(--err)', fontWeight: 600 }}>
              🚫 {t('dw_blocked', lang)}
            </div>
          )}

          {/* Archive action */}
          {d.canArchive && (
            <div>
              <label style={{ display: 'block', fontSize: '10.5px', color: 'var(--t2)', marginBottom: '4px' }}>
                {t('dw_confirm_label', lang)}: <code dir="ltr" style={{ fontWeight: 700 }}>{phrase}</code>
              </label>
              <div style={{ display: 'flex', gap: '8px' }}>
                <input
                  type="text" dir="ltr" value={confirm} onChange={e => setConfirm(e.target.value)}
                  placeholder={phrase}
                  style={{ flex: 1, padding: '8px 10px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)', background: 'var(--s)', color: 'var(--t)', fontSize: '12px', fontFamily: 'monospace' }}
                />
                <PhoenixButton variant="warn" size="md" loading={busy} disabled={confirm !== phrase} onClick={onArchiveOrg}>
                  📦 {t('dw_org_archived', lang)}
                </PhoenixButton>
              </div>
            </div>
          )}
        </PhoenixCard>
      )}
    </div>
  );
}
