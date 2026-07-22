import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import {
  defaultWarehouseIntakeAllowed,
  WAREHOUSE_INTAKE_BLOCKED_CODE,
} from './warehouse-intake-safety';

/**
 * INVENTORY-CENTER-INTAKE-A — thin client over the migration 065 warehouse
 * stock write contracts.
 *
 * This file is the ONLY manual entry path into stock truth. It never computes
 * stock, never writes warehouse_stock / outlet_stock / item_availability
 * directly, and never uses a privileged key: every mutation goes through a
 * SECURITY DEFINER RPC that re-checks warehouse scope and permission
 * server-side. `item_availability` is a PROJECTION of that truth (migration
 * 067's phoenix_project_outlet_availability) — nothing here writes it, and no
 * caller may choose a condition by hand.
 *
 * Every write carries a caller-generated `requestId`. Migration 065 treats it
 * as the idempotency key: replaying the same requestId returns the original
 * result instead of double-posting the ledger, which makes a retry after a
 * timeout safe.
 */

/** Result envelope; `error` is the RPC's raised code token (e.g. 'NOT_AUTHORIZED_WAREHOUSE_RECEIVE'). */
export interface IntakeResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

/**
 * Normalize a Supabase RPC error into a stable code token.
 *
 * Unlike the 074/075/076 network RPCs (which RAISE 'CODE: human message'),
 * migration 065 RAISEs a BARE lowercase_snake token with a SQLSTATE — e.g.
 * `quantity_must_be_positive` USING ERRCODE '23514'. Postgres prefixes nothing,
 * but PostgREST may wrap it, so we extract the first token-shaped run rather
 * than assuming the whole message is the code.
 */
function intakeErrorCode(message: string | undefined): string {
  if (!message) return 'unknown_error';
  const match = /[a-z][a-z0-9_]{3,}/.exec(message);
  return match ? match[0] : 'unknown_error';
}

async function callRpc<T = Record<string, unknown>>(
  fn: string,
  args: Record<string, unknown>,
): Promise<IntakeResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: intakeErrorCode(error.message) };
  const payload = (data ?? {}) as { ok?: boolean } & T;
  return { ok: payload.ok !== false, data: payload as T };
}

/**
 * Seams for the accumulating-receipt write paths. Both default to production
 * behaviour; tests inject a spy transport and a forced gate to prove the path
 * fails closed WITHOUT calling any writer while the migration-065 concurrency
 * blocker is unresolved (see warehouse-intake-safety.ts).
 */
export interface WarehouseIntakeDeps {
  callRpc?: typeof callRpc;
  /** Gate decision; defaults to the live build gate. */
  allowed?: () => boolean;
}

/**
 * Generate an idempotency key for one intake attempt. Held in component state
 * for the lifetime of a single form submission so that a user-initiated retry
 * after a network failure replays the SAME key and cannot post the quantity
 * twice. A new key is minted only when the form is cleared for a new entry.
 */
export function newRequestId(): string {
  return crypto.randomUUID();
}

export interface ReceiveWarehouseStockInput {
  requestId: string;
  warehouseId: string;
  scientificName: string;
  quantity: number;
  /**
   * Explicit operator acknowledgements, not derived from blank fields. Migration
   * 065 requires the caller to state that a code/batch is genuinely absent
   * rather than merely un-typed, so a rushed entry cannot silently create an
   * unidentifiable batch.
   */
  hasNoNationalCode: boolean;
  hasNoBatchNumber: boolean;
  centralItemId?: string | null;
  tradeName?: string | null;
  concentration?: string | null;
  dosageForm?: string | null;
  unit?: string | null;
  nationalCode?: string | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  unitPrice?: number | null;
  priceBasis?: string | null;
  currency?: string | null;
  /**
   * CANONICAL-SUPPLY-PROVENANCE-088: closed vocabulary ('aid'|'purchase'|
   * 'kimadia'). Part of LOT IDENTITY server-side. A 'purchase' received at a
   * pharmacy-department warehouse defaults its origin to 'central' — the
   * server enforces the same rule.
   */
  supplyType?: string | null;
  purchaseOrigin?: string | null;
  sourceDocumentNumber?: string | null;
  notes?: string | null;
  /**
   * The canonical `warehouse_stock.movement_seq` this receipt was composed
   * against, read from the server (migration 078). Omit to post unguarded,
   * exactly as before 078.
   *
   * A brand-new lot has generation 0, so a FIRST receipt legitimately sends 0.
   * `undefined` and `0` therefore mean different things — see
   * {@link toExpectedGeneration}.
   */
  expectedGeneration?: number | null;
}

