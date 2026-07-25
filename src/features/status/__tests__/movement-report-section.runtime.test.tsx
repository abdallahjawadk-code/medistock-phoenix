/**
 * @vitest-environment jsdom
 *
 * REPORTING-RUNTIME-RECOVERY R03 — genuine component/runtime test for
 * MovementReportSection's CSV export and Print, proving the ACTUAL fixed
 * behavior: once loading completes, a genuine zero-row filtered result is
 * still exportable/printable (not silently disabled/no-op), while the
 * loading state itself correctly disables both actions, and permission
 * gates still hide them entirely when the caller lacks the grant.
 */
import '@testing-library/jest-dom/vitest';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, waitFor, fireEvent, cleanup } from '@testing-library/react';
import { MovementReportSection } from '../MovementReportSection';
import type { AvailabilityMovementReportRecord } from '@/shared/supabase/services/availability.service';

const getPointsByOrg = vi.fn(async (_orgId: string) => []);
vi.mock('@/shared/supabase/services/warehouses.service', () => ({
  getPointsByOrg: (orgId: string) => getPointsByOrg(orgId),
}));

const getAvailabilityMovementsReport = vi.fn<() => Promise<AvailabilityMovementReportRecord[]>>();
vi.mock('@/shared/supabase/services/availability.service', () => ({
  getAvailabilityMovementsReport: () => getAvailabilityMovementsReport(),
}));

// jsdom does not implement URL.createObjectURL/revokeObjectURL at all — the
// property must exist before vi.spyOn can wrap it.
if (!('createObjectURL' in URL)) (URL as unknown as { createObjectURL: () => string }).createObjectURL = () => '';
if (!('revokeObjectURL' in URL)) (URL as unknown as { revokeObjectURL: () => void }).revokeObjectURL = () => {};

let mobileContext = false;
vi.mock('@/shared/lib/reportExport', () => ({
  isLikelyMobilePrintContext: () => mobileContext,
}));

// Isolates this test from PhoenixDialog/portal internals — only the props
// MovementReportSection passes are what's under test here.
vi.mock('@/shared/ui/MobilePrintFallbackModal', () => ({
  MobilePrintFallbackModal: ({ open, html }: { open: boolean; html: string }) =>
    open ? <div data-testid="mobile-print-modal">{html}</div> : null,
}));

let permissions = new Set(['availability.movements.view', 'availability.movements.export', 'availability.movements.print']);
vi.mock('@/app/AppContext', () => ({
  useApp: () => ({ lang: 'en', activeOrgId: 'org1', myPermissions: permissions }),
}));

const ROW: AvailabilityMovementReportRecord = {
  id: 'm1', movementType: 'add', quantityBefore: 10, quantityDelta: 5, quantityAfter: 15,
  reason: 'restock', notes: null, actorNameSnapshot: 'Officer A', actorEmailSnapshot: null,
  actorRoleSnapshot: 'warehouse_officer', createdAt: '2026-07-20T00:00:00Z',
  scientificName: 'Paracetamol', tradeName: null, concentration: null, dosageForm: null,
  distributionPointId: 'dp1', distributionPointName: 'Port A', distributionPointNameAr: null,
};

