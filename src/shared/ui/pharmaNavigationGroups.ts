import type { Lang } from '@/shared/lib/types';

const SECTIONS = [
  { key: 'work', ar: 'العمل اليومي', en: 'Daily workspace', screens: [3, 23, 18, 19] },
  { key: 'insight', ar: 'المتابعة والتحليل', en: 'Monitor & analyse', screens: [22, 13, 21] },
  { key: 'manage', ar: 'إدارة المنظومة', en: 'Administration', screens: [11, 14, 17] },
] as const;

/** Presentation only. Call AFTER projectNavigation; no authority decisions or
 * new destinations live here. Unrecognised future destinations remain visible. */
export function groupPharmaNavigation<T extends { screen: number }>(items: readonly T[], lang: Lang) {
  const assigned = new Set<number>(SECTIONS.flatMap(section => [...section.screens]));
  const groups: Array<{ key: string; label: string; items: T[] }> = SECTIONS.map(section => ({
    key: section.key as string,
    label: lang === 'ar' ? section.ar : section.en,
    items: section.screens.flatMap(screen => items.filter(item => item.screen === screen)),
  }));
  const remaining = items.filter(item => !assigned.has(item.screen));
  if (remaining.length) groups.push({ key: 'other', label: lang === 'ar' ? 'وجهات أخرى' : 'Other destinations', items: remaining });
  return groups.filter(group => group.items.length > 0);
}
