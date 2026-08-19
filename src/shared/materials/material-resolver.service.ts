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
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * G3.2 — WHAT CHANGED, AND WHY
 * ─────────────────────────────────────────────────────────────────────────────
 * Three defects were closed here. None of them needed a migration; all three
 * were this module declining to read contracts the database already had.
 *
 *  A. CATALOG IDENTITY WAS DISCARDED (G3.2-GAP-01).
 *     Migration 114 added `trade_name`, `concentration` and `dosage_form` to
 *     `central_items`. This module went on hard-coding all three to null, so
 *     two strengths of one molecule came back rendering IDENTICALLY and the
 *     operator picked between them blind. They are now read and returned. A
 *     field that is genuinely NULL on the row still returns null — the fix is
 *     to stop discarding real data, not to start inventing it.
 *
 *  B. INACTIVE CATALOG ROWS WERE SELECTABLE (G3.2-GAP-02).
 *     `status` was selected and never filtered, so a `discontinued` material
 *     could be proposed for an operational line. `registry.searchCentralItems`
 *     had always filtered it; this module had not. It now does. This is an
 *     intentional narrowing: fewer results, and the ones that remain are usable.
 *
 *  C. STOCK RESULTS CARRIED NO STRUCTURAL POSITION (G3.2-GAP-05).
 *     A lot came back with a `warehouse_stock.id` and nothing to say which
 *     organization, warehouse or health-centre facility it sat in. The lot rows
 *     now carry `organization_id`, `warehouse_id`, `central_item_id` and
 *     Migration 150's generated `material_identity_key`, and the warehouse's
 *     own structural row is read once to resolve facility + sector role.
 *
 * WHAT DID NOT CHANGE, DELIBERATELY:
 *   - No new authorization filter. RLS, Migration 182's facility-scoped RBAC
 *     and Migration 187's delegated operational access remain the ONLY
 *     authorities on what this caller may read. Everything added here is
 *     descriptive: it reports the structure of rows the server already
 *     returned. A client-side field is not a security boundary.
 *   - `material_identity_key` is never computed here. See search-contract.ts.
 *   - The public audience still never reaches lot-level stock.
 */
import { supabase, supabaseConfigured } from '@/shared/supabase/client';
import { normalizeSearchText } from '@/shared/lib/search-normalize';
import { escapePostgrestIlikeValue } from '@/shared/supabase/services/availability.service';
import { displaySupplyType, type CanonicalSupplyType } from '@/shared/lib/supply-types';
import {
  classifyWarehouseSectorRole,
  type CanonicalMaterialResult,
  type MaterialScope,
  type WarehouseSectorRole,
} from './search-contract';

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
  /**
   * G3.2 — the same result expressed under the canonical contract, with
   * IDENTITY / SCOPE / DISPLAY / ELIGIBILITY kept apart.
   *
   * The flat fields above are retained unchanged so existing consumers keep
   * working; new work should read `canonical`. They are two views of ONE
   * result, never two sources of truth: `canonical` is built from the same row
   * in the same pass, never re-derived from the flat fields.
   */
  canonical: CanonicalMaterialResult;
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
  /** 114 — catalog identity detail. Nullable; super_admin-maintained. */
  trade_name?: string | null; concentration?: string | null; dosage_form?: string | null;
}

interface StockRow {
  id: string; scientific_name: string; trade_name: string | null;
  concentration: string | null; dosage_form: string | null; unit: string | null;
  national_code: string | null; batch_number: string | null; expiry_date: string | null;
  on_hand_quantity: number; reserved_quantity: number; available_quantity: number;
  supply_type_text: string | null;
  /** 150 — GENERATED ALWAYS STORED. Read, never computed. */
  material_identity_key?: string | null;
  /** 150 — catalog linkage, where the lot has one. */
  central_item_id?: string | null;
  organization_id?: string | null;
  warehouse_id?: string | null;
}

/**
 * The structural row behind a warehouse scope, read ONCE per resolve call.
 *
 * `organizations` is embedded because the sector role cannot be decided from
 * the warehouse alone: Migration 181's rule applies only inside an organization
 * whose `institution_class` is 'health_sector'. Reading the warehouse without
 * its organization is exactly how `facility_id IS NULL` gets misread as
 * "sector main" in a hospital.
 */
interface WarehouseContextRow {
  id: string;
  organization_id: string | null;
  facility_id: string | null;
  warehouse_kind: string | null;
  is_main: boolean | null;
  organizations?:
    | { organization_kind: string | null; institution_class: string | null }
    | Array<{ organization_kind: string | null; institution_class: string | null }>
    | null;
}

interface ResolvedWarehouseContext {
  organizationId: string | null;
  facilityId: string | null;
  sectorRole: WarehouseSectorRole;
}

