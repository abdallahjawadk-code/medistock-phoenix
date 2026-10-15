/**
 * @vitest-environment jsdom
 *
 * CI-4A — R-A (an ambiguous purchase attempt) and R-B (a settled result kept until the operator closes it),
 * through the REAL DirectEntryPanel. Outcomes are deferred promises: no sleeps, and the silent-request deadline
 * is driven by fake timers.
 *
 * The attempt store is module-level and lives for this page load only. Nothing here claims protection across a
 * full reload: that needs a server reconciliation contract, which is out of scope.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { t } from '@/shared/i18n/strings';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DirectEntryPanel } from '../DirectEntryPanel';
import { getDuplicateCandidates, reconcileDirectEntry, RECONCILE_DEADLINE_MS } from '../procurement.service';

const hooks = vi.hoisted(() => ({
  rpc: vi.fn(),
  newRequestId: vi.fn(),
}));

/**
 * CI-4C: a SIMULATED RLS-protected read surface for the confirm-only reconciliation reader. Each table holds the rows
 * the current caller is allowed to see (RLS is modelled by what is seeded), `.eq()` filters exactly, `.limit()` runs the
 * query. A table can be made to fail (`errors`) or to hang until released (`gates`). This is mock evidence, not a database.
 */
const db = vi.hoisted(() => {
  const state = {
    tables: {} as Record<string, Record<string, unknown>[]>,
    errors: {} as Record<string, { code?: string; message?: string }>,
    gates: {} as Record<string, Promise<void> | undefined>,
    reads: [] as string[],
    session: null as { user: { id: string } } | null,
    /** CI-4D-A: the auth session read can fail, throw, or hang until released; every read is counted. */
    sessionError: null as { message: string } | null,
    /** An error answer that ALSO carries the stored session (a client that does not clear it on error). */
    sessionErrorKeepsSession: false,
    sessionThrows: false,
    sessionGate: undefined as Promise<void> | undefined,
    sessionReads: 0,
    async getSession() {
      state.sessionReads += 1;
      if (state.sessionGate) await state.sessionGate;
      if (state.sessionThrows) throw new Error('session storage unavailable');
      if (state.sessionError) {
        return { data: { session: state.sessionErrorKeepsSession ? state.session : null }, error: state.sessionError };
      }
      return { data: { session: state.session }, error: null };
    },
    from(table: string) {
      const filters: Array<[string, unknown]> = [];
      const query = {
        select: () => query,
        eq: (column: string, value: unknown) => { filters.push([column, value]); return query; },
        limit: async (count: number) => {
          state.reads.push(table);
          if (state.gates[table]) await state.gates[table];
          if (state.errors[table]) return { data: null, error: state.errors[table] };
          const rows = (state.tables[table] ?? []).filter(row => filters.every(([c, v]) => row[c] === v));
          return { data: rows.slice(0, count), error: null };
        },
      };
      return query;
    },
  };
  return state;
});

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  supabase: {
    rpc: (...args: unknown[]) => hooks.rpc(...args),
    from: (table: string) => db.from(table),
    auth: { getSession: () => db.getSession() },
  },
}));
// The real reconciliation reader runs against the simulated read surface above; only the id mint and the advisory
// duplicate lookup are replaced.
vi.mock('../procurement.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../procurement.service')>()),
  newRequestId: () => hooks.newRequestId(),
  getDuplicateCandidates: vi.fn(async () => []),
}));
// The panel reads the signed-in profile and organization to bind an attempt to its owner.
vi.mock('@/app/AppContext', () => ({
  useApp: () => {
    // CI-4D-A: a test can make this tab's AppContext differ from the identity encoded in the panel's scope.
    if (appOverride !== null) return appOverride;
    const [profileId, orgId] = scopeKey.split('|');
    // CI-4D-A: an empty profile id models a tab whose profile is not loaded (no owner to bind an attempt to).
    return { profile: profileId ? { id: profileId } : null, activeOrgId: orgId || null };
  },
}));
vi.mock('@/shared/materials/PhoenixMaterialResolver', () => ({
  PhoenixMaterialResolver: ({ onSelect }: { onSelect: (m: ResolvedMaterial) => void }) => (
    <button
      type="button"
      // CI-4D-B: a stock lot result as the real resolver returns it — live stock figures and lot identifiers included —
      // so a test can prove the panel never retains them.
      onClick={() => onSelect({
        source: 'stock', centralItemId: 'ci-1', warehouseStockId: 'ws-stock-1',
        scientificName: 'Paracetamol', tradeName: 'Panadol', concentration: '500 mg', dosageForm: 'tablet',
        unit: 'box', nationalCode: 'NC-LOT', barcode: '6281000000001', batchNumber: 'LOT-STOCK-7', expiryDate: '2027-05-01',
        onHand: 500, reserved: 20, available: 480, supplyType: 'purchase', grade: 'confirmed',
        reasonKey: 'x', canonical: { scope: { warehouseStockId: 'ws-stock-1' }, eligibility: { availableQuantity: 480 } },
      } as unknown as ResolvedMaterial)}
    >
      pick-material
    </button>
  ),
}));

/** The silent-request deadline. Mirrors the product constant: a request with no answer after this becomes ambiguous. */
const DEADLINE_MS = 20_000;

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

const RECORDED = { data: { ok: true, idempotent_replay: false, order_number: 'SP-1', receipt_number: 'R-1' }, error: null };

let scopeSeq = 0;
let scopeKey = '';
let keySeq = 0;
let appOverride: { profile: { id: string } | null; activeOrgId: string | null } | null = null;

