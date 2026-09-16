/**
 * CN-2B — Central Needs: upload, preview, authoritative verify, review.
 *
 * THE TRUST STORY THIS SCREEN TELLS, in order and never collapsed:
 *
 *   SOURCE            the immutable imported value, exactly as the workbook
 *                     held it. Rendered as text, always. Never HTML, never a
 *                     formula result, never `formattedText` standing in for
 *                     the real value.
 *   PARSER EVIDENCE   where it came from — file, sheet, cell, fingerprint.
 *   CANONICAL MAPPING the explicit human decision: a central item, or "not
 *                     applicable" with a stated reason.
 *   MANUAL OVERRIDE   a reasoned correction, shown BESIDE the source value,
 *                     never in place of it.
 *   REVIEW STATE      readiness computed by the server, never by this file.
 *
 * The four status words are used with exact meanings:
 *   PROVISIONAL              a browser-only parse; nothing is persisted.
 *   AUTHORITATIVELY VERIFIED Node 22 reproduced the preview and the database
 *                            recomputed an agreeing digest.
 *   INCOMPLETE               the server lists at least one review blocker.
 *   READY FOR REVIEW         the server lists none.
 *
 * Family detection is advisory. It is displayed with its confidence and its
 * reasons, and it gates nothing at all — no authorization, no automatic
 * mapping, no business truth.
 *
 * UX-1 — THE WORKSPACE SHELL, and what it deliberately did NOT change.
 *
 * The same panels, in the same order, are now grouped under the six named
 * workflow stages declared in CentralNeedsWorkflowNav. That is a PRESENTATION
 * change and nothing more:
 *   * every stage section is rendered unconditionally, so no panel is mounted
 *     or unmounted by navigating — the data each one loads, and when, is
 *     exactly what it was before;
 *   * the conditions inside a stage (`canImport && isDraft`, `activeSessionId`,
 *     `revision`) are the screen's own, carried over verbatim;
 *   * the command header and the summary strip read state this screen has
 *     ALREADY loaded. Neither adds a query, and neither computes a business
 *     fact — readiness still comes from the server, as it always did.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '@/app/AppContext';
import { t } from '@/shared/i18n/strings';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import { PhoenixEmptyState } from '@/shared/ui/PhoenixEmptyState';
import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';
import { useCentralNeedsPreview, detectContainerKind } from './useCentralNeedsPreview';
import { centralNeedsErrorText } from './central-needs.i18n';
import { getOrganizations, type OrgRow } from '@/shared/supabase/services/organizations.service';
import { CentralNeedsDispositionTable } from './CentralNeedsDispositionTable';
import { CentralNeedsNeedLinePanel } from './CentralNeedsNeedLinePanel';
import { CentralNeedsBeneficiaryColumnPanel } from './CentralNeedsBeneficiaryColumnPanel';
import {
  CentralNeedsWorkflowNav,
  CENTRAL_NEEDS_STAGES,
  stageDomId,
  stageTitleDomId,
  type CentralNeedsStageId,
} from './CentralNeedsWorkflowNav';
import {
  deriveCentralNeedsStageProgress,
  recommendedCentralNeedsStage,
  stageProgressLabelKey,
  summarizeSessionBlockers,
} from './CentralNeedsWorkspaceState';
import {
  CentralNeedsError,
  abandonImportSession,
  approveRevision,
  fetchReviewReadiness,
  finalizeImport,
  listDispositions,
  listBeneficiaryColumns,
  listNeedLineLineage,
  listImportBatches,
  listImportSessions,
  listOverrides,
  listPlanRevisions,
  listSourceRecords,
  openPlanRevision,
  rejectRevision,
  searchBatchEntries,
  searchSourceFiles,
  requestSourceDownload,
  requestUploadTicket,
  submitRevision,
  uploadToStaging,
  type BeneficiaryColumnSummary,
  type FieldOverride,
  type NeedLine,
  type NeedLineSourceLink,
  type ImportBatch,
  type ImportSession,
  type PlanRevision,
  type RecordDisposition,
  type ReviewReadiness,
  type SourceFile,
  type SourceRecord,
} from './central-needs.service';
import type { ArchiveParseResult, FileParseResult } from './import/contract.ts';

type Busy = null | 'verifying' | 'submitting' | 'approving' | 'rejecting' | 'abandoning' | 'opening';
type ChildActivity = { busy: boolean; dirty: boolean; failed: boolean };

/** A revision label is never a bare "#1" — revision numbers restart per plan year. */
function revisionLabel(r: PlanRevision, lang: Parameters<typeof t>[1]): string {
  const year = r.planYear === null ? '—' : String(r.planYear);
  return `${year} · ${t('cn2b_revision', lang)} ${r.revisionNumber} — ${t(`cn2b_revstatus_${r.status}`, lang)}`;
}

/**
 * UX-1 — a panel heading is an h3 because a panel now sits INSIDE a stage,
 * whose own heading is the h2 beneath this screen's single h1. The visual
 * treatment is unchanged; the document outline simply gained the level it was
 * missing once the panels were grouped.
 */
function Panel({ titleKey, icon, children }: { titleKey: string; icon: Parameters<typeof PhoenixIcon>[0]['name']; children: React.ReactNode }) {
  const { lang } = useApp();
  return (
    <section className="cn2b-panel">
      <h3 className="cn2b-panel__title">
        <span className="cn2b-panel__title-icon" aria-hidden="true"><PhoenixIcon name={icon} size={15} /></span>
        {t(titleKey, lang)}
      </h3>
      <div className="cn2b-panel__body">{children}</div>
    </section>
  );
}

/** One of the four exact status words, never improvised. */
function StateBadge({ state }: { state: 'provisional' | 'verified' | 'incomplete' | 'ready' }) {
  const { lang } = useApp();
  const key = {
    provisional: 'cn2b_state_provisional',
    verified: 'cn2b_state_verified',
    incomplete: 'cn2b_state_incomplete',
    ready: 'cn2b_state_ready',
  }[state];
  return <span className="cn2b-badge" data-state={state}>{t(key, lang)}</span>;
}

/** A blocker with no translation yet shows its server identifier, not a dictionary key. */
function blockerLabel(blocker: string, lang: Parameters<typeof t>[1]): string {
  const key = `cn2b_blocker_${blocker}`;
  const text = t(key, lang);
  return text === key ? blocker : text;
}


