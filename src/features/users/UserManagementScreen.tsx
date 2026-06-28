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
  disableUserViaEdge, enableUserViaEdge,
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

function statusVariant(status: string): 'ok' | 'warn' | 'err' | 'neutral' {
  if (status === 'active') return 'ok';
  if (status === 'suspended') return 'warn';
  return 'neutral';
}

function statusLabel(status: string, lang: 'ar' | 'en'): string {
  if (status === 'active')    return t('um_active', lang);
  if (status === 'suspended') return t('um_suspended', lang);
  return t('um_inactive', lang);
}

export function UserManagementScreen() {
  const { lang, role, activeOrgId, profile } = useApp();
  const isMobile = window.innerWidth < 768;
  const isSuper  = normalizeRole(role) === 'super_admin';

  const actorEff    = effectivePermissions(role);
  const canViewUsers = isSuper || actorEff.has('users.view');
  const canCreate    = isSuper || actorEff.has('users.create');
  const canManagePerms = isSuper || actorEff.has('users.manage_permissions');

  const [selectedId,   setSelectedId]   = useState<string | null>(null);
  const [search,       setSearch]       = useState('');
  const [filterRole,   setFilterRole]   = useState<string>('');
  const [showCreate,   setShowCreate]   = useState(false);
  const [toast,        setToast]        = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<ManagedUser | null>(null);

  const users = useAsync(() => listUsers(isSuper ? activeOrgId : undefined), [isSuper, activeOrgId]);

  function showToast(msg: string) { setToast(msg); setTimeout(() => setToast(null), 3200); }

  function afterLifecycle() {
    setSelectedId(null);
    users.reload();
  }

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
          lang={lang} isSuper={isSuper} actorRole={role} actorOrgId={activeOrgId}
          onClose={() => setShowCreate(false)} onToast={showToast}
          onCreated={() => { setShowCreate(false); users.reload(); }}
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
            const isSelf   = u.id === profile?.id;
            return (
              <PhoenixCard key={u.id} padding="12px 14px" onClick={() => setSelectedId(u.id)}
                style={{ cursor: 'pointer', border: selected ? '1px solid var(--p)' : undefined, background: selected ? 'var(--p2)' : undefined }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: '13px', fontWeight: 700 }} dir="auto">{userName(u)}</div>
                    {isSuper && <div style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="auto">{lang === 'ar' ? (u.org_name_ar ?? u.org_name ?? '—') : (u.org_name ?? u.org_name_ar ?? '—')}</div>}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
                    <PhoenixStatusBadge variant={statusVariant(u.status)} label={statusLabel(u.status, lang)} />
                    <PhoenixStatusBadge variant="neutral" label={t(roleLabelKey(u.role), lang)} />
                  </div>
                </div>

                {/* Lifecycle: disable/enable — super_admin only, not self.
                    Hard delete is gated pending USER-LIFECYCLE-DISABLE-DELETE-A finalization. */}
                {isSuper && !isSelf && (
                  <div style={{ display: 'flex', gap: '6px', marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--brd)' }}
                    onClick={e => e.stopPropagation()}>
                    {u.status === 'suspended' ? (
                      <PhoenixButton variant="ghost" size="md"
                        onClick={() => setDisableTarget(u)}>
                        ✅ {t('um_enable_user', lang)}
                      </PhoenixButton>
                    ) : (
                      <PhoenixButton variant="ghost" size="md" onClick={() => setDisableTarget(u)}>
                        🔕 {t('um_disable_user', lang)}
                      </PhoenixButton>
                    )}
                  </div>
                )}
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

      {/* Disable / Enable modal */}
      {disableTarget && (
        <DisableConfirmModal
          user={disableTarget} lang={lang}
          onCancel={() => setDisableTarget(null)}
          onConfirm={async () => {
            // Determine direction from the original live status in the user list.
            const enabling = ((users.data ?? []).find(u => u.id === disableTarget.id)?.status === 'suspended');

            const res = enabling
              ? await enableUserViaEdge(disableTarget.id)
              : await disableUserViaEdge(disableTarget.id);

            setDisableTarget(null);
            if (res.ok) {
              showToast(enabling ? t('um_user_enabled', lang) : t('um_user_disabled', lang));
              afterLifecycle();
            } else {
              showToast(res.error === 'LAST_SUPER_ADMIN'
                ? t('um_last_super_admin', lang)
                : t('um_lifecycle_failed', lang));
            }
          }}
          isEnable={((users.data ?? []).find(u => u.id === disableTarget.id)?.status === 'suspended')}
        />
      )}

      {/* Hard delete UI intentionally not shown — pending USER-LIFECYCLE-DISABLE-DELETE-A finalization.
          The admin-user-lifecycle Edge Function must be deployed and email-based confirmation
          must be wired before the delete flow is exposed in the UI. */}
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

  const [draft, setDraft]       = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy]         = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const migrationMissing = eff.data?.migrationMissing ?? false;
  const initialEff: Record<string, boolean> = (() => {
    if (eff.data?.permissions) return eff.data.permissions;
    const out: Record<string, boolean> = {};
    for (const p of PERMISSION_KEYS) out[p.key] = defaults.has(p.key);
    return out;
  })();

  const current  = draft ?? initialEff;
  const readOnly = !canManage || migrationMissing;

  const grantCtx: GrantContext = {
    actorRole,
    isSelf:    user.id === actorId,
    sameScope: isSuper,
  };

  function toggle(key: string, value: boolean) {
    setDraft(d => ({ ...(d ?? initialEff), [key]: value }));
  }

  async function onSave() {
    const overrides: OverrideMap = {};
    for (const p of PERMISSION_KEYS) {
      const cur  = current[p.key] ?? false;
      const init = initialEff[p.key] ?? false;
      if (cur === init) continue;
      overrides[p.key] = cur === defaults.has(p.key) ? null : cur;
    }
    if (Object.keys(overrides).length === 0) { onToast(t('um_saved', lang)); return; }

    const check = validateOverrides(grantCtx, overrides);
    if (!check.ok && check.rejected.length > 0) { onToast(t('um_cannot_grant', lang)); return; }

    setBusy(true);
    try {
      const res = await assignProfilePermissions(user.id, overrides);
      if (res.migrationMissing) { onToast(t('um_perm_unavailable', lang)); return; }
      if (!res.ok) { onToast(t('um_cannot_grant', lang)); return; }
      onToast(t('um_saved', lang));
      setDraft(null);
      eff.reload();
    } catch { onToast(t('load_error', lang)); }
    finally { setBusy(false); }
  }

  async function onReset() {
    setBusy(true);
    try {
      const res = await resetProfilePermissions(user.id);
      if (res.migrationMissing) { onToast(t('um_perm_unavailable', lang)); return; }
      onToast(t('um_reset_done', lang));
      setDraft(null);
      eff.reload();
    } catch { onToast(t('load_error', lang)); }
    finally { setBusy(false); }
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
                        const checked   = current[p.key] ?? false;
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

function CreateUserForm({ lang, isSuper, actorRole, actorOrgId, onClose, onToast, onCreated }: {
  lang: 'ar' | 'en';
  isSuper: boolean;
  actorRole: string;
  actorOrgId: string | null;
  onClose: () => void;
  onToast: (m: string) => void;
  onCreated: () => void;
}) {
  const orgs = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);

  const [mode,        setMode]        = useState<'password' | 'invite'>('invite');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [fullName,    setFullName]    = useState('');
  const [email,       setEmail]       = useState('');
  const [orgId,       setOrgId]       = useState(actorOrgId ?? '');
  const [selRole,     setSelRole]     = useState<OfficialRole>('viewer');
  const [password,    setPassword]    = useState('');
  const [confirm,     setConfirm]     = useState('');
  const [showPwd,     setShowPwd]     = useState(false);
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const isInstitutionAdmin = normalizeRole(actorRole) === 'institution_admin';
  const roleOptions   = OFFICIAL_ROLES.filter(r => canTargetRole(actorRole, r));
  const effectiveOrg  = isSuper ? orgId : (actorOrgId ?? '');
  const pwdValid      = mode === 'invite' || (password.length >= 8 && password === confirm);
  const canSubmit     = fullName.trim() && email.trim() && effectiveOrg && pwdValid;

  async function onSubmit() {
    setError(null);
    if (selRole === 'super_admin' && !isSuper) { setError(t('um_cannot_create_super', lang)); return; }
    if (selRole === 'institution_admin' && !isSuper) { setError(t('um_cannot_create_institution_admin', lang)); return; }
    if (!isSuper && actorOrgId && effectiveOrg !== actorOrgId) { setError(t('um_cannot_create_outside_org', lang)); return; }

    if (mode === 'password') {
      if (password.length < 8) { setError(t('um_password_too_short', lang)); return; }
      if (password !== confirm) { setError(t('um_passwords_no_match', lang)); return; }
    }

    setBusy(true);
    try {
      const res = await createUserViaEdge({
        fullName: fullName.trim(),
        email:    email.trim(),
        organizationId: effectiveOrg,
        role:     selRole,
        ...(mode === 'password' ? { password } : {}),
      });

      if (res.edgeMissing) { setError(t('um_edge_disabled', lang)); return; }
      if (!res.ok) {
        if (res.error === 'CANNOT_CREATE_SUPER_ADMIN')       setError(t('um_cannot_create_super', lang));
        else if (res.error === 'CANNOT_CREATE_INSTITUTION_ADMIN') setError(t('um_cannot_create_institution_admin', lang));
        else if (res.error === 'CROSS_ORG_FORBIDDEN')        setError(t('um_cannot_create_outside_org', lang));
        else if (res.error === 'PASSWORD_TOO_SHORT')         setError(t('um_password_too_short', lang));
        else setError(t('um_edge_disabled', lang));
        return;
      }

      // Success — show mode-appropriate message.
      if (res.passwordMode) {
        onToast(t('um_created_password', lang));
      } else if (res.invited) {
        onToast(t('um_created_invited', lang));
      } else {
        onToast(t('um_created_no_invite', lang));
      }
      onCreated();
    } catch {
      setError(t('um_edge_disabled', lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <PhoenixCard padding="18px" style={{ marginBottom: '16px' }}>
      <h3 style={{ fontSize: '14px', fontWeight: 700, marginBottom: '12px' }}>{t('um_create_user', lang)}</h3>

      {/* Primary invite-flow banner — always visible */}
      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r2)', padding: '10px 14px', marginBottom: '14px', fontSize: '12.5px', color: 'var(--info)', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
        <span style={{ flexShrink: 0 }}>📧</span>
        <span dir="auto">{t('um_invite_activation_msg', lang)}</span>
      </div>

      {/* Own-institution scope badge for institution_admin */}
      {isInstitutionAdmin && (
        <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '8px 12px', marginBottom: '10px', fontSize: '12px', color: 'var(--t2)', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <span>🏢</span>
          <span dir="auto">{t('um_invite_own_org_only', lang)}</span>
        </div>
      )}

      {/* Invite config note */}
      <div style={{ fontSize: '11px', color: 'var(--t3)', marginBottom: '14px' }}>
        {t('um_invite_notice', lang)}
      </div>

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* Name + Email */}
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

        {/* Org + Role */}
        <div style={{ display: 'grid', gridTemplateColumns: isSuper ? '1fr 1fr' : '1fr', gap: '12px' }}>
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

        {/* Advanced: set temporary password — hidden by default */}
        <div>
          <button type="button"
            onClick={() => {
              setShowAdvanced(s => {
                const next = !s;
                setMode(next ? 'password' : 'invite');
                if (!next) { setPassword(''); setConfirm(''); setError(null); }
                return next;
              });
            }}
            style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: '11.5px', color: 'var(--t2)', padding: 0, display: 'flex', alignItems: 'center', gap: '5px' }}>
            <span>{showAdvanced ? '▾' : '▸'}</span>
            <span>{showAdvanced ? t('um_hide_advanced', lang) : `🔑 ${t('um_advanced_options', lang)}`}</span>
          </button>

          {showAdvanced && (
            <div style={{ marginTop: '10px', padding: '12px 14px', background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)' }}>
              <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: '0 0 12px 0', fontWeight: 600 }} dir="auto">
                ⚠ {t('um_password_mode_warning', lang)}
              </p>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_password', lang)} *</label>
                  <div style={{ position: 'relative' }}>
                    <input type={showPwd ? 'text' : 'password'} value={password} onChange={e => setPassword(e.target.value)}
                      style={{ ...fieldStyle, paddingInlineEnd: '60px' }} autoComplete="new-password" dir="ltr" />
                    <button type="button" onClick={() => setShowPwd(s => !s)}
                      style={{ position: 'absolute', insetInlineEnd: '8px', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--t2)' }}>
                      {showPwd ? t('um_hide_password', lang) : t('um_show_password', lang)}
                    </button>
                  </div>
                </div>
                <div>
                  <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_confirm_password', lang)} *</label>
                  <input type={showPwd ? 'text' : 'password'} value={confirm} onChange={e => setConfirm(e.target.value)}
                    style={{ ...fieldStyle, borderColor: confirm && confirm !== password ? 'var(--err)' : undefined }}
                    autoComplete="new-password" dir="ltr" />
                </div>
              </div>
              {password && password.length < 8 && (
                <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: '8px 0 0 0' }}>{t('um_password_too_short', lang)}</p>
              )}
              {confirm && confirm !== password && (
                <p style={{ fontSize: '11.5px', color: 'var(--err)', margin: '8px 0 0 0' }}>{t('um_passwords_no_match', lang)}</p>
              )}
            </div>
          )}
        </div>

        {error && <p style={{ fontSize: '12px', color: 'var(--err)', margin: 0 }} dir="auto">{error}</p>}

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

