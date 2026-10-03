/**
 * Annual Needs — Simple Mode (owner task: "Simple Annual Needs — Corpus
 * Contract + Local Implementation"; then "Simple UX Visual Activation &
 * Convergence", which made this the DEFAULT landing view of الاحتياج السنوي;
 * then CN-UI-S1, which made it the COMPLETE normal workflow).
 *
 * Presentation-only. Every write goes through the SAME canonical RPCs
 * Advanced Mode already uses (`setBeneficiaryColumns`, `setRecordDisposition`,
 * `openPlanRevision`, `requestUploadTicket`/`uploadToStaging`/`finalizeImport`
 * via the handlers the parent screen passes down). Simple Mode and Advanced
 * Mode read and write the SAME persisted business state — this component
 * introduces no second source of truth and no client-side readiness.
 *
 * THE SHELL. This component owns the whole Simple page: the title block, the
 * six-step progress indicator and ONE main task card for the current step.
 * The Advanced command header, workflow rail, diagnostics and six stage
 * sections are rendered by the parent screen ONLY in Advanced Mode — none of
 * them wraps this view, and this view offers no GENERIC way into it: no
 * footer, no "advanced options", no mode toggle. The only way out is the
 * CONTEXTUAL expert escape (CN-UI-S1 HC1, `ExpertEscapeBlock`), which exists
 * only while the server's own blockers name a condition this view has no
 * control for, and opens exactly the one Advanced stage that resolves it.
 *
 * CN-UI-S1 — THE WHOLE NORMAL WORKFLOW HAPPENS HERE: annual draft → upload and
 * verify → institutions → materials → need lines → submit → approve/reject →
 * terminal state. The three surfaces that carry canonical behaviour are not
 * re-implemented: the screen builds each ONCE and hands the element in —
 * `workSessionPicker` (its one Work Session switch algorithm and guard),
 * `needLineWorkspace` (the CN-UI-R1 need-line panel, with its own region-aware
 * resolver and canonical writes) and `lifecycleActions` (its submit / approve /
 * reject handlers). This component only decides WHERE they appear, so it still
 * names no need-line write, panel or lifecycle RPC itself.
 *
 * HARD BOUNDARY (owner task section 16): the bulk "quantities as imported"
 * action stays disabled — automatic bulk NeedLine persistence is out of scope,
 * pending independent proof of the corpus's unit-lineage contract (see
 * CORPUS-CONTRACT.md). Need lines are built one decision at a time in the
 * canonical panel instead.
 */
import { useMemo, type ReactNode } from 'react';
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
import {
  deriveSimpleExpertEscapes, summarizeSimpleReadiness,
  type SimpleExpertEscape, type SimpleExpertReason, type SimpleExpertStage, type SimpleOverrideContext,
} from './simpleReadiness';
import { computeSimpleCounts } from './simpleCounts';
import { deriveRevisionContext } from '../central-needs.revision-context';
import { CENTRAL_NEEDS_STAGES } from '../CentralNeedsWorkflowNav';
import type {
  BeneficiaryColumnSummary, CentralNeedsError, FieldOverride, ImportBatch, ImportSession, PlanRevision, RecordDisposition, ReviewReadiness, SourceRecord,
} from '../central-needs.service';
import type { RegionReadState } from '../regions/beneficiaryRegions';
import { RegionWorkspaceProvider } from '../regions/RegionWorkspace';

type SimpleStep = 'upload' | 'analyzing' | 'review-institution' | 'review-material' | 'need-lines' | 'pending';

/**
 * WHAT the parent screen is busy with, verbatim from its own `Busy` state.
 * Used only to label the analyzing step truthfully — a revision being opened
 * is not "analyzing a file", and the step must not say it is.
 */
type SimpleActivity = null | 'verifying' | 'submitting' | 'approving' | 'rejecting' | 'abandoning' | 'opening';

/**
 * CN-UI-S1 — a lifecycle action runs ON the outcome step, beside the control
 * that started it. It never sends the page to "analyzing": that would unmount
 * the need-line workspace (and any draft in it) for the length of a click.
 */
