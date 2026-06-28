import { createContext, useContext, useState, useRef, ReactNode, useEffect, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { Lang, Theme, Role } from '@/shared/lib/types';
import { supabaseConfigured } from '@/shared/supabase/client';
import {
  getSession,
  onAuthChange,
  getMyProfile,
  signIn as authSignIn,
  signOut as authSignOut,
  requestPasswordReset as authRequestReset,
  updatePassword as authUpdatePassword,
  type Profile,
  type SignInResult,
} from '@/shared/supabase/services/auth.service';

interface AppState {
  // ── UI prefs ──
  lang: Lang;
  theme: Theme;
  setLang: (l: Lang) => void;
  setTheme: (t: Theme) => void;
  toggleLang: () => void;
  toggleTheme: () => void;
  dir: 'rtl' | 'ltr';

  // ── Auth / session ──
  configured: boolean;
  authReady: boolean;
  session: Session | null;
  profile: Profile | null;
  role: Role;
  /** Org scope for queries. super_admin may switch; others are pinned to their org. */
  activeOrgId: string | null;
  setActiveOrgId: (id: string | null) => void;
  signIn: (email: string, password: string) => Promise<SignInResult>;
  signOut: () => Promise<void>;
  /** Re-fetches the current profile (e.g. after a password change clears must_change_password). */
  reloadProfile: () => Promise<void>;

  // ── Password recovery ──
  /** True when the user arrived via a reset-password email (recovery session). */
  passwordRecovery: boolean;
  requestPasswordReset: (email: string) => Promise<SignInResult>;
  updatePassword: (newPassword: string) => Promise<SignInResult>;
  clearRecovery: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

export function AppProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState]   = useState<Lang>('ar');
  const [theme, setThemeState] = useState<Theme>('light');

  const [authReady, setAuthReady] = useState(false);
  const authReadyRef = useRef(false);
  const [session, setSession]     = useState<Session | null>(null);
  const [profile, setProfile]     = useState<Profile | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  // Seed recovery mode from the URL so the reset screen shows immediately,
  // before Supabase's PASSWORD_RECOVERY event fires. ResetPasswordScreen
  // handles its own session exchange — AppContext skips profile loading.
  const [passwordRecovery, setPasswordRecovery] = useState<boolean>(
    () => typeof window !== 'undefined' &&
      (window.location.pathname.startsWith('/auth/callback') ||
       window.location.hash.includes('type=recovery')),
  );
  const passwordRecoveryRef = useRef(passwordRecovery);

  const setLang  = (l: Lang)  => setLangState(l);
  const setTheme = (t: Theme) => setThemeState(t);
  const toggleLang  = () => setLangState(l => l === 'ar' ? 'en' : 'ar');
  const toggleTheme = () => setThemeState(t => t === 'dark' ? 'light' : 'dark');

  // Sync <html> and <body> attributes for RTL/LTR + theme + lang.
  useEffect(() => {
    const dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.setAttribute('dir', dir);
    document.documentElement.setAttribute('lang', lang);
    document.body.setAttribute('dir', dir);
  }, [lang, theme]);

  // Load profile for a session, pinning org scope for non-super_admin roles.
  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null);
      setActiveOrgId(null);
      return;
    }
    const p = await getMyProfile();
    setProfile(p);
    // Non-super_admin users are scoped to their own org; super_admin starts global.
    if (p && p.role !== 'super_admin') {
      setActiveOrgId(p.organization_id);
    }
  }, []);

  // Establish session on mount + subscribe to auth changes.
  // Recovery callback landing (/auth/callback) is handled entirely by
  // ResetPasswordScreen — it manages its own session exchange independently.
  // AppContext just needs to mark passwordRecovery=true so App.tsx renders it.
  useEffect(() => {
    let active = true;
    if (!supabaseConfigured) {
      setAuthReady(true);
      return;
    }

    const unsub = onAuthChange(async (event, s) => {
      if (!active) return;
      if (event === 'PASSWORD_RECOVERY') {
        passwordRecoveryRef.current = true;
        setPasswordRecovery(true);
      }
      setSession(s);
      // Skip profile loading during recovery — ResetPasswordScreen is standalone
      if (!passwordRecoveryRef.current) {
        await loadProfile(s);
      }
      if (!authReadyRef.current) {
        authReadyRef.current = true;
        setAuthReady(true);
      }
    });

    getSession().then(async (s) => {
      if (!active) return;
      setSession(s);
      if (!passwordRecoveryRef.current) {
        await loadProfile(s);
      }
      if (!authReadyRef.current) {
        authReadyRef.current = true;
        setAuthReady(true);
      }
    });

    return () => { active = false; unsub(); };
  }, [loadProfile]);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await authSignIn(email, password);
    // session + profile arrive via onAuthChange subscription.
    return res;
  }, []);

  const reloadProfile = useCallback(async () => {
    const p = await getMyProfile();
    setProfile(p);
  }, []);

  const signOut = useCallback(async () => {
    await authSignOut();
    setSession(null);
    setProfile(null);
    setActiveOrgId(null);
    setPasswordRecovery(false);
  }, []);

  const requestPasswordReset = useCallback(
    (email: string) => authRequestReset(email),
    [],
  );

  const updatePassword = useCallback(
    (newPassword: string) => authUpdatePassword(newPassword),
    [],
  );

  // After a successful reset, drop the recovery session and return to login.
  const clearRecovery = useCallback(async () => {
    setPasswordRecovery(false);
    await authSignOut();
    setSession(null);
    setProfile(null);
    // Strip the recovery hash/path so a refresh doesn't re-enter recovery.
    if (typeof window !== 'undefined') {
      window.history.replaceState(null, '', '/');
    }
  }, []);

  const role: Role = profile?.role ?? 'viewer';

  return (
    <AppContext.Provider value={{
      lang, theme, setLang, setTheme, toggleLang, toggleTheme,
      dir: lang === 'ar' ? 'rtl' : 'ltr',
      configured: supabaseConfigured,
      authReady, session, profile, role,
      activeOrgId, setActiveOrgId,
      signIn, signOut, reloadProfile,
      passwordRecovery, requestPasswordReset, updatePassword, clearRecovery,
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
