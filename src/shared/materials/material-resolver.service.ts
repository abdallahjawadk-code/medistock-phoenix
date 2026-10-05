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
  /**
   * PRE3-A — the catalog row's own Arabic/alternate name (`central_items.name_ar`),
   * reported separately so a picker can show it as its own discriminator. Null
   * for a stock lot (which has none) and for a catalog row without one.
   * Optional so existing result literals keep compiling unchanged.
   */
  nameAr?: string | null;
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
  // PRE3-A: 114's trade_name is graded exactly like the stock lot's trade name
  // already is (gradeStock below) — a name, never a code.
  const tradeN = normalizeSearchText(row.trade_name ?? '');
  if (nameN === norm || nameArN === norm || tradeN === norm) return { grade: 'strong', reasonKey: 'mr_reason_name_exact' };
  if (nameN.startsWith(norm) || nameArN.startsWith(norm) || tradeN.startsWith(norm)) return { grade: 'strong', reasonKey: 'mr_reason_name_prefix' };
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
 * One registered catalog row as a resolver result — the ONE mapping both the
 * search (resolveMaterials) and the exact-candidate mode use.
 */
function catalogResult(row: CatalogRow, raw: string, norm: string): ResolvedMaterial {
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

  return {
    source: 'catalog', centralItemId: row.id, warehouseStockId: null,
    scientificName: row.name, nameAr: textOrNull(row.name_ar), tradeName,
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
  };
}

/** The catalog columns every resolver read selects. */
const CATALOG_SELECT = 'id, name, name_ar, barcode, unit, status, trade_name, concentration, dosage_form';

// ─────────────────────────────────────────────────────────────────────────────
// PRE3-A — ARABIC SPELLING VARIANTS MATCH IN BOTH DIRECTIONS
//
// `normalizeSearchText` folds the QUERY (أ إ آ ٱ → ا, ة → ه, ى ئ → ي, ؤ → و,
// harakat / tatweel dropped), but ILIKE compares that against the STORED text
// as written. Folding one side only is directional: 'إيبوبروفين' found a row
// stored as 'ايبوبروفين', yet 'ايبوبروفين' never found a row stored as
// 'إيبوبروفين', nor one stored with harakat or tatweel.
//
// The comparison stays on the server, on the existing columns, through an
// operator PostgREST already exposes (`imatch` = PostgreSQL `~*`): the
// normalized query becomes a regex in which every folded letter accepts every
// spelling `normalizeSearchText` folds to it, and harakat/tatweel may follow
// any non-ASCII character. The filter, the order and the LIMIT all run over the
// symmetric match set — nothing is fetched in order to be filtered here. No
// migration, function or index is involved; the ILIKE terms are unchanged.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Folded letter → every stored spelling `normalizeSearchText` folds to it — its
 * normalizeChar table read backwards: ا ← أ إ آ ٱ (U+0623/0625/0622/0671),
 * ه ← ة (U+0629), ي ← ى ئ (U+0649/0626), و ← ؤ (U+0624).
 */
export const ARABIC_VARIANT_CLASSES: Readonly<Record<string, string>> = {
  'ا': 'اأإآٱ',
  'ه': 'هة',
  'ي': 'يىئ',
  'و': 'وؤ',
};

/** What `normalizeSearchText` drops: harakat + shadda/sukun (U+064B–U+0652), dagger alif (U+0670), tatweel (U+0640). */
const IGNORABLE_RUN = '[\u064B-\u0652\u0670\u0640]*';

/**
 * Longest normalized query, in characters, that gets the variant-tolerant term.
 * It bounds the regex and the request URL (an Arabic character costs 6 URL
 * bytes, a variant class or an ignorable run about 32); a longer query keeps
 * the ILIKE terms alone, exactly as before.
 */
export const VARIANT_PATTERN_MAX_CHARS = 30;

const isAscii = (ch: string): boolean => (ch.codePointAt(0) ?? 0) <= 0x7f;

