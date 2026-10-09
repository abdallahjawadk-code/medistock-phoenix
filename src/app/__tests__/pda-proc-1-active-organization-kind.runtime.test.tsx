/** @vitest-environment jsdom */
/**
 * PDA-PROC-1 — `activeOrganizationKind` is READ-ONLY derived state of the REAL
 * AppProvider: the canonical organization_kind of `activeOrgId`, read through
 * getOrganization.
 *
 * Contract under test: it follows activeOrgId; it is null in the very render an
 * org or profile change appears; a stale answer can never surface; read
 * failure, a missing row, an unknown kind and a deadline all settle as null;
 * logout and a profile switch clear it; it is never inferred from the role;
 * pending is true exactly while a non-null org's kind is unread.
 *
 * Ordering is controlled with deferred promises, never with sleeps. Every
 * render of the probe is recorded, and after each test every recorded render is
 * checked: a non-null kind may only ever appear next to the organization it
 * was read for.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import type { AuthChangeEvent, Session } from '@supabase/supabase-js';
import type { Profile, ProfileLoad, SessionLoad } from '@/shared/supabase/services/auth.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';
import type { OrganizationKind } from '@/shared/lib/institution-hierarchy';

const getSessionResult = vi.fn<() => Promise<SessionLoad>>();
const getMyProfileResult = vi.fn<() => Promise<ProfileLoad>>();
const signIn = vi.fn<(email: string, password: string) => Promise<{ ok: boolean }>>();
const signOut = vi.fn<() => Promise<void>>();
const onAuthChange = vi.fn<(cb: unknown) => () => void>();
const getOrganization = vi.fn<(id: string) => Promise<OrgRow | null>>();

vi.mock('@/shared/supabase/client', () => ({ supabaseConfigured: true, supabase: {} }));

vi.mock('@/shared/supabase/services/auth.service', () => ({
  getSessionResult: () => getSessionResult(),
  getMyProfileResult: () => getMyProfileResult(),
  onAuthChange: (cb: unknown) => onAuthChange(cb),
  signIn: (email: string, password: string) => signIn(email, password),
  signOut: () => signOut(),
  requestPasswordReset: vi.fn(),
  updatePassword: vi.fn(),
}));

const getEffectivePermissions =
  vi.fn<(id: string) => Promise<{ permissions: Record<string, boolean> | null }>>();
vi.mock('@/shared/supabase/services/users.service', () => ({
  getEffectivePermissions: (id: string) => getEffectivePermissions(id),
}));

vi.mock('@/shared/supabase/services/organizations.service', () => ({
  getOrganization: (id: string) => getOrganization(id),
}));

import { AppProvider, useApp } from '../AppContext';
import { AUTH_PROFILE_DEADLINE_MS } from '@/shared/lib/deadline';

type AuthCallback = (event: AuthChangeEvent, session: Session | null) => Promise<void> | void;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}
const never = <T,>(): Promise<T> => new Promise<T>(() => {});

const ORG_CARE_A = 'org-care-a';
const ORG_CARE_B = 'org-care-b';
const ORG_PDA = 'org-pda';

/** The canonical classification of each fixture org (what the server would answer). */
const KIND_OF: Record<string, OrganizationKind> = {
  [ORG_CARE_A]: 'care_institution',
  [ORG_CARE_B]: 'care_institution',
  [ORG_PDA]: 'pharmacy_department_authority',
};

function orgRow(id: string, organizationKind: OrganizationKind | null = KIND_OF[id] ?? null): OrgRow {
  return {
    id, name: id, name_ar: id, code: id, status: 'active', city: '', contact_email: '',
    organizationKind,
    institutionClass: organizationKind === 'care_institution' ? 'hospital' : null,
  };
}

const sessionFor = (id: string) => ({ user: { id } }) as unknown as Session;

function profileFor(id: string, over: Partial<Profile> = {}): Profile {
  return {
    id,
    organization_id: ORG_CARE_A,
    full_name: `Operator ${id}`,
    role: 'warehouse_officer',
    status: 'active',
    username: null,
    login_mode: 'email',
    contact_email: null,
    must_change_password: false,
    whatsapp_phone: null,
    ...over,
  };
}

let authCallback: AuthCallback = () => undefined;

interface Seen { profile: string | null; org: string | null; kind: OrganizationKind | null; pending: boolean }
let renders: Seen[] = [];

