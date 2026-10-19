/**
 * R1-A4 — copy for the manual annual-needs workspace (Arabic first, English parity).
 * Kept beside the feature so adding it cannot disturb the shared dictionary's ordering/parity tests.
 * A server refusal is rendered by `centralNeedsErrorText` (which degrades to the database identifier
 * for a code without a translation) — never by a generic "something went wrong".
 */
import type { ManualQuantityReason } from './manual-quantity';

export type ManualLang = 'ar' | 'en';

const D = {
  title: { ar: 'الاحتياج السنوي — إدخال يدوي', en: 'Annual needs — manual entry' },
  notEnabled: { ar: 'الإدخال اليدوي غير مُفعّل لحسابك أو لهذه المؤسسة.', en: 'Manual entry is not enabled for your account or this organization.' },
  readOnlyRevision: { ar: 'هذا الإصدار ليس مسودة يدوية؛ العرض للقراءة فقط.', en: 'This revision is not a manual draft; it is shown read-only.' },
  loading: { ar: 'جارٍ التحميل…', en: 'Loading…' },
  loadFailed: { ar: 'تعذّر تحميل الأسطر. لم يتغيّر شيء.', en: 'The lines could not be loaded. Nothing was changed.' },
  empty: { ar: 'لا توجد أسطر بعد.', en: 'No lines yet.' },
  beneficiary: { ar: 'المؤسسة المستفيدة', en: 'Beneficiary institution' },
  item: { ar: 'المادة', en: 'Item' },
  quantity: { ar: 'الكمية السنوية', en: 'Annual quantity' },
  quantityHint: { ar: 'أرقام إنجليزية فقط (مثال: 12 أو 12.5). لا فواصل آلاف ولا أصفار زائدة.', en: 'ASCII digits only (e.g. 12 or 12.5). No thousands separators or trailing zeros.' },
  unit: { ar: 'الوحدة', en: 'Unit' },
  reason: { ar: 'السبب', en: 'Reason' },
  choose: { ar: 'اختر…', en: 'Choose…' },
  add: { ar: 'إضافة سطر', en: 'Add line' },
  correct: { ar: 'تصحيح', en: 'Correct' },
  void: { ar: 'إلغاء السطر', en: 'Void line' },
  save: { ar: 'حفظ', en: 'Save' },
  cancel: { ar: 'إلغاء الأمر', en: 'Cancel' },
  saved: { ar: 'تم الحفظ وتحديث القائمة من الخادم.', en: 'Saved; the list was refreshed from the server.' },
  replay: { ar: 'هذا الطلب نُفّذ سابقًا ولم يتكرر.', en: 'This request had already been applied and was not repeated.' },
  staleRefreshed: { ar: 'تغيّر السطر في الخادم. حُدّثت القائمة؛ راجع ثم أعد المحاولة.', en: 'The line changed on the server. The list was refreshed; review and try again.' },
  history: { ar: 'السجل', en: 'History' },
  voided: { ar: 'ملغى', en: 'Voided' },
  q_empty: { ar: 'أدخل الكمية.', en: 'Enter the quantity.' },
  q_non_ascii_digits: { ar: 'استخدم الأرقام الإنجليزية (0-9) والنقطة العشرية فقط.', en: 'Use ASCII digits (0-9) and a dot as the decimal mark only.' },
  q_too_long: { ar: 'الكمية أطول من الحد المسموح.', en: 'The quantity is too long.' },
  q_not_canonical: { ar: 'صيغة غير مقبولة: بلا إشارة ولا فراغ ولا أس ولا أصفار زائدة في البداية أو بعد الفاصلة.', en: 'Not accepted: no sign, spaces, exponent, leading zeros or trailing zeros after the decimal point.' },
  q_proposal: { ar: 'هل تقصد: __Q__؟ أعد كتابتها بنفسك لتأكيدها.', en: 'Did you mean __Q__? Retype it yourself to confirm.' },
  reasonRequired: { ar: 'السبب مطلوب.', en: 'A reason is required.' },
  scopeRequired: { ar: 'اختر المؤسسة المستفيدة والمادة.', en: 'Choose the beneficiary and the item.' },
} as const;

export type ManualKey = keyof typeof D;

export function mt(key: ManualKey, lang: ManualLang): string {
  return D[key][lang];
}

export function quantityReasonText(reason: ManualQuantityReason, lang: ManualLang): string {
  return mt(`q_${reason}` as ManualKey, lang);
}

export const MANUAL_COPY_KEYS = Object.keys(D) as ManualKey[];
