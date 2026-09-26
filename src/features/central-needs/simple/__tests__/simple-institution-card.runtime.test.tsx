/** @vitest-environment jsdom */
import '@testing-library/jest-dom/vitest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { BeneficiaryColumnSummary } from '../../central-needs.service';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';

const setBeneficiaryColumns = vi.fn();
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return { ...actual, setBeneficiaryColumns: (...a: unknown[]) => setBeneficiaryColumns(...a) };
});

const { SimpleInstitutionCard } = await import('../SimpleInstitutionCard');

afterEach(() => { cleanup(); setBeneficiaryColumns.mockReset(); });

const HOSPITAL_A = '00000000-0000-0000-0000-0000000000c1';
const HOSPITAL_B = '00000000-0000-0000-0000-0000000000c2';

const ORGS: OrgRow[] = [
  { id: HOSPITAL_A, name: 'Al-Hillah Teaching Hospital', name_ar: 'مستشفى الحلة التعليمي', code: 'hillah', status: 'active', organizationKind: 'care_institution' },
  { id: HOSPITAL_B, name: 'Marjan Hospital', name_ar: 'مستشفى مرجان', code: 'marjan', status: 'active', organizationKind: 'care_institution' },
] as unknown as OrgRow[];

const col = (over: Partial<BeneficiaryColumnSummary> = {}): BeneficiaryColumnSummary => ({
  importSessionId: 's1',
  originalFilename: 'need-2026.xls',
  archiveEntryPath: null,
  sheetIndex: 0,
  sheetName: 'Sheet1',
  columnIndex: 4,
  sourceFieldName: 'مستشفى الحلة التعليمي',
  numericValueCount: 5,
  zeroValueCount: 1,
  nonzeroNumericCount: 4,
  mappingId: null,
  decision: null,
  beneficiaryOrganizationId: null,
  mappingReason: null,
  mappedAt: null,
  mappedRowNumericCount: 5,
  reviewRequired: true,
  ...over,
});

function renderCard(over: Partial<Parameters<typeof SimpleInstitutionCard>[0]> = {}) {
  return render(
    <SimpleInstitutionCard
      lang="ar"
      planRevisionId="rev-1"
      editable
      column={col()}
      activeCareInstitutions={ORGS}
      onResolved={() => {}}
      {...over}
    />,
  );
}

