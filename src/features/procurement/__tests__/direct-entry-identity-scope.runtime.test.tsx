/**
 * @vitest-environment jsdom
 *
 * CI-3 / R-2 — the direct-entry attempt scope, through the REAL LocalProcurementScreen.
 *
 * The unresolved attempt store is keyed by identity + organization + warehouse. The
 * panel-level suite passes that scope in directly, so the wiring in
 * LocalProcurementScreen is proven here: two operators in the SAME organization and
 * warehouse must never share an in-flight purchase, its key or its outcome.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { t } from '@/shared/i18n/strings';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import { LocalProcurementScreen } from '../LocalProcurementScreen';

const hooks = vi.hoisted(() => ({
  rpc: vi.fn(),
  newRequestId: vi.fn(),
  useInventoryScopes: vi.fn(),
  useProcurementPermissions: vi.fn(),
  getSession: vi.fn(),
}));

interface AppMock {
  lang: 'ar' | 'en';
  dir: 'rtl' | 'ltr';
  activeOrgId: string | null;
  activeOrganizationKind: 'care_institution';
  activeOrganizationKindPending: boolean;
  profile: { id: string; role: string; organization_id: string | null };
}
let app: AppMock;
vi.mock('@/app/AppContext', () => ({ useApp: () => app }));

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  // CI-4D-A: every send first reads the live auth session (shared by all tabs of the browser).
  supabase: {
    rpc: (...args: unknown[]) => hooks.rpc(...args),
    auth: { getSession: () => hooks.getSession() },
  },
}));
vi.mock('../procurement.service', () => ({
  newRequestId: () => hooks.newRequestId(),
  getDuplicateCandidates: vi.fn(async () => []),
}));
vi.mock('@/features/inventory/useInventoryScopes', () => ({
  useInventoryScopes: (...args: unknown[]) => hooks.useInventoryScopes(...args),
}));
vi.mock('../useProcurementPermissions', () => ({
  useProcurementPermissions: (...args: unknown[]) => hooks.useProcurementPermissions(...args),
}));
vi.mock('@/shared/ui/PhoenixOrgScope', () => ({ PhoenixOrgScope: () => <div data-testid="org-scope-stub" /> }));
vi.mock('../PurchaseHistoryPanel', () => ({ PurchaseHistoryPanel: () => <div data-testid="purchase-history-stub" /> }));
// The resolver has its own coverage: here it is one button that selects one registered material.
vi.mock('@/shared/materials/PhoenixMaterialResolver', () => ({
  PhoenixMaterialResolver: ({ onSelect }: { onSelect: (m: ResolvedMaterial) => void }) => (
    <button
      type="button"
      onClick={() => onSelect({
        source: 'catalog', centralItemId: 'ci-1', warehouseStockId: null,
        scientificName: 'Paracetamol', tradeName: null, concentration: null, dosageForm: null,
        unit: null, nationalCode: null, barcode: null, batchNumber: null, expiryDate: null,
        onHand: null, reserved: null, available: null, supplyType: null, grade: 'confirmed',
        reasonKey: 'x', canonical: undefined,
      } as unknown as ResolvedMaterial)}
    >
      pick-material
    </button>
  ),
}));

const ORG = 'care-org-1';
const WAREHOUSE = { id: 'wh-1', name: 'Main store', nameAr: 'المخزن الرئيسي' };

function appFor(profileId: string): AppMock {
  return {
    lang: 'en',
    dir: 'ltr',
    activeOrgId: ORG,
    activeOrganizationKind: 'care_institution',
    activeOrganizationKindPending: false,
    profile: { id: profileId, role: 'warehouse_officer', organization_id: ORG },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const RECORDED = { data: { ok: true, idempotent_replay: false, order_number: 'SP-1', receipt_number: 'R-1' }, error: null };

let keySeq = 0;
/** Each test gets its own operator ids: the attempt store is module-level, so isolation must come from the scope. */
let testSeq = 0;

beforeEach(() => {
  testSeq += 1;
  keySeq = 0;
  hooks.rpc.mockReset();
  hooks.newRequestId.mockReset();
  hooks.newRequestId.mockImplementation(() => {
    keySeq += 1;
    return `key-${keySeq}`;
  });
  hooks.useInventoryScopes.mockReset();
  hooks.useInventoryScopes.mockReturnValue({ loading: false, data: { manageableWarehouses: [WAREHOUSE] } });
  hooks.useProcurementPermissions.mockReset();
  hooks.useProcurementPermissions.mockReturnValue({
    loading: false,
    data: { canView: true, canManage: true, canApprove: false, canReceive: true, canReturn: false },
  });
  app = appFor(`operator-a-${testSeq}`);
  // By default the live auth session is whoever this tab's AppContext shows; a test can make them diverge.
  sessionUser = null;
  hooks.getSession.mockReset();
  hooks.getSession.mockImplementation(async () => ({ data: { session: { user: { id: sessionUser ?? app.profile.id } } }, error: null }));
});

