/**
 * RBAC-PHASE-2 — Phase C: feature-flag state clarification.
 *
 * Six distinct states get casually collapsed into the phrase "shadow mode is
 * on": code merged, dev/test default, staging activation, production off, the
 * super-admin pilot, and broad enforcement. Conflating the first with the third
 * is how a team ends up reviewing telemetry that was never collected. These
 * tests pin the diagnostic that tells them apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { describeScopedRbacMode } from '../mode';

const PHOENIX = join(__dirname, '../../../../');

describe('C1. the diagnostic distinguishes every flag state', () => {
  it('production with no configuration is off, and says it was not configured', () => {
    const d = describeScopedRbacMode({ dev: false, environment: 'production' });
    expect(d).toEqual({
      mode: 'off',
      environment: 'production',
      scopedEvaluationEnabled: false,
      enforcementActive: false,
      explicitlyConfigured: false,
    });
  });

  it('development defaults to shadow, and reports it as a DEFAULT not a choice', () => {
    const d = describeScopedRbacMode({ dev: true, environment: 'development' });
    expect(d.mode).toBe('shadow');
    expect(d.scopedEvaluationEnabled).toBe(true);
    expect(d.enforcementActive).toBe(false);
    // The distinction that matters: shadow here is a default, not deployed intent.
    expect(d.explicitlyConfigured).toBe(false);
  });

  it('staging shadow is explicitly configured — the state that makes telemetry real', () => {
    const d = describeScopedRbacMode({ raw: 'shadow', dev: false, environment: 'production' });
    expect(d.mode).toBe('shadow');
    expect(d.scopedEvaluationEnabled).toBe(true);
    expect(d.enforcementActive).toBe(false);
    expect(d.explicitlyConfigured).toBe(true);
  });

  it('the super-admin pilot is the only state reporting enforcement active', () => {
    const d = describeScopedRbacMode({ raw: 'enforce_super_admin', dev: false, environment: 'production' });
    expect(d.enforcementActive).toBe(true);

    for (const raw of ['off', 'shadow', undefined]) {
      expect(describeScopedRbacMode({ raw, dev: false }).enforcementActive).toBe(false);
    }
  });

  it('a typo reports as unconfigured and never as enforcement', () => {
    const d = describeScopedRbacMode({ raw: 'enforce_all', dev: false, environment: 'production' });
    expect(d.mode).toBe('off');
    expect(d.explicitlyConfigured).toBe(false);
    expect(d.enforcementActive).toBe(false);
  });
});

describe('C2. the diagnostic leaks nothing', () => {
  it('carries only configuration — no secret, URL, identity or token', () => {
    const d = describeScopedRbacMode({ raw: 'shadow', dev: false, environment: 'production' });
    expect(Object.keys(d).sort()).toEqual([
      'enforcementActive', 'environment', 'explicitlyConfigured',
      'mode', 'scopedEvaluationEnabled',
    ]);
    const json = JSON.stringify(d);
    for (const leak of ['http', 'supabase', 'key', 'token', 'anon', 'profile', 'email']) {
      expect(`${leak}: ${json.toLowerCase().includes(leak)}`).toBe(`${leak}: false`);
    }
  });

  it('is logged in development only', () => {
    const ctx = readFileSync(join(PHOENIX, 'src/app/AppContext.tsx'), 'utf8');
    expect(ctx).toContain("console.info('[phoenix][rbac] scoped RBAC configuration', scopedRbacDiagnostic);");
    const line = ctx.split('\n').findIndex(l => l.includes("'[phoenix][rbac] scoped RBAC configuration'"));
    // The two lines above it must be the DEV guard.
    expect(ctx.split('\n').slice(line - 2, line).join('\n')).toContain('import.meta.env.DEV');
  });
});

describe('C3. documentation does not claim production shadow', () => {
  const docs = ['.env.example', 'docs/rbac-staging-activation.md'];

  it('never states shadow mode is active in production', () => {
    for (const f of docs) {
      const body = readFileSync(join(PHOENIX, f), 'utf8').toLowerCase();
      // The claim may only ever be conditional on the env var being set.
      expect(`${f}: ${/shadow mode is (now |currently )?active in production/.test(body)}`)
        .toBe(`${f}: false`);
      expect(`${f}: ${/production.{0,40}shadow.{0,20}enabled/.test(body)}`).toBe(`${f}: false`);
    }
  });

  it('the staging runbook names the exact variable and value', () => {
    const doc = readFileSync(join(PHOENIX, 'docs/rbac-staging-activation.md'), 'utf8');
    expect(doc).toContain('VITE_PHOENIX_SCOPED_RBAC_MODE=shadow');
    expect(doc).toContain('VITE_PHOENIX_SCOPED_RBAC_MODE=off');
  });

  it('the runbook documents rollback without a database change', () => {
    const doc = readFileSync(join(PHOENIX, 'docs/rbac-staging-activation.md'), 'utf8').toLowerCase();
    expect(doc).toContain('rollback');
    expect(doc).toContain('no database rollback');
  });

  it('the runbook exposes no secret value', () => {
    const doc = readFileSync(join(PHOENIX, 'docs/rbac-staging-activation.md'), 'utf8');
    // Placeholders only — never a real key or a populated URL.
    expect(doc).not.toMatch(/eyJ[A-Za-z0-9_-]{20,}/);       // a JWT-shaped anon key
    expect(doc).not.toMatch(/https:\/\/[a-z0-9]{20}\.supabase\.co/); // a real project URL
    expect(doc).not.toContain('SERVICE_ROLE');
  });
});