/* ── Disable / Enable confirmation modal ── */

function DisableConfirmModal({ user, lang, onCancel, onConfirm, isEnable }: {
  user: ManagedUser;
  lang: 'ar' | 'en';
  onCancel: () => void;
  onConfirm: () => Promise<void>;
  isEnable: boolean;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: '16px' }}>
      <PhoenixCard padding="24px" style={{ maxWidth: '440px', width: '100%' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '10px' }}>
          {isEnable ? `✅ ${t('um_enable_user', lang)}` : `🔕 ${t('um_disable_user', lang)}`}
        </h3>
        <p style={{ fontSize: '13px', color: 'var(--t2)', marginBottom: '18px' }} dir="auto">
          <strong>{userName(user)}</strong> — {t('um_disable_confirm_q', lang)}
        </p>
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <PhoenixButton variant="ghost" size="md" disabled={busy} onClick={onCancel}>{t('cancel', lang)}</PhoenixButton>
          <PhoenixButton variant="primary" size="md" loading={busy}
            onClick={async () => { setBusy(true); await onConfirm(); setBusy(false); }}>
            {isEnable ? t('um_enable_user', lang) : t('um_disable_user', lang)}
          </PhoenixButton>
        </div>
      </PhoenixCard>
    </div>
  );
}

/* DeleteConfirmModal removed — pending USER-LIFECYCLE-DISABLE-DELETE-A.
   Hard delete requires email-based confirmation from ManagedUser (email field not
   currently fetched) and a deployed admin-user-lifecycle Edge Function. */
