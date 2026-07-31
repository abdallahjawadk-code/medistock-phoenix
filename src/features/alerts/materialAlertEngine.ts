import type { StatusReport } from '@/shared/supabase/services/status-reports.service';

export type AlertSeverity = 'critical' | 'urgent' | 'high' | 'watch' | 'opportunity' | 'info';
export type AlertKind = 'expiry' | 'missing' | 'surplus' | 'data_quality';
export type ExpiryBucket = 'expired' | '3_months' | '6_months' | '9_months';
export type MatchConfidence = 'high' | 'medium';

export interface MaterialAlert {
  id: string;
  kind: AlertKind;
  severity: AlertSeverity;
  materialKey: string;
  materialName: string;
  materialNameAr: string;
  institutionId: string;
  institutionName: string;
  institutionNameAr: string;
  quantity: number | null;
  unit: string | null;
  expiryDate: string | null;
  daysUntilExpiry: number | null;
  monthsBucket: ExpiryBucket | null;
  reason: string;
  reasonAr: string;
  suggestedAction: string;
  suggestedActionAr: string;
  manualActionRequired: true;
}

export interface ExchangeSuggestion {
  id: string;
  sourceInstitutionId: string;
  sourceInstitutionName: string;
  sourceInstitutionNameAr: string;
  destinationInstitutionId: string;
  destinationInstitutionName: string;
  destinationInstitutionNameAr: string;
  materialKey: string;
  materialName: string;
  materialNameAr: string;
  sourceCondition: string;
  destinationNeed: string;
  severity: AlertSeverity;
  confidence: MatchConfidence;
  quantity: number | null;
  unit: string | null;
  expiryDate: string | null;
  suggestedAction: string;
  suggestedActionAr: string;
  manualActionRequired: true;
}

export interface MaterialAlertEngineOutput {
  alerts: MaterialAlert[];
  suggestions: ExchangeSuggestion[];
  summary: {
    criticalCount: number;
    urgentCount: number;
    highCount: number;
    watchCount: number;
    opportunityCount: number;
    dataQualityCount: number;
  };
  computedAt: string;
}

// ─── Date utilities ───────────────────────────────────────────────────────────

export function parseExpiryDate(s: string | null | undefined): Date | null {
  if (!s || typeof s !== 'string') return null;
  const dateStr = s.trim().slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) return null;
  const d = new Date(dateStr + 'T00:00:00');
  return isNaN(d.getTime()) ? null : d;
}

// Matches Postgres `(date + interval 'N months')::date` semantics:
// the result day is clamped to the last day of the target month,
// preventing JS Date overflow at month boundaries (e.g. Jan 31 + 1 month → Feb 28/29).
export function addMonths(base: Date, months: number): Date {
  const rawMonth  = base.getMonth() + months;
  const y         = base.getFullYear() + Math.floor(rawMonth / 12);
  const m         = ((rawMonth % 12) + 12) % 12;
  const lastDay   = new Date(y, m + 1, 0).getDate(); // day 0 of next month = last day of m
  return new Date(y, m, Math.min(base.getDate(), lastDay));
}

export function daysUntil(today: Date, target: Date): number {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate()).getTime();
  const e = new Date(target.getFullYear(), target.getMonth(), target.getDate()).getTime();
  return Math.round((e - t) / 86_400_000);
}

export function expiryBucket(today: Date, expiry: Date): ExpiryBucket | null {
  const base = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  const exp  = new Date(expiry.getFullYear(), expiry.getMonth(), expiry.getDate());
  if (exp < base) return 'expired';
  if (exp <= addMonths(base, 3)) return '3_months';
  if (exp <= addMonths(base, 6)) return '6_months';
  if (exp <= addMonths(base, 9)) return '9_months';
  return null;
}

export function expiryBucketToSeverity(bucket: ExpiryBucket): AlertSeverity {
  switch (bucket) {
    case 'expired':  return 'critical';
    case '3_months': return 'urgent';
    case '6_months': return 'high';
    case '9_months': return 'watch';
  }
}

