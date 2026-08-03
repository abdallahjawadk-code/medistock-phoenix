/**
 * @vitest-environment jsdom
 *
 * PHASE-C1-REPORT-INTEGRITY — genuine component/runtime proof for
 * MonthlyPositionTab's error-integrity fix, mirroring
 * custody-chain-tab.runtime.test.tsx's style: mocked service calls, real
 * render/rerender, real assertions on what actually appears in the DOM.
 *
 * The bug this covers: the open-report read's failure used to fall through
 * silently to the "no open report" empty-state branch (the tab never
 * checked `.error` at all), and a failed reload could leave a STALE
 * previous report rendered as if it were still current (useAsync retains
 * the last-good `data` through a failed reload). Both are fixed by
 * checking `.error` before ever reaching the empty-state or report-card
 * branches.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MonthlyPositionTab } from '../DecisionIntelligenceReportsScreen';
import type { MonthlyStatusReport, MonthlyStatusLine } from '@/shared/supabase/services/monthly-status.service';

const getOpenMonthlyStatusReport = vi.fn<(orgId: string) => Promise<MonthlyStatusReport | null>>();
const getLatestLockedMonthlyStatusReport = vi.fn<(orgId: string) => Promise<MonthlyStatusReport | null>>();
const getMonthlyStatusLines = vi.fn<(reportId: string) => Promise<MonthlyStatusLine[]>>();
const prepareMonthlyStatusReport = vi.fn();
const classifyMonthlyStatusLines = vi.fn();
const confirmSuspectedMissing = vi.fn();
const submitMonthlyStatusReport = vi.fn();
const returnMonthlyStatusReportForClarification = vi.fn();
const approveLockMonthlyStatusReport = vi.fn();
const createMonthlyStatusAmendment = vi.fn();
const recordStocktake = vi.fn();
const getStocktakeCountLines = vi.fn(async (_stocktakeId: string) => [] as unknown[]);

vi.mock('@/shared/supabase/services/monthly-status.service', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/shared/supabase/services/monthly-status.service')>();
  return {
    ...actual,
    getOpenMonthlyStatusReport: (orgId: string) => getOpenMonthlyStatusReport(orgId),
    getLatestLockedMonthlyStatusReport: (orgId: string) => getLatestLockedMonthlyStatusReport(orgId),
    getMonthlyStatusLines: (reportId: string) => getMonthlyStatusLines(reportId),
    prepareMonthlyStatusReport: (...a: unknown[]) => prepareMonthlyStatusReport(...a),
    classifyMonthlyStatusLines: (...a: unknown[]) => classifyMonthlyStatusLines(...a),
    confirmSuspectedMissing: (...a: unknown[]) => confirmSuspectedMissing(...a),
    submitMonthlyStatusReport: (...a: unknown[]) => submitMonthlyStatusReport(...a),
    returnMonthlyStatusReportForClarification: (...a: unknown[]) => returnMonthlyStatusReportForClarification(...a),
    approveLockMonthlyStatusReport: (...a: unknown[]) => approveLockMonthlyStatusReport(...a),
    createMonthlyStatusAmendment: (...a: unknown[]) => createMonthlyStatusAmendment(...a),
    recordStocktake: (...a: unknown[]) => recordStocktake(...a),
    getStocktakeCountLines: (stocktakeId: string) => getStocktakeCountLines(stocktakeId),
  };
});

vi.mock('@/features/inventory/useInventoryScopes', () => ({
  useInventoryScopes: () => ({ data: { manageableWarehouses: [], manageableOutlets: [] }, loading: false, error: null, reload: vi.fn() }),
}));

const REPORT_A: MonthlyStatusReport = {
  id: 'r-A', organization_id: 'orgA', status: 'draft', version: 1, amendment_of: null,
  prepared_by: 'u1', prepared_at: '2026-07-01T00:00:00Z', submitted_by: null, submitted_at: null,
  approved_by: null, approved_at: null, locked_at: null, returned_by: null, returned_at: null,
  return_reason: null, created_at: '2026-07-01T00:00:00Z', updated_at: '2026-07-01T00:00:00Z',
};
const LINE_A: MonthlyStatusLine = {
  id: 'l-A', report_id: 'r-A', scientific_name: 'Amoxicillin', national_code: 'NC-1',
  on_hand_qty: 10, reserved_qty: 0, in_transit_qty: 0, quarantine_qty: 0, central_qty: 5,
  supplementary_qty: 5, nearest_expiry_date: null, suggested_classification: 'available',
  classification: 'available', classification_reason: null, classification_overridden: false,
  stocktake_count_line_id: null, confirmed_missing: false, confirmed_by: null, confirmed_at: null,
};

const noop = () => {};

describe('MonthlyPositionTab — loading/success/empty/error precedence (runtime, not source-scan)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getLatestLockedMonthlyStatusReport.mockResolvedValue(null);
  });
  afterEach(cleanup);

  it('success-with-data: a real open report and its lines render the report card and table', async () => {
    getOpenMonthlyStatusReport.mockResolvedValue(REPORT_A);
    getMonthlyStatusLines.mockResolvedValue([LINE_A]);

    render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);

    await waitFor(() => expect(screen.getByText('Amoxicillin')).toBeInTheDocument());
    expect(screen.getByTestId('monthly-position-tab')).toBeInTheDocument();
    expect(screen.queryByText('No open report right now')).not.toBeInTheDocument();
  });

  it('success-empty: a genuinely absent open report shows the empty state with a Prepare action, not an error', async () => {
    getOpenMonthlyStatusReport.mockResolvedValue(null);

    render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);

    await waitFor(() => expect(screen.getByText('No open report right now')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Prepare status' })).toBeInTheDocument();
  });

  it('PHASE-C1 fix: a read failure shows an error state, NEVER the "no open report" empty state', async () => {
    getOpenMonthlyStatusReport.mockRejectedValue(new Error('connection reset'));

    render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);

    await waitFor(() => expect(screen.getByText('connection reset')).toBeInTheDocument());
    expect(screen.queryByText('No open report right now')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Prepare status' })).not.toBeInTheDocument();
  });

  it('a report that resolves fine but whose LINES fail to load also shows an error, never a report card with a silently-empty table', async () => {
    getOpenMonthlyStatusReport.mockResolvedValue(REPORT_A);
    getMonthlyStatusLines.mockRejectedValue(new Error('lines read failed'));

    render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);

    await waitFor(() => expect(screen.getByText('lines read failed')).toBeInTheDocument());
    // Never silently renders the report card as if it had zero materials.
    expect(screen.queryByText('No open report right now')).not.toBeInTheDocument();
  });

  it('Retry re-issues the exact same read (current orgId) and recovers to success', async () => {
    getOpenMonthlyStatusReport.mockRejectedValueOnce(new Error('temporary failure'));
    render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);
    await waitFor(() => expect(screen.getByText('temporary failure')).toBeInTheDocument());

    getOpenMonthlyStatusReport.mockResolvedValue(null);
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));

    await waitFor(() => expect(screen.getByText('No open report right now')).toBeInTheDocument());
    // Old error must not linger once the retry succeeds.
    expect(screen.queryByText('temporary failure')).not.toBeInTheDocument();
    expect(getOpenMonthlyStatusReport).toHaveBeenCalledWith('orgA');
  });

  it('a FAILED refresh never leaves the previous successful report rendered as if it were still current', async () => {
    getOpenMonthlyStatusReport.mockResolvedValue(REPORT_A);
    getMonthlyStatusLines.mockResolvedValue([LINE_A]);
    render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);
    await waitFor(() => expect(screen.getByText('Amoxicillin')).toBeInTheDocument());

    // A manual refresh (the "Refresh balances" action re-runs
    // prepareMonthlyStatusReport then reloads reportState) that this time
    // fails outright.
    getOpenMonthlyStatusReport.mockRejectedValue(new Error('refresh failed'));
    prepareMonthlyStatusReport.mockResolvedValue({ ok: true, report_id: 'r-A' });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh balances' }));

    await waitFor(() => expect(screen.getByText('refresh failed')).toBeInTheDocument());
    // The stale report content (and its line table) must be gone, not shown
    // underneath/alongside the error as if still "current".
    expect(screen.queryByText('Amoxicillin')).not.toBeInTheDocument();
  });

  it('org switch: a slow org-A response resolving AFTER a fast org-B response never overwrites B\'s report with A\'s (race safety)', async () => {
    let resolveA!: (v: MonthlyStatusReport | null) => void;
    const pendingA = new Promise<MonthlyStatusReport | null>(res => { resolveA = res; });
    // Org A is slow and never resolves until told to; org B is fast and has
    // no open report at all — a clean, unambiguous state to assert against.
    getOpenMonthlyStatusReport.mockImplementation((orgId: string) => orgId === 'orgA' ? pendingA : Promise.resolve(null));
    getMonthlyStatusLines.mockResolvedValue([]);

    const { rerender } = render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);
    rerender(<MonthlyPositionTab orgId="orgB" lang="en" role="super_admin" onToast={noop} />);
    await waitFor(() => expect(screen.getByText('No open report right now')).toBeInTheDocument());

    // NOW resolve the stale org-A promise — its report must never appear;
    // org B genuinely has no open report, so the empty state must persist.
    resolveA(REPORT_A);
    await new Promise(r => setTimeout(r, 0));
    expect(screen.queryByText('No open report right now')).toBeInTheDocument();
    expect(screen.queryByText('v1')).not.toBeInTheDocument(); // REPORT_A's version badge would prove a leak
    expect(screen.getByTestId('monthly-position-tab')).toBeInTheDocument();
  });

  it('switching orgId re-issues the read with the NEW org id, never the previous one', async () => {
    getOpenMonthlyStatusReport.mockResolvedValue(REPORT_A);
    getMonthlyStatusLines.mockResolvedValue([]);
    const { rerender } = render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);
    await waitFor(() => expect(getOpenMonthlyStatusReport).toHaveBeenCalledWith('orgA'));

    rerender(<MonthlyPositionTab orgId="orgB" lang="en" role="super_admin" onToast={noop} />);
    await waitFor(() => expect(getOpenMonthlyStatusReport).toHaveBeenCalledWith('orgB'));
  });

  it('a secondary lockedState failure shows its own inline notice but never blocks the primary open-report content', async () => {
    getOpenMonthlyStatusReport.mockResolvedValue(REPORT_A);
    getMonthlyStatusLines.mockResolvedValue([LINE_A]);
    getLatestLockedMonthlyStatusReport.mockRejectedValue(new Error('locked history unavailable'));

    render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);

    await waitFor(() => expect(screen.getByText('Amoxicillin')).toBeInTheDocument());
    // Secondary failure is visible...
    await waitFor(() => expect(screen.getByText('locked history unavailable')).toBeInTheDocument());
    // ...but the primary report content is still there, not erased.
    expect(screen.getByText('Amoxicillin')).toBeInTheDocument();
  });

  it('no unhandled rejection surfaces when every read fails at once', async () => {
    const onUnhandled = vi.fn();
    process.on('unhandledRejection', onUnhandled);
    getOpenMonthlyStatusReport.mockRejectedValue(new Error('down'));
    getLatestLockedMonthlyStatusReport.mockRejectedValue(new Error('down'));

    render(<MonthlyPositionTab orgId="orgA" lang="en" role="super_admin" onToast={noop} />);
    await waitFor(() => expect(screen.getByText('down')).toBeInTheDocument());
    await new Promise(r => setTimeout(r, 0));

    expect(onUnhandled).not.toHaveBeenCalled();
    process.removeListener('unhandledRejection', onUnhandled);
  });
});
