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

interface StockBatch {
  id: string; warehouseId: string; scientificName: string;
  batchNumber: string | null; expiryDate: string | null;
  onHandQuantity: number; reservedQuantity: number; availableQuantity: number;
  nationalCode: string | null; centralItemId: string | null;
  concentration: string | null; dosageForm: string | null; unit: string | null;
  materialIdentityKey: string | null; internalBatchReference: string | null;
  supplyType: string | null; purchaseOrigin: string | null;
}

/** A warehouse_stock lot that `isExactReleaseCandidate` will accept as an EXACT destination for `row` — matches all six identity dimensions the real predicate checks. */
const matchingStockBatch = (id: string, row: QRow): StockBatch => ({
  id, warehouseId: row.warehouseId, scientificName: row.scientificName,
  batchNumber: row.batchNumber, expiryDate: row.expiryDate,
  onHandQuantity: 100, reservedQuantity: 0, availableQuantity: 100,
  nationalCode: row.nationalCode, centralItemId: null,
  concentration: null, dosageForm: null, unit: null,
  materialIdentityKey: row.materialIdentityKey,
  internalBatchReference: row.internalBatchReference,
  supplyType: row.supplyType, purchaseOrigin: row.purchaseOrigin,
});

const settledStock = new Map<string, StockBatch[]>();
function setWarehouseStock(warehouseId: string, stock: StockBatch[]) {
  settledStock.set(warehouseId, stock);
}

const getQuarantineStockCalls: string[] = [];
// A QUEUE, not a single slot: two overlapping actions (e.g. an old one on
// A1 still pending when a new one starts on A2) each need their OWN
// deferred, consumed in the order the calls actually happen — a single
// slot would let the second call silently steal the first call's hold (or
// resolve instantly instead of waiting for one), masking exactly the
// overlap these tests exist to exercise.
const pendingReleaseCalls: ReturnType<typeof deferred<{ ok: boolean; data?: unknown; error?: string }>>[] = [];
const pendingDestroyCalls: ReturnType<typeof deferred<{ ok: boolean; data?: unknown; error?: string }>>[] = [];
function holdRelease() {
  const d = deferred<{ ok: boolean; data?: unknown; error?: string }>();
  pendingReleaseCalls.push(d);
  return d;
}
function holdDestroy() {
  const d = deferred<{ ok: boolean; data?: unknown; error?: string }>();
  pendingDestroyCalls.push(d);
  return d;
}

const releaseQuarantineStock = vi.fn((_input: { quarantineStockId: string }) => {
  const d = pendingReleaseCalls.shift();
  if (d) return d.promise;
  return Promise.resolve({ ok: true, data: { movement_id: 'm1' } });
});
const destroyQuarantineStock = vi.fn((_input: { quarantineStockId: string }) => {
  const d = pendingDestroyCalls.shift();
  if (d) return d.promise;
  return Promise.resolve({ ok: true, data: { movement_id: 'm2' } });
});