function Probe() {
  const app = useApp();
  renders.push({
    profile: app.profile?.id ?? null,
    org: app.activeOrgId,
    kind: app.activeOrganizationKind,
    pending: app.activeOrganizationKindPending,
  });
  return (
    <div>
      <span data-testid="status">{app.authStatus}</span>
      <span data-testid="profile">{app.profile?.id ?? 'null'}</span>
      <span data-testid="org">{app.activeOrgId ?? 'null'}</span>
      <span data-testid="kind">{app.activeOrganizationKind ?? 'null'}</span>
      <span data-testid="pending">{String(app.activeOrganizationKindPending)}</span>
      <button onClick={() => void app.signOut()}>sign-out</button>
      <button onClick={() => app.setActiveOrgId(ORG_CARE_A)}>org-care-a</button>
      <button onClick={() => app.setActiveOrgId(ORG_CARE_B)}>org-care-b</button>
      <button onClick={() => app.setActiveOrgId(ORG_PDA)}>org-pda</button>
      <button onClick={() => app.setActiveOrgId(null)}>org-all</button>
      <button onClick={() => void app.reloadProfile()}>reload-profile</button>
    </div>
  );
}

const mount = () => render(<AppProvider><Probe /></AppProvider>);
const val = (id: string) => screen.getByTestId(id).textContent;
const kind = () => val('kind');
const pending = () => val('pending');

async function click(name: string) {
  await act(async () => { screen.getByRole('button', { name }).click(); });
}

async function emitAuthEvent(event: AuthChangeEvent, session: Session | null) {
  await act(async () => { void authCallback(event, session); });
}

/** Sign in as `profile` through the real bootstrap and wait for the shell state. */
async function signInAs(profile: Profile) {
  getSessionResult.mockResolvedValue({ status: 'ok', session: sessionFor(profile.id) });
  getMyProfileResult.mockResolvedValue({ status: 'ok', profile });
  mount();
  await waitFor(() => expect(val('status')).toBe('authenticated'));
}

/** Every recorded render obeys the invariant: a kind only ever sits next to its own org. */
function expectNoForeignKindEverRendered() {
  expect(renders.length).toBeGreaterThan(0);
  for (const r of renders) {
    if (r.org === null || r.profile === null) {
      expect(r.kind, JSON.stringify(r)).toBeNull();
      expect(r.pending, JSON.stringify(r)).toBe(false);
    }
    if (r.kind !== null) expect(r.kind, JSON.stringify(r)).toBe(KIND_OF[r.org as string]);
  }
}

beforeEach(() => {
  vi.resetAllMocks();
  renders = [];
  onAuthChange.mockImplementation((cb) => {
    authCallback = cb as AuthCallback;
    return () => undefined;
  });
  signOut.mockResolvedValue(undefined);
  signIn.mockResolvedValue({ ok: true });
  getEffectivePermissions.mockResolvedValue({ permissions: { 'reports.view': true } });
  getOrganization.mockImplementation(async (id: string) => orgRow(id));
});
afterEach(() => {
  expectNoForeignKindEverRendered();
  cleanup();
  vi.useRealTimers();
});

describe('PDA-PROC-1 · activeOrganizationKind follows activeOrgId', () => {
  it('a pinned care institution is pending while unread, then care_institution', async () => {
    const read = deferred<OrgRow | null>();
    getOrganization.mockReturnValueOnce(read.promise);
    await signInAs(profileFor('user-A'));

    // Pending is derived in the render that publishes the org; the read itself
    // is issued by the effect that follows that render's commit.
    expect(val('org')).toBe(ORG_CARE_A);
    expect(kind()).toBe('null');
    expect(pending()).toBe('true');
    await waitFor(() => expect(getOrganization).toHaveBeenCalledWith(ORG_CARE_A));
    expect(pending()).toBe('true');

    await act(async () => { read.resolve(orgRow(ORG_CARE_A)); await read.promise; });
    expect(kind()).toBe('care_institution');
    expect(pending()).toBe('false');
    expect(getOrganization).toHaveBeenCalledTimes(1);
  });

  it('a pinned pharmacy department authority resolves to pharmacy_department_authority', async () => {
    await signInAs(profileFor('user-A', { organization_id: ORG_PDA, role: 'central_warehouse_manager' }));
    await waitFor(() => expect(kind()).toBe('pharmacy_department_authority'));
    expect(pending()).toBe('false');
    expect(getOrganization).toHaveBeenCalledWith(ORG_PDA);
  });

  it('a read that REJECTS settles as null (fail closed), not pending', async () => {
    getOrganization.mockRejectedValue(new TypeError('network down'));
    await signInAs(profileFor('user-A'));
    await waitFor(() => expect(pending()).toBe('false'));
    expect(kind()).toBe('null');
  });

  it('a missing / unreadable row (service answers null) settles as null', async () => {
    getOrganization.mockResolvedValue(null);
    await signInAs(profileFor('user-A'));
    await waitFor(() => expect(pending()).toBe('false'));
    expect(kind()).toBe('null');
  });

  it('an unknown kind (service maps it to organizationKind null) settles as null', async () => {
    getOrganization.mockImplementation(async (id: string) => orgRow(id, null));
    await signInAs(profileFor('user-A'));
    await waitFor(() => expect(pending()).toBe('false'));
    expect(kind()).toBe('null');
  });

  it('a row answered for a DIFFERENT id is not trusted', async () => {
    getOrganization.mockImplementation(async () => orgRow(ORG_CARE_B));
    await signInAs(profileFor('user-A'));
    await waitFor(() => expect(pending()).toBe('false'));
    expect(kind()).toBe('null');
  });

  it('is never inferred from the role: the organization decides, whatever the role', async () => {
    // A "pharmacy department" role inside a care institution is care.
    await signInAs(profileFor('user-A', { role: 'central_warehouse_manager', organization_id: ORG_CARE_A }));
    await waitFor(() => expect(kind()).toBe('care_institution'));
    cleanup();

    // An institution role inside a PDA organization is PDA.
    renders = [];
    await signInAs(profileFor('user-B', { role: 'institution_admin', organization_id: ORG_PDA }));
    await waitFor(() => expect(kind()).toBe('pharmacy_department_authority'));
  });

  it('super_admin starts on "all organizations": kind null, NOT pending, nothing read', async () => {
    await signInAs(profileFor('user-S', { role: 'super_admin', organization_id: ORG_PDA }));
    expect(val('org')).toBe('null');
    expect(kind()).toBe('null');
    expect(pending()).toBe('false');
    expect(getOrganization).not.toHaveBeenCalled();
  });
});

