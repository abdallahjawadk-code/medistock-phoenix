/**
 * PHASE-1-CONTROLLED-RBAC-ACTIVATION-SHADOW-MODE — feature-flag behavior.
 *
 * The flag is the only thing standing between "observe" and "enforce". Every
 * branch of its resolution is pinned here, including the ones that matter most:
 * a typo must never enable enforcement, and production must never default to
 * anything but 'off'.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  resolveScopedRbacMode, isScopedRbacMode, scopedEngineEnabled,
  scopedEngineEnforcesRole, SCOPED_RBAC_MODE_ENV_VAR,
} from '../mode';

const SRC = join(__dirname, '../../../');
const read = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

describe('mode resolution', () => {
  it('defaults to shadow in development', () => {
    expect(resolveScopedRbacMode({ dev: true })).toBe('shadow');
  });

  it('defaults to shadow in test', () => {
    expect(resolveScopedRbacMode({ test: true })).toBe('shadow');
  });

  it('defaults to off in production unless explicitly configured', () => {
    expect(resolveScopedRbacMode({ dev: false, test: false })).toBe('off');
    expect(resolveScopedRbacMode({})).toBe('off');
  });

  it('honours each explicit value', () => {
    for (const mode of ['off', 'shadow', 'enforce_super_admin'] as const) {
      expect(resolveScopedRbacMode({ raw: mode, dev: false })).toBe(mode);
      expect(resolveScopedRbacMode({ raw: mode, dev: true })).toBe(mode);
    }
  });

  it('a typo NEVER enables enforcement — it falls back to the environment default', () => {
    for (const bad of [
      'enforce', 'enforce_all', 'ENFORCE_SUPER_ADMIN', 'true', '1', 'on',
      'Shadow', ' shadow', '', null, undefined, 0, false, {},
    ]) {
      expect(resolveScopedRbacMode({ raw: bad, dev: false })).toBe('off');
      expect(resolveScopedRbacMode({ raw: bad, dev: true })).toBe('shadow');
    }
  });

  it('recognizes exactly three values and no more', () => {
    expect(isScopedRbacMode('off')).toBe(true);
    expect(isScopedRbacMode('shadow')).toBe(true);
    expect(isScopedRbacMode('enforce_super_admin')).toBe(true);
    expect(isScopedRbacMode('enforce_all')).toBe(false);
    expect(isScopedRbacMode('enforce_everyone')).toBe(false);
  });
});

describe('engine gating', () => {
  it('runs the engine in shadow and the pilot, never when off', () => {
    expect(scopedEngineEnabled('off')).toBe(false);
    expect(scopedEngineEnabled('shadow')).toBe(true);
    expect(scopedEngineEnabled('enforce_super_admin')).toBe(true);
  });

  it('enforces for exactly one (mode, role) pair', () => {
    expect(scopedEngineEnforcesRole('enforce_super_admin', 'super_admin')).toBe(true);

    for (const role of [
      'institution_admin', 'hospital_admin', 'warehouse_officer', 'port_officer',
      'monthly_status_officer', 'viewer', 'transfer_manager', 'warehouse_manager', '',
    ]) {
      expect(scopedEngineEnforcesRole('enforce_super_admin', role)).toBe(false);
    }

    for (const mode of ['off', 'shadow'] as const) {
      expect(scopedEngineEnforcesRole(mode, 'super_admin')).toBe(false);
    }
  });
});

describe('flag contract in source', () => {
  it('uses the documented env var name and the repository flag convention', () => {
    const src = read('shared/authz/mode.ts');
    expect(SCOPED_RBAC_MODE_ENV_VAR).toBe('VITE_PHOENIX_SCOPED_RBAC_MODE');
    expect(src).toContain('import.meta.env.VITE_PHOENIX_SCOPED_RBAC_MODE');
  });

  it('exposes no mode that enforces for all roles', () => {
    // Asserted against the resolver rather than the source text: the file's own
    // documentation says the words "enforce_all" precisely to record that they
    // are not a value, and a grep-based test would have to forbid saying so.
    for (const attempt of ['enforce_all', 'enforce_everyone', 'enforce']) {
      expect(isScopedRbacMode(attempt)).toBe(false);
      expect(resolveScopedRbacMode({ raw: attempt, dev: false })).toBe('off');
    }
  });

  it('is documented in .env.example', () => {
    const env = readFileSync(join(SRC, '../.env.example'), 'utf8');
    expect(env).toContain('VITE_PHOENIX_SCOPED_RBAC_MODE');
  });
});
