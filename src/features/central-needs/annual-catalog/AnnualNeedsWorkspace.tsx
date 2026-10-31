import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CentralNeedsError } from '../central-needs.service';
import { centralNeedsErrorText } from '../central-needs.i18n';
import { ManualNeedsWorkspace, type ManualNeedsApi } from '../manual/ManualNeedsWorkspace';
import { MaterialPicker } from '../manual/MaterialPicker';
import { MaterialRegistrationPanel, type RegistrationPrefill } from '../manual/MaterialRegistrationPanel';
import type { BeneficiaryOption, CatalogOption, YearRevision } from '../manual/manual-journey.service';
import * as manualServices from '../manual/manual-needs.service';
import { getManualCatalogLabels } from '../manual/manual-catalog.service';
import type { ManualCapabilities, ManualNeedEvent, ManualScope } from '../manual/manual-needs.service';
import type { MaterialRequest, MaterialUnit } from '../manual/material-registration.service';
import { mt, annualNeedsErrorText, manualUnitText, type ManualLang } from '../manual/manual-needs.i18n';
import { AnnualCatalogPicker, annualFieldText } from './AnnualCatalogPicker';
import { AnnualCatalogEditor, type AnnualEditorSubmission } from './AnnualCatalogEditor';
import { AnnualCatalogSources } from './AnnualCatalogSources';
import { AnnualOriginalFiles, type AnnualOriginalsUiApi } from './AnnualOriginalFiles';
import { ot } from './annual-originals.i18n';
import type { AnnualCatalogScope } from './annual-catalog.contract';
import { AnnualCatalogContractError, type AnnualCanonicalPreview, type AnnualCatalogItemResult, type AnnualCatalogWriteResult,
  type AnnualCatalogYearResult } from './annual-catalog-server.contract';
import { listAnnualCatalogYears, openAnnualCatalogYear, previewAnnualCanonical, listAnnualCatalogOccurrences } from './annual-catalog.service';
import type { AnnualCatalogChange, AnnualCatalogEditResult, AnnualEditableFields, AnnualNeedBinding } from './annual-needs.contract';
import * as annualServices from './annual-needs.service';

export const realAnnualNeedsUiApi = {
  listAnnualCatalogYears, openAnnualCatalogYear, previewAnnualCanonical, listAnnualCatalogOccurrences,
  searchAnnualCatalogForNeeds: annualServices.searchAnnualCatalogForNeeds,
  getAnnualCatalogItemForNeeds: annualServices.getAnnualCatalogItemForNeeds,
  addAnnualCatalogItemForNeeds: annualServices.addAnnualCatalogItemForNeeds,
  refreshAnnualCatalogItemForNeeds: annualServices.refreshAnnualCatalogItemForNeeds,
  completeAnnualMaterialRequestForNeeds: annualServices.completeAnnualMaterialRequestForNeeds,
  editAnnualCatalogItem: annualServices.editAnnualCatalogItem,
  listAnnualCatalogChanges: annualServices.listAnnualCatalogChanges,
  createAnnualRegistrationApi: annualServices.createAnnualRegistrationApi,
  listAnnualNeedEvents: annualServices.listAnnualNeedEvents,
  addAnnualNeedLine: annualServices.addAnnualNeedLine,
  correctAnnualNeedLine: annualServices.correctAnnualNeedLine,
  voidAnnualNeedLine: annualServices.voidAnnualNeedLine,
};
export type AnnualNeedsUiApi = typeof realAnnualNeedsUiApi;

interface Props {
  lang: ManualLang;
  scope: AnnualCatalogScope;
  actorId: string;
  revision: YearRevision | null;
  capabilities: ManualCapabilities;
  beneficiaries: BeneficiaryOption[];
  searchRegisteredMaterials: (query: string) => Promise<CatalogOption[]>;
  nationalCodeEnabled?: boolean;
  sameActorEnabled?: boolean;
  api?: AnnualNeedsUiApi;
  manualApi?: ManualNeedsApi;
  originalsApi?: AnnualOriginalsUiApi;
  onIdentityReady?: (ready: boolean) => void;
  onScopeLockChange?: (locked: boolean) => void;
}

