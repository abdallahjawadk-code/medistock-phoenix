/**
 * VISUAL-QA-HARNESS-A — provides a fixture {@link AppState} to a real screen
 * subtree (DEV/TEST ONLY). Mirrors the RTL/lang/theme <html>/<body> side
 * effects the real AppProvider performs so captured screenshots are faithful.
 */
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import type { Lang, Theme } from '@/shared/lib/types';
import { AppContext } from '@/app/AppContext';
import { buildQaAppState, type QaPersona } from './qaFixtures';

interface Props {
  persona: QaPersona;
  lang: Lang;
  theme: Theme;
  /** Overrides the persona's own organization; see buildQaAppState. */
  orgId?: string | null;
  children: ReactNode;
}

export function QaAppProvider({ persona, lang: initialLang, theme: initialTheme, orgId, children }: Props) {
  const [lang, setLang] = useState<Lang>(initialLang);
  const [theme, setTheme] = useState<Theme>(initialTheme);

  useEffect(() => setLang(initialLang), [initialLang]);
  useEffect(() => setTheme(initialTheme), [initialTheme]);

  useEffect(() => {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('dir', dir);
    document.documentElement.setAttribute('lang', lang);
    document.body.setAttribute('dir', dir);
  }, [lang, theme]);

  const value = useMemo(
    () => buildQaAppState({ persona, lang, theme, setLang, setTheme, orgId }),
    [persona, lang, theme, orgId],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}
