/**
 * E2-C — the Multi-Institution Mapping panel.
 *
 * Where the HUMAN declares, for the sheet open in the trusted source viewer,
 * each institution the sheet carries Need quantities for: the cell with its
 * name, its Need column or range, and which MediStock care institution it is.
 * Presentational: it renders the state held by `useInstitutionMapping` and
 * reports which button was pressed or which list option was chosen — never a
 * coordinate. Every judgement (can this selection be used, is an entry valid,
 * what conflicts) comes from the pure functions in `institutionMapping.ts`.
 *
 * NOTHING IS INFERRED. The panel receives no workbook data: no cell, header or
 * value reaches it, so it cannot propose an institution from what the workbook
 * says. The beneficiary list starts on "choose", even when it has one option,
 * and its options are the trusted organization rows the screen loaded — ids
 * from MediStock, names shown only as labels.
 *
 * It sits beside the E2-B panel and owns every word about institutions.
 */
import { useEffect, useId, useMemo, useRef } from 'react';
import { t, type Lang } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixSelect } from '@/shared/ui/PhoenixSelect';
import { a1Address, columnLetters } from '../excel-first/excelViewerModel';
import type { WorkbookSelection } from '../excel-first/workbookSelection';
import {
  anchorFromSelection,
  checkInstitutionMapping,
  draftCandidate,
  evaluateInstitutionMappings,
  needFromSelection,
  type InstitutionAnchor,
  type InstitutionMappingFailure,
  type InstitutionOutcome,
  type InstitutionProblem,
  type NeedSource,
} from './institutionMapping';
import type { SheetMappingProfile } from './sheetMappingProfile';
import type { InstitutionMappingController } from './useInstitutionMapping';

/** A trusted organization row, structurally (the screen passes its active care institutions). */
export interface BeneficiaryChoice {
  id: string;
  name: string;
  name_ar: string;
  code: string;
}

interface Props {
  lang: Lang;
  controller: InstitutionMappingController;
  /** E2-B's profile for the same sheet: read for the role-column checks, never changed here. */
  profile: SheetMappingProfile | null;
  beneficiaries: readonly BeneficiaryChoice[];
}

const WHY: Record<InstitutionMappingFailure, string> = {
  NO_TRUSTED_SELECTION: 'cn2b_inst_why_no_selection',
  INVALID_SELECTION: 'cn2b_inst_why_invalid',
  INVALID_CONTEXT: 'cn2b_inst_why_invalid',
  INVALID_MAPPING: 'cn2b_inst_why_invalid',
  SOURCE_MISMATCH: 'cn2b_inst_why_source',
  SHEET_MISMATCH: 'cn2b_inst_why_sheet',
  ANCHOR_NOT_CELL_OR_RANGE: 'cn2b_inst_why_anchor_kind',
  NEED_NOT_COLUMN_OR_RANGE: 'cn2b_inst_why_need_kind',
  INCOMPLETE_MAPPING: 'cn2b_inst_why_incomplete',
  BENEFICIARY_NOT_ELIGIBLE: 'cn2b_inst_why_not_eligible',
  PROFILE_MISMATCH: 'cn2b_inst_why_profile',
  NEED_IS_NATIONAL_CODE_COLUMN: 'cn2b_inst_why_national_code',
  NEED_IS_MATERIAL_COLUMN: 'cn2b_inst_why_material',
  DUPLICATE_MAPPING: 'cn2b_inst_why_duplicate',
  NEED_OVERLAP: 'cn2b_inst_why_need_overlap',
  ANCHOR_IN_OWN_NEED: 'cn2b_inst_why_anchor_in_own_need',
  ANCHOR_OVERLAP: 'cn2b_inst_why_anchor_overlap',
  ANCHOR_IN_NEED: 'cn2b_inst_why_anchor_in_need',
  NEED_COVERS_ANCHOR: 'cn2b_inst_why_need_covers_anchor',
  UNKNOWN_MAPPING: 'cn2b_inst_why_unknown',
};

