/** @vitest-environment jsdom */
/**
 * E2-C.8 — the Multi-Institution Mapping panel, in isolation.
 *
 * REAL: the E2-C panel, `useWorkbookMapping` (E2-B's hook + E2-C's hook on one
 * selection feed), both pure reducers and the E2-B panel beside it. The
 * trusted selections are produced by E2-A's own builders — exactly the objects
 * the stored source viewer reports. The full stored-source path is in
 * simple/__tests__/e2c-stored-institution-mapping.
 */
import '@testing-library/jest-dom/vitest';
import { useEffect } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import {
  buildCellSelection,
  buildColumnSelection,
  buildRangeSelection,
  type WorkbookSelection,
  type WorkbookSourceIdentity,
} from '../../excel-first/workbookSelection';
import { InstitutionMappingPanel, type BeneficiaryChoice } from '../InstitutionMappingPanel';
import { SheetMappingProfilePanel } from '../SheetMappingProfilePanel';
import { useWorkbookMapping } from '../useInstitutionMapping';

const SOURCE: WorkbookSourceIdentity = {
  batchId: 'batch-1', entryId: 'entry-1', entryOrdinal: 1, entrySha256: 'd'.repeat(64),
  importSessionId: 'session-1', workbookIndex: 0,
};
const SHEET = { sheetIndex: 0, sheetName: 'Needs 2027' };
const ORGS: BeneficiaryChoice[] = [
  { id: 'org-a', name: 'Al Amal Hospital', name_ar: 'مستشفى الأمل', code: 'HOSP-A' },
  { id: 'org-b', name: 'Al Noor Clinic', name_ar: 'مستوصف النور', code: 'CLIN-B' },
];

const column = (col: number, sheet = SHEET) => buildColumnSelection(SOURCE, sheet, col) as WorkbookSelection;
const cell = (row: number, col: number, merged: string | null = null) => buildCellSelection(SOURCE, SHEET, row, col, merged) as WorkbookSelection;
const range = (r0: number, c0: number, r1: number, c1: number) =>
  buildRangeSelection(SOURCE, SHEET, { row: r0, col: c0 }, { row: r1, col: c1 }) as WorkbookSelection;

/** Feeds a selection exactly as StoredWorkbookPanel's onSelectionChange would, to BOTH drafts. */
function Host({ lang, selection, beneficiaries = ORGS }: {
  lang: 'ar' | 'en';
  selection: WorkbookSelection | null;
  beneficiaries?: BeneficiaryChoice[];
}) {
  const mapping = useWorkbookMapping();
  const { observeSelection } = mapping;
  useEffect(() => { observeSelection(selection); }, [observeSelection, selection]);
  return (
    <>
      <SheetMappingProfilePanel lang={lang} state={mapping.sheet.state} onAssign={mapping.sheet.assign} onClear={mapping.sheet.clear} />
      <InstitutionMappingPanel lang={lang} controller={mapping.institutions} profile={mapping.sheet.state.profile} beneficiaries={beneficiaries} />
    </>
  );
}

afterEach(cleanup);

const panel = () => screen.getByTestId('cn2b-instmap-panel');
const byTest = (id: string) => within(panel()).getByTestId(id);
const queryTest = (id: string) => within(panel()).queryByTestId(id);
const captureAnchor = () => byTest('cn2b-instmap-capture-anchor');
const captureNeed = () => byTest('cn2b-instmap-capture-need');
const picker = () => byTest('cn2b-instmap-beneficiary') as HTMLSelectElement;
const commitButton = () => byTest('cn2b-instmap-commit');
const items = () => within(panel()).queryAllByTestId('cn2b-instmap-item');

type View = ReturnType<typeof render>;
const show = (view: View, selection: WorkbookSelection | null, lang: 'ar' | 'en' = 'en', beneficiaries = ORGS) =>
  view.rerender(<Host lang={lang} selection={selection} beneficiaries={beneficiaries} />);

/** The human's three explicit steps, then Add. */
function mapInstitution(view: View, anchor: WorkbookSelection, need: WorkbookSelection, orgId: string, lang: 'ar' | 'en' = 'en') {
  show(view, anchor, lang);
  fireEvent.click(captureAnchor());
  show(view, need, lang);
  fireEvent.click(captureNeed());
  fireEvent.change(picker(), { target: { value: orgId } });
  fireEvent.click(commitButton());
}