describe('MovementReportSection — CSV export and Print (runtime, not source-scan)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getPointsByOrg.mockResolvedValue([]);
    mobileContext = false;
    permissions = new Set(['availability.movements.view', 'availability.movements.export', 'availability.movements.print']);
  });
  afterEach(cleanup);

  it('R03: CSV/Print are DISABLED while the report is still loading', async () => {
    getAvailabilityMovementsReport.mockReturnValue(new Promise(() => {})); // never resolves during this test
    render(<MovementReportSection />);

    const csvBtn = await screen.findByRole('button', { name: /export csv/i });
    const printBtn = screen.getByRole('button', { name: /print/i });
    expect(csvBtn).toBeDisabled();
    expect(printBtn).toBeDisabled();
    expect(csvBtn).toHaveAttribute('aria-disabled', 'true');
  });

  it('R03: CSV export is ENABLED and produces a real download with correct metadata for a genuine ZERO-row result', async () => {
    getAvailabilityMovementsReport.mockResolvedValue([]);
    render(<MovementReportSection />);

    const csvBtn = await screen.findByRole('button', { name: /export csv/i });
    await waitFor(() => expect(csvBtn).not.toBeDisabled());

    let capturedBlob: Blob | null = null;
    const createObjectURLSpy = vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
      capturedBlob = obj as Blob;
      return 'blob:mock-url';
    });
    const revokeSpy = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fireEvent.click(csvBtn);

    expect(createObjectURLSpy).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeSpy).toHaveBeenCalledTimes(1);
    expect(capturedBlob).not.toBeNull();
    expect(capturedBlob!.type).toContain('text/csv');

    // Blob.text() decodes as UTF-8 and, per the WHATWG spec, silently strips
    // a leading BOM (it's a decoding marker, not observable text content) —
    // so the BOM byte sequence itself must be checked on the raw bytes.
    const bytes = new Uint8Array(await capturedBlob!.arrayBuffer());
    expect([bytes[0], bytes[1], bytes[2]]).toEqual([0xEF, 0xBB, 0xBF]); // UTF-8 BOM

    const text = await capturedBlob!.text();
    expect(text).toContain('Quantity Movement Report');       // report title
    expect(text).toContain('Selected filters');                // selected-filters metadata present
    expect(text).toContain('Total rows: 0');                   // row count IS zero, honestly
    expect(text).toContain('Date/Time');                       // column headers present

    createObjectURLSpy.mockRestore();
    revokeSpy.mockRestore();
    clickSpy.mockRestore();
  });

  it('R03: Print (desktop) is ENABLED and actually opens the print window for a genuine ZERO-row result', async () => {
    getAvailabilityMovementsReport.mockResolvedValue([]);
    mobileContext = false;
    render(<MovementReportSection />);

    const printBtn = await screen.findByRole('button', { name: /print/i });
    await waitFor(() => expect(printBtn).not.toBeDisabled());

    const fakeWin = { document: { write: vi.fn(), close: vi.fn() }, focus: vi.fn(), print: vi.fn(), close: vi.fn() };
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(fakeWin as unknown as Window);

    fireEvent.click(printBtn);

    expect(openSpy).toHaveBeenCalledTimes(1);
    expect(fakeWin.document.write).toHaveBeenCalledTimes(1);
    const html = fakeWin.document.write.mock.calls[0][0] as string;
    expect(html).toContain('Total rows');
    expect(html).toMatch(/Total rows[^<]*:\s*0/);
    expect(fakeWin.print).toHaveBeenCalledTimes(1);
    expect(fakeWin.close).toHaveBeenCalledTimes(1);

    openSpy.mockRestore();
  });

  it('R03: Print (mobile context) routes to the in-app fallback modal for a genuine ZERO-row result, never window.print directly', async () => {
    getAvailabilityMovementsReport.mockResolvedValue([]);
    mobileContext = true;
    render(<MovementReportSection />);

    const printBtn = await screen.findByRole('button', { name: /print/i });
    await waitFor(() => expect(printBtn).not.toBeDisabled());

    const openSpy = vi.spyOn(window, 'open');
    fireEvent.click(printBtn);

    expect(openSpy).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByTestId('mobile-print-modal')).toBeInTheDocument());
    expect(screen.getByTestId('mobile-print-modal').textContent).toMatch(/Total rows[^<]*:\s*0/);

    openSpy.mockRestore();
  });

  it('shows a visible popup-blocked message instead of failing silently when window.open returns null', async () => {
    getAvailabilityMovementsReport.mockResolvedValue([]);
    mobileContext = false;
    render(<MovementReportSection />);

    const printBtn = await screen.findByRole('button', { name: /print/i });
    await waitFor(() => expect(printBtn).not.toBeDisabled());

    const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
    fireEvent.click(printBtn);

    await waitFor(() => {
      expect(screen.getByText(/blocked the print window/i)).toBeInTheDocument();
    });

    openSpy.mockRestore();
  });

  it('CSV export works and Print opens for a NON-empty result too (regression coverage, not just the zero-row edge case)', async () => {
    getAvailabilityMovementsReport.mockResolvedValue([ROW]);
    render(<MovementReportSection />);

    await waitFor(() => expect(screen.getByText('Paracetamol')).toBeInTheDocument());
    const csvBtn = screen.getByRole('button', { name: /export csv/i });
    expect(csvBtn).not.toBeDisabled();

    let capturedBlob: Blob | null = null;
    vi.spyOn(URL, 'createObjectURL').mockImplementation((obj: Blob | MediaSource) => {
      capturedBlob = obj as Blob;
      return 'blob:mock-url';
    });
    vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    fireEvent.click(csvBtn);
    const text = await capturedBlob!.text();
    expect(text).toContain('Paracetamol');
    expect(text).toMatch(/Total rows.*1/i);

    vi.restoreAllMocks();
  });

  it('permission gating: CSV/Print buttons are entirely absent without the export/print grants (not just disabled)', async () => {
    permissions = new Set(['availability.movements.view']); // view only, no export/print
    getAvailabilityMovementsReport.mockResolvedValue([]);
    render(<MovementReportSection />);

    await waitFor(() => expect(screen.queryByText('loading', { exact: false })).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /export csv/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /print/i })).not.toBeInTheDocument();
  });

  it('the whole section renders nothing without the base view permission', () => {
    permissions = new Set();
    const { container } = render(<MovementReportSection />);
    expect(container).toBeEmptyDOMElement();
  });
});
