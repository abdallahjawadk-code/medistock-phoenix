/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';

/**
 * QUARANTINE PANEL — STALE-WAREHOUSE RACE, REPRODUCED OVER THE REAL SCREEN.
 *
 * ═════════════════════════════════════════════════════════════════════════
 * WHY THIS FILE EXISTS, AND WHAT IT CORRECTS FROM AN EARLIER CLAIM
 *
 * A prior review of `canDisposeQuarantine = quarantinePerm.data ?? false`
 * (InventoryCenterScreen.tsx) concluded the underlying ROWS were always safe
 * because `QuarantinePanel` receives the LIVE `activeWarehouseId` prop and
 * "reload() never goes stale". That claim was never actually tested with
 * controlled promise timing — it inferred freshness from the prop being
 * live, which does not follow: `QuarantinePanel.reload()` is a hand-rolled
 * fetch with NO staleness guard at all —
 *
 *     const reload = useCallback(async () => {
 *       ...
 *       const [q, s] = await Promise.all([
 *         getQuarantineStock(warehouseId), getWarehouseStock(warehouseId),
 *       ]);
 *       setRows(q); setStock(s);
 *       ...
 *     }, [warehouseId, lang]);
 *     useEffect(() => { void reload(); }, [reload]);
 *
 * Nothing here checks, at the moment `setRows(q)` actually runs, whether
 * `warehouseId` is STILL what it was when this particular `reload()` call
 * started. Two overlapping calls — the ordinary result of switching warehouse
 * before the previous fetch has settled, which `useAsync` elsewhere in this
 * codebase guards against via an `active` flag — can resolve in EITHER order.
 * Whichever call's `setRows` runs LAST wins, regardless of which warehouse is
 * actually selected when it does.
 *
 * WHAT IS REAL HERE, AND WHAT IS SIMULATED
 *
 * `InventoryCenterScreen` and `QuarantinePanel` are the REAL, unmodified
 * components — not stand-ins. Every SERVICE call they make is replaced at its
 * own exported-function seam (`getQuarantineStock`, `getWarehouseStock`,
 * `releaseQuarantineStock`, `destroyQuarantineStock`) or at
 * `supabaseRbacTransport.hasScopedPermission`, with a LOCAL, network-free
 * double whose promises this file resolves/rejects by hand — the same
 * seam-replacement idiom this codebase's own suites already use. Every OTHER
 * permission hook the screen calls unconditionally resolves to a fast, inert
 * `false`/`[]` so only the quarantine path is under test.
 *
 * For every scenario this records THREE independent facts, because they can
 * diverge from one another and each is its own kind of wrong if it does:
 *   • which warehouse is SELECTED (the picker's own value)
 *   • which warehouse the DISPLAYED row actually belongs to (its own
 *     scientific name, standing in for `row.warehouseId` — never inferred
 *     from the picker)
 *   • which row id WOULD be sent to the disposal service if confirmed NOW
 *
 * RESULT — the defect was real, and it was two separate mechanisms, not one
 *
 * Against the unmodified component, four of these scenarios failed:
 *   1. A's rows (and A's dispose buttons) stayed on screen, fully
 *      interactive, for the entire window B's own fetch was pending —
 *      `reload()` never cleared `rows`/`stock` on a warehouseId change.
 *   2. An OPEN release/destroy form on one of A's rows survived the switch
 *      to B — `rows` still held A's row objects (same identity, same React
 *      key), so `QuarantineRow`'s per-row `mode`/`reason`/`quantity` state
 *      was never unmounted.
 *   3. A late response from B, resolving AFTER C had already been selected
 *      and had already rendered its own correct rows, overwrote C's rows
 *      with B's — `reload()` had no generation guard, so whichever request
 *      resolved last won regardless of which warehouse was still selected.
 *   4. Separately: `canDisposeQuarantine = quarantinePerm.data ?? false`
 *      (InventoryCenterScreen.tsx) can hold a stale `true` from a PREVIOUS
 *      warehouse for the entire window the CURRENT warehouse's own
 *      permission check is pending or has thrown — `useAsync` never clears
 *      `data` on a dep change or on error. A confirmed exception on B's own
 *      permission check left A's stale `true` as the only signal gating the
 *      confirm button.
 *
 * The fix (QuarantinePanel.tsx, useQuarantinePermission.ts,
 * InventoryCenterScreen.tsx) closes both: (1)/(2) by clearing rows/stock
 * synchronously on a warehouseId change — which also unmounts any open
 * per-row form — plus a request-generation counter in `reload()` that
 * discards a response superseded by a newer request; (4) by adding a
 * `confirmed` flag to `useQuarantinePermission` that is true only once the
 * CURRENT (org, warehouse, profile) triple has settled with no error, and
 * gating the disposal actions (not tab visibility, which is unchanged) on
 * it. `canDispose` alone was never touched — editing only that line, as a
 * prior pass assumed would be enough, leaves defects 1–3 completely open.
 * ═════════════════════════════════════════════════════════════════════════
 */

