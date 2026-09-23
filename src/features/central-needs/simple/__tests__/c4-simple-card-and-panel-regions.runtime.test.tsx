/** @vitest-environment jsdom */
/**
 * C4 (X1) on the existing whole-column (M213) surfaces: a region-governed
 * column is read-only with a label and can never reach
 * `setBeneficiaryColumns`; the Simple one-click confirm is withheld for a
 * column an ACTIVE region or an unsaved workbook draft touches, or while
 * regions could not be read; every M213 decision is preceded by the X1 warning.
 */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BeneficiaryColumnSummary, BeneficiaryRegionVersion } from '../../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';
import type { RegionReadState, UnsavedDraftSources } from '../../regions/beneficiaryRegions';

const setBeneficiaryColumns = vi.fn();
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return { ...actual, setBeneficiaryColumns: (...a: unknown[]) => setBeneficiaryColumns(...a) };
});

const { SimpleInstitutionCard } = await import('../SimpleInstitutionCard');
const { CentralNeedsBeneficiaryColumnPanel } = await import('../../CentralNeedsBeneficiaryColumnPanel');
const { RegionWorkspaceProvider, useRegionWorkspace } = await import('../../regions/RegionWorkspace');
const { T } = await import('@/shared/i18n/strings');

afterEach(() => { cleanup(); setBeneficiaryColumns.mockReset(); });

