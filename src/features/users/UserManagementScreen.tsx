import { lazy, Suspense, useEffect, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { useAsync } from '@/shared/lib/useAsync';
import {
  OFFICIAL_ROLES, OFFICIAL_ROLE_LABEL_KEY, roleLabelKey, canTargetRole, normalizeRole,
  type OfficialRole,
} from '@/shared/lib/roles';
import { normalizeUsername, validateUsername } from '@/shared/lib/username';
import {
  PERMISSION_KEYS, permissionsByModule, roleDefaults,
  validateOverrides, isDangerousPermission, type OverrideMap, type GrantContext,
} from '@/shared/lib/permissions';
import {
  listUsers, getEffectivePermissions, assignProfilePermissions,
  resetProfilePermissions, createUserViaEdge, getOrgStatusContacts,
  disableUserViaEdge, enableUserViaEdge, recycleUserViaEdge, rotatePasswordViaEdge,
  type ManagedUser,
} from '@/shared/supabase/services/users.service';
import { getOrganizations } from '@/shared/supabase/services/organizations.service';
import { useShadowObservation } from '@/shared/authz/useAuthorization';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixStatusBadge } from '@/shared/ui/PhoenixStatusBadge';
import { PhoenixOrgScope } from '@/shared/ui/PhoenixOrgScope';
import { PhoenixLoadingState } from '@/shared/ui/PhoenixLoadingState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixScreenHeader } from '@/shared/ui/PhoenixScreenHeader';
import { PhoenixNotice } from '@/shared/ui/PhoenixNotice';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixToast } from '@/shared/ui/PhoenixToast';
import { WhatsAppContactButton } from '@/shared/ui/WhatsAppContactButton';
import { buildMaterialContactMessage } from '@/shared/lib/whatsapp';
/**
 * AUTHENTICATED-SCREEN-SPLIT-B: lazy-load these two Super Admin-only panels
 * (same convention as AvailabilityCleanupWizard above — each already
 * Renders null internally for any non-super_admin role).
 */
const AvailabilityCleanupWizard = lazy(() =>
  import('@/features/admin/AvailabilityCleanupWizard').then(m => ({ default: m.AvailabilityCleanupWizard })),
);
const PlatformBroadcastAdminPanel = lazy(() =>
  import('@/features/platform-broadcast/PlatformBroadcastAdminPanel').then(m => ({ default: m.PlatformBroadcastAdminPanel })),
);

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

/** Business/client error codes that already have a specific, mapped message. */
const KNOWN_PERMISSION_CODES = new Set([
  'CANNOT_EDIT_OWN_PERMISSIONS', 'SELF_ESCALATION',
  'UNKNOWN_PERMISSION', 'NEEDS_AUTHORITY_FOR_DANGEROUS', 'CANNOT_GRANT_UNHELD',
]);

/**
 * Maps a permission-save RPC result (top-level ok:false) to a toast message.
 * Only a genuinely missing RPC shows the migration-010 message; only an
 * actual network/config failure shows the network message; a recognized
 * business/client code shows its specific message. If none of those apply —
 * a real but unclassified RPC failure (e.g. an ambiguous-function dispatch
 * error, an unexpected Postgres error) — the diagnostic code captured by
 * users.service.ts is shown instead of a bare, unhelpful generic message
 * (PERMISSION-RPC-CONTRACT-FIX-B).
 */
function permissionResultMessage(
  res: { ok: boolean; migrationMissing?: boolean; error?: string; diagnostics?: { diagnostic_code: string } },
  lang: 'ar' | 'en',
  successKey: string,
): string {
  if (res.ok) return t(successKey, lang);
  if (res.migrationMissing) return t('um_perm_unavailable', lang);
  if (res.error === 'NOT_CONFIGURED' || res.error === 'NETWORK_ERROR') return t('um_perm_network_error', lang);
  if (res.error && KNOWN_PERMISSION_CODES.has(res.error)) return messageForPermissionCodes([res.error], lang);
  const diag = res.diagnostics?.diagnostic_code;
  if (diag && diag !== 'SUCCESS') return `${t('um_perm_diag_prefix', lang)} ${diag}`;
  return t('um_perm_save_failed', lang);
}

/**
 * Maps a permission-grant error code (client-side GrantError or server-side
 * RPC business-logic code) to the specific, safe message the spec requires —
 * never the vague generic "Check administrator authority or access rules"
 * unless the code is genuinely unrecognized. Self-edit, unheld, dangerous,
 * and unknown-key codes from both the client pre-check (validateOverrides)
 * and the server RPC (per-key `rejected` array or top-level `error`) share
 * the same priority order, since they describe the same underlying rules.
 */
function messageForPermissionCodes(codes: string[], lang: 'ar' | 'en'): string {
  const priority: [string[], string][] = [
    [['CANNOT_EDIT_OWN_PERMISSIONS', 'SELF_ESCALATION'], 'um_perm_self_edit_blocked'],
    [['UNKNOWN_PERMISSION'], 'um_perm_unknown_key'],
    [['NEEDS_AUTHORITY_FOR_DANGEROUS'], 'um_perm_dangerous_unauthorized'],
    [['CANNOT_GRANT_UNHELD'], 'um_perm_unheld'],
  ];
  for (const [matchCodes, key] of priority) {
    if (codes.some(c => matchCodes.includes(c))) return t(key, lang);
  }
  return t('um_perm_save_failed', lang);
}

