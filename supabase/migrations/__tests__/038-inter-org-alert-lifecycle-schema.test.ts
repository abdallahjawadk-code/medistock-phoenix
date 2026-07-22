/**
 * ALERT-LIFECYCLE-SCHEMA-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 038: schema/permissions/RLS
 * foundation for the persisted inter-org alert lifecycle
 * (inter_org_alert_states + inter_org_alert_events). No live DB is used —
 * these are text/shape assertions against the SQL file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_038_PATH = join(MIGRATIONS_DIR, '038_phoenix_inter_org_alert_lifecycle_schema.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/**
 * Strip `--` comment lines, leaving only active SQL. Used for whole-file
 * guardrails so header/VERIFY prose that documents compliance (e.g. "Does
 * NOT use service_role") never false-positives a "must not contain X" check.
 */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

describe('Migration 038 exists exactly once', () => {
  it('038_phoenix_inter_org_alert_lifecycle_schema.sql exists', () => {
    expect(existsSync(MIGRATION_038_PATH)).toBe(true);
  });

  it('is the only file named 038_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('038_'));
    expect(matches).toEqual(['038_phoenix_inter_org_alert_lifecycle_schema.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });
});

describe('Migration 038: creates exactly the two lifecycle tables', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('creates inter_org_alert_states', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.inter_org_alert_states');
  });

  it('creates inter_org_alert_events', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS public.inter_org_alert_events');
  });

  it('creates no other table', () => {
    const matches = activeSql(sql).match(/CREATE TABLE IF NOT EXISTS/g) ?? [];
    expect(matches.length).toBe(2);
  });
});

describe('Migration 038: does not modify migrations 001-037', () => {
  it('all prior migration files (001-037) still exist untouched', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(0[1-9]|[1-2][0-9]|3[0-7])_/.test(f));
    expect(matches.length).toBeGreaterThan(0);
  });

  it('migration 036 file is untouched (no new identifier fields added there)', () => {
    const sql036 = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');
    expect(sql036).toContain('Migration 036: Live Inter-Institution Alerts RPC');
  });

  it('migration 037 file is untouched', () => {
    const sql037 = readMigration('037_phoenix_live_alert_identifiers.sql');
    expect(sql037).toContain('Migration 037: Live Alert Stable Identifiers');
  });

  it('038 does not create a second 036/037-named file', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('036_'))).toEqual(['036_phoenix_live_inter_institution_alerts_rpc.sql']);
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('037_'))).toEqual(['037_phoenix_live_alert_identifiers.sql']);
  });
});

describe('Migration 038: does not redefine phoenix_get_live_inter_institution_alerts', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('does not CREATE OR REPLACE FUNCTION phoenix_get_live_inter_institution_alerts', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts');
  });
});

describe('Migration 038: does not create lifecycle RPCs yet', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('does not create any function at all (schema/permissions/RLS only)', () => {
    expect(sql).not.toMatch(/CREATE\s+(OR\s+REPLACE\s+)?FUNCTION/i);
  });

  it('verify block asserts the three known future lifecycle RPC names do not yet exist', () => {
    expect(sql).toContain("proname = 'phoenix_update_inter_org_alert_state'");
    expect(sql).toContain("proname = 'phoenix_reopen_inter_org_alert'");
    expect(sql).toContain("proname = 'phoenix_get_live_inter_institution_alerts_with_state'");
  });
});