/**
 * The POSIX regex (for `imatch`) that matches every stored text whose
 * normalized form contains `norm`; null when `norm` is pure ASCII (the ILIKE
 * terms already match that exactly, case-insensitively) or too long.
 *
 * Injection-safe by construction: every ASCII character other than a letter or
 * digit is backslash-escaped, which PostgreSQL's ARE reads as that literal
 * character; letters and digits are never escaped (ARE would read `\d`, `\1`…
 * as escapes) and are never special; no non-ASCII character is special in an
 * ARE. The result is a plain sequence of literals, classes and one `*` per
 * gap — no alternation, groups or back-references.
 */
export function arabicVariantPattern(norm: string): string | null {
  const chars = Array.from(norm);
  if (chars.length === 0 || chars.length > VARIANT_PATTERN_MAX_CHARS || chars.every(isAscii)) return null;
  return chars.map((ch, i) => {
    const variants = ARABIC_VARIANT_CLASSES[ch];
    const atom = variants
      ? `[${variants}]`
      : (isAscii(ch) && !/^[0-9A-Za-z]$/.test(ch) ? `\\${ch}` : ch);
    return i < chars.length - 1 && !isAscii(ch) ? atom + IGNORABLE_RUN : atom;
  }).join('');
}

/**
 * A double-quoted PostgREST logic-tree value: `\` and `"` escaped — the rule
 * `escapePostgrestIlikeValue` documents — so `,` `.` `:` `(` `)` inside it are
 * inert. Unlike that helper it adds no `%` wildcards.
 */
function quoteLogicTreeValue(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// ─────────────────────────────────────────────────────────────────────────────
// PRE3 RUN 4 — EXACT-CANDIDATE MODE: A SINGLE SUGGESTION NEEDS PROVEN UNIQUENESS
//
// A one-click suggestion may be offered only when exactly ONE active registered
// item carries a row's text exactly (the client rule `centralItemExactlyNames`:
// normalizeSearchText equality on name / name_ar / trade_name, or the national
// code verbatim). Deciding that from a capped, alphabetical search window was
// the defect: a second exact item past the cut was invisible.
//
// This mode asks the server for a set that PROVABLY CONTAINS every active item
// the client rule could call exact, and proves the set COMPLETE:
//
//   1. For each name column, three regex terms (PostgREST `match` = PostgreSQL
//      `~`, case-SENSITIVE, so no collation/locale case folding is relied on):
//        R(q)   anchored: every stored text made only of MIRRORED characters
//               (below) whose normalized form equals q — case, Arabic variant,
//               harakat/tatweel and surrounding-whitespace tolerant;
//        STRAY  a dropped mark right after a character whose image is ASCII
//               (the one placement R(q) does not spell out, to keep it short);
//        UNMIR  ANY character outside the mirrored alphabet — presentation
//               forms, ligatures, decomposed hamza/madda, fullwidth, exotic
//               spaces, compatibility symbols — i.e. everything whose
//               normalization the server cannot reproduce. Such rows are
//               fetched whatever they say, and judged by the client rule.
//      The national code gets its own anchored, trim-tolerant literal term.
//   2. ACTIVE rows only (`status = 'active'`), limit CAP+1, `count=exact`.
//   3. Complete only when every request's exact count is ≤ CAP and equals the
//      rows received, and every row received is active. Anything else —
//      truncation, a missing count, a request too long to send, a failure —
//      proves nothing, and the caller offers no suggestion.
//
// The client rule is then applied to the complete set by the caller. Nothing
// here maps, suggests or writes anything.
// ─────────────────────────────────────────────────────────────────────────────

/** Most rows one exact-candidate request may return and still be complete (it asks for CAP+1). */
export const EXACT_CANDIDATE_CAP = 100;

/**
 * Largest URL-encoded `or=` parameter one exact-candidate request may carry. A
 * request that would be longer is NOT sent and nothing is proven (fail closed);
 * with the fixed parameters the whole query string then stays well under 8 KB.
 */
export const EXACT_REQUEST_MAX_OR_BYTES = 6000;

/**
 * THE MIRRORED ALPHABET (inclusive code-point ranges). For a stored text made
 * only of these characters, `normalizeSearchText` is per-character: NFKC does
 * not compose, decompose or reorder anything that survives, `toLowerCase` has
 * no context, and every character maps to at most ONE character (or to
 * nothing: harakat, dagger alif, tatweel). The regex classes below are DERIVED
 * from `normalizeSearchText` itself over exactly this set, so the server-side
 * term R(q) is equivalent to the client rule on it. Every other character is
 * caught by the UNMIR term instead. Verified exhaustively (every code point,
 * every ordered pair) in material-resolver-exact-candidates.test.ts.
 */
export const EXACT_MIRRORED_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0001, 0x007f], // ASCII (A-Z fold to a-z; whitespace trims at the edges)
  [0x00a0, 0x00a7], [0x00a9, 0x00a9], [0x00ab, 0x00ae], [0x00b0, 0x00b1],
  [0x00b5, 0x00b7], [0x00bb, 0x00bb], [0x00bf, 0x00ff], // Latin-1 minus compatibility forms (NBSP -> space, µ -> μ)
  [0x0391, 0x03a1], [0x03a4, 0x03a9], [0x03b1, 0x03c9], // basic Greek (Σ excluded: context-dependent lowercase)
  [0x0600, 0x060f], [0x061b, 0x0652], [0x0660, 0x0674], [0x0679, 0x06d5],
  [0x06dd, 0x06de], [0x06e5, 0x06e6], [0x06e9, 0x06e9], [0x06ee, 0x06ff], // Arabic minus composing/Quranic marks and ٵ-ٸ
  [0x1680, 0x1680], [0x200b, 0x2016], [0x2018, 0x2023], [0x2027, 0x202e],
  [0x2030, 0x2032], [0x2035, 0x2035], [0x2038, 0x203b], [0x203d, 0x203d],
  [0x203f, 0x2046], [0x204a, 0x2056], [0x2058, 0x205e], [0x2060, 0x206f], // punctuation, format, bidi controls
  [0x20ac, 0x20ac], [0xfeff, 0xfeff],
];