export function UserManagementScreen() {
  // `authz` sits before myPermissions deliberately: permission-persistence.test.ts
  // pins the exact `myPermissions, reloadMyPermissions } = useApp()` text as its
  // proof that actor gating reads the context rather than the hardcoded table.
  // That guard is still true and worth keeping — so this addition works around
  // it rather than editing it.
  const { lang, role, activeOrgId, profile, authz, myPermissions, reloadMyPermissions } = useApp();
  const isMobile = window.innerWidth < 768;
  const isSuper  = normalizeRole(role) === 'super_admin';

  // PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE: observe the two scope-
  // administration keys migration 062 introduced for this screen. Observation
  // only — no scope-management UI is activated in this phase, and neither key
  // gates anything here. The mismatch report tells us what enforcing them later
  // would change, before it changes for anyone.
  useShadowObservation(authz, 'users.edit_scope',        { organizationId: activeOrgId });
  useShadowObservation(authz, 'users.reset_permissions', { organizationId: activeOrgId });

  // myPermissions is the actor's DB-backed effective permission set (role
  // defaults + their own profile_permission_overrides), loaded fresh on
  // login by AppContext — never the hardcoded role-default table alone.
  // Guard against a load race: if this screen mounts before AppContext's
  // async load finishes, myPermissions is still the empty initial Set.
  // Proactively reload once rather than letting a save attempt run against
  // stale/empty data (PERMISSION-SAVE-RPC-DIAGNOSTIC-FIX-A).
  useEffect(() => {
    if (myPermissions.size === 0) reloadMyPermissions();
  }, []);

  const actorEff    = myPermissions;
  const canViewUsers = isSuper || actorEff.has('users.view');
  const canCreate    = isSuper || actorEff.has('users.create');
  const canManagePerms = isSuper || actorEff.has('users.manage_permissions');
  const canRecycle   = isSuper || actorEff.has('users.recycle');

  const [selectedId,   setSelectedId]   = useState<string | null>(null);
  const [search,       setSearch]       = useState('');
  const [filterRole,   setFilterRole]   = useState<string>('');
  const [showCreate,   setShowCreate]   = useState(false);
  const [toast,        setToast]        = useState<string | null>(null);
  const [disableTarget, setDisableTarget] = useState<ManagedUser | null>(null);
  const [recycleTarget, setRecycleTarget] = useState<ManagedUser | null>(null);
  const [rotateTarget, setRotateTarget] = useState<ManagedUser | null>(null);

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
      <div className="premium-page nexus-users-page" style={{ maxWidth: '900px', animation: 'fs .3s ease' }}>
        <PhoenixScreenHeader icon="users" eyebrow="PHOENIX RBAC · PROTECTED" title={t('um_title', lang)} description={t('um_multi_officer', lang)} />
        <PhoenixEmptyState icon="lock" title={t('um_no_users_perm', lang)} description={t('um_server_only', lang)} />
      </div>
    );
  }

  return (
    <div className="premium-page nexus-users-page" style={{ maxWidth: '1100px', animation: 'fs .3s ease' }}>
      <PhoenixScreenHeader
        icon="users"
        eyebrow={lang === 'ar' ? 'PHOENIX RBAC · إدارة مضبوطة' : 'PHOENIX RBAC · CONTROLLED ADMINISTRATION'}
        title={t('um_title', lang)}
        description={t('um_multi_officer', lang)}
        actions={<>
          {isSuper && <PhoenixOrgScope />}
          {canCreate && (
            <PhoenixButton variant="primary" size="md" onClick={() => setShowCreate(s => !s)}>
              + {t('um_create_user', lang)}
            </PhoenixButton>
          )}
        </>}
      />

      {/* Secure server-path notice */}
      <PhoenixNotice tone="neutral" icon="shield">{t('um_server_only', lang)}</PhoenixNotice>

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
          <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', color: 'var(--t3)', pointerEvents: 'none' }}><PhoenixIcon name="search" size={16} /></span>
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
            <PhoenixEmptyState icon="users" title={t('um_empty', lang)} description={t('um_multi_officer', lang)} />
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
                  <div style={{ display: 'flex', gap: '6px', flexWrap: 'wrap', marginTop: '10px', paddingTop: '8px', borderTop: '1px solid var(--brd)' }}
                    onClick={e => e.stopPropagation()}>
                    {u.status === 'suspended' ? (
                      <>
                        <PhoenixButton variant="ghost" size="md"
                          onClick={() => setDisableTarget(u)}>
                          <PhoenixIcon name="check" size={15} /> {t('um_enable_user', lang)}
                        </PhoenixButton>
                        {canRecycle && normalizeRole(u.role) !== 'super_admin' && (
                          <PhoenixButton variant="ghost" size="md"
                            onClick={() => setRecycleTarget(u)}>
                            <PhoenixIcon name="refresh" size={15} /> {t('um_recycle_account', lang)}
                          </PhoenixButton>
                        )}
                      </>
                    ) : (
                      <>
                        <PhoenixButton variant="ghost" size="md" onClick={() => setDisableTarget(u)}>
                          <PhoenixIcon name="lock" size={15} /> {t('um_disable_user', lang)}
                        </PhoenixButton>
                        <PhoenixButton variant="ghost" size="md" onClick={() => setRotateTarget(u)}>
                          <PhoenixIcon name="key" size={15} /> {t('um_rotate_password', lang)}
                        </PhoenixButton>
                      </>
                    )}
                  </div>
                )}
              </PhoenixCard>
            );
          })}
        </div>

        {/* Selected-user panel: summary by default, permission matrix only when explicitly opened */}
        <div>
          {!selectedUser && (
            <PhoenixEmptyState icon="scope" title={t('um_select_user', lang)} description={t('um_permissions', lang)} />
          )}
          {selectedUser && (
            <UserPermissionsPanel
              key={selectedUser.id}
              user={selectedUser} lang={lang} actorRole={role} isSuper={isSuper}
              actorId={profile?.id ?? ''} actorPermissions={actorEff}
              canManage={canManagePerms} onToast={showToast}
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

      {/* Recycle account modal */}
      {recycleTarget && canRecycle && (
        <RecycleConfirmModal
          user={recycleTarget} lang={lang} isSuper={isSuper}
          actorOrgId={activeOrgId}
          onCancel={() => setRecycleTarget(null)}
          onSuccess={(msg) => { setRecycleTarget(null); showToast(msg); afterLifecycle(); }}
          onError={(msg) => showToast(msg)}
        />
      )}

      {/* Rotate temporary password modal */}
      {rotateTarget && (
        <RotatePasswordModal
          user={rotateTarget} lang={lang}
          onCancel={() => setRotateTarget(null)}
          onDone={() => { setRotateTarget(null); afterLifecycle(); }}
        />
      )}

      {/* Hard delete UI intentionally not shown — pending USER-LIFECYCLE-DISABLE-DELETE-A finalization.
          The admin-user-lifecycle Edge Function must be deployed and email-based confirmation
          must be wired before the delete flow is exposed in the UI. */}

      {/* PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A: Super Admin-only maintenance wizard.
          Renders null internally for any non-super_admin role — this screen
          is already the safest existing super_admin-oriented admin area.
          AUTHENTICATED-SCREEN-SPLIT-B: lazy-loaded here too. */}
      {normalizeRole(role) === 'super_admin' && (
        <Suspense fallback={<PhoenixLoadingState />}>
          <AvailabilityCleanupWizard lang={lang} role={role} />
        </Suspense>
      )}

      {/* PHASE3-PLATFORM-BROADCAST-NOTICES-A: Super Admin-only broadcast
          management panel. Renders null internally for any non-super_admin
          role, same convention as AvailabilityCleanupWizard above.
          AUTHENTICATED-SCREEN-SPLIT-B: lazy-loaded here too. */}
      {normalizeRole(role) === 'super_admin' && (
        <Suspense fallback={<PhoenixLoadingState />}>
          <PlatformBroadcastAdminPanel lang={lang} role={role} />
        </Suspense>
      )}
    </div>
  );
}