// Returns the canonical color/bg for a bucket — single source of truth shared by
// DashboardScreen, InterInstitutionAlertsScreen, and PublicQrScreen.
export function getExpiryBucketStyle(bucket: string): { color: string; bg: string } | null {
  switch (bucket) {
    case 'expired':  return { color: 'var(--err)',         bg: 'var(--err2)'         };
    case '3_months': return { color: 'var(--risk-tier-3m)', bg: 'var(--risk-tier-3m-bg)' };
    case '6_months': return { color: 'var(--warn)',         bg: 'var(--warn2)'        };
    case '9_months': return { color: 'var(--risk-tier-9m)', bg: 'var(--risk-tier-9m-bg)' };
    default:         return null;
  }
}

// ─── Material key matching ────────────────────────────────────────────────────

function normalize(s: string | null | undefined): string {
  return s ? s.trim().toLowerCase().replace(/\s+/g, ' ') : '';
}

export function materialKey(r: StatusReport): string {
  if (r.item_id) return `id:${r.item_id}`;
  const en = normalize(r.item_name);
  const ar = normalize(r.item_name_ar);
  if (en && ar) return `name:${en}|${ar}`;
  return en ? `name:${en}` : ar ? `name:${ar}` : '';
}

function keysMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;
  const cA = a.indexOf(':'), cB = b.indexOf(':');
  const typeA = a.slice(0, cA), typeB = b.slice(0, cB);
  const valA  = a.slice(cA + 1), valB  = b.slice(cB + 1);
  if (typeA === 'id' && typeB === 'id') return valA === valB;
  if (typeA === 'id' || typeB === 'id') return false;
  const pA = valA.split('|'), pB = valB.split('|');
  return pA.some(x => x && pB.includes(x));
}

// Name-only match (medium confidence) does NOT guarantee pharmacological equivalence:
// concentration, dosage_form, and supply_type are absent from StatusReport.
// Matching on those fields is deferred to Phase 5 when StatusReport gains them.
// Guard: if neither side carries item_id nor any name, return null — no blind matching.
function matchConfidence(src: StatusReport, dst: StatusReport): MatchConfidence | null {
  if (src.item_id && dst.item_id) return src.item_id === dst.item_id ? 'high' : null;
  const srcEn = normalize(src.item_name), dstEn = normalize(dst.item_name);
  const srcAr = normalize(src.item_name_ar), dstAr = normalize(dst.item_name_ar);
  if (!srcEn && !srcAr && !dstEn && !dstAr) return null;
  return (srcEn && srcEn === dstEn) || (srcAr && srcAr === dstAr) ? 'medium' : null;
}

// ─── Severity rank (for sorting) ─────────────────────────────────────────────

const SEV_RANK: Record<AlertSeverity, number> = {
  critical: 6, urgent: 5, high: 4, watch: 3, opportunity: 2, info: 1,
};

// ─── Main engine ─────────────────────────────────────────────────────────────
// Pure: no DB writes, no network calls, no fake data, no hardcoded results.
// Deterministic: identical inputs always produce identical outputs.
// Safe: null / undefined / invalid fields never crash the engine.

