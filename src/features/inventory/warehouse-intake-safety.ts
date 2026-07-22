/**
 * WAREHOUSE-INTAKE SAFETY GATE — migration-065 accumulating-receipt concurrency.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE BLOCKER (HARD, PRE-DEPLOYMENT)
 * ────────────────────────────────────────────────────────────────────────────
 * `phoenix_receive_warehouse_stock` (migration 065) posts an ADDITIVE receipt:
 * the caller states a `p_quantity` that MOVED and the ledger appends it to the
 * batch's on-hand. Its only idempotency guard is `p_request_id` — replaying the
 * SAME request id returns the original result, and replaying it with DIFFERENT
 * arguments RAISEs `request_id_conflict`.
 *
 * That guard protects a single client retrying its own submission. It does NOT
 * protect against two INDEPENDENT submissions of the same physical receipt:
 *
 *   - Two operators on two devices each open the intake form for the same
 *     delivery, each mints its OWN random `p_request_id` (see `newRequestId`),
 *     and each posts +30. The request ids differ, so nothing collides; the
 *     ledger accumulates +60. Sixty units are now on hand for a thirty-unit
 *     delivery, and no error was ever shown.
 *   - The same happens for one operator across a reload if the form re-mints a
 *     key, or across a double-submit that outruns its own in-flight guard.
 *
 * The receipt is additive, so there is no natural upper bound the server can
 * check — unlike the 070/071 line receives, whose target line carries a
 * `pending → decided` status the RPC enforces (`dispatch_line_already_decided`,
 * `return_shipment_line_already_received`). The accumulating receipt has no such
 * per-target precondition, so the double-post is invisible.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * REQUIRED SOLUTION (server; NOT applied here — needs explicit approval)
 * ────────────────────────────────────────────────────────────────────────────
 * Add optimistic concurrency to the accumulating-receipt RPCs. In full, see
 * `docs/blocker-migration-065-accumulating-receipt-concurrency.md`. In brief:
 *
 *   1. Add a per-batch monotonic generation the server owns — e.g. a
 *      `warehouse_stock.movement_seq bigint` incremented in the same statement
 *      as every posted movement (or reuse `on_hand_quantity` as the generation
 *      when the batch already exists).
 *   2. Add an OPTIONAL `p_expected_generation bigint` parameter to
 *      `phoenix_receive_warehouse_stock` and to the additive modes of
 *      `phoenix_apply_warehouse_stock_movement`.
 *   3. Under the existing per-request advisory lock, AFTER resolving/locking the
 *      target `warehouse_stock` row, compare `p_expected_generation` to the
 *      row's current generation. If the caller supplied one and it does not
 *      match, RAISE `warehouse_receipt_generation_conflict` (SQLSTATE 40001) so
 *      the client must reload canonical state and re-confirm before re-posting.
 *      A brand-new batch has generation 0; the first poster commits and advances
 *      it, the second poster's stale expected-0 then conflicts under the lock.
 *   4. The client passes the generation it last read canonically as
 *      `p_expected_generation` — exactly the `generation` axis the derived
 *      idempotency token already carries (see `operation-token.ts`).
 *
 * Only when that migration lands may {@link MIGRATION_065_CONCURRENCY_RESOLVED}
 * be flipped to `true`, in the SAME commit, so the gate below opens.
 *
 * ────────────────────────────────────────────────────────────────────────────
 * THE GATE
 * ────────────────────────────────────────────────────────────────────────────
 * Until the blocker is resolved, the accumulating-receipt path must not run in
 * a PRODUCTION build. Development and test builds keep it enabled so the feature
 * can be built and exercised. This mirrors the dead-code-folding gate pattern in
 * `qaConfig.ts`: in a production build Vite replaces `import.meta.env.PROD` with
 * the literal `true`, so {@link warehouseIntakeAllowed} folds to `false` and the
 * write path fails closed before it can touch the ledger.
 */

/** Marker asserted present by the pre-deployment safety test. Do not rename. */
export const MIGRATION_065_CONCURRENCY_BLOCKER =
  'PHOENIX_BLOCKER_MIGRATION_065_ACCUMULATING_RECEIPT_CONCURRENCY';

/**
 * RESOLVED (Stage C activation, 2026-07-22). The required server contract is
 * live and verified in production: migration 078 added the per-batch
 * `warehouse_stock.movement_seq` generation plus the guarded RPCs, and 079
 * makes them REFUSE a NULL expected generation. In the SAME commit as this
 * flip, every production call site (manual IntakeForm, BatchRow adjustment,
 * OCR confirmAndSubmit) performs a fresh canonical generation read immediately
 * before posting — an absent lot is generation 0, and ANY failed read refuses
 * without touching a writer (see getWarehouseReceiptLotGeneration /
 * getWarehouseStockGeneration in warehouse-intake.service.ts).
 */
export const MIGRATION_065_CONCURRENCY_RESOLVED = true;

/** Error code returned by the intake service when the gate is closed. */
export const WAREHOUSE_INTAKE_BLOCKED_CODE = 'blocked_migration_065_concurrency';

/**
 * Pure gate decision. The accumulating-receipt path is allowed when the blocker
 * is resolved, OR when this is not a production build (dev/test/beta, where the
 * feature must remain buildable and testable).
 *
 * Kept pure and side-effect-free so the safety test can prove the whole truth
 * table — most importantly that an unresolved blocker in a production build is
 * NEVER allowed.
 */
export function warehouseIntakeAllowed(env: {
  isProd: boolean;
  blockerResolved: boolean;
}): boolean {
  return env.blockerResolved || !env.isProd;
}

/**
 * The live gate for this build. In a production build `import.meta.env.PROD` is
 * the literal `true`, so with the blocker unresolved this folds to `false`.
 */
export function defaultWarehouseIntakeAllowed(): boolean {
  return warehouseIntakeAllowed({
    isProd: import.meta.env.PROD === true,
    blockerResolved: MIGRATION_065_CONCURRENCY_RESOLVED,
  });
}
