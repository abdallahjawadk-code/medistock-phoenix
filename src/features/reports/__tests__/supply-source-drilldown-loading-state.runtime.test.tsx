/**
 * @vitest-environment jsdom
 *
 * POST-UAT DEFECT REPAIR — src/features/reports/DecisionIntelligenceReportsScreen.tsx
 * Defect: PHX-DEFECT-2026-09-02-SUPPLY-SOURCE-DRILLDOWN-LOADING-STATE-UNREACHABLE
 * (UAT evidence artifact 625; ledger control :636:state#1).
 *
 * SupplySourceDrilldown's `detail` is
 * `useAsync(() => (open ? getSupplySourcesDetail(orgId, bucket.key) :
 * Promise.resolve<SupplySourceDetailRow[]>([])), [orgId, bucket.key, open])`.
 * While the bucket is CLOSED, that loader still ran (a real dependency-array
 * entry, never skipped) and resolved to `[]`, committing `detail.data = []`
 * before the user ever opened it. useAsync (shared/lib/useAsync.ts) never
 * resets `data` back to null when a new fetch starts -- only loading/error
 * reset -- so the instant `open` flipped true and the REAL fetch began,
 * `detail.data` was still the truthy `[]` left over from the closed-state
 * placeholder. The loading guard was `detail.loading && !detail.data`, and
 * `![]` is `false` (an empty array is truthy), so the loading branch could
 * never render; the empty-state guard fired instead, immediately showing "No
 * official reports yet" while the real request was still in flight.
 *
 * Fix: the closed-state loader now returns a promise that never settles,
 * instead of one that resolves to a fake empty array. This is a local
 * repair, entirely inside SupplySourceDrilldown -- useAsync (shared by 56
 * other call sites) and every one of its OTHER real render branches
 * (error/empty/populated) are unchanged.
 *
 * Real React render + real fireEvent against the REAL, unmocked
 * ExecutiveOverviewTab (separately exported from this file) and its real
 * useAsync/SupplySourceDrilldown logic. Only decision-intelligence.service is
 * mocked (the two functions ExecutiveOverviewTab itself actually calls).
 */
import '@testing-library/jest-dom/vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ExecutiveOverviewTab } from '../DecisionIntelligenceReportsScreen';
import type { ExecutiveOverview, SupplySourceDetailRow } from '../decision-intelligence.service';

const getExecutiveOverview = vi.fn();
const getSupplySourcesDetail = vi.fn();
vi.mock('../decision-intelligence.service', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../decision-intelligence.service')>()),
  getExecutiveOverview: (...a: unknown[]) => getExecutiveOverview(...a),
  getSupplySourcesDetail: (...a: unknown[]) => getSupplySourcesDetail(...a),
}));

afterEach(() => { cleanup(); vi.clearAllMocks(); });

const overview: ExecutiveOverview = {
  organization_id: 'org-1', as_of: '2026-01-01T00:00:00Z', materials_tracked: 42,
  classification_counts: { available: 30, low_stock: 5, missing: 2, surplus: 3, near_expiry: 1, expired: 1 },
  supply_source_totals: {
    warehouse: { kimadia: 10, aid: 2, purchase_central: 1, purchase_supplementary: 0, unclassified: 0 },
    outlet: { kimadia: 5, aid: 1, purchase_central: 0, purchase_supplementary: 2, unclassified: 0 },
  },
};

const LOT: SupplySourceDetailRow = {
  source_table: 'warehouse_stock', lot_id: 'lot-1', location_kind: 'warehouse', location_id: 'wh-1',
  location_name: 'Central', location_name_ar: 'المركزي', scientific_name: 'Synthetic Amoxicillin A',
  trade_name: null, batch_number: 'LOT-9', expiry_date: '2027-01-01', on_hand_quantity: 10, supply_bucket: 'kimadia',
};

async function renderAndFindToggle(key: string) {
  render(<ExecutiveOverviewTab orgId="org-1" lang="en" onToast={vi.fn()} onMobilePrint={vi.fn()} />);
  await screen.findByTestId('executive-overview-tab');
  return screen.getByTestId(`dir-supply-bucket-${key}`);
}

describe('SupplySourceDrilldown · real loading state on first open (:636:state#1)', () => {
  it('shows a real, accessible loading indicator while the real fetch is pending, not the empty state', async () => {
    getExecutiveOverview.mockResolvedValue(overview);
    let release!: (v: SupplySourceDetailRow[]) => void;
    getSupplySourcesDetail.mockImplementation((_orgId: string, key: string) =>
      key === 'kimadia' ? new Promise<SupplySourceDetailRow[]>(res => { release = res; }) : Promise.resolve([]));

    const bucketToggle = await renderAndFindToggle('kimadia');
    fireEvent.click(within(bucketToggle).getByRole('button'));

    // ACCESSIBILITY: a real, assistive-technology-visible status role, not
    // just a visual spinner div.
    expect(within(bucketToggle).getByRole('status')).toBeInTheDocument();
    expect(within(bucketToggle).queryByText('No official reports yet')).not.toBeInTheDocument();
    expect(within(bucketToggle).queryByRole('alert')).not.toBeInTheDocument();

    await act(async () => { release([]); });
  });

  it('stale placeholder data cannot suppress the loading state on a second, independent bucket', async () => {
    // Every bucket runs its OWN SupplySourceDrilldown instance with its own
    // useAsync -- opening one must never affect another's placeholder state.
    getExecutiveOverview.mockResolvedValue(overview);
    let releaseAid!: (v: SupplySourceDetailRow[]) => void;
    getSupplySourcesDetail.mockImplementation((_orgId: string, key: string) => {
      if (key === 'kimadia') return Promise.resolve([]);
      if (key === 'aid') return new Promise<SupplySourceDetailRow[]>(res => { releaseAid = res; });
      return Promise.resolve([]);
    });

    render(<ExecutiveOverviewTab orgId="org-1" lang="en" onToast={vi.fn()} onMobilePrint={vi.fn()} />);
    await screen.findByTestId('executive-overview-tab');

    const kimadiaToggle = screen.getByTestId('dir-supply-bucket-kimadia');
    const aidToggle = screen.getByTestId('dir-supply-bucket-aid');
    fireEvent.click(within(kimadiaToggle).getByRole('button'));
    await within(kimadiaToggle).findByText('No official reports yet'); // kimadia's own real empty result

    fireEvent.click(within(aidToggle).getByRole('button'));
    // The unrelated 'aid' bucket is unaffected by kimadia's already-settled
    // state and shows its own real, independent loading indicator.
    expect(within(aidToggle).getByRole('status')).toBeInTheDocument();
    expect(within(aidToggle).queryByText('No official reports yet')).not.toBeInTheDocument();

    await act(async () => { releaseAid([]); });
  });
});

