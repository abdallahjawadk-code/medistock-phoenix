/**
 * G5 / M1 — DIRECT SUPPLY TOPOLOGY STATES MUST BE HONEST.
 *
 * `ds_no_sector_main` ("this network has no sector main depot") is a CLAIM ABOUT
 * THE DATABASE. Before G5 the Branch-B panel rendered it whenever the source
 * list was empty — which is also true while the Migration 191 role read is still
 * loading, and true FOREVER if that read fails, because nothing re-fetched. An
 * operator was told a structural fact when the truth was "not known yet" or
 * "the read broke".
 *
 * The fix gates the claim on a SUCCESSFUL load of both prerequisites — the
 * organization list (which selects the health sectors) and the role read — and
 * reports loading and error as themselves, with a retry.
 *
 * These are source-level assertions on the rendered branch order, which is what
 * decides which of the four states an operator sees. The corridor's security
 * semantics are unchanged and are covered by
 * `shared/lib/__tests__/direct-supply-corridors.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const SRC = join(__dirname, '..', 'DirectSupplyOperations.tsx');
const source = readFileSync(SRC, 'utf8');

/** The Branch-B conditional, from its guard comment to the closing paren. */
const branchB = (() => {
  const at = source.indexOf("branch === 'sector_to_health_center' && (");
  if (at === -1) throw new Error('Branch-B render block not found');
  return source.slice(at, source.indexOf('</PhoenixCard>', at));
})();

describe('G5 · Branch-B reports loading as loading', () => {
  it('renders a loading state while either prerequisite is still loading', () => {
    expect(branchB).toMatch(/\(orgs\.loading \|\| sectorRoles\.loading\)/);
    expect(branchB).toContain('PhoenixLoadingState');
    expect(branchB).toContain('data-testid="ds-sector-source-loading"');
  });

  it('LOADING is evaluated BEFORE the empty-source claim', () => {
    const loadingAt = branchB.indexOf('orgs.loading || sectorRoles.loading');
    const claimAt = branchB.indexOf("t('ds_no_sector_main'");
    expect(loadingAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    expect(loadingAt).toBeLessThan(claimAt);
  });
});

describe('G5 · Branch-B reports failure as failure, with a retry', () => {
  it('renders PhoenixErrorState when either prerequisite errored', () => {
    expect(branchB).toMatch(/\(orgs\.error \|\| sectorRoles\.error\)/);
    expect(branchB).toContain('PhoenixErrorState');
    expect(branchB).toContain('data-testid="ds-sector-source-error"');
  });

  it('the retry re-runs the read that actually failed', () => {
    expect(branchB).toMatch(/onRetry=\{\(\) => \{[^}]*orgs\.reload\(\)/);
    expect(branchB).toMatch(/sectorRoles\.reload\(\)/);
  });

  it('ERROR is evaluated BEFORE the empty-source claim', () => {
    const errorAt = branchB.indexOf('orgs.error || sectorRoles.error');
    const claimAt = branchB.indexOf("t('ds_no_sector_main'");
    expect(errorAt).toBeGreaterThan(-1);
    expect(errorAt).toBeLessThan(claimAt);
  });

  it('imports the error state it renders', () => {
    expect(source).toContain("import { PhoenixErrorState } from '@/shared/ui/PhoenixErrorState';");
  });
});

describe('G5 · the claim survives only for a genuinely empty successful load', () => {
  it('ds_no_sector_main is still rendered — the fix does not delete the state', () => {
    expect(branchB).toContain("t('ds_no_sector_main'");
  });

  it('it is reached only after loading and error have both been ruled out', () => {
    // The rendered chain must be, in order: loading -> error -> empty -> picker.
    const order = ['orgs.loading || sectorRoles.loading',
                   'orgs.error || sectorRoles.error',
                   'corridorSources.length === 0',
                   'PhoenixSelect'];
    let cursor = -1;
    for (const token of order) {
      const at = branchB.indexOf(token);
      expect(at, token).toBeGreaterThan(cursor);
      cursor = at;
    }
  });

  it('a successful load with a sector main still renders the picker', () => {
    expect(branchB).toContain('PhoenixSelect');
    expect(branchB).toMatch(/options=\{corridorSources\.map/);
  });
});

describe('G5 · corridor security semantics are untouched', () => {
  it('the Branch-B source is still the DATABASE structural role', () => {
    const corridors = readFileSync(
      join(__dirname, '..', '..', '..', 'shared', 'lib', 'direct-supply-corridors.ts'), 'utf8');
    expect(corridors).toContain("structuralRole === 'sector_main'");
  });

  it('no fallback was introduced that would offer a source without a role', () => {
    expect(branchB).not.toMatch(/structuralRole\s*\?\?\s*'sector_main'/);
    expect(branchB).not.toContain('|| warehouses');
  });

  it('the screen still asks Migration 191 for the roles', () => {
    expect(source).toContain('getOrganizationWarehouseRoles');
  });
});
