/**
 * SUBPURCHASE-DIRECT-ENTRY (089) — the simple supplementary-purchase entry.
 *
 * One human-confirmed act records a material the institution ALREADY bought
 * into its own warehouse: material (registered-only, via the unified
 * resolver — or fresh identity typed HERE, the ONE screen besides the
 * Inventory Center allowed to register), batch, expiry, quantity, price,
 * purchase date, invoice/reference, optional supplier, notes. No order/
 * supplier/approval workflow is shown; provenance is pinned SERVER-side to
 * purchase/supplementary — no supply-type field exists here.
 *
 * Safety (CI-4A/4B/4C): the request id and the exact arguments of an attempt
 * are captured before dispatch. An attempt whose outcome is not proven is
 * locked: it can be checked read-only (a confirm-only reconciliation read) or
 * retried with its own request and arguments, never edited or re-keyed. Only
 * specific evidence releases it as rejected; 23505 is kept for reconciliation.
 * A confirmed success stays visible until the operator acknowledges it, and
 * blocks new submissions until then. Mandatory human confirmation, official
 * server numbers in the result, and the readiness gate (RPC absent) remain.
 *
 * CI-4D-A: every send — a new purchase or a retry — is preceded by a fail-closed
 * live identity check (see ownerStillSignedIn). A refused send never reaches
 * the server and never substitutes the current user or mints a new request id.
 */
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { t } from '@/shared/i18n/strings';
import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { isDeadlineExceeded, withDeadline } from '@/shared/lib/deadline';
import { PhoenixCard } from '@/shared/ui/PhoenixCard';
import { PhoenixInput } from '@/shared/ui/PhoenixInput';
import { PhoenixButton } from '@/shared/ui/PhoenixButton';
import { PhoenixMaterialResolver } from '@/shared/materials/PhoenixMaterialResolver';
import type { ResolvedMaterial } from '@/shared/materials/material-resolver.service';
import { useApp } from '@/app/AppContext';
import { newRequestId, getDuplicateCandidates, reconcileDirectEntry, type DuplicateCandidate } from './procurement.service';

interface Props {
  lang: 'ar' | 'en';
  warehouseId: string;
  /** Identity + organization that owns this workspace's attempts and settled results (see the attempt store below). */
  scopeKey: string;
  onDone: (messageKey: string) => void;
}

/**
 * CI-4A — the purchase attempt lifecycle, held OUTSIDE the component for this page load only.
 *
 * A remount (same-screen re-activation, Back/Forward, a profile reload, a navigation away and back) discards every
 * useState value, so the attempt lives here, keyed by identity + organization + warehouse. A record is immutable once
 * created: its request id and its exact RPC arguments are captured before the first dispatch.
 *
 * Outcome classes:
 *   recorded  — a success body with ok === true and both identifiers. Terminal. Kept as a settled outcome until the
 *               operator closes it, so a result that settles while the panel is away is still shown on return.
 *   rejected  — SPECIFIC evidence that the request was never committed (see classifyRefusal): a pure input check
 *               that 116 raises before its replay lookup, on any dispatch; or, on the attempt's first client dispatch,
 *               the RPC-absent codes. State-dependent refusals are never evidence (CI-4C). Terminal: released.
 *   conflict  — 23505 (request_id_conflict). The request id is already held by a recorded purchase with a different
 *               fingerprint, which does not prove that any earlier purchase failed. The attempt is kept, locked, for
 *               reconciliation. It is never released, re-keyed or re-submitted automatically.
 *   ambiguous — anything else: a transport failure, a timeout, an error without a code, an unlisted SQLSTATE, a
 *               refusal on a retry that could follow an earlier dispatch still able to commit, a malformed success body.
 *               The attempt stays, locked. It can be retried only with its own request id and arguments.
 *
 * The server records at most one purchase per request id: the same id with the same payload replays the original
 * result (116). A retry of an ambiguous attempt with its own id and arguments therefore cannot record a second purchase.
 *
 * Not claimed: protection across a full page reload. That needs a server read contract that looks up a request id.
 */
type RecordArgs = Readonly<Record<string, unknown>>;

/**
 * CI-4D-B — the material as this panel keeps it: exactly the fields the form renders and the request arguments use
 * (p_central_item_id, p_scientific_name, p_trade_name, p_concentration, p_dosage_form, p_unit). A resolver result also
 * carries live stock figures (on-hand / reserved / available, canonical eligibility) and a stock lot's identifiers
 * (warehouse stock id, batch, expiry, barcode); none of those are needed here, so none are kept — not in component
 * state and not in a retained attempt.
 */
type MaterialIdentity = Readonly<Pick<ResolvedMaterial,
  'centralItemId' | 'scientificName' | 'tradeName' | 'concentration' | 'dosageForm' | 'unit'>>;

function toMaterialIdentity(m: ResolvedMaterial): MaterialIdentity {
  return Object.freeze({
    centralItemId: m.centralItemId,
    scientificName: m.scientificName,
    tradeName: m.tradeName,
    concentration: m.concentration,
    dosageForm: m.dosageForm,
    unit: m.unit,
  });
}

/** The form as it was when the attempt was captured, restored when the panel returns to an unresolved attempt. */
interface FormSnapshot {
  material: MaterialIdentity | null;
  newIdentity: boolean;
  scientificName: string;
  tradeName: string;
  concentration: string;
  dosageForm: string;
  unit: string;
  nationalCode: string;
  batch: string;
  noBatch: boolean;
  expiry: string;
  qty: string;
  price: string;
  purchaseDate: string;
  invoice: string;
  supplier: string;
  notes: string;
  confirmed: boolean;
}

