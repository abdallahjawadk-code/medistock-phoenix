/**
 * R1-A4 — the manual annual-needs JOURNEY of the Screen-3 tab:
 *   year -> beneficiary institution -> material -> manual annual quantity -> review -> submit -> independent approve / reject -> history.
 *
 * It COMPOSES the existing pieces (the manual workspace for the lines, the PRE3-A resolver through the picker, the governed
 * material registration, the A3 identity assist, the existing readiness / submit / approve / reject routines and the revision
 * history) and adds no authority of its own. Org-level scope: nothing here depends on a selected warehouse. Every decision is a
 * server call followed by a re-read; responses of a previous organization / year are discarded; the maker can never approve.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CentralNeedsError, type ReviewReadiness } from '../central-needs.service';
import { CentralNeedsRevisionHistory } from '../CentralNeedsRevisionHistory';
import { useCentralNeedsPreview } from '../useCentralNeedsPreview';
import { ManualNeedsWorkspace, type ManualNeedsApi } from './ManualNeedsWorkspace';
import { MaterialPicker } from './MaterialPicker';
import { MaterialRegistrationPanel, type RegistrationApi, type RegistrationPrefill, type ResolvedMaterialUse } from './MaterialRegistrationPanel';
import { IdentityAssistPanel, type IdentityPreviewHandle } from './IdentityAssistPanel';
import { realJourneyApi, type BeneficiaryOption, type CatalogOption, type JourneyApi, type YearRevision } from './manual-journey.service';
import type { ManualCapabilities } from './manual-needs.service';
import { jt, journeyErrorText, type JourneyKey, type JourneyLang } from './manual-journey.i18n';

interface Props {
  lang: JourneyLang;
  organizationId: string;
  actorId: string;
  api?: JourneyApi;
  workspaceApi?: ManualNeedsApi;
  registrationApi?: RegistrationApi;
  /** test seam for the in-browser workbook preview; the real hook is used otherwise */
  preview?: IdentityPreviewHandle;
  /** test seam: the plan year the journey opens on */
  initialYear?: number;
}

const BLOCKER_COPY: Record<string, { ar: string; en: string }> = {
  manual_revision_has_no_lines: { ar: 'لا توجد أسطر في الإصدار.', en: 'The revision has no lines.' },
  manual_revision_has_import_evidence: { ar: 'الإصدار اليدوي يحوي أدلة استيراد.', en: 'A manual revision carries import evidence.' },
  manual_projection_event_divergence: { ar: 'تعارض بين السطر وسجل الأحداث.', en: 'A line disagrees with its event chain.' },
  manual_event_without_line: { ar: 'حدث بلا سطر مقابل.', en: 'An event has no matching line.' },
  manual_line_beneficiary_ineligible: { ar: 'مؤسسة مستفيدة غير مؤهلة.', en: 'An ineligible beneficiary institution.' },
  manual_line_item_not_active: { ar: 'مادة غير فعّالة.', en: 'An item is not active.' },
  manual_line_unit_mismatch: { ar: 'وحدة لا تطابق الدليل.', en: 'A unit does not match the catalog.' },
  manual_line_warehouse_ineligible: { ar: 'مخزن غير مؤهل.', en: 'An ineligible warehouse.' },
  manual_coverage_unacknowledged: { ar: 'مواد من الإصدار السابق غير مشمولة وتحتاج إقرارًا.', en: 'Items of the previous revision are omitted and need an acknowledgement.' },
};

const currentYear = () => new Date().getFullYear();

