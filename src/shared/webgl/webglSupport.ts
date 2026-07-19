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

export interface DeviceProfile {
  isMobile: boolean;
  /** Upper bound for devicePixelRatio passed to the renderer. */
  dprCap: number;
  /** Number of GPU ember particles the device may afford. */
  particleCount: number;
  lowPower: boolean;
}

/** Coarse device tiering from hints that are cheap and safe to read. */
export function deviceProfile(): DeviceProfile {
  const nav =
    typeof navigator !== 'undefined'
      ? (navigator as Navigator & { deviceMemory?: number })
      : undefined;
  const isMobile = nav ? /Mobi|Android|iPhone|iPad|iPod/i.test(nav.userAgent) : false;
  const cores = nav?.hardwareConcurrency ?? 4;
  const mem = nav?.deviceMemory ?? 4;
  const lowPower = isMobile || cores <= 4 || mem <= 4;
  return {
    isMobile,
    dprCap: isMobile ? 1.5 : 2,
    particleCount: isMobile ? 850 : lowPower ? 1400 : 2600,
    lowPower,
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