const HOSPITAL = '00000000-0000-0000-0000-0000000000c1';
const ORGS = [
  { id: HOSPITAL, name: 'Al-Hillah Teaching Hospital', name_ar: 'مستشفى الحلة التعليمي', code: 'hillah', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const col = (over: Partial<BeneficiaryColumnSummary> = {}): BeneficiaryColumnSummary => ({
  importSessionId: 's1', originalFilename: 'need.xlsx', archiveEntryPath: null, sheetIndex: 0, sheetName: 'Sheet1',
  columnIndex: 4, sourceFieldName: 'Al-Hillah Teaching Hospital', numericValueCount: 5, zeroValueCount: 0,
  nonzeroNumericCount: 5, mappingId: null, decision: null, beneficiaryOrganizationId: null, mappingReason: null,
  mappedAt: null, mappedRowNumericCount: 5, reviewRequired: true, ...over,
});
const region = (over: Partial<BeneficiaryRegionVersion> = {}): BeneficiaryRegionVersion => ({
  versionId: 'v1', regionId: 'r1', versionNo: 1, supersedesVersionId: null, planRevisionId: 'rev-1', importSessionId: 's1',
  sheetIndex: 0, rowStart: 0, rowEnd: 1_048_575, columnStart: 4, columnEnd: 4, decision: 'beneficiary',
  beneficiaryOrganizationId: HOSPITAL, decisionReason: 'r', decidedBy: 'u', decidedAt: 't', ...over,
});

/** Publishes the given unsaved drafts into the provider, as the workbook layer does. */
function PublishDrafts({ drafts }: { drafts: UnsavedDraftSources | null }) {
  const ws = useRegionWorkspace();
  const setDrafts = ws?.setUnsavedDrafts;
  useEffect(() => { setDrafts?.(drafts); }, [setDrafts, drafts]);
  return null;
}

function renderCardIn(regions: RegionReadState | undefined, drafts: UnsavedDraftSources | null = null, column = col()) {
  return render(
    <RegionWorkspaceProvider regions={regions} canWrite sessions={[]} onChanged={() => {}}>
      <PublishDrafts drafts={drafts} />
      <SimpleInstitutionCard lang="en" planRevisionId="rev-1" editable column={column} activeCareInstitutions={ORGS} onResolved={() => {}} />
    </RegionWorkspaceProvider>,
  );
}
const oneClick = () => screen.queryByText(T.cn2b_simple_correct.en);

describe('C4 — the Simple institution card under X1', () => {
  it('with no region anywhere the card is unchanged: the one-click confirm is offered, after the X1 warning', () => {
    renderCardIn({ phase: 'ready', versions: [] });
    expect(oneClick()).toBeInTheDocument();
    expect(screen.getByTestId('cn4-simple-x1-warning')).toHaveTextContent(T.cn4_m213_keeps_column_out_of_regions.en);
  });

  it('a region-governed column is read-only with a label; no control can reach setBeneficiaryColumns', () => {
    renderCardIn({ phase: 'ready', versions: [region()] });
    expect(screen.getByTestId('cn4-simple-region-governed')).toHaveTextContent(T.cn4_region_governed_column.en);
    expect(oneClick()).toBeNull();
    for (const b of screen.queryAllByRole('button')) fireEvent.click(b);
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('an unsaved workbook draft over the column withholds only the one-click confirm; the explicit picker stays', () => {
    renderCardIn({ phase: 'ready', versions: [] }, { importSessionId: 's1', sheetIndex: 0, needs: [{ rowStart: 1, rowEnd: 9, columnStart: 3, columnEnd: 4 }] });
    expect(screen.getByTestId('cn4-simple-one-click-suppressed')).toBeInTheDocument();
    expect(oneClick()).toBeNull();
    expect(screen.getByText(T.cn2b_simple_choose_another_institution.en)).toBeInTheDocument();
  });

  it('a region layer that could not be read withholds the one-click confirm (fail closed)', () => {
    renderCardIn({ phase: 'unavailable', code: 'beneficiary_regions_read_inconsistent' });
    expect(oneClick()).toBeNull();
    expect(screen.getByTestId('cn4-simple-one-click-suppressed')).toBeInTheDocument();
  });

  it('a region on ANOTHER column or sheet changes nothing for this column', () => {
    renderCardIn({ phase: 'ready', versions: [region({ columnStart: 5, columnEnd: 6 }), region({ versionId: 'v2', sheetIndex: 1 })] });
    expect(oneClick()).toBeInTheDocument();
    expect(screen.queryByTestId('cn4-simple-region-governed')).toBeNull();
  });

  it('without a region context (older hosts) the card behaves exactly as before C4', () => {
    render(<SimpleInstitutionCard lang="en" planRevisionId="rev-1" editable column={col()} activeCareInstitutions={ORGS} onResolved={() => {}} />);
    expect(oneClick()).toBeInTheDocument();
    expect(screen.queryByTestId('cn4-simple-region-governed')).toBeNull();
  });
});

describe('C4 — the Advanced column panel under X1', () => {
  const panel = (regions: RegionReadState, columns: BeneficiaryColumnSummary[]) => render(
    <CentralNeedsBeneficiaryColumnPanel lang="en" planRevisionId="rev-1" editable columns={columns}
      activeCareInstitutions={ORGS} onChanged={() => {}} beneficiaryRegions={regions} />,
  );

  it('a region-governed column is labelled and offers no decision control; other columns keep theirs', () => {
    panel({ phase: 'ready', versions: [region()] }, [col({ columnIndex: 4 }), col({ columnIndex: 7 })]);
    const rows = screen.getAllByTestId('cn2b-bc-row');
    const governed = rows.find((r) => r.getAttribute('data-region-governed') === 'true')!;
    expect(within(governed).getByTestId('cn4-bc-region-governed')).toBeInTheDocument();
    expect(within(governed).queryByRole('combobox')).toBeNull();
    const other = rows.find((r) => r !== governed)!;
    expect(within(other).getByRole('combobox')).toBeInTheDocument();
    expect(screen.getByTestId('cn4-bc-x1-warning')).toBeInTheDocument();
  });

  it('a same-label group confirm never includes a region-governed sibling', () => {
    panel({ phase: 'ready', versions: [region({ columnStart: 4, columnEnd: 4 })] }, [
      col({ columnIndex: 4 }), col({ columnIndex: 7 }), col({ columnIndex: 8 }),
    ]);
    const rows = screen.getAllByTestId('cn2b-bc-row').filter((r) => r.getAttribute('data-region-governed') !== 'true');
    fireEvent.change(within(rows[0]).getByRole('combobox'), { target: { value: HOSPITAL } });
    const apply = screen.getByText(T.cn2b_beneficiary_column_apply_to_matching.en.replace('__N__', '2'));
    expect(apply).toBeInTheDocument();
  });

  it('when regions could not be read the panel says so', () => {
    panel({ phase: 'unavailable', code: 'beneficiary_regions_read_inconsistent' }, [col()]);
    expect(screen.getByTestId('cn4-bc-regions-unavailable')).toBeInTheDocument();
  });
});
