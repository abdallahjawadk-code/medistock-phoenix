import { createContext, useContext, useState, ReactNode, useEffect } from 'react';
import type { Lang, Theme, Role } from '@/shared/lib/types';

interface AppState {
  lang: Lang;
  theme: Theme;
  role: Role;
  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
  setRole: (r: Role) => void;
  toggleLang: () => void;
  toggleTheme: () => void;
  dir: 'rtl' | 'ltr';
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState]   = useState<Lang>('ar');
  const [theme, setThemeState] = useState<Theme>('light');
  const [role, setRole]        = useState<Role>('super_admin');

  const setLang  = (l: Lang)  => setLangState(l);
  const setTheme = (t: Theme) => setThemeState(t);
  const toggleLang  = () => setLangState(l => l === 'ar' ? 'en' : 'ar');
  const toggleTheme = () => setThemeState(t => t === 'dark' ? 'light' : 'dark');

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('dir', lang === 'ar' ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', lang);
  }, [lang, theme]);

  return (
    <AppContext.Provider value={{
      lang, theme, role,
      setLang, setTheme, setRole,
      toggleLang, toggleTheme,
      dir: lang === 'ar' ? 'rtl' : 'ltr',
    }}>
      {children}
    </AppContext.Provider>
  );
}

export function useApp(): AppState {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be inside AppProvider');
  return ctx;
}
