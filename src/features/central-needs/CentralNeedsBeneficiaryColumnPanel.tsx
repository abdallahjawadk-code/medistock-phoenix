/**
 * CN-2B CORRECTIVE EXTENSION (213) — the beneficiary-column review surface.
 *
 * WHY THIS EXISTS
 * The Annual Needs archive is not one institution per upload: one uploaded
 * workbook/ZIP legitimately carries many beneficiary institutions, one
 * quantity column per institution on a shared material row. The plan owner
 * (e.g. دائرة صحة بابل - قسم الصيدلة) is a fixed, unrelated dimension —
 * `organization_id` — from the beneficiaries represented by individual
 * imported columns. This panel is where a human reviews, column by column,
 * what each physical column is. It never asks the operator to assign the
 * whole upload to one beneficiary.
 *
 * RULES THIS COMPONENT EXISTS TO HONOUR
 *  1. WORKBOOK TEXT IS EVIDENCE, NOT AUTHORITY. A suggestion is shown only
 *     when a column's header matches exactly ONE active care institution's
 *     name/name_ar/code, after trimming whitespace — no fuzzy matching, no
 *     AI, no inference from filename, sheet name, or column position — and it
 *     is never persisted without an explicit human decision.
 *  2. NO WHOLE-FILE SHORTCUT. Every physical column is decided and persisted
 *     independently, even when an "apply to N matching columns" action records
 *     several at once — grouping is a UI convenience over independent server
 *     writes, never a single row.
 *  3. EVERY COLUMN IS IN EXACTLY ONE EXPLICIT STATE (independent review
 *     finding 1): BENEFICIARY (a registered care institution), NOT A
 *     BENEFICIARY COLUMN (an explicit, reasoned human classification), or
 *     UNRESOLVED (no decision yet). Unresolved is never shown or saved as
 *     "not a beneficiary". A header that matches no registered institution is
 *     shown as evidence ("no exact match") — never labelled an institution, and
 *     never defaulted to the plan owner, the active org, or the only known
 *     hospital. A column for an institution that is not registered yet stays
 *     unresolved — and blocks submission — until the institution exists and is
 *     confirmed, or a human explicitly classifies the column.
 *  4. A CHANGED DECISION IS A CORRECTION (independent review finding 2).
 *     Changing a reviewed column (A → B, or beneficiary ↔ not a beneficiary)
 *     and any "not a beneficiary" decision require a human-entered reason; an
 *     action label is never sent as a reason. Only a first beneficiary
 *     confirmation may fall back to the adopted initial-confirmation reason.
 *     A group apply only ever covers UNRESOLVED columns, so reviewed columns are
 *     never corrected in bulk.
 *  5. THE SERVER DECIDES. The state, the "blocks submission" marker and the
 *     cell counts are read from the server's own column summary — this panel
 *     computes nothing the server does not also enforce.
 *
 * UX-2B — THE OPERATIONAL WORKSPACE, and what it deliberately did NOT change.
 *
 * A real multi-institution workbook produces dozens to hundreds of physical
 * columns, and reviewing them meant scrolling one flat list. UX-2B adds a
 * summary, local filtering and a denser row layout so an operator can find the
 * columns that still need a decision. All of that is PRESENTATION:
 *
 *   * every count here is derived from the `columns` prop the server already
 *     supplied — `reviewRequired`, the decisions and the cell counts remain the
 *     server's answers, never recomputed;
 *   * filtering narrows what is DISPLAYED and issues no request. It never
 *     touches a pending choice or reason, never selects anything, and never
 *     writes: a decision typed against a column that a filter later hides is
 *     still there, unchanged, when the filter is cleared;
 *   * the institution search is a way for a HUMAN to locate an institution in a
 *     long list. It narrows the picker's options; it never selects one.
 *
 * The decision semantics, the reason contract, the group-apply scope rule and
 * the write-time re-filter are untouched.
 */
import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';
import {
  setBeneficiaryColumns,
  type BeneficiaryColumnDecision,
  type BeneficiaryColumnSummary,
  type SetBeneficiaryColumnsInput,
} from './central-needs.service';
import { centralNeedsErrorText } from './central-needs.i18n';

/** The picker value that stands for an explicit "not a beneficiary column" decision. */
export const NON_BENEFICIARY_CHOICE = '__non_beneficiary__';

interface Props {
  lang: 'ar' | 'en';
  planRevisionId: string;
  editable: boolean;
  columns: BeneficiaryColumnSummary[];
  /** Active organizations only — eligibility (care_institution + active) is still re-checked server-side. */
  activeCareInstitutions: OrgRow[];
  onChanged: () => void;
}

