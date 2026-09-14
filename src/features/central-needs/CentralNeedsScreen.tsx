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

/**
 * UX-1 — one operational number, read from state the screen has ALREADY
 * loaded. No metric here triggers a read of its own: a summary that fetched
 * would be a second source of truth for a fact the panels below already show.
 */
function SummaryMetric({ labelKey, value }: { labelKey: string; value: string | number }) {
  const { lang } = useApp();
  return (
    <div className="cn2b-summary__cell">
      <dt className="cn2b-summary__label">{t(labelKey, lang)}</dt>
      <dd className="cn2b-summary__value">{value}</dd>
    </div>
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
    setRecords([]);
    setDispositions([]);
    setSourceQuery('');
    setSourceFiles([]);
    setEntryHits([]);
    setSourceSearchError(null);
    setSourceSearchPhase('idle');
  }, []);

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
    // FINDING B — claim this reload's generation BEFORE awaiting. The same six
    // reads run, in the same order; only the right to commit them is gated.
    const seq = (revisionReloadSeq.current += 1);
    const [nextSessions, nextBatches, nextOverrides, nextReadiness, nextLineage, nextBeneficiaryColumns] =
      await Promise.all([
        listImportSessions(id),
        listImportBatches(id),
        listOverrides(id),
        fetchReviewReadiness(id),
        // Revision-wide, through the exact-decimal read: a line's provenance may
        // span every import session of the revision.
        listNeedLineLineage(id),
        // (213) Revision-wide too: a physical column's mapping is not scoped
        // to whichever import session happens to be on screen.
        listBeneficiaryColumns(id),
      ]);
    // A newer reload started while this one was in flight: its answer is the
    // current one, and this late reply is discarded rather than overwriting it.
    if (seq !== revisionReloadSeq.current) return;
    setSessions(nextSessions);
    setBatches(nextBatches);
    setOverrides(nextOverrides);
    setReadiness(nextReadiness);
    setNeedLines(nextLineage.needLines);
    setClaimedSources(nextLineage.sources);
    setBeneficiaryColumns(nextBeneficiaryColumns);
    const completed = nextSessions.filter((s) => s.status === 'completed');
    setActiveSessionId((current) => (current && completed.some((s) => s.id === current) ? current : completed[0]?.id ?? null));
    // Last, and only here: every read above succeeded and this is still the
    // current generation, so the committed evidence now provably belongs to
    // `id`. A rejected reload never reaches this line, so a failure leaves the
    // identity null rather than mislabelling stale data.
    setDataRevisionId(id);
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

  const onOpenRevision = useCallback(async (openNext: boolean) => {
    if (!organizationId) return;
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
  }, [organizationId, planYear]);

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
    if (activeSessionId) setDispositions(await listDispositions(activeSessionId));
    if (revisionId) setReadiness(await fetchReviewReadiness(revisionId));
  }, [activeSessionId, revisionId]);

  // --- render --------------------------------------------------------------

  if (!organizationId) {
    return <PhoenixEmptyState title={t('cn2b_no_organization', lang)} />;
  }

  const previewResult = preview.state.phase === 'ready' ? preview.state.outcome.result : null;

  // UX-1 — summary figures, every one of them counted off state already on
  // screen. A column counts as decided once a review decision exists for it,
  // whichever decision that was.
  /**
   * THE RENDER-TIME ATTRIBUTION GATE.
   *
   * Computed during render from the two identities, so it is already correct in
   * the very first commit after `revisionId` changes — the render in which the
   * effect has not run yet and the state below still holds the previous
   * revision's evidence. Nothing revision-scoped may be presented unless the
   * committed data provably belongs to the revision now selected.
   */
  const revisionDataReady = revisionId !== null && dataRevisionId === revisionId;

  const completedSessionCount = sessions.filter((s) => s.status === 'completed').length;
  const decidedColumnCount = beneficiaryColumns.filter((c) => c.decision !== null).length;
  /** An unattributable figure is shown as unknown, never as a number. */
  const metric = (value: number | string) => (revisionDataReady ? value : '—');

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
            onChange={(e) => setRevisionId(e.target.value || null)}
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
                      disabled={s.status !== 'completed'}
                      onClick={() => setActiveSessionId(s.id)}
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
    ) : sessionLoading ? (
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
        />
      </Panel>
    ) : (
      <p className="cn2b-hint">{t('cn2b_stage_review_waiting', lang)}</p>
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
        />
      </Panel>
    ) : (
      <p className="cn2b-hint">{t('cn2b_stage_revision_waiting', lang)}</p>
    ),

    'need-lines': !revisionDataReady ? (
      <p className="cn2b-hint" role="status">{t('cn2b_revision_loading', lang)}</p>
    ) : revision ? (
      <Panel titleKey="cn2b_panel_need_lines" icon="editor">
        <CentralNeedsNeedLinePanel
          lang={lang}
          planRevisionId={revision.id}
          editable={canEdit && isDraft}
          dispositions={dispositions}
          records={records}
          overrides={overrides}
          beneficiaryColumns={beneficiaryColumns}
          needLines={needLines}
          claimedSources={claimedSources}
          onChanged={() => void reloadRevision(revision.id)}
        />
      </Panel>
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

      <CentralNeedsWorkflowNav lang={lang} />

      <section className="cn2b-summary" aria-label={t('cn2b_summary_label', lang)}>
        <dl className="cn2b-summary__grid">
          <SummaryMetric labelKey="cn2b_sum_sessions" value={metric(`${completedSessionCount}/${sessions.length}`)} />
          <SummaryMetric labelKey="cn2b_sum_batches" value={metric(batches.length)} />
          <SummaryMetric labelKey="cn2b_sum_columns" value={metric(`${decidedColumnCount}/${beneficiaryColumns.length}`)} />
          <SummaryMetric labelKey="cn2b_sum_need_lines" value={metric(needLines.length)} />
          <SummaryMetric labelKey="cn2b_sum_blockers" value={metric(readiness ? readiness.blockers.length : '—')} />
        </dl>
      </section>

      {error && <PhoenixErrorState message={centralNeedsErrorText(error, lang)} />}
      {notice && <p className="cn2b-notice" role="status">{t(notice, lang)}</p>}

      {CENTRAL_NEEDS_STAGES.map((stage, index) => (
        <section
          key={stage.id}
          id={stageDomId(stage.id)}
          className="cn2b-stage"
          data-stage={stage.id}
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