describe('SimpleInstitutionCard — section 12 (checklist items 2, 3, 4, 6)', () => {
  it('never calls setBeneficiaryColumns on mount — a suggestion is shown, never auto-persisted (checklist item 3)', () => {
    renderCard();
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('shows the exact-match suggestion for [صحيح] and confirms it with the SAME payload shape Advanced Mode sends', async () => {
    renderCard();
    expect(screen.getByTestId('cn2b-simple-institution-suggestion')).toHaveTextContent('مستشفى الحلة التعليمي');
    fireEvent.click(screen.getByText('صحيح'));
    await Promise.resolve();
    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
    const call = setBeneficiaryColumns.mock.calls[0][0];
    expect(call.planRevisionId).toBe('rev-1');
    expect(call.mappings).toEqual([{
      importSessionId: 's1',
      sheetIndex: 0,
      columnIndex: 4,
      decision: 'beneficiary',
      beneficiaryOrganizationId: HOSPITAL_A,
      // stale-write protection payload — checklist item 6.
      previousDecision: null,
      previousBeneficiaryOrganizationId: null,
    }]);
  });

  it('an UNRESOLVED column’s first confirmation carries a non-empty default reason without the reviewer typing one', async () => {
    renderCard();
    fireEvent.click(screen.getByText('صحيح'));
    await Promise.resolve();
    const call = setBeneficiaryColumns.mock.calls[0][0];
    expect(typeof call.mappingReason).toBe('string');
    expect(call.mappingReason.trim().length).toBeGreaterThan(0);
  });

  it('a header matching NO registered institution gets no suggestion and says so — never a guess', () => {
    renderCard({ column: col({ sourceFieldName: 'مستشفى غير مسجل في البرنامج', columnIndex: 6 }) });
    expect(screen.queryByText('صحيح')).toBeNull();
    expect(screen.getByTestId('cn2b-simple-institution-no-suggestion'))
      .toHaveTextContent('لم نجد مؤسسة مطابقة تماماً');
    // The only way forward is an explicit human choice.
    expect(screen.getByText('اختيار المؤسسة')).toBeInTheDocument();
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('an exact match on the LATIN name is offered too, not only the Arabic one', () => {
    renderCard({ column: col({ sourceFieldName: 'Al-Hillah Teaching Hospital', columnIndex: 5 }) });
    expect(screen.getByTestId('cn2b-simple-institution-suggestion')).toHaveTextContent('مستشفى الحلة التعليمي');
  });

  it('ambiguous exact matches (>1) force an explicit choice — no [صحيح] shortcut is offered', () => {
    const dualMatchOrgs: OrgRow[] = [
      ...ORGS,
      { id: 'dup', name: 'Al-Hillah Teaching Hospital', name_ar: 'مستشفى الحلة التعليمي', code: 'dup', status: 'active', organizationKind: 'care_institution' } as unknown as OrgRow,
    ];
    render(
      <SimpleInstitutionCard
        lang="ar" planRevisionId="rev-1" editable column={col()} activeCareInstitutions={dualMatchOrgs} onResolved={() => {}}
      />,
    );
    expect(screen.queryByText('صحيح')).toBeNull();
    expect(screen.getByTestId('cn2b-simple-institution-no-suggestion')).toBeInTheDocument();
  });

  it('[ليست مؤسسة] requires a typed reason before the confirm control is enabled (invariant: no fuzzy/automatic NON_BENEFICIARY)', async () => {
    renderCard();
    fireEvent.click(screen.getByText('ليست مؤسسة'));
    const confirmButton = screen.getByText('تأكيد: ليست مؤسسة') as HTMLButtonElement;
    expect(confirmButton.disabled).toBe(true);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'عمود رقم تسلسلي وليس مؤسسة' } });
    expect((screen.getByText('تأكيد: ليست مؤسسة') as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByText('تأكيد: ليست مؤسسة'));
    await Promise.resolve();
    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
    const call = setBeneficiaryColumns.mock.calls[0][0];
    expect(call.mappings[0].decision).toBe('non_beneficiary');
    expect(call.mappings[0].beneficiaryOrganizationId).toBeNull();
    expect(call.mappingReason).toBe('عمود رقم تسلسلي وليس مؤسسة');
  });

  it('"choose another institution" sends the picked org, not the suggestion, when the reviewer overrides it', async () => {
    renderCard();
    fireEvent.click(screen.getByText('اختيار مؤسسة أخرى'));
    fireEvent.click(screen.getByText('مستشفى مرجان'));
    await Promise.resolve();
    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
    expect(setBeneficiaryColumns.mock.calls[0][0].mappings[0].beneficiaryOrganizationId).toBe(HOSPITAL_B);
  });
});

describe('SimpleInstitutionCard — permission parity (Director finding 2)', () => {
  it('editable=false renders NO control that could write: no confirm, no picker, no not-an-institution', () => {
    renderCard({ editable: false });
    expect(screen.queryByText('صحيح')).toBeNull();
    expect(screen.queryByText('اختيار مؤسسة أخرى')).toBeNull();
    expect(screen.queryByText('اختيار المؤسسة')).toBeNull();
    expect(screen.queryByText('ليست مؤسسة')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-institution-picker')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-institution-non-beneficiary-reason')).toBeNull();
    // There is no button at all in the read-only card, so nothing to click.
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('editable=false still shows the evidence and the read-only reason, so the reviewer is not left guessing', () => {
    renderCard({ editable: false });
    expect(screen.getByTestId('cn2b-simple-institution-evidence')).toHaveTextContent('مستشفى الحلة التعليمي');
    expect(screen.getByTestId('cn2b-simple-institution-read-only')).toBeInTheDocument();
  });

  it('editable=false never calls setBeneficiaryColumns — on mount or from any reachable interaction', async () => {
    renderCard({ editable: false });
    await Promise.resolve();
    for (const el of screen.queryAllByRole('button')) fireEvent.click(el);
    await Promise.resolve();
    expect(setBeneficiaryColumns).not.toHaveBeenCalled();
  });

  it('editable=true keeps the existing write path working — the gate narrows nothing else', async () => {
    renderCard({ editable: true });
    fireEvent.click(screen.getByText('صحيح'));
    await Promise.resolve();
    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
  });
});

describe('SimpleInstitutionCard — C5 §17 (UI-F3): a refused write reaches the screen', () => {
  it('reports a plan_revision_not_editable refusal to onRefused, and resolves nothing', async () => {
    const { centralNeedsErrorFromPostgrest } = await import('../../central-needs.service');
    setBeneficiaryColumns.mockRejectedValueOnce(centralNeedsErrorFromPostgrest({
      code: '23514', message: 'plan_revision_not_editable', details: 'revision=rev-1 status=submitted',
    }));
    const onRefused = vi.fn();
    const onResolved = vi.fn();
    renderCard({ onRefused, onResolved });
    fireEvent.click(screen.getByText('صحيح'));
    await vi.waitFor(() => expect(onRefused).toHaveBeenCalledTimes(1));
    expect(onRefused.mock.calls[0][0]).toMatchObject({ businessCode: 'plan_revision_not_editable' });
    expect(onResolved).not.toHaveBeenCalled();
    expect(setBeneficiaryColumns).toHaveBeenCalledTimes(1);
  });
});
