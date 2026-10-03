/** @vitest-environment jsdom */
/**
 * CN-UI-S1 — the Simple workspace as the COMPLETE normal workflow.
 *
 * The workspace re-implements none of the three canonical surfaces the
 * screen hands it — the Work Session selector, the need-line panel and the
 * lifecycle actions. These tests render it directly with PROBES in those
 * slots, so what is proven here is purely where (and when) Simple places
 * them, and what it never offers:
 *
 *   S1-08  the lifecycle block appears for a ready draft's editor only, on
 *          the outcome step — never while the server still blocks;
 *   S1-09  for a submitted revision it is the decision; for any other closed
 *          status it is absent;
 *   S1-11  no step offers a way into Advanced, in either language;
 *   S1-12  no step is a summary;
 *   S1-14  Arabic RTL / English LTR, the new copy bilingual;
 *   S1-15  one h1, every task card titled and labelled, live regions;
 *   S1-17  the need-line workspace keeps ONE instance across need lines ⇄
 *          outcome and through a submit in flight; rows still being read
 *          are never acted on; the material card reports busy/dirty/failed
 *          and releases them when it leaves.
 */
import '@testing-library/jest-dom/vitest';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { T } from '@/shared/i18n/strings';
import type { PreviewState } from '../../useCentralNeedsPreview';
import type {
  BeneficiaryColumnSummary, FieldOverride, PlanRevision, RecordDisposition, ReviewReadiness, RevisionStatus, SourceRecord,
} from '../../central-needs.service';

const setRecordDisposition = vi.fn();
vi.mock('../../central-needs.service', async () => {
  const actual = await vi.importActual<typeof import('../../central-needs.service')>('../../central-needs.service');
  return {
    ...actual,
    setRecordDisposition: (...a: unknown[]) => setRecordDisposition(...a),
    setBeneficiaryColumns: vi.fn(),
    searchCentralItems: () => Promise.resolve([]),
  };
});

const { CentralNeedsSimpleWorkspace } = await import('../CentralNeedsSimpleWorkspace');
const { materialCardHasLocalWork } = await import('../SimpleMaterialCard');

const lifecycle: string[] = [];
function Probe({ name }: { name: string }) {
  useEffect(() => {
    lifecycle.push(`mount:${name}`);
    return () => { lifecycle.push(`unmount:${name}`); };
  }, [name]);
  return <div data-testid={`probe-${name}`} />;
}
const SLOTS = {
  workSessionPicker: <Probe name="picker" />,
  needLineWorkspace: <Probe name="need-lines" />,
  lifecycleActions: <Probe name="lifecycle" />,
};

const IDLE: PreviewState = { phase: 'idle' };
const revisionOf = (status: RevisionStatus): PlanRevision => ({
  id: 'rev-1', planId: 'plan-1', organizationId: 'org-1', planYear: 2026, revisionNumber: 1, status,
});
const rec = (targetEntity: string): SourceRecord => ({
  id: `r-${targetEntity}`, importSessionId: 's1', recordOrdinal: 1, targetEntity, fieldName: 'ITEMS',
  sourceValues: { value: 'PARACETAMOL 500 MG' }, sourceProvenance: { sheetIndex: 0, coordinate: { col: 2 } },
});
const disp = (targetEntity: string): RecordDisposition => ({
  id: `d-${targetEntity}`, importSessionId: 's1', targetEntity, decision: 'mapped', centralItemId: 'item-1',
  decisionReason: null, decidedAt: '2026-01-01T00:00:00.000Z',
});
const decided: BeneficiaryColumnSummary = {
  importSessionId: 's1', originalFilename: 'n.xls', archiveEntryPath: null, sheetIndex: 0, sheetName: 'S', columnIndex: 2,
  sourceFieldName: 'Hospital', numericValueCount: 1, zeroValueCount: 0, nonzeroNumericCount: 1, mappingId: 'm1',
  decision: 'beneficiary', beneficiaryOrganizationId: 'org-a', mappingReason: null, mappedAt: null, mappedRowNumericCount: 1,
  reviewRequired: false,
};
const readinessOf = (ready: boolean): ReviewReadiness => ({
  planRevisionId: 'rev-1', status: 'draft', ready,
  blockers: ready ? [] : [{ blocker: 'mapped_target_entity_without_need_line', detail: 'session=s1' }],
});

type WorkspaceProps = Parameters<typeof CentralNeedsSimpleWorkspace>[0];
/** A draft whose rows are all decided: the need-lines step (blocked) or the outcome (ready). */
const reviewed = (over: Partial<WorkspaceProps> = {}): WorkspaceProps => ({
  lang: 'en', planYear: 2026, onPlanYearChange: () => {}, revisionsLoading: false, revision: revisionOf('draft'), isDraft: true,
  revisionDataReady: true, canImport: true, canEdit: true, busy: false, activity: null, onOpenRevision: () => {},
  preview: IDLE, pendingFile: null, onPickFile: () => {}, onVerify: () => {}, error: null, notice: null,
  readiness: readinessOf(false), beneficiaryColumns: [decided], careInstitutions: [], records: [rec('row-5')],
  dispositions: [disp('row-5')], activeSessionId: 's1', onChanged: () => {}, ...SLOTS, ...over,
});

function renderWorkspace(props: WorkspaceProps) {
  const view = render(<CentralNeedsSimpleWorkspace {...props} />);
  return { ...view, rerenderWith: (next: Partial<WorkspaceProps>) => view.rerender(<CentralNeedsSimpleWorkspace {...{ ...props, ...next }} />) };
}
const stepOf = () => screen.getByTestId('cn2b-simple-workspace').getAttribute('data-step');

beforeEach(() => { lifecycle.length = 0; setRecordDisposition.mockReset(); });
afterEach(() => cleanup());

describe('CN-UI-S1 · where Simple places the screen\'s canonical surfaces', () => {
  it('need lines: the selector in the session context, the panel in its own section, and NO lifecycle block', () => {
    renderWorkspace(reviewed());
    expect(stepOf()).toBe('need-lines');
    expect(within(screen.getByTestId('cn2b-simple-context')).getByTestId('probe-picker')).toBeInTheDocument();
    expect(within(screen.getByTestId('cn2b-simple-need-lines')).getByTestId('probe-need-lines')).toBeInTheDocument();
    expect(screen.queryByTestId('probe-lifecycle')).toBeNull();
    expect(screen.queryByTestId('cn2b-simple-submit')).toBeNull();
    // The panel is an auxiliary workspace, never a second task card.
    expect(screen.getByTestId('cn2b-simple-need-lines').closest('.cn2b-simple-card')).toBeNull();
    expect(document.querySelectorAll('.cn2b-simple-card')).toHaveLength(1);
  });

  it('S1-08 — the server\'s ready: the lifecycle block in the outcome card, for an editor of the draft only', () => {
    const { rerenderWith } = renderWorkspace(reviewed({ readiness: readinessOf(true) }));
    expect(stepOf()).toBe('pending');
    expect(within(screen.getByTestId('cn2b-simple-submit')).getByTestId('probe-lifecycle')).toBeInTheDocument();
    expect(within(screen.getByTestId('cn2b-simple-pending')).getByTestId('cn2b-simple-submit')).toBeInTheDocument();
    rerenderWith({ canEdit: false });
    expect(screen.queryByTestId('probe-lifecycle')).toBeNull();
    expect(screen.getByTestId('cn2b-simple-submit-unavailable')).toHaveTextContent(T.cn2b_simple_submit_needs_edit.en);
  });

  it('S1-09 — a submitted revision places the lifecycle block as its decision; approved, rejected and superseded never do', () => {
    for (const status of ['submitted', 'approved', 'rejected', 'superseded'] as const) {
      renderWorkspace(reviewed({ revision: revisionOf(status), isDraft: false, readiness: { ...readinessOf(true), status } }));
      expect(stepOf(), status).toBe('pending');
      const closed = screen.getByTestId('cn2b-simple-closed');
      if (status === 'submitted') {
        expect(within(within(closed).getByTestId('cn2b-simple-decision')).getByTestId('probe-lifecycle')).toBeInTheDocument();
      } else {
        expect(screen.queryByTestId('probe-lifecycle'), status).toBeNull();
      }
      // A closed revision is no draft: no draft outcome card, no submit, no session context.
      expect(screen.queryByTestId('cn2b-simple-pending'), status).toBeNull();
      expect(screen.queryByTestId('cn2b-simple-context'), status).toBeNull();
      cleanup();
    }
  });
});

