/**
 * PHOENIX-MATERIAL-RESOLVER — THE one material identification service.
 *
 * Every screen that lets an operator pick a material resolves it HERE, against
 * the registered catalog (central_items) and — when a warehouse scope is given
 * — the RLS-scoped canonical stock lots. Free text is ONLY a filter: nothing
 * in this module can create a material, and OCR/fuzzy hits can never write
 * stock or register identity (they only ever *select* an existing record).
 *
 * Recognition inputs: scientific name, trade name, national code, batch
 * number, medicine barcode/GS1. Match order and grading:
 *   1. exact national code / barcode ............ grade 'confirmed'
 *   2. exact-normalized or prefix name .......... grade 'strong'
 *   3. batch number inside the stock scope ...... grade 'probable' (a batch
 *      number alone is NEVER a unique identity — all hits are shown)
 *   4. partial/fuzzy (normalized substring) ..... grade 'probable'
 *   otherwise ................................... 'unknown' (empty result)
 *
 * All reads are server-side PostgREST queries under the caller's own RLS —
 * the full catalog is never shipped to the browser; results are capped.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { normalizeSearchText } from '@/shared/lib/search-normalize';
import { escapePostgrestIlikeValue } from '@/shared/supabase/services/availability.service';
import { displaySupplyType, type CanonicalSupplyType } from '@/shared/lib/supply-types';

export type MatchGrade = 'confirmed' | 'strong' | 'probable';

export interface ResolvedMaterial {
  /** 'catalog' = registered central item; 'stock' = canonical lot in scope. */
  source: 'catalog' | 'stock';
  centralItemId: string | null;
  warehouseStockId: string | null;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  barcode: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  onHand: number | null;
  reserved: number | null;
  available: number | null;
  /** Canonical display source (aid/purchase/kimadia) when known. */
  supplyType: CanonicalSupplyType | null;
  grade: MatchGrade;
  /** i18n key explaining WHY this matched. */
  reasonKey: string;
}

export interface ResolveOptions {
  /** Scope stock-lot matches (batch numbers, on-hand) to ONE warehouse. */
  warehouseId?: string | null;
  /**
   * Which identity fields a query may match.
   *   'internal' (default): scientific name, trade name, national code, batch
   *                         number and medicine barcode — the operator view.
   *   'public'  : scientific or trade NAME only. A public outlet visitor must
   *               not be able to enumerate the catalog by national code, batch
   *               number or barcode, and never sees lot-level stock. Any
   *               warehouse scope is ignored in this mode.
   */
  audience?: 'internal' | 'public';
  signal?: AbortSignal;
  limit?: number;
}

const GRADE_ORDER: Record<MatchGrade, number> = { confirmed: 0, strong: 1, probable: 2 };

interface CatalogRow {
  id: string; name: string; name_ar: string | null; barcode: string | null;
  unit: string | null; status?: string | null;
}

interface StockRow {
  id: string; scientific_name: string; trade_name: string | null;
  concentration: string | null; dosage_form: string | null; unit: string | null;
  national_code: string | null; batch_number: string | null; expiry_date: string | null;
  on_hand_quantity: number; reserved_quantity: number; available_quantity: number;
  supply_type_text: string | null;
}

function gradeCatalog(row: CatalogRow, raw: string, norm: string):
  { grade: MatchGrade; reasonKey: string } {
  if (row.barcode && row.barcode.trim() === raw) return { grade: 'confirmed', reasonKey: 'mr_reason_barcode_exact' };
  const nameN = normalizeSearchText(row.name ?? '');
  const nameArN = normalizeSearchText(row.name_ar ?? '');
  if (nameN === norm || nameArN === norm) return { grade: 'strong', reasonKey: 'mr_reason_name_exact' };
  if (nameN.startsWith(norm) || nameArN.startsWith(norm)) return { grade: 'strong', reasonKey: 'mr_reason_name_prefix' };
  return { grade: 'probable', reasonKey: 'mr_reason_name_partial' };
}

function gradeStock(row: StockRow, raw: string, norm: string):
  { grade: MatchGrade; reasonKey: string } {
  if (row.national_code && row.national_code.trim() === raw) return { grade: 'confirmed', reasonKey: 'mr_reason_national_exact' };
  if (row.batch_number && row.batch_number.trim() === raw) return { grade: 'probable', reasonKey: 'mr_reason_batch_match' };
  const sciN = normalizeSearchText(row.scientific_name ?? '');
  const tradeN = normalizeSearchText(row.trade_name ?? '');
  if (sciN === norm || tradeN === norm) return { grade: 'strong', reasonKey: 'mr_reason_name_exact' };
  if (sciN.startsWith(norm) || tradeN.startsWith(norm)) return { grade: 'strong', reasonKey: 'mr_reason_name_prefix' };
  return { grade: 'probable', reasonKey: 'mr_reason_name_partial' };
}

