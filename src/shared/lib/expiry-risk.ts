/**
 * EXPIRY-RISK-TIERS-A
 *
 * Frontend-only visual expiry risk classification: expired / critical
 * (0–3 months) / high warning (3–6 months) / early warning (6–9 months) /
 * normal (>9 months) / unknown (no parseable date).
 *
 * This is intentionally a thin wrapper around the existing, already-tested
 * date math in `src/shared/lib/status/canonical.ts` (`parseExpiryDate`,
 * `addMonthsClamped`) — the same bucketing rules already power
 * `getExpiryBucket`/`computeEffectiveStatus` there and
 * `expiryBucket`/`getExpiryBucketStyle` in
 * `src/features/alerts/materialAlertEngine.ts` (which mirrors migration
 * 028's Postgres logic). This module does NOT reimplement date arithmetic —
 * it only adds the specific tier vocabulary, bilingual labels, and a badge
 * "tone" mapping that the UI layer needs, distinguishing `'normal'`
 * (parseable date, beyond the 9-month horizon) from `'unknown'`
 * (null/undefined/unparseable date) — a distinction `getExpiryBucket` does
 * not make (it collapses both to `null`).
 *
 * Scope: UI classification only. Does NOT touch backend alert generation,
 * the live inter-institution alert RPC, database status values, or the
 * existing 3-month `near_expiry` backend/alert threshold.
 */

import { parseExpiryDate, addMonthsClamped } from './status/canonical';

export type ExpiryRiskTier =
  | 'expired'
  | 'critical_3m'
  | 'warning_6m'
  | 'watch_9m'
  | 'normal'
  | 'unknown';

/** Maps directly onto PhoenixStatusBadge's variant prop — no new CSS/tokens needed. */
export type ExpiryRiskTone = 'err' | 'warn' | 'info' | 'ok' | 'neutral';

function dateOnly(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/**
 * Classifies an expiry date into a risk tier relative to `now` (defaults to
 * the real current time; injectable for deterministic tests).
 *
 *   unknown      — expiryDate is null/undefined/unparseable
 *   expired      — expiryDate < today
 *   critical_3m  — today <= expiryDate <= today + 3 months
 *   warning_6m   — today + 3 months < expiryDate <= today + 6 months
 *   watch_9m     — today + 6 months < expiryDate <= today + 9 months
 *   normal       — expiryDate > today + 9 months
 *
 * Never throws — invalid/null/undefined input safely returns 'unknown'.
 */
export function getExpiryRiskTier(
  expiryDate: string | Date | null | undefined,
  now: Date = new Date(),
): ExpiryRiskTier {
  const exp = parseExpiryDate(expiryDate);
  if (!exp) return 'unknown';

  const base = dateOnly(now);
  const e = dateOnly(exp);

  if (e < base) return 'expired';
  if (e <= addMonthsClamped(base, 3)) return 'critical_3m';
  if (e <= addMonthsClamped(base, 6)) return 'warning_6m';
  if (e <= addMonthsClamped(base, 9)) return 'watch_9m';
  return 'normal';
}

/**
 * Approximate whole months remaining until expiry (average month length),
 * for display purposes only — NOT used to compute the tier itself (the
 * tier uses exact calendar-month comparisons via addMonthsClamped). Returns
 * null for unparseable/missing dates. Negative values indicate an already-
 * expired date.
 */
export function getExpiryRiskMonthsRemaining(
  expiryDate: string | Date | null | undefined,
  now: Date = new Date(),
): number | null {
  const exp = parseExpiryDate(expiryDate);
  if (!exp) return null;
  const base = dateOnly(now);
  const e = dateOnly(exp);
  const days = Math.round((e.getTime() - base.getTime()) / 86_400_000);
  return Math.round(days / 30.4368);
}

const EXPIRY_RISK_LABELS: Record<ExpiryRiskTier, { ar: string; en: string }> = {
  expired:     { ar: 'منتهي الصلاحية',                     en: 'Expired' },
  critical_3m: { ar: 'قريب النفاد جداً - خلال 3 أشهر',      en: 'Critical expiry - within 3 months' },
  warning_6m:  { ar: 'قرب نفاد عالٍ - خلال 6 أشهر',         en: 'High expiry warning - within 6 months' },
  watch_9m:    { ar: 'مراقبة نفاد مبكرة - خلال 9 أشهر',     en: 'Early expiry watch - within 9 months' },
  normal:      { ar: 'طبيعي',                              en: 'Normal' },
  unknown:     { ar: 'غير محدد',                            en: 'Unknown' },
};

export function getExpiryRiskLabel(tier: ExpiryRiskTier, lang: 'ar' | 'en' = 'en'): string {
  return EXPIRY_RISK_LABELS[tier][lang];
}

const EXPIRY_RISK_TONES: Record<ExpiryRiskTier, ExpiryRiskTone> = {
  expired: 'err',
  critical_3m: 'err',
  warning_6m: 'warn',
  watch_9m: 'info',
  normal: 'ok',
  unknown: 'neutral',
};

export function getExpiryRiskTone(tier: ExpiryRiskTier): ExpiryRiskTone {
  return EXPIRY_RISK_TONES[tier];
}

/** True for the two tiers that warrant a stronger visual treatment (icon/bold), per the product requirement that the 3-month tier show a clear alert state. */
export function isExpiryRiskCritical(tier: ExpiryRiskTier): boolean {
  return tier === 'expired' || tier === 'critical_3m';
}
