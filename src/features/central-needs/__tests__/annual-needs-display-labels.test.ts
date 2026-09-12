/**
 * Annual Needs display terminology.
 *
 * NOTE THE MISSING IMPORT. This file deliberately does NOT import
 * `../central-needs.i18n`, because the renamed labels must come from the
 * canonical dictionary itself. An earlier revision patched them over `T` with
 * `Object.assign` at module scope, which made the displayed name depend on
 * whether anything had imported that module yet — CI caught it rendering the
 * new name on the Arabic screen and the old one in the English sidebar, on the
 * same commit. Reading `T` cold, as a sidebar or permission matrix does, is
 * therefore the whole point of this test.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { T } from '@/shared/i18n/strings';
import { PERMISSION_KEYS } from '@/shared/lib/permissions';

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

  it('carries no display label still using the retired Central Needs wording', () => {
    for (const key of [
      'cn2b_nav', 'cn2b_title', 'permmod_central_needs',
      'perm_central_needs_view', 'perm_central_needs_import',
      'perm_central_needs_edit', 'perm_central_needs_approve',
    ] as const) {
      expect(T[key].en, key).not.toMatch(/Central Needs/);
      expect(T[key].ar, key).not.toMatch(/الاحتياجات المركزية|الاحتياج المركزي/);
    }
  });

  it('keeps the technical permission keys and module id untouched', () => {
    // The rename is display-only: the keys the database, RLS and every RPC use
    // are unchanged, so a renamed label can never silently regrant anything.
    const keys = PERMISSION_KEYS.filter((p) => p.module === 'central_needs').map((p) => p.key).sort();
    expect(keys).toEqual([
      'central_needs.approve',
      'central_needs.edit',
      'central_needs.import',
      'central_needs.view',
    ]);
  });

  it('never reintroduces a runtime patch over the canonical dictionary', () => {
    // A module-scope mutation is what made the name import-order dependent.
    const source = readFileSync(new URL('../central-needs.i18n.ts', import.meta.url), 'utf8');
    expect(source).not.toMatch(/Object\.assign\s*\(\s*T\b/);
  });
});