const LIFECYCLE_ACTIVITIES: ReadonlySet<SimpleActivity> = new Set<SimpleActivity>(['submitting', 'approving', 'rejecting']);

/** CN-UI-S1 HC1 / HC1.1 / HC1.2 — the sentence that says WHY each contextual expert escape exists. */
const EXPERT_BODY_KEY: Readonly<Record<SimpleExpertReason, string>> = {
  open_import: 'cn2b_simple_expert_body_open_import',
  numeric_override: 'cn2b_simple_expert_body_numeric_override',
  source_evidence_invalid: 'cn2b_simple_expert_body_source_evidence_invalid',
  override_head_unproven: 'cn2b_simple_expert_body_override_head_unproven',
  unknown_blocker: 'cn2b_simple_expert_body_unknown',
  unknown_lineage_reason: 'cn2b_simple_expert_body_unknown_lineage',
};

/**
 * The title of each escape. The four DIAGNOSTIC ones (invalid immutable
 * evidence, an unproven override head, an unknown blocker, an unknown lineage
 * reason) are reading and escalation, not a remedy, and their title says so; the
 * map is total, so a new reason cannot silently inherit the remedy-implying title.
 */
const EXPERT_TITLE_KEY: Readonly<Record<SimpleExpertReason, string>> = {
  open_import: 'cn2b_simple_expert_title',
  numeric_override: 'cn2b_simple_expert_title',
  source_evidence_invalid: 'cn2b_simple_expert_title_unknown',
  override_head_unproven: 'cn2b_simple_expert_title_unknown',
  unknown_blocker: 'cn2b_simple_expert_title_unknown',
  unknown_lineage_reason: 'cn2b_simple_expert_title_unknown',
};

/**
 * CN-UI-S1 HC1 — ONE contextual expert escape: why Simple cannot resolve what
 * the server reported, and a real button that opens exactly the Advanced stage
 * that can resolve it — or, for the DIAGNOSTIC escapes, that shows exactly what the
 * server returned (named in the sentence AND on the button; no remedy is claimed). Not a general mode
 * switch, not a footer, not a step: it exists only while `escape` does. The
 * button is offered only to someone holding the permission that stage needs;
 * anyone else reads who to ask instead. Presentation only — it holds no state
 * and calls only the callback the screen gave it.
 */
function ExpertEscapeBlock({ lang, escape, allowed, busy, onOpen }: {
  lang: 'ar' | 'en';
  escape: SimpleExpertEscape;
  allowed: boolean;
  busy: boolean;
  onOpen: (stage: SimpleExpertStage) => void;
}) {
  const stageTitle = t(CENTRAL_NEEDS_STAGES.find((stage) => stage.id === escape.stage)?.titleKey ?? 'cn2b_stage_readiness', lang);
  return (
    <div
      className="cn2b-simple-expert"
      role="group"
      aria-labelledby="cn2b-simple-expert-title"
      data-testid="cn2b-simple-expert-escape"
      data-reason={escape.reason}
      data-stage={escape.stage}
    >
      <p className="cn2b-simple-expert__title" id="cn2b-simple-expert-title">
        <PhoenixIcon name="settings" size={15} inline aria-hidden="true" />{' '}
        {t(EXPERT_TITLE_KEY[escape.reason], lang)}
      </p>
      <p className="cn2b-simple-expert__body" id="cn2b-simple-expert-body">
        {t(EXPERT_BODY_KEY[escape.reason], lang).replace('__STAGE__', stageTitle)}
      </p>
      {allowed ? (
        <PhoenixButton
          type="button" variant="secondary" disabled={busy}
          aria-describedby="cn2b-simple-expert-body"
          data-testid="cn2b-simple-expert-open"
          onClick={() => onOpen(escape.stage)}
        >
          {t('cn2b_simple_expert_open', lang).replace('__STAGE__', stageTitle)}
        </PhoenixButton>
      ) : (
        <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-expert-no-permission">
          {t('cn2b_simple_expert_no_permission', lang)}
        </p>
      )}
    </div>
  );
}

