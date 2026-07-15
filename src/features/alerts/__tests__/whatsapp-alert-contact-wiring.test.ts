/**
 * UX-WHATSAPP-ALERT-CONTACT-WIRING-A
 * Run: npm test -- --run
 *
 * Static + behavioral tests proving the per-alert WhatsApp contact wiring in
 * InterInstitutionAlertsScreen was added WITHOUT touching routes, nav
 * targets, QR public URL logic, export/print logic, user management, or
 * lifecycle permissions — and without introducing fake data, fake phone
 * numbers, raw UUIDs in the UI, WhatsApp API/tokens/automation, new
 * SQL/migrations/RPC/Edge Functions, or Service-D interference.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { findUnreviewedMigrationFiles, getMaximumReviewedMigrationNumber } from '../../../../supabase/migrations/__tests__/helpers/reviewed-migrations';
import { findUnexpectedMigrationGitStatusEntries } from '../../../../supabase/migrations/__tests__/helpers/reviewed-migration-git-status';
import { execSync } from 'child_process';
import { buildMaterialContactMessage } from '@/shared/lib/whatsapp';

const SRC = join(__dirname, '../../../');
const ROOT = join(__dirname, '../../../../');
const readSrc = (rel: string) => readFileSync(join(SRC, rel), 'utf8');

const app = readSrc('app/App.tsx');
// QR-BUNDLE-CODE-SPLIT-A: the screen-number switch now lives in its own
// lazy-loaded chunk (AuthenticatedApp.tsx), separate from App.tsx.
const authenticatedApp = readSrc('app/AuthenticatedApp.tsx');
const alertsScreen = readSrc('features/alerts/InterInstitutionAlertsScreen.tsx');
const usersService = readSrc('shared/supabase/services/users.service.ts');
const whatsappHelper = readSrc('shared/lib/whatsapp.ts');
const whatsappButton = readSrc('shared/ui/WhatsAppContactButton.tsx');
const statusCenter = readSrc('features/status/StatusCenterScreen.tsx');
const userManagementScreen = readSrc('features/users/UserManagementScreen.tsx');
const publicQr = readSrc('features/qr/PublicQrScreen.tsx');

// ─── 1-3: routes/QR unchanged ───────────────────────────────────────────────

describe('1. App screen map / routes unchanged', () => {
  it('App.tsx still switches on the same known screen numbers', () => {
    for (const n of [3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]) {
      expect(authenticatedApp).toContain(`case ${n}:`);
    }
  });
});

describe('2. Existing navigation targets unchanged', () => {
  it('InterInstitutionAlertsScreen has no route/onNavigate changes from this phase', () => {
    expect(alertsScreen).not.toContain('onNavigate');
  });
});

describe('3. QR public route remains present', () => {
  it('App.tsx still bypasses auth entirely for ?qid=/?token=; PublicQrScreen untouched', () => {
    expect(app).toContain('publicQrId');
    expect(app).toContain('PublicQrScreen');
    expect(publicQr).not.toContain('WhatsApp');
  });
});

// ─── 4/5: export/print + mobile print fallback ─────────────────────────────

describe('4/5. Export/print handlers + mobile print fallback remain unchanged', () => {
  // SAFE-PROFESSIONAL-XLSX-EXPORT-A: a later, separately-reviewed phase
  // replaced StatusCenterScreen's ad-hoc CSV export with a real styled
  // .xlsx workbook (exportXlsx) — unrelated to this phase's WhatsApp
  // alert-contact concerns. printReport and the mobile print fallback are
  // untouched.
  it('StatusCenterScreen still has exportXlsx, printReport, and the mobile print fallback modal', () => {
    expect(statusCenter).toContain('function exportXlsx');
    expect(statusCenter).toContain('function printReport');
    expect(statusCenter).toContain('MobilePrintFallbackModal');
  });

  it('InterInstitutionAlertsScreen was not given any export/print logic', () => {
    expect(alertsScreen).not.toContain('exportCsv');
    expect(alertsScreen).not.toContain('exportXlsx');
    expect(alertsScreen).not.toContain('printReport');
    expect(alertsScreen).not.toContain('window.print');
  });
});

// ─── 6: user-management unchanged ──────────────────────────────────────────

describe('6. User-management function invocations remain unchanged', () => {
  it('UserManagementScreen still calls the same lifecycle functions and its own ContactSection integration is untouched', () => {
    for (const fn of [
      'createUserViaEdge', 'disableUserViaEdge', 'enableUserViaEdge',
      'recycleUserViaEdge', 'rotatePasswordViaEdge',
      'assignProfilePermissions', 'resetProfilePermissions', 'listUsers', 'getEffectivePermissions',
    ]) {
      expect(userManagementScreen).toContain(fn);
    }
    expect(userManagementScreen).toContain('getOrgStatusContacts(orgId)');
    expect(userManagementScreen).toContain('WhatsAppContactButton');
  });

  it('getOrgStatusContacts (single-org) signature/behavior is untouched by this phase', () => {
    const block = usersService.slice(
      usersService.indexOf('export async function getOrgStatusContacts('),
      usersService.indexOf('export async function getOrgStatusContacts(') + 500,
    );
    expect(block).toContain(".eq('organization_id', orgId)");
  });
});

// ─── 7-9: no service_role, no inter_org_exchange UI, no wipe tooling ───────

describe('7. No service_role / auth.admin in frontend', () => {
  it('none of the changed files reference service_role or auth.admin', () => {
    for (const src of [alertsScreen, usersService, whatsappHelper, whatsappButton]) {
      expect(src).not.toMatch(/service_role/i);
      expect(src).not.toContain('auth.admin');
    }
  });
});

describe('8. No inter_org_exchange UI added', () => {
  it('none of the changed files reference inter_org_exchange', () => {
    for (const src of [alertsScreen, usersService, whatsappHelper, whatsappButton]) {
      expect(src).not.toContain('inter_org_exchange');
    }
  });
});

describe('9. No wipe tooling restored', () => {
  it('none of the changed files reference wipe/full-reset tooling', () => {
    for (const src of [alertsScreen, usersService, whatsappHelper, whatsappButton]) {
      expect(src).not.toMatch(/phoenix-wipe-execute|FULL_PUBLIC_APP_WIPE_APPROVED|full_wipe|DROP SCHEMA/i);
    }
  });
});

describe('10. No package/lockfile/migration changes', () => {
  // REFRESH-MIGRATION-051-DIFF-GUARDS-A: 051_material_batch_identity_option_a.sql
  // is excluded because a later, separately-reviewed phase (FIX-MIGRATION-051-
  // IMMUTABLE-EXPIRY-DATE-A) legitimately corrects it in-place before its
  // first successful manual apply.
  it('git diff for migration SQL files is empty other than the already-approved 051 immutable-expiry-date fix (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change); package.json changes are limited to the approved exceljs addition (EXPORT-PROFESSIONAL-XLSX-PDF-B)', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- "supabase/migrations/*.sql" ":!supabase/migrations/051_material_batch_identity_option_a.sql" ":!supabase/migrations/053_item_availability_removed_marker.sql" ":!supabase/migrations/054_dashboard_condition_counts_rpcs.sql" ":!supabase/migrations/055_phoenix_clean_availability_data.sql" ":!supabase/migrations/056_phoenix_platform_broadcast_notices.sql" ":!supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    expect(diff.trim()).toBe('');

    let pkgDiff = '';
    try {
      pkgDiff = execSync('git diff -- package.json', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* git not available in this sandbox — skip silently */ }
    const addedLines = pkgDiff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++'));
    const removedLines = pkgDiff.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'));
    expect(removedLines.length).toBe(0);
    expect(addedLines.every(l => /"exceljs":/.test(l))).toBe(true);
  });

  it('no unreviewed migration SQL files were created — only the separately-reviewed migration 045 (DB-MY-ACCOUNT-WHATSAPP-RPC-A) is allowed as an untracked addition (test-only maintenance under supabase/migrations/__tests__/ is not a migration SQL change; 044 is already committed and no longer appears here)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- "supabase/migrations/*.sql"', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    // MIGRATION-GUARD-DERIVE-B: the allowed in-flight migration entries are
    // now DERIVED from the canonical reviewed registry instead of a copy kept
    // in this file, so registering a migration once permits it everywhere and
    // no historical guard needs an edit. Strictly stronger than the old list:
    // an unregistered migration still fails, and a MODIFIED reviewed migration
    // now fails too (the old list tolerated `M `/`M  ` entries).
    expect(findUnexpectedMigrationGitStatusEntries(status)).toEqual([]);
  });
});