type Form = 'title' | 'inline';
const CELL_KEY: Record<Form, string> = { title: 'cn2b_map_cell', inline: 'cn2b_inst_sel_cell' };
const RANGE_KEY: Record<Form, string> = { title: 'cn2b_map_range', inline: 'cn2b_inst_sel_range' };
const COLUMN_KEY: Record<Form, string> = { title: 'cn2b_map_column', inline: 'cn2b_inst_sel_column' };

const rangeRef = (r0: number, c0: number, r1: number, c1: number) => `${a1Address(r0, c0)}:${a1Address(r1, c1)}`;

function anchorText(anchor: InstitutionAnchor, lang: Lang, form: Form): string {
  if (anchor.kind === 'range') {
    return t(RANGE_KEY[form], lang).replace('__REF__', rangeRef(anchor.startRow, anchor.startColumn, anchor.endRow, anchor.endColumn));
  }
  const cell = t(CELL_KEY[form], lang).replace('__REF__', a1Address(anchor.rowIndex, anchor.columnIndex));
  return anchor.mergedRange === null ? cell : `${cell} ${t('cn2b_inst_merged', lang).replace('__REF__', anchor.mergedRange)}`;
}

function needText(need: NeedSource, lang: Lang, form: Form): string {
  if (need.kind === 'column') return t(COLUMN_KEY[form], lang).replace('__COL__', columnLetters(need.columnIndex));
  return t(RANGE_KEY[form], lang).replace('__REF__', rangeRef(need.startRow, need.startColumn, need.endRow, need.endColumn));
}

function selectionText(selection: WorkbookSelection, lang: Lang, form: Form): string {
  if (selection.kind === 'column') return t(COLUMN_KEY[form], lang).replace('__COL__', columnLetters(selection.columnIndex));
  if (selection.kind === 'cell') return t(CELL_KEY[form], lang).replace('__REF__', selection.a1);
  return t(RANGE_KEY[form], lang).replace('__REF__', selection.a1Range);
}