describe('CN-UI-S1 · nothing is discarded or acted on by surprise (S1-17)', () => {
  it('the need-line workspace keeps ONE instance across need lines → outcome → a submit in flight → need lines', () => {
    const { rerenderWith } = renderWorkspace(reviewed());
    expect(stepOf()).toBe('need-lines');
    rerenderWith({ readiness: readinessOf(true) });
    expect(stepOf()).toBe('pending');
    rerenderWith({ readiness: readinessOf(true), busy: true, activity: 'submitting' });
    expect(stepOf()).toBe('pending'); // a lifecycle action never sends the page to "analyzing"
    rerenderWith({ readiness: readinessOf(false), busy: false, activity: null });
    expect(stepOf()).toBe('need-lines');
    expect(lifecycle.filter((e) => e.endsWith(':need-lines'))).toEqual(['mount:need-lines']);
  });

  it('rows still being read for a newly chosen session are never acted on: no card, no panel — only the selector, waiting', () => {
    const { rerenderWith } = renderWorkspace(reviewed());
    rerenderWith({ sessionLoading: true, activeSessionId: 's2', records: [rec('row-old')], dispositions: [] });
    expect(stepOf()).toBe('analyzing');
    expect(screen.queryByTestId('cn2b-simple-material-card')).toBeNull();
    expect(screen.queryByTestId('probe-need-lines')).toBeNull();
    expect(within(screen.getByTestId('cn2b-simple-context')).getByTestId('probe-picker')).toBeInTheDocument();
    expect(within(screen.getByTestId('cn2b-simple-analyzing')).getByRole('status')).toHaveTextContent(T.cn2b_simple_preparing.en);
  });

  it('a CLOSED revision stays on its outcome while a session loads, but shows no need lines from rows that are not yet that session\'s', () => {
    const { rerenderWith } = renderWorkspace(reviewed({ revision: revisionOf('submitted'), isDraft: false }));
    expect(screen.getByTestId('probe-need-lines')).toBeInTheDocument(); // read-only register for the approver
    rerenderWith({ sessionLoading: true, activeSessionId: 's2' });
    expect(stepOf()).toBe('pending');
    expect(screen.getByTestId('cn2b-simple-closed')).toBeInTheDocument();
    expect(screen.queryByTestId('probe-need-lines')).toBeNull();
  });

  it('the material card reports busy / dirty / failed to the screen\'s guard, and releases them when it leaves', async () => {
    const reports: Array<{ busy: boolean; dirty: boolean; failed: boolean }> = [];
    let release!: () => void;
    setRecordDisposition.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ mappingId: 'm', idempotentReplay: false }); }));
    const { rerenderWith } = renderWorkspace(reviewed({
      dispositions: [], onMaterialActivityChange: (a) => { reports.push(a); },
    }));
    expect(stepOf()).toBe('review-material');
    const card = screen.getByTestId('cn2b-simple-material-card');
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    fireEvent.change(within(card).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'footer' } });
    expect(reports.at(-1)).toEqual({ busy: false, dirty: true, failed: false });
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_confirm_not_a_material.en }));
    expect(reports.at(-1)).toEqual({ busy: true, dirty: true, failed: false });
    await act(async () => { release(); });
    expect(reports.at(-1)).toEqual({ busy: false, dirty: true, failed: false });
    // The server's re-read shows the decision: the queue empties and the card leaves.
    rerenderWith({ dispositions: [disp('row-5')] });
    expect(stepOf()).toBe('need-lines');
    expect(reports.at(-1)).toEqual({ busy: false, dirty: false, failed: false });
  });

  it('a refused material decision is reported as failed', async () => {
    const reports: Array<{ busy: boolean; dirty: boolean; failed: boolean }> = [];
    setRecordDisposition.mockRejectedValue(new Error('refused'));
    renderWorkspace(reviewed({ dispositions: [], onMaterialActivityChange: (a) => { reports.push(a); } }));
    const card = screen.getByTestId('cn2b-simple-material-card');
    fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
    fireEvent.change(within(card).getByLabelText(T.cn2b_beneficiary_column_reason_required.en), { target: { value: 'footer' } });
    await act(async () => { fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_confirm_not_a_material.en })); });
    expect(reports.at(-1)).toEqual({ busy: false, dirty: true, failed: true });
  });
});

describe('CN-UI-S1 · no handoff, no summary, both languages (S1-11, S1-12, S1-14)', () => {
  const STEP_FIXTURES: Array<[string, Partial<WorkspaceProps>]> = [
    ['upload', { revision: null, isDraft: false }],
    ['analyzing', { busy: true, activity: 'verifying' }],
    ['review-institution', { beneficiaryColumns: [{ ...decided, decision: null, beneficiaryOrganizationId: null, reviewRequired: true }] }],
    ['review-material', { dispositions: [] }],
    ['need-lines', {}],
    ['pending', { readiness: readinessOf(true) }],
    ['pending', { revision: revisionOf('approved'), isDraft: false }],
  ];

  for (const lang of ['ar', 'en'] as const) {
    it(`${lang}: every step — no way into Advanced, no summary, the page direction ${lang === 'ar' ? 'RTL' : 'LTR'}`, () => {
      for (const [step, over] of STEP_FIXTURES) {
        renderWorkspace(reviewed({ lang, ...over }));
        const page = screen.getByTestId('cn2b-simple-workspace');
        expect(page.getAttribute('data-step'), step).toBe(step);
        expect(page).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        expect(page.textContent ?? '', step).not.toMatch(/Advanced options|advanced options|خيارات متقدمة|الخيارات المتقدمة/);
        expect(page.querySelector('footer'), step).toBeNull();
        for (const id of ['cn2b-simple-advanced-link', 'cn2b-simple-continue-advanced', 'cn2b-simple-handoff', 'cn2b-simple-summary', 'cn2b-simple-review-start']) {
          expect(screen.queryByTestId(id), `${step}: ${id}`).toBeNull();
        }
        cleanup();
      }
    });
  }

  it('the new CN-UI-S1 copy exists in Arabic and English, and the six-step labels name the need-lines step', () => {
    for (const key of [
      'cn2b_simple_step_need_lines', 'cn2b_simple_need_lines_title', 'cn2b_simple_need_lines_lead', 'cn2b_simple_need_lines_workspace',
      'cn2b_simple_submit_title', 'cn2b_simple_submit_needs_edit', 'cn2b_simple_no_edit_permission', 'cn2b_simple_no_edit_permission_hint',
    ]) {
      expect(T[key], key).toBeDefined();
      expect(T[key].ar, key).toMatch(/[؀-ۿ]/);
      expect(T[key].en.trim(), key).not.toBe('');
      expect(T[key].ar, key).not.toBe(T[key].en);
    }
    renderWorkspace(reviewed({ lang: 'ar' }));
    expect(screen.getByTestId('cn2b-simple-step-count')).toHaveTextContent('الخطوة 5 من 6');
    expect(screen.getByTestId('cn2b-simple-step-title')).toHaveTextContent(T.cn2b_simple_step_need_lines.ar);
  });
});