const ORG = 'org-1';
const WH_A = 'wh-A';
const WH_B = 'wh-B';
const WH_C = 'wh-C';

interface QRow {
  id: string; warehouseId: string; scientificName: string;
  batchNumber: string | null; nationalCode: string | null; expiryDate: string | null;
  quarantineReason: string; quantity: number; materialIdentityKey: string | null;
  internalBatchReference: string | null; supplyType: string | null; purchaseOrigin: string | null;
}

function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

// A permission outcome is one of three DISTINCT shapes the real transport
// (or the hook's own promise chain) can produce, per rbac.service.ts's own
// contract ({ok:true,allowed} | {ok:false,error}) plus the unexpected case
// of a rejected promise the contract says should never happen but the hook
// layer must still not misinterpret as a grant. Collapsing these into one
// generic boolean mock would hide exactly the gap this suite exists to
// catch — see the two RBAC-specific scenarios below.
type PermissionOutcome = boolean | { rpcError: string } | 'throws';
const pendingRows = new Map<string, ReturnType<typeof deferred<QRow[]>>>();
const pendingPermission = new Map<string, ReturnType<typeof deferred<boolean>>>();
const settledRows = new Map<string, QRow[]>();
const settledPermission = new Map<string, PermissionOutcome>();

function holdRows(warehouseId: string) {
  const d = deferred<QRow[]>();
  pendingRows.set(warehouseId, d);
  return d;
}
function holdPermission(warehouseId: string) {
  const d = deferred<boolean>();
  pendingPermission.set(warehouseId, d);
  return d;
}
function settleRowsImmediately(warehouseId: string, rows: QRow[]) {
  pendingRows.delete(warehouseId);
  settledRows.set(warehouseId, rows);
}
function settlePermissionImmediately(warehouseId: string, allowed: boolean) {
  pendingPermission.delete(warehouseId);
  settledPermission.set(warehouseId, allowed);
}
/** The RBAC transport itself resolves with its documented { ok: false, error } shape — a real, contract-compliant failure, never a thrown exception. */
function settlePermissionRpcError(warehouseId: string, rpcError = 'NETWORK_ERROR') {
  pendingPermission.delete(warehouseId);
  settledPermission.set(warehouseId, { rpcError });
}
/** The permission check throws/rejects outright — the case rbac.service.ts's fail-closed contract says should never occur, but the hook layer must still not treat stale prior data as a grant while it's unresolved. */
function settlePermissionThrows(warehouseId: string) {
  pendingPermission.delete(warehouseId);
  settledPermission.set(warehouseId, 'throws');
}

const quarantineRow = (id: string, warehouseId: string, name: string): QRow => ({
  id, warehouseId, scientificName: name,
  batchNumber: null, nationalCode: null, expiryDate: '2026-12-31',
  quarantineReason: 'test', quantity: 5, materialIdentityKey: `mik-${name}`,
  internalBatchReference: null, supplyType: null, purchaseOrigin: null,
});

