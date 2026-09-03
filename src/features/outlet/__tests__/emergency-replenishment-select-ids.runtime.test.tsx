/**
 * @vitest-environment jsdom
 *
 * EMERGENCY-REPLENISHMENT SELECT ID COLLISION — regression lock.
 *
 * THE DEFECT THIS FILE LOCKS OUT.
 * `PhoenixSelect` derives its DOM id from the LABEL TEXT whenever no explicit
 * `id` prop is supplied (`id ?? label?.toLowerCase().replace(/\s+/g,'-') ??
 * generatedId` — the useId() fallback is unreachable while a label exists).
 * `ReplenishForm` and `ReverseForm` each render a select captioned "Route" and
 * a select captioned "Batch", and both forms are on screen together in the only
 * state either is ever shown (the tab renders them as siblings once the outlet
 * has at least one active outgoing route). The document therefore carried two
 * `id="route"` and two `id="batch"` elements.
 *
 * That is invalid HTML — an id must be unique in the tree — and it concretely
 * broke label association for the SECOND occurrence of each: `getElementById`,
 * the DOM `label.control` property, and a screen reader's "activate the control
 * this label names" all resolve to the FIRST match in document order only. A
 * keyboard or screen-reader user working in the Reverse Replenishment section
 * was routed to the Routine Replenishment section's fields instead.
 *
 * ALL SIX tests fail against the pre-repair component, and every one of them
 * fails for the same mechanical reason: resolving the Reverse form's own
 * "Route"/"Batch" label lands on the Routine form's control, so testing-library
 * reports `Found a label with the text of: Batch, however the element
 * associated with this label (<select />) is non-labellable` — the DOM
 * `label.control` lookup returned the FIRST `#batch` in the document, which
 * lives in the other card. Tests 4-6 assert behaviour the repair must NOT
 * change (state isolation, service-boundary arguments, submit gating, the
 * route-change batch reset, replay wording); they fail here only because they
 * cannot address the reverse controls by label until the ids are unique.
 *
 * The service boundary is MOCKED — every RPC assertion below is a mocked
 * frontend boundary, never a real RPC, database, or end-to-end execution.
 * Every fixture value is synthetic; no real patient or institution data.
 */
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EmergencyReplenishmentTab } from '../EmergencyReplenishmentTab';
import type { ReplenishmentRoute, ReversibleBatch } from '../emergency-replenishment.service';
import type { OutletStockRow } from '../outlet-stock.service';

const svc = vi.hoisted(() => ({
  listReplenishmentRoutes: vi.fn(),
  getReversibleBatches: vi.fn(),
  replenishEmergencyOutlet: vi.fn(),
  reverseOutletReplenishment: vi.fn(),
}));
vi.mock('../emergency-replenishment.service', async () => {
  const actual = await vi.importActual<typeof import('../emergency-replenishment.service')>(
    '../emergency-replenishment.service',
  );
  return {
    ...actual,
    listReplenishmentRoutes: svc.listReplenishmentRoutes,
    getReversibleBatches: svc.getReversibleBatches,
    replenishEmergencyOutlet: svc.replenishEmergencyOutlet,
    reverseOutletReplenishment: svc.reverseOutletReplenishment,
  };
});

const stockSvc = vi.hoisted(() => ({ getOutletStock: vi.fn() }));
vi.mock('../outlet-stock.service', async () => {
  const actual = await vi.importActual<typeof import('../outlet-stock.service')>('../outlet-stock.service');
  return { ...actual, getOutletStock: stockSvc.getOutletStock };
});

// Both preflights are UI affordance only; the RPCs re-check server-side. Fixed
// here so this file tests the id/label contract, not the permission matrix
// (which useEmergencyReplenishmentPermission's own tests already cover).
vi.mock('@/features/inventory/useEmergencyReplenishmentPermission', () => ({
  useEmergencyReplenishmentPermission: () => ({
    data: { canReplenish: true, canReverse: true }, loading: false, error: null, reload: vi.fn(),
  }),
}));
vi.mock('@/features/inventory/useWarehouseDispatchCreatePermission', () => ({
  useWarehouseDispatchCreatePermission: () => ({ data: false, loading: false, error: null, reload: vi.fn() }),
}));

