/**
 * C4 — the PERSISTED beneficiary-region layer of the sheet on screen.
 *
 * Two layers, never mixed:
 *   * SAVED — the server's ACTIVE region versions for this (import session,
 *     sheet), keyed by `versionId`, read fresh from the server every time the
 *     sheet changes and after every write. Never injected into E2-C.
 *   * UNSAVED — the human's E2-C drafts. They become explicit `add` changes
 *     only when the human confirms them with a reason; once saved they leave
 *     the unsaved layer.
 *
 * Every write goes through `setBeneficiaryRegions`, fenced on the ACTIVE
 * version ids this layer last loaded. A stale refusal reloads the layer and
 * asks the human to decide again — never an automatic retry. A failed or
 * inconsistent read shows the layer as unavailable and disables every write.
 * Writing also needs `canWrite` (edit permission AND a draft revision) and the
 * G3 guarantee (the grid on screen was rendered by the session's parser).
 *
 * An M213-decided column is shown read-only. "Convert to regions" never
 * creates a region by itself and never copies the M213 decision: the human
 * draws every rectangle and picks every beneficiary, and the conversion is
 * sent in the same call. Importing a modified workbook is not a remedy and is
 * never suggested.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { t } from '@/shared/i18n/strings';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixIcon } from '@/shared/ui/PhoenixIcon';
import {
  CentralNeedsError,
  listBeneficiaryRegions,
  listScopeColumnMappings,
  setBeneficiaryRegions,
  type BeneficiaryRegionChange,
  type BeneficiaryRegionVersion,
  type ImportSession,
  type ScopeColumnMapping,
} from '../central-needs.service';
import { centralNeedsErrorText } from '../central-needs.i18n';
import type { BeneficiaryChoice } from '../mapping/InstitutionMappingPanel';
import type { InstitutionMappingController } from '../mapping/useInstitutionMapping';
import type { WorkbookSelection } from '../excel-first/workbookSelection';
import {
  addsFromDrafts,
  boundsLabel,
  boundsOfNeed,
  conversionOf,
  conversionsWithoutRegion,
  draftObstacles,
  loadedLayerConflict,
  regionGovernsColumn,
  renderedParserMatchesSession,
  RUNNING_PARSER_IDENTITY,
  type RegionBounds,
  type UnsavedDraftSources,
} from './beneficiaryRegions';

type Lang = 'ar' | 'en';

type Layer =
  | { phase: 'idle' }
  | { phase: 'loading' }
  | { phase: 'ready'; active: BeneficiaryRegionVersion[]; m213: ScopeColumnMapping[] }
  | { phase: 'unavailable'; code: string };

/** One pending human action; each needs its own reason before anything is sent. */
type Pending =
  | { kind: 'save' }
  | { kind: 'remove'; versionId: string }
  | { kind: 'replace'; versionId: string; bounds: RegionBounds }
  | { kind: 'non_beneficiary'; bounds: RegionBounds }
  | { kind: 'inverse'; columnIndex: number; versionIds: string[] };

interface Props {
  lang: Lang;
  planRevisionId: string;
  /** `canEdit && isDraft`. Without it the layer is read-only. */
  canWrite: boolean;
  careInstitutions: readonly BeneficiaryChoice[];
  /** The revision's import sessions; the G3 check reads the scope session's parser identity. */
  sessions: readonly ImportSession[];
  /** The E2-C controller: its trusted context is this layer's scope, its entries are the unsaved layer. */
  institutions: InstitutionMappingController;
  onChanged?: () => void;
  /** Shares this sheet's unsaved Need sources with the workspace (Simple one-click suppression). */
  onUnsavedDraftsChange?: (drafts: UnsavedDraftSources | null) => void;
}

const boundsOfSelection = (selection: WorkbookSelection | null): RegionBounds | null => {
  if (!selection) return null;
  if (selection.kind === 'column') return boundsOfNeed({ kind: 'column', columnIndex: selection.columnIndex });
  if (selection.kind === 'range') {
    return { rowStart: selection.startRow, rowEnd: selection.endRow, columnStart: selection.startColumn, columnEnd: selection.endColumn };
  }
  return { rowStart: selection.rowIndex, rowEnd: selection.rowIndex, columnStart: selection.columnIndex, columnEnd: selection.columnIndex };
};

