import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  canAssignRole,
  isAdminRole,
  canManageOrg,
  ASSIGNABLE_ROLES_BY_ACTOR,
} from '../types';
import type { Role } from '../types';

const SRC     = join(__dirname, '../../..');
const PHOENIX = join(__dirname, '../../../..');

function readSrc(rel: string) {
  return readFileSync(join(SRC, rel), 'utf8');
}

function readPhoenix(rel: string) {
  return readFileSync(join(PHOENIX, rel), 'utf8');
}

describe('Role hierarchy helpers', () => {
  it('super_admin can assign any role', () => {
    const roles: Role[] = ['super_admin', 'hospital_admin', 'warehouse_manager', 'point_operator', 'viewer'];
    roles.forEach(r => expect(canAssignRole('super_admin', r)).toBe(true));
  });

  it('hospital_admin can assign all roles except super_admin', () => {
    expect(canAssignRole('hospital_admin', 'hospital_admin')).toBe(true);
    expect(canAssignRole('hospital_admin', 'warehouse_manager')).toBe(true);
    expect(canAssignRole('hospital_admin', 'point_operator')).toBe(true);
    expect(canAssignRole('hospital_admin', 'viewer')).toBe(true);
    expect(canAssignRole('hospital_admin', 'super_admin')).toBe(false);
  });

  it('warehouse_manager cannot assign any role', () => {
    expect(canAssignRole('warehouse_manager', 'viewer')).toBe(false);
  });

  it('point_operator cannot assign any role', () => {
    expect(canAssignRole('point_operator', 'viewer')).toBe(false);
  });

  it('viewer cannot assign any role', () => {
    expect(canAssignRole('viewer', 'viewer')).toBe(false);
  });

  it('isAdminRole identifies admin-level roles', () => {
    expect(isAdminRole('super_admin')).toBe(true);
    expect(isAdminRole('hospital_admin')).toBe(true);
    expect(isAdminRole('warehouse_manager')).toBe(false);
    expect(isAdminRole('point_operator')).toBe(false);
    expect(isAdminRole('viewer')).toBe(false);
  });

  it('canManageOrg is super_admin only', () => {
    expect(canManageOrg('super_admin')).toBe(true);
    expect(canManageOrg('hospital_admin')).toBe(false);
    expect(canManageOrg('warehouse_manager')).toBe(false);
  });

  it('ASSIGNABLE_ROLES_BY_ACTOR: hospital_admin cannot assign super_admin', () => {
    expect(ASSIGNABLE_ROLES_BY_ACTOR.hospital_admin).not.toContain('super_admin');
  });

  it('ASSIGNABLE_ROLES_BY_ACTOR: non-admin roles have empty assignable list', () => {
    expect(ASSIGNABLE_ROLES_BY_ACTOR.warehouse_manager).toHaveLength(0);
    expect(ASSIGNABLE_ROLES_BY_ACTOR.point_operator).toHaveLength(0);
    expect(ASSIGNABLE_ROLES_BY_ACTOR.viewer).toHaveLength(0);
  });
});

describe('types.ts: no hardcoded institution codes', () => {
  const types = readSrc('shared/lib/types.ts');

  it('does not contain hardcoded institution codes', () => {
    expect(types).not.toMatch(/'marjan'|'hilla'|'babil'|'mahawil'/);
  });

  it('does not export Institution interface with hardcoded code union', () => {
    expect(types).not.toMatch(/code:\s*'marjan'/);
  });

  it('does not export BridgeLink interface', () => {
    expect(types).not.toContain('BridgeLink');
  });

  it('does not export InstitutionStatus type', () => {
    expect(types).not.toContain('InstitutionStatus');
  });

  it('exports Organization interface aligned with DB schema', () => {
    expect(types).toContain('Organization');
    expect(types).toContain('OrganizationStatus');
  });

  it('exports ProfileRow interface', () => {
    expect(types).toContain('ProfileRow');
  });

  it('AllowlistedEntityType includes warehouse and distribution_point', () => {
    expect(types).toContain("'warehouse'");
    expect(types).toContain("'distribution_point'");
    expect(types).toContain("'local_item'");
  });
});

