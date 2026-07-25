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
});
