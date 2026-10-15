/**
 * @vitest-environment jsdom
 *
 * CI-3 / R-2 — the direct-entry attempt, through the REAL DirectEntryPanel.
 *
 * A remount (same-screen re-activation, Back/Forward, a same-identity profile
 * reload) discards every useState value. Before the fix the idempotency key was
 * minted at mount and lived only in that state, so a remount while the RPC was
 * still unresolved could (a) mint a second request_id for the same attempt and
 * (b) leave the button enabled, inviting a second purchase submission.
 *
 * The RPC is a deferred promise, so "in flight" is held open, never slept.
 * Assertions compare request_id values across calls rather than fixed numbers,
 * because the panel mints a key on every payload edit.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { t } from '@/shared/i18n/strings';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import { DirectEntryPanel } from '../DirectEntryPanel';

const hooks = vi.hoisted(() => ({
  rpc: vi.fn(),
  newRequestId: vi.fn(),
  getSession: vi.fn(),
}));

vi.mock('@/shared/supabase/client', () => ({
  supabaseConfigured: true,
  // CI-4D-A: every send first reads the live auth session; by default it is the operator who owns the scope.
  supabase: {
    rpc: (...args: unknown[]) => hooks.rpc(...args),
    auth: { getSession: () => hooks.getSession() },
  },
}));
vi.mock('../procurement.service', () => ({
  newRequestId: () => hooks.newRequestId(),
  getDuplicateCandidates: vi.fn(async () => []),
}));
// CI-4C: the panel binds an attempt to the signed-in profile and organization.
vi.mock('@/app/AppContext', () => ({
  useApp: () => ({ profile: { id: scopeKey.split('|')[0] }, activeOrgId: scopeKey.split('|')[1] }),
}));
// The resolver has its own runtime coverage. Here it is a single button that
// selects one registered material, so the panel's own lifecycle is what runs.
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

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

let scopeSeq = 0;
/** A fresh identity + organization per test, so the module-level attempt store never leaks between tests. */
let scopeKey = '';
let keySeq = 0;

beforeEach(() => {
  scopeSeq += 1;
  scopeKey = `operator-${scopeSeq}|org-1`;
  keySeq = 0;
  hooks.rpc.mockReset();
  hooks.newRequestId.mockReset();
  hooks.newRequestId.mockImplementation(() => {
    keySeq += 1;
    return `key-${scopeSeq}-${keySeq}`;
  });
  hooks.getSession.mockReset();
  hooks.getSession.mockImplementation(async () => ({ data: { session: { user: { id: scopeKey.split('|')[0] } } }, error: null }));
});

afterEach(() => {
  cleanup();
});

/** CI-4D-A: a send now waits for the live identity check (an asynchronous session read). Lets it settle; no timer moves. */
async function settleIdentityCheck() {
  await act(async () => { for (let i = 0; i < 20; i += 1) await Promise.resolve(); });
}

const panel = (onDone: (k: string) => void = () => undefined) => (
  <DirectEntryPanel lang="en" warehouseId="wh-1" scopeKey={scopeKey} onDone={onDone} />
);

/**
 * The submit button is the panel's last button. It cannot be found by its label: while busy,
 * PhoenixButton replaces the label with a spinner, so the accessible name disappears.
 */
function submitButton() {
  const buttons = screen.getAllByRole('button');
  return buttons[buttons.length - 1];
}

/** Select the material (if the resolver is showing), enter the batch and quantity, and confirm. */
function fillValidPayload(batch = 'BATCH-1', quantity = '5') {
  const pick = screen.queryByRole('button', { name: 'pick-material' });
  if (pick) fireEvent.click(pick);
  fireEvent.change(screen.getByLabelText(t('mv_f_batch_number', 'en')), { target: { value: batch } });
  fireEvent.change(screen.getByLabelText(t('inv_quantity_received', 'en')), { target: { value: quantity } });
  fireEvent.click(screen.getByTestId('subpurchase-confirm'));
}

/** The request_id that the Nth dispatch carried. */
const requestIdOf = (call: number) => (hooks.rpc.mock.calls[call][1] as { p_request_id: string }).p_request_id;
const argsOf = (call: number) => hooks.rpc.mock.calls[call][1] as Record<string, unknown>;

const RECORDED = { data: { ok: true, idempotent_replay: false, order_number: 'SP-1', receipt_number: 'R-1' }, error: null };