interface UnresolvedAttempt {
  readonly scope: string;
  readonly requestId: string;
  readonly args: RecordArgs;
  readonly form: Readonly<FormSnapshot>;
  /** CI-4D-A: 'unsent' — created, its identity check not yet passed; nothing has reached the server. */
  state: 'unsent' | 'in_flight' | 'ambiguous' | 'conflict';
  /**
   * Increments on every SEND (an RPC actually issued), so a stale answer from an earlier send can never change the
   * current state. A send refused by the identity check does not count: it never left the tab.
   */
  dispatchId: number;
  timer: ReturnType<typeof setTimeout> | null;
  /** CI-4C: who created the attempt and for which organization; a status check reads only for this owner. */
  readonly actorId: string | null;
  readonly organizationId: string | null;
  /** CI-4C: a read-only status check is running; neither a retry nor a second check may start meanwhile. */
  checking: boolean;
  /** Increments on every status check, so a stale check result can never change the attempt. */
  checkId: number;
  /** The last status check could not confirm a recorded receipt (it proves nothing either way). */
  checkUnconfirmed: boolean;
  /** CI-4D-A: the live identity is being verified before a send; no other send or status check may start meanwhile. */
  verifying: boolean;
  /** Increments on every identity verification, so a stale verification result can never send or change anything. */
  verifyId: number;
  /** The last send was refused because the live identity could not be verified as this attempt's owner. Not sent. */
  identityRefused: boolean;
}

interface SettledOutcome {
  readonly scope: string;
  readonly requestId: string;
  readonly replay: boolean;
  readonly orderNumber: string | null;
  readonly receiptNumber: string | null;
  /** CI-4C: confirmed by a read-only status check rather than by the write's own answer. */
  readonly reconciled: boolean;
  acknowledged: boolean;
}

interface Notice {
  /** CI-4C: the attempt this notice belongs to. A late answer for another attempt never clears it. */
  readonly requestId: string;
  /** CI-4D-A: 'identity' — a never-sent attempt was released because its owner could not be verified. */
  readonly kind: 'rejected' | 'ambiguous' | 'conflict' | 'identity';
  readonly readiness: boolean;
  readonly message: string;
  /** CI-4D-A: for an 'identity' release, the never-sent attempt's form, restored if the panel was away meanwhile. */
  readonly form?: Readonly<FormSnapshot>;
}

/** A request with no answer by this deadline is ambiguous. It is never reported as rejected. */
const DIRECT_ENTRY_DEADLINE_MS = 20_000;
/** CI-4D-A: a live session read slower than this refuses the send (fail closed); it is never treated as a pass. */
const IDENTITY_CHECK_DEADLINE_MS = 10_000;

/** CI-4D-A: the identity a mounted panel currently shows (AppContext profile and active organization). */
interface LiveIdentity {
  readonly profileId: string | null;
  readonly organizationId: string | null;
}
/**
 * Registered by each mounted panel for its own attempt scope and removed when it unmounts or its identity changes
 * (one entry per mounted panel, so one panel leaving never withdraws another's). A send reads it before AND after the
 * asynchronous session read; no entry (no panel showing this owner's scope) refuses the send.
 */
const liveIdentities = new Map<string, Set<LiveIdentity>>();

const unresolved = new Map<string, UnresolvedAttempt>();
/** Keyed by scope AND request id: a request id is only unique within one operator's workspace. */
const outcomes = new Map<string, SettledOutcome>();
const outcomeKey = (scope: string, requestId: string) => `${scope}#${requestId}`;
const notices = new Map<string, Notice>();
let storeVersion = 0;
const storeListeners = new Set<() => void>();

function storeChanged(): void {
  storeVersion += 1;
  for (const listener of storeListeners) listener();
}
function subscribeToStore(listener: () => void): () => void {
  storeListeners.add(listener);
  return () => { storeListeners.delete(listener); };
}
function currentStoreVersion(): number {
  return storeVersion;
}

type RecordResponse = { data: unknown; error: { code?: string; message?: string } | null };

const RPC_ABSENT_CODES = new Set(['42883', 'PGRST202']);

/**
 * 116:92-106 — pure input checks raised BEFORE the replay lookup. They depend only on the frozen arguments, so this
 * request can never have been committed with them: proof of non-commit on ANY dispatch. 23514 is also used for a
 * state-dependent check (116:137), so the message must match exactly; the code alone is not evidence.
 */
const PRE_REPLAY_INPUT_REFUSALS = new Set([
  'request_id_required',
  'scientific_name_required',
  'quantity_must_be_positive',
  'batch_number_flag_mismatch',
  'unit_price_must_be_non_negative',
]);

/**
 * Classifies a refusal. Only specific evidence releases an attempt; 23505 is a conflict; everything else is unknown.
 *
 * CI-4C: refusals that depend on server state — session (116:89), warehouse (116:132-138) and scoped authority
 * (116:142-151) — are NEVER evidence, not even on the attempt's first client dispatch: one client dispatch does not
 * prove one server execution (a gateway or proxy may have retried it), and an earlier execution of the same request
 * may have committed. They stay ambiguous. Two kinds of evidence remain:
 *   - the pure input checks above, which no execution of these frozen arguments can pass, on any dispatch;
 *   - the RPC-absent codes on the first dispatch: the function did not exist for this request. This rests on one
 *     stated runtime assumption, that the function is not removed between two deliveries of the same request.
 */
function classifyRefusal(error: { code?: string; message?: string }, soleDispatch: boolean): 'rejected' | 'conflict' | 'ambiguous' {
  const code = error.code ?? '';
  const message = error.message ?? '';
  if (code === '23505') return 'conflict';
  if (code === '23514' && PRE_REPLAY_INPUT_REFUSALS.has(message)) return 'rejected';
  if (soleDispatch && RPC_ABSENT_CODES.has(code)) return 'rejected';
  return 'ambiguous';
}