beforeEach(() => {
  scopeSeq += 1;
  scopeKey = `operator-${scopeSeq}|org-1`;
  keySeq = 0;
  db.tables = {};
  db.errors = {};
  db.gates = {};
  db.reads = [];
  db.session = { user: { id: `operator-${scopeSeq}` } };
  db.sessionError = null;
  db.sessionErrorKeepsSession = false;
  db.sessionThrows = false;
  db.sessionGate = undefined;
  db.sessionReads = 0;
  appOverride = null;
  hooks.rpc.mockReset();
  hooks.newRequestId.mockReset();
  hooks.newRequestId.mockImplementation(() => {
    keySeq += 1;
    return `key-${scopeSeq}-${keySeq}`;
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

/** CI-4D-A: a send now waits for the live identity check (an asynchronous session read). Lets it settle; no timer moves. */
async function settleIdentityCheck() {
  await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
}

const panel = (onDone: (k: string) => void = () => undefined) => (
  <DirectEntryPanel lang="en" warehouseId="wh-1" scopeKey={scopeKey} onDone={onDone} />
);

/** The submit button is the panel's last button (the result card and its Close button sit above the form). */
function submitButton() {
  const buttons = screen.getAllByRole('button');
  return buttons[buttons.length - 1];
}

function fillValidPayload(batch = 'BATCH-1', quantity = '5') {
  const pick = screen.queryByRole('button', { name: 'pick-material' });
  if (pick) fireEvent.click(pick);
  fireEvent.change(screen.getByLabelText(t('mv_f_batch_number', 'en')), { target: { value: batch } });
  fireEvent.change(screen.getByLabelText(t('inv_quantity_received', 'en')), { target: { value: quantity } });
  fireEvent.click(screen.getByTestId('subpurchase-confirm'));
}

const argsOf = (call: number) => hooks.rpc.mock.calls[call][1] as Record<string, unknown>;
const requestIdOf = (call: number) => argsOf(call).p_request_id;
const batchInput = () => screen.getByLabelText(t('mv_f_batch_number', 'en'));
const retryButton = () => screen.getByRole('button', { name: t('sp_attempt_retry_original', 'en') });
const closeButton = () => screen.getByRole('button', { name: t('sp_attempt_acknowledge', 'en') });
const checkButton = () => screen.getByRole('button', { name: t('sp_attempt_check_status', 'en') });
const currentActor = () => scopeKey.split('|')[0];

describe('CI-4A · R-A · an ambiguous purchase attempt is locked, and only its original request is retried', () => {
  it('a transport failure with no error code is ambiguous, not rejected: the attempt stays locked, and the retry carries the original request and payload', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    expect(batchInput()).toBeDisabled();

    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(argsOf(1)).toEqual(argsOf(0));
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
  });

  it('while the attempt is unresolved the payload cannot be edited: a change is refused, and the retry sends the original payload', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    render(panel());
    fillValidPayload('BATCH-1', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());

    fireEvent.change(batchInput(), { target: { value: 'BATCH-EDITED' } });
    expect(batchInput()).toHaveValue('BATCH-1');
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(argsOf(1)).toEqual(argsOf(0));
  });

  it('a coded refusal (SQLSTATE 23514) is a confirmed rejection: the attempt is released, the fields are editable, and the next purchase gets a new request id', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'batch_number_flag_mismatch' } });
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('batch_number_flag_mismatch'));
    expect(batchInput()).not.toBeDisabled();

    fillValidPayload('BATCH-2', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));
  });

  it('a PostgREST error that is not an RPC-absent code is ambiguous: the attempt stays locked', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: 'PGRST116', message: 'JSON object requested' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).toBeInTheDocument();
  });

  it('a success body that is not a recorded result is never treated as recorded: the attempt stays locked', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: null });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(batchInput()).toBeDisabled());
    expect(screen.queryByText(t('sp_entry_recorded', 'en'))).toBeNull();
    expect(retryButton()).toBeInTheDocument();
  });

  it('a readiness refusal with the RPC absent (42883) is a confirmed rejection: it is shown as unavailable (CI-4D-A operator wording) and the attempt is released', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'function does not exist' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unavailable', 'en')));
    expect(batchInput()).not.toBeDisabled();
  });

  it('no answer within the deadline makes the attempt ambiguous, never rejected; a late recorded answer is then recorded once', async () => {
    vi.useFakeTimers();
    const late = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(late.promise);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);

    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).toBeInTheDocument();
    // CI-4C: the unconfirmed outcome is stated in plain words (it was silent in CI-4A).
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unknown', 'en'));
    expect(hooks.rpc).toHaveBeenCalledTimes(1);

    await act(async () => { late.resolve(RECORDED); await late.promise; });
    expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('competing answers: a retry that settles first is the record, and the earlier answer arriving later creates no second record', async () => {
    vi.useFakeTimers();
    const first = deferred<typeof RECORDED>();
    const retry = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(retry.promise);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });

    fireEvent.click(retryButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(2);
    expect(argsOf(1)).toEqual(argsOf(0));

    const SAME = { data: { ok: true, idempotent_replay: true, order_number: 'SP-7', receipt_number: 'R-7' }, error: null };
    await act(async () => { retry.resolve(SAME); await retry.promise; });
    expect(screen.getByText('SP-7')).toBeInTheDocument();
    await act(async () => { first.resolve(SAME); await first.promise; });
    expect(screen.getAllByText('SP-7')).toHaveLength(1);
    expect(hooks.rpc).toHaveBeenCalledTimes(2);
  });

  it('a failed reconciliation stays locked, and a later successful reconciliation records the original purchase once', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up again'));
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));

    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up again'));
    expect(batchInput()).toBeDisabled();
    expect(argsOf(1)).toEqual(argsOf(0));

    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
    expect(hooks.rpc).toHaveBeenCalledTimes(3);
    expect(argsOf(2)).toEqual(argsOf(0));
  });

  it('a late transport failure that arrives after the attempt has recorded does not re-lock or alarm the settled purchase', async () => {
    vi.useFakeTimers();
    const second = deferred<typeof RECORDED>();
    let rejectFirst!: (reason: unknown) => void;
    const firstRejects = new Promise<typeof RECORDED>((_resolve, reject) => { rejectFirst = reject; });
    hooks.rpc.mockReturnValueOnce(firstRejects).mockReturnValueOnce(second.promise);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await act(async () => { second.resolve(RECORDED); await second.promise; });
    expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument();

    // The earlier request now fails at the transport: it must not change the recorded purchase.
    await act(async () => { rejectFirst(new Error('socket hang up')); await firstRejects.catch(() => undefined); });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument();
    expect(screen.getAllByText('SP-1')).toHaveLength(1);
  });
});

describe('CI-4B · a SQLSTATE is not proof of non-commit unless it is specific evidence', () => {
  it('23505 request_id_conflict needs reconciliation: the attempt is kept with its original request and payload, nothing is re-keyed or re-submitted, across a remount', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'request_id_conflict' } });
    const first = render(panel());
    fillValidPayload('BATCH-1', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(batchInput()).toBeDisabled();
    expect(submitButton()).toBeDisabled();

    fillValidPayload('BATCH-2', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(batchInput()).toHaveValue('BATCH-1');
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);

    first.unmount();
    render(panel());
    expect(batchInput()).toBeDisabled();
    expect(batchInput()).toHaveValue('BATCH-1');
    expect(submitButton()).toBeDisabled();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('a 23505 that answers a RETRY is also kept for reconciliation, not released', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'request_id_conflict' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(submitButton()).toBeDisabled());
    expect(batchInput()).toBeDisabled();
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('a state-dependent refusal (42501) that answers a RETRY is not proof of non-commit: the attempt stays locked with its original key', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42501', message: 'forbidden_local_procurement_manage' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('forbidden_local_procurement_manage'));
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).toBeInTheDocument();
    expect(argsOf(1)).toEqual(argsOf(0));
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('an RPC-absent refusal (42883) that answers a RETRY is not proof either: the attempt stays locked', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'function does not exist' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(retryButton()).toBeInTheDocument());
    expect(batchInput()).toBeDisabled();
  });

  it.each([
    ['57014', 'canceling statement due to statement timeout'],
    ['40001', 'could not serialize access due to concurrent update'],
    ['XX000', 'internal error'],
    ['23514', 'some_other_check_violation'],
    ['23514', 'destination_must_be_active_institution_warehouse'],
  ])('an unlisted or state-dependent SQLSTATE %s (%s) on a RETRY is ambiguous: locked, retry only', async (code, message) => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code, message } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).toBeInTheDocument();
  });

  it.each([
    ['57014', 'canceling statement due to statement timeout'],
    ['40001', 'could not serialize access due to concurrent update'],
    ['XX000', 'internal error'],
    ['23514', 'some_other_check_violation'],
  ])('an unlisted SQLSTATE %s (%s) on the FIRST dispatch is ambiguous, not a confirmed rejection', async (code, message) => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code, message } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).toBeInTheDocument();
  });

  // CI-4C reverses the CI-4B first-dispatch exception: one client dispatch does not prove one server execution
  // (a gateway or proxy may have retried it), so a state-dependent refusal never proves that nothing was committed.
  it.each([
    ['P0002', 'warehouse_not_found'],
    ['23514', 'destination_must_be_active_institution_warehouse'],
    ['42501', 'forbidden_local_procurement_manage'],
    ['42501', 'forbidden_local_procurement_receive'],
    ['28000', 'not_authenticated'],
  ])('CI-4C: a state-dependent refusal %s %s is ambiguous even on the FIRST dispatch', async (code, message) => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code, message } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(message));
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).toBeInTheDocument();
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('GUARD: a pure input check on the FIRST dispatch is still a confirmed rejection, stated in plain words', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'quantity_must_be_positive' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_rejected', 'en')));
    expect(batchInput()).not.toBeDisabled();
  });

  it('GUARD: a pure input check raised before the replay lookup (23514 batch_number_flag_mismatch) proves non-commit even on a retry', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'batch_number_flag_mismatch' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('batch_number_flag_mismatch'));
    expect(batchInput()).not.toBeDisabled();
  });

  it('GUARD: a successful replay after an ambiguous dispatch is still recorded (replay behaviour preserved)', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    hooks.rpc.mockResolvedValueOnce({ data: { ok: true, idempotent_replay: true, order_number: 'SP-1', receipt_number: 'R-1' }, error: null });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByText(t('sp_entry_replayed', 'en'))).toBeInTheDocument());
    expect(argsOf(1)).toEqual(argsOf(0));
  });
});