export function InstitutionMappingPanel({ lang, controller, profile, beneficiaries }: Props) {
  const idPrefix = useId();
  const sectionRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const editorTitleRef = useRef<HTMLHeadingElement>(null);
  const listTitleRef = useRef<HTMLHeadingElement>(null);
  const { state } = controller;
  const { context, selection, mappings, draft, resetPending, outcome, outcomeSeq } = state;
  const ready = context !== null && selection !== null;
  const editing = draft.editingId !== null;
  const ids = {
    title: `${idPrefix}-title`,
    editor: `${idPrefix}-editor`,
    list: `${idPrefix}-list`,
    anchorHint: `${idPrefix}-anchor-hint`,
    needHint: `${idPrefix}-need-hint`,
    commitHint: `${idPrefix}-commit-hint`,
    resetText: `${idPrefix}-reset-text`,
  };

  const byId = useMemo(() => new Map(beneficiaries.map((b) => [b.id, b] as const)), [beneficiaries]);
  const eligibleBeneficiaryIds = useMemo(() => beneficiaries.map((b) => b.id), [beneficiaries]);
  const checks = { profile, eligibleBeneficiaryIds };

  const orgName = (id: string): string => {
    const org = byId.get(id);
    if (!org) return t('cn2b_inst_unknown_org', lang).replace('__ID__', id);
    return (lang === 'ar' ? org.name_ar || org.name : org.name || org.name_ar);
  };
  const entryName = (entryId: string | undefined): string => {
    const entry = mappings.find((m) => m.id === entryId);
    return entry ? orgName(entry.beneficiaryOrganizationId) : '';
  };
  const whyText = (problem: InstitutionProblem): string =>
    t(WHY[problem.reason], lang).replace('__NAME__', entryName(problem.conflictId));

  // What the current selection can be used for — decided by the domain, not here.
  const anchorCheck = ready ? anchorFromSelection(context, selection) : null;
  const needCheck = ready ? needFromSelection(context, selection) : null;
  const drafted = draftCandidate(state);
  const draftProblem = drafted.ok && context ? checkInstitutionMapping({ context, ...checks }, drafted.candidate, mappings) : null;
  const statuses = context ? evaluateInstitutionMappings({ context, ...checks }, mappings) : [];

  const options = [
    { value: '', label: t('cn2b_inst_choose', lang) },
    ...beneficiaries.map((b) => ({ value: b.id, label: b.code ? `${orgName(b.id)} — ${b.code}` : orgName(b.id) })),
    ...(draft.beneficiaryOrganizationId !== null && !byId.has(draft.beneficiaryOrganizationId)
      ? [{ value: draft.beneficiaryOrganizationId, label: orgName(draft.beneficiaryOrganizationId) }]
      : []),
  ];

  const message = outcome ? outcomeMessage(outcome) : null;
  function outcomeMessage(o: InstitutionOutcome): { tone: 'status' | 'alert'; text: string } {
    switch (o.kind) {
      case 'anchor_set':
        return { tone: 'status', text: t('cn2b_inst_done_anchor', lang).replace('__SEL__', anchorText(o.anchor, lang, 'inline')) };
      case 'need_set':
        return { tone: 'status', text: t('cn2b_inst_done_need', lang).replace('__SEL__', needText(o.need, lang, 'inline')) };
      case 'added':
        return { tone: 'status', text: t('cn2b_inst_done_added', lang).replace('__NAME__', orgName(o.beneficiaryOrganizationId)) };
      case 'updated':
        return { tone: 'status', text: t('cn2b_inst_done_updated', lang).replace('__NAME__', orgName(o.beneficiaryOrganizationId)) };
      case 'removed':
        return { tone: 'status', text: t('cn2b_inst_done_removed', lang).replace('__NAME__', orgName(o.beneficiaryOrganizationId)) };
      case 'editing':
        return { tone: 'status', text: t('cn2b_inst_done_editing', lang).replace('__NAME__', orgName(o.beneficiaryOrganizationId)) };
      case 'draft_cleared':
        return { tone: 'status', text: t('cn2b_inst_done_cleared', lang) };
      case 'reset':
        return { tone: 'status', text: t('cn2b_inst_done_reset', lang).replace('__N__', String(o.removed)) };
      case 'refused':
        return { tone: 'alert', text: `${whyText(o)} ${t('cn2b_inst_nothing_changed', lang)}` };
    }
  }

  // Keep keyboard focus on a live control when the control that was used
  // disappears. Every outcome is a new object, so only a new outcome moves focus.
  useEffect(() => {
    if (!outcome) return;
    if (outcome.kind === 'added' || outcome.kind === 'updated' || outcome.kind === 'editing' || outcome.kind === 'draft_cleared') {
      editorTitleRef.current?.focus();
    } else if (outcome.kind === 'removed') {
      listTitleRef.current?.focus();
    } else if (outcome.kind === 'reset') {
      titleRef.current?.focus();
    }
  }, [outcome]);
  const pendingBefore = useRef(resetPending);
  useEffect(() => {
    if (pendingBefore.current === resetPending) return;
    pendingBefore.current = resetPending;
    const target = resetPending ? 'cn2b-instmap-reset-keep' : 'cn2b-instmap-reset';
    sectionRef.current?.querySelector<HTMLButtonElement>(`[data-testid="${target}"]`)?.focus();
  }, [resetPending]);

  return (
    <section
      ref={sectionRef}
      className="cn2b-instmap"
      aria-labelledby={ids.title}
      lang={lang}
      dir={lang === 'ar' ? 'rtl' : 'ltr'}
      data-testid="cn2b-instmap-panel"
      data-instmap-state={ready ? 'ready' : 'unavailable'}
    >
      <p className="cn2b-instmap__eyebrow">
        <PhoenixIcon name="lock" size={14} inline aria-hidden="true" /> {t('cn2b_map_eyebrow', lang)}
      </p>
      <h2 className="cn2b-instmap__title" id={ids.title} ref={titleRef} tabIndex={-1}>{t('cn2b_inst_title', lang)}</h2>
      <p className="cn2b-instmap__lead">{t('cn2b_inst_lead', lang)}</p>

      {!ready && (
        <p className="cn2b-instmap__hint" role="status" data-testid="cn2b-instmap-unavailable">{t('cn2b_inst_unavailable', lang)}</p>
      )}

      {ready && (
        <section className="cn2b-instmap__editor" aria-labelledby={ids.editor} data-testid="cn2b-instmap-editor" data-mode={editing ? 'edit' : 'add'}>
          <h3 className="cn2b-instmap__subtitle" id={ids.editor} ref={editorTitleRef} tabIndex={-1}>
            {t(editing ? 'cn2b_inst_editor_edit' : 'cn2b_inst_editor_new', lang)}
          </h3>
          <p className="cn2b-instmap__hint" data-testid="cn2b-instmap-selected">
            {t('cn2b_map_selected', lang)}: <bdi>{selectionText(selection, lang, 'title')}</bdi>
          </p>

          <div className="cn2b-instmap__part" data-testid="cn2b-instmap-part-anchor">
            <p className="cn2b-instmap__part-name">{t('cn2b_inst_part_anchor', lang)}</p>
            <p className="cn2b-instmap__part-value" data-testid="cn2b-instmap-draft-anchor" data-set={draft.anchor ? 'true' : 'false'}>
              {draft.anchor ? <bdi>{anchorText(draft.anchor, lang, 'title')}</bdi> : <span className="cn2b-instmap__unset">{t('cn2b_inst_not_set', lang)}</span>}
            </p>
            <PhoenixButton
              type="button"
              variant="secondary"
              size="sm"
              disabled={!anchorCheck?.ok}
              aria-describedby={anchorCheck?.ok ? undefined : ids.anchorHint}
              onClick={controller.captureAnchor}
              data-testid="cn2b-instmap-capture-anchor"
              style={{ whiteSpace: 'normal', textAlign: 'start' }}
            >
              {anchorCheck?.ok
                ? t('cn2b_inst_use_anchor', lang).replace('__SEL__', anchorText(anchorCheck.anchor, lang, 'inline'))
                : t('cn2b_inst_use_anchor_idle', lang)}
            </PhoenixButton>
            {anchorCheck && !anchorCheck.ok && (
              <p className="cn2b-instmap__hint" id={ids.anchorHint} data-testid="cn2b-instmap-anchor-hint">
                {t(WHY[anchorCheck.reason], lang)}
              </p>
            )}
          </div>

          <div className="cn2b-instmap__part" data-testid="cn2b-instmap-part-need">
            <p className="cn2b-instmap__part-name">{t('cn2b_inst_part_need', lang)}</p>
            <p className="cn2b-instmap__part-value" data-testid="cn2b-instmap-draft-need" data-set={draft.need ? 'true' : 'false'}>
              {draft.need ? <bdi>{needText(draft.need, lang, 'title')}</bdi> : <span className="cn2b-instmap__unset">{t('cn2b_inst_not_set', lang)}</span>}
            </p>
            <PhoenixButton
              type="button"
              variant="secondary"
              size="sm"
              disabled={!needCheck?.ok}
              aria-describedby={needCheck?.ok ? undefined : ids.needHint}
              onClick={controller.captureNeed}
              data-testid="cn2b-instmap-capture-need"
              style={{ whiteSpace: 'normal', textAlign: 'start' }}
            >
              {needCheck?.ok
                ? t('cn2b_inst_use_need', lang).replace('__SEL__', needText(needCheck.need, lang, 'inline'))
                : t('cn2b_inst_use_need_idle', lang)}
            </PhoenixButton>
            {needCheck && !needCheck.ok && (
              <p className="cn2b-instmap__hint" id={ids.needHint} data-testid="cn2b-instmap-need-hint">
                {t(WHY[needCheck.reason], lang)}
              </p>
            )}
          </div>

          <div className="cn2b-instmap__part" data-testid="cn2b-instmap-part-beneficiary">
            <PhoenixSelect
              label={t('cn2b_inst_part_beneficiary', lang)}
              options={options}
              value={draft.beneficiaryOrganizationId ?? ''}
              onChange={(e) => controller.chooseBeneficiary(e.target.value === '' ? null : e.target.value)}
              data-testid="cn2b-instmap-beneficiary"
            />
            {beneficiaries.length === 0 && (
              <p className="cn2b-instmap__hint" data-testid="cn2b-instmap-no-beneficiaries">{t('cn2b_inst_no_beneficiaries', lang)}</p>
            )}
          </div>

          {!drafted.ok && (
            <p className="cn2b-instmap__hint" id={ids.commitHint} data-testid="cn2b-instmap-incomplete">{t('cn2b_inst_why_incomplete', lang)}</p>
          )}
          {draftProblem && (
            <p className="cn2b-instmap__problem" id={ids.commitHint} data-testid="cn2b-instmap-draft-problem">
              <PhoenixIcon name="warning" size={14} inline aria-hidden="true" /> {whyText(draftProblem)}
            </p>
          )}
          <div className="cn2b-instmap__actions" role="group" aria-label={t(editing ? 'cn2b_inst_editor_edit' : 'cn2b_inst_editor_new', lang)}>
            <PhoenixButton
              type="button"
              variant="primary"
              size="sm"
              disabled={!drafted.ok}
              aria-describedby={!drafted.ok || draftProblem ? ids.commitHint : undefined}
              onClick={() => controller.commit(checks)}
              data-testid="cn2b-instmap-commit"
            >
              {t(editing ? 'cn2b_inst_apply' : 'cn2b_inst_add', lang)}
            </PhoenixButton>
            {(editing || draft.anchor || draft.need || draft.beneficiaryOrganizationId) && (
              <PhoenixButton type="button" variant="ghost" size="sm" onClick={controller.cancelEdit} data-testid="cn2b-instmap-cancel">
                {t(editing ? 'cn2b_inst_cancel_edit' : 'cn2b_inst_clear_draft', lang)}
              </PhoenixButton>
            )}
          </div>
        </section>
      )}

      <h3 className="cn2b-instmap__subtitle" id={ids.list} ref={listTitleRef} tabIndex={-1} data-testid="cn2b-instmap-list-title">
        {t('cn2b_inst_list_title', lang).replace('__N__', String(mappings.length))}
      </h3>
      {mappings.length === 0 ? (
        <p className="cn2b-instmap__hint" data-testid="cn2b-instmap-empty">{t('cn2b_inst_list_empty', lang)}</p>
      ) : (
        <ol className="cn2b-instmap__list" aria-labelledby={ids.list} data-testid="cn2b-instmap-list">
          {mappings.map((entry) => {
            const problems = statuses.find((s) => s.id === entry.id)?.problems ?? [];
            const name = orgName(entry.beneficiaryOrganizationId);
            const code = byId.get(entry.beneficiaryOrganizationId)?.code ?? '';
            return (
              <li
                key={entry.id}
                className="cn2b-instmap__item"
                data-testid="cn2b-instmap-item"
                data-mapping-id={entry.id}
                data-beneficiary-id={entry.beneficiaryOrganizationId}
                data-valid={problems.length === 0 ? 'true' : 'false'}
                data-editing={draft.editingId === entry.id ? 'true' : 'false'}
              >
                <p className="cn2b-instmap__item-name" data-testid="cn2b-instmap-item-name">
                  <PhoenixIcon name="hospital" size={15} inline aria-hidden="true" /> <bdi>{name}</bdi>
                  {code && <span className="cn2b-instmap__code"><bdi>{code}</bdi></span>}
                </p>
                <dl className="cn2b-instmap__facts">
                  <div className="cn2b-instmap__fact">
                    <dt>{t('cn2b_inst_item_anchor', lang)}</dt>
                    <dd data-testid="cn2b-instmap-item-anchor"><bdi>{anchorText(entry.anchor, lang, 'title')}</bdi></dd>
                  </div>
                  <div className="cn2b-instmap__fact">
                    <dt>{t('cn2b_inst_item_need', lang)}</dt>
                    <dd data-testid="cn2b-instmap-item-need"><bdi>{needText(entry.need, lang, 'title')}</bdi></dd>
                  </div>
                </dl>
                {problems.length === 0 ? (
                  <p className="cn2b-instmap__valid" data-testid="cn2b-instmap-item-status">
                    <PhoenixIcon name="check" size={14} inline aria-hidden="true" /> {t('cn2b_inst_item_valid', lang)}
                  </p>
                ) : (
                  <div className="cn2b-instmap__problem" data-testid="cn2b-instmap-item-status">
                    <p className="cn2b-instmap__problem-title">
                      <PhoenixIcon name="warning" size={14} inline aria-hidden="true" /> {t('cn2b_inst_item_problem', lang)}
                    </p>
                    <ul className="cn2b-instmap__problems">
                      {problems.map((p) => (
                        <li key={`${p.reason}:${p.conflictId ?? ''}`} data-reason={p.reason}>{whyText(p)}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="cn2b-instmap__item-actions">
                  <PhoenixButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => controller.edit(entry.id)}
                    aria-label={t('cn2b_inst_edit_label', lang).replace('__NAME__', name)}
                    data-testid={`cn2b-instmap-edit-${entry.id}`}
                  >
                    {t('cn2b_inst_edit', lang)}
                  </PhoenixButton>
                  <PhoenixButton
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => controller.remove(entry.id)}
                    aria-label={t('cn2b_inst_remove_label', lang).replace('__NAME__', name)}
                    data-testid={`cn2b-instmap-remove-${entry.id}`}
                  >
                    {t('cn2b_inst_remove', lang)}
                  </PhoenixButton>
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {mappings.length > 0 && !resetPending && (
        <div className="cn2b-instmap__actions">
          <PhoenixButton type="button" variant="ghost" size="sm" onClick={controller.requestReset} data-testid="cn2b-instmap-reset">
            {t('cn2b_inst_reset', lang)}
          </PhoenixButton>
        </div>
      )}
      {resetPending && (
        <div className="cn2b-instmap__confirm" role="group" aria-labelledby={ids.resetText} data-testid="cn2b-instmap-reset-confirm">
          <p id={ids.resetText}>{t('cn2b_inst_reset_question', lang).replace('__N__', String(mappings.length))}</p>
          <div className="cn2b-instmap__actions">
            <PhoenixButton type="button" variant="danger" size="sm" onClick={controller.confirmReset} data-testid="cn2b-instmap-reset-yes">
              {t('cn2b_inst_reset_yes', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="ghost" size="sm" onClick={controller.cancelReset} data-testid="cn2b-instmap-reset-keep">
              {t('cn2b_inst_reset_keep', lang)}
            </PhoenixButton>
          </div>
        </div>
      )}

      <p className="cn2b-instmap__status" role="status" data-testid="cn2b-instmap-status">
        {message?.tone === 'status' ? <span key={outcomeSeq}>{message.text}</span> : null}
      </p>
      {message?.tone === 'alert' && (
        <p key={outcomeSeq} className="cn2b-instmap__alert" role="alert" data-testid="cn2b-instmap-alert">
          <PhoenixIcon name="warning" size={15} inline aria-hidden="true" /> {message.text}
        </p>
      )}
    </section>
  );
}
