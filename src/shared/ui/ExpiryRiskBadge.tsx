import { PhoenixStatusBadge } from './PhoenixStatusBadge';
import {
  getExpiryRiskTier,
  getExpiryRiskLabel,
  getExpiryRiskTone,
  isExpiryRiskCritical,
} from '@/shared/lib/expiry-risk';
import { PhoenixIcon } from './PhoenixIcon';

interface Props {
  expiryDate: string | Date | null | undefined;
  lang: 'ar' | 'en';
  /** Injectable for deterministic tests; defaults to the real current time. */
  now?: Date;
}

/**
 * EXPIRY-RISK-TIERS-A
 *
 * Small shared badge for the 9/6/3-month expiry risk tiers (see
 * src/shared/lib/expiry-risk.ts). Renders nothing for 'normal'/'unknown' —
 * the common case — to avoid visual noise; only calls out expired/critical/
 * warning/watch tiers. The two most urgent tiers (expired, critical_3m) get
 * a bold warning-icon treatment per the product requirement that the
 * 3-month tier show a clearly stronger alert state than 6/9-month tiers.
 *
 * UI classification only — never writes to the database, never triggers a
 * backend alert, never changes the stored `condition` value.
 */
export function ExpiryRiskBadge({ expiryDate, lang, now }: Props) {
  const tier = getExpiryRiskTier(expiryDate, now);
  if (tier === 'normal' || tier === 'unknown') return null;

  const tone = getExpiryRiskTone(tier);
  const label = getExpiryRiskLabel(tier, lang);
  const strong = isExpiryRiskCritical(tier);

  return (
    <PhoenixStatusBadge
      variant={tone}
      label={label}
      icon={strong ? <PhoenixIcon name="warning" size={11} /> : undefined}
      style={strong ? { fontWeight: 800 } : undefined}
    />
  );
}