interface RecordedBody {
  ok: true;
  idempotent_replay?: boolean;
  order_number: string;
  receipt_number: string;
}
function isRecordedBody(data: unknown): data is RecordedBody {
  if (typeof data !== 'object' || data === null) return false;
  const body = data as Record<string, unknown>;
  return body.ok === true && typeof body.order_number === 'string' && typeof body.receipt_number === 'string';
}

function settleAttempt(attempt: UnresolvedAttempt, dispatchId: number, response: RecordResponse): void {
  const isCurrent = unresolved.get(attempt.scope) === attempt && attempt.dispatchId === dispatchId;
  // A confirmed recorded answer is kept whichever dispatch it came from. It is idempotent per request id.
  if (response.error === null && isRecordedBody(response.data)) {
    const key = outcomeKey(attempt.scope, attempt.requestId);
    if (!outcomes.has(key)) {
      outcomes.set(key, {
        scope: attempt.scope,
        requestId: attempt.requestId,
        replay: response.data.idempotent_replay === true,
        orderNumber: response.data.order_number,
        receiptNumber: response.data.receipt_number,
        reconciled: false,
        acknowledged: false,
      });
    }
    if (unresolved.get(attempt.scope) === attempt) {
      if (attempt.timer !== null) clearTimeout(attempt.timer);
      unresolved.delete(attempt.scope);
    }
    // Only this attempt's own notice is cleared: the scope may meanwhile hold a newer attempt with a notice of its own.
    if (notices.get(attempt.scope)?.requestId === attempt.requestId) notices.delete(attempt.scope);
    storeChanged();
    return;
  }
  if (!isCurrent) return;
  if (attempt.timer !== null) {
    clearTimeout(attempt.timer);
    attempt.timer = null;
  }
  const refusal = response.error === null ? 'ambiguous' : classifyRefusal(response.error, dispatchId === 1);
  if (refusal === 'rejected') {
    unresolved.delete(attempt.scope);
    notices.set(attempt.scope, {
      requestId: attempt.requestId,
      kind: 'rejected',
      readiness: RPC_ABSENT_CODES.has(response.error?.code ?? ''),
      message: response.error?.message ?? '',
    });
  } else {
    // conflict or ambiguous: the attempt keeps its request id and arguments, locked. Only an ambiguous one may be retried.
    attempt.state = refusal;
    notices.set(attempt.scope, {
      requestId: attempt.requestId, kind: refusal, readiness: false, message: response.error?.message ?? '',
    });
  }
  storeChanged();
}

/**
 * CI-4D-A — fail-closed owner check immediately before a write. The attempt's frozen owner (actorId, organizationId)
 * must equal BOTH the identity this tab's panel shows (AppContext profile and active organization, read before and
 * after the asynchronous session read) AND the user of the live auth session (supabase.auth.getSession reads the
 * session the browser's tabs share, so a sign-in in another tab is seen here before this tab re-renders). A missing
 * owner, a missing panel, no session, an error, a throw, a deadline or any difference refuses the send. The current
 * user is never substituted into the attempt.
 *
 * Not claimed: this narrows but cannot remove the check-then-send race. Between this check and the request reaching
 * the server the shared session can still change, and the server records whoever's token arrives. Only server-side
 * actor binding closes that.
 */
async function ownerStillSignedIn(attempt: UnresolvedAttempt): Promise<boolean> {
  // The scope must itself encode this owner (LocalProcurementScreen builds it as profile|organization, the panel adds
  // the warehouse), so an attempt can never pass the check for an owner other than the one its scope belongs to.
  const ownScope = attempt.actorId !== null && attempt.organizationId !== null
    && attempt.scope === `${attempt.actorId}|${attempt.organizationId}|${String(attempt.args.p_warehouse_id ?? '')}`;
  const panelShowsOwner = (): boolean => {
    const live = liveIdentities.get(attempt.scope);
    return ownScope && live !== undefined && live.size > 0
      && [...live].every(identity => identity.profileId === attempt.actorId && identity.organizationId === attempt.organizationId);
  };
  if (!panelShowsOwner()) return false;
  const read = await withDeadline(supabase.auth.getSession(), IDENTITY_CHECK_DEADLINE_MS);
  if (isDeadlineExceeded(read) || read.error) return false;
  if ((read.data.session?.user?.id ?? null) !== attempt.actorId) return false;
  return panelShowsOwner();
}

/**
 * Starts one send of an attempt: the identity check first, then the RPC. Its own synchronous guard (independent of
 * any button state) allows one verification or send at a time, never during a status check, and only for an attempt
 * that may be sent: a new one ('unsent') or an ambiguous one. In flight is never sent twice; a 23505 conflict is never
 * re-sent.
 */