/* ── User permissions panel: summary by default, matrix only when opened ── */
/* PERMISSION-MATRIX-UX-HARDENING-A: permission checkboxes are never shown
   by default. The actor must explicitly click "Manage this user's
   permissions" before any permission data loads or renders. This is a UX
   convenience only — every server-side RPC check (self-edit block,
   users.manage_permissions requirement, dangerous-permission authority,
   institution_admin scope) remains the real security boundary, completely
   unaffected by whether this panel is open or closed. */

function UserPermissionsPanel({ user, lang, actorRole, isSuper, actorId, actorPermissions, canManage, onToast }: {
  user: ManagedUser;
  lang: 'ar' | 'en';
  actorRole: string;
  isSuper: boolean;
  actorId: string;
  actorPermissions: Set<string>;
  canManage: boolean;
  onToast: (m: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const isSelf = user.id === actorId;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
      <PhoenixCard padding="16px">
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap', marginBottom: '10px' }}>
          <div>
            <div style={{ fontSize: '14px', fontWeight: 700 }} dir="auto">{userName(user)}</div>
            <div style={{ fontSize: '11px', color: 'var(--t2)' }} dir="ltr">
              {user.username ?? '—'}
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '6px', flexShrink: 0 }}>
            <PhoenixStatusBadge variant={statusVariant(user.status)} label={statusLabel(user.status, lang)} />
            <PhoenixStatusBadge variant="neutral" label={t(roleLabelKey(user.role), lang)} />
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', fontSize: '12px', color: 'var(--t2)' }}>
          <InfoLine label={t('um_organization', lang)} value={lang === 'ar' ? (user.org_name_ar ?? user.org_name ?? '—') : (user.org_name ?? user.org_name_ar ?? '—')} />
        </div>

        {!open ? (
          <div style={{ marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--brd)' }}>
            {isSelf ? (
              <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: 0 }} dir="auto">
                <PhoenixIcon name="warning" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('um_perm_self_edit_session_note', lang)}
              </p>
            ) : canManage ? (
              <PhoenixButton variant="primary" size="md" onClick={() => setOpen(true)}>
                <PhoenixIcon name="shield" size={15} /> {t('um_manage_user_permissions', lang)}
              </PhoenixButton>
            ) : (
              <p style={{ fontSize: '11.5px', color: 'var(--t2)', margin: 0 }} dir="auto">
                {t('um_no_manage_permissions_note', lang)}
              </p>
            )}
            <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '8px' }} dir="auto">
              {t('um_permissions_hidden_note', lang)}
            </p>
          </div>
        ) : (
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '12px', paddingTop: '10px', borderTop: '1px solid var(--brd)' }}>
            <PhoenixButton variant="ghost" size="md" onClick={() => setOpen(false)}>
              {t('um_hide_permissions', lang)}
            </PhoenixButton>
          </div>
        )}
      </PhoenixCard>

      {open && (
        <PermissionMatrix
          user={user} lang={lang} actorRole={actorRole} isSuper={isSuper}
          actorId={actorId} actorPermissions={actorPermissions}
          canManage={canManage} onToast={onToast}
        />
      )}
    </div>
  );
}

function InfoLine({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
      <span>{label}</span>
      <span style={{ fontWeight: 600, color: 'var(--t)' }} dir="auto">{value}</span>
    </div>
  );
}

/* ── Permission matrix (rendered only once explicitly opened) ── */

