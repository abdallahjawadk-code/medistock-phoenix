/**
 * @vitest-environment jsdom
 *
 * PHOENIX-DEMO-ORGANIZATION-WATERMARK-145 / PHASE-C1-REPORT-INTEGRITY —
 * genuine component/runtime proof that the Official Report Library visibly
 * watermarks reports derived from a PHOENIX_DEMO_V1 organization, shows no
 * such watermark for an ordinary (official) organization, and — the C1 fix —
 * shows a distinct, non-alarming "Unverified" notice when the demo/official
 * check itself fails or returns something malformed, rather than silently
 * looking exactly like an ordinary official organization.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ReportLibraryTab } from '../DecisionIntelligenceReportsScreen';
import type { ReportSnapshotRow, OrganizationDataMode } from '../decision-intelligence.service';

const listReportSnapshots = vi.fn<() => Promise<ReportSnapshotRow[]>>();
const getOrganizationDataMode = vi.fn<() => Promise<OrganizationDataMode>>();
vi.mock('../decision-intelligence.service', async () => {
  const actual = await vi.importActual('../decision-intelligence.service');
  return {
    ...actual,
    listReportSnapshots: () => listReportSnapshots(),
    getOrganizationDataMode: () => getOrganizationDataMode(),
  };
});

const SNAPSHOT: ReportSnapshotRow = {
  id: 's1', organization_id: 'org-1', report_type: 'executive_overview',
  official_number: 'EO-2026-000001', filters: {}, reporting_period: null,
  source_as_of: '2026-07-20T00:00:00Z',
  payload: {
    organization_id: 'org-1', as_of: '2026-07-20T00:00:00Z', materials_tracked: 10,
    classification_counts: {}, supply_source_totals: { warehouse: {}, outlet: {} },
  },
  qr_payload: 'https://example.test/qr/s1',
  created_by: 'u1', created_by_role: 'super_admin', created_by_name: 'Admin',
  created_at: '2026-07-20T00:00:00Z',
};

describe('ReportLibraryTab — demo/official/unverified organization state (runtime, not source-scan)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the demo watermark banner and per-report badge when the organization data mode resolves to demo', async () => {
    listReportSnapshots.mockResolvedValue([SNAPSHOT]);
    getOrganizationDataMode.mockResolvedValue({ status: 'demo' });

    render(<ReportLibraryTab orgId="org-1" lang="en" />);

    await waitFor(() => expect(screen.getByTestId('dir-report-library')).toBeInTheDocument());
    expect(screen.getByTestId('dir-report-library-demo-watermark')).toBeInTheDocument();
    expect(screen.getAllByText('DEMO — UNOFFICIAL').length).toBeGreaterThanOrEqual(2); // banner + per-card badge
    expect(screen.queryByTestId('dir-report-library-unverified-notice')).not.toBeInTheDocument();
  });

  it('shows NO demo watermark and NO unverified notice for an ordinary (official) organization', async () => {
    listReportSnapshots.mockResolvedValue([SNAPSHOT]);
    getOrganizationDataMode.mockResolvedValue({ status: 'official' });

    render(<ReportLibraryTab orgId="org-1" lang="en" />);

    await waitFor(() => expect(screen.getByTestId('dir-report-library')).toBeInTheDocument());
    expect(screen.queryByTestId('dir-report-library-demo-watermark')).not.toBeInTheDocument();
    expect(screen.queryByText('DEMO — UNOFFICIAL')).not.toBeInTheDocument();
    expect(screen.queryByTestId('dir-report-library-unverified-notice')).not.toBeInTheDocument();
    expect(screen.queryByText('Unverified')).not.toBeInTheDocument();
  });

  it('PHASE-C1 fix: a failed demo/official check shows a distinct Unverified notice — never silently looks Official', async () => {
    listReportSnapshots.mockResolvedValue([SNAPSHOT]);
    getOrganizationDataMode.mockResolvedValue({ status: 'unverified', error: new Error('network error') });

    render(<ReportLibraryTab orgId="org-1" lang="en" />);

    await waitFor(() => expect(screen.getByTestId('dir-report-library')).toBeInTheDocument());
    // The library itself still renders its real content — a secondary
    // demo-state failure never blocks the primary snapshot list.
    expect(screen.getByText('EO-2026-000001')).toBeInTheDocument();
    // But the state is visibly "Unverified", not silently "Official"
    // (no demo watermark, but a distinct notice instead of nothing).
    expect(screen.queryByTestId('dir-report-library-demo-watermark')).not.toBeInTheDocument();
    expect(screen.queryByText('DEMO — UNOFFICIAL')).not.toBeInTheDocument();
    expect(screen.getByTestId('dir-report-library-unverified-notice')).toBeInTheDocument();
    expect(screen.getAllByText('Unverified').length).toBeGreaterThanOrEqual(2); // banner + per-card badge
  });

  it('a malformed/unexpected demo-check response (not literally unverified from the service) is also NOT treated as official', async () => {
    listReportSnapshots.mockResolvedValue([SNAPSHOT]);
    // Simulates the hook-level catch path (getOrganizationDataMode itself
    // never throws, but a consumer must still stay safe if something above
    // it does) — reload never resolves to a real status.
    getOrganizationDataMode.mockRejectedValue(new Error('unexpected'));

    render(<ReportLibraryTab orgId="org-1" lang="en" />);

    await waitFor(() => expect(screen.getByTestId('dir-report-library')).toBeInTheDocument());
    expect(screen.queryByTestId('dir-report-library-demo-watermark')).not.toBeInTheDocument();
    expect(screen.getByTestId('dir-report-library-unverified-notice')).toBeInTheDocument();
  });

  it('Retry on the Unverified notice re-issues the same demo/official check', async () => {
    listReportSnapshots.mockResolvedValue([SNAPSHOT]);
    getOrganizationDataMode.mockResolvedValue({ status: 'unverified' });

    render(<ReportLibraryTab orgId="org-1" lang="en" />);
    await waitFor(() => expect(screen.getByTestId('dir-report-library-unverified-notice')).toBeInTheDocument());

    getOrganizationDataMode.mockClear();
    getOrganizationDataMode.mockResolvedValue({ status: 'official' });
    screen.getByRole('button', { name: 'Retry' }).click();

    await waitFor(() => expect(screen.queryByTestId('dir-report-library-unverified-notice')).not.toBeInTheDocument());
    expect(getOrganizationDataMode).toHaveBeenCalledTimes(1);
  });
});