/** Neutral context: known-nothing, claims nothing. */
const UNKNOWN_WAREHOUSE_CONTEXT: ResolvedWarehouseContext = {
  organizationId: null,
  facilityId: null,
  sectorRole: 'unclassified',
};

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

/** Blank-safe trim: '' and whitespace collapse to null, never to a value. */
function textOrNull(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * Read the structural row behind a warehouse scope.
 *
 * Failure is NEVER fatal and never throws: a caller that cannot read the
 * warehouse row (RLS, a stale id, a transport error) still gets its material
 * results, with an honestly unknown structural context rather than a guessed
 * one. Search must not become unusable because a descriptive lookup failed.
 */
async function loadWarehouseContext(
  warehouseId: string,
  signal?: AbortSignal,
): Promise<ResolvedWarehouseContext> {
  try {
    let query = supabase
      .from('warehouses')
      .select('id, organization_id, facility_id, warehouse_kind, is_main, organizations(organization_kind, institution_class)')
      .eq('id', warehouseId)
      .limit(1);
    if (signal) query = query.abortSignal(signal);

    const { data, error } = await query;
    if (error) return UNKNOWN_WAREHOUSE_CONTEXT;

    const row = ((data ?? []) as unknown as WarehouseContextRow[])[0];
    if (!row) return UNKNOWN_WAREHOUSE_CONTEXT;

    const org = Array.isArray(row.organizations) ? row.organizations[0] : row.organizations;

    return {
      organizationId: row.organization_id ?? null,
      facilityId: row.facility_id ?? null,
      // DECISION D: the role is decided by organization class + warehouse shape.
      // A null facility_id on its own proves nothing and is never read as
      // "sector main" here.
      sectorRole: classifyWarehouseSectorRole({
        organizationKind: org?.organization_kind ?? null,
        institutionClass: org?.institution_class ?? null,
        warehouseKind: row.warehouse_kind,
        facilityId: row.facility_id,
        isMain: row.is_main,
      }),
    };
  } catch {
    return UNKNOWN_WAREHOUSE_CONTEXT;
  }
}

/** True when a 'YYYY-MM-DD' expiry is strictly in the past. Text comparison only. */
function isExpiredDate(expiryDate: string | null, today: string): boolean {
  return Boolean(expiryDate) && (expiryDate as string) < today;
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
  //
  // G3.2-GAP-01: 114's trade_name / concentration / dosage_form are read here.
  // G3.2-GAP-02: only ACTIVE catalog rows are operationally selectable.
  const catalogOr = [
    `name.ilike.${ilikeRaw}`, `name_ar.ilike.${ilikeRaw}`,
    `name.ilike.${ilikeNorm}`, `name_ar.ilike.${ilikeNorm}`,
  ];
  if (!isPublic) catalogOr.unshift(`barcode.eq.${JSON.stringify(raw)}`);
  let catalogQuery = supabase
    .from('central_items')
    .select('id, name, name_ar, barcode, unit, status, trade_name, concentration, dosage_form')
    .eq('status', 'active')
    .or(catalogOr.join(','))
    .limit(limit);
  if (opts.signal) catalogQuery = catalogQuery.abortSignal(opts.signal);

  // 3 — canonical stock lots inside the given warehouse scope (RLS re-scopes).
  // Never for a public audience: lot-level batch/on-hand is not public data,
  // and national-code / batch lookups are operator-only.
  const stockScopeActive = Boolean(opts.warehouseId) && !isPublic;
  const stockPromise = stockScopeActive
    ? (() => {
        let q = supabase
          .from('warehouse_stock')
          .select('id, scientific_name, trade_name, concentration, dosage_form, unit, national_code, batch_number, expiry_date, on_hand_quantity, reserved_quantity, available_quantity, supply_type_text, material_identity_key, central_item_id, organization_id, warehouse_id')
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

  // G3.2-GAP-05: the warehouse's own structural row, read only when a stock
  // scope is actually in play. A public visitor and a catalog-only search do
  // not read it — there is nothing for it to describe.
  const contextPromise = stockScopeActive
    ? loadWarehouseContext(opts.warehouseId as string, opts.signal)
    : Promise.resolve(UNKNOWN_WAREHOUSE_CONTEXT);

  const [catalog, stock, warehouseContext] = await Promise.all([catalogQuery, stockPromise, contextPromise]);
  if (catalog.error) throw catalog.error;
  if ((stock as { error: unknown }).error) throw (stock as { error: Error }).error;

  const today = new Date().toISOString().slice(0, 10);
  const results: ResolvedMaterial[] = [];

  for (const row of ((catalog.data ?? []) as CatalogRow[])) {
    const { grade, reasonKey } = gradeCatalog(row, raw, norm);

    // DECISION A: for a catalog row the national-code semantic IS `barcode`.
    // Migration 114 states this contract explicitly and declines to add a
    // duplicate column; the owner reaffirmed it for G3.2. The database column
    // keeps its historical name — only this semantic field unifies catalog and
    // lot. Do not silently reinterpret `barcode` as a bare GTIN here.
    const catalogNationalCode = textOrNull(row.barcode);
    // 114's real trade_name wins. `name_ar` remains a fallback ALTERNATE NAME
    // for rows that predate 114 and have none — it is not "the trade name".
    const tradeName = textOrNull(row.trade_name) ?? textOrNull(row.name_ar);
    const concentration = textOrNull(row.concentration);
    const dosageForm = textOrNull(row.dosage_form);
    const unit = textOrNull(row.unit);
    // The query already restricts to active rows; this reflects the row rather
    // than assuming the filter, so a contract change cannot silently pass.
    // G3.2 FAIL-CLOSED: `status` is OPTIONAL on CatalogRow, so it can arrive
    // undefined as well as null. Neither is promoted to active. A missing
    // status is not evidence of an active material, and defaulting it to
    // active is precisely the permissive reading that would let an inactive
    // or unfiltered catalog row become operationally selectable.
    const active = row.status === 'active';

    results.push({
      source: 'catalog', centralItemId: row.id, warehouseStockId: null,
      scientificName: row.name, tradeName,
      concentration, dosageForm, unit,
      nationalCode: catalogNationalCode, barcode: textOrNull(row.barcode),
      batchNumber: null, expiryDate: null,
      onHand: null, reserved: null, available: null,
      supplyType: null, grade, reasonKey,
      canonical: {
        identity: {
          centralItemId: row.id,
          materialIdentityKey: null,
          warehouseStockId: null,
          outletStockId: null,
        },
        // DECISION E: a catalog hit has no operational position. Nothing is
        // fabricated to fill the shape.
        scope: { kind: 'catalog' },
        display: {
          scientificName: row.name,
          tradeName,
          concentration,
          dosageForm,
          unit,
          nationalCode: catalogNationalCode,
          batchNumber: null,
          expiryDate: null,
        },
        eligibility: {
          selectable: active,
          active,
          availableQuantity: null,
          expired: null,
          blockedReasonKey: null,
        },
      },
    });
  }

  for (const row of (((stock as { data: StockRow[] | null }).data ?? []) as StockRow[])) {
    const { grade, reasonKey } = gradeStock(row, raw, norm);
    const expired = isExpiredDate(row.expiry_date, today);
    const available = row.available_quantity;
    const selectable = !expired && available > 0;

    const organizationId = row.organization_id ?? warehouseContext.organizationId;
    const warehouseId = row.warehouse_id ?? (opts.warehouseId ?? null);

    // A warehouse scope whose ids are known is reported as a warehouse scope,
    // with an honestly null facility when the structural row could not be read.
    // When even the ids are unknown the result declares no operational position
    // rather than asserting a half-built one.
    const scope: MaterialScope = (organizationId && warehouseId)
      ? {
          kind: 'warehouse',
          organizationId,
          warehouseId,
          facilityId: warehouseContext.facilityId,
          sectorRole: warehouseContext.sectorRole,
        }
      : { kind: 'catalog' };

    results.push({
      source: 'stock', centralItemId: row.central_item_id ?? null, warehouseStockId: row.id,
      scientificName: row.scientific_name, tradeName: row.trade_name,
      concentration: row.concentration, dosageForm: row.dosage_form, unit: row.unit,
      nationalCode: row.national_code, barcode: null,
      batchNumber: row.batch_number, expiryDate: row.expiry_date,
      onHand: row.on_hand_quantity, reserved: row.reserved_quantity,
      available,
      supplyType: displaySupplyType(row.supply_type_text), grade, reasonKey,
      canonical: {
        identity: {
          centralItemId: row.central_item_id ?? null,
          // 150's generated column, carried verbatim. Never computed here.
          materialIdentityKey: row.material_identity_key ?? null,
          warehouseStockId: row.id,
          outletStockId: null,
        },
        scope,
        display: {
          scientificName: row.scientific_name,
          tradeName: row.trade_name,
          concentration: row.concentration,
          dosageForm: row.dosage_form,
          unit: row.unit,
          nationalCode: row.national_code,
          batchNumber: row.batch_number,
          expiryDate: row.expiry_date,
        },
        eligibility: {
          selectable,
          active: true,
          availableQuantity: available,
          expired,
          blockedReasonKey: expired
            ? 'mv_e_expired_not_dispatchable'
            : (available > 0 ? null : 'mv_e_quantity_exceeds_available'),
        },
      },
    });
  }

  results.sort((a, b) => GRADE_ORDER[a.grade] - GRADE_ORDER[b.grade]);
  return results.slice(0, limit);
}
