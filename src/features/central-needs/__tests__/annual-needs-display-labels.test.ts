import { describe, expect, it } from 'vitest';
import '../central-needs.i18n';
import { T } from '@/shared/i18n/strings';

describe('Annual Needs display terminology', () => {
  it('renames the Central Needs surface without changing technical permission keys', () => {
    expect(T.cn2b_nav).toEqual({ ar: 'الاحتياج السنوي', en: 'Annual Needs' });
    expect(T.cn2b_title).toEqual({ ar: 'الاحتياج السنوي', en: 'Annual Needs' });
    expect(T.permmod_central_needs).toEqual({ ar: 'الاحتياج السنوي', en: 'Annual Needs' });

    expect(T.perm_central_needs_view).toEqual({
      ar: 'عرض خطط الاحتياج السنوي',
      en: 'View Annual Needs plans',
    });
    expect(T.perm_central_needs_import).toEqual({
      ar: 'استيراد بيانات الاحتياج السنوي',
      en: 'Import Annual Needs data',
    });
    expect(T.perm_central_needs_edit).toEqual({
      ar: 'تعديل بيانات الاحتياج السنوي',
      en: 'Edit Annual Needs data',
    });
    expect(T.perm_central_needs_approve).toEqual({
      ar: 'اعتماد مراجعة خطة الاحتياج السنوي',
      en: 'Approve Annual Needs plan revision',
    });
  });
});