/**
 * Normalize the optional expected generation for an RPC argument.
 *
 * `0` is a REAL generation — a lot that exists but has never moved, and the
 * value a first receipt sends — so `??`/falsy coercion here would silently turn
 * the strictest guard into no guard at all. Only `undefined` means "unguarded".
 */
export function toExpectedGeneration(v: number | null | undefined): number | null {
  return v === undefined ? null : v;
}

/** PostgreSQL: column does not exist. Emitted until migration 078 is applied. */
const UNDEFINED_COLUMN = '42703';

/**
 * The outcome of reading a lot's canonical generation.
 *
 * DISCRIMINATED ON PURPOSE. An earlier revision returned `number | null`, where
 * `null` meant every one of "column not deployed yet", "row not visible",
 * "network failed" and "no such lot" — and every one of those collapsed into
 * "post unguarded". A read failure silently disabling the concurrency guard is
 * precisely the class of bug this whole migration exists to prevent, so the
 * failure now has to be handled explicitly by the caller and cannot be reached
 * by accident.
 *
 * `absent` is NOT an error: a lot that does not exist yet legitimately has
 * generation 0, and that is what a first receipt must send.
 */
export type GenerationRead =
  | { ok: true; generation: number }
  /** No such lot yet — a first receipt. Canonically generation 0. */
  | { ok: true; generation: 0; absent: true }
  /** The guard is unavailable. The caller MUST NOT post. */
  | { ok: false; reason: 'not_deployed' | 'unreadable' | 'not_configured' };

/**
 * Read the canonical, server-owned generation of one warehouse stock lot.
 *
 * `movement_seq` exists only once migration 078 is applied, and this repository
 * never applies migrations automatically, so between merge and apply the column
 * is genuinely absent — reported as `not_deployed`, never as a usable value.
 */
export async function getWarehouseStockGeneration(
  warehouseStockId: string,
  deps: { read?: (id: string) => Promise<{ movement_seq: number } | null> } = {},
): Promise<GenerationRead> {
  if (deps.read) {
    const row = await deps.read(warehouseStockId);
    if (!row) return { ok: true, generation: 0, absent: true };
    return { ok: true, generation: row.movement_seq };
  }
  if (!supabaseConfigured) return { ok: false, reason: 'not_configured' };
  if (!warehouseStockId) return { ok: true, generation: 0, absent: true };

  const { data, error } = await supabase
    .from('warehouse_stock')
    .select('movement_seq')
    .eq('id', warehouseStockId)
    .maybeSingle();

  if (error) {
    return { ok: false, reason: error.code === UNDEFINED_COLUMN ? 'not_deployed' : 'unreadable' };
  }
  if (data === null) return { ok: true, generation: 0, absent: true };

  const seq = (data as { movement_seq?: number }).movement_seq;
  // A row that exists but reports no generation means the column is not what we
  // think it is. Fail closed rather than guess.
  return typeof seq === 'number' ? { ok: true, generation: seq } : { ok: false, reason: 'unreadable' };
}

/** Refusal token when a mutation was attempted without a proven generation. */
export const GENERATION_UNAVAILABLE_CODE = 'expected_generation_unavailable';

/**
 * The lot identity a warehouse RECEIPT resolves against, matching migration
 * 065/078's server-side resolution EXACTLY: (warehouse_id, trimmed
 * scientific_name, concentration, dosage_form, national_code, batch_number,
 * expiry_date, internal_batch_reference). `requestId` participates because a
 * receipt that explicitly has NO batch number targets a brand-new lot whose
 * internal_batch_reference the server derives from the request id — see
 * {@link receiptInternalBatchReference}.
 */
export interface WarehouseReceiptLotIdentity {
  requestId: string;
  warehouseId: string;
  scientificName: string;
  hasNoBatchNumber: boolean;
  concentration?: string | null;
  dosageForm?: string | null;
  nationalCode?: string | null;
  batchNumber?: string | null;
  expiryDate?: string | null;
  /** 088: canonical provenance participates in lot identity. */
  supplyType?: string | null;
  purchaseOrigin?: string | null;
}

