/**
 * Annual Needs — Simple Mode summary counts.
 *
 * Pure, presentation-only aggregation over props the parent screen has
 * ALREADY loaded via the existing service reads (`listBeneficiaryColumns`,
 * `listDispositions`, `listSourceRecords`). No new server call, no new
 * business rule: `reviewRequired`, `decision` and the beneficiary/material
 * mapping are the server's own answers, only counted here.
 *
 * "Quantities" mirrors the SAME two-rule selection
 * `CentralNeedsNeedLinePanel`'s own `candidates` memo already applies —
 * mapped disposition AND a resolved beneficiary column — kept here as a
 * small, separately-documented duplicate rather than a refactor of that
 * large, invariant-critical file, which is out of this task's file scope.
 * See CORPUS-CONTRACT.md / the final report's open findings.
 */
import type { BeneficiaryColumnSummary, RecordDisposition, SourceRecord } from '../central-needs.service';

export interface SimpleCounts {
  institutionsConfirmed: number;
  institutionsUnresolved: number;
  materialsMapped: number;
  materialsUndispositioned: number;
  quantityCandidateCount: number;
  /** institutionsUnresolved + materialsUndispositioned — "N items need review". */
  reviewItemCount: number;
}

function columnIdentity(record: SourceRecord): { sheetIndex: number; columnIndex: number } | null {
  const p = record.sourceProvenance as { sheetIndex?: unknown; coordinate?: { col?: unknown } } | null;
  const sheetIndex = p?.sheetIndex;
  const columnIndex = p?.coordinate?.col;
  if (typeof sheetIndex !== 'number' || typeof columnIndex !== 'number') return null;
  return { sheetIndex, columnIndex };
}

export function computeSimpleCounts(
  beneficiaryColumns: readonly BeneficiaryColumnSummary[],
  records: readonly SourceRecord[],
  dispositions: readonly RecordDisposition[],
): SimpleCounts {
  const institutionsConfirmed = new Set(
    beneficiaryColumns.filter((c) => c.decision === 'beneficiary' && c.beneficiaryOrganizationId)
      .map((c) => c.beneficiaryOrganizationId as string),
  ).size;
  const institutionsUnresolved = beneficiaryColumns.filter((c) => c.decision === null && c.reviewRequired).length;

  const mappedItemByEntity = new Map<string, string>();
  for (const d of dispositions) {
    if (d.decision === 'mapped' && d.centralItemId) mappedItemByEntity.set(d.targetEntity, d.centralItemId);
  }
  const dispositionedEntities = new Set(dispositions.map((d) => d.targetEntity));
  const allEntities = new Set(records.map((r) => r.targetEntity));
  const materialsMapped = new Set(mappedItemByEntity.values()).size;
  let materialsUndispositioned = 0;
  for (const entity of allEntities) if (!dispositionedEntities.has(entity)) materialsUndispositioned += 1;

  const beneficiaryByColumnKey = new Map<string, string>();
  for (const c of beneficiaryColumns) {
    if (c.decision === 'beneficiary' && c.beneficiaryOrganizationId) {
      beneficiaryByColumnKey.set(`${c.importSessionId}:${c.sheetIndex}:${c.columnIndex}`, c.beneficiaryOrganizationId);
    }
  }
  let quantityCandidateCount = 0;
  for (const r of records) {
    if (!mappedItemByEntity.has(r.targetEntity)) continue;
    const col = columnIdentity(r);
    if (!col) continue;
    const key = `${r.importSessionId}:${col.sheetIndex}:${col.columnIndex}`;
    if (beneficiaryByColumnKey.has(key)) quantityCandidateCount += 1;
  }

  return {
    institutionsConfirmed,
    institutionsUnresolved,
    materialsMapped,
    materialsUndispositioned,
    quantityCandidateCount,
    reviewItemCount: institutionsUnresolved + materialsUndispositioned,
  };
}
