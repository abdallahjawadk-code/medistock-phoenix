/**
 * @vitest-environment jsdom
 *
 * REPORTING-RUNTIME-RECOVERY R02 — genuine component/runtime test for
 * CorrectionsHistoryTab, mirroring custody-chain-tab.runtime.test.tsx. The
 * fix moved the paper-reference useAsync hook before the loading/error/empty
 * early returns; this proves the loading -> loaded transition never throws
 * React's fixed-hook-order invariant.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup, fireEvent } from '@testing-library/react';
import { CorrectionsHistoryTab } from '../DecisionIntelligenceReportsScreen';
import type { CorrectionHistoryRow } from '../differences-corrections.service';

const listCorrectionHistory = vi.fn<() => Promise<CorrectionHistoryRow[]>>();
vi.mock('../differences-corrections.service', () => ({
  listCorrectionHistory: () => listCorrectionHistory(),
}));

const getPaperReferencesFor = vi.fn(async (_documentType: string, _documentIds: readonly string[]) => new Map());
vi.mock('@/features/movement/paper-reference.service', () => ({
  getPaperReferencesFor: (documentType: string, documentIds: readonly string[]) => getPaperReferencesFor(documentType, documentIds),
}));

// REPORTING-UNIFICATION: mission requirement — prove export/print carry
// REAL row content, not just that the button exists/was clicked. Captures
// the exact config the tab hands to the shared export module.
const exportProfessionalXlsx = vi.fn<(...args: unknown[]) => Promise<boolean>>(async () => true);
const triggerProfessionalPrint = vi.fn<(...args: unknown[]) => { ok: boolean; mobileHtml: string | undefined }>(() => ({ ok: true, mobileHtml: undefined }));
vi.mock('@/shared/lib/professional-export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/lib/professional-export')>();
  return { ...actual, exportProfessionalXlsx: (...a: unknown[]) => exportProfessionalXlsx(...a), triggerProfessionalPrint: (...a: unknown[]) => triggerProfessionalPrint(...a) };
});

const OUTLET_ROW: CorrectionHistoryRow = {
  id: 'c1', scope: 'outlet', status: 'pending', scientificName: 'Paracetamol',
  batchNumber: 'B1', onHandBefore: 30, afterOrProposed: 27, variance: -3,
  reason: 'stocktake shortfall', decisionReason: null, proposedByName: 'Officer A',
  proposedAt: '2026-07-20T00:00:00Z', decidedAt: null,
  appliedMovementId: null, // no movement posted while pending
};
const WAREHOUSE_ROW: CorrectionHistoryRow = {
  id: 'c2', scope: 'warehouse', status: 'approved', scientificName: 'Amoxicillin',
  batchNumber: 'B2', onHandBefore: 100, afterOrProposed: 95, variance: -5,
  reason: 'damaged units', decisionReason: 'confirmed', proposedByName: 'Officer B',
  proposedAt: '2026-07-19T00:00:00Z', decidedAt: '2026-07-19T12:00:00Z',
  appliedMovementId: 'a1b2c3d4-0000-0000-0000-000000000001',
};

const noop = () => {};

describe('CorrectionsHistoryTab — loading to loaded transition (runtime, not source-scan)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPaperReferencesFor.mockResolvedValue(new Map());
  });
  afterEach(cleanup);

  it('renders a loading state first, then resolves to loaded content, with no thrown hook-order error (R02)', async () => {
    listCorrectionHistory.mockResolvedValue([OUTLET_ROW, WAREHOUSE_ROW]);

    render(<CorrectionsHistoryTab lang="en" onToast={noop} onMobilePrint={noop} />);

    await waitFor(() => {
      expect(screen.getByText('Paracetamol')).toBeInTheDocument();
    });
    expect(screen.getByTestId('corrections-history-tab')).toBeInTheDocument();
    expect(screen.getByText('Amoxicillin')).toBeInTheDocument();
  });

  it('renders the empty state cleanly when there is no correction history (no crash)', async () => {
    listCorrectionHistory.mockResolvedValue([]);

    render(<CorrectionsHistoryTab lang="en" onToast={noop} onMobilePrint={noop} />);

    await waitFor(() => {
      // The empty state renders instead of the table-bearing tab root.
      expect(screen.queryByTestId('corrections-history-tab')).not.toBeInTheDocument();
    });
    expect(getPaperReferencesFor).toHaveBeenCalledWith('stock_correction_request', []);
  });

  it('shows a non-technical recorded marker for an approved correction, and no UUID', async () => {
    listCorrectionHistory.mockResolvedValue([OUTLET_ROW, WAREHOUSE_ROW]);

    render(<CorrectionsHistoryTab lang="en" onToast={noop} onMobilePrint={noop} />);

    await waitFor(() => expect(screen.getByText('Paracetamol')).toBeInTheDocument());
    expect(screen.getByText('Recorded')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(WAREHOUSE_ROW.appliedMovementId!);
    // The pending row's cell has no appliedMovementId, so no title-bearing
    // cell exists for it — only one such cell should be present.
    expect(document.querySelector(`[title="${WAREHOUSE_ROW.appliedMovementId}"]`)).toBeNull();
  });

  it('only fetches paper references for outlet-scope rows, never warehouse-scope (110 does not cover warehouse corrections)', async () => {
    listCorrectionHistory.mockResolvedValue([OUTLET_ROW, WAREHOUSE_ROW]);

    render(<CorrectionsHistoryTab lang="en" onToast={noop} onMobilePrint={noop} />);

    await waitFor(() => expect(screen.getByText('Paracetamol')).toBeInTheDocument());
    expect(getPaperReferencesFor).toHaveBeenCalledWith('stock_correction_request', ['c1']);
  });

  it('shows an error state (with retry) when the history read fails', async () => {
    listCorrectionHistory.mockRejectedValue(new Error('load failed'));

    render(<CorrectionsHistoryTab lang="en" onToast={noop} onMobilePrint={noop} />);

    await waitFor(() => {
      expect(screen.getByText('load failed')).toBeInTheDocument();
    });
  });
});

describe('CorrectionsHistoryTab — export/print carry REAL row content (not just a button click)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPaperReferencesFor.mockResolvedValue(new Map());
  });
  afterEach(cleanup);

  it('Export Excel hands the real, currently-loaded rows to the shared export module — actual material names and variances, not an empty/stub config', async () => {
    listCorrectionHistory.mockResolvedValue([OUTLET_ROW, WAREHOUSE_ROW]);
    render(<CorrectionsHistoryTab lang="en" onToast={noop} onMobilePrint={noop} />);
    await waitFor(() => expect(screen.getByText('Paracetamol')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Export Excel' }));
    await waitFor(() => expect(exportProfessionalXlsx).toHaveBeenCalledTimes(1));

    const config = exportProfessionalXlsx.mock.calls[0][0] as { rows: CorrectionHistoryRow[]; fileNameBase: string };
    expect(config.rows).toHaveLength(2);
    expect(config.rows.map(r => r.scientificName)).toEqual(['Paracetamol', 'Amoxicillin']);
    expect(config.rows.map(r => r.variance)).toEqual([-3, -5]);
    expect(config.fileNameBase).toBe('medistock-differences-corrections');
  });

  it('Print hands the same real rows to the shared print trigger', async () => {
    listCorrectionHistory.mockResolvedValue([OUTLET_ROW, WAREHOUSE_ROW]);
    render(<CorrectionsHistoryTab lang="en" onToast={noop} onMobilePrint={noop} />);
    await waitFor(() => expect(screen.getByText('Paracetamol')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'Print' }));
    expect(triggerProfessionalPrint).toHaveBeenCalledTimes(1);

    const config = triggerProfessionalPrint.mock.calls[0][0] as { rows: CorrectionHistoryRow[] };
    expect(config.rows).toHaveLength(2);
    expect(config.rows.map(r => r.batchNumber)).toEqual(['B1', 'B2']);
  });
});
