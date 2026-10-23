/** @vitest-environment jsdom */
/**
 * R1-A4 — the activation gate of the Screen-3 tab: pure decision matrix + the hook (no request when inactive, stale answers discarded).
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import type { ManualCapabilities } from '../manual-needs.service';

vi.mock('@/shared/supabase/client', () => ({ supabase: { rpc: vi.fn(), from: vi.fn() } }));
const appState = { role: 'super_admin' as string | null, activeOrgId: 'org-1' as string | null, profile: { id: 'u1', organization_id: 'org-1' } as { id: string; organization_id: string | null } | null };
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));
const { computeManualNeedsTabState, useManualNeedsTabGate, manualNeedsTabFlag } = await import('../manual-needs-gate');

const base = { flag: true, role: 'central_warehouse_manager', activeOrgId: 'org-1', homeOrgId: 'org-1', orgKind: 'pharmacy_department_authority', orgKindLoaded: true, capabilities: { view: true, manualSet: true, approve: false } };

describe('gate decision (pure) - entrant vs independent approver', () => {
  it('an independent approver (approve key, NO entry key) reaches the tab; an entrant (entry key, no approve key) too; neither/other keys do not', () => {
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: true, manualSet: false, approve: true } })).toBe('on');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: true, manualSet: true, approve: false } })).toBe('on');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: true, manualSet: false, approve: false } })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: true, manualSet: false, approve: undefined } as never })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: true, manualSet: 'true', approve: 1 } as never })).toBe('off');
  });
  it('the approver path keeps every OTHER condition: flag, a signed-in role, home organization, PDA kind, and the server answer', () => {
    const approver = { view: true, manualSet: false, approve: true };
    for (const patch of [{ flag: false }, { role: null }, { activeOrgId: 'org-2' }, { orgKind: 'care_institution' }, { capabilities: null }] as const) {
      expect(computeManualNeedsTabState({ ...base, capabilities: approver, ...patch } as never), JSON.stringify(patch)).toBe('off');
    }
    expect(computeManualNeedsTabState({ ...base, capabilities: undefined })).toBe('checking');
  });
});

describe('gate decision (pure) - the view right is REQUIRED', () => {
  it('approve=true or manualSet=true WITHOUT view=true never opens the tab (negative); view + either opens it', () => {
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: false, manualSet: false, approve: true } })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: false, manualSet: true, approve: false } })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: false, manualSet: true, approve: true } })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: true, manualSet: false, approve: false } })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: undefined, manualSet: false, approve: true } as never })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: 'true', manualSet: false, approve: true } as never })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: true, manualSet: false, approve: true } })).toBe('on');
    expect(computeManualNeedsTabState({ ...base, capabilities: { view: true, manualSet: true, approve: false } })).toBe('on');
  });
  it('the independent reviewer with view + approve and NO manualSet gets the tab (and only that: sign-in, home PDA organization and flag still apply)', () => {
    const reviewer = { view: true, manualSet: false, approve: true };
    expect(computeManualNeedsTabState({ ...base, capabilities: reviewer })).toBe('on');
    expect(computeManualNeedsTabState({ ...base, capabilities: reviewer, role: 'super_admin' })).toBe('on');
    expect(computeManualNeedsTabState({ ...base, capabilities: reviewer, role: 'warehouse_officer' })).toBe('on');
    for (const patch of [{ flag: false }, { role: null }, { activeOrgId: 'org-2' }, { orgKind: 'care_institution' }]) {
      expect(computeManualNeedsTabState({ ...base, capabilities: reviewer, ...patch } as never), JSON.stringify(patch)).toBe('off');
    }
  });
});

describe('gate decision (pure)', () => {
  it('is ON only when every condition holds', () => {
    expect(computeManualNeedsTabState(base)).toBe('on');
    expect(computeManualNeedsTabState({ ...base, role: 'super_admin' })).toBe('on');
  });
  it('M224-RBAC-ROOT-FIX: the role is not a gate - an ordinary member the SERVER confirms reaches the tab', () => {
    for (const role of ['warehouse_officer', 'institution_admin', 'central_warehouse_manager', 'super_admin']) {
      expect(computeManualNeedsTabState({ ...base, role }), role).toBe('on');
      expect(computeManualNeedsTabState({ ...base, role, capabilities: { view: true, manualSet: false, approve: false } }), role).toBe('off');
      expect(computeManualNeedsTabState({ ...base, role, orgKind: 'care_institution' }), role).toBe('off');
    }
  });
  it('is OFF by default and for every missing condition', () => {
    for (const patch of [
      { flag: false }, { role: null }, { role: '' },
      { activeOrgId: null }, { homeOrgId: null }, { activeOrgId: 'org-2' },
      { orgKind: 'care_institution' }, { orgKind: null }, { capabilities: null }, { capabilities: { view: true, manualSet: false, approve: false } },
    ] as const) {
      expect(computeManualNeedsTabState({ ...base, ...patch } as never), JSON.stringify(patch)).toBe('off');
    }
  });
  it('waits (checking) only while a still-possible ON has an unanswered question; never ON without the server answer', () => {
    expect(computeManualNeedsTabState({ ...base, orgKindLoaded: false, orgKind: null })).toBe('checking');
    expect(computeManualNeedsTabState({ ...base, capabilities: undefined })).toBe('checking');
    expect(computeManualNeedsTabState({ ...base, flag: false, orgKindLoaded: false, orgKind: null })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, role: null, capabilities: undefined })).toBe('off');
    expect(computeManualNeedsTabState({ ...base, role: 'institution_admin', capabilities: undefined })).toBe('checking');
  });
  it('the build flag is OFF in the default build', () => {
    expect(manualNeedsTabFlag()).toBe(false);
  });
});

const caps = (manualSet: boolean, approve = false, view = true): ManualCapabilities => ({ view, edit: manualSet, approve, manualSet, excelImportOpen: true, approveExcludedForRevision: false });
const org = (id: string, kind: string) => ({ id, organizationKind: kind } as never);

function Probe({ deps }: { deps: Parameters<typeof useManualNeedsTabGate>[0] }) {
  const state = useManualNeedsTabGate(deps);
  return <output data-testid="gate">{state}</output>;
}
const mkDeps = (o: Partial<{ flag: boolean; orgs: unknown[]; caps: ManualCapabilities | Error; orgErr: boolean }> = {}) => {
  const getOrganizations = vi.fn(async () => { if (o.orgErr) throw new Error('x'); return (o.orgs ?? [org('org-1', 'pharmacy_department_authority')]) as never; });
  const getManualCapabilities = vi.fn(async () => { if (o.caps instanceof Error) throw o.caps; return o.caps ?? caps(true); });
  return { deps: { flag: () => o.flag ?? true, getOrganizations, getManualCapabilities } as never, getOrganizations, getManualCapabilities };
};

beforeEach(() => { appState.role = 'central_warehouse_manager'; appState.activeOrgId = 'org-1'; appState.profile = { id: 'u1', organization_id: 'org-1' }; });
afterEach(() => cleanup());

describe('gate hook', () => {
  it('flag OFF: state off and NO request of any kind', async () => {
    const m = mkDeps({ flag: false });
    render(<Probe deps={m.deps} />);
    await Promise.resolve();
    expect(screen.getByTestId('gate')).toHaveTextContent('off');
    expect(m.getOrganizations).not.toHaveBeenCalled();
    expect(m.getManualCapabilities).not.toHaveBeenCalled();
  });
  it('no signed-in role or other acting organization: off and no request', async () => {
    for (const patch of [() => { appState.role = null; }, () => { appState.activeOrgId = 'org-2'; }, () => { appState.profile = null; }]) {
      cleanup(); patch();
      const m = mkDeps();
      render(<Probe deps={m.deps} />);
      await Promise.resolve();
      expect(screen.getByTestId('gate')).toHaveTextContent('off');
      expect(m.getOrganizations).not.toHaveBeenCalled();
      appState.role = 'central_warehouse_manager'; appState.activeOrgId = 'org-1'; appState.profile = { id: 'u1', organization_id: 'org-1' };
    }
  });
  it('M224-RBAC-ROOT-FIX: an ordinary PDA member (warehouse_officer) asks the server and is ON when it confirms the keys', async () => {
    appState.role = 'warehouse_officer';
    const m = mkDeps();
    render(<Probe deps={m.deps} />);
    await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('on'));
    expect(m.getManualCapabilities).toHaveBeenCalledWith('org-1', null);
  });
  it('PDA + server says manualSet: on, after asking exactly once', async () => {
    const m = mkDeps();
    render(<Probe deps={m.deps} />);
    expect(screen.getByTestId('gate')).toHaveTextContent('checking');
    await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('on'));
    expect(m.getManualCapabilities).toHaveBeenCalledTimes(1);
    expect(m.getManualCapabilities).toHaveBeenCalledWith('org-1', null);
  });
  it('server says approve only (no entry key): on - the independent approver reaches the tab', async () => {
    const m = mkDeps({ caps: caps(false, true) });
    render(<Probe deps={m.deps} />);
    await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('on'));
  });
  it('server says approve WITHOUT view: off (the view right is required)', async () => {
    const m = mkDeps({ caps: caps(false, true, false) });
    render(<Probe deps={m.deps} />);
    await waitFor(() => expect(m.getManualCapabilities).toHaveBeenCalled());
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('gate')).toHaveTextContent('off');
  });
  it('care institution: off, and the capability question is never asked', async () => {
    const m = mkDeps({ orgs: [org('org-1', 'care_institution')] });
    render(<Probe deps={m.deps} />);
    await waitFor(() => expect(screen.getByTestId('gate')).toHaveTextContent('off'));
    expect(m.getManualCapabilities).not.toHaveBeenCalled();
  });
  it('server says no / fails / organization lookup fails: off (fail closed)', async () => {
    for (const o of [{ caps: caps(false) }, { caps: new Error('boom') }, { orgErr: true }]) {
      cleanup();
      const m = mkDeps(o as never);
      render(<Probe deps={m.deps} />);
      await waitFor(() => expect(m.getOrganizations).toHaveBeenCalled());
      await new Promise((r) => setTimeout(r, 20));
      expect(screen.getByTestId('gate')).toHaveTextContent('off');
    }
  });
  it('a late answer for the PREVIOUS organization never turns the gate on for the new one', async () => {
    let release!: (v: ManualCapabilities) => void;
    const slow = mkDeps();
    slow.getManualCapabilities.mockImplementationOnce(() => new Promise<ManualCapabilities>((r) => { release = r; }));
    const { rerender } = render(<Probe deps={slow.deps} />);
    await waitFor(() => expect(slow.getManualCapabilities).toHaveBeenCalledTimes(1));
    appState.activeOrgId = 'org-2'; appState.profile = { id: 'u1', organization_id: 'org-2' };
    slow.getOrganizations.mockResolvedValueOnce([org('org-2', 'care_institution')] as never);
    rerender(<Probe deps={slow.deps} />);
    release(caps(true));
    await new Promise((r) => setTimeout(r, 30));
    expect(screen.getByTestId('gate')).toHaveTextContent('off');
  });
});