function PermissionMatrix({ user, lang, actorRole, isSuper, actorId, actorPermissions, canManage, onToast }: {
  user: ManagedUser;
  lang: 'ar' | 'en';
  actorRole: string;
  isSuper: boolean;
  actorId: string;
  /** Actor's own DB-backed effective permissions (role defaults + their overrides). */
  actorPermissions: Set<string>;
  canManage: boolean;
  onToast: (m: string) => void;
}) {
  const defaults = roleDefaults(user.role);
  const eff = useAsync(() => getEffectivePermissions(user.id), [user.id]);

  const [draft, setDraft]       = useState<Record<string, boolean> | null>(null);
  const [busy, setBusy]         = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [permSearch, setPermSearch] = useState('');

  // migrationMissing means the permission-matrix RPC is genuinely absent
  // (a true migration gap). loadError covers every other reason the read
  // failed (network, RLS, an unrelated runtime error) — neither case may be
  // misreported as the other (PERMISSION-MATRIX-010-GUARD-FIX-A).
  const migrationMissing = eff.data?.migrationMissing ?? false;
  const loadError = eff.data?.loadError;
  const initialEff: Record<string, boolean> = (() => {
    if (eff.data?.permissions) return eff.data.permissions;
    const out: Record<string, boolean> = {};
    for (const p of PERMISSION_KEYS) out[p.key] = defaults.has(p.key);
    return out;
  })();

  const current  = draft ?? initialEff;
  // Read-only whenever we don't have confirmed DB data to edit against —
  // editing on top of a synthesized role-default fallback would silently
  // discard any real overrides the read failed to fetch.
  const readOnly = !canManage || migrationMissing || !!loadError;

  // Diff the actor's DB-backed effective permissions against their role
  // defaults so the client-side grant-authority pre-check (validateOverrides)
  // reflects any overrides actually persisted for the actor — not just their
  // hardcoded role defaults. The server-side RPC re-validates independently;
  // this only avoids a misleading "cannot grant" UI message.
  //
  // GUARD: actorPermissions starts as an empty Set until AppContext's async
  // load completes. An empty effective set is never legitimate for any real
  // account (every role gets at least dashboard.view by default) — diffing
  // against an empty set would wrongly mark EVERY permission as an explicit
  // override the actor doesn't hold, including for super_admin, who would
  // then fail their own authority check while saving someone else's
  // permissions. Treat "empty" as "not loaded yet" and skip the diff,
  // falling back to pure role defaults instead (PERMISSION-SAVE-RPC-DIAGNOSTIC-FIX-A).
  const actorOverrides: OverrideMap = {};
  if (actorPermissions.size > 0) {
    const actorDefaults = roleDefaults(actorRole);
    for (const p of PERMISSION_KEYS) {
      const has = actorPermissions.has(p.key);
      if (has !== actorDefaults.has(p.key)) actorOverrides[p.key] = has;
    }
  }

  const grantCtx: GrantContext = {
    actorRole,
    actorOverrides,
    isSelf:    user.id === actorId,
    sameScope: isSuper,
  };

  // Included only as diagnostic context on save/reset failures — never used
  // to bypass the server-side RPC's own authority check.
  const actorHasManagePermissions = isSuper || actorPermissions.has('users.manage_permissions');

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
    if (!check.ok && check.rejected.length > 0) {
      onToast(messageForPermissionCodes(check.rejected.map(r => r.error), lang));
      return;
    }

    setBusy(true);
    try {
      const res = await assignProfilePermissions(user.id, overrides, actorHasManagePermissions);
      if (!res.ok) {
        onToast(permissionResultMessage(res, lang, 'um_saved'));
        return;
      }
      // The RPC can succeed overall (ok:true) while rejecting individual
      // keys (e.g. an unknown key, or a dangerous permission the actor
      // doesn't hold) — never report this as a plain "saved" success.
      if (res.rejected && res.rejected.length > 0) {
        onToast(messageForPermissionCodes(res.rejected.map(r => r.error), lang));
      } else {
        onToast(t('um_saved', lang));
      }
      setDraft(null);
      eff.reload();
    } catch { onToast(t('um_perm_network_error', lang)); }
    finally { setBusy(false); }
  }

  async function onReset() {
    setBusy(true);
    try {
      const res = await resetProfilePermissions(user.id, actorHasManagePermissions);
      onToast(permissionResultMessage(res, lang, 'um_reset_done'));
      if (res.ok) {
        setDraft(null);
        eff.reload();
      }
    } catch { onToast(t('um_perm_network_error', lang)); }
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
          <PhoenixIcon name="warning" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('um_perm_unavailable', lang)}
        </div>
      )}
      {!migrationMissing && loadError && (
        <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)', padding: '8px 12px', marginBottom: '12px', fontSize: '11.5px', color: 'var(--warn)' }}>
          <PhoenixIcon name="warning" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t(loadError === 'UNKNOWN_ERROR' ? 'load_error' : 'um_perm_network_error', lang)}
        </div>
      )}

      {!readOnly && (
        <div style={{ background: 'var(--err2)', border: '1px solid var(--err)', borderRadius: 'var(--r2)', padding: '8px 12px', marginBottom: '12px', fontSize: '11.5px', color: 'var(--err)' }} dir="auto">
          <PhoenixIcon name="warning" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('um_editing_sensitive_permissions', lang)}
        </div>
      )}

      {eff.loading && <PhoenixLoadingState label={t('loading', lang)} />}

      {!eff.loading && (
        <>
          <div style={{ position: 'relative', marginBottom: '10px' }}>
            <span style={{ position: 'absolute', insetInlineStart: '10px', top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none' }}><PhoenixIcon name="search" size={14} /></span>
            <input type="search" placeholder={t('um_search_permissions', lang)} value={permSearch} onChange={e => setPermSearch(e.target.value)}
              style={{ ...fieldStyle, paddingInlineStart: '32px' }} aria-label={t('um_search_permissions', lang)} />
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            {Object.entries(modules)
              .map(([mod, perms]) => {
                const q = permSearch.trim().toLowerCase();
                const filtered = q
                  ? perms.filter(p => t(p.labelKey, lang).toLowerCase().includes(q) || p.key.toLowerCase().includes(q))
                  : perms;
                return [mod, filtered] as const;
              })
              .filter(([, perms]) => perms.length > 0)
              .map(([mod, perms]) => {
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
                                <PhoenixIcon name="warning" size={11} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '3px' }} /> {t('um_dangerous', lang)}
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
        <div key={c.id} style={{ display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap', fontSize: '12px', marginBottom: '4px' }}>
          <span dir="auto">{c.display_name}</span>
          <a href={`tel:${c.phone}`} style={{ color: 'var(--pd)', fontWeight: 700, display: 'inline-flex', alignItems: 'center', gap: '4px' }} dir="ltr"><PhoenixIcon name="phone" size={14} /> {c.phone}</a>
          {c.is_primary && <PhoenixStatusBadge variant="ok" label={lang === 'ar' ? 'أساسي' : 'Primary'} icon={<PhoenixIcon name="star" size={11} />} />}
          {/* UX-WHATSAPP-INSTITUTION-CONTACT-A: reuses this exact already-loaded
              contact phone — no new fetch, no fake number. */}
          <WhatsAppContactButton
            phone={c.phone}
            lang={lang}
            message={buildMaterialContactMessage({}, lang)}
          />
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

  // Local username + temporary password is the only normal create path
  // (LOCAL-UX-PERMISSION-PERSISTENCE-FIX-A). Email/invite mode still exists
  // server-side (users.service.ts / admin-create-user) for compatibility but
  // is not offered in this form.
  const [fullName,    setFullName]    = useState('');
  const [username,    setUsername]    = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [tempConfirm,  setTempConfirm]  = useState('');
  const [showTempPwd,  setShowTempPwd]  = useState(false);
  const [orgId,       setOrgId]       = useState(actorOrgId ?? '');
  const [selRole,     setSelRole]     = useState<OfficialRole>('viewer');
  const [busy,        setBusy]        = useState(false);
  const [error,       setError]       = useState<string | null>(null);

  const isInstitutionAdmin = normalizeRole(actorRole) === 'institution_admin';
  const roleOptions   = OFFICIAL_ROLES.filter(r => canTargetRole(actorRole, r));
  const effectiveOrg  = isSuper ? orgId : (actorOrgId ?? '');
  const localValid    = validateUsername(username) && tempPassword.length >= 8 && tempPassword === tempConfirm;
  const canSubmit     = Boolean(fullName.trim() && username.trim() && effectiveOrg && localValid);

  async function onSubmit() {
    setError(null);
    if (selRole === 'super_admin' && !isSuper) { setError(t('um_cannot_create_super', lang)); return; }
    if (selRole === 'institution_admin' && !isSuper) { setError(t('um_cannot_create_institution_admin', lang)); return; }
    if (!isSuper && actorOrgId && effectiveOrg !== actorOrgId) { setError(t('um_cannot_create_outside_org', lang)); return; }

    if (!validateUsername(username)) { setError(t('um_username_invalid', lang)); return; }
    if (tempPassword.length < 8) { setError(t('um_password_too_short', lang)); return; }
    if (tempPassword !== tempConfirm) { setError(t('um_passwords_no_match', lang)); return; }

    setBusy(true);
    try {
      const res = await createUserViaEdge({
        fullName: fullName.trim(),
        organizationId: effectiveOrg,
        role: selRole,
        loginMode: 'local',
        username: normalizeUsername(username),
        temporaryPassword: tempPassword,
        ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
      });

      if (res.edgeMissing) { setError(t('um_edge_disabled', lang)); return; }
      if (!res.ok) {
        if (res.error === 'CANNOT_CREATE_SUPER_ADMIN')       setError(t('um_cannot_create_super', lang));
        else if (res.error === 'CANNOT_CREATE_INSTITUTION_ADMIN') setError(t('um_cannot_create_institution_admin', lang));
        else if (res.error === 'CROSS_ORG_FORBIDDEN')        setError(t('um_cannot_create_outside_org', lang));
        else if (res.error === 'PASSWORD_TOO_SHORT')         setError(t('um_password_too_short', lang));
        else if (res.error === 'INVALID_USERNAME')           setError(t('um_username_invalid', lang));
        else setError(t('um_edge_disabled', lang));
        return;
      }

      onToast(t('um_created_local', lang));
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

      <div style={{ background: 'var(--info2)', border: '1px solid var(--info)', borderRadius: 'var(--r2)', padding: '10px 14px', marginBottom: '14px', fontSize: '12.5px', color: 'var(--info)', display: 'flex', gap: '8px', alignItems: 'flex-start' }}>
        <PhoenixIcon name="key" size={16} style={{ flexShrink: 0 }} />
        <span dir="auto">{t('um_local_creation_msg', lang)}</span>
      </div>

      {/* Own-institution scope badge for institution_admin */}
      {isInstitutionAdmin && (
        <div style={{ background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', padding: '8px 12px', marginBottom: '10px', fontSize: '12px', color: 'var(--t2)', display: 'flex', gap: '6px', alignItems: 'center' }}>
          <PhoenixIcon name="institutions" size={15} />
          <span dir="auto">{t('um_invite_own_org_only', lang)}</span>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
        {/* Name + Username */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_full_name', lang)} *</label>
            <input type="text" value={fullName} onChange={e => setFullName(e.target.value)} style={fieldStyle} dir="auto" />
          </div>
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_username', lang)} *</label>
            <input type="text" value={username} onChange={e => setUsername(e.target.value)}
              style={{ ...fieldStyle, borderColor: username && !validateUsername(username) ? 'var(--err)' : undefined }}
              dir="ltr" autoComplete="off" placeholder="ali.pharmacy" />
          </div>
        </div>

        {username && !validateUsername(username) && (
          <p style={{ fontSize: '11.5px', color: 'var(--err)', margin: 0 }}>{t('um_username_invalid', lang)}</p>
        )}

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

        {/* Temporary password */}
        <div style={{ padding: '12px 14px', background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)' }}>
          <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: '0 0 12px 0', fontWeight: 600 }} dir="auto">
            <PhoenixIcon name="warning" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('um_password_mode_warning', lang)}
          </p>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_password', lang)} *</label>
              <div style={{ position: 'relative' }}>
                <input type={showTempPwd ? 'text' : 'password'} value={tempPassword} onChange={e => setTempPassword(e.target.value)}
                  style={{ ...fieldStyle, paddingInlineEnd: '60px' }} autoComplete="new-password" dir="ltr" />
                <button type="button" onClick={() => setShowTempPwd(s => !s)}
                  style={{ position: 'absolute', insetInlineEnd: '8px', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--t2)' }}>
                  {showTempPwd ? t('um_hide_password', lang) : t('um_show_password', lang)}
                </button>
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_confirm_password', lang)} *</label>
              <input type={showTempPwd ? 'text' : 'password'} value={tempConfirm} onChange={e => setTempConfirm(e.target.value)}
                style={{ ...fieldStyle, borderColor: tempConfirm && tempConfirm !== tempPassword ? 'var(--err)' : undefined }}
                autoComplete="new-password" dir="ltr" />
            </div>
          </div>
          {tempPassword && tempPassword.length < 8 && (
            <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: '8px 0 0 0' }}>{t('um_password_too_short', lang)}</p>
          )}
          {tempConfirm && tempConfirm !== tempPassword && (
            <p style={{ fontSize: '11.5px', color: 'var(--err)', margin: '8px 0 0 0' }}>{t('um_passwords_no_match', lang)}</p>
          )}
        </div>

        <div>
          <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_contact_email_optional', lang)}</label>
          <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} style={fieldStyle} dir="ltr" />
          <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="auto">{t('um_contact_email_not_for_login', lang)}</p>
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
    <div className="nexus-legacy-dialog" role="dialog" aria-modal="true" aria-label={isEnable ? t('um_enable_user', lang) : t('um_disable_user', lang)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: '16px' }}>
      <PhoenixCard className="premium-dialog-panel nexus-legacy-dialog__panel" padding="24px" style={{ maxWidth: '440px', width: '100%' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '10px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}><PhoenixIcon name={isEnable ? 'check' : 'lock'} size={17} /> {isEnable ? t('um_enable_user', lang) : t('um_disable_user', lang)}</span>
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

/* ── Rotate temporary password modal ──
   Two steps in one modal: (1) confirm + enter a new temporary password for an
   ACTIVE user (no identity change — distinct from account recycling, which
   requires the target to already be suspended); (2) show the new password
   exactly once after a successful reset, with the required one-time warning,
   then discard it from state on close. The password never leaves this
   component's local state and is never logged. */

function RotatePasswordModal({ user, lang, onCancel, onDone }: {
  user: ManagedUser;
  lang: 'ar' | 'en';
  onCancel: () => void;
  onDone: () => void;
}) {
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [resultPassword, setResultPassword] = useState<string | null>(null);

  const valid = newPassword.length >= 8 && newPassword === confirmPassword;

  async function onConfirm() {
    setError(null);
    if (newPassword.length < 8) { setError(t('um_password_too_short', lang)); return; }
    if (newPassword !== confirmPassword) { setError(t('um_passwords_no_match', lang)); return; }

    setBusy(true);
    try {
      const res = await rotatePasswordViaEdge(user.id, newPassword);
      if (res.ok) {
        // Shown exactly once, from the value already held locally — the
        // server never echoes the password back.
        setResultPassword(newPassword);
      } else {
        setError(res.error === 'LAST_SUPER_ADMIN' ? t('um_last_super_admin', lang) : t('um_rotate_password_failed', lang));
      }
    } catch {
      setError(t('um_rotate_password_failed', lang));
    } finally {
      setBusy(false);
      setNewPassword('');
      setConfirmPassword('');
    }
  }

  function handleClose() {
    setResultPassword(null);
    if (resultPassword) onDone();
    else onCancel();
  }

  return (
    <div className="nexus-legacy-dialog" role="dialog" aria-modal="true" aria-label={t('um_rotate_password', lang)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: '16px' }}>
      <PhoenixCard className="premium-dialog-panel nexus-legacy-dialog__panel" padding="24px" style={{ maxWidth: '440px', width: '100%' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '10px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}><PhoenixIcon name="key" size={17} /> {t('um_rotate_password', lang)}</span>
        </h3>

        {!resultPassword ? (
          <>
            <p style={{ fontSize: '13px', color: 'var(--t2)', marginBottom: '14px' }} dir="auto">
              <strong>{userName(user)}</strong> — {t('um_rotate_password_confirm_q', lang)}
            </p>

            <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '10px' }}>
              <div>
                <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_rotate_password_new', lang)} *</label>
                <div style={{ position: 'relative' }}>
                  <input type={showPwd ? 'text' : 'password'} value={newPassword} onChange={e => setNewPassword(e.target.value)}
                    style={{ ...fieldStyle, paddingInlineEnd: '60px' }} autoComplete="new-password" dir="ltr" />
                  <button type="button" onClick={() => setShowPwd(s => !s)}
                    style={{ position: 'absolute', insetInlineEnd: '8px', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--t2)' }}>
                    {showPwd ? t('um_hide_password', lang) : t('um_show_password', lang)}
                  </button>
                </div>
              </div>
              <div>
                <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_confirm_password', lang)} *</label>
                <input type={showPwd ? 'text' : 'password'} value={confirmPassword} onChange={e => setConfirmPassword(e.target.value)}
                  style={{ ...fieldStyle, borderColor: confirmPassword && confirmPassword !== newPassword ? 'var(--err)' : undefined }}
                  autoComplete="new-password" dir="ltr" />
              </div>
              {newPassword && newPassword.length < 8 && (
                <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: 0 }}>{t('um_password_too_short', lang)}</p>
              )}
              {confirmPassword && confirmPassword !== newPassword && (
                <p style={{ fontSize: '11.5px', color: 'var(--err)', margin: 0 }}>{t('um_passwords_no_match', lang)}</p>
              )}
            </div>

            {error && <p style={{ fontSize: '12px', color: 'var(--err)', marginBottom: '10px' }} dir="auto">{error}</p>}

            <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
              <PhoenixButton variant="ghost" size="md" disabled={busy} onClick={onCancel}>{t('cancel', lang)}</PhoenixButton>
              <PhoenixButton variant="primary" size="md" loading={busy} disabled={!valid} onClick={onConfirm}>
                {t('um_rotate_password', lang)}
              </PhoenixButton>
            </div>
          </>
        ) : (
          <>
            <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)', padding: '10px 14px', marginBottom: '14px', fontSize: '12px', color: 'var(--warn)', fontWeight: 600 }} dir="auto">
              <PhoenixIcon name="warning" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('um_rotate_password_show_once', lang)}
            </div>
            <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '6px' }} dir="auto">{t('um_rotate_password_success', lang)}</p>
            <div style={{ padding: '10px 12px', background: 'var(--s2)', border: '1px solid var(--brd)', borderRadius: 'var(--r2)', fontSize: '14px', fontWeight: 700, marginBottom: '16px', wordBreak: 'break-all' }} dir="ltr">
              {resultPassword}
            </div>
            <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
              <PhoenixButton variant="primary" size="md" onClick={handleClose}>
                {t('um_rotate_password_close', lang)}
              </PhoenixButton>
            </div>
          </>
        )}
      </PhoenixCard>
    </div>
  );
}

/* ── Recycle account modal ── */

function RecycleConfirmModal({ user, lang, isSuper, actorOrgId, onCancel, onSuccess, onError }: {
  user: ManagedUser;
  lang: 'ar' | 'en';
  isSuper: boolean;
  actorOrgId: string | null;
  onCancel: () => void;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
}) {
  const orgs = useAsync(() => isSuper ? getOrganizations() : Promise.resolve([]), [isSuper]);

  // Local username + temporary password is the only normal recycle path
  // (LOCAL-UX-PERMISSION-PERSISTENCE-FIX-A). Email-mode recycle still exists
  // server-side (users.service.ts / admin-recycle-user) for compatibility but
  // is not offered in this modal.
  const [newName,    setNewName]    = useState('');
  const [newUsername, setNewUsername] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [tempPassword, setTempPassword] = useState('');
  const [tempConfirm,  setTempConfirm]  = useState('');
  const [showTempPwd,  setShowTempPwd]  = useState(false);
  const [newRole,    setNewRole]    = useState<OfficialRole>('viewer');
  const [newOrgId,   setNewOrgId]   = useState(user.organization_id ?? actorOrgId ?? '');
  const [confirm,    setConfirm]    = useState('');
  const [busy,       setBusy]       = useState(false);

  const roleOptions = OFFICIAL_ROLES.filter(r => canTargetRole(isSuper ? 'super_admin' : 'institution_admin', r));
  const expectedConfirm = `RECYCLE_USER_${user.id}`;
  const localValid = validateUsername(newUsername) && tempPassword.length >= 8 && tempPassword === tempConfirm;
  const canSubmit = Boolean(newName.trim() && localValid && confirm === expectedConfirm);

  async function onSubmit() {
    setBusy(true);
    try {
      const res = await recycleUserViaEdge({
        targetProfileId: user.id,
        newFullName: newName.trim(),
        newRole,
        loginMode: 'local',
        newUsername: normalizeUsername(newUsername),
        newTemporaryPassword: tempPassword,
        ...(contactEmail.trim() ? { contactEmail: contactEmail.trim() } : {}),
        ...(isSuper && newOrgId !== user.organization_id ? { newOrganizationId: newOrgId } : {}),
        confirmation: confirm,
      });

      if (res.edgeMissing) { onError(t('um_edge_disabled', lang)); return; }
      if (!res.ok) {
        if (res.error === 'TARGET_NOT_SUSPENDED')      onError(t('um_recycle_must_suspend', lang));
        else if (res.error === 'SELF_ACTION_FORBIDDEN') onError(t('um_recycle_no_self', lang));
        else if (res.error === 'CANNOT_RECYCLE_SUPER_ADMIN') onError(t('um_recycle_no_super', lang));
        else if (res.error === 'CROSS_ORG_FORBIDDEN')  onError(t('um_recycle_no_cross_org', lang));
        else if (res.error === 'INVALID_USERNAME')     onError(t('um_username_invalid', lang));
        else onError(t('um_recycle_failed', lang));
        return;
      }

      onSuccess(t('um_recycle_success_local', lang));
    } catch {
      onError(t('um_recycle_failed', lang));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="nexus-legacy-dialog" role="dialog" aria-modal="true" aria-label={t('um_recycle_account', lang)} style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,.45)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9000, padding: '16px' }}>
      <PhoenixCard className="premium-dialog-panel nexus-legacy-dialog__panel" padding="24px" style={{ maxWidth: '520px', width: '100%', maxHeight: '90vh', overflowY: 'auto' }}>
        <h3 style={{ fontSize: '15px', fontWeight: 700, marginBottom: '10px' }}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: '7px' }}><PhoenixIcon name="refresh" size={17} /> {t('um_recycle_account', lang)}</span>
        </h3>
        <p style={{ fontSize: '12px', color: 'var(--t2)', marginBottom: '6px' }} dir="auto">
          <strong>{userName(user)}</strong>
        </p>

        <div style={{ background: 'var(--warn2)', border: '1px solid var(--warn)', borderRadius: 'var(--r2)', padding: '10px 14px', marginBottom: '14px', fontSize: '12px', color: 'var(--warn)' }} dir="auto">
          <PhoenixIcon name="warning" size={14} style={{ verticalAlign: 'text-bottom', marginInlineEnd: '5px' }} /> {t('um_recycle_warning_local', lang)}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_recycle_new_name', lang)} *</label>
              <input type="text" value={newName} onChange={e => setNewName(e.target.value)} style={fieldStyle} dir="auto" />
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_recycle_new_username', lang)} *</label>
              <input type="text" value={newUsername} onChange={e => setNewUsername(e.target.value)}
                style={{ ...fieldStyle, borderColor: newUsername && !validateUsername(newUsername) ? 'var(--err)' : undefined }}
                dir="ltr" autoComplete="off" />
            </div>
          </div>

          {newUsername && !validateUsername(newUsername) && (
            <p style={{ fontSize: '11.5px', color: 'var(--err)', margin: 0 }}>{t('um_username_invalid', lang)}</p>
          )}

          <div style={{ display: 'grid', gridTemplateColumns: isSuper ? '1fr 1fr' : '1fr', gap: '12px' }}>
            {isSuper && (
              <div>
                <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_recycle_new_org', lang)}</label>
                <select value={newOrgId} onChange={e => setNewOrgId(e.target.value)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                  {(orgs.data ?? []).map(o => <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>)}
                </select>
              </div>
            )}
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_recycle_new_role', lang)} *</label>
              <select value={newRole} onChange={e => setNewRole(e.target.value as OfficialRole)} style={{ ...fieldStyle, appearance: 'none', cursor: 'pointer' }}>
                {roleOptions.map(r => <option key={r} value={r}>{t(OFFICIAL_ROLE_LABEL_KEY[r], lang)}</option>)}
              </select>
            </div>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_password', lang)} *</label>
              <div style={{ position: 'relative' }}>
                <input type={showTempPwd ? 'text' : 'password'} value={tempPassword} onChange={e => setTempPassword(e.target.value)}
                  style={{ ...fieldStyle, paddingInlineEnd: '60px' }} autoComplete="new-password" dir="ltr" />
                <button type="button" onClick={() => setShowTempPwd(s => !s)}
                  style={{ position: 'absolute', insetInlineEnd: '8px', top: '50%', transform: 'translateY(-50%)', border: 'none', background: 'none', cursor: 'pointer', fontSize: '11px', color: 'var(--t2)' }}>
                  {showTempPwd ? t('um_hide_password', lang) : t('um_show_password', lang)}
                </button>
              </div>
            </div>
            <div>
              <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_confirm_password', lang)} *</label>
              <input type={showTempPwd ? 'text' : 'password'} value={tempConfirm} onChange={e => setTempConfirm(e.target.value)}
                style={{ ...fieldStyle, borderColor: tempConfirm && tempConfirm !== tempPassword ? 'var(--err)' : undefined }}
                autoComplete="new-password" dir="ltr" />
            </div>
          </div>
          {tempPassword && tempPassword.length < 8 && (
            <p style={{ fontSize: '11.5px', color: 'var(--warn)', margin: 0 }}>{t('um_password_too_short', lang)}</p>
          )}
          {tempConfirm && tempConfirm !== tempPassword && (
            <p style={{ fontSize: '11.5px', color: 'var(--err)', margin: 0 }}>{t('um_passwords_no_match', lang)}</p>
          )}
          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_contact_email_optional', lang)}</label>
            <input type="email" value={contactEmail} onChange={e => setContactEmail(e.target.value)} style={fieldStyle} dir="ltr" />
            <p style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="auto">{t('um_contact_email_not_for_login', lang)}</p>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: '11.5px', fontWeight: 600, color: 'var(--t2)', marginBottom: '5px' }}>{t('um_recycle_confirm', lang)} *</label>
            <input type="text" value={confirm} onChange={e => setConfirm(e.target.value)}
              placeholder={expectedConfirm} style={fieldStyle} dir="ltr" />
            <div style={{ fontSize: '10.5px', color: 'var(--t3)', marginTop: '4px' }} dir="ltr">
              {expectedConfirm}
            </div>
          </div>

          <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
            <PhoenixButton variant="ghost" size="md" disabled={busy} onClick={onCancel}>{t('cancel', lang)}</PhoenixButton>
            <PhoenixButton variant="primary" size="md" loading={busy} disabled={!canSubmit} onClick={onSubmit}>
              {t('um_recycle_account', lang)}
            </PhoenixButton>
          </div>
        </div>
      </PhoenixCard>
    </div>
  );
}

/* DeleteConfirmModal removed — pending USER-LIFECYCLE-DISABLE-DELETE-A.
   Hard delete requires email-based confirmation from ManagedUser (email field not
   currently fetched) and a deployed admin-user-lifecycle Edge Function. */