export function BeneficiaryRegionLayer({
  lang, planRevisionId, canWrite, careInstitutions, sessions, institutions,
  onChanged, onUnsavedDraftsChange,
}: Props) {
  // The stored viewer renders with this build's own parser.
  const renderedParserIdentity = RUNNING_PARSER_IDENTITY;
  const context = institutions.state.context;
  const scopeSessionId = context?.source.importSessionId ?? null;
  const scopeSheetIndex = context?.sheetIndex ?? null;
  const scopeSheetName = context?.sheetName ?? null;
  const scopeKey = scopeSessionId === null ? null : `${scopeSessionId}:${scopeSheetIndex}`;

  const [layer, setLayer] = useState<Layer>({ phase: 'idle' });
  const [converting, setConverting] = useState<ReadonlySet<number>>(new Set());
  const [pending, setPending] = useState<Pending | null>(null);
  const [reason, setReason] = useState('');
  const [decision, setDecision] = useState<'beneficiary' | 'non_beneficiary'>('beneficiary');
  const [beneficiary, setBeneficiary] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (scopeSessionId === null || scopeSheetIndex === null) {
      setLayer({ phase: 'idle' });
      return;
    }
    const seq = (loadSeq.current += 1);
    setLayer({ phase: 'loading' });
    try {
      const [active, m213] = await Promise.all([
        listBeneficiaryRegions({ planRevisionId, importSessionId: scopeSessionId, sheetIndex: scopeSheetIndex }),
        listScopeColumnMappings({ planRevisionId, importSessionId: scopeSessionId, sheetIndex: scopeSheetIndex }),
      ]);
      if (seq !== loadSeq.current) return;
      if (loadedLayerConflict(active, m213)) {
        setLayer({ phase: 'unavailable', code: 'beneficiary_decision_grain_conflict' });
        return;
      }
      setLayer({ phase: 'ready', active, m213 });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      setLayer({ phase: 'unavailable', code: e instanceof CentralNeedsError ? e.businessCode : 'beneficiary_regions_read_inconsistent' });
    }
  }, [planRevisionId, scopeSessionId, scopeSheetIndex]);

  // A new sheet is a new scope: reload from the server, forget every choice.
  useEffect(() => {
    setConverting(new Set());
    setPending(null);
    setMessage(null);
    void load();
  }, [scopeKey, load]);

  const drafts = institutions.state.mappings;
  const unsaved = useMemo<UnsavedDraftSources | null>(() => {
    if (scopeSessionId === null || scopeSheetIndex === null) return null;
    const needs = drafts.map((d) => boundsOfNeed(d.need));
    const inProgress = institutions.state.draft.need;
    if (inProgress) needs.push(boundsOfNeed(inProgress));
    return { importSessionId: scopeSessionId, sheetIndex: scopeSheetIndex, needs };
  }, [drafts, institutions.state.draft.need, scopeSessionId, scopeSheetIndex]);
  const draftsListener = useRef(onUnsavedDraftsChange);
  useEffect(() => { draftsListener.current = onUnsavedDraftsChange; });
  useEffect(() => { draftsListener.current?.(unsaved); }, [unsaved]);
  useEffect(() => () => draftsListener.current?.(null), []);

  const session = sessions.find((s) => s.id === scopeSessionId) ?? null;
  const g3 = renderedParserMatchesSession(renderedParserIdentity, session?.parserIdentity ?? null);
  const ready = layer.phase === 'ready' ? layer : null;
  const writable = canWrite && g3 && ready !== null && !busy;

  const obstacles = useMemo(
    () => (ready ? draftObstacles(drafts, ready.active, ready.m213, converting) : []),
    [ready, drafts, converting],
  );
  const draftChanges = useMemo(() => addsFromDrafts(drafts), [drafts]);
  const uncoveredConversions = useMemo(() => conversionsWithoutRegion(converting, draftChanges), [converting, draftChanges]);

  const selection = institutions.state.selection;
  const selectionBounds = boundsOfSelection(selection);
  const selectedColumn = selection?.kind === 'column' ? selection.columnIndex : null;

  const orgLabel = (id: string | null) => {
    const hit = careInstitutions.find((c) => c.id === id);
    return hit ? (lang === 'ar' ? hit.name_ar : hit.name) : id ?? '—';
  };

  function begin(next: Pending) {
    setPending(next);
    setReason('');
    setDecision('beneficiary');
    setBeneficiary('');
    setMessage(null);
  }

  async function send(changes: BeneficiaryRegionChange[], savedDraftIds: readonly string[]) {
    if (!ready || !writable || scopeSessionId === null || scopeSheetIndex === null || scopeSheetName === null) return;
    setBusy(true);
    setMessage(null);
    try {
      await setBeneficiaryRegions({
        planRevisionId,
        importSessionId: scopeSessionId,
        sheetIndex: scopeSheetIndex,
        renderedParserIdentity,
        expectedSheetName: scopeSheetName,
        expectedVersionIds: ready.active.map((v) => v.versionId),
        changes,
        reason,
      });
      for (const id of savedDraftIds) institutions.remove(id);
      setPending(null);
      setConverting(new Set());
      setMessage({ tone: 'ok', text: t('cn4_region_saved', lang) });
      await load();
      onChanged?.();
    } catch (e) {
      const refusal = e instanceof CentralNeedsError ? e : 'unknown_error';
      if (refusal instanceof CentralNeedsError && refusal.businessCode === 'beneficiary_region_stale') {
        // Reload what the server holds now; the human must look and decide again.
        setPending(null);
        await load();
        setMessage({ tone: 'error', text: `${centralNeedsErrorText(refusal, lang)} ${t('cn4_region_stale_reloaded', lang)}` });
      } else {
        setMessage({ tone: 'error', text: centralNeedsErrorText(refusal, lang) });
      }
    } finally {
      setBusy(false);
    }
  }

  function confirmPending() {
    if (!pending || !ready || reason.trim() === '') return;
    switch (pending.kind) {
      case 'save': {
        const conversions = ready.m213.filter((m) => converting.has(m.columnIndex)).map(conversionOf);
        void send([...conversions, ...draftChanges], drafts.map((d) => d.id));
        return;
      }
      case 'remove':
        void send([{ op: 'remove', versionId: pending.versionId }], []);
        return;
      case 'inverse':
        void send(pending.versionIds.map((versionId) => ({ op: 'remove' as const, versionId })), []);
        return;
      case 'replace': {
        const ben = decision === 'beneficiary' ? beneficiary : null;
        if (decision === 'beneficiary' && !ben) return;
        void send([{ op: 'replace', versionId: pending.versionId, ...pending.bounds, decision, beneficiaryOrganizationId: ben }], []);
        return;
      }
      case 'non_beneficiary':
        void send([{ op: 'add', ...pending.bounds, decision: 'non_beneficiary', beneficiaryOrganizationId: null }], []);
        return;
      default:
    }
  }

  if (layer.phase === 'idle') return null;

  const canConfirm = reason.trim() !== ''
    && !(pending?.kind === 'replace' && decision === 'beneficiary' && beneficiary === '');

  // The inverse is offered for a selected region-governed column whose every
  // intersecting ACTIVE version is exactly that one column.
  const inverseTargets = ready && selectedColumn !== null && scopeSessionId !== null && scopeSheetIndex !== null
    && regionGovernsColumn(ready.active, scopeSessionId, scopeSheetIndex, selectedColumn)
    ? ready.active.filter((v) => v.columnStart <= selectedColumn && selectedColumn <= v.columnEnd)
    : [];
  const inverseSingleColumn = inverseTargets.length > 0 && inverseTargets.every((v) => v.columnStart === v.columnEnd);

  return (
    <section className="cn2b-panel cn4-region-layer" data-testid="cn4-region-layer" data-phase={layer.phase}
      aria-label={t('cn4_region_title', lang)}>
      <h3 className="cn2b-panel__title">{t('cn4_region_title', lang)}</h3>
      <p className="cn2b-hint">{t('cn4_region_hint', lang)}</p>

      {layer.phase === 'loading' && <p className="cn2b-hint" role="status">{t('cn4_region_loading', lang)}</p>}
      {layer.phase === 'unavailable' && (
        <p className="cn2b-hint" role="alert" data-testid="cn4-region-unavailable">
          <PhoenixIcon name="warning" size={15} inline aria-hidden="true" />{' '}
          {t('cn4_region_unavailable', lang)} ({centralNeedsErrorText(layer.code, lang)})
        </p>
      )}
      {ready && !g3 && (
        <p className="cn2b-hint" role="status" data-testid="cn4-region-g3-read-only">
          <PhoenixIcon name="lock" size={15} inline aria-hidden="true" /> {t('cn4_region_g3_read_only', lang)}
        </p>
      )}
      {ready && !canWrite && (
        <p className="cn2b-hint" data-testid="cn4-region-read-only">{t('cn2b_bc_read_only', lang)}</p>
      )}
      {message && (
        <p className="cn2b-hint" role={message.tone === 'error' ? 'alert' : 'status'} data-testid="cn4-region-message" data-tone={message.tone}>
          {message.text}
        </p>
      )}

      {ready && (
        <>
          <h4>{t('cn4_region_saved_title', lang)}</h4>
          {ready.active.length === 0 ? (
            <p className="cn2b-hint" data-testid="cn4-region-empty">{t('cn4_region_empty', lang)}</p>
          ) : (
            <ul className="cn2b-list" data-testid="cn4-region-saved">
              {ready.active.map((v) => (
                <li key={v.versionId} data-testid="cn4-region-version" data-version-id={v.versionId}
                  data-region-id={v.regionId} data-decision={v.decision}>
                  <bdi>{boundsLabel(v)}</bdi>{' — '}
                  {v.decision === 'beneficiary'
                    ? <bdi>{orgLabel(v.beneficiaryOrganizationId)}</bdi>
                    : t('cn4_region_non_beneficiary', lang)}
                  {' · '}{t('cn4_region_version', lang).replace('__N__', String(v.versionNo))}
                  {' · '}<span>{t('cn2b_history_reason', lang).replace('__REASON__', v.decisionReason)}</span>
                  {writable && (
                    <span className="cn2b-actions">
                      <PhoenixButton type="button" variant="ghost" size="sm" data-testid="cn4-region-remove"
                        onClick={() => begin({ kind: 'remove', versionId: v.versionId })}>
                        {t('cn4_region_remove', lang)}
                      </PhoenixButton>
                      {selectionBounds && (
                        <PhoenixButton type="button" variant="ghost" size="sm" data-testid="cn4-region-replace"
                          onClick={() => begin({ kind: 'replace', versionId: v.versionId, bounds: selectionBounds })}>
                          {t('cn4_region_replace_with_selection', lang)}
                        </PhoenixButton>
                      )}
                    </span>
                  )}
                </li>
              ))}
            </ul>
          )}

          {ready.m213.length > 0 && (
            <>
              <h4>{t('cn4_region_m213_title', lang)}</h4>
              <ul className="cn2b-list" data-testid="cn4-region-m213">
                {ready.m213.map((m) => (
                  <li key={m.mappingId} data-testid="cn4-region-m213-column" data-column={m.columnIndex}
                    data-converting={converting.has(m.columnIndex)}>
                    <bdi>{boundsLabel(boundsOfNeed({ kind: 'column', columnIndex: m.columnIndex }))}</bdi>{' — '}
                    {m.decision === 'beneficiary' ? <bdi>{orgLabel(m.beneficiaryOrganizationId)}</bdi> : t('cn4_region_non_beneficiary', lang)}
                    {' · '}{t('cn4_region_m213_read_only', lang)}
                    {writable && (
                      <PhoenixButton type="button" variant="ghost" size="sm" data-testid="cn4-region-convert"
                        onClick={() => setConverting((prev) => {
                          const next = new Set(prev);
                          if (next.has(m.columnIndex)) next.delete(m.columnIndex); else next.add(m.columnIndex);
                          return next;
                        })}>
                        {converting.has(m.columnIndex) ? t('cn4_region_convert_cancel', lang) : t('cn4_region_convert', lang)}
                      </PhoenixButton>
                    )}
                    {converting.has(m.columnIndex) && (
                      <p className="cn2b-hint" data-testid="cn4-region-converting-hint">{t('cn4_region_converting_hint', lang)}</p>
                    )}
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4>{t('cn4_region_unsaved_title', lang)}</h4>
          {drafts.length === 0 ? (
            <p className="cn2b-hint" data-testid="cn4-region-unsaved-empty">{t('cn4_region_unsaved_empty', lang)}</p>
          ) : (
            <ul className="cn2b-list" data-testid="cn4-region-unsaved">
              {drafts.map((d) => {
                const own = obstacles.filter((o) => o.draftId === d.id);
                return (
                  <li key={d.id} data-testid="cn4-region-unsaved-draft" data-draft-id={d.id} data-blocked={own.length > 0}>
                    <bdi>{boundsLabel(boundsOfNeed(d.need))}</bdi>{' — '}<bdi>{orgLabel(d.beneficiaryOrganizationId)}</bdi>
                    {' · '}{t('cn4_region_unsaved_badge', lang)}
                    {own.map((o) => (
                      <span key={`${o.reason}:${o.conflict}`} className="cn2b-hint" data-testid="cn4-region-obstacle" data-reason={o.reason}>
                        {' '}{t(`cn4_region_obstacle_${o.reason}`, lang)}
                      </span>
                    ))}
                  </li>
                );
              })}
            </ul>
          )}
          {uncoveredConversions.length > 0 && (
            <p className="cn2b-hint" role="status" data-testid="cn4-region-conversion-needs-region">
              {t('cn4_region_conversion_needs_region', lang)}
            </p>
          )}

          {writable && (
            <div className="cn2b-actions">
              <PhoenixButton type="button" variant="primary" size="sm" data-testid="cn4-region-save-drafts"
                disabled={drafts.length === 0 || obstacles.length > 0 || uncoveredConversions.length > 0}
                onClick={() => begin({ kind: 'save' })}>
                {t('cn4_region_save_drafts', lang)}
              </PhoenixButton>
              {selectionBounds && (
                <PhoenixButton type="button" variant="secondary" size="sm" data-testid="cn4-region-mark-non-beneficiary"
                  onClick={() => begin({ kind: 'non_beneficiary', bounds: selectionBounds })}>
                  {t('cn4_region_mark_non_beneficiary', lang)}
                </PhoenixButton>
              )}
              {inverseTargets.length > 0 && inverseSingleColumn && selectedColumn !== null && (
                <PhoenixButton type="button" variant="ghost" size="sm" data-testid="cn4-region-inverse"
                  onClick={() => begin({ kind: 'inverse', columnIndex: selectedColumn, versionIds: inverseTargets.map((v) => v.versionId) })}>
                  {t('cn4_region_inverse', lang)}
                </PhoenixButton>
              )}
            </div>
          )}
          {writable && inverseTargets.length > 0 && !inverseSingleColumn && (
            <p className="cn2b-hint" data-testid="cn4-region-inverse-multi">{t('cn4_region_inverse_multi_column', lang)}</p>
          )}

          {pending && writable && (
            <div className="cn2b-panel" data-testid="cn4-region-confirm" data-kind={pending.kind}>
              {pending.kind === 'inverse' && <p className="cn2b-hint">{t('cn4_region_inverse_hint', lang)}</p>}
              {pending.kind === 'replace' && (
                <>
                  <p className="cn2b-hint"><bdi>{boundsLabel(pending.bounds)}</bdi></p>
                  <label className="cn2b-field">
                    <span className="cn2b-field__label">{t('cn4_region_decision_label', lang)}</span>
                    <select className="cn2b-select" data-testid="cn4-region-decision" value={decision}
                      onChange={(e) => setDecision(e.target.value === 'non_beneficiary' ? 'non_beneficiary' : 'beneficiary')}>
                      <option value="beneficiary">{t('cn4_region_beneficiary', lang)}</option>
                      <option value="non_beneficiary">{t('cn4_region_non_beneficiary', lang)}</option>
                    </select>
                  </label>
                  {decision === 'beneficiary' && (
                    <label className="cn2b-field">
                      <span className="cn2b-field__label">{t('cn4_region_choose_beneficiary', lang)}</span>
                      <select className="cn2b-select" data-testid="cn4-region-beneficiary" value={beneficiary}
                        onChange={(e) => setBeneficiary(e.target.value)}>
                        <option value="">—</option>
                        {careInstitutions.map((c) => <option key={c.id} value={c.id}>{orgLabel(c.id)}</option>)}
                      </select>
                    </label>
                  )}
                </>
              )}
              <label className="cn2b-field">
                <span className="cn2b-field__label">{t('cn4_region_reason_label', lang)}</span>
                <input type="text" className="cn2b-input" data-testid="cn4-region-reason" value={reason}
                  onChange={(e) => setReason(e.target.value)} />
              </label>
              <div className="cn2b-actions">
                <PhoenixButton type="button" variant="primary" size="sm" data-testid="cn4-region-confirm-send"
                  disabled={!canConfirm || busy} onClick={confirmPending}>
                  {t('cn4_region_confirm', lang)}
                </PhoenixButton>
                <PhoenixButton type="button" variant="ghost" size="sm" disabled={busy} onClick={() => setPending(null)}>
                  {t('cn2b_simple_cancel', lang)}
                </PhoenixButton>
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