/** The exact column filter the canonical read uses, exported so tests can pin it. */
export interface NormalizedLotFilter {
  warehouse_id: string;
  scientific_name: string;
  concentration: string | null;
  dosage_form: string | null;
  national_code: string | null;
  batch_number: string | null;
  internal_batch_reference: string | null;
  expiry_date: string | null;
  /** 088 provenance identity axes. Mirrors the server's normalization: a
   *  'purchase' with no explicit origin resolves as 'central'. */
  supply_type: string | null;
  purchase_origin: string | null;
}

/** Mirror of the server's NULLIF(btrim(x), '') normalization. */
function normalizeIdentityText(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Mirror of migration 065/078's internal-batch-reference derivation: a receipt
 * that explicitly has no batch number is assigned `WSNB-<request id sans
 * dashes>` — unique per request, so such a receipt ALWAYS creates a fresh lot
 * and its canonical generation is 0 by construction. A batch-carrying receipt
 * has no internal reference.
 */
export function receiptInternalBatchReference(
  identity: Pick<WarehouseReceiptLotIdentity, 'hasNoBatchNumber' | 'requestId'>,
): string | null {
  return identity.hasNoBatchNumber
    ? `WSNB-${identity.requestId.replace(/-/g, '')}`
    : null;
}

/** Build the exact canonical filter the server resolves the receipt against. */
export function normalizedLotFilter(identity: WarehouseReceiptLotIdentity): NormalizedLotFilter {
  const supplyType = normalizeIdentityText(identity.supplyType);
  const explicitOrigin = normalizeIdentityText(identity.purchaseOrigin);
  return {
    warehouse_id:             identity.warehouseId,
    scientific_name:          normalizeIdentityText(identity.scientificName) ?? '',
    concentration:            normalizeIdentityText(identity.concentration),
    dosage_form:              normalizeIdentityText(identity.dosageForm),
    national_code:            normalizeIdentityText(identity.nationalCode),
    batch_number:             normalizeIdentityText(identity.batchNumber),
    internal_batch_reference: receiptInternalBatchReference(identity),
    expiry_date:              normalizeIdentityText(identity.expiryDate),
    supply_type:              supplyType,
    // Mirror of the server rule: purchase defaults to 'central'.
    purchase_origin:          supplyType === 'purchase' ? (explicitOrigin ?? 'central') : explicitOrigin,
  };
}

/** Injectable transport for the canonical lot read; production hits PostgREST. */
export type LotGenerationQuery = (filter: NormalizedLotFilter) => Promise<{
  data: { movement_seq?: number } | null;
  error: { code?: string } | null;
}>;

/**
 * Read the canonical generation of the lot a RECEIPT will resolve to, by the
 * SAME identity the guarded RPC locks (078). Performed fresh immediately
 * before each logical mutation. Same discriminated fail-closed contract as
 * {@link getWarehouseStockGeneration}: absent lot IS generation 0 (a first
 * receipt); any read failure — missing column, RLS/permission, network,
 * ambiguous identity (more than one matching row) — refuses and must never
 * collapse into 0 or null.
 */
export async function getWarehouseReceiptLotGeneration(
  identity: WarehouseReceiptLotIdentity,
  deps: { query?: LotGenerationQuery } = {},
): Promise<GenerationRead> {
  const filter = normalizedLotFilter(identity);

  let result: Awaited<ReturnType<LotGenerationQuery>>;
  if (deps.query) {
    result = await deps.query(filter);
  } else {
    if (!supabaseConfigured) return { ok: false, reason: 'not_configured' };
    let query = supabase
      .from('warehouse_stock')
      .select('movement_seq')
      .eq('warehouse_id', filter.warehouse_id)
      .eq('scientific_name', filter.scientific_name);
    const optional = [
      ['concentration', filter.concentration],
      ['dosage_form', filter.dosage_form],
      ['national_code', filter.national_code],
      ['batch_number', filter.batch_number],
      ['internal_batch_reference', filter.internal_batch_reference],
      ['expiry_date', filter.expiry_date],
      // 088: the per-source lot is the identity — read ITS generation.
      ['supply_type', filter.supply_type],
      ['purchase_origin', filter.purchase_origin],
    ] as const;
    for (const [column, value] of optional) {
      query = value === null ? query.is(column, null) : query.eq(column, value);
    }
    // maybeSingle errors on >1 row: an ambiguous identity is a failed read,
    // never a guessable generation.
    result = await query.maybeSingle();
  }

  if (result.error) {
    return { ok: false, reason: result.error.code === UNDEFINED_COLUMN ? 'not_deployed' : 'unreadable' };
  }
  if (result.data === null) return { ok: true, generation: 0, absent: true };
  const seq = result.data.movement_seq;
  return typeof seq === 'number' ? { ok: true, generation: seq } : { ok: false, reason: 'unreadable' };
}

export interface ReceiveWarehouseStockResult {
  ok: boolean;
  warehouse_stock_id: string;
  movement_id: string;
  quantity_before: number;
  quantity_after: number;
  replayed?: boolean;
}

/**
 * Manual intake of physical stock into a warehouse ledger
 * (phoenix_receive_warehouse_stock, migration 065). This posts a RECEIPT
 * movement and lets the ledger derive the resulting on-hand quantity — the
 * caller never states a resulting quantity, only the amount received.
 */
export function receiveWarehouseStock(
  input: ReceiveWarehouseStockInput,
  deps: WarehouseIntakeDeps = {},
): Promise<IntakeResult<ReceiveWarehouseStockResult>> {
  // Fail closed while the migration-065 accumulating-receipt concurrency blocker
  // is unresolved in a production build: refuse before any writer is called.
  if (!(deps.allowed ?? defaultWarehouseIntakeAllowed)()) {
    return Promise.resolve({ ok: false, error: WAREHOUSE_INTAKE_BLOCKED_CODE });
  }
  // Migration 079: the guarded RPC REFUSES a NULL generation. Refusing here too
  // means a failed generation read can never reach the wire at all, so the
  // client and the server fail closed for the same reason instead of relying on
  // the round trip to catch it.
  if (input.expectedGeneration == null) {
    return Promise.resolve({ ok: false, error: GENERATION_UNAVAILABLE_CODE });
  }
  const call = deps.callRpc ?? callRpc;
  // Migration 078: the GUARDED entry point. It enforces the expected-generation
  // precondition and then delegates to the 065 RPC, so RBAC, fingerprint
  // idempotency and the audit trail stay single-sourced. The legacy name is
  // deliberately not called any more — it is the unguarded accumulating path,
  // and migration 080 revokes it from `authenticated` entirely.
  return call<ReceiveWarehouseStockResult>('phoenix_receive_warehouse_stock_guarded', {
    p_request_id:             input.requestId,
    p_warehouse_id:           input.warehouseId,
    p_scientific_name:        input.scientificName.trim(),
    p_quantity:               input.quantity,
    p_has_no_national_code:   input.hasNoNationalCode,
    p_has_no_batch_number:    input.hasNoBatchNumber,
    p_expected_generation:    toExpectedGeneration(input.expectedGeneration),
    p_central_item_id:        input.centralItemId ?? null,
    p_trade_name:             input.tradeName ?? null,
    p_concentration:          input.concentration ?? null,
    p_dosage_form:            input.dosageForm ?? null,
    p_unit:                   input.unit ?? null,
    p_national_code:          input.nationalCode ?? null,
    p_batch_number:           input.batchNumber ?? null,
    p_expiry_date:            input.expiryDate ?? null,
    p_unit_price:             input.unitPrice ?? null,
    p_price_basis:            input.priceBasis ?? null,
    p_currency:               input.currency ?? null,
    p_supply_type_text:       input.supplyType ?? null,
    p_source_document_number: input.sourceDocumentNumber ?? null,
    p_notes:                  input.notes ?? null,
    // 088 canonical provenance — identity axis, validated server-side.
    p_supply_type:            input.supplyType ?? null,
    p_purchase_origin:        input.purchaseOrigin ?? null,
  });
}

/**
 * The movement types accepted by migration 065's
 * phoenix_apply_warehouse_stock_movement.
 *
 * `set_exact` is deliberately NOT surfaced by the Inventory Center UI: an
 * operator states what MOVED and the ledger computes the balance. It stays in
 * the type because the RPC accepts it and a future reconciliation tool may
 * need it — see WAREHOUSE_ADJUSTMENT_TYPES below for what the UI actually
 * offers. `correction` requires a reason server-side.
 */
export type WarehouseStockMovementType = 'set_exact' | 'add' | 'subtract' | 'correction';

/** The subset the Inventory Center offers — movement-shaped only, never a balance overwrite. */
export const WAREHOUSE_ADJUSTMENT_TYPES = ['add', 'subtract', 'correction'] as const;

export interface ApplyWarehouseStockMovementInput {
  requestId: string;
  warehouseStockId: string;
  movementType: WarehouseStockMovementType;
  amount: number;
  /** Required by the RPC for set_exact/correction; optional for add/subtract. */
  reason?: string | null;
  sourceDocumentNumber?: string | null;
  notes?: string | null;
  /**
   * Canonical `warehouse_stock.movement_seq` this adjustment was composed
   * against (migration 078). Omit to post unguarded.
   */
  expectedGeneration?: number | null;
}

export interface ApplyWarehouseStockMovementResult {
  ok: boolean;
  warehouse_stock_id: string;
  movement_id: string;
  quantity_before: number;
  quantity_delta: number;
  quantity_after: number;
  replayed?: boolean;
}

/**
 * Post a correction/quarantine movement against an existing warehouse stock
 * batch (phoenix_apply_warehouse_stock_movement, migration 065). The RPC
 * rejects a movement that would drive on-hand negative and requires a reason.
 */
export function applyWarehouseStockMovement(
  input: ApplyWarehouseStockMovementInput,
  deps: WarehouseIntakeDeps = {},
): Promise<IntakeResult<ApplyWarehouseStockMovementResult>> {
  // The additive movement modes (add/correction) share the same accumulating
  // concurrency gap as the receipt, so they are gated by the same blocker.
  if (!(deps.allowed ?? defaultWarehouseIntakeAllowed)()) {
    return Promise.resolve({ ok: false, error: WAREHOUSE_INTAKE_BLOCKED_CODE });
  }
  // Same fail-closed rule as the receipt: no proven generation, no post.
  if (input.expectedGeneration == null) {
    return Promise.resolve({ ok: false, error: GENERATION_UNAVAILABLE_CODE });
  }
  const call = deps.callRpc ?? callRpc;
  // Migration 078: the GUARDED entry point, for the same reason as the receipt.
  return call<ApplyWarehouseStockMovementResult>('phoenix_apply_warehouse_stock_movement_guarded', {
    p_request_id:             input.requestId,
    p_warehouse_stock_id:     input.warehouseStockId,
    p_movement_type:          input.movementType,
    p_amount:                 input.amount,
    p_expected_generation:    toExpectedGeneration(input.expectedGeneration),
    p_reason:                 input.reason ?? null,
    p_source_document_number: input.sourceDocumentNumber ?? null,
    p_notes:                  input.notes ?? null,
  });
}

/**
 * One posted movement in a warehouse's ledger. Read-only: warehouse_stock_movements
 * grants SELECT only to client roles (migration 065), and its RLS policy
 * re-enforces warehouse scope for every caller regardless of these filters.
 */
export interface WarehouseStockMovementRecord {
  id: string;
  warehouseStockId: string;
  movementType: string;
  quantityBefore: number;
  quantityDelta: number;
  quantityAfter: number;
  reason: string | null;
  notes: string | null;
  sourceDocumentNumber: string | null;
  actorNameSnapshot: string | null;
  createdAt: string;
}

interface WarehouseStockMovementRow {
  id: string; warehouse_stock_id: string; movement_type: string;
  quantity_before: number; quantity_delta: number; quantity_after: number;
  reason: string | null; notes: string | null; source_document_number: string | null;
  actor_name_snapshot: string | null; created_at: string;
}

/** Newest-first ledger history for one batch, capped — an audit view, not an export. */
export async function getWarehouseStockMovements(
  warehouseStockId: string,
  limit = 100,
): Promise<WarehouseStockMovementRecord[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('warehouse_stock_movements')
    .select(`
      id, warehouse_stock_id, movement_type, quantity_before, quantity_delta, quantity_after,
      reason, notes, source_document_number, actor_name_snapshot, created_at
    `)
    .eq('warehouse_stock_id', warehouseStockId)
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data as WarehouseStockMovementRow[] | null ?? []).map(r => ({
    id: r.id,
    warehouseStockId: r.warehouse_stock_id,
    movementType: r.movement_type,
    quantityBefore: r.quantity_before,
    quantityDelta: r.quantity_delta,
    quantityAfter: r.quantity_after,
    reason: r.reason,
    notes: r.notes,
    sourceDocumentNumber: r.source_document_number,
    actorNameSnapshot: r.actor_name_snapshot,
    createdAt: r.created_at,
  }));
}

