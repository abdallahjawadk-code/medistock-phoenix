/**
 * CN-2B — rendering a server refusal for a human.
 *
 * The database's own identifier is the contract, so a code with no translation
 * yet degrades to the identifier itself rather than to a vague "something went
 * wrong" or, worse, to a raw dictionary key leaking into the interface. This
 * mirrors `tRpcError`'s reasoning in `strings.ts`: a new server-side rule must
 * never be silently flattened into a generic failure.
 *
 * DISPLAY TERMINOLOGY
 * -------------------
 * The product-facing name of this module is "Annual Needs" / "الاحتياج السنوي".
 * The technical identifiers remain `central_needs.*`, and the already-applied
 * M209 permission-catalog labels remain historical database evidence.  We
 * therefore override display copy only, at the feature i18n boundary, without
 * renaming permissions, tables, RPCs, migrations, or stored evidence.
 */
import { T, t } from '@/shared/i18n/strings';
import type { Lang } from '@/shared/i18n/strings';

const ANNUAL_NEEDS_DISPLAY_LABELS = {
  cn2b_nav: { ar: 'الاحتياج السنوي', en: 'Annual Needs' },
  cn2b_title: { ar: 'الاحتياج السنوي', en: 'Annual Needs' },
  permmod_central_needs: { ar: 'الاحتياج السنوي', en: 'Annual Needs' },
  perm_central_needs_view: { ar: 'عرض خطط الاحتياج السنوي', en: 'View Annual Needs plans' },
  perm_central_needs_import: { ar: 'استيراد بيانات الاحتياج السنوي', en: 'Import Annual Needs data' },
  perm_central_needs_edit: { ar: 'تعديل بيانات الاحتياج السنوي', en: 'Edit Annual Needs data' },
  perm_central_needs_approve: { ar: 'اعتماد مراجعة خطة الاحتياج السنوي', en: 'Approve Annual Needs plan revision' },
} satisfies Partial<typeof T>;

Object.assign(T, ANNUAL_NEEDS_DISPLAY_LABELS);

export function centralNeedsErrorText(code: string, lang: Lang): string {
  const key = `cn2b_err_${code}`;
  const text = t(key, lang);
  return text === key ? code : text;
}