describe('CN-UI-S1 · accessibility structure (S1-15)', () => {
  const FIXTURES: Array<Partial<WorkspaceProps>> = [
    {}, { readiness: readinessOf(true) }, { revision: revisionOf('submitted'), isDraft: false },
    { dispositions: [] }, { busy: true, activity: 'verifying' },
  ];

  it('one h1; every task card titled by an h2 it is labelled by; the need lines a titled h3 subsection', () => {
    for (const over of FIXTURES) {
      const { container } = renderWorkspace(reviewed(over));
      expect(container.querySelectorAll('h1')).toHaveLength(1);
      for (const section of container.querySelectorAll('section.cn2b-simple-card[aria-labelledby]')) {
        const title = container.querySelector(`#${section.getAttribute('aria-labelledby')}`);
        expect(title, section.getAttribute('data-testid') ?? '').not.toBeNull();
        expect(title?.tagName).toBe('H2');
        expect(section.contains(title)).toBe(true);
      }
      const needLines = container.querySelector('[data-testid="cn2b-simple-need-lines"]');
      if (needLines) {
        const title = container.querySelector(`#${needLines.getAttribute('aria-labelledby')}`);
        expect(title?.tagName).toBe('H3');
        expect(title).toHaveTextContent(T.cn2b_simple_need_lines_workspace.en);
      }
      cleanup();
    }
  });

  it('the session context is a named region; status and errors are announced', () => {
    renderWorkspace(reviewed({ notice: 'Saved.', error: 'Refused.' }));
    expect(screen.getByRole('region', { name: T.cn2b_work_session.en })).toBe(screen.getByTestId('cn2b-simple-context'));
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.getByRole('alert')).toHaveTextContent('Refused.');
  });
});

// ============================================================================
// CN-UI-S1 HC1 — material draft guard (H1-01) and contextual expert escape
// (H1-02), at the workspace level. The screen-level halves (the real Work
// Session guard, the real busy/dirty guard, the real mode switch) are in
// cn-ui-s1-simple-workflow-screen.runtime.test.tsx.
// ============================================================================

describe('CN-UI-S1 HC1 · the material card\'s dirty contract (H1-01)', () => {
  type Report = { busy: boolean; dirty: boolean; failed: boolean };
  const CLEAN: Report = { busy: false, dirty: false, failed: false };
  const DIRTY: Report = { busy: false, dirty: true, failed: false };

  /** The review-material step, with every activity report the card makes recorded. */
  function renderMaterialStep() {
    const reports: Report[] = [];
    const view = renderWorkspace(reviewed({ dispositions: [], onMaterialActivityChange: (a) => { reports.push({ ...a }); } }));
    expect(stepOf()).toBe('review-material');
    const card = () => screen.getByTestId('cn2b-simple-material-card');
    return { ...view, reports, card, last: () => reports.at(-1) };
  }
  const openPicker = (card: HTMLElement) => fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_choose_material.en }));
  const openReason = (card: HTMLElement) => fireEvent.click(within(card).getByRole('button', { name: T.cn2b_simple_not_a_material.en }));
  const searchBox = (card: HTMLElement) => within(card).getByLabelText(T.cn2b_simple_search_material.en) as HTMLInputElement;
  const reasonBox = (card: HTMLElement) => within(card).getByLabelText(T.cn2b_beneficiary_column_reason_required.en) as HTMLInputElement;

  it('the pure rule is the frozen contract, term by term: picking OR query OR reason-surface OR reason text', () => {
    const NONE = { picking: false, query: '', showNotApplicable: false, notApplicableReason: '' };
    expect(materialCardHasLocalWork(NONE)).toBe(false);
    // Each term ALONE is enough — none depends on another (nor on a persisted write).
    expect(materialCardHasLocalWork({ ...NONE, picking: true })).toBe(true);
    expect(materialCardHasLocalWork({ ...NONE, query: 'amox' })).toBe(true);
    expect(materialCardHasLocalWork({ ...NONE, showNotApplicable: true })).toBe(true);
    expect(materialCardHasLocalWork({ ...NONE, notApplicableReason: 'footer' })).toBe(true);
    // Whitespace is not work.
    expect(materialCardHasLocalWork({ ...NONE, query: '   ' })).toBe(false);
    expect(materialCardHasLocalWork({ ...NONE, notApplicableReason: ' \t ' })).toBe(false);
  });

  it('starts clean — a card that has not been touched never asks to be protected', () => {
    const { last } = renderMaterialStep();
    expect(last()).toEqual(CLEAN);
  });

  it('H1-01A — opening the material picker marks the surface dirty, before anything is typed', () => {
    const { card, last } = renderMaterialStep();
    openPicker(card());
    expect(within(card()).getByTestId('cn2b-simple-material-picker')).toBeInTheDocument();
    expect(last()).toEqual(DIRTY);
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('H1-01B — typing search text keeps it dirty', () => {
    const { card, last } = renderMaterialStep();
    openPicker(card());
    fireEvent.change(searchBox(card()), { target: { value: 'amox' } });
    expect(searchBox(card())).toHaveValue('amox');
    expect(last()).toEqual(DIRTY);
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('H1-01C — opening the not-applicable reason surface marks it dirty even before any text', () => {
    const { card, last } = renderMaterialStep();
    openReason(card());
    expect(reasonBox(card())).toHaveValue('');
    expect(last()).toEqual(DIRTY);
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('H1-01D — a typed reason is dirty, and stays dirty while the surface is open even if the text is cleared again', () => {
    const { card, last } = renderMaterialStep();
    openReason(card());
    fireEvent.change(reasonBox(card()), { target: { value: 'footer row' } });
    expect(last()).toEqual(DIRTY);
    fireEvent.change(reasonBox(card()), { target: { value: '' } });
    expect(last()).toEqual(DIRTY);
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('H1-01E — returning to a genuinely clean state clears dirty: Cancel of the picker (its query too) and of the reason surface', () => {
    const { card, last } = renderMaterialStep();
    openPicker(card());
    fireEvent.change(searchBox(card()), { target: { value: 'amox' } });
    expect(last()).toEqual(DIRTY);
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_cancel.en }));
    expect(within(card()).queryByTestId('cn2b-simple-material-picker')).toBeNull();
    expect(last()).toEqual(CLEAN);
    // Nothing hidden is left behind: re-opening starts from an empty search, and Cancel again is clean.
    openPicker(card());
    expect(searchBox(card())).toHaveValue('');
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_cancel.en }));
    expect(last()).toEqual(CLEAN);

    openReason(card());
    fireEvent.change(reasonBox(card()), { target: { value: 'footer row' } });
    expect(last()).toEqual(DIRTY);
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_cancel.en }));
    expect(within(card()).queryByTestId('cn2b-simple-material-not-applicable-reason')).toBeNull();
    expect(last()).toEqual(CLEAN);
    expect(setRecordDisposition).not.toHaveBeenCalled();
  });

  it('H1-01I — an in-flight decision reports busy alongside dirty (the work is never dropped), and a refusal reports failed', async () => {
    let refuse!: (e: Error) => void;
    setRecordDisposition.mockImplementation(() => new Promise((_resolve, reject) => { refuse = reject; }));
    const { card, last } = renderMaterialStep();
    openReason(card());
    fireEvent.change(reasonBox(card()), { target: { value: 'footer row' } });
    fireEvent.click(within(card()).getByRole('button', { name: T.cn2b_simple_confirm_not_a_material.en }));
    expect(last()).toEqual({ busy: true, dirty: true, failed: false });
    expect(reasonBox(card())).toHaveValue('footer row');
    await act(async () => { refuse(new Error('refused')); });
    expect(last()).toEqual({ busy: false, dirty: true, failed: true });
    expect(reasonBox(card())).toHaveValue('footer row');
    expect(setRecordDisposition).toHaveBeenCalledTimes(1);
  });
});