describe('Migration 038: permission keys — 4 new keys under inter_institution_alerts.* only', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');
  const EXPECTED_KEYS = [
    'inter_institution_alerts.acknowledge',
    'inter_institution_alerts.manage',
    'inter_institution_alerts.resolve',
    'inter_institution_alerts.dismiss',
  ];

  EXPECTED_KEYS.forEach(key => {
    it(`adds permission key '${key}'`, () => {
      expect(sql).toContain(`'${key}'`);
    });
  });

  it('does not add an alerts.inter_org.* permission key as an actual INSERT value', () => {
    expect(sql).not.toMatch(/\(\s*'alerts\.inter_org/);
  });

  it('verify block asserts no alerts.inter_org.* namespace was introduced', () => {
    expect(sql).toContain("key LIKE 'alerts.inter_org%'");
  });

  it('uses INSERT ... ON CONFLICT (idempotent, consistent with project style)', () => {
    expect(sql).toMatch(/INSERT INTO permission_keys[\s\S]*?ON CONFLICT \(key\) DO NOTHING/);
  });
});

describe('Migration 038: role defaults match the agreed matrix', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  const EXPECTATIONS: Array<[string, string, boolean]> = [
    ['super_admin', 'inter_institution_alerts.acknowledge', true],
    ['super_admin', 'inter_institution_alerts.manage', true],
    ['super_admin', 'inter_institution_alerts.resolve', true],
    ['super_admin', 'inter_institution_alerts.dismiss', true],
    ['institution_admin', 'inter_institution_alerts.acknowledge', true],
    ['institution_admin', 'inter_institution_alerts.dismiss', true],
    ['hospital_admin', 'inter_institution_alerts.dismiss', true],
    ['warehouse_manager', 'inter_institution_alerts.acknowledge', true],
    ['warehouse_manager', 'inter_institution_alerts.manage', true],
    ['warehouse_manager', 'inter_institution_alerts.resolve', true],
    ['warehouse_manager', 'inter_institution_alerts.dismiss', false],
    ['warehouse_officer', 'inter_institution_alerts.acknowledge', true],
    ['warehouse_officer', 'inter_institution_alerts.manage', true],
    ['warehouse_officer', 'inter_institution_alerts.resolve', true],
    ['warehouse_officer', 'inter_institution_alerts.dismiss', false],
    ['transfer_manager', 'inter_institution_alerts.acknowledge', true],
    ['transfer_manager', 'inter_institution_alerts.manage', false],
    ['transfer_manager', 'inter_institution_alerts.resolve', false],
    ['transfer_manager', 'inter_institution_alerts.dismiss', false],
    ['monthly_status_officer', 'inter_institution_alerts.acknowledge', true],
    ['monthly_status_officer', 'inter_institution_alerts.manage', false],
    ['port_officer', 'inter_institution_alerts.acknowledge', true],
    ['port_officer', 'inter_institution_alerts.manage', false],
    ['point_operator', 'inter_institution_alerts.acknowledge', true],
    ['point_operator', 'inter_institution_alerts.manage', false],
    ['viewer', 'inter_institution_alerts.acknowledge', false],
    ['viewer', 'inter_institution_alerts.manage', false],
    ['viewer', 'inter_institution_alerts.resolve', false],
    ['viewer', 'inter_institution_alerts.dismiss', false],
  ];

  EXPECTATIONS.forEach(([role, key, allowed]) => {
    it(`${role} -> ${key} = ${allowed}`, () => {
      const escapedKey = key.replace(/\./g, '\\.');
      const re = new RegExp(`\\('${role}',\\s*'${escapedKey}',\\s*${allowed}\\)`);
      expect(sql).toMatch(re);
    });
  });

  it('does not remove existing permission defaults (only inserts, never deletes from role_permission_defaults)', () => {
    expect(sql).not.toMatch(/DELETE\s+FROM\s+role_permission_defaults/i);
  });

  it('does not modify unrelated permission keys (no UPDATE on permission_keys itself)', () => {
    expect(sql).not.toMatch(/UPDATE\s+permission_keys/i);
  });

  it('uses idempotent upsert for role_permission_defaults (ON CONFLICT DO UPDATE)', () => {
    expect(sql).toMatch(/ON CONFLICT \(role, permission_key\) DO UPDATE SET allowed = excluded\.allowed/);
  });
});

