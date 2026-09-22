/**
 * Annual Needs — Simple Mode (owner task: "Simple Annual Needs — Corpus
 * Contract + Local Implementation"; then "Simple UX Visual Activation &
 * Convergence", which made this the DEFAULT landing view of الاحتياج السنوي).
 *
 * Presentation-only. Every write goes through the SAME canonical RPCs
 * Advanced Mode already uses (`setBeneficiaryColumns`, `setRecordDisposition`,
 * `openPlanRevision`, `requestUploadTicket`/`uploadToStaging`/`finalizeImport`
 * via the handlers the parent screen passes down). Simple Mode and Advanced
 * Mode read and write the SAME persisted business state — this component
 * introduces no second source of truth and no client-side readiness.
 *
 * THE SHELL. This component owns the whole Simple page: the title block, the
 * six-step progress indicator, ONE main task card for the current step, and
 * the quiet "Advanced options" entry at the end. The Advanced command header,
 * workflow rail, diagnostics and six stage sections are rendered by the
 * parent screen ONLY in Advanced Mode — none of them wraps this view.
 *
 * HARD BOUNDARY (owner task section 16): this component NEVER calls
 * `setNeedLine`. The final "quantities as imported" action is always
 * disabled here — automatic bulk NeedLine persistence is out of scope for
 * this task, pending independent proof of the corpus's unit-lineage
 * contract (see CORPUS-CONTRACT.md). Step 6 therefore hands the human to
 * the Advanced options honestly instead of claiming completion.
 */