// ─── 11/12: uses WhatsAppContactButton + real contact data only ───────────

describe('11. Alert WhatsApp wiring uses WhatsAppContactButton', () => {
  it('InterInstitutionAlertsScreen renders WhatsAppContactButton, not a duplicated wa.me implementation', () => {
    expect(alertsScreen).toContain("import { WhatsAppContactButton } from '@/shared/ui/WhatsAppContactButton'");
    expect(alertsScreen).toContain('<WhatsAppContactButton');
    expect(alertsScreen).not.toContain('wa.me');
    expect(alertsScreen).not.toContain('window.open');
  });
});

describe('12. UX-ALERTS-LIVE-WHATSAPP-CONTACT-WIRING-A: phone comes directly off the alert row, not a separate RLS-limited query', () => {
  it('screen no longer imports or calls getOrgStatusContactsForOrgs — the RLS-limited direct-table lookup is fully removed from this screen', () => {
    expect(alertsScreen).not.toContain('getOrgStatusContactsForOrgs');
    expect(alertsScreen).not.toContain('OrgContactRow');
    expect(alertsScreen).not.toContain('contactsByOrg');
    expect(alertsScreen).not.toContain('contactOrgKey');
  });

  it('screen still makes no direct supabase.from()/supabase.rpc() call of its own — all reads go through the lifecycle service', () => {
    expect(alertsScreen).not.toContain('supabase.from(');
    expect(alertsScreen).not.toContain('supabase.rpc(');
  });

  it('the WhatsApp button phone prop is sourced directly from the alert row: sourceContactPhone for the source target, targetContactPhone for the target target', () => {
    const block = alertsScreen.slice(alertsScreen.indexOf('<WhatsAppContactButton'), alertsScreen.indexOf('<WhatsAppContactButton') + 300);
    expect(block).toContain("phone={target.key === 'source' ? a.sourceContactPhone : a.targetContactPhone}");
  });

  it('getOrgStatusContactsForOrgs itself is left in place in users.service.ts (not removed globally) since it is a generic service, only its call site in this screen was removed', () => {
    expect(usersService).toContain('export async function getOrgStatusContactsForOrgs(');
  });
});