vi.mock('@/features/inventory/quarantine.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/features/inventory/quarantine.service')>();
  return {
    ...actual,
    getQuarantineStock: (warehouseId: string): Promise<QRow[]> => {
      getQuarantineStockCalls.push(warehouseId);
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
  return { ...actual, getWarehouseStock: (warehouseId: string) => Promise.resolve(settledStock.get(warehouseId) ?? []) };
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
  settledStock.clear();
  getQuarantineStockCalls.length = 0;
  pendingReleaseCalls.length = 0;
  pendingDestroyCalls.length = 0;
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
    // health_center_manager keeps the tab visible independent of
    // canDisposeQuarantine's own staleness window (documented, unchanged,
    // out of scope here) — isolating what this test checks: the dispose
    // buttons, not tab-visibility timing.
    appState = { ...appState, role: 'health_center_manager', profile: { ...appState.profile, role: 'health_center_manager' } };
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
  // No "if (!confirm.disabled)" escape hatch here: without a matching
  // destination lot the release confirm button is disabled and the whole
  // assertion block below it would silently never run — the earlier version
  // of this test guarded on exactly that and so never actually asserted
  // anything for release. A genuinely matching warehouse_stock lot is
  // provided so the button really does activate and the click is real.

  it('release: the confirm button activates on a matching lot and the service is called exactly once with the open row', async () => {
    const row = quarantineRow('row-a1', WH_A, 'Alpha');
    settleRowsImmediately(WH_A, [row]);
    settlePermissionImmediately(WH_A, true);
    setWarehouseStock(WH_A, [matchingStockBatch('lot-a1', row)]);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    fireEvent.click(screen.getByText('إفراج'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });

    const confirm = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإفراج') as HTMLButtonElement;
      expect(btn.disabled, 'a matching lot must activate the confirm button').toBe(false);
      return btn;
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(releaseQuarantineStock).toHaveBeenCalledTimes(1));
    expect(releaseQuarantineStock.mock.calls[0][0].quarantineStockId).toBe('row-a1');
  });

  it('destroy: the confirm button activates (no destination lot needed) and the service is called exactly once with the open row', async () => {
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إتلاف')).toBeInTheDocument());

    fireEvent.click(screen.getByText('إتلاف'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });

    const confirm = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإتلاف') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(destroyQuarantineStock).toHaveBeenCalledTimes(1));
    expect(destroyQuarantineStock.mock.calls[0][0].quarantineStockId).toBe('row-a1');
  });

  it('after switching warehouse, the submitted id belongs to the CURRENTLY selected warehouse’s row, never a stale one', async () => {
    const rowA = quarantineRow('row-a1', WH_A, 'Alpha');
    const rowB = quarantineRow('row-b1', WH_B, 'Beta');
    settleRowsImmediately(WH_A, [rowA]);
    settlePermissionImmediately(WH_A, true);
    setWarehouseStock(WH_A, [matchingStockBatch('lot-a1', rowA)]);
    settleRowsImmediately(WH_B, [rowB]);
    settlePermissionImmediately(WH_B, true);
    setWarehouseStock(WH_B, [matchingStockBatch('lot-b1', rowB)]);

    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    await selectWarehouse(WH_B);
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
    fireEvent.click(screen.getByText('إفراج'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirm = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإفراج') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    fireEvent.click(confirm);

    await waitFor(() => expect(releaseQuarantineStock).toHaveBeenCalledTimes(1));
    expect(releaseQuarantineStock.mock.calls[0][0].quarantineStockId).toBe('row-b1');
  });
});

describe('reproduction — an action opened on A completes AFTER the operator has already switched to B', () => {
  it('release: A’s completion does not reload A into view, and does not touch B’s rows, form, busy state, or toast', async () => {
    const rowA = quarantineRow('row-a1', WH_A, 'Alpha');
    const rowB = quarantineRow('row-b1', WH_B, 'Beta');
    settleRowsImmediately(WH_A, [rowA]);
    settlePermissionImmediately(WH_A, true);
    setWarehouseStock(WH_A, [matchingStockBatch('lot-a1', rowA)]);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    fireEvent.click(screen.getByText('إفراج'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإفراج') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });

    const releaseCall = holdRelease();
    fireEvent.click(confirmA);
    await waitFor(() => expect(releaseQuarantineStock).toHaveBeenCalledTimes(1));

    // Switch away from A to B WHILE A's release request is still pending.
    settleRowsImmediately(WH_B, [rowB]);
    settlePermissionImmediately(WH_B, true);
    getQuarantineStockCalls.length = 0; // only care about fetches AFTER this point
    await selectWarehouse(WH_B);
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    // NOW A's release finally completes, entirely after the switch.
    releaseCall.resolve({ ok: true, data: { movement_id: 'm1' } });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(screen.getByText('Beta'), 'B’s row must still be shown').toBeInTheDocument();
    expect(screen.queryByText('Alpha'), 'A must not reappear — this is not a resubmit or auto-restore of A').toBeNull();
    expect(screen.queryByText('تم الإفراج بنجاح'), 'A’s own success toast must not surface while viewing B').toBeNull();
    expect(screen.getByText('إفراج'), 'B’s own dispose affordance must remain, undisturbed by A’s completion').toBeInTheDocument();
    expect(
      getQuarantineStockCalls,
      'A’s stale onDone must not call reload() and re-fetch A — the request-generation counter alone does not catch this, since a stale reload() looks like a legitimate newest request',
    ).not.toContain(WH_A);
  });

  it('destroy: A’s completion does not reload A into view, and does not touch B’s rows, form, busy state, or toast', async () => {
    const rowA = quarantineRow('row-a1', WH_A, 'Alpha');
    const rowB = quarantineRow('row-b1', WH_B, 'Beta');
    settleRowsImmediately(WH_A, [rowA]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إتلاف')).toBeInTheDocument());

    fireEvent.click(screen.getByText('إتلاف'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإتلاف') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });

    const destroyCall = holdDestroy();
    fireEvent.click(confirmA);
    await waitFor(() => expect(destroyQuarantineStock).toHaveBeenCalledTimes(1));

    settleRowsImmediately(WH_B, [rowB]);
    settlePermissionImmediately(WH_B, true);
    getQuarantineStockCalls.length = 0;
    await selectWarehouse(WH_B);
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('إتلاف')).toBeInTheDocument());

    destroyCall.resolve({ ok: true, data: { movement_id: 'm2' } });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(screen.getByText('Beta'), 'B’s row must still be shown').toBeInTheDocument();
    expect(screen.queryByText('Alpha'), 'A must not reappear').toBeNull();
    expect(screen.queryByText('تم الإتلاف بنجاح'), 'A’s own success toast must not surface while viewing B').toBeNull();
    expect(screen.getByText('إتلاف')).toBeInTheDocument();
    expect(getQuarantineStockCalls, 'A’s stale onDone must not re-fetch A').not.toContain(WH_A);
  });
});

describe('reproduction — the busy slot must be OWNED by the action that claimed it, not merely gated on warehouseId', () => {
  it('a partial release from A, completed while B is on screen, must not leave the remaining A row stuck busy once the operator returns', async () => {
    const rowA = quarantineRow('row-a1', WH_A, 'Alpha');
    settleRowsImmediately(WH_A, [rowA]);
    settlePermissionImmediately(WH_A, true);
    setWarehouseStock(WH_A, [matchingStockBatch('lot-a1', rowA)]);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    fireEvent.click(screen.getByText('إفراج'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب' } });
    // Partial: row.quantity is 5, releasing only 2 — the row survives.
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '2' } });
    const confirmA = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإفراج') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });

    const releaseCall = holdRelease();
    fireEvent.click(confirmA);
    await waitFor(() => expect(releaseQuarantineStock).toHaveBeenCalledTimes(1));

    // Switch to B while A's partial release is still in flight.
    const rowB = quarantineRow('row-b1', WH_B, 'Beta');
    settleRowsImmediately(WH_B, [rowB]);
    settlePermissionImmediately(WH_B, true);
    await selectWarehouse(WH_B);
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());

    // The old release completes while B is shown.
    releaseCall.resolve({ ok: true, data: { movement_id: 'm1' } });
    await new Promise(resolve => setTimeout(resolve, 20));

    // Return to A — server-side the row survived with less stock; the
    // fixture is refreshed to reflect that (same id, still present).
    settleRowsImmediately(WH_A, [quarantineRow('row-a1', WH_A, 'Alpha')]);
    await selectWarehouse(WH_A);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('إفراج')).toBeInTheDocument());

    fireEvent.click(screen.getByText('إفراج'));
    await waitFor(() => expect(screen.getByLabelText('سبب القرار')).toBeInTheDocument());
    const reasonInput = screen.getByLabelText('سبب القرار') as HTMLInputElement;
    const quantityInput = screen.getByLabelText('الكمية') as HTMLInputElement;
    const cancelBtn = screen.getByText('إلغاء') as HTMLButtonElement;
    expect(reasonInput, 'reason field must not be stuck disabled by the OLD, already-completed action').not.toBeDisabled();
    expect(quantityInput, 'quantity field must not be stuck disabled').not.toBeDisabled();
    expect(cancelBtn, 'cancel must not be stuck disabled').not.toBeDisabled();

    fireEvent.change(reasonInput, { target: { value: 'سبب جديد' } });
    fireEvent.change(quantityInput, { target: { value: '1' } });
    await waitFor(() => {
      const confirmNew = screen.getByText('تأكيد الإفراج') as HTMLButtonElement;
      expect(confirmNew, 'confirm must be reachable again — the row must not be permanently locked').not.toBeDisabled();
    });
  });

  it('destroy: an old, long-pending action on A1 that finally SUCCEEDS after a trip to B and back must not touch a newer, still-pending action on A2', async () => {
    const rowA1 = quarantineRow('row-a1', WH_A, 'Alpha');
    const rowA2 = quarantineRow('row-a2', WH_A, 'Gamma');
    settleRowsImmediately(WH_A, [rowA1, rowA2]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());

    // Start (but do not finish) a destroy on A1 — the first row in DOM order.
    fireEvent.click(screen.getAllByText('إتلاف')[0]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب أول' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA1 = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإتلاف') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    const destroyCallA1 = holdDestroy();
    fireEvent.click(confirmA1);
    await waitFor(() => expect(destroyQuarantineStock).toHaveBeenCalledTimes(1));

    // Leave to B and come back to A — A1's action is STILL pending the
    // whole time; nothing about it has settled yet.
    const rowB = quarantineRow('row-b1', WH_B, 'Beta');
    settleRowsImmediately(WH_B, [rowB]);
    settlePermissionImmediately(WH_B, true);
    await selectWarehouse(WH_B);
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());

    settleRowsImmediately(WH_A, [rowA1, rowA2]); // fresh fetch on return — nothing has changed server-side yet
    await selectWarehouse(WH_A);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());

    // Start a NEW action on A2, on this fresh visit.
    fireEvent.click(screen.getAllByText('إتلاف')[1]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب ثانٍ' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA2 = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإتلاف') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    const destroyCallA2 = holdDestroy(); // A2's own request must stay genuinely in flight throughout
    fireEvent.click(confirmA2);
    await waitFor(() => expect(destroyQuarantineStock).toHaveBeenCalledTimes(2));

    // A2's own form is now genuinely busy (its own request is in flight,
    // still unresolved).
    expect(screen.getByLabelText('الكمية'), 'A2 must read busy right before A1’s stale completion arrives').toBeDisabled();

    // NOW A1's OLD, long-pending destroy finally completes — successfully.
    destroyCallA1.resolve({ ok: true, data: { movement_id: 'm-old' } });
    await new Promise(resolve => setTimeout(resolve, 30));

    // A2's own busy state, form, and confirm reachability must be
    // completely undisturbed by A1's unrelated completion.
    expect(screen.getByLabelText('الكمية'), 'A1 completing must not clear A2’s busy slot').toBeDisabled();
    expect(screen.getByLabelText('سبب القرار'), 'A2’s form must remain exactly as it was').toBeDisabled();
    expect(destroyQuarantineStock, 'no extra confirm must have been reachable/sendable for A2').toHaveBeenCalledTimes(2);

    destroyCallA2.resolve({ ok: true, data: { movement_id: 'm-a2' } });
    await new Promise(resolve => setTimeout(resolve, 20));
  });

  it('destroy: an old, long-pending action on A1 that finally FAILS after a trip to B and back must not touch a newer, still-pending action on A2', async () => {
    const rowA1 = quarantineRow('row-a1', WH_A, 'Alpha');
    const rowA2 = quarantineRow('row-a2', WH_A, 'Gamma');
    settleRowsImmediately(WH_A, [rowA1, rowA2]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('إتلاف')[0]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب أول' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA1 = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإتلاف') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    const destroyCallA1 = holdDestroy();
    fireEvent.click(confirmA1);
    await waitFor(() => expect(destroyQuarantineStock).toHaveBeenCalledTimes(1));

    const rowB = quarantineRow('row-b1', WH_B, 'Beta');
    settleRowsImmediately(WH_B, [rowB]);
    settlePermissionImmediately(WH_B, true);
    await selectWarehouse(WH_B);
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());

    settleRowsImmediately(WH_A, [rowA1, rowA2]);
    await selectWarehouse(WH_A);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('إتلاف')[1]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب ثانٍ' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA2 = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإتلاف') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    const destroyCallA2 = holdDestroy(); // A2's own request must stay genuinely in flight throughout
    fireEvent.click(confirmA2);
    await waitFor(() => expect(destroyQuarantineStock).toHaveBeenCalledTimes(2));

    expect(screen.getByLabelText('الكمية')).toBeDisabled();

    // A1's OLD action finally settles — this time with a failure.
    destroyCallA1.resolve({ ok: false, error: 'CONFLICT' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(screen.getByLabelText('الكمية'), 'A1 failing must not clear A2’s busy slot either').toBeDisabled();
    expect(screen.getByLabelText('سبب القرار')).toBeDisabled();
    expect(destroyQuarantineStock).toHaveBeenCalledTimes(2);
    // A1's own failure toast is expected to surface — A1's action was NOT
    // superseded by A2 starting (they occupy separate registry entries,
    // keyed by row, not a single shared slot); it is a real, independent
    // completion of A1's own request, on the warehouse currently on
    // screen. What must hold is that it says nothing about A2, and A2's
    // own state above is untouched by it.
    expect(screen.getByText(/فشل الإجراء/)).toBeInTheDocument();

    destroyCallA2.resolve({ ok: true, data: { movement_id: 'm-a2' } });
    await new Promise(resolve => setTimeout(resolve, 20));
  });
});