describe('PDA-PROC-1 · organization switches and stale answers', () => {
  it('super_admin switching orgs re-reads each one, and "all organizations" clears it', async () => {
    await signInAs(profileFor('user-S', { role: 'super_admin' }));

    await click('org-care-a');
    await waitFor(() => expect(kind()).toBe('care_institution'));
    await click('org-pda');
    await waitFor(() => expect(kind()).toBe('pharmacy_department_authority'));
    expect(getOrganization.mock.calls.map(c => c[0])).toEqual([ORG_CARE_A, ORG_PDA]);

    await click('org-all');
    expect(kind()).toBe('null');
    expect(pending()).toBe('false');
  });

  it('race: ORG_A requested -> switch to ORG_B -> ORG_B resolves -> stale ORG_A resolves => ORG_B kind', async () => {
    const readA = deferred<OrgRow | null>();
    const readB = deferred<OrgRow | null>();
    await signInAs(profileFor('user-S', { role: 'super_admin' }));
    getOrganization.mockReturnValueOnce(readA.promise).mockReturnValueOnce(readB.promise);

    await click('org-care-a');
    expect(pending()).toBe('true');
    await click('org-pda');
    expect(val('org')).toBe(ORG_PDA);
    expect(kind()).toBe('null');
    expect(pending()).toBe('true');

    await act(async () => { readB.resolve(orgRow(ORG_PDA)); await readB.promise; });
    expect(kind()).toBe('pharmacy_department_authority');
    expect(pending()).toBe('false');

    // The stale care answer for ORG_A arrives last. It must change nothing.
    await act(async () => { readA.resolve(orgRow(ORG_CARE_A)); await readA.promise; });
    expect(val('org')).toBe(ORG_PDA);
    expect(kind()).toBe('pharmacy_department_authority');
    expect(pending()).toBe('false');
  });

  it('race: a stale answer arriving while the NEW read is still pending stays invisible', async () => {
    const readA = deferred<OrgRow | null>();
    const readB = deferred<OrgRow | null>();
    await signInAs(profileFor('user-S', { role: 'super_admin' }));
    getOrganization.mockReturnValueOnce(readA.promise).mockReturnValueOnce(readB.promise);

    await click('org-care-a');
    await click('org-pda');
    await act(async () => { readA.resolve(orgRow(ORG_CARE_A)); await readA.promise; });
    expect(kind()).toBe('null');
    expect(pending()).toBe('true');

    await act(async () => { readB.resolve(orgRow(ORG_PDA)); await readB.promise; });
    expect(kind()).toBe('pharmacy_department_authority');
  });

  it('A -> B -> A: the kind is null immediately at EACH switch, and A is read again', async () => {
    const readB = deferred<OrgRow | null>();
    const readA2 = deferred<OrgRow | null>();
    await signInAs(profileFor('user-S', { role: 'super_admin' }));

    await click('org-care-a');
    await waitFor(() => expect(kind()).toBe('care_institution'));

    getOrganization.mockReturnValueOnce(readB.promise).mockReturnValueOnce(readA2.promise);
    await click('org-pda');
    expect(kind()).toBe('null');
    expect(pending()).toBe('true');

    // Back to A before B answered: A's earlier answer is NOT reused.
    await click('org-care-a');
    expect(val('org')).toBe(ORG_CARE_A);
    expect(kind()).toBe('null');
    expect(pending()).toBe('true');
    expect(getOrganization.mock.calls.map(c => c[0])).toEqual([ORG_CARE_A, ORG_PDA, ORG_CARE_A]);

    // B's late answer cannot land on A either.
    await act(async () => { readB.resolve(orgRow(ORG_PDA)); await readB.promise; });
    expect(kind()).toBe('null');
    expect(pending()).toBe('true');

    await act(async () => { readA2.resolve(orgRow(ORG_CARE_A)); await readA2.promise; });
    expect(kind()).toBe('care_institution');
    expect(pending()).toBe('false');
  });

  it('a care -> PDA switch never renders the PDA org with the care kind, not even for one render', async () => {
    await signInAs(profileFor('user-S', { role: 'super_admin' }));
    await click('org-care-a');
    await waitFor(() => expect(kind()).toBe('care_institution'));
    const from = renders.length;

    getOrganization.mockReturnValueOnce(never<OrgRow | null>());
    await click('org-pda');
    const after = renders.slice(from);
    expect(after.length).toBeGreaterThan(0);
    for (const r of after) {
      expect(r.org).toBe(ORG_PDA);
      expect(r.kind).toBeNull();
      expect(r.pending).toBe(true);
    }
  });
});

