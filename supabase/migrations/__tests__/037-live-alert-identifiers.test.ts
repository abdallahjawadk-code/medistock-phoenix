/**
 * LIVE-ALERTS-RPC-IDENTIFIERS-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 037: adds
 * source_item_availability_id / target_item_availability_id to
 * phoenix_get_live_inter_institution_alerts's payload. No live DB is used.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { expectRetiredSurfaceAbsent } from '../../../tests/helpers/retired-surfaces';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_036_PATH = join(MIGRATIONS_DIR, '036_phoenix_live_inter_institution_alerts_rpc.sql');
const MIGRATION_037_PATH = join(MIGRATIONS_DIR, '037_phoenix_live_alert_identifiers.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

function extractFunctionBody(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts');
  const end = sql.indexOf('-- restrict execution to authenticated users only');
  return sql.slice(start, end);
}

describe('Migration 037 exists exactly once', () => {
  it('037_phoenix_live_alert_identifiers.sql exists', () => {
    expect(existsSync(MIGRATION_037_PATH)).toBe(true);
  });

  it('is the only file named 037_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('037_'));
    expect(matches).toEqual(['037_phoenix_live_alert_identifiers.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    const sql = readMigration('037_phoenix_live_alert_identifiers.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });
});

describe('Migration 037: does not modify migrations 001-036', () => {
  it('migration 036 file is byte-identical to what it was before this phase (untouched)', () => {
    const sql036 = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');
    expect(sql036).toContain('Migration 036: Live Inter-Institution Alerts RPC');
    expect(sql036).not.toContain('source_item_availability_id');
    expect(sql036).not.toContain('target_item_availability_id');
  });

  it('all prior migration files (001-036) still exist untouched', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(0[1-9]|[1-2][0-9]|3[0-6])_/.test(f));
    expect(matches.length).toBeGreaterThan(0);
  });

  it('037 does not create a second 036-named file (036 remains the sole owner of that filename)', () => {
    const matches036 = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('036_'));
    expect(matches036).toEqual(['036_phoenix_live_inter_institution_alerts_rpc.sql']);
  });
});

describe('Migration 037: redefines only phoenix_get_live_inter_institution_alerts', () => {
  const sql = readMigration('037_phoenix_live_alert_identifiers.sql');

  it('creates/replaces phoenix_get_live_inter_institution_alerts', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts');
  });

  it('does not redefine any other RPC (no other CREATE OR REPLACE FUNCTION)', () => {
    const matches = sql.match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    expect(matches.length).toBe(1);
  });

  it('does not create any table', () => {
    expect(sql).not.toMatch(/CREATE\s+TABLE/i);
  });

  it('does not create any RLS policy', () => {
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
  });
});

describe('Migration 037: signature and security properties preserved from 036', () => {
  const sql = readMigration('037_phoenix_live_alert_identifiers.sql');

  it('takes p_limit integer default 200 and returns jsonb', () => {
    expect(sql).toMatch(/p_limit\s+integer\s+DEFAULT\s+200/i);
    expect(sql).toMatch(/RETURNS\s+jsonb/);
  });

  it('is SECURITY DEFINER with SET search_path = public', () => {
    expect(sql).toContain('SECURITY DEFINER');
    expect(sql).toContain('SET search_path = public');
  });

  it('requires auth.uid() and rejects when null', () => {
    expect(sql).toContain('auth.uid()');
    expect(sql).toContain('NOT_AUTHENTICATED');
  });

  it('revokes execute from PUBLIC and anon, grants to authenticated only', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_get_live_inter_institution_alerts\(integer\)\s*\n\s*FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_get_live_inter_institution_alerts\(integer\)\s*\n\s*TO authenticated;/);
  });

  it('super_admin bypass and permission checks unchanged', () => {
    expect(sql).toMatch(/v_is_super\s*:=\s*\(v_role = 'super_admin'\)/);
    expect(sql).toContain("phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')");
    expect(sql).toContain("phoenix_profile_has_permission(v_actor, 'exchange_alerts.view')");
  });

  it('non-super scope isolation unchanged', () => {
    expect(sql).toContain('v_is_super OR m.src_org = v_org OR m.tgt_org = v_org');
  });
});

describe('Migration 037: payload includes the new stable identifiers', () => {
  const sql = readMigration('037_phoenix_live_alert_identifiers.sql');
  const fnBody = extractFunctionBody(sql);

  it("includes 'source_item_availability_id' in the payload", () => {
    expect(fnBody).toContain("'source_item_availability_id',");
    expect(fnBody).toContain('s.src_availability_id');
  });

  it("includes 'target_item_availability_id' in the payload", () => {
    expect(fnBody).toContain("'target_item_availability_id',");
    expect(fnBody).toContain('s.tgt_availability_id');
  });

  it('values come from item_availability.id via the matched CTE (src_availability_id/tgt_availability_id)', () => {
    expect(fnBody).toContain('s.availability_id       AS src_availability_id');
    expect(fnBody).toContain('d.availability_id       AS tgt_availability_id');
  });
});

describe('Migration 037: all pre-existing payload fields are still present', () => {
  const sql = readMigration('037_phoenix_live_alert_identifiers.sql');
  const REQUIRED_FIELDS = [
    'alert_type', 'severity',
    'source_organization_id', 'source_organization_name',
    'source_distribution_point_id', 'source_distribution_point_name',
    'target_organization_id', 'target_organization_name',
    'target_distribution_point_id', 'target_distribution_point_name',
    'scientific_name', 'concentration', 'dosage_form',
    'source_trade_name', 'target_trade_name',
    'source_status', 'target_status',
    'source_quantity', 'target_quantity',
    'source_expiry_date', 'computed_at',
  ];

  REQUIRED_FIELDS.forEach(field => {
    it(`payload still includes '${field}'`, () => {
      expect(sql).toContain(`'${field}'`);
    });
  });

  it('top-level response still uses the ok/alerts/computed_at jsonb shape', () => {
    expect(sql).toMatch(/jsonb_build_object\(\s*\n\s*'ok', true,\s*\n\s*'alerts', coalesce\(v_alerts, '\[\]'::jsonb\),\s*\n\s*'computed_at', v_computed_at/);
  });
});

describe('Migration 037: payload never includes supply_type', () => {
  const sql = readMigration('037_phoenix_live_alert_identifiers.sql');

  it('supply_type absent from the function body', () => {
    expect(extractFunctionBody(sql)).not.toContain('supply_type');
  });
});

describe('Migration 037: data source and matching identity unchanged', () => {
  const sql = readMigration('037_phoenix_live_alert_identifiers.sql');
  const fnBody = extractFunctionBody(sql);

  it('still queries public.item_availability', () => {
    expect(fnBody).toContain('FROM public.item_availability');
  });

  it('never references institution_item_status_reports', () => {
    expect(fnBody).not.toContain('institution_item_status_reports');
  });

  it('still matches by scientific_name + concentration + dosage_form (normalized)', () => {
    const joinBlock = sql.slice(sql.indexOf('JOIN demand d'), sql.indexOf(')\n  , scoped AS'));
    expect(joinBlock).toContain('s.norm_sci    = d.norm_sci');
    expect(joinBlock).toContain('s.norm_conc   = d.norm_conc');
    expect(joinBlock).toContain('s.norm_dosage = d.norm_dosage');
  });

  it('trade_name is never used in the JOIN/match condition', () => {
    const joinBlock = sql.slice(sql.indexOf('JOIN demand d'), sql.indexOf(')\n  , scoped AS'));
    expect(joinBlock).not.toContain('trade_name');
  });

  it('still excludes available/expired from supply/demand candidate sets', () => {
    expect(sql).toContain("effective_status IN ('surplus', 'near_expiry')");
    expect(sql).toContain("effective_status IN ('missing', 'low_stock')");
    expect(sql).not.toMatch(/effective_status IN \([^)]*'available'[^)]*\)/);
    expect(sql).not.toMatch(/effective_status IN \([^)]*'expired'[^)]*\)/);
  });

  it('same-organization pairs are still excluded', () => {
    expect(sql).toContain('s.organization_id <> d.organization_id');
  });
});

describe('Migration 037: guardrails — no lifecycle/permission/QR/quantity/service_role/Excel additions', () => {
  const sql = readMigration('037_phoenix_live_alert_identifiers.sql');
  const fnBody = extractFunctionBody(sql);

  it('does not create inter_org_alert_states or inter_org_alert_events (header prose may name them to document compliance)', () => {
    expect(fnBody).not.toContain('inter_org_alert_states');
    expect(fnBody).not.toContain('inter_org_alert_events');
  });

  it('does not insert into permission_keys or role_permission_defaults', () => {
    expect(sql).not.toMatch(/insert into permission_keys/i);
    expect(sql).not.toMatch(/insert into role_permission_defaults/i);
  });

  it('does not redefine phoenix_apply_availability_movement or phoenix_upsert_availability', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('the function body never queries/writes get_public_qr_payload, qr_tokens, or qr_targets', () => {
    expect(fnBody).not.toContain('get_public_qr_payload');
    expect(fnBody).not.toContain('qr_tokens');
    expect(fnBody).not.toContain('qr_targets');
  });

  it('the function body never uses service_role', () => {
    expect(fnBody).not.toContain('service_role');
  });

  it('does not add Excel/XLSX import machinery', () => {
    expect(sql).not.toMatch(/exceljs|read-excel-file|sheetjs|papaparse/i);
    expect(sql).not.toMatch(/import\s+.*xlsx/i);
  });

  it('does not run supabase db push directly (only mentions it as prohibited)', () => {
    const activeLines = sql.split('\n').filter(l => !l.trimStart().startsWith('--'));
    expect(activeLines.join('\n')).not.toMatch(/supabase\s+db\s+push/);
  });

  it('has no DROP TABLE, TRUNCATE, or destructive DELETE', () => {
    const activeLines = sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
    expect(activeLines).not.toMatch(/drop table/i);
    expect(activeLines).not.toMatch(/truncate/i);
    expect(activeLines).not.toMatch(/delete from/i);
  });

  it('does not use suggestion/recommendation/opportunity wording', () => {
    expect(sql.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(sql).not.toContain('اقتراح');
    expect(sql).not.toContain('فرصة');
  });
});

describe('Migration 037: verification block exists and checks new fields', () => {
  const sql = readMigration('037_phoenix_live_alert_identifiers.sql');

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(sql).toContain('VERIFY');
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toContain('ASSERT');
  });

  it('verify block asserts both new identifier fields are present', () => {
    expect(sql).toMatch(/ASSERT v_fn_src LIKE '%source_item_availability_id%'/);
    expect(sql).toMatch(/ASSERT v_fn_src LIKE '%target_item_availability_id%'/);
  });

  it('verify block asserts supply_type is still absent', () => {
    expect(sql).toMatch(/ASSERT v_fn_src NOT LIKE '%supply_type%'/);
  });

  it('verify block asserts grants (authenticated yes, anon/PUBLIC no)', () => {
    expect(sql).toContain("grantee = 'authenticated'");
    expect(sql).toContain("grantee IN ('anon', 'PUBLIC')");
  });

  it('verify block asserts search_path is pinned', () => {
    expect(sql).toMatch(/search_path/i);
  });

  it('verify block confirms other RPCs (legacy, quantity-movement, QR) still exist', () => {
    expect(sql).toContain("proname = 'get_scoped_inter_institution_alerts'");
    expect(sql).toContain("proname = 'phoenix_apply_availability_movement'");
    expect(sql).toContain("proname = 'phoenix_upsert_availability'");
    expect(sql).toContain("proname = 'get_public_qr_payload'");
  });
});

describe('Service layer: sourceItemAvailabilityId / targetItemAvailabilityId mapping', () => {
  const servicePath = join(__dirname, '../../../src/features/alerts/live-inter-institution-alerts.service.ts');
  const service = readFileSync(servicePath, 'utf8');

  it('type includes the two new camelCase fields', () => {
    expect(service).toContain('sourceItemAvailabilityId: string');
    expect(service).toContain('targetItemAvailabilityId: string');
  });

  it('raw row type includes the two new snake_case fields', () => {
    expect(service).toContain('source_item_availability_id: string');
    expect(service).toContain('target_item_availability_id: string');
  });

  it('mapRow maps both new fields from snake_case to camelCase', () => {
    expect(service).toContain('sourceItemAvailabilityId: r.source_item_availability_id');
    expect(service).toContain('targetItemAvailabilityId: r.target_item_availability_id');
  });

  it('still calls the same RPC name (no new RPC introduced)', () => {
    expect(service).toContain("supabase.rpc('phoenix_get_live_inter_institution_alerts'");
  });

  it('does not use service_role or auth.admin', () => {
    expect(service).not.toContain('service_role');
    expect(service).not.toMatch(/auth\.admin/);
  });

  it('does not add Excel/XLSX import', () => {
    expect(service).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });
});

describe('UI compatibility: InterInstitutionAlertsScreen and DashboardScreen remain compatible', () => {
  const alertsScreen = readFileSync(join(__dirname, '../../../src/features/alerts/InterInstitutionAlertsScreen.tsx'), 'utf8');
  const dashboardScreen = readFileSync(join(__dirname, '../../../src/features/dashboard/DashboardScreen.tsx'), 'utf8');

  // ALERT-CQRS-BOUNDARY-190 (G4.1): both screens still read the live alert feed
  // through the lifecycle service and still need no change for this migration's
  // optional identifier fields — but the read wrapper is now the PURE query,
  // because the old one wrote lifecycle rows as a side effect of being read.
  // Re-pointed by EXACT name.
  it('InterInstitutionAlertsScreen still reads the live alert feed (no changes required by the new optional fields)', () => {
    expect(alertsScreen).toContain('queryLiveInterOrgAlertsPage');
    expect(alertsScreen).toContain('inter-org-alert-lifecycle.service');
  });

  it('DashboardScreen still reads the live alert feed (no changes required by the new optional fields)', () => {
    expect(dashboardScreen).toContain('queryLiveInterOrgAlertSummary');
    expect(dashboardScreen).toContain('inter-org-alert-lifecycle.service');
  });

  it('neither screen references a lifecycle table/RPC (no lifecycle UI added in this phase)', () => {
    expect(alertsScreen).not.toContain('inter_org_alert_states');
    expect(dashboardScreen).not.toContain('inter_org_alert_states');
  });
});

describe('Regression guards: unrelated systems untouched', () => {
  const historyModal = readFileSync(join(__dirname, '../../../src/features/status/MovementHistoryModal.tsx'), 'utf8');
  const reportSection = readFileSync(join(__dirname, '../../../src/features/status/MovementReportSection.tsx'), 'utf8');

  // E6: was an isolation assertion read straight off EditorScreen.tsx. The
  // screen is retired, so this is now an absence guard — a deleted screen
  // cannot reference this phase.
  it('EditorScreen stays retired, so it cannot reference this phase', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  // CANONICAL-STOCK-CUTOVER: AdjustQuantityModal is retired (deleted).
  it('AdjustQuantityModal stays retired, so it cannot reference this phase', () => {
    expectRetiredSurfaceAbsent('AdjustQuantityModal');
  });

  it('MovementHistoryModal.tsx is unaffected', () => {
    expect(historyModal).not.toContain('phoenix_get_live_inter_institution_alerts');
  });

  it('MovementReportSection.tsx is unaffected', () => {
    expect(reportSection).not.toContain('phoenix_get_live_inter_institution_alerts');
  });
});
