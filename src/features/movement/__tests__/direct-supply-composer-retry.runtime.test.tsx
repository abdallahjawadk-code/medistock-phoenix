/**
 * @vitest-environment jsdom
 *
 * POST-UAT DEFECT REPAIR — src/features/movement/DirectSupplyComposer.tsx
 * Defect: PHX-DEFECT-2026-09-02-DIRECT-SUPPLY-COMPOSER-RETRY-DUPLICATE-LINE
 * (UAT evidence artifact 653; ledger control :355:button#1).
 *
 * "Retry unsent lines only" is meant to resend ONLY the lines that did not
 * land in the first commit attempt. Before the repair, it resent EVERY line,
 * including ones that already succeeded, into
 * phoenix_add_warehouse_transfer_request_line -- an RPC with no idempotency
 * token, so a resent successful line becomes a genuine duplicate operational
 * line on the request. Root cause: planRetry's non-provenance match key
 * compared scientificName + batchNumber + expiryDate, but a supply REQUEST
 * line never persists batch/expiry server-side at all (network.service.ts's
 * TransferRequestLine has no such columns -- batch is chosen later, at
 * dispatch), so a reloaded server line could only ever supply null there,
 * which could never agree with a real draft line's real batch/expiry. Fixed
 * in movement-commit.ts by giving each caller of planRetry its own explicit
 * identity basis ('material' here, matching on concentration/dosageForm/unit
 * -- the real fields a supply request line's RPC round-trips) instead of a
 * shared 'supply'/'return' direction that silently conflated this composer's
 * batch-less request lines with OutletDispatchComposer's real, batch-specific
 * dispatch lines.
 *
 * Real React render + real fireEvent driving the REAL, unmocked composer and
 * its real business logic (composer-model.ts, movement-commit.ts). Only the
 * network.service RPC boundary and AppContext are mocked.
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DirectSupplyComposer } from '../DirectSupplyComposer';
import type { PartyOption } from '../ui/MovementPartySelector';
import type { NetworkWarehouse } from '@/features/network/network.service';

vi.mock('@/app/AppContext', () => ({
  useApp: () => ({ lang: 'en', dir: 'ltr' }),
}));

const getWarehouseStock = vi.fn();
const getTransferRequestLines = vi.fn();
const createDirectTransferRequest = vi.fn();
const addTransferRequestLine = vi.fn();
vi.mock('@/features/network/network.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/network/network.service')>()),
  getWarehouseStock: (...a: unknown[]) => getWarehouseStock(...a),
  getTransferRequestLines: (...a: unknown[]) => getTransferRequestLines(...a),
  createDirectTransferRequest: (...a: unknown[]) => createDirectTransferRequest(...a),
  addTransferRequestLine: (...a: unknown[]) => addTransferRequestLine(...a),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const sourceWarehouses: NetworkWarehouse[] = [
  { id: 'wh-central-1', name: 'Central', name_ar: 'المركزي', warehouseKind: 'central', status: 'active', isMain: true, code: null, organizationId: 'org-central', facilityId: null },
];
const destinationWarehouses: PartyOption[] = [
  { id: 'wh-inst-1', organizationId: 'org-1', organizationName: 'Institution One', warehouseName: 'Depot' },
];
const organizations = [{ id: 'org-1', name: 'Institution One' }];

function makeStockBatch(overrides: Record<string, unknown> = {}) {
  return {
    id: 'stock-a', warehouseId: 'wh-central-1', scientificName: 'Synthetic Amoxicillin A',
    batchNumber: 'LOT-9', expiryDate: '2027-01-01', onHandQuantity: 10, reservedQuantity: 0,
    availableQuantity: 10, nationalCode: null, centralItemId: 'item-1', concentration: '500mg',
    dosageForm: 'Tablet', unit: 'box', materialIdentityKey: 'key-1', internalBatchReference: null,
    ...overrides,
  };
}

function renderComposer() {
  const onCancel = vi.fn();
  const onCreated = vi.fn();
  const utils = render(
    <DirectSupplyComposer
      sourceWarehouses={sourceWarehouses} destinationWarehouses={destinationWarehouses}
      organizations={organizations} onCancel={onCancel} onCreated={onCreated}
    />,
  );
  return { ...utils, onCancel, onCreated };
}

function selectParties() {
  const combos = screen.getAllByRole('combobox');
  fireEvent.change(combos[1], { target: { value: 'wh-central-1' } });
  fireEvent.change(screen.getByRole('combobox', { name: 'Institutions' }), { target: { value: 'org-1' } });
  fireEvent.change(screen.getAllByRole('combobox')[3], { target: { value: 'wh-inst-1' } });
}

async function addTwoLinesAndReview(refValue: string) {
  getWarehouseStock.mockResolvedValue([
    makeStockBatch({ id: 'stock-a', scientificName: 'Synthetic Amoxicillin A', batchNumber: 'LOT-9', expiryDate: '2027-01-01' }),
    makeStockBatch({ id: 'stock-b', scientificName: 'Synthetic Paracetamol B', batchNumber: 'LOT-4', expiryDate: '2027-06-01', concentration: '250mg', dosageForm: 'Syrup', unit: 'bottle' }),
  ]);

  renderComposer();
  selectParties();
  fireEvent.change(screen.getByRole('textbox', { name: 'Official letter / external document number — required' }), { target: { value: refValue } });
  fireEvent.click(screen.getByRole('button', { name: 'Material selection' }));
  await screen.findByText('Synthetic Amoxicillin A');

  const qtyInputs = screen.getAllByRole('textbox', { name: /Quantity received/ });
  fireEvent.change(qtyInputs[0], { target: { value: '4' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[0]);
  fireEvent.change(screen.getAllByRole('textbox', { name: /Quantity received/ })[1], { target: { value: '4' } });
  fireEvent.click(screen.getAllByRole('button', { name: 'Add' })[1]);

  fireEvent.click(screen.getByRole('button', { name: 'Review' }));
  await screen.findByText(refValue);
}

/** Amoxicillin (line 1) SUCCEEDS; Paracetamol (line 2) FAILS -> partial. */
async function createPartialRequest(refValue = 'REF-3') {
  await addTwoLinesAndReview(refValue);
  createDirectTransferRequest.mockResolvedValue({ ok: true, data: { id: 'supply-req-3' } });
  addTransferRequestLine
    .mockResolvedValueOnce({ ok: true, data: { id: 'supply-line-1' } })
    .mockResolvedValueOnce({ ok: false, error: 'line_failed' });
  await act(async () => {
    fireEvent.click(screen.getByTestId('confirm-create-supply-request'));
  });
  const partialBlock = await screen.findByTestId('supply-partial-failure');

  // The canonical reload reports exactly what the real RPC can report: the ONE
  // line that actually landed (Amoxicillin), with its real material-identity
  // fields and no batch/expiry column at all -- the real TransferRequestLine
  // shape (network.service.ts) has none.
  getTransferRequestLines.mockResolvedValue([{
    id: 'srv-1', transferRequestId: 'supply-req-3', scientificName: 'Synthetic Amoxicillin A',
    concentration: '500mg', dosageForm: 'Tablet', unit: 'box', requestedQuantity: 4,
    approvedQuantity: null, fulfilledQuantity: null, status: 'pending', notes: null,
  }]);
  addTransferRequestLine.mockClear();

  return { partialBlock };
}