export function ManualNeedsJourney({ lang, organizationId, actorId, api = realJourneyApi, workspaceApi, registrationApi, preview, initialYear }: Props) {
  const realPreview = useCentralNeedsPreview();
  const previewHandle: IdentityPreviewHandle = preview ?? realPreview;
  const [yearText, setYearText] = useState(String(initialYear ?? currentYear()));
  const [year, setYear] = useState<number | null>(null);               // the year actually opened
  const [revisions, setRevisions] = useState<YearRevision[] | null>(null);
  const [caps, setCaps] = useState<ManualCapabilities | null>(null);
  const [beneficiaries, setBeneficiaries] = useState<BeneficiaryOption[] | null>(null);
  const [benefFailed, setBenefFailed] = useState(false);
  const [items, setItems] = useState<CatalogOption[]>([]);
  const [prefill, setPrefill] = useState<RegistrationPrefill | null>(null);
  const [showRegistration, setShowRegistration] = useState(false);
  const [readiness, setReadiness] = useState<ReviewReadiness | null>(null);
  const [confirmSubmit, setConfirmSubmit] = useState(false);
  const [correctionReason, setCorrectionReason] = useState('');
  const [rejectReason, setRejectReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const epoch = useRef(0);

  const latest = revisions && revisions.length > 0 ? revisions[0] : null;
  const yearValid = /^\d{4}$/.test(yearText) && Number(yearText) >= 2000 && Number(yearText) <= 2100;

  // organization switch: forget everything and discard anything still in flight
  useEffect(() => {
    epoch.current += 1;
    const mine = epoch.current;
    setYear(null); setRevisions(null); setCaps(null); setItems([]); setPrefill(null); setShowRegistration(false); setReadiness(null);
    setConfirmSubmit(false); setNotice(null); setErrorText(null); setLoadFailed(false); setBenefFailed(false); setBeneficiaries(null);
    previewHandle.reset();
    void (async () => {
      try {
        const list = await api.listBeneficiaries();
        if (epoch.current === mine) setBeneficiaries(list);
      } catch {
        if (epoch.current === mine) { setBeneficiaries([]); setBenefFailed(true); }
      }
    })();
    return () => { epoch.current += 1; };
  }, [organizationId]);

  const loadYear = useCallback(async (y: number, mine: number) => {
    try {
      const revs = await api.listYearRevisions(organizationId, y);
      const c = await api.getCaps(organizationId, revs[0]?.id ?? null);
      if (epoch.current !== mine) return;
      setRevisions(revs); setCaps(c); setYear(y); setLoadFailed(false);
    } catch {
      if (epoch.current !== mine) return;
      setLoadFailed(true);
    }
  }, [api, organizationId]);

  const openYear = () => {
    if (!yearValid) return;
    epoch.current += 1;
    const mine = epoch.current;
    setRevisions(null); setCaps(null); setReadiness(null); setConfirmSubmit(false); setNotice(null); setErrorText(null);
    void loadYear(Number(yearText), mine);
  };

  /** One server action, then a re-read of the truth. A refusal is shown by its database identifier; a stale one refreshes. */
  const act = async (fn: () => Promise<unknown>, okNotice: string) => {
    if (year === null) return;
    const mine = epoch.current;
    setBusy(true); setErrorText(null); setNotice(null);
    try {
      await fn();
      if (epoch.current !== mine) return;
      setReadiness(null); setConfirmSubmit(false); setRejectReason(''); setCorrectionReason('');
      await loadYear(year, mine);
      if (epoch.current !== mine) return;
      setNotice(okNotice);
    } catch (e: unknown) {
      if (epoch.current !== mine) return;
      if (e instanceof CentralNeedsError) {
        setErrorText(journeyErrorText(e, lang));
        if (e.businessCode === 'central_needs_revision_stale' || e.businessCode === 'plan_revision_not_editable') { setNotice(jt('stale', lang)); await loadYear(year, mine); }
      } else {
        setErrorText(jt('err_load_failed', lang));
      }
    } finally {
      if (epoch.current === mine) setBusy(false);
    }
  };

  /** Readiness is a READ: it must survive until the person acts, so it does not go through `act` (which re-reads and clears it). */
  const checkReadiness = async () => {
    if (!latest) return;
    const mine = epoch.current;
    setBusy(true); setErrorText(null); setNotice(null);
    try {
      const r = await api.readiness(latest.id);
      if (epoch.current === mine) setReadiness(r);
    } catch (e: unknown) {
      if (epoch.current !== mine) return;
      setReadiness(null);
      setErrorText(e instanceof CentralNeedsError ? journeyErrorText(e, lang) : jt('err_load_failed', lang));
    } finally {
      if (epoch.current === mine) setBusy(false);
    }
  };

  const beneficiaryOptions = useMemo(
    () => (beneficiaries ?? []).map((b) => ({ id: b.id, name: lang === 'ar' && b.nameAr ? b.nameAr : b.name })),
    [beneficiaries, lang],
  );
  const itemOptions = useMemo(() => items.map((i) => ({ id: i.id, name: lang === 'ar' && i.nameAr ? i.nameAr : i.name, unit: i.unit })), [items, lang]);

  const addItem = (i: CatalogOption) => setItems((cur) => (cur.some((x) => x.id === i.id) ? cur : [...cur, i]));
  const useResolved = (r: ResolvedMaterialUse) => addItem({ id: r.id, name: r.name, nameAr: r.nameAr, concentration: r.concentration, dosageForm: r.dosageForm, unit: r.unit });

  const isManualDraft = !!latest && latest.sourceMode === 'manual' && latest.status === 'draft';
  const canDecide = !!latest && latest.status === 'submitted' && !!caps && caps.approve && !caps.approveExcludedForRevision;
  const makerBlocked = !!latest && latest.status === 'submitted' && !!caps && caps.approve && caps.approveExcludedForRevision;
  const closed = !!latest && ['approved', 'rejected', 'withdrawn'].includes(latest.status);
  const statusText = (s: string) => jt(`status_${s}` as JourneyKey, lang);

  return (
    <section dir={lang === 'ar' ? 'rtl' : 'ltr'} aria-labelledby="journey-title" data-testid="manual-needs-journey">
      <h2 id="journey-title">{jt('title', lang)}</h2>
      <div role="status" aria-live="polite">{notice}</div>
      {errorText && <p role="alert">{errorText}</p>}
      {benefFailed && <p role="alert">{jt('beneficiaries_failed', lang)}</p>}

      <section aria-labelledby="step-year">
        <h3 id="step-year">{jt('step_year', lang)}</h3>
        <form onSubmit={(e) => { e.preventDefault(); openYear(); }}>
          <label>{jt('year', lang)}
            <input dir="ltr" inputMode="numeric" value={yearText} disabled={busy} aria-invalid={!yearValid} onChange={(e) => setYearText(e.target.value)} />
          </label>
          <button type="submit" disabled={!yearValid || busy}>{jt('open_year', lang)}</button>
        </form>
        {loadFailed && <p role="alert">{jt('failed', lang)}</p>}
        {year !== null && revisions !== null && caps !== null && (
          <div>
            {latest ? (
              <p>{jt('revision_label', lang).replace('__N__', String(latest.revisionNumber)).replace('__S__', statusText(latest.status))}</p>
            ) : <p>{jt('no_revision', lang)}</p>}
            {!latest && caps.edit && caps.manualSet && (
              <button type="button" disabled={busy} onClick={() => void act(() => api.openPlan(organizationId, year), jt('start_plan', lang))}>{jt('start_plan', lang)}</button>
            )}
            {latest && latest.sourceMode === 'excel' && <p role="note">{jt('excel_revision_readonly', lang)}</p>}
            {latest && closed && caps.edit && caps.manualSet && (
              <div>
                <label>{jt('correction_reason', lang)}
                  <input value={correctionReason} disabled={busy} onChange={(e) => setCorrectionReason(e.target.value)} />
                </label>
                <button type="button" disabled={busy || correctionReason.trim() === ''}
                  onClick={() => void act(() => api.openCorrection(organizationId, year, latest.id, correctionReason.trim()), jt('open_correction', lang))}>{jt('open_correction', lang)}</button>
              </div>
            )}
          </div>
        )}
      </section>

      {year !== null && latest && latest.sourceMode === 'manual' && caps && (
        <>
          <section aria-labelledby="step-lines">
            <h3 id="step-lines">{jt('step_lines', lang)}</h3>
            {isManualDraft && (
              <>
                <MaterialPicker lang={lang} scopeKey={`${organizationId}:${latest.id}`} search={api.searchCatalog} selected={items}
                  onPick={addItem} onRemove={(id) => setItems((c) => c.filter((x) => x.id !== id))} onRequestRegistration={() => setShowRegistration(true)} />
                <IdentityAssistPanel lang={lang} scopeKey={`${organizationId}:${latest.id}`} preview={previewHandle} resolve={api.resolveForIdentity}
                  onUseItem={addItem} onRequestRegistration={(p) => { setPrefill(p); setShowRegistration(true); }} />
                {showRegistration && (
                  <MaterialRegistrationPanel lang={lang} organizationId={organizationId} actorId={actorId} planRevisionId={latest.id}
                    prefill={prefill} onUseItem={useResolved} api={registrationApi} />
                )}
              </>
            )}
            <ManualNeedsWorkspace lang={lang} organizationId={organizationId} planRevisionId={latest.id} revisionStatus={latest.status}
              sourceMode={latest.sourceMode} beneficiaries={beneficiaryOptions} items={itemOptions} api={workspaceApi} />
          </section>

          {isManualDraft && (
            <section aria-labelledby="step-review">
              <h3 id="step-review">{jt('step_review', lang)}</h3>
              <button type="button" disabled={busy} onClick={() => void checkReadiness()}>{jt('readiness', lang)}</button>
              {readiness && (readiness.ready
                ? <p role="status">{jt('ready', lang)}</p>
                : (
                  <div role="alert">
                    <p>{jt('not_ready', lang)}</p>
                    <ul>{readiness.blockers.map((b) => <li key={`${b.blocker}:${b.detail ?? ''}`}>{BLOCKER_COPY[b.blocker]?.[lang] ?? b.blocker}</li>)}</ul>
                  </div>
                ))}
            </section>
          )}

          {isManualDraft && readiness?.ready && caps.edit && (
            <section aria-labelledby="step-submit">
              <h3 id="step-submit">{jt('step_submit', lang)}</h3>
              {!confirmSubmit
                ? <button type="button" disabled={busy} onClick={() => setConfirmSubmit(true)}>{jt('submit', lang)}</button>
                : (
                  <div role="group" aria-label={jt('confirm_submit', lang)}>
                    <button type="button" disabled={busy} onClick={() => void act(() => api.submit(latest.id), jt('submitted_ok', lang))}>{jt('confirm_submit', lang)}</button>
                    <button type="button" disabled={busy} onClick={() => setConfirmSubmit(false)}>{jt('cancel', lang)}</button>
                  </div>
                )}
            </section>
          )}

          {latest.status === 'submitted' && (
            <section aria-labelledby="step-decide">
              <h3 id="step-decide">{jt('step_decide', lang)}</h3>
              {makerBlocked && <p role="note">{jt('maker_cannot_decide', lang)}</p>}
              {!caps.approve && <p role="note">{jt('no_decide_rights', lang)}</p>}
              {canDecide && (
                <div>
                  <button type="button" disabled={busy} onClick={() => void act(() => api.approve(latest.id), jt('decided_ok', lang))}>{jt('approve', lang)}</button>
                  <label>{jt('reject_reason', lang)}
                    <input value={rejectReason} disabled={busy} onChange={(e) => setRejectReason(e.target.value)} />
                  </label>
                  <button type="button" disabled={busy || rejectReason.trim() === ''} onClick={() => void act(() => api.reject(latest.id, rejectReason.trim()), jt('decided_ok', lang))}>{jt('reject', lang)}</button>
                </div>
              )}
            </section>
          )}
        </>
      )}

      {year !== null && (
        <section aria-labelledby="step-history">
          <h3 id="step-history">{jt('step_history', lang)}</h3>
          <CentralNeedsRevisionHistory lang={lang} organizationId={organizationId} planYear={year} />
        </section>
      )}
    </section>
  );
}
