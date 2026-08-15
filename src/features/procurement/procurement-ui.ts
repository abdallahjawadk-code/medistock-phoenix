import type { OrderStatus } from './procurement.service';

/** INSTITUTION-LOCAL-PROCUREMENT-087 — shared presentation helpers. */

export const STATUS_LABEL_KEY: Record<OrderStatus, string> = {
  draft: 'lp_status_draft',
  submitted: 'lp_status_submitted',
  approved: 'lp_status_approved',
  rejected: 'lp_status_rejected',
  partially_received: 'lp_status_partially_received',
  received: 'lp_status_received',
  cancelled: 'lp_status_cancelled',
};

/** Semantic tone per status for badges (maps to existing CSS variables). */
export const STATUS_TONE: Record<OrderStatus, { bg: string; fg: string }> = {
  draft: { bg: 'var(--s)', fg: 'var(--t2)' },
  submitted: { bg: 'var(--p2)', fg: 'var(--pd)' },
  approved: { bg: 'var(--ok2)', fg: 'var(--ok)' },
  rejected: { bg: 'var(--err2)', fg: 'var(--err)' },
  partially_received: { bg: 'var(--p2)', fg: 'var(--pd)' },
  received: { bg: 'var(--ok2)', fg: 'var(--ok)' },
  cancelled: { bg: 'var(--s)', fg: 'var(--t2)' },
};

/**
 * Map an RPC error token to a translated message key. Unknown tokens fall back
 * to lp_err_unknown — the raw token is still logged by the service layer.
 */
const ERROR_KEY: Record<string, string> = {
  not_configured: 'lp_err_offline',
  not_authenticated: 'lp_err_denied',
  forbidden_local_procurement_manage: 'lp_err_denied',
  forbidden_local_procurement_approve: 'lp_err_denied',
  forbidden_local_procurement_receive: 'lp_err_denied',
  forbidden_local_procurement_return: 'lp_err_denied',
  active_profile_required: 'lp_err_denied',
  supplier_name_exists: 'lp_err_supplier_exists',
  supplier_name_required: 'lp_err_name_required',
  supplier_inactive: 'lp_err_supplier_inactive',
  order_number_exists: 'lp_err_order_number_exists',
  order_number_required: 'lp_err_order_number_required',
  order_has_no_lines: 'lp_err_no_lines',
  order_not_draft: 'lp_err_not_draft',
  order_not_submitted: 'lp_err_not_submitted',
  order_not_receivable: 'lp_err_not_receivable',
  order_not_cancellable: 'lp_err_not_cancellable',
  approver_must_differ_from_submitter: 'lp_err_sod',
  quantity_must_be_positive: 'lp_err_quantity',
  received_quantity_exceeds_ordered: 'lp_err_over_receipt',
  batch_number_flag_mismatch: 'lp_err_batch_flag',
  duplicate_order_line_in_payload: 'lp_err_duplicate_line',
  request_id_conflict: 'lp_err_request_conflict',
  procurement_order_generation_conflict: 'lp_err_stale',
  warehouse_stock_generation_conflict: 'lp_err_stale',
  return_exceeds_received: 'lp_err_over_return',
  return_reason_required: 'lp_err_reason_required',
  cancel_reason_required: 'lp_err_reason_required',
  insufficient_unreserved_stock: 'lp_err_insufficient_stock',
  destination_must_be_active_institution_warehouse: 'lp_err_warehouse',
  warehouse_not_found: 'lp_err_warehouse',
  /**
   * R1.3 (184) — a health sector may open a local procurement order ONLY at its
   * Sector Main; a facility-bound Health Center depot is never an entry root.
   * Mapped to the same "this warehouse cannot be used" message as 087's own
   * warehouse refusals, so the operator sees a real explanation instead of
   * lp_err_unknown's "unexpected error".
   */
  local_procurement_root_must_be_sector_main: 'lp_err_warehouse',
  supplier_not_found: 'lp_err_supplier_missing',
  order_not_found: 'lp_err_missing',
  order_line_not_found: 'lp_err_missing',
  receipt_line_not_found: 'lp_err_missing',
};

export function procurementErrorKey(code: string | undefined): string {
  return (code && ERROR_KEY[code]) || 'lp_err_unknown';
}

export const dash = (v: string | number | null | undefined): string =>
  (v == null || v === '' ? '—' : String(v));