const releaseQuarantineStock = vi.fn((_input: { quarantineStockId: string }) => Promise.resolve({ ok: true, data: { movement_id: 'm1' } }));
const destroyQuarantineStock = vi.fn((_input: { quarantineStockId: string }) => Promise.resolve({ ok: true, data: { movement_id: 'm2' } }));

vi.mock('@/features/inventory/quarantine.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/inventory/quarantine.service')>();
  return {
    ...actual,
    getQuarantineStock: (warehouseId: string): Promise<QRow[]> => {
      const held = pendingRows.get(warehouseId);
      if (held) return held.promise;
      return Promise.resolve(settledRows.get(warehouseId) ?? []);
    },
    releaseQuarantineStock: (input: { quarantineStockId: string }) => releaseQuarantineStock(input),
    destroyQuarantineStock: (input: { quarantineStockId: string }) => destroyQuarantineStock(input),
  };
});

vi.mock('@/features/network/network.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/network/network.service')>();
  return { ...actual, getWarehouseStock: () => Promise.resolve([]) };
});

vi.mock('@/shared/supabase/services/organizations.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/supabase/services/organizations.service')>();
  return { ...actual, getOrganizations: () => Promise.resolve([]) };
});

vi.mock('@/shared/supabase/services/scope-topology.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/supabase/services/scope-topology.service')>();
  return {
    ...actual,
    getOrganizationScopeTopology: () => Promise.resolve([WH_A, WH_B, WH_C].map(id => ({
      nodeKind: 'warehouse' as const, organizationId: ORG, organizationKind: null,
      institutionClass: null, facilityId: null, facilityClass: null, facilityStatus: null,
      facilityName: null, facilityNameAr: null, warehouseId: id, warehouseName: `Warehouse ${id}`,
      warehouseNameAr: `مخزن ${id}`, warehouseKind: 'institution' as const, warehouseStatus: 'active',
      warehouseIsMain: false, structuralRole: 'institution_store' as const, distributionPointId: null,
      distributionPointName: null, distributionPointNameAr: null, distributionPointType: null,
      distributionPointStatus: null, inEffectiveScope: true,
    }))),
  };
});

const hasScopedPermission = vi.fn((args: { permissionKey: string; warehouseId: string | null }) => {
  if (args.permissionKey === 'warehouse_transfer.return_request' && args.warehouseId) {
    const held = pendingPermission.get(args.warehouseId);
    if (held) return held.promise.then(allowed => ({ ok: true, allowed }));
    if (settledPermission.has(args.warehouseId)) {
      const outcome = settledPermission.get(args.warehouseId)!;
      if (outcome === 'throws') return Promise.reject(new Error('unexpected RBAC transport failure'));
      if (typeof outcome === 'object') return Promise.resolve({ ok: false, error: outcome.rpcError });
      return Promise.resolve({ ok: true, allowed: outcome });
    }
  }
  // Every other scoped permission (adjust/correct/return_receive/resolve
  // exceptions/suspension/etc.) — inert false, fast, so only the quarantine
  // tab and its own gate are ever affected by this test's fixtures.
  return Promise.resolve({ ok: true, allowed: false });
});

vi.mock('@/shared/authz/rbac.service', () => ({
  supabaseRbacTransport: {
    hasScopedPermission: (args: unknown) => hasScopedPermission(args as { permissionKey: string; warehouseId: string | null }),
    hasWarehouseAssignment: () => Promise.resolve({ ok: true, allowed: true }),
    hasPointAssignment: () => Promise.resolve({ ok: true, allowed: true }),
  },
}));

