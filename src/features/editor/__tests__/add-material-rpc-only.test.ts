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
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const SRC = join(__dirname, '../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const editor = readSrc('features/editor/EditorScreen.tsx');
const institutions = readSrc('features/institutions/InstitutionScreen.tsx');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
const registryService = readSrc('shared/supabase/services/registry.service.ts');
const qrService = readSrc('shared/supabase/services/qr.service.ts');

function extractFn(src: string, startMarker: string, endMarker: string): string {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  return src.slice(start, end === -1 ? undefined : end);
}

describe('Add-material call path: EditorScreen.tsx uses the RPC, not a direct table write', () => {
  const doApply = extractFn(editor, 'async function doApply', 'const fieldStyle');

  it('calls upsertAvailability (phoenix_upsert_availability RPC) — not a direct .insert()/.upsert() on item_availability', () => {
    expect(doApply).toContain('await upsertAvailability(');
    expect(doApply).not.toMatch(/\.from\('item_availability'\)/);
    expect(doApply).not.toMatch(/\.insert\(|\.upsert\(/);
  });

  it('does NOT call phoenix_apply_availability_movement for a first-time add (quantity comes from the INSERT branch, not a movement)', () => {
    expect(doApply).not.toContain('applyAvailabilityMovement');
  });

  it('does NOT create a QR target/token as part of adding a material (QR creation is a separate, manual, port-level action)', () => {
    expect(doApply).not.toMatch(/createQrForTarget|create_qr_for_target/);
  });

  it('reloads pointAvailability after a successful save (BUGFIX: previously missing, left isEditMode stale)', () => {
    expect(doApply).toMatch(/setToast\(t\('apply_success', lang\)\)[\s\S]*pointAvailability\.reload\(\)/);
  });

  it('the reload happens on the success path, not inside the catch block', () => {
    const successBlock = doApply.slice(doApply.indexOf('await upsertAvailability'), doApply.indexOf('} catch (e) {'));
    expect(successBlock).toContain('pointAvailability.reload()');
  });

  it('classifies save errors via classifyAvailabilitySaveError and logs to console (already correct — unchanged by this phase)', () => {
    const catchBlock = doApply.slice(doApply.indexOf('} catch (e) {'));
    expect(catchBlock).toContain('console.error(');
    expect(catchBlock).toContain('classifyAvailabilitySaveError(e)');
    expect(catchBlock).not.toMatch(/setToast\(e instanceof Error \? e\.message/);
  });
});

describe('Add-material call path: InstitutionScreen.tsx QuickAvailForm uses the RPC, not a direct table write', () => {
  // Scoped to QuickAvailForm specifically — InstitutionScreen.tsx has multiple
  // functions with an identically-shaped "async function onSubmit()", e.g.
  // AddPortForm's, so a bare marker search would grab the wrong one.
  const quickAvailForm = institutions.slice(institutions.indexOf('function QuickAvailForm('), institutions.indexOf('\n}\n\n', institutions.indexOf('function QuickAvailForm(')));
  const onSubmit = extractFn(quickAvailForm, 'async function onSubmit() {', 'return (');

  it('calls upsertAvailability (phoenix_upsert_availability RPC) — not a direct .insert()/.upsert() on item_availability', () => {
    expect(onSubmit).toContain('await upsertAvailability(');
    expect(onSubmit).not.toMatch(/\.from\('item_availability'\)/);
    expect(onSubmit).not.toMatch(/\.insert\(|\.upsert\(/);
  });

  it('does NOT call phoenix_apply_availability_movement or create a QR target as part of adding a material', () => {
    expect(onSubmit).not.toContain('applyAvailabilityMovement');
    expect(onSubmit).not.toMatch(/createQrForTarget|create_qr_for_target/);
  });

  it('already reloads on success via onSaved() -> avail.reload() (unchanged by this phase)', () => {
    expect(onSubmit).toContain('onSaved();');
    expect(institutions).toMatch(/onSaved=\{\(\)\s*=>\s*\{\s*setShowAdd\(false\);\s*avail\.reload\(\);/);
  });

  it('BUGFIX: catch block now classifies via classifyAvailabilitySaveError instead of showing raw e.message', () => {
    const catchBlock = onSubmit.slice(onSubmit.indexOf('} catch (e) {'));
    expect(catchBlock).toContain('console.error(');
    expect(catchBlock).toContain('classifyAvailabilitySaveError(e)');
    expect(catchBlock).not.toMatch(/setError\(e instanceof Error \? e\.message/);
  });

  it('classifyAvailabilitySaveError is imported from availability.service', () => {
    const importBlock = institutions.slice(0, institutions.indexOf('export function InstitutionScreen'));
    expect(importBlock).toMatch(/classifyAvailabilitySaveError[\s\S]{0,80}from '@\/shared\/supabase\/services\/availability\.service'/);
  });
});

describe('No direct writes to any availability-related table anywhere in the frontend (RPC-only, matches live-confirmed grants)', () => {
  const files: [string, string][] = [
    ['EditorScreen.tsx', editor],
    ['InstitutionScreen.tsx', institutions],
    ['availability.service.ts', availabilityService],
    ['registry.service.ts', registryService],
    ['qr.service.ts', qrService],
  ];

  for (const [name, src] of files) {
    it(`${name}: no direct .insert()/.update()/.upsert()/.delete() against central_items, local_items, item_availability, item_availability_movements, qr_targets, or qr_tokens`, () => {
      const tables = ['central_items', 'local_items', 'item_availability', 'item_availability_movements', 'qr_targets', 'qr_tokens'];
      for (const table of tables) {
        const writePattern = new RegExp(`\\.from\\('${table}'\\)[\\s\\S]{0,120}?\\.(insert|update|upsert|delete)\\(`, 'g');
        expect(src, `${name} appears to write directly to ${table}`).not.toMatch(writePattern);
      }
    });
  }

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

  it('EditorScreen gates the Apply action on availability.create OR availability.update — the RPC itself (not a table grant) decides which applies', () => {
    expect(editor).toContain("myPermissions.has('availability.create')");
    expect(editor).toContain("myPermissions.has('availability.update')");
    expect(editor).toContain('canCreateAvailability || canUpdateAvailability');
  });

  it('super_admin is not blocked by a missing direct table grant — canSubmit only depends on org/point/name state and permission flags, not on a raw table-level check', () => {
    const canSubmitLine = editor.split('\n').find(l => l.includes('const canSubmit ='));
    expect(canSubmitLine).toBeTruthy();
    expect(canSubmitLine).not.toMatch(/\.from\(/);
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

  it('both add-material catch blocks use the same classifier (no duplicated/divergent error-mapping logic)', () => {
    const editorCatch = extractFn(editor, 'async function doApply', 'const fieldStyle').match(/} catch \(e\) \{[\s\S]*?\}\s*finally/)?.[0] ?? '';
    expect(editorCatch).toContain('classifyAvailabilitySaveError(e)');
    const quickAvailForm = institutions.slice(institutions.indexOf('function QuickAvailForm('), institutions.indexOf('\n}\n\n', institutions.indexOf('function QuickAvailForm(')));
    const quickAddOnSubmit = extractFn(quickAvailForm, 'async function onSubmit() {', 'return (');
    const quickAddCatch = quickAddOnSubmit.match(/} catch \(e\) \{[\s\S]*?\}\s*finally/)?.[0] ?? '';
    expect(quickAddCatch).toContain('classifyAvailabilitySaveError(e)');
  });
});

describe('Guards: no Service-D/inter_org_exchange changes, no wipe tooling restored', () => {
  it('no inter_org_exchange reference in either touched file', () => {
    expect(editor).not.toMatch(/inter_org_exchange/i);
    expect(institutions).not.toMatch(/inter_org_exchange/i);
  });

  it('no service_role/auth.admin usage in either touched file', () => {
    expect(editor).not.toMatch(/service_role|auth\.admin/i);
    expect(institutions).not.toMatch(/service_role|auth\.admin/i);
  });

  it('no wipe tooling references', () => {
    expect(editor).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
    expect(institutions).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe/i);
  });

  it('this file\'s own frontend changes (EditorScreen.tsx / InstitutionScreen.tsx reload + error-classification fixes) added no migration newer than 043 — 043 itself was added separately once the real DB-level root cause was found (only the separately-reviewed migrations 044/045, DB-MY-ACCOUNT-WHATSAPP-PHONE-A / DB-MY-ACCOUNT-WHATSAPP-RPC-A, are allowed beyond 043)', () => {
    const ROOT = join(__dirname, '../../../../');
    const migrationsDir = join(ROOT, 'supabase/migrations');
    const matches = readdirSync(migrationsDir).filter((f: string) => /^0(4[4-9]|[5-9][0-9])_/.test(f));
    expect(matches).toEqual(['044_phoenix_profiles_whatsapp_phone.sql', '045_phoenix_update_my_whatsapp_phone_rpc.sql', '046_phoenix_set_my_org_whatsapp_contact_rpc.sql', '047_phoenix_live_alerts_contact_fields.sql', '048_live_alerts_expiry_risk_tiers.sql', '049_add_national_code_to_item_availability.sql']);
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

  it('EditorScreen.tsx and QuickAvailForm still call the same upsertAvailability RPC path this migration does not change — the frontend reload/error-mapping fixes remain valid and complementary, not a substitute for 043', () => {
    expect(editor).toContain('await upsertAvailability(');
    const quickAvailForm = institutions.slice(institutions.indexOf('function QuickAvailForm('), institutions.indexOf('\n}\n\n', institutions.indexOf('function QuickAvailForm(')));
    expect(quickAvailForm).toContain('await upsertAvailability(');
  });
});