export function computeMaterialAlerts(
  reports: StatusReport[],
  today: Date = new Date(),
): MaterialAlertEngineOutput {
  const active = reports.filter(r => r.is_active);
  const alerts: MaterialAlert[] = [];
  const suggestions: ExchangeSuggestion[] = [];

  for (const r of active) {
    const mk = materialKey(r);
    if (!mk) continue;

    const instName   = r.organizations?.name    ?? '';
    const instNameAr = r.organizations?.name_ar ?? '';
    const matName    = r.item_name    ?? r.item_name_ar ?? '';
    const matNameAr  = r.item_name_ar ?? r.item_name    ?? '';

    // 1. Expiry alerts — computed from expiry_date, independent of manual status
    const expDate = parseExpiryDate(r.expiry_date);
    if (expDate !== null) {
      const days   = daysUntil(today, expDate);
      const bucket = expiryBucket(today, expDate);

      if (bucket !== null) {
        const isExpired = bucket === 'expired';
        const monthsStr = bucket === '3_months' ? '3' : bucket === '6_months' ? '6' : '9';
        alerts.push({
          id: `expiry:${r.id}`,
          kind: 'expiry',
          severity: expiryBucketToSeverity(bucket),
          materialKey: mk, materialName: matName, materialNameAr: matNameAr,
          institutionId: r.organization_id, institutionName: instName, institutionNameAr: instNameAr,
          quantity: r.quantity, unit: r.unit, expiryDate: r.expiry_date,
          daysUntilExpiry: days, monthsBucket: bucket,
          reason: isExpired ? 'expired_material' : `expires_within_${monthsStr}_months`,
          reasonAr: isExpired ? 'expired_material' : `expires_within_${monthsStr}_months`,
          suggestedAction: isExpired ? 'urgent_redistribution' : 'rotate_before_expiry',
          suggestedActionAr: isExpired ? 'urgent_redistribution' : 'rotate_before_expiry',
          manualActionRequired: true,
        });
      }

      // Data quality: expiry_date in the past but status doesn't say near_expiry/missing
      if (days < 0 && r.status_type !== 'near_expiry' && r.status_type !== 'missing') {
        alerts.push({
          id: `dq:exp-status:${r.id}`,
          kind: 'data_quality', severity: 'info',
          materialKey: mk, materialName: matName, materialNameAr: matNameAr,
          institutionId: r.organization_id, institutionName: instName, institutionNameAr: instNameAr,
          quantity: r.quantity, unit: r.unit, expiryDate: r.expiry_date,
          daysUntilExpiry: days, monthsBucket: 'expired',
          reason: 'expired_but_marked_available',
          reasonAr: 'expired_but_marked_available',
          suggestedAction: 'current_position_based',
          suggestedActionAr: 'current_position_based',
          manualActionRequired: true,
        });
      }
    }

    // 2. Status-based alerts
    if (r.status_type === 'missing') {
      alerts.push({
        id: `missing:${r.id}`,
        kind: 'missing', severity: 'critical',
        materialKey: mk, materialName: matName, materialNameAr: matNameAr,
        institutionId: r.organization_id, institutionName: instName, institutionNameAr: instNameAr,
        quantity: r.quantity, unit: r.unit, expiryDate: r.expiry_date,
        daysUntilExpiry: null, monthsBucket: null,
        reason: 'missing_material', reasonAr: 'missing_material',
        suggestedAction: 'urgent_redistribution', suggestedActionAr: 'urgent_redistribution',
        manualActionRequired: true,
      });

      // Data quality: missing status but positive quantity is contradictory
      if (r.quantity != null && r.quantity > 0) {
        alerts.push({
          id: `dq:qty-missing:${r.id}`,
          kind: 'data_quality', severity: 'info',
          materialKey: mk, materialName: matName, materialNameAr: matNameAr,
          institutionId: r.organization_id, institutionName: instName, institutionNameAr: instNameAr,
          quantity: r.quantity, unit: r.unit, expiryDate: r.expiry_date,
          daysUntilExpiry: null, monthsBucket: null,
          reason: 'available_but_zero_quantity', reasonAr: 'available_but_zero_quantity',
          suggestedAction: 'current_position_based', suggestedActionAr: 'current_position_based',
          manualActionRequired: true,
        });
      }
    }

    if (r.status_type === 'scarce') {
      alerts.push({
        id: `scarce:${r.id}`,
        kind: 'missing', severity: 'urgent',
        materialKey: mk, materialName: matName, materialNameAr: matNameAr,
        institutionId: r.organization_id, institutionName: instName, institutionNameAr: instNameAr,
        quantity: r.quantity, unit: r.unit, expiryDate: r.expiry_date,
        daysUntilExpiry: null, monthsBucket: null,
        reason: 'out_of_stock', reasonAr: 'out_of_stock',
        suggestedAction: 'urgent_redistribution', suggestedActionAr: 'urgent_redistribution',
        manualActionRequired: true,
      });
    }

    if (r.status_type === 'surplus') {
      alerts.push({
        id: `surplus:${r.id}`,
        kind: 'surplus', severity: 'opportunity',
        materialKey: mk, materialName: matName, materialNameAr: matNameAr,
        institutionId: r.organization_id, institutionName: instName, institutionNameAr: instNameAr,
        quantity: r.quantity, unit: r.unit, expiryDate: r.expiry_date,
        daysUntilExpiry: null, monthsBucket: null,
        reason: 'surplus_for_redistribution', reasonAr: 'surplus_for_redistribution',
        suggestedAction: 'verify_quantity_before_transfer',
        suggestedActionAr: 'verify_quantity_before_transfer',
        manualActionRequired: true,
      });
    }
  }

  // 3. Exchange suggestions — cross-org material matches (exact match only)
  const sources = active.filter(r => r.status_type === 'surplus' || r.status_type === 'near_expiry');
  const targets = active.filter(r => r.status_type === 'missing'  || r.status_type === 'scarce');
  const seen    = new Set<string>();

  for (const src of sources) {
    const srcKey = materialKey(src);
    if (!srcKey) continue;

    for (const tgt of targets) {
      if (src.organization_id === tgt.organization_id) continue;
      const tgtKey = materialKey(tgt);
      if (!tgtKey || !keysMatch(srcKey, tgtKey)) continue;

      const confidence = matchConfidence(src, tgt);
      if (!confidence) continue;

      const pairId = `${src.id}:${tgt.id}`;
      if (seen.has(pairId)) continue;
      seen.add(pairId);

      const hasQty      = src.quantity != null && src.quantity > 0;
      const isNearExpiry = src.status_type === 'near_expiry';
      const isMissing    = tgt.status_type === 'missing';

      let severity: AlertSeverity;
      if (isNearExpiry && isMissing)          severity = 'urgent';
      else if (isMissing && hasQty)            severity = 'urgent';
      else if (isMissing && !hasQty)           severity = 'opportunity';
      else                                      severity = 'high'; // surplus+scarce or near_expiry+scarce

      suggestions.push({
        id: pairId,
        sourceInstitutionId:     src.organization_id,
        sourceInstitutionName:   src.organizations?.name    ?? '',
        sourceInstitutionNameAr: src.organizations?.name_ar ?? '',
        destinationInstitutionId:     tgt.organization_id,
        destinationInstitutionName:   tgt.organizations?.name    ?? '',
        destinationInstitutionNameAr: tgt.organizations?.name_ar ?? '',
        materialKey: srcKey,
        materialName:   src.item_name    ?? tgt.item_name    ?? '',
        materialNameAr: src.item_name_ar ?? tgt.item_name_ar ?? '',
        sourceCondition: src.status_type,
        destinationNeed: tgt.status_type,
        severity, confidence,
        quantity: src.quantity, unit: src.unit, expiryDate: src.expiry_date,
        suggestedAction:   isNearExpiry ? 'rotate_before_expiry' : 'verify_quantity_before_transfer',
        suggestedActionAr: isNearExpiry ? 'rotate_before_expiry' : 'verify_quantity_before_transfer',
        manualActionRequired: true,
      });
    }
  }

  alerts.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);
  suggestions.sort((a, b) => SEV_RANK[b.severity] - SEV_RANK[a.severity]);

  return {
    alerts,
    suggestions,
    summary: {
      criticalCount:    alerts.filter(a => a.severity === 'critical').length,
      urgentCount:      alerts.filter(a => a.severity === 'urgent').length,
      highCount:        alerts.filter(a => a.severity === 'high').length,
      watchCount:       alerts.filter(a => a.severity === 'watch').length,
      opportunityCount: alerts.filter(a => a.severity === 'opportunity').length,
      dataQualityCount: alerts.filter(a => a.kind === 'data_quality').length,
    },
    computedAt: today.toISOString(),
  };
}