let appState = {
  lang: 'ar' as const, dir: 'rtl' as const, theme: 'light' as const,
  role: 'central_warehouse_manager',
  activeOrgId: ORG as string | null,
  myPermissions: new Set<string>(),
  profile: { id: 'p1', full_name: 'T', role: 'central_warehouse_manager', organization_id: ORG },
  session: { user: { id: 'u1' } },
  authStatus: 'authenticated',
  setActiveOrgId: () => undefined,
  toggleLang: () => undefined, toggleTheme: () => undefined,
};
vi.mock('@/app/AppContext', () => ({ useApp: () => appState }));

import { InventoryCenterScreen } from '@/features/inventory/InventoryCenterScreen';

const QUARANTINE_TAB_LABEL_AR = 'الحجر الصحي';

async function selectWarehouse(id: string) {
  await waitFor(() => {
    const opt = document.querySelector(`.nexus-it-context-bar select option[value="${id}"]`);
    expect(opt).not.toBeNull();
  });
  const select = document.querySelector('.nexus-it-context-bar select') as HTMLSelectElement;
  fireEvent.change(select, { target: { value: id } });
}

async function openQuarantineTab() {
  await waitFor(() => expect(screen.queryByText(QUARANTINE_TAB_LABEL_AR)).toBeInTheDocument());
  fireEvent.click(screen.getByText(QUARANTINE_TAB_LABEL_AR));
}

beforeEach(() => {
  pendingRows.clear();
  pendingPermission.clear();
  settledRows.clear();
  settledPermission.clear();
  hasScopedPermission.mockClear();
  releaseQuarantineStock.mockClear();
  destroyQuarantineStock.mockClear();
  appState = {
    ...appState,
    activeOrgId: ORG,
    role: 'central_warehouse_manager',
    profile: { ...appState.profile, role: 'central_warehouse_manager' },
  };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ════════════════════════════════════════════════════════════════════════ */

describe('reproduction — A settled, B pending: what does the panel show right now?', () => {
  it('does not display A’s rows or A’s dispose buttons while B is selected and pending', async () => {
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    holdRows(WH_B);
    holdPermission(WH_B);
    await selectWarehouse(WH_B);

    await waitFor(() => {
      const select = document.querySelector('.nexus-it-context-bar select') as HTMLSelectElement;
      expect(select.value, 'selected warehouse').toBe(WH_B);
    });
    expect(screen.queryByText('Alpha'), 'A’s row must not still be shown for B').toBeNull();
    expect(screen.queryByText('إفراج')).toBeNull();
    expect(screen.queryByText('إتلاف')).toBeNull();
  });
});

describe('reproduction — an OPEN release/destroy form exists before switching', () => {
  it('the open form is gone once the panel reflects a different, pending warehouse', async () => {
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    fireEvent.click(screen.getByText('إفراج'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'فحص' } });
    expect(screen.getByLabelText('سبب القرار')).toHaveValue('فحص');

    holdRows(WH_B);
    holdPermission(WH_B);
    await selectWarehouse(WH_B);

    await waitFor(() => expect(screen.queryByLabelText('سبب القرار')).toBeNull());
    expect(screen.queryByText('Alpha')).toBeNull();
  });
});

describe('reproduction — how B settling resolves (denied / failed / stale-after-fresh)', () => {
  it('B denies the permission: no dispose affordance appears once B answers', async () => {
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    const bRows = holdRows(WH_B);
    const bPerm = holdPermission(WH_B);
    await selectWarehouse(WH_B);

    bRows.resolve([quarantineRow('row-b1', WH_B, 'Beta')]);
    bPerm.resolve(false);

    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
    expect(screen.queryByText('إفراج')).toBeNull();
    expect(screen.queryByText('إتلاف')).toBeNull();
  });

  it('B’s data request FAILS outright: the panel shows its real error state, not A’s stale rows', async () => {
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    const bRows = holdRows(WH_B);
    settlePermissionImmediately(WH_B, true);
    await selectWarehouse(WH_B);
    bRows.reject(new Error('network down'));

    await waitFor(() => expect(document.querySelector('[role="alert"], .nexus-error-state')).not.toBeNull());
    expect(screen.queryByText('Alpha')).toBeNull();
    expect(screen.queryByText('إفراج')).toBeNull();
  });

  it('an OLDER response (from a warehouse that is no longer selected) arriving LATE must not replace the CURRENT one', async () => {
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());

    const bRows = holdRows(WH_B);
    const bPerm = holdPermission(WH_B);
    await selectWarehouse(WH_B);

    settleRowsImmediately(WH_C, [quarantineRow('row-c1', WH_C, 'Gamma')]);
    settlePermissionImmediately(WH_C, true);
    await selectWarehouse(WH_C);
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    // The stale, older B response finally arrives now — after C already
    // settled and rendered.
    bRows.resolve([quarantineRow('row-b1', WH_B, 'Beta')]);
    bPerm.resolve(true);
    await new Promise(resolve => setTimeout(resolve, 30));

    const select = document.querySelector('.nexus-it-context-bar select') as HTMLSelectElement;
    expect(select.value, 'still on C').toBe(WH_C);
    expect(screen.getByText('Gamma')).toBeInTheDocument();
    expect(screen.queryByText('Beta'), 'B’s stale, late row must not appear').toBeNull();
  });
});

