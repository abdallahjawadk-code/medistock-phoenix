export function getLanguageDirection(lang: string | null | undefined): 'rtl' | 'ltr' {
  if (!lang) return 'ltr';
  if (lang.trim().toLowerCase() === 'ar') return 'rtl';
  return 'ltr';
}