interface Props {
  lang: 'ar' | 'en';
  planYear: number;
  onPlanYearChange: (year: number) => void;
  revisionsLoading: boolean;
  revision: PlanRevision | null;
  isDraft: boolean;
  revisionDataReady: boolean;
  /**
   * The SAME raw `central_needs.import` boolean `CentralNeedsScreen` derives
   * from `myPermissions`. It gates the file upload only — the one thing the
   * server's import guard protects.
   */
  canImport: boolean;
  /**
   * The SAME raw `central_needs.edit` boolean `CentralNeedsScreen` derives
   * from `myPermissions`. This component ANDs it with `isDraft` itself, so a
   * mutation control is offered under exactly the condition Advanced Mode
   * uses at its own call sites (`editable={canEdit && isDraft}`). CN-UI-S1:
   * it also gates opening an annual draft or a correction, exactly as the
   * server guards those (edit) and as Advanced's plan stage already offers
   * them. The server RPC remains the final authority either way.
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
  /**
   * CN-UI-S1 — the screen's own "the active session's rows are still being
   * read, or are not yet provably that session's" flag. While it is set,
   * `records`/`dispositions` may still be the PREVIOUS session's, so no review
   * card or need-line surface may be offered against the new
   * `activeSessionId`. Optional for older harnesses (never loading).
   */
  sessionLoading?: boolean;
  onChanged: () => void;
  /**
   * C6-B1 — a CONFIRMED material decision. A disposition lives in the active
   * import session, so the revision re-read behind `onChanged` does not carry
   * it: the screen re-reads the session's dispositions (and readiness) here, and
   * the material queue moves only when that server re-read shows the decision.
   * Institution and region writes keep `onChanged`. Absent (older harnesses),
   * the material card falls back to `onChanged`.
   */
  onMaterialResolved?: () => void;
  /**
   * CN-UI-S1 — where the material card reports its busy/dirty/failed. The
   * screen passes the setter its Work Session guard already reads, so a
   * session switch waits for an in-flight decision and asks before a typed
   * reason is dropped.
   */
  onMaterialActivityChange?: (activity: { busy: boolean; dirty: boolean; failed: boolean }) => void;
  /**
   * CN-UI-S1 HC1.1 — where the stored-workbook mapping surface reports its
   * busy/dirty/failed: in-memory mapping work that unmounting this workspace
   * would discard, and a beneficiary-region write in flight. The screen reads it
   * only for the contextual expert escape's guard; the surface releases it when
   * it leaves the tree. Absent (older harnesses), nothing is reported.
   */
  onStoredWorkbookActivityChange?: (activity: { busy: boolean; dirty: boolean; failed: boolean }) => void;
  /**
   * CN-UI-S1 HC1.2 — the override chain the screen ALREADY holds (the very props
   * it gives the need-line panel), so the contextual escape can tell whether a
   * `binding_invalid` cell has a CURRENT NUMERIC head Simple can re-pin. Both are
   * needed: without either (older harnesses) the head is unproven and the escape
   * fails closed to the readiness stage. Read-only; nothing is requested here.
   */
  overrides?: readonly FieldOverride[];
  overrideReadFailure?: string | null;
  /**
   * C5 §17 (UI-F3) — a server refusal of a card's write, so the screen can re-read
   * the registry and the revision when the revision's lifecycle moved.
   */
  onRefused?: (refusal: CentralNeedsError) => void;
  /**
   * C4: the revision's ACTIVE beneficiary regions, read fresh from the server
   * by the screen, or why they could not be read. The screen always passes it;
   * an older harness that passes none gets no region layer at all.
   */
  beneficiaryRegions?: RegionReadState;
  /** C4: the revision's import sessions (parser identities back the G3 check). */
  sessions?: readonly ImportSession[];
  /**
   * CN-UI-S1 — the screen's ONE Work Session selector, already bound to its
   * one switch handler and busy/dirty guard. Placed here, never re-implemented.
   */
  workSessionPicker?: ReactNode;
  /**
   * CN-UI-S1 — the screen's ONE need-line panel element (the canonical,
   * region-aware CentralNeedsNeedLinePanel with its canonical props). Placed
   * here, never re-implemented; its edit gate is its own `editable` prop.
   */
  needLineWorkspace?: ReactNode;
  /**
   * CN-UI-S1 — the screen's ONE lifecycle action block (submit for an editor
   * of a ready draft; approve/reject for an approver of a submitted revision),
   * gated by the screen exactly as Advanced's readiness stage is.
   */
  lifecycleActions?: ReactNode;
  /**
   * CN-UI-S1 HC1 — opens the Advanced `stage` for a condition the SERVER
   * reported and Simple has no control for (see `deriveSimpleExpertEscape`).
   * The screen owns the busy/dirty guard and the presentation switch; absent
   * (older harnesses) no escape is rendered, because it could not act.
   */
  onExpertEscape?: (stage: SimpleExpertStage) => void;
}

