/* ─── UX-WHATSAPP-INSTITUTION-CONTACT-A — safe wa.me link helper ────────────
   Frontend-only. Builds a plain https://wa.me/<digits>?text=... deep link
   that opens the user's own WhatsApp app/Web with a prefilled message —
   the user must still press send themselves. No WhatsApp Business API, no
   Cloud API, no access tokens, no server calls, no automation of any kind.
   ──────────────────────────────────────────────────────────────────────── */

import type { Lang } from './types';

/**
 * Keep digits only (strips +, spaces, dashes, parentheses, letters).
 * Returns '' when the result is implausibly short to be a real phone number.
 * Never guesses or prepends a country code — if the stored value already
 * includes one, it survives the digit-stripping as-is; if not, this
 * function does not invent one.
 */
export function normalizeWhatsappPhone(raw: string | null | undefined): string {
  if (!raw) return '';
  const digits = raw.replace(/\D+/g, '');
  if (digits.length < 8 || digits.length > 15) return '';
  return digits;
}

export function isValidWhatsappPhone(raw: string | null | undefined): boolean {
  return normalizeWhatsappPhone(raw).length > 0;
}

/**
 * Builds a wa.me deep link. Returns '' when the phone does not normalize to
 * a plausible number — callers must treat that as "cannot open WhatsApp".
 */
export function buildWhatsappUrl(phone: string | null | undefined, message: string): string {
  const digits = normalizeWhatsappPhone(phone);
  if (!digits) return '';
  return `https://wa.me/${digits}?text=${encodeURIComponent(message)}`;
}

export interface MaterialContactMessageInput {
  material?: string | null;
  status?: string | null;
  /** Generic single-institution field — used by the status/officer contact context. */
  institution?: string | null;
  /** UX-WHATSAPP-ALERT-CONTACT-WIRING-A: inter-institution alert context only. */
  sourceInstitution?: string | null;
  targetInstitution?: string | null;
  outlet?: string | null;
  quantity?: string | number | null;
  /**
   * REVIEWER FIX (Phase 3): quantity is ambiguous by itself — a raw source
   * balance and a real computed transfer recommendation must never render
   * with the same generic "Quantity:" label.
   * 'balance'   — a discovery-layer alert's raw source stock; the message
   *               explicitly says it is NOT a transfer suggestion.
   * 'suggested' — a real FEFO-computed suggestion's quantity; labeled as
   *               "for review", never as a done deal.
   * Omitted     — unchanged legacy "Quantity:" wording (status-officer
   *               follow-up context, byte-for-byte preserved).
   */
  quantityLabel?: 'balance' | 'suggested';
  expiryDate?: string | null;
  lastUpdate?: string | null;
  /**
   * 'status' (default) — original generic status follow-up wording, exactly
   * as used by UserManagementScreen's ContactSection (UX-WHATSAPP-INSTITUTION-CONTACT-A).
   * 'alert' — inter-institution material ALERT wording
   * (UX-WHATSAPP-ALERT-CONTACT-WIRING-A). Omitting this field preserves the
   * original 'status' output byte-for-byte.
   */
  context?: 'status' | 'alert';
}

/**
 * Builds a professional, non-clinical, bilingual follow-up message.
 * Only fields that are actually present in `input` are included — never
 * invents a field, never adds a diagnosis/clinical recommendation, never
 * includes a raw id/UUID. The generated text still requires the user to
 * press Send inside WhatsApp.
 */
export function buildMaterialContactMessage(input: MaterialContactMessageInput, lang: Lang): string {
  const hasQty = input.quantity !== undefined && input.quantity !== null && input.quantity !== '';
  const isAlert = input.context === 'alert';
  const qtyLabelAr = input.quantityLabel === 'suggested' ? 'الكمية المقترحة للمراجعة'
    : input.quantityLabel === 'balance' ? 'رصيد المصدر الحالي — ليس كمية مناقلة مقترحة'
    : 'الكمية';
  const qtyLabelEn = input.quantityLabel === 'suggested' ? 'Suggested quantity for review'
    : input.quantityLabel === 'balance' ? 'Current source balance — not a suggested transfer quantity'
    : 'Quantity';

  const fieldLines: string[] = [];
  if (lang === 'ar') {
    if (input.material) fieldLines.push(`المادة: ${input.material}`);
    if (input.status) fieldLines.push(`الحالة: ${input.status}`);
    if (input.institution) fieldLines.push(`المؤسسة: ${input.institution}`);
    if (input.sourceInstitution) fieldLines.push(`المؤسسة المرسلة: ${input.sourceInstitution}`);
    if (input.targetInstitution) fieldLines.push(`المؤسسة المستلمة: ${input.targetInstitution}`);
    if (input.outlet) fieldLines.push(`المنفذ: ${input.outlet}`);
    if (hasQty) fieldLines.push(`${qtyLabelAr}: ${input.quantity}`);
    if (input.expiryDate) fieldLines.push(`تاريخ الانتهاء: ${input.expiryDate}`);
    if (input.lastUpdate) fieldLines.push(`آخر تحديث: ${input.lastUpdate}`);

    return [
      'السلام عليكم،',
      isAlert
        ? 'نود التواصل بخصوص تنبيه مادة ضمن نظام MediStock Phoenix.'
        : 'نود التواصل بخصوص حالة مادة ضمن نظام MediStock Phoenix.',
      ...(fieldLines.length ? ['', ...fieldLines] : []),
      '',
      'يرجى مراجعة الحالة والتنسيق عند الإمكان.',
    ].join('\n');
  }

  if (input.material) fieldLines.push(`Material: ${input.material}`);
  if (input.status) fieldLines.push(`Status: ${input.status}`);
  if (input.institution) fieldLines.push(`Institution: ${input.institution}`);
  if (input.sourceInstitution) fieldLines.push(`Source institution: ${input.sourceInstitution}`);
  if (input.targetInstitution) fieldLines.push(`Target institution: ${input.targetInstitution}`);
  if (input.outlet) fieldLines.push(`Outlet: ${input.outlet}`);
  if (hasQty) fieldLines.push(`${qtyLabelEn}: ${input.quantity}`);
  if (input.expiryDate) fieldLines.push(`Expiry date: ${input.expiryDate}`);
  if (input.lastUpdate) fieldLines.push(`Last update: ${input.lastUpdate}`);

  return [
    'Hello,',
    isAlert
      ? 'We would like to follow up regarding a material alert in MediStock Phoenix.'
      : 'We would like to follow up regarding a material status in MediStock Phoenix.',
    ...(fieldLines.length ? ['', ...fieldLines] : []),
    '',
    'Please review and coordinate when possible.',
  ].join('\n');
}
