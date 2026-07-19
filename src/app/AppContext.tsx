import { createContext, useContext, useState, useRef, ReactNode, useEffect, useCallback } from 'react';
import type { Session } from '@supabase/supabase-js';
import type { Lang, Theme, Role } from '@/shared/lib/types';
import { supabaseConfigured } from '@/shared/supabase/client';
import { roleDefaults, PERMISSION_KEY_SET } from '@/shared/lib/permissions';
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
import { getEffectivePermissions } from '@/shared/supabase/services/users.service';
import {
  createAuthorizationService, createRbacObservability,
  type AuthorizationService,
} from '@/shared/authz/authorization';
import {
  currentScopedRbacDiagnostic, currentScopedRbacMode,
  type ScopedRbacMode, type ScopedRbacModeDiagnostic,
} from '@/shared/authz/mode';
import type { RbacTelemetryStore } from '@/shared/authz/telemetry';

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

  /**
   * The current user's EFFECTIVE permissions — role defaults with their own
   * profile_permission_overrides applied, loaded fresh from the DB on every
   * login/profile load. This is the source of truth for "can I do X" UI
   * gating; it is NOT the hardcoded permissions.ts role-default table, which
   * is a fallback only (used while this loads, or if the permission-matrix
   * migration is not yet applied).
   */
  myPermissions: Set<string>;
  /** True when the permission-matrix RPCs (migration 010) are unavailable — myPermissions falls back to role defaults only. */
  myPermissionsMigrationMissing: boolean;
  /** Re-fetches the current user's effective permissions from the DB. */
  reloadMyPermissions: () => Promise<void>;

  /**
   * PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE: the central scoped-RBAC
   * authorization service (migration 062). In 'off'/'shadow' it observes only —
   * every effective decision it returns is still `myPermissions`, unchanged.
   * The super_admin pilot ('enforce_super_admin') is the sole mode where its
   * answer gates anything, and only for role === 'super_admin'.
   */
  authz: AuthorizationService;
  /** The resolved PHOENIX_SCOPED_RBAC_MODE for this build. */
  scopedRbacMode: ScopedRbacMode;
  /**
   * Session-scoped, in-memory mismatch telemetry (RBAC-PHASE-2). Bounded,
   * deduplicated, cleared on logout/profile switch, and never transmitted
   * anywhere — a human exports it as JSON to review. Collects nothing in a
   * production build with mode=off.
   */
  rbacTelemetry: RbacTelemetryStore;
  /** Safe configuration diagnostic: mode, environment, whether the engine runs. */
  scopedRbacDiagnostic: ScopedRbacModeDiagnostic;

  // ── Password recovery ──
  /** True when the user arrived via a reset-password email (recovery session). */
  passwordRecovery: boolean;
  requestPasswordReset: (email: string) => Promise<SignInResult>;
  updatePassword: (newPassword: string) => Promise<SignInResult>;
  clearRecovery: () => Promise<void>;
}

const AppContext = createContext<AppState | null>(null);

// VISUAL-QA-HARNESS-A: exported ONLY so the DEV/TEST-only visual-QA harness can
// supply a deterministic fixture context (src/features/qa). Production code must
// keep using <AppProvider> — this export grants no new capability at runtime.
export { AppContext };
export type { AppState };

interface AppProviderProps {
  children: ReactNode;
  /**
   * DB-PRESSURE-QUICK-WINS-A: when true, the auth-bootstrap effect below
   * (getSession + onAuthChange subscription + loadProfile/loadPermissions)
   * never runs — authReady is set true immediately, session/profile stay
   * null. For the anonymous public QR route, which only ever reads
   * lang/toggleLang off this context (see App.tsx), that bootstrap is pure
   * unused Supabase overhead. Authenticated routes never pass this prop, so
   * their bootstrap sequence is byte-for-byte unchanged.
   */
  skipAuthBootstrap?: boolean;
}

