import { describe, it, expect, afterEach } from 'vitest';
import {
  detectWebGL,
  shouldRenderWebGL,
  prefersReducedMotion,
  prefersReducedData,
  deviceProfile,
} from '../webglSupport';

/**
 * WEBGL-FALLBACK-CONTRACT: the real-3D path must degrade safely without any
 * DOM/GL environment. These run in the default (node) test env — no jsdom
 * dependency added — and assert the gates that guarantee a no-WebGL /
 * Save-Data device is routed to the 2D fallback and never mounts three.js.
 */
describe('PhoenixExperience WebGL gates', () => {
  it('detectWebGL() is false with no document/GL context', () => {
    expect(detectWebGL()).toBe(false);
  });

  it('shouldRenderWebGL() is false when no context can be created', () => {
    // This is the single gate <PhoenixExperience> checks before importing the
    // three.js chunk; false here means only the 2D fallback ever renders.
    expect(shouldRenderWebGL()).toBe(false);
  });

  it('prefersReducedMotion() is a safe false when window is unavailable', () => {
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe('Save-Data routing', () => {
  afterEach(() => {
    delete (globalThis as { navigator?: unknown }).navigator;
  });

  it('prefersReducedData() honours navigator.connection.saveData', () => {
    Object.defineProperty(globalThis, 'navigator', {
      configurable: true,
      value: { userAgent: 'test', connection: { saveData: true } },
    });
    expect(prefersReducedData()).toBe(true);
    // With Save-Data on, the WebGL gate stays closed unless explicitly allowed.
    expect(shouldRenderWebGL()).toBe(false);
    expect(shouldRenderWebGL({ allowReducedData: true })).toBe(false); // still no GL context
  });
});

describe('device tiering', () => {
  it('deviceProfile() caps DPR ≤ 1.5 and keeps a positive, bounded particle budget', () => {
    const p = deviceProfile();
    expect(p.dprCap).toBeGreaterThan(0);
    // New adaptive ceiling: even the high tier never exceeds 1.5 DPR / 1200
    // particles — the old 2.0 / 2600 budget was the source of the login jank.
    expect(p.dprCap).toBeLessThanOrEqual(1.5);
    expect(p.particleCount).toBeGreaterThan(0);
    expect(p.particleCount).toBeLessThanOrEqual(1200);
    expect(['low', 'medium', 'high']).toContain(p.tier);
  });
});
