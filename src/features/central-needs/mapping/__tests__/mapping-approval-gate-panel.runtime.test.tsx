/** @vitest-environment jsdom */
/**
 * E2-D.5 — the Mapping Approval Gate panel and its lifecycle, in isolation.
 *
 * REAL: E2-B and E2-C hooks/reducers/panels, `useMappingApprovalGate`, the E2-D
 * panel, Web Crypto. Composition mirrors StoredWorkbookMapping; the full stored
 * source path is in simple/__tests__/e2d-stored-approval.
 */
import '@testing-library/jest-dom/vitest';
import { createHash } from 'node:crypto';
import { useEffect, useMemo } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import {
  buildCellSelection,
  buildColumnSelection,
  type WorkbookSelection,
  type WorkbookSourceIdentity,
} from '../../excel-first/workbookSelection';
import { InstitutionMappingPanel, type BeneficiaryChoice } from '../InstitutionMappingPanel';
import { MappingApprovalGatePanel } from '../MappingApprovalGatePanel';
import { SheetMappingProfilePanel } from '../SheetMappingProfilePanel';
import { useWorkbookMapping } from '../useInstitutionMapping';
import { useMappingApprovalGate } from '../useMappingApprovalGate';

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
const cell = (row: number, col: number) => buildCellSelection(SOURCE, SHEET, row, col) as WorkbookSelection;

interface HostProps { lang: 'ar' | 'en'; selection: WorkbookSelection | null; beneficiaries?: BeneficiaryChoice[]; planRevisionId?: string | null }
function Host({ lang, selection, beneficiaries = ORGS, planRevisionId = 'rev-1' }: HostProps) {
  const mapping = useWorkbookMapping();
  const { observeSelection } = mapping;
  useEffect(() => { observeSelection(selection); }, [observeSelection, selection]);
  const eligibleBeneficiaryIds = useMemo(() => beneficiaries.map((b) => b.id), [beneficiaries]);
  const approval = useMappingApprovalGate({
    planRevisionId, sheet: mapping.sheet.state, institutions: mapping.institutions.state, eligibleBeneficiaryIds,
  });
  return (
    <>
      <SheetMappingProfilePanel lang={lang} state={mapping.sheet.state} onAssign={mapping.sheet.assign} onClear={mapping.sheet.clear} />
      <InstitutionMappingPanel lang={lang} controller={mapping.institutions} profile={mapping.sheet.state.profile} beneficiaries={beneficiaries} />
      <MappingApprovalGatePanel lang={lang} approval={approval} />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

type View = ReturnType<typeof render>;
let current: HostProps = { lang: 'en', selection: null };
const show = (view: View, patch: Partial<HostProps>) => { current = { ...current, ...patch }; view.rerender(<Host {...current} />); };
const start = (props: Partial<HostProps> = {}) => { current = { lang: 'en', selection: null, ...props }; return render(<Host {...current} />); };

const gate = () => screen.getByTestId('cn2b-approve-panel');
const inGate = (id: string) => within(gate()).getByTestId(id);
const queryGate = (id: string) => within(gate()).queryByTestId(id);
const inst = (id: string) => within(screen.getByTestId('cn2b-instmap-panel')).getByTestId(id);

function assign(view: View, col: number, role: 'national_code' | 'material') {
  show(view, { selection: column(col) });
  fireEvent.click(screen.getByTestId(`cn2b-map-assign-${role}`));
}
function mapInstitution(view: View, anchor: WorkbookSelection, need: WorkbookSelection, org: string) {
  show(view, { selection: anchor });
  fireEvent.click(inst('cn2b-instmap-capture-anchor'));
  show(view, { selection: need });
  fireEvent.click(inst('cn2b-instmap-capture-need'));
  fireEvent.change(inst('cn2b-instmap-beneficiary'), { target: { value: org } });
  fireEvent.click(inst('cn2b-instmap-commit'));
}
async function readyView(props: Partial<HostProps> = {}) {
  const view = start(props);
  assign(view, 0, 'national_code');
  assign(view, 1, 'material');
  mapInstitution(view, cell(0, 2), column(2), 'org-a');
  mapInstitution(view, cell(0, 3), column(3), 'org-b');
  await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'ready'));
  return view;
}
async function approvedView(props: Partial<HostProps> = {}) {
  const view = await readyView(props);
  const fingerprint = inGate('cn2b-approve-fingerprint-value').textContent as string;
  fireEvent.click(inGate('cn2b-approve-action'));
  expect(gate()).toHaveAttribute('data-approved', 'true');
  return { view, fingerprint };
}
/** Let any fingerprint computation settle. */
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
async function expectRevoked() {
  await settle();
  expect(gate()).toHaveAttribute('data-approved', 'false');
  expect(queryGate('cn2b-approve-approved')).toBeNull();
  expect(inGate('cn2b-approve-stale')).toHaveTextContent('The earlier local approval no longer matches the current mappings.');
}