describe('CN-UI-S1 HC1 · the contextual expert escape, placed by the workspace (H1-02)', () => {
  const OPEN_IMPORT = { blocker: 'import_session_still_open', detail: 'session=s9 status=processing' };
  const NUMERIC = {
    blocker: 'need_line_quantity_lineage_unsafe',
    detail: 'session=s1 source_record=r-row-5 need_line=n1 reason=source_quantity_requires_explicit_numeric_override',
  };
  const UNKNOWN = { blocker: 'brand_new_server_code_this_build_has_never_seen', detail: null };
  // HC1.1 — the rest of M217's frozen lineage vocabulary, each classified.
  const lineageRow = (reason: string | null) => ({
    blocker: 'need_line_quantity_lineage_unsafe',
    detail: reason === null ? 'session=s1 source_record=r-row-5 need_line=n1' : `session=s1 source_record=r-row-5 need_line=n1 reason=${reason}`,
  });
  const INVALID_EVIDENCE = lineageRow('source_cell_value_contract_invalid');
  const VALUE_INVALID = lineageRow('source_quantity_override_value_invalid');
  const UNKNOWN_LINEAGE = lineageRow('a_future_reason_this_build_has_never_seen');
  const MISSING_LINEAGE = lineageRow(null);
  const blockedBy = (...blockers: ReviewReadiness['blockers']): ReviewReadiness => ({
    planRevisionId: 'rev-1', status: 'draft', ready: false, blockers,
  });
  const escape = () => screen.queryByTestId('cn2b-simple-expert-escape');
  const openButton = () => screen.queryByTestId('cn2b-simple-expert-open');
  const stageTitle = (stage: 'source' | 'review' | 'readiness', lang: 'ar' | 'en') =>
    T[`cn2b_stage_${stage}`][lang];

  // CN-UI-S1 HC1.2 — the override chain the screen already holds, handed to the workspace as-is.
  const override = (sourceRecordId: string, finalValue: unknown, id: string): FieldOverride => ({
    id, sourceRecordId, targetEntity: 'row-5', fieldName: 'ITEMS', previousValue: null, finalValue,
    finalValueText: typeof finalValue === 'number' ? String(finalValue) : JSON.stringify(finalValue),
    overrideReason: 'reviewed', overrideNote: null, createdAt: '2026-09-26T10:00:00+00:00',
  });
  const NUMERIC_HEAD: Partial<WorkspaceProps> = { overrides: [override('r-row-5', 12, 'ov-head')], overrideReadFailure: null };
  const TEXT_HEAD: Partial<WorkspaceProps> = { overrides: [override('r-row-5', 'twelve', 'ov-text')], overrideReadFailure: null };
  const OTHER_RECORD_HEAD: Partial<WorkspaceProps> = { overrides: [override('r-another-cell', 12, 'ov-other')], overrideReadFailure: null };
  const CHAIN_UNAVAILABLE: Partial<WorkspaceProps> = { overrides: [], overrideReadFailure: 'field_overrides_not_loaded' };
  // HC1.3 — `…_requires_explicit_numeric_override` is HEAD-DEPENDENT (like binding_invalid): a COMPLETE chain with no head for the cell is the
  // plain "this cell still needs a numeric correction" case the NUMERIC fixture below stands for.
  const NO_HEAD: Partial<WorkspaceProps> = { overrides: [], overrideReadFailure: null };
  const BINDING_INVALID = lineageRow('source_quantity_override_binding_invalid');
  const BINDING_WITHOUT_RECORD = { blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 need_line=n1 reason=source_quantity_override_binding_invalid' };
  const NUMERIC_WITHOUT_RECORD = { blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 need_line=n1 reason=source_quantity_requires_explicit_numeric_override' };

  type EscapeCase = {
    name: string; blockers: ReviewReadiness['blockers']; stage: 'source' | 'review' | 'readiness'; reason: string;
    titleKey: string; bodyKey: string; props?: Partial<WorkspaceProps>;
  };
  const CASES: readonly EscapeCase[] = [
    { name: 'numeric override (numeric-required, no current head)', blockers: [NUMERIC], stage: 'review', reason: 'numeric_override', titleKey: 'cn2b_simple_expert_title', bodyKey: 'cn2b_simple_expert_body_numeric_override', props: NO_HEAD },
    { name: 'open import', blockers: [OPEN_IMPORT], stage: 'source', reason: 'open_import', titleKey: 'cn2b_simple_expert_title', bodyKey: 'cn2b_simple_expert_body_open_import' },
    { name: 'unknown blocker', blockers: [UNKNOWN], stage: 'readiness', reason: 'unknown_blocker', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_unknown' },
    // HC1.2 — invalid IMMUTABLE evidence has no in-app remedy: one DIAGNOSTIC escape to READINESS, for both forms.
    { name: 'invalid evidence (lineage reason)', blockers: [INVALID_EVIDENCE], stage: 'readiness', reason: 'source_evidence_invalid', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_source_evidence_invalid' },
    { name: 'invalid evidence (blocker)', blockers: [{ blocker: 'source_cell_value_contract_invalid', detail: 'session=s1 source_record=r-row-5 reason=invalid_evidence' }], stage: 'readiness', reason: 'source_evidence_invalid', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_source_evidence_invalid' },
    { name: 'invalid override value', blockers: [VALUE_INVALID], stage: 'review', reason: 'numeric_override', titleKey: 'cn2b_simple_expert_title', bodyKey: 'cn2b_simple_expert_body_numeric_override' },
    { name: 'unknown lineage reason', blockers: [UNKNOWN_LINEAGE], stage: 'readiness', reason: 'unknown_lineage_reason', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_unknown_lineage' },
    { name: 'missing lineage reason', blockers: [MISSING_LINEAGE], stage: 'readiness', reason: 'unknown_lineage_reason', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_unknown_lineage' },
    // HC1.2 — binding_invalid is CONDITION-AWARE: with no usable numeric current head it escapes; with no proof it fails closed.
    { name: 'binding_invalid, current head is text', blockers: [BINDING_INVALID], stage: 'review', reason: 'numeric_override', titleKey: 'cn2b_simple_expert_title', bodyKey: 'cn2b_simple_expert_body_numeric_override', props: TEXT_HEAD },
    { name: 'binding_invalid, no current head for the record', blockers: [BINDING_INVALID], stage: 'review', reason: 'numeric_override', titleKey: 'cn2b_simple_expert_title', bodyKey: 'cn2b_simple_expert_body_numeric_override', props: OTHER_RECORD_HEAD },
    { name: 'binding_invalid, record not named by the server', blockers: [BINDING_WITHOUT_RECORD], stage: 'readiness', reason: 'override_head_unproven', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_override_head_unproven', props: NUMERIC_HEAD },
    { name: 'binding_invalid, override chain unavailable', blockers: [BINDING_INVALID], stage: 'readiness', reason: 'override_head_unproven', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_override_head_unproven', props: CHAIN_UNAVAILABLE },
    { name: 'binding_invalid, no override context at all', blockers: [BINDING_INVALID], stage: 'readiness', reason: 'override_head_unproven', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_override_head_unproven' },
    // HC1.3 — the numeric-required reason takes the SAME branches through the SAME function.
    { name: 'numeric-required, current head is text', blockers: [NUMERIC], stage: 'review', reason: 'numeric_override', titleKey: 'cn2b_simple_expert_title', bodyKey: 'cn2b_simple_expert_body_numeric_override', props: TEXT_HEAD },
    { name: 'numeric-required, only ANOTHER cell has a numeric head', blockers: [NUMERIC], stage: 'review', reason: 'numeric_override', titleKey: 'cn2b_simple_expert_title', bodyKey: 'cn2b_simple_expert_body_numeric_override', props: OTHER_RECORD_HEAD },
    { name: 'numeric-required, record not named by the server', blockers: [NUMERIC_WITHOUT_RECORD], stage: 'readiness', reason: 'override_head_unproven', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_override_head_unproven', props: NUMERIC_HEAD },
    { name: 'numeric-required, override chain unavailable', blockers: [NUMERIC], stage: 'readiness', reason: 'override_head_unproven', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_override_head_unproven', props: CHAIN_UNAVAILABLE },
    { name: 'numeric-required, no override context at all', blockers: [NUMERIC], stage: 'readiness', reason: 'override_head_unproven', titleKey: 'cn2b_simple_expert_title_unknown', bodyKey: 'cn2b_simple_expert_body_override_head_unproven' },
  ];

  it('HC1.2 — the override context is used ONLY when BOTH halves arrive: the chain without its read verdict, or the verdict without the chain, is an UNPROVEN head (fail closed)', () => {
    renderWorkspace(reviewed({ readiness: blockedBy(BINDING_INVALID), onExpertEscape: vi.fn(), overrides: [override('r-row-5', 12, 'ov-head')] }));
    expect(escape()).toHaveAttribute('data-reason', 'override_head_unproven');
    cleanup();
    renderWorkspace(reviewed({ readiness: blockedBy(BINDING_INVALID), onExpertEscape: vi.fn(), overrideReadFailure: null }));
    expect(escape()).toHaveAttribute('data-reason', 'override_head_unproven');
  });

  it('HC1.2 — the escape FOLLOWS the chain it is handed: the same readiness with a changed chain or read verdict gives a changed answer (never a stale one)', () => {
    const { rerenderWith } = renderWorkspace(reviewed({ readiness: blockedBy(BINDING_INVALID), onExpertEscape: vi.fn(), ...TEXT_HEAD }));
    expect(escape()).toHaveAttribute('data-reason', 'numeric_override'); // the current head is text
    rerenderWith({ ...NUMERIC_HEAD }); // a numeric head arrives
    expect(escape()).toBeNull();
    rerenderWith({ ...NUMERIC_HEAD, overrideReadFailure: 'field_overrides_not_loaded' }); // the chain is being re-read
    expect(escape()).toHaveAttribute('data-reason', 'override_head_unproven');
    rerenderWith({ ...NUMERIC_HEAD, overrideReadFailure: null }); // and has answered
    expect(escape()).toBeNull();
  });

  it('HC1.3 — the numeric-required reason FOLLOWS the chain exactly like binding_invalid: record a correction (the chain changes) and the escape goes away; while the chain is re-read it is unproven; never a stale answer', () => {
    const { rerenderWith } = renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC), onExpertEscape: vi.fn(), ...NO_HEAD }));
    expect(escape()).toHaveAttribute('data-reason', 'numeric_override'); // no head yet: the correction is recorded in DATA REVIEW
    rerenderWith({ ...TEXT_HEAD }); // a non-numeric head arrives
    expect(escape()).toHaveAttribute('data-reason', 'numeric_override');
    rerenderWith({ ...NUMERIC_HEAD }); // the reviewer records the numeric correction and the chain is re-read: Simple's remedy now applies
    expect(escape()).toBeNull();
    rerenderWith({ ...NUMERIC_HEAD, overrideReadFailure: 'field_overrides_not_loaded' }); // a re-read is under way: the head cannot be proven
    expect(escape()).toHaveAttribute('data-reason', 'override_head_unproven');
    rerenderWith({ ...NUMERIC_HEAD, overrideReadFailure: null }); // and has answered
    expect(escape()).toBeNull();
    // The readiness is the same object throughout: only the chain moved the answer.
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toHaveTextContent(T.cn2b_simple_blocker_lineage_source_quantity_requires_explicit_numeric_override.en);
  });

  it('H1-02A — the normal ready workflow shows NO expert escape', () => {
    renderWorkspace(reviewed({ readiness: readinessOf(true), onExpertEscape: vi.fn() }));
    expect(stepOf()).toBe('pending');
    expect(escape()).toBeNull();
    expect(openButton()).toBeNull();
  });

  it('H1-02B/H — blockers Simple resolves (beneficiary, material, need lines, the two lineage reasons its panel remedies) show NO escape', () => {
    const solvable: ReviewReadiness['blockers'][] = [
      [{ blocker: 'beneficiary_column_review_required', detail: 'session=s1 column=3' }],
      [{ blocker: 'target_entity_without_disposition', detail: 'session=s1 target_entity=row-9' }],
      [{ blocker: 'mapped_target_entity_without_need_line', detail: 'session=s1 target_entity=row-5' }],
      [{ blocker: 'need_line_unit_conversion_required', detail: null }],
      [{ blocker: 'beneficiary_region_cell_without_need_line', detail: 'session=s1 sheet=0' }],
      // HC1.2 / HC1.3: resolvable ONLY because the cell's current head (r1) is a proven numeric override — see the overrides below.
      [{ blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 source_record=r1 need_line=n1 reason=source_quantity_override_binding_invalid' }],
      [{ blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 source_record=r1 need_line=n1 reason=source_quantity_requires_explicit_numeric_override' }],
      [{ blocker: 'need_line_quantity_lineage_unsafe', detail: 'session=s1 source_record=r1 need_line=n1 reason=source_quantity_override_mismatch' }],
      [{ blocker: 'no_finalized_import', detail: null }],
    ];
    for (const blockers of solvable) {
      renderWorkspace(reviewed({
        readiness: blockedBy(...blockers), onExpertEscape: vi.fn(),
        overrides: [override('r1', 12, 'ov-r1')], overrideReadFailure: null,
      }));
      expect(stepOf(), JSON.stringify(blockers)).toBe('need-lines');
      expect(escape(), JSON.stringify(blockers)).toBeNull();
      cleanup();
    }
  });

  it('merely "not ready" — a plain blocker list with nothing outside Simple — is no reason to leave Simple', () => {
    renderWorkspace(reviewed({ readiness: readinessOf(false), onExpertEscape: vi.fn() }));
    expect(stepOf()).toBe('need-lines');
    expect(screen.getByTestId('cn2b-simple-readiness-messages')).toBeInTheDocument();
    expect(escape()).toBeNull();
  });

  for (const c of CASES) {
    it(`${c.name} — the escape is shown INSIDE the one task card, says why, and names the stage it opens`, () => {
      renderWorkspace(reviewed({ readiness: blockedBy(...c.blockers), onExpertEscape: vi.fn(), ...c.props }));
      expect(stepOf()).toBe('need-lines');
      const block = escape() as HTMLElement;
      expect(block).toBeInTheDocument();
      expect(block).toHaveAttribute('data-reason', c.reason);
      expect(block).toHaveAttribute('data-stage', c.stage);
      expect(block.closest('.cn2b-simple-card')).toBe(screen.getByTestId('cn2b-simple-pending'));
      expect(document.querySelectorAll('.cn2b-simple-card')).toHaveLength(1);
      // The sentence says why and names the stage; the button names the same stage.
      expect(block).toHaveTextContent(T[c.titleKey].en);
      expect(block).toHaveTextContent(T[c.bodyKey].en.replace('__STAGE__', stageTitle(c.stage, 'en')));
      expect(block.textContent).not.toContain('__STAGE__');
      const button = within(block).getByRole('button', { name: T.cn2b_simple_expert_open.en.replace('__STAGE__', stageTitle(c.stage, 'en')) });
      expect(button).toBe(openButton());
    });
  }

  it('H1-02C/D — the numeric-override escape opens the DATA REVIEW stage, once per click', () => {
    const onExpertEscape = vi.fn();
    renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC), onExpertEscape, ...NO_HEAD }));
    expect(onExpertEscape).not.toHaveBeenCalled(); // rendering opens nothing
    fireEvent.click(openButton() as HTMLElement);
    expect(onExpertEscape).toHaveBeenCalledTimes(1);
    expect(onExpertEscape).toHaveBeenCalledWith('review');
  });

  it('H1-02F — an open import attempt opens the SOURCE stage; it is shown on the need-lines step AND on the upload step (no completed session yet)', () => {
    const onExpertEscape = vi.fn();
    renderWorkspace(reviewed({ readiness: blockedBy(OPEN_IMPORT), onExpertEscape }));
    expect(stepOf()).toBe('need-lines');
    fireEvent.click(openButton() as HTMLElement);
    expect(onExpertEscape).toHaveBeenCalledWith('source');
    cleanup();

    onExpertEscape.mockClear();
    renderWorkspace(reviewed({
      activeSessionId: null, records: [], dispositions: [], beneficiaryColumns: [],
      readiness: blockedBy({ blocker: 'no_finalized_import', detail: null }, OPEN_IMPORT), onExpertEscape,
    }));
    expect(stepOf()).toBe('upload');
    const block = escape() as HTMLElement;
    expect(block.closest('.cn2b-simple-card')).toBe(screen.getByTestId('cn2b-simple-upload'));
    expect(block).toHaveAttribute('data-stage', 'source');
    fireEvent.click(openButton() as HTMLElement);
    expect(onExpertEscape).toHaveBeenCalledTimes(1);
    expect(onExpertEscape).toHaveBeenCalledWith('source');
  });

  it('H1-02G — an unknown blocker opens the READINESS stage, labelled as expert diagnosis and promising no resolution', () => {
    const onExpertEscape = vi.fn();
    renderWorkspace(reviewed({ readiness: blockedBy(UNKNOWN), onExpertEscape }));
    const block = escape() as HTMLElement;
    expect(block).toHaveTextContent(T.cn2b_simple_expert_title_unknown.en);
    expect(block).toHaveTextContent('does not guarantee');
    expect(block).not.toHaveTextContent(/will resolve|fix(es)? it|resolves? the/i);
    fireEvent.click(openButton() as HTMLElement);
    expect(onExpertEscape).toHaveBeenCalledWith('readiness');
  });

  it('it appears only where the person would otherwise be stuck — never while institutions or materials still need review', () => {
    for (const over of [
      { beneficiaryColumns: [{ ...decided, decision: null, beneficiaryOrganizationId: null, reviewRequired: true }] },
      { dispositions: [] },
    ] as Array<Partial<WorkspaceProps>>) {
      renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC, OPEN_IMPORT, UNKNOWN), onExpertEscape: vi.fn(), ...over }));
      expect(['review-institution', 'review-material']).toContain(stepOf());
      expect(escape()).toBeNull();
      cleanup();
    }
  });

  it('when several apply the earliest stage wins; once that one is resolved the next appears', () => {
    const { rerenderWith } = renderWorkspace(reviewed({ readiness: blockedBy(UNKNOWN, NUMERIC, OPEN_IMPORT), onExpertEscape: vi.fn(), ...NO_HEAD }));
    expect(escape()).toHaveAttribute('data-stage', 'source');
    rerenderWith({ readiness: blockedBy(UNKNOWN, NUMERIC) });
    expect(escape()).toHaveAttribute('data-stage', 'review');
    rerenderWith({ readiness: blockedBy(UNKNOWN) });
    expect(escape()).toHaveAttribute('data-stage', 'readiness');
    rerenderWith({ readiness: blockedBy({ blocker: 'mapped_target_entity_without_need_line', detail: null }) });
    expect(escape()).toBeNull();
  });

  it('never for a closed revision, never from another revision\'s readiness, never without a callback to act with', () => {
    // A submitted revision's blockers are informational: its outcome is the closed card.
    renderWorkspace(reviewed({
      revision: revisionOf('submitted'), isDraft: false, readiness: { ...blockedBy(NUMERIC), status: 'submitted' }, onExpertEscape: vi.fn(),
    }));
    expect(stepOf()).toBe('pending');
    expect(escape()).toBeNull();
    cleanup();
    // A readiness that belongs to another revision is not evidence about this one.
    renderWorkspace(reviewed({ readiness: { ...blockedBy(NUMERIC), planRevisionId: 'rev-other' }, onExpertEscape: vi.fn() }));
    expect(escape()).toBeNull();
    cleanup();
    // Without a callback the control could not act, so it is not offered.
    renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC) }));
    expect(escape()).toBeNull();
    cleanup();
    // While the active session's rows are still loading nothing is acted on.
    renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC), onExpertEscape: vi.fn(), sessionLoading: true }));
    expect(stepOf()).toBe('analyzing');
    expect(escape()).toBeNull();
  });

  it('H1-02I — while a write is in flight the button is disabled and cannot act', () => {
    const onExpertEscape = vi.fn();
    renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC), onExpertEscape, busy: true, activity: 'submitting', ...NO_HEAD }));
    expect(stepOf()).toBe('need-lines'); // a lifecycle action never sends the page to "analyzing"
    expect(openButton()).toBeDisabled();
    fireEvent.click(openButton() as HTMLElement);
    expect(onExpertEscape).not.toHaveBeenCalled();
  });

  it('the stage opens only for someone who holds the permission its own controls need — anyone else is told, not stranded', () => {
    const onExpertEscape = vi.fn();
    // The numeric correction is an EDIT (the data review table's gate), not an import…
    renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC), onExpertEscape, canEdit: false, canImport: true, ...NO_HEAD }));
    expect(openButton()).toBeNull();
    expect(screen.getByTestId('cn2b-simple-expert-no-permission')).toHaveTextContent(T.cn2b_simple_expert_no_permission.en);
    expect(escape()).toHaveTextContent(T.cn2b_simple_expert_title.en); // the why is still told
    cleanup();
    renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC), onExpertEscape, canEdit: true, canImport: false, ...NO_HEAD }));
    expect(openButton()).not.toBeNull();
    cleanup();
    // …abandoning an import attempt is an IMPORT (the source stage's gate)…
    renderWorkspace(reviewed({ readiness: blockedBy(OPEN_IMPORT), onExpertEscape, canEdit: true, canImport: false }));
    expect(openButton()).toBeNull();
    expect(screen.getByTestId('cn2b-simple-expert-no-permission')).toBeInTheDocument();
    cleanup();
    renderWorkspace(reviewed({ readiness: blockedBy(OPEN_IMPORT), onExpertEscape, canEdit: false, canImport: true }));
    expect(openButton()).not.toBeNull();
    cleanup();
    // …and reading the server's own answer needs neither.
    renderWorkspace(reviewed({ readiness: blockedBy(UNKNOWN), onExpertEscape, canEdit: false, canImport: false }));
    expect(openButton()).not.toBeNull();
    fireEvent.click(openButton() as HTMLElement);
    expect(onExpertEscape).toHaveBeenCalledWith('readiness');
    // Nobody clicked a withheld control.
    expect(onExpertEscape).toHaveBeenCalledTimes(1);
  });

  it('H1-02M — it is the ONLY way out: no footer, no generic Advanced link, exactly one button into Advanced, in every escape case', () => {
    for (const c of CASES) {
      const { container } = renderWorkspace(reviewed({ readiness: blockedBy(...c.blockers), onExpertEscape: vi.fn(), ...c.props }));
      const page = screen.getByTestId('cn2b-simple-workspace');
      expect(container.querySelector('footer'), c.name).toBeNull();
      for (const id of ['cn2b-simple-advanced-link', 'cn2b-simple-continue-advanced', 'cn2b-simple-handoff']) {
        expect(screen.queryByTestId(id), `${c.name}: ${id}`).toBeNull();
      }
      expect(page.textContent ?? '', c.name).not.toMatch(/Advanced options|advanced options|خيارات متقدمة|الخيارات المتقدمة/);
      expect(screen.getAllByTestId('cn2b-simple-expert-open'), c.name).toHaveLength(1);
      expect(within(page).getAllByRole('button').filter((b) => /expert|Open the “/i.test(b.textContent ?? '')), c.name).toHaveLength(1);
      cleanup();
    }
  });

  for (const lang of ['ar', 'en'] as const) {
    it(`H1-02O — ${lang}: every case renders its own copy in ${lang === 'ar' ? 'Arabic, RTL' : 'English, LTR'}, naming the stage with no placeholder left`, () => {
      for (const c of CASES) {
        renderWorkspace(reviewed({ lang, readiness: blockedBy(...c.blockers), onExpertEscape: vi.fn(), ...c.props }));
        const page = screen.getByTestId('cn2b-simple-workspace');
        expect(page).toHaveAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
        const block = escape() as HTMLElement;
        const stage = stageTitle(c.stage, lang);
        expect(block, c.name).toHaveTextContent(T[c.titleKey][lang]);
        expect(block, c.name).toHaveTextContent(T[c.bodyKey][lang].replace('__STAGE__', stage));
        expect(within(block).getByRole('button', { name: T.cn2b_simple_expert_open[lang].replace('__STAGE__', stage) }), c.name).toBeInTheDocument();
        expect(block.textContent, c.name).not.toContain('__STAGE__');
        if (lang === 'ar') expect(block.textContent, c.name).toMatch(/[؀-ۿ]/);
        cleanup();
      }
    });
  }

  it('the copy exists in both languages, never reuses the generic "Advanced" wording, and the two switch guards have their own words', () => {
    const keys = [
      'cn2b_simple_expert_title', 'cn2b_simple_expert_title_unknown', 'cn2b_simple_expert_body_numeric_override',
      'cn2b_simple_expert_body_open_import', 'cn2b_simple_expert_body_unknown', 'cn2b_simple_expert_open',
      'cn2b_simple_expert_no_permission', 'cn2b_expert_switch_confirm', 'cn2b_expert_switch_blocked',
      // HC1.1
      'cn2b_simple_expert_body_source_evidence_invalid', 'cn2b_simple_expert_body_override_head_unproven', 'cn2b_simple_expert_body_unknown_lineage',
    ];
    for (const key of keys) {
      expect(T[key], key).toBeDefined();
      expect(T[key].ar, key).toMatch(/[؀-ۿ]/);
      expect(T[key].en.trim(), key).not.toBe('');
      expect(T[key].ar, key).not.toBe(T[key].en);
      for (const lang of ['ar', 'en'] as const) {
        expect(T[key][lang], `${key}.${lang}`).not.toMatch(/Advanced options|advanced options|خيارات متقدمة|الخيارات المتقدمة/);
      }
    }
    // The open-import sentence names the real control's own word, in both languages ('إنهاء المحاولة' / 'Abandon attempt').
    expect(T.cn2b_abandon.ar).toContain('إنهاء');
    expect(T.cn2b_simple_expert_body_open_import.ar).toContain('إنهاؤها');
    expect(T.cn2b_abandon.en).toMatch(/Abandon/);
    expect(T.cn2b_simple_expert_body_open_import.en).toMatch(/abandoned/);
    // The spec's own wording for the headline sentence.
    expect(T.cn2b_simple_expert_title.en).toBe('This issue requires expert review tools');
    expect(T.cn2b_simple_expert_title.ar).toBe('تحتاج هذه المشكلة إلى أدوات المراجعة المتقدمة');
    // The switch is not a "change revision", so it must not borrow that copy.
    expect(T.cn2b_expert_switch_confirm.en).not.toBe(T.cn2b_revision_context_change_confirm.en);
    expect(T.cn2b_expert_switch_blocked.en).not.toBe(T.cn2b_revision_context_change_blocked.en);
    expect(T.cn2b_expert_switch_confirm.en).not.toMatch(/revision/i);
  });

  it('accessibility — a labelled group, a real keyboard-focusable button described by the sentence that explains it', () => {
    renderWorkspace(reviewed({ readiness: blockedBy(NUMERIC), onExpertEscape: vi.fn(), ...NO_HEAD }));
    const block = escape() as HTMLElement;
    const group = screen.getByRole('group', { name: T.cn2b_simple_expert_title.en });
    expect(group).toBe(block);
    const button = openButton() as HTMLButtonElement;
    expect(button.tagName).toBe('BUTTON');
    expect(button.type).toBe('button');
    expect(button).toHaveAccessibleName(T.cn2b_simple_expert_open.en.replace('__STAGE__', T.cn2b_stage_review.en));
    expect(button).toHaveAccessibleDescription(T.cn2b_simple_expert_body_numeric_override.en.replace('__STAGE__', T.cn2b_stage_review.en));
    button.focus();
    expect(document.activeElement).toBe(button);
    // It is not an alert: the blockers above it are the status; this is an offer.
    expect(block.getAttribute('role')).toBe('group');
    expect(within(block).queryByRole('alert')).toBeNull();
  });
});

