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
  const [groupConfirm, setGroupConfirm] = useState<{ choice: string; reason: string; keys: ColumnKey[] } | null>(null);

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
      {error && <div style={{ color: 'var(--danger)', fontSize: 12.5, marginBottom: 10 }}>{error}</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {columns.map((col) => {
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

          const siblings = col.sourceFieldName ? (bySameLabel.get(col.sourceFieldName) ?? []) : [];
          const unresolvedSiblingKeys = siblings.filter((s) => s.decision === null).map(keyOf);
          const offerGroup = col.decision === null && Boolean(col.sourceFieldName)
            && unresolvedSiblingKeys.length > 1 && hasChange;

          return (
            <div key={key} data-testid="cn2b-bc-row" data-column-state={col.decision ?? 'unresolved'} style={{
              display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 10, padding: '8px 10px',
              border: '1px solid var(--brd)', borderRadius: 'var(--r3)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {col.originalFilename ?? col.importSessionId} · {col.sheetName ?? `#${col.sheetIndex}`} · #{col.columnIndex}
                </div>
                <div style={{ fontSize: 12, opacity: 0.7 }}>
                  {col.sourceFieldName ?? '—'} · {col.nonzeroNumericCount} / {col.numericValueCount}
                  {col.zeroValueCount > 0 ? ` (${col.zeroValueCount} = 0)` : ''}
                </div>
                {hint && <div style={{ fontSize: 11.5, opacity: 0.8 }}>{hint}</div>}
              </div>

              <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4 }}>
                <span data-testid="cn2b-bc-state" style={{ fontSize: 11.5, padding: '2px 8px', borderRadius: 999, background: 'var(--chip)' }}>
                  {t(stateKey, lang)}
                </span>
                {col.decision === 'beneficiary' && (
                  <span data-testid="cn2b-bc-beneficiary-name" style={{ fontSize: 12, fontWeight: 600 }}>
                    {institutionName(col.beneficiaryOrganizationId)}
                  </span>
                )}
                {col.reviewRequired && (
                  <span data-testid="cn2b-bc-blocks-readiness" style={{ fontSize: 11.5, color: 'var(--danger)' }}>
                    {t('cn2b_beneficiary_column_blocks_readiness', lang)}
                  </span>
                )}
              </div>

              {editable && (
                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
                  <select
                    aria-label={t('cn2b_beneficiary_column_decision_label', lang)}
                    disabled={busy}
                    value={choice ?? (current || (suggestions.length === 1 ? suggestions[0].id : ''))}
                    onChange={(e) => setPendingChoice((prev) => ({ ...prev, [key]: e.target.value }))}
                    style={{ fontSize: 12.5, padding: '4px 6px', borderRadius: 'var(--r2)', border: '1px solid var(--brd)' }}
                  >
                    <option value="">—</option>
                    {activeCareInstitutions.map((o) => (
                      <option key={o.id} value={o.id}>{lang === 'ar' ? o.name_ar : o.name}</option>
                    ))}
                    <option value={NON_BENEFICIARY_CHOICE}>{t('cn2b_beneficiary_column_option_non_beneficiary', lang)}</option>
                  </select>

                  {hasChange && (
                    <input
                      type="text"
                      aria-label={t(reasonRequired ? 'cn2b_beneficiary_column_reason_required' : 'cn2b_beneficiary_column_reason_optional', lang)}
                      aria-required={reasonRequired}
                      placeholder={t(reasonRequired ? 'cn2b_beneficiary_column_reason_required' : 'cn2b_beneficiary_column_reason_optional', lang)}
                      disabled={busy}
                      value={reason}
                      onChange={(e) => setPendingReason((prev) => ({ ...prev, [key]: e.target.value }))}
                      style={{ fontSize: 12.5, padding: '4px 6px', minWidth: 220, borderRadius: 'var(--r2)', border: '1px solid var(--brd)' }}
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
                      onClick={() => { if (choice) setGroupConfirm({ choice, reason: reason.trim(), keys: unresolvedSiblingKeys }); }}
                    >
                      {t('cn2b_beneficiary_column_apply_to_matching', lang).replace('__N__', String(unresolvedSiblingKeys.length))}
                    </PhoenixButton>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {groupConfirm && (
        <div style={{
          marginTop: 14, padding: 12, borderRadius: 'var(--r3)', border: '1px solid var(--brd)', background: 'var(--chip)',
        }}>
          <div style={{ fontSize: 13, marginBottom: 8 }}>
            {t('cn2b_beneficiary_column_apply_to_matching', lang).replace('__N__', String(groupConfirm.keys.length))}
          </div>
          <div style={{ fontSize: 12, marginBottom: 6 }}>{t('cn2b_beneficiary_column_group_scope_note', lang)}</div>
          {groupConfirm.reason && (
            <div style={{ fontSize: 12, marginBottom: 6, fontStyle: 'italic' }}>{groupConfirm.reason}</div>
          )}
          <ul style={{ margin: '0 0 10px', paddingInlineStart: 18, fontSize: 12, opacity: 0.8, maxHeight: 140, overflowY: 'auto' }}>
            {columns.filter((c) => groupConfirm.keys.includes(keyOf(c))).map((c) => (
              <li key={keyOf(c)}>
                {c.originalFilename ?? c.importSessionId} · {c.sheetName ?? `#${c.sheetIndex}`} · #{c.columnIndex}
              </li>
            ))}
          </ul>
          <div style={{ display: 'flex', gap: 8 }}>
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
