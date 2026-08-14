/**
 * R1.1-U — the canonical `typecheck` script must be a REAL TypeScript gate.
 *
 * THE BUG THIS LOCKS OUT. The root tsconfig.json is a SOLUTION file: it carries
 * `"files": []` and delegates everything to project references
 * (tsconfig.app.json, tsconfig.node.json). `tsc --noEmit` on a solution file
 * type-checks only that file's own `files`/`include` — which is empty — so it
 * exits 0 having checked NOTHING. It never descends into the referenced
 * projects; only `tsc -b` does.
 *
 * That is not theoretical. During R1.1-U, adding one member to the `OfficialRole`
 * union left THREE exhaustive `Record<AnyRole, …>` maps missing a key —
 * a hard compile error in src/ — and `npm run typecheck` still exited 0. The
 * failure only surfaced under `npm run build`, whose `tsc -b` prefix does the
 * real work. A green "typecheck" that cannot fail is worse than no typecheck:
 * it is a gate everyone trusts and nothing enforces.
 *
 * These assertions read package.json and the tsconfig layout, so they hold
 * regardless of the current source tree's health.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const readJson = (rel: string) =>
  JSON.parse(readFileSync(join(ROOT, rel), 'utf8').replace(/^﻿/, ''));

const pkg = readJson('package.json') as { scripts: Record<string, string> };
const rootTsconfig = readJson('tsconfig.json') as {
  files?: unknown[];
  references?: { path: string }[];
  include?: unknown[];
};

describe('the canonical typecheck script is project-reference aware', () => {
  it('the root tsconfig really is a solution file — the precondition for the bug', () => {
    // If this ever stops being true the rule below may be relaxed, but it must
    // be a deliberate decision, not a silent drift.
    expect(Array.isArray(rootTsconfig.files)).toBe(true);
    expect(rootTsconfig.files).toHaveLength(0);
    expect(rootTsconfig.include ?? []).toHaveLength(0);
    expect(rootTsconfig.references?.length ?? 0).toBeGreaterThan(0);
  });

  it('typecheck builds the referenced projects instead of checking nothing', () => {
    const script = pkg.scripts.typecheck;
    expect(script, 'a typecheck script must exist').toBeTruthy();
    // `tsc -b` (or --build) is the only form that descends into references.
    expect(script).toMatch(/\btsc\s+(-b\b|--build\b)/);
  });

  it('typecheck is NOT the no-op form that silently passes', () => {
    const script = pkg.scripts.typecheck;
    // The exact regression: `tsc --noEmit` with no -b on a solution root.
    expect(script).not.toMatch(/\btsc\s+--noEmit\b(?![\s\S]*--build)/);
    expect(/\btsc\s+(-b\b|--build\b)/.test(script)).toBe(true);
  });

  it('build still performs its own type check, so the two gates cannot diverge', () => {
    expect(pkg.scripts.build).toMatch(/\btsc\s+(-b\b|--build\b)/);
  });

  it('every referenced project actually exists', () => {
    for (const ref of rootTsconfig.references ?? []) {
      expect(() => readJson(ref.path), ref.path).not.toThrow();
    }
  });
});
