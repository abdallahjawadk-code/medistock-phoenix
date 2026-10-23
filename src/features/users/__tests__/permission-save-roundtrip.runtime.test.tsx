/** @vitest-environment jsdom */
/**
 * PERMISSION-SAVE-01 — the permission matrix must persist exactly what the
 * person ticked, through the REAL UserManagementScreen and its REAL onSave.
 *
 * Root cause this pins: the save used to compare the new value with the
 * CLIENT fallback table (roleDefaults) and send `null` (inherit) when they
 * matched. The database resolves `null` against ITS OWN role default, which
 * can differ (super_admin's fallback is the whole catalog; the database seeds
 * no Central Needs default for anyone). A ticked grant was therefore sent as
 * `null`, stored as "inherit", and came back unticked after the reload.
 *
 * The services are replaced by an in-memory model of the server contract the
 * screen talks to, transcribed from migration 219's assign_profile_permissions
 * / reset_profile_permissions and migration 010's effective-permission read:
 *   - effective(key) = override (when not null) ?? database role default ?? false
 *   - assign: actor must be super_admin or hold users.manage_permissions in the
 *     target's organization; no self-edit; unknown keys rejected per key; a
 *     `true` from a non-super_admin needs the actor to hold the key; `null`
 *     is written as-is (inherit); every accepted key is upserted alone
 *   - reset: deletes only the target's own override rows.
 * The database role defaults here deliberately differ from the client
 * fallback, which is exactly the condition under which the bug appeared.
 * This is a component-level proof; PostgREST/PostgreSQL are not exercised.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PERMISSION_KEYS } from '@/shared/lib/permissions';
import { t } from '@/shared/i18n/strings';
import { UserManagementScreen } from '@/features/users/UserManagementScreen';

type Overrides = Record<string, boolean | null>;
interface ServerProfile { id: string; role: string; organization_id: string | null; full_name: string }

const h = vi.hoisted(() => ({
  app: {
    lang: 'en' as 'ar' | 'en',
    role: 'super_admin',
    activeOrgId: null as string | null,
    profile: { id: 'actor-super' } as { id: string } | null,
    authz: {},
    myPermissions: new Set<string>(),
    reloadMyPermissions: () => undefined,
  },
  server: {
    profiles: [] as { id: string; role: string; organization_id: string | null; full_name: string }[],
    /** permission_keys rows (the database registry). */
    registry: new Set<string>(),
    /** role_permission_defaults: role -> key -> allowed. */
    roleDefaults: {} as Record<string, Record<string, boolean>>,
    /** profile_permission_overrides: profile -> key -> allowed (null = inherit). */
    overrides: {} as Record<string, Record<string, boolean | null>>,
    /** auth.uid() of the caller. */
    actorId: 'actor-super',
  },
  calls: {
    assign: [] as { profileId: string; payload: Record<string, boolean | null> }[],
    reset: [] as string[],
    effective: [] as string[],
  },
}));

vi.mock('@/app/AppContext', () => ({ useApp: () => h.app }));
vi.mock('@/shared/supabase/client', () => ({ supabaseConfigured: true, supabase: {} }));
vi.mock('@/shared/authz/useAuthorization', () => ({ useShadowObservation: () => undefined }));
vi.mock('@/shared/ui/useResponsiveViewport', () => ({ useIsMobileViewport: () => false }));
vi.mock('@/shared/ui/PhoenixOrgScope', () => ({ PhoenixOrgScope: () => null }));
vi.mock('@/features/users/DelegatedAccessPanel', () => ({ DelegatedAccessPanel: () => null }));
vi.mock('@/features/admin/AvailabilityCleanupWizard', () => ({ AvailabilityCleanupWizard: () => null }));
vi.mock('@/features/platform-broadcast/PlatformBroadcastAdminPanel', () => ({ PlatformBroadcastAdminPanel: () => null }));
vi.mock('@/features/institutions/facilities.service', () => ({ listOrganizationFacilities: async () => [] }));
vi.mock('@/shared/supabase/services/organizations.service', () => ({ getOrganizations: async () => [] }));

/** The server model, called through the mocked service functions below. */
function holds(profileId: string, key: string): boolean {
  const p = h.server.profiles.find(x => x.id === profileId);
  if (!p) return false;
  const o = h.server.overrides[profileId]?.[key];
  if (o !== undefined && o !== null) return o;
  return h.server.roleDefaults[p.role]?.[key] ?? false;
}