describe('CI-4A · R-B · a settled result is kept until the operator closes it', () => {
  it('a success that settles while the panel is unmounted is shown on remount, and no second purchase is dispatched', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);
    const first = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    first.unmount();

    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
    render(panel());
    expect(screen.getByText('SP-1')).toBeInTheDocument();
    // The result blocks a new submission even with a complete form.
    fillValidPayload('BATCH-2', '3');
    expect(submitButton()).toBeDisabled();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('the result is not acknowledged or discarded automatically: it survives repeated remounts until the operator closes it', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);
    const first = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    first.unmount();
    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });

    const second = render(panel());
    second.unmount();
    render(panel());
    expect(screen.getByText('SP-1')).toBeInTheDocument();

    fireEvent.click(closeButton());
    expect(screen.queryByText('SP-1')).toBeNull();
    hooks.rpc.mockResolvedValueOnce({ data: { ok: true, idempotent_replay: false, order_number: 'SP-2', receipt_number: 'R-2' }, error: null });
    fillValidPayload('BATCH-2', '3');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));
  });

  it('a replayed success is shown with the original identifiers and the replay wording', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: { ok: true, idempotent_replay: true, order_number: 'SP-1', receipt_number: 'R-1' }, error: null });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByText(t('sp_entry_replayed', 'en'))).toBeInTheDocument());
    expect(screen.getByText('SP-1')).toBeInTheDocument();
  });

  it('an organization switch during a pending attempt: the other organization gets its own purchase, and the original attempt still resolves for its own organization', async () => {
    const orgA = `operator-${scopeSeq}|org-A`;
    const orgB = `operator-${scopeSeq}|org-B`;
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);

    scopeKey = orgA;
    const first = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    first.unmount();

    scopeKey = orgB;
    render(panel());
    expect(batchInput()).not.toBeDisabled();
    fillValidPayload('BATCH-B', '2');
    hooks.rpc.mockResolvedValueOnce({ data: { ok: true, idempotent_replay: false, order_number: 'SP-B', receipt_number: 'R-B' }, error: null });
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByText('SP-B')).toBeInTheDocument());
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));
    cleanup();

    scopeKey = orgA;
    render(panel());
    expect(submitButton()).toHaveAttribute('aria-busy', 'true');
    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
    await waitFor(() => expect(screen.getByText('SP-1')).toBeInTheDocument());
    expect(screen.queryByText('SP-B')).toBeNull();
  });
});

/** The frozen RPC arguments of one direct-entry attempt, without the request id (exactly what the panel freezes). */
const SAMPLE_ARGS: Readonly<Record<string, unknown>> = Object.freeze({
  p_warehouse_id: 'wh-1', p_scientific_name: 'Paracetamol', p_quantity: 5,
  p_batch_number: 'BATCH-1', p_has_no_batch: false, p_expiry_date: '2027-01-31', p_unit_price: 2.5,
  p_purchase_date: null, p_invoice_number: 'INV-1', p_supplier_name: 'Acme Pharma', p_notes: null,
  p_central_item_id: 'ci-1', p_trade_name: null, p_concentration: null, p_dosage_form: null, p_unit: null,
  p_national_code: 'NC-1',
});

interface SeedOverrides {
  receivedBy?: string;
  receiptOrganization?: string;
  receiptWarehouse?: string;
  orderOrganization?: string;
  orderVisible?: boolean;
  eventPayload?: Record<string, unknown>;
  quantity?: number;
  batch?: string | null;
  unitPrice?: number | null;
  supplierName?: string;
  extraReceipt?: boolean;
  /** What 116 stored, when it differs from the raw argument (116 btrims text: only U+0020 spaces are removed). */
  scientificName?: string;
  purchaseDate?: string | null;
  orderNotes?: string | null;
  receiptNotes?: string | null;
  centralItemId?: string | null;
  tradeName?: string | null;
  concentration?: string | null;
  dosageForm?: string | null;
  unit?: string | null;
  receiptNationalCode?: string | null;
}

const pick = <V,>(override: V | undefined, fallback: V): V => (override === undefined ? fallback : override);

/** Seeds the rows the caller could read if the purchase had been recorded by the server under `requestId`. */
function seedRecordedPurchase(requestId: string, args: Readonly<Record<string, unknown>>, over: SeedOverrides = {}) {
  const receipt = {
    id: 'rcpt-1', order_id: 'ord-1', request_id: requestId, receipt_number: 'R-9',
    organization_id: over.receiptOrganization ?? 'org-1', warehouse_id: over.receiptWarehouse ?? 'wh-1',
    received_by: over.receivedBy ?? currentActor(), notes: pick(over.receiptNotes, args.p_notes ?? null),
  };
  db.tables.procurement_receipts = over.extraReceipt ? [receipt, { ...receipt, id: 'rcpt-2' }] : [receipt];
  db.tables.procurement_orders = over.orderVisible === false ? [] : [{
    id: 'ord-1', organization_id: over.orderOrganization ?? 'org-1', warehouse_id: 'wh-1', supplier_id: 'sup-1',
    order_number: 'SP-9', invoice_number: args.p_invoice_number ?? null,
    invoice_date: pick(over.purchaseDate, args.p_purchase_date ?? null), notes: pick(over.orderNotes, args.p_notes ?? null),
  }];
  db.tables.procurement_order_events = [{
    order_id: 'ord-1', event_type: 'created', payload: over.eventPayload ?? { direct_entry: true, request_id: requestId },
  }];
  db.tables.procurement_order_lines = [{
    id: 'ol-1', order_id: 'ord-1', scientific_name: over.scientificName ?? args.p_scientific_name,
    national_code: args.p_national_code ?? null, ordered_quantity: over.quantity ?? args.p_quantity,
    central_item_id: pick(over.centralItemId, args.p_central_item_id ?? null),
    trade_name: pick(over.tradeName, args.p_trade_name ?? null), concentration: pick(over.concentration, args.p_concentration ?? null),
    dosage_form: pick(over.dosageForm, args.p_dosage_form ?? null), unit: pick(over.unit, args.p_unit ?? null),
  }];
  db.tables.procurement_receipt_lines = [{
    receipt_id: 'rcpt-1', order_line_id: 'ol-1', quantity: over.quantity ?? args.p_quantity,
    batch_number: over.batch === undefined ? args.p_batch_number : over.batch,
    has_no_batch_number: args.p_has_no_batch, national_code: pick(over.receiptNationalCode, args.p_national_code ?? null),
    expiry_date: args.p_expiry_date ?? null, unit_price: over.unitPrice === undefined ? (args.p_unit_price ?? null) : over.unitPrice,
  }];
  db.tables.procurement_suppliers = [{ id: 'sup-1', name: over.supplierName ?? ((args.p_supplier_name as string | null) ?? 'شراء مباشر') }];
}

const expectation = (over: Record<string, unknown> = {}) => ({
  requestId: 'req-sample', actorId: currentActor(), organizationId: 'org-1', warehouseId: 'wh-1', args: SAMPLE_ARGS, ...over,
});

/** The frozen arguments the panel dispatched (call 0), split into request id and payload. */
function dispatchedAttempt() {
  const { p_request_id: requestId, ...frozen } = argsOf(0);
  return { requestId: requestId as string, frozen };
}

