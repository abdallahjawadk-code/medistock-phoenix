/**
 * Annual Needs — Simple Mode institution card (spec section 12).
 *
 * A THIN presentation wrapper around the exact same write path and rules
 * `CentralNeedsBeneficiaryColumnPanel` already enforces: `setBeneficiaryColumns`,
 * `exactMatchSuggestion` (no fuzzy matching), `mappingFor` and
 * `reasonRequiredFor` are all reused, unchanged, from that file. This card
 * adds no new decision logic and no new server call — it only narrows the
 * view to one column at a time and simplifies the copy.
 *
 * "WORKBOOK TEXT IS EVIDENCE, NOT AUTHORITY" (M213) holds exactly as it does
 * in Advanced Mode: a suggestion is never auto-persisted — [صحيح] performs
 * the SAME explicit human-confirmed write `setBeneficiaryColumns` always
 * required, just triggered from a simpler control.
 */
import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';
import {
  exactMatchSuggestion,
  mappingFor,
  reasonRequiredFor,
  NON_BENEFICIARY_CHOICE,
} from '../CentralNeedsBeneficiaryColumnPanel';
import { setBeneficiaryColumns, type BeneficiaryColumnSummary } from '../central-needs.service';
import { centralNeedsErrorText } from '../central-needs.i18n';

interface Props {
  lang: 'ar' | 'en';
  planRevisionId: string;
  /**
   * `canEdit && isDraft`, the same gate `CentralNeedsBeneficiaryColumnPanel`
   * applies to its own controls. When false this card renders the evidence
   * read-only and offers no control that could reach `setBeneficiaryColumns`.
   */
  editable: boolean;
  /** The ONE unresolved column this card reviews. Callers pick the next one. */
  column: BeneficiaryColumnSummary;
  activeCareInstitutions: OrgRow[];
  onResolved: () => void;
}

type Picker = { open: boolean; query: string };