describe('E2-D.5 — blocked, ready, approved', () => {
  it('starts BLOCKED with the reasons, the checklist and the disclaimer; approval impossible', () => {
    start();
    expect(gate()).toHaveAttribute('data-approval-status', 'blocked');
    expect(inGate('cn2b-approve-state')).toHaveTextContent('Status: BLOCKED');
    expect(inGate('cn2b-approve-disclaimer')).toHaveTextContent('This approval covers mapping review only and does not submit or approve the Annual Needs revision.');
    expect(within(inGate('cn2b-approve-blockers')).getByText('Open the verified original workbook above and select a cell or a column in it.')).toBeInTheDocument();
    const items = within(inGate('cn2b-approve-checklist')).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-check'))).toEqual(['revision', 'source', 'nationalCode', 'material', 'institutions', 'noConflict', 'noUnsavedEdit']);
    expect(items[1]).toHaveTextContent('Trusted Excel source');
    expect(items[1]).toHaveTextContent('Not yet');
    expect(inGate('cn2b-approve-action')).toBeDisabled();
    expect(queryGate('cn2b-approve-fingerprint')).toBeNull();
  });

  it('with Material missing it stays BLOCKED and says what to do', async () => {
    const view = start();
    assign(view, 0, 'national_code');
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    await settle();
    expect(gate()).toHaveAttribute('data-approval-status', 'blocked');
    expect(within(inGate('cn2b-approve-blockers')).getByText('Assign the Material column in the sheet mapping profile.')).toBeInTheDocument();
    expect(within(inGate('cn2b-approve-checklist')).getByText('Material column assigned').closest('li')).toHaveAttribute('data-met', 'false');
    expect(inGate('cn2b-approve-action')).toBeDisabled();
  });

  it('a complete mapping is VALID and awaits explicit approval; the fingerprint is SHA-256 of the shown canonical evidence', async () => {
    await readyView();
    expect(inGate('cn2b-approve-state')).toHaveTextContent('Status: VALID — the mappings are ready for review and local approval.');
    expect(inGate('cn2b-approve-awaiting')).toHaveTextContent('await your explicit local approval');
    expect(within(inGate('cn2b-approve-checklist')).getAllByText('Done')).toHaveLength(7);
    const fingerprint = inGate('cn2b-approve-fingerprint-value').textContent as string;
    expect(fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const json = inGate('cn2b-approve-evidence-json').textContent as string;
    expect(JSON.parse(json).schemaVersion).toBe('e2d-mapping-approval-v1');
    expect(fingerprint).toBe(createHash('sha256').update(Buffer.from(json, 'utf8')).digest('hex'));
    expect(gate()).toHaveAttribute('data-approved', 'false');
    expect(inGate('cn2b-approve-action')).toBeEnabled();
  });

  it('an explicit click approves LOCALLY, bound to the fingerprint, and says nothing was submitted', async () => {
    const { fingerprint } = await approvedView();
    expect(inGate('cn2b-approve-approved')).toHaveTextContent('File mappings approved locally');
    expect(inGate('cn2b-approve-approved')).toHaveTextContent('Nothing was sent to the server; the Annual Needs revision was not submitted or approved.');
    expect(inGate('cn2b-approve-state')).toHaveTextContent('Status: VALID — file mappings approved locally.');
    expect(inGate('cn2b-approve-fingerprint-value')).toHaveTextContent(fingerprint);
    expect(document.activeElement).toBe(inGate('cn2b-approve-approved'));
    expect(queryGate('cn2b-approve-action')).toBeNull();
  });

  it('moving the selection inside the same trusted sheet keeps the approval', async () => {
    const { view, fingerprint } = await approvedView();
    for (const selection of [cell(30, 9), column(7), cell(1, 1)]) {
      show(view, { selection });
      await settle();
      expect(gate()).toHaveAttribute('data-approved', 'true');
      expect(inGate('cn2b-approve-fingerprint-value')).toHaveTextContent(fingerprint);
    }
    expect(queryGate('cn2b-approve-stale')).toBeNull();
  });
});

describe('E2-D.6 — the approval ends on any semantic change and must be given again', () => {
  it('an E2-B role change', async () => {
    const { view } = await approvedView();
    fireEvent.click(screen.getByTestId('cn2b-map-clear-material'));
    await expectRevoked();
    expect(gate()).toHaveAttribute('data-approval-status', 'blocked');
    assign(view, 5, 'material');
    await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'ready'));
    expect(gate()).toHaveAttribute('data-approved', 'false');
    expect(inGate('cn2b-approve-stale')).toBeInTheDocument();
  });

  it('an edit begins — and cancelling it still requires a new approval', async () => {
    const { fingerprint } = await approvedView();
    fireEvent.click(inst('cn2b-instmap-edit-im-1'));
    await expectRevoked();
    expect(within(inGate('cn2b-approve-blockers')).getByText('Finish the institution mapping in progress or clear its choices.')).toBeInTheDocument();
    fireEvent.click(inst('cn2b-instmap-cancel'));
    await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'ready'));
    expect(gate()).toHaveAttribute('data-approved', 'false');
    expect(inGate('cn2b-approve-stale')).toBeInTheDocument();
    // The same mapping again: a NEW explicit approval, for the same fingerprint.
    fireEvent.click(inGate('cn2b-approve-action'));
    expect(gate()).toHaveAttribute('data-approved', 'true');
    expect(inGate('cn2b-approve-fingerprint-value')).toHaveTextContent(fingerprint);
    expect(queryGate('cn2b-approve-stale')).toBeNull();
  });

  it('an edit is committed', async () => {
    const { view, fingerprint } = await approvedView();
    fireEvent.click(inst('cn2b-instmap-edit-im-1'));
    show(view, { selection: column(6) });
    fireEvent.click(inst('cn2b-instmap-capture-need'));
    fireEvent.click(inst('cn2b-instmap-commit'));
    await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'ready'));
    await expectRevoked();
    expect(inGate('cn2b-approve-fingerprint-value').textContent).not.toBe(fingerprint);
  });

  it('a mapping is added', async () => {
    const { view, fingerprint } = await approvedView();
    mapInstitution(view, cell(0, 8), column(8), 'org-a');
    await waitFor(() => expect(inGate('cn2b-approve-fingerprint-value').textContent).not.toBe(fingerprint));
    await expectRevoked();
  });

  it('a mapping is removed', async () => {
    const { fingerprint } = await approvedView();
    fireEvent.click(inst('cn2b-instmap-remove-im-2'));
    await waitFor(() => expect(inGate('cn2b-approve-fingerprint-value').textContent).not.toBe(fingerprint));
    await expectRevoked();
  });

  it('the eligible beneficiary set changes', async () => {
    const { view, fingerprint } = await approvedView({ beneficiaries: [...ORGS, { id: 'org-z', name: 'Z', name_ar: 'ز', code: 'Z' }] });
    show(view, { beneficiaries: ORGS });
    await waitFor(() => expect(inGate('cn2b-approve-fingerprint-value').textContent).not.toBe(fingerprint));
    await expectRevoked();
  });

  it('the revision changes', async () => {
    const { view, fingerprint } = await approvedView();
    show(view, { planRevisionId: 'rev-2' });
    await waitFor(() => expect(inGate('cn2b-approve-fingerprint-value').textContent).not.toBe(fingerprint));
    await expectRevoked();
  });

  it('the source/sheet changes', async () => {
    const { view } = await approvedView();
    show(view, { selection: null });
    await expectRevoked();
    show(view, { selection: column(0, { sheetIndex: 1, sheetName: 'Other' }) });
    await settle();
    expect(gate()).toHaveAttribute('data-approval-status', 'blocked');
    expect(gate()).toHaveAttribute('data-approved', 'false');
  });

  it('a reset is pending', async () => {
    await approvedView();
    fireEvent.click(inst('cn2b-instmap-reset'));
    await expectRevoked();
    expect(within(inGate('cn2b-approve-blockers')).getByText('Confirm or cancel the pending reset of institution mappings.')).toBeInTheDocument();
    fireEvent.click(inst('cn2b-instmap-reset-keep'));
    await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'ready'));
    expect(gate()).toHaveAttribute('data-approved', 'false');
  });

  it('a remount (revision switch) starts with no approval at all', async () => {
    const { view } = await approvedView();
    view.unmount();
    start();
    expect(gate()).toHaveAttribute('data-approved', 'false');
    expect(queryGate('cn2b-approve-stale')).toBeNull();
  });
});

