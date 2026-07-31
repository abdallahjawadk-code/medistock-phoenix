import { describe, it, expect, beforeAll } from 'vitest';
import { exec } from 'node:child_process';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';

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
const execAsync = promisify(exec);

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
  // Migration-062 scope-assignment fixtures and their transport. These decide
  // what a scoped persona may reach, so their absence from dist/ is part of the
  // same contract as the fixtures themselves.
  'QA_SCOPE_ASSIGNMENTS',
  'createQaRbacTransport',
  'qaLoadScopes',
  'qa-psa-wh-a',
  'qa-psa-pt-1',
  'qa-outlet-1',
  'qa-wh-inst-a',
  'warehouse_officer_assigned',
  'outlet_officer_assigned',
  // Migration-071 return-corridor fixtures and the simulated-outcome allowlist.
  // The allowlist decides which write RPCs the harness can answer locally, so
  // its absence from dist/ is as important as the fixture rows themselves.
  'QA_MUTATION_OUTCOMES',
  'QA-RET-0001',
  'QA-SHP-0001',
  'QA-INT-77',
  'qa-os-1',
  'qa-om-1',
  // The canonical fixture UUID prefixes. A leak of any one of these would mean
  // synthetic return documents shipped in a production bundle.
  '0aa11111-0000-4000-8000',
  '0bb22222-0000-4000-8000',
  '0cc33333-0000-4000-8000',
  '0dd44444-0000-4000-8000',
  '0ee55555-0000-4000-8000',
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
  beforeAll(async () => {
    // Reproduce a REAL production build. Vitest runs with NODE_ENV=test in the
    // ambient env; inheriting that would make Vite keep import.meta.env.DEV
    // true and defeat the very elimination we are verifying. CI/Vercel build
    // with NODE_ENV=production, so we pin it here. VITE_ENABLE_VISUAL_QA=true
    // is the adversarial case: even with the opt-in flag on, a production build
    // must still strip the harness because import.meta.env.DEV is false.
    try {
      await execAsync('npm run build', {
        cwd: ROOT,
        encoding: 'utf8',
        env: {
          ...process.env,
          NODE_ENV: 'production',
          VITE_ENABLE_VISUAL_QA: 'true',
        },
      });
    } catch (error) {
      const failure = error as {
        status?: number | null;
        stdout?: string | Buffer;
        stderr?: string | Buffer;
      };
      throw new Error([
        'QA production build failed.',
        `status: ${failure.status ?? 'unknown'}`,
        'STDOUT:',
        String(failure.stdout ?? ''),
        'STDERR:',
        String(failure.stderr ?? ''),
      ].join('\n'));
    }
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