const ORG = 'org-synth-1';
const SOURCE = 'dp-synth-source';

const ROUTE: ReplenishmentRoute = {
  id: 'route-synth-1', organizationId: ORG, sourcePointId: SOURCE, destinationPointId: 'dp-synth-dest',
  sourcePointType: 'pharmacy', destinationPointType: 'rescue_cart', isActive: true, notes: null,
};

const STOCK: OutletStockRow = {
  id: 'stock-synth-1', scientificName: 'Synthetic Amoxicillin', tradeName: null, concentration: null,
  dosageForm: null, unit: null, nationalCode: null, batchNumber: 'BATCH-SYNTH-REPL', internalBatchReference: null,
  expiryDate: null, onHandQuantity: 10, reservedQuantity: 0, availableQuantity: 10, generation: 1,
  centralItemId: null,
};

const REVERSIBLE: ReversibleBatch = {
  originReceiveMovementId: 'mv-recv-1', originSendMovementId: 'mv-send-1', originReferenceId: 'ref-1',
  destinationOutletStockId: 'dest-stock-synth-1', sourceOutletStockId: 'src-stock-synth-1',
  materialIdentityKey: 'mat-1', scientificName: 'Synthetic Amoxicillin', batchNumber: 'BATCH-SYNTH-REV',
  expiryDate: null, originalCreditedQuantity: 5, returnedQuantity: 0, remainingReversibleQuantity: 5,
  originCreatedAt: '2026-08-01T00:00:00Z',
};

/** The two forms, located by their own headings rather than by DOM order. */
const replenishCard = () =>
  screen.getByText('Routine Replenishment').closest('.phoenix-card') as HTMLElement;
const reverseCard = () =>
  screen.getByText('Reverse Replenishment').closest('.phoenix-card') as HTMLElement;

function renderTab() {
  return render(
    <EmergencyReplenishmentTab
      orgId={ORG} distributionPointId={SOURCE} outletName="Synthetic Pharmacy" lang="en"
    />,
  );
}

/** Waits until both forms have finished their async loads and are on screen. */
async function renderBothForms() {
  const utils = renderTab();
  await screen.findByText('Routine Replenishment');
  await waitFor(() => expect(within(reverseCard()).getByLabelText('Batch')).toBeInTheDocument());
  return utils;
}

