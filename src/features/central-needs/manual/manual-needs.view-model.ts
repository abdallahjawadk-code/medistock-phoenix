/**
 * R1-A4 — folds the append-only manual event chain into the rows the workspace shows.
 * Pure: no I/O, no clock. The server chain is the truth; this only groups and labels it.
 */
import type { ManualNeedEvent } from './manual-needs.service';

export interface ManualNeedRow {
  scopeKey: string;
  beneficiaryOrganizationId: string;
  centralItemId: string;
  targetWarehouseId: string | null;
  /** The newest event of the scope — its id is the stale-write fence for the next write. */
  lastEventId: string;
  lastSeq: number;
  live: boolean;
  quantityText: string | null;
  approvedUnit: string | null;
  history: ManualNeedEvent[];
}

export const scopeKeyOf = (e: { beneficiaryOrganizationId: string; centralItemId: string; targetWarehouseId: string | null }) =>
  `${e.beneficiaryOrganizationId}|${e.centralItemId}|${e.targetWarehouseId ?? ''}`;

export function foldManualEvents(events: readonly ManualNeedEvent[]): ManualNeedRow[] {
  const byScope = new Map<string, ManualNeedEvent[]>();
  for (const e of events) {
    const k = scopeKeyOf(e);
    const list = byScope.get(k);
    if (list) list.push(e); else byScope.set(k, [e]);
  }
  const rows: ManualNeedRow[] = [];
  for (const [scopeKey, list] of byScope) {
    const history = [...list].sort((a, b) => a.eventSeq - b.eventSeq);
    const last = history[history.length - 1];
    const live = last.eventKind !== 'void';
    rows.push({
      scopeKey,
      beneficiaryOrganizationId: last.beneficiaryOrganizationId,
      centralItemId: last.centralItemId,
      targetWarehouseId: last.targetWarehouseId,
      lastEventId: last.id,
      lastSeq: last.eventSeq,
      live,
      quantityText: live ? last.quantityText : null,
      approvedUnit: live ? last.approvedUnit : null,
      history,
    });
  }
  return rows.sort((a, b) => a.scopeKey.localeCompare(b.scopeKey));
}

/** A revision may be edited only while it is a manual DRAFT and the caller holds the manual key. */
export function canEditManual(args: { status: string; sourceMode: string; manualSet: boolean }): boolean {
  return args.status === 'draft' && args.sourceMode === 'manual' && args.manualSet;
}