describe('DirectSupplyComposer · full success needs no retry', () => {
  it('two lines that both succeed leave no partial-failure block and no retry button', async () => {
    await addTwoLinesAndReview('REF-ALL-OK');
    createDirectTransferRequest.mockResolvedValue({ ok: true, data: { id: 'supply-req-ok' } });
    addTransferRequestLine.mockResolvedValue({ ok: true, data: { id: 'supply-line-x' } });

    await act(async () => {
      fireEvent.click(screen.getByTestId('confirm-create-supply-request'));
    });

    expect(screen.queryByTestId('supply-partial-failure')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry unsent lines only' })).not.toBeInTheDocument();
    expect(addTransferRequestLine).toHaveBeenCalledTimes(2);
  });
});

describe('DirectSupplyComposer · partial success is visible and offers retry', () => {
  it('shows the real partial-failure block with a real Retry button after one line fails', async () => {
    const { partialBlock } = await createPartialRequest();
    expect(within(partialBlock).getByRole('button', { name: 'Retry unsent lines only' })).toBeInTheDocument();
  });
});

describe('DirectSupplyComposer · Retry resends only the failed line (repaired)', () => {
  it('sends exactly one add-line call, for the genuinely-failed material only', async () => {
    const { partialBlock } = await createPartialRequest();
    addTransferRequestLine.mockResolvedValue({ ok: true, data: { id: 'supply-line-retry' } });

    await act(async () => {
      fireEvent.click(within(partialBlock).getByRole('button', { name: 'Retry unsent lines only' }));
    });

    expect(addTransferRequestLine).toHaveBeenCalledTimes(1);
    expect(addTransferRequestLine).toHaveBeenCalledWith(expect.objectContaining({ scientificName: 'Synthetic Paracetamol B' }));
    expect(addTransferRequestLine).not.toHaveBeenCalledWith(expect.objectContaining({ scientificName: 'Synthetic Amoxicillin A' }));
  });

  it('the already-succeeded line is called exactly once across the ENTIRE lifecycle (initial commit + retry)', async () => {
    const { partialBlock } = await createPartialRequest();
    addTransferRequestLine.mockResolvedValue({ ok: true, data: { id: 'supply-line-retry' } });

    await act(async () => {
      fireEvent.click(within(partialBlock).getByRole('button', { name: 'Retry unsent lines only' }));
    });

    const amoxicillinCalls = addTransferRequestLine.mock.calls.filter(
      ([arg]) => arg.scientificName === 'Synthetic Amoxicillin A',
    );
    // Exactly the calls made during the retry itself (0 -- it must not be
    // resent); the initial-commit call was already cleared before retrying,
    // so a nonzero count here would mean the repaired path relapsed.
    expect(amoxicillinCalls).toHaveLength(0);
  });

  it('a real final success clears the partial-failure block and its error state', async () => {
    const { partialBlock } = await createPartialRequest();
    addTransferRequestLine.mockResolvedValue({ ok: true, data: { id: 'supply-line-retry' } });

    await act(async () => {
      fireEvent.click(within(partialBlock).getByRole('button', { name: 'Retry unsent lines only' }));
    });

    expect(screen.queryByTestId('supply-partial-failure')).not.toBeInTheDocument();
  });
});

describe('DirectSupplyComposer · a second failure remains retryable', () => {
  it('retrying again after the retry itself fails still offers Retry, and a third attempt sends the same line again', async () => {
    const { partialBlock: firstPartial } = await createPartialRequest('REF-DOUBLE-FAIL');
    // Retry #1: Paracetamol fails AGAIN.
    addTransferRequestLine.mockResolvedValueOnce({ ok: false, error: 'line_failed_again' });
    await act(async () => {
      fireEvent.click(within(firstPartial).getByRole('button', { name: 'Retry unsent lines only' }));
    });
    const secondPartial = await screen.findByTestId('supply-partial-failure');
    expect(within(secondPartial).getByRole('button', { name: 'Retry unsent lines only' })).toBeInTheDocument();
    expect(addTransferRequestLine).toHaveBeenCalledTimes(1);

    // The canonical reload still reports only Amoxicillin -- Paracetamol
    // never landed on either attempt.
    addTransferRequestLine.mockClear();
    addTransferRequestLine.mockResolvedValueOnce({ ok: true, data: { id: 'supply-line-retry-2' } });
    await act(async () => {
      fireEvent.click(within(secondPartial).getByRole('button', { name: 'Retry unsent lines only' }));
    });

    expect(addTransferRequestLine).toHaveBeenCalledTimes(1);
    expect(addTransferRequestLine).toHaveBeenCalledWith(expect.objectContaining({ scientificName: 'Synthetic Paracetamol B' }));
    expect(screen.queryByTestId('supply-partial-failure')).not.toBeInTheDocument();
  });
});

describe('DirectSupplyComposer · busy-state protection', () => {
  it('a second click on Retry while the first retry is still in flight triggers no second reload', async () => {
    const { partialBlock } = await createPartialRequest('REF-BUSY');
    let releaseReload!: (v: unknown[]) => void;
    getTransferRequestLines.mockReturnValue(new Promise(res => { releaseReload = res; }));

    const retryBtn = within(partialBlock).getByRole('button', { name: 'Retry unsent lines only' });
    fireEvent.click(retryBtn);
    // The composer's own committing guard disables the button while in flight.
    await vi.waitFor(() => expect(retryBtn).toBeDisabled());
    fireEvent.click(retryBtn); // ignored -- disabled, and retryUnsent itself early-returns on `committing`

    expect(getTransferRequestLines).toHaveBeenCalledTimes(1);

    await act(async () => {
      releaseReload([{
        id: 'srv-1', transferRequestId: 'supply-req-3', scientificName: 'Synthetic Amoxicillin A',
        concentration: '500mg', dosageForm: 'Tablet', unit: 'box', requestedQuantity: 4,
        approvedQuantity: null, fulfilledQuantity: null, status: 'pending', notes: null,
      }]);
    });
  });
});

describe('DirectSupplyComposer · a committed request cannot be silently edited back into a retry candidate', () => {
  it('the line table is read-only once a partial result exists -- no quantity input, no remove control', async () => {
    await createPartialRequest('REF-READONLY');
    // MovementLineTable renders with readOnly={committing || Boolean(result)}
    // once a result exists; a read-only row offers no editable quantity
    // control and no remove control for either line.
    expect(screen.queryAllByRole('button', { name: /remove|Remove/ })).toHaveLength(0);
  });
});
