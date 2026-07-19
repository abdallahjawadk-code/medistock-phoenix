import { describe, it, expect, afterEach } from 'vitest';
import { resolveEffects, getEffectsMode, setEffectsMode, type EffectsMode } from '../effectsMode';
import { deviceTier, type DeviceHints } from '../webglSupport';

/**
 * PHOENIX-PERF-BUDGET: the adaptive effects policy is the enforcement point for
 * every performance gate in the hotfix. These tests pin the guarantees so a
 * future tweak can't silently reintroduce the login/welcome jank:
 *   • off / reduced / Save-Data never authorise a continuous WebGL loop.
 *   • WebGL login is deferred (high-tier only) — mobile/medium never eager-load
 *     the three.js chunk for the login backdrop.
 *   • per-tier DPR / particle / antialias ceilings hold.
 *   • the welcome loop is always frame-capped between 24 and 45 — never 60.
 */

const base: DeviceHints = {
  isMobile: false,
  cores: 8,
  memory: 8,
  coarsePointer: false,
  viewportMin: 900,
  saveData: false,
  webgl2: true,
};

const high: DeviceHints = { ...base };
const medium: DeviceHints = { ...base, memory: 6 }; // known, but < 8 ⇒ medium
const mobile: DeviceHints = { ...base, isMobile: true, coarsePointer: true, viewportMin: 390 };
const memoryUnknown: DeviceHints = { ...base, memory: undefined };

const opts = (mode: EffectsMode, hints: DeviceHints, extra: { reducedMotion?: boolean } = {}) =>
  resolveEffects({ mode, hints, hasWebGL: true, reducedMotion: false, ...extra });

describe('device tiering', () => {
  it('treats a fast, roomy, WebGL2 desktop as high', () => {
    expect(deviceTier(high)).toBe('high');
  });

  it('never treats unknown deviceMemory as high (assumes medium)', () => {
    expect(deviceTier(memoryUnknown)).toBe('medium');
  });

  it('drops mobile / coarse-pointer / low-core devices to low', () => {
    expect(deviceTier(mobile)).toBe('low');
    expect(deviceTier({ ...base, cores: 4 })).toBe('low');
    expect(deviceTier({ ...base, memory: 4 })).toBe('low');
    expect(deviceTier({ ...base, saveData: true })).toBe('low');
  });
});

describe('mode gates: off / reduced / save-data never run continuous WebGL', () => {
  it('off ⇒ no WebGL at all', () => {
    const e = opts('off', high);
    expect(e.webglAllowed).toBe(false);
    expect(e.continuous).toBe(false);
    expect(e.loginWebGL).toBe(false);
    expect(e.welcomeWebGL).toBe(false);
  });

  it('reduced ⇒ static only, no login/welcome WebGL', () => {
    const e = opts('reduced', high);
    expect(e.continuous).toBe(false);
    expect(e.loginWebGL).toBe(false);
    expect(e.welcomeWebGL).toBe(false);
  });

  it('Save-Data ⇒ static only even in auto on a strong device', () => {
    const e = opts('auto', { ...high, saveData: true });
    expect(e.continuous).toBe(false);
    expect(e.loginWebGL).toBe(false);
    expect(e.welcomeWebGL).toBe(false);
  });

  it('OS reduced-motion ⇒ static only', () => {
    const e = opts('auto', high, { reducedMotion: true });
    expect(e.continuous).toBe(false);
    expect(e.loginWebGL).toBe(false);
  });
});

describe('login is interaction-first (Three deferred, never eager on mobile/medium)', () => {
  it('high auto ⇒ WebGL login allowed but deferred behind a finite idle window', () => {
    const e = opts('auto', high);
    expect(e.loginWebGL).toBe(true);
    expect(Number.isFinite(e.loginIdleMs)).toBe(true);
    expect(e.loginIdleMs).toBeGreaterThanOrEqual(1500);
  });

  it('medium auto ⇒ no WebGL login (2.5D parallax plate instead)', () => {
    const e = opts('auto', medium);
    expect(e.loginWebGL).toBe(false);
    expect(e.loginParallax2D).toBe(true);
  });

  it('mobile auto ⇒ no WebGL login and no continuous parallax loop', () => {
    const e = opts('auto', mobile);
    expect(e.loginWebGL).toBe(false);
    expect(e.loginParallax2D).toBe(false);
  });
});

describe('render budget ceilings per tier', () => {
  it('mobile/low: DPR ≤ 1, ≤ 450 particles, antialias off', () => {
    const e = opts('auto', mobile);
    expect(e.dprCap).toBeLessThanOrEqual(1);
    expect(e.particleCount).toBeLessThanOrEqual(450);
    expect(e.welcomeParticles).toBeLessThanOrEqual(450);
    expect(e.antialias).toBe(false);
  });

  it('medium: DPR ≤ 1.25, ≤ 800 particles, antialias off', () => {
    const e = opts('auto', medium);
    expect(e.dprCap).toBeLessThanOrEqual(1.25);
    expect(e.particleCount).toBeLessThanOrEqual(800);
    expect(e.antialias).toBe(false);
  });

  it('high: DPR ≤ 1.5, ≤ 1200 particles', () => {
    const e = opts('auto', high);
    expect(e.dprCap).toBeLessThanOrEqual(1.5);
    expect(e.particleCount).toBeLessThanOrEqual(1200);
  });
});

describe('welcome loop is frame-capped, never 60fps', () => {
  for (const [name, hints] of [
    ['high', high],
    ['medium', medium],
    ['mobile', mobile],
  ] as const) {
    it(`${name}: 24 ≤ fps ≤ 45`, () => {
      const e = opts('auto', hints);
      expect(e.welcomeFps).toBeGreaterThanOrEqual(24);
      expect(e.welcomeFps).toBeLessThanOrEqual(45);
      expect(e.welcomeFps).not.toBe(60);
    });
  }
});

describe('effects-mode persistence', () => {
  afterEach(() => {
    try {
      localStorage.clear();
    } catch {
      /* no localStorage in this env */
    }
  });

  it('defaults to auto and round-trips a stored choice when localStorage exists', () => {
    if (typeof localStorage === 'undefined') {
      expect(getEffectsMode()).toBe('auto');
      return;
    }
    expect(getEffectsMode()).toBe('auto');
    setEffectsMode('cinematic');
    expect(getEffectsMode()).toBe('cinematic');
    setEffectsMode('off');
    expect(getEffectsMode()).toBe('off');
  });
});
