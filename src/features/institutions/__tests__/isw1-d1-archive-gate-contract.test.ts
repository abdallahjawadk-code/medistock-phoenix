/**
 * ISW1-D1 — the archive gate's rendering contract in OrgCleanupWizard.
 *
 * The service half of the repair makes a failed impact read throw. That alone is
 * not enough: useAsync deliberately KEEPS its last successful `data` when a
 * later run fails, so a wizard that renders on `impact.data` alone would keep a
 * stale impact card — and a stale `canArchive` — on screen after the counts
 * became unreadable. That is the same fail-open in a different place.
 *
 * These assertions read the component source, matching the discipline this
 * repository already uses for this screen in hierarchy.test.ts. The end-to-end
 * runtime proof is the IS-W1 retest, which drives the real UI in a real browser.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../..');
const SCREEN = readFileSync(join(ROOT, 'src/features/institutions/InstitutionScreen.tsx'), 'utf8');
const STRINGS = readFileSync(join(ROOT, 'src/shared/i18n/strings.ts'), 'utf8');
const LIFECYCLE = readFileSync(join(ROOT, 'src/shared/supabase/services/lifecycle.service.ts'), 'utf8');

describe('the impact card cannot render over an error', () => {
  it('gates the impact card on the ABSENCE of an error, not just on data', () => {
    // Pre-repair this read `{!impact.loading && d && (`.
    expect(SCREEN).toContain('{!impact.loading && !impact.error && d && (');
  });

  it('still renders a dedicated error state with a retry', () => {
    expect(SCREEN).toContain('{!impact.loading && impact.error && (');
    expect(SCREEN).toContain('onRetry={impact.reload}');
  });

  it('keeps the archive action nested inside the canArchive branch', () => {
    // The confirmation input and the archive button must remain unreachable
    // whenever canArchive is false — including the "unknown" case, which now
    // never reaches this branch at all.
    expect(SCREEN).toContain('{d.canArchive && (');
    expect(SCREEN).toContain("if (confirm !== phrase || !d?.canArchive) return;");
  });
});

describe('the unavailable-counts message is localized', () => {
  it('maps the sentinel to a localized string rather than showing raw error text', () => {
    expect(SCREEN).toContain('IMPACT_READ_UNAVAILABLE');
    expect(SCREEN).toContain("t('dw_impact_unavailable', lang)");
  });

  it('imports the sentinel from the service rather than re-declaring it', () => {
    expect(SCREEN).toMatch(/IMPACT_READ_UNAVAILABLE,\s*\n\}\s*from '@\/shared\/supabase\/services\/lifecycle\.service'/);
  });

  it('defines dw_impact_unavailable in BOTH Arabic and English', () => {
    const line = STRINGS.split('\n').find((l) => l.includes('dw_impact_unavailable:'));
    expect(line, 'dw_impact_unavailable must exist').toBeTruthy();
    expect(line).toMatch(/ar:\s*'[^']+'/);
    expect(line).toMatch(/en:\s*'[^']+'/);
    // Arabic must actually be Arabic, not an English placeholder.
    expect(line).toMatch(/[؀-ۿ]/);
  });

  it('does not claim dependencies are zero in either language', () => {
    const line = STRINGS.split('\n').find((l) => l.includes('dw_impact_unavailable:')) ?? '';
    expect(line).not.toMatch(/\b0\b|zero|صفر/i);
  });

  it('leaves the existing blocked/ready wording untouched', () => {
    expect(STRINGS).toContain("dw_blocked:");
    expect(STRINGS).toContain("dw_ready:");
    expect(STRINGS).toContain('محظور — يجب حذف التبعيات أولاً');
  });
});

describe('the service can no longer fabricate a count', () => {
  it('no longer coerces a missing count with ?? 0', () => {
    expect(LIFECYCLE).not.toMatch(/Res\.count\s*\?\?\s*0/);
    expect(LIFECYCLE).not.toMatch(/srRes\.count\s*\?\?\s*0/);
  });

  it('routes every impact count through the fail-closed helper', () => {
    for (const table of [
      'warehouses',
      'distribution_points',
      'qr_tokens',
      'item_availability',
      'profiles',
      'institution_item_status_reports',
    ]) {
      expect(LIFECYCLE).toContain(`requireCount(`);
      expect(LIFECYCLE).toContain(`'${table}'`);
    }
  });

  it('keeps canArchive defined by the same four canonical dependency classes', () => {
    expect(LIFECYCLE).toContain('canArchive: wh === 0 && dp === 0 && qr === 0 && avail === 0');
  });

  it('exports the sentinel so callers can localize it', () => {
    expect(LIFECYCLE).toContain("export const IMPACT_READ_UNAVAILABLE = 'IMPACT_READ_UNAVAILABLE'");
  });

  it('no longer swallows the status-report read in a bare catch', () => {
    expect(LIFECYCLE).not.toContain('/* table may not exist */');
  });
});

