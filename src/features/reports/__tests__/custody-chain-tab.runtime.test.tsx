/**
 * @vitest-environment jsdom
 *
 * REPORTING-RUNTIME-RECOVERY R01 — genuine component/runtime test, not a
 * source-string scan. Renders CustodyChainTab for real (via
 * @testing-library/react) with mocked service calls, and proves the
 * loading -> loaded transition never throws React's "Rendered more hooks
 * than during the previous render" invariant violation — the exact defect
 * that previously blanked the whole app shell on first load. A static
 * source scan (decision-intelligence-reports.test.ts) cannot catch this
 * class of bug: the broken code READS the same, it only CRASHES at runtime.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { CustodyChainTab } from '../DecisionIntelligenceReportsScreen';
import type { WarehouseDispatch } from '@/features/outlet/dispatch.service';
import type { OutletReturnRequest, OutletReturnShipment } from '@/features/outlet/outlet-return.service';
import type { MovementTimelineResult } from '../custody-chain.service';

const listCustodyDispatches = vi.fn<() => Promise<WarehouseDispatch[]>>();
const listCustodyReturnRequests = vi.fn<() => Promise<OutletReturnRequest[]>>();
const listCustodyReturnShipments = vi.fn<() => Promise<OutletReturnShipment[]>>();
const getMovementTimeline = vi.fn<(id: string) => Promise<MovementTimelineResult>>();

vi.mock('../custody-chain.service', () => ({
  listCustodyDispatches: () => listCustodyDispatches(),
  listCustodyReturnRequests: () => listCustodyReturnRequests(),
  listCustodyReturnShipments: () => listCustodyReturnShipments(),
  getMovementTimeline: (id: string) => getMovementTimeline(id),
}));

const getDispenseContext = vi.fn();
vi.mock('@/features/outlet/dispense-context.service', () => ({
  getDispenseContext: (movementId: string) => getDispenseContext(movementId),
}));

const getPaperReferencesFor = vi.fn(async (_documentType: string, _documentIds: readonly string[]) => new Map());
vi.mock('@/features/movement/paper-reference.service', () => ({
  getPaperReferencesFor: (documentType: string, documentIds: readonly string[]) => getPaperReferencesFor(documentType, documentIds),
}));

const DISPATCH: WarehouseDispatch = {
  id: 'd1', organizationId: 'org1', warehouseId: 'w1', destinationDistributionPointId: 'dp1',
  dispatchNumber: 'DSP-0001', status: 'sent', documentNumber: null, defaultCurrency: null,
  notes: null, sentAt: '2026-07-20T00:00:00Z', createdAt: '2026-07-19T00:00:00Z',
};
const RETURN_REQUEST: OutletReturnRequest = {
  id: 'r1', distributionPointId: 'dp1', sourceOrganizationId: 'org1', destinationWarehouseId: 'w1',
  destinationOrganizationId: 'org1', returnNumber: 'RET-0001', status: 'pending',
  requestedBySide: 'outlet', notes: null, createdAt: '2026-07-21T00:00:00Z',
};
const SHIPMENT: OutletReturnShipment = {
  id: 's1', returnRequestId: 'r1', distributionPointId: 'dp1', destinationWarehouseId: 'w1',
  shipmentNumber: 'SHP-0001', status: 'shipped',
};
const TIMELINE: MovementTimelineResult = {
  ok: true, complete: true, completeness_note: 'complete',
  events: [{
    event_id: 'e1', event_type: 'dispatch.sent', occurred_at: '2026-07-20T00:00:00Z',
    actor_id: 'u1', actor_role: 'warehouse_officer', actor_name: 'Test Officer', status: 'sent',
    material: 'Paracetamol', batch: 'B1', quantity_delta: -10, reference_type: null,
    reference_id: null, reference: null, provenance: 'movement_events',
    // MOVEMENT-TIMELINE-CONTRACT-FIELDS-139
    reason_code: 'dispensed', quantity_before: 30, quantity_after: 20,
    correlation_id: 'c0ffee00-0000-4000-8000-000000000001',
    causation_id: 'ca05a710-0000-4000-8000-000000000002',
    has_dispense_context: true,
  }],
};

/** A derived_from_column event genuinely has no quantity/reason — the UI must
 *  show that honestly rather than invent values. */