vi.mock('@/shared/supabase/services/users.service', () => ({
  listUsers: async () => h.server.profiles.map(p => ({
    id: p.id, organization_id: p.organization_id, full_name: p.full_name, role: p.role,
    status: 'active', org_name: 'PDA', org_name_ar: 'PDA', username: null, login_mode: 'email',
  })),
  getEffectivePermissions: async (profileId: string) => {
    h.calls.effective.push(profileId);
    const permissions: Record<string, boolean> = {};
    for (const key of h.server.registry) permissions[key] = holds(profileId, key);
    return { permissions, migrationMissing: false };
  },
  assignProfilePermissions: async (profileId: string, payload: Record<string, boolean | null>) => {
    h.calls.assign.push({ profileId, payload: { ...payload } });
    const actor = h.server.profiles.find(p => p.id === h.server.actorId);
    const target = h.server.profiles.find(p => p.id === profileId);
    if (!actor) return { ok: false, error: 'ACTOR_PROFILE_NOT_FOUND' };
    if (!target) return { ok: false, error: 'TARGET_NOT_FOUND' };
    if (actor.role !== 'super_admin') {
      if (!holds(actor.id, 'users.manage_permissions')) return { ok: false, error: 'INSUFFICIENT_PERMISSION' };
      if (target.organization_id !== actor.organization_id) return { ok: false, error: 'OUT_OF_SCOPE' };
    }
    if (profileId === actor.id) return { ok: false, error: 'CANNOT_EDIT_OWN_PERMISSIONS' };
    const rejected: { key: string; error: string }[] = [];
    let applied = 0;
    for (const [key, value] of Object.entries(payload)) {
      if (!h.server.registry.has(key)) { rejected.push({ key, error: 'UNKNOWN_PERMISSION' }); continue; }
      if (value === true && actor.role !== 'super_admin' && !holds(actor.id, key)) {
        rejected.push({ key, error: 'CANNOT_GRANT_UNHELD' });
        continue;
      }
      (h.server.overrides[profileId] ??= {})[key] = value;
      applied++;
    }
    return { ok: true, applied, rejected };
  },
  resetProfilePermissions: async (profileId: string) => {
    h.calls.reset.push(profileId);
    delete h.server.overrides[profileId];
    return { ok: true };
  },
  createUserViaEdge: vi.fn(),
  getOrgStatusContacts: async () => [],
  disableUserViaEdge: vi.fn(),
  enableUserViaEdge: vi.fn(),
  recycleUserViaEdge: vi.fn(),
  rotatePasswordViaEdge: vi.fn(),
  deleteUserViaEdge: vi.fn(),
}));

const PDA = 'org-pda';
const VIEW = 'central_needs.view';
const EDIT = 'central_needs.edit';
const IMPORT = 'central_needs.import';
const APPROVE = 'central_needs.approve';
const MANUAL = 'central_needs.manual_need.set';
const REVIEW = 'central_needs.material_review';

function seed(profiles: ServerProfile[], actorId: string, overrides: Record<string, Overrides> = {}) {
  h.server.profiles = profiles;
  h.server.actorId = actorId;
  // The database registry: the frontend catalog plus the two keys M224/M228 registered.
  h.server.registry = new Set([...PERMISSION_KEYS.map(p => p.key), MANUAL, REVIEW]);
  // The database seeds NO Central Needs default for any role (M209/M224/M228). Only the
  // deny scenario adds one, so that a database default can disagree with the client fallback.
  h.server.roleDefaults = {
    super_admin: Object.fromEntries(PERMISSION_KEYS.filter(p => !p.key.startsWith('central_needs.')).map(p => [p.key, true])),
    institution_admin: { 'users.view': true },
    central_warehouse_manager: {},
  };
  h.server.overrides = JSON.parse(JSON.stringify(overrides)) as Record<string, Overrides>;
  h.calls.assign = [];
  h.calls.reset = [];
  h.calls.effective = [];
  const actor = profiles.find(p => p.id === actorId)!;
  h.app.role = actor.role;
  h.app.profile = { id: actorId };
  h.app.activeOrgId = actor.role === 'super_admin' ? null : actor.organization_id;
  // AppContext's actor set: the database's effective keys, topped up to the whole catalog for
  // super_admin (the existing AppContext behaviour, unchanged here).
  const mine = new Set([...h.server.registry].filter(k => holds(actorId, k)));
  if (actor.role === 'super_admin') for (const p of PERMISSION_KEYS) mine.add(p.key);
  h.app.myPermissions = mine;
}

const label = (key: string) => t(PERMISSION_KEYS.find(p => p.key === key)?.labelKey ?? `missing:${key}`, 'en');

function checkbox(key: string): HTMLInputElement {
  const text = screen.getByText(label(key));
  const input = text.closest('label')?.querySelector('input[type="checkbox"]');
  if (!(input instanceof HTMLInputElement)) throw new Error(`no checkbox for ${key}`);
  return input;
}