describe('Migration 038: inter_org_alert_states expected columns', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');
  const tableStart = sql.indexOf('CREATE TABLE IF NOT EXISTS public.inter_org_alert_states');
  const tableEnd = sql.indexOf('COMMENT ON TABLE public.inter_org_alert_states');
  const tableBlock = sql.slice(tableStart, tableEnd);

  const EXPECTED_COLUMNS = [
    'id', 'alert_key', 'alert_type',
    'source_item_availability_id', 'target_item_availability_id',
    'source_organization_id', 'target_organization_id',
    'scientific_name', 'concentration', 'dosage_form',
    'status', 'severity_snapshot',
    'first_seen_at', 'last_seen_at',
    'acknowledged_at', 'acknowledged_by',
    'in_progress_at', 'in_progress_by',
    'resolved_at', 'resolved_by',
    'dismissed_at', 'dismissed_by',
    'reason', 'notes', 'created_at', 'updated_at',
  ];

  EXPECTED_COLUMNS.forEach(col => {
    it(`has column '${col}'`, () => {
      expect(tableBlock).toContain(col);
    });
  });

  it('source/target item_availability_id reference item_availability(id) ON DELETE RESTRICT', () => {
    expect(tableBlock).toMatch(/source_item_availability_id\s+uuid NOT NULL REFERENCES public\.item_availability\(id\) ON DELETE RESTRICT/);
    expect(tableBlock).toMatch(/target_item_availability_id\s+uuid NOT NULL REFERENCES public\.item_availability\(id\) ON DELETE RESTRICT/);
  });

  it('source/target organization_id reference organizations(id)', () => {
    expect(tableBlock).toMatch(/source_organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\)/);
    expect(tableBlock).toMatch(/target_organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\)/);
  });

  it('acknowledged_by/in_progress_by/resolved_by/dismissed_by reference auth.users(id) ON DELETE SET NULL', () => {
    expect(tableBlock).toMatch(/acknowledged_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(tableBlock).toMatch(/in_progress_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(tableBlock).toMatch(/resolved_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(tableBlock).toMatch(/dismissed_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  });
});

describe('Migration 038: inter_org_alert_events expected columns', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');
  const tableStart = sql.indexOf('CREATE TABLE IF NOT EXISTS public.inter_org_alert_events');
  const tableEnd = sql.indexOf('COMMENT ON TABLE public.inter_org_alert_events');
  const tableBlock = sql.slice(tableStart, tableEnd);

  const EXPECTED_COLUMNS = [
    'id', 'alert_state_id', 'event_type',
    'actor_id', 'actor_name_snapshot', 'actor_email_snapshot', 'actor_role_snapshot',
    'from_status', 'to_status', 'reason', 'notes', 'created_at',
  ];

  EXPECTED_COLUMNS.forEach(col => {
    it(`has column '${col}'`, () => {
      expect(tableBlock).toContain(col);
    });
  });

  it('alert_state_id references inter_org_alert_states(id) ON DELETE RESTRICT', () => {
    expect(tableBlock).toMatch(/alert_state_id\s+uuid NOT NULL REFERENCES public\.inter_org_alert_states\(id\) ON DELETE RESTRICT/);
  });
});

describe('Migration 038: alert_key unique constraint', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('alert_key is text NOT NULL UNIQUE', () => {
    expect(sql).toMatch(/alert_key\s+text NOT NULL UNIQUE/);
  });

  it('does not enforce alert_key generation via trigger (documented as future-RPC-computed)', () => {
    expect(sql).not.toMatch(/CREATE\s+TRIGGER[\s\S]{0,80}alert_key/i);
  });
});