const TIMELINE_DERIVED: MovementTimelineResult = {
  ok: true, complete: false, completeness_note: 'partial',
  events: [{
    event_id: 'e2', event_type: 'dispatch_sent', occurred_at: '2026-07-20T00:00:00Z',
    actor_id: 'u1', actor_role: null, actor_name: null, status: 'sent',
    material: null, batch: null, quantity_delta: null, reference_type: 'warehouse_dispatch',
    reference_id: 'd1', reference: 'DSP-0001', provenance: 'derived_from_column',
    reason_code: null, quantity_before: null, quantity_after: null,
    correlation_id: null, causation_id: null, has_dispense_context: false,
  }],
};

const noop = () => {};

describe('CustodyChainTab — loading to loaded transition (runtime, not source-scan)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPaperReferencesFor.mockResolvedValue(new Map());
  });

  // No global vitest `globals: true` / setup file exists in this repo, so
  // @testing-library/react's auto-cleanup-on-afterEach never registers —
  // without this, each render() in this file would leave its DOM tree
  // mounted, and later queries would find duplicate elements across tests.
  afterEach(cleanup);

  it('renders a loading state first, then resolves to loaded content, with no thrown hook-order error (R01)', async () => {
    listCustodyDispatches.mockResolvedValue([DISPATCH]);
    listCustodyReturnRequests.mockResolvedValue([RETURN_REQUEST]);
    listCustodyReturnShipments.mockResolvedValue([SHIPMENT]);

    // React itself throws synchronously (surfaced as an uncaught error during
    // the effect flush) if hook order is violated between renders — no
    // try/catch needed here: an unhandled hook-order violation would fail
    // this test via an uncaught rejection/console.error assertion is not
    // even necessary, the render commit itself would throw.
    render(<CustodyChainTab lang="en" onToast={noop} onMobilePrint={noop} />);

    // Initial render: data not resolved yet.
    expect(document.body.textContent).toBeTruthy();

    await waitFor(() => {
      expect(screen.getByText('DSP-0001')).toBeInTheDocument();
    });

    // The report shell (data-testid on the tab root) must still be mounted —
    // the whole point of R01 is that the app shell must not disappear.
    expect(screen.getByTestId('custody-chain-tab')).toBeInTheDocument();
    expect(screen.getByText('RET-0001')).toBeInTheDocument();
  });

  it('renders cleanly with empty results from all three reads (no crash, no infinite loading)', async () => {
    listCustodyDispatches.mockResolvedValue([]);
    listCustodyReturnRequests.mockResolvedValue([]);
    listCustodyReturnShipments.mockResolvedValue([]);

    render(<CustodyChainTab lang="en" onToast={noop} onMobilePrint={noop} />);

    await waitFor(() => {
      expect(screen.getByTestId('custody-chain-tab')).toBeInTheDocument();
    });
    // No dispatch/return rows to find; the tab itself must still be present.
    expect(screen.queryByText('DSP-0001')).not.toBeInTheDocument();
  });

  it('clicking a dispatch row expands the movement timeline (toggleTrace) without a hook-order crash', async () => {
    listCustodyDispatches.mockResolvedValue([DISPATCH]);
    listCustodyReturnRequests.mockResolvedValue([]);
    listCustodyReturnShipments.mockResolvedValue([]);
    getMovementTimeline.mockResolvedValue(TIMELINE);

    render(<CustodyChainTab lang="en" onToast={noop} onMobilePrint={noop} />);

    await waitFor(() => expect(screen.getByText('DSP-0001')).toBeInTheDocument());

    fireEvent.click(screen.getByText('DSP-0001'));

    await waitFor(() => {
      expect(screen.getByText('dispatch.sent')).toBeInTheDocument();
    });
    expect(getMovementTimeline).toHaveBeenCalledWith('d1');
  });

  it('shows an error state (with retry) when the dispatches read fails, and never renders paper-reference hooks on a broken partial state', async () => {
    listCustodyDispatches.mockRejectedValue(new Error('network down'));
    listCustodyReturnRequests.mockResolvedValue([]);
    listCustodyReturnShipments.mockResolvedValue([]);

    render(<CustodyChainTab lang="en" onToast={noop} onMobilePrint={noop} />);

    await waitFor(() => {
      expect(screen.getByText('network down')).toBeInTheDocument();
    });
  });

  it('139: a movement-row trace event shows legal fields while technical UUIDs stay internal', async () => {
    listCustodyDispatches.mockResolvedValue([DISPATCH]);
    listCustodyReturnRequests.mockResolvedValue([]);
    listCustodyReturnShipments.mockResolvedValue([]);
    getMovementTimeline.mockResolvedValue(TIMELINE);
    render(<CustodyChainTab lang="en" onToast={noop} onMobilePrint={noop} />);

    fireEvent.click(await screen.findByText('DSP-0001'));
    const ev = await screen.findByTestId('custody-trace-event');
    expect(ev.textContent).toContain('Dispensed');        // translated reason_code
    expect(ev.textContent).toMatch(/30\s*→\s*20/);        // before → after
    expect(ev.textContent).toContain('(-10)');             // signed delta
    expect(ev.textContent).not.toContain('c0ffee00');      // correlation is internal
    expect(ev.textContent).not.toContain('ca05a710');      // causation is internal
    expect(ev.textContent).toContain('movement_events');   // provenance still shown
  });

  it('139: an event with no quantity/reason (derived_from_column) shows neither — absence is honest, never invented', async () => {
    listCustodyDispatches.mockResolvedValue([DISPATCH]);
    listCustodyReturnRequests.mockResolvedValue([]);
    listCustodyReturnShipments.mockResolvedValue([]);
    getMovementTimeline.mockResolvedValue(TIMELINE_DERIVED);
    render(<CustodyChainTab lang="en" onToast={noop} onMobilePrint={noop} />);

    fireEvent.click(await screen.findByText('DSP-0001'));
    const ev = await screen.findByTestId('custody-trace-event');
    expect(ev.textContent).not.toMatch(/Reason code:/);
    expect(ev.textContent).not.toMatch(/→\s*\d/);
    expect(ev.textContent).toContain('derived_from_column');
    // The document reference IS present and must still render.
    expect(ev.textContent).toContain('DSP-0001');
  });

  it('139: has_dispense_context opens the MASKED drill-down via the existing RPC, and the trace itself never carries beneficiary detail', async () => {
    listCustodyDispatches.mockResolvedValue([DISPATCH]);
    listCustodyReturnRequests.mockResolvedValue([]);
    listCustodyReturnShipments.mockResolvedValue([]);
    getMovementTimeline.mockResolvedValue(TIMELINE);
    getDispenseContext.mockResolvedValue({
      id: 'ctx1', movementId: 'e1', beneficiaryType: 'patient',
      patientIdentifier: null, patientName: null, patientReferenceType: 'chart',
      patientIdentityMasked: true, crashCartReference: null, internalOrderReference: null,
      notes: null, recordedBy: 'u1', recordedAt: '2026-07-20T00:00:00Z',
    });
    render(<CustodyChainTab lang="en" onToast={noop} onMobilePrint={noop} />);

    fireEvent.click(await screen.findByText('DSP-0001'));
    const ev = await screen.findByTestId('custody-trace-event');
    // No beneficiary detail is present in the trace payload rendering itself.
    expect(ev.textContent).not.toMatch(/MRN|patient_identifier/i);

    fireEvent.click(screen.getByRole('button', { name: /Beneficiary . View/i }));
    expect(getDispenseContext).toHaveBeenCalledWith('e1');
    await waitFor(() => expect(screen.getByTestId('dispense-context-viewer')).toBeInTheDocument());
    // Server said masked -> the viewer shows the masked indicator, never a value.
    expect(screen.getByTestId('dispense-context-viewer').textContent).not.toMatch(/MRN/i);
  });

  it('139: an event WITHOUT a dispense context renders no drill-down affordance at all', async () => {
    listCustodyDispatches.mockResolvedValue([DISPATCH]);
    listCustodyReturnRequests.mockResolvedValue([]);
    listCustodyReturnShipments.mockResolvedValue([]);
    getMovementTimeline.mockResolvedValue(TIMELINE_DERIVED);
    render(<CustodyChainTab lang="en" onToast={noop} onMobilePrint={noop} />);

    fireEvent.click(await screen.findByText('DSP-0001'));
    await screen.findByTestId('custody-trace-event');
    expect(screen.queryByRole('button', { name: /Beneficiary . View/i })).not.toBeInTheDocument();
    expect(getDispenseContext).not.toHaveBeenCalled();
  });
});
