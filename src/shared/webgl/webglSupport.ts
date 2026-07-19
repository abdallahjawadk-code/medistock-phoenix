/* ─── PHOENIX WEBGL — capability detection & device tiering ────────────────────
   Pure, side-effect-free helpers used to decide whether the real Three.js scene
   may mount, and how heavy it is allowed to be. Kept free of any three import so
   it lives in the light chunk and the WebGL bundle only loads when we commit to
   rendering it. Never throws; always safe on the server / in tests.
   ─────────────────────────────────────────────────────────────────────────── */

/** True when a WebGL (2 or 1) rendering context can actually be created. */
export function detectWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    const gl =
      canvas.getContext('webgl2') ||
      canvas.getContext('webgl') ||
      canvas.getContext('experimental-webgl');
    return Boolean(gl);
  } catch {
    return false;
  }
}

/** User asked the OS to minimise non-essential motion. */
export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

/** User (or their network) asked to minimise data use (Save-Data). */
export function prefersReducedData(): boolean {
  if (typeof navigator === 'undefined') return false;
  const conn = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return Boolean(conn?.saveData);
}

/** Coarse tiers that gate how heavy the WebGL scene is allowed to be. */
export type DeviceTier = 'low' | 'medium' | 'high';

export interface DeviceHints {
  isMobile: boolean;
  /** Logical CPU count (defaults to 4 when unknown). */
  cores: number;
  /** navigator.deviceMemory in GB, or undefined when the UA does not expose it. */
  memory?: number;
  /** True when the primary pointer is coarse (touch) — a proxy for phones/tablets. */
  coarsePointer: boolean;
  /** Narrowest viewport edge in CSS px (0 on the server). */
  viewportMin: number;
  saveData: boolean;
  /** True only when a real WebGL2 context can be created. */
  webgl2: boolean;
}

/** Read the cheap, safe device hints once. Never throws; safe on the server. */
export function deviceHints(): DeviceHints {
  if (typeof navigator === 'undefined' || typeof window === 'undefined') {
    return {
      isMobile: false,
      cores: 4,
      memory: undefined,
      coarsePointer: false,
      viewportMin: 0,
      saveData: false,
      webgl2: false,
    };
  }
  const nav = navigator as Navigator & { deviceMemory?: number };
  const isMobile = /Mobi|Android|iPhone|iPad|iPod/i.test(nav.userAgent);
  const coarsePointer = Boolean(window.matchMedia?.('(pointer: coarse)').matches);
  const viewportMin = Math.min(window.innerWidth || 0, window.innerHeight || 0);
  let webgl2 = false;
  try {
    webgl2 = Boolean(document.createElement('canvas').getContext('webgl2'));
  } catch {
    webgl2 = false;
  }
  return {
    isMobile,
    cores: nav.hardwareConcurrency ?? 4,
    memory: nav.deviceMemory,
    coarsePointer,
    viewportMin,
    saveData: prefersReducedData(),
    webgl2,
  };
}

/**
 * Classify the device. Conservative on purpose: `high` is only granted to a
 * clearly desktop-class machine (fast CPU, ≥8 GB, WebGL2, fine pointer, roomy
 * viewport). When deviceMemory is unavailable we assume `medium`, never `high`,
 * so an unknown 8 GB laptop is not treated as an unbounded cinematic device.
 */
export function deviceTier(hints: DeviceHints = deviceHints()): DeviceTier {
  const { isMobile, cores, memory, coarsePointer, viewportMin, saveData, webgl2 } = hints;

  // Anything explicitly constrained drops straight to the cheapest tier.
  if (saveData || isMobile || coarsePointer || cores <= 4 || (memory !== undefined && memory <= 4)) {
    return 'low';
  }

  const memoryKnownAmple = memory !== undefined && memory >= 8;
  const roomyViewport = viewportMin >= 720; // narrowest edge, so portrait laptops still qualify
  if (webgl2 && cores >= 8 && memoryKnownAmple && roomyViewport) {
    return 'high';
  }
  return 'medium';
}

export interface DeviceProfile {
  isMobile: boolean;
  tier: DeviceTier;
  /** Upper bound for devicePixelRatio passed to the renderer. */
  dprCap: number;
  /** Number of GPU particles the device may afford in the login scene. */
  particleCount: number;
  /** MSAA is expensive; reserved for the `high` tier only. */
  antialias: boolean;
  lowPower: boolean;
}

/** Per-tier render budget. Deliberately modest — identity over frame-burning. */
export function deviceProfile(hints: DeviceHints = deviceHints()): DeviceProfile {
  const tier = deviceTier(hints);
  const byTier = {
    high: { dprCap: 1.5, particleCount: 1100, antialias: true },
    medium: { dprCap: 1.25, particleCount: 700, antialias: false },
    low: { dprCap: 1, particleCount: 400, antialias: false },
  }[tier];
  return {
    isMobile: hints.isMobile,
    tier,
    dprCap: byTier.dprCap,
    particleCount: byTier.particleCount,
    antialias: byTier.antialias,
    lowPower: tier === 'low',
  };
}

/**
 * Central gate: may we mount the real 3D scene at all?
 * Reduced-motion does NOT disable WebGL (we render a near-static frame instead);
 * missing WebGL support or an explicit Save-Data request routes to the 2D plate.
 */
export function shouldRenderWebGL(opts?: { allowReducedData?: boolean }): boolean {
  if (!detectWebGL()) return false;
  if (prefersReducedData() && !opts?.allowReducedData) return false;
  return true;
}