describe('Institution management: bilingual display', () => {
  const strings = readSrc('shared/i18n/strings.ts');

  it('has bilingual institution management keys', () => {
    expect(strings).toContain('nav_institutions');
    expect(strings).toContain('inst_sub');
    expect(strings).toContain('inst_add');
    expect(strings).toContain('inst_edit');
    expect(strings).toContain('inst_users');
    expect(strings).toContain('inst_name_en');
    expect(strings).toContain('inst_name_ar');
  });

  it('has bilingual role labels', () => {
    expect(strings).toContain('role_super_admin');
    expect(strings).toContain('role_hospital_admin');
    expect(strings).toContain('role_warehouse_manager');
    expect(strings).toContain('role_point_operator');
    expect(strings).toContain('role_viewer');
  });

  it('has user creation limitation notice', () => {
    expect(strings).toContain('user_create_notice');
  });
});

describe('InstitutionScreen: safety checks', () => {
  const screen = readSrc('features/institutions/InstitutionScreen.tsx');

  it('does not import service_role or admin API', () => {
    expect(screen).not.toContain('service_role');
    expect(screen).not.toContain('admin.');
  });

  it('uses canManageOrg for org CRUD gating', () => {
    expect(screen).toContain('canManageOrg');
  });

  it('uses canAssignRole for role change gating', () => {
    expect(screen).toContain('canAssignRole');
  });

  it('uses dir="ltr" for technical identifiers', () => {
    expect(screen).toContain('dir="ltr"');
  });

  it('uses dir="auto" for user-entered content', () => {
    expect(screen).toContain('dir="auto"');
  });

  it('uses dir="rtl" for Arabic name input', () => {
    expect(screen).toContain('dir="rtl"');
  });

  it('does not contain DataReset or OCR imports', () => {
    expect(screen).not.toMatch(/DataReset|OCR|DocIntel|ExcelImport/i);
  });

  it('handles RPC escalation errors with bilingual messages', () => {
    expect(screen).toContain('CANNOT_ESCALATE_TO_SUPER_ADMIN');
    expect(screen).toContain('CANNOT_MODIFY_OTHER_ORG');
    expect(screen).toContain('CANNOT_CHANGE_OWN_ROLE');
    expect(screen).toContain('role_no_escalate');
  });
});