interface MirrorTables {
  /** normalized character → every mirrored character whose image it is. */
  sources: Map<string, string[]>;
  /** `[…]*` of the mirrored characters normalization drops (harakat, dagger alif, tatweel). */
  droppedRun: string;
  /** `[…]*` of what may surround the text: dropped marks and characters whose image is trimmed whitespace. */
  edgeRun: string;
  /** STRAY: a dropped mark right after a character whose image is ASCII. */
  strayDropped: string;
  /** UNMIR: any character outside the mirrored alphabet. */
  unmirrored: string;
}

let mirrorTablesMemo: MirrorTables | null = null;

/** One character as a regex literal: ASCII letters/digits and non-ASCII as themselves, other ASCII backslash-escaped. */
function regexLiteral(ch: string): string {
  return isAscii(ch) && !/^[0-9A-Za-z]$/.test(ch) ? `\\${ch}` : ch;
}

/** Inclusive code-point runs of these characters, ascending. */
function codePointRuns(chars: readonly string[]): Array<[number, number]> {
  const points = [...new Set(chars.map((ch) => ch.codePointAt(0) as number))].sort((a, b) => a - b);
  const runs: Array<[number, number]> = [];
  for (const cp of points) {
    const last = runs[runs.length - 1];
    if (last && last[1] === cp - 1) last[1] = cp;
    else runs.push([cp, cp]);
  }
  return runs;
}

/** Bracket-expression body for these runs: a run of three or more becomes a code-point range `a-b`. */
function regexClassBody(runs: ReadonlyArray<readonly [number, number]>): string {
  return runs.map(([lo, hi]) => {
    const from = regexLiteral(String.fromCodePoint(lo));
    if (hi === lo) return from;
    const to = regexLiteral(String.fromCodePoint(hi));
    return hi === lo + 1 ? from + to : `${from}-${to}`;
  }).join('');
}