export function AppProvider({ children, skipAuthBootstrap = false }: AppProviderProps) {
  const [lang, setLangState]   = useState<Lang>('ar');
  const [theme, setThemeState] = useState<Theme>('light');

  const [authReady, setAuthReady] = useState(false);
  const authReadyRef = useRef(false);
  const [session, setSession]     = useState<Session | null>(null);
  const [profile, setProfile]     = useState<Profile | null>(null);
  const [activeOrgId, setActiveOrgId] = useState<string | null>(null);
  const [myPermissions, setMyPermissions] = useState<Set<string>>(new Set());
  const [myPermissionsMigrationMissing, setMyPermissionsMigrationMissing] = useState(false);

  // ── Scoped-RBAC service (PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE) ──
  // One instance per provider, created once: its cache and in-flight dedup map
  // are per-session state, and a service rebuilt on every render would cache
  // nothing and issue one RPC per row per render.
  const scopedRbacMode = useRef<ScopedRbacMode>(currentScopedRbacMode()).current;
  const scopedRbacDiagnostic = useRef<ScopedRbacModeDiagnostic>(currentScopedRbacDiagnostic()).current;
  const observability = useRef(createRbacObservability(scopedRbacMode)).current;
  const rbacTelemetry = observability.store;
  const authz = useRef<AuthorizationService>(
    createAuthorizationService({ mode: scopedRbacMode, reporter: observability.reporter }),
  ).current;
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

  // Load the current user's EFFECTIVE permissions from the DB (role defaults
  // + their own profile_permission_overrides). Falls back to the hardcoded
  // role-default table only if the permission-matrix RPC is unavailable —
  // never the other way around (DB is the source of truth once reachable).
  const loadPermissions = useCallback(async (p: Profile | null) => {
    if (!p) {
      setMyPermissions(new Set());
      setMyPermissionsMigrationMissing(false);
      return;
    }
    const res = await getEffectivePermissions(p.id);
    if (res.permissions) {
      const perms = new Set(Object.entries(res.permissions).filter(([, v]) => v).map(([k]) => k));
      // super_admin always has every key in the frontend catalog regardless of DB state
      // (DB RLS also has explicit super_admin bypasses, so this is consistent).
      // This defends against partial role_permission_defaults seeding (e.g. a key was
      // added to the frontend catalog after migration 010 ran without a matching DB insert).
      if (p.role === 'super_admin') {
        for (const key of PERMISSION_KEY_SET) perms.add(key);
      }
      if (import.meta.env.DEV) {
        console.info('[phoenix] loadPermissions:', {
          profileId: p.id, role: p.role,
          superAdminTopUp: p.role === 'super_admin',
          permCount: perms.size,
          hasPortsCreate: perms.has('ports.create'),
          hasPortsView: perms.has('ports.view'),
          source: 'rpc',
        });
      }
      setMyPermissions(perms);
      setMyPermissionsMigrationMissing(false);
    } else {
      const fallback = roleDefaults(p.role);
      if (import.meta.env.DEV) {
        console.warn('[phoenix] loadPermissions: RPC fallback to roleDefaults', {
          profileId: p.id, role: p.role,
          migrationMissing: res.migrationMissing,
          loadError: res.loadError,
          fallbackPermCount: fallback.size,
          hasPortsCreate: fallback.has('ports.create'),
          source: 'fallback',
        });
      }
      setMyPermissions(fallback);
      setMyPermissionsMigrationMissing(res.migrationMissing);
    }
  }, []);

  // Load profile for a session, pinning org scope for non-super_admin roles.
  const loadProfile = useCallback(async (s: Session | null) => {
    if (!s) {
      setProfile(null);
      setActiveOrgId(null);
      await loadPermissions(null);
      return;
    }
    const p = await getMyProfile();
    setProfile(p);
    // Non-super_admin users are scoped to their own org; super_admin starts global.
    if (p && p.role !== 'super_admin') {
      setActiveOrgId(p.organization_id);
    }
    await loadPermissions(p);
  }, [loadPermissions]);

  // Establish session on mount + subscribe to auth changes.
  // Recovery callback landing (/auth/callback) is handled entirely by
  // ResetPasswordScreen — it manages its own session exchange independently.
  // AppContext just needs to mark passwordRecovery=true so App.tsx renders it.
  useEffect(() => {
    let active = true;
    if (!supabaseConfigured || skipAuthBootstrap) {
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
  }, [loadProfile, skipAuthBootstrap]);

  // Startup diagnostic (RBAC-PHASE-2 Phase C). Development only, once per
  // mount. It answers "is shadow mode actually on in this build?" — a question
  // that otherwise gets answered by assumption, and whose answer decides
  // whether the telemetry means anything. It reports CONFIGURATION only: the
  // record has no field for a URL, a key, a session or a user.
  useEffect(() => {
    if (import.meta.env.DEV) {
      console.info('[phoenix][rbac] scoped RBAC configuration', scopedRbacDiagnostic);
    }
  }, [scopedRbacDiagnostic]);

  // Console export handle for the staging review (docs/rbac-staging-activation.md).
  // Attached ONLY where the store already collects — a production build with
  // mode=off has `enabled: false`, so nothing is exposed there at all. What it
  // exposes is the same sanitized snapshot the store would give anyone: no
  // identity, no token, no URL. It is deliberately read-only — there is no
  // reason for a console to be able to inject an authorization event.
  useEffect(() => {
    if (!rbacTelemetry.enabled || typeof window === 'undefined') return;
    const w = window as unknown as Record<string, unknown>;
    w.__phoenixRbacTelemetry = {
      exportJson: () => rbacTelemetry.exportJson(),
      snapshot:   () => rbacTelemetry.snapshot(),
      mode:       scopedRbacDiagnostic,
    };
    return () => { delete w.__phoenixRbacTelemetry; };
  }, [rbacTelemetry, scopedRbacDiagnostic]);

  // Telemetry is per-subject. A profile switch on a shared workstation must not
  // leave the previous person's mismatches in the buffer for the next person to
  // export. Keyed on profile.id ALONE, deliberately: the authz cache is
  // invalidated on every permission refresh too, but wiping the session's
  // accumulated evidence every time permissions reload would leave the store
  // permanently near-empty for no safety benefit.
  useEffect(() => {
    rbacTelemetry.clear();
  }, [rbacTelemetry, profile?.id]);

  // Keep the authorization service's context in step with the session. Every
  // dependency here is a reason its cached decisions are no longer valid:
  //   session   → login / logout / token refresh to a different user
  //   profile   → role, org or status changed under us
  //   permissions → an administrator changed what this person may do
  // setContext() invalidates unconditionally, so no cached decision can outlive
  // the state it was computed from, and none can survive into another user's
  // session.
  useEffect(() => {
    authz.setContext({
      authenticated:     session !== null,
      profileId:         profile?.id ?? null,
      // Role is read from the profile ONLY. There is no fallback role here on
      // purpose: `role` below defaults to 'viewer' for display, and feeding that
      // default into the authorization engine would silently authorize a
      // profile-load failure as a viewer instead of failing closed.
      role:              profile?.role ?? null,
      organizationId:    profile?.organization_id ?? null,
      legacyPermissions: myPermissions,
    });
  }, [authz, session, profile, myPermissions]);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await authSignIn(email, password);
    // session + profile arrive via onAuthChange subscription.
    return res;
  }, []);

  const reloadProfile = useCallback(async () => {
    const p = await getMyProfile();
    setProfile(p);
    await loadPermissions(p);
  }, [loadPermissions]);

  const reloadMyPermissions = useCallback(async () => {
    await loadPermissions(profile);
  }, [loadPermissions, profile]);

  const signOut = useCallback(async () => {
    await authSignOut();
    setSession(null);
    setProfile(null);
    setActiveOrgId(null);
    setPasswordRecovery(false);
    setMyPermissions(new Set());
    setMyPermissionsMigrationMissing(false);
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
      myPermissions, myPermissionsMigrationMissing, reloadMyPermissions,
      authz, scopedRbacMode, rbacTelemetry, scopedRbacDiagnostic,
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
