import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import { canManageOrg, canAssignRole, ASSIGNABLE_ROLES_BY_ACTOR } from '@/shared/lib/types';
import type { Role } from '@/shared/lib/types';
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
import { getWarehouses, getPointsByOrg } from '@/shared/supabase/services/warehouses.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';

const ROLE_LABEL_KEY: Record<Role, string> = {
  super_admin: 'role_super_admin',
  hospital_admin: 'role_hospital_admin',
  warehouse_manager: 'role_warehouse_manager',
  point_operator: 'role_point_operator',
  viewer: 'role_viewer',
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
  const { lang, role, activeOrgId, profile } = useApp();
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
    <div style={{ maxWidth: '1000px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '22px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>
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
      <div style={{ display: 'flex', gap: '10px', marginBottom: '16px', flexWrap: 'wrap' }}>
        <div style={{ position: 'relative', flex: 1, minWidth: '200px' }}>
          <span style={{ position: 'absolute', insetInlineStart: '12px', top: '50%', transform: 'translateY(-50%)', fontSize: '15px', pointerEvents: 'none' }}>🔍</span>
          <input
            type="search"
            placeholder={t('search', lang)}
            value={search}
            onChange={e => setSearch(e.target.value)}
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
        <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : 'repeat(auto-fill, minmax(min(100%, 300px), 1fr))', gap: '12px' }}>
          {filtered.map(org => (
            <PhoenixCard key={org.id} hover padding="16px" onClick={() => onSelect(org.id)}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', marginBottom: '8px' }}>
                <span style={{ fontSize: '13px', fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {orgDisplayName(org, lang)}
                </span>
                <PhoenixStatusBadge variant={STATUS_VARIANT[org.status] ?? 'neutral'} label={statusLabel(org.status, lang)} />
              </div>
              <div style={{ fontSize: '11.5px', color: 'var(--t2)', display: 'flex', flexWrap: 'wrap', gap: '8px' }}>
                <span dir="ltr" style={{ fontFamily: 'monospace' }}>{org.code}</span>
                {org.city && <span>· {org.city}</span>}
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

function OrgDetailView({ lang, isMobile, orgId, actorRole, onToast }: {
  lang: 'ar' | 'en';
  isMobile: boolean;
  orgId: string;
  actorRole: Role;
  onToast: (msg: string) => void;
}) {
  const isSuper = canManageOrg(actorRole);
  const canEditRoles = actorRole === 'super_admin' || actorRole === 'hospital_admin';

  const org = useAsync(() => getOrganization(orgId), [orgId]);
  const users = useAsync(() => getProfilesByOrg(orgId), [orgId]);
  const warehouses = useAsync(() => getWarehouses(orgId), [orgId]);
  const points = useAsync(() => getPointsByOrg(orgId), [orgId]);

  const [editing, setEditing] = useState(false);

  const o = org.data;
  const whCount = warehouses.data?.length ?? 0;
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
              <span style={{ fontSize: '16px' }}>🏬</span>
              <span><strong>{whCount}</strong> {t('inst_warehouses', lang)}</span>
            </div>
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

  async function onSaveRole() {
    if (!canAssignRole(actorRole, newRole)) return;
    setBusy(true);
    try {
      await updateProfileRole(user.id, newRole);
      setChanging(false);
      onRoleChanged();
    } catch (e) {
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
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <select
              value={newRole}
              onChange={e => setNewRole(e.target.value as Role)}
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
            <PhoenixButton variant="ghost" size="sm" onClick={() => setChanging(false)}>
              {t('cancel', lang)}
            </PhoenixButton>
          </div>
        )}
      </div>
    </PhoenixCard>
  );
}