/**
 * Resolve registered materials for one query. Returns ALL hits ordered by
 * grade (never auto-picks); [] means 'unknown' — the caller shows the
 * "must be registered first" message and may NOT treat the text as a material.
 */
export async function resolveMaterials(rawQuery: string, opts: ResolveOptions = {}): Promise<ResolvedMaterial[]> {
  const raw = (rawQuery ?? '').trim();
  const norm = normalizeSearchText(raw);
  if (!supabaseConfigured || norm.length < 2) return [];
  const limit = opts.limit ?? 12;

  const audience = opts.audience ?? 'internal';
  const isPublic = audience === 'public';

  const ilikeRaw = escapePostgrestIlikeValue(raw);
  const ilikeNorm = escapePostgrestIlikeValue(norm);

  // 1+2+4 — the registered catalog (server-side, capped, RLS applies).
  // Public visitors may match by NAME only (scientific = name, trade = name_ar);
  // barcode-exact matching is an operator-only capability.
  const catalogOr = [
    `name.ilike.${ilikeRaw}`, `name_ar.ilike.${ilikeRaw}`,
    `name.ilike.${ilikeNorm}`, `name_ar.ilike.${ilikeNorm}`,
  ];
  if (!isPublic) catalogOr.unshift(`barcode.eq.${JSON.stringify(raw)}`);
  let catalogQuery = supabase
    .from('central_items')
    .select('id, name, name_ar, barcode, unit, status')
    .or(catalogOr.join(','))
    .limit(limit);
  if (opts.signal) catalogQuery = catalogQuery.abortSignal(opts.signal);

  // 3 — canonical stock lots inside the given warehouse scope (RLS re-scopes).
  // Never for a public audience: lot-level batch/on-hand is not public data,
  // and national-code / batch lookups are operator-only.
  const stockPromise = (opts.warehouseId && !isPublic)
    ? (() => {
        let q = supabase
          .from('warehouse_stock')
          .select('id, scientific_name, trade_name, concentration, dosage_form, unit, national_code, batch_number, expiry_date, on_hand_quantity, reserved_quantity, available_quantity, supply_type_text')
          .eq('warehouse_id', opts.warehouseId)
          .or([
            `national_code.eq.${JSON.stringify(raw)}`,
            `batch_number.eq.${JSON.stringify(raw)}`,
            `scientific_name.ilike.${ilikeRaw}`, `trade_name.ilike.${ilikeRaw}`,
            `scientific_name.ilike.${ilikeNorm}`, `trade_name.ilike.${ilikeNorm}`,
          ].join(','))
          .limit(limit);
        if (opts.signal) q = q.abortSignal(opts.signal);
        return q;
      })()
    : Promise.resolve({ data: [], error: null } as { data: StockRow[]; error: null });

  const [catalog, stock] = await Promise.all([catalogQuery, stockPromise]);
  if (catalog.error) throw catalog.error;
  if ((stock as { error: unknown }).error) throw (stock as { error: Error }).error;

  const results: ResolvedMaterial[] = [];

  for (const row of ((catalog.data ?? []) as CatalogRow[])) {
    const { grade, reasonKey } = gradeCatalog(row, raw, norm);
    results.push({
      source: 'catalog', centralItemId: row.id, warehouseStockId: null,
      scientificName: row.name, tradeName: row.name_ar,
      concentration: null, dosageForm: null, unit: row.unit ?? null,
      nationalCode: null, barcode: row.barcode ?? null,
      batchNumber: null, expiryDate: null,
      onHand: null, reserved: null, available: null,
      supplyType: null, grade, reasonKey,
    });
  }

  for (const row of (((stock as { data: StockRow[] | null }).data ?? []) as StockRow[])) {
    const { grade, reasonKey } = gradeStock(row, raw, norm);
    results.push({
      source: 'stock', centralItemId: null, warehouseStockId: row.id,
      scientificName: row.scientific_name, tradeName: row.trade_name,
      concentration: row.concentration, dosageForm: row.dosage_form, unit: row.unit,
      nationalCode: row.national_code, barcode: null,
      batchNumber: row.batch_number, expiryDate: row.expiry_date,
      onHand: row.on_hand_quantity, reserved: row.reserved_quantity,
      available: row.available_quantity,
      supplyType: displaySupplyType(row.supply_type_text), grade, reasonKey,
    });
  }

  results.sort((a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade]);
  return results.slice(0, limit);
}
