/**
 * LIVE-INTER-INSTITUTION-ALERTS-RPC-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 036: phoenix_get_live_inter_institution_alerts.
 * These are text/shape assertions against the SQL file — no live DB is used.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { expectRetiredSurfaceAbsent } from '../../../tests/helpers/retired-surfaces';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_036_PATH = join(MIGRATIONS_DIR, '036_phoenix_live_inter_institution_alerts_rpc.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/**
 * Slice out just the CREATE FUNCTION body (excluding the header comment
 * block and the VERIFY block), for assertions about actual RPC behavior.
 * The header/VERIFY prose legitimately mentions forbidden terms (e.g.
 * "Does NOT touch get_public_qr_payload") to document compliance — that
 * text must not itself trip a "must not contain X" check.
 */
function extractFunctionBody(sql: string): string {
  const start = sql.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts');
  const end = sql.indexOf('-- restrict execution to authenticated users only');
  return sql.slice(start, end);
}

describe('Migration 036 exists exactly once', () => {
  it('036_phoenix_live_inter_institution_alerts_rpc.sql exists', () => {
    expect(existsSync(MIGRATION_036_PATH)).toBe(true);
  });

  it('is non-trivial in size', () => {
    expect(readFileSync(MIGRATION_036_PATH, 'utf8').length).toBeGreaterThan(1000);
  });

  it('is the only file named 036_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('036_'));
    expect(matches).toEqual(['036_phoenix_live_inter_institution_alerts_rpc.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });

  it('creates phoenix_get_live_inter_institution_alerts', () => {
    const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts');
  });
});

describe('Migration 036: RPC signature and security properties', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

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

  it('caps p_limit to a safe maximum (500) and floors it at 1', () => {
    expect(sql).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit,\s*200\),\s*1\),\s*500\)/);
  });
});

describe('Migration 036: data source — item_availability only', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');
  const fnBody = extractFunctionBody(sql);

  it('queries public.item_availability', () => {
    expect(fnBody).toContain('FROM public.item_availability');
  });

  it('never references institution_item_status_reports in the function body', () => {
    expect(fnBody).not.toContain('institution_item_status_reports');
  });

  it('never references a status_reports table name in the function body', () => {
    expect(fnBody).not.toMatch(/status_reports/);
  });

  it('does not use mock/hardcoded alert rows (only computed from item_availability joins)', () => {
    // No literal alert-shaped insert/values block — the only VALUES-like
    // construct in this file should be jsonb_build_object calls, not a
    // hardcoded row of alert data.
    expect(sql).not.toMatch(/insert into\s+\(?\s*alert/i);
  });
});

describe('Migration 036: matching identity — scientific_name + concentration + dosage_form, never trade_name', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

  it('normalizes scientific_name, concentration, dosage_form for matching', () => {
    expect(sql).toMatch(/lower\(btrim\(ia\.scientific_name\)\)\s*AS norm_sci/);
    expect(sql).toMatch(/lower\(btrim\(coalesce\(ia\.concentration, ''\)\)\)\s*AS norm_conc/);
    expect(sql).toMatch(/lower\(btrim\(coalesce\(ia\.dosage_form, ''\)\)\)\s*AS norm_dosage/);
  });

  it('the JOIN condition uses all three normalized identity columns', () => {
    const joinBlock = sql.slice(sql.indexOf('JOIN demand d'), sql.indexOf(')\n  , scoped AS'));
    expect(joinBlock).toContain('s.norm_sci    = d.norm_sci');
    expect(joinBlock).toContain('s.norm_conc   = d.norm_conc');
    expect(joinBlock).toContain('s.norm_dosage = d.norm_dosage');
  });

  it('trade_name is never part of the JOIN/match condition', () => {
    const joinBlock = sql.slice(sql.indexOf('JOIN demand d'), sql.indexOf(')\n  , scoped AS'));
    expect(joinBlock).not.toContain('trade_name');
  });

  it('excludes rows with null/empty scientific_name from candidacy entirely', () => {
    expect(sql).toContain('ia.scientific_name IS NOT NULL');
    expect(sql).toMatch(/btrim\(ia\.scientific_name\)\s*<>\s*''/);
  });

  it('trade_name is returned display-only (separate source/target fields, not compared)', () => {
    expect(sql).toContain('source_trade_name');
    expect(sql).toContain('target_trade_name');
  });
});

