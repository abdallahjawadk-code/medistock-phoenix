/**
 * THE canonical reviewed-writer registry for the unified movement contract.
 *
 * Every function that INSERTs into a live quantity ledger must appear here
 * exactly once. This is the single source of truth: the static discovery
 * guard (movement-writer-completeness.test.ts) scans the real migration
 * corpus and fails if disk and this registry disagree in EITHER direction,
 * and the dynamic guard replays 001->latest and re-derives the same set from
 * pg_proc. Neither guard re-lists the writers itself — a new writer can only
 * be made to pass by being reviewed and added here.
 *
 * WHY item_availability_movements is not a contract ledger
 * --------------------------------------------------------
 * It is a dead projection ledger, proven three independent ways against a
 * full 001->latest replay:
 *   1. it has NONE of the contract columns (no reason_code, correlation_id,
 *      causation_id or occurred_at — 124/125 deliberately added them to the
 *      three LIVE ledgers only);
 *   2. it carries NO canonical event-capture trigger (123 attached
 *      phoenix_capture_movement_posted to the three live ledgers only);
 *   3. it holds zero rows after a complete replay.
 * Its two writers are therefore listed as EXCLUDED_WRITERS with that reason,
 * not silently dropped — an exclusion has to be stated to be auditable.
 */

/** The three ledgers that carry the unified movement contract. */
export const CONTRACT_LEDGERS: readonly string[] = Object.freeze([
  'warehouse_stock_movements',
  'outlet_stock_movements',
  'warehouse_quarantine_stock_movements',
]);

/** Ledgers that exist but are deliberately outside the contract. */
export const NON_CONTRACT_LEDGERS: readonly string[] = Object.freeze([
  'item_availability_movements',
]);

export interface ReviewedWriter {
  /** Function name, unique across the registry. */
  fn: string;
  /** A-I; the domain slice that brought this writer into the contract. */
  group: string;
  /** Migration that last (re)defined it with full contract compliance. */
  migration: number;
  /** Contract ledgers this writer inserts into. */
  ledgers: readonly string[];
  /** How reason_code is obtained. */
  reasonCode:
    | { kind: 'literal'; value: string }
    | { kind: 'parameter'; param: string }
    | { kind: 'propagated'; from: string };
  /** How correlation_id is obtained. */
  correlation: 'fresh' | 'inherited-from-predecessor';
  /** How causation_id is obtained; null = genuine root operation. */
  causation: string | null;
  /**
   * Idempotency mechanism. Client-callable writers must own a
   * request_fingerprint; an internal helper may delegate to its only caller,
   * which must then be a reviewed writer itself.
   */
  idempotency: 'request_fingerprint' | 'delegated-to-caller';
  /** Concurrency mechanism. Every contract writer must have one. */
  concurrency: 'advisory-lock+row-lock' | 'row-lock';
  /** true when the caller is `authenticated`; false = internal/service-only. */
  clientCallable: boolean;
}