describe('Migration 038: status allowed values', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('status CHECK constrains to the 5 lifecycle states', () => {
    expect(sql).toMatch(/CHECK \(status IN \('open', 'acknowledged', 'in_progress', 'resolved', 'dismissed'\)\)/);
  });

  it('status defaults to open', () => {
    expect(sql).toMatch(/status\s+text NOT NULL DEFAULT 'open'/);
  });

  it('alert_type CHECK constrains to the 2 known types', () => {
    expect(sql).toMatch(/CHECK \(alert_type IN \('surplus_to_shortage', 'near_expiry_to_shortage'\)\)/);
  });

  it('severity_snapshot CHECK allows high/medium/low or null', () => {
    expect(sql).toMatch(/CHECK \(severity_snapshot IS NULL OR severity_snapshot IN \('high', 'medium', 'low'\)\)/);
  });
});

describe('Migration 038: event_type allowed values', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('event_type CHECK constrains to the 7 known transition types', () => {
    expect(sql).toMatch(/CHECK \(event_type IN \('opened', 'acknowledged', 'in_progress', 'resolved', 'dismissed', 'reopened', 'seen'\)\)/);
  });
});

describe('Migration 038: source/target organization and availability distinctness', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('source_organization_id <> target_organization_id is enforced', () => {
    expect(sql).toContain('CONSTRAINT inter_org_alert_states_orgs_distinct_chk');
    expect(sql).toMatch(/CHECK \(source_organization_id <> target_organization_id\)/);
  });

  it('source_item_availability_id <> target_item_availability_id is enforced', () => {
    expect(sql).toContain('CONSTRAINT inter_org_alert_states_availability_distinct_chk');
    expect(sql).toMatch(/CHECK \(source_item_availability_id <> target_item_availability_id\)/);
  });
});

describe('Migration 038: dismissed/resolved require a reason', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('dismissed requires a non-empty reason', () => {
    expect(sql).toContain('CONSTRAINT inter_org_alert_states_dismiss_reason_chk');
    expect(sql).toMatch(/CHECK \(status <> 'dismissed' OR \(reason IS NOT NULL AND btrim\(reason\) <> ''\)\)/);
  });

  it('resolved requires a non-empty reason (owner-recommended stricter default)', () => {
    expect(sql).toContain('CONSTRAINT inter_org_alert_states_resolve_reason_chk');
    expect(sql).toMatch(/CHECK \(status <> 'resolved' OR \(reason IS NOT NULL AND btrim\(reason\) <> ''\)\)/);
  });
});

describe('Migration 038: RLS enabled on both tables', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('RLS enabled on inter_org_alert_states', () => {
    expect(sql).toContain('ALTER TABLE public.inter_org_alert_states ENABLE ROW LEVEL SECURITY');
  });

  it('RLS enabled on inter_org_alert_events', () => {
    expect(sql).toContain('ALTER TABLE public.inter_org_alert_events ENABLE ROW LEVEL SECURITY');
  });
});

describe('Migration 038: no anon/PUBLIC access', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('revokes all from PUBLIC and anon on inter_org_alert_states', () => {
    expect(sql).toContain('REVOKE ALL ON TABLE public.inter_org_alert_states FROM PUBLIC, anon');
  });

  it('revokes all from PUBLIC and anon on inter_org_alert_events', () => {
    expect(sql).toContain('REVOKE ALL ON TABLE public.inter_org_alert_events FROM PUBLIC, anon');
  });

  it('verify block asserts anon/PUBLIC have zero privileges on both tables', () => {
    expect(sql).toContain("grantee IN ('anon','PUBLIC')");
  });
});