describe('Role assignment: RPC-based (not direct update)', () => {
  const orgService = readSrc('shared/supabase/services/organizations.service.ts');

  it('updateProfileRole calls assign_profile_role RPC', () => {
    expect(orgService).toContain('assign_profile_role');
    expect(orgService).toContain("supabase.rpc('assign_profile_role'");
  });

  it('updateProfileRole does NOT use direct .update() on profiles', () => {
    const fnStart = orgService.indexOf('async function updateProfileRole');
    const fnEnd = orgService.indexOf('}', orgService.indexOf('return result', fnStart));
    const fnBody = orgService.slice(fnStart, fnEnd);
    expect(fnBody).not.toMatch(/\.from\(['"]profiles['"]\)\s*\.\s*update/);
  });

  it('updateProfileRole rejects non-ok RPC responses', () => {
    expect(orgService).toContain('ROLE_ASSIGN_FAILED');
    expect(orgService).toContain('result.ok');
  });
});

describe('Migration 005: assign_profile_role RPC security', () => {
  const sql = readPhoenix('supabase/migrations/005_phoenix_assign_profile_role.sql');

  it('is SECURITY DEFINER', () => {
    expect(sql).toContain('security definer');
  });

  it('sets search_path to public, pg_temp', () => {
    expect(sql).toContain('set search_path = public, pg_temp');
  });

  it('checks auth.uid() is not null', () => {
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('NOT_AUTHENTICATED');
  });

  it('validates role against allowlist', () => {
    expect(sql).toContain('INVALID_ROLE');
    expect(sql).toContain("'super_admin', 'hospital_admin', 'warehouse_manager', 'point_operator', 'viewer'");
  });

  it('blocks self-assignment', () => {
    expect(sql).toContain('CANNOT_CHANGE_OWN_ROLE');
    expect(sql).toContain('p_target_id = v_actor_id');
  });

  it('blocks hospital_admin from assigning super_admin', () => {
    expect(sql).toContain('CANNOT_ESCALATE_TO_SUPER_ADMIN');
    expect(sql).toContain("p_new_role = 'super_admin'");
  });

  it('blocks hospital_admin from modifying profiles outside own org', () => {
    expect(sql).toContain('CANNOT_MODIFY_OTHER_ORG');
    expect(sql).toContain('v_target.organization_id is distinct from v_actor_org_id');
  });

  it('blocks hospital_admin from modifying super_admin profiles', () => {
    expect(sql).toContain('CANNOT_MODIFY_SUPER_ADMIN');
  });

  it('only super_admin and hospital_admin can assign roles', () => {
    expect(sql).toContain('INSUFFICIENT_ROLE');
    expect(sql).toContain("v_actor_role not in ('super_admin', 'hospital_admin')");
  });

  it('writes audit log on role change', () => {
    expect(sql).toContain("'role_assigned'");
    expect(sql).toContain('previous_role');
    expect(sql).toContain('new_role');
  });

  it('is not granted to anon', () => {
    expect(sql).toContain('revoke all on function assign_profile_role');
    expect(sql).toContain('from anon');
  });

  it('is granted to authenticated', () => {
    expect(sql).toContain('grant execute on function assign_profile_role');
    expect(sql).toContain('to authenticated');
  });
});

describe('Port QR lifecycle: safety checks', () => {
  const screen = readSrc('features/institutions/InstitutionScreen.tsx');
  const whService = readSrc('shared/supabase/services/warehouses.service.ts');
  const qrService = readSrc('shared/supabase/services/qr.service.ts');
  const strings = readSrc('shared/i18n/strings.ts');

  it('create port calls createDistributionPoint then createQrForTarget', () => {
    expect(screen).toContain('createDistributionPoint');
    expect(screen).toContain('createQrForTarget');
  });

  it('create port handles QR failure gracefully without rollback', () => {
    expect(screen).toContain('qr_gen_failed');
  });

  it('QR revoke does not archive or delete port', () => {
    expect(screen).toContain('manual_revoke');
    const revokeBlock = screen.slice(
      screen.indexOf('async function onRevokeQr'),
      screen.indexOf('}', screen.indexOf("setBusy(null)", screen.indexOf('async function onRevokeQr')) + 1) + 1,
    );
    expect(revokeBlock).not.toContain('archiveEntity');
    expect(revokeBlock).not.toContain('distribution_points');
  });

  it('archive port revokes QR first, then archives', () => {
    const archiveBlock = screen.slice(
      screen.indexOf('async function onArchivePort'),
      screen.indexOf('}', screen.indexOf("setArchiveReason('')") + 1) + 1,
    );
    const qrDisableIdx = archiveBlock.indexOf('disableQrToken');
    const archiveIdx = archiveBlock.indexOf('archiveEntity');
    expect(qrDisableIdx).toBeGreaterThan(-1);
    expect(archiveIdx).toBeGreaterThan(qrDisableIdx);
  });

  it('regenerate QR does not modify port entity', () => {
    expect(qrService).toContain('regenerateQrForPoint');
    const regenFn = qrService.slice(
      qrService.indexOf('async function regenerateQrForPoint'),
      qrService.indexOf('}', qrService.indexOf('return { ok:', qrService.indexOf('regenerateQrForPoint')) + 1) + 1,
    );
    expect(regenFn).not.toContain('distribution_points');
    expect(regenFn).toContain('disableQrToken');
    expect(regenFn).toContain('createQrForTarget');
  });

  it('no raw .delete() on distribution_points in warehouses service', () => {
    expect(whService).not.toMatch(/\.from\(['"]distribution_points['"]\)\s*\.\s*delete/);
  });

  it('no raw .delete() on distribution_points in InstitutionScreen', () => {
    expect(screen).not.toMatch(/\.from\(['"]distribution_points['"]\)\s*\.\s*delete/);
  });

  it('uses archiveEntity RPC (not raw delete) for port archival', () => {
    expect(screen).toContain('archiveEntity');
    expect(screen).toContain("'distribution_point'");
  });

  it('bilingual QR safety messages exist', () => {
    expect(strings).toContain('port_revoke_safe');
    expect(strings).toContain('port_archive_warn');
    expect(strings).toContain('port_archive_deps');
    expect(strings).toContain('qr_confirm_regenerate');
    expect(strings).toContain('qr_confirm_revoke');
  });

  it('QR URLs use dir="ltr"', () => {
    expect(screen).toMatch(/dir="ltr"[\s\S]*?publicUrl/);
  });

  it('confirmation dialogs exist for regenerate, revoke, archive', () => {
    expect(screen).toContain("confirmAction === 'regenerate'");
    expect(screen).toContain("confirmAction === 'revoke'");
    expect(screen).toContain("confirmAction === 'archive'");
  });

  it('port mutation is gated by permission-based flags (canEditPorts/canArchivePorts)', () => {
    expect(screen).toContain('canEditPorts');
    expect(screen).toContain('canArchivePorts');
  });
});

describe('Port availability: management and display', () => {
  const screen = readSrc('features/institutions/InstitutionScreen.tsx');
  const strings = readSrc('shared/i18n/strings.ts');
  const availService = readSrc('shared/supabase/services/availability.service.ts');

  it('PortCard includes PortAvailabilitySection', () => {
    expect(screen).toContain('PortAvailabilitySection');
  });

  it('availability section uses getAvailabilityByPoint scoped to point', () => {
    expect(screen).toContain('getAvailabilityByPoint');
  });

  it('availability upsert uses upsertAvailability with port scope', () => {
    expect(screen).toContain('upsertAvailability');
  });

  it('availability service queries by distribution_point_id', () => {
    expect(availService).toContain('distribution_point_id');
  });

  it('bilingual condition labels exist', () => {
    expect(strings).toContain('cond_available');
    expect(strings).toContain('cond_low_stock');
    expect(strings).toContain('cond_missing');
    expect(strings).toContain('cond_surplus');
    expect(strings).toContain('cond_near_expiry');
    expect(strings).toContain('cond_expired');
  });

  it('bilingual availability management keys exist', () => {
    expect(strings).toContain('avail_manage');
    expect(strings).toContain('avail_add');
    expect(strings).toContain('avail_saved');
    expect(strings).toContain('avail_select_item');
  });

  it('condition labels use bilingual display in admin', () => {
    expect(screen).toContain('CONDITION_LABEL_KEY');
  });
});

describe('Public QR page: safety and bilingual', () => {
  const publicQr = readSrc('features/qr/PublicQrScreen.tsx');
  const strings = readSrc('shared/i18n/strings.ts');

  it('shows bilingual condition labels (not raw DB values)', () => {
    expect(publicQr).toContain('conditionLabel');
    expect(publicQr).toContain('CONDITION_LABEL');
  });

  it('shows expiry warning for near_expiry items', () => {
    expect(publicQr).toContain('public_expiry_warn');
    expect(publicQr).toContain('near_expiry');
  });

  it('shows bilingual empty port message', () => {
    expect(publicQr).toContain('public_empty_port');
    expect(strings).toContain('public_empty_port');
  });

  it('does not expose private fields', () => {
    expect(publicQr).not.toContain('audit_log');
    expect(publicQr).not.toContain('actor_id');
    expect(publicQr).not.toContain('service_role');
    expect(publicQr).not.toContain('token_hash');
    expect(publicQr).not.toContain('batch_number');
  });

  it('does not expose admin controls on public page', () => {
    expect(publicQr).not.toContain('archiveEntity');
    expect(publicQr).not.toContain('disableQrToken');
    expect(publicQr).not.toContain('updateProfileRole');
  });

  it('uses dir="auto" for item names', () => {
    expect(publicQr).toContain('dir="auto"');
  });

  it('uses dir="ltr" for expiry dates', () => {
    expect(publicQr).toContain('dir="ltr"');
  });

  it('has search functionality for item names', () => {
    expect(publicQr).toContain('public_search');
    expect(publicQr).toContain('search');
  });

  it('search works with Arabic and English item names', () => {
    expect(publicQr).toContain('name_ar');
    expect(publicQr).toContain('.toLowerCase()');
  });

  it('shows privacy notice', () => {
    expect(publicQr).toContain('qr_no_expose');
  });

  it('handles revoked QR gracefully', () => {
    expect(publicQr).toContain('qr_invalid');
    expect(publicQr).toContain('qr_scan_again');
  });

  it('displays item count', () => {
    expect(publicQr).toContain('public_items_count');
  });
});

describe('Central Status Center: structure and safety', () => {
  const screen = readSrc('features/status/StatusCenterScreen.tsx');
  const service = readSrc('shared/supabase/services/status-reports.service.ts');
  const strings = readSrc('shared/i18n/strings.ts');
  const sql = readPhoenix('supabase/migrations/006_phoenix_status_reports.sql');

  it('status_type constrained to scarce/surplus/near_expiry/missing', () => {
    expect(sql).toContain("'scarce', 'surplus', 'near_expiry', 'missing'");
  });

  it('table has RLS enabled', () => {
    expect(sql).toContain('enable row level security');
  });

  it('super_admin has full access', () => {
    expect(sql).toContain('isr_all_superadmin');
  });

  it('hospital_admin scoped to own org', () => {
    expect(sql).toContain('isr_all_hospitaladmin');
    expect(sql).toContain('organization_id = phoenix_my_org()');
  });

  it('viewer is read-only', () => {
    expect(sql).toContain('isr_select_viewer');
    expect(sql).not.toMatch(/isr_insert_viewer|isr_update_viewer/);
  });

  it('bilingual status labels exist', () => {
    expect(strings).toContain('st_scarce');
    expect(strings).toContain('st_surplus');
    expect(strings).toContain('st_near_expiry');
    expect(strings).toContain('st_missing');
  });

  it('bilingual resolved label exists', () => {
    expect(strings).toContain('sc_resolved');
  });

  it('screen uses org scope for filtering', () => {
    expect(screen).toContain('activeOrgId');
    expect(screen).toContain('PhoenixOrgScope');
  });

  it('screen is a read-only live availability report (manual mutation gating removed)', () => {
    // LIVE-STATUS-CENTER-REPORTS-PRINT-EXPORT-A: the manual report add/edit/resolve
    // workflow was removed, so the screen no longer performs role-gated mutations.
    // It now reads live item_availability instead.
    expect(screen).toContain('getAvailabilityByOrg');
    expect(screen).not.toContain('createStatusReport');
    expect(screen).not.toContain('updateStatusReport');
  });

  it('no exchange alert logic beyond the disclaimer notice', () => {
    expect(screen).not.toContain('exchangeAlert');
    expect(screen).not.toContain('autoTransfer');
    expect(screen).not.toContain('auto_approve');
    expect(screen).not.toContain('suggestTransfer');
  });

  it('no auto-transfer in service', () => {
    expect(service).not.toContain('transfer');
    expect(service).not.toContain('exchange');
  });

  it('no service_role in screen', () => {
    expect(screen).not.toContain('service_role');
  });

  it('no service_role in service', () => {
    expect(service).not.toContain('service_role');
  });

  it('notes field uses dir="auto"', () => {
    expect(screen).toContain('dir="auto"');
  });

  it('port/material names use bilingual fallback', () => {
    // The live report renders distribution point names with an AR/EN fallback
    // (name_ar || name) and material identity (scientific_name / trade_name).
    expect(screen).toContain('name_ar');
    expect(screen).toContain('scientific_name');
  });

  it('service filters by org, statusType, and activeOnly', () => {
    expect(service).toContain('organization_id');
    expect(service).toContain('status_type');
    expect(service).toContain('is_active');
  });

  it('resolve sets is_active to false', () => {
    expect(service).toContain('is_active: false');
    expect(service).toContain('resolved_at');
  });

  it('navigation item exists', () => {
    expect(strings).toContain('nav_status_center');
  });

  it('no-exchange notice is shown', () => {
    expect(screen).toContain('sc_no_exchange');
  });
});

describe('Central Dashboard integration', () => {
  const dashboard = readSrc('features/dashboard/DashboardScreen.tsx');
  const dashService = readSrc('shared/supabase/services/dashboard.service.ts');
  const strings = readSrc('shared/i18n/strings.ts');

  it('dashboard uses real metrics not hardcoded demo values', () => {
    expect(dashService).not.toContain('DEMO_METRICS');
    expect(dashService).toContain("from('warehouses')");
    expect(dashService).toContain("from('distribution_points')");
    expect(dashService).toContain("from('qr_tokens')");
  });

  it('dashboard service includes warehouse count', () => {
    expect(dashService).toContain('activeWarehouses');
  });

  it('dashboard service includes port count', () => {
    expect(dashService).toContain('activePorts');
  });

  it('dashboard service includes QR active/disabled counts', () => {
    expect(dashService).toContain('activeQrCodes');
    expect(dashService).toContain('disabledQrCodes');
  });

  it('dashboard service includes surplus count', () => {
    expect(dashService).toContain('surplusCount');
  });

  it('dashboard service fetches status report counts with graceful fallback', () => {
    expect(dashService).toContain('getStatusReportCounts');
    expect(dashService).toContain('institution_item_status_reports');
    expect(dashService).toContain('catch');
  });

  it('dashboard screen uses the live inter-institution alerts service (LIVE-ALERTS-DASHBOARD-SUMMARY-A; generateExchangeAlerts summary widget replaced)', () => {
    expect(dashboard).toContain('getLiveInterInstitutionAlerts');
    expect(dashboard).not.toContain('generateExchangeAlerts');
  });

  it('dashboard screen shows top 3 recommendations for the separate local/material alert widget', () => {
    expect(dashboard).toContain('slice(0, 3)');
  });

  it('no transfer/approval buttons on dashboard', () => {
    expect(dashboard).not.toContain('approveTransfer');
    expect(dashboard).not.toContain('autoTransfer');
    expect(dashboard).not.toContain('createTransfer');
  });

  it('bilingual dashboard keys exist', () => {
    expect(strings).toContain('d_central');
    expect(strings).toContain('d_warehouses');
    expect(strings).toContain('d_ports');
    expect(strings).toContain('d_qr_active');
    expect(strings).toContain('d_qr_disabled');
    expect(strings).toContain('d_surplus');
    expect(strings).toContain('d_scarce');
    expect(strings).toContain('d_reports_active');
    expect(strings).toContain('d_exchange_total');
    expect(strings).toContain('d_exchange_high');
    expect(strings).toContain('d_no_data');
  });

  it('no service_role in dashboard', () => {
    expect(dashboard).not.toContain('service_role');
    expect(dashService).not.toContain('service_role');
  });

  it('institution cards navigate to institution screen (11)', () => {
    expect(dashboard).toContain('onNavigate(11)');
  });

  it('exchange-alert cards navigate to inter-institution alerts (13)', () => {
    // Bug fix: cards previously pointed to screen 12 (Status Center); correct target is 13
    expect(dashboard).toContain('onNavigate(13)');
    expect(dashboard).not.toMatch(/onClick\s*=\s*\{[^}]*onNavigate\(12\)/);
  });
});

describe('Hierarchical deletion wizard: safety', () => {
  const screen = readSrc('features/institutions/InstitutionScreen.tsx');
  const lifecycle = readSrc('shared/supabase/services/lifecycle.service.ts');
  const strings = readSrc('shared/i18n/strings.ts');
  const sql = readPhoenix('supabase/migrations/007_phoenix_clear_port_availability.sql');

  it('clear_port_availability RPC requires confirmation phrase', () => {
    expect(sql).toContain('CLEAR_PORT_ITEMS_');
    expect(sql).toContain('CONFIRMATION_MISMATCH');
  });

  it('clear_port_availability RPC checks auth.uid()', () => {
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('NOT_AUTHENTICATED');
  });

  it('clear_port_availability RPC enforces role', () => {
    expect(sql).toContain('INSUFFICIENT_ROLE');
    expect(sql).toContain("'super_admin', 'hospital_admin', 'warehouse_manager'");
  });

  it('clear_port_availability RPC enforces org scope', () => {
    expect(sql).toContain('FORBIDDEN_ORG');
  });

  it('clear_port_availability RPC writes audit log', () => {
    expect(sql).toContain('port_items_cleared');
    expect(sql).toContain('audit_logs');
  });

  it('clear_port_availability RPC does NOT delete distribution_points', () => {
    expect(sql).not.toMatch(/delete from distribution_points/i);
  });

  it('clear_port_availability RPC does NOT delete qr_tokens', () => {
    expect(sql).not.toMatch(/delete from qr_tokens/i);
  });

  it('screen has PortCleanupWizard component', () => {
    expect(screen).toContain('PortCleanupWizard');
  });

  it('screen has OrgCleanupWizard component', () => {
    expect(screen).toContain('OrgCleanupWizard');
  });

  it('OrgCleanupWizard only renders for super_admin', () => {
    expect(screen).toContain("if (!isSuper) return null");
  });

  it('PortCleanupWizard gated by canArchivePorts permission', () => {
    expect(screen).toContain('canArchivePorts');
  });

  it('org impact checks child dependencies', () => {
    expect(lifecycle).toContain('activeWarehouses');
    expect(lifecycle).toContain('activePorts');
    expect(lifecycle).toContain('activeQrTokens');
    expect(lifecycle).toContain('availabilityRows');
  });

  it('org canArchive requires all dependencies zero', () => {
    expect(lifecycle).toContain('canArchive');
    expect(lifecycle).toContain('wh === 0 && dp === 0 && qr === 0 && avail === 0');
  });

  it('org canPurge also requires profiles zero', () => {
    expect(lifecycle).toContain('canPurge');
    expect(lifecycle).toContain('profiles === 0');
  });

  it('archive org uses status=inactive (not raw delete)', () => {
    expect(lifecycle).toContain("status: 'inactive'");
    expect(lifecycle).not.toMatch(/\.from\(['"]organizations['"]\)\s*\.\s*delete/);
  });

  it('confirmation phrases required in wizard UI', () => {
    expect(screen).toContain('CLEAR PORT ITEMS');
    expect(screen).toContain('ARCHIVE ORGANIZATION');
  });

  it('bilingual deletion wizard keys exist', () => {
    expect(strings).toContain('dw_title');
    expect(strings).toContain('dw_clear_items');
    expect(strings).toContain('dw_clear_items_warn');
    expect(strings).toContain('dw_org_blocked');
    expect(strings).toContain('dw_users_safe');
    expect(strings).toContain('dw_archive_safe');
    expect(strings).toContain('dw_ready');
    expect(strings).toContain('dw_blocked');
  });

  it('no CASCADE in migration', () => {
    expect(sql).not.toContain('CASCADE');
  });

  it('no DROP in migration', () => {
    expect(sql).not.toContain('DROP');
  });

  it('no TRUNCATE in migration', () => {
    expect(sql).not.toContain('TRUNCATE');
  });

  it('no service_role in lifecycle service', () => {
    expect(lifecycle).not.toContain('service_role');
  });

  it('no DataReset restored', () => {
    expect(screen).not.toContain('DataReset');
    expect(lifecycle).not.toContain('DataReset');
  });
});

describe('Disabled modules remain disabled', () => {
  const frozen = readSrc('features/health/IntakeFrozenScreen.tsx');

  it('IntakeFrozenScreen still shows frozen state', () => {
    expect(frozen.toLowerCase()).toMatch(/frozen|مجمد|blocked|محظور/);
  });

  it('IntakeFrozenScreen does not import OCR/Excel/DocIntel', () => {
    expect(frozen).not.toMatch(/import.*[Oo]cr/);
    expect(frozen).not.toMatch(/import.*[Ee]xcel/);
    expect(frozen).not.toMatch(/import.*[Dd]oc[Ii]ntel/);
  });
});

describe('Hardening: hard-purge stays unreachable from the UI', () => {
  // purge_entity_with_all_data is super_admin-only + confirmation-gated in SQL,
  // but the frontend should never wire it into a screen. The wizard uses
  // archiveEntity / clearPortAvailability only. This guards against an
  // accidental future import re-exposing a destructive path through the UI.
  const screenFiles = [
    'features/institutions/InstitutionScreen.tsx',
    'features/dashboard/DashboardScreen.tsx',
    'features/status/StatusCenterScreen.tsx',
    'features/registry/RegistryScreen.tsx',
    'features/qr/QrScreen.tsx',
    'features/qr/PublicQrScreen.tsx',
  ];

  screenFiles.forEach(rel => {
    it(`${rel} does not import or call purgeEntityWithAllData`, () => {
      const content = readSrc(rel);
      expect(content).not.toContain('purgeEntityWithAllData');
      expect(content).not.toContain('purge_entity_with_all_data');
    });
  });

  it('the deletion wizard screen uses only archive/clear, not purge', () => {
    const screen = readSrc('features/institutions/InstitutionScreen.tsx');
    expect(screen).toContain('archiveEntity');
    expect(screen).not.toContain('purgeEntityWithAllData');
  });
});

describe('Hardening: manual migration documentation exists', () => {
  const doc = readPhoenix('docs/manual-supabase-migrations.md');

  it('documents applying 005, 006 and 007 manually', () => {
    expect(doc).toContain('005_phoenix_assign_profile_role.sql');
    expect(doc).toContain('006_phoenix_status_reports.sql');
    expect(doc).toContain('007_phoenix_clear_port_availability.sql');
    expect(doc.toLowerCase()).toContain('apply 005 manually');
    expect(doc.toLowerCase()).toContain('apply 006 manually');
    expect(doc.toLowerCase()).toContain('apply 007 manually');
  });

  it('warns to take a backup first and forbids db push', () => {
    expect(doc.toLowerCase()).toContain('backup');
    expect(doc).toContain('supabase db push');
    expect(doc.toLowerCase()).toContain('do not');
  });

  it('includes verification smoke tests after each migration', () => {
    expect(doc.toLowerCase()).toContain('smoke test');
    expect(doc).toContain('assign_profile_role');
    expect(doc).toContain('institution_item_status_reports');
    expect(doc).toContain('clear_port_availability');
  });
});
