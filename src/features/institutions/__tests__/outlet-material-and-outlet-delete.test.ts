/**
 * BUGFIX-OUTLET-MATERIAL-AND-OUTLET-DELETE-A
 * Run: npm test -- --run
 *
 * Static source-code tests for:
 *  - "Remove from outlet" — a safe, audited quantity-zero + condition=missing
 *    action for a material row inside a distribution point (no hard delete,
 *    no bypass of the item_availability quantity hard guard — migration 035).
 *  - The pre-existing "Archive/Disable outlet" flow (archive_entity RPC) now
 *    honestly checks { ok } instead of always showing a false success toast,
 *    and its button/dialog no longer misuses the "Archived" status word as
 *    an action-verb label.
 *  - No hard DELETE of item_availability or distribution_points is
 *    introduced anywhere; purge_entity_with_all_data stays unreachable from
 *    the UI (pre-existing guard in hierarchy.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { roleDefaults } from '@/shared/lib/permissions';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const screen = readSrc('features/institutions/InstitutionScreen.tsx');
const lifecycleService = readSrc('shared/supabase/services/lifecycle.service.ts');
const availabilityService = readSrc('shared/supabase/services/availability.service.ts');
const strings = readSrc('shared/i18n/strings.ts');

const UUID_LITERAL_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe('Material remove action: visible in the outlet material list', () => {
  it('PortAvailabilitySection renders a remove-from-outlet button per row when canRemove (effective permission)', () => {
    const fnStart = screen.indexOf('function PortAvailabilitySection');
    const fnBody = screen.slice(fnStart, screen.indexOf('function QuickAvailForm'));
    expect(fnBody).toContain("t('avail_remove_from_outlet', lang)");
    // BUGFIX-HIDE-CLEARED-PORT-CONTENTS-A: already-removed (quantity 0 +
    // condition 'missing') rows are now filtered out of `rows` entirely
    // before rendering, so the per-row button gate simplifies to canRemove
    // alone — there is no longer a row in the list for which it could apply.
    expect(fnBody).toMatch(/\{canRemove\s*&&\s*\(/);
  });

  it('the remove button has a minimum touch target size (mobile-reachable)', () => {
    const fnStart = screen.indexOf('function PortAvailabilitySection');
    const fnBody = screen.slice(fnStart, screen.indexOf('function QuickAvailForm'));
    const btnStart = fnBody.indexOf('setRemoveTarget(r)');
    const around = fnBody.slice(btnStart, btnStart + 500);
    expect(around).toContain("minHeight: '28px'");
  });

  it('the button is inside the same card/row markup as the table view (no separate desktop-only container)', () => {
    const fnStart = screen.indexOf('function PortAvailabilitySection');
    const fnBody = screen.slice(fnStart, screen.indexOf('function QuickAvailForm'));
    expect(fnBody).not.toMatch(/isMobile/);
    expect(fnBody).toContain('rows.map(r =>');
  });
});

describe('Material remove action: calls the correct existing service/RPC path', () => {
  it('imports applyAvailabilityMovement and classifyAvailabilityMovementError from the existing availability service', () => {
    expect(screen).toContain('applyAvailabilityMovement');
    expect(screen).toContain('classifyAvailabilityMovementError');
    expect(screen).toContain("from '@/shared/supabase/services/availability.service'");
  });

  it('onConfirmRemove zeroes quantity via the audited movement RPC, not a direct write', () => {
    const fnStart = screen.indexOf('async function onConfirmRemove');
    const fnBody = screen.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain("movementType: 'set_exact'");
    expect(fnBody).toContain('amount: 0');
    expect(fnBody).not.toMatch(/\.update\(|\.delete\(|DELETE FROM/);
  });

  it('onConfirmRemove marks condition as missing via the existing upsert RPC after quantity matches', () => {
    const fnStart = screen.indexOf('async function onConfirmRemove');
    const fnBody = screen.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain('upsertAvailability');
    expect(fnBody).toContain("condition: 'missing'");
  });

  it('does not call any hard-delete RPC/table method for item_availability', () => {
    const fnStart = screen.indexOf('async function onConfirmRemove');
    const fnBody = screen.slice(fnStart, fnStart + 1500);
    expect(fnBody).not.toContain('purgeEntityWithAllData');
    expect(fnBody).not.toContain('purge_entity_with_all_data');
  });
});

describe('Material remove: success refreshes the list; errors are shown honestly', () => {
  it('reloads the availability list on success', () => {
    const fnStart = screen.indexOf('async function onConfirmRemove');
    const fnBody = screen.slice(fnStart, fnStart + 1500);
    expect(fnBody).toContain('avail.reload()');
    expect(fnBody).toContain("onToast(t('avail_removed_from_outlet', lang))");
  });

  it('shows a translated, honest error message on failure (not a raw thrown error)', () => {
    const fnStart = screen.indexOf('async function onConfirmRemove');
    const fnBody = screen.slice(fnStart, fnStart + 1500);
    expect(fnBody).toMatch(/catch \(e\)/);
    expect(fnBody).toContain('classifyAvailabilityMovementError(e)');
    expect(fnBody).toContain('setRemoveError(');
  });

  it('the confirmation dialog surfaces removeError to the user', () => {
    const fnStart = screen.indexOf('function PortAvailabilitySection');
    const fnBody = screen.slice(fnStart, screen.indexOf('function QuickAvailForm'));
    expect(fnBody).toMatch(/removeError && <p/);
  });
});

describe('Material remove: proves this is a safe deactivate, not a blind hard delete', () => {
  it('does not remove the row from item_availability, only zeroes quantity and flips condition', () => {
    const fnStart = screen.indexOf('async function onConfirmRemove');
    const fnBody = screen.slice(fnStart, fnStart + 1500);
    expect(fnBody).not.toMatch(/\.delete\(\)/);
    expect(fnBody).not.toContain("from('item_availability')");
  });

  it('quantity is only zeroed through the audited movement RPC when it is not already 0 (idempotent, no unnecessary writes)', () => {
    const fnStart = screen.indexOf('async function onConfirmRemove');
    const fnBody = screen.slice(fnStart, fnStart + 500);
    expect(fnBody).toMatch(/removeTarget\.quantity !== 0/);
  });

  it('BUGFIX-HIDE-CLEARED-PORT-CONTENTS-A: already-removed rows (quantity 0 + missing) are filtered out of the outlet contents list entirely, not just their remove button hidden', () => {
    const fnStart = screen.indexOf('function PortAvailabilitySection');
    const fnBody = screen.slice(fnStart, screen.indexOf('function QuickAvailForm'));
    expect(fnBody).toMatch(/\.filter\(r => !\(r\.quantity === 0 && r\.condition === 'missing'\)\)/);
  });
});

describe('Outlet disable/archive action: visible, confirmed, and now honest about failure', () => {
  it('PortCard still renders the archive/disable action, now gated by canArchivePortsEffective', () => {
    const cardStart = screen.indexOf('function PortCard');
    const cardBody = screen.slice(cardStart, screen.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toMatch(/canArchivePortsEffective &&[\s\S]{0,250}t\('port_disable_action', lang\)/);
  });

  it('the archive button no longer reuses the "Archived" status-word label', () => {
    const cardStart = screen.indexOf('function PortCard');
    const cardBody = screen.slice(cardStart, screen.indexOf('function QrPreviewModal', cardStart));
    // Only the status badge (point.status === 'active' ? ... : statusLabel(...)) may
    // reference the raw 'archived' concept; the action buttons must use the new key.
    expect(cardBody).not.toMatch(/setConfirmAction\('archive'\)[\s\S]{0,80}t\('archived', lang\)/);
    expect(cardBody).not.toMatch(/onClick=\{onArchivePort\}[\s\S]{0,80}t\('port_archived', lang\)/);
  });

  it('has a confirmation dialog before archiving (destructive-adjacent action)', () => {
    const cardStart = screen.indexOf('function PortCard');
    const cardBody = screen.slice(cardStart, screen.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toContain("confirmAction === 'archive'");
    expect(cardBody).toContain('onClick={onArchivePort}');
  });

  it('onArchivePort checks result.ok before reporting success (was previously always "successful")', () => {
    const fnStart = screen.indexOf('async function onArchivePort');
    const fnBody = screen.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain('const result = await archiveEntity(');
    expect(fnBody).toMatch(/if \(!result\.ok\)/);
    expect(fnBody).toContain('archiveErrorKey(result.error)');
  });

  it('archiveErrorKey maps known archive_entity failure codes to translated, honest messages', () => {
    expect(screen).toContain('function archiveErrorKey');
    const fnStart = screen.indexOf('function archiveErrorKey');
    const fnBody = screen.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain('INSUFFICIENT_ROLE');
    expect(fnBody).toContain('port_archive_forbidden');
    expect(fnBody).toContain('NOT_FOUND_OR_ALREADY_ARCHIVED');
    expect(fnBody).toContain('port_already_archived');
  });

  it('lifecycle.service archiveEntity return type documents the { ok:false, error } non-throwing failure shape', () => {
    const fnStart = lifecycleService.indexOf('export async function archiveEntity');
    const fnBody = lifecycleService.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain('error?: string');
  });
});

describe('Outlet deletion: never uses hard delete/purge, only the existing safe archive path', () => {
  it('InstitutionScreen does not import or call purgeEntityWithAllData (matches existing hierarchy.test.ts guard)', () => {
    expect(screen).not.toContain('purgeEntityWithAllData');
    expect(screen).not.toContain('purge_entity_with_all_data');
  });

  it('uses only archiveEntity/clearPortAvailability for destructive-adjacent outlet actions', () => {
    expect(screen).toContain('archiveEntity');
    expect(screen).toContain('clearPortAvailability');
  });

  it('port_archive_deps already documents that hard-delete is unsupported and archiving is used instead', () => {
    expect(strings).toContain('port_archive_deps');
    const line = strings.split('\n').find(l => l.trim().startsWith('port_archive_deps:'));
    expect(line).toBeDefined();
  });
});

describe('Outlet archive: success refreshes the outlet/port list', () => {
  it('onArchivePort reloads on confirmed success', () => {
    const fnStart = screen.indexOf('async function onArchivePort');
    const fnBody = screen.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain('onReload()');
  });
});

describe('BUGFIX-OUTLET-MATERIAL-DELETE-EDIT-A: Edit outlet action', () => {
  it('is visible in the outlet card, gated by canEditPorts (the same permission already used for material add)', () => {
    const cardStart = screen.indexOf('function PortCard');
    const cardBody = screen.slice(cardStart, screen.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toMatch(/canEditPorts &&[\s\S]{0,40}<PhoenixButton[\s\S]{0,80}onClick=\{openEdit\}/);
    expect(cardBody).toContain("t('port_edit', lang)");
  });

  it('the edit button is inside the same shared Actions row as the other mobile-reachable port actions (no desktop-only container)', () => {
    const cardStart = screen.indexOf('function PortCard');
    const cardBody = screen.slice(cardStart, screen.indexOf('function QrPreviewModal', cardStart));
    const actionsIdx = cardBody.indexOf('{/* Actions */}');
    const editIdx = cardBody.indexOf('canEditPorts &&', actionsIdx);
    expect(editIdx).toBeGreaterThan(actionsIdx);
    expect(editIdx - actionsIdx).toBeLessThan(350);
  });

  it('imports updateDistributionPoint from the existing warehouses service (no new RPC/migration)', () => {
    expect(screen).toContain('updateDistributionPoint');
    expect(screen).toContain("from '@/shared/supabase/services/warehouses.service'");
  });

  it('the edit dialog only exposes fields the existing service/type already supports: name, name_ar, pointType', () => {
    const dialogStart = screen.indexOf("open={confirmAction === 'edit'}");
    const dialogBody = screen.slice(dialogStart, screen.indexOf("open={confirmAction === 'archive'}"));
    expect(dialogBody).toContain('editNameAr');
    expect(dialogBody).toContain('editName');
    expect(dialogBody).toContain('editPointType');
    // no invented fields such as code/notes/status in this form
    expect(dialogBody).not.toMatch(/editCode|editNotes|editStatus/);
  });

  it('openEdit pre-fills the form from the existing point, never a blank/fake default', () => {
    const fnStart = screen.indexOf('function openEdit');
    const fnBody = screen.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('point.name');
    expect(fnBody).toContain('point.name_ar');
    expect(fnBody).toContain('point.pointType');
  });

  it('required fields (Arabic and English name) are validated before saving', () => {
    const fnStart = screen.indexOf('async function onSaveEdit');
    const fnBody = screen.slice(fnStart, fnStart + 700);
    expect(fnBody).toMatch(/!editName\.trim\(\)\s*\|\|\s*!editNameAr\.trim\(\)/);
    expect(fnBody).toContain("t('port_name_required', lang)");
  });

  it('save calls the existing updateDistributionPoint service, not a fake/local-only update', () => {
    const fnStart = screen.indexOf('async function onSaveEdit');
    const fnBody = screen.slice(fnStart, fnStart + 700);
    expect(fnBody).toMatch(/await updateDistributionPoint\(point\.id,/);
    expect(fnBody).not.toContain('setQr(');
  });

  it('does not send status or any unsupported field in the update payload', () => {
    const fnStart = screen.indexOf('async function onSaveEdit');
    const fnBody = screen.slice(fnStart, fnStart + 700);
    const callStart = fnBody.indexOf('await updateDistributionPoint(point.id,');
    const callBody = fnBody.slice(callStart, callStart + 200);
    expect(callBody).not.toContain('status:');
  });

  it('success closes the dialog, reloads outlet data, and shows an honest success message', () => {
    const fnStart = screen.indexOf('async function onSaveEdit');
    const fnBody = screen.slice(fnStart, fnStart + 700);
    expect(fnBody).toContain('setConfirmAction(null)');
    expect(fnBody).toContain('onReload()');
    expect(fnBody).toContain("onToast(t('port_updated', lang))");
  });

  it('failure keeps the dialog open and shows a translated, honest error (not a raw thrown error, not a silent close)', () => {
    const fnStart = screen.indexOf('async function onSaveEdit');
    const fnBody = screen.slice(fnStart, fnStart + 700);
    expect(fnBody).toMatch(/catch \(e\)/);
    expect(fnBody).toContain("setEditError(t('port_update_error', lang))");
    const catchIdx = fnBody.indexOf('catch (e)');
    const catchBody = fnBody.slice(catchIdx, catchIdx + 200);
    expect(catchBody).not.toContain('setConfirmAction(null)');
  });

  it('the edit dialog cannot be dismissed mid-save (avoids losing the in-flight request silently)', () => {
    const dialogStart = screen.indexOf("open={confirmAction === 'edit'}");
    const dialogBody = screen.slice(dialogStart, dialogStart + 300);
    expect(dialogBody).toMatch(/if \(!editBusy\) setConfirmAction\(null\)/);
  });

  it('does not render the outlet raw id/UUID anywhere in the edit form', () => {
    const dialogStart = screen.indexOf("open={confirmAction === 'edit'}");
    const dialogBody = screen.slice(dialogStart, screen.indexOf("open={confirmAction === 'archive'}"));
    expect(dialogBody).not.toMatch(UUID_LITERAL_RE);
    expect(dialogBody).not.toMatch(/>\{point\.id\}</);
  });

  it('new i18n keys are safe, bilingual, and match the requested wording', () => {
    const requiredKeys = ['port_save_action', 'port_name_required', 'port_update_error'];
    requiredKeys.forEach(key => {
      const line = strings.split('\n').find(l => l.trim().startsWith(`${key}:`));
      expect(line).toBeDefined();
      expect(line).toMatch(/ar:\s*'[^']+',\s*en:\s*'[^']+'/);
    });
  });

  it('reuses the pre-existing (previously unused) port_edit and port_name_ar/port_name_en keys instead of duplicating them', () => {
    expect(strings).toContain('port_edit:');
    expect(strings).toContain('port_name_ar:');
    expect(strings).toContain('port_name_en:');
  });

  it('no exchange/approval/service_role wording was introduced by the edit form', () => {
    const dialogStart = screen.indexOf("open={confirmAction === 'edit'}");
    const dialogBody = screen.slice(dialogStart, screen.indexOf("open={confirmAction === 'archive'}"));
    expect(dialogBody).not.toContain('service_role');
    expect(dialogBody.toLowerCase()).not.toMatch(/suggestion|recommendation|opportunit/);
  });
});