/** The lone literal for one character, else a bracket expression over all of them. */
function regexAtom(chars: readonly string[]): string {
  return chars.length === 1 ? regexLiteral(chars[0]) : `[${regexClassBody(codePointRuns(chars))}]`;
}

/**
 * What `normalizeSearchText` makes of ONE character, read from the function
 * itself (between two neutral digits, so whitespace is not trimmed away).
 * Only meaningful for mirrored characters, whose normalization is per-character.
 */
function mirroredImage(ch: string): string {
  return normalizeSearchText(`0${ch}0`).slice(1, -1);
}

function mirrorTables(): MirrorTables {
  if (mirrorTablesMemo) return mirrorTablesMemo;
  const sources = new Map<string, string[]>();
  const dropped: string[] = [];
  const edge: string[] = [];
  const asciiImage: string[] = [];
  for (const [lo, hi] of EXACT_MIRRORED_RANGES) {
    for (let cp = lo; cp <= hi; cp += 1) {
      const ch = String.fromCodePoint(cp);
      const image = mirroredImage(ch);
      if (image === '') { dropped.push(ch); edge.push(ch); continue; }
      sources.set(image, [...(sources.get(image) ?? []), ch]);
      if (/^\s$/.test(image)) edge.push(ch);
      if (isAscii(image)) asciiImage.push(ch);
    }
  }
  const droppedClass = `[${regexClassBody(codePointRuns(dropped))}]`;
  mirrorTablesMemo = {
    sources,
    droppedRun: `${droppedClass}*`,
    edgeRun: `[${regexClassBody(codePointRuns(edge))}]*`,
    strayDropped: `[${regexClassBody(codePointRuns(asciiImage))}]${droppedClass}`,
    unmirrored: `[^${regexClassBody(EXACT_MIRRORED_RANGES)}]`,
  };
  return mirrorTablesMemo;
}

/**
 * R(q): the anchored regex (PostgreSQL `~`) matching every stored text made of
 * mirrored characters whose `normalizeSearchText` equals `norm`. Each normalized
 * character becomes the class of every mirrored character that normalizes to
 * it; dropped marks may follow any non-ASCII character and surround the text;
 * trimmed whitespace may surround it. Null when some character of `norm` is the
 * image of NO mirrored character — then no mirrored text can normalize to
 * `norm`, and the UNMIR term alone covers every candidate.
 */
export function exactNamePattern(norm: string): string | null {
  const tables = mirrorTables();
  const chars = Array.from(norm);
  if (chars.length === 0) return null;
  let body = '';
  for (const [i, ch] of chars.entries()) {
    const sources = tables.sources.get(ch);
    if (!sources) return null;
    body += regexAtom(sources);
    if (i < chars.length - 1 && !isAscii(ch)) body += tables.droppedRun;
  }
  return `^${tables.edgeRun}${body}${tables.edgeRun}$`;
}

/** STRAY: a dropped mark right after a character whose image is ASCII — the placement R(q) leaves to this term. */
export function exactStrayDroppedPattern(): string {
  return mirrorTables().strayDropped;
}

/** UNMIR: any character outside EXACT_MIRRORED_RANGES. */
export function exactUnmirroredPattern(): string {
  return mirrorTables().unmirrored;
}

/** Every character JavaScript's String.prototype.trim removes (WhiteSpace + LineTerminator). */
const JS_TRIM_RUNS: ReadonlyArray<readonly [number, number]> = [
  [0x0009, 0x000d], [0x0020, 0x0020], [0x00a0, 0x00a0], [0x1680, 0x1680], [0x2000, 0x200a],
  [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000], [0xfeff, 0xfeff],
];

/** True when every UTF-16 surrogate in `text` is part of a valid pair (PostgreSQL text can hold nothing else). */
function isWellFormedText(text: string): boolean {
  return Array.from(text).every((ch) => {
    const cp = ch.codePointAt(0) ?? 0;
    return cp !== 0 && (cp < 0xd800 || cp > 0xdfff);
  });
}