function WorkSessionSelector({
  lang,
  sessions,
  activeSessionId,
  blockerSummary,
  sessionEntryById,
  disabled,
  onChange,
}: {
  lang: Parameters<typeof t>[1];
  sessions: ImportSession[];
  activeSessionId: string | null;
  blockerSummary: ReturnType<typeof summarizeSessionBlockers>;
  sessionEntryById: ReadonlyMap<string, { archiveEntryPath: string | null; containerFilename: string }>;
  disabled: boolean;
  onChange: (id: string) => void;
}) {
  const [query, setQuery] = useState('');
  const completed = sessions.filter((session) => session.status === 'completed');
  const normalizedQuery = query.trim().toLowerCase();
  const rows = completed.map((session, index) => {
    const entry = sessionEntryById.get(session.id);
    const sourceLabel = entry?.archiveEntryPath
      || entry?.containerFilename
      || `${t('cn2b_session_unbatched_fallback', lang)} · ${session.startedAt}`;
    const blockers = blockerSummary.bySession.get(session.id) ?? 0;
    const blockerText = blockers === 0
      ? t('cn2b_session_no_attributed_blockers', lang)
      : `${t('cn2b_session_blockers', lang)}: ${blockers}`;
    const label = `${sourceLabel} · ${t('cn2b_sess_completed', lang)} · ${t('cn2b_work_session', lang)} ${index + 1}/${completed.length} · ${blockerText}`;
    return { session, label };
  });
  const visibleRows = normalizedQuery === ''
    ? rows
    : rows.filter(({ session, label }) => session.id === activeSessionId || label.toLowerCase().includes(normalizedQuery));

  return (
    <section className="cn2b-work-session" aria-label={t('cn2b_work_session', lang)}>
      <label className="cn2b-field">
        <span className="cn2b-field__label">{t('cn2b_work_session_search', lang)}</span>
        <input
          className="cn2b-input"
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t('cn2b_work_session_search', lang)}
        />
      </label>
      <label className="cn2b-field">
        <span className="cn2b-field__label">{t('cn2b_work_session', lang)}</span>
        <select
          className="cn2b-select"
          value={activeSessionId ?? ''}
          disabled={disabled || completed.length === 0}
          onChange={(event) => event.target.value && onChange(event.target.value)}
        >
          {completed.length === 0 && <option value="">{t('cn2b_work_session_none', lang)}</option>}
          {visibleRows.map(({ session, label }) => <option key={session.id} value={session.id}>{label}</option>)}
        </select>
      </label>
      {disabled && <p className="cn2b-work-session__meta">{t('cn2b_work_session_switch_blocked', lang)}</p>}
      {blockerSummary.unattributed > 0 && (
        <p className="cn2b-work-session__meta" role="status">
          {t('cn2b_unattributed_blockers', lang)}: {blockerSummary.unattributed}
        </p>
      )}
    </section>
  );
}