describe('R-2 · one attempt keeps one request_id and one dispatch, across a remount', () => {
  it('a remount while the RPC is in flight re-attaches to it: no second dispatch, busy, and the outcome reaches the remounted panel', async () => {
    const onDoneFirst = vi.fn();
    const onDoneRemount = vi.fn();
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);

    const first = render(panel(onDoneFirst));
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);

    // Back/Forward, a same-screen re-activation or a profile reload: the subtree is discarded.
    first.unmount();

    render(panel(onDoneRemount));
    // The attempt is still unresolved, so the remounted panel is busy and cannot dispatch again.
    expect(submitButton()).toBeDisabled();
    expect(submitButton()).toHaveAttribute('aria-busy', 'true');
    fillValidPayload('BATCH-1', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);

    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });

    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
    expect(onDoneRemount).toHaveBeenCalledWith('sp_entry_ok');
    expect(onDoneFirst).not.toHaveBeenCalled();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('after the in-flight attempt is recorded, the next purchase carries a NEW key', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);
    const first = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    first.unmount();
    render(panel());
    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());

    // CI-4A: a settled result blocks the next purchase until the operator closes it.
    fireEvent.click(screen.getByRole('button', { name: t('sp_attempt_acknowledge', 'en') }));
    hooks.rpc.mockResolvedValueOnce({ data: { ok: true, idempotent_replay: false, order_number: 'SP-2', receipt_number: 'R-2' }, error: null });
    fillValidPayload('BATCH-2', '7');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));
  });

  it('a lost response (ambiguous failure) followed by a remount reuses the SAME key for the next submission', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    const first = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch'));
    expect(submitButton()).not.toBeDisabled();
    first.unmount();

    // The server may already have recorded the first attempt. A remount must not change the key.
    render(panel());
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).toBe(requestIdOf(0));
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
  });

  it('a rejected RPC promise (thrown, not an error object) releases the busy state and keeps the key', async () => {
    hooks.rpc.mockRejectedValueOnce(new Error('socket hang up'));
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('socket hang up'));
    expect(submitButton()).not.toBeDisabled();
    expect(submitButton()).not.toHaveAttribute('aria-busy', 'true');
  });

  it('a request_id_conflict (23505) is NOT a release: the key is kept and nothing is re-keyed or re-submitted automatically (CI-4B)', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { code: '23505', message: 'request_id_conflict' } });
    render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('request_id_conflict'));

    // CI-3 rotated the key here. A conflict does not prove that the earlier purchase failed, so the attempt is kept
    // for reconciliation: no new key, no second dispatch.
    expect(submitButton()).toBeDisabled();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    expect(hooks.newRequestId).toHaveBeenCalledTimes(1);
  });

  it('two clicks in the same tick, before React re-renders, dispatch nothing new', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);
    render(panel());
    fillValidPayload();
    // Inside one act() the second native click still reaches the first render's handler, so only the store guard can stop it.
    const button = submitButton();
    act(() => { button.click(); button.click(); });
    await settleIdentityCheck();
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
    await waitFor(() => expect(screen.getByText(t('sp_entry_recorded', 'en'))).toBeInTheDocument());
    expect(hooks.rpc).toHaveBeenCalledTimes(1);
  });

  it('while an attempt is unresolved the payload is locked: an edit is refused, and the retry sends the original key and payload (CI-4A item 4)', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'Failed to fetch' } });
    render(panel());
    fillValidPayload('BATCH-1', '5');
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toHaveTextContent('Failed to fetch'));

    // CI-3 let an edited payload dispatch under a new key here, which can record a second purchase after an
    // ambiguous outcome. CI-4A refuses the edit, so the only submission is the original request.
    const batch = screen.getByLabelText(t('mv_f_batch_number', 'en'));
    fireEvent.change(batch, { target: { value: 'BATCH-2' } });
    expect(batch).toHaveValue('BATCH-1');
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(argsOf(1)).toEqual(argsOf(0));
  });

  it('a refusal with no error code (a gateway body that merely mentions "function") does not release the attempt key', async () => {
    hooks.rpc.mockResolvedValueOnce({ data: null, error: { message: 'upstream function timeout' } });
    const first = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    first.unmount();

    render(panel());
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).toBe(requestIdOf(0));
  });

  it('NEGATIVE CONTROL: another operator is never attached to an in-flight attempt, and gets its own key', async () => {
    const inFlight = deferred<typeof RECORDED>();
    hooks.rpc.mockReturnValueOnce(inFlight.promise);
    const first = render(panel());
    fillValidPayload();
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    first.unmount();

    // A different operator on the same workstation, same warehouse.
    scopeKey = `other-operator-${scopeSeq}|org-1`;
    render(panel());
    expect(submitButton()).not.toHaveAttribute('aria-busy', 'true');
    fillValidPayload();
    expect(submitButton()).not.toBeDisabled();
    hooks.rpc.mockResolvedValueOnce(RECORDED);
    fireEvent.click(submitButton());
    await settleIdentityCheck();
    await waitFor(() => expect(hooks.rpc).toHaveBeenCalledTimes(2));
    expect(requestIdOf(1)).not.toBe(requestIdOf(0));
    await act(async () => { inFlight.resolve(RECORDED); await inFlight.promise; });
  });
});