// ============================================================================
// CN-UI-S1 HC1 — review follow-ups: the escape offered is the one the person
// can ACT on, and no control into Advanced exists under any other label.
// ============================================================================
describe('CN-UI-S1 HC1 · which escape is offered, and that it is the ONLY control into Advanced', () => {
  const OPEN_IMPORT = { blocker: 'import_session_still_open', detail: 'session=s9 status=processing' };
  const NUMERIC = {
    blocker: 'need_line_quantity_lineage_unsafe',
    detail: 'session=s1 source_record=r-row-5 need_line=n1 reason=source_quantity_requires_explicit_numeric_override',
  };
  const UNKNOWN = { blocker: 'brand_new_server_code_this_build_has_never_seen', detail: null };
  const blockedBy = (...blockers: ReviewReadiness['blockers']): ReviewReadiness => ({
    planRevisionId: 'rev-1', status: 'draft', ready: false, blockers,
  });
  const escape = () => screen.queryByTestId('cn2b-simple-expert-escape');
  const openButton = () => screen.queryByTestId('cn2b-simple-expert-open');
  const BANNED = /advanced|expert|متقدم|خبير/i;
  // HC1.3: a complete override chain in which the cell has no head — the numeric-required row then needs a numeric correction (REVIEW).
  const NO_HEAD: Partial<WorkspaceProps> = { overrides: [], overrideReadFailure: null };

  it('with both an open import and a numeric correction pending, someone who can only EDIT is offered the data review stage, not a stage they cannot use', () => {
    const onExpertEscape = vi.fn();
    renderWorkspace(reviewed({ readiness: blockedBy(OPEN_IMPORT, NUMERIC), ...NO_HEAD, onExpertEscape, canEdit: true, canImport: false }));
    expect(escape()).toHaveAttribute('data-stage', 'review');
    fireEvent.click(openButton() as HTMLElement);
    expect(onExpertEscape).toHaveBeenCalledWith('review');
    cleanup();

    onExpertEscape.mockClear();
    renderWorkspace(reviewed({ readiness: blockedBy(OPEN_IMPORT, NUMERIC), ...NO_HEAD, onExpertEscape, canEdit: false, canImport: true }));
    expect(escape()).toHaveAttribute('data-stage', 'source');
    fireEvent.click(openButton() as HTMLElement);
    expect(onExpertEscape).toHaveBeenCalledWith('source');
    cleanup();

    // Someone who can do both gets the earliest stage, as always.
    renderWorkspace(reviewed({ readiness: blockedBy(OPEN_IMPORT, NUMERIC), ...NO_HEAD, onExpertEscape, canEdit: true, canImport: true }));
    expect(escape()).toHaveAttribute('data-stage', 'source');
  });

  it('when the person can act on none of them, the first is shown with who to ask — never a button they cannot use', () => {
    renderWorkspace(reviewed({ readiness: blockedBy(OPEN_IMPORT, NUMERIC), ...NO_HEAD, onExpertEscape: vi.fn(), canEdit: false, canImport: false }));
    expect(escape()).toHaveAttribute('data-stage', 'source');
    expect(openButton()).toBeNull();
    expect(screen.getByTestId('cn2b-simple-expert-no-permission')).toBeInTheDocument();
    cleanup();
    // Reading the server's own answer needs no permission, so an unknown blocker is always actable.
    renderWorkspace(reviewed({ readiness: blockedBy(OPEN_IMPORT, UNKNOWN), onExpertEscape: vi.fn(), canEdit: false, canImport: false }));
    expect(escape()).toHaveAttribute('data-stage', 'readiness');
    expect(openButton()).not.toBeNull();
  });

  const NO_ESCAPE_STATES: Array<[string, Partial<WorkspaceProps>]> = [
    ['upload', { revision: null, isDraft: false }],
    ['analyzing', { busy: true, activity: 'verifying' }],
    ['institution review', { beneficiaryColumns: [{ ...decided, decision: null, beneficiaryOrganizationId: null, reviewRequired: true }] }],
    ['material review', { dispositions: [] }],
    ['need lines, a blocker Simple resolves', {}],
    ['the ready outcome', { readiness: readinessOf(true) }],
    ['a closed revision', { revision: revisionOf('approved'), isDraft: false }],
    ['a closed revision with the server\'s numeric blocker', { revision: revisionOf('submitted'), isDraft: false, readiness: { ...blockedBy(NUMERIC), status: 'submitted' } }],
    ['rows still loading', { sessionLoading: true }],
  ];
  const controlsOf = (root: HTMLElement) => [...root.querySelectorAll<HTMLElement>('button, a[href], [role="button"], [role="link"], [role="switch"], [role="menuitem"], [role="tab"]')];
  const nameOf = (el: HTMLElement) => `${el.getAttribute('aria-label') ?? ''} ${el.textContent ?? ''} ${el.getAttribute('title') ?? ''}`;

  for (const lang of ['ar', 'en'] as const) {
    it(`${lang}: with the callback wired, NO control on any Simple state leads to Advanced under any label — none is named for it, none ever calls it`, () => {
      for (const [name, over] of NO_ESCAPE_STATES) {
        const onExpertEscape = vi.fn();
        const { container } = renderWorkspace(reviewed({ lang, onExpertEscape, ...over }));
        const page = screen.getByTestId('cn2b-simple-workspace');
        expect(escape(), name).toBeNull();
        const controls = controlsOf(page);
        for (const control of controls) expect(nameOf(control), `${name}: ${control.outerHTML.slice(0, 80)}`).not.toMatch(BANNED);
        // Press every enabled control the page offers: none of them may reach the escape callback.
        for (const control of controls) if (!(control as HTMLButtonElement).disabled) fireEvent.click(control);
        expect(onExpertEscape, name).not.toHaveBeenCalled();
        expect(container.querySelector('footer'), name).toBeNull();
        cleanup();
      }
    });
  }

  it('where the escape applies, the callback is reachable ONLY through its own button — every other control leaves it uncalled', () => {
    for (const blockers of [[NUMERIC], [OPEN_IMPORT], [UNKNOWN]]) {
      const onExpertEscape = vi.fn();
      renderWorkspace(reviewed({ readiness: blockedBy(...blockers), onExpertEscape, ...NO_HEAD }));
      const page = screen.getByTestId('cn2b-simple-workspace');
      const mine = openButton() as HTMLElement;
      const others = controlsOf(page).filter((c) => c !== mine);
      for (const control of others) expect(nameOf(control), control.outerHTML.slice(0, 80)).not.toMatch(BANNED);
      for (const control of others) if (!(control as HTMLButtonElement).disabled) fireEvent.click(control);
      expect(onExpertEscape).not.toHaveBeenCalled();
      fireEvent.click(mine);
      expect(onExpertEscape).toHaveBeenCalledTimes(1);
      cleanup();
    }
  });

  it('the stage the escape names comes from the stage titles themselves — independent of the escape copy table', () => {
    const STAGES = { source: { ar: 'المصدر والاستيراد', en: 'Source and import' }, review: { ar: 'مراجعة البيانات', en: 'Data review' }, readiness: { ar: 'الجاهزية والاعتماد', en: 'Readiness and approval' } } as const;
    const BLOCKERS = { source: OPEN_IMPORT, review: NUMERIC, readiness: UNKNOWN } as const;
    for (const lang of ['ar', 'en'] as const) {
      for (const stage of ['source', 'review', 'readiness'] as const) {
        renderWorkspace(reviewed({ lang, readiness: blockedBy(BLOCKERS[stage]), onExpertEscape: vi.fn(), ...NO_HEAD }));
        // Literal titles, so an edit that drops the stage from the copy cannot be satisfied by the same edit to the table.
        expect(openButton(), `${lang}/${stage}`).toHaveTextContent(STAGES[stage][lang]);
        expect(screen.getByTestId('cn2b-simple-expert-escape'), `${lang}/${stage}`).toHaveTextContent(STAGES[stage][lang]);
        cleanup();
      }
    }
    for (const key of ['cn2b_simple_expert_open', 'cn2b_simple_expert_body_numeric_override', 'cn2b_simple_expert_body_open_import', 'cn2b_simple_expert_body_unknown']) {
      for (const lang of ['ar', 'en'] as const) expect(T[key][lang], `${key}.${lang}`).toContain('__STAGE__');
    }
  });
});