function dispatchAttempt(attempt: UnresolvedAttempt): void {
  if (unresolved.get(attempt.scope) !== attempt || attempt.verifying || attempt.checking) return;
  if (attempt.state !== 'unsent' && attempt.state !== 'ambiguous') return;
  attempt.verifying = true;
  attempt.identityRefused = false;
  attempt.verifyId += 1;
  const verifyId = attempt.verifyId;
  storeChanged();
  const finish = (allowed: boolean) => {
    // Stale: the attempt was resolved, replaced or re-verified meanwhile. Nothing is sent and nothing changes.
    if (unresolved.get(attempt.scope) !== attempt || attempt.verifyId !== verifyId || !attempt.verifying) return;
    attempt.verifying = false;
    // An earlier send may have answered during the check (a late refusal or conflict): send only if still allowed.
    if (allowed && (attempt.state === 'unsent' || attempt.state === 'ambiguous')) {
      sendAttempt(attempt);
      return;
    }
    if (!allowed && attempt.state === 'unsent') {
      // Never sent: nothing can have been recorded under this request id, so the attempt is released (the form keeps
      // its values). This is proof of non-commit, not an escape from an unresolved attempt.
      unresolved.delete(attempt.scope);
      notices.set(attempt.scope, {
        requestId: attempt.requestId, kind: 'identity', readiness: false, message: '', form: attempt.form,
      });
    } else if (!allowed && attempt.state === 'ambiguous') {
      // Already sent before: kept in custody exactly as it was — same owner, request id, frozen arguments, lock.
      // (A late 23505 that made it a conflict meanwhile is never retried, so no retry refusal is shown for it.)
      attempt.identityRefused = true;
    }
    storeChanged();
  };
  void ownerStillSignedIn(attempt).then(finish, () => finish(false));
}

/** The RPC itself. Called only by a current, positive identity check. */
function sendAttempt(attempt: UnresolvedAttempt): void {
  if (attempt.timer !== null) clearTimeout(attempt.timer);
  attempt.dispatchId += 1;
  const dispatchId = attempt.dispatchId;
  attempt.state = 'in_flight';
  attempt.checkUnconfirmed = false;
  // The dispatching attempt holds the scope. An earlier notice — its previous dispatch's, or a released attempt's —
  // describes another request or dispatch, so its technical detail must not reappear under this one.
  notices.delete(attempt.scope);
  attempt.timer = setTimeout(() => {
    if (unresolved.get(attempt.scope) !== attempt || attempt.dispatchId !== dispatchId || attempt.state !== 'in_flight') return;
    attempt.timer = null;
    attempt.state = 'ambiguous';
    storeChanged();
  }, DIRECT_ENTRY_DEADLINE_MS);
  storeChanged();
  // A synchronous throw from the client is a transport failure like any other (ambiguous), never an unhandled error.
  let record: unknown;
  try {
    record = supabase.rpc('phoenix_subpurchase_direct_entry', { p_request_id: attempt.requestId, ...attempt.args });
  } catch (thrown) {
    record = Promise.reject(thrown);
  }
  void Promise.resolve(record as PromiseLike<RecordResponse>).then(
    response => settleAttempt(attempt, dispatchId, response),
    (reason: unknown) => settleAttempt(attempt, dispatchId, {
      data: null,
      error: { message: reason instanceof Error ? reason.message : String(reason) },
    }),
  );
}

function createAttempt(
  scope: string,
  requestId: string,
  args: RecordArgs,
  form: FormSnapshot,
  actorId: string | null,
  organizationId: string | null,
): UnresolvedAttempt {
  const attempt: UnresolvedAttempt = {
    scope,
    requestId,
    args: Object.freeze({ ...args }),
    form: Object.freeze({ ...form }),
    state: 'unsent',
    dispatchId: 0,
    timer: null,
    actorId,
    organizationId,
    checking: false,
    checkId: 0,
    checkUnconfirmed: false,
    verifying: false,
    verifyId: 0,
    identityRefused: false,
  };
  unresolved.set(scope, attempt);
  return attempt;
}

/**
 * CI-4C: one read-only status check of an unresolved attempt (reconcileDirectEntry: plain RLS SELECTs, bounded, no
 * write). It can only turn an AMBIGUOUS attempt into the recorded result it confirms. Any other answer — nothing found,
 * a refused or failed read, a timeout, a mismatch — leaves the attempt exactly as it was: locked, same request id,
 * same arguments. A 23505 conflict is never confirmed by a check. A result that arrives after the attempt was resolved,
 * replaced or re-checked is stale and changes nothing.
 */
function checkAttemptStatus(attempt: UnresolvedAttempt): void {
  if (unresolved.get(attempt.scope) !== attempt || attempt.state === 'in_flight' || attempt.checking) return;
  // CI-4D-A: nothing to check before the first send, and no check while a send is being verified.
  if (attempt.state === 'unsent' || attempt.verifying) return;
  attempt.checking = true;
  attempt.checkId += 1;
  const checkId = attempt.checkId;
  storeChanged();
  const finish = (confirmed: { orderNumber: string; receiptNumber: string } | null) => {
    if (unresolved.get(attempt.scope) !== attempt || attempt.checkId !== checkId) return;
    attempt.checking = false;
    if (confirmed !== null && attempt.state === 'ambiguous') {
      const key = outcomeKey(attempt.scope, attempt.requestId);
      if (!outcomes.has(key)) {
        outcomes.set(key, {
          scope: attempt.scope,
          requestId: attempt.requestId,
          replay: false,
          orderNumber: confirmed.orderNumber,
          receiptNumber: confirmed.receiptNumber,
          reconciled: true,
          acknowledged: false,
        });
      }
      if (attempt.timer !== null) clearTimeout(attempt.timer);
      unresolved.delete(attempt.scope);
      // This attempt still holds the scope (stale guard above), and every dispatch clears earlier notices, so the
      // scope's notice is this attempt's own.
      notices.delete(attempt.scope);
    } else {
      attempt.checkUnconfirmed = true;
    }
    storeChanged();
  };
  if (attempt.actorId === null || attempt.organizationId === null) {
    finish(null);
    return;
  }
  void reconcileDirectEntry({
    requestId: attempt.requestId,
    actorId: attempt.actorId,
    organizationId: attempt.organizationId,
    warehouseId: String(attempt.args.p_warehouse_id ?? ''),
    args: attempt.args,
  }).then(
    result => finish(result.status === 'confirmed' ? result : null),
    () => finish(null),
  );
}