describe('E2-D.7 — no fingerprint, no approval (fail closed)', () => {
  it('without Web Crypto the mapping is valid but cannot be approved', async () => {
    vi.stubGlobal('crypto', {});
    const view = start();
    assign(view, 0, 'national_code');
    assign(view, 1, 'material');
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'fingerprint_unavailable'));
    expect(within(gate()).getByRole('alert')).toHaveTextContent('cannot be computed in this browser, so local approval is not possible');
    expect(inGate('cn2b-approve-action')).toBeDisabled();
    fireEvent.click(inGate('cn2b-approve-action'));
    expect(gate()).toHaveAttribute('data-approved', 'false');
    expect(queryGate('cn2b-approve-fingerprint')).toBeNull();
  });

  it('a failing digest behaves the same', async () => {
    vi.spyOn(globalThis.crypto.subtle, 'digest').mockRejectedValue(new Error('digest failed'));
    const view = start();
    assign(view, 0, 'national_code');
    assign(view, 1, 'material');
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    await waitFor(() => expect(gate()).toHaveAttribute('data-approval-status', 'fingerprint_unavailable'));
    expect(inGate('cn2b-approve-action')).toBeDisabled();
  });

  it('without a revision id the mapping is BLOCKED', async () => {
    const view = start({ planRevisionId: null });
    assign(view, 0, 'national_code');
    assign(view, 1, 'material');
    mapInstitution(view, cell(0, 2), column(2), 'org-a');
    await settle();
    expect(gate()).toHaveAttribute('data-approval-status', 'blocked');
    expect(within(inGate('cn2b-approve-blockers')).getByText('No Annual Needs draft is identified for this workbook.')).toBeInTheDocument();
  });
});

