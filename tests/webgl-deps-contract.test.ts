import { describe, it, expect } from 'vitest';
import pkg from '../package.json';
import fiberPkg from '@react-three/fiber/package.json';

/**
 * WEBGL-DIGITAL-TWIN-DEPS-A: locks the WebGL stack to the React-18-compatible
 * line. @react-three/fiber v9 requires React 19; this project is React 18, so
 * fiber MUST stay on v8 and three must be present. If someone bumps fiber to
 * v9 (or drops three) without moving React, this fails loudly instead of
 * breaking the runtime.
 */
describe('WebGL Digital Twin dependency contract', () => {
  it('pins @react-three/fiber to the v8 (React 18) line', () => {
    expect(pkg.dependencies['@react-three/fiber']).toMatch(/^\^?8\./);
  });

  it('includes three as a runtime dependency', () => {
    expect(pkg.dependencies.three).toBeDefined();
  });

  it('keeps React on the 18 line that fiber v8 supports', () => {
    expect(pkg.dependencies.react).toMatch(/^\^?18\./);
  });

  it('fiber v8 declares a React 18-compatible peer range', () => {
    // e.g. ">=18 <19" — must admit 18 and exclude 19.
    expect(fiberPkg.peerDependencies?.react ?? '').toContain('18');
  });
});