/**
 * The national-code term: the stored code, trimmed as `textOrNull` trims it,
 * equals `raw` verbatim. Null when `raw` holds a NUL or a lone surrogate —
 * no stored text can, so no stored code can equal it.
 */
export function exactCodePattern(raw: string): string | null {
  if (raw === '' || !isWellFormedText(raw)) return null;
  const trimRun = `[${regexClassBody(JS_TRIM_RUNS)}]*`;
  return `^${trimRun}${Array.from(raw).map(regexLiteral).join('')}${trimRun}$`;
}

export type ExactCandidateTarget = 'name' | 'name_ar' | 'trade_name' | 'barcode';

export interface ExactCandidateRequest {
  target: ExactCandidateTarget;
  /** PostgREST logic-tree terms, OR-ed in one `or=(…)`. */
  terms: string[];
  /** Size of the URL-encoded `or=(…)` parameter, exactly as postgrest-js appends it. */
  encodedBytes: number;
}

export interface ExactCandidatePlan {
  raw: string;
  norm: string;
  requests: ExactCandidateRequest[];
  /** Why nothing can be proven before a request is sent; null when every request is sendable. */
  unprovable: null | 'not_searchable' | 'query_too_long';
}

/**
 * The requests that together return a provable superset of the active items
 * the client exactness rule could match for `rawText`. Pure: builds, sends nothing.
 */
export function planExactCatalogCandidates(rawText: string): ExactCandidatePlan {
  const raw = (rawText ?? '').trim();
  const norm = normalizeSearchText(raw);
  if (norm.length < 2) return { raw, norm, requests: [], unprovable: 'not_searchable' };
  const namePattern = exactNamePattern(norm);
  const nameTerms = (col: 'name' | 'name_ar' | 'trade_name'): string[] => [
    ...(namePattern === null ? [] : [`${col}.match.${quoteLogicTreeValue(namePattern)}`]),
    `${col}.match.${quoteLogicTreeValue(exactStrayDroppedPattern())}`,
    `${col}.match.${quoteLogicTreeValue(exactUnmirroredPattern())}`,
  ];
  const codePattern = exactCodePattern(raw);
  const drafts: Array<{ target: ExactCandidateTarget; terms: string[] }> = [
    { target: 'name', terms: nameTerms('name') },
    { target: 'name_ar', terms: nameTerms('name_ar') },
    { target: 'trade_name', terms: nameTerms('trade_name') },
    ...(codePattern === null ? [] : [{ target: 'barcode' as const, terms: [`barcode.match.${quoteLogicTreeValue(codePattern)}`] }]),
  ];
  const requests = drafts.map((d) => ({
    ...d,
    encodedBytes: new URLSearchParams([['or', `(${d.terms.join(',')})`]]).toString().length,
  }));
  const tooLong = requests.some((r) => r.encodedBytes > EXACT_REQUEST_MAX_OR_BYTES);
  return { raw, norm, requests, unprovable: tooLong ? 'query_too_long' : null };
}

export interface ExactCatalogCandidates {
  /** Every row the requests returned (deduplicated), as catalog results. A SUPERSET of the exact matches. */
  items: ResolvedMaterial[];
  /** True ONLY when the set is proven complete; anything else proves nothing. */
  complete: boolean;
  /** Why completeness is not proven; null when complete. */
  incompleteReason:
    | null
    | 'not_configured'
    | 'not_searchable'
    | 'query_too_long'
    | 'truncated'
    | 'count_unavailable'
    | 'inactive_row_returned';
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
  // PRE3-A: the variant-tolerant regex (null for a pure-ASCII or over-long query).
  const variantPattern = arabicVariantPattern(norm);
  const imatchVariant = variantPattern === null ? null : quoteLogicTreeValue(variantPattern);

