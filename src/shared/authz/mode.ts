/* ─── MEDISTOCK PHOENIX — Scoped RBAC feature flag ────────────────────────────
   PHOENIX_SCOPED_RBAC_MODE.

   The repository already has exactly one feature-flag convention: a Vite env
   var read at module scope and compared to a literal string
   (EditorScreen.tsx: VITE_PHOENIX_BATCH_IDENTITY_051_ENABLED === 'true'). This
   flag follows it, with the value space widened from boolean to the three modes
   the phase needs.

   RUNTIME CONFIGURATION — the exact variable:

     VITE_PHOENIX_SCOPED_RBAC_MODE = off | shadow | enforce_super_admin

   Vite inlines VITE_-prefixed vars at BUILD time, so this is a build-time
   configuration knob, not a runtime toggle: production enforcement is a
   deliberate rebuild+deploy, never a console flip.

   DEFAULTS (resolveScopedRbacMode):
     • unset in dev/test  → 'shadow'   (observe, never block)
     • unset in prod      → 'off'      (nothing new runs at all)
     • unrecognized value → the default for the environment, never a stronger
       mode. A typo must not be able to enable enforcement.

   There is deliberately no 'enforce_all' value. Full enforcement is a later
   phase and cannot be reached by configuration alone.
   ──────────────────────────────────────────────────────────────────────────── */

export type ScopedRbacMode = 'off' | 'shadow' | 'enforce_super_admin';

export const SCOPED_RBAC_MODE_ENV_VAR = 'VITE_PHOENIX_SCOPED_RBAC_MODE';

const VALID_MODES: readonly ScopedRbacMode[] = ['off', 'shadow', 'enforce_super_admin'];

export function isScopedRbacMode(v: unknown): v is ScopedRbacMode {
  return typeof v === 'string' && (VALID_MODES as readonly string[]).includes(v);
}

export interface ModeEnvironment {
  /** Raw VITE_PHOENIX_SCOPED_RBAC_MODE value, if any. */
  raw?: unknown;
  /** import.meta.env.DEV */
  dev?: boolean;
  /** import.meta.env.MODE === 'test' / vitest */
  test?: boolean;
}

/**
 * Resolve the effective mode. Pure and injectable so the tests can prove every
 * branch without touching the real environment.
 *
 * Fails SAFE in both directions: an unset/garbage value never yields a mode
 * stronger than the environment's default, and production never defaults to
 * anything but 'off'.
 */
export function resolveScopedRbacMode(env: ModeEnvironment): ScopedRbacMode {
  const fallback: ScopedRbacMode = env.dev || env.test ? 'shadow' : 'off';
  if (!isScopedRbacMode(env.raw)) return fallback;
  return env.raw;
}

/** The mode this build is running in. */
export function currentScopedRbacMode(): ScopedRbacMode {
  return resolveScopedRbacMode({
    raw:  import.meta.env.VITE_PHOENIX_SCOPED_RBAC_MODE,
    dev:  import.meta.env.DEV,
    test: import.meta.env.MODE === 'test',
  });
}

/** True when the scoped engine should be evaluated at all. */
export function scopedEngineEnabled(mode: ScopedRbacMode): boolean {
  return mode !== 'off';
}

/* ── Runtime diagnostic (RBAC-PHASE-2, Phase C) ───────────────────────────────
   "Is shadow mode actually on in this build?" is a question that has been
   answered by assumption more than once, and the answer decides whether the
   telemetry we are about to review means anything. This makes it observable —
   and observable ONLY as configuration.

   The record below has no field for a URL, a key, a session, a profile or any
   user-identifying value, so no code path can emit one. It reports what this
   BUILD is configured to do, not who is using it. */

export interface ScopedRbacModeDiagnostic {
  mode: ScopedRbacMode;
  /** 'development' | 'test' | 'production' — Vite's build environment. */
  environment: string;
  /** Whether the scoped engine will be evaluated at all. */
  scopedEvaluationEnabled: boolean;
  /**
   * Whether ANY role is gated by the scoped engine in this build. True only for
   * enforce_super_admin, and even then only for super_admin.
   */
  enforcementActive: boolean;
  /** True when the mode came from an explicit env value rather than a default. */
  explicitlyConfigured: boolean;
}

export function describeScopedRbacMode(env: ModeEnvironment & { environment?: string }): ScopedRbacModeDiagnostic {
  const mode = resolveScopedRbacMode(env);
  return {
    mode,
    environment: env.environment ?? (env.test ? 'test' : env.dev ? 'development' : 'production'),
    scopedEvaluationEnabled: scopedEngineEnabled(mode),
    enforcementActive: mode === 'enforce_super_admin',
    explicitlyConfigured: isScopedRbacMode(env.raw),
  };
}

/** This build's diagnostic. */
export function currentScopedRbacDiagnostic(): ScopedRbacModeDiagnostic {
  return describeScopedRbacMode({
    raw:         import.meta.env.VITE_PHOENIX_SCOPED_RBAC_MODE,
    dev:         import.meta.env.DEV,
    test:        import.meta.env.MODE === 'test',
    environment: import.meta.env.MODE,
  });
}

/**
 * True when the scoped decision may actually GATE this role.
 * The pilot is super_admin only — every other role stays shadow-only, in every
 * mode. There is no configuration that makes this return true for another role.
 */
export function scopedEngineEnforcesRole(mode: ScopedRbacMode, role: string): boolean {
  return mode === 'enforce_super_admin' && role === 'super_admin';
}