type ColumnKey = string; // `${importSessionId}:${sheetIndex}:${columnIndex}`
const keyOf = (c: Pick<BeneficiaryColumnSummary, 'importSessionId' | 'sheetIndex' | 'columnIndex'>): ColumnKey =>
  `${c.importSessionId}:${c.sheetIndex}:${c.columnIndex}`;

/**
 * UX-2B — the presentation filter over the three PERSISTED states. These are
 * the same three the server stores; choosing one narrows the view and decides
 * nothing.
 */
type StateFilter = 'all' | 'unresolved' | 'beneficiary' | 'non_beneficiary';

const STATE_FILTERS: ReadonlyArray<{ value: StateFilter; labelKey: string }> = [
  { value: 'all', labelKey: 'cn2b_bc_filter_state_all' },
  { value: 'unresolved', labelKey: 'cn2b_bc_filter_state_unresolved' },
  { value: 'beneficiary', labelKey: 'cn2b_bc_filter_state_beneficiary' },
  { value: 'non_beneficiary', labelKey: 'cn2b_bc_filter_state_non_beneficiary' },
];

/** Exact, case-sensitive-after-trim match against name/name_ar/code — never fuzzy. */
function exactMatchSuggestion(label: string | null, orgs: OrgRow[]): OrgRow[] {
  if (!label) return [];
  const trimmed = label.trim();
  if (!trimmed) return [];
  return orgs.filter((o) => o.name.trim() === trimmed || o.name_ar.trim() === trimmed || o.code.trim() === trimmed);
}

/** The picker value of a column's CURRENT decision — '' when it is unresolved. */
function currentChoiceOf(col: BeneficiaryColumnSummary): string {
  if (col.decision === 'beneficiary') return col.beneficiaryOrganizationId ?? '';
  if (col.decision === 'non_beneficiary') return NON_BENEFICIARY_CHOICE;
  return '';
}

const decisionOf = (choice: string): BeneficiaryColumnDecision =>
  choice === NON_BENEFICIARY_CHOICE ? 'non_beneficiary' : 'beneficiary';

/**
 * Finding 2: changing an existing decision, and any "not a beneficiary"
 * decision, needs a human-entered reason. Only a first beneficiary
 * confirmation of an unresolved column may use the initial-confirmation reason.
 */
const reasonRequiredFor = (col: BeneficiaryColumnSummary, choice: string): boolean =>
  choice === NON_BENEFICIARY_CHOICE || col.decision !== null;

function mappingFor(col: BeneficiaryColumnSummary, choice: string): SetBeneficiaryColumnsInput {
  return {
    importSessionId: col.importSessionId,
    sheetIndex: col.sheetIndex,
    columnIndex: col.columnIndex,
    decision: decisionOf(choice),
    beneficiaryOrganizationId: choice === NON_BENEFICIARY_CHOICE ? null : choice,
    // What this client last saw — a stale view is refused server-side.
    previousDecision: col.decision,
    previousBeneficiaryOrganizationId: col.beneficiaryOrganizationId,
  };
}