describe('CI-4C · confirm-only reconciliation reader (SIMULATED RLS read surface)', () => {
  it('confirms a matching receipt only when every check passes, and never writes', async () => {
    seedRecordedPurchase('req-sample', SAMPLE_ARGS);
    await expect(reconcileDirectEntry(expectation())).resolves.toEqual({ status: 'confirmed', orderNumber: 'SP-9', receiptNumber: 'R-9' });
    expect(hooks.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, () => void, string]>([
    ['nothing readable (unknown request, RLS-filtered, not yet committed)', () => { /* no rows */ }, 'not_found'],
    ['a receipt recorded by another operator (same organization and warehouse)', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { receivedBy: 'colleague' }), 'not_own_receipt'],
    ['a receipt in another warehouse', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { receiptWarehouse: 'wh-2' }), 'scope_mismatch'],
    ['a receipt in another organization', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { receiptOrganization: 'org-2' }), 'scope_mismatch'],
    ['an order that is not readable', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { orderVisible: false }), 'order_mismatch'],
    ['an order in another scope', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { orderOrganization: 'org-2' }), 'order_mismatch'],
    ['no direct-entry provenance on the order', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { eventPayload: {} }), 'provenance_missing'],
    ['provenance for another request id', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { eventPayload: { direct_entry: true, request_id: 'other' } }), 'provenance_missing'],
    ['a different quantity', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { quantity: 6 }), 'payload_mismatch'],
    ['a different batch', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { batch: 'OTHER' }), 'payload_mismatch'],
    ['a different unit price', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { unitPrice: 3 }), 'payload_mismatch'],
    ['a different supplier', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { supplierName: 'Other Co' }), 'payload_mismatch'],
    // CI-4C review: every argument 116 persists is compared, not only the replay fingerprint (116:109-113).
    ['a different purchase date', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { purchaseDate: '2026-01-01' }), 'payload_mismatch'],
    ['different order notes', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { orderNotes: 'other' }), 'payload_mismatch'],
    ['different receipt notes', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { receiptNotes: 'other' }), 'payload_mismatch'],
    ['a different catalogue item', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { centralItemId: 'ci-2' }), 'payload_mismatch'],
    ['a different trade name', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { tradeName: 'Other' }), 'payload_mismatch'],
    ['a different unit', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { unit: 'box' }), 'payload_mismatch'],
    ['a different concentration', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { concentration: '500 mg' }), 'payload_mismatch'],
    ['a different dosage form', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { dosageForm: 'syrup' }), 'payload_mismatch'],
    ['a receipt line with a different national code', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { receiptNationalCode: 'NC-2' }), 'payload_mismatch'],
    ['two receipts for one request id (defensive)', () => seedRecordedPurchase('req-sample', SAMPLE_ARGS, { extraReceipt: true }), 'ambiguous_rows'],
    ['revoked access: the receipt read is refused', () => { seedRecordedPurchase('req-sample', SAMPLE_ARGS); db.errors.procurement_receipts = { code: '42501', message: 'permission denied' }; }, 'read_error'],
    ['a later read in the chain fails', () => { seedRecordedPurchase('req-sample', SAMPLE_ARGS); db.errors.procurement_orders = { message: 'Failed to fetch' }; }, 'read_error'],
    ['no signed-in session', () => { seedRecordedPurchase('req-sample', SAMPLE_ARGS); db.session = null; }, 'no_session'],
    ['a different signed-in user', () => { seedRecordedPurchase('req-sample', SAMPLE_ARGS); db.session = { user: { id: 'someone-else' } }; }, 'not_own_session'],
  ])('%s is UNRESOLVED, never a verdict of non-execution', async (_label, arrange, reason) => {
    arrange();
    await expect(reconcileDirectEntry(expectation())).resolves.toEqual({ status: 'unresolved', reason });
    expect(hooks.rpc).not.toHaveBeenCalled();
  });

  it('a read that does not answer within the deadline is unresolved (timeout), and it is a single bounded read, never a poll', async () => {
    vi.useFakeTimers();
    seedRecordedPurchase('req-sample', SAMPLE_ARGS);
    let release!: () => void;
    db.gates.procurement_receipts = new Promise<void>((resolve) => { release = resolve; });
    const pending = reconcileDirectEntry(expectation());
    await act(async () => { vi.advanceTimersByTime(RECONCILE_DEADLINE_MS + 1); });
    await expect(pending).resolves.toEqual({ status: 'unresolved', reason: 'timeout' });
    release();
    await act(async () => { vi.advanceTimersByTime(RECONCILE_DEADLINE_MS * 3); });
    expect(db.reads.filter(table => table === 'procurement_receipts')).toHaveLength(1);
    expect(hooks.rpc).not.toHaveBeenCalled();
  });

  it.each<[string, { user: { id: string } } | null, string]>([
    ['a user switch', { user: { id: 'someone-else' } }, 'not_own_session'],
    ['a sign-out', null, 'no_session'],
  ])('%s while the reads are running is UNRESOLVED: the session is re-checked before anything is confirmed', async (_label, swapped, reason) => {
    seedRecordedPurchase('req-sample', SAMPLE_ARGS);
    let release!: () => void;
    db.gates.procurement_suppliers = new Promise<void>((resolve) => { release = resolve; });
    const pending = reconcileDirectEntry(expectation());
    for (let i = 0; i < 50 && !db.reads.includes('procurement_suppliers'); i += 1) await Promise.resolve();
    expect(db.reads).toContain('procurement_suppliers');
    db.session = swapped;
    release();
    await expect(pending).resolves.toEqual({ status: 'unresolved', reason });
  });

  it('text is compared as 116 stores it: btrim removes only U+0020 spaces, so other edge whitespace is kept on both sides', async () => {
    // A catalogue name carrying a trailing no-break space is stored with it (btrim keeps U+00A0); it still confirms.
    const nbsp = Object.freeze({ ...SAMPLE_ARGS, p_scientific_name: 'Paracetamol\u00a0', p_trade_name: 'Panadol\t' });
    seedRecordedPurchase('req-sample', nbsp);
    await expect(reconcileDirectEntry(expectation({ args: nbsp }))).resolves.toMatchObject({ status: 'confirmed' });
    // Edge U+0020 spaces are removed by btrim: the stored name has none.
    const spaced = Object.freeze({ ...SAMPLE_ARGS, p_scientific_name: '  Paracetamol ' });
    seedRecordedPurchase('req-sample', spaced, { scientificName: 'Paracetamol' });
    await expect(reconcileDirectEntry(expectation({ args: spaced }))).resolves.toMatchObject({ status: 'confirmed' });
    // A stored name without the no-break space is a different value, never a match.
    seedRecordedPurchase('req-sample', nbsp, { scientificName: 'Paracetamol' });
    await expect(reconcileDirectEntry(expectation({ args: nbsp }))).resolves.toEqual({ status: 'unresolved', reason: 'payload_mismatch' });
    expect(hooks.rpc).not.toHaveBeenCalled();
  });
});

describe('CI-4C · reconciliation from the panel', () => {
  it('an ambiguous attempt can be checked read-only: a confirmed matching receipt becomes the recorded result, with no write and no new key', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(checkButton()).toBeInTheDocument());
    const { requestId, frozen } = dispatchedAttempt();
    seedRecordedPurchase(requestId, frozen);

    fireEvent.click(checkButton());
    await waitFor(() => expect(screen.getByText(t('sp_attempt_existing_receipt', 'en'))).toBeInTheDocument());
    expect(screen.getByText('SP-9')).toBeInTheDocument();
    expect(screen.getByText('R-9')).toBeInTheDocument();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
    expect(batchInput()).not.toBeDisabled();
    expect(submitButton()).toBeDisabled();
  });

  it('a check that finds nothing keeps the attempt locked with its original key and says it could not confirm (empty is not proof)', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(checkButton()).toBeInTheDocument());

    fireEvent.click(checkButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_check_unconfirmed', 'en')));
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).not.toBeDisabled();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('a check whose read is refused (revoked access) keeps the attempt locked', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(checkButton()).toBeInTheDocument());
    const { requestId, frozen } = dispatchedAttempt();
    seedRecordedPurchase(requestId, frozen);
    db.errors.procurement_receipts = { code: '42501', message: 'permission denied' };

    fireEvent.click(checkButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_check_unconfirmed', 'en')));
    expect(batchInput()).toBeDisabled();
    expect(screen.queryByText(t('sp_attempt_existing_receipt', 'en'))).toBeNull();
  });

  it('a receipt recorded by a colleague under the same scope never confirms this operator\'s attempt', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(checkButton()).toBeInTheDocument());
    const { requestId, frozen } = dispatchedAttempt();
    seedRecordedPurchase(requestId, frozen, { receivedBy: 'colleague' });

    fireEvent.click(checkButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_check_unconfirmed', 'en')));
    expect(batchInput()).toBeDisabled();
  });

  it('a 23505 conflict is never confirmed by a check, even when a fully matching receipt is readable', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'request_id_conflict' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(checkButton()).toBeInTheDocument());
    const { requestId, frozen } = dispatchedAttempt();
    seedRecordedPurchase(requestId, frozen);

    fireEvent.click(checkButton());
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_check_unconfirmed', 'en')));
    expect(screen.queryByText(t('sp_attempt_existing_receipt', 'en'))).toBeNull();
    expect(batchInput()).toBeDisabled();
    expect(submitButton()).toBeDisabled();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('while a check runs neither the retry nor a second check can start', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(checkButton()).toBeInTheDocument());
    const { requestId, frozen } = dispatchedAttempt();
    seedRecordedPurchase(requestId, frozen);
    let release!: () => void;
    db.gates.procurement_receipts = new Promise<void>((resolve) => { release = resolve; });

    fireEvent.click(checkButton());
    await waitFor(() => expect(checkButton()).toBeDisabled());
    expect(retryButton()).toBeDisabled();
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    fireEvent.click(checkButton());
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(db.reads.filter(table => table === 'procurement_receipts')).toHaveLength(1);

    await act(async () => { release(); });
    await waitFor(() => expect(screen.getByText(t('sp_attempt_existing_receipt', 'en'))).toBeInTheDocument());
  });

  it('a check that settles after the attempt was already resolved by a late answer changes nothing (stale result)', async () => {
    vi.useFakeTimers();
    const late = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(late.promise);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    const { requestId, frozen } = dispatchedAttempt();
    seedRecordedPurchase(requestId, frozen);
    let release!: () => void;
    db.gates.procurement_receipts = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(checkButton());

    await act(async () => { late.resolve(RECORDED); await late.promise; });
    expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument();
    await act(async () => { release(); });
    // Let the whole read chain finish (it ends with the supplier read), so the stale result is really delivered.
    for (let i = 0; i < 50 && !db.reads.includes('procurement_suppliers'); i += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => { await Promise.resolve(); });
    expect(db.reads).toContain('procurement_suppliers');
    expect(screen.getAllByText(t('sp_entry_recorded', 'en'))).toHaveLength(1);
    expect(screen.queryByText(t('sp_attempt_existing_receipt', 'en'))).toBeNull();
    expect(screen.queryByText('SP-9')).toBeNull();
  });
});