describe('E2-C.8 — without a trusted selection the panel is unavailable', () => {
  it('no editor, no mapping, and the human is told how to proceed', () => {
    render(<Host lang="en" selection={null} />);
    expect(panel()).toHaveAttribute('data-instmap-state', 'unavailable');
    expect(queryTest('cn2b-instmap-editor')).toBeNull();
    expect(byTest('cn2b-instmap-unavailable')).toHaveTextContent(/source identity is proven/);
    expect(byTest('cn2b-instmap-empty')).toHaveTextContent('No institution is mapped yet.');
    expect(within(panel()).queryAllByRole('button')).toHaveLength(0);
    expect(screen.queryByRole('alert')).toBeNull();
  });
});

describe('E2-C.9 — explicit human mapping, one part at a time', () => {
  it('name cell → Need column → chosen institution → Add', () => {
    const view = render(<Host lang="en" selection={cell(0, 2)} />);
    expect(panel()).toHaveAttribute('data-instmap-state', 'ready');
    expect(byTest('cn2b-instmap-selected')).toHaveTextContent('Cell C1');
    expect(captureAnchor()).toBeEnabled();
    expect(captureAnchor()).toHaveAccessibleName('Use cell C1 as the institution name cell');
    // A single cell cannot be a Need source; the reason is given and linked.
    expect(captureNeed()).toBeDisabled();
    expect(captureNeed()).toHaveAccessibleDescription(/A single cell cannot be a Need source/);
    fireEvent.click(captureAnchor());
    expect(byTest('cn2b-instmap-draft-anchor')).toHaveTextContent('Cell C1');
    expect(byTest('cn2b-instmap-status')).toHaveTextContent('The institution name cell is now cell C1.');

    show(view, column(2));
    expect(captureAnchor()).toBeDisabled();
    expect(byTest('cn2b-instmap-anchor-hint')).toHaveTextContent('A whole column cannot be an institution name cell');
    expect(captureNeed()).toHaveAccessibleName('Use column C for the Need quantities');
    fireEvent.click(captureNeed());
    expect(byTest('cn2b-instmap-draft-need')).toHaveTextContent('Column C');

    // Nothing is chosen for the human: Add waits for an explicit institution.
    expect(picker().value).toBe('');
    expect(commitButton()).toBeDisabled();
    expect(byTest('cn2b-instmap-incomplete')).toHaveTextContent('Set all three parts');
    fireEvent.change(picker(), { target: { value: 'org-a' } });
    expect(commitButton()).toBeEnabled();
    fireEvent.click(commitButton());

    expect(items()).toHaveLength(1);
    const [item] = items();
    expect(item).toHaveAttribute('data-beneficiary-id', 'org-a');
    expect(item).toHaveAttribute('data-valid', 'true');
    expect(within(item).getByTestId('cn2b-instmap-item-name')).toHaveTextContent('Al Amal Hospital');
    expect(within(item).getByTestId('cn2b-instmap-item-name')).toHaveTextContent('HOSP-A');
    expect(within(item).getByTestId('cn2b-instmap-item-anchor')).toHaveTextContent('Cell C1');
    expect(within(item).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('Column C');
    expect(within(item).getByTestId('cn2b-instmap-item-status')).toHaveTextContent('Mapping is valid');
    expect(byTest('cn2b-instmap-status')).toHaveTextContent('Al Amal Hospital is now mapped.');
    // The editor is empty again and holds focus, ready for the next institution.
    expect(picker().value).toBe('');
    expect(byTest('cn2b-instmap-draft-anchor')).toHaveTextContent('Not set yet');
    expect(document.activeElement).toBe(within(panel()).getByRole('heading', { name: 'New institution mapping' }));
  });

  it('the institution list offers exactly the trusted rows — never preselected, even with one option', () => {
    const one = [ORGS[0]];
    const view = render(<Host lang="en" selection={cell(0, 2)} beneficiaries={one} />);
    fireEvent.click(captureAnchor());
    show(view, column(2), 'en', one);
    fireEvent.click(captureNeed());
    expect(picker().value).toBe('');
    expect([...picker().options].map((o) => o.value)).toEqual(['', 'org-a']);
    expect(commitButton()).toBeDisabled();
  });

  it('with no trusted institutions, no mapping can be completed', () => {
    const view = render(<Host lang="en" selection={cell(0, 2)} beneficiaries={[]} />);
    fireEvent.click(captureAnchor());
    show(view, column(2), 'en', []);
    fireEvent.click(captureNeed());
    expect([...picker().options].map((o) => o.value)).toEqual(['']);
    expect(byTest('cn2b-instmap-no-beneficiaries')).toHaveTextContent('No active care institutions are available');
    expect(commitButton()).toBeDisabled();
  });

  it('several institutions on one sheet, each in its own column or range', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    mapInstitution(view, cell(20, 0), range(21, 3, 40, 3), 'org-b');
    expect(items().map((i) => i.getAttribute('data-beneficiary-id'))).toEqual(['org-a', 'org-b']);
    expect(within(items()[1]).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('Range D22:D41');
    expect(byTest('cn2b-instmap-list-title')).toHaveTextContent('Mapped institutions (2)');
    expect(items().every((i) => i.getAttribute('data-valid') === 'true')).toBe(true);
  });

  it('a rectangular Need range keeps all four coordinates; a merged name cell is shown as its anchor and block', () => {
    const view = render(<Host lang="en" selection={range(1, 2, 9, 4)} />);
    expect(captureNeed()).toBeEnabled();
    expect(captureNeed()).toHaveAccessibleName('Use range C2:E10 for the Need quantities');
    expect(queryTest('cn2b-instmap-need-hint')).toBeNull();
    fireEvent.click(captureNeed());
    expect(byTest('cn2b-instmap-draft-need')).toHaveTextContent('Range C2:E10');
    show(view, cell(0, 2, 'C1:E1'));
    expect(captureAnchor()).toHaveAccessibleName('Use cell C1 (merged C1:E1) as the institution name cell');
    fireEvent.click(captureAnchor());
    fireEvent.change(picker(), { target: { value: 'org-a' } });
    fireEvent.click(commitButton());
    expect(within(items()[0]).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('Range C2:E10');
    expect(items()[0]).toHaveAttribute('data-valid', 'true');
  });

  it('the same institution may hold several independent Need sources; an exact duplicate is refused', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2, 'C1:D1'), column(2), 'org-a');
    mapInstitution(view, cell(0, 2, 'C1:D1'), column(3), 'org-a');
    mapInstitution(view, cell(20, 0), range(21, 4, 40, 6), 'org-a');
    expect(items().map((i) => [i.getAttribute('data-beneficiary-id'), i.getAttribute('data-valid')])).toEqual([
      ['org-a', 'true'], ['org-a', 'true'], ['org-a', 'true'],
    ]);
    // The exact same declaration again.
    show(view, cell(0, 2, 'C1:D1'));
    fireEvent.click(captureAnchor());
    show(view, column(2));
    fireEvent.click(captureNeed());
    fireEvent.change(picker(), { target: { value: 'org-a' } });
    expect(byTest('cn2b-instmap-draft-problem')).toHaveTextContent('This exact mapping already exists.');
    fireEvent.click(commitButton());
    expect(screen.getByRole('alert')).toHaveTextContent('This exact mapping already exists. Nothing was changed.');
    expect(items()).toHaveLength(3);
  });

  it('a Need range crossing the Material column (E2-B) is refused', () => {
    const view = render(<Host lang="en" selection={column(1)} />);
    fireEvent.click(screen.getByTestId('cn2b-map-assign-material'));
    show(view, cell(0, 5));
    fireEvent.click(captureAnchor());
    show(view, range(1, 0, 9, 3));
    fireEvent.click(captureNeed());
    fireEvent.change(picker(), { target: { value: 'org-b' } });
    expect(byTest('cn2b-instmap-draft-problem')).toHaveTextContent('The Need source includes the Material column.');
    fireEvent.click(commitButton());
    expect(screen.getByRole('alert')).toHaveTextContent('The Need source includes the Material column. Nothing was changed.');
    expect(items()).toHaveLength(0);
  });

  it('a conflicting draft is flagged before Add, and Add is refused with nothing changed', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    show(view, cell(0, 3));
    fireEvent.click(captureAnchor());
    show(view, column(2));
    fireEvent.click(captureNeed());
    fireEvent.change(picker(), { target: { value: 'org-b' } });
    expect(byTest('cn2b-instmap-draft-problem')).toHaveTextContent('The Need source overlaps the Need source of Al Amal Hospital.');
    fireEvent.click(commitButton());
    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-testid', 'cn2b-instmap-alert');
    expect(alert).toHaveTextContent('The Need source overlaps the Need source of Al Amal Hospital. Nothing was changed.');
    expect(items()).toHaveLength(1);
  });

  it('the National Code column (E2-B) cannot be a Need source', () => {
    const view = render(<Host lang="en" selection={column(0)} />);
    fireEvent.click(screen.getByTestId('cn2b-map-assign-national_code'));
    show(view, cell(0, 3));
    fireEvent.click(captureAnchor());
    show(view, column(0));
    fireEvent.click(captureNeed());
    fireEvent.change(picker(), { target: { value: 'org-a' } });
    expect(byTest('cn2b-instmap-draft-problem')).toHaveTextContent('The Need source includes the National Code column.');
    fireEvent.click(commitButton());
    expect(screen.getByRole('alert')).toHaveTextContent('The Need source includes the National Code column. Nothing was changed.');
    expect(items()).toHaveLength(0);
  });

  it('a role E2-B assigns later is reported against the existing mapping, not silently accepted', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    show(view, column(2));
    fireEvent.click(screen.getByTestId('cn2b-map-assign-material'));
    const [item] = items();
    expect(item).toHaveAttribute('data-valid', 'false');
    const status = within(item).getByTestId('cn2b-instmap-item-status');
    expect(status).toHaveTextContent('Mapping needs attention');
    expect(within(status).getByText('The Need source includes the Material column.')).toHaveAttribute('data-reason', 'NEED_IS_MATERIAL_COLUMN');
  });
});