afterEach(() => {
  cleanup();
});

/** The user of the browser's shared auth session when it differs from this tab's AppContext (another tab signed in). */
let sessionUser: string | null = null;

/** CI-4D-A: a send now waits for the live identity check (an asynchronous session read). Lets it settle; no timer moves. */
async function settleIdentityCheck() {
  await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
}

function submitButton() {
  const buttons = screen.getAllByRole('button');
  return buttons[buttons.length - 1];
}

function fillValidPayload(batch: string, quantity: string) {
  const pick = screen.queryByRole('button', { name: 'pick-material' });
  if (pick) fireEvent.click(pick);
  fireEvent.change(screen.getByLabelText(t('mv_f_batch_number', 'en')), { target: { value: batch } });
  fireEvent.change(screen.getByLabelText(t('inv_quantity_received', 'en')), { target: { value: quantity } });
  fireEvent.click(screen.getByTestId('subpurchase-confirm'));
}

const requestIdOf = (call: number) => (hooks.rpc.mock.calls[call][1] as { p_request_id: string }).p_request_id;

describe('R-2 · the attempt scope is identity-bound, through LocalProcurementScreen', () => {
  it('NEGATIVE CONTROL: a second operator in the SAME organization and warehouse never attaches to the first operator\'s in-flight purchase', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);

    const first = render(<LocalProcurementScreen />);
    fillValidPayload('BATCH-A', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    first.unmount();

    app = appFor(`operator-b-${testSeq}`);
    render(<LocalProcurementScreen />);
    // Not busy: operator B has no attempt of its own in flight.
    expect(submitButton()).not.toHaveAttribute('aria-busy', 'true');
    fillValidPayload('BATCH-B', '4');
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));

    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
  });

  it('a remount of the SAME operator in the same workspace re-attaches to the in-flight purchase (no second dispatch)', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);

    const first = render(<LocalProcurementScreen />);
    fillValidPayload('BATCH-A', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    first.unmount();

    render(<LocalProcurementScreen />);
    expect(submitButton()).toHaveAttribute('aria-busy', 'true');
    fillValidPayload('BATCH-A', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);

    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
  });

  it('returning to Screen 19 after the purchase settled while away recovers the existing result, without a second purchase', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);
    const first = render(<LocalProcurementScreen />);
    fillValidPayload('BATCH-A', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    first.unmount();

    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
    render(<LocalProcurementScreen />);
    expect(screen.getByText('SP-1')).toBeInTheDocument();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE CONTROL (CI-4C): another operator in the same organization and warehouse never gets a status check for someone else\'s unresolved attempt', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    const first = render(<LocalProcurementScreen />);
    fillValidPayload('BATCH-A', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('button', { name: t('sp_attempt_check_status', 'en') })).toBeInTheDocument());
    first.unmount();

    app = appFor(`operator-b-${testSeq}`);
    render(<LocalProcurementScreen />);
    expect(screen.queryByRole('button', { name: t('sp_attempt_check_status', 'en') })).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByLabelText(t('mv_f_batch_number', 'en'))).not.toBeDisabled();
  });

  it('CROSS-USER (CI-4D-A): this tab still shows operator A but the browser session is operator B (another tab signed in): A\'s NEW purchase is not sent', async () => {
    render(<LocalProcurementScreen />);
    fillValidPayload('BATCH-A', '5');
    sessionUser = `operator-b-${testSeq}`;
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_identity_unsent', 'en'));
  });

  it('CROSS-USER (CI-4D-A): A\'s unresolved attempt is never re-sent under B\'s session; when A\'s session returns, the SAME request is sent', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    render(<LocalProcurementScreen />);
    fillValidPayload('BATCH-A', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    const retry = () => screen.getByRole('button', { name: t('sp_attempt_retry_original', 'en') });
    await waitFor(() => expect(retry()).not.toBeDisabled());

    sessionUser = `operator-b-${testSeq}`;
    fireEvent.click(retry());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByLabelText(t('mv_f_batch_number', 'en'))).toBeDisabled();
    // CI-4D-B: the refusal says the retry was not sent, the earlier attempt may be recorded, and who must sign in.
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_identity_retry_refused', 'en'));
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unknown', 'en'));

    sessionUser = null;
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fireEvent.click(retry());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).toBe(requestIdOf(0));
    expect(hooks.rpc.mock.calls[1][1]).toEqual(hooks.rpc.mock.calls[0][1]);
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('NEGATIVE CONTROL: another operator in the same organization and warehouse never sees a settled result', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);
    const first = render(<LocalProcurementScreen />);
    fillValidPayload('BATCH-A', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    first.unmount();
    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });

    app = appFor(`operator-b-${testSeq}`);
    render(<LocalProcurementScreen />);
    expect(screen.queryByText('SP-1')).toBeNull();
    expect(submitButton()).not.toHaveAttribute('aria-busy', 'true');
  });
});
