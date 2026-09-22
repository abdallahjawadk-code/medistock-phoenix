/**
 * C1 — the pure revision-context derivation, tested directly.
 *
 * The runtime suite (c1-registry-revision-context.runtime.test.tsx) proves the
 * screens use it; this file proves the module itself: the correction target is
 * the selected revision's own plan year or a refusal, the registry order is
 * canonical and deterministic, identity is the revision id, and the module is
 * pure (no React, no Supabase, no clock, no network).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  PLAN_YEAR_MAX,
  PLAN_YEAR_MIN,
  compareRegistryRevisions,
  deriveRevisionContext,
  findRegistryRevision,
  isTrustedPlanYear,
  sortRegistryRevisions,
} from '../central-needs.revision-context';
import type { PlanRevision, RevisionStatus } from '../central-needs.service';

const ROOT = join(__dirname, '..', '..', '..', '..');
const read = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

const rev = (id: string, planYear: number | null, revisionNumber: number, status: RevisionStatus = 'approved'): PlanRevision => ({
  id, planId: `plan-${planYear ?? 'x'}`, organizationId: 'org-1', planYear, revisionNumber, status,
});

describe('C1 — isTrustedPlanYear mirrors M209 (plan_year integer BETWEEN 2000 AND 2100)', () => {
  it('accepts exactly the integers the database could hold', () => {
    expect(PLAN_YEAR_MIN).toBe(2000);
    expect(PLAN_YEAR_MAX).toBe(2100);
    for (const year of [2000, 2024, 2025, 2027, 2100]) expect(isTrustedPlanYear(year), String(year)).toBe(true);
  });

  it('refuses everything else — it never coerces', () => {
    for (const value of [null, undefined, NaN, Infinity, -Infinity, 1999, 2101, 2025.5, '2025', 0, -2025, {}, []]) {
      expect(isTrustedPlanYear(value), String(value)).toBe(false);
    }
  });
});

describe('C1 — deriveRevisionContext: the correction target is the selected revision year or a refusal', () => {
  it('no selection: nothing is derived and a correction is refused', () => {
    const ctx = deriveRevisionContext(null);
    expect(ctx).toEqual({
      revision: null, revisionId: null, planYear: null, revisionNumber: null, status: null,
      isDraft: false, isClosed: false, acceptsNextRevisionRequest: false,
      correction: { ok: false, reason: 'no_revision_selected' },
    });
  });

  it('the target year IS the selected revision plan year, for every status', () => {
    for (const status of ['draft', 'submitted', 'approved', 'rejected', 'superseded'] as const) {
      const ctx = deriveRevisionContext(rev('rev-a', 2024, 2, status));
      expect(ctx.planYear, status).toBe(2024);
      expect(ctx.revisionNumber, status).toBe(2);
      expect(ctx.status, status).toBe(status);
      expect(ctx.correction, status).toEqual({ ok: true, revisionId: 'rev-a', planYear: 2024 });
    }
  });

  it('draft / closed / next-revision flags restate the existing rules exactly', () => {
    const flags = (s: RevisionStatus) => {
      const c = deriveRevisionContext(rev('r', 2025, 1, s));
      return [c.isDraft, c.isClosed, c.acceptsNextRevisionRequest];
    };
    expect(flags('draft')).toEqual([true, false, false]);
    expect(flags('submitted')).toEqual([false, true, false]);
    expect(flags('approved')).toEqual([false, true, true]);
    expect(flags('rejected')).toEqual([false, true, true]);
    expect(flags('superseded')).toEqual([false, true, false]);
  });

  it('an untrustworthy plan year is refused, never replaced by a guess', () => {
    for (const bad of [null, NaN, 1999, 2101, 2025.5]) {
      const ctx = deriveRevisionContext(rev('rev-x', bad as number | null, 1, 'approved'));
      expect(ctx.planYear, String(bad)).toBeNull();
      expect(ctx.correction, String(bad)).toEqual({ ok: false, reason: 'revision_plan_year_unavailable' });
      // The rest of the selection is still stated exactly.
      expect(ctx.revisionId).toBe('rev-x');
      expect(ctx.acceptsNextRevisionRequest).toBe(true);
    }
  });

  it('takes the selected revision as its ONLY input: no year, clock or other revision can reach it', () => {
    expect(deriveRevisionContext.length).toBe(1);
    const src = read('src/features/central-needs/central-needs.revision-context.ts');
    const body = src.slice(src.indexOf('export function deriveRevisionContext'));
    expect(body).not.toMatch(/planYearInput|draftYear|getFullYear|Date\b/);
  });

  it('is deterministic: the same revision always yields an equal context, and changing the revision changes it', () => {
    const a = rev('rev-2025', 2025, 1);
    expect(deriveRevisionContext(a)).toEqual(deriveRevisionContext({ ...a }));
    const b = rev('rev-2026', 2026, 2);
    expect(deriveRevisionContext(b).correction).toEqual({ ok: true, revisionId: 'rev-2026', planYear: 2026 });
    expect(deriveRevisionContext(a).correction).toEqual({ ok: true, revisionId: 'rev-2025', planYear: 2025 });
  });
});

describe('C1 — the canonical registry order and identity', () => {
  const rows = [
    rev('r-2025-1', 2025, 1),
    rev('r-2027-1', 2027, 1),
    rev('r-null-1', null, 1),
    rev('r-2025-3', 2025, 3),
    rev('r-2027-2', 2027, 2),
    rev('r-2025-2', 2025, 2),
  ];

  it('orders plan year DESC, then revision number DESC, an unavailable year last', () => {
    expect(sortRegistryRevisions(rows).map((r) => r.id)).toEqual([
      'r-2027-2', 'r-2027-1', 'r-2025-3', 'r-2025-2', 'r-2025-1', 'r-null-1',
    ]);
  });

  it('is independent of the input order and never mutates the input', () => {
    const before = rows.map((r) => r.id);
    const expected = sortRegistryRevisions(rows).map((r) => r.id);
    const permutations = [[...rows].reverse(), [rows[3], rows[0], rows[5], rows[1], rows[4], rows[2]]];
    for (const p of permutations) expect(sortRegistryRevisions(p).map((r) => r.id)).toEqual(expected);
    expect(rows.map((r) => r.id)).toEqual(before);
  });

  it('breaks an exact (year, number) tie deterministically by revision id', () => {
    const x = rev('b', null, 1);
    const y = rev('a', null, 1);
    expect(compareRegistryRevisions(x, y)).toBeGreaterThan(0);
    expect(compareRegistryRevisions(y, x)).toBeLessThan(0);
    expect(compareRegistryRevisions(x, x)).toBe(0);
  });

  it('identity is the revision id: the same revision number in two years is never confused', () => {
    const two = [rev('rev-2026-1', 2026, 1), rev('rev-2025-1', 2025, 1)];
    expect(findRegistryRevision(two, 'rev-2025-1')?.planYear).toBe(2025);
    expect(findRegistryRevision(two, 'rev-2026-1')?.planYear).toBe(2026);
    expect(findRegistryRevision(two, 'missing')).toBeNull();
    expect(findRegistryRevision(two, null)).toBeNull();
  });
});

describe('C1 — the module is pure and the screens read it', () => {
  const src = read('src/features/central-needs/central-needs.revision-context.ts');
  const importLines = src.split('\n').filter((l) => /^\s*import\b/.test(l));

  it('imports nothing at runtime — only the service TYPE, which the compiler erases', () => {
    expect(importLines).toEqual(["import type { PlanRevision, RevisionStatus } from './central-needs.service';"]);
  });

  it('carries no React, Supabase, DOM, network, clock or mutation of shared state', () => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const forbidden of [
      /\breact\b/i, /supabase/i, /\bwindow\b/, /\bdocument\b/, /\bfetch\s*\(/, /\.rpc\(/,
      /\bDate\b/, /localStorage|sessionStorage/, /useState|useEffect|useMemo/, /\.sort\(\)/,
    ]) expect(code, String(forbidden)).not.toMatch(forbidden);
  });

  it('the service, Advanced Mode and Simple Mode all take revision context from this one module', () => {
    const service = read('src/features/central-needs/central-needs.service.ts');
    const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
    const simple = read('src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx');
    expect(service).toMatch(/from '\.\/central-needs\.revision-context'/);
    expect(service).toContain('sortRegistryRevisions(');
    expect(screen).toMatch(/from '\.\/central-needs\.revision-context'/);
    expect(screen).toContain('deriveRevisionContext(revision)');
    expect(simple).toMatch(/from '\.\.\/central-needs\.revision-context'/);
    expect(simple).toContain('deriveRevisionContext(revision)');
  });

  it('PD-1: no correction path reads the draft-year input, and no revision year falls back to it', () => {
    const screen = read('src/features/central-needs/CentralNeedsScreen.tsx');
    const simple = read('src/features/central-needs/simple/CentralNeedsSimpleWorkspace.tsx');
    const correction = screen.slice(screen.indexOf('const onOpenCorrection'), screen.indexOf('const onOpenRevision'));
    expect(correction).toContain('revisionContext.correction');
    // The screen's own `planYear` state (a bare identifier) never appears in the
    // correction path; only the context's `target.planYear` does.
    expect(correction).not.toMatch(/(^|[^.\w])planYear\b/);
    expect(correction).toContain('target.planYear');
    // C2 (M215): a correction is its own RPC, fenced on the SELECTED revision's
    // id, and never goes through the annual-draft RPC. The draft RPC has exactly
    // one call site — the annual draft — which is the only place the explicit
    // draft-year input is legitimately read, and it can never open a correction.
    expect(correction).toContain('openCorrectionRevision(organizationId, target.planYear, target.revisionId, reason)');
    expect(correction).not.toContain('openPlanRevision(');
    expect(screen.match(/openPlanRevision\(/g)).toHaveLength(1);
    expect(screen).toContain('openPlanRevision(organizationId, planYear, false)');
    expect(simple).not.toMatch(/planYear\s*\?\?\s*planYear/);
    expect(simple).not.toMatch(/revision!?\.planYear\s*\?\?/);
  });
});
