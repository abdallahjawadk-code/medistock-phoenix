/**
 * MOVEMENT-COMPOSER-A — the local composer draft.
 *
 * THE CONTRACT OF THIS FILE: it is pure. Nothing here calls an RPC, touches
 * Supabase, or mutates anything server-side. A draft lives entirely in memory
 * until the operator confirms, which is what makes "Cancel performs ZERO
 * create/add-line calls" true by construction rather than by discipline.
 *
 * The old flow created the request header the moment the operator filled in the
 * parties, then made them reopen it and type material names by hand. That left
 * abandoned headers behind on every cancel and made scientific_name the material
 * identity. Both are fixed here: identity is a stable id, and nothing is
 * persisted before the review step.
 *
 * G3.2 — `searchStock` matched with a bare `.toLowerCase()`. That is adequate
 * for English and wrong for Arabic: an operator who typed "أموكسيسيلين" found
 * nothing when the row read "اموكسيسيلين", while the SAME query typed into
 * PhoenixMaterialResolver found it, because the resolver had always used the
 * canonical bilingual normalizer. One search box behaving differently from
 * another is not a cosmetic inconsistency — it teaches operators that a
 * material "is not in stock" when it is. Both now use `normalizeSearchText`.
 */
import { normalizeSearchText } from '@/shared/lib/search-normalize';

export type MovementDirection = 'supply' | 'return';

/** A selectable source-stock row for SUPPLY. Identity is warehouseStockId. */
export interface StockCandidate {
  warehouseStockId: string;
  centralItemId: string | null;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  internalBatchReference: string | null;
  expiryDate: string | null;
  onHandQuantity: number;
  reservedQuantity: number;
  availableQuantity: number;
}

/** One composed line, before anything is persisted. */
export interface DraftLine {
  /**
   * Stable per-line key generated ONCE when the line is added and reused for
   * every retry of its send RPC. This is the idempotency token that makes a
   * retry safe (p_request_id on phoenix_send_direct_warehouse_transfer_line).
   */
  idempotencyKey: string;
  /** SUPPLY: the source stock row. RETURN: null — provenance identifies it. */
  warehouseStockId: string | null;
  /** RETURN: the mandatory provenance anchor. SUPPLY: null. */
  originalTransferLineId: string | null;
  centralItemId: string | null;
  scientificName: string;
  tradeName: string | null;
  concentration: string | null;
  dosageForm: string | null;
  unit: string | null;
  nationalCode: string | null;
  batchNumber: string | null;
  internalBatchReference: string | null;
  expiryDate: string | null;
  quantity: number;
  /** The cap this line was validated against when it was added. */
  maxQuantity: number;
  /** RETURN only — one of the existing reason codes. */
  reasonCode: string | null;
  reasonText: string | null;
  notes: string | null;
}

export interface DraftLineIssue {
  idempotencyKey: string;
  code:
    | 'quantity_not_positive'
    | 'quantity_not_integer'
    | 'quantity_exceeds_available'
    | 'duplicate_material_batch'
    | 'expired_not_dispatchable'
    | 'missing_reason_code'
    | 'missing_provenance'
    | 'missing_identity';
  detail?: string;
}

/**
 * Identity of a material+batch for duplicate detection.
 *
 * Two rows are "the same material" when they point at the same stock row (or
 * the same provenance line). Falling back to name+batch catches the case where
 * OCR proposed the same physical batch twice through different routes.
 */
export function lineIdentityKey(line: Pick<DraftLine, 'warehouseStockId' | 'originalTransferLineId' | 'scientificName' | 'batchNumber' | 'expiryDate'>): string {
  if (line.warehouseStockId) return `stock:${line.warehouseStockId}`;
  if (line.originalTransferLineId) return `prov:${line.originalTransferLineId}`;
  return `name:${line.scientificName.trim().toLowerCase()}|${(line.batchNumber ?? '').trim().toLowerCase()}|${line.expiryDate ?? ''}`;
}

export function isExpired(expiryDate: string | null, today: Date = new Date()): boolean {
  if (!expiryDate) return false;
  const expiry = new Date(`${expiryDate}T00:00:00Z`);
  if (Number.isNaN(expiry.getTime())) return false;
  const midnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  return expiry < midnight;
}

/**
 * Validate the whole draft.
 *
 * `direction` matters: expired stock must NOT be dispatched as supply, but
 * expired stock absolutely MAY be returned — that is one of the main reasons a
 * return exists. Conflating the two would block legitimate returns.
 */