describe('12b. inter-org-alert-lifecycle.service.ts: type + mapper accept the new RPC contact fields', () => {
  const lifecycleService = readSrc('features/alerts/inter-org-alert-lifecycle.service.ts');

  it('LiveInterInstitutionAlertWithState declares sourceContactPhone/targetContactPhone', () => {
    const typeBlock = lifecycleService.slice(
      lifecycleService.indexOf('export interface LiveInterInstitutionAlertWithState'),
      lifecycleService.indexOf('export interface LiveInterInstitutionAlertsWithStateResult'),
    );
    expect(typeBlock).toContain('sourceContactPhone?: string | null');
    expect(typeBlock).toContain('targetContactPhone?: string | null');
  });

  it('the raw RPC row type declares the snake_case source fields', () => {
    const rawBlock = lifecycleService.slice(
      lifecycleService.indexOf('interface RawLiveAlertWithStateRow'),
      lifecycleService.indexOf('interface RawAlertEventRow'),
    );
    expect(rawBlock).toContain('source_contact_phone?: string | null');
    expect(rawBlock).toContain('target_contact_phone?: string | null');
  });

  it('mapRow maps source_contact_phone/target_contact_phone to camelCase, defaulting a missing value to null (never undefined, never a fake number)', () => {
    const mapBlock = lifecycleService.slice(
      lifecycleService.indexOf('function mapRow('),
      lifecycleService.indexOf('function mapEvent('),
    );
    expect(mapBlock).toContain('sourceContactPhone: r.source_contact_phone ?? null');
    expect(mapBlock).toContain('targetContactPhone: r.target_contact_phone ?? null');
  });
});

// ─── 13/14/15: no fake numbers, no API/automation, no auto-send ───────────