describe('CI-4C · a stale check never touches a newer attempt', () => {
  it('a check started for an attempt that is then released and replaced cannot unlock the new attempt or show the old receipt', async () => {
    vi.useFakeTimers();
    const original = deferred<{ data: null; error: { code: string; message: string } }>();
    const replacement = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(original.promise).mockReturnValueOnce(replacement.promise);
    render(panel());
    fillValidPayload('BATCH-1', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    const { requestId, frozen } = dispatchedAttempt();
    seedRecordedPurchase(requestId, frozen);
    let release!: () => void;
    db.gates.procurement_receipts = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(checkButton());

    // The original dispatch now answers with a pure input refusal: the attempt is released (proven uncommitted).
    await act(async () => { original.resolve({ data: null, error: { code: '23514', message: 'quantity_must_be_positive' } }); await original.promise; });
    expect(batchInput()).not.toBeDisabled();
    // The operator records a different purchase; it is in flight.
    fillValidPayload('BATCH-2', '7');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(2);
    expect(submitButton()).toHaveAttribute('aria-busy', 'true');

    // The old check now completes with a confirmation for the OLD request: it must change nothing.
    await act(async () => { release(); });
    for (let i = 0; i < 50 && !db.reads.includes('procurement_suppliers'); i += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    await act(async () => { await Promise.resolve(); });
    expect(db.reads).toContain('procurement_suppliers');
    expect(submitButton()).toHaveAttribute('aria-busy', 'true');
    expect(batchInput()).toBeDisabled();
    expect(screen.queryByText(t('sp_attempt_existing_receipt', 'en'))).toBeNull();
    expect(screen.queryByText('SP-9')).toBeNull();
    await act(async () => { replacement.resolve(RECORDED); await replacement.promise; });
  });
});

describe('CI-4C · a notice belongs to one attempt and one dispatch', () => {
  const technicalText = () => screen.getByRole('alert').querySelector('details')?.textContent ?? '';

  it('a late success for an attempt already confirmed by a status check does not clear the newer attempt\'s notice', async () => {
    vi.useFakeTimers();
    const first = deferred<typeof RECORDED>();
    const second = deferred<{ data: null; error: { code: string; message: string } }>();
    hooks.rpc.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    render(panel());
    fillValidPayload('BATCH-1', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    const { requestId, frozen } = dispatchedAttempt();
    seedRecordedPurchase(requestId, frozen);
    fireEvent.click(checkButton());
    for (let i = 0; i < 50 && !screen.queryByText(t('sp_attempt_existing_receipt', 'en')); i += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    expect(screen.getByText(t('sp_attempt_existing_receipt', 'en'))).toBeInTheDocument();
    fireEvent.click(closeButton());

    // A second purchase is refused by a state-dependent check: ambiguous, with its own technical detail.
    fillValidPayload('BATCH-2', '7');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await act(async () => {
      second.resolve({ data: null, error: { code: '42501', message: 'forbidden_local_procurement_receive' } });
      await second.promise;
    });
    expect(technicalText()).toContain('forbidden_local_procurement_receive');

    // The first request's own answer arrives late. It belongs to the first attempt only.
    await act(async () => { first.resolve(RECORDED); await first.promise; });
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unknown', 'en'));
    expect(technicalText()).toContain('forbidden_local_procurement_receive');
    expect(batchInput()).toBeDisabled();
    expect(hooks.rpc).toHaveBeenCalledTimes(2);
  });

  it('a retry that gets no answer does not show the previous dispatch\'s technical detail', async () => {
    const silent = deferred<typeof RECORDED>();
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up')).mockReturnValueOnce(silent.promise);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    vi.useFakeTimers();
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unknown', 'en'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('socket hang up');
    expect(requestIdOf(1)).toBe(requestIdOf(0));
  });

  it('a new attempt that gets no answer does not show the previous attempt\'s refusal detail', async () => {
    const silent = deferred<typeof RECORDED>();
    hooks.rpc
      .mockResolvedValueOnce({ data: null, error: { code: '23514', message: 'quantity_must_be_positive' } })
      .mockReturnValueOnce(silent.promise);
    render(panel());
    fillValidPayload('BATCH-1', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_rejected', 'en')));
    vi.useFakeTimers();
    fillValidPayload('BATCH-2', '7');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unknown', 'en'));
    expect(screen.getByRole('alert')).not.toHaveTextContent('quantity_must_be_positive');
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));
  });
});

describe('CI-4C · Arabic / English copy', () => {
  const KEYS = [
    'sp_attempt_unknown', 'sp_attempt_check_status', 'sp_attempt_check_unconfirmed', 'sp_attempt_retry_original',
    'sp_attempt_retry_hint', 'sp_attempt_conflict', 'sp_attempt_existing_receipt', 'sp_attempt_acknowledge',
    'sp_attempt_technical_details', 'sp_attempt_rejected',
  ];
  const ARABIC = /[؀-ۿ]/;

  it.each(KEYS)('%s exists in Arabic and English', (key) => {
    expect(t(key, 'en')).not.toBe(key);
    expect(t(key, 'ar')).not.toBe(key);
    expect(t(key, 'ar')).toMatch(ARABIC);
    expect(t(key, 'en')).not.toMatch(ARABIC);
  });

  it('the read-only check and the write retry are never labelled alike', () => {
    expect(t('sp_attempt_check_status', 'en')).toMatch(/read-only/i);
    expect(t('sp_attempt_check_status', 'ar')).toContain('قراءة فقط');
    expect(t('sp_attempt_retry_original', 'en')).not.toMatch(/read-only|check/i);
    expect(t('sp_attempt_retry_original', 'ar')).not.toContain('قراءة');
  });

  it('the conflict copy never asserts that this purchase failed', () => {
    expect(t('sp_attempt_conflict', 'en')).not.toMatch(/failed|was not recorded|not been recorded/i);
    expect(t('sp_attempt_conflict', 'ar')).not.toMatch(/فشل|لم يُسجَّل|لم يسجل/);
  });

  it('no copy promises protection across a page reload, and the retry copy warns against reloading', () => {
    for (const key of KEYS) {
      expect(t(key, 'en')).not.toMatch(/never be (recorded|duplicated)|cannot be duplicated|guarantee/i);
      expect(t(key, 'ar')).not.toMatch(/ضمان|نضمن|يضمن|مضمون|لن يتكرر|لن يُسجَّل مرتين/);
    }
    expect(t('sp_attempt_retry_hint', 'en')).toMatch(/reload/i);
    expect(t('sp_attempt_retry_hint', 'ar')).toMatch(/تحميل/);
  });

  // CI-4C copy review.
  it('Arabic calls the attempt «الإدخال», never «الطلب» (which the procurement screens use for the purchase ORDER)', () => {
    for (const key of KEYS) expect(t(key, 'ar')).not.toContain('الطلب');
    expect(t('sp_attempt_retry_original', 'ar')).toContain('الإدخال');
  });

  it('the 23505 copy is neutral (any unique conflict, not only request_id_conflict) and points to History & receipts', () => {
    expect(t('sp_attempt_conflict', 'en')).not.toMatch(/different details/i);
    expect(t('sp_attempt_conflict', 'ar')).not.toContain('بتفاصيل مختلفة');
    expect(t('sp_attempt_conflict', 'en')).toContain(t('sp_tab_history', 'en'));
    expect(t('sp_attempt_conflict', 'ar')).toContain(t('sp_tab_history', 'ar'));
  });

  it('the retry hint says the server returns the existing receipt NUMBER, and the confirmed heading names the status check', () => {
    expect(t('sp_attempt_retry_hint', 'en')).toMatch(/existing receipt number/i);
    expect(t('sp_attempt_retry_hint', 'ar')).toContain('رقم الوصل');
    expect(t('sp_attempt_existing_receipt', 'en')).toMatch(/status check/i);
    expect(t('sp_attempt_existing_receipt', 'ar')).toContain('التحقق من الحالة');
  });

  it('the technical-details label matches the app wording, and Arabic tanween follows the file convention «ـًا»', () => {
    expect(t('sp_attempt_technical_details', 'ar')).toContain(t('acw_technical_details', 'ar'));
    for (const key of KEYS) expect(t(key, 'ar')).not.toMatch(/اً/);
  });

  it('the primary message is translated; the raw server text is only inside the collapsed technical details', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unknown', 'en')));
    const alert = screen.getByRole('alert');
    const primary = alert.querySelector('[data-notice-primary]');
    expect(primary?.textContent).toBe(t('sp_attempt_unknown', 'en'));
    const details = alert.querySelector('details');
    expect(details).not.toBeNull();
    expect(details).not.toHaveAttribute('open');
    expect(details?.textContent).toContain('socket hang up');
    expect(primary?.textContent).not.toContain('socket hang up');
  });
});

/** The pre-send identity check's deadline. Mirrors the product constant: a session read slower than this refuses the send. */
const IDENTITY_DEADLINE_MS = 10_000;

describe('CI-4D-A · the live identity is verified immediately before every write', () => {
  // CI-4D-B: a never-sent new purchase and a refused retry each have their own accurate copy.
  const unsentRefusal = () => t('sp_attempt_identity_unsent', 'en');
  const retryRefusal = () => t('sp_attempt_identity_retry_refused', 'en');

  /** Submits once and leaves the attempt ambiguous after a transport failure (one RPC so far). */
  async function ambiguousAttempt() {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    const view = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    return view;
  }

  it('a NEW purchase is not sent when the browser session belongs to another user (another tab signed in)', async () => {
    db.session = { user: { id: 'someone-else' } };
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(unsentRefusal());
    // Nothing was sent, so nothing can have been recorded: the form is editable again and keeps its values.
    expect(batchInput()).not.toBeDisabled();
    expect(batchInput()).toHaveValue('BATCH-1');
  });

  it.each<[string, () => void]>([
    ['there is no session (signed out in another tab)', () => { db.session = null; }],
    ['the session read reports an error', () => { db.sessionError = { message: 'Auth session missing!' }; }],
    ['the session read throws', () => { db.sessionThrows = true; }],
    // A unique organization per test: the module-level store must not carry one test's notice into another.
    ['this tab has no profile loaded (no owner to bind the attempt to)', () => { scopeKey = `|org-noprofile-${scopeSeq}`; }],
  ])('a NEW purchase is not sent when %s', async (_label, arrange) => {
    arrange();
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(unsentRefusal());
  });

  it('a session read that reports an error is a refusal even when it also carries the owner\'s session', async () => {
    db.sessionError = { message: 'refresh failed' };
    db.sessionErrorKeepsSession = true;
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(unsentRefusal());
  });

  it('when this tab does not show the attempt\'s owner, the auth session is not even read (fail fast: no session refresh under another identity)', async () => {
    scopeKey = `|org-noprofile-${scopeSeq}`;
    render(panel());
    fillValidPayload();
    expect(screen.getByTestId('subpurchase-confirm')).toBeChecked();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    // The submission really happened (and was refused) — the assertion below is not vacuous.
    expect(screen.getByRole('alert')).toHaveTextContent(unsentRefusal());
    expect(db.sessionReads).toBe(0);
    expect(hooks.rpc).not.toHaveBeenCalled();
  });

  it('a session read that does not answer in time refuses the send, and its late answer sends nothing', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    expect(submitButton()).toHaveAttribute('aria-busy', 'true');
    act(() => { vi.advanceTimersByTime(IDENTITY_DEADLINE_MS + 1); });
    await settleIdentityCheck();
    expect(screen.getByRole('alert')).toHaveTextContent(unsentRefusal());
    await act(async () => { release(); });
    await settleIdentityCheck();
    expect(hooks.rpc).not.toHaveBeenCalled();
  });

  it('a RETRY is not sent under another user: owner, request id, frozen payload and lock are kept; the returning owner retries the SAME request', async () => {
    await ambiguousAttempt();
    const owner = db.session;
    db.session = { user: { id: 'someone-else' } };
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unknown', 'en'));
    expect(screen.getByRole('alert')).toHaveTextContent(retryRefusal());
    expect(batchInput()).toBeDisabled();
    expect(batchInput()).toHaveValue('BATCH-1');
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);

    // The original owner's session is back: the same request id and the same arguments are sent.
    db.session = owner;
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(argsOf(1)).toEqual(argsOf(0));
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it.each<[string, () => void]>([
    ['no session', () => { db.session = null; }],
    ['a failing session read', () => { db.sessionError = { message: 'Auth session missing!' }; }],
  ])('a RETRY is not sent with %s, and the attempt stays locked under its own request id', async (_label, arrange) => {
    await ambiguousAttempt();
    arrange();
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).not.toBeDisabled();
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('this tab\'s profile changing DURING the session read refuses the send, even when the read answers with the original owner (stale positive)', async () => {
    const view = await ambiguousAttempt();
    const ownerScope = scopeKey;
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(retryButton());
    // While the session is being read, this tab's AppContext switches to another operator.
    scopeKey = `intruder-${scopeSeq}|org-1`;
    view.rerender(panel());
    await act(async () => { release(); });
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);

    // The owner returns: the attempt is still in custody, locked, with its own request id, and can be retried.
    scopeKey = ownerScope;
    view.rerender(panel());
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).not.toBeDisabled();
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('the active organization changing DURING the session read refuses the send', async () => {
    const view = await ambiguousAttempt();
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(retryButton());
    scopeKey = `operator-${scopeSeq}|org-2`;
    view.rerender(panel());
    await act(async () => { release(); });
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('the panel unmounting during the session read refuses the send (no live identity to compare)', async () => {
    const view = await ambiguousAttempt();
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(retryButton());
    view.unmount();
    await act(async () => { release(); });
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    // The owner comes back to the screen: the attempt is still in custody.
    render(panel());
    expect(batchInput()).toBeDisabled();
    expect(retryButton()).not.toBeDisabled();
  });

  it('rapid retry clicks in one tick (before any re-render) start ONE identity check and send ONE request', async () => {
    await ambiguousAttempt();
    const answer = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(answer.promise);
    const readsBefore = db.sessionReads;
    const button = retryButton();
    act(() => { button.click(); button.click(); button.click(); });
    await settleIdentityCheck();
    expect(db.sessionReads - readsBefore).toBe(1);
    expect(hooks.rpc).toHaveBeenCalledTimes(2);
    await act(async () => { answer.resolve(RECORDED); await answer.promise; });
  });

  it.each<[string, (owner: string) => { profile: { id: string } | null; activeOrgId: string | null }]>([
    ['another profile', () => ({ profile: { id: 'intruder' }, activeOrgId: 'org-1' })],
    ['another active organization', (owner) => ({ profile: { id: owner }, activeOrgId: 'org-2' })],
  ])('this tab\'s AppContext showing %s for the SAME scope refuses the send (the comparison does not rely on the scope wiring)', async (_label, make) => {
    const view = await ambiguousAttempt();
    appOverride = make(currentActor());
    view.rerender(panel());
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(retryRefusal());
    expect(batchInput()).toBeDisabled();
  });

  it('a status check clicked in the same tick as a retry (before any re-render) does not start while the send is verified', async () => {
    await ambiguousAttempt();
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    const retry = retryButton();
    const check = checkButton();
    act(() => { retry.click(); check.click(); });
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    await act(async () => { release(); });
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
    expect(db.reads).toHaveLength(0);
    expect(hooks.rpc).toHaveBeenCalledTimes(2);
  });

  it('while the identity check runs, neither a status check nor a second send can start', async () => {
    await ambiguousAttempt();
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(retryButton());
    expect(submitButton()).toHaveAttribute('aria-busy', 'true');
    expect(checkButton()).toBeDisabled();
    fireEvent.click(checkButton());
    fireEvent.click(submitButton());
    expect(db.reads).toHaveLength(0);
    expect(db.sessionReads).toBe(2);
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    await act(async () => { release(); });
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
    expect(hooks.rpc).toHaveBeenCalledTimes(2);
  });

  it('a late success that settles the attempt while its retry is being verified: the verification result sends nothing', async () => {
    vi.useFakeTimers();
    const first = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(first.promise);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(retryButton());
    await act(async () => { first.resolve(RECORDED); await first.promise; });
    expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument();
    await act(async () => { release(); });
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('a late 23505 from the earlier send arriving while a retry is being verified: the conflict is never re-sent', async () => {
    vi.useFakeTimers();
    const first = deferred<{ data: null; error: { code: string; message: string } }>();
    hooks.rpc.mockReturnValueOnce(first.promise);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(retryButton());
    await act(async () => { first.resolve({ data: null, error: { code: '23505', message: 'request_id_conflict' } }); await first.promise; });
    await act(async () => { release(); });
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_conflict', 'en'));
    expect(submitButton()).toBeDisabled();
  });

  // CI-4D-A review fixes (F1, F3, F4, F5, F6).
  it('F1: leaving the panel while a NEW purchase is verified sends nothing, and the entered form is restored on return', async () => {
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    const view = render(panel());
    fillValidPayload('BATCH-KEEP', '9');
    fireEvent.click(submitButton());
    view.unmount();
    await act(async () => { release(); });
    await settleIdentityCheck();
    expect(hooks.rpc).not.toHaveBeenCalled();
    render(panel());
    expect(batchInput()).toHaveValue('BATCH-KEEP');
    expect(screen.getByLabelText(t('inv_quantity_received', 'en'))).toHaveValue(9);
    expect(batchInput()).not.toBeDisabled();
    // Never sent: the restored form needs a fresh human confirmation before it can be submitted.
    expect(screen.getByTestId('subpurchase-confirm')).not.toBeChecked();
    expect(submitButton()).toBeDisabled();
    fireEvent.click(screen.getByTestId('subpurchase-confirm'));
    // Nothing was ever sent under the first request id, so sending now is a new, safe first send.
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('F3: a retry refused for identity after a late 23505 turned the attempt into a conflict shows no "try again" line', async () => {
    vi.useFakeTimers();
    const first = deferred<{ data: null; error: { code: string; message: string } }>();
    hooks.rpc.mockReturnValueOnce(first.promise);
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    act(() => { vi.advanceTimersByTime(DEADLINE_MS + 1); });
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    fireEvent.click(retryButton());
    await act(async () => { first.resolve({ data: null, error: { code: '23505', message: 'request_id_conflict' } }); await first.promise; });
    db.session = { user: { id: 'someone-else' } };
    await act(async () => { release(); });
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_conflict', 'en'));
    expect(screen.getByRole('alert')).not.toHaveTextContent(retryRefusal());
    expect(screen.getByRole('alert')).not.toHaveTextContent(unsentRefusal());
  });

  it('F4: a second panel for the same scope unmounting does not withdraw the first panel\'s live identity', async () => {
    await ambiguousAttempt();
    const second = render(panel());
    second.unmount();
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(argsOf(1)).toEqual(argsOf(0));
  });

  it('F5: an attempt whose owner does not match the identity encoded in its scope is never sent (inconsistent wiring fails closed)', async () => {
    // This tab's AppContext and the live session say "stranger", but the panel's scope belongs to this operator.
    appOverride = { profile: { id: 'stranger' }, activeOrgId: 'org-1' };
    db.session = { user: { id: 'stranger' } };
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).not.toHaveBeenCalled();
    expect(screen.getByRole('alert')).toHaveTextContent(unsentRefusal());
  });

  it('F6: a synchronous throw from the RPC call is handled like a transport failure (ambiguous, locked), not an unhandled rejection', async () => {
    hooks.rpc.mockImplementationOnce(() => { throw new Error('sync boom'); });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unknown', 'en'));
    expect(screen.getByRole('alert')).toHaveTextContent('sync boom');
    expect(batchInput()).toBeDisabled();
  });

  it('a send refused for identity never mints a new request id for the locked attempt, and the payload cannot be edited meanwhile', async () => {
    await ambiguousAttempt();
    db.session = { user: { id: 'someone-else' } };
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    fireEvent.change(batchInput(), { target: { value: 'BATCH-EDITED' } });
    expect(batchInput()).toHaveValue('BATCH-1');
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });
});

describe('CI-4D-B · accurate identity-refusal copy', () => {
  const UNSENT = 'sp_attempt_identity_unsent';
  const RETRY = 'sp_attempt_identity_retry_refused';

  it('both keys exist in Arabic and English, follow the file conventions, and promise nothing', () => {
    for (const key of [UNSENT, RETRY]) {
      expect(t(key, 'en')).not.toBe(key);
      expect(t(key, 'ar')).toMatch(/[؀-ۿ]/);
      expect(t(key, 'en')).not.toMatch(/[؀-ۿ]/);
      expect(t(key, 'ar')).not.toMatch(/اً/);
      expect(t(key, 'ar')).not.toContain('الطلب');
      expect(t(key, 'en')).not.toMatch(/guarantee|never be (recorded|duplicated)/i);
      expect(t(key, 'ar')).not.toMatch(/ضمان|نضمن|يضمن/);
    }
  });

  it('never-sent: says this purchase was not sent because the original operator could not be verified', () => {
    expect(t(UNSENT, 'en')).toMatch(/was not sent/i);
    expect(t(UNSENT, 'en')).toMatch(/could not be verified/i);
    expect(t(UNSENT, 'ar')).toContain('لم يُرسَل');
  });

  it('refused retry: not sent, the earlier attempt MAY be recorded, the original operator must sign in to retry the SAME request; no failure claim, no new request', () => {
    const en = t(RETRY, 'en');
    expect(en).toMatch(/was not sent/i);
    expect(en).toMatch(/may already (be|have been) recorded/i);
    expect(en).toMatch(/original operator must sign in/i);
    expect(en).toMatch(/same request/i);
    expect(en).toMatch(/do not enter this purchase again/i);
    expect(en).not.toMatch(/failed|was not recorded|not been recorded|new request|start over/i);
    const ar = t(RETRY, 'ar');
    expect(ar).toContain('لم تُرسَل');
    expect(ar).toContain('قد تكون');
    expect(ar).toContain('المشغّل الأصلي');
    expect(ar).not.toMatch(/فشل|لم يُسجَّل|لم يسجل/);
  });

  it('the historical key is kept for its other consumer; only the direct-entry panel stops using it', () => {
    expect(t('auth_boot_failed_msg', 'en')).not.toBe('auth_boot_failed_msg');
    const panelSource = readFileSync(join(process.cwd(), 'src/features/procurement/DirectEntryPanel.tsx'), 'utf8');
    const appSource = readFileSync(join(process.cwd(), 'src/app/AuthenticatedApp.tsx'), 'utf8');
    expect(panelSource).not.toContain('auth_boot_failed_msg');
    expect(appSource).toContain("t('auth_boot_failed_msg', lang)");
  });
});

describe('CI-4D-B · the retained form is minimal (no live stock figures)', () => {
  const IDENTITY = {
    centralItemId: 'ci-1', scientificName: 'Paracetamol', tradeName: 'Panadol',
    concentration: '500 mg', dosageForm: 'tablet', unit: 'box',
  };
  const LEAKS = ['onHand', 'reserved', '"available', 'availableQuantity', 'warehouseStockId', 'ws-stock-1', 'LOT-STOCK-7',
    '6281000000001', 'canonical', '2027-05-01', 'NC-LOT', 'supplyType', 'barcode'];

  /** Every form snapshot the panel freezes into its attempt store (createAttempt freezes it before the first send). */
  function captureFrozenForms() {
    const forms: Array<Record<string, unknown>> = [];
    const realFreeze = Object.freeze;
    const spy = vi.spyOn(Object, 'freeze').mockImplementation(((value: unknown) => {
      if (value !== null && typeof value === 'object' && 'material' in value && 'batch' in value) {
        forms.push(value as Record<string, unknown>);
      }
      return realFreeze(value);
    }) as typeof Object.freeze);
    return { forms, restore: () => spy.mockRestore() };
  }

  it('the snapshot kept for an unresolved attempt holds only the material identity the form needs: no stock figures, no lot identifiers', async () => {
    const capture = captureFrozenForms();
    try {
      hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
      render(panel());
      fillValidPayload();
      fireEvent.click(submitButton());
      await settleIdentityCheck();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
      expect(capture.forms.length).toBeGreaterThan(0);
      const kept = capture.forms[capture.forms.length - 1];
      expect(kept.material).toEqual(IDENTITY);
      expect(Object.isFrozen(kept.material)).toBe(true);
      const serialized = JSON.stringify(capture.forms);
      for (const leak of LEAKS) expect(serialized).not.toContain(leak);
    } finally {
      capture.restore();
    }
  });

  it('the frozen request arguments are unchanged: the identity yields the same material arguments, and a retry after a remount sends them byte-for-byte', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    const view = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    expect(argsOf(0)).toMatchObject({
      p_central_item_id: 'ci-1', p_scientific_name: 'Paracetamol', p_trade_name: 'Panadol',
      p_concentration: '500 mg', p_dosage_form: 'tablet', p_unit: 'box',
    });
    view.unmount();
    render(panel());
    // A sent, unresolved attempt stays immutable and locked after the remount: the material cannot even be cleared.
    expect(screen.getByText('Paracetamol (Panadol)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '✕' })).toBeDisabled();
    expect(batchInput()).toBeDisabled();
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fireEvent.click(retryButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(argsOf(1)).toEqual(argsOf(0));
  });

  it('a never-sent form restored after the panel was away keeps the material identity and entered data, needs a fresh confirmation, and sends the same material arguments', async () => {
    const capture = captureFrozenForms();
    try {
      let release!: () => void;
      db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
      const view = render(panel());
      fillValidPayload('BATCH-R', '4');
      fireEvent.click(submitButton());
      view.unmount();
      await act(async () => { release(); });
      await settleIdentityCheck();
      expect(hooks.rpc).not.toHaveBeenCalled();
      db.sessionGate = undefined;

      render(panel());
      expect(screen.getByText('Paracetamol (Panadol)')).toBeInTheDocument();
      expect(batchInput()).toHaveValue('BATCH-R');
      expect(screen.getByTestId('subpurchase-confirm')).not.toBeChecked();
      expect(submitButton()).toBeDisabled();
      expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_identity_unsent', 'en'));
      fireEvent.click(screen.getByTestId('subpurchase-confirm'));
      hooks.rpc.mockResolvedValueOnce(RECORDED);
      fireEvent.click(submitButton());
      await settleIdentityCheck();
      await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(1));
      expect(argsOf(0)).toMatchObject({
        p_central_item_id: 'ci-1', p_scientific_name: 'Paracetamol', p_trade_name: 'Panadol',
        p_concentration: '500 mg', p_dosage_form: 'tablet', p_unit: 'box', p_batch_number: 'BATCH-R', p_quantity: 4,
      });
      const serialized = JSON.stringify(capture.forms);
      for (const leak of LEAKS) expect(serialized).not.toContain(leak);
    } finally {
      capture.restore();
    }
  });

  it('a material chosen from the advisory duplicate list is kept as the same minimal identity (no catalogue payload retained)', async () => {
    vi.mocked(getDuplicateCandidates).mockImplementation(async () => [{
      source: 'catalog', sourceId: 'ci-dup', scientificName: 'Amoxicillin', tradeName: 'Amoxil',
      concentration: '250 mg', dosageForm: 'capsule', nationalCode: 'NC-DUP', similarityScore: 0.9,
    }]);
    const capture = captureFrozenForms();
    try {
      hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
      render(panel());
      fireEvent.click(screen.getByRole('button', { name: `+ ${t('sp_register_new_material', 'en')}` }));
      fireEvent.change(screen.getByLabelText(t('inv_scientific_name', 'en')), { target: { value: 'Amox' } });
      fireEvent.click(await screen.findByRole('button', { name: t('sp_duplicate_use_this', 'en') }, { timeout: 3000 }));
      expect(screen.getByText('Amoxicillin (Amoxil)')).toBeInTheDocument();
      fillValidPayload();
      fireEvent.click(submitButton());
      await settleIdentityCheck();
      await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
      const kept = capture.forms[capture.forms.length - 1];
      expect(kept.material).toEqual({
        centralItemId: 'ci-dup', scientificName: 'Amoxicillin', tradeName: 'Amoxil',
        concentration: '250 mg', dosageForm: 'capsule', unit: null,
      });
      const serialized = JSON.stringify(capture.forms);
      for (const leak of ['canonical', 'barcode', 'NC-DUP', 'reasonKey', 'eligibility', 'availableQuantity']) {
        expect(serialized).not.toContain(leak);
      }
      expect(argsOf(0)).toMatchObject({ p_central_item_id: 'ci-dup', p_scientific_name: 'Amoxicillin', p_trade_name: 'Amoxil' });
    } finally {
      capture.restore();
      vi.mocked(getDuplicateCandidates).mockImplementation(async () => []);
    }
  });

  it('ISOLATION: another operator in the same tab, organization and warehouse never receives the first operator\'s retained form', async () => {
    let release!: () => void;
    db.sessionGate = new Promise<void>((resolve) => { release = resolve; });
    const view = render(panel());
    fillValidPayload('BATCH-PRIVATE', '6');
    fireEvent.click(submitButton());
    view.unmount();
    await act(async () => { release(); });
    await settleIdentityCheck();

    scopeKey = `other-operator-${scopeSeq}|org-1`;
    db.session = { user: { id: `other-operator-${scopeSeq}` } };
    db.sessionGate = undefined;
    render(panel());
    expect(batchInput()).toHaveValue('');
    expect(screen.queryByText('Paracetamol (Panadol)')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByTestId('subpurchase-confirm')).not.toBeChecked();
  });
});

describe('CI-4D-A · copy: readiness wording and an in-progress message', () => {
  it('a readiness refusal (RPC absent) is stated in operator words, without developer or migration wording', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '42883', message: 'function does not exist' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent(t('sp_attempt_unavailable', 'en')));
    const primary = screen.getByRole('alert').querySelector('[data-notice-primary]');
    expect(primary?.textContent).not.toMatch(/migration|089/i);
  });

  it('the in-progress message is shown while the purchase is being submitted (identity check, then in flight), and not after it settles', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);
    render(panel());
    fillValidPayload();
    expect(screen.queryByText(t('sp_attempt_in_progress', 'en'))).toBeNull();
    fireEvent.click(submitButton());
    expect(screen.getByText(t('sp_attempt_in_progress', 'en'))).toBeInTheDocument();
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(screen.getByText(t('sp_attempt_in_progress', 'en'))).toBeInTheDocument();
    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
    expect(screen.queryByText(t('sp_attempt_in_progress', 'en'))).toBeNull();
  });

  it('both new keys exist in Arabic and English; the historical key is kept; nothing promises safety across a reload', () => {
    for (const key of ['sp_attempt_unavailable', 'sp_attempt_in_progress']) {
      expect(t(key, 'en')).not.toBe(key);
      expect(t(key, 'ar')).toMatch(/[؀-ۿ]/);
      expect(t(key, 'en')).not.toMatch(/[؀-ۿ]/);
      expect(t(key, 'en')).not.toMatch(/migration|089|guarantee|never be (recorded|duplicated)/i);
      expect(t(key, 'ar')).not.toMatch(/migration|089|ضمان|نضمن|يضمن|الطلب/);
      expect(t(key, 'ar')).not.toMatch(/اً/);
    }
    // Historical localization keys are not removed or renamed.
    expect(t('sp_awaiting_migration', 'en')).not.toBe('sp_awaiting_migration');
    // The in-progress line tells the operator not to reload, close or leave the page; it promises nothing.
    expect(t('sp_attempt_in_progress', 'en')).toMatch(/reload/i);
    expect(t('sp_attempt_in_progress', 'ar')).toMatch(/تحميل/);
    expect(t('sp_attempt_in_progress', 'en')).toMatch(/leave/i);
    expect(t('sp_attempt_in_progress', 'ar')).toMatch(/تغادر/);
    // F7: the readiness copy does not state as fact what rests on a runtime assumption (the RPC-absent rule).
    expect(t('sp_attempt_unavailable', 'en')).not.toMatch(/not (been )?recorded/i);
    expect(t('sp_attempt_unavailable', 'ar')).not.toMatch(/لم يُسجَّل|لم يسجل/);
  });
});

describe('CI-4C · the internal submit guard is preserved (source pin)', () => {
  it('submit() never runs while a result is open, and re-dispatches an unresolved attempt only when it is ambiguous', () => {
    // Under jsdom import.meta.url is not a file: URL, so the source is read from the repository root (vitest's cwd).
    const source = readFileSync(join(process.cwd(), 'src/features/procurement/DirectEntryPanel.tsx'), 'utf8');
    expect(source).toContain('if (!supabaseConfigured || outcome !== null) return;');
    expect(source).toContain("if (stored.state === 'ambiguous' && !stored.checking) dispatchAttempt(stored);");
  });

  it('CI-4D-A: dispatchAttempt has its own synchronous guard (independent of the button) and sends only after the identity check', () => {
    const source = readFileSync(join(process.cwd(), 'src/features/procurement/DirectEntryPanel.tsx'), 'utf8');
    expect(source).toContain('if (unresolved.get(attempt.scope) !== attempt || attempt.verifying || attempt.checking) return;');
    expect(source).toContain("if (attempt.state !== 'unsent' && attempt.state !== 'ambiguous') return;");
    // The RPC is issued only from sendAttempt, which only the identity check's positive, current result calls.
    expect(source.split("supabase.rpc('phoenix_subpurchase_direct_entry'").length - 1).toBe(1);
  });
});