export const REVIEWED_MOVEMENT_WRITERS: readonly ReviewedWriter[] = Object.freeze([
  // ── Group A — warehouse intake (roots) ──────────────────────────────────
  {
    fn: 'phoenix_receive_warehouse_stock', group: 'A', migration: 126,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'literal', value: 'received' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: false,
  },
  {
    fn: 'phoenix_apply_warehouse_stock_movement', group: 'A', migration: 126,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'parameter', param: 'p_reason_code' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: false,
  },
  // ── Group B — warehouse transfer ────────────────────────────────────────
  {
    fn: 'phoenix_send_warehouse_transfer_line', group: 'B', migration: 127,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'literal', value: 'transferred' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_receive_warehouse_transfer_line', group: 'B', migration: 127,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'literal', value: 'received' },
    correlation: 'inherited-from-predecessor',
    causation: 'warehouse_transfer_lines.source_movement_id',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  // ── Group C — warehouse return ──────────────────────────────────────────
  {
    fn: 'phoenix_send_warehouse_return_shipment_line', group: 'C', migration: 128,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'propagated', from: 'warehouse_return_request_lines.reason_code' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_receive_warehouse_return_shipment_line', group: 'C', migration: 128,
    ledgers: ['warehouse_stock_movements', 'warehouse_quarantine_stock_movements'],
    reasonCode: { kind: 'propagated', from: 'warehouse_return_request_lines.reason_code' },
    correlation: 'inherited-from-predecessor',
    causation: 'warehouse_return_shipment_lines.source_movement_id',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  // ── Group D — direct central<->institution ──────────────────────────────
  {
    fn: 'phoenix_send_direct_warehouse_transfer_line', group: 'D', migration: 129,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'literal', value: 'transferred' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_send_direct_warehouse_return_shipment_line', group: 'D', migration: 129,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'propagated', from: 'warehouse_return_request_lines.reason_code' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  // ── Group E — procurement ───────────────────────────────────────────────
  {
    fn: '_phoenix_procurement_post_receipt_line', group: 'E', migration: 130,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'literal', value: 'received' },
    correlation: 'fresh', causation: null,
    // Internal helper: it holds its own row locks but has no fingerprint of
    // its own — idempotency is enforced by its ONLY caller
    // (phoenix_procurement_receive_order), which owns the advisory lock and
    // the request fingerprint for the whole receipt. Never client-callable
    // (ACL: owner only), so it cannot be reached outside that scope.
    idempotency: 'delegated-to-caller', concurrency: 'row-lock',
    clientCallable: false,
  },
  {
    fn: 'phoenix_procurement_return_to_supplier', group: 'E', migration: 130,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'parameter', param: 'p_reason_code' },
    correlation: 'inherited-from-predecessor',
    causation: 'procurement_receipt_lines.movement_id',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  // ── Group F — outlet corridor ───────────────────────────────────────────
  {
    fn: 'phoenix_send_warehouse_dispatch', group: 'F', migration: 131,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'literal', value: 'transferred' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_receive_outlet_dispatch_line', group: 'F', migration: 131,
    ledgers: ['outlet_stock_movements'],
    reasonCode: { kind: 'parameter', param: 'p_reason_code' },
    correlation: 'inherited-from-predecessor',
    // Natural-key lookup, not a stored column: the send half writes its
    // movement with reference_type='warehouse_dispatch_send' and
    // reference_id=<dispatch_line_id>, which this side already holds.
    causation: "warehouse_stock_movements[reference_type='warehouse_dispatch_send'].id",
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_dispense_outlet_stock', group: 'F', migration: 131,
    ledgers: ['outlet_stock_movements'],
    reasonCode: { kind: 'literal', value: 'dispensed' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_count_outlet_stock', group: 'F', migration: 131,
    ledgers: ['outlet_stock_movements'],
    reasonCode: { kind: 'parameter', param: 'p_reason_code' },
    correlation: 'fresh', causation: null,
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_send_outlet_return_shipment_line', group: 'F', migration: 135,
    ledgers: ['outlet_stock_movements'],
    reasonCode: { kind: 'propagated', from: 'outlet_return_request_lines.reason_code' },
    correlation: 'inherited-from-predecessor',
    causation: 'outlet_return_request_lines.original_inbound_movement_id',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  // ── Group G — quarantine ────────────────────────────────────────────────
  {
    fn: 'phoenix_release_quarantine_stock', group: 'G', migration: 132,
    ledgers: ['warehouse_quarantine_stock_movements', 'warehouse_stock_movements'],
    reasonCode: { kind: 'propagated', from: 'warehouse_quarantine_stock.quarantine_reason' },
    correlation: 'inherited-from-predecessor',
    causation: 'most-recent-prior-movement-on-the-same-quarantine-lot',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_destroy_quarantine_stock', group: 'G', migration: 132,
    ledgers: ['warehouse_quarantine_stock_movements'],
    reasonCode: { kind: 'propagated', from: 'warehouse_quarantine_stock.quarantine_reason' },
    correlation: 'inherited-from-predecessor',
    causation: 'most-recent-prior-movement-on-the-same-quarantine-lot',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  // ── Group H — second-person correction approval ─────────────────────────
  {
    fn: 'phoenix_approve_outlet_stock_correction', group: 'H', migration: 133,
    ledgers: ['outlet_stock_movements'],
    reasonCode: { kind: 'literal', value: 'corrected' },
    correlation: 'inherited-from-predecessor',
    causation: 'most-recent-prior-movement-on-the-same-stock-row',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  {
    fn: 'phoenix_approve_warehouse_stock_correction', group: 'H', migration: 133,
    ledgers: ['warehouse_stock_movements'],
    reasonCode: { kind: 'literal', value: 'corrected' },
    correlation: 'inherited-from-predecessor',
    causation: 'most-recent-prior-movement-on-the-same-stock-row',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
  // ── Group I — outlet return receive (found by this guard) ───────────────
  {
    fn: 'phoenix_receive_outlet_return_shipment_line', group: 'I', migration: 135,
    ledgers: ['warehouse_stock_movements', 'warehouse_quarantine_stock_movements'],
    reasonCode: { kind: 'propagated', from: 'outlet_return_request_lines.reason_code' },
    correlation: 'inherited-from-predecessor',
    causation: 'outlet_return_shipment_lines.source_movement_id',
    idempotency: 'request_fingerprint', concurrency: 'advisory-lock+row-lock',
    clientCallable: true,
  },
]);

export interface ExcludedWriter {
  fn: string;
  ledger: string;
  reason: string;
}

/**
 * Writers that touch a NON-contract ledger. Listed explicitly so the guard
 * can tell "reviewed and deliberately out of scope" apart from "unknown".
 */
export const EXCLUDED_WRITERS: readonly ExcludedWriter[] = Object.freeze([
  {
    fn: 'phoenix_apply_manual_availability_movement_internal',
    ledger: 'item_availability_movements',
    reason:
      'Dead projection ledger: no contract columns, no canonical event-capture ' +
      'trigger, zero rows after a full replay. Function is owner-only (never ' +
      'granted to authenticated or service_role) and 080/085 revoke its ' +
      'manual-availability callers.',
  },
  {
    fn: 'phoenix_update_inter_org_exchange_status',
    ledger: 'item_availability_movements',
    reason:
      'Same dead projection ledger. Writes an availability projection row for ' +
      'the inter-org exchange workflow; moves no canonical quantity and emits ' +
      'no canonical movement event.',
  },
]);

/** Fast lookups. Built once; never derived from disk. */
const BY_FN: ReadonlyMap<string, ReviewedWriter> = new Map(
  REVIEWED_MOVEMENT_WRITERS.map(w => [w.fn, w]),
);
const EXCLUDED_BY_FN: ReadonlyMap<string, ExcludedWriter> = new Map(
  EXCLUDED_WRITERS.map(w => [w.fn, w]),
);

export const reviewedWriter = (fn: string): ReviewedWriter | undefined => BY_FN.get(fn);
export const isReviewedWriter = (fn: string): boolean => BY_FN.has(fn);
export const excludedWriter = (fn: string): ExcludedWriter | undefined => EXCLUDED_BY_FN.get(fn);
export const isExcludedWriter = (fn: string): boolean => EXCLUDED_BY_FN.has(fn);

/** Every function name the registry knows about, reviewed or excluded. */
export const KNOWN_WRITER_NAMES: readonly string[] = Object.freeze([
  ...REVIEWED_MOVEMENT_WRITERS.map(w => w.fn),
  ...EXCLUDED_WRITERS.map(w => w.fn),
]);

export const writersInGroup = (group: string): readonly ReviewedWriter[] =>
  REVIEWED_MOVEMENT_WRITERS.filter(w => w.group === group);

/** The domain groups the contract is organised into, in slice order. */
export const CONTRACT_GROUPS: readonly string[] = Object.freeze([
  'A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I',
]);