describe('the server guard ships alongside the UI guard', () => {
  const MIGRATION = readFileSync(
    join(ROOT, 'supabase/migrations/201_phoenix_organization_archive_dependency_guard.sql'),
    'utf8',
  );

  it('guards the transition INTO inactive', () => {
    expect(MIGRATION).toContain("NEW.status IS DISTINCT FROM 'inactive' OR OLD.status IS NOT DISTINCT FROM 'inactive'");
  });

  it('counts exactly the four canonical blocking classes with the contract filters', () => {
    expect(MIGRATION).toMatch(/FROM public\.warehouses\s+WHERE organization_id = NEW\.id AND status <> 'archived'/);
    expect(MIGRATION).toMatch(/FROM public\.distribution_points\s+WHERE organization_id = NEW\.id AND status <> 'archived'/);
    expect(MIGRATION).toMatch(/FROM public\.qr_tokens\s+WHERE organization_id = NEW\.id AND status = 'active'/);
    expect(MIGRATION).toMatch(/FROM public\.item_availability\s+WHERE organization_id = NEW\.id/);
  });

  it('takes the FOR UPDATE serialization fence before counting', () => {
    const fence = MIGRATION.indexOf('FOR UPDATE');
    const firstCount = MIGRATION.indexOf('SELECT count(*) INTO v_warehouses');
    expect(fence).toBeGreaterThan(-1);
    expect(fence).toBeLessThan(firstCount);
  });

  it('raises a deterministic error contract', () => {
    expect(MIGRATION).toContain("RAISE EXCEPTION 'organization_archive_blocked_by_dependencies'");
    expect(MIGRATION).toContain("ERRCODE = '23514'");
  });

  it('is SECURITY DEFINER with a pinned search_path and no PUBLIC execute', () => {
    expect(MIGRATION).toContain('SECURITY DEFINER');
    expect(MIGRATION).toContain("SET search_path TO 'public', 'pg_temp'");
    expect(MIGRATION).toContain('REVOKE ALL ON FUNCTION public._phoenix_organization_archive_dependency_guard_v1() FROM PUBLIC');
  });

  it('carries no manual-apply banner and is one transaction', () => {
    expect(MIGRATION).not.toMatch(/MANUAL APPLY ONLY/i);
    expect(MIGRATION).not.toContain('\r');
    expect((MIGRATION.match(/^BEGIN;$/gm) ?? [])).toHaveLength(1);
    expect((MIGRATION.match(/^COMMIT;$/gm) ?? [])).toHaveLength(1);
  });

  it('installs exactly the five triggers the two halves need, and no others', () => {
    const triggers = (MIGRATION.match(/^CREATE TRIGGER (\w+)/gm) ?? [])
      .map((l) => l.replace('CREATE TRIGGER ', ''))
      .sort();
    expect(triggers).toEqual([
      'distribution_points_archived_org_guard_trg',
      'item_availability_archived_org_guard_trg',
      'organizations_archive_dependency_guard_trg',
      'qr_tokens_archived_org_guard_trg',
      'warehouses_archived_org_guard_trg',
    ]);
    // Every CREATE TRIGGER is preceded by its own DROP ... IF EXISTS, so the
    // migration is re-runnable.
    expect((MIGRATION.match(/^DROP TRIGGER IF EXISTS/gm) ?? [])).toHaveLength(triggers.length);
  });
});

describe('the reciprocal half closes the ordering hole', () => {
  const MIGRATION = readFileSync(
    join(ROOT, 'supabase/migrations/201_phoenix_organization_archive_dependency_guard.sql'),
    'utf8',
  );

  // The archive fence alone only makes the count TRUE AT DECISION TIME. It does
  // not stop the loser of the race from landing afterwards, so without this
  // second half the invariant is defeatable purely by ordering — reproduced on a
  // real rig for both an INSERT and an in-place status flip before it was added.
  it('refuses a live dependency under an archived organization', () => {
    expect(MIGRATION).toContain("RAISE EXCEPTION 'organization_archived_dependency_not_permitted'");
    expect(MIGRATION).toContain("IF v_org_status = 'inactive' THEN");
  });

  it('defines liveness per table exactly as the archive guard counts it', () => {
    expect(MIGRATION).toContain("IF TG_TABLE_NAME = 'item_availability' THEN");
    expect(MIGRATION).toContain("v_is_live := (NEW.status = 'active');");
    expect(MIGRATION).toContain("v_is_live := (NEW.status IS DISTINCT FROM 'archived');");
  });

  it('takes the reciprocal FOR SHARE fence on the organization row', () => {
    // FOR SHARE conflicts with the archive guard's FOR UPDATE, so the two halves
    // can never both decide against a stale view of each other.
    expect(MIGRATION).toMatch(/FROM public\.organizations o\s+WHERE o\.id = NEW\.organization_id\s+FOR SHARE/);
  });

  it('never masks a missing organization - the foreign key owns that error', () => {
    expect(MIGRATION).toContain('IF NOT FOUND THEN');
  });

  it('is SECURITY DEFINER, search_path pinned, and not executable by PUBLIC', () => {
    expect(MIGRATION).toContain(
      'REVOKE ALL ON FUNCTION public._phoenix_archived_organization_dependency_guard_v1() FROM PUBLIC',
    );
    // Line-anchored: the header prose also discusses SECURITY DEFINER, and a
    // comment must never satisfy a contract check.
    expect((MIGRATION.match(/^SECURITY DEFINER$/gm) ?? [])).toHaveLength(2);
    expect((MIGRATION.match(/^SET search_path TO 'public', 'pg_temp'$/gm) ?? [])).toHaveLength(2);
  });

  it('guards only the columns that can change liveness or ownership', () => {
    expect(MIGRATION).toContain('BEFORE INSERT OR UPDATE OF status, organization_id ON public.warehouses');
    expect(MIGRATION).toContain('BEFORE INSERT OR UPDATE OF status, organization_id ON public.distribution_points');
    expect(MIGRATION).toContain('BEFORE INSERT OR UPDATE OF status, organization_id ON public.qr_tokens');
    // item_availability has no liveness status - only creation or a change of
    // owner can grow the count.
    expect(MIGRATION).toContain('BEFORE INSERT OR UPDATE OF organization_id ON public.item_availability');
  });
});
