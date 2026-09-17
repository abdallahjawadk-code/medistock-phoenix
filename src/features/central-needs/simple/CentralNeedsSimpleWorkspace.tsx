/**
 * Annual Needs — Simple Mode (owner task: "Simple Annual Needs — Corpus
 * Contract + Local Implementation").
 *
 * Presentation-only. Every write goes through the SAME canonical RPCs
 * Advanced Mode already uses (`setBeneficiaryColumns`, `setRecordDisposition`,
 * `openPlanRevision`, `requestUploadTicket`/`uploadToStaging`/`finalizeImport`
 * via the handlers the parent screen passes down). Simple Mode and Advanced
 * Mode read and write the SAME persisted business state — this component
 * introduces no second source of truth and no client-side readiness.
 *
 * HARD BOUNDARY (owner task section 16): this component NEVER calls
 * `setNeedLine`. The final "quantities as imported" action is always
 * disabled here — automatic bulk NeedLine persistence is out of scope for
 * this task, pending independent proof of the corpus's unit-lineage
 * contract (see CORPUS-CONTRACT.md).
 */
import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';
import type { PreviewState } from '../useCentralNeedsPreview';
import { SimpleInstitutionCard } from './SimpleInstitutionCard';
import { SimpleMaterialCard } from './SimpleMaterialCard';
import { summarizeSimpleReadiness } from './simpleReadiness';
import { computeSimpleCounts } from './simpleCounts';
import type {
  BeneficiaryColumnSummary, PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../central-needs.service';

type SimpleStep = 'upload' | 'analyzing' | 'summary' | 'review-institution' | 'review-material' | 'pending';

interface Props {
  lang: 'ar' | 'en';
  planYear: number;
  onPlanYearChange: (year: number) => void;
  revisionsLoading: boolean;
  revision: PlanRevision | null;
  isDraft: boolean;
  revisionDataReady: boolean;
  canImport: boolean;
  /**
   * The SAME raw `central_needs.edit` boolean `CentralNeedsScreen` derives
   * from `myPermissions`. This component ANDs it with `isDraft` itself, so a
   * mutation control is offered under exactly the condition Advanced Mode
   * uses at its own call sites (`editable={canEdit && isDraft}`). The server
   * RPC remains the final authority either way.
   */
  canEdit: boolean;
  busy: boolean;
  onOpenRevision: (openNext: boolean) => void;
  preview: PreviewState;
  pendingFile: File | null;
  onPickFile: (file: File | null) => void;
  onVerify: () => void;
  error: string | null;

  readiness: ReviewReadiness | null;
  beneficiaryColumns: BeneficiaryColumnSummary[];
  careInstitutions: OrgRow[];
  records: SourceRecord[];
  dispositions: RecordDisposition[];
  activeSessionId: string | null;
  onChanged: () => void;
  onSwitchToAdvanced: () => void;
}

export function CentralNeedsSimpleWorkspace({
  lang, planYear, onPlanYearChange, revisionsLoading, revision, isDraft, revisionDataReady,
  canImport, canEdit, busy, onOpenRevision, preview, pendingFile, onPickFile, onVerify, error,
  readiness, beneficiaryColumns, careInstitutions, records, dispositions, activeSessionId,
  onChanged, onSwitchToAdvanced,
}: Props) {
  /**
   * THE ONLY navigation state in Simple Mode (defects 4 and 5), and it is
   * keyed by dataset identity rather than being a bare boolean or a free step
   * override. It records which analyzed dataset's summary the human has moved
   * past, so the summary is presented once before item-by-item review and
   * cannot be skipped — while never surviving into a different revision or
   * import session, and never outranking a closed revision or an unready one.
   * It is not persisted, never sent to a server, and decides nothing about
   * readiness or completion.
   */
  const [summaryAckKey, setSummaryAckKey] = useState<string | null>(null);

  const counts = useMemo(
    () => computeSimpleCounts(beneficiaryColumns, records, dispositions),
    [beneficiaryColumns, records, dispositions],
  );
  const readinessSummary = useMemo(() => summarizeSimpleReadiness(readiness), [readiness]);

  const unresolvedColumns = useMemo(
    () => beneficiaryColumns.filter((c) => c.decision === null && c.reviewRequired),
    [beneficiaryColumns],
  );
  const dispositionedEntities = useMemo(() => new Set(dispositions.map((d) => d.targetEntity)), [dispositions]);
  const undispositionedEntities = useMemo(() => {
    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const r of records) {
      if (dispositionedEntities.has(r.targetEntity) || seen.has(r.targetEntity)) continue;
      seen.add(r.targetEntity);
      ordered.push(r.targetEntity);
    }
    return ordered;
  }, [records, dispositionedEntities]);
  const fieldsByEntity = useMemo(() => {
    const m = new Map<string, SourceRecord[]>();
    for (const r of records) m.set(r.targetEntity, [...(m.get(r.targetEntity) ?? []), r]);
    return m;
  }, [records]);

  // section 18 — a revision already submitted/approved is never silently
  // superseded. A human must explicitly choose to open a correction revision.
  const revisionClosed = revision !== null && revision.status !== 'draft';

  /** Advanced Mode's own rule, verbatim: the edit permission AND a draft revision. */
  const canWrite = canEdit && isDraft;

  /**
   * The identity of the dataset on screen: this revision plus the import
   * session whose records/dispositions are loaded. Opening another revision or
   * switching session changes it, which is what makes the acknowledgement
   * above impossible to carry over stale.
   */
  const datasetKey = revision === null ? null : `${revision.id}:${activeSessionId ?? 'no-session'}`;
  const summaryAcknowledged = datasetKey !== null && summaryAckKey === datasetKey;

  /**
   * The single source of the visible step: current props plus the dataset-keyed
   * acknowledgement. Presentation-only routing, never business readiness. The
   * order of these guards is the contract — a missing revision, a closed one,
   * and an unready or parsing one each outrank the summary, which in turn
   * precedes review.
   */
  const derivedStep: SimpleStep = useMemo(() => {
    if (!revision) return 'upload';
    if (revisionClosed) return 'upload';
    if (preview.phase === 'parsing' || busy) return 'analyzing';
    if (!revisionDataReady) return 'analyzing';
    // Defect 4: the analysis summary is presented once per analyzed dataset,
    // BEFORE item-by-item review. This gates navigation only — readiness,
    // blockers and every unresolved item remain exactly what the server says,
    // and nothing below is skipped, only ordered.
    if (!summaryAcknowledged) return 'summary';
    if (unresolvedColumns.length > 0) return 'review-institution';
    if (undispositionedEntities.length > 0) return 'review-material';
    return 'pending';
  }, [revision, revisionClosed, preview.phase, busy, revisionDataReady, summaryAcknowledged,
      unresolvedColumns.length, undispositionedEntities.length]);

  /**
   * There is no separate step override to go stale: the step is always derived
   * from current props plus the dataset-keyed acknowledgement, so a dataset
   * change, a closed revision or an unready one always wins over whatever the
   * human last navigated to.
   */
  const step = derivedStep;

  /** Leaves the summary for the review queue, for THIS dataset only. */
  function goToReview() {
    if (datasetKey !== null) setSummaryAckKey(datasetKey);
  }
  /** Returns to the summary by withdrawing the acknowledgement. */
  function goToSummary() { setSummaryAckKey(null); }

  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  return (
    <div className="cn2b-simple" dir={dir} data-testid="cn2b-simple-workspace" data-step={step}>
      {step === 'upload' && (
        <PhoenixCard className="cn2b-simple-card" data-testid="cn2b-simple-upload">
          <h2 className="cn2b-simple-hero-title">{t('cn2b_simple_title', lang)}</h2>

          {revisionClosed ? (
            <>
              <p className="cn2b-simple-card__label" data-testid="cn2b-simple-closed-notice">
                {t('cn2b_simple_already_approved', lang)}
              </p>
              {/*
                A closed revision is superseded ONLY by this explicit click —
                never by rendering. It calls the same `openPlanRevision`
                handler Advanced Mode uses, with openNext=true, exactly once.
              */}
              {canImport ? (
                <PhoenixButton
                  type="button" variant="primary" disabled={revisionsLoading || busy}
                  data-testid="cn2b-simple-create-correction"
                  onClick={() => onOpenRevision(true)}
                >
                  {t('cn2b_simple_create_correction', lang)}
                </PhoenixButton>
              ) : (
                <p className="cn2b-simple-card__hint">{t('cn2b_simple_no_import_permission', lang)}</p>
              )}
            </>
          ) : (
            <>
              <p className="cn2b-simple-card__label">
                {t('cn2b_simple_year_label', lang)}: {planYear}
              </p>
              {canImport && !revision && (
                <div className="cn2b-simple-card__actions">
                  <input
                    type="number"
                    className="cn2b-simple-input"
                    aria-label={t('cn2b_plan_year', lang)}
                    value={planYear}
                    onChange={(e) => onPlanYearChange(Number(e.target.value) || planYear)}
                  />
                  <PhoenixButton
                    type="button" variant="primary" disabled={revisionsLoading || busy}
                    data-testid="cn2b-simple-start"
                    onClick={() => onOpenRevision(false)}
                  >
                    {t('cn2b_simple_start', lang)}
                  </PhoenixButton>
                </div>
              )}
              {canImport && revision && isDraft && (
                <>
                  <label className="cn2b-simple-card__actions">
                    <input
                      type="file"
                      accept=".xlsx,.xls,.csv,.zip"
                      data-testid="cn2b-simple-file-input"
                      onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
                    />
                  </label>
                  {pendingFile && (
                    <PhoenixButton
                      type="button" variant="primary" disabled={preview.phase !== 'ready' || busy}
                      onClick={onVerify}
                    >
                      {t('cn2b_simple_upload_button', lang)}
                    </PhoenixButton>
                  )}
                  {preview.phase === 'failed' && (
                    <p className="cn2b-simple-card__error" role="alert">
                      {t('cn2b_preview_failed', lang)} ({preview.reason})
                    </p>
                  )}
                </>
              )}
              {!canImport && (
                <p className="cn2b-simple-card__hint">{t('cn2b_simple_no_import_permission', lang)}</p>
              )}
            </>
          )}
          {error && <div className="cn2b-simple-card__error" role="alert">{error}</div>}
        </PhoenixCard>
      )}

      {step === 'analyzing' && (
        <PhoenixCard className="cn2b-simple-card" data-testid="cn2b-simple-analyzing">
          <p role="status">{t('cn2b_simple_analyzing', lang)}</p>
        </PhoenixCard>
      )}

      {step === 'summary' && (
        <PhoenixCard className="cn2b-simple-card" data-testid="cn2b-simple-summary">
          <p data-testid="cn2b-simple-summary-read">{t('cn2b_simple_file_read', lang)}</p>
          {/*
            SCOPE HONESTY (Director finding 3). These counts do NOT share one
            scope, so neither may be presented as a whole-revision total:
              * institutions comes from `listBeneficiaryColumns(planRevisionId)`
                — revision-wide;
              * materials and quantities come from `listSourceRecords` /
                `listDispositions`, both keyed by `importSessionId` — the
                ACTIVE work session only, and one archive can finalize into
                dozens of sessions.
            A revision-wide material/quantity total would need a read this
            build does not have, so each metric states its own scope instead.
          */}
          <h3 className="cn2b-simple-card__label" data-testid="cn2b-simple-summary-scope-title">
            {t('cn2b_simple_scope_session_title', lang)}
          </h3>
          <dl className="cn2b-simple-summary-grid">
            <div>
              <dt>
                {t('cn2b_simple_institutions', lang)}{' '}
                <span className="cn2b-simple-card__hint" data-testid="cn2b-simple-scope-institutions">
                  {t('cn2b_simple_scope_whole_revision', lang)}
                </span>
              </dt>
              <dd data-testid="cn2b-simple-count-institutions">{counts.institutionsConfirmed}</dd>
            </div>
            <div>
              <dt>
                {t('cn2b_simple_materials', lang)}{' '}
                <span className="cn2b-simple-card__hint" data-testid="cn2b-simple-scope-materials">
                  {t('cn2b_simple_scope_this_session', lang)}
                </span>
              </dt>
              <dd data-testid="cn2b-simple-count-materials">{counts.materialsMapped}</dd>
            </div>
            <div>
              <dt>
                {t('cn2b_simple_quantities', lang)}{' '}
                <span className="cn2b-simple-card__hint" data-testid="cn2b-simple-scope-quantities">
                  {t('cn2b_simple_scope_this_session', lang)}
                </span>
              </dt>
              <dd data-testid="cn2b-simple-count-quantities">{counts.quantityCandidateCount}</dd>
            </div>
          </dl>
          <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-summary-scope-note">
            {t('cn2b_simple_scope_session_note', lang)}
          </p>
          <p data-testid="cn2b-simple-review-remaining">
            {t('cn2b_simple_items_need_review', lang).replace('__N__', String(counts.reviewItemCount))}
          </p>
          <div className="cn2b-simple-card__actions">
            {/*
              The single control that leaves the summary. It is always offered,
              so a dataset with nothing left to review can still advance — the
              summary must be passable, never a dead end.
            */}
            <PhoenixButton
              type="button" variant="primary"
              data-testid="cn2b-simple-review-start"
              onClick={goToReview}
            >
              {counts.reviewItemCount > 0
                ? t('cn2b_simple_review_button', lang).replace('__N__', String(counts.reviewItemCount))
                : t('cn2b_simple_continue', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="secondary" onClick={onSwitchToAdvanced}>
              {t('cn2b_simple_view_details', lang)}
            </PhoenixButton>
            <PhoenixButton type="button" variant="ghost" onClick={onSwitchToAdvanced}>
              {t('cn2b_simple_advanced_options', lang)}
            </PhoenixButton>
          </div>
        </PhoenixCard>
      )}

      {step === 'review-institution' && unresolvedColumns[0] && (
        <>
          <p className="cn2b-simple-progress" data-testid="cn2b-simple-institution-progress">
            {t('cn2b_simple_reviewing_institutions', lang)} ({unresolvedColumns.length})
          </p>
          <SimpleInstitutionCard
            lang={lang}
            planRevisionId={revision!.id}
            editable={canWrite}
            column={unresolvedColumns[0]}
            activeCareInstitutions={careInstitutions}
            onResolved={onChanged}
          />
          <PhoenixButton type="button" variant="ghost" onClick={goToSummary}>
            {t('cn2b_simple_back_to_summary', lang)}
          </PhoenixButton>
        </>
      )}

      {step === 'review-material' && undispositionedEntities[0] && activeSessionId && (
        <>
          <p className="cn2b-simple-progress" data-testid="cn2b-simple-material-progress">
            {t('cn2b_simple_reviewing_materials', lang)} ({undispositionedEntities.length})
          </p>
          <SimpleMaterialCard
            lang={lang}
            importSessionId={activeSessionId}
            editable={canWrite}
            targetEntity={undispositionedEntities[0]}
            fields={fieldsByEntity.get(undispositionedEntities[0]) ?? []}
            onResolved={onChanged}
          />
          <PhoenixButton type="button" variant="ghost" onClick={goToSummary}>
            {t('cn2b_simple_back_to_summary', lang)}
          </PhoenixButton>
        </>
      )}

      {step === 'pending' && (
        <PhoenixCard className="cn2b-simple-card" data-testid="cn2b-simple-pending">
          <p data-testid="cn2b-simple-pending-title">{t('cn2b_simple_reviewed_all', lang)}</p>
          {readinessSummary && readinessSummary.messageKeys.length > 0 && (
            <ul className="cn2b-simple-blockers" data-testid="cn2b-simple-readiness-messages">
              {readinessSummary.messageKeys.map((key) => <li key={key}>{t(key, lang)}</li>)}
            </ul>
          )}
          {readinessSummary && readinessSummary.messageKeys.length === 0 && (
            <p data-testid="cn2b-simple-readiness-clear">{t('cn2b_simple_readiness_clear', lang)}</p>
          )}
          {/*
            HARD BOUNDARY (owner task section 16): this action is always
            disabled in this build. Enabling it requires a separate,
            independently-authorized task once the corpus's source-unit and
            NeedLine-batch contract is proven — see CORPUS-CONTRACT.md.
          */}
          <PhoenixButton type="button" variant="primary" disabled data-testid="cn2b-simple-confirm-quantities">
            {t('cn2b_simple_confirm_quantities', lang)}
          </PhoenixButton>
          <p className="cn2b-simple-card__hint">{t('cn2b_simple_confirm_quantities_disabled_note', lang)}</p>
          <PhoenixButton type="button" variant="ghost" onClick={onSwitchToAdvanced}>
            {t('cn2b_simple_advanced_options', lang)}
          </PhoenixButton>
        </PhoenixCard>
      )}
    </div>
  );
}

export type { SimpleStep };
