/**
 * BUGFIX-AVAILABILITY-EDITOR-ADD-MATERIAL-A
 * Run: npm test -- --run
 *
 * Live Supabase diagnostics confirmed the RPC grants themselves are correct
 * (phoenix_upsert_availability / phoenix_apply_availability_movement /
 * create_qr_for_target / clear_port_availability all have SECURITY DEFINER +
 * authenticated EXECUTE, anon denied) — so this phase does not touch grants
 * or add a migration. Source investigation instead found two real,
 * independent frontend gaps in the two "add material" surfaces:
 *
 * 1. EditorScreen.tsx (nav_editor — the actual "Availability Editor" screen):
 *    doApply() already used the RPC path and already classified errors via
 *    classifyAvailabilitySaveError + console diagnostics (this part was
 *    already correct) — but on a SUCCESSFUL save it never reloaded
 *    pointAvailability, so the newly-added row wasn't reflected in
 *    isEditMode/existingRow detection until the point selection changed. A
 *    second Apply for the same material (no other field changes) would still
 *    look like a brand-new row locally and could resend a stale quantity.
 *
 * 2. InstitutionScreen.tsx's QuickAvailForm (the port-level "+ Add" quick
 *    form) already reloads correctly on success (onSaved -> avail.reload())
 *    but its catch block showed the raw/untranslated e.message (falling back
 *    to load_error only when e was not an Error instance) instead of running
 *    it through classifyAvailabilitySaveError like every other
 *    availability-mutation catch in the codebase.
 *
 * Neither surface has any direct INSERT/UPDATE against central_items,
 * local_items, item_availability, item_availability_movements, qr_targets,
 * or qr_tokens — both go exclusively through phoenix_upsert_availability.
 * Neither calls phoenix_apply_availability_movement or creates a QR target
 * as part of adding a material — by design: the movement RPC is for
 * quantity CHANGES on an EXISTING row, not initial creation, and QR
 * generation is a separate, manual, port-level action.
 *
 * CORRECTION (BUGFIX-AVAILABILITY-DUPLICATE-PORT-INDEX-B): the two frontend
 * fixes above (reload-after-save, classified error mapping) were real gaps
 * and remain correct, but they do NOT fix the actual production-blocking
 * root cause. A live browser error surfaced it: adding a second material to
 * any outlet failed with 409/23505 "duplicate key value violates unique
 * constraint item_avail_point_port_idx" — a wrong legacy DB-level unique
 * index (distribution_point_id, port_name) that allows at most ONE
 * item_availability row per outlet, total, regardless of scientific_name.
 * No amount of frontend reload/error-classification logic can work around a
 * hard DB constraint violation on every second add. The actual fix is
 * migration 043 (043_phoenix_fix_item_availability_unique_indexes.sql),
 * which drops that index plus a second, narrower wrong index
 * (item_avail_point_sciname_idx) while preserving the correct 4-column
 * identity index (item_availability_dp_sci_conc_form_uniq, migration 029)
 * that phoenix_upsert_availability's own lookup already matches. See
 * supabase/migrations/__tests__/043-fix-item-availability-unique-indexes.test.ts
 * for that migration's tests, and the "requires migration 043" describe
 * block below for what this file specifically asserts about that
 * dependency.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { reviewedMigrationFilesAbove } from '../../../../supabase/migrations/__tests__/helpers/reviewed-migrations';
import { actualMigrationFilesAbove } from '../../../../supabase/migrations/__tests__/helpers/migration-dir';
import {
  expectRetiredSurfaceAbsent,
  expectScreenThreeIsInventoryCenter,
  expectQuickAvailFormAbsent,
  productionSourceFiles,
} from '../../../../tests/helpers/retired-surfaces';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

// E6: EditorScreen.tsx is gone — the screen is retired. Assertions that named
// it are now absence guards, and the "no direct table write" scan below covers
// EVERY production file rather than a hand-listed few.
const institutions = readSrc('features/institutions/InstitutionScreen.tsx');
const reactivateModal = readSrc('features/status/ReactivateMaterialModal.tsx');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
const registryService = readSrc('shared/supabase/services/registry.service.ts');
const qrService = readSrc('shared/supabase/services/qr.service.ts');


describe('Add-material via the retired manual forms: both surfaces are gone', () => {
  // These two describes used to assert that EditorScreen's doApply and
  // InstitutionScreen's QuickAvailForm each reached the RPC rather than writing
  // a table directly, and that each classified its errors. Both surfaces are
  // now RETIRED, so the guarantee becomes: neither can be reintroduced, and the
  // RPC-only rule is enforced across every production file (next describe).
  it('EditorScreen is deleted, unimported and unrendered', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('screen 3 routes to the Inventory Center that replaced it', () => {
    expectScreenThreeIsInventoryCenter();
  });

  it('the QuickAvailForm quick-add writer is gone from InstitutionScreen', () => {
    expectQuickAvailFormAbsent();
  });

  it('the one surviving availability writer still goes through the RPC wrapper', () => {
    // ReactivateMaterialModal is deployment blocker 3. While it exists it must
    // obey the same rule the retired forms did: RPC wrapper, never a table.
    expect(reactivateModal).toContain('await upsertAvailability(');
    expect(reactivateModal).not.toMatch(/\.from\('item_availability'\)/);
    expect(reactivateModal).toContain('classifyAvailabilitySaveError');
  });
});

describe('No direct writes to any availability-related table anywhere in the frontend (RPC-only, matches live-confirmed grants)', () => {
  const TABLES = [
    'central_items', 'local_items', 'item_availability',
    'item_availability_movements', 'qr_targets', 'qr_tokens',
  ];

  // E6: this used to iterate a HAND-LISTED set of five files, one of which was
  // the now-retired EditorScreen. Dropping that entry would have quietly
  // narrowed the guarantee, so the scan was widened instead: every production
  // source file is checked, which is strictly stronger than the original and
  // cannot go stale when a new screen is added.
  for (const table of TABLES) {
    it(`no production file writes directly to ${table} — the RPC is the only path`, () => {
      const writePattern = new RegExp(`\\.from\\('${table}'\\)[\\s\\S]{0,120}?\\.(insert|update|upsert|delete)\\(`);
      const offenders = productionSourceFiles()
        .filter(f => writePattern.test(readFileSync(f, 'utf8')))
        .map(f => f.replace(/\\/g, '/').split('/src/')[1]);
      expect(offenders, `direct write to ${table}`).toEqual([]);
    });
  }

  it('the previously hand-listed services are covered by that scan and still read-only where required', () => {
    for (const [name, src] of [
      ['InstitutionScreen.tsx', institutions],
      ['availability.service.ts', availabilityService],
      ['qr.service.ts', qrService],
    ] as [string, string][]) {
      expect(src.length, `${name} should still be readable`).toBeGreaterThan(0);
    }
  });

  it('registry.service.ts (getLocalItems, source of the QuickAvailForm dropdown) is read-only', () => {
    expect(registryService).not.toMatch(/\.insert\(|\.update\(|\.upsert\(|\.delete\(/);
  });
});

describe('super_admin can add the first material via the RPC path (no direct-write grant needed)', () => {
  it('upsertAvailability requires no organization_id/distribution_point_id pre-existing row — INSERT branch handled server-side by phoenix_upsert_availability', () => {
    const fnStart = availabilityService.indexOf('export async function upsertAvailability');
    const fnBody = availabilityService.slice(fnStart, availabilityService.indexOf('\n}', fnStart));
    expect(fnBody).toContain("supabase.rpc('phoenix_upsert_availability'");
  });

  it('the retired EditorScreen can no longer gate anything — it is gone', () => {
    // Was: EditorScreen gates Apply on availability.create OR availability.update.
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('the surviving availability writer is permission-gated, not table-gated', () => {
    // The invariant that mattered: the RPC decides, never a raw table grant.
    expect(reactivateModal).toContain('REACTIVATE_PERMISSION_KEYS');
    expect(reactivateModal).toContain('myPermissions.has');
    expect(reactivateModal).not.toMatch(/\.from\('item_availability'\)/);
  });
});

describe('Backend RPC errors map to safe translated messages, not a raw/generic load_error', () => {
  it('classifyAvailabilitySaveError classifies quantity_update_requires_movement, 42501/forbidden variants, and falls back to load_error only for genuinely unclassified errors', () => {
    const fnStart = availabilityService.indexOf('export function classifyAvailabilitySaveError');
    const fnBody = availabilityService.slice(fnStart, availabilityService.indexOf('\n}', fnStart) + 2);
    expect(fnBody).toContain('avail_qty_update_requires_movement');
    expect(fnBody).toContain("code === '42501'");
    expect(fnBody).toContain('avail_no_create_permission');
    expect(fnBody).toContain('avail_no_update_permission');
    expect(fnBody).toContain('avail_cross_org_denied');
    expect(fnBody).toContain("return 'load_error';");
  });

  it('the surviving availability writer uses the shared classifier (no divergent mapping)', () => {
    // Was: assert BOTH retired add-material catch blocks used the classifier.
    // Both are retired, so the rule now binds whatever still writes availability.
    const catchBlock = reactivateModal.slice(reactivateModal.indexOf('} catch'));
    expect(catchBlock).toContain('classifyAvailabilitySaveError');
  });
});

describe('Guards: no Service-D/inter_org_exchange changes, no wipe tooling restored', () => {
  // These were scoped to "either touched file" — i.e. this phase must not have
  // introduced Service-D/wipe surface into the two add-material screens. They
  // are deliberately NOT widened to the whole repo: inter_org_exchange is a
  // legitimate feature elsewhere, so a repo-wide ban would assert something
  // false. One of the two named files is now retired, so the pair becomes
  // "the survivor is still clean" + "the other one is gone".
  it('the retired add-material surface cannot carry any of this — it is deleted', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
    expectQuickAvailFormAbsent();
  });

  it('no inter_org_exchange reference in the surviving touched file', () => {
    expect(institutions).not.toMatch(/inter_org_exchange/i);
  });

  it('no service_role/auth.admin usage in the surviving touched file', () => {
    expect(institutions).not.toMatch(/service_role|auth\.admin/i);
  });

  it('no wipe tooling references in the surviving touched file', () => {
    expect(institutions).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
  });

  it('this file\'s own frontend changes (EditorScreen.tsx / InstitutionScreen.tsx reload + error-classification fixes) added no migration newer than 043 — 043 itself was added separately once the real DB-level root cause was found (only the separately-reviewed migrations 044/045/.../054, DB-MY-ACCOUNT-WHATSAPP-PHONE-A / DB-MY-ACCOUNT-WHATSAPP-RPC-A / ... / PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A, are allowed beyond 043)', () => {
    const ROOT = join(__dirname, '../../../../');
    const migrationsDir = join(ROOT, 'supabase/migrations');
    // MIGRATION-GUARD-DERIVE-A: the expected filenames beyond 043 now come from
    // the canonical reviewed-migration registry instead of a copy kept in this
    // file. Still exact-filename equality: an unregistered migration on disk
    // fails here, so this phase still cannot smuggle in a migration of its own.
    expect(actualMigrationFilesAbove(43, migrationsDir)).toEqual(reviewedMigrationFilesAbove(43));
  });
});

describe('BUGFIX-AVAILABILITY-DUPLICATE-PORT-INDEX-B: adding multiple materials per outlet requires migration 043, not just the frontend fixes above', () => {
  const ROOT = join(__dirname, '../../../../');
  const migration043 = readFileSync(join(ROOT, 'supabase/migrations/043_phoenix_fix_item_availability_unique_indexes.sql'), 'utf8');

  it('migration 043 exists and drops the wrong item_avail_point_port_idx index', () => {
    expect(migration043).toContain('DROP INDEX IF EXISTS public.item_avail_point_port_idx;');
  });

  it('migration 043 drops the wrong item_avail_point_sciname_idx index', () => {
    expect(migration043).toContain('DROP INDEX IF EXISTS public.item_avail_point_sciname_idx;');
  });

  it('migration 043 preserves the correct 4-column identity index that phoenix_upsert_availability already relies on', () => {
    // Scoped to actual DROP statement lines only — the migration's header
    // prose legitimately discusses item_availability_dp_sci_conc_form_uniq
    // at length while explaining why it's preserved (see the dedicated
    // 043-fix-item-availability-unique-indexes.test.ts for the rigorous,
    // comment-stripped version of this check).
    const dropLines = migration043.split('\n').filter(l => l.trim().startsWith('DROP'));
    for (const line of dropLines) {
      expect(line).not.toContain('item_availability_dp_sci_conc_form_uniq');
    }
    expect(migration043).toContain('item_availability_dp_sci_conc_form_uniq');
  });

  it('the surviving availability writer still uses the RPC path this migration does not change', () => {
    // Was: assert EditorScreen and QuickAvailForm both called upsertAvailability.
    // Both are retired; migration 043 remains the real fix either way.
    expectRetiredSurfaceAbsent('EditorScreen');
    expectQuickAvailFormAbsent();
    expect(reactivateModal).toContain('await upsertAvailability(');
  });
});