describe('E2-C.10 — edit, remove and safe reset', () => {
  it('edit loads the entry, Apply replaces it in place', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    mapInstitution(view, cell(0, 3), column(3), 'org-b');
    const edit = byTest('cn2b-instmap-edit-im-1');
    expect(edit).toHaveAccessibleName('Edit the mapping for Al Amal Hospital');
    fireEvent.click(edit);
    expect(byTest('cn2b-instmap-editor')).toHaveAttribute('data-mode', 'edit');
    expect(document.activeElement).toBe(within(panel()).getByRole('heading', { name: 'Edit institution mapping' }));
    expect(picker().value).toBe('org-a');
    expect(byTest('cn2b-instmap-draft-need')).toHaveTextContent('Column C');
    expect(items()[0]).toHaveAttribute('data-editing', 'true');

    show(view, column(5));
    fireEvent.click(captureNeed());
    fireEvent.click(byTest('cn2b-instmap-commit'));
    expect(byTest('cn2b-instmap-commit')).toHaveTextContent('Add mapping');
    expect(items().map((i) => i.getAttribute('data-mapping-id'))).toEqual(['im-1', 'im-2']);
    expect(within(items()[0]).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('Column F');
    expect(byTest('cn2b-instmap-status')).toHaveTextContent('The mapping for Al Amal Hospital is updated.');
  });

  it('cancel editing changes nothing', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    fireEvent.click(byTest('cn2b-instmap-edit-im-1'));
    show(view, column(6));
    fireEvent.click(captureNeed());
    fireEvent.click(byTest('cn2b-instmap-cancel'));
    expect(within(items()[0]).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('Column C');
    expect(byTest('cn2b-instmap-status')).toHaveTextContent('The choices were cleared; no mapping was changed.');
  });

  it('remove takes out exactly one entry and keeps focus in the list', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    mapInstitution(view, cell(0, 3), column(3), 'org-b');
    const remove = byTest('cn2b-instmap-remove-im-1');
    expect(remove).toHaveAccessibleName('Remove the mapping for Al Amal Hospital');
    fireEvent.click(remove);
    expect(items().map((i) => i.getAttribute('data-beneficiary-id'))).toEqual(['org-b']);
    expect(byTest('cn2b-instmap-status')).toHaveTextContent('The mapping for Al Amal Hospital is removed.');
    expect(document.activeElement).toBe(byTest('cn2b-instmap-list-title'));
  });

  it('reset asks first; "Keep them" keeps everything; confirming clears E2-C only', () => {
    const view = render(<Host lang="en" selection={column(0)} />);
    fireEvent.click(screen.getByTestId('cn2b-map-assign-national_code'));
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    mapInstitution(view, cell(0, 3), column(3), 'org-b');

    fireEvent.click(byTest('cn2b-instmap-reset'));
    const confirm = byTest('cn2b-instmap-reset-confirm');
    expect(confirm).toHaveAccessibleName(/Remove all 2 institution mappings from this draft\?/);
    expect(document.activeElement).toBe(byTest('cn2b-instmap-reset-keep'));
    fireEvent.click(byTest('cn2b-instmap-reset-keep'));
    expect(items()).toHaveLength(2);
    expect(document.activeElement).toBe(byTest('cn2b-instmap-reset'));

    fireEvent.click(byTest('cn2b-instmap-reset'));
    fireEvent.click(byTest('cn2b-instmap-reset-yes'));
    expect(items()).toHaveLength(0);
    expect(byTest('cn2b-instmap-status')).toHaveTextContent('All 2 institution mappings were removed from the draft.');
    expect(document.activeElement).toBe(within(panel()).getByRole('heading', { name: 'Institution Need mapping' }));
    // E2-B's declaration is untouched by an E2-C reset.
    expect(screen.getByTestId('cn2b-map-role-national_code')).toHaveAttribute('data-column-index', '0');
  });
});

