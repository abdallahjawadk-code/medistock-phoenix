import { describe, it, expect, beforeAll } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * VISUAL-QA-HARNESS-A — production-safety contract.
 *
 * The DEV/TEST-only visual-QA harness must NEVER ship in a production bundle.
 * This builds the app with the QA flag explicitly enabled (the adversarial
 * case) and asserts the emitted `dist/` carries no QA marker, route, fixture,
 * or persona id. Because `visualQaEnabled` folds to `false` when
 * `import.meta.env.DEV === false`, `vite build` (mode=production) must
 * tree-shake the entire harness even with VITE_ENABLE_VISUAL_QA=true.
 */
const ROOT = join(__dirname, '..');
const DIST = join(ROOT, 'dist');

// Markers that would only exist if harness code leaked into the bundle:
// the route/component, the fixture client, the fixtures, and QA personas.
const FORBIDDEN = [
  'PHOENIX_VISUAL_QA_HARNESS_ONLY',
  'QaHarness',
  'QaAppProvider',
  'buildQaAppState',
  'data-qa-marker',
  'createQaFixtureClient',
  'QA_FIXTURES',
  'QA_READONLY',
  'QA_PERSONAS',
  'qa-org-a1',
  'qa-wh-central',
];

function bundleFiles(): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (/\.(js|css|html)$/.test(entry.name)) out.push(p);
    }
  };
  if (existsSync(DIST)) walk(DIST);
  return out;
}

describe('QA harness is excluded from production builds', () => {
  beforeAll(() => {
    // Reproduce a REAL production build. Vitest runs with NODE_ENV=test in the
    // ambient env; inheriting that would make Vite keep import.meta.env.DEV
    // true and defeat the very elimination we are verifying. CI/Vercel build
    // with NODE_ENV=production, so we pin it here. VITE_ENABLE_VISUAL_QA=true
    // is the adversarial case: even with the opt-in flag on, a production build
    // must still strip the harness because import.meta.env.DEV is false.
    execSync('npm run build', {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'production', VITE_ENABLE_VISUAL_QA: 'true' },
    });
  }, 180_000);

  it('emits a dist/ bundle', () => {
    expect(bundleFiles().length).toBeGreaterThan(0);
  });

  it('contains no QA harness markers even with VITE_ENABLE_VISUAL_QA=true', () => {
    const hits: string[] = [];
    for (const file of bundleFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const marker of FORBIDDEN) {
        if (text.includes(marker)) hits.push(`${marker} → ${file}`);
      }
    }
    expect(hits, `QA markers leaked into production bundle:\n${hits.join('\n')}`).toEqual([]);
  });
});