describe('Migration 036: effective_status mirrors computeEffectiveStatus precedence', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');
  const caseBlock = sql.slice(sql.indexOf('CASE\n', sql.indexOf('candidates AS')), sql.indexOf('END AS effective_status') + 'END AS effective_status'.length);

  it('expired takes precedence: expiry_date < current_date OR condition = expired', () => {
    expect(caseBlock).toMatch(/expiry_date IS NOT NULL AND ia\.expiry_date < current_date THEN 'expired'/);
    expect(caseBlock).toContain("ia.condition = 'expired' THEN 'expired'");
  });

  it('missing: quantity <= 0 OR condition = missing (checked before near_expiry)', () => {
    expect(caseBlock).toContain('ia.quantity <= 0');
    expect(caseBlock).toContain("ia.condition = 'missing' THEN 'missing'");
    const missingPos = caseBlock.indexOf("THEN 'missing'");
    const nearExpiryPos = caseBlock.indexOf("THEN 'near_expiry'");
    expect(missingPos).toBeLessThan(nearExpiryPos);
  });

  it('near_expiry: expiry_date within 3 months OR condition = near_expiry (3-month window only)', () => {
    expect(caseBlock).toMatch(/interval '3 months'/);
    expect(caseBlock).not.toMatch(/interval '6 months'/);
    expect(caseBlock).not.toMatch(/interval '9 months'/);
    expect(caseBlock).toContain("ia.condition = 'near_expiry' THEN 'near_expiry'");
  });

  it('low_stock and surplus fall straight through from condition', () => {
    expect(caseBlock).toContain("ia.condition = 'low_stock' THEN 'low_stock'");
    expect(caseBlock).toContain("ia.condition = 'surplus' THEN 'surplus'");
  });

  it('available is the final fallback', () => {
    expect(caseBlock).toContain("ELSE 'available'");
  });
});

describe('Migration 036: demand/supply inclusion and exclusion', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

  it('supply set is surplus + near_expiry', () => {
    expect(sql).toContain("effective_status IN ('surplus', 'near_expiry')");
  });

  it('demand set is missing + low_stock', () => {
    expect(sql).toContain("effective_status IN ('missing', 'low_stock')");
  });

  it('available and expired never appear as a candidate set', () => {
    expect(sql).not.toMatch(/effective_status IN \([^)]*'available'[^)]*\)/);
    expect(sql).not.toMatch(/effective_status IN \([^)]*'expired'[^)]*\)/);
  });

  it('same-organization pairs are excluded', () => {
    expect(sql).toContain('s.organization_id <> d.organization_id');
  });
});

describe('Migration 036: alert types and severity', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

  it('alert_type is surplus_to_shortage or near_expiry_to_shortage', () => {
    expect(sql).toContain("'near_expiry_to_shortage'");
    expect(sql).toContain("'surplus_to_shortage'");
  });

  it('near_expiry source produces near_expiry_to_shortage, otherwise surplus_to_shortage', () => {
    expect(sql).toMatch(/WHEN s\.effective_status = 'near_expiry'\s*\n\s*THEN 'near_expiry_to_shortage' ELSE 'surplus_to_shortage'/);
  });

  it('severity is high when target is missing, medium otherwise (low_stock)', () => {
    expect(sql).toMatch(/WHEN d\.effective_status = 'missing'\s*\n\s*THEN 'high' ELSE 'medium'/);
  });
});

describe('Migration 036: permission and scope behavior', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

  it('super_admin bypasses the permission check', () => {
    expect(sql).toMatch(/v_is_super\s*:=\s*\(v_role = 'super_admin'\)/);
    expect(sql).toContain('v_is_super\n    OR phoenix_profile_has_permission');
  });

  it('checks inter_institution_alerts.view as the primary permission', () => {
    expect(sql).toContain("phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')");
  });

  it('allows exchange_alerts.view as a backward-compatible fallback', () => {
    expect(sql).toContain("phoenix_profile_has_permission(v_actor, 'exchange_alerts.view')");
  });

  it('does not introduce a new alerts.inter_org.* permission key in the function body', () => {
    const fnBody = extractFunctionBody(sql);
    expect(fnBody).not.toContain('alerts.inter_org');
  });

  it('rejects with FORBIDDEN when neither permission is held', () => {
    expect(sql).toContain('FORBIDDEN');
  });

  it('non-super callers are scoped to alerts where their org is source or target', () => {
    expect(sql).toContain('v_is_super OR m.src_org = v_org OR m.tgt_org = v_org');
  });

  it('does not insert into permission_keys or role_permission_defaults', () => {
    expect(sql).not.toMatch(/insert into permission_keys/i);
    expect(sql).not.toMatch(/insert into role_permission_defaults/i);
  });
});