  // 1+2+4 — the registered catalog (server-side, capped, RLS applies).
  // Public visitors may match by NAME only (scientific = name, trade = name_ar);
  // barcode-exact matching is an operator-only capability.
  //
  // G3.2-GAP-01: 114's trade_name / concentration / dosage_form are read here.
  // G3.2-GAP-02: only ACTIVE catalog rows are operationally selectable.
  // PRE3-A: trade_name is a NAME and is now matched like one, for both
  // audiences (the public contract above already promises trade-name search).
  // The capped window is ordered by name then id so the same query returns
  // the same rows every time; grading then re-sorts inside that window.
  // PRE3-A: the `imatch` terms make Arabic spelling variants match in both
  // directions (see arabicVariantPattern) — names only, so the public contract
  // is unchanged; the window is still capped by the server after filtering.
  const catalogOr = [
    `name.ilike.${ilikeRaw}`, `name_ar.ilike.${ilikeRaw}`, `trade_name.ilike.${ilikeRaw}`,
    `name.ilike.${ilikeNorm}`, `name_ar.ilike.${ilikeNorm}`, `trade_name.ilike.${ilikeNorm}`,
  ];
  if (imatchVariant) {
    catalogOr.push(`name.imatch.${imatchVariant}`, `name_ar.imatch.${imatchVariant}`, `trade_name.imatch.${imatchVariant}`);
  }
  if (!isPublic) catalogOr.unshift(`barcode.eq.${JSON.stringify(raw)}`);
  let catalogQuery = supabase
    .from('central_items')
    .select(CATALOG_SELECT)
    .eq('status', 'active')
    .or(catalogOr.join(','))
    .order('name', { ascending: true })
    .order('id', { ascending: true })
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
            ...(imatchVariant ? [`scientific_name.imatch.${imatchVariant}`, `trade_name.imatch.${imatchVariant}`] : []),
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

  for (const row of ((catalog.data ?? []) as CatalogRow[])) results.push(catalogResult(row, raw, norm));

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

/**
 * PRE3 Run 4 — the canonical resolver's EXACT-CANDIDATE mode (see the block
 * above planExactCatalogCandidates). Same catalog, same columns, same ACTIVE
 * filter, same row mapping as resolveMaterials; operator audience only (it
 * matches the national code). Returns a superset of the active items the client
 * exactness rule could match for `rawText`, and `complete: true` only when that
 * superset is PROVEN complete. A failed request throws — it is never reported
 * as "complete and empty".
 */
export async function resolveExactCatalogCandidates(
  rawText: string,
  opts: { signal?: AbortSignal } = {},
): Promise<ExactCatalogCandidates> {
  if (!supabaseConfigured) return { items: [], complete: false, incompleteReason: 'not_configured' };
  const plan = planExactCatalogCandidates(rawText);
  if (plan.unprovable) return { items: [], complete: false, incompleteReason: plan.unprovable };

  const responses = await Promise.all(plan.requests.map((request) => {
    let query = supabase
      .from('central_items')
      .select(CATALOG_SELECT, { count: 'exact' })
      .eq('status', 'active')
      .or(request.terms.join(','))
      .order('name', { ascending: true })
      .order('id', { ascending: true })
      .limit(EXACT_CANDIDATE_CAP + 1);
    if (opts.signal) query = query.abortSignal(opts.signal);
    return query;
  }));

  let incompleteReason: ExactCatalogCandidates['incompleteReason'] = null;
  const byId = new Map<string, CatalogRow>();
  for (const response of responses) {
    if (response.error) throw response.error;
    const rows = (response.data ?? []) as CatalogRow[];
    const count = response.count;
    if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) incompleteReason ??= 'count_unavailable';
    else if (count > EXACT_CANDIDATE_CAP || rows.length !== count) incompleteReason ??= 'truncated';
    // The filter is part of what was proven: a row it should have excluded
    // means this was not the request the proof is about.
    if (rows.some((row) => row.status !== 'active')) incompleteReason ??= 'inactive_row_returned';
    for (const row of rows) if (!byId.has(row.id)) byId.set(row.id, row);
  }

  return {
    items: [...byId.values()].map((row) => catalogResult(row, plan.raw, plan.norm)),
    complete: incompleteReason === null,
    incompleteReason,
  };
}