export function CentralNeedsSimpleWorkspace({
  lang, planYear, onPlanYearChange, revisionsLoading, revision, isDraft, revisionDataReady,
  canImport, canEdit, busy, activity, onOpenRevision, newerRevisionNumber = null, preview, pendingFile, onPickFile, onVerify, error, notice,
  readiness, batches = [], beneficiaryColumns, careInstitutions, records, dispositions, activeSessionId, sessionLoading = false,
  onChanged, onMaterialResolved, onMaterialActivityChange, onStoredWorkbookActivityChange, overrides, overrideReadFailure, onRefused, beneficiaryRegions, sessions,
  workSessionPicker, needLineWorkspace, lifecycleActions, onExpertEscape,
}: Props) {
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
   * The single source of the visible step: current props only. There is no
   * navigation state at all — no acknowledgement, no override — so nothing can
   * go stale across a revision, session or readiness change. Presentation-only
   * routing, never business readiness: the order of these guards is the
   * contract.
   *   * a closed revision lands on the outcome step BEFORE any blocker
   *     projection (C5 §17) — its terminal sentence, and the decision when it
   *     is submitted;
   *   * a parse, a verify, an open, or data that is not yet this revision's
   *     (or this session's) is "analyzing" — never a card acting on stale rows;
   *   * then the queues the server's own state leaves: institutions
   *     (revision-wide), materials (the ACTIVE session), the need lines, and
   *     the outcome once the SERVER says the draft is ready.
   */
  const derivedStep: SimpleStep = useMemo(() => {
    if (!revision) return 'upload';
    if (revisionClosed) return 'pending';
    if (preview.phase === 'parsing' || (busy && !LIFECYCLE_ACTIVITIES.has(activity))) return 'analyzing';
    if (!revisionDataReady) return 'analyzing';
    // An open draft with NO completed import session has nothing analysed yet:
    // the task is still to upload the file. `activeSessionId` is the screen's
    // own answer to "is there a completed session" (reloadRevision publishes the
    // first completed one, or null) — read here, never recomputed.
    if (activeSessionId === null) return 'upload';
    if (sessionLoading) return 'analyzing';
    if (unresolvedColumns.length > 0) return 'review-institution';
    if (undispositionedEntities.length > 0) return 'review-material';
    // READINESS IS THE SERVER'S: only its own `ready` reaches the outcome.
    if (readinessSummary?.ready === true) return 'pending';
    return 'need-lines';
  }, [revision, revisionClosed, preview.phase, busy, activity, revisionDataReady, activeSessionId, sessionLoading,
      unresolvedColumns.length, undispositionedEntities.length, readinessSummary]);

  const step = derivedStep;

  /**
   * The active session's context — the canonical Work Session selector and
   * the two scope-labelled figures — wherever the work on screen is
   * session-scoped: material review, the need lines and the draft's outcome,
   * and while a newly chosen session's rows are still being read.
   */
  const showSessionContext = revision !== null && !revisionClosed && revisionDataReady && activeSessionId !== null
    && (step === 'review-material' || step === 'need-lines' || step === 'pending' || (step === 'analyzing' && sessionLoading));

  /**
   * The canonical need-line workspace: on the need-lines step and the outcome
   * step (one tree position for both, so a draft in it survives the server
   * turning ready), read-only on a closed revision by the panel's own gate.
   * Never while the active session's rows are still the previous session's.
   */
  const showNeedLineWorkspace = needLineWorkspace != null && revisionDataReady && !sessionLoading
    && (step === 'need-lines' || step === 'pending');

  /**
   * CN-UI-S1 HC1 — the contextual expert escape, from the SAME readiness the
   * screen owns. It is read only while that readiness provably belongs to the
   * selected revision, and shown only on the two steps where the person would
   * otherwise be stuck on a blocker they can read but not act on: the
   * need-lines card, and the upload step (an open import attempt with no
   * completed session yet). Never for a closed revision, never while data or
   * the active session's rows are still loading, and never without a callback
   * to act with. Whether the person MAY use the stage it opens follows the
   * permission that stage's own controls require in Advanced (abandoning an
   * import attempt: import; recording a numeric correction: edit; reading the
   * server's answer: none). When several escapes apply, the first one the person
   * CAN act on is offered; only when none is, the first is shown with who to ask.
   */
  const overrideContext = useMemo<SimpleOverrideContext | undefined>(
    () => (overrides !== undefined && overrideReadFailure !== undefined ? { overrides, overrideReadFailure } : undefined),
    [overrides, overrideReadFailure],
  );
  const expertEscapes = useMemo(
    () => (revision !== null && readiness !== null && readiness.planRevisionId === revision.id
      ? deriveSimpleExpertEscapes(readiness, overrideContext)
      : []),
    [revision, readiness, overrideContext],
  );
  const expertStageAllowed = (stage: SimpleExpertStage): boolean => (
    stage === 'source' ? canImport && isDraft
      : stage === 'review' ? canWrite
        : true
  );
  const expertEscape = expertEscapes.find((escape) => expertStageAllowed(escape.stage)) ?? expertEscapes[0] ?? null;
  const expertEscapeShown = expertEscape !== null && onExpertEscape !== undefined
    && !revisionClosed && isDraft && revisionDataReady && !sessionLoading;
  const expertEscapeAllowed = expertEscape !== null && expertStageAllowed(expertEscape.stage);

  const dir = lang === 'ar' ? 'rtl' : 'ltr';

  /**
   * Step 2's phases, each shown ONLY with a state the props actually justify.
   *   * a browser-side parse in flight → "reading the file" is the live phase;
   *   * the authoritative verify in flight (`activity === 'verifying'`) → the
   *     file was read (verify needs a ready preview) and the server analysis
   *     is the live phase; "preparing the review" is still waiting because the
   *     screen only publishes the reloaded data once verify has fully returned;
   *   * a plain revision or session data read (nothing else in flight) → only
   *     the preparation phase is live; nothing claims a file was read just now;
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
    // C4 — the region context for the surfaces below: which columns ACTIVE
    // regions govern, the write gate, the sessions for G3, the reload after a
    // region write, and the unsaved workbook Need sources.
    <RegionWorkspaceProvider regions={beneficiaryRegions} canWrite={canWrite} sessions={sessions ?? NO_SESSIONS} onChanged={onChanged}>
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
        upload to institution/material review cannot unmount it.
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
        <StoredWorkbookMapping key={revision.id} lang={lang} batches={batches} careInstitutions={careInstitutions} planRevisionId={revision.id}
          onActivityChange={onStoredWorkbookActivityChange} />
      )}

      {/*
        CN-UI-S1 — compact context, not a summary step: WHICH work session the
        session-scoped work below belongs to (the screen's own selector, so a
        switch runs through its one guard), and two figures that each state
        their own scope. One fixed position, so moving between these steps
        never remounts the selector.
      */}
      {showSessionContext && (
        <section className="cn2b-simple-context" data-testid="cn2b-simple-context" aria-label={t('cn2b_work_session', lang)}>
          {workSessionPicker}
          <dl className="cn2b-simple-context__figures">
            <div className="cn2b-simple-context__figure">
              <dt>
                {t('cn2b_simple_institutions', lang)}
                <span className="cn2b-simple-context__scope" data-testid="cn2b-simple-scope-institutions">
                  {t('cn2b_simple_scope_whole_revision', lang)}
                </span>
              </dt>
              <dd data-testid="cn2b-simple-count-institutions">{counts.institutionsConfirmed}</dd>
            </div>
            <div className="cn2b-simple-context__figure">
              <dt>
                {t('cn2b_simple_materials', lang)}
                <span className="cn2b-simple-context__scope" data-testid="cn2b-simple-scope-materials">
                  {t('cn2b_simple_scope_this_session', lang)}
                </span>
              </dt>
              <dd data-testid="cn2b-simple-count-materials">{counts.materialsMapped}</dd>
            </div>
          </dl>
        </section>
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
          {!revision ? (
            <>
              <p className="cn2b-simple-card__eyebrow">{t('cn2b_simple_step_upload', lang)}</p>
              <h2 className="cn2b-simple-card__title" id="cn2b-simple-upload-title">{t('cn2b_simple_year_choose', lang)}</h2>
              <p className="cn2b-simple-card__lead">{t('cn2b_simple_year_hint', lang)}</p>
              {/* CN-UI-S1 — opening an annual draft is an EDIT (the server's
                  guard, and Advanced's plan stage), never an import. */}
              {canEdit ? (
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
                <div className="cn2b-simple-permission" role="status" data-testid="cn2b-simple-no-edit-permission">
                  <PhoenixIcon name="lock" size={18} inline aria-hidden="true" />
                  <span>
                    <strong>{t('cn2b_simple_no_edit_permission', lang)}</strong>
                    <br />{t('cn2b_simple_no_edit_permission_hint', lang)}
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
          {/* CN-UI-S1 HC1 — an open import attempt with no completed session yet:
              this page can only upload, so the way to abandon it is contextual. */}
          {revision !== null && expertEscapeShown && expertEscape !== null && onExpertEscape && (
            <ExpertEscapeBlock lang={lang} escape={expertEscape} allowed={expertEscapeAllowed} busy={busy} onOpen={onExpertEscape} />
          )}
          {error && !(canImport && isDraft) && (
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
            onRefused={onRefused}
          />
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
          {/*
            C6-B1 — keyed by the row it decides: once the queue advances, the next
            row gets a fresh card, never the previous row's open form or reason.
          */}
          <SimpleMaterialCard
            key={`${activeSessionId}:${undispositionedEntities[0]}`}
            lang={lang}
            importSessionId={activeSessionId}
            editable={canWrite}
            targetEntity={undispositionedEntities[0]}
            fields={fieldsByEntity.get(undispositionedEntities[0]) ?? []}
            onResolved={onMaterialResolved ?? onChanged}
            onRefused={onRefused}
            onActivityChange={onMaterialActivityChange}
          />
        </>
      )}

      {(step === 'need-lines' || step === 'pending') && !revisionClosed && (
        <section
          className="cn2b-simple-card cn2b-simple-card--outcome"
          data-testid="cn2b-simple-pending"
          data-ready={readinessSummary?.ready === true}
          aria-labelledby="cn2b-simple-pending-title"
        >
          <div className="cn2b-simple-outcome__mark" data-ready={readinessSummary?.ready === true} aria-hidden="true">
            <PhoenixIcon name={readinessSummary?.ready ? 'check' : 'clipboard'} size={28} />
          </div>
          <h2 className="cn2b-simple-card__title" id="cn2b-simple-pending-title" data-testid="cn2b-simple-pending-title">
            {step === 'pending' ? t('cn2b_simple_submit_title', lang) : t('cn2b_simple_need_lines_title', lang)}
          </h2>
          {step === 'need-lines' && (
            <p className="cn2b-simple-card__lead" data-testid="cn2b-simple-need-lines-lead">{t('cn2b_simple_need_lines_lead', lang)}</p>
          )}
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

          {/*
            CN-UI-S1 HC1 — only when the server's own blockers name something
            this view has no control for. Merely "not ready", and every blocker
            Simple does resolve, shows nothing here.
          */}
          {step === 'need-lines' && expertEscapeShown && expertEscape !== null && onExpertEscape && (
            <ExpertEscapeBlock lang={lang} escape={expertEscape} allowed={expertEscapeAllowed} busy={busy} onOpen={onExpertEscape} />
          )}

          {/*
            Submit, only on the outcome step — which only the server's own
            `ready` reaches — and only through the screen's lifecycle block,
            whose Submit is gated exactly as Advanced's (edit permission, a
            draft, ready, nothing in flight). Without edit permission the page
            says who can submit instead of offering a control.
          */}
          {step === 'pending' && (canWrite ? (
            <div className="cn2b-simple-lifecycle" data-testid="cn2b-simple-submit">{lifecycleActions}</div>
          ) : (
            <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-submit-unavailable">
              {t('cn2b_simple_submit_needs_edit', lang)}
            </p>
          ))}

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

      {step === 'pending' && revisionClosed && revision && (
        <section className="cn2b-simple-card cn2b-simple-card--outcome" data-testid="cn2b-simple-closed" aria-labelledby="cn2b-simple-closed-title">
          <p className="cn2b-simple-card__eyebrow">{t('cn2b_simple_closed_status', lang)}</p>
          <h2 className="cn2b-simple-card__title" id="cn2b-simple-closed-title">
            <span className="cn2b-simple-status" data-status={revision.status}>
              {t(`cn2b_revstatus_${revision.status}`, lang)}
            </span>
            <span>{revisionContext.planYear ?? '—'}</span>
          </h2>
          {/* C5 §17 — each closed status has its own terminal sentence;
              none of them reads as an edit task. */}
          <p className="cn2b-simple-card__lead" data-testid="cn2b-simple-closed-notice" data-status={revision.status}>
            {t(CLOSED_NOTICE_KEY_BY_STATUS[revision.status] ?? 'cn2b_simple_closed_notice', lang)}
          </p>
          {/*
            CN-UI-S1 — the decision on a SUBMITTED revision, through the
            screen's lifecycle block: approve / reject appear only for an
            approver (its own `canApprove` gate); anyone else reads the
            truthful waiting sentence above and is offered nothing.
          */}
          {revision.status === 'submitted' && (
            <div className="cn2b-simple-lifecycle" data-testid="cn2b-simple-decision">{lifecycleActions}</div>
          )}
          {/*
            A correction is opened ONLY by this explicit click — never by
            rendering. It calls the same parent correction handler Advanced
            Mode uses (`onOpenRevision(true)`), which asks for the reason and
            sends the selected revision's own year and id exactly once. C2:
            the approved revision stays in effect until the correction is
            itself approved; a correction can only follow a DECIDED newest
            revision, so it is withheld otherwise and says why. CN-UI-S1: a
            correction is an EDIT (the server's guard, and Advanced's plan
            stage), never an import.
          */}
          {canEdit ? (
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
            <p className="cn2b-simple-card__hint" data-testid="cn2b-simple-correction-no-edit-permission">
              {t('cn2b_simple_no_edit_permission', lang)}
            </p>
          )}
        </section>
      )}

      {/*
        CN-UI-S1 — the canonical need-line panel, mounted by the screen and
        placed here. One fixed position for the need-lines and outcome steps,
        so the server turning the draft ready (or not) never remounts it. It is
        an auxiliary workspace beside the task card, never a second
        `.cn2b-simple-card`.
      */}
      {showNeedLineWorkspace && (
        <section className="cn2b-simple-needlines" data-testid="cn2b-simple-need-lines" aria-labelledby="cn2b-simple-need-lines-title">
          <h3 className="cn2b-simple-needlines__title" id="cn2b-simple-need-lines-title">{t('cn2b_simple_need_lines_workspace', lang)}</h3>
          {needLineWorkspace}
        </section>
      )}
    </div>
    </RegionWorkspaceProvider>
  );
}

const NO_SESSIONS: readonly ImportSession[] = [];

/**
 * C5 §17 — the closed card's terminal sentence per status. Submitted says a
 * decision is pending (no correction yet), approved offers a correction,
 * rejected says why it is closed, superseded points to the newer revision.
 */
const CLOSED_NOTICE_KEY_BY_STATUS: Readonly<Partial<Record<PlanRevision['status'], string>>> = {
  submitted: 'cn2b_simple_closed_submitted',
  approved: 'cn2b_simple_already_approved',
  rejected: 'cn2b_simple_closed_rejected',
  superseded: 'cn2b_simple_closed_superseded',
};

export type { SimpleStep, SimpleActivity };
