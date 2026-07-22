/**
 * MOVEMENT-COMPOSER-A — return provenance arithmetic.
 *
 * A direct return is NOT generic material entry. Every returnable line must
 * descend from an actual received transfer line, and migration 069 enforces
 * that at the schema level: warehouse_return_request_lines.original_transfer_line_id
 * and warehouse_return_shipment_lines.original_transfer_line_id are both
 * NOT NULL REFERENCES warehouse_transfer_lines(id).
 *
 * These helpers only DISPLAY the cap. The server remains the final authority —
 * 069 carries CHECK (returned_quantity <= received_quantity) and the send RPC
 * re-derives the cap inside the transaction. A UI that computed this wrongly
 * would produce a confusing error, never an over-return.
 */

export interface ProvenanceCandidate {
  /** warehouse_transfer_lines.id — the immutable provenance anchor. */
  originalTransferLineId: string;
  /** Quantity the institution actually received on this line. */
  receivedQuantity: number | null;
  /** Quantity already committed back (sent) against this line. */
  returnedQuantity: number;
  /** warehouse_transfer_lines.resulting_warehouse_stock_id — the physical row. */
  resultingWarehouseStockId: string | null;
  /** Physical on-hand of that resulting stock row, when readable. */
  onHandQuantity: number | null;
  /** Physical reserved of that resulting stock row, when readable. */
  reservedQuantity: number | null;
}

export interface ProvenanceCaps {
  /** receivedQuantity - returnedQuantity, floored at 0. */
  provenanceRemaining: number;
  /** onHandQuantity - reservedQuantity, floored at 0; null when stock is unreadable. */
  physicalAvailable: number | null;
  /** The binding cap the UI must enforce. */
  safeReturnable: number;
  /** True when physical stock could not be read, so the cap rests on provenance alone. */
  physicalUnknown: boolean;
}

const floor0 = (n: number) => (Number.isFinite(n) && n > 0 ? Math.floor(n) : 0);

export function computeProvenanceCaps(candidate: ProvenanceCandidate): ProvenanceCaps {
  const received = candidate.receivedQuantity ?? 0;
  const provenanceRemaining = floor0(received - candidate.returnedQuantity);

  const hasPhysical =
    candidate.resultingWarehouseStockId !== null &&
    candidate.onHandQuantity !== null &&
    candidate.reservedQuantity !== null;

  const physicalAvailable = hasPhysical
    ? floor0((candidate.onHandQuantity as number) - (candidate.reservedQuantity as number))
    : null;

  // When the physical row is not readable we do NOT silently widen the cap to
  // provenance alone and call it safe — we cap on provenance but flag it, so
  // the reviewer can see the number rests on one source instead of two.
  const safeReturnable = physicalAvailable === null
    ? provenanceRemaining
    : Math.min(provenanceRemaining, physicalAvailable);

  return {
    provenanceRemaining,
    physicalAvailable,
    safeReturnable,
    physicalUnknown: physicalAvailable === null,
  };
}

/**
 * Expired / damaged / recalled stock is deliberately RETURNABLE — those are
 * among the most legitimate reasons to send something back. This never filters;
 * it only classifies so the UI can warn conspicuously.
 */
export type ReturnRiskFlag = 'expired' | 'near_expiry' | 'physical_unknown' | 'exceeds_physical';

export function returnRiskFlags(
  candidate: ProvenanceCandidate,
  expiryDate: string | null,
  today: Date = new Date(),
): ReturnRiskFlag[] {
  const flags: ReturnRiskFlag[] = [];
  const caps = computeProvenanceCaps(candidate);

  if (expiryDate) {
    const expiry = new Date(`${expiryDate}T00:00:00Z`);
    if (!Number.isNaN(expiry.getTime())) {
      const midnight = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
      if (expiry < midnight) flags.push('expired');
      else {
        const ninetyDays = 90 * 24 * 60 * 60 * 1000;
        if (expiry.getTime() - midnight.getTime() <= ninetyDays) flags.push('near_expiry');
      }
    }
  }

  if (caps.physicalUnknown) flags.push('physical_unknown');
  else if (caps.provenanceRemaining > (caps.physicalAvailable as number)) flags.push('exceeds_physical');

  return flags;
}