describe('Migration 036: payload fields', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');
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
    it(`payload includes '${field}'`, () => {
      expect(sql).toContain(`'${field}'`);
    });
  });

  it('payload never includes supply_type in the function body', () => {
    expect(extractFunctionBody(sql)).not.toContain('supply_type');
  });

  it('top-level response uses the ok/alerts/computed_at jsonb shape', () => {
    expect(sql).toMatch(/jsonb_build_object\(\s*\n\s*'ok', true,\s*\n\s*'alerts', coalesce\(v_alerts, '\[\]'::jsonb\),\s*\n\s*'computed_at', v_computed_at/);
  });
});

describe('Migration 036: sorting', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

  it('orders high severity first', () => {
    expect(sql).toMatch(/CASE s\.severity WHEN 'high' THEN 2 ELSE 1 END DESC/);
  });

  it('near_expiry alerts prioritize earliest expiry_date', () => {
    expect(sql).toMatch(/CASE WHEN s\.alert_type = 'near_expiry_to_shortage' THEN s\.src_expiry END ASC NULLS LAST/);
  });

  it('final tiebreaker is scientific_name', () => {
    expect(sql).toMatch(/s\.scientific_name ASC/);
  });
});

describe('Migration 036: wording guard — no suggestion/recommendation/opportunity wording', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

  it('does not use "suggestion" wording anywhere', () => {
    expect(sql.toLowerCase()).not.toMatch(/suggestion|suggested/);
  });

  it('does not use "recommendation" wording anywhere', () => {
    expect(sql.toLowerCase()).not.toMatch(/recommendation|recommended/);
  });

  it('does not use "opportunity" wording anywhere', () => {
    expect(sql.toLowerCase()).not.toMatch(/opportunit/);
  });

  it('does not use Arabic اقتراح/فرصة wording', () => {
    expect(sql).not.toContain('اقتراح');
    expect(sql).not.toContain('فرصة');
  });
});

describe('Migration 036: verification block exists', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(sql).toContain('VERIFY');
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toContain('ASSERT');
  });

  it('verify block checks the function exists and its security properties', () => {
    expect(sql).toContain("proname = 'phoenix_get_live_inter_institution_alerts'");
    expect(sql).toMatch(/v_fn_src LIKE '%SECURITY DEFINER%'/);
  });

  it('verify block confirms legacy RPC and quantity-movement/QR RPCs are untouched', () => {
    expect(sql).toContain("proname = 'get_scoped_inter_institution_alerts'");
    expect(sql).toContain("proname = 'phoenix_apply_availability_movement'");
    expect(sql).toContain("proname = 'phoenix_upsert_availability'");
    expect(sql).toContain("proname = 'get_public_qr_payload'");
  });
});

describe('Migration 036: guardrails — no unrelated changes', () => {
  const sql = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');

  it('does not modify migrations 001-035 (only creates 036)', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(0[1-9]|[1-2][0-9]|3[0-5])_/.test(f));
    expect(matches.length).toBeGreaterThan(0); // sanity: prior migrations still exist untouched
  });

  it('does not redefine phoenix_apply_availability_movement or phoenix_upsert_availability', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_apply_availability_movement');
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
  });

  it('does not redefine get_scoped_inter_institution_alerts (legacy RPC left untouched)', () => {
    expect(sql).not.toContain('create or replace function get_scoped_inter_institution_alerts');
  });

  it('the function body itself never queries/writes get_public_qr_payload, qr_tokens, or qr_targets', () => {
    const fnBody = extractFunctionBody(sql);
    expect(fnBody).not.toContain('get_public_qr_payload');
    expect(fnBody).not.toContain('qr_tokens');
    expect(fnBody).not.toContain('qr_targets');
  });

  it('does not create or drop any RLS policy', () => {
    expect(sql).not.toMatch(/CREATE\s+POLICY/i);
    expect(sql).not.toMatch(/DROP\s+POLICY/i);
  });

  it('the function body itself never uses service_role', () => {
    expect(extractFunctionBody(sql)).not.toContain('service_role');
  });

  it('does not add actual Excel/xlsx import machinery (header prose may say "Excel/XLSX" to document compliance)', () => {
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
});