describe('E2-C.11 — a change of sheet discards the draft', () => {
  it('another sheet starts empty, and returning does not resurrect the old entries', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    show(view, null);
    expect(panel()).toHaveAttribute('data-instmap-state', 'unavailable');
    expect(items()).toHaveLength(0);
    show(view, column(0, { sheetIndex: 1, sheetName: 'Other' }));
    expect(items()).toHaveLength(0);
    show(view, null);
    show(view, cell(0, 2));
    expect(items()).toHaveLength(0);
  });
});

describe('E2-C.12 — language, direction and keyboard', () => {
  it('Arabic renders right-to-left with Arabic copy and Arabic institution names', () => {
    const view = render(<Host lang="ar" selection={cell(0, 2)} />);
    expect(panel()).toHaveAttribute('dir', 'rtl');
    expect(panel()).toHaveAttribute('lang', 'ar');
    expect(within(panel()).getByRole('heading', { name: 'ربط المؤسسات بمصادر الاحتياج' })).toBeInTheDocument();
    expect(captureAnchor()).toHaveAccessibleName('استخدام الخلية C1 كخلية اسم المؤسسة');
    mapInstitution(view, cell(0, 2), column(2), 'org-a', 'ar');
    const [item] = items();
    expect(within(item).getByTestId('cn2b-instmap-item-name')).toHaveTextContent('مستشفى الأمل');
    expect(within(item).getByTestId('cn2b-instmap-item-anchor')).toHaveTextContent('الخلية C1');
    expect(within(item).getByTestId('cn2b-instmap-item-need')).toHaveTextContent('العمود C');
    expect(byTest('cn2b-instmap-edit-im-1')).toHaveAccessibleName('تعديل ربط مستشفى الأمل');
    expect(picker()).toHaveAccessibleName('المؤسسة المستفيدة (من قائمة MediStock)');
  });

  it('English renders left-to-right with English copy', () => {
    render(<Host lang="en" selection={cell(0, 2)} />);
    expect(panel()).toHaveAttribute('dir', 'ltr');
    expect(panel()).toHaveAttribute('lang', 'en');
    expect(panel()).toHaveAccessibleName('Institution Need mapping');
  });

  it('every control is native and keyboard-reachable; the list is an ordered list labelled by its heading', () => {
    const view = render(<Host lang="en" selection={null} />);
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    for (const button of within(panel()).getAllByRole('button')) {
      expect(button.tagName).toBe('BUTTON');
      expect(button).toHaveAttribute('type', 'button');
      expect(Number(button.getAttribute('tabindex') ?? '0')).toBeLessThanOrEqual(0);
    }
    expect(picker().tagName).toBe('SELECT');
    expect(picker()).toHaveAccessibleName("Beneficiary institution (from MediStock's list)");
    expect(within(panel()).getByRole('list', { name: 'Mapped institutions (1)' }).tagName).toBe('OL');
    byTest('cn2b-instmap-edit-im-1').focus();
    expect(document.activeElement).toBe(byTest('cn2b-instmap-edit-im-1'));
    // At rest there is no alert, so an alert always means a refusal just happened.
    expect(screen.queryByRole('alert')).toBeNull();
  });
});
