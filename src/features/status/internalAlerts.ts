import type { CanonicalStatus } from '@/shared/lib/status/canonical';

/**
 * AVAILABILITY-ALERTS-QR-POLISH-B
 *
 * Computes "internal" (same-institution) surplus/near-expiry -> missing/
 * low-stock matches entirely client-side from the live availability rows
 * StatusCenterScreen already loads via getAvailabilityByOrg (one network
 * call, already org-scoped server-side). This is deliberately the mirror of
 * materialAlertEngine.ts's cross-institution matching, restricted to pairs
 * at DIFFERENT distribution points within the SAME organization — no new
 * RPC, no new SQL, no new network call. Two rows at the exact same point are
 * never matched (same-point same-material duplication is a data issue, not
 * an actionable internal transfer).
 *
 * Matching key mirrors materialAlertEngine.ts exactly: normalized
 * (lowercased, trimmed) scientific_name + concentration + dosage_form —
 * never trade_name (display-only, never used to match identity).
 */

export interface InternalAlertRow {
  distribution_points: { id: string; name: string; name_ar: string } | null;
  scientific_name: string | null;
  trade_name: string | null;
  concentration: string | null;
  dosage_form: string | null;
  quantity: number;
  effective_status?: CanonicalStatus;
  condition?: string | null;
}

export interface InternalAlertMatch {
  scientificName: string;
  concentration: string | null;
  dosageForm: string | null;
  sourcePointId: string;
  sourcePointName: string;
  sourcePointNameAr: string;
  sourceStatus: 'surplus' | 'near_expiry';
  sourceQuantity: number;
  targetPointId: string;
  targetPointName: string;
  targetPointNameAr: string;
  targetStatus: 'missing' | 'low_stock';
  targetQuantity: number;
  /** 'high' when the target is fully missing, 'medium' when merely low stock — same convention as materialAlertEngine.ts. */
  severity: 'high' | 'medium';
}

const SUPPLY_STATUSES: ReadonlyArray<CanonicalStatus> = ['surplus', 'near_expiry'];
const DEMAND_STATUSES: ReadonlyArray<CanonicalStatus> = ['missing', 'low_stock'];

function norm(v: string | null | undefined): string {
  return (v ?? '').trim().toLowerCase();
}

function effOf(r: InternalAlertRow): CanonicalStatus {
  return (r.effective_status ?? (r.condition as CanonicalStatus | undefined) ?? 'available');
}

/**
 * Compute same-institution material matches from already-loaded live
 * availability rows for one organization. Pure function — no I/O, no
 * network call, safe to unit test with plain fixtures.
 */
export function computeInternalAlerts(rows: InternalAlertRow[]): InternalAlertMatch[] {
  const supply = rows.filter(r => r.distribution_points && SUPPLY_STATUSES.includes(effOf(r)));
  const demand = rows.filter(r => r.distribution_points && DEMAND_STATUSES.includes(effOf(r)));

  const matches: InternalAlertMatch[] = [];

  for (const s of supply) {
    const sName = norm(s.scientific_name);
    if (!sName) continue;
    const sPoint = s.distribution_points!;

    for (const d of demand) {
      const dPoint = d.distribution_points!;
      if (sPoint.id === dPoint.id) continue; // same outlet — not an actionable internal transfer
      if (norm(d.scientific_name) !== sName) continue;
      if (norm(d.concentration) !== norm(s.concentration)) continue;
      if (norm(d.dosage_form) !== norm(s.dosage_form)) continue;

      const targetStatus = effOf(d) as 'missing' | 'low_stock';
      matches.push({
        scientificName: s.scientific_name!.trim(),
        concentration: s.concentration,
        dosageForm: s.dosage_form,
        sourcePointId: sPoint.id,
        sourcePointName: sPoint.name,
        sourcePointNameAr: sPoint.name_ar,
        sourceStatus: effOf(s) as 'surplus' | 'near_expiry',
        sourceQuantity: s.quantity,
        targetPointId: dPoint.id,
        targetPointName: dPoint.name,
        targetPointNameAr: dPoint.name_ar,
        targetStatus,
        targetQuantity: d.quantity,
        severity: targetStatus === 'missing' ? 'high' : 'medium',
      });
    }
  }

  // Highest severity first, then alphabetically by material name for a stable order.
  return matches.sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === 'high' ? -1 : 1;
    return a.scientificName.localeCompare(b.scientificName);
  });
}
