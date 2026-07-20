import { normalizeForMatching } from '../parse/normalize';

/**
 * PHARMA-OCR-A — duplicate / conflicting stock identity detection.
 *
 * A batch is identified by (warehouse, material, national code, batch number,
 * expiry). Two situations must both stop an automatic accept:
 *
 *  - DUPLICATE: an identical identity already exists. Posting again may be a
 *    legitimate second delivery, or an accidental re-scan of the same invoice.
 *    Only the operator knows which, so the flow requires them to say.
 *  - CONFLICT: the same batch number for the same material carries a DIFFERENT
 *    expiry than what is already on file. One of the two is wrong, and guessing
 *    which would corrupt expiry-driven quarantine and FEFO picking.
 *
 * Neither case is resolved here. This module reports; the review UI blocks.
 */

export interface ExistingBatchIdentity {
  warehouseStockId: string;
  warehouseId: string;
  scientificName: string;
  nationalCode: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
  onHandQuantity: number;
}

export interface ProposedBatchIdentity {
  warehouseId: string;
  scientificName: string;
  nationalCode: string | null;
  batchNumber: string | null;
  expiryDate: string | null;
}

export type IdentityFindingKind = 'duplicate' | 'expiry_conflict' | 'national_code_conflict';

export interface IdentityFinding {
  kind: IdentityFindingKind;
  existing: ExistingBatchIdentity;
  /** Human-checkable explanation of what differs, for the review UI. */
  differingFields: string[];
}

export interface IdentityAssessment {
  findings: IdentityFinding[];
  /** True when at least one finding must be explicitly resolved before intake. */
  blocksAutomaticAccept: boolean;
}

const same = (a: string | null | undefined, b: string | null | undefined): boolean => {
  if (!a || !b) return false;
  return normalizeForMatching(a) === normalizeForMatching(b);
};

/**
 * Compare a proposed intake against existing stock in the SAME warehouse.
 * Cross-warehouse batches are intentionally out of scope: the same batch
 * legitimately exists in several warehouses at once.
 */
export function assessBatchIdentity(
  proposed: ProposedBatchIdentity,
  existing: readonly ExistingBatchIdentity[],
): IdentityAssessment {
  const findings: IdentityFinding[] = [];
  const sameWarehouse = existing.filter(row => row.warehouseId === proposed.warehouseId);

  for (const row of sameWarehouse) {
    const materialMatches =
      same(row.scientificName, proposed.scientificName) ||
      same(row.nationalCode, proposed.nationalCode);
    if (!materialMatches) continue;

    const batchMatches = same(row.batchNumber, proposed.batchNumber);
    if (!batchMatches) continue;

    const expiryMatches = same(row.expiryDate, proposed.expiryDate);
    const codeMatches =
      !row.nationalCode || !proposed.nationalCode || same(row.nationalCode, proposed.nationalCode);

    if (expiryMatches && codeMatches) {
      findings.push({ kind: 'duplicate', existing: row, differingFields: [] });
      continue;
    }
    if (!expiryMatches) {
      findings.push({
        kind: 'expiry_conflict',
        existing: row,
        differingFields: ['expiryDate'],
      });
    }
    if (!codeMatches) {
      findings.push({
        kind: 'national_code_conflict',
        existing: row,
        differingFields: ['nationalCode'],
      });
    }
  }

  return { findings, blocksAutomaticAccept: findings.length > 0 };
}
