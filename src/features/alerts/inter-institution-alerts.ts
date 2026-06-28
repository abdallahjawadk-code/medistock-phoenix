import type { StatusReport } from '@/shared/supabase/services/status-reports.service';
import {
  generateExchangeAlerts,
  type ExchangeAlert,
  type AlertPriority,
} from '@/features/status/exchange-alerts';

export type { AlertPriority } from '@/features/status/exchange-alerts';

/** Contact for an organization's Monthly Status Officer (scoped, never public). */
export interface OrgContact {
  organizationId: string;
  displayName: string | null;
  phone: string | null;
}

export type StatusPair =
  | 'surplus_missing'
  | 'surplus_scarce'
  | 'expiry_missing'
  | 'expiry_scarce';

/** A fully-resolved alert with counterpart contact info for the UI. */
export interface ScopedAlert extends ExchangeAlert {
  recommendationKind: 'surplus_match' | 'expiry_match';
  statusPair: StatusPair;
  sourceContactName: string | null;
  sourceContactPhone: string | null;
  targetContactName: string | null;
  targetContactPhone: string | null;
}

/** Stable i18n key for a (source, target) status pair. */
export function statusPairKey(sourceStatus: string, targetStatus: string): StatusPair {
  if (sourceStatus === 'surplus' && targetStatus === 'missing') return 'surplus_missing';
  if (sourceStatus === 'surplus' && targetStatus === 'scarce') return 'surplus_scarce';
  if (sourceStatus === 'near_expiry' && targetStatus === 'missing') return 'expiry_missing';
  return 'expiry_scarce';
}

export const STATUS_PAIR_LABEL_KEY: Record<StatusPair, string> = {
  surplus_missing: 'iia_pair_surplus_missing',
  surplus_scarce:  'iia_pair_surplus_scarce',
  expiry_missing:  'iia_pair_expiry_missing',
  expiry_scarce:   'iia_pair_expiry_scarce',
};

/**
 * Strict isolation: super_admin keeps every alert; any other actor keeps only
 * alerts where their own organization is the source OR the target party.
 * Mirrors the WHERE clause of get_scoped_inter_institution_alerts (migration 009).
 */
export function scopeAlertsForActor<T extends { sourceOrgId: string; targetOrgId: string }>(
  alerts: T[],
  actorOrgId: string | null,
  isSuper: boolean,
): T[] {
  if (isSuper) return alerts;
  if (!actorOrgId) return [];
  return alerts.filter(a => a.sourceOrgId === actorOrgId || a.targetOrgId === actorOrgId);
}

function contactMap(contacts: OrgContact[]): Map<string, OrgContact> {
  const map = new Map<string, OrgContact>();
  for (const c of contacts) {
    if (!map.has(c.organizationId)) map.set(c.organizationId, c);
  }
  return map;
}

/** Attach source/target contacts and derived fields to a base alert. */
export function toScopedAlert(alert: ExchangeAlert, contacts: Map<string, OrgContact>): ScopedAlert {
  const src = contacts.get(alert.sourceOrgId);
  const tgt = contacts.get(alert.targetOrgId);
  return {
    ...alert,
    recommendationKind: alert.sourceStatus === 'near_expiry' ? 'expiry_match' : 'surplus_match',
    statusPair: statusPairKey(alert.sourceStatus, alert.targetStatus),
    sourceContactName:  src?.displayName ?? null,
    sourceContactPhone: src?.phone ?? null,
    targetContactName:  tgt?.displayName ?? null,
    targetContactPhone: tgt?.phone ?? null,
  };
}

/**
 * Client-side fallback used ONLY for super_admin (who is permitted to see all
 * reports). Non-super actors must use the scoped RPC instead — never compute
 * cross-institution alerts in the browser for them.
 */
export function buildScopedAlertsFromReports(
  reports: StatusReport[],
  contacts: OrgContact[],
  actorOrgId: string | null,
  isSuper: boolean,
): ScopedAlert[] {
  const base = generateExchangeAlerts(reports);
  const scoped = scopeAlertsForActor(base, actorOrgId, isSuper);
  const map = contactMap(contacts);
  return scoped.map(a => toScopedAlert(a, map));
}

const PRIORITY_RANK: Record<AlertPriority, number> = { high: 3, medium: 2, low: 1 };

/** Sort high → low priority (stable for equal priorities). */
export function sortByPriority<T extends { priority: AlertPriority }>(alerts: T[]): T[] {
  return [...alerts].sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
}

/** Build a copy-ready bilingual contact recommendation summary for an alert. */
export function recommendationSummary(a: ScopedAlert, lang: 'ar' | 'en'): string {
  const item = lang === 'ar' ? (a.itemNameAr || a.itemName) : (a.itemName || a.itemNameAr);
  const source = lang === 'ar' ? (a.sourceOrgNameAr || a.sourceOrgName) : (a.sourceOrgName || a.sourceOrgNameAr);
  const target = lang === 'ar' ? (a.targetOrgNameAr || a.targetOrgName) : (a.targetOrgName || a.targetOrgNameAr);
  const qty = a.quantity != null ? `${a.quantity}${a.unit ? ` ${a.unit}` : ''}` : '';
  if (lang === 'ar') {
    return [
      `المادة: ${item}`,
      `المصدر (فائض/قريب النفاد): ${source}`,
      `المحتاجة (شحيح/مفقود): ${target}`,
      qty ? `الكمية: ${qty}` : '',
      a.sourceContactPhone ? `هاتف المصدر: ${a.sourceContactPhone}` : '',
      a.targetContactPhone ? `هاتف المحتاجة: ${a.targetContactPhone}` : '',
      'إجراء يدوي — لا نقل تلقائي.',
    ].filter(Boolean).join('\n');
  }
  return [
    `Item: ${item}`,
    `Source (surplus/near-expiry): ${source}`,
    `Target (scarce/missing): ${target}`,
    qty ? `Quantity: ${qty}` : '',
    a.sourceContactPhone ? `Source phone: ${a.sourceContactPhone}` : '',
    a.targetContactPhone ? `Target phone: ${a.targetContactPhone}` : '',
    'Manual action — no auto-transfer.',
  ].filter(Boolean).join('\n');
}
