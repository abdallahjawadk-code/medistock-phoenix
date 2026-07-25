/**
 * CURRENT MOVEMENT STATUS view — structural contract.
 *
 * Pins the security and UX rules the component cannot be rendered to prove in
 * this repo: RLS-scoped reads only (no privileged key / admin API / fabricated
 * history), a generic not-found-or-unauthorized result, all required UI states,
 * and an explicit statement that the full historical timeline is unavailable.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = process.cwd();
const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const read = (...p: string[]) => readFileSync(join(ROOT, ...p), 'utf8');
// Executable code only — a doc comment that NAMES service_role to say it is
// never used is documentation, not a call, and must not fail the guard.
const view = stripComments(read('src', 'features', 'outlet', 'CurrentMovementStatus.tsx'));
const resolver = stripComments(read('src', 'features', 'outlet', 'movement-status.ts'));
const screen = read('src', 'features', 'outlet', 'OutletOperationsScreen.tsx');
const strings = read('src', 'shared', 'i18n', 'strings.ts');

describe('reads are RLS-scoped, with no privileged access or fabricated history', () => {
  it('resolves through the existing outlet-return reads only', () => {
    expect(view).toContain('resolveMovementStatus(');
    expect(view).toContain('getOutletReturnRequests()');
    expect(view).toContain('getOutletReturnShipments()');
  });

  it('names no service_role, admin API, or privileged key anywhere', () => {
    for (const forbidden of ['service_role', 'auth.admin', 'serviceRole', 'SERVICE_ROLE', 'supabaseAdmin']) {
      expect(view, forbidden).not.toContain(forbidden);
      expect(resolver, forbidden).not.toContain(forbidden);
    }
  });
});

describe('existence is never leaked', () => {
  it('unknown and unauthorized share one generic result in the resolver', () => {
    // Both the "row not found" and "RLS-hidden (empty read)" paths return the
    // same not_available; the resolver has exactly one such literal per kind.
    expect(resolver).toContain("reason: 'not_available'");
    expect(resolver).not.toMatch(/reason:\s*'unauthorized'|reason:\s*'forbidden'|reason:\s*'not_found'/);
  });

  it('the view shows the generic not-available message for that reason', () => {
    expect(view).toContain("'or_status_not_available'");
  });
});

describe('every required UI state is present', () => {
  it('renders loading, error, offline, not-available and result states', () => {
    for (const marker of [
      "phase === 'loading'", "phase === 'error'", 'movement-status-offline',
      'movement-status-not-available', 'movement-status-result',
    ]) {
      expect(view, marker).toContain(marker);
    }
  });

  it('accepts a QR payload or a canonical UUID', () => {
    expect(view).toContain('parseMovementStatusInput(');
    expect(view).toContain("t('or_status_input_label'");
  });
});

describe('MOVEMENT-TRACKING-MERGE: the server-authoritative timeline is live', () => {
  it('consumes the 081/082 phoenix_movement_timeline RPC and dropped the unavailable copy', () => {
    expect(view).toContain('getMovementTimeline');
    expect(view).not.toContain('or_status_timeline_note');
    expect(strings).not.toContain('or_status_timeline_note');
  });
});

describe('the view is mounted and reachable in Screen 18', () => {
  it('lives inside the merged Movement History & Tracking tab (no separate status tab)', () => {
    expect(screen).toContain('<CurrentMovementStatus');
    expect(screen).not.toContain("or_tab_status");
    expect(screen).toContain("{ id: 'history', labelKey: 'or_tab_history' }");
  });
});