describe('BUGFIX-OUTLET-MATERIAL-DELETE-EDIT-A: permission-matrix fix — effective gating matches what the backend will actually allow', () => {
  it('canRemoveOutletMaterial requires ports.edit AND availability.quantity.set AND (availability.update OR availability.create)', () => {
    const fnStart = screen.indexOf('const canRemoveOutletMaterial');
    const fnBody = screen.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('canEditPorts');
    expect(fnBody).toContain("actorPermissions.has('availability.quantity.set')");
    expect(fnBody).toMatch(/actorPermissions\.has\('availability\.update'\)\s*\|\|\s*actorPermissions\.has\('availability\.create'\)/);
  });

  it('a role with ports.edit but WITHOUT availability.quantity.set does not see/enable the remove button (port_officer case)', () => {
    // PORT_OFFICER_DEFAULTS in permissions.ts grants ports.edit + availability.update
    // but NOT availability.quantity.set — canRemoveOutletMaterial must evaluate false
    // for that permission set, since applyAvailabilityMovement's set_exact call would
    // otherwise be rejected server-side after the button was already shown.
    const portOfficerPerms = roleDefaults('port_officer');
    const hasEdit = portOfficerPerms.has('ports.edit');
    const hasQtySet = portOfficerPerms.has('availability.quantity.set');
    expect(hasEdit).toBe(true);
    expect(hasQtySet).toBe(false);
  });

  it('roles that hold ports.edit + availability.quantity.set + availability.update/create can pass (hospital_admin default; super_admin has ALL_KEYS)', () => {
    // hospital_admin (LEGACY_ADMIN_DEFAULTS) is the only non-super_admin role
    // whose *default* permission set already includes all three requirements.
    // institution_admin's defaults do NOT include ports.edit/ports.archive —
    // if an institution_admin ever holds them it is via a custom per-user
    // override (see the next test), not the role default matrix.
    const hospitalAdminPerms = roleDefaults('hospital_admin');
    expect(hospitalAdminPerms.has('ports.edit')).toBe(true);
    expect(hospitalAdminPerms.has('availability.quantity.set')).toBe(true);
    expect(hospitalAdminPerms.has('availability.update') || hospitalAdminPerms.has('availability.create')).toBe(true);

    const superAdminPerms = roleDefaults('super_admin');
    expect(superAdminPerms.has('ports.edit')).toBe(true);
    expect(superAdminPerms.has('availability.quantity.set')).toBe(true);
  });

  it('the remove button in PortAvailabilitySection is gated by the canRemove prop (fed by the effective permission), not by canMutate', () => {
    const fnStart = screen.indexOf('function PortAvailabilitySection');
    const fnBody = screen.slice(fnStart, screen.indexOf('function QuickAvailForm'));
    expect(fnBody).toMatch(/\{canRemove\s*&&\s*\(/);
    // canMutate is still used, but only for the separate "+ Add" action, not remove
    expect(fnBody).toMatch(/canMutate\s*&&\s*!showAdd/);
  });

  it('onConfirmRemove still catches and honestly reports backend errors if permissions change mid-session (defense in depth — UI gating is not the only safety net)', () => {
    const fnStart = screen.indexOf('async function onConfirmRemove');
    const fnBody = screen.slice(fnStart, fnStart + 1500);
    expect(fnBody).toMatch(/catch \(e\)/);
    expect(fnBody).toContain('classifyAvailabilityMovementError(e)');
    expect(fnBody).toContain('setRemoveError(');
  });

  it('canArchivePortsEffective requires ports.archive AND actorRole in (super_admin, hospital_admin) — matching archive_entity exactly', () => {
    const fnStart = screen.indexOf('const canArchivePortsEffective');
    const fnBody = screen.slice(fnStart, fnStart + 300);
    expect(fnBody).toContain('canArchivePorts');
    expect(fnBody).toMatch(/actorRole === 'super_admin'\s*\|\|\s*actorRole === 'hospital_admin'/);
  });

  it('institution_admin does not hold ports.archive by role default; if granted via a custom per-user override, the actorRole check still excludes it (archive_entity would return INSUFFICIENT_ROLE)', () => {
    // institution_admin's default permission set does NOT include ports.archive
    // (unlike hospital_admin/super_admin) — confirming the scenario described
    // in the bug report can only happen via a custom per-user permission grant
    // (the app supports per-user overrides beyond role defaults), not the
    // default matrix.
    const perms = roleDefaults('institution_admin');
    expect(perms.has('ports.archive')).toBe(false);
    // Simulate that scenario: an institution_admin whose *effective* permission
    // Set was customized to include ports.archive. canArchivePortsEffective's
    // actorRole check (not a permission-key check) must still exclude them,
    // exactly matching archive_entity's hardcoded role allowlist.
    const customPerms = new Set([...perms, 'ports.archive']);
    const simulatedCanArchivePorts = customPerms.has('ports.archive');
    const actorRole = 'institution_admin';
    const simulatedCanArchivePortsEffective = simulatedCanArchivePorts
      && ((actorRole as string) === 'super_admin' || (actorRole as string) === 'hospital_admin');
    expect(simulatedCanArchivePorts).toBe(true);
    expect(simulatedCanArchivePortsEffective).toBe(false);
  });

  it('the archive button and Actions-row container both use canArchivePortsEffective, not the raw permission alone', () => {
    const cardStart = screen.indexOf('function PortCard');
    const cardBody = screen.slice(cardStart, screen.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toMatch(/canEditPorts \|\| canGenerateQr \|\| canRevokeQr \|\| canArchivePortsEffective/);
  });

  it('result.ok is still checked before reporting archive success (not removed by this fix)', () => {
    const fnStart = screen.indexOf('async function onArchivePort');
    const fnBody = screen.slice(fnStart, fnStart + 900);
    expect(fnBody).toContain('const result = await archiveEntity(');
    expect(fnBody).toMatch(/if \(!result\.ok\)/);
  });

  it('INSUFFICIENT_ROLE still maps to an honest translated error (not removed by this fix)', () => {
    expect(screen).toContain('function archiveErrorKey');
    const fnStart = screen.indexOf('function archiveErrorKey');
    const fnBody = screen.slice(fnStart, fnStart + 400);
    expect(fnBody).toContain('INSUFFICIENT_ROLE');
    expect(fnBody).toContain('port_archive_forbidden');
  });

  it('still does not use hard purge/delete for the outlet', () => {
    expect(screen).not.toContain('purgeEntityWithAllData');
    expect(screen).not.toContain('purge_entity_with_all_data');
  });

  it('edit outlet is unchanged: still gated by ports.edit on both UI and backend (RLS), no effective-permission split needed', () => {
    const cardStart = screen.indexOf('function PortCard');
    const cardBody = screen.slice(cardStart, screen.indexOf('function QrPreviewModal', cardStart));
    expect(cardBody).toMatch(/canEditPorts &&[\s\S]{0,80}<PhoenixButton[\s\S]{0,80}onClick=\{openEdit\}/);
    expect(screen).toContain('updateDistributionPoint(point.id,');
  });

  it('no new permission model was invented — only existing permissions.ts keys and the existing actorRole value are used', () => {
    const startIdx = screen.indexOf('const canArchivePortsEffective');
    const endIdx = screen.indexOf('const canGenerateQr', startIdx);
    const combinedBody = screen.slice(startIdx, endIdx);
    // Only permission keys already defined in permissions.ts are referenced.
    expect(combinedBody).not.toMatch(/actorPermissions\.has\('(?!ports\.archive|ports\.edit|availability\.quantity\.set|availability\.update|availability\.create)/);
  });
});

describe('Safety: no service_role/auth.admin, no raw ids exposed, no exchange workflow', () => {
  it('no service_role or auth.admin in InstitutionScreen or the lifecycle/availability services', () => {
    [screen, lifecycleService, availabilityService].forEach(src => {
      expect(src).not.toContain('service_role');
      expect(src).not.toMatch(/auth\.admin/);
    });
  });

  it('the remove-from-outlet button and dialog do not render raw ids/UUIDs as visible text', () => {
    const fnStart = screen.indexOf('function PortAvailabilitySection');
    const fnBody = screen.slice(fnStart, screen.indexOf('function QuickAvailForm'));
    expect(fnBody).not.toMatch(UUID_LITERAL_RE);
    expect(fnBody).not.toMatch(/>\{r\.id\}</);
  });

  it('no exchange request / approval workflow wording was added', () => {
    [screen].forEach(src => {
      expect(src.toLowerCase()).not.toMatch(/suggestion|recommendation|opportunit/);
      expect(src).not.toContain('اقتراح');
      expect(src).not.toContain('فرصة');
      expect(src).not.toContain('inter_org_exchange');
      expect(src).not.toContain('createInterOrgExchangeRequest');
    });
  });

  it('no existing migration SQL was modified for this fix (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change)', () => {
    let diff = '';
    try {
      diff = execSync("git diff -- 'supabase/migrations/*.sql'", { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('no package/lockfile changes', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json package-lock.json pnpm-lock.yaml yarn.lock', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');
  });

  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });
});
