/* ─── PHOENIX WEBGL — effects policy (single source of truth) ──────────────────
   Turns the user's chosen EffectsMode + the device tier + accessibility/data
   hints into a concrete, bounded render plan. Kept free of any three import so
   it lives in the light chunk and never forces the WebGL bundle to load. The
   golden rule encoded here: the login form is interaction-first (WebGL is
   deferred/optional), the short welcome sequence is where the full 3D lives, and
   nothing renders a continuous loop on the low/reduced/off paths.
   ─────────────────────────────────────────────────────────────────────────── */
import {
  deviceHints,
  deviceProfile,
  prefersReducedMotion,
  detectWebGL,
  type DeviceHints,
  type DeviceProfile,
  type DeviceTier,
} from './webglSupport';

export type EffectsMode = 'auto' | 'cinematic' | 'reduced' | 'off';

const STORAGE_KEY = 'phoenix-effects-mode';
const MODES: readonly EffectsMode[] = ['auto', 'cinematic', 'reduced', 'off'];

/** Read the user's stored preference (client-only, defaults to `auto`). */
export function getEffectsMode(): EffectsMode {
  if (typeof localStorage === 'undefined') return 'auto';
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return (MODES as readonly string[]).includes(raw ?? '') ? (raw as EffectsMode) : 'auto';
  } catch {
    return 'auto';
  }
}

/** Persist the preference locally only (never leaves the device). */
export function setEffectsMode(mode: EffectsMode): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* private mode / quota — the in-memory default still applies */
  }
}

export interface ResolvedEffects {
  mode: EffectsMode;
  tier: DeviceTier;
  profile: DeviceProfile;
  /** No three.js / Canvas at all (mode=off, or WebGL unavailable). */
  webglAllowed: boolean;
  /** A continuous animated loop is permitted (false ⇒ static frame / plate only). */
  continuous: boolean;

  /* ── Login ─────────────────────────────────────────────── */
  /** May the login backdrop upgrade to the real WebGL scene at all? */
  loginWebGL: boolean;
  /** Idle delay before auto-upgrading the login scene; Infinity ⇒ never auto. */
  loginIdleMs: number;
  /** Use a cheap 2.5D pointer-parallax on the 2D plate when WebGL login is off. */
  loginParallax2D: boolean;

  /* ── Welcome ───────────────────────────────────────────── */
  welcomeWebGL: boolean;
  /** Target frame cap for the welcome sequence (never 60 for a backdrop). */
  welcomeFps: number;
  welcomeParticles: number;

  /* ── Shared render budget ─────────────────────────────── */
  dprCap: number;
  particleCount: number;
  antialias: boolean;
}

interface ResolveInput {
  mode?: EffectsMode;
  hints?: DeviceHints;
  reducedMotion?: boolean;
  hasWebGL?: boolean;
}

/**
 * Resolve the full render plan. Pure and synchronous so both React and the perf
 * tests can exercise it. The tier caps are the ceiling; the mode only ever
 * lowers cost (reduced/off) or lifts the login/welcome gates (cinematic).
 */
export function resolveEffects(input: ResolveInput = {}): ResolvedEffects {
  const mode = input.mode ?? getEffectsMode();
  const hints = input.hints ?? deviceHints();
  const profile = deviceProfile(hints);
  const reducedMotion = input.reducedMotion ?? prefersReducedMotion();
  const hasWebGL = input.hasWebGL ?? detectWebGL();
  const tier = profile.tier;

  // Hard off: never touch three or a Canvas.
  const webglAllowed = mode !== 'off' && hasWebGL;

  // Static-only paths: explicit reduced mode, OS reduced-motion, or Save-Data.
  // These keep the approved plate / a single composed frame — no rAF loop.
  const staticOnly = mode === 'reduced' || reducedMotion || hints.saveData;
  const continuous = webglAllowed && !staticOnly;

  const cinematic = mode === 'cinematic';

  // Login is interaction-first. WebGL login is reserved for high-tier (or an
  // explicit cinematic opt-in) and even then it is deferred behind idle time.
  const loginWebGL = continuous && (cinematic || tier === 'high');
  const loginIdleMs = loginWebGL ? (cinematic ? 600 : 1500) : Infinity;
  // Medium/low keep a cheap 2.5D parallax on the plate instead of a GL context.
  const loginParallax2D = !loginWebGL && !staticOnly && !hints.isMobile;

  // Welcome is the short showpiece — WebGL for medium+ (and cinematic), always
  // frame-capped, never 60fps.
  const welcomeWebGL = continuous && (cinematic || tier !== 'low' || !hints.isMobile);
  const welcomeFps = tier === 'high' ? (cinematic ? 45 : 30) : tier === 'medium' ? 30 : 24;
  // Mobile/low is hard-capped at 450 welcome particles per the perf budget.
  const welcomeParticles =
    tier === 'low' || hints.isMobile
      ? Math.min(profile.particleCount, 450)
      : profile.particleCount;

  return {
    mode,
    tier,
    profile,
    webglAllowed,
    continuous,
    loginWebGL,
    loginIdleMs,
    loginParallax2D,
    welcomeWebGL,
    welcomeFps,
    welcomeParticles,
    dprCap: profile.dprCap,
    particleCount: profile.particleCount,
    antialias: profile.antialias,
  };
}
