/**
 * @vitest-environment jsdom
 *
 * PHOENIX-DEMO-ORGANIZATION-WATERMARK-145 — genuine component/runtime proof
 * that the Official Report Library visibly watermarks reports derived from
 * a PHOENIX_DEMO_V1 organization ("تجريبي — غير رسمي" / "DEMO — UNOFFICIAL"),
 * and shows no such watermark for an ordinary organization.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import { ReportLibraryTab } from '../DecisionIntelligenceReportsScreen';
import type { ReportSnapshotRow } from '../decision-intelligence.service';

const listReportSnapshots = vi.fn<() => Promise<ReportSnapshotRow[]>>();
const isDemoOrganization = vi.fn<() => Promise<boolean>>();
vi.mock('../decision-intelligence.service', async () => {
  const actual = await vi.importActual('../decision-intelligence.service');
  return {
    ...actual,
    listReportSnapshots: () => listReportSnapshots(),
    isDemoOrganization: () => isDemoOrganization(),
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

describe('ReportLibraryTab — demo/official watermark (runtime, not source-scan)', () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(cleanup);

  it('shows the demo watermark banner and per-report badge when the organization is demo-flagged', async () => {
    listReportSnapshots.mockResolvedValue([SNAPSHOT]);
    isDemoOrganization.mockResolvedValue(true);

    render(<ReportLibraryTab orgId="org-1" lang="en" />);

    await waitFor(() => expect(screen.getByTestId('dir-report-library')).toBeInTheDocument());
    expect(screen.getByTestId('dir-report-library-demo-watermark')).toBeInTheDocument();
    expect(screen.getAllByText('DEMO — UNOFFICIAL').length).toBeGreaterThanOrEqual(2); // banner + per-card badge
  });

  it('shows NO demo watermark for an ordinary (non-demo) organization', async () => {
    listReportSnapshots.mockResolvedValue([SNAPSHOT]);
    isDemoOrganization.mockResolvedValue(false);

    render(<ReportLibraryTab orgId="org-1" lang="en" />);

    await waitFor(() => expect(screen.getByTestId('dir-report-library')).toBeInTheDocument());
    expect(screen.queryByTestId('dir-report-library-demo-watermark')).not.toBeInTheDocument();
    expect(screen.queryByText('DEMO — UNOFFICIAL')).not.toBeInTheDocument();
  });

  it('fails closed to no watermark if the demo-status check errors (never crashes the library)', async () => {
    listReportSnapshots.mockResolvedValue([SNAPSHOT]);
    isDemoOrganization.mockRejectedValue(new Error('network error'));

    render(<ReportLibraryTab orgId="org-1" lang="en" />);

    await waitFor(() => expect(screen.getByTestId('dir-report-library')).toBeInTheDocument());
    expect(screen.queryByTestId('dir-report-library-demo-watermark')).not.toBeInTheDocument();
    expect(screen.getByText('EO-2026-000001')).toBeInTheDocument();
  });
});