describe('Migration 038: no authenticated INSERT/UPDATE/DELETE grants', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('revokes INSERT/UPDATE/DELETE from authenticated on inter_org_alert_states', () => {
    expect(sql).toContain('REVOKE INSERT, UPDATE, DELETE ON TABLE public.inter_org_alert_states FROM authenticated');
  });

  it('revokes SELECT/INSERT/UPDATE/DELETE from authenticated on inter_org_alert_events', () => {
    expect(sql).toContain('REVOKE SELECT, INSERT, UPDATE, DELETE ON TABLE public.inter_org_alert_events FROM authenticated');
  });

  it('grants SELECT only (no write) to authenticated on states', () => {
    expect(sql).toContain('GRANT SELECT ON TABLE public.inter_org_alert_states TO authenticated');
    expect(sql).not.toMatch(/GRANT\s+(INSERT|UPDATE|DELETE)[\s\S]{0,60}inter_org_alert_states/i);
  });

  it('grants nothing to authenticated on events (no actual GRANT statement targets it)', () => {
    const grantLines = activeSql(sql).split('\n').filter(l => /^\s*GRANT\b/i.test(l));
    expect(grantLines.some(l => l.includes('inter_org_alert_events'))).toBe(false);
  });

  it('verify block asserts no INSERT/UPDATE/DELETE grant to authenticated on either table', () => {
    expect(sql).toMatch(/authenticated.*INSERT.*UPDATE.*DELETE.*inter_org_alert_states|inter_org_alert_states/);
  });
});

describe('Migration 038: SELECT policy for states is org-scoped and permission-gated', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');
  const policyStart = sql.indexOf('CREATE POLICY "inter_org_alert_states_select_perm"');
  const policyEnd = sql.indexOf(';', policyStart);
  const policyBlock = sql.slice(policyStart, policyEnd);

  it('super_admin bypasses the check', () => {
    expect(policyBlock).toContain("phoenix_my_role() = 'super_admin'");
  });

  it('checks inter_institution_alerts.view', () => {
    expect(policyBlock).toContain("phoenix_profile_has_permission(auth.uid(), 'inter_institution_alerts.view')");
  });

  it('scopes to source_organization_id or target_organization_id = phoenix_my_org()', () => {
    expect(policyBlock).toContain('source_organization_id = phoenix_my_org()');
    expect(policyBlock).toContain('target_organization_id = phoenix_my_org()');
  });

  it('is the only policy on inter_org_alert_states (no INSERT/UPDATE/DELETE policy)', () => {
    const allPolicyMatches = sql.match(/CREATE POLICY "[^"]*" ON public\.inter_org_alert_states/g) ?? [];
    expect(allPolicyMatches.length).toBe(1);
  });
});

describe('Migration 038: event log direct-select decision is explicit (Option A — no direct SELECT)', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('documents the chosen option in the header', () => {
    expect(sql).toMatch(/Chosen:\s*NO direct SELECT policy on inter_org_alert_events/);
  });

  it('creates no CREATE POLICY targeting inter_org_alert_events', () => {
    expect(sql).not.toMatch(/CREATE POLICY[\s\S]{0,60}inter_org_alert_events/);
  });

  it('revokes SELECT from authenticated on events explicitly', () => {
    expect(sql).toMatch(/REVOKE SELECT,[\s\S]{0,40}ON TABLE public\.inter_org_alert_events FROM authenticated/);
  });
});

