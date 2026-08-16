import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/**
 * QUARANTINE-DISPOSITION — thin client over migration 099's quarantine ledger
 * and disposition RPCs.
 *
 * Reads are RLS-scoped SELECTs (105 widened the policy so warehouse_officer,
 * not just central_warehouse_manager, can see what they are authorized to
 * release/destroy). Every mutation is a SECURITY DEFINER RPC that re-checks
 * warehouse scope and the warehouse_transfer.return_request permission
 * server-side — nothing here writes a table directly.
 */

/**
 * R1.5-E: carries the CANONICAL lot-identity dimensions.
 * `materialIdentityKey` is migration 150's GENERATED ALWAYS STORED column on
 * warehouse_quarantine_stock, read as data and never recomputed client-side.
 *
 * `quarantineReason` stays part of THIS row (wqs_identity_uniq includes it,
 * because one physical lot can be held under two different reasons) but is
 * deliberately NOT part of destination lot identity — warehouse_stock has no
 * such dimension. See `stock-identity.ts`.
 */
export interface QuarantineStockRow {
  id: string;
  warehouseId: string;
  scientificName: string;
  batchNumber: string | null;
  nationalCode: string | null;
  expiryDate: string | null;
  quarantineReason: string;
  quantity: number;
  materialIdentityKey: string | null;
  internalBatchReference: string | null;
  supplyType: string | null;
  purchaseOrigin: string | null;
}

interface QuarantineStockDbRow {
  id: string; warehouse_id: string; scientific_name: string;
  batch_number: string | null; national_code: string | null;
  expiry_date: string | null; quarantine_reason: string; quantity: number;
  material_identity_key: string | null;
  internal_batch_reference: string | null;
  supply_type: string | null;
  purchase_origin: string | null;
}

/** Currently-held quarantine lots at one warehouse, newest quarantine first. */
export async function getQuarantineStock(warehouseId: string): Promise<QuarantineStockRow[]> {
  if (!supabaseConfigured || !warehouseId) return [];
  const { data, error } = await supabase
    .from('warehouse_quarantine_stock')
    .select('id, warehouse_id, scientific_name, batch_number, national_code, expiry_date, quarantine_reason, quantity, material_identity_key, internal_batch_reference, supply_type, purchase_origin')
    .eq('warehouse_id', warehouseId)
    .gt('quantity', 0)
    .order('expiry_date', { ascending: true, nullsFirst: false });
  if (error) throw error;
  return (data as QuarantineStockDbRow[] | null ?? []).map(r => ({
    id: r.id, warehouseId: r.warehouse_id, scientificName: r.scientific_name,
    batchNumber: r.batch_number, nationalCode: r.national_code,
    expiryDate: r.expiry_date, quarantineReason: r.quarantine_reason, quantity: r.quantity,
    // Straight through — a missing canonical key stays null and the release
    // picker then offers nothing, rather than guessing from material fields.
    materialIdentityKey: r.material_identity_key,
    internalBatchReference: r.internal_batch_reference,
    supplyType: r.supply_type,
    purchaseOrigin: r.purchase_origin,
  }));
}

export interface RpcResult<T = Record<string, unknown>> {
  ok: boolean;
  data?: T;
  error?: string;
}

function rpcErrorCode(message: string | undefined): string {
  if (!message) return 'unknown_error';
  const match = /[a-z][a-z0-9_]{3,}/.exec(message);
  return match ? match[0] : 'unknown_error';
}

async function callRpc<T = Record<string, unknown>>(fn: string, args: Record<string, unknown>): Promise<RpcResult<T>> {
  if (!supabaseConfigured) return { ok: false, error: 'not_configured' };
  const { data, error } = await supabase.rpc(fn, args);
  if (error) return { ok: false, error: rpcErrorCode(error.message) };
  const payload = (data ?? {}) as { ok?: boolean } & T;
  return { ok: payload.ok !== false, data: payload as T };
}

/**
 * Releases quarantined quantity back into a NAMED, existing dispensable
 * warehouse_stock lot — never a substitution; the server refuses unless the
 * destination lot's material/batch/expiry identity matches the quarantine row
 * exactly.
 */
export function releaseQuarantineStock(input: {
  requestId: string; quarantineStockId: string; quantity: number;
  reason: string; destinationWarehouseStockId: string;
}): Promise<RpcResult<{ movement_id?: string }>> {
  return callRpc('phoenix_release_quarantine_stock', {
    p_request_id: input.requestId,
    p_quarantine_stock_id: input.quarantineStockId,
    p_quantity: input.quantity,
    p_reason: input.reason,
    p_destination_warehouse_stock_id: input.destinationWarehouseStockId,
  });
}

/** Permanently destroys quarantined quantity. No credit anywhere — irreversible. */
export function destroyQuarantineStock(input: {
  requestId: string; quarantineStockId: string; quantity: number; reason: string;
}): Promise<RpcResult<{ movement_id?: string }>> {
  return callRpc('phoenix_destroy_quarantine_stock', {
    p_request_id: input.requestId,
    p_quarantine_stock_id: input.quarantineStockId,
    p_quantity: input.quantity,
    p_reason: input.reason,
  });
}
