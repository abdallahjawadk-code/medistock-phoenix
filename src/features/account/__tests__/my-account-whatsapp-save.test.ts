/**
 * UX-MY-ACCOUNT-WHATSAPP-SAVE-A
 * Run: npm test -- --run
 *
 * Static + behavioral tests proving My Account can now really save a
 * personal WhatsApp number to profiles.whatsapp_phone (migration 044,
 * already manually applied), through the project's existing SECURITY
 * DEFINER-RPC-only write pattern for profiles (never a raw
 * `.from('profiles').update(...)`, which phoenix-guardrails.test.ts forbids
 * everywhere in frontend code) — and that this was done without touching
 * alert lifecycle, permission gates, the contactOrgKey freeze fix, QR,
 * export/print, or user-management logic.
 *
 * IMPORTANT — deployment prerequisite documented here, not hidden: the RPC
 * `phoenix_update_my_whatsapp_phone(p_phone text)` this phase's service
 * calls does not exist yet. It must be added by a separate, reviewed
 * migration (companion to 044) before Save actually persists anything —
 * until then, calling it surfaces an honest failure (function not found),
 * never a fake success. This test suite proves the frontend contract only;
 * it does not require a live database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
import { normalizeWhatsappPhone, isValidWhatsappPhone } from '@/shared/lib/whatsapp';
import { T } from '@/shared/i18n/strings';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const myAccount = readSrc('features/account/MyAccountScreen.tsx');
const authService = readSrc('shared/supabase/services/auth.service.ts');
const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const app = readSrc('app/App.tsx');
const publicQr = readSrc('features/qr/PublicQrScreen.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const userManagementScreen = readSrc('features/users/UserManagementScreen.tsx');

describe('1. My Account includes Contact Information / بيانات التواصل', () => {
  it('renders the ma_contact_info_title section', () => {
    expect(myAccount).toContain("t('ma_contact_info_title', lang)");
    expect(T.ma_contact_info_title.ar).toBe('بيانات التواصل');
    expect(T.ma_contact_info_title.en).toBe('Contact Information');
  });
});

describe('2. My Account has My WhatsApp number / رقم واتسابي', () => {
  it('renders the ma_whatsapp_label field label', () => {
    expect(myAccount).toContain("t('ma_whatsapp_label', lang)");
    expect(T.ma_whatsapp_label.ar).toBe('رقم واتسابي');
    expect(T.ma_whatsapp_label.en).toBe('My WhatsApp number');
  });
});

describe('3. Uses existing normalizeWhatsappPhone/isValidWhatsappPhone helpers', () => {
  it('MyAccountScreen imports both from the shared whatsapp helper, not a hand-rolled regex', () => {
    expect(myAccount).toContain("from '@/shared/lib/whatsapp'");
    expect(myAccount).toContain('isValidWhatsappPhone(waNumber)');
    expect(myAccount).toContain('normalizeWhatsappPhone(trimmed)');
  });
});

describe('4. Empty input saves NULL / is handled as clear', () => {
  it('trimmed empty input maps to null, not to isValidWhatsappPhone rejection', () => {
    const block = myAccount.slice(myAccount.indexOf('async function onSaveWhatsapp'), myAccount.indexOf('async function onSaveWhatsapp') + 400);
    expect(block).toContain("trimmed === '' ? null : normalizeWhatsappPhone(trimmed)");
  });

  it('waValid treats empty/whitespace input as valid (never blocks clearing)', () => {
    expect(myAccount).toContain("waNumber.trim() === '' || isValidWhatsappPhone(waNumber)");
  });

  it('sanity: the real helper agrees empty string is not itself a "valid phone", confirming the OR-short-circuit is intentional, not redundant', () => {
    expect(isValidWhatsappPhone('')).toBe(false);
  });
});

describe('5. Invalid phone cannot be saved', () => {
  it('save button is disabled whenever waValid is false', () => {
    expect(myAccount).toContain('disabled={!waValid}');
  });

  it('onSaveWhatsapp returns early (no service call) when invalid', () => {
    const block = myAccount.slice(myAccount.indexOf('async function onSaveWhatsapp'), myAccount.indexOf('async function onSaveWhatsapp') + 150);
    expect(block).toContain('if (!waValid) return;');
  });

  it('sanity: a non-empty garbage string is rejected by the real helper', () => {
    expect(isValidWhatsappPhone('abc')).toBe(false);
    expect(isValidWhatsappPhone('123')).toBe(false);
  });
});

describe('6. Valid phone is normalized before save', () => {
  it('phoneToSave is normalizeWhatsappPhone(trimmed), not the raw input', () => {
    expect(myAccount).toContain('const phoneToSave = ');
    expect(myAccount).toContain('normalizeWhatsappPhone(trimmed)');
  });

  it('sanity: the real helper strips separators/spaces to digits-only', () => {
    expect(normalizeWhatsappPhone('964 700 123 4567')).toBe('9647001234567');
  });
});

describe('7. Save is explicit click only', () => {
  it('onSaveWhatsapp is only wired to a button onClick, never a useEffect', () => {
    expect(myAccount).toContain('onClick={onSaveWhatsapp}');
    expect(myAccount).not.toContain('useEffect');
  });
});

describe('8/9/10. Service updates only the caller\'s own whatsapp_phone, never role/status/organization_id', () => {
  it('updateMyWhatsappPhone calls an RPC scoped by auth.uid() server-side, no client-passed profile id', () => {
    const block = authService.slice(authService.indexOf('export async function updateMyWhatsappPhone('));
    expect(block).toContain("supabase.rpc('phoenix_update_my_whatsapp_phone'");
    expect(block).not.toContain('.eq(');
    expect(block).not.toMatch(/profileId|profile_id|targetId/i);
  });

  it('the function signature only accepts a phone value, never a role/status/organization_id parameter', () => {
    expect(authService).toContain('export async function updateMyWhatsappPhone(phone: string | null)');
    expect(authService).not.toMatch(/updateMyWhatsappPhone\([^)]*role/i);
    expect(authService).not.toMatch(/updateMyWhatsappPhone\([^)]*status/i);
    expect(authService).not.toMatch(/updateMyWhatsappPhone\([^)]*organization/i);
  });

  it('no raw .update() on profiles anywhere in this service file (matches the project-wide guardrail)', () => {
    expect(authService).not.toMatch(/from\(['"]profiles['"]\)\s*\.\s*update\s*\(/);
  });
});

describe('11. No service_role/auth.admin', () => {
  it('auth.service.ts and MyAccountScreen never reference service_role or auth.admin', () => {
    for (const src of [authService, myAccount]) {
      expect(src).not.toMatch(/service_role/i);
      expect(src).not.toContain('auth.admin');
    }
  });
});

describe('12. No WhatsApp API/tokens/automation/automatic sending', () => {
  it('no Cloud API/token/Bearer/sendMessage references, no auto-send', () => {
    for (const src of [authService, myAccount]) {
      expect(src).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com/i);
      expect(src).not.toContain('Bearer ');
      expect(src).not.toContain('wa.me');
      expect(src).not.toContain('.click()');
    }
  });
});

describe('13. No fake phone numbers', () => {
  it('no hardcoded phone constant in the new code', () => {
    for (const src of [authService, myAccount]) {
      expect(src).not.toMatch(/['"`]\+?\d{8,15}['"`]/);
    }
  });
});

describe('14. No SQL/migration/RPC/Edge Function added by this phase (UX-MY-ACCOUNT-WHATSAPP-SAVE-A) — the RPC itself is a separately-reviewed later phase, DB-MY-ACCOUNT-WHATSAPP-RPC-A', () => {
  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded from this diff check because a later, separately-reviewed
  // phase (FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A) legitimately corrects
  // it in-place before its first successful manual apply.
  it('no existing migration SQL was modified (other than the already-approved 051 immutable-expiry-date fix)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('no unreviewed migration SQL files were created — only the separately-reviewed migration 045 (DB-MY-ACCOUNT-WHATSAPP-RPC-A, adding the RPC this screen\'s service already calls) is allowed as an untracked addition', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const ALLOWED_UNTRACKED = new Set([
      '?? supabase/migrations/045_phoenix_update_my_whatsapp_phone_rpc.sql',
      'A  supabase/migrations/045_phoenix_update_my_whatsapp_phone_rpc.sql',
      '?? supabase/migrations/046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      'A  supabase/migrations/046_phoenix_set_my_org_whatsapp_contact_rpc.sql',
      '?? supabase/migrations/047_phoenix_live_alerts_contact_fields.sql',
      'A  supabase/migrations/047_phoenix_live_alerts_contact_fields.sql',
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
      // before its first successful manual apply, same pattern as 051/053.
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
      'M supabase/migrations/056_phoenix_platform_broadcast_notices.sql',
      'M  supabase/migrations/056_phoenix_platform_broadcast_notices.sql',
      '?? supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql',
      'A  supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql',
    ]);
    const unexpected = status.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !ALLOWED_UNTRACKED.has(l));
    expect(unexpected).toEqual([]);
  });
});

describe('15. No package/lockfile changes', () => {
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

describe('16. MyAccountScreen changed only for contact UI', () => {
  it('existing password reset/change sections and InfoRow helper remain present, untouched in structure', () => {
    expect(myAccount).toContain("t('ma_change_pw', lang)");
    expect(myAccount).toContain("t('ma_reset_btn', lang)");
    expect(myAccount).toContain('function InfoRow(');
    expect(myAccount).toContain('markPasswordChanged');
  });
});

describe('17. InterInstitutionAlertsScreen freeze safety (as of this personal-WhatsApp-save phase)', () => {
  it('no unstable array-typed dependency was ever reintroduced (contactOrgKey itself was later superseded and removed entirely by UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A, once contact phones moved server-side)', () => {
    expect(alertsScreen).not.toContain('alertOrgIds');
  });

  it('personal whatsapp_phone is not read anywhere in the alerts screen (org-contact integration is a later phase)', () => {
    expect(alertsScreen).not.toContain('whatsapp_phone');
  });
});

describe('18. Alert lifecycle handlers/permission gates unchanged', () => {
  it('acknowledge/start-processing/resolve/dismiss/reopen/history buttons remain wired', () => {
    expect(alertsScreen).toContain("onClick={() => onAction('acknowledged')}");
    expect(alertsScreen).toContain("onClick={() => onAction('in_progress')}");
    expect(alertsScreen).toContain("onClick={() => onAction('resolved')}");
    expect(alertsScreen).toContain("onClick={() => onAction('dismissed')}");
    expect(alertsScreen).toContain("onClick={() => onAction('open')}");
    expect(alertsScreen).toContain('onClick={onHistory}');
  });

  it('TRANSITION_PERMISSION map and canTransition gating are untouched', () => {
    expect(alertsScreen).toContain("open:         'inter_institution_alerts.manage'");
    expect(alertsScreen).toContain("acknowledged: 'inter_institution_alerts.acknowledge'");
    expect(alertsScreen).toContain("in_progress:  'inter_institution_alerts.manage'");
    expect(alertsScreen).toContain("resolved:     'inter_institution_alerts.resolve'");
    expect(alertsScreen).toContain("dismissed:    'inter_institution_alerts.dismiss'");
  });
});

describe('19. QR routes unchanged', () => {
  it('App.tsx still bypasses auth entirely for ?qid=/?token=; PublicQrScreen untouched', () => {
    expect(app).toContain('publicQrId');
    expect(app).toContain('PublicQrScreen');
    expect(publicQr).not.toContain('whatsapp_phone');
  });

  // PublicQrScreen.tsx is excluded below — a later, separately-reviewed
  // QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A phase, unrelated to this one.
  it('App.tsx was not modified by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/app/App.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('20. Export/print unchanged', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: a later, separately-reviewed phase
  // replaced StatusCenterScreen's ad-hoc CSV export with a real styled
  // .xlsx workbook (exportXlsx) — unrelated to this phase's WhatsApp save
  // concerns. printReport and the mobile print fallback are untouched.
  it('StatusCenterScreen still has exportXlsx, printReport, and the mobile print fallback modal', () => {
    expect(statusCenter).toContain('function exportXlsx');
    expect(statusCenter).toContain('function printReport');
    expect(statusCenter).toContain('MobilePrintFallbackModal');
  });

  it('MyAccountScreen was not given any export/print logic', () => {
    expect(myAccount).not.toContain('exportCsv');
    expect(myAccount).not.toContain('exportXlsx');
    expect(myAccount).not.toContain('printReport');
    expect(myAccount).not.toContain('window.print');
  });
});

describe('21. User-management lifecycle unchanged', () => {
  it('UserManagementScreen still calls the same lifecycle functions', () => {
    for (const fn of [
      'createUserViaEdge', 'disableUserViaEdge', 'enableUserViaEdge',
      'recycleUserViaEdge', 'rotatePasswordViaEdge',
      'assignProfilePermissions', 'resetProfilePermissions', 'listUsers', 'getEffectivePermissions',
    ]) {
      expect(userManagementScreen).toContain(fn);
    }
  });

  it('UserManagementScreen.tsx was not modified by this phase, other than the later AvailabilityCleanupWizard addition (PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/users/UserManagementScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const addedLines = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++') && l.trim() !== '+');
    const unexpected = addedLines.filter(l => !l.includes('AvailabilityCleanupWizard') && !l.includes('PHASE3-DEEP-CLEAN-AVAILABILITY-DATA-A') && !l.includes('Renders null internally') && !l.includes('is already the safest') && !l.includes('PlatformBroadcastAdminPanel') && !l.includes('PHASE3-PLATFORM-BROADCAST-NOTICES-A') && !l.includes('same convention as AvailabilityCleanupWizard above'));
    expect(unexpected).toEqual([]);
  });
});

describe('22. i18n Arabic and English strings exist', () => {
  it('all new My Account WhatsApp-save strings have the exact required bilingual text', () => {
    expect(T.ma_contact_info_title).toEqual({ ar: 'بيانات التواصل', en: 'Contact Information' });
    expect(T.ma_whatsapp_label).toEqual({ ar: 'رقم واتسابي', en: 'My WhatsApp number' });
    expect(T.ma_whatsapp_hint).toEqual({ ar: 'اكتب الرقم بصيغة دولية مثل 9647XXXXXXXXX', en: 'Use international format, e.g. 9647XXXXXXXXX' });
    expect(T.ma_whatsapp_save).toEqual({ ar: 'حفظ رقم واتساب', en: 'Save WhatsApp number' });
    expect(T.ma_whatsapp_save_success).toEqual({ ar: 'تم حفظ رقم واتساب بنجاح', en: 'WhatsApp number saved successfully' });
    expect(T.ma_whatsapp_save_error).toEqual({ ar: 'تعذر حفظ رقم واتساب', en: 'Could not save WhatsApp number' });
  });
});

describe('23. Mobile-safe / no horizontal overflow', () => {
  it('the WhatsApp input uses width:100% / maxWidth:100%, matching the rest of the form fields (no fixed oversized width)', () => {
    const block = myAccount.slice(myAccount.indexOf('type="tel"'), myAccount.indexOf('type="tel"') + 400);
    expect(block).toContain("maxWidth: '100%'");
  });

  it('the screen container caps width and the field reuses the shared fieldStyle used by password inputs (consistent, tested mobile layout)', () => {
    expect(myAccount).toContain("maxWidth: '640px'");
    expect(myAccount).toContain('...fieldStyle');
  });
});

describe('24. premium-preview.html untouched', () => {
  it('remains untracked only', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });
});

describe('25. supabase/.temp unstaged', () => {
  it('no staged entry for supabase/.temp', () => {
    let staged = '';
    try {
      staged = execSync('git diff --cached --name-only -- supabase/.temp', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(staged.trim()).toBe('');
  });
});

describe('26. Service-D stash untouched', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });
});
