/**
 * INVENTORY-DERIVED-AVAILABILITY-083 — the unified client read of physical
 * availability.
 *
 * Every consumer that wants to know "what is actually on hand at this outlet"
 * reads it HERE, through the server-authoritative projection
 * `phoenix_available_stock` (migration 083 Part B), instead of trusting a
 * possibly-stale or hand-edited `item_availability.quantity`. The RPC derives
 * availability ONLY from canonical `outlet_stock`: it aggregates every batch/lot
 * without double counting, excludes expired/missing from `usableQuantity`, and
 * derives condition through the audited 067 policy. It is RLS-scoped — a
 * forbidden point and a nonexistent one return the SAME empty result, so this
 * function can never be used to probe existence off-scope.
 *
 * This module never writes. The projection is read-only by construction (the RPC
 * is STABLE and holds no write privilege); this wrapper only shapes the payload.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';

/** One material identity's derived availability at an outlet. camelCase view of
 *  the RPC's per-lot JSON object. */
export interface AvailableStockItem {
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  /** Physical on-hand (pre-reservation) summed across the lot. */
  onHandQuantity: number;
  /** on_hand − reserved, the sellable balance the projection reports. */
  availableQuantity: number;
  /** availableQuantity with expired/missing forced to 0 — the figure a consumer
   *  should surface as "usable stock". */
  usableQuantity: number;
  /** Audited 067-policy condition (available | low_stock | near_expiry | expired | missing | …). */
  condition: string;
  /** false iff condition is expired/missing. */
  isUsable: boolean;
}

export interface AvailableStockResult {
  ok: boolean;
  /** Echoes the point queried, or null for the empty/forbidden/nonexistent shape. */
  distributionPointId: string | null;
  /** Always 'canonical_projection' — a marker that this came from the derived
   *  projection, never from a manual availability write. */
  source: string;
  items: AvailableStockItem[];
}

/** The raw per-lot object the RPC emits inside `items`. */
interface RawAvailableStockItem {
  scientific_name: string;
  trade_name: string | null;
  concentration: string | null;
  dosage_form: string | null;
  national_code: string | null;
  batch_number: string | null;
  expiry_date: string | null;
  on_hand_quantity: number | string;
  available_quantity: number | string;
  usable_quantity: number | string;
  condition: string;
  is_usable: boolean;
}

/** The whole RPC payload. */
export interface RawAvailableStockPayload {
  ok?: boolean;
  distribution_point_id?: string | null;
  source?: string;
  items?: RawAvailableStockItem[] | null;
}

/** The empty shape — identical for not-configured, forbidden, and nonexistent,
 *  so no caller can distinguish those cases (matches the RPC's own contract). */
const EMPTY_RESULT: AvailableStockResult = Object.freeze({
  ok: true,
  distributionPointId: null,
  source: 'canonical_projection',
  items: [],
});

/** Postgres `sum()` over integers returns bigint, which the driver may hand back
 *  as a string. Coerce defensively so arithmetic downstream is never string
 *  concatenation. */
function toInt(v: number | string | null | undefined): number {
  if (v === null || v === undefined) return 0;
  const n = typeof v === 'string' ? Number(v) : v;
  return Number.isFinite(n) ? n : 0;
}

/**
 * Pure mapping of the RPC's jsonb payload to the camelCase result. Exported for
 * direct behavioral coverage; `getAvailableStock` is just this over the wire.
 * A malformed/absent payload maps to the empty shape rather than throwing.
 */
export function mapAvailableStock(payload: RawAvailableStockPayload | null | undefined): AvailableStockResult {
  if (!payload || typeof payload !== 'object') return EMPTY_RESULT;
  const items = Array.isArray(payload.items) ? payload.items : [];
  return {
    ok: payload.ok ?? true,
    distributionPointId: payload.distribution_point_id ?? null,
    source: payload.source ?? 'canonical_projection',
    items: items.map((r) => ({
      scientificName: r.scientific_name,
      tradeName: r.trade_name ?? null,
      concentration: r.concentration ?? null,
      dosageForm: r.dosage_form ?? null,
      nationalCode: r.national_code ?? null,
      batchNumber: r.batch_number ?? null,
      expiryDate: r.expiry_date ?? null,
      onHandQuantity: toInt(r.on_hand_quantity),
      availableQuantity: toInt(r.available_quantity),
      usableQuantity: toInt(r.usable_quantity),
      condition: r.condition,
      isUsable: r.is_usable,
    })),
  };
}

/** The injectable transport seam — a fake in tests, `supabase.rpc` in prod. */
export interface AvailabilityProjectionRpc {
  (fn: 'phoenix_available_stock', args: { p_distribution_point_id: string }): Promise<{
    data: RawAvailableStockPayload | null;
    error: { message?: string } | null;
  }>;
}

const defaultRpc: AvailabilityProjectionRpc = async (fn, args) => {
  const { data, error } = await supabase.rpc(fn, args);
  return { data: (data as RawAvailableStockPayload | null) ?? null, error };
};

/**
 * Read the canonical, derived availability for one outlet. Empty (never an
 * error) when Supabase is not configured or no point is supplied, matching the
 * forbidden/nonexistent empty shape so call sites need only one code path.
 * A genuine RPC error is thrown, not swallowed.
 */
export async function getAvailableStock(
  distributionPointId: string | null | undefined,
  rpc: AvailabilityProjectionRpc = defaultRpc,
): Promise<AvailableStockResult> {
  if (!supabaseConfigured || !distributionPointId) return EMPTY_RESULT;
  const { data, error } = await rpc('phoenix_available_stock', {
    p_distribution_point_id: distributionPointId,
  });
  if (error) throw error;
  return mapAvailableStock(data);
}