export function CentralNeedsBeneficiaryColumnPanel({
  lang, planRevisionId, editable, columns, activeCareInstitutions, onChanged,
}: Props) {
  const [pendingChoice, setPendingChoice] = useState<Record<ColumnKey, string>>({});
  const [pendingReason, setPendingReason] = useState<Record<ColumnKey, string>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [groupConfirm, setGroupConfirm] =
    useState<{ choice: string; reason: string; keys: ColumnKey[]; label: string | null } | null>(null);

  /**
   * UX-2B presentation filters. Held here and applied only to what is
   * rendered: `pendingChoice` and `pendingReason` are keyed by column and are
   * never touched by any of this, so a hidden column keeps the decision its
   * reviewer typed.
   */
  const [textFilter, setTextFilter] = useState('');
  const [stateFilter, setStateFilter] = useState<StateFilter>('all');
  const [blockingOnly, setBlockingOnly] = useState(false);
  /** Narrows the picker's option list so a human can find one institution among many. */
  const [institutionQuery, setInstitutionQuery] = useState('');

  const filtersActive = textFilter.trim() !== '' || stateFilter !== 'all' || blockingOnly;

  const bySameLabel = useMemo(() => {
    const map = new Map<string, BeneficiaryColumnSummary[]>();
    for (const c of columns) {
      if (!c.sourceFieldName) continue;
      const list = map.get(c.sourceFieldName) ?? [];
      list.push(c);
      map.set(c.sourceFieldName, list);
    }
    return map;
  }, [columns]);

  const institutionName = (id: string | null): string => {
    const org = activeCareInstitutions.find((o) => o.id === id);
    return org ? (lang === 'ar' ? org.name_ar : org.name) : (id ?? '—');
  };

  /** The label a decision reads as, for the current/proposed comparison. */
  const choiceLabel = (choice: string): string => {
    if (choice === NON_BENEFICIARY_CHOICE) return t('cn2b_beneficiary_column_state_non_beneficiary', lang);
    if (choice === '') return t('cn2b_beneficiary_column_state_unresolved', lang);
    return institutionName(choice);
  };

  /**
   * UX-2B — counts of the PERSISTED server states, over every loaded column.
   * Display only: nothing here is derived business truth, and `reviewRequired`
   * is the server's own marker, counted rather than recomputed.
   */
  const summary = useMemo(() => ({
    total: columns.length,
    unresolved: columns.filter((c) => c.decision === null).length,
    beneficiary: columns.filter((c) => c.decision === 'beneficiary').length,
    nonBeneficiary: columns.filter((c) => c.decision === 'non_beneficiary').length,
    blocking: columns.filter((c) => c.reviewRequired).length,
  }), [columns]);

  /** Client-only. Reads the already-loaded props and calls nothing. */
  const visibleColumns = useMemo(() => {
    const needle = textFilter.trim().toLowerCase();
    return columns.filter((c) => {
      if (stateFilter === 'unresolved' && c.decision !== null) return false;
      if (stateFilter === 'beneficiary' && c.decision !== 'beneficiary') return false;
      if (stateFilter === 'non_beneficiary' && c.decision !== 'non_beneficiary') return false;
      if (blockingOnly && !c.reviewRequired) return false;
      if (needle === '') return true;
      const org = activeCareInstitutions.find((o) => o.id === c.beneficiaryOrganizationId);
      const haystack = [
        c.originalFilename ?? '', c.archiveEntryPath ?? '', c.sheetName ?? '',
        c.sourceFieldName ?? '', String(c.columnIndex), `#${c.columnIndex}`,
        c.mappingReason ?? '', org?.name ?? '', org?.name_ar ?? '', org?.code ?? '',
      ];
      return haystack.join('\u0000').toLowerCase().includes(needle);
    });
  }, [columns, activeCareInstitutions, textFilter, stateFilter, blockingOnly]);

  /**
   * The institutions the picker offers. An institution search narrows this list
   * so a human can FIND one; it never selects one, and the column's own current
   * or pending choice is always kept offerable so a filter can never make the
   * selected value unrepresentable.
   */
  const pickerInstitutionsFor = (keepId: string): OrgRow[] => {
    const q = institutionQuery.trim().toLowerCase();
    if (q === '') return activeCareInstitutions;
    return activeCareInstitutions.filter((o) =>
      o.id === keepId
      || o.name.toLowerCase().includes(q)
      || o.name_ar.toLowerCase().includes(q)
      || o.code.toLowerCase().includes(q));
  };

  function clearFilters() {
    setTextFilter('');
    setStateFilter('all');
    setBlockingOnly(false);
  }

  function clearPending(keys: ColumnKey[]) {
    const drop = <T,>(prev: Record<ColumnKey, T>) => {
      const next = { ...prev };
      for (const k of keys) delete next[k];
      return next;
    };
    setPendingChoice(drop);
    setPendingReason(drop);
  }

  async function write(mappings: SetBeneficiaryColumnsInput[], mappingReason: string, keys: ColumnKey[]) {
    setBusy(true);
    setError(null);
    try {
      await setBeneficiaryColumns({ planRevisionId, mappingReason, mappings });
      clearPending(keys);
      setGroupConfirm(null);
      onChanged();
    } catch (e) {
      setError(centralNeedsErrorText((e as { code?: string }).code ?? 'unknown_error', lang));
    } finally {
      setBusy(false);
    }
  }

  function confirmOne(col: BeneficiaryColumnSummary, choice: string, reason: string) {
    // Reachable without a typed reason only for a first beneficiary confirmation.
    const mappingReason = reason.trim() || t('cn2b_beneficiary_column_initial_reason', lang);
    void write([mappingFor(col, choice)], mappingReason, [keyOf(col)]);
  }

  function confirmGroup() {
    if (!groupConfirm) return;
    // Re-filter at write time: a column reviewed meanwhile is never overwritten by a group apply.
    const targets = columns.filter((c) => groupConfirm.keys.includes(keyOf(c)) && c.decision === null);
    const mappingReason = groupConfirm.reason || t('cn2b_beneficiary_column_initial_reason', lang);
    void write(targets.map((c) => mappingFor(c, groupConfirm.choice)), mappingReason, groupConfirm.keys);
  }

  return (
    <PhoenixCard padding="16px">
      <h3 style={{ margin: 0, fontSize: 15, fontWeight: 700 }}>{t('cn2b_beneficiary_columns_title', lang)}</h3>
      <p style={{ margin: '6px 0 14px', fontSize: 12.5, opacity: 0.75 }}>{t('cn2b_beneficiary_columns_explainer', lang)}</p>
      {error && <div className="cn2b-bc-error" role="alert">{error}</div>}

      {columns.length === 0 ? (
        /* A — nothing loaded at all. Distinct from "filters hid everything". */
        <p className="cn2b-bc-empty" data-empty="no-columns">{t('cn2b_bc_empty_no_columns', lang)}</p>
      ) : (
        <>
          {/* UX-2B — counts of the server's own states, for orientation only. */}
          <dl className="cn2b-bc-summary" role="status">
            <div className="cn2b-bc-summary__cell">
              <dt>{t('cn2b_bc_sum_total', lang)}</dt><dd data-bc-count="total">{summary.total}</dd>
            </div>
            <div className="cn2b-bc-summary__cell">
              <dt>{t('cn2b_bc_sum_unresolved', lang)}</dt><dd data-bc-count="unresolved">{summary.unresolved}</dd>
            </div>
            <div className="cn2b-bc-summary__cell">
              <dt>{t('cn2b_bc_sum_beneficiary', lang)}</dt><dd data-bc-count="beneficiary">{summary.beneficiary}</dd>
            </div>
            <div className="cn2b-bc-summary__cell">
              <dt>{t('cn2b_bc_sum_non_beneficiary', lang)}</dt><dd data-bc-count="non_beneficiary">{summary.nonBeneficiary}</dd>
            </div>
            <div className="cn2b-bc-summary__cell">
              <dt>{t('cn2b_bc_sum_blocking', lang)}</dt><dd data-bc-count="blocking">{summary.blocking}</dd>
            </div>
            <div className="cn2b-bc-summary__cell">
              <dt>{t('cn2b_bc_sum_visible', lang)}</dt><dd data-bc-count="visible">{visibleColumns.length}</dd>
            </div>
          </dl>

          {/*
            Local filters. Deliberately a searchbox, toggle buttons and a
            checkbox rather than text inputs and selects: a read-only revision
            must expose no mutation control, and these are none — they narrow
            the view and reach nothing.
          */}
          <div className="cn2b-bc-toolbar">
            <input
              type="search"
              className="cn2b-bc-input cn2b-bc-toolbar__grow"
              aria-label={t('cn2b_bc_filter_search', lang)}
              placeholder={t('cn2b_bc_filter_search_hint', lang)}
              value={textFilter}
              onChange={(e) => setTextFilter(e.target.value)}
            />
            <div className="cn2b-bc-segmented" role="group" aria-label={t('cn2b_bc_filter_state_label', lang)}>
              {STATE_FILTERS.map((f) => (
                <button
                  key={f.value}
                  type="button"
                  className="cn2b-bc-segbtn"
                  data-state-filter={f.value}
                  data-active={stateFilter === f.value}
                  aria-pressed={stateFilter === f.value}
                  onClick={() => setStateFilter(f.value)}
                >
                  {t(f.labelKey, lang)}
                </button>
              ))}
            </div>
            <label className="cn2b-bc-check">
              <input
                type="checkbox"
                checked={blockingOnly}
                onChange={(e) => setBlockingOnly(e.target.checked)}
              />
              {t('cn2b_bc_filter_blocking_only', lang)}
            </label>
            {editable && (
              <input
                type="search"
                className="cn2b-bc-input"
                aria-label={t('cn2b_bc_filter_institution', lang)}
                placeholder={t('cn2b_bc_filter_institution_hint', lang)}
                value={institutionQuery}
                onChange={(e) => setInstitutionQuery(e.target.value)}
              />
            )}
            <PhoenixButton size="sm" variant="ghost" disabled={!filtersActive} onClick={clearFilters}>
              {t('cn2b_bc_filter_clear', lang)}
            </PhoenixButton>
          </div>

          {/* C — the workspace is read-only because the revision is not editable. */}
          {!editable && (
            <p className="cn2b-bc-readonly" data-empty="read-only">{t('cn2b_bc_read_only', lang)}</p>
          )}

          {visibleColumns.length === 0 ? (
            /* B — columns exist, but these filters match none of them. */
            <p className="cn2b-bc-empty" data-empty="filtered">{t('cn2b_bc_empty_filtered', lang)}</p>
          ) : (
            <div className="cn2b-bc-rows">
              {visibleColumns.map((col) => {
                const key = keyOf(col);
                const current = currentChoiceOf(col);
                const suggestions = col.decision ? [] : exactMatchSuggestion(col.sourceFieldName, activeCareInstitutions);
                // Evidence hints, shown only while a column is unresolved — never a state of their own.
                const hint = col.decision ? null
                  : suggestions.length === 1 ? t('cn2b_beneficiary_column_status_suggested', lang)
                  : suggestions.length > 1 ? t('cn2b_beneficiary_column_status_ambiguous', lang)
                  : col.sourceFieldName ? t('cn2b_beneficiary_column_hint_no_exact_match', lang)
                  : null;
                const stateKey = col.decision === 'beneficiary' ? 'cn2b_beneficiary_column_state_beneficiary'
                  : col.decision === 'non_beneficiary' ? 'cn2b_beneficiary_column_state_non_beneficiary'
                  : 'cn2b_beneficiary_column_state_unresolved';

                const choice = pendingChoice[key];
                const hasChange = choice !== undefined && choice !== '' && choice !== current;
                const reason = pendingReason[key] ?? '';
                const reasonRequired = hasChange && reasonRequiredFor(col, choice);
                const reasonOk = !reasonRequired || reason.trim() !== '';
                const canConfirm = !busy && hasChange && reasonOk;
                /** A prefilled exact match is a SUGGESTION until a human confirms it. */
                const showingSuggestion = choice === undefined && !col.decision && suggestions.length === 1;

                const siblings = col.sourceFieldName ? (bySameLabel.get(col.sourceFieldName) ?? []) : [];
                const unresolvedSiblingKeys = siblings.filter((s) => s.decision === null).map(keyOf);
                const offerGroup = col.decision === null && Boolean(col.sourceFieldName)
                  && unresolvedSiblingKeys.length > 1 && hasChange;

                return (
                  <div
                    key={key}
                    data-testid="cn2b-bc-row"
                    data-column-state={col.decision ?? 'unresolved'}
                    data-blocking={col.reviewRequired || undefined}
                    data-suggested={showingSuggestion || undefined}
                    className="cn2b-bc-row"
                  >
                    {/* 1 — SOURCE EVIDENCE. Nothing here is ever dropped. */}
                    <div className="cn2b-bc__evidence">
                      <div className="cn2b-bc__ident">
                        {col.originalFilename ?? col.importSessionId} · {col.sheetName ?? `#${col.sheetIndex}`} · #{col.columnIndex}
                      </div>
                      <div className="cn2b-bc__counts">
                        {col.sourceFieldName ?? '—'} · {col.nonzeroNumericCount} / {col.numericValueCount}
                        {col.zeroValueCount > 0 ? ` (${col.zeroValueCount} = 0)` : ''}
                      </div>
                      {col.archiveEntryPath && <div className="cn2b-bc__path">{col.archiveEntryPath}</div>}
                      {hint && <div className="cn2b-bc__hint">{hint}</div>}
                    </div>

                    {/* 2 — CURRENT REVIEW STATE, as the server records it. */}
                    <div className="cn2b-bc__state">
                      <span data-testid="cn2b-bc-state" className="cn2b-bc__badge" data-state={col.decision ?? 'unresolved'}>
                        {t(stateKey, lang)}
                      </span>
                      {col.decision === 'beneficiary' && (
                        <span data-testid="cn2b-bc-beneficiary-name" className="cn2b-bc__org">
                          {institutionName(col.beneficiaryOrganizationId)}
                        </span>
                      )}
                      {col.reviewRequired && (
                        <span data-testid="cn2b-bc-blocks-readiness" className="cn2b-bc__blocks">
                          {t('cn2b_beneficiary_column_blocks_readiness', lang)}
                        </span>
                      )}
                    </div>

                    {/* 3 — REVIEW ACTION. Decision semantics unchanged. */}
                    {editable && (
                      <div className="cn2b-bc__action">
                        <select
                          className="cn2b-bc-select"
                          aria-label={t('cn2b_beneficiary_column_decision_label', lang)}
                          disabled={busy}
                          value={choice ?? (current || (suggestions.length === 1 ? suggestions[0].id : ''))}
                          onChange={(e) => setPendingChoice((prev) => ({ ...prev, [key]: e.target.value }))}
                        >
                          <option value="">—</option>
                          {pickerInstitutionsFor(choice ?? current).map((o) => (
                            <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>
                          ))}
                          <option value={NON_BENEFICIARY_CHOICE}>{t('cn2b_beneficiary_column_option_non_beneficiary', lang)}</option>
                        </select>

                        {hasChange && (
                          <input
                            type="text"
                            className="cn2b-bc-input"
                            aria-label={t(reasonRequired ? 'cn2b_beneficiary_column_reason_required' : 'cn2b_beneficiary_column_reason_optional', lang)}
                            aria-required={reasonRequired}
                            placeholder={t(reasonRequired ? 'cn2b_beneficiary_column_reason_required' : 'cn2b_beneficiary_column_reason_optional', lang)}
                            disabled={busy}
                            value={reason}
                            onChange={(e) => setPendingReason((prev) => ({ ...prev, [key]: e.target.value }))}
                          />
                        )}

                        <PhoenixButton
                          size="sm" variant="secondary" disabled={!canConfirm}
                          onClick={() => { if (canConfirm && choice) confirmOne(col, choice, reason); }}
                        >
                          {t('cn2b_beneficiary_column_confirm', lang)}
                        </PhoenixButton>

                        {offerGroup && (
                          <PhoenixButton
                            size="sm" variant="ghost" disabled={busy || !reasonOk}
                            onClick={() => {
                              if (choice) {
                                setGroupConfirm({
                                  choice, reason: reason.trim(), keys: unresolvedSiblingKeys,
                                  label: col.sourceFieldName,
                                });
                              }
                            }}
                          >
                            {t('cn2b_beneficiary_column_apply_to_matching', lang).replace('__N__', String(unresolvedSiblingKeys.length))}
                          </PhoenixButton>
                        )}

                        {/* A correction states what it replaces, beside what it proposes. */}
                        {hasChange && (
                          <div className="cn2b-bc__change" data-testid="cn2b-bc-change">
                            <span className="cn2b-bc__change-from">
                              {t('cn2b_bc_current', lang)}: {choiceLabel(current)}
                            </span>
                            <span className="cn2b-bc__change-arrow" aria-hidden="true">→</span>
                            <span className="cn2b-bc__change-to">
                              {t('cn2b_bc_proposed', lang)}: {choiceLabel(choice)}
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>
      )}

      {groupConfirm && (
        <div className="cn2b-bc-group">
          <div className="cn2b-bc-group__title">
            {t('cn2b_beneficiary_column_apply_to_matching', lang).replace('__N__', String(groupConfirm.keys.length))}
          </div>
          <div className="cn2b-bc-group__scope">{t('cn2b_beneficiary_column_group_scope_note', lang)}</div>
          <div className="cn2b-bc-group__proposed" data-testid="cn2b-bc-group-proposed">
            {t('cn2b_bc_group_proposed', lang)}: {choiceLabel(groupConfirm.choice)}
          </div>
          {groupConfirm.label && (
            <div className="cn2b-bc-group__label" data-testid="cn2b-bc-group-label">
              {t('cn2b_bc_group_label', lang)}: {groupConfirm.label}
            </div>
          )}
          {groupConfirm.reason && (
            <div className="cn2b-bc-group__reason">{groupConfirm.reason}</div>
          )}
          <ul className="cn2b-bc-group__list">
            {columns.filter((c) => groupConfirm.keys.includes(keyOf(c))).map((c) => (
              <li key={keyOf(c)}>
                {c.originalFilename ?? c.importSessionId} · {c.sheetName ?? `#${c.sheetIndex}`} · #{c.columnIndex}
              </li>
            ))}
          </ul>
          <div className="cn2b-bc-group__actions">
            <PhoenixButton size="sm" variant="primary" disabled={busy} onClick={confirmGroup}>
              {t('cn2b_beneficiary_column_confirm', lang)}
            </PhoenixButton>
            <PhoenixButton size="sm" variant="ghost" disabled={busy} onClick={() => setGroupConfirm(null)}>
              {lang === 'ar' ? 'إلغاء' : 'Cancel'}
            </PhoenixButton>
          </div>
        </div>
      )}
    </PhoenixCard>
  );
}