export function CentralNeedsScreen() {
  const { lang, dir, activeOrgId, profile, myPermissions } = useApp();
  /**
   * The canonical organization scope, exactly as every other org-scoped screen
   * reads it (see InventoryCenterScreen). A platform administrator carries
   * `profile.organization_id = null` and picks an organization with
   * <PhoenixOrgScope />, so reading the profile alone would dead-end that actor
   * on "no organization" for a surface they are entitled to use. The profile's
   * own organization remains the fallback for an org-bound role. This selects
   * WHICH organization is shown; it grants nothing — RLS and every CN-1B/CN-2B
   * RPC re-derive authority from auth.uid() for whichever organization is asked
   * about.
   */
  const organizationId = activeOrgId ?? profile?.organization_id ?? null;

  const canImport = myPermissions.has('central_needs.import');
  const canEdit = myPermissions.has('central_needs.edit');
  const canApprove = myPermissions.has('central_needs.approve');

  const [revisions, setRevisions] = useState<PlanRevision[]>([]);
  const [revisionId, setRevisionId] = useState<string | null>(null);
  const [sessions, setSessions] = useState<ImportSession[]>([]);
  const [batches, setBatches] = useState<ImportBatch[]>([]);
  const [records, setRecords] = useState<SourceRecord[]>([]);
  const [dispositions, setDispositions] = useState<RecordDisposition[]>([]);
  const [overrides, setOverrides] = useState<FieldOverride[]>([]);
  const [needLines, setNeedLines] = useState<NeedLine[]>([]);
  const [claimedSources, setClaimedSources] = useState<NeedLineSourceLink[]>([]);
  /** (213) Every physical candidate column of the revision and its confirmed beneficiary, if any. */
  const [beneficiaryColumns, setBeneficiaryColumns] = useState<BeneficiaryColumnSummary[]>([]);
  /** Active care institutions — the only eligible beneficiaries, same rule the server enforces. */
  const [careInstitutions, setCareInstitutions] = useState<OrgRow[]>([]);
  const [readiness, setReadiness] = useState<ReviewReadiness | null>(null);
  const [activeSessionId, setActiveSessionId] = useState<string | null>(null);
  const [activeStage, setActiveStage] = useState<CentralNeedsStageId>('plan');
  const stageWasChosen = useRef(false);
  /**
   * UX-3R §7.2 - the initial stage is a DECISION that needs the revision and
   * its readiness. Until it resolves the workspace renders its loading state;
   * painting Stage 1 first and jumping when readiness lands is what §7 forbids.
   */
  const [initialStageResolved, setInitialStageResolved] = useState(false);
  const [revisionReloading, setRevisionReloading] = useState(false);
  /** UX-3R §6.3 rule 0 — readiness re-read after a confirmed Stage 3 write is pending. */
  const [readinessRefreshing, setReadinessRefreshing] = useState(false);
  const [reviewActivity, setReviewActivity] = useState<ChildActivity>({ busy: false, dirty: false, failed: false });
  const [beneficiaryActivity, setBeneficiaryActivity] = useState<ChildActivity>({ busy: false, dirty: false, failed: false });
  const [needLineActivity, setNeedLineActivity] = useState<ChildActivity>({ busy: false, dirty: false, failed: false });
  const [backgroundResult, setBackgroundResult] = useState<{ stage: CentralNeedsStageId; failed: boolean } | null>(null);
  const previousChildBusy = useRef<Record<'review' | 'beneficiaries' | 'need-lines', boolean>>({ review: false, beneficiaries: false, 'need-lines': false });
  const previousParentBusyStage = useRef<CentralNeedsStageId | null>(null);
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /**
   * UX-2A — in-flight marker for the session read this screen already performs.
   * It distinguishes "still loading" from "loaded and genuinely empty", which
   * previously rendered identically. It adds no request.
   *
   * There is no matching flag for the revision reload any more: `dataRevisionId`
   * below is strictly stronger, since it says not just whether a read is in
   * flight but WHICH revision the committed evidence belongs to — which is the
   * question every revision-scoped render site actually has to answer.
   */
  const [sessionLoading, setSessionLoading] = useState(false);
  /**
   * FINDING C — the revision LIST is loading until its one existing read
   * resolves. It starts true so the very first paint cannot assert "no
   * revisions" about a question that has not been answered yet.
   */
  const [revisionsLoading, setRevisionsLoading] = useState(true);
  /**
   * WHICH REVISION THE COMMITTED EVIDENCE ACTUALLY BELONGS TO.
   *
   * Clearing the old revision's state in an effect is too late: a passive
   * effect runs AFTER the render that already carries the new `revisionId`, so
   * for one commit the screen would show revision A's batches, sessions and
   * review rows beneath revision B's header. On a provenance screen that
   * single frame is a false attribution, so the guard has to hold DURING
   * render, not after it.
   *
   * This is set only by a reload that both succeeded and is still the current
   * generation, and is dropped to null the moment anything invalidates it.
   */
  const [dataRevisionId, setDataRevisionId] = useState<string | null>(null);

  const preview = useCentralNeedsPreview();
  const [pendingFile, setPendingFile] = useState<File | null>(null);

  // G — the annual plan surface.
  const [planYear, setPlanYear] = useState<number>(() => new Date().getFullYear());
  // I — bounded source-evidence search.
  const [sourceQuery, setSourceQuery] = useState('');
  const [sourceFiles, setSourceFiles] = useState<SourceFile[]>([]);
  const [entryHits, setEntryHits] = useState<Array<{ id: string; archiveEntryPath: string | null; entrySha256: string; containerFilename: string; entryOrdinal: number }>>([]);
  /** UX-3R — trusted batch-entry labels for the shared Work Session selector. */
  const [sessionEntries, setSessionEntries] = useState<Array<{ importSessionId: string; archiveEntryPath: string | null; containerFilename: string }>>([]);
  /**
   * UX-2A — the four states a bounded evidence search can actually be in.
   *
   * They exist because "no results" and "you have not searched yet" are
   * different facts, and the screen used to render the first sentence for the
   * second situation. This adds NO query: the same two bounded server-side
   * searches run, in the same place, under the same RLS scope; the phase only
   * records where that one request currently is.
   */
  const [sourceSearchPhase, setSourceSearchPhase] = useState<'idle' | 'searching' | 'done' | 'failed'>('idle');
  const [sourceSearchError, setSourceSearchError] = useState<string | null>(null);
  /**
   * Monotonic request token. A slower earlier keystroke must never overwrite a
   * newer answer, which would show results for a query the operator has already
   * replaced. Nothing is cancelled server-side; a stale reply is simply ignored.
   */
  const sourceSearchSeq = useRef(0);
  /**
   * FINDING B — the same monotonic-token discipline for the revision reload.
   *
   * Two reloads can overlap (a revision switch, or a panel's onChanged landing
   * mid-flight). Without a token the LAST REPLY wins rather than the LATEST
   * REQUEST, so a slow read for revision A can overwrite revision B's evidence
   * and present it as B's. Only the newest request may commit.
   */
  const revisionReloadSeq = useRef(0);

  const revision = useMemo(() => revisions.find((r) => r.id === revisionId) ?? null, [revisions, revisionId]);
  const isDraft = revision?.status === 'draft';
  const revisionDataReady = revisionId !== null && dataRevisionId === revisionId;

  /**
   * FINDINGS A + B — everything below is scoped to ONE revision, so a revision
   * change must drop all of it at once. Showing the previous revision's
   * batches, sessions, review rows or search hits under a new revision's header
   * would attribute evidence to a plan it does not belong to, which is exactly
   * the kind of claim this feature exists to make impossible.
   */
  const resetRevisionScopedState = useCallback(() => {
    revisionReloadSeq.current += 1;
    sourceSearchSeq.current += 1;
    // Nothing on screen may claim a revision until a reload proves which one.
    setDataRevisionId(null);
    setSessions([]);
    setBatches([]);
    setOverrides([]);
    setReadiness(null);
    setNeedLines([]);
    setClaimedSources([]);
    setBeneficiaryColumns([]);
    setActiveSessionId(null);
    setSessionEntries([]);
    setPendingFile(null);
    preview.reset();
    setReviewActivity({ busy: false, dirty: false, failed: false });
    setBeneficiaryActivity({ busy: false, dirty: false, failed: false });
    setNeedLineActivity({ busy: false, dirty: false, failed: false });
    setBackgroundResult(null);
    previousChildBusy.current = { review: false, beneficiaries: false, 'need-lines': false };
    previousParentBusyStage.current = null;
    setActiveStage('plan');
    stageWasChosen.current = false;
    setInitialStageResolved(false);
    setRevisionReloading(false);
    setReadinessRefreshing(false);
    setRecords([]);
    setDispositions([]);
    setSourceQuery('');
    setSourceFiles([]);
    setEntryHits([]);
    setSourceSearchError(null);
    setSourceSearchPhase('idle');
  }, [preview.reset]);

  // --- loading -------------------------------------------------------------

  // Only a live care institution may be a beneficiary — surfaced once here
  // and shared by the column-mapping and need-line panels, rather than each
  // fetching its own copy.
  useEffect(() => {
    let cancelled = false;
    getOrganizations()
      .then((rows) => {
        if (cancelled) return;
        setCareInstitutions(rows.filter((o) => o.organizationKind === 'care_institution' && o.status === 'active'));
      })
      .catch(() => { if (!cancelled) setCareInstitutions([]); });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (!organizationId) return;
    let cancelled = false;
    // FINDING C — "still asking" and "asked, and there are none" are different
    // answers. Until this resolves the screen must not claim the second.
    setRevisionsLoading(true);
    listPlanRevisions(organizationId)
      .then((rows) => {
        if (cancelled) return;
        setRevisions(rows);
        setRevisionId((current) => current ?? rows[0]?.id ?? null);
      })
      .catch((e: unknown) => !cancelled && setError(e instanceof CentralNeedsError ? e.code : 'load_failed'))
      .finally(() => { if (!cancelled) setRevisionsLoading(false); });
    return () => { cancelled = true; };
  }, [organizationId]);

  const reloadRevision = useCallback(async (id: string) => {
    const seq = (revisionReloadSeq.current += 1);
    setRevisionReloading(true);
    try {
      const [nextSessions, nextBatches, nextOverrides, nextReadiness, nextLineage, nextBeneficiaryColumns, nextSessionEntries] =
        await Promise.all([
          listImportSessions(id),
          listImportBatches(id),
          listOverrides(id),
          fetchReviewReadiness(id),
          listNeedLineLineage(id),
          listBeneficiaryColumns(id),
          // Existing bounded revision query; label enrichment is presentation-only and fails soft.
          searchBatchEntries(id, '', 500).catch(() => []),
        ]);
      if (seq !== revisionReloadSeq.current) return;
      setSessions(nextSessions);
      setBatches(nextBatches);
      setOverrides(nextOverrides);
      setReadiness(nextReadiness);
      setNeedLines(nextLineage.needLines);
      setClaimedSources(nextLineage.sources);
      setBeneficiaryColumns(nextBeneficiaryColumns);
      setSessionEntries(nextSessionEntries.map((entry) => ({
        importSessionId: entry.importSessionId,
        archiveEntryPath: entry.archiveEntryPath,
        containerFilename: entry.containerFilename,
      })));
      const completed = nextSessions.filter((session) => session.status === 'completed');
      setActiveSessionId((current) => (
        current && completed.some((session) => session.id === current)
          ? current
          : completed[0]?.id ?? null
      ));
      setDataRevisionId(id);
    } finally {
      if (seq === revisionReloadSeq.current) setRevisionReloading(false);
    }
  }, []);

  useEffect(() => {
    if (!revisionId) return;
    let cancelled = false;
    // FINDINGS A + B — drop the previous revision's evidence and its search
    // BEFORE the new reads start, so nothing from the old plan is ever on
    // screen under the new plan's header, not even for one frame.
    resetRevisionScopedState();
    // The reload publishes `dataRevisionId` itself, and only on success while
    // still current, so a failure leaves the evidence unattributed and the
    // render gate keeps showing the waiting state rather than stale rows.
    reloadRevision(revisionId).catch((e: unknown) => {
      if (!cancelled) setError(e instanceof CentralNeedsError ? e.code : 'load_failed');
    });
    return () => { cancelled = true; };
  }, [revisionId, reloadRevision, resetRevisionScopedState]);

  useEffect(() => {
    if (!activeSessionId) { setRecords([]); setDispositions([]); setSessionLoading(false); return; }
    let cancelled = false;
    setSessionLoading(true);
    Promise.all([listSourceRecords(activeSessionId), listDispositions(activeSessionId)])
      .then(([r, d]) => { if (!cancelled) { setRecords(r); setDispositions(d); } })
      .catch((e: unknown) => !cancelled && setError(e instanceof CentralNeedsError ? e.code : 'load_failed'))
      .finally(() => { if (!cancelled) setSessionLoading(false); });
    return () => { cancelled = true; };
  }, [activeSessionId]);

  // --- actions -------------------------------------------------------------

  const onPickFile = useCallback((file: File | null) => {
    setError(null);
    setNotice(null);
    setPendingFile(file);
    preview.reset();
    if (file) void preview.parse(file);
  }, [preview]);

  const onVerify = useCallback(async () => {
    if (!revisionId || !pendingFile || preview.state.phase !== 'ready') return;
    setBusy('verifying');
    setError(null);
    setNotice(null);
    try {
      const ticket = await requestUploadTicket(revisionId, pendingFile.size);
      await uploadToStaging(ticket, pendingFile, preview.state.outcome.json);
      const result = await finalizeImport({
        planRevisionId: revisionId,
        uploadId: ticket.uploadId,
        containerKind: preview.state.outcome.kind === 'archive' ? 'zip' : 'file',
      });
      setNotice(result.idempotentReplay ? 'cn2b_notice_already_verified' : 'cn2b_notice_verified');
      setPendingFile(null);
      preview.reset();
      await reloadRevision(revisionId);
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'verify_failed');
    } finally {
      setBusy(null);
    }
  }, [revisionId, pendingFile, preview, reloadRevision]);

  const onAbandon = useCallback(async (sessionId: string) => {
    const reason = window.prompt(t('cn2b_abandon_reason_prompt', lang) ?? '');
    if (!reason || reason.trim() === '') return;
    setBusy('abandoning');
    setError(null);
    try {
      await abandonImportSession(sessionId, reason.trim());
      if (revisionId) await reloadRevision(revisionId);
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'abandon_failed');
    } finally {
      setBusy(null);
    }
  }, [lang, revisionId, reloadRevision]);

  const sourceDraftDirty = pendingFile !== null || preview.state.phase !== 'idle';
  const revisionDraftDirty = sourceDraftDirty || reviewActivity.dirty || beneficiaryActivity.dirty || needLineActivity.dirty;
  const revisionContextBusy = busy !== null || reviewActivity.busy || beneficiaryActivity.busy || needLineActivity.busy;

  const confirmRevisionContextDiscard = useCallback((): boolean => {
    if (revisionContextBusy) {
      window.alert(t('cn2b_revision_context_change_blocked', lang));
      return false;
    }
    if (!revisionDraftDirty) return true;
    return window.confirm(t('cn2b_revision_context_change_confirm', lang));
  }, [revisionContextBusy, revisionDraftDirty, lang]);

  const onOpenRevision = useCallback(async (openNext: boolean) => {
    if (!organizationId || !confirmRevisionContextDiscard()) return;
    setBusy('opening');
    setError(null);
    setNotice(null);
    try {
      const opened = await openPlanRevision(organizationId, planYear, openNext);
      const rows = await listPlanRevisions(organizationId);
      setRevisions(rows);
      setRevisionId(opened.planRevisionId);
      setNotice(opened.idempotent ? 'cn2b_notice_revision_existing' : 'cn2b_notice_revision_opened');
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'open_revision_failed');
    } finally {
      setBusy(null);
    }
  }, [organizationId, planYear, confirmRevisionContextDiscard]);

  // I — search runs against the selected revision only; RLS is the boundary.
  const onSearchSource = useCallback(async (q: string) => {
    setSourceQuery(q);
    const trimmed = q.trim();
    // An empty box is NOT a search that found nothing — it is no search at all,
    // and any in-flight reply is disowned by advancing the token.
    if (!revisionId || trimmed === '') {
      sourceSearchSeq.current += 1;
      setSourceFiles([]);
      setEntryHits([]);
      setSourceSearchError(null);
      setSourceSearchPhase('idle');
      return;
    }
    const seq = (sourceSearchSeq.current += 1);
    setSourceSearchError(null);
    setSourceSearchPhase('searching');
    try {
      const [files, entries] = await Promise.all([
        searchSourceFiles(revisionId, q),
        searchBatchEntries(revisionId, q),
      ]);
      if (seq !== sourceSearchSeq.current) return;
      setSourceFiles(files);
      setEntryHits(entries);
      setSourceSearchPhase('done');
    } catch (e: unknown) {
      if (seq !== sourceSearchSeq.current) return;
      setSourceFiles([]);
      setEntryHits([]);
      // A refused search is reported as a refusal, never as "nothing matched".
      setSourceSearchError(e instanceof CentralNeedsError ? e.code : 'load_failed');
      setSourceSearchPhase('failed');
    }
  }, [revisionId]);

  /** UX-2A — reset the evidence search. Presentation only: it writes nothing. */
  const onClearSourceSearch = useCallback(() => {
    sourceSearchSeq.current += 1;
    setSourceQuery('');
    setSourceFiles([]);
    setEntryHits([]);
    setSourceSearchError(null);
    setSourceSearchPhase('idle');
  }, []);

  const onSubmit = useCallback(async () => {
    if (!revisionId) return;
    setBusy('submitting');
    setError(null);
    try {
      await submitRevision(revisionId);
      const rows = organizationId ? await listPlanRevisions(organizationId) : [];
      setRevisions(rows);
      await reloadRevision(revisionId);
      setNotice('cn2b_notice_submitted');
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'submit_failed');
    } finally {
      setBusy(null);
    }
  }, [revisionId, organizationId, reloadRevision]);

  const onApprove = useCallback(async () => {
    if (!revisionId) return;
    setBusy('approving');
    setError(null);
    try {
      await approveRevision(revisionId);
      const rows = organizationId ? await listPlanRevisions(organizationId) : [];
      setRevisions(rows);
      setNotice('cn2b_notice_approved');
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'approve_failed');
    } finally {
      setBusy(null);
    }
  }, [revisionId, organizationId]);

  const onReject = useCallback(async () => {
    if (!revisionId) return;
    const reason = window.prompt(t('cn2b_reject_reason_prompt', lang) ?? '');
    if (!reason || reason.trim() === '') return;
    setBusy('rejecting');
    setError(null);
    try {
      await rejectRevision(revisionId, reason.trim());
      const rows = organizationId ? await listPlanRevisions(organizationId) : [];
      setRevisions(rows);
      setNotice('cn2b_notice_rejected');
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'reject_failed');
    } finally {
      setBusy(null);
    }
  }, [revisionId, organizationId, lang]);

  const onDownloadSource = useCallback(async (batchId: string) => {
    setError(null);
    try {
      const { url } = await requestSourceDownload(batchId);
      window.open(url, '_blank', 'noopener,noreferrer');
    } catch (e: unknown) {
      setError(e instanceof CentralNeedsError ? e.code : 'download_failed');
    }
  }, []);

  const onDispositionsChanged = useCallback(async () => {
    // UX-3R §6.3 rule 0 — a confirmed Stage 3 write may change server readiness, so no
    // previous completion may stand until the re-read answers. The reads are unchanged.
    if (revisionId) setReadinessRefreshing(true);
    try {
      if (activeSessionId) setDispositions(await listDispositions(activeSessionId));
      if (revisionId) setReadiness(await fetchReviewReadiness(revisionId));
    } finally {
      if (revisionId) setReadinessRefreshing(false);
    }
  }, [activeSessionId, revisionId]);

  const stageProgress = useMemo(() => deriveCentralNeedsStageProgress({
    hasRevision: revision !== null,
    revisionStatus: revision?.status ?? null,
    revisionDataReady,
    refreshing: revisionReloading || readinessRefreshing,
    readiness,
  }), [readiness, revision, revisionDataReady, revisionReloading, readinessRefreshing]);

  const recommendedStage = useMemo(
    () => recommendedCentralNeedsStage(revision !== null, stageProgress),
    [revision, stageProgress],
  );

  const sessionBlockers = useMemo(() => summarizeSessionBlockers(readiness), [readiness]);
  const sessionEntryById = useMemo(
    () => new Map(sessionEntries.map((entry) => [entry.importSessionId, entry])),
    [sessionEntries],
  );
  const sessionSwitchBlocked = sessionLoading
    || reviewActivity.busy
    || needLineActivity.busy;
  const sessionDraftDirty = reviewActivity.dirty || needLineActivity.dirty;
  const busyStage: CentralNeedsStageId | null = reviewActivity.busy ? 'review'
    : beneficiaryActivity.busy ? 'beneficiaries'
      : needLineActivity.busy ? 'need-lines'
        : (busy === 'verifying' || busy === 'abandoning') ? 'source'
          : busy === 'opening' ? 'plan'
            : (busy === 'submitting' || busy === 'approving' || busy === 'rejecting') ? 'readiness'
              : null;

  const onStageChange = useCallback((id: CentralNeedsStageId) => {
    stageWasChosen.current = true;
    setInitialStageResolved(true);
    setActiveStage(id);
    setBackgroundResult((current) => current?.stage === id ? null : current);
  }, []);

  const onWorkSessionChange = useCallback((id: string) => {
    if (sessionSwitchBlocked || id === activeSessionId) return;
    if (sessionDraftDirty && !window.confirm(t('cn2b_work_session_change_confirm', lang))) return;
    setReviewActivity({ busy: false, dirty: false, failed: false });
    setNeedLineActivity({ busy: false, dirty: false, failed: false });
    setActiveSessionId(id);
  }, [activeSessionId, lang, sessionDraftDirty, sessionSwitchBlocked]);

  useEffect(() => {
    if (stageWasChosen.current) return;
    if (revisionId === null) {
      // §7.1 - "no revision exists" is only KNOWN once the revision list has
      // answered. While it is still being asked this is the §7.2 loading state,
      // not Stage 1 (FINDING C: still asking is not the same answer as none).
      if (revisionsLoading) return;
      setActiveStage('plan');
      setInitialStageResolved(true);
      return;
    }
    // §7.2 - hold the loading state until this revision readiness answers.
    if (!revisionDataReady || revisionReloading) return;
    setActiveStage(recommendedStage);
    setInitialStageResolved(true);
    // Resume once from server-backed progress; later readiness changes must not move the stage under the operator.
    stageWasChosen.current = true;
  }, [recommendedStage, revisionDataReady, revisionId, revisionReloading, revisionsLoading]);

  useEffect(() => {
    const activities = { review: reviewActivity, beneficiaries: beneficiaryActivity, 'need-lines': needLineActivity } as const;
    for (const stage of ['review', 'beneficiaries', 'need-lines'] as const) {
      const wasBusy = previousChildBusy.current[stage];
      const activity = activities[stage];
      if (wasBusy && !activity.busy && activeStage !== stage) {
        setBackgroundResult({ stage, failed: activity.failed });
      }
      previousChildBusy.current[stage] = activity.busy;
    }
  }, [activeStage, beneficiaryActivity, needLineActivity, reviewActivity]);

  useEffect(() => {
    const parentStage = (busy === 'verifying' || busy === 'abandoning') ? 'source'
      : busy === 'opening' ? 'plan'
        : (busy === 'submitting' || busy === 'approving' || busy === 'rejecting') ? 'readiness'
          : null;
    const previous = previousParentBusyStage.current;
    if (previous && !parentStage && activeStage !== previous) {
      setBackgroundResult({ stage: previous, failed: error !== null });
    }
    previousParentBusyStage.current = parentStage;
  }, [activeStage, busy, error]);

  // --- render --------------------------------------------------------------

  if (!organizationId) {
    return <PhoenixEmptyState title={t('cn2b_no_organization', lang)} />;
  }

  const previewResult = preview.state.phase === 'ready' ? preview.state.outcome.result : null;

  // UX-1 — summary figures, every one of them counted off state already on
  // screen. A column counts as decided once a review decision exists for it,
  // whichever decision that was.
  const completedSessionCount = sessions.filter((session) => session.status === 'completed').length;

  /**
   * UX-1 — the content of each workflow stage, keyed by its canonical id.
   *
   * The stage SECTIONS are rendered unconditionally by the map below, in the
   * one order CENTRAL_NEEDS_STAGES declares. Only the conditions this screen
   * already had appear inside them, unchanged, so grouping the panels moved no
   * data loading and hid no surface from anyone who could reach it before.
   */
  const stageBody: Record<CentralNeedsStageId, React.ReactNode> = {
    plan: (
      <Panel titleKey="cn2b_panel_revision" icon="reports">
        <label className="cn2b-field">
          <span className="cn2b-field__label">{t('cn2b_revision', lang)}</span>
          <select
            className="cn2b-select"
            value={revisionId ?? ''}
            onChange={(e) => {
              const next = e.target.value || null;
              if (next === revisionId) return;
              if (!confirmRevisionContextDiscard()) return;
              setRevisionId(next);
            }}
          >
            {/* FINDING C — while the list is still being read, say so. Only a
                RESOLVED empty list may claim there are no revisions. */}
            {revisions.length === 0 && (
              <option value="">
                {revisionsLoading ? t('cn2b_revisions_loading', lang) : t('cn2b_no_revisions', lang)}
              </option>
            )}
            {revisions.map((r) => (
              <option key={r.id} value={r.id}>{revisionLabel(r, lang)}</option>
            ))}
          </select>
        </label>

        {canEdit && (
          <>
            <label className="cn2b-field">
              <span className="cn2b-field__label">{t('cn2b_plan_year', lang)}</span>
              <input
                className="cn2b-input"
                type="number"
                min={2000}
                max={2100}
                value={planYear}
                onChange={(e) => setPlanYear(Number(e.target.value))}
              />
            </label>
            <p className="cn2b-hint">{t('cn2b_plan_explainer', lang)}</p>
            <div className="cn2b-actions">
              {/* First/current annual draft. M210 returns the existing open
                  draft when there is one, so pressing this twice is safe and
                  never creates a second draft. */}
              <button
                type="button"
                className="cn2b-btn cn2b-btn--primary"
                disabled={busy !== null || !Number.isFinite(planYear)}
                onClick={() => void onOpenRevision(false)}
              >
                {t('cn2b_open_draft', lang)}
              </button>
              {/* Superseding a CLOSED revision is a separate, explicit action —
                  never automatic, and never offered while a draft is open. */}
              {(revision?.status === 'approved' || revision?.status === 'rejected') && (
                <button
                  type="button"
                  className="cn2b-btn"
                  disabled={busy !== null}
                  onClick={() => void onOpenRevision(true)}
                >
                  {t('cn2b_open_next_revision', lang)}
                </button>
              )}
            </div>
          </>
        )}
      </Panel>
    ),

    source: (
      <>
        {canImport && isDraft && (
          <Panel titleKey="cn2b_panel_upload" icon="warehouse">
            <label className="cn2b-field">
              <span className="cn2b-field__label">{t('cn2b_choose_file', lang)}</span>
              <input
                className="cn2b-file"
                type="file"
                accept=".xls,.xlsx,.csv,.zip"
                onChange={(e) => onPickFile(e.target.files?.[0] ?? null)}
              />
            </label>
            {pendingFile && (
              <p className="cn2b-hint">
                {pendingFile.name} · {detectContainerKind(pendingFile) === 'archive' ? t('cn2b_kind_zip', lang) : t('cn2b_kind_file', lang)}
              </p>
            )}
            {preview.state.phase === 'parsing' && <p className="cn2b-hint" role="status">{t('cn2b_parsing', lang)}</p>}
            {preview.state.phase === 'failed' && (
              <PhoenixErrorState message={`${t('cn2b_preview_failed', lang)} (${preview.state.reason})`} />
            )}
          </Panel>
        )}

        {previewResult && (
          <Panel titleKey="cn2b_panel_preview" icon="editor">
            <div className="cn2b-inline"><StateBadge state="provisional" /></div>
            <p className="cn2b-hint">{t('cn2b_preview_explainer', lang)}</p>
            <PreviewSummary result={previewResult} kind={preview.state.phase === 'ready' ? preview.state.outcome.kind : 'file'} />
            <button
              type="button"
              className="cn2b-btn cn2b-btn--primary"
              disabled={busy !== null}
              onClick={() => void onVerify()}
            >
              {busy === 'verifying' ? t('cn2b_verifying', lang) : t('cn2b_verify', lang)}
            </button>
          </Panel>
        )}

        <Panel titleKey="cn2b_panel_batches" icon="warehouse">
          {!revisionDataReady ? (
            /* Attribution gate: no batch may be shown under a revision the
               committed data does not provably belong to. */
            <p className="cn2b-hint" role="status">{t('cn2b_revision_loading', lang)}</p>
          ) : batches.length === 0 ? (
            <PhoenixEmptyState title={t('cn2b_no_batches', lang)} />
          ) : (
            <div className="cn2b-scroll">
              <table className="cn2b-table">
                <caption className="cn2b-visually-hidden">{t('cn2b_panel_batches', lang)}</caption>
                <thead>
                  <tr>
                    <th scope="col">{t('cn2b_col_container', lang)}</th>
                    <th scope="col">{t('cn2b_col_kind', lang)}</th>
                    <th scope="col">{t('cn2b_col_entries', lang)}</th>
                    <th scope="col">{t('cn2b_col_sha', lang)}</th>
                    <th scope="col">{t('cn2b_col_actions', lang)}</th>
                  </tr>
                </thead>
                <tbody>
                  {batches.map((b) => (
                    <tr key={b.id}>
                      <td>{b.containerFilename}</td>
                      <td>{t(`cn2b_kind_${b.containerKind}`, lang)}</td>
                      <td>{`${b.acceptedEntryCount} (+${b.excludedEntryCount})`}</td>
                      <td className="cn2b-cell--digest"><code className="cn2b-code">{b.containerSha256.slice(0, 12)}…</code></td>
                      <td className="cn2b-cell--actions">
                        <button type="button" className="cn2b-btn cn2b-btn--sm" onClick={() => void onDownloadSource(b.id)}>
                          {t('cn2b_download_source', lang)}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel titleKey="cn2b_panel_source_search" icon="reports">
          {/*
            REVISION ATTRIBUTION GATE for the whole search surface.

            Hiding only the result ROWS was not enough: the typed query, the
            phase line, the result COUNT and any refusal are equally statements
            ABOUT a revision. In the single commit between selecting a new
            revision and the reset effect running, they would otherwise still
            describe the previous one — the same false attribution, just in
            words instead of rows. So the entire operational surface waits
            until the committed evidence provably belongs to the selection.
          */}
          {!revisionDataReady ? (
            <p className="cn2b-hint" role="status">{t('cn2b_revision_loading', lang)}</p>
          ) : (
            <>
            {/*
              UX-2A search toolbar. The input, the reset and the state line read
              as one control strip; the state line below is the ONLY place that
              says what the search is doing, so "nothing matched" can never be
              shown to someone who has not searched.
            */}
            <div className="cn2b-toolbar">
              <label className="cn2b-field cn2b-toolbar__grow" htmlFor="cn2b-source-search">
                <span className="cn2b-field__label">{t('cn2b_source_search', lang)}</span>
                <input
                  id="cn2b-source-search"
                  className="cn2b-input"
                  type="search"
                  value={sourceQuery}
                  placeholder={t('cn2b_source_search_hint', lang)}
                  onChange={(e) => void onSearchSource(e.target.value)}
                />
              </label>
              <div className="cn2b-toolbar__actions">
                <button
                  type="button"
                  className="cn2b-btn"
                  disabled={sourceQuery === '' && sourceSearchPhase === 'idle'}
                  onClick={onClearSourceSearch}
                >
                  {t('cn2b_source_search_clear', lang)}
                </button>
              </div>
            </div>

            {/*
              The four states are mutually exclusive and each is named. A refused
              search is reported through the Central Needs translator as a
              refusal, never flattened into an empty result.
            */}
            <p className="cn2b-searchstate" data-phase={sourceSearchPhase} role="status">
              {sourceSearchPhase === 'idle' && t('cn2b_source_search_idle', lang)}
              {sourceSearchPhase === 'searching' && t('cn2b_source_search_running', lang)}
              {sourceSearchPhase === 'done' && (
                `${t('cn2b_source_search_results', lang)}: ${sourceFiles.length + entryHits.length}`
              )}
              {sourceSearchPhase === 'failed' && t('cn2b_source_search_failed', lang)}
            </p>
            {sourceSearchPhase === 'failed' && sourceSearchError && (
              <PhoenixErrorState message={centralNeedsErrorText(sourceSearchError, lang)} />
            )}

            {sourceSearchPhase === 'done' && sourceFiles.length === 0 && entryHits.length === 0 && (
              <PhoenixEmptyState title={t('cn2b_source_search_empty', lang)} />
            )}

            {/* The attribution gate above now wraps this entire surface, so the
                rows only have to decide whether there is anything to show. */}
            {sourceFiles.length === 0 && entryHits.length === 0 ? null : (
              <div className="cn2b-scroll">
                <table className="cn2b-table">
                  <caption className="cn2b-visually-hidden">{t('cn2b_panel_source_search', lang)}</caption>
                  <thead>
                    <tr>
                      <th scope="col">{t('cn2b_col_container', lang)}</th>
                      <th scope="col">{t('cn2b_col_entry_path', lang)}</th>
                      <th scope="col">{t('cn2b_col_sha', lang)}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sourceFiles.map((f) => (
                      <tr key={f.id}>
                        <td>{f.originalFilename}</td>
                        <td>—</td>
                        <td><code className="cn2b-code">{f.fileHash.slice(0, 16)}…</code></td>
                      </tr>
                    ))}
                    {entryHits.map((e) => (
                      <tr key={e.id}>
                        <td>{e.containerFilename}</td>
                        <td><code className="cn2b-code">{e.archiveEntryPath ?? '—'}</code></td>
                        <td><code className="cn2b-code">{e.entrySha256.slice(0, 16)}…</code></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            </>
          )}
        </Panel>

        <Panel titleKey="cn2b_panel_sessions" icon="alerts">
          {!revisionDataReady ? (
            <p className="cn2b-hint" role="status">{t('cn2b_revision_loading', lang)}</p>
          ) : sessions.length === 0 ? (
            <PhoenixEmptyState title={t('cn2b_no_sessions', lang)} />
          ) : (
            <>
              {/*
                UX-2A — a compact operational selector, not a filtered list.
                EVERY session stays listed whatever its status, because a failed
                or abandoned attempt is part of the import record. Only a
                completed one is selectable, exactly as before: that is the
                single session whose evidence the review surface may read.
              */}
              <p className="cn2b-hint" role="status">
                {t('cn2b_sessions_completed_of', lang)}: {completedSessionCount}/{sessions.length}
              </p>
              <ul className="cn2b-list cn2b-list--sessions">
                {sessions.map((s) => (
                  <li key={s.id} className="cn2b-list__row">
                    <button
                      type="button"
                      className="cn2b-session"
                      data-active={s.id === activeSessionId}
                      aria-pressed={s.id === activeSessionId}
                      disabled={s.status !== 'completed' || sessionSwitchBlocked}
                      onClick={() => onWorkSessionChange(s.id)}
                    >
                      <span className="cn2b-session__status" data-status={s.status}>
                        {t(`cn2b_sess_${s.status}`, lang)}
                      </span>
                      {s.status === 'completed' && <StateBadge state="verified" />}
                      <code className="cn2b-code">{(s.authoritativeDigest ?? s.previewDigest ?? '').slice(0, 12)}…</code>
                      {s.id === activeSessionId && (
                        <span className="cn2b-session__current">{t('cn2b_session_current', lang)}</span>
                      )}
                    </button>
                    {canImport && isDraft && (s.status === 'pending' || s.status === 'processing') && (
                      <button type="button" className="cn2b-btn cn2b-btn--sm" disabled={busy !== null} onClick={() => void onAbandon(s.id)}>
                        {t('cn2b_abandon', lang)}
                      </button>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}
        </Panel>
      </>
    ),

    review: !revisionDataReady ? (
      <p className="cn2b-hint" role="status">{t('cn2b_revision_loading', lang)}</p>
    ) : (
      <>
        <WorkSessionSelector
          lang={lang}
          sessions={sessions}
          activeSessionId={activeSessionId}
          blockerSummary={sessionBlockers}
          sessionEntryById={sessionEntryById}
          disabled={sessionSwitchBlocked}
          onChange={onWorkSessionChange}
        />
        {sessionLoading ? (
          <p className="cn2b-hint" role="status">{t('cn2b_session_loading', lang)}</p>
        ) : activeSessionId ? (
          <Panel titleKey="cn2b_panel_review" icon="editor">
            <CentralNeedsDispositionTable
              importSessionId={activeSessionId}
              records={records}
              dispositions={dispositions}
              overrides={overrides}
              organizationId={organizationId}
              canEdit={canEdit && isDraft}
              onChanged={() => void onDispositionsChanged()}
              onActivityChange={setReviewActivity}
            />
          </Panel>
        ) : (
          <p className="cn2b-hint">{t('cn2b_stage_review_waiting', lang)}</p>
        )}
      </>
    ),

    beneficiaries: !revisionDataReady ? (
      <p className="cn2b-hint" role="status">{t('cn2b_revision_loading', lang)}</p>
    ) : revision ? (
      <Panel titleKey="cn2b_panel_beneficiary_columns" icon="editor">
        <CentralNeedsBeneficiaryColumnPanel
          lang={lang}
          planRevisionId={revision.id}
          editable={canEdit && isDraft}
          columns={beneficiaryColumns}
          activeCareInstitutions={careInstitutions}
          onChanged={() => void reloadRevision(revision.id)}
          onActivityChange={setBeneficiaryActivity}
        />
      </Panel>
    ) : (
      <p className="cn2b-hint">{t('cn2b_stage_revision_waiting', lang)}</p>
    ),

    'need-lines': !revisionDataReady ? (
      <p className="cn2b-hint" role="status">{t('cn2b_revision_loading', lang)}</p>
    ) : revision ? (
      <>
        <WorkSessionSelector
          lang={lang}
          sessions={sessions}
          activeSessionId={activeSessionId}
          blockerSummary={sessionBlockers}
          sessionEntryById={sessionEntryById}
          disabled={sessionSwitchBlocked}
          onChange={onWorkSessionChange}
        />
        <Panel titleKey="cn2b_panel_need_lines" icon="editor">
          <CentralNeedsNeedLinePanel
            lang={lang}
            planRevisionId={revision.id}
            workSessionId={activeSessionId}
            editable={canEdit && isDraft}
            dispositions={dispositions}
            records={records}
            overrides={overrides}
            beneficiaryColumns={beneficiaryColumns}
            needLines={needLines}
            claimedSources={claimedSources}
            onChanged={() => void reloadRevision(revision.id)}
            onActivityChange={setNeedLineActivity}
          />
        </Panel>
      </>
    ) : (
      <p className="cn2b-hint">{t('cn2b_stage_revision_waiting', lang)}</p>
    ),

    readiness: !revisionDataReady ? (
      <p className="cn2b-hint" role="status">{t('cn2b_revision_loading', lang)}</p>
    ) : (
      <Panel titleKey="cn2b_panel_readiness" icon="alerts">
        {!readiness ? (
          <PhoenixEmptyState title={t('cn2b_readiness_unknown', lang)} />
        ) : readiness.ready ? (
          <p className="cn2b-hint"><StateBadge state="ready" /> {t('cn2b_readiness_ready', lang)}</p>
        ) : (
          <>
            <p className="cn2b-hint"><StateBadge state="incomplete" /> {t('cn2b_readiness_blocked', lang)}</p>
            <ul className="cn2b-blockers">
              {readiness.blockers.map((b, i) => (
                <li key={`${b.blocker}-${i}`}>
                  <strong>{blockerLabel(b.blocker, lang)}</strong>
                  {b.detail && <code className="cn2b-code"> {b.detail}</code>}
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="cn2b-actions">
          {canEdit && isDraft && (
            <button
              type="button"
              className="cn2b-btn cn2b-btn--primary"
              disabled={busy !== null || !readiness?.ready}
              onClick={() => void onSubmit()}
            >
              {t('cn2b_submit', lang)}
            </button>
          )}
          {canApprove && revision?.status === 'submitted' && (
            <>
              <button type="button" className="cn2b-btn cn2b-btn--primary" disabled={busy !== null} onClick={() => void onApprove()}>
                {t('cn2b_approve', lang)}
              </button>
              <button type="button" className="cn2b-btn" disabled={busy !== null} onClick={() => void onReject()}>
                {t('cn2b_reject', lang)}
              </button>
            </>
          )}
        </div>
      </Panel>
    ),
  };

  return (
    <div className="cn2b" dir={dir}>
      {/*
        UX-1 command header. Every value below is the one the panels already
        show — the selected revision's own year, number and workflow status,
        and the server's readiness verdict. It restates them where an operator
        can see them without scrolling; it never computes one.
      */}
      <header className="cn2b-header">
        <div className="cn2b-header__identity">
          <h1 className="cn2b-title">{t('cn2b_title', lang)}</h1>
          <p className="cn2b-subtitle">{t('cn2b_subtitle', lang)}</p>
        </div>
        <div className="cn2b-header__state">
          {revision ? (
            <span className="cn2b-revchip">
              <span className="cn2b-revchip__plan">{revision.planYear === null ? '—' : revision.planYear}</span>
              <span className="cn2b-revchip__label">{t('cn2b_revision', lang)} {revision.revisionNumber}</span>
              <span className="cn2b-revstatus" data-status={revision.status}>
                {t(`cn2b_revstatus_${revision.status}`, lang)}
              </span>
            </span>
          ) : (
            <span className="cn2b-revchip" data-empty="true">
              {revisionsLoading ? t('cn2b_revisions_loading', lang) : t('cn2b_no_revisions', lang)}
            </span>
          )}
          {revisionDataReady && readiness && (readiness.ready ? <StateBadge state="ready" /> : <StateBadge state="incomplete" />)}
        </div>
      </header>

      <CentralNeedsWorkflowNav
        lang={lang}
        activeStage={initialStageResolved ? activeStage : null}
        stageProgress={stageProgress}
        busyStage={busyStage}
        resultStage={backgroundResult?.stage ?? null}
        onStageChange={onStageChange}
      />

      <section className="cn2b-guidance" aria-live="polite">
        {!initialStageResolved ? (
          /* §7.2 - until the initial stage is decided the strip says it is
             loading rather than naming Stage 1 as the current task. */
          <span className="cn2b-guidance__state">{t('cn2b_workspace_loading', lang)}</span>
        ) : (
          <>
            <span className="cn2b-guidance__label">{t('cn2b_current_task', lang)}</span>
            <strong className="cn2b-guidance__task">
              {t(CENTRAL_NEEDS_STAGES.find((stage) => stage.id === activeStage)?.titleKey ?? 'cn2b_stage_plan', lang)}
            </strong>
            <span className="cn2b-guidance__state">
              {t(stageProgressLabelKey(stageProgress[activeStage]), lang)}
            </span>
            {recommendedStage !== activeStage && (
              <>
                <span className="cn2b-guidance__label">{t('cn2b_recommended_task', lang)}</span>
                <span className="cn2b-guidance__state">
                  {t(CENTRAL_NEEDS_STAGES.find((stage) => stage.id === recommendedStage)?.titleKey ?? 'cn2b_stage_plan', lang)}
                </span>
              </>
            )}
          </>
        )}
      </section>

      {backgroundResult && (
        <p className="cn2b-background-result" role={backgroundResult.failed ? 'alert' : 'status'}>
          {t(backgroundResult.failed ? 'cn2b_background_failed' : 'cn2b_background_result', lang)} —{' '}
          {t(CENTRAL_NEEDS_STAGES.find((stage) => stage.id === backgroundResult.stage)?.titleKey ?? 'cn2b_stage_plan', lang)}
        </p>
      )}

      {error && <PhoenixErrorState message={centralNeedsErrorText(error, lang)} />}
      {notice && <p className="cn2b-notice" role="status">{t(notice, lang)}</p>}

      {!initialStageResolved && (
        /* §7.2 - the workspace loading state. The six stage wrappers below
           stay mounted (§4.3); none of them is painted yet. The guidance strip
           above is the page's ONE polite status region (§4.3) and already
           announces this, so the placeholder is visual only. */
        <p className="cn2b-workspace-loading cn2b-hint">
          {t('cn2b_workspace_loading', lang)}
        </p>
      )}

      {CENTRAL_NEEDS_STAGES.map((stage, index) => (
        <section
          key={stage.id}
          id={stageDomId(stage.id)}
          className="cn2b-stage"
          data-stage={stage.id}
          data-active={initialStageResolved && stage.id === activeStage}
          hidden={!initialStageResolved || stage.id !== activeStage}
          aria-labelledby={stageTitleDomId(stage.id)}
          /* Not a tab stop — a scroll target the navigator can focus, so a
             keyboard user lands inside the stage they asked for. */
          tabIndex={-1}
        >
          <h2 className="cn2b-stage__title" id={stageTitleDomId(stage.id)}>
            <span className="cn2b-stage__ordinal" aria-hidden="true">{index + 1}</span>
            <span className="cn2b-stage__text">{t(stage.titleKey, lang)}</span>
          </h2>
          <div className="cn2b-stage__body">{stageBody[stage.id]}</div>
        </section>
      ))}
    </div>
  );
}

/**
 * Diagnostics, totals and the ADVISORY family signal. The family is shown with
 * its confidence and its reasons precisely so it reads as a hint a human may
 * disregard — it drives no decision anywhere in this feature.
 */
function PreviewSummary({ result, kind }: { result: FileParseResult | ArchiveParseResult; kind: 'file' | 'archive' }) {
  const { lang } = useApp();
  const files: FileParseResult[] = kind === 'archive' ? (result as ArchiveParseResult).entries : [result as FileParseResult];
  const archive = kind === 'archive' ? (result as ArchiveParseResult) : null;

  return (
    <div className="cn2b-preview">
      {archive && (
        <dl className="cn2b-kv">
          <div><dt>{t('cn2b_files_total', lang)}</dt><dd>{archive.reconciliation.filesTotal}</dd></div>
          <div><dt>{t('cn2b_files_accepted', lang)}</dt><dd>{archive.reconciliation.filesAccepted}</dd></div>
          <div><dt>{t('cn2b_files_rejected', lang)}</dt><dd>{archive.reconciliation.filesRejected}</dd></div>
          <div><dt>{t('cn2b_files_excluded', lang)}</dt><dd>{archive.reconciliation.filesExcluded}</dd></div>
        </dl>
      )}

      {archive && archive.excludedEntries.length > 0 && (
        <ul className="cn2b-diagnostics">
          {archive.excludedEntries.map((e) => (
            <li key={e.path} data-severity="info">
              <code className="cn2b-code">{e.path}</code> — {t(`cn2b_excluded_${e.reason}`, lang)}
            </li>
          ))}
        </ul>
      )}

      {files.map((f, i) => (
        <div key={`${f.input.sha256}-${i}`} className="cn2b-file-summary">
          <h3 className="cn2b-file-summary__name">
            {f.input.archiveEntryPath ?? f.input.originalFilename}
            <code className="cn2b-code">{f.input.sha256.slice(0, 12)}…</code>
          </h3>
          {f.family && (
            <p className="cn2b-advisory">
              <span className="cn2b-advisory__tag">{t('cn2b_family_advisory', lang)}</span>
              {t(`cn2b_family_${f.family.family}`, lang)} · {Math.round(f.family.confidence * 100)}%
              <span className="cn2b-advisory__why">{f.family.evidence.join(' · ')}</span>
            </p>
          )}
          {f.workbook && (
            <dl className="cn2b-kv">
              <div><dt>{t('cn2b_sheets', lang)}</dt><dd>{f.workbook.totals.sheetCount}</dd></div>
              <div><dt>{t('cn2b_formulas', lang)}</dt><dd>{f.workbook.totals.formulaCellCount}</dd></div>
              <div><dt>{t('cn2b_zeros', lang)}</dt><dd>{f.workbook.totals.numericZeroCellCount}</dd></div>
              <div><dt>{t('cn2b_blanks', lang)}</dt><dd>{f.workbook.totals.explicitBlankCellCount}</dd></div>
              <div><dt>{t('cn2b_errors', lang)}</dt><dd>{f.workbook.totals.cachedFormulaErrorCount}</dd></div>
              <div><dt>{t('cn2b_comments', lang)}</dt><dd>{f.workbook.totals.commentCount}</dd></div>
            </dl>
          )}
          {f.diagnostics.length > 0 && (
            <ul className="cn2b-diagnostics">
              {f.diagnostics.map((d, j) => (
                <li key={`${d.code}-${j}`} data-severity={d.severity}>
                  <strong>{d.code}</strong> {d.message}
                </li>
              ))}
            </ul>
          )}
        </div>
      ))}
    </div>
  );
}