export function SimpleInstitutionCard({ lang, planRevisionId, editable, column, activeCareInstitutions, onResolved }: Props) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picker, setPicker] = useState<Picker>({ open: false, query: '' });
  const [nonBeneficiaryReason, setNonBeneficiaryReason] = useState('');
  const [showNonBeneficiaryReason, setShowNonBeneficiaryReason] = useState(false);

  const suggestions = useMemo(
    () => exactMatchSuggestion(column.sourceFieldName, activeCareInstitutions),
    [column.sourceFieldName, activeCareInstitutions],
  );
  const singleSuggestion = suggestions.length === 1 ? suggestions[0] : null;

  const orgLabel = (o: OrgRow) => (lang === 'ar' ? o.name_ar : o.name);

  const pickerOptions = useMemo(() => {
    const q = picker.query.trim().toLowerCase();
    if (q === '') return activeCareInstitutions;
    return activeCareInstitutions.filter((o) =>
      o.name.toLowerCase().includes(q) || o.name_ar.toLowerCase().includes(q) || o.code.toLowerCase().includes(q));
  }, [activeCareInstitutions, picker.query]);

  async function write(choice: string, reason: string) {
    // Defence in depth: the controls are not rendered without `editable`, and
    // no code path may reach the RPC without it either.
    if (!editable) return;
    setBusy(true);
    setError(null);
    try {
      await setBeneficiaryColumns({
        planRevisionId,
        mappingReason: reason.trim() || t('cn2b_beneficiary_column_initial_reason', lang),
        mappings: [mappingFor(column, choice)],
      });
      onResolved();
    } catch (e) {
      setError(centralNeedsErrorText((e as { code?: string }).code ?? 'unknown_error', lang));
    } finally {
      setBusy(false);
    }
  }

  function confirmSuggestion() {
    if (!singleSuggestion) return;
    // (213) An unresolved column's FIRST beneficiary confirmation never
    // requires a typed reason — reasonRequiredFor(column, id) is false here
    // because column.decision is null. The default initial-confirmation
    // reason is the SAME one Advanced Mode falls back to.
    void write(singleSuggestion.id, '');
  }

  function confirmPicked(orgId: string) {
    void write(orgId, '');
  }

  function submitNonBeneficiary() {
    if (!reasonRequiredFor(column, NON_BENEFICIARY_CHOICE)) return; // always true, kept for symmetry
    if (nonBeneficiaryReason.trim() === '') return;
    void write(NON_BENEFICIARY_CHOICE, nonBeneficiaryReason);
  }

  return (
    <section className="cn2b-simple-card cn2b-simple-card--review" data-testid="cn2b-simple-institution-card" aria-labelledby="cn2b-simple-institution-evidence">
      <div className="cn2b-simple-evidence">
        <p className="cn2b-simple-card__eyebrow">
          <PhoenixIcon name="file" size={14} inline aria-hidden="true" /> {t('cn2b_simple_found_in_file', lang)}
        </p>
        <h2 className="cn2b-simple-evidence__text" id="cn2b-simple-institution-evidence" data-testid="cn2b-simple-institution-evidence">
          <bdi>{column.sourceFieldName ?? t('cn2b_simple_unnamed_column', lang)}</bdi>
        </h2>
        {(column.originalFilename || column.sheetName) && (
          <p className="cn2b-simple-evidence__meta">
            <bdi>{column.originalFilename ?? ''}{column.originalFilename && column.sheetName ? ' · ' : ''}{column.sheetName ?? ''}</bdi>
          </p>
        )}
      </div>

      {error && (
        <div className="cn2b-simple-error" role="alert">
          <PhoenixIcon name="warning" size={16} inline aria-hidden="true" /> {error}
        </div>
      )}

      {/* Read-only: the evidence and any exact match stay visible, every control does not. */}
      {!editable && (
        <>
          {singleSuggestion && (
            <div className="cn2b-simple-match">
              <p className="cn2b-simple-match__label">{t('cn2b_simple_matching_institution', lang)}</p>
              <p className="cn2b-simple-match__name" data-testid="cn2b-simple-institution-suggestion">
                <bdi>{orgLabel(singleSuggestion)}</bdi>
              </p>
            </div>
          )}
          <p className="cn2b-bc-readonly cn2b-simple-readonly" data-empty="read-only" data-testid="cn2b-simple-institution-read-only">
            {t('cn2b_bc_read_only', lang)}
          </p>
        </>
      )}

      {editable && singleSuggestion && !picker.open && !showNonBeneficiaryReason && (
        <>
          <div className="cn2b-simple-match">
            <p className="cn2b-simple-match__label">{t('cn2b_simple_matching_institution', lang)}</p>
            <p className="cn2b-simple-match__name" data-testid="cn2b-simple-institution-suggestion">
              <bdi>{orgLabel(singleSuggestion)}</bdi>
            </p>
          </div>
          <div className="cn2b-simple-card__actions">
            <PhoenixButton type="button" variant="primary" size="lg" disabled={busy} onClick={confirmSuggestion}>
              {t('cn2b_simple_correct', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="secondary" disabled={busy} onClick={() => setPicker({ open: true, query: '' })}>
              {t('cn2b_simple_choose_another_institution', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => setShowNonBeneficiaryReason(true)}>
              {t('cn2b_simple_not_an_institution', lang)}
            </PhoenixButton>
          </div>
        </>
      )}

      {editable && !singleSuggestion && !picker.open && !showNonBeneficiaryReason && (
        <>
          <div className="cn2b-simple-match cn2b-simple-match--none" data-testid="cn2b-simple-institution-no-suggestion">
            <PhoenixIcon name="info" size={16} inline aria-hidden="true" />{' '}
            {suggestions.length > 1
              ? t('cn2b_simple_multiple_matches', lang)
              : t('cn2b_simple_no_match', lang)}
          </div>
          <div className="cn2b-simple-card__actions">
            <PhoenixButton type="button" variant="primary" size="lg" disabled={busy} onClick={() => setPicker({ open: true, query: '' })}>
              {t('cn2b_simple_choose_institution', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => setShowNonBeneficiaryReason(true)}>
              {t('cn2b_simple_not_an_institution', lang)}
            </PhoenixButton>
          </div>
        </>
      )}

      {editable && picker.open && (
        <div className="cn2b-simple-card__picker" data-testid="cn2b-simple-institution-picker">
          <input
            type="search"
            className="cn2b-simple-input"
            aria-label={t('cn2b_simple_search_institution', lang)}
            placeholder={t('cn2b_simple_search_institution', lang)}
            value={picker.query}
            onChange={(e) => setPicker((p) => ({ ...p, query: e.target.value }))}
          />
          <ul className="cn2b-simple-card__picker-list">
            {pickerOptions.map((o) => (
              <li key={o.id}>
                <PhoenixButton type="button" variant="ghost" className="cn2b-simple-option" disabled={busy} onClick={() => confirmPicked(o.id)}>
                  {orgLabel(o)}
                </PhoenixButton>
              </li>
            ))}
            {pickerOptions.length === 0 && <li className="cn2b-simple-card__empty">{t('cn2b_simple_no_results', lang)}</li>}
          </ul>
          <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => setPicker({ open: false, query: '' })}>
            {t('cn2b_simple_cancel', lang)}
          </PhoenixButton>
        </div>
      )}

      {editable && showNonBeneficiaryReason && (
        <div className="cn2b-simple-card__reason" data-testid="cn2b-simple-institution-non-beneficiary-reason">
          <p className="cn2b-simple-card__hint">{t('cn2b_simple_non_beneficiary_reason_hint', lang)}</p>
          <input
            type="text"
            className="cn2b-simple-input"
            aria-label={t('cn2b_beneficiary_column_reason_required', lang)}
            placeholder={t('cn2b_beneficiary_column_reason_required', lang)}
            value={nonBeneficiaryReason}
            onChange={(e) => setNonBeneficiaryReason(e.target.value)}
          />
          <div className="cn2b-simple-card__actions">
            <PhoenixButton
              type="button" variant="danger" disabled={busy || nonBeneficiaryReason.trim() === ''}
              onClick={submitNonBeneficiary}
            >
              {t('cn2b_simple_confirm_not_an_institution', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="ghost" disabled={busy} onClick={() => { setShowNonBeneficiaryReason(false); setNonBeneficiaryReason(''); }}>
              {t('cn2b_simple_cancel', lang)}
            </PhoenixButton>
          </div>
        </div>
      )}
    </section>
  );
}