async function openMatrixFor(name: string) {
  fireEvent.click((await screen.findAllByText(name))[0]);
  fireEvent.click((await screen.findByText(t('um_manage_user_permissions', 'en'))).closest('button')!);
  await screen.findByText(label(VIEW));
}

async function reopenMatrix() {
  fireEvent.click(screen.getByText(t('um_hide_permissions', 'en')).closest('button')!);
  fireEvent.click((await screen.findByText(t('um_manage_user_permissions', 'en'))).closest('button')!);
  await screen.findByText(label(VIEW));
}

async function save() {
  fireEvent.click(screen.getByText(t('um_save', 'en')).closest('button')!);
}

const ACTOR_SUPER: ServerProfile = { id: 'actor-super', role: 'super_admin', organization_id: PDA, full_name: 'Actor Super' };
const TARGET_SUPER: ServerProfile = { id: 'target-super', role: 'super_admin', organization_id: PDA, full_name: 'Target Member' };
const TARGET_CWM: ServerProfile = { id: 'target-cwm', role: 'central_warehouse_manager', organization_id: PDA, full_name: 'Warehouse Member' };
const ACTOR_ADMIN: ServerProfile = { id: 'actor-admin', role: 'institution_admin', organization_id: PDA, full_name: 'Actor Admin' };

beforeEach(() => { h.app.lang = 'en'; });
afterEach(() => { cleanup(); });

describe('P1 — the matrix saves the explicit choice and it survives reload and reopen', () => {
  it('an explicit grant survives save → reload → reopen when the client fallback says true but the database default is false', async () => {
    seed([ACTOR_SUPER, TARGET_SUPER], 'actor-super', { 'target-super': { [APPROVE]: true } });
    render(<UserManagementScreen />);
    await openMatrixFor('Target Member');
    expect(checkbox(VIEW).checked).toBe(false);
    expect(checkbox(APPROVE).checked).toBe(true);

    fireEvent.click(checkbox(VIEW));
    expect(checkbox(VIEW).checked).toBe(true);
    await save();

    await screen.findByText(t('um_saved', 'en'));
    expect(h.calls.assign).toEqual([{ profileId: 'target-super', payload: { [VIEW]: true } }]);
    expect(h.server.overrides['target-super']).toEqual({ [APPROVE]: true, [VIEW]: true });
    // Reload: the matrix re-reads the server's effective set.
    await waitFor(() => expect(checkbox(VIEW).checked).toBe(true));
    expect(h.calls.effective.filter(id => id === 'target-super').length).toBeGreaterThanOrEqual(2);

    // Reopen the panel: a fresh read.
    await reopenMatrix();
    await waitFor(() => expect(checkbox(VIEW).checked).toBe(true));
    expect(checkbox(APPROVE).checked).toBe(true);

    // Remount the whole screen: still the stored value.
    cleanup();
    render(<UserManagementScreen />);
    await openMatrixFor('Target Member');
    await waitFor(() => expect(checkbox(VIEW).checked).toBe(true));
  });

  it('an explicit deny survives save → reload → reopen when the client fallback says false but the database default is true', async () => {
    seed([ACTOR_SUPER, TARGET_CWM], 'actor-super');
    h.server.roleDefaults.central_warehouse_manager = { [EDIT]: true };
    render(<UserManagementScreen />);
    await openMatrixFor('Warehouse Member');
    await waitFor(() => expect(checkbox(EDIT).checked).toBe(true));

    fireEvent.click(checkbox(EDIT));
    await save();

    await screen.findByText(t('um_saved', 'en'));
    expect(h.calls.assign).toEqual([{ profileId: 'target-cwm', payload: { [EDIT]: false } }]);
    await waitFor(() => expect(checkbox(EDIT).checked).toBe(false));
    await reopenMatrix();
    await waitFor(() => expect(checkbox(EDIT).checked).toBe(false));
  });

  it('saving with nothing changed sends no RPC', async () => {
    seed([ACTOR_SUPER, TARGET_SUPER], 'actor-super');
    render(<UserManagementScreen />);
    await openMatrixFor('Target Member');
    await save();
    await screen.findByText(t('um_saved', 'en'));
    expect(h.calls.assign).toEqual([]);
  });

  it('only the changed key is sent; keys the person did not touch keep their stored values', async () => {
    seed([ACTOR_SUPER, TARGET_SUPER], 'actor-super', { 'target-super': { [APPROVE]: true, [IMPORT]: false } });
    render(<UserManagementScreen />);
    await openMatrixFor('Target Member');
    fireEvent.click(checkbox(VIEW));
    await save();
    await screen.findByText(t('um_saved', 'en'));
    expect(h.calls.assign).toHaveLength(1);
    expect(Object.keys(h.calls.assign[0].payload)).toEqual([VIEW]);
    expect(h.server.overrides['target-super'][APPROVE]).toBe(true);
    expect(h.server.overrides['target-super'][IMPORT]).toBe(false);
  });

  it('reset to role defaults still goes through the reset path and returns the person to the database defaults', async () => {
    seed([ACTOR_SUPER, TARGET_SUPER], 'actor-super', { 'target-super': { [VIEW]: true } });
    render(<UserManagementScreen />);
    await openMatrixFor('Target Member');
    await waitFor(() => expect(checkbox(VIEW).checked).toBe(true));
    fireEvent.click(screen.getByText(t('um_reset_defaults', 'en')).closest('button')!);
    await waitFor(() => expect(h.calls.reset).toEqual(['target-super']));
    expect(h.calls.assign).toEqual([]);
    expect(h.server.overrides['target-super']).toBeUndefined();
    await waitFor(() => expect(checkbox(VIEW).checked).toBe(false));
  });
});