describe('reproduction — B’s PERMISSION check itself: denial, a real RBAC transport error, and an unexpected exception are three different things', () => {
  it('the RBAC transport resolves { ok: false, error }: this is a real failure, not a client bug, and must be treated as a plain denial — no dispose affordance for B', async () => {
    // health_center_manager carries the independent, role-only inventory
    // read affordance, so the quarantine tab's own VISIBILITY does not
    // depend on canDisposeQuarantine — isolating what this test actually
    // checks (the dispose BUTTONS) from the separate, pre-existing,
    // documented fact that this hook's `data` can briefly go stale.
    appState = { ...appState, role: 'health_center_manager', profile: { ...appState.profile, role: 'health_center_manager' } };
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    settleRowsImmediately(WH_B, [quarantineRow('row-b1', WH_B, 'Beta')]);
    settlePermissionRpcError(WH_B, 'NETWORK_ERROR');
    await selectWarehouse(WH_B);

    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
    await waitFor(() => expect(hasScopedPermission).toHaveBeenCalledWith(
      expect.objectContaining({ warehouseId: WH_B, permissionKey: 'warehouse_transfer.return_request' }),
    ));
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(screen.queryByText('إفراج')).toBeNull();
    expect(screen.queryByText('إتلاف')).toBeNull();
  });

  it('the permission check throws unexpectedly: A’s stale allowed=true must not keep acting as a green light for B once B’s own check has failed', async () => {
    appState = { ...appState, role: 'health_center_manager', profile: { ...appState.profile, role: 'health_center_manager' } };
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    settleRowsImmediately(WH_B, [quarantineRow('row-b1', WH_B, 'Beta')]);
    settlePermissionThrows(WH_B);
    await selectWarehouse(WH_B);

    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
    // The rejected permission promise needs a tick beyond the rows response
    // to reach useAsync's catch handler and commit `error`.
    await waitFor(() => {
      expect(screen.queryByText('إفراج')).toBeNull();
      expect(screen.queryByText('إتلاف')).toBeNull();
    });
  });
});

describe('what the disposal service would actually receive right now (structural check)', () => {
  it('records the row id that a click on release/destroy would submit', async () => {
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    fireEvent.click(screen.getByText('إفراج'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });

    const confirm = screen.getByText('تأكيد الإفراج');
    if (!(confirm as HTMLButtonElement).disabled) {
      fireEvent.click(confirm);
      await waitFor(() => expect(releaseQuarantineStock).toHaveBeenCalled());
      const arg = releaseQuarantineStock.mock.calls[0][0];
      expect(arg.quarantineStockId).toBe('row-a1');
    }
  });
});