describe('reproduction — a single shared slot cannot track two genuinely concurrent pending operations', () => {
  it('release: A1 pending → B → A → A2 pending → a reconfirm attempt on A1 sends no third request; completing A1 first (success) then A2 (failure) frees both rows without opening either early', async () => {
    const rowA1 = quarantineRow('row-a1', WH_A, 'Alpha');
    const rowA2 = quarantineRow('row-a2', WH_A, 'Gamma');
    settleRowsImmediately(WH_A, [rowA1, rowA2]);
    settlePermissionImmediately(WH_A, true);
    setWarehouseStock(WH_A, [matchingStockBatch('lot-a1', rowA1), matchingStockBatch('lot-a2', rowA2)]);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());

    // Start (but do not finish) a release on A1.
    fireEvent.click(screen.getAllByText('إفراج')[0]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب أول' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA1 = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإفراج') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    const releaseCallA1 = holdRelease();
    fireEvent.click(confirmA1);
    await waitFor(() => expect(releaseQuarantineStock).toHaveBeenCalledTimes(1));

    // Leave to B and back to A — A1's release is STILL pending throughout;
    // this remounts a brand new QuarantineRow for row-a1, with mode back
    // at 'none' and no memory of the click above.
    const rowB = quarantineRow('row-b1', WH_B, 'Beta');
    settleRowsImmediately(WH_B, [rowB]);
    settlePermissionImmediately(WH_B, true);
    await selectWarehouse(WH_B);
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());

    settleRowsImmediately(WH_A, [rowA1, rowA2]); // fresh fetch — nothing changed server-side yet
    await selectWarehouse(WH_A);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());

    // Start a NEW action on A2, on this fresh visit — A1's original
    // request is still outstanding the whole time.
    fireEvent.click(screen.getAllByText('إفراج')[1]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب ثانٍ' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA2 = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإفراج') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    const releaseCallA2 = holdRelease();
    fireEvent.click(confirmA2);
    await waitFor(() => expect(releaseQuarantineStock).toHaveBeenCalledTimes(2));

    // Attempt to reconfirm A1 again on this fresh mount. Its own earlier
    // request is still in flight, so it must already read busy — before
    // even trying to click confirm.
    fireEvent.click(screen.getAllByText('إفراج')[0]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(2));
    const quantityA1Retry = screen.getAllByLabelText('الكمية')[0] as HTMLInputElement;
    const confirmA1Retry = screen.getAllByText('تأكيد الإفراج')[0] as HTMLButtonElement;
    expect(quantityA1Retry, 'A1 must already read busy — its own earlier request is still outstanding').toBeDisabled();
    expect(confirmA1Retry, 'confirm must already be disabled too').toBeDisabled();
    fireEvent.click(confirmA1Retry); // disabled — must be a no-op
    expect(releaseQuarantineStock, 'the reconfirm attempt on A1 must not have sent a third request').toHaveBeenCalledTimes(2);

    // Complete A1 first — successfully.
    releaseCallA1.resolve({ ok: true, data: { movement_id: 'm-a1' } });
    await new Promise(resolve => setTimeout(resolve, 30));

    // A2 must be completely unaffected: A1 finishing must not open A2.
    expect(screen.getAllByLabelText('الكمية')[1], 'A2 must remain busy — A1 finishing must not free A2 early').toBeDisabled();
    expect(releaseQuarantineStock).toHaveBeenCalledTimes(2);
    // A1's own row, meanwhile, must be free again — its earlier request
    // (the one actually sent) has genuinely finished.
    await waitFor(() => expect(screen.getAllByLabelText('الكمية')[0]).not.toBeDisabled());

    // Now complete A2 — this time with a failure.
    releaseCallA2.resolve({ ok: false, error: 'CONFLICT' });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(releaseQuarantineStock).toHaveBeenCalledTimes(2);
    // A2 must be free again too — not left stuck busy by its own failure.
    await waitFor(() => expect(screen.getAllByLabelText('الكمية')[1]).not.toBeDisabled());
  });

  it('destroy: A1 pending → B → A → A2 pending → a reconfirm attempt on A1 sends no third request; completing A2 first (failure) then A1 (success) frees both rows without opening either early', async () => {
    const rowA1 = quarantineRow('row-a1', WH_A, 'Alpha');
    const rowA2 = quarantineRow('row-a2', WH_A, 'Gamma');
    settleRowsImmediately(WH_A, [rowA1, rowA2]);
    settlePermissionImmediately(WH_A, true);
    render(<InventoryCenterScreen />);
    await selectWarehouse(WH_A);
    await openQuarantineTab();
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('إتلاف')[0]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب أول' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA1 = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإتلاف') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    const destroyCallA1 = holdDestroy();
    fireEvent.click(confirmA1);
    await waitFor(() => expect(destroyQuarantineStock).toHaveBeenCalledTimes(1));

    const rowB = quarantineRow('row-b1', WH_B, 'Beta');
    settleRowsImmediately(WH_B, [rowB]);
    settlePermissionImmediately(WH_B, true);
    await selectWarehouse(WH_B);
    await waitFor(() => expect(screen.getByText('Beta')).toBeInTheDocument());

    settleRowsImmediately(WH_A, [rowA1, rowA2]);
    await selectWarehouse(WH_A);
    await waitFor(() => expect(screen.getByText('Alpha')).toBeInTheDocument());
    await waitFor(() => expect(screen.getByText('Gamma')).toBeInTheDocument());

    fireEvent.click(screen.getAllByText('إتلاف')[1]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(1));
    fireEvent.change(screen.getByLabelText('سبب القرار'), { target: { value: 'سبب ثانٍ' } });
    fireEvent.change(screen.getByLabelText('الكمية'), { target: { value: '1' } });
    const confirmA2 = await waitFor(() => {
      const btn = screen.getByText('تأكيد الإتلاف') as HTMLButtonElement;
      expect(btn.disabled).toBe(false);
      return btn;
    });
    const destroyCallA2 = holdDestroy();
    fireEvent.click(confirmA2);
    await waitFor(() => expect(destroyQuarantineStock).toHaveBeenCalledTimes(2));

    fireEvent.click(screen.getAllByText('إتلاف')[0]);
    await waitFor(() => expect(screen.getAllByLabelText('سبب القرار')).toHaveLength(2));
    const quantityA1Retry = screen.getAllByLabelText('الكمية')[0] as HTMLInputElement;
    const confirmA1Retry = screen.getAllByText('تأكيد الإتلاف')[0] as HTMLButtonElement;
    expect(quantityA1Retry, 'A1 must already read busy — its own earlier request is still outstanding').toBeDisabled();
    expect(confirmA1Retry).toBeDisabled();
    fireEvent.click(confirmA1Retry);
    expect(destroyQuarantineStock, 'the reconfirm attempt on A1 must not have sent a third request').toHaveBeenCalledTimes(2);

    // Complete A2 FIRST this time — with a failure — the opposite order
    // from the release test above.
    destroyCallA2.resolve({ ok: false, error: 'CONFLICT' });
    await new Promise(resolve => setTimeout(resolve, 30));

    // A1 must be completely unaffected: A2 finishing must not free A1.
    expect(screen.getAllByLabelText('الكمية')[0], 'A1 must remain busy — A2 finishing must not free A1 early').toBeDisabled();
    expect(destroyQuarantineStock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getAllByLabelText('الكمية')[1]).not.toBeDisabled());

    // Now complete A1 — successfully.
    destroyCallA1.resolve({ ok: true, data: { movement_id: 'm-a1' } });
    await new Promise(resolve => setTimeout(resolve, 30));

    expect(destroyQuarantineStock).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getAllByLabelText('الكمية')[0]).not.toBeDisabled());
  });
});
