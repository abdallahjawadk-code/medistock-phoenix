/**
 * MOVEMENT-LABELS — the single shared translation map for the Unified
 * Movements contract's closed vocabularies.
 *
 * Both reporting surfaces that render movement rows (MovementReportSection,
 * used by Status Center AND the Decision Intelligence Stock Movements tab,
 * and the Custody Chain trace) need to turn a stored `reason_code` /
 * `movement_type` / ledger source into a translated label. Keeping one map
 * here is the reporting-closure rule in miniature: reuse over a second
 * parallel implementation.
 *
 * `t()` returns the KEY itself for an unknown key, which would render
 * "mvmt_reason_something" to a user. The helpers below therefore check
 * membership explicitly and fall back to the raw stored code — an honest,
 * recognisable value — rather than leaking an i18n key into the UI.
 */
import { t } from '@/shared/i18n/strings';

type Lang = 'ar' | 'en';

/** The closed 16-value reason vocabulary (migration 125). */
export const REASON_CODE_LABEL_KEY: Readonly<Record<string, string>> = Object.freeze({
  received: 'mvmt_reason_received',
  transferred: 'mvmt_reason_transferred',
  dispensed: 'mvmt_reason_dispensed',
  counted: 'mvmt_reason_counted',
  corrected: 'mvmt_reason_corrected',
  released: 'mvmt_reason_released',
  excess: 'mvmt_reason_excess',
  shipment_error: 'mvmt_reason_shipment_error',
  near_expiry: 'mvmt_reason_near_expiry',
  expired: 'mvmt_reason_expired',
  damaged: 'mvmt_reason_damaged',
  recalled: 'mvmt_reason_recalled',
  quality_issue: 'mvmt_reason_quality_issue',
  temperature_excursion: 'mvmt_reason_temperature_excursion',
  other: 'mvmt_reason_other',
  legacy_unclassified: 'mvmt_reason_legacy_unclassified',
});

/** Union of the movement_type CHECK vocabularies across the three ledgers. */
export const MOVEMENT_TYPE_LABEL_KEY: Readonly<Record<string, string>> = Object.freeze({
  set_exact: 'mvmt_set_exact',
  add: 'mvmt_add',
  subtract: 'mvmt_subtract',
  correction: 'mvmt_correction',
  reserve: 'mvmt_type_reserve',
  release: 'mvmt_type_release',
  dispatch_send: 'mvmt_type_dispatch_send',
  dispatch_return: 'mvmt_type_dispatch_return',
  dispatch_receive: 'mvmt_type_dispatch_receive',
  dispense: 'mvmt_type_dispense',
  return_send: 'mvmt_type_return_send',
  quarantine_receive: 'mvmt_type_quarantine_receive',
  quarantine_release: 'mvmt_type_quarantine_release',
  quarantine_destroy: 'mvmt_type_quarantine_destroy',
  quarantine_correction: 'mvmt_type_quarantine_correction',
});

export const LEDGER_SOURCE_LABEL_KEY: Readonly<Record<string, string>> = Object.freeze({
  warehouse: 'mvmt_ledger_warehouse',
  outlet: 'mvmt_ledger_outlet',
  quarantine: 'mvmt_ledger_quarantine',
});

/** Translated reason label, or the raw stored code if it is outside the
 *  known vocabulary (never an i18n key). */
export function reasonCodeLabel(code: string | null | undefined, lang: Lang): string {
  if (!code) return '—';
  const key = REASON_CODE_LABEL_KEY[code];
  return key ? t(key, lang) : code;
}

/** Translated movement-type label, or the raw stored type if unknown. */
export function movementTypeLabel(type: string | null | undefined, lang: Lang): string {
  if (!type) return '—';
  const key = MOVEMENT_TYPE_LABEL_KEY[type];
  return key ? t(key, lang) : type;
}

/** Translated ledger-source label, or the raw stored source if unknown. */
export function ledgerSourceLabel(source: string | null | undefined, lang: Lang): string {
  if (!source) return '—';
  const key = LEDGER_SOURCE_LABEL_KEY[source];
  return key ? t(key, lang) : source;
}