describe('SupplySourceDrilldown · resolved data renders correctly', () => {
  it('a genuinely empty result shows the real empty state once the real fetch settles', async () => {
    getExecutiveOverview.mockResolvedValue(overview);
    getSupplySourcesDetail.mockResolvedValue([]);
    const bucketToggle = await renderAndFindToggle('kimadia');
    fireEvent.click(within(bucketToggle).getByRole('button'));

    expect(await within(bucketToggle).findByText('No official reports yet')).toBeInTheDocument();
    expect(within(bucketToggle).queryByRole('status')).not.toBeInTheDocument();
  });

  it('a populated result renders the real table and a real Export Excel button', async () => {
    getExecutiveOverview.mockResolvedValue(overview);
    getSupplySourcesDetail.mockResolvedValue([LOT]);
    const bucketToggle = await renderAndFindToggle('kimadia');
    fireEvent.click(within(bucketToggle).getByRole('button'));

    expect(await within(bucketToggle).findByText('Synthetic Amoxicillin A')).toBeInTheDocument();
    expect(within(bucketToggle).getByRole('button', { name: 'Export Excel' })).toBeInTheDocument();
    expect(within(bucketToggle).queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('SupplySourceDrilldown · rejected requests render the real error/retry state', () => {
  it('a rejected fetch shows a real alert with a working retry, and retry re-fetches', async () => {
    getExecutiveOverview.mockResolvedValue(overview);
    getSupplySourcesDetail.mockRejectedValueOnce(new Error('boom'));
    const bucketToggle = await renderAndFindToggle('kimadia');
    fireEvent.click(within(bucketToggle).getByRole('button'));

    const alert = await within(bucketToggle).findByRole('alert');
    expect(alert).toBeInTheDocument();
    expect(within(bucketToggle).queryByRole('status')).not.toBeInTheDocument();

    getSupplySourcesDetail.mockResolvedValueOnce([LOT]);
    fireEvent.click(within(bucketToggle).getByRole('button', { name: /retry|Retry/i }));
    expect(await within(bucketToggle).findByText('Synthetic Amoxicillin A')).toBeInTheDocument();
  });
});

describe('SupplySourceDrilldown · close/reopen does not leak stale state', () => {
  it('closing hides the panel; reopening keeps showing the last REAL result while it silently revalidates, then swaps to the fresh one', async () => {
    // This is the pre-existing, intentional stale-while-revalidating contract
    // useAsync gives every caller (never resetting `data` mid-reload) -- the
    // repair must not disturb it. It is deliberately DIFFERENT from the very
    // first open (covered above), where there was never any real data to
    // stay stale with -- only a fake placeholder the repair now avoids ever
    // committing.
    getExecutiveOverview.mockResolvedValue(overview);
    getSupplySourcesDetail.mockResolvedValueOnce([LOT]);
    const bucketToggle = await renderAndFindToggle('kimadia');
    const toggleBtn = within(bucketToggle).getByRole('button');

    fireEvent.click(toggleBtn); // open -> real data
    await within(bucketToggle).findByText('Synthetic Amoxicillin A');
    fireEvent.click(toggleBtn); // close -- the whole panel unmounts, not just the data
    expect(within(bucketToggle).queryByText('Synthetic Amoxicillin A')).not.toBeInTheDocument();
    expect(within(bucketToggle).queryByRole('status')).not.toBeInTheDocument();

    let releaseSecond!: (v: SupplySourceDetailRow[]) => void;
    getSupplySourcesDetail.mockImplementationOnce(() => new Promise<SupplySourceDetailRow[]>(res => { releaseSecond = res; }));
    fireEvent.click(toggleBtn); // reopen -- a fresh real fetch starts, genuinely pending
    // The prior REAL result reappears immediately (stale-while-revalidating);
    // no loading spinner competes with it, and no "no results" flash appears
    // either -- both would misrepresent what is genuinely known right now.
    expect(within(bucketToggle).getByText('Synthetic Amoxicillin A')).toBeInTheDocument();
    expect(within(bucketToggle).queryByRole('status')).not.toBeInTheDocument();
    expect(within(bucketToggle).queryByText('No official reports yet')).not.toBeInTheDocument();

    await act(async () => { releaseSecond([]); }); // this reopen's real result: genuinely empty this time
    expect(await within(bucketToggle).findByText('No official reports yet')).toBeInTheDocument();
    expect(within(bucketToggle).queryByText('Synthetic Amoxicillin A')).not.toBeInTheDocument();
  });
});