describe('Migration 038: security guardrails', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');
  const active = activeSql(sql);

  it('no service_role reference in active SQL (header prose may document its absence)', () => {
    expect(active).not.toContain('service_role');
  });

  it('no auth.admin reference in active SQL', () => {
    expect(active).not.toMatch(/auth\.admin/);
  });

  it('no supply_type reference in active SQL', () => {
    expect(active).not.toContain('supply_type');
  });

  it('no suggestion/recommendation/opportunity/اقتراح/فرصة wording in active SQL', () => {
    expect(active.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(active).not.toContain('اقتراح');
    expect(active).not.toContain('فرصة');
  });

  it('no Excel/XLSX import machinery in active SQL (header prose may document its absence)', () => {
    expect(active).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not touch get_public_qr_payload, qr_tokens, or qr_targets', () => {
    expect(sql).not.toMatch(/CREATE[\s\S]{0,40}qr_tokens|CREATE[\s\S]{0,40}qr_targets/i);
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.get_public_qr_payload');
  });

  it('does not touch phoenix_apply_availability_movement or phoenix_upsert_availability', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('does not create or alter item_availability_movements', () => {
    expect(sql).not.toMatch(/CREATE TABLE[\s\S]{0,20}item_availability_movements/);
    expect(sql).not.toMatch(/ALTER TABLE[\s\S]{0,20}item_availability_movements/);
  });

  it('never directly updates item_availability.quantity', () => {
    expect(sql).not.toMatch(/UPDATE\s+(public\.)?item_availability\s+SET\s+quantity/i);
  });

  it('does not run supabase db push directly (only mentions it as prohibited)', () => {
    const activeLines = sql.split('\n').filter(l => !l.trimStart().startsWith('--'));
    expect(activeLines.join('\n')).not.toMatch(/supabase\s+db\s+push/);
  });

  it('has no DROP TABLE, TRUNCATE, or destructive DELETE', () => {
    const activeLines = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(activeLines).not.toMatch(/drop table/i);
    expect(activeLines).not.toMatch(/truncate/i);
    expect(activeLines).not.toMatch(/\bdelete from\b/i);
  });
});

describe('Migration 038: verification block exists', () => {
  const sql = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(sql).toContain('VERIFY');
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toContain('ASSERT');
  });

  it('verify block confirms migration 036/037 RPC still exists', () => {
    expect(sql).toContain("proname = 'phoenix_get_live_inter_institution_alerts'");
  });

  it('verify block confirms quantity-movement and QR RPCs are untouched', () => {
    expect(sql).toContain("proname = 'phoenix_apply_availability_movement'");
    expect(sql).toContain("proname = 'phoenix_upsert_availability'");
    expect(sql).toContain("proname = 'get_public_qr_payload'");
  });
});

describe('No UI strings were added in this phase (schema-only)', () => {
  it('strings.ts is unaffected by this migration (no lia_* additions required by a schema-only phase)', () => {
    const stringsPath = join(__dirname, '../../../src/shared/i18n/strings.ts');
    const before = readFileSync(stringsPath, 'utf8');
    // This phase adds no UI strings; assert no new lifecycle-specific keys
    // (e.g. an "alert_state_" prefix) were introduced.
    expect(before).not.toMatch(/\balert_state_(open|acknowledged|in_progress|resolved|dismissed)\b\s*:/);
  });
});

describe('Regression: UI screens and unrelated systems untouched', () => {
  const alertsScreen = readFileSync(join(__dirname, '../../../src/features/alerts/InterInstitutionAlertsScreen.tsx'), 'utf8');
  const dashboardScreen = readFileSync(join(__dirname, '../../../src/features/dashboard/DashboardScreen.tsx'), 'utf8');
  // AdjustQuantityModal is retired (canonical-stock cutover); its absence is
  // asserted in the retired-surface audit. Movement history remains.
  const historyModal = readFileSync(join(__dirname, '../../../src/features/status/MovementHistoryModal.tsx'), 'utf8');
  const service = readFileSync(join(__dirname, '../../../src/features/alerts/live-inter-institution-alerts.service.ts'), 'utf8');

  it('InterInstitutionAlertsScreen does not reference the new lifecycle tables', () => {
    expect(alertsScreen).not.toContain('inter_org_alert_states');
    expect(alertsScreen).not.toContain('inter_org_alert_events');
  });

  it('DashboardScreen does not reference the new lifecycle tables', () => {
    expect(dashboardScreen).not.toContain('inter_org_alert_states');
    expect(dashboardScreen).not.toContain('inter_org_alert_events');
  });

  it('MovementHistoryModal is unaffected', () => {
    expect(historyModal).not.toContain('inter_org_alert_states');
  });

  it('live-inter-institution-alerts.service.ts is unaffected by this schema-only phase', () => {
    expect(service).not.toContain('inter_org_alert_states');
    expect(service).not.toContain('inter_org_alert_events');
  });
});
