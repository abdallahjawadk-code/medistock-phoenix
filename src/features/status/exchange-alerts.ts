import type { StatusReport } from '@/shared/supabase/services/status-reports.service';

export type AlertPriority = 'high' | 'medium' | 'low';

export interface ExchangeAlert {
  id: string;
  sourceOrgId: string;
  sourceOrgName: string;
  sourceOrgNameAr: string;
  targetOrgId: string;
  targetOrgName: string;
  targetOrgNameAr: string;
  itemKey: string;
  itemName: string;
  itemNameAr: string;
  sourceStatus: string;
  targetStatus: string;
  quantity: number | null;
  unit: string | null;
  expiryDate: string | null;
  priority: AlertPriority;
  manualActionRequired: true;
}

function normalizeText(text: string | null | undefined): string {
  if (!text) return '';
  return text.trim().toLowerCase().replace(/\s+/g, ' ');
}

function itemKey(report: StatusReport): string {
  if (report.item_id) return `id:${report.item_id}`;
  const en = normalizeText(report.item_name);
  const ar = normalizeText(report.item_name_ar);
  if (en && ar) return `name:${en}|${ar}`;
  if (en) return `name:${en}`;
  if (ar) return `name:${ar}`;
  return '';
}

function keysMatch(a: string, b: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;

  const pa = a.split(':');
  const pb = b.split(':');

  if (pa[0] === 'id' && pb[0] === 'id') return pa[1] === pb[1];
  if (pa[0] === 'id' || pb[0] === 'id') return false;

  const partsA = (pa[1] ?? '').split('|');
  const partsB = (pb[1] ?? '').split('|');
  return partsA.some(a => a && partsB.some(b => b && a === b));
}

function computePriority(sourceStatus: string, targetStatus: string, hasQuantity: boolean): AlertPriority | null {
  if (sourceStatus === 'near_expiry' && targetStatus === 'missing') return 'high';
  if (sourceStatus === 'surplus' && targetStatus === 'missing' && hasQuantity) return 'high';
  if (sourceStatus === 'surplus' && targetStatus === 'scarce') return 'medium';
  if (sourceStatus === 'near_expiry' && targetStatus === 'scarce') return 'medium';
  if (sourceStatus === 'surplus' && targetStatus === 'missing' && !hasQuantity) return 'low';
  return null;
}

const SOURCE_STATUSES = new Set(['surplus', 'near_expiry']);
const TARGET_STATUSES = new Set(['scarce', 'missing']);

export function generateExchangeAlerts(reports: StatusReport[]): ExchangeAlert[] {
  const active = reports.filter(r => r.is_active);

  const sources = active.filter(r => SOURCE_STATUSES.has(r.status_type));
  const targets = active.filter(r => TARGET_STATUSES.has(r.status_type));

  const alerts: ExchangeAlert[] = [];
  const seen = new Set<string>();

  for (const src of sources) {
    const srcKey = itemKey(src);
    if (!srcKey) continue;

    for (const tgt of targets) {
      if (src.organization_id === tgt.organization_id) continue;

      const tgtKey = itemKey(tgt);
      if (!tgtKey) continue;

      if (!keysMatch(srcKey, tgtKey)) continue;

      const pairId = `${src.id}:${tgt.id}`;
      if (seen.has(pairId)) continue;
      seen.add(pairId);

      const priority = computePriority(src.status_type, tgt.status_type, src.quantity != null);
      if (!priority) continue;

      const srcOrg = src.organizations;
      const tgtOrg = tgt.organizations;

      alerts.push({
        id: pairId,
        sourceOrgId: src.organization_id,
        sourceOrgName: srcOrg?.name ?? '',
        sourceOrgNameAr: srcOrg?.name_ar ?? '',
        targetOrgId: tgt.organization_id,
        targetOrgName: tgtOrg?.name ?? '',
        targetOrgNameAr: tgtOrg?.name_ar ?? '',
        itemKey: srcKey,
        itemName: src.item_name ?? tgt.item_name ?? '',
        itemNameAr: src.item_name_ar ?? tgt.item_name_ar ?? '',
        sourceStatus: src.status_type,
        targetStatus: tgt.status_type,
        quantity: src.quantity,
        unit: src.unit,
        expiryDate: src.expiry_date,
        priority,
        manualActionRequired: true,
      });
    }
  }

  alerts.sort((a, b) => {
    const rank: Record<AlertPriority, number> = { high: 3, medium: 2, low: 1 };
    return rank[b.priority] - rank[a.priority];
  });

  return alerts;
}