import { useMemo, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import type { OrgRow } from '@/shared/supabase/services/organizations.service';
import type { PreviewState } from '../useCentralNeedsPreview';
import { ExcelWorkbookViewer } from '../excel-first/ExcelWorkbookViewer';
import { StoredWorkbookMapping } from './StoredWorkbookMapping';
import { SimpleInstitutionCard } from './SimpleInstitutionCard';
import { SimpleMaterialCard } from './SimpleMaterialCard';
import { SimpleStepper } from './SimpleStepper';
import { SimpleUploadZone } from './SimpleUploadZone';
import { summarizeSimpleReadiness } from './simpleReadiness';
import { computeSimpleCounts } from './simpleCounts';
import { deriveRevisionContext } from '../central-needs.revision-context';
import type {
  BeneficiaryColumnSummary, ImportBatch, PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../central-needs.service';

type SimpleStep = 'upload' | 'analyzing' | 'summary' | 'review-institution' | 'review-material' | 'pending';

/**
 * WHAT the parent screen is busy with, verbatim from its own `Busy` state.
 * Used only to label the analyzing step truthfully — a revision being opened
 * is not "analyzing a file", and the step must not say it is.
 */
type SimpleActivity = null | 'verifying' | 'submitting' | 'approving' | 'rejecting' | 'abandoning' | 'opening';

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
  activity: SimpleActivity;
  onOpenRevision: (openNext: boolean) => void;
  /**
   * C2 — the number of a NEWER revision of the selected revision's own plan,
   * or null when the selection is the newest. A correction can only follow
   * the newest revision (the server's stale fence), so it is withheld while
   * this is set. Optional for older test harnesses; the screen always passes it.
   */
  newerRevisionNumber?: number | null;
  preview: PreviewState;
  pendingFile: File | null;
  onPickFile: (file: File | null) => void;
  onVerify: () => void;
  /** Already translated for a human by the parent (`centralNeedsErrorText`). */
  error: string | null;
  /** Already translated by the parent. */
  notice: string | null;

  readiness: ReviewReadiness | null;
  /**
   * E1.1: revision-scoped immutable source containers. Optional for backwards-
   * compatible test harnesses; production always passes the loaded batches.
   */
  batches?: ImportBatch[];
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
  canImport, canEdit, busy, activity, onOpenRevision, newerRevisionNumber = null, preview, pendingFile, onPickFile, onVerify, error, notice,
  readiness, batches = [], beneficiaryColumns, careInstitutions, records, dispositions, activeSessionId,
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

  /**
   * C1 — the selected revision's context, from the SAME `revision` the parent
   * passes and the SAME pure derivation Advanced Mode uses. Its year is the
   * revision's own plan year or nothing: `planYear` below is only the year
   * typed for a first annual draft and never stands in for a revision's year.
   */
  const revisionContext = useMemo(() => deriveRevisionContext(revision), [revision]);

  // section 18 — a revision already submitted/approved is never silently
  // superseded. A human must explicitly choose to open a correction revision.
  const revisionClosed = revisionContext.isClosed;

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
    // An open draft with NO completed import session has nothing analysed yet:
    // the task is still to upload the file. `activeSessionId` is the screen's
    // own answer to "is there a completed session" (reloadRevision publishes the
    // first completed one, or null) — read here, never recomputed.
    if (activeSessionId === null) return 'upload';
    // Defect 4: the analysis summary is presented once per analyzed dataset,
    // BEFORE item-by-item review. This gates navigation only — readiness,
    // blockers and every unresolved item remain exactly what the server says,
    // and nothing below is skipped, only ordered.
    if (!summaryAcknowledged) return 'summary';
    if (unresolvedColumns.length > 0) return 'review-institution';
    if (undispositionedEntities.length > 0) return 'review-material';
    return 'pending';
  }, [revision, revisionClosed, preview.phase, busy, revisionDataReady, activeSessionId, summaryAcknowledged,
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

  /**
   * Step 2's phases, each shown ONLY with a state the props actually justify.
   *   * a browser-side parse in flight → "reading the file" is the live phase;
   *   * the authoritative verify in flight (`activity === 'verifying'`) → the
   *     file was read (verify needs a ready preview) and the server analysis
   *     is the live phase; "preparing the review" is still waiting because the
   *     screen only publishes the reloaded data once verify has fully returned;
   *   * a plain revision data reload (nothing else in flight) → only the
   *     preparation phase is live; nothing claims a file was read just now;
   *   * any other parent operation → a generic "working" status, no phases.
   */
  const analyzing = useMemo(() => {
    if (preview.phase === 'parsing') {
      return { titleKey: 'cn2b_simple_analyzing', phases: ['active', 'waiting', 'waiting'] as const };
    }
    if (activity === 'verifying') {
      return { titleKey: 'cn2b_simple_analyzing', phases: ['done', 'active', 'waiting'] as const };
    }
    if (busy) return { titleKey: 'cn2b_simple_working', phases: null };
    return { titleKey: 'cn2b_simple_preparing', phases: null };
  }, [preview.phase, activity, busy]);

  const previewReady = preview.phase === 'ready';

  return (
    <div className="cn2b-simple" dir={dir} data-testid="cn2b-simple-workspace" data-step={step}>
      {/* The page identity. Simple Mode owns the screen's h1 — the Advanced
          command header is not rendered around this view. */}
      <header className="cn2b-simple-hero">
        <h1 className="cn2b-simple-title">{t('cn2b_simple_title', lang)}</h1>
        <p className="cn2b-simple-tagline">{t('cn2b_simple_tagline', lang)}</p>
        {/*
          C1 — WHICH plan and revision every action on this page affects,
          stated from the selected revision itself: its plan year (or "—" when
          the registry could not give one — never the calendar year), its
          revision number and its status. Presentation only.
        */}
        {revision !== null && (
          <p
            className="cn2b-simple-tagline"
            data-testid="cn2b-simple-revision-context"
            data-plan-year={revisionContext.planYear ?? ''}
            data-revision-number={revisionContext.revisionNumber ?? ''}
            data-status={revisionContext.status ?? ''}
          >
            {t('cn2b_plan_year', lang)} <bdi>{revisionContext.planYear ?? '—'}</bdi>
            {' · '}{t('cn2b_revision', lang)} {revisionContext.revisionNumber}
            {' · '}
            {/* Plain text on purpose: the task card keeps the one status chip
                (`.cn2b-simple-status`), which the browser suite counts. */}
            <span>{t(`cn2b_revstatus_${revisionContext.status}`, lang)}</span>
          </p>
        )}
      </header>

      <SimpleStepper lang={lang} step={step} />

      {/*
        E1.1 — once a source is authoritatively registered, the original
        workbook remains available from every later Simple step. This is
        deliberately OUTSIDE all `step === ...` branches, so moving from
        upload to summary/institution/material review cannot unmount it.
        It is an AUXILIARY source viewer with its own block class — never a
        second `.cn2b-simple-card`: the page keeps exactly ONE task card.
        `key` makes a revision switch destroy all transient signed-URL/bytes/
        parser state — and the E2-B / E2-C mapping drafts built on it —
        before the next revision can render. E2-C's beneficiary choices are
        the same active care institutions the institution review card uses.
        E2-D binds its LOCAL mapping approval to this revision's id only — it
        never reads or changes the revision's status.
      */}
      {revisionDataReady && revision && batches.length > 0 && (
        <StoredWorkbookMapping key={revision.id} lang={lang} batches={batches} careInstitutions={careInstitutions} planRevisionId={revision.id} />
      )}

      {notice && (
        <p className="cn2b-simple-notice" role="status" data-testid="cn2b-simple-notice">
          <PhoenixIcon name="check" size={16} inline aria-hidden="true" /> {notice}
        </p>
      )}
      {error && step !== 'upload' && (
        <div className="cn2b-simple-error" role="alert" data-testid="cn2b-simple-error">
          <PhoenixIcon name="warning" size={16} inline aria-hidden="true" /> {error}
        </div>
      )}

      {step === 'upload' && (
        <section className="cn2b-simple-card" data-testid="cn2b-simple-upload" aria-labelledby="cn2b-simple-upload-title">
          {revisionClosed ? (
            <>
              <p className="cn2b-simple-card__eyebrow">{t('cn2b_simple_closed_status', lang)}</p>
              <h2 className="cn2b-simple-card__title" id="cn2b-simple-upload-title">
                <span className="cn2b-simple-status" data-status={revision!.status}>
                  {t(`cn2b_revstatus_${revision!.status}`, lang)}
                </span>
                <span>{revisionContext.planYear ?? '—'}</span>
              </h2>
              <p className="cn2b-simple-card__lead" data-testid="cn2b-simple-closed-notice">
                {revision!.status === 'approved'
                  ? t('cn2b_simple_already_approved', lang)
                  : t('cn2b_simple_closed_notice', lang)}
              </p>
              {/*
                A correction is opened ONLY by this explicit click — never by
                rendering. It calls the same parent correction handler Advanced
                Mode uses (`onOpenRevision(true)`), which asks for the reason and
                sends the selected revision's own year and id exactly once. C2:
                the approved revision stays in effect until the correction is
                itself approved; a correction can only follow a DECIDED newest
                revision, so it is withheld otherwise and says why.
              */}
              {canImport ? (
                <>
                  <div className="cn2b-simple-card__actions">
                    <PhoenixButton
                      type="button" variant="primary" size="lg"
                      disabled={revisionsLoading || busy || !revisionContext.correction.ok
                        || !revisionContext.acceptsNextRevisionRequest || newerRevisionNumber !== null}
                      data-testid="cn2b-simple-create-correction"
                      onClick={() => onOpenRevision(true)}
                    >
                      {t('cn2b_simple_create_correction', lang)}
                    </PhoenixButton>
                  </div>
                  {revisionContext.correction.ok && revisionContext.revisionNumber !== null && (
                    <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-correction-target">
                      {t('cn2b_correction_target', lang)
                        .replace('__YEAR__', String(revisionContext.correction.planYear))
                        .replace('__N__', String(revisionContext.revisionNumber))}
                      {' '}{t('cn2b_correction_keeps_effective', lang)}
                    </p>
                  )}
                  {/* C1 — no trustworthy plan year, no correction: fail closed and say why. */}
                  {!revisionContext.correction.ok && (
                    <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-correction-year-unavailable">
                      {t('cn2b_err_revision_plan_year_unavailable', lang)}
                    </p>
                  )}
                  {revisionContext.correction.ok && newerRevisionNumber !== null && (
                    <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-correction-newer-revision">
                      {t('cn2b_correction_newer_revision_exists', lang).replace('__N__', String(newerRevisionNumber))}
                    </p>
                  )}
                </>
              ) : (
                <p className="cn2b-simple-card__hint">{t('cn2b_simple_no_import_permission', lang)}</p>
              )}
            </>
          ) : !revision ? (
            <>
              <p className="cn2b-simple-card__eyebrow">{t('cn2b_simple_step_upload', lang)}</p>
              <h2 className="cn2b-simple-card__title" id="cn2b-simple-upload-title">{t('cn2b_simple_year_choose', lang)}</h2>
              <p className="cn2b-simple-card__lead">{t('cn2b_simple_year_hint', lang)}</p>
              {canImport ? (
                <div className="cn2b-simple-year">
                  <label className="cn2b-simple-field">
                    <span className="cn2b-simple-field__label">{t('cn2b_plan_year', lang)}</span>
                    <input
                      type="number"
                      className="cn2b-simple-input cn2b-simple-input--year"
                      inputMode="numeric"
                      min={2000}
                      max={2100}
                      value={planYear}
                      onChange={(e) => onPlanYearChange(Number(e.target.value) || planYear)}
                    />
                  </label>
                  <PhoenixButton
                    type="button" variant="primary" size="lg" disabled={revisionsLoading || busy}
                    data-testid="cn2b-simple-start"
                    onClick={() => onOpenRevision(false)}
                  >
                    {t('cn2b_simple_start', lang)}
                  </PhoenixButton>
                </div>
              ) : (
                <div className="cn2b-simple-permission" role="status">
                  <PhoenixIcon name="lock" size={18} inline aria-hidden="true" />
                  <span>
                    <strong>{t('cn2b_simple_no_import_permission', lang)}</strong>
                    <br />{t('cn2b_simple_no_import_permission_hint', lang)}
                  </span>
                </div>
              )}
            </>
          ) : (
            <>
              <p className="cn2b-simple-card__eyebrow">
                <span className="cn2b-simple-status" data-status="draft">{t('cn2b_revstatus_draft', lang)}</span>
                {' '}{t('cn2b_simple_draft_open', lang).replace('__YEAR__', String(revisionContext.planYear ?? '—'))}
              </p>
              <h2 className="cn2b-simple-card__title" id="cn2b-simple-upload-title">{t('cn2b_simple_upload_title', lang)}</h2>
              {canImport && isDraft ? (
                <>
                  <SimpleUploadZone
                    lang={lang}
                    pendingFile={pendingFile}
                    previewReady={previewReady}
                    disabled={busy}
                    onPickFile={onPickFile}
                  />
                  {preview.phase === 'failed' && (
                    <div className="cn2b-simple-error" role="alert" data-testid="cn2b-simple-preview-failed">
                      <PhoenixIcon name="warning" size={16} inline aria-hidden="true" />{' '}
                      {t('cn2b_preview_failed', lang)} ({preview.reason})
                    </div>
                  )}
                  {pendingFile && (
                    <div className="cn2b-simple-card__actions">
                      <PhoenixButton
                        type="button" variant="primary" size="lg" disabled={!previewReady || busy}
                        data-testid="cn2b-simple-upload-submit"
                        onClick={onVerify}
                      >
                        {t('cn2b_simple_upload_button', lang)}
                      </PhoenixButton>
                    </div>
                  )}
                  {error && (
                    <div className="cn2b-simple-error" role="alert" data-testid="cn2b-simple-error">
                      <PhoenixIcon name="warning" size={16} inline aria-hidden="true" /> {error}
                    </div>
                  )}
                  {/*
                    E1 Excel-First — the original workbook, read-only, exactly
                    as the browser preview above already parsed it. It is
                    handed that preview's own result: no second parse, no
                    write path, and nothing it shows changes what "upload"
                    sends.
                  */}
                  {preview.phase === 'ready' && (
                    <ExcelWorkbookViewer lang={lang} kind={preview.outcome.kind} result={preview.outcome.result} />
                  )}
                  <p className="cn2b-simple-trust">
                    <PhoenixIcon name="lock" size={15} inline aria-hidden="true" /> {t('cn2b_simple_trust_note', lang)}
                  </p>
                </>
              ) : (
                <div className="cn2b-simple-permission" role="status">
                  <PhoenixIcon name="lock" size={18} inline aria-hidden="true" />
                  <span>
                    <strong>{t('cn2b_simple_no_import_permission', lang)}</strong>
                    <br />{t('cn2b_simple_no_import_permission_hint', lang)}
                  </span>
                </div>
              )}
            </>
          )}
          {error && !(canImport && isDraft && !revisionClosed) && (
            <div className="cn2b-simple-error" role="alert" data-testid="cn2b-simple-error">
              <PhoenixIcon name="warning" size={16} inline aria-hidden="true" /> {error}
            </div>
          )}
        </section>
      )}

      {step === 'analyzing' && (
        <section className="cn2b-simple-card cn2b-simple-card--analyzing" data-testid="cn2b-simple-analyzing" aria-labelledby="cn2b-simple-analyzing-title">
          <div className="cn2b-simple-spinner" aria-hidden="true" />
          <div role="status" aria-live="polite" className="cn2b-simple-analyzing__status">
            <h2 className="cn2b-simple-card__title" id="cn2b-simple-analyzing-title">{t(analyzing.titleKey, lang)}</h2>
            <p className="cn2b-simple-card__lead">{t('cn2b_simple_analyzing_note', lang)}</p>
          </div>
          <div className="cn2b-simple-progressbar" aria-hidden="true"><span /></div>
          {analyzing.phases && (
            <ol className="cn2b-simple-phases" aria-label={t('cn2b_simple_processing_status', lang)} data-testid="cn2b-simple-phases">
              {(['cn2b_simple_phase_read', 'cn2b_simple_phase_analyze', 'cn2b_simple_phase_prepare'] as const).map((key, i) => {
                const state = analyzing.phases[i];
                return (
                  <li key={key} className="cn2b-simple-phase" data-state={state}>
                    <span className="cn2b-simple-phase__mark" aria-hidden="true">
                      {state === 'done' ? <PhoenixIcon name="check" size={14} /> : i + 1}
                    </span>
                    <span className="cn2b-simple-phase__text">{t(key, lang)}</span>
                    <span className="cn2b-simple-phase__state">{t(`cn2b_simple_phase_${state}`, lang)}</span>
                  </li>
                );
              })}
            </ol>
          )}
        </section>
      )}

      {step === 'summary' && (
        <section className="cn2b-simple-card" data-testid="cn2b-simple-summary" aria-labelledby="cn2b-simple-summary-title">
          <p className="cn2b-simple-card__eyebrow cn2b-simple-card__eyebrow--ok" data-testid="cn2b-simple-summary-read">
            <PhoenixIcon name="check" size={15} inline aria-hidden="true" /> {t('cn2b_simple_file_read', lang)}
          </p>
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
          <h2 className="cn2b-simple-card__title" id="cn2b-simple-summary-title" data-testid="cn2b-simple-summary-scope-title">
            {t('cn2b_simple_scope_session_title', lang)}
          </h2>
          <dl className="cn2b-simple-stats">
            <div className="cn2b-simple-stat">
              <dt className="cn2b-simple-stat__label">
                {t('cn2b_simple_institutions', lang)}
                <span className="cn2b-simple-stat__scope" data-testid="cn2b-simple-scope-institutions">
                  {t('cn2b_simple_scope_whole_revision', lang)}
                </span>
              </dt>
              <dd className="cn2b-simple-stat__value" data-testid="cn2b-simple-count-institutions">{counts.institutionsConfirmed}</dd>
            </div>
            <div className="cn2b-simple-stat">
              <dt className="cn2b-simple-stat__label">
                {t('cn2b_simple_materials', lang)}
                <span className="cn2b-simple-stat__scope" data-testid="cn2b-simple-scope-materials">
                  {t('cn2b_simple_scope_this_session', lang)}
                </span>
              </dt>
              <dd className="cn2b-simple-stat__value" data-testid="cn2b-simple-count-materials">{counts.materialsMapped}</dd>
            </div>
            <div className="cn2b-simple-stat">
              <dt className="cn2b-simple-stat__label">
                {t('cn2b_simple_quantities', lang)}
                <span className="cn2b-simple-stat__scope" data-testid="cn2b-simple-scope-quantities">
                  {t('cn2b_simple_scope_this_session', lang)}
                </span>
              </dt>
              <dd className="cn2b-simple-stat__value" data-testid="cn2b-simple-count-quantities">{counts.quantityCandidateCount}</dd>
            </div>
          </dl>
          <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-summary-scope-note">
            {t('cn2b_simple_scope_session_note', lang)}
          </p>
          <div
            className="cn2b-simple-review-count"
            data-empty={counts.reviewItemCount === 0}
            data-testid="cn2b-simple-review-remaining"
          >
            <PhoenixIcon name={counts.reviewItemCount > 0 ? 'clipboard' : 'check'} size={20} aria-hidden="true" />
            <span>
              {counts.reviewItemCount > 0
                ? t('cn2b_simple_items_need_review', lang).replace('__N__', String(counts.reviewItemCount))
                : t('cn2b_simple_nothing_to_review', lang)}
            </span>
          </div>
          <div className="cn2b-simple-card__actions">
            {/*
              The single control that leaves the summary. It is always offered,
              so a dataset with nothing left to review can still advance — the
              summary must be passable, never a dead end.
            */}
            <PhoenixButton
              type="button" variant="primary" size="lg"
              data-testid="cn2b-simple-review-start"
              onClick={goToReview}
            >
              {counts.reviewItemCount > 0
                ? t('cn2b_simple_review_button', lang).replace('__N__', String(counts.reviewItemCount))
                : t('cn2b_simple_continue', lang)}
            </PhoenixButton>
          </div>
        </section>
      )}

      {step === 'review-institution' && unresolvedColumns[0] && (
        <>
          <div className="cn2b-simple-review-head">
            <p className="cn2b-simple-progress" data-testid="cn2b-simple-institution-progress">
              <PhoenixIcon name="hospital" size={16} inline aria-hidden="true" />
              {' '}{t('cn2b_simple_reviewing_institutions', lang)}
              {' '}<span className="cn2b-simple-progress__count">{t('cn2b_simple_remaining', lang)}: {unresolvedColumns.length}</span>
            </p>
            <p className="cn2b-simple-review-head__hint">{t('cn2b_simple_institution_step_hint', lang)}</p>
          </div>
          <SimpleInstitutionCard
            lang={lang}
            planRevisionId={revision!.id}
            editable={canWrite}
            column={unresolvedColumns[0]}
            activeCareInstitutions={careInstitutions}
            onResolved={onChanged}
          />
          <div className="cn2b-simple-review-foot">
            <PhoenixButton type="button" variant="ghost" size="sm" onClick={goToSummary}>
              {t('cn2b_simple_back_to_summary', lang)}
            </PhoenixButton>
          </div>
        </>
      )}

      {step === 'review-material' && undispositionedEntities[0] && activeSessionId && (
        <>
          <div className="cn2b-simple-review-head">
            <p className="cn2b-simple-progress" data-testid="cn2b-simple-material-progress">
              <PhoenixIcon name="package" size={16} inline aria-hidden="true" />
              {' '}{t('cn2b_simple_reviewing_materials', lang)}
              {' '}<span className="cn2b-simple-progress__count">{t('cn2b_simple_remaining', lang)}: {undispositionedEntities.length}</span>
            </p>
            <p className="cn2b-simple-review-head__hint">{t('cn2b_simple_material_step_hint', lang)}</p>
          </div>
          <SimpleMaterialCard
            lang={lang}
            importSessionId={activeSessionId}
            editable={canWrite}
            targetEntity={undispositionedEntities[0]}
            fields={fieldsByEntity.get(undispositionedEntities[0]) ?? []}
            onResolved={onChanged}
          />
          <div className="cn2b-simple-review-foot">
            <PhoenixButton type="button" variant="ghost" size="sm" onClick={goToSummary}>
              {t('cn2b_simple_back_to_summary', lang)}
            </PhoenixButton>
          </div>
        </>
      )}

      {step === 'pending' && (
        <section className="cn2b-simple-card cn2b-simple-card--outcome" data-testid="cn2b-simple-pending" aria-labelledby="cn2b-simple-pending-title">
          <div className="cn2b-simple-outcome__mark" data-ready={readinessSummary?.ready === true} aria-hidden="true">
            <PhoenixIcon name={readinessSummary?.ready ? 'check' : 'clipboard'} size={28} />
          </div>
          <h2 className="cn2b-simple-card__title" id="cn2b-simple-pending-title" data-testid="cn2b-simple-pending-title">
            {t('cn2b_simple_reviewed_all', lang)}
          </h2>
          {/*
            READINESS IS THE SERVER'S. Three honest cases, none synthesized:
            the server said ready, the server listed blockers, or the server
            has not answered yet. "كل شيء جاهز" is never shown from this file.
          */}
          {readinessSummary === null && (
            <p className="cn2b-simple-card__lead" data-testid="cn2b-simple-readiness-unknown">
              {t('cn2b_simple_readiness_unknown', lang)}
            </p>
          )}
          {readinessSummary && readinessSummary.messageKeys.length > 0 && (
            <>
              <p className="cn2b-simple-card__lead">{t('cn2b_simple_final_server_pending', lang)}</p>
              <ul className="cn2b-simple-blockers" data-testid="cn2b-simple-readiness-messages">
                {readinessSummary.messageKeys.map((key) => (
                  <li key={key}>
                    <PhoenixIcon name="warning" size={15} inline aria-hidden="true" /> {t(key, lang)}
                  </li>
                ))}
              </ul>
            </>
          )}
          {readinessSummary && readinessSummary.messageKeys.length === 0 && (
            <p className="cn2b-simple-card__lead" data-testid="cn2b-simple-readiness-clear">
              {readinessSummary.ready
                ? t('cn2b_simple_final_server_ready', lang)
                : t('cn2b_simple_readiness_clear', lang)}
            </p>
          )}

          <div className="cn2b-simple-handoff" data-testid="cn2b-simple-handoff">
            <p className="cn2b-simple-handoff__text">{t('cn2b_simple_final_handoff', lang)}</p>
            <div className="cn2b-simple-card__actions">
              <PhoenixButton
                type="button" variant="primary" size="lg"
                data-testid="cn2b-simple-continue-advanced"
                onClick={onSwitchToAdvanced}
              >
                {t('cn2b_simple_final_continue_advanced', lang)}
              </PhoenixButton>
            </div>
          </div>

          {/*
            HARD BOUNDARY (owner task section 16): this action is always
            disabled in this build. Enabling it requires a separate,
            independently-authorized task once the corpus's source-unit and
            NeedLine-batch contract is proven — see CORPUS-CONTRACT.md.
          */}
          <details className="cn2b-simple-unavailable">
            <summary>{t('cn2b_simple_confirm_quantities', lang)}</summary>
            <div className="cn2b-simple-unavailable__body">
              <PhoenixButton type="button" variant="secondary" size="sm" disabled data-testid="cn2b-simple-confirm-quantities">
                {t('cn2b_simple_confirm_quantities', lang)}
              </PhoenixButton>
              <p className="cn2b-simple-card__hint">{t('cn2b_simple_confirm_quantities_disabled_note', lang)}</p>
            </div>
          </details>
        </section>
      )}

      {/*
        The Advanced entry: present on every step, visually secondary, at the
        end. Switching is presentation only — the parent keeps every piece of
        state; nothing is reloaded or reset by entering Advanced Mode.
      */}
      <footer className="cn2b-simple-footer">
        <PhoenixButton
          type="button" variant="ghost" size="sm"
          data-testid="cn2b-simple-advanced-link"
          onClick={onSwitchToAdvanced}
        >
          <PhoenixIcon name="settings" size={15} aria-hidden="true" />
          {t('cn2b_simple_advanced_options', lang)}
        </PhoenixButton>
        <span className="cn2b-simple-footer__hint">{t('cn2b_simple_advanced_hint', lang)}</span>
      </footer>
    </div>
  );
}

export type { SimpleStep, SimpleActivity };