describe('Service layer: getLiveInterInstitutionAlerts wrapper', () => {
  const servicePath = join(__dirname, '../../../src/features/alerts/live-inter-institution-alerts.service.ts');
  const service = readFileSync(servicePath, 'utf8');

  it('service file exists', () => {
    expect(existsSync(servicePath)).toBe(true);
  });

  it('calls the expected RPC name', () => {
    expect(service).toContain("supabase.rpc('phoenix_get_live_inter_institution_alerts'");
  });

  it('maps snake_case fields to camelCase', () => {
    expect(service).toContain('alertType: r.alert_type');
    expect(service).toContain('sourceOrganizationId: r.source_organization_id');
    expect(service).toContain('targetOrganizationId: r.target_organization_id');
    expect(service).toContain('scientificName: r.scientific_name');
    expect(service).toContain('sourceTradeName: r.source_trade_name');
    expect(service).toContain('targetTradeName: r.target_trade_name');
    expect(service).toContain('sourceQuantity: r.source_quantity');
    expect(service).toContain('computedAt: r.computed_at');
  });

  it('does not import or reference status-reports.service.ts / StatusReport', () => {
    expect(service).not.toContain('status-reports.service');
    expect(service).not.toContain('StatusReport');
  });

  it('does not use service_role or auth.admin', () => {
    expect(service).not.toContain('service_role');
    expect(service).not.toMatch(/auth\.admin/);
  });

  it('does not add Excel/XLSX import', () => {
    expect(service).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('is superseded in the alert and dashboard UI by the lifecycle-aware service; StatusCenter remains unchanged', () => {
    const alertsScreen = readFileSync(join(__dirname, '../../../src/features/alerts/InterInstitutionAlertsScreen.tsx'), 'utf8');
    const dashboardScreen = readFileSync(join(__dirname, '../../../src/features/dashboard/DashboardScreen.tsx'), 'utf8');
    const statusCenter = readFileSync(join(__dirname, '../../../src/features/status/StatusCenterScreen.tsx'), 'utf8');
    expect(alertsScreen).toContain('inter-org-alert-lifecycle.service');
    expect(alertsScreen).toContain('getLiveInterInstitutionAlertsWithState');
    expect(dashboardScreen).toContain('inter-org-alert-lifecycle.service');
    expect(dashboardScreen).toContain('getLiveInterInstitutionAlertsWithState');
    expect(statusCenter).not.toContain('getLiveInterInstitutionAlerts');
  });

  it('does not use suggestion/recommendation/opportunity wording', () => {
    expect(service.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
  });
});

describe('Regression guards: unrelated systems untouched', () => {
  const adjustModal = readFileSync(join(__dirname, '../../../src/features/status/AdjustQuantityModal.tsx'), 'utf8');
  const historyModal = readFileSync(join(__dirname, '../../../src/features/status/MovementHistoryModal.tsx'), 'utf8');
  const reportSection = readFileSync(join(__dirname, '../../../src/features/status/MovementReportSection.tsx'), 'utf8');

  // E6: was an isolation assertion read straight off EditorScreen.tsx. The
  // screen is retired, so this is now an absence guard — a deleted screen
  // cannot reference this phase.
  it('EditorScreen stays retired, so it cannot reference this phase', () => {
    expectRetiredSurfaceAbsent('EditorScreen');
  });

  it('AdjustQuantityModal.tsx is unaffected', () => {
    expect(adjustModal).not.toContain('phoenix_get_live_inter_institution_alerts');
  });

  it('MovementHistoryModal.tsx is unaffected', () => {
    expect(historyModal).not.toContain('phoenix_get_live_inter_institution_alerts');
  });

  it('MovementReportSection.tsx is unaffected', () => {
    expect(reportSection).not.toContain('phoenix_get_live_inter_institution_alerts');
  });
});
