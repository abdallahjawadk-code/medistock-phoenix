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
  institution?: string | null;
  outlet?: string | null;
  quantity?: string | number | null;
  expiryDate?: string | null;
  lastUpdate?: string | null;
}

/**
 * Builds a professional, non-clinical, bilingual follow-up message.
 * Only fields that are actually present in `input` are included — never
 * invents a field, never adds a diagnosis/clinical recommendation. The
 * generated text still requires the user to press Send inside WhatsApp.
 */
export function buildMaterialContactMessage(input: MaterialContactMessageInput, lang: Lang): string {
  const hasQty = input.quantity !== undefined && input.quantity !== null && input.quantity !== '';

  const fieldLines: string[] = [];
  if (lang === 'ar') {
    if (input.material) fieldLines.push(`المادة: ${input.material}`);
    if (input.status) fieldLines.push(`الحالة: ${input.status}`);
    if (input.institution) fieldLines.push(`المؤسسة: ${input.institution}`);
    if (input.outlet) fieldLines.push(`المنفذ: ${input.outlet}`);
    if (hasQty) fieldLines.push(`الكمية: ${input.quantity}`);
    if (input.expiryDate) fieldLines.push(`تاريخ الانتهاء: ${input.expiryDate}`);
    if (input.lastUpdate) fieldLines.push(`آخر تحديث: ${input.lastUpdate}`);

    return [
      'السلام عليكم،',
      'نود التواصل بخصوص حالة مادة ضمن نظام MediStock Phoenix.',
      ...(fieldLines.length ? ['', ...fieldLines] : []),
      '',
      'يرجى مراجعة الحالة والتنسيق عند الإمكان.',
    ].join('\n');
  }

  if (input.material) fieldLines.push(`Material: ${input.material}`);
  if (input.status) fieldLines.push(`Status: ${input.status}`);
  if (input.institution) fieldLines.push(`Institution: ${input.institution}`);
  if (input.outlet) fieldLines.push(`Outlet: ${input.outlet}`);
  if (hasQty) fieldLines.push(`Quantity: ${input.quantity}`);
  if (input.expiryDate) fieldLines.push(`Expiry date: ${input.expiryDate}`);
  if (input.lastUpdate) fieldLines.push(`Last update: ${input.lastUpdate}`);

  return [
    'Hello,',
    'We would like to follow up regarding a material status in MediStock Phoenix.',
    ...(fieldLines.length ? ['', ...fieldLines] : []),
    '',
    'Please review and coordinate when possible.',
  ].join('\n');
}