describe('P1 — authority boundaries are unchanged', () => {
  it('self-edit: the actor gets no matrix for their own account and nothing is sent', async () => {
    seed([ACTOR_SUPER, TARGET_SUPER], 'actor-super');
    render(<UserManagementScreen />);
    fireEvent.click((await screen.findAllByText('Actor Super'))[0]);
    expect(await screen.findByText(t('um_perm_self_edit_session_note', 'en'), { exact: false })).toBeInTheDocument();
    expect(screen.queryByText(t('um_manage_user_permissions', 'en'))).toBeNull();
    expect(h.calls.assign).toEqual([]);
  });

  it('a caller without users.manage_permissions gets no matrix and nothing is sent', async () => {
    seed([ACTOR_ADMIN, TARGET_CWM], 'actor-admin');
    render(<UserManagementScreen />);
    fireEvent.click((await screen.findAllByText('Warehouse Member'))[0]);
    expect(await screen.findByText(t('um_no_manage_permissions_note', 'en'))).toBeInTheDocument();
    expect(screen.queryByText(t('um_manage_user_permissions', 'en'))).toBeNull();
    expect(h.calls.assign).toEqual([]);
  });

  it('a non-super_admin caller is refused by the client pre-check before any RPC, and nothing is stored', async () => {
    // The pre-existing grant context marks every non-super_admin actor out of scope
    // (sameScope = isSuper), so the refusal reported is the generic save failure; the
    // point here is only that the explicit `true` now sent never bypasses that check.
    seed([ACTOR_ADMIN, TARGET_CWM], 'actor-admin', { 'actor-admin': { 'users.manage_permissions': true } });
    h.app.myPermissions = new Set(['users.view', 'users.manage_permissions']);
    render(<UserManagementScreen />);
    await openMatrixFor('Warehouse Member');
    fireEvent.click(checkbox(VIEW));
    await save();
    expect(await screen.findByText(t('um_perm_save_failed', 'en'))).toBeInTheDocument();
    expect(h.calls.assign).toEqual([]);
    expect(h.server.overrides['target-cwm']).toBeUndefined();
    await reopenMatrix();
    await waitFor(() => expect(checkbox(VIEW).checked).toBe(false));
  });

  it('a per-key server rejection is shown, and the rejected key is not stored', async () => {
    seed([ACTOR_SUPER, TARGET_SUPER], 'actor-super');
    h.server.registry.delete(IMPORT);
    render(<UserManagementScreen />);
    await openMatrixFor('Target Member');
    fireEvent.click(checkbox(IMPORT));
    await save();
    expect(await screen.findByText(t('um_perm_unknown_key', 'en'))).toBeInTheDocument();
    expect(h.calls.assign).toHaveLength(1);
    expect(h.server.overrides['target-super']?.[IMPORT]).toBeUndefined();
    await waitFor(() => expect(checkbox(IMPORT).checked).toBe(false));
  });
});

describe('P2 — the two Central Needs keys registered by M224/M228 can be assigned from the matrix', () => {
  it('manual_need.set and material_review are listed, and a grant of each survives save → reload → reopen', async () => {
    seed([ACTOR_SUPER, TARGET_SUPER], 'actor-super');
    render(<UserManagementScreen />);
    await openMatrixFor('Target Member');
    expect(checkbox(MANUAL).checked).toBe(false);
    expect(checkbox(REVIEW).checked).toBe(false);

    fireEvent.click(checkbox(MANUAL));
    fireEvent.click(checkbox(REVIEW));
    await save();

    await screen.findByText(t('um_saved', 'en'));
    expect(h.calls.assign).toEqual([{ profileId: 'target-super', payload: { [MANUAL]: true, [REVIEW]: true } }]);
    await reopenMatrix();
    await waitFor(() => expect(checkbox(MANUAL).checked).toBe(true));
    expect(checkbox(REVIEW).checked).toBe(true);
  });
});
