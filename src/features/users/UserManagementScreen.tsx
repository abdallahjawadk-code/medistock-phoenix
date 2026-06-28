import { useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import {
  OFFICIAL_ROLES, OFFICIAL_ROLE_LABEL_KEY, roleLabelKey, canTargetRole, normalizeRole,
  type OfficialRole,
} from '@/shared/lib/roles';
import {
  PERMISSION_KEYS, permissionsByModule, roleDefaults, effectivePermissions,
  validateOverrides, isDangerousPermission, type OverrideMap, type GrantContext,
} from '@/shared/lib/permissions';
import {
  listUsers, getEffectivePermissions, assignProfilePermissions,
  resetProfilePermissions, createUserViaEdge, getOrgStatusContacts,
  type ManagedUser,
} from '@/shared/supabase/services/users.service';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';

const fieldStyle = {
  width: '100%', padding: '9px 12px', borderRadius: 'var(--r2)',
  border: '1px solid var(--brd)', background: 'var(--s)',
  color: 'var(--t)', fontSize: '12.5px',
} as const;

function userName(u: ManagedUser): string { return u.full_name || u.id; }

export function UserManagementScreen() {
  const { lang, role, activeOrgId, profile } = useApp();
  const isMobile = window.innerWidth < 768;
  const isSuper = normalizeRole(role) === 'super_admin';

  // Actor effective permissions (role defaults are a safe UI baseline; backend enforces).
  const actorEff = effectivePermissions(role);
  const canViewUsers = isSuper || actorEff.has('users.view');
  const canCreate = isSuper || actorEff.has('users.create');
  const canManagePerms = isSuper || actorEff.has('users.manage_permissions');

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [search, setSearch] = useState('');
  const [filterRole, setFilterRole] = useState<string>('');
  const [showCreate, setShowCreate] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const users = useAsync(() => listUsers(isSuper ? activeOrgId : undefined), [isSuper, activeOrgId]);

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 2800); }

  const rows = (users.data ?? []).filter(u => {
    if (filterRole && normalizeRole(u.role) !== filterRole) return false;
    if (search) {
      const q = search.toLowerCase();
      return userName(u).toLowerCase().includes(q) || (u.full_name ?? '').includes(search);
    }
    return true;
  });

  const selectedUser = rows.find(u => u.id === selectedId) ?? (users.data ?? []).find(u => u.id === selectedId) ?? null;

  if (!canViewUsers) {
    return (
      <div style={{ maxWidth: '900px', animation: 'fs .3s ease' }}>
        <h2 style={{ fontSize: '22px', fontWeight: 700, marginBottom: '12px' }}>{t('um_title', lang)}</h2>
        <PhoenixEmptyState icon="🔒" title={t('um_no_users_perm', lang)} description={t('um_server_only', lang)} />
      </div>
    );
  }

  return (
    <div style={{ maxWidth: '1100px', animation: 'fs .3s ease' }}>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: '12px', marginBottom: '16px' }}>
        <div>
          <h2 style={{ fontSize: isMobile ? '18px' : '22px', fontWeight: 700, letterSpacing: '-.3px' }}>{t('um_title', lang)}</h2>
          <p style={{ fontSize: '12.5px', color: 'var(--t2)', marginTop: '3px' }}>{t('um_multi_officer', lang)}</p>
        </div>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          {isSuper && <PhoenixOrgScope />}
          {canCreate && (
            <PhoenixButton variant="primary" size="md" onClick={() => setShowCreate(s => !s)}>
              + {t('um_create_user', lang)}
            </PhoenixButton>
          )}
        </div>
      </div>

      {/* Secure server-path notice */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r3)', padding: '10px 14px', marginBottom: '16px', fontSize: '12px', color: 'var(--info)', display: 'flex', alignItems: 'center', gap: '8px' }}>
        🔐 {t('um_server_only', lang)}
      </div>

      {showCreate && canCreate && (
        <CreateUserForm
          lang={lang} isSuper={isSuper} actorOrgId={activeOrgId}
          onClose={() => setShowCreate(false)} onToast={showToast}
        />
      )}

      {/* Filters */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '10px', marginBottom: '14px', alignItems: 'center' }}>
        <select value={filterRole} onChange={e => setFilterRole(e.target.value)}
          style={{ ...fieldStyle, width: 'auto', minWidth: '160px', appearance: 'none', cursor: 'pointer' }} aria-label={t('um_filter_role', lang)}>
          <option value="">{t('um_filter_role', lang)}: {t('um_all', lang)}</option>
          {OFFICIAL_ROLES.map(r => <option key={r} value={r}>{t(OFFICIAL_ROLE_LABEL_KEY[r], lang)}</option>)}
        </select>
        <div style={{ position: 'relative', flex: 1, minWidth: '150px' }}>
          <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', fontSize: '14px', pointerEvents: 'none' }}>🔍</span>
          <input type="search" placeholder={t('um_search', lang)} value={search} onChange={e => setSearch(e.target.value)}
            style={{ ...fieldStyle, paddingInlineStart: '34px' }} aria-label={t('um_search', lang)} />
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: isMobile ? '1fr' : '1fr 1.4fr', gap: '16px', alignItems: 'start' }}>
        {/* User list */}
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          {users.loading && <PhoenixLoadingState label={t('loading', lang)} />}
          {!users.loading && users.error && (
            <PhoenixErrorState title={t('load_error', lang)} message={users.error} onRetry={users.reload} />
          )}
          {!users.loading && !users.error && rows.length === 0 && (
            <PhoenixEmptyState icon="👥" title={t('um_empty', lang)} description={t('um_multi_officer', lang)} />
          )}
          {rows.map(u => {
            const selected = u.id === selectedId;
            return (
              <PhoenixCard key={u.id} padding="12px 14px" onClick={() => setSelectedId(u.id)}
                style={{ cursor: 'pointer', border: selected ? '1px solid var(--p)' : undefined, background: selected ? 'var(--p2)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 700 }} dir="auto">{userName(u)}</div>
                    {isSuper && <div style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="auto">{lang === 'ar' ? (u.org_name_ar ?? u.org_name ?? '—') : (u.org_name ?? u.org_name_ar ?? '—')}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <PhoenixStatusBadge variant={u.status === 'active' ? 'ok' : 'neutral'} label={t(u.status === 'active' ? 'um_active' : 'um_inactive', lang)} />
                    <PhoenixStatusBadge variant="neutral" label={t(roleLabelKey(u.role), lang)} />
                  </div>
                </div>
              </PhoenixCard>
            );
          })}
        </div>

        {/* Permission matrix */}
        <div>
          {!selectedUser && (
            <PhoenixEmptyState icon="🧩" title={t('um_select_user', lang)} description={t('um_permissions', lang)} />
          )}
          {selectedUser && (
            <PermissionMatrix
              key={selectedUser.id}
              user={selectedUser} lang={lang} actorRole={role} isSuper={isSuper}
              actorId={profile?.id ?? ''} canManage={canManagePerms} onToast={showToast}
            />
          )}
        </div>
      </div>

      {toast && <PhoenixToast message={toast} />}
    </div>
  );
}

/* ── Permission matrix ── */

function PermissionMatrix({ user, lang, actorRole, isSuper, actorId, canManage, onToast }: {
  user: ManagedUser;
  lang: 'ar' | 'en';
  actorRole: string;
  isSuper: boolean;
  actorId: string;
  canManage: boolean;
  onToast: (m: string) => void;
}) {
  const defaults = roleDefaults(user.role);
  const eff = useAsync(() => getEffectivePermissions(user.id), [user.id]);

  const [draft, setDraft] = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  // Initial effective = RPC result, or role defaults when migration missing.
  const migrationMissing = eff.data?.migrationMissing ?? false;
  const initialEff: Record<string, boolean> = (() => {
    if (eff.data?.permissions) return eff.data.permissions;
    const out: Record<string, boolean> = {};
    for (const p of PERMISSION_KEYS) out[p.key] = defaults.has(p.key);
    return out;
  })();

  const current = draft ?? initialEff;
  const readOnly = !canManage || migrationMissing;

  const grantCtx: GrantContext = {
    actorRole,
    isSelf: user.id === actorId,
    sameScope: isSuper, // server re-checks org scope; client baseline is super-only
  };

  function toggle(key: string, value: boolean) {
    setDraft(d => ({ ...(d ?? initialEff), [key]: value }));
  }

  async function onSave() {
    // Build overrides: changed keys → value (null when back to role default).
    const overrides: OverrideMap = {};
    for (const p of PERMISSION_KEYS) {
      const cur = current[p.key] ?? false;
      const init = initialEff[p.key] ?? false;
      if (cur === init) continue;
      overrides[p.key] = cur === defaults.has(p.key) ? null : cur;
    }
    if (Object.keys(overrides).length === 0) { onToast(t('um_saved', lang)); return; }

    // Client-side validation for UX (server is the real boundary).
    const check = validateOverrides(grantCtx, overrides);
    if (!check.ok && check.rejected.length > 0) {
      onToast(t('um_cannot_grant', lang));
      return;
    }

    setBusy(true);
    try {
      const res = await assignProfilePermissions(user.id, overrides);
      if (res.migrationMissing) { onToast(t('um_perm_unavailable', lang)); return; }
      if (!res.ok) { onToast(t('um_cannot_grant', lang)); return; }
      onToast(t('um_saved', lang));
      setDraft(null);
      eff.reload();
    } catch {
      onToast(t('load_error', lang));
    } finally { setBusy(false); }
  }

  async function onReset() {
    setBusy(true);
    try {
      const res = await resetProfilePermissions(user.id);
      if (res.migrationMissing) { onToast(t('um_perm_unavailable', lang)); return; }
      onToast(t('um_reset_done', lang));
      setDraft(null);
      eff.reload();
    } catch {
      onToast(t('load_error', lang));
    } finally { setBusy(false); }
  }

  const modules = permissionsByModule();
  const isMonthlyOfficer = normalizeRole(user.role) === 'monthly_status_officer';

  return (
    <PhoenixCard padding="16px">
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
        <div>
          <div style={{ fontSize: '14px', fontWeight: 700 }} dir="auto">{userName(user)}</div>
          <div style={{ fontSize: '11px', color: 'var(--t2)' }}>{t('um_permissions', lang)} · {t(roleLabelKey(user.role), lang)}</div>
        </div>
        <PhoenixStatusBadge variant="neutral" label={t(roleLabelKey(user.role), lang)} />
      </div>

      {migrationMissing && (
        <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)', padding: '8px 12px', marginBottom: '12px', fontSize: '11.5px', color: 'var(--warn)' }}>
          ⚠ {t('um_perm_unavailable', lang)}
        </div>
      )}

      {eff.loading && <PhoenixLoadingState label={t('loading', lang)} />}

      {!eff.loading && (
        <>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {Object.entries(modules).map(([mod, perms]) => {
              const open = !collapsed[mod];
              return (
                <div key={mod} style={{ border: '1px solid var(--brd)', borderRadius: 'var(--r2)', overflow: 'hidden' }}>
                  <button onClick={() => setCollapsed(c => ({ ...c, [mod]: open }))}
                    style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '9px 12px', background: 'var(--s2)', border: 'none', cursor: 'pointer', fontSize: '12.5px', fontWeight: 700, color: 'var(--t)', textAlign: 'start' }}>
                    <span>{t(`permmod_${mod}`, lang)}</span>
                    <span style={{ fontSize: '11px', color: 'var(--t2)' }}>{open ? '▾' : '▸'}</span>
                  </button>
                  {open && (
                    <div style={{ padding: '8px 12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                      {perms.map(p => {
                        const checked = current[p.key] ?? false;
                        const isDefault = defaults.has(p.key);
                        return (
                          <label key={p.key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: readOnly ? 'default' : 'pointer' }}>
                            <input type="checkbox" checked={checked} disabled={readOnly}
                              onChange={e => toggle(p.key, e.target.checked)} />
                            <span>{t(p.labelKey, lang)}</span>
                            {isDangerousPermission(p.key) && (
                              <span style={{ fontSize: '9.5px', fontWeight: 700, color: 'var(--err)', background: 'var(--err2)', padding: '1px 6px', borderRadius: 'var(--rpill)' }}>
                                ⚠ {t('um_dangerous', lang)}
                              </span>
                            )}
                            {checked !== isDefault && (
                              <span style={{ fontSize: '9.5px', color: 'var(--info)' }}>● {t('um_custom_perms', lang)}</span>
                            )}
                          </label>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {isMonthlyOfficer && <ContactSection orgId={user.organization_id} lang={lang} />}

          {!readOnly && (
            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end', marginTop: '14px' }}>
              <PhoenixButton variant="ghost" size="md" loading={busy} onClick={onReset}>
                {t('um_reset_defaults', lang)}
              </PhoenixButton>
              <PhoenixButton variant="primary" size="md" loading={busy} onClick={onSave}>
                {t('um_save', lang)}
              </PhoenixButton>
            </div>
          )}
        </>
      )}
    </PhoenixCard>
  );
}

/* ── Monthly Status Officer contact section ── */

function ContactSection({ orgId, lang }: { orgId: string | null; lang: 'ar' | 'en' }) {
  const contacts = useAsync(() => orgId ? getOrgStatusContacts(orgId) : Promise.resolve([]), [orgId]);
  return (
    <div style={{ marginTop: '14px', borderTop: '1px solid var(--brd)', paddingTop: '12px' }}>
      <div style={{ fontSize: '12.5px', fontWeight: 700, marginBottom: '6px' }}>{t('um_contact', lang)}</div>
      <div style={{ fontSize: '11px', color: 'var(--t2)', marginBottom: '8px' }}>{t('um_multi_officer', lang)}</div>
      {(contacts.data ?? []).length === 0 && (
        <div style={{ fontSize: '11.5px', color: 'var(--t3)', fontStyle: 'italic' }}>—</div>
      )}
      {(contacts.data ?? []).map(c => (
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', marginBottom: '4px' }}>
          <span dir="auto">{c.display_name}</span>
          <a href={`tel:${c.phone}`} style={{ color: 'var(--pd)', fontWeight: 700 }} dir="ltr">📞 {c.phone}</a>
          {c.is_primary && <PhoenixStatusBadge variant="ok" label="★" />}
        </div>
      ))}
    </div>
  );
}

/* ── Create user form (secure server path only) ── */

function CreateUserForm({ lang, isSuper, actorOrgId, onClose, onToast }: {
  lang: 'ar' | 'en';
  isSuper: boolean;
  actorOrgId: string | null;
  onClose: () => void;
  onToast: (m: string) => void;
}) {
  const orgs = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [orgId, setOrgId] = useState(actorOrgId ?? '');
  const [selRole, setSelRole] = useState<OfficialRole>('viewer');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Non-super cannot pick super_admin.
  const roleOptions = OFFICIAL_ROLES.filter(r => canTargetRole(isSuper ? 'super_admin' : 'viewer', r));
  const effectiveOrg = isSuper ? orgId : (actorOrgId ?? '');
  const canSubmit = fullName.trim() && email.trim() && effectiveOrg;

  async function onSubmit() {
    setError(null);
    if (selRole === 'super_admin' && !isSuper) { setError(t('um_cannot_create_super', lang)); return; }
    if (!isSuper && actorOrgId && effectiveOrg !== actorOrgId) { setError(t('um_cannot_create_outside_org', lang)); return; }
    setBusy(true);
    try {
      const res = await createUserViaEdge({ fullName: fullName.trim(), email: email.trim(), organizationId: effectiveOrg, role: selRole });
      if (res.edgeMissing) { setError(t('um_edge_disabled', lang)); return; }
      if (!res.ok) {
        if (res.error === 'CANNOT_CREATE_SUPER_ADMIN') setError(t('um_cannot_create_super', lang));
        else if (res.error === 'CROSS_ORG_FORBIDDEN') setError(t('um_cannot_create_outside_org', lang));
        else setError(t('um_edge_disabled', lang));
        return;
      }
      onToast(t('um_create_user', lang));
      onClose();
    } catch {
      setError(t('um_edge_disabled', lang));
    } finally { setBusy(false); }
  }

  return (
    <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '10px' }}>{t('um_create_user', lang)}</h3>
      <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)', padding: '8px 12px', marginBottom: '12px', fontSize: '11.5px', color: 'var(--warn)' }}>
        🔐 {t('um_server_only', lang)} · {t('um_create_disabled_hint', lang)}
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_full_name', lang)} *</label>
            <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} style={fieldStyle} dir="auto" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_email', lang)} *</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} style={fieldStyle} dir="ltr" />
          </div>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          {isSuper && (
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_organization', lang)} *</label>
              <select value={orgId} onChange={e => setOrgId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                <option value="">{t('um_organization', lang)}</option>
                {(orgs.data ?? []).map(o => <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>)}
              </select>
            </div>
          )}
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_role', lang)} *</label>
            <select value={selRole} onChange={e => setSelRole(e.target.value as OfficialRole)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
              {roleOptions.map(r => <option key={r} value={r}>{t(OFFICIAL_ROLE_LABEL_KEY[r], lang)}</option>)}
            </select>
          </div>
        </div>

        {error && <p style={{ fontSize: '12px', color: 'var(--err)' }} dir="auto">{error}</p>}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <PhoenixButton variant="ghost" size="md" onClick={onClose}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" loading={busy} disabled={!canSubmit} onClick={onSubmit}>
            {t('um_create_user', lang)}
          </PhoenixButton>
        </div>
      </div>
    </PhoenixCard>
  );
}
