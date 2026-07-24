import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { mapOrder, type OrderRow, type ReceiptRow, type ReceiptLineRow } from '@/features/procurement/procurement.service';

/**
 * DECISION-INTELLIGENCE-REPORTS — "Supplementary Purchases" traceability
 * section.
 *
 * procurement_orders/procurement_receipts/procurement_receipt_lines (087/
 * 089) ARE the supplementary-purchase corridor already — every row under
 * this module is a supplementary purchase by construction, so no
 * purchase_origin filter is needed or possible here (that column lives on
 * warehouse_stock/outlet_stock, stamped once the receipt posts).
 *
 * getOrders() in procurement.service.ts requires a warehouseId (the
 * operational per-warehouse screen's own scope); this adds the ONE missing
 * org-wide list, still against the SAME table and the SAME RLS
 * (phoenix_can_read_local_procurement) every operational read already goes
 * through — no new grant, no new policy. getReceipts/getReceiptLines are
 * reused UNCHANGED for the order->receipt->line drill-down.
 */
export async function listSupplementaryPurchaseOrders(organizationId: string): Promise<OrderRow[]> {
  if (!supabaseConfigured) return [];
  const { data, error } = await supabase
    .from('procurement_orders')
    .select('*')
    .eq('organization_id', organizationId)
    .order('created_at', { ascending: false })
    .limit(200);
  if (error) throw new Error(error.message);
  return (data ?? []).map(mapOrder);
}

export type { OrderRow, ReceiptRow, ReceiptLineRow };