export function validateDraft(
  lines: readonly DraftLine[],
  direction: MovementDirection,
  today: Date = new Date(),
): DraftLineIssue[] {
  const issues: DraftLineIssue[] = [];
  const seen = new Map<string, string>();

  for (const line of lines) {
    const key = line.idempotencyKey;

    if (direction === 'supply' && !line.warehouseStockId) {
      issues.push({ idempotencyKey: key, code: 'missing_identity' });
    }
    if (direction === 'return' && !line.originalTransferLineId) {
      issues.push({ idempotencyKey: key, code: 'missing_provenance' });
    }

    if (!Number.isFinite(line.quantity) || line.quantity <= 0) {
      issues.push({ idempotencyKey: key, code: 'quantity_not_positive' });
    } else if (!Number.isInteger(line.quantity)) {
      issues.push({ idempotencyKey: key, code: 'quantity_not_integer' });
    } else if (line.quantity > line.maxQuantity) {
      issues.push({
        idempotencyKey: key,
        code: 'quantity_exceeds_available',
        detail: `${line.quantity} > ${line.maxQuantity}`,
      });
    }

    if (direction === 'supply' && isExpired(line.expiryDate, today)) {
      issues.push({ idempotencyKey: key, code: 'expired_not_dispatchable' });
    }

    if (direction === 'return' && !line.reasonCode) {
      issues.push({ idempotencyKey: key, code: 'missing_reason_code' });
    }

    const identity = lineIdentityKey(line);
    const previous = seen.get(identity);
    if (previous) {
      issues.push({ idempotencyKey: key, code: 'duplicate_material_batch', detail: previous });
    } else {
      seen.set(identity, key);
    }
  }

  return issues;
}

export function draftIsConfirmable(lines: readonly DraftLine[], direction: MovementDirection, today: Date = new Date()): boolean {
  return lines.length > 0 && validateDraft(lines, direction, today).length === 0;
}

/**
 * FEFO recommendation — first-expiry-first-out.
 *
 * This RECOMMENDS only. It returns the candidate a dispatcher would normally
 * pick; the operator still selects and confirms explicitly, because a soonest
 * expiry is not always the right batch (quarantine, allocation, damage).
 */
export function recommendFefo(
  candidates: readonly StockCandidate[],
  today: Date = new Date(),
): StockCandidate | null {
  const usable = candidates.filter(c => c.availableQuantity > 0 && !isExpired(c.expiryDate, today));
  if (usable.length === 0) return null;
  return [...usable].sort((a, b) => {
    // Undated stock sorts last: an unknown expiry is not evidence of a long one.
    if (a.expiryDate === b.expiryDate) return b.availableQuantity - a.availableQuantity;
    if (!a.expiryDate) return 1;
    if (!b.expiryDate) return -1;
    return a.expiryDate < b.expiryDate ? -1 : 1;
  })[0];
}

/**
 * Free-text search across every field the operator might recall.
 *
 * G3.2: normalization is `normalizeSearchText` — the SAME function the material
 * resolver uses — so Arabic hamza seats, taa marbuta, final yaa, harakat and
 * tatweel fold identically in both places, and English stays case-insensitive.
 * Every term must match (AND), unchanged from before.
 *
 * This is a FILTER over rows already fetched under the caller's RLS scope. It
 * grants nothing and hides nothing for safety; identity remains
 * `warehouseStockId` on the row, never the text typed here.
 */
export function searchStock(candidates: readonly StockCandidate[], query: string): StockCandidate[] {
  const q = normalizeSearchText(query);
  if (!q) return [...candidates];
  const terms = q.split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...candidates];
  return candidates.filter(c => {
    const haystack = normalizeSearchText([
      c.scientificName, c.tradeName, c.concentration, c.dosageForm, c.unit,
      c.nationalCode, c.batchNumber, c.internalBatchReference, c.expiryDate,
    ].filter(Boolean).join(' '));
    return terms.every(term => haystack.includes(term));
  });
}

/** Build a draft line from an authoritative stock row. Identity is never typed. */
export function draftLineFromStock(
  stock: StockCandidate,
  quantity: number,
  idempotencyKey: string,
): DraftLine {
  return {
    idempotencyKey,
    warehouseStockId: stock.warehouseStockId,
    originalTransferLineId: null,
    centralItemId: stock.centralItemId,
    scientificName: stock.scientificName,
    tradeName: stock.tradeName,
    concentration: stock.concentration,
    dosageForm: stock.dosageForm,
    unit: stock.unit,
    nationalCode: stock.nationalCode,
    batchNumber: stock.batchNumber,
    internalBatchReference: stock.internalBatchReference,
    expiryDate: stock.expiryDate,
    quantity,
    maxQuantity: stock.availableQuantity,
    reasonCode: null,
    reasonText: null,
    notes: null,
  };
}

/**
 * Revalidate a draft against freshly fetched stock immediately before creation.
 * Availability moves under concurrent operators, so the cap a line was added
 * with may be stale by the time the operator reaches review.
 */
export function revalidateAgainstFreshStock(
  lines: readonly DraftLine[],
  fresh: readonly StockCandidate[],
): { lines: DraftLine[]; changed: string[] } {
  const byId = new Map(fresh.map(s => [s.warehouseStockId, s]));
  const changed: string[] = [];
  const next = lines.map(line => {
    if (!line.warehouseStockId) return line;
    const current = byId.get(line.warehouseStockId);
    if (!current) {
      changed.push(line.idempotencyKey);
      return { ...line, maxQuantity: 0 };
    }
    if (current.availableQuantity !== line.maxQuantity) {
      changed.push(line.idempotencyKey);
      return { ...line, maxQuantity: current.availableQuantity };
    }
    return line;
  });
  return { lines: next, changed };
}