describe('E2-D.8 — language, direction, keyboard, memory only', () => {
  it('Arabic: right-to-left with the exact mapping-local wording', async () => {
    await approvedView({ lang: 'ar' });
    expect(gate()).toHaveAttribute('dir', 'rtl');
    expect(gate()).toHaveAttribute('lang', 'ar');
    expect(within(gate()).getByRole('heading', { name: 'مراجعة تعيينات الملف واعتمادها محليًا' })).toBeInTheDocument();
    expect(inGate('cn2b-approve-disclaimer')).toHaveTextContent('هذا الاعتماد يثبت مراجعة التعيينات فقط ولا يرسل الخطة للاعتماد.');
    expect(inGate('cn2b-approve-approved')).toHaveTextContent('تعيينات الملف معتمدة محليًا');
    expect(inGate('cn2b-approve-fingerprint-value')).toHaveAttribute('dir', 'ltr');
  });

  it('Arabic: the approve action is named exactly', async () => {
    await readyView({ lang: 'ar' });
    expect(inGate('cn2b-approve-action')).toHaveAccessibleName('اعتماد تعيينات الملف');
  });

  it('English: left-to-right; the action is a native, focusable button', async () => {
    await readyView();
    expect(gate()).toHaveAttribute('dir', 'ltr');
    expect(gate()).toHaveAccessibleName('File mapping review and local approval');
    const action = inGate('cn2b-approve-action');
    expect(action.tagName).toBe('BUTTON');
    expect(action).toHaveAttribute('type', 'button');
    expect(action).toHaveAccessibleName('Approve file mappings');
    action.focus();
    expect(document.activeElement).toBe(action);
    expect(within(gate()).getByRole('status')).toHaveTextContent('Status: VALID');
  });

  it('approving persists nothing and reaches no network', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    await approvedView();
    expect(setItem).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(document.cookie).toBe('');
  });
});