describe('PDA-PROC-1 · identity changes clear the kind', () => {
  it('logout clears a settled kind (null, not pending)', async () => {
    await signInAs(profileFor('user-A'));
    await waitFor(() => expect(kind()).toBe('care_institution'));

    await click('sign-out');
    expect(val('profile')).toBe('null');
    expect(val('org')).toBe('null');
    expect(kind()).toBe('null');
    expect(pending()).toBe('false');
  });

  it('a read still in flight at logout cannot revive the kind when it answers late', async () => {
    const read = deferred<OrgRow | null>();
    getOrganization.mockReturnValueOnce(read.promise);
    await signInAs(profileFor('user-A'));
    expect(pending()).toBe('true');

    await click('sign-out');
    expect(kind()).toBe('null');
    expect(pending()).toBe('false');

    await act(async () => { read.resolve(orgRow(ORG_CARE_A)); await read.promise; });
    expect(kind()).toBe('null');
    expect(pending()).toBe('false');
  });

  it('a profile switch to another user clears it, even when both belong to the SAME org', async () => {
    await signInAs(profileFor('user-A', { organization_id: ORG_CARE_A }));
    await waitFor(() => expect(kind()).toBe('care_institution'));
    expect(getOrganization).toHaveBeenCalledTimes(1);

    const readForB = deferred<OrgRow | null>();
    getOrganization.mockReturnValueOnce(readForB.promise);
    getMyProfileResult.mockResolvedValue({ status: 'ok', profile: profileFor('user-B', { organization_id: ORG_CARE_A }) });
    await emitAuthEvent('SIGNED_IN', sessionFor('user-B'));
    await waitFor(() => expect(val('profile')).toBe('user-B'));

    // User B's own read decides; user A's settled answer is not carried over.
    expect(val('org')).toBe(ORG_CARE_A);
    expect(kind()).toBe('null');
    expect(pending()).toBe('true');
    expect(getOrganization).toHaveBeenCalledTimes(2);
    // No render of user B carried a kind before B's own read answered (below).
    for (const r of renders) {
      expect(r.profile === 'user-B' && r.kind !== null, JSON.stringify(r)).toBe(false);
    }

    await act(async () => { readForB.resolve(orgRow(ORG_CARE_A)); await readForB.promise; });
    expect(kind()).toBe('care_institution');
    expect(pending()).toBe('false');
  });

  it('a same-user profile reload keeps the settled kind: no re-read, no flash to null', async () => {
    await signInAs(profileFor('user-A'));
    await waitFor(() => expect(kind()).toBe('care_institution'));
    const from = renders.length;

    await click('reload-profile');
    await waitFor(() => expect(getMyProfileResult).toHaveBeenCalledTimes(2));
    expect(kind()).toBe('care_institution');
    expect(getOrganization).toHaveBeenCalledTimes(1);
    for (const r of renders.slice(from)) {
      if (r.profile === 'user-A' && r.org === ORG_CARE_A) expect(r.kind).toBe('care_institution');
    }
  });
});

describe('PDA-PROC-1 · a read that never answers is bounded', () => {
  it('stays pending up to the deadline, then settles as null (fail closed)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    getOrganization.mockReturnValue(never<OrgRow | null>());
    await signInAs(profileFor('user-A'));
    expect(pending()).toBe('true');

    await act(async () => { await vi.advanceTimersByTimeAsync(AUTH_PROFILE_DEADLINE_MS - 1000); });
    expect(pending()).toBe('true');
    expect(kind()).toBe('null');

    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    await waitFor(() => expect(pending()).toBe('false'));
    expect(kind()).toBe('null');
  });
});
