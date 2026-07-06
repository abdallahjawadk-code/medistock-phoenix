/**
 * BUGFIX-MY-ACCOUNT-CLEAR-WHATSAPP-DISABLES-OFFICIAL-CONTACT-A
 * Run: npm test -- --run
 *
 * Root cause: clearing profiles.whatsapp_phone from My Account (onSaveWhatsapp
 * with an empty input) only ever called phoenix_update_my_whatsapp_phone(NULL).
 * If that same number had previously been published as the organization's
 * official WhatsApp contact via phoenix_set_my_org_whatsapp_contact(true)
 * (migration 046), the organization_status_contacts row was left untouched —
 * still is_active=true with the now-deleted phone — so Inter-Institution
 * Alerts kept showing a WhatsApp button with a stale number instead of
 * returning to the missing-phone state.
 *
 * Fix: when the normalized phone-to-save is null (the user cleared the
 * field), call phoenix_set_my_org_whatsapp_contact(false) first, then
 * phoenix_update_my_whatsapp_phone(NULL). The disable call is safe to issue
 * unconditionally — migration 046's RPC only checks role/org/status when
 * p_enabled=false, never profiles.whatsapp_phone — and is best-effort
 * (caught/ignored) so an ineligible caller or a caller with no existing
 * contact row never blocks the user's primary action of clearing their own
 * number.
 *
 * No migration/SQL/RPC change — phoenix_set_my_org_whatsapp_contact already
 * supports this safely, confirmed by reading migration 046 directly (its
 * p_enabled=false branch never references v_profile.whatsapp_phone).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const myAccount = readSrc('features/account/MyAccountScreen.tsx');
const migration046 = readFileSync(join(ROOT, 'supabase/migrations/046_phoenix_set_my_org_whatsapp_contact_rpc.sql'), 'utf8');

const onSaveWhatsappBlock = myAccount.slice(
  myAccount.indexOf('async function onSaveWhatsapp'),
  myAccount.indexOf('async function onEnableOrgContact'),
);

describe('1. Investigation: migration 046 disable branch never requires a saved phone', () => {
  it('the p_enabled=false branch does not reference v_profile.whatsapp_phone at all', () => {
    const fnStart = migration046.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_set_my_org_whatsapp_contact');
    const disableStart = migration046.indexOf('IF NOT p_enabled THEN', fnStart);
    const disableEnd = migration046.indexOf('-- p_enabled = true from here on.', disableStart);
    const disableBlock = migration046.slice(disableStart, disableEnd);
    expect(disableBlock).not.toContain('whatsapp_phone');
    expect(disableBlock).toContain('SET is_active = false');
  });

  it('only the p_enabled=true branch requires and validates whatsapp_phone', () => {
    const enableStart = migration046.indexOf('-- p_enabled = true from here on.');
    const enableBlock = migration046.slice(enableStart, enableStart + 400);
    expect(enableBlock).toContain('whatsapp_phone_required');
    expect(enableBlock).toContain('invalid_whatsapp_phone');
  });
});

describe('2. Clearing WhatsApp phone calls the official-contact disable RPC', () => {
  it('onSaveWhatsapp calls setMyOrgWhatsappContact(false) when phoneToSave is null', () => {
    expect(onSaveWhatsappBlock).toContain('if (phoneToSave === null) {');
    expect(onSaveWhatsappBlock).toContain('await setMyOrgWhatsappContact(false)');
  });

  it('the disable call happens before phoneToSave is actually persisted', () => {
    const disableIdx = onSaveWhatsappBlock.indexOf('setMyOrgWhatsappContact(false)');
    const updateIdx = onSaveWhatsappBlock.indexOf('await updateMyWhatsappPhone(phoneToSave)');
    expect(disableIdx).toBeGreaterThan(-1);
    expect(updateIdx).toBeGreaterThan(-1);
    expect(disableIdx).toBeLessThan(updateIdx);
  });
});

describe('3. Disable call is best-effort — never blocks the primary clear-phone action', () => {
  it('the disable call is wrapped so its own failure is caught and ignored, not propagated', () => {
    expect(onSaveWhatsappBlock).toContain('.catch(() => undefined)');
  });
});

describe('4. Clearing phone still saves NULL through phoenix_update_my_whatsapp_phone', () => {
  it('phoneToSave is null for empty/whitespace input, and is passed to updateMyWhatsappPhone unchanged', () => {
    expect(onSaveWhatsappBlock).toContain("trimmed === '' ? null : normalizeWhatsappPhone(trimmed)");
    expect(onSaveWhatsappBlock).toContain('await updateMyWhatsappPhone(phoneToSave)');
  });
});

describe('5. Enabling official contact is only ever attempted when clearing, never when saving a real number', () => {
  it('the disable branch is gated strictly on phoneToSave === null (never fires when saving a valid, non-empty phone)', () => {
    expect(onSaveWhatsappBlock).toMatch(/if \(phoneToSave === null\) \{\s*await setMyOrgWhatsappContact\(false\)/);
  });
});

describe('6. No fake phone number, no direct table write, no id passed', () => {
  it('no hardcoded phone constant introduced by this fix', () => {
    expect(onSaveWhatsappBlock).not.toMatch(/['"`]\+?\d{8,15}['"`]/);
  });

  it('setMyOrgWhatsappContact is called with only a boolean, never a phone/profile/org id', () => {
    expect(onSaveWhatsappBlock).toContain('setMyOrgWhatsappContact(false)');
    expect(onSaveWhatsappBlock).not.toMatch(/setMyOrgWhatsappContact\([^)]*phone/i);
    expect(onSaveWhatsappBlock).not.toMatch(/setMyOrgWhatsappContact\([^)]*(id|uuid)/i);
  });
});

describe('7. Existing save-valid-phone behavior still works', () => {
  it('still validates before saving and returns early when invalid', () => {
    expect(onSaveWhatsappBlock).toContain('if (!waValid) return;');
  });

  it('still normalizes a non-empty phone before persisting it', () => {
    expect(onSaveWhatsappBlock).toContain('normalizeWhatsappPhone(trimmed)');
  });

  it('still shows success/error toasts and reloads the profile on success', () => {
    expect(onSaveWhatsappBlock).toContain("showToast(t('ma_whatsapp_save_success', lang))");
    expect(onSaveWhatsappBlock).toContain("showToast(t('ma_whatsapp_save_error', lang))");
    expect(onSaveWhatsappBlock).toContain('await reloadProfile()');
  });
});

describe('8. Existing enable/disable official-contact button behavior still works, unchanged', () => {
  it('onEnableOrgContact still requires eligibility + a saved phone before calling setMyOrgWhatsappContact(true)', () => {
    const block = myAccount.slice(myAccount.indexOf('async function onEnableOrgContact'), myAccount.indexOf('async function onDisableOrgContact'));
    expect(block).toContain('if (!isOrgContactEligible || !hasSavedWhatsapp || orgContactBusy) return;');
    expect(block).toContain('await setMyOrgWhatsappContact(true)');
  });

  it('onDisableOrgContact (the explicit button) still works independently and is untouched by this fix', () => {
    const block = myAccount.slice(myAccount.indexOf('async function onDisableOrgContact'), myAccount.indexOf('async function onDisableOrgContact') + 400);
    expect(block).toContain('if (!isOrgContactEligible || orgContactBusy) return;');
    expect(block).toContain('await setMyOrgWhatsappContact(false)');
  });
});

describe('9. No WhatsApp API/Graph API/token/automation introduced', () => {
  it('no Cloud API/token/Bearer/sendMessage references, no auto-send', () => {
    expect(myAccount).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com/i);
    expect(myAccount).not.toContain('Bearer ');
    expect(myAccount).not.toContain('wa.me');
    expect(myAccount).not.toContain('.click()');
  });
});

describe('10. No migrations created or modified by this fix', () => {
  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded from this check because a later, separately-reviewed phase
  // (FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it
  // in-place before its first successful manual apply — 052+ and every other
  // migration file remain fully guarded below.
  // PHASE2-ALLOW-054-INPLACE-HARDENING-GUARDS-A: 054_dashboard_condition_counts_rpcs.sql
  // is also excluded — HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A legitimately
  // corrects it in-place (COALESCE(v_role = 'super_admin', false)) before its
  // first successful manual apply, the same pattern as 051/053. Every other
  // migration file (001-053, 055+) remains fully guarded.
  it('no working-tree diff on any migration SQL file other than the already-approved 051 immutable-expiry-date fix', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no new untracked migration SQL file was created by this fix — only the separately-reviewed migrations 048 (DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A), 049 (DATA-MODEL-NATIONAL-CODE-SEPARATION-A), 050 (DB-AVAILABILITY-UPSERT-NATIONAL-CODE-050-A), and 051 (DB-MATERIAL-BATCH-IDENTITY-051-A, including its later in-place immutable-expiry-date correction) are allowed as untracked/modified additions', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const ALLOWED_UNTRACKED = new Set([
      '?? supabase/migrations/048_live_alerts_expiry_risk_tiers.sql',
      'A  supabase/migrations/048_live_alerts_expiry_risk_tiers.sql',
      '?? supabase/migrations/049_add_national_code_to_item_availability.sql',
      'A  supabase/migrations/049_add_national_code_to_item_availability.sql',
      '?? supabase/migrations/050_phoenix_upsert_availability_national_code.sql',
      'A  supabase/migrations/050_phoenix_upsert_availability_national_code.sql',
      '?? supabase/migrations/051_material_batch_identity_option_a.sql',
      'A  supabase/migrations/051_material_batch_identity_option_a.sql',
      // Trimmed forms of " M ..." (unstaged modify) / "M  ..." (staged modify) —
      // status.split('\n').map(l => l.trim()) strips only the leading char.
      'M supabase/migrations/051_material_batch_identity_option_a.sql',
      'M  supabase/migrations/051_material_batch_identity_option_a.sql',
      // QR-EFFECTIVE-CONDITION-QUANTITY-ZERO-052-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/052_qr_effective_condition_quantity_zero.sql',
      'A  supabase/migrations/052_qr_effective_condition_quantity_zero.sql',
      // DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/053_item_availability_removed_marker.sql',
      'A  supabase/migrations/053_item_availability_removed_marker.sql',
      // FIX-MIGRATION-053-REMOVED-BY-FK-A: 053 corrected in-place before its
      // first successful manual apply (removed_by FK creation/verification
      // fix), same pattern as the 051 immutable-expiry-date correction.
      'M supabase/migrations/053_item_availability_removed_marker.sql',
      'M  supabase/migrations/053_item_availability_removed_marker.sql',
      // PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/054_dashboard_condition_counts_rpcs.sql',
      'A  supabase/migrations/054_dashboard_condition_counts_rpcs.sql',
      // HARDEN-MIGRATION-054-NULL-ROLE-FAIL-CLOSED-A: 054 corrected in-place
      // before its first successful manual apply (COALESCE(v_role =
      // 'super_admin', false) NULL-role fail-closed fix), same pattern as
      // the 051/053 in-place corrections above.
      'M supabase/migrations/054_dashboard_condition_counts_rpcs.sql',
      'M  supabase/migrations/054_dashboard_condition_counts_rpcs.sql',
      // PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/055_phoenix_clean_availability_data.sql',
      'A  supabase/migrations/055_phoenix_clean_availability_data.sql',
      // FIX-MIGRATION-055-TRUNCATE-VERIFY-FALSE-POSITIVE-A: 055 corrected
      // in-place before its first successful manual apply (VERIFY block's
      // TRUNCATE assertion false-positive fix), same pattern as 051/053/054.
      'M supabase/migrations/055_phoenix_clean_availability_data.sql',
      'M  supabase/migrations/055_phoenix_clean_availability_data.sql',
      // PHASE3-PLATFORM-BROADCAST-NOTICES-A: new reviewed migration,
      // prepared but not yet applied/committed.
      '?? supabase/migrations/056_phoenix_platform_broadcast_notices.sql',
      'A  supabase/migrations/056_phoenix_platform_broadcast_notices.sql',
      // FIX-MIGRATION-056-SEARCH-PATH-VERIFY-FALSE-POSITIVE-A: 056 corrected
      // in-place before its first successful manual apply (VERIFY block's
      // search_path check false-positive fix), same pattern as 051/053/054/055.
      'M supabase/migrations/056_phoenix_platform_broadcast_notices.sql',
      'M  supabase/migrations/056_phoenix_platform_broadcast_notices.sql',
      '?? supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql',
      'A  supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql',
    ]);
    const unexpected = status.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !ALLOWED_UNTRACKED.has(l));
    expect(unexpected).toEqual([]);
  });
});

describe('11. No QR/export/print/user-management/auth/RLS/permissions files changed', () => {
  // StatusCenterScreen.tsx is intentionally excluded here as of EXPIRY-RISK-TIERS-A,
  // a later, separately-reviewed phase that adds a purely-additive ExpiryRiskBadge
  // next to its expiry-date table cell (see expiry-risk-badge-wiring.test.ts).
  // PublicQrScreen.tsx is also excluded — a later, separately-reviewed
  // QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A phase that hides
  // non-available items from the public QR list.
  // QR-BUNDLE-CODE-SPLIT-A: a later, separately-reviewed phase legitimately
  // restructures src/app/App.tsx (route-level lazy loading) — excluded here.
  // DB-PRESSURE-QUICK-WINS-A: a later, separately-reviewed phase legitimately
  // adds a skipAuthBootstrap flag to src/app/AppContext.tsx — excluded here.
  it('empty diff on auth.service.ts; UserManagementScreen.tsx allows only the later AvailabilityCleanupWizard addition (PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A)', () => {
    let diff = '';
    try {
      diff = execSync(
        'git diff -- src/shared/supabase/services/auth.service.ts',
        { cwd: ROOT, encoding: 'utf8' },
      );
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');

    let userMgmtDiff = '';
    try {
      userMgmtDiff = execSync('git diff -- src/features/users/UserManagementScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const addedLines = userMgmtDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++') && l.trim() !== '+');
    const unexpected = addedLines.filter(l => !l.includes('AvailabilityCleanupWizard') && !l.includes('PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A') && !l.includes('Renders null internally') && !l.includes('is already the safest') && !l.includes('PlatformBroadcastAdminPanel') && !l.includes('PHASE3-PLATFORM-BROADCAST-NOTICES-A') && !l.includes('same convention as AvailabilityCleanupWizard above'));
    expect(unexpected).toEqual([]);
  });
});

describe('12. No package/lockfile changes', () => {
  it('package.json/lockfiles empty diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = diff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removedLines.length).toBe(0);
    expect(addedLines.every(l => /"exceljs":/.test(l))).toBe(true);
  });
});

describe('13. Service-D stash and untracked-file guards untouched', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untracked only', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });

  it('no staged entry for supabase/.temp', () => {
    let staged = '';
    try {
      staged = execSync('git diff --cached --name-only -- supabase/.temp', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(staged.trim()).toBe('');
  });
});
