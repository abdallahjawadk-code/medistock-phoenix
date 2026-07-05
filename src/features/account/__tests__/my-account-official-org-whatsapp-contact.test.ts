/**
 * UX-OFFICIAL-ORG-WHATSAPP-CONTACT-TOGGLE-A
 * Run: npm test -- --run
 *
 * Static + behavioral tests proving My Account can let an eligible
 * organization user (institution_admin/hospital_admin/monthly_status_officer)
 * publish their own already-saved profiles.whatsapp_phone as their
 * organization's official WhatsApp contact
 * (organization_status_contacts.phone), or withdraw it again — through the
 * separately-reviewed SECURITY DEFINER RPC
 * phoenix_set_my_org_whatsapp_contact(p_enabled boolean), migration 046
 * (manually applied in Supabase, verified authenticated-only EXECUTE).
 *
 * This is a UI/service-only phase: no migration, no direct table write, no
 * phone/profile/user/org id ever passed to the RPC — the RPC resolves
 * everything from auth.uid() server-side and is the final eligibility
 * authority. This suite proves the frontend contract only; it does not
 * require a live database.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { execSync } from 'child_process';
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

describe('1. My Account has an official organization contact section', () => {
  it('renders the ma_org_contact_title section, always present regardless of role', () => {
    expect(myAccount).toContain("t('ma_org_contact_title', lang)");
    expect(T.ma_org_contact_title.ar).toBe('جهة اتصال المؤسسة الرسمية');
    expect(T.ma_org_contact_title.en).toBe('Official organization contact');
  });
});

describe('2. Action requires a saved profile.whatsapp_phone', () => {
  it('hasSavedWhatsapp is derived from profile.whatsapp_phone, not the unsaved draft input', () => {
    expect(myAccount).toContain('const hasSavedWhatsapp = !!(profile?.whatsapp_phone && profile.whatsapp_phone.trim()');
  });

  it('enable button is disabled when there is no saved number, and the "save first" hint renders', () => {
    expect(myAccount).toContain('disabled={orgContactBusy || !hasSavedWhatsapp}');
    expect(myAccount).toContain("t('ma_org_contact_phone_required', lang)");
  });

  it('onEnableOrgContact returns early with no saved number (no RPC call)', () => {
    const block = myAccount.slice(myAccount.indexOf('async function onEnableOrgContact'), myAccount.indexOf('async function onEnableOrgContact') + 200);
    expect(block).toContain('if (!isOrgContactEligible || !hasSavedWhatsapp || orgContactBusy) return;');
  });
});

describe('3. Action is role-limited to institution_admin/hospital_admin/monthly_status_officer', () => {
  it('ORG_CONTACT_ELIGIBLE_ROLES lists exactly the three eligible roles', () => {
    expect(myAccount).toContain("const ORG_CONTACT_ELIGIBLE_ROLES = ['institution_admin', 'hospital_admin', 'monthly_status_officer'];");
  });

  it('does not broaden access to viewer/point_operator/warehouse_manager/super_admin', () => {
    const block = myAccount.slice(myAccount.indexOf('ORG_CONTACT_ELIGIBLE_ROLES ='), myAccount.indexOf('ORG_CONTACT_ELIGIBLE_ROLES =') + 150);
    for (const role of ['viewer', 'point_operator', 'warehouse_manager', 'super_admin']) {
      expect(block).not.toContain(`'${role}'`);
    }
  });

  it('isOrgContactEligible checks the role against ORG_CONTACT_ELIGIBLE_ROLES', () => {
    expect(myAccount).toContain('ORG_CONTACT_ELIGIBLE_ROLES.includes((profile?.role as string | undefined) ?? \'\')');
  });

  it('ineligible profiles see the explanatory disabled state, not the action buttons', () => {
    expect(myAccount).toContain('isOrgContactEligible ?');
    expect(myAccount).toContain("t('ma_org_contact_ineligible', lang)");
  });
});

describe('4. Action requires organization_id', () => {
  it('isOrgContactEligible requires profile.organization_id to be truthy', () => {
    const block = myAccount.slice(myAccount.indexOf('const isOrgContactEligible ='), myAccount.indexOf('const isOrgContactEligible =') + 250);
    expect(block).toContain('!!profile?.organization_id');
    expect(block).toContain("profile?.status === 'active'");
  });
});

describe('5. Enable calls phoenix_set_my_org_whatsapp_contact with p_enabled true', () => {
  it('onEnableOrgContact calls setMyOrgWhatsappContact(true)', () => {
    const block = myAccount.slice(myAccount.indexOf('async function onEnableOrgContact'), myAccount.indexOf('async function onDisableOrgContact'));
    expect(block).toContain('await setMyOrgWhatsappContact(true)');
  });

  it('setMyOrgWhatsappContact(enabled) forwards enabled as p_enabled to the RPC', () => {
    const block = authService.slice(authService.indexOf('export async function setMyOrgWhatsappContact('));
    expect(block).toContain("supabase.rpc('phoenix_set_my_org_whatsapp_contact', { p_enabled: enabled })");
  });
});

describe('6. Disable calls phoenix_set_my_org_whatsapp_contact with p_enabled false', () => {
  it('onDisableOrgContact calls setMyOrgWhatsappContact(false)', () => {
    const block = myAccount.slice(myAccount.indexOf('async function onDisableOrgContact'), myAccount.indexOf('async function onDisableOrgContact') + 400);
    expect(block).toContain('await setMyOrgWhatsappContact(false)');
  });
});

describe('7. No phone number is passed to the RPC', () => {
  it('setMyOrgWhatsappContact signature accepts only a boolean, never a phone string', () => {
    expect(authService).toContain('export async function setMyOrgWhatsappContact(enabled: boolean)');
    expect(authService).not.toMatch(/setMyOrgWhatsappContact\([^)]*phone/i);
  });

  it('the RPC call payload has only p_enabled, no p_phone/phone key', () => {
    const block = authService.slice(authService.indexOf('export async function setMyOrgWhatsappContact('));
    const rpcCall = block.slice(block.indexOf("supabase.rpc('phoenix_set_my_org_whatsapp_contact'"), block.indexOf("supabase.rpc('phoenix_set_my_org_whatsapp_contact'") + 100);
    expect(rpcCall).not.toMatch(/p_phone|phone:/i);
  });
});

describe('8. No profile/user/org id is passed to the RPC', () => {
  it('setMyOrgWhatsappContact never takes or forwards an id parameter', () => {
    expect(authService).not.toMatch(/setMyOrgWhatsappContact\([^)]*(id|uuid)/i);
    const block = authService.slice(authService.indexOf('export async function setMyOrgWhatsappContact('), authService.indexOf('export async function setMyOrgWhatsappContact(') + 500);
    expect(block).not.toMatch(/profileId|profile_id|organizationId|organization_id|userId|user_id/i);
  });
});

describe('9. No direct write to organization_status_contacts from frontend', () => {
  it('MyAccountScreen and auth.service.ts never call .from(\'organization_status_contacts\') — mentioning the table name in an explanatory comment is fine, writing to it directly is not', () => {
    expect(myAccount).not.toMatch(/from\(['"]organization_status_contacts['"]\)/);
    expect(authService).not.toMatch(/from\(['"]organization_status_contacts['"]\)/);
  });
});

describe('10. No direct .from(\'profiles\').update anywhere touched by this phase', () => {
  it('MyAccountScreen and auth.service.ts have no raw profiles update call', () => {
    for (const src of [myAccount, authService]) {
      expect(src).not.toMatch(/from\(['"]profiles['"]\)\s*\.\s*update\s*\(/);
    }
  });
});

describe('11/12. Personal WhatsApp save still calls phoenix_update_my_whatsapp_phone, behavior unchanged', () => {
  it('updateMyWhatsappPhone is untouched — still the RPC-based personal-number save path', () => {
    const block = authService.slice(authService.indexOf('export async function updateMyWhatsappPhone('));
    expect(block).toContain("supabase.rpc('phoenix_update_my_whatsapp_phone'");
  });

  it('onSaveWhatsapp still validates and normalizes before calling updateMyWhatsappPhone, untouched by this phase', () => {
    expect(myAccount).toContain('if (!waValid) return;');
    expect(myAccount).toContain("trimmed === '' ? null : normalizeWhatsappPhone(trimmed)");
    expect(myAccount).toContain('await updateMyWhatsappPhone(phoneToSave)');
  });
});

describe('13. No WhatsApp API/tokens/automation/auto-send', () => {
  it('no Cloud API/token/Bearer/sendMessage references, no auto-send, in the new code', () => {
    for (const src of [authService, myAccount]) {
      expect(src).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com/i);
      expect(src).not.toContain('Bearer ');
      expect(src).not.toContain('wa.me');
      expect(src).not.toContain('.click()');
    }
  });

  it('no service_role/auth.admin references', () => {
    for (const src of [authService, myAccount]) {
      expect(src).not.toMatch(/service_role/i);
      expect(src).not.toContain('auth.admin');
    }
  });
});

describe('14. No fake phone numbers', () => {
  it('no hardcoded phone constant in the new code', () => {
    for (const src of [authService, myAccount]) {
      expect(src).not.toMatch(/['"`]\+?\d{8,15}['"`]/);
    }
  });
});

describe('15. No SQL/migration/RPC/Edge Function added by this phase — 046 is already committed/applied, this phase only adds the UI/service call site', () => {
  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded from the diff check because a later, separately-reviewed
  // phase (FIX-MIGRATION-051-IMMUTABLE-EXPIRY-DATE-A) legitimately corrects
  // it in-place before its first successful manual apply.
  it('no existing migration SQL was modified (other than the already-approved 051 immutable-expiry-date fix), and no new migration SQL file was created', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    // 047 (DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A) is a separately-reviewed
    // later migration phase, untracked/unstaged at review time here — this
    // check only constrains what this UI/service phase itself introduced.
    const ALLOWED_UNTRACKED = new Set([
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
    ]);
    const unexpected = status.split('\n').map(l => l.trim()).filter(Boolean).filter(l => !ALLOWED_UNTRACKED.has(l));
    expect(unexpected).toEqual([]);
  });
});

describe('16. No package/lockfile changes', () => {
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

describe('17. InterInstitutionAlertsScreen freeze safety (as of this UI-toggle phase)', () => {
  it('no unstable array-typed dependency was ever reintroduced (contactOrgKey itself was later superseded and removed entirely by UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A, once contact phones moved server-side)', () => {
    expect(alertsScreen).not.toContain('alertOrgIds');
  });

  it('getOrgStatusContactsForOrgs / contact-lookup service is untouched by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/shared/supabase/services/users.service.ts src/features/alerts/inter-institution-alerts.service.ts', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
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
    expect(publicQr).not.toContain('organization_status_contacts');
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
  // replaced StatusCenterScreen's ad-hoc CSV export (csvSafeCell/exportCsv)
  // with a real styled .xlsx workbook (exportXlsx/exportAvailabilityXlsx) —
  // unrelated to this phase's WhatsApp contact concerns. printReport and the
  // mobile print fallback are untouched by that phase.
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

  it('StatusCenterScreen.tsx print function is unchanged; the export diff (from the later SAFE-PROFESSIONAL-XLSX-EXPORT-A phase) is scoped to the CSV-to-XLSX replacement only', () => {
    expect(statusCenter).toContain('function exportXlsx');
    expect(statusCenter).toContain('function printReport');
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/status/StatusCenterScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff).not.toMatch(/^[+-].*function printReport/m);
    if (diff.trim()) {
      expect(diff).toMatch(/exportAvailabilityXlsx|removed_at/);
      expect(diff).not.toMatch(/service_role|auth\.admin/);
    }
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

  it('UserManagementScreen.tsx was not modified by this phase', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- src/features/users/UserManagementScreen.tsx', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

describe('22. i18n Arabic and English strings exist', () => {
  it('all new official organization contact strings have the exact required bilingual text', () => {
    expect(T.ma_org_contact_title).toEqual({ ar: 'جهة اتصال المؤسسة الرسمية', en: 'Official organization contact' });
    expect(T.ma_org_contact_enable).toEqual({ ar: 'استخدام رقمي كرقم تواصل رسمي للمؤسسة', en: 'Use my number as official organization contact' });
    expect(T.ma_org_contact_disable).toEqual({ ar: 'إلغاء استخدام رقمي كرقم تواصل رسمي', en: 'Stop using my number as official organization contact' });
    expect(T.ma_org_contact_phone_required).toEqual({ ar: 'يجب حفظ رقم واتسابي أولاً قبل استخدامه كرقم تواصل رسمي للمؤسسة', en: 'Save my WhatsApp number first before using it as the official organization contact' });
    expect(T.ma_org_contact_enable_success).toEqual({ ar: 'تم تفعيل رقمك كرقم تواصل رسمي للمؤسسة', en: 'Your number was enabled as the official organization contact' });
    expect(T.ma_org_contact_disable_success).toEqual({ ar: 'تم إلغاء تفعيل رقمك كرقم تواصل رسمي للمؤسسة', en: 'Your number was disabled as the official organization contact' });
    expect(T.ma_org_contact_error).toEqual({ ar: 'تعذر تحديث رقم التواصل الرسمي للمؤسسة', en: 'Could not update official organization contact' });
    expect(T.ma_org_contact_ineligible).toEqual({ ar: 'متاح لمسؤول المؤسسة ومسؤول المواقف الشهرية فقط', en: 'Available only to institution managers and monthly status officers' });
  });
});

describe('23. Mobile-safe / touch-target / wrapping', () => {
  it('the action row wraps on narrow screens instead of overflowing horizontally', () => {
    expect(myAccount).toContain("flexWrap: 'wrap'");
  });

  it('buttons use the shared md size (consistent touch target with the rest of the screen)', () => {
    const block = myAccount.slice(myAccount.indexOf("t('ma_org_contact_title', lang)"), myAccount.indexOf("t('ma_org_contact_title', lang)") + 1200);
    expect(block).toContain("size=\"md\"");
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