/**
 * Map an intake RPC error token (as returned in IntakeResult.error) to an i18n
 * string key. The tokens are migration 065's own vocabulary — see the
 * RAISE EXCEPTION sites in phoenix_receive_warehouse_stock and
 * phoenix_apply_warehouse_stock_movement. Ordering matters: the more specific
 * identity/authorization cases are matched before the generic *_required tail.
 */
export function classifyIntakeError(code: string | undefined): string {
  const c = code ?? '';

  // Pre-deployment safety gate: the accumulating-receipt path is disabled in a
  // production build until the migration-065 concurrency blocker is resolved.
  if (c === WAREHOUSE_INTAKE_BLOCKED_CODE) return 'inv_err_blocked_concurrency';

  // Permission / identity boundary (42501) — the RPC is the real gate.
  if (c === 'forbidden_warehouse_stock_adjust') return 'inv_err_no_receive_permission';
  if (c === 'forbidden_warehouse_stock_movement') return 'inv_err_no_movement_permission';
  if (c === 'active_profile_required') return 'inv_err_not_authorized';
  if (c === 'not_authenticated') return 'inv_err_not_authorized';

  // Explicit-identity acknowledgements (the "I confirm there is no code/batch" flags).
  if (c === 'explicit_identity_flags_required') return 'inv_err_identity_flags_required';
  if (c === 'national_code_flag_mismatch') return 'inv_err_national_code_mismatch';
  if (c === 'batch_number_flag_mismatch') return 'inv_err_batch_mismatch';
  if (c === 'warehouse_stock_identity_resolution_failed') return 'inv_err_identity';
  if (c === 'warehouse_stock_central_item_conflict') return 'inv_err_identity';

  // Idempotency: the same request id replayed with DIFFERENT arguments.
  if (c === 'request_id_conflict') return 'inv_err_request_conflict';

  // Migration 078 optimistic concurrency: the canonical lot moved between the
  // read this receipt was composed against and the post. Distinct from
  // request_id_conflict — nothing is wrong with the request, the WORLD changed,
  // so the operator must reload the canonical row and re-confirm rather than
  // retry blindly. A blind retry is exactly the double-post being prevented.
  if (c === 'warehouse_receipt_generation_conflict') return 'inv_err_generation_conflict';

  // Migration 079 fail-closed, raised by the server; and the client-side refusal
  // that stops the same situation before the wire. Both mean the guard could not
  // be proven, so the receipt must not proceed.
  if (c === 'expected_generation_required'
    || c === GENERATION_UNAVAILABLE_CODE) return 'inv_err_generation_unavailable';

  // Quantity invariants — the ledger never goes negative or below reservations.
  if (c === 'warehouse_quantity_cannot_go_negative') return 'inv_err_negative';
  if (c === 'warehouse_quantity_below_reserved') return 'inv_err_below_reserved';
  if (c === 'quantity_must_be_positive' || c === 'amount_must_be_positive') return 'inv_err_qty_positive';
  if (c === 'amount_must_be_non_negative') return 'inv_err_qty_non_negative';
  if (c === 'unit_price_must_be_non_negative') return 'inv_err_price_non_negative';

  if (c === 'warehouse_correction_reason_required') return 'inv_err_reason_required';

  // item_availability is a projection — any attempt to write it directly is a bug.
  if (c === 'warehouse_managed_availability_read_only'
    || c === 'warehouse_managed_availability_server_only'
    || c === 'availability_source_kind_immutable') return 'inv_err_projection_read_only';

  if (c === 'warehouse_not_found_or_inactive') return 'inv_err_warehouse_unavailable';
  if (c === 'warehouse_stock_not_found' || c === 'availability_not_found') return 'inv_err_not_found';

  if (c === 'invalid_warehouse_movement_type') return 'inv_err_invalid';
  if (c.endsWith('_required')) return 'inv_err_invalid';

  return 'inv_err_generic';
}