function openOutcome(scope: string): SettledOutcome | null {
  for (const outcome of outcomes.values()) {
    if (outcome.scope === scope && !outcome.acknowledged) return outcome;
  }
  return null;
}

function acknowledgeOutcome(outcome: SettledOutcome): void {
  outcome.acknowledged = true;
  storeChanged();
}

export function DirectEntryPanel({ lang, warehouseId, scopeKey, onDone }: Props) {
  const scope = `${scopeKey}|${warehouseId}`;
  // Re-render whenever the attempt store changes (an answer, a timeout, a release, an acknowledgement).
  useSyncExternalStore(subscribeToStore, currentStoreVersion);
  const attempt = unresolved.get(scope) ?? null;
  const locked = attempt !== null;
  const outcome = openOutcome(scope);
  const notice = notices.get(scope) ?? null;
  // CI-4C: the attempt is bound to the signed-in profile and organization that create it; a status check reads only
  // for that owner, and the reader re-checks the live session against it.
  const { profile, activeOrgId } = useApp();
  // CI-4D-A: publish the identity this panel shows for its scope, for the pre-send identity check. It is removed on
  // unmount or when the identity changes, so a send that outlives this panel (or this identity) is refused.
  const liveProfileId = profile?.id ?? null;
  const liveOrganizationId = activeOrgId ?? null;
  useLayoutEffect(() => {
    const live: LiveIdentity = { profileId: liveProfileId, organizationId: liveOrganizationId };
    const mounted = liveIdentities.get(scope) ?? new Set<LiveIdentity>();
    mounted.add(live);
    liveIdentities.set(scope, mounted);
    return () => {
      mounted.delete(live);
      if (mounted.size === 0 && liveIdentities.get(scope) === mounted) liveIdentities.delete(scope);
    };
  }, [scope, liveProfileId, liveOrganizationId]);
  // The unresolved attempt's form; or, CI-4D-A, the form of a never-sent attempt released while this panel was away.
  // That one was never sent, so it is editable again and needs a fresh human confirmation before any submission.
  const [restored] = useState(() => {
    const released = notices.get(scope);
    const unsentForm = released?.kind === 'identity' && released.form ? { ...released.form, confirmed: false } : null;
    return unresolved.get(scope)?.form ?? unsentForm;
  });
  const reportedRef = useRef(new Set<string>());
  useEffect(() => {
    const key = outcome ? outcomeKey(outcome.scope, outcome.requestId) : null;
    if (outcome && key !== null && !reportedRef.current.has(key)) {
      reportedRef.current.add(key);
      onDone(outcome.replay ? 'sp_entry_replayed' : 'sp_entry_ok');
    }
  }, [outcome, onDone]);

  // Every form setter is refused while an attempt is unresolved: the payload is the attempt's identity (CI-4A item 4).
  const gate = <V,>(set: (value: V) => void) => (value: V) => { if (!locked) set(value); };
  const [material, setMaterialState] = useState<MaterialIdentity | null>(restored?.material ?? null);
  const [newIdentity, setNewIdentityState] = useState(restored?.newIdentity ?? false);
  const [scientificName, setScientificNameState] = useState(restored?.scientificName ?? '');
  const [tradeName, setTradeNameState] = useState(restored?.tradeName ?? '');
  const [concentration, setConcentrationState] = useState(restored?.concentration ?? '');
  const [dosageForm, setDosageFormState] = useState(restored?.dosageForm ?? '');
  const [unit, setUnitState] = useState(restored?.unit ?? '');
  const [nationalCode, setNationalCodeState] = useState(restored?.nationalCode ?? '');
  const [duplicates, setDuplicates] = useState<DuplicateCandidate[]>([]);
  const [batch, setBatchState] = useState(restored?.batch ?? '');
  const [noBatch, setNoBatchState] = useState(restored?.noBatch ?? false);
  const [expiry, setExpiryState] = useState(restored?.expiry ?? '');
  const [qty, setQtyState] = useState(restored?.qty ?? '');
  const [price, setPriceState] = useState(restored?.price ?? '');
  const [purchaseDate, setPurchaseDateState] = useState(restored?.purchaseDate ?? '');
  const [invoice, setInvoiceState] = useState(restored?.invoice ?? '');
  const [supplier, setSupplierState] = useState(restored?.supplier ?? '');
  const [notes, setNotesState] = useState(restored?.notes ?? '');
  const [confirmed, setConfirmedState] = useState(restored?.confirmed ?? false);
  const setMaterial = gate(setMaterialState);
  const setNewIdentity = gate(setNewIdentityState);
  const setScientificName = gate(setScientificNameState);
  const setTradeName = gate(setTradeNameState);
  const setConcentration = gate(setConcentrationState);
  const setDosageForm = gate(setDosageFormState);
  const setUnit = gate(setUnitState);
  const setNationalCode = gate(setNationalCodeState);
  const setBatch = gate(setBatchState);
  const setNoBatch = gate(setNoBatchState);
  const setExpiry = gate(setExpiryState);
  const setQty = gate(setQtyState);
  const setPrice = gate(setPriceState);
  const setPurchaseDate = gate(setPurchaseDateState);
  const setInvoice = gate(setInvoiceState);
  const setSupplier = gate(setSupplierState);
  const setNotes = gate(setNotesState);
  const setConfirmed = gate(setConfirmedState);
  const touch = () => setConfirmed(false);

  const effectiveName = material?.scientificName ?? (newIdentity ? scientificName.trim() : '');
  const qtyN = parseInt(qty, 10);
  const formComplete = effectiveName !== ''
    && Number.isFinite(qtyN) && qtyN > 0
    && (noBatch ? batch.trim() === '' : batch.trim() !== '')
    && confirmed;
  // An ambiguous attempt is retried, never edited; a recorded result must be closed before anything new is submitted.
  // Neither a retry nor a second check may start while a read-only status check is running.
  // CI-4D-A: nor while a send's identity check is running.
  const verifying = attempt?.verifying ?? false;
  const canRetry = attempt !== null && attempt.state === 'ambiguous' && !attempt.checking && !verifying && outcome === null;
  const canSubmitNew = !locked && outcome === null && formComplete;
  const submitEnabled = canRetry || canSubmitNew;
  // A status check needs a sent request (nothing to look up before the first send) that is no longer in flight.
  const checkable = attempt !== null && attempt.state !== 'unsent' && attempt.state !== 'in_flight';
  const canCheck = checkable && !attempt.checking && !verifying && outcome === null;
  // CI-4D-A: the purchase is being submitted (its identity check, then the request in flight).
  const submitting = attempt !== null && (attempt.state === 'in_flight' || verifying);
  // The primary message is always translated copy. The server's or transport's own text is technical detail only.
  const noticePrimary = attempt !== null
    ? (attempt.state === 'ambiguous' ? t('sp_attempt_unknown', lang)
      : attempt.state === 'conflict' ? t('sp_attempt_conflict', lang) : '')
    : (notice !== null && notice.kind === 'rejected'
      ? t(notice.readiness ? 'sp_attempt_unavailable' : 'sp_attempt_rejected', lang)
      // CI-4D-A: a never-sent attempt released because its owner could not be verified (CI-4D-B: its own copy).
      : notice !== null && notice.kind === 'identity' ? t('sp_attempt_identity_unsent', lang) : '');
  const technicalDetail = noticePrimary !== '' ? (notice?.message ?? '') : '';

  // 117 — advisory-only duplicate suggestion while typing a NEW identity.
  // Never blocks submission; purely a "did you mean...?" hint.
  useEffect(() => {
    if (!newIdentity || material !== null || scientificName.trim().length < 2) {
      setDuplicates([]);
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      void getDuplicateCandidates(warehouseId, scientificName, tradeName, nationalCode)
        .then(rows => { if (!cancelled) setDuplicates(rows); });
    }, 400);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [newIdentity, material, warehouseId, scientificName, tradeName, nationalCode]);

  /** Closes the recorded result. The operator's act is the only thing that acknowledges it; the form then needs a fresh confirmation. */
  function closeOutcome(settled: SettledOutcome) {
    acknowledgeOutcome(settled);
    setConfirmedState(false);
  }

  function submit() {
    if (!supabaseConfigured || outcome !== null) return;
    const stored = unresolved.get(scope);
    if (stored) {
      // Unresolved: the only permitted submission is the SAME request and arguments, and only when ambiguous. In flight
      // is never dispatched twice, and a 23505 conflict is never re-sent: it needs reconciliation, not a retry.
      if (stored.state === 'ambiguous' && !stored.checking) dispatchAttempt(stored);
      return;
    }
    if (!formComplete) return;
    const fields = {
      p_warehouse_id: warehouseId,
      p_scientific_name: effectiveName,
      p_quantity: qtyN,
      p_batch_number: batch.trim() || null,
      p_has_no_batch: noBatch,
      p_expiry_date: expiry || null,
      p_unit_price: price.trim() === '' ? null : Number(price),
      p_purchase_date: purchaseDate || null,
      p_invoice_number: invoice.trim() || null,
      p_supplier_name: supplier.trim() || null,
      p_notes: notes.trim() || null,
      p_central_item_id: material?.centralItemId ?? null,
      p_trade_name: (material?.tradeName ?? tradeName.trim()) || null,
      p_concentration: (material?.concentration ?? concentration.trim()) || null,
      p_dosage_form: (material?.dosageForm ?? dosageForm.trim()) || null,
      p_unit: (material?.unit ?? unit.trim()) || null,
      p_national_code: nationalCode.trim() || null,
    };
    // A NEW attempt: its request id and arguments are captured here, before the first dispatch, and never change.
    const form: FormSnapshot = {
      material, newIdentity, scientificName, tradeName, concentration, dosageForm, unit, nationalCode,
      batch, noBatch, expiry, qty, price, purchaseDate, invoice, supplier, notes, confirmed,
    };
    dispatchAttempt(createAttempt(scope, newRequestId(), fields, form, profile?.id ?? null, activeOrgId ?? null));
  }

  const fieldRow = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(min(100%, 200px), 1fr))', gap: '10px' } as const;

  return (
    <div style={{ display: 'grid', gap: '12px' }} data-testid="subpurchase-direct-entry">
      {/* A settled result stays until the operator closes it. Nothing new can be submitted while it is open. */}
      {outcome && (
        <PhoenixCard data-testid="subpurchase-result">
          <div style={{ fontSize: '12.5px', display: 'grid', gap: '4px' }}>
            <div><strong>{t(outcome.reconciled ? 'sp_attempt_existing_receipt' : outcome.replay ? 'sp_entry_replayed' : 'sp_entry_recorded', lang)}</strong></div>
            <div dir="ltr">{t('sp_official_order_no', lang)}: <code>{outcome.orderNumber}</code></div>
            <div dir="ltr">{t('sp_official_receipt_no', lang)}: <code>{outcome.receiptNumber}</code></div>
            <div>
              <PhoenixButton variant="ghost" size="sm" onClick={() => closeOutcome(outcome)}>{t('sp_attempt_acknowledge', lang)}</PhoenixButton>
            </div>
          </div>
        </PhoenixCard>
      )}
      <PhoenixCard>
        <h4 style={{ fontSize: '13.5px', fontWeight: 700, marginBottom: '4px' }}>{t('sp_entry_title', lang)}</h4>
        <p style={{ fontSize: '11.5px', color: 'var(--t2)', marginBottom: '12px' }} dir="auto">{t('sp_entry_sub', lang)}</p>

        {/* Material: registered-first; a NEW identity may be registered HERE
            (the one screen besides the Inventory Center allowed to). */}
        {material === null && !newIdentity && !locked && (
          <>
            <PhoenixMaterialResolver lang={lang} warehouseId={warehouseId} onSelect={m => { setMaterial(toMaterialIdentity(m)); touch(); }} />
            <div style={{ marginTop: '8px' }}>
              <PhoenixButton variant="ghost" size="sm" onClick={() => { setNewIdentity(true); touch(); }}>
                + {t('sp_register_new_material', lang)}
              </PhoenixButton>
            </div>
          </>
        )}
        {material !== null && (
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '12.5px', padding: '8px 12px', borderRadius: 'var(--r2)', background: 'var(--s2)', border: '1px solid var(--brd)' }}>
            <strong dir="auto">{material.scientificName}{material.tradeName ? ` (${material.tradeName})` : ''}</strong>
            <PhoenixButton variant="ghost" size="sm" disabled={locked} onClick={() => { setMaterial(null); touch(); }}>✕</PhoenixButton>
          </div>
        )}
        {newIdentity && material === null && (
          <div style={{ marginTop: '10px', display: 'grid', gap: '10px' }}>
            <div style={fieldRow}>
              <PhoenixInput disabled={locked} label={t('inv_scientific_name', lang)} value={scientificName} onChange={e => { setScientificName(e.target.value); touch(); }} />
              <PhoenixInput disabled={locked} label={t('inv_trade_name', lang)} value={tradeName} onChange={e => { setTradeName(e.target.value); touch(); }} />
              <PhoenixInput disabled={locked} label={t('inv_concentration', lang)} value={concentration} onChange={e => { setConcentration(e.target.value); touch(); }} />
              <PhoenixInput disabled={locked} label={t('inv_dosage_form', lang)} value={dosageForm} onChange={e => { setDosageForm(e.target.value); touch(); }} />
              <PhoenixInput disabled={locked} label={t('inv_unit', lang)} value={unit} onChange={e => { setUnit(e.target.value); touch(); }} />
              <PhoenixInput disabled={locked} label={t('sp_national_code_optional', lang)} value={nationalCode} onChange={e => { setNationalCode(e.target.value); touch(); }} />
            </div>

            {/* 117 — advisory-only, never blocks creating a new material. */}
            {duplicates.length > 0 && (
              <div data-testid="subpurchase-duplicate-hint" role="status" style={{ padding: '8px 12px', borderRadius: 'var(--r2)', background: 'var(--warn2)', border: '1px solid var(--warn)', display: 'grid', gap: '6px' }}>
                <div style={{ fontSize: '12px', fontWeight: 700 }} dir="auto">{t('sp_duplicate_hint_title', lang)}</div>
                <div style={{ display: 'grid', gap: '4px' }}>
                  {duplicates.map(d => (
                    <div key={`${d.source}-${d.sourceId}`} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: '8px', fontSize: '11.5px', flexWrap: 'wrap' }}>
                      <span dir="auto">
                        {d.scientificName}{d.tradeName ? ` (${d.tradeName})` : ''}
                        {' '}· {t(d.source === 'catalog' ? 'sp_duplicate_source_catalog' : 'sp_duplicate_source_lot', lang)}
                      </span>
                      {d.source === 'catalog' && (
                        <PhoenixButton
                          variant="ghost" size="sm"
                          onClick={() => {
                            // G3.2 — this button is rendered ONLY for
                            // `d.source === 'catalog'`, so the row it adopts is a
                            // `central_items` hit and nothing more. Its canonical
                            // block therefore says exactly that and no more:
                            //
                            //  - scope.kind = 'catalog' (DECISION E). The panel
                            //    does have a `warehouseId` in scope, but this row
                            //    is NOT stock in that warehouse — it is a catalog
                            //    entry the operator is about to purchase INTO it.
                            //    Attaching the warehouse here would assert a
                            //    structural position the row does not occupy.
                            //  - materialIdentityKey = null. 150's key is a
                            //    GENERATED column on the stock tables;
                            //    `phoenix_subpurchase_duplicate_candidates` does
                            //    not return one, and it must never be rebuilt
                            //    from name / national code / concentration.
                            //  - nationalCode is the catalog-level semantic,
                            //    which for a catalog row IS `barcode` (DECISION A)
                            //    — matching what this code already assigned to
                            //    both fields before G3.2.
                            //
                            // Contract adaptation only: the duplicate-handling
                            // workflow below is untouched.
                            setMaterial(toMaterialIdentity({
                              source: 'catalog',
                              centralItemId: d.sourceId,
                              warehouseStockId: null,
                              scientificName: d.scientificName,
                              tradeName: d.tradeName,
                              concentration: d.concentration,
                              dosageForm: d.dosageForm,
                              unit: null,
                              nationalCode: d.nationalCode,
                              barcode: d.nationalCode,
                              batchNumber: null,
                              expiryDate: null,
                              onHand: null,
                              reserved: null,
                              available: null,
                              supplyType: null,
                              grade: 'confirmed',
                              reasonKey: 'sp_duplicate_use_this',
                              canonical: {
                                identity: {
                                  centralItemId: d.sourceId,
                                  materialIdentityKey: null,
                                  warehouseStockId: null,
                                  outletStockId: null,
                                },
                                scope: { kind: 'catalog' },
                                display: {
                                  scientificName: d.scientificName,
                                  tradeName: d.tradeName,
                                  concentration: d.concentration,
                                  dosageForm: d.dosageForm,
                                  unit: null,
                                  nationalCode: d.nationalCode,
                                  batchNumber: null,
                                  expiryDate: null,
                                },
                                eligibility: {
                                  // The 117 duplicate lookup is advisory and
                                  // already returns only usable catalog rows;
                                  // the RPC behind the entry itself remains the
                                  // authority on whether the purchase is legal.
                                  selectable: true,
                                  active: true,
                                  availableQuantity: null,
                                  expired: null,
                                  blockedReasonKey: null,
                                },
                              },
                            } satisfies ResolvedMaterial));
                            setNewIdentity(false);
                            touch();
                          }}
                        >
                          {t('sp_duplicate_use_this', lang)}
                        </PhoenixButton>
                      )}
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: '10.5px', color: 'var(--t2)' }} dir="auto">{t('sp_duplicate_hint_note', lang)}</div>
              </div>
            )}

            <PhoenixButton variant="ghost" size="sm" disabled={locked} onClick={() => { setNewIdentity(false); touch(); }}>
              {t('sp_back_to_search', lang)}
            </PhoenixButton>
          </div>
        )}
      </PhoenixCard>

      <PhoenixCard>
        <div style={fieldRow}>
          <PhoenixInput label={t('mv_f_batch_number', lang)} value={batch} disabled={locked || noBatch} onChange={e => { setBatch(e.target.value); touch(); }} />
          <PhoenixInput disabled={locked} label={t('mv_f_expiry_date', lang)} type="date" value={expiry} onChange={e => { setExpiry(e.target.value); touch(); }} />
          <PhoenixInput disabled={locked} label={t('inv_quantity_received', lang)} type="number" min={1} step={1} value={qty} onChange={e => { setQty(e.target.value); touch(); }} />
          <PhoenixInput disabled={locked} label={t('inv_unit_price', lang)} type="number" min={0} step="0.01" value={price} onChange={e => { setPrice(e.target.value); touch(); }} />
          <PhoenixInput disabled={locked} label={t('sp_purchase_date', lang)} type="date" value={purchaseDate} onChange={e => { setPurchaseDate(e.target.value); touch(); }} />
          <PhoenixInput disabled={locked} label={t('sp_invoice_ref', lang)} value={invoice} onChange={e => { setInvoice(e.target.value); touch(); }} />
          <PhoenixInput disabled={locked} label={t('sp_supplier_optional', lang)} value={supplier} onChange={e => { setSupplier(e.target.value); touch(); }} />
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12.5px', minHeight: '44px' }}>
          <input type="checkbox" disabled={locked} checked={noBatch} onChange={e => { setNoBatch(e.target.checked); if (e.target.checked) setBatch(''); touch(); }} />
          {t('inv_no_batch_number', lang)}
        </label>
        <PhoenixInput disabled={locked} label={t('inv_notes', lang)} value={notes} onChange={e => { setNotes(e.target.value); touch(); }} />

        {/* MANDATORY human confirmation — nothing posts without it. */}
        <label style={{ display: 'flex', gap: '8px', alignItems: 'flex-start', fontSize: '12px', marginTop: '10px', cursor: 'pointer' }}>
          <input type="checkbox" disabled={locked} checked={confirmed} onChange={e => setConfirmed(e.target.checked)} data-testid="subpurchase-confirm" />
          <span dir="auto">{t('sp_confirm_entry', lang)}</span>
        </label>

        {noticePrimary !== '' && (
          <div role="alert" style={{ fontSize: '12px', color: 'var(--err)', marginTop: '8px', display: 'grid', gap: '6px' }} dir="auto">
            <p data-notice-primary="" style={{ margin: 0 }}>{noticePrimary}</p>
            {attempt?.checkUnconfirmed && <p style={{ margin: 0 }}>{t('sp_attempt_check_unconfirmed', lang)}</p>}
            {/* CI-4D-A: the last retry was not sent, because the signed-in owner could not be verified. */}
            {attempt?.identityRefused && <p style={{ margin: 0 }}>{t('sp_attempt_identity_retry_refused', lang)}</p>}
            {attempt?.state === 'ambiguous' && <p style={{ margin: 0, color: 'var(--t2)' }}>{t('sp_attempt_retry_hint', lang)}</p>}
            {/* Restricted technical detail: collapsed, never the primary message. */}
            {technicalDetail !== '' && (
              <details style={{ color: 'var(--t2)' }}>
                <summary>{t('sp_attempt_technical_details', lang)}</summary>
                <code dir="ltr">{technicalDetail}</code>
              </details>
            )}
          </div>
        )}

        {submitting && (
          <p role="status" style={{ fontSize: '12px', color: 'var(--t2)', margin: '8px 0 0' }} dir="auto">{t('sp_attempt_in_progress', lang)}</p>
        )}

        <div style={{ marginTop: '12px', display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
          {/* A read-only status check (SELECTs only) is a different action from a write retry, and is never labelled alike. */}
          {attempt !== null && checkable && (
            <PhoenixButton variant="ghost" onClick={() => checkAttemptStatus(attempt)} disabled={!canCheck}>
              {t('sp_attempt_check_status', lang)}
            </PhoenixButton>
          )}
          {/* An ambiguous attempt is retried with its own request and arguments; it is never re-keyed or re-typed. */}
          <PhoenixButton onClick={() => submit()} disabled={!submitEnabled} loading={submitting}>
            {locked ? t('sp_attempt_retry_original', lang) : t('sp_submit_entry', lang)}
          </PhoenixButton>
        </div>
      </PhoenixCard>
    </div>
  );
}