type YearState = 'loading' | 'missing' | 'active' | 'archived' | 'failed';
type CatalogReceipt = AnnualCatalogWriteResult | AnnualCatalogEditResult | AnnualCatalogYearResult;
interface CatalogIntent { kind: string; execute: () => Promise<CatalogReceipt> }
const defaultManualApi: ManualNeedsApi = manualServices;

function outcomeUnknown(error: unknown): boolean {
  if (error instanceof AnnualCatalogContractError) return error.outcomeUnknown;
  return !(error instanceof CentralNeedsError) || (error.businessCode === 'central_needs_request_failed' && error.sqlstate === null);
}

/** A single owner/year journey; quantity parsing, event folding and writes remain in the existing manual workspace. */
export function AnnualNeedsWorkspace({ lang, scope, actorId, revision, capabilities, beneficiaries, searchRegisteredMaterials,
  nationalCodeEnabled = false, sameActorEnabled = false, api = realAnnualNeedsUiApi, manualApi = defaultManualApi,
  originalsApi, onIdentityReady, onScopeLockChange }: Props) {
  const [yearState, setYearState] = useState<YearState>('loading');
  const [beneficiary, setBeneficiary] = useState('');
  const [selected, setSelected] = useState<AnnualCatalogItemResult[]>([]);
  const [inspected, setInspected] = useState<AnnualCatalogItemResult | null>(null);
  const [editorReset, setEditorReset] = useState(0);
  const [changes, setChanges] = useState<AnnualCatalogChange[]>([]);
  const [historyCursor, setHistoryCursor] = useState<string | null>(null);
  const [historyBusy, setHistoryBusy] = useState(false);
  const [historyFailed, setHistoryFailed] = useState(false);
  const [canonicalPreview, setCanonicalPreview] = useState<AnnualCanonicalPreview | null>(null);
  const [adding, setAdding] = useState(false);
  const [registration, setRegistration] = useState(false);
  const [registrationPrefill, setRegistrationPrefill] = useState<RegistrationPrefill | null>(null);
  const [addition, setAddition] = useState<{ preview: AnnualCanonicalPreview; request: MaterialRequest | null } | null>(null);
  const [additionReason, setAdditionReason] = useState('');
  const [catalogBusy, setCatalogBusy] = useState(false);
  const [manualLocked, setManualLocked] = useState(false);
  const [registrationLocked, setRegistrationLocked] = useState(false);
  const [originalsOpen, setOriginalsOpen] = useState(false);
  const [originalsLocked, setOriginalsLocked] = useState(false);
  const [unknown, setUnknown] = useState(false);
  const [pendingReadId, setPendingReadId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [errorText, setErrorText] = useState<string | null>(null);
  const [pickerVersion, setPickerVersion] = useState(0);
  const intent = useRef<CatalogIntent | null>(null);
  const epoch = useRef(0);
  const historyRequest = useRef(0);
  const selectedRef = useRef(selected); selectedRef.current = selected;
  const beneficiaryRef = useRef(beneficiary); beneficiaryRef.current = beneficiary;
  const eventRef = useRef<ManualNeedEvent[]>([]);
  const inspectedRef = useRef(inspected); inspectedRef.current = inspected;
  const identity = `${scope.ownerOrgId}:${scope.planningYear}:${actorId}:${revision?.id ?? 'catalog'}`;
  const contextKey = `${identity}:${beneficiary}`;
  const otherOperationLocked = catalogBusy || manualLocked || registrationLocked || unknown || pendingReadId !== null;
  const scopeLocked = otherOperationLocked || originalsLocked;
  const canManage = capabilities.view && capabilities.edit && yearState === 'active';

  const errorLabel = (error: unknown) => error instanceof CentralNeedsError
    ? annualNeedsErrorText(error.businessCode, lang) ?? centralNeedsErrorText(error, lang)
    : error instanceof AnnualCatalogContractError && !error.outcomeUnknown ? mt('annualInvalidFields', lang) : mt('annualOperationFailed', lang);

  const loadYear = useCallback(async (mine: number) => {
    setYearState('loading');
    try {
      let after: number | null = null;
      for (let page = 0; page < 20; page += 1) {
        const result = await api.listAnnualCatalogYears(scope.ownerOrgId, 50, after);
        if (epoch.current !== mine) return;
        const year = result.years.find((row) => row.planningYear === scope.planningYear);
        if (year) { setYearState(year.status); return; }
        if (result.nextAfterYear === null) { setYearState('missing'); return; }
        after = result.nextAfterYear;
      }
      throw new Error('annual_year_page_limit');
    } catch { if (epoch.current === mine) setYearState('failed'); }
  }, [api, scope.ownerOrgId, scope.planningYear]);

  useEffect(() => {
    const mine = ++epoch.current;
    setBeneficiary(''); setSelected([]); setInspected(null); setChanges([]); setHistoryCursor(null); setHistoryFailed(false);
    setHistoryBusy(false); setCanonicalPreview(null); setAdding(false); setRegistration(false); setRegistrationPrefill(null);
    setAddition(null); setAdditionReason(''); setCatalogBusy(false); setManualLocked(false); setRegistrationLocked(false); setUnknown(false); setPendingReadId(null);
    setOriginalsOpen(false); setOriginalsLocked(false);
    setNotice(null); setErrorText(null); intent.current = null; eventRef.current = [];
    void loadYear(mine);
    return () => { epoch.current += 1; };
  }, [identity, loadYear]);

  useEffect(() => { onScopeLockChange?.(scopeLocked); return () => { onScopeLockChange?.(false); }; }, [scopeLocked, onScopeLockChange]);

  const chooseBeneficiary = (value: string) => {
    if (scopeLocked || yearState === 'loading' || beneficiary === value) return;
    epoch.current += 1;
    setBeneficiary(value); setSelected([]); setInspected(null); setChanges([]); setCanonicalPreview(null); setHistoryBusy(false);
    setAdding(false); setRegistration(false); setRegistrationPrefill(null); setAddition(null); setAdditionReason('');
    setErrorText(null); setNotice(mt('annualBeneficiaryChanged', lang));
  };

  const loadHistory = async (annualItemId: string, more = false) => {
    const mine = epoch.current;
    const request = ++historyRequest.current;
    const current = () => epoch.current === mine && historyRequest.current === request
      && inspectedRef.current?.membership.annualItemId === annualItemId;
    setHistoryBusy(true); setHistoryFailed(false);
    try {
      const page = await api.listAnnualCatalogChanges(scope, annualItemId, 25, more ? historyCursor : null);
      if (!current()) return;
      setChanges((old) => {
        const byId = new Map((more ? old : []).map((change) => [change.changeId, change]));
        page.changes.forEach((change) => byId.set(change.changeId, change));
        return [...byId.values()];
      });
      setHistoryCursor(page.nextAfterChangeId);
    } catch { if (current()) setHistoryFailed(true); }
    finally { if (current()) setHistoryBusy(false); }
  };

  const inspect = async (item: AnnualCatalogItemResult) => {
    if (scopeLocked) return;
    const mine = epoch.current;
    setCatalogBusy(true); setErrorText(null); setChanges([]); setHistoryCursor(null); setCanonicalPreview(null);
    try {
      const fresh = await api.getAnnualCatalogItemForNeeds(scope, item.membership.annualItemId);
      if (epoch.current !== mine) return;
      inspectedRef.current = fresh; setInspected(fresh); setEditorReset((value) => value + 1);
      void loadHistory(fresh.membership.annualItemId);
    } catch (error) { if (epoch.current === mine) setErrorText(errorLabel(error)); }
    finally { if (epoch.current === mine) setCatalogBusy(false); }
  };

  const acceptFresh = (fresh: AnnualCatalogItemResult) => {
    inspectedRef.current = fresh; setInspected(fresh); setEditorReset((value) => value + 1);
    // Editing or refreshing a catalog item never silently upgrades a previously selected need reference.
    setSelected((items) => items.filter((item) => item.membership.annualItemId !== fresh.membership.annualItemId));
    setPendingReadId(null); setCanonicalPreview(null); setPickerVersion((value) => value + 1);
    void loadHistory(fresh.membership.annualItemId);
  };

  const runCatalog = async (kind: string, execute: () => Promise<CatalogReceipt>): Promise<AnnualCatalogItemResult | null> => {
    if (catalogBusy || manualLocked || registrationLocked || originalsLocked || pendingReadId) return null;
    if (intent.current && intent.current.kind !== kind) { setErrorText(mt('annualPendingOperation', lang)); return null; }
    const operation = intent.current ?? { kind, execute };
    intent.current = operation;
    const mine = epoch.current;
    setCatalogBusy(true); setErrorText(null); setNotice(null);
    try {
      const receipt = await operation.execute();
      if (epoch.current !== mine) return null;
      intent.current = null; setUnknown(false);
      if ('year' in receipt) {
        setYearState(receipt.year.status); setNotice(mt('annualYearOpened', lang)); return null;
      }
      setAddition(null); setAdditionReason(''); setAdding(false); setRegistration(false);
      // A valid replay is a historical receipt; always read current eligibility separately.
      try {
        const fresh = await api.getAnnualCatalogItemForNeeds(scope, receipt.membership.annualItemId);
        if (epoch.current !== mine) return null;
        acceptFresh(fresh); setNotice(mt('annualCatalogSaved', lang));
        return fresh;
      } catch {
        if (epoch.current === mine) {
          // Pending catalog reconciliation locks parent actions. It does not invalidate identities already read for saved need events.
          setPendingReadId(receipt.membership.annualItemId); setNotice(mt('annualSavedReadFailed', lang));
        }
        return null;
      }
    } catch (error) {
      if (epoch.current !== mine) return null;
      setErrorText(errorLabel(error));
      const uncertain = outcomeUnknown(error); setUnknown(uncertain);
      if (!uncertain) intent.current = null;
      return null;
    } finally { if (epoch.current === mine) setCatalogBusy(false); }
  };

  const retryCurrentRead = async () => {
    if (!pendingReadId || catalogBusy) return;
    const mine = epoch.current;
    setCatalogBusy(true); setErrorText(null);
    try {
      const fresh = await api.getAnnualCatalogItemForNeeds(scope, pendingReadId);
      if (epoch.current === mine) { acceptFresh(fresh); setNotice(mt('annualCatalogSaved', lang)); }
    } catch (error) { if (epoch.current === mine) setErrorText(errorLabel(error)); }
    finally { if (epoch.current === mine) setCatalogBusy(false); }
  };

  const previewExisting = async (canonicalItemId: string, request: MaterialRequest | null = null) => {
    if (scopeLocked) return;
    const mine = epoch.current;
    setCatalogBusy(true); setErrorText(null);
    try {
      const preview = await api.previewAnnualCanonical(scope, canonicalItemId);
      if (epoch.current === mine) { setAddition({ preview, request }); setAdditionReason(''); }
    } catch (error) { if (epoch.current === mine) setErrorText(errorLabel(error)); }
    finally { if (epoch.current === mine) setCatalogBusy(false); }
  };

  const addToYear = () => {
    if (!addition || !additionReason.trim() || !canManage) return;
    const key = manualApi.newManualIdempotencyKey();
    const { preview, request } = addition;
    if (request) {
      const input = { scope, requestId: request.id, expectedRequestVersion: request.version,
        expectedCanonicalFingerprint: preview.canonicalFingerprint, reason: additionReason, idempotencyKey: key };
      void runCatalog('complete', () => api.completeAnnualMaterialRequestForNeeds(input));
    } else {
      const input = { scope, canonicalItemId: preview.canonicalItemId, expectedCanonicalFingerprint: preview.canonicalFingerprint,
        occurrences: [], reason: additionReason, idempotencyKey: key };
      void runCatalog('add', () => api.addAnnualCatalogItemForNeeds(input));
    }
  };

  const saveEdit = (input: AnnualEditorSubmission) => {
    if (!inspected || !canManage) return Promise.resolve(null);
    const command = { ...input, scope, annualItemId: inspected.membership.annualItemId, idempotencyKey: manualApi.newManualIdempotencyKey() };
    return runCatalog('edit', () => api.editAnnualCatalogItem(command));
  };
  const refreshCanonical = (input: Omit<AnnualEditorSubmission, 'fields'>) => {
    if (!inspected || !canManage) return Promise.resolve(null);
    const command = { ...input, scope, annualItemId: inspected.membership.annualItemId, occurrences: [], idempotencyKey: manualApi.newManualIdempotencyKey() };
    return runCatalog('refresh', () => api.refreshAnnualCatalogItemForNeeds(command));
  };
  const previewCurrentCanonical = async () => {
    if (!inspected?.membership.canonicalItemId || scopeLocked) return;
    const mine = epoch.current; const annualId = inspected.membership.annualItemId;
    setCatalogBusy(true); setErrorText(null);
    try {
      const preview = await api.previewAnnualCanonical(scope, inspected.membership.canonicalItemId);
      if (epoch.current === mine && inspectedRef.current?.membership.annualItemId === annualId) setCanonicalPreview(preview);
    } catch (error) { if (epoch.current === mine) setErrorText(errorLabel(error)); }
    finally { if (epoch.current === mine) setCatalogBusy(false); }
  };

  const reloadInspected = async () => {
    if (!inspected || scopeLocked) return;
    const mine = epoch.current; const id = inspected.membership.annualItemId;
    setCatalogBusy(true); setErrorText(null);
    try {
      const fresh = await api.getAnnualCatalogItemForNeeds(scope, id);
      if (epoch.current !== mine || inspectedRef.current?.membership.annualItemId !== id) return;
      // Deliberately do not remount the editor: its typed proposal must survive a stale-write recovery.
      inspectedRef.current = fresh; setInspected(fresh); setCanonicalPreview(null); setNotice(mt('annualServerVersionLoaded', lang));
      void loadHistory(id);
    } catch (error) { if (epoch.current === mine) setErrorText(errorLabel(error)); }
    finally { if (epoch.current === mine) setCatalogBusy(false); }
  };

  const requestReview = (fields: AnnualEditableFields) => {
    setRegistrationPrefill({ pointer: null, descriptor: { scientificName: fields.scientificName ?? '', nameAr: fields.nameAr,
      nationalCode: fields.nationalCode, barcode: fields.barcode, dosageForm: fields.dosageForm, strength: fields.concentration,
      ...(fields.unit ? { unit: fields.unit as MaterialUnit } : {}) } });
    setAdding(true); setRegistration(true);
  };

  const registrationApi = useMemo(() => api.createAnnualRegistrationApi(scope), [api, scope.ownerOrgId, scope.planningYear, actorId]);
  const pickerApi = useMemo(() => ({ searchAnnualCatalog: api.searchAnnualCatalogForNeeds, getAnnualCatalogItem: api.getAnnualCatalogItemForNeeds }), [api]);

  // Keep this adapter stable while selections change: a new callback object would reload the existing editor and erase unsent input.
  const boundManualApi = useMemo<ManualNeedsApi>(() => {
    const bindingFor = (manualScope: ManualScope, expectedEventId: string | null, kind: 'add' | 'correct' | 'void'): Pick<AnnualNeedBinding, 'annualItemId' | 'fieldVersionId'> => {
      if (manualScope.beneficiaryOrganizationId !== beneficiaryRef.current) throw new AnnualCatalogContractError('input', 'annualNeeds.beneficiary');
      const chosen = selectedRef.current.find((item) => item.membership.canonicalItemId === manualScope.centralItemId && item.selectable);
      if (kind !== 'void' && chosen) return { annualItemId: chosen.membership.annualItemId, fieldVersionId: chosen.fieldVersion.fieldVersionId };
      const saved = expectedEventId ? eventRef.current.find((event) => event.id === expectedEventId)?.annualBinding : null;
      if (kind !== 'add' && saved) return saved;
      throw new AnnualCatalogContractError('input', 'annualNeeds.binding.required');
    };
    return {
      getManualCapabilities: manualApi.getManualCapabilities,
      getManualCatalogLabels: manualApi.getManualCatalogLabels ?? getManualCatalogLabels,
      newManualIdempotencyKey: manualApi.newManualIdempotencyKey,
      async listManualNeedEvents(revisionId) {
        const mine = epoch.current;
        const events = await api.listAnnualNeedEvents(scope, revisionId);
        if (epoch.current === mine) eventRef.current = events;
        return events;
      },
      addManualNeedLine(manualScope, quantityText, reason, idempotencyKey, expectedLastEventId = null, reference = null) {
        return api.addAnnualNeedLine({ scope, manualScope, ...bindingFor(manualScope, expectedLastEventId, 'add'), quantityText, reason, idempotencyKey, expectedLastEventId, reference });
      },
      correctManualNeedLine(manualScope, quantityText, reason, idempotencyKey, expectedLastEventId, reference = null) {
        return api.correctAnnualNeedLine({ scope, manualScope, ...bindingFor(manualScope, expectedLastEventId, 'correct'), quantityText, reason, idempotencyKey, expectedLastEventId, reference });
      },
      voidManualNeedLine(manualScope, reason, idempotencyKey, expectedLastEventId, reference = null) {
        // Only an explicitly unbound historical event uses its existing lawful void path; never invent a binding.
        const events = eventRef.current.filter((event) => event.planRevisionId === manualScope.planRevisionId
          && event.beneficiaryOrganizationId === manualScope.beneficiaryOrganizationId && event.centralItemId === manualScope.centralItemId
          && event.targetWarehouseId === manualScope.targetWarehouseId);
        const latest = events.reduce<ManualNeedEvent | null>((last, event) => !last || event.eventSeq > last.eventSeq ? event : last, null);
        if (manualScope.beneficiaryOrganizationId === beneficiaryRef.current && latest?.id === expectedLastEventId
          && latest.eventKind !== 'void' && latest.annualBinding === null) {
          return manualApi.voidManualNeedLine(manualScope, reason, idempotencyKey, expectedLastEventId, reference);
        }
        return api.voidAnnualNeedLine({ scope, manualScope, ...bindingFor(manualScope, expectedLastEventId, 'void'), reason, idempotencyKey, expectedLastEventId, reference });
      },
    };
  }, [api, manualApi, scope.ownerOrgId, scope.planningYear, actorId]);

  const itemOptions = selected.filter((item) => item.membership.canonicalItemId !== null).map((item) => ({
    id: item.membership.canonicalItemId ?? '', name: (lang === 'ar' ? annualFieldText(item, 'nameAr') : null) ?? annualFieldText(item, 'scientificName') ?? mt('annualUnnamed', lang),
    nameAr: annualFieldText(item, 'nameAr'), unit: annualFieldText(item, 'unit') ?? '', nationalCode: annualFieldText(item, 'nationalCode'),
    concentration: annualFieldText(item, 'concentration'), dosageForm: annualFieldText(item, 'dosageForm'), annualItem: item,
  }));
  const beneficiaryOptions = beneficiaries.map((item) => ({ id: item.id, name: lang === 'ar' && item.nameAr ? item.nameAr : item.name }));
  const manualLockChanged = useCallback((locked: boolean) => setManualLocked(locked), []);
  const registrationLockChanged = useCallback((locked: boolean) => setRegistrationLocked(locked), []);
  const originalsLockChanged = useCallback((locked: boolean) => setOriginalsLocked(locked), []);

  return <section className="prism-annual-needs" aria-label={mt('annualJourneyTitle', lang)} lang={lang} dir={lang === 'ar' ? 'rtl' : 'ltr'}>
    <p className="prism-search-hint">{mt('annualScopePolicy', lang)}</p>
    {notice && <p role="status" className={`prism-notice ${pendingReadId ? 'prism-notice--warning' : 'prism-notice--success'}`}>{notice}</p>}
    {errorText && <p role="alert" className="prism-notice prism-notice--error">{errorText}</p>}
    {unknown && <div className="prism-notice prism-notice--warning"><p>{mt('annualPendingOperation', lang)}</p>
      <button type="button" disabled={catalogBusy} onClick={() => { if (intent.current) void runCatalog(intent.current.kind, intent.current.execute); }}>{mt('annualReconcileOperation', lang)}</button>
    </div>}
    {pendingReadId && <button type="button" disabled={catalogBusy} onClick={() => void retryCurrentRead()}>{mt('annualReloadCurrent', lang)}</button>}
    {yearState === 'loading' && <p role="status">{mt('loading', lang)}</p>}
    {yearState === 'failed' && <div className="prism-notice prism-notice--error"><p role="alert">{mt('annualYearLoadFailed', lang)}</p><button type="button" onClick={() => void loadYear(epoch.current)}>{mt('annualRetryYear', lang)}</button></div>}
    {yearState === 'missing' && <div className="prism-search-state"><p>{mt('annualYearMissing', lang)}</p>
      {capabilities.edit && <button type="button" disabled={scopeLocked} onClick={() => {
        const key = manualApi.newManualIdempotencyKey(); void runCatalog('open-year', () => api.openAnnualCatalogYear(scope, key));
      }}>{mt('annualCreateYear', lang)}</button>}
    </div>}
    {yearState === 'archived' && <p role="note" className="prism-notice">{mt('annualYearArchived', lang)}</p>}
    {(yearState === 'active' || yearState === 'archived') && <div className="prism-originals-disclosure">
      <button type="button" aria-expanded={originalsOpen} disabled={scopeLocked} onClick={() => setOriginalsOpen((open) => !open)}>{ot(originalsOpen ? 'close' : 'open', lang)}</button>
      {originalsOpen && <AnnualOriginalFiles lang={lang} scope={scope} actorId={actorId} canWrite={canManage} disabled={otherOperationLocked}
        api={originalsApi} onScopeLockChange={originalsLockChanged} />}
    </div>}
    <>
      <label className="prism-annual-beneficiary">{mt('beneficiary', lang)}<select value={beneficiary} disabled={scopeLocked || yearState === 'loading'} onChange={(event) => chooseBeneficiary(event.target.value)}>
        <option value="">{mt('choose', lang)}</option>{beneficiaryOptions.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
      </select></label>
      <div className="prism-entry-grid">
        {(yearState === 'active' || yearState === 'archived') && <div className="prism-entry-grid__catalog">
          <AnnualCatalogPicker key={pickerVersion} lang={lang} scope={scope} contextKey={contextKey} selected={selected} api={pickerApi} disabled={scopeLocked}
            onPick={(item) => { if (beneficiary) setSelected((old) => old.some((row) => row.membership.annualItemId === item.membership.annualItemId) ? old : [...old, item]); else setErrorText(mt('annualChooseBeneficiary', lang)); }}
            onRemove={(id) => setSelected((old) => old.filter((item) => item.membership.annualItemId !== id))}
            onRequestAddition={canManage ? () => { setAdding(true); setRegistration(false); setRegistrationPrefill(null); } : undefined}
            onInspect={(item) => void inspect(item)} />
        </div>}
        {revision?.sourceMode === 'manual' ? <fieldset className="prism-annual-quantity" disabled={catalogBusy || registrationLocked || originalsLocked || unknown || pendingReadId !== null}>
          <ManualNeedsWorkspace key={`${identity}:${beneficiary}`} lang={lang} organizationId={scope.ownerOrgId} planRevisionId={revision.id}
            revisionStatus={revision.status} sourceMode={revision.sourceMode} beneficiaries={beneficiaryOptions} items={itemOptions}
            api={boundManualApi} annualMode annualEntryEnabled={yearState === 'active'} beneficiaryId={beneficiary} onIdentityReady={onIdentityReady} onScopeLockChange={manualLockChanged} />
        </fieldset> : <p className="prism-notice">{mt('annualOpenDraftForQuantity', lang)}</p>}
      </div>
      {adding && canManage && <section className="prism-annual-addition" aria-label={mt('annualAddMissing', lang)}>
        <div className="prism-annual-editor__header"><h4>{mt('annualAddMissing', lang)}</h4><button type="button" disabled={scopeLocked} onClick={() => { setAdding(false); setRegistration(false); setAddition(null); }}>{mt('cancel', lang)}</button></div>
        <p className="prism-search-hint">{mt('annualRegisteredSearchHint', lang)}</p>
        <fieldset disabled={scopeLocked}>
          <MaterialPicker lang={lang} scopeKey={`${contextKey}:registered-addition`} search={searchRegisteredMaterials} selected={[]}
            onPick={(item) => void previewExisting(item.id)} onRemove={() => undefined} onRequestRegistration={() => setRegistration(true)} />
          <button type="button" onClick={() => { setRegistration(true); setRegistrationPrefill(null); }}>{mt('annualNewRegistration', lang)}</button>
        </fieldset>
        {registration && <fieldset disabled={catalogBusy || manualLocked || originalsLocked || unknown || pendingReadId !== null}>
          <MaterialRegistrationPanel key={`${contextKey}:registration`} lang={lang} organizationId={scope.ownerOrgId} actorId={actorId} planRevisionId={null}
            scopeKey={contextKey} onScopeLockChange={registrationLockChanged}
            prefill={registrationPrefill} api={registrationApi} nationalCodeEnabled={nationalCodeEnabled} sameActorEnabled={sameActorEnabled}
            onUseItem={(item) => void previewExisting(item.id)} onUseResolvedRequest={(request) => { if (request.resolvedItemId) void previewExisting(request.resolvedItemId, request); }}
            resolvedActionLabel={mt('annualUseResolvedRequest', lang)} />
        </fieldset>}
        {addition && <div className="prism-annual-canonical">
          <h4>{mt('annualConfirmMembership', lang)}</h4>
          <p><bdi>{addition.preview.canonicalSnapshot.scientificName}</bdi> · <bdi dir="ltr">{addition.preview.canonicalSnapshot.nationalCode ?? '—'}</bdi> · <bdi>{manualUnitText(addition.preview.canonicalSnapshot.unit, lang)}</bdi></p>
          {!addition.preview.eligible && <p className="prism-notice prism-notice--warning">{mt('annualAdditionPreparing', lang)}</p>}
          <label>{mt('annualMembershipReason', lang)}<textarea value={additionReason} maxLength={2000} disabled={scopeLocked} onChange={(event) => setAdditionReason(event.target.value)} /></label>
          <button type="button" disabled={catalogBusy || manualLocked || registrationLocked || originalsLocked || pendingReadId !== null || !additionReason.trim()} onClick={addToYear}>{mt('annualConfirmMembership', lang)}</button>
        </div>}
      </section>}
      {inspected && <AnnualCatalogEditor key={`${inspected.membership.annualItemId}:${editorReset}`} lang={lang} contextKey={contextKey} item={inspected}
        changes={changes} canEdit={canManage} busy={catalogBusy || manualLocked || registrationLocked || originalsLocked || pendingReadId !== null} outcomeUnknown={unknown}
        sourcePanel={<AnnualCatalogSources lang={lang} contextKey={contextKey} scope={scope} annualItemId={inspected.membership.annualItemId} reader={api.listAnnualCatalogOccurrences} />}
        historyBusy={historyBusy} historyFailed={historyFailed} hasMoreHistory={historyCursor !== null} canonicalPreview={canonicalPreview}
        onSave={saveEdit} onRefreshCanonical={refreshCanonical} onPreviewCanonical={() => void previewCurrentCanonical()}
        onReloadCurrent={() => void reloadInspected()}
        onLoadHistory={(more) => void loadHistory(inspected.membership.annualItemId, more)} onRequestRegistration={canManage ? requestReview : undefined}
        onClose={() => { setInspected(null); inspectedRef.current = null; setChanges([]); setCanonicalPreview(null); }} />}
    </>
  </section>;
}