describe('EmergencyReplenishmentTab · select id/label contract', () => {
  beforeEach(() => {
    svc.listReplenishmentRoutes.mockReset().mockResolvedValue([ROUTE]);
    svc.getReversibleBatches.mockReset().mockResolvedValue([REVERSIBLE]);
    svc.replenishEmergencyOutlet.mockReset().mockResolvedValue({
      ok: true,
      data: {
        ok: true, idempotent_replay: false, request_id: 'r1', route_id: ROUTE.id,
        source_outlet_stock_id: STOCK.id, destination_outlet_stock_id: 'x',
      },
    });
    svc.reverseOutletReplenishment.mockReset().mockResolvedValue({
      ok: true,
      data: {
        ok: true, idempotent_replay: false, request_id: 'r2', route_id: ROUTE.id,
        destination_outlet_stock_id: REVERSIBLE.destinationOutletStockId, source_outlet_stock_id: 'x',
      },
    });
    stockSvc.getOutletStock.mockReset().mockResolvedValue([STOCK]);
  });
  afterEach(cleanup);

  // ---- 1. No duplicate DOM id anywhere in the rendered tab ----
  it('renders no duplicate DOM id while both forms are on screen', async () => {
    const { container } = await renderBothForms();

    const ids = [...container.querySelectorAll('[id]')].map(el => el.id);
    const duplicates = [...new Set(ids.filter((id, i) => ids.indexOf(id) !== i))];

    expect(ids.length).toBeGreaterThan(0);
    expect(duplicates).toEqual([]);
  });

  // ---- 2. Each label resolves to exactly one control, in its own form ----
  it('associates every label with exactly one control inside its own form', async () => {
    const { container } = await renderBothForms();

    const labels = [...container.querySelectorAll('label[for]')] as HTMLLabelElement[];
    expect(labels.length).toBeGreaterThanOrEqual(4);

    for (const label of labels) {
      const targets = container.querySelectorAll(`[id="${CSS.escape(label.htmlFor)}"]`);
      // Exactly one control answers to this label's `for`, so the association
      // is unambiguous for getElementById / label.control / assistive tech.
      expect(targets, `label "${label.textContent}" -> #${label.htmlFor}`).toHaveLength(1);
      // ...and that control lives in the same form card as the label itself,
      // i.e. the label never points across into the other form.
      expect(label.closest('.phoenix-card')).toBe(targets[0].closest('.phoenix-card'));
    }
  });

  // ---- 3. Both "Route" and both "Batch" controls are reachable by label ----
  it('exposes both Route and both Batch selects to label-based lookup', async () => {
    await renderBothForms();

    // Pre-repair these each returned a single element: the duplicate id meant
    // the Reverse form's own controls could not be reached by label at all.
    expect(screen.getAllByLabelText('Route')).toHaveLength(2);
    expect(screen.getAllByLabelText('Batch')).toHaveLength(2);

    const replRoute = within(replenishCard()).getByLabelText('Route');
    const revRoute = within(reverseCard()).getByLabelText('Route');
    const replBatch = within(replenishCard()).getByLabelText('Batch');
    const revBatch = within(reverseCard()).getByLabelText('Batch');

    expect(replRoute).not.toBe(revRoute);
    expect(replBatch).not.toBe(revBatch);

    // Each label reaches the select that actually belongs to that form: the two
    // forms build visibly different option sets from the same route/batch data.
    expect(replBatch).toHaveTextContent('BATCH-SYNTH-REPL');
    expect(replBatch).not.toHaveTextContent('BATCH-SYNTH-REV');
    expect(revBatch).toHaveTextContent('BATCH-SYNTH-REV');
    expect(revBatch).not.toHaveTextContent('BATCH-SYNTH-REPL');
  });

  // ---- 4. Replenish interaction touches only replenish state ----
  it('replenish fields drive only the replenish form and its own service call', async () => {
    await renderBothForms();

    const replBatch = within(replenishCard()).getByLabelText('Batch') as HTMLSelectElement;
    const revBatch = within(reverseCard()).getByLabelText('Batch') as HTMLSelectElement;
    const replQty = within(replenishCard()).getByLabelText('Quantity *') as HTMLInputElement;
    const revQty = within(reverseCard()).getByLabelText('Quantity *') as HTMLInputElement;

    fireEvent.change(replBatch, { target: { value: STOCK.id } });
    fireEvent.change(replQty, { target: { value: '3' } });

    expect(replBatch).toHaveValue(STOCK.id);
    expect(replQty).toHaveValue(3);
    // The reverse form is untouched by any of it.
    expect(revBatch).toHaveValue('');
    expect(revQty).toHaveValue(null);

    const submit = within(replenishCard()).getByRole('button', { name: 'Execute Replenishment' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    // (mocked boundary) — the replenishment RPC only, with this form's values.
    await waitFor(() => expect(svc.replenishEmergencyOutlet).toHaveBeenCalledTimes(1));
    expect(svc.replenishEmergencyOutlet.mock.calls[0][0]).toMatchObject({
      routeId: ROUTE.id, sourceOutletStockId: STOCK.id, quantity: 3,
    });
    expect(svc.reverseOutletReplenishment).not.toHaveBeenCalled();
    expect(await screen.findByText('Replenishment completed successfully')).toBeInTheDocument();
  });

  // ---- 5. Reverse interaction touches only reverse state ----
  it('reverse fields drive only the reverse form and its own service call', async () => {
    await renderBothForms();

    const replBatch = within(replenishCard()).getByLabelText('Batch') as HTMLSelectElement;
    const revBatch = within(reverseCard()).getByLabelText('Batch') as HTMLSelectElement;
    const replQty = within(replenishCard()).getByLabelText('Quantity *') as HTMLInputElement;
    const revQty = within(reverseCard()).getByLabelText('Quantity *') as HTMLInputElement;

    fireEvent.change(revBatch, { target: { value: REVERSIBLE.destinationOutletStockId } });
    fireEvent.change(revQty, { target: { value: '2' } });
    fireEvent.change(within(reverseCard()).getByLabelText('Reversal Reason'), {
      target: { value: '  synthetic reason  ' },
    });

    expect(revBatch).toHaveValue(REVERSIBLE.destinationOutletStockId);
    expect(revQty).toHaveValue(2);
    // The replenish form is untouched by any of it.
    expect(replBatch).toHaveValue('');
    expect(replQty).toHaveValue(null);

    const submit = within(reverseCard()).getByRole('button', { name: 'Execute Reversal' });
    expect(submit).toBeEnabled();
    fireEvent.click(submit);

    // (mocked boundary) — the reversal RPC only, with this form's values, reason trimmed.
    await waitFor(() => expect(svc.reverseOutletReplenishment).toHaveBeenCalledTimes(1));
    expect(svc.reverseOutletReplenishment.mock.calls[0][0]).toMatchObject({
      routeId: ROUTE.id,
      destinationOutletStockId: REVERSIBLE.destinationOutletStockId,
      quantity: 2,
      reason: 'synthetic reason',
    });
    expect(svc.replenishEmergencyOutlet).not.toHaveBeenCalled();
    expect(await screen.findByText('Replenishment reversed successfully')).toBeInTheDocument();
  });

  // ---- 6. Submit gating and route->batch reset are unchanged by the repair ----
  it('keeps submit gating, the route-change batch reset, and idempotent replay wording', async () => {
    const ROUTE_2: ReplenishmentRoute = { ...ROUTE, id: 'route-synth-2' };
    svc.listReplenishmentRoutes.mockReset().mockResolvedValue([ROUTE, ROUTE_2]);
    svc.reverseOutletReplenishment.mockReset().mockResolvedValue({
      ok: true,
      data: {
        ok: true, idempotent_replay: true, request_id: 'r2', route_id: ROUTE.id,
        destination_outlet_stock_id: REVERSIBLE.destinationOutletStockId, source_outlet_stock_id: 'x',
      },
    });
    await renderBothForms();

    const revSubmit = within(reverseCard()).getByRole('button', { name: 'Execute Reversal' });
    const revBatch = within(reverseCard()).getByLabelText('Batch') as HTMLSelectElement;
    const revQty = within(reverseCard()).getByLabelText('Quantity *');
    const revRoute = within(reverseCard()).getByLabelText('Route') as HTMLSelectElement;

    expect(revSubmit).toBeDisabled();
    fireEvent.change(revBatch, { target: { value: REVERSIBLE.destinationOutletStockId } });
    expect(revSubmit).toBeDisabled(); // quantity still empty

    fireEvent.change(revQty, { target: { value: String(REVERSIBLE.remainingReversibleQuantity + 1) } });
    expect(revSubmit).toBeDisabled(); // over the server-capped reversible quantity

    fireEvent.change(revQty, { target: { value: '1' } });
    expect(revSubmit).toBeEnabled();

    // Changing the route clears the chosen batch — that batch belonged to the
    // previous route's read model and must not survive the switch.
    fireEvent.change(revRoute, { target: { value: ROUTE_2.id } });
    await waitFor(() => {
      expect(within(reverseCard()).getByLabelText('Batch')).toHaveValue('');
    });
    expect(revSubmit).toBeDisabled();

    // An idempotent replay is still reported as a replay, not as a fresh move.
    fireEvent.change(within(reverseCard()).getByLabelText('Batch'), {
      target: { value: REVERSIBLE.destinationOutletStockId },
    });
    fireEvent.change(within(reverseCard()).getByLabelText('Quantity *'), { target: { value: '1' } });
    fireEvent.click(within(reverseCard()).getByRole('button', { name: 'Execute Reversal' }));
    await waitFor(() => expect(svc.reverseOutletReplenishment).toHaveBeenCalledTimes(1));
    expect(
      await screen.findByText('Duplicate request — no additional stock was moved'),
    ).toBeInTheDocument();
  });
});