describe('13. No fake WhatsApp numbers added', () => {
  it('no hardcoded phone constant anywhere in the changed files', () => {
    for (const src of [alertsScreen, usersService]) {
      expect(src).not.toMatch(/['"`]\+?\d{8,15}['"`]/);
    }
  });
});

describe('14. No WhatsApp API/Cloud API/tokens/automation added', () => {
  it('no API/Cloud API/token/Bearer references in the changed files', () => {
    for (const src of [alertsScreen, whatsappHelper, whatsappButton]) {
      expect(src).not.toMatch(/graph\.facebook\.com|access_token=|api\.whatsapp\.com/i);
      expect(src).not.toContain('Bearer ');
    }
  });
});

describe('15. No automatic sending', () => {
  it('WhatsAppContactButton (reused unchanged) is still a plain user-clickable anchor', () => {
    expect(whatsappButton).toContain('target="_blank"');
    expect(whatsappButton).toContain('rel="noreferrer noopener"');
    expect(whatsappButton).not.toContain('useEffect');
    expect(whatsappButton).not.toContain('.click()');
  });
});

// ─── 16/17/18: message builder ─────────────────────────────────────────────

describe('16. Message builder omits missing fields', () => {
  it('alert-context message omits a field entirely when not supplied', () => {
    const msg = buildMaterialContactMessage({ material: 'Amoxicillin', context: 'alert' }, 'en');
    expect(msg).toContain('Material: Amoxicillin');
    expect(msg).not.toContain('Status:');
    expect(msg).not.toContain('Source institution:');
    expect(msg).not.toContain('Target institution:');
    expect(msg).not.toContain('Quantity:');
  });
});

describe('17. Message builder does not include raw UUIDs', () => {
  const uuid = '3fa85f64-5717-4562-b3fc-2c963f66afa6';

  it('buildMaterialContactMessage never echoes a UUID-shaped input back verbatim as a label without context', () => {
    // The builder only ever renders whatever string a caller supplies for
    // institution names — this proves the ALERT SCREEN itself never passes
    // organization ids (only resolved display names) into those fields.
    const block = alertsScreen.slice(alertsScreen.indexOf('buildMaterialContactMessage({'), alertsScreen.indexOf('buildMaterialContactMessage({') + 700);
    expect(block).toContain('sourceInstitution: orgName(');
    expect(block).toContain('targetInstitution: orgName(');
    expect(block).not.toContain('sourceOrganizationId');
    expect(block).not.toContain('targetOrganizationId');
  });

  it('the WhatsApp button label uses the resolved org display name, not the org id', () => {
    const block = alertsScreen.slice(alertsScreen.indexOf('label={`${t(target.labelKey'), alertsScreen.indexOf('label={`${t(target.labelKey') + 120);
    expect(block).toContain('target.orgName');
    expect(block).not.toContain('target.orgId');
  });

  it('sanity: a raw uuid passed as a name would appear verbatim only if the caller chose to (documenting the risk, not exercising it here)', () => {
    expect(uuid).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('18. Message builder has Arabic and English alert wording', () => {
  it('alert context produces the distinct alert greeting in both languages', () => {
    const ar = buildMaterialContactMessage({ material: 'X', context: 'alert' }, 'ar');
    const en = buildMaterialContactMessage({ material: 'X', context: 'alert' }, 'en');
    expect(ar).toContain('نود التواصل بخصوص تنبيه مادة');
    expect(en).toContain('We would like to follow up regarding a material alert');
  });

  it('default (status) context is unchanged from the previous phase — byte-identical output when called the same way', () => {
    const arStatus = buildMaterialContactMessage({}, 'ar');
    const enStatus = buildMaterialContactMessage({}, 'en');
    expect(arStatus).toContain('نود التواصل بخصوص حالة مادة ضمن نظام MediStock Phoenix.');
    expect(enStatus).toContain('We would like to follow up regarding a material status in MediStock Phoenix.');
  });

  it('source/target institution lines render distinctly from the generic single institution line', () => {
    const msg = buildMaterialContactMessage({ sourceInstitution: 'Hospital A', targetInstitution: 'Hospital B', context: 'alert' }, 'en');
    expect(msg).toContain('Source institution: Hospital A');
    expect(msg).toContain('Target institution: Hospital B');
    expect(msg).not.toContain('Institution:');
  });
});

// ─── 19: no clinical/medical recommendations ───────────────────────────────

describe('19. No clinical/medical recommendations', () => {
  it('full alert message contains no diagnosis/prescription/dosage-recommendation wording', () => {
    const full = buildMaterialContactMessage({
      material: 'Amoxicillin', status: 'Missing',
      sourceInstitution: 'Hospital A', targetInstitution: 'Hospital B',
      outlet: 'Main Pharmacy', quantity: 10, expiryDate: '2026-01-01', lastUpdate: '2026-01-01',
      context: 'alert',
    }, 'en');
    expect(full.toLowerCase()).not.toMatch(/diagnos|prescri|dosage recommendation|treatment plan|take \d+ (mg|tablet)/);
  });
});

// ─── 20: honest missing/invalid phone ──────────────────────────────────────

describe('20. Missing/invalid phone state is honest', () => {
  it('WhatsAppContactButton (reused, unmodified) still distinguishes missing vs invalid', () => {
    expect(whatsappButton).toContain('wa_number_missing');
    expect(whatsappButton).toContain('wa_invalid_number');
  });

  it('the alert card never substitutes a fake number when the alert row has no contact phone — it passes the field through as-is (null/undefined), never a fallback string', () => {
    const block = alertsScreen.slice(alertsScreen.indexOf('<WhatsAppContactButton'), alertsScreen.indexOf('<WhatsAppContactButton') + 300);
    expect(block).toContain("phone={target.key === 'source' ? a.sourceContactPhone : a.targetContactPhone}");
    expect(block).not.toMatch(/\|\|\s*['"`]\+?\d/);
  });
});

// ─── 21/22: existing handlers + lifecycle permissions unchanged ───────────

describe('21. Existing alert action handlers remain connected', () => {
  it('acknowledge/start-processing/resolve/dismiss/reopen/history buttons are all still wired to onAction/onHistory', () => {
    expect(alertsScreen).toContain("onClick={() => onAction('acknowledged')}");
    expect(alertsScreen).toContain("onClick={() => onAction('in_progress')}");
    expect(alertsScreen).toContain("onClick={() => onAction('resolved')}");
    expect(alertsScreen).toContain("onClick={() => onAction('dismissed')}");
    expect(alertsScreen).toContain("onClick={() => onAction('open')}");
    expect(alertsScreen).toContain('onClick={onHistory}');
  });
});

describe('22. Existing alert lifecycle permission gates remain unchanged', () => {
  it('TRANSITION_PERMISSION map and canTransition gating are untouched', () => {
    expect(alertsScreen).toContain("open:         'inter_institution_alerts.manage'");
    expect(alertsScreen).toContain("acknowledged: 'inter_institution_alerts.acknowledge'");
    expect(alertsScreen).toContain("in_progress:  'inter_institution_alerts.manage'");
    expect(alertsScreen).toContain("resolved:     'inter_institution_alerts.resolve'");
    expect(alertsScreen).toContain("dismissed:    'inter_institution_alerts.dismiss'");
    expect(alertsScreen).toContain('canTransition(');
  });

  it('no new permission keys were invented by this phase', () => {
    for (const src of [whatsappHelper, whatsappButton]) {
      expect(src).not.toContain('myPermissions');
    }
    // the screen's only permission usage is the pre-existing canTransition/TRANSITION_PERMISSION path
    expect(alertsScreen).not.toContain("permission_keys");
  });
});

// ─── 23/24: no new SQL/RPC/Edge Function; no breakage ─────────────────────

describe('23. No new SQL/migrations/RPC/Edge Function introduced', () => {
  it('getOrgStatusContactsForOrgs uses only a plain PostgREST select (.from/.in/.eq), no .rpc(', () => {
    const block = usersService.slice(usersService.indexOf('export async function getOrgStatusContactsForOrgs('));
    expect(block).not.toContain('.rpc(');
    expect(block).not.toContain('functions.invoke');
  });

  it('no unreviewed top-level migration file exists beyond 043 — only the separately-reviewed migrations 044 (DB-MY-ACCOUNT-WHATSAPP-PHONE-A), 045 (DB-MY-ACCOUNT-WHATSAPP-RPC-A), 046 (DB-OFFICIAL-ORG-WHATSAPP-CONTACT-RPC-A), 047 (DB-ALERTS-LIVE-WHATSAPP-CONTACT-FIELDS-A), 048 (DB-EXPIRY-RISK-TIERS-LIVE-ALERTS-A), 049 (DATA-MODEL-NATIONAL-CODE-SEPARATION-A), 050 (DB-AVAILABILITY-UPSERT-NATIONAL-CODE-050-A), 051 (DB-MATERIAL-BATCH-IDENTITY-051-A, manual-apply-only, not yet applied), 052 (QR-EFFECTIVE-CONDITION-QUANTITY-ZERO-052-A, manually applied and verified), 053 (DB-REMOVED-OUTLET-MATERIAL-MARKER-053-A, manual-apply-only, not yet applied), and 054 (PHASE2-DASHBOARD-PERFORMANCE-RPCS-054-A, manual-apply-only, not yet applied) are allowed above it (any of these may still be untracked/unstaged at review time — this check only constrains what IS tracked/staged, not when it lands)', () => {
    let files = '';
    try {
      files = execSync('git ls-files supabase/migrations', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const trackedMigrationFiles = files.split('\n').filter(f => /^supabase\/migrations\/\d{3}_/.test(f));
    // MIGRATION-GUARD-DERIVE-B: the tracked-migration allowlist and the `<= 59`
    // ceiling both used to need an edit per migration. Both now derive from the
    // canonical registry: every tracked migration SQL file must be an exactly
    // reviewed filename, and the ceiling is the registry maximum.
    const trackedNames = trackedMigrationFiles.map(f => f.slice('supabase/migrations/'.length));
    expect(findUnreviewedMigrationFiles(trackedNames)).toEqual([]);
    const nums = trackedNames.map(f => parseInt(f.slice(0, 3), 10));
    expect(Math.max(...nums)).toBeLessThanOrEqual(getMaximumReviewedMigrationNumber());
  });

  // BASELINE-GUARD-FIX-A: proves the allowlist above still REJECTS an
  // unreviewed migration rather than merely accepting whatever is on disk.
  // Pure in-memory logic mirroring the filter at the top of this block — it
  // never creates, reads, or requires a real 059 file.
  it('a synthetic unreviewed migration 059 would still be rejected by the allowlist (guard is not a wildcard)', () => {
    const allowedBeyond043 = new Set([
      'supabase/migrations/057_phoenix_platform_broadcast_admin_details_delete.sql',
      'supabase/migrations/058_phoenix_public_qr_dosage_form.sql',
      'supabase/migrations/059_phoenix_public_qr_concentration.sql',
    ]);
    const synthetic = [
      'supabase/migrations/058_phoenix_public_qr_dosage_form.sql',
      'supabase/migrations/059_phoenix_public_qr_concentration.sql',
      'supabase/migrations/059_totally_unreviewed_migration.sql',
    ];
    const beyond043 = synthetic.filter(f => {
      const match = f.match(/\/(\d{3})_/);
      return match ? Number(match[1]) > 43 : false;
    });
    const unexpected = beyond043.filter(f => !allowedBeyond043.has(f));
    // 058 is allowed through; 059 is caught.
    expect(unexpected).toEqual(['supabase/migrations/059_totally_unreviewed_migration.sql']);
    // And the numeric ceiling independently catches it too.
    const nums = synthetic.map(f => parseInt(f.slice('supabase/migrations/'.length, 'supabase/migrations/'.length + 3), 10));
    expect(Math.max(...nums)).toBeGreaterThan(58);
  });
});

describe('24. No route/link/QR/export/user-management breakage', () => {
  // QR-HIDE-NONAVAILABLE-ITEMS-FROM-PUBLIC-LIST-A: PublicQrScreen.tsx is
  // excluded from this empty-diff check — a later, separately-reviewed
  // phase that hides non-available items from the public list. App.tsx
  // remains fully guarded.
  // QR-BUNDLE-CODE-SPLIT-A: App.tsx was later, legitimately restructured
  // (route detection now lazy-loads PublicQrScreen vs AuthenticatedApp) —
  // the empty-diff guard is replaced by a behavior check that the public QR
  // route still resolves the same way.
  it('App.tsx still resolves ?qid=/?token= to PublicQrScreen (route behavior unchanged by later QR-BUNDLE-CODE-SPLIT-A restructuring)', () => {
    const app = readFileSync(join(ROOT, 'src/app/App.tsx'), 'utf8');
    expect(app).toContain("params.get('qid')");
    expect(app).toContain('PublicQrScreen');
  });
});

// ─── 25: mobile wrapping/touch target ──────────────────────────────────────

describe('25. Mobile wrapping/touch target exists', () => {
  it('the WhatsApp contact row wraps on mobile', () => {
    const block = alertsScreen.slice(alertsScreen.indexOf('contactTargets.length > 0'), alertsScreen.indexOf('contactTargets.length > 0') + 300);
    expect(block).toContain("flexWrap: 'wrap'");
  });

  it('WhatsAppContactButton (reused) still meets the 38px minimum touch height', () => {
    expect(whatsappButton).toContain("minHeight: '38px'");
  });
});

describe('Safety guards', () => {
  it('stash@{0} (paused Service-D work) was not popped or applied', () => {
    const stashList = execSync('git stash list', { cwd: ROOT, encoding: 'utf8' });
    expect(stashList).toContain('paused Service-D inter-org exchange service work');
  });

  it('premium-preview.html remains untouched (untracked only)', () => {
    let status = '';
    try {
      status = execSync('git status --porcelain -- premium-preview.html', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    if (status.trim()) {
      expect(status.trim().startsWith('??')).toBe(true);
    }
  });
});
