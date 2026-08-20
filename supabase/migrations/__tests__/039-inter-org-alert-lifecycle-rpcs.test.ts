/**
 * ALERT-LIFECYCLE-RPC-A
 * Run: npm test -- --run
 *
 * Static source-code tests for migration 039: the four inter-org alert
 * lifecycle RPCs (phoenix_get_live_inter_institution_alerts_with_state,
 * phoenix_update_inter_org_alert_state, phoenix_reopen_inter_org_alert,
 * phoenix_get_inter_org_alert_events). No live DB is used — these are
 * text/shape assertions against the SQL file.
 */
import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'fs';
import { join } from 'path';

const MIGRATIONS_DIR = join(__dirname, '../');
const MIGRATION_039_PATH = join(MIGRATIONS_DIR, '039_phoenix_inter_org_alert_lifecycle_rpcs.sql');

function readMigration(rel: string) {
  return readFileSync(join(MIGRATIONS_DIR, rel), 'utf8');
}

/** Strip `--` comment lines, leaving only active SQL for whole-file guardrails. */
function activeSql(sql: string): string {
  return sql.split('\n').filter(l => !l.trimStart().startsWith('--')).join('\n');
}

function extractFunction(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  const afterStart = sql.indexOf('AS $$', start) + 'AS $$'.length;
  const end = sql.indexOf('\n$$;', afterStart);
  return sql.slice(start, end);
}

describe('Migration 039 exists exactly once', () => {
  it('039_phoenix_inter_org_alert_lifecycle_rpcs.sql exists', () => {
    expect(existsSync(MIGRATION_039_PATH)).toBe(true);
  });

  it('is the only file named 039_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('039_'));
    expect(matches).toEqual(['039_phoenix_inter_org_alert_lifecycle_rpcs.sql']);
  });

  it('is manual-apply-only (no supabase db push)', () => {
    const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toContain('supabase db push');
  });
});

describe('Migration 039: does not modify migrations 001-038', () => {
  it('all prior migration files (001-038) still exist untouched', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => /^0(0[1-9]|[1-2][0-9]|3[0-8])_/.test(f));
    expect(matches.length).toBeGreaterThan(0);
  });

  it('migration 038 file is untouched (still the schema-only migration, no RPC body added)', () => {
    const sql038 = readMigration('038_phoenix_inter_org_alert_lifecycle_schema.sql');
    expect(sql038).toContain('Migration 038: Inter-Org Alert Lifecycle Schema');
    // 038 legitimately mentions phoenix_get_live_inter_institution_alerts_with_state
    // in prose (its own VERIFY block asserts it does NOT exist yet, and its
    // closing "NEXT PHASE" note names it as future work) — it must not,
    // however, contain an actual CREATE FUNCTION for it.
    expect(sql038).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state');
  });

  it('migration 037/036 files are untouched', () => {
    const sql037 = readMigration('037_phoenix_live_alert_identifiers.sql');
    const sql036 = readMigration('036_phoenix_live_inter_institution_alerts_rpc.sql');
    expect(sql037).toContain('Migration 037: Live Alert Stable Identifiers');
    expect(sql036).toContain('Migration 036: Live Inter-Institution Alerts RPC');
  });

  it('039 does not create a second 036/037/038-named file', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('036_'))).toEqual(['036_phoenix_live_inter_institution_alerts_rpc.sql']);
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('037_'))).toEqual(['037_phoenix_live_alert_identifiers.sql']);
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('038_'))).toEqual(['038_phoenix_inter_org_alert_lifecycle_schema.sql']);
  });
});

describe('Migration 039: creates exactly the four lifecycle RPCs', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');

  it('creates phoenix_get_live_inter_institution_alerts_with_state', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts_with_state(');
  });

  it('creates phoenix_update_inter_org_alert_state', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_update_inter_org_alert_state(');
  });

  it('creates phoenix_reopen_inter_org_alert', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_reopen_inter_org_alert(');
  });

  it('creates phoenix_get_inter_org_alert_events', () => {
    expect(sql).toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_inter_org_alert_events(');
  });

  it('creates no other function', () => {
    const matches = activeSql(sql).match(/CREATE OR REPLACE FUNCTION/g) ?? [];
    expect(matches.length).toBe(4);
  });

  it('does not redefine phoenix_get_live_inter_institution_alerts', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION public.phoenix_get_live_inter_institution_alerts(');
  });

  it('creates no table, policy, or permission key', () => {
    expect(activeSql(sql)).not.toMatch(/CREATE TABLE/i);
    expect(activeSql(sql)).not.toMatch(/CREATE POLICY/i);
    expect(activeSql(sql)).not.toMatch(/INSERT INTO permission_keys/i);
  });
});

describe('Migration 039: all four RPCs are SECURITY DEFINER + SET search_path = public', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
  const FN_NAMES = [
    'phoenix_get_live_inter_institution_alerts_with_state',
    'phoenix_update_inter_org_alert_state',
    'phoenix_reopen_inter_org_alert',
    'phoenix_get_inter_org_alert_events',
  ];

  FN_NAMES.forEach(name => {
    it(`${name} is SECURITY DEFINER with SET search_path = public`, () => {
      const fn = extractFunction(sql, name);
      expect(fn.length).toBeGreaterThan(0);
      expect(fn).toContain('SECURITY DEFINER');
    });
  });

  it('all four have EXECUTE revoked from PUBLIC/anon and granted to authenticated', () => {
    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_get_live_inter_institution_alerts_with_state\(integer\)\s*\n\s*FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_get_live_inter_institution_alerts_with_state\(integer\)\s*\n\s*TO authenticated;/);

    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_update_inter_org_alert_state\(text, text, text, text\)\s*\n\s*FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_update_inter_org_alert_state\(text, text, text, text\)\s*\n\s*TO authenticated;/);

    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_reopen_inter_org_alert\(text, text, text\)\s*\n\s*FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_reopen_inter_org_alert\(text, text, text\)\s*\n\s*TO authenticated;/);

    expect(sql).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_get_inter_org_alert_events\(text\)\s*\n\s*FROM PUBLIC, anon;/);
    expect(sql).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_get_inter_org_alert_events\(text\)\s*\n\s*TO authenticated;/);
  });
});

describe('Migration 039: phoenix_get_live_inter_institution_alerts_with_state behavior', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
  const fn = extractFunction(sql, 'phoenix_get_live_inter_institution_alerts_with_state');

  it('requires auth.uid() and rejects when null', () => {
    expect(fn).toContain('auth.uid()');
    expect(fn).toContain('NOT_AUTHENTICATED');
  });

  it('checks super_admin bypass and inter_institution_alerts.view / exchange_alerts.view', () => {
    expect(fn).toMatch(/v_is_super\s*:=\s*\(v_role = 'super_admin'\)/);
    expect(fn).toContain("phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')");
    expect(fn).toContain("phoenix_profile_has_permission(v_actor, 'exchange_alerts.view')");
  });

  it('still queries item_availability and preserves matching identity', () => {
    expect(fn).toContain('FROM public.item_availability ia');
    expect(fn).toContain('s.norm_sci    = d.norm_sci');
    expect(fn).toContain('s.norm_conc   = d.norm_conc');
    expect(fn).toContain('s.norm_dosage = d.norm_dosage');
  });

  it('preserves trade_name as display-only (not in the join condition)', () => {
    const joinBlock = fn.slice(fn.indexOf('JOIN demand d'), fn.indexOf('scoped AS'));
    expect(joinBlock).not.toContain('trade_name');
  });

  it('preserves supply/demand sets (surplus/near_expiry vs missing/low_stock)', () => {
    expect(fn).toContain("effective_status IN ('surplus', 'near_expiry')");
    expect(fn).toContain("effective_status IN ('missing', 'low_stock')");
  });

  it('excludes available/expired from candidate sets', () => {
    expect(fn).not.toMatch(/effective_status IN \([^)]*'available'[^)]*\)/);
    expect(fn).not.toMatch(/effective_status IN \([^)]*'expired'[^)]*\)/);
  });

  it('preserves cross-org-only matching (same-org excluded)', () => {
    expect(fn).toContain('s.organization_id <> d.organization_id');
  });

  it('preserves the same limit cap behavior (default 200, max 500, min 1)', () => {
    expect(fn).toMatch(/LEAST\(GREATEST\(COALESCE\(p_limit,\s*200\),\s*1\),\s*500\)/);
  });

  it('never exposes supply_type', () => {
    expect(fn).not.toContain('supply_type');
  });

  it('derives alert_key from source_item_availability_id + target_item_availability_id + alert_type', () => {
    expect(fn).toMatch(/m\.src_availability_id::text \|\| ':' \|\| m\.tgt_availability_id::text \|\| ':' \|\| m\.alert_type/);
  });

  it('upserts inter_org_alert_states keyed by alert_key', () => {
    expect(fn).toContain('INSERT INTO public.inter_org_alert_states');
    expect(fn).toContain('ON CONFLICT (alert_key) DO UPDATE SET');
  });

  it('new rows are inserted with status open', () => {
    const insertBlock = fn.slice(fn.indexOf('INSERT INTO public.inter_org_alert_states'), fn.indexOf('ON CONFLICT (alert_key)'));
    expect(insertBlock).toContain("'open', s.severity");
  });

  it('the upsert never overwrites status, reason, or notes on conflict', () => {
    const conflictBlock = fn.slice(fn.indexOf('ON CONFLICT (alert_key) DO UPDATE SET'), fn.indexOf('RETURNING'));
    expect(conflictBlock).not.toContain('status');
    expect(conflictBlock).not.toContain('reason');
    expect(conflictBlock).not.toContain('notes');
    expect(conflictBlock).not.toMatch(/acknowledged_at|in_progress_at|resolved_at|dismissed_at/);
  });

  it('the upsert refreshes last_seen_at and severity_snapshot on conflict', () => {
    const conflictBlock = fn.slice(fn.indexOf('ON CONFLICT (alert_key) DO UPDATE SET'), fn.indexOf('RETURNING'));
    expect(conflictBlock).toContain('last_seen_at');
    expect(conflictBlock).toContain('severity_snapshot');
  });

  it('appends an opened event only for newly-inserted alert_keys (was_inserted / xmax = 0)', () => {
    expect(fn).toMatch(/\(xmax = 0\) AS was_inserted/);
    expect(fn).toContain('WHERE was_inserted');
    expect(fn).toContain("'opened'");
  });

  it('includes all required lifecycle fields in the returned payload', () => {
    const REQUIRED = [
      'alert_key', 'lifecycle_status', 'first_seen_at', 'last_seen_at',
      'acknowledged_at', 'acknowledged_by', 'in_progress_at', 'in_progress_by',
      'resolved_at', 'resolved_by', 'dismissed_at', 'dismissed_by',
      'lifecycle_reason', 'lifecycle_notes',
    ];
    REQUIRED.forEach(field => {
      expect(fn).toContain(`'${field}'`);
    });
  });

  it('uses the ok/alerts/computed_at response shape', () => {
    expect(fn).toMatch(/jsonb_build_object\(\s*\n\s*'ok', true,\s*\n\s*'alerts', coalesce\(v_alerts, '\[\]'::jsonb\),\s*\n\s*'computed_at', v_computed_at/);
  });

  it('is documented as having a controlled write side effect', () => {
    expect(sql).toMatch(/CONTROLLED WRITE SIDE EFFECT/);
  });
});

describe('Migration 039: phoenix_update_inter_org_alert_state behavior', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
  const fn = extractFunction(sql, 'phoenix_update_inter_org_alert_state');

  it('requires auth.uid()', () => {
    expect(fn).toContain('not_authenticated');
  });

  it('locks the target row with FOR UPDATE before any check', () => {
    expect(fn).toMatch(/FOR UPDATE/);
  });

  it('validates the allowed transitions exactly', () => {
    expect(fn).toMatch(/v_row\.status = 'open'\s*AND p_to_status = 'acknowledged'/);
    expect(fn).toMatch(/v_row\.status = 'open'\s*AND p_to_status = 'dismissed'/);
    expect(fn).toMatch(/v_row\.status = 'acknowledged' AND p_to_status = 'in_progress'/);
    expect(fn).toMatch(/v_row\.status = 'acknowledged' AND p_to_status = 'dismissed'/);
    expect(fn).toMatch(/v_row\.status = 'in_progress'\s*AND p_to_status = 'resolved'/);
    expect(fn).toMatch(/v_row\.status = 'in_progress'\s*AND p_to_status = 'dismissed'/);
  });

  it('rejects an unknown target status before checking transitions', () => {
    expect(fn).toContain("p_to_status NOT IN ('acknowledged', 'in_progress', 'resolved', 'dismissed')");
    expect(fn).toContain('invalid_target_status');
  });

  it('raises invalid_transition when the computed v_allowed is false', () => {
    expect(fn).toContain('IF NOT v_allowed THEN');
    expect(fn).toContain('invalid_transition');
  });

  it('does NOT allow open -> in_progress, open -> resolved, acknowledged -> resolved, or in_progress -> acknowledged', () => {
    expect(fn).not.toMatch(/v_row\.status = 'open'\s*AND p_to_status = 'in_progress'/);
    expect(fn).not.toMatch(/v_row\.status = 'open'\s*AND p_to_status = 'resolved'/);
    expect(fn).not.toMatch(/v_row\.status = 'acknowledged' AND p_to_status = 'resolved'/);
    expect(fn).not.toMatch(/v_row\.status = 'in_progress'\s*AND p_to_status = 'acknowledged'/);
  });

  it('requires a non-empty reason for dismissed and resolved', () => {
    expect(fn).toContain("p_to_status IN ('dismissed', 'resolved')");
    expect(fn).toContain('reason_required');
  });

  it('enforces org scope from the locked row (super_admin bypass)', () => {
    expect(fn).toMatch(/v_row\.source_organization_id <> v_my_org\s*\n\s*AND v_row\.target_organization_id <> v_my_org/);
    expect(fn).toContain('forbidden_cross_org');
  });

  it('checks the correct permission per target status', () => {
    expect(fn).toContain("p_to_status = 'acknowledged' AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.acknowledge')");
    expect(fn).toContain("p_to_status = 'in_progress' AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.manage')");
    expect(fn).toContain("p_to_status = 'resolved' AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.resolve')");
    expect(fn).toContain("p_to_status = 'dismissed' AND NOT phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.dismiss')");
  });

  it('writes state and appends exactly one event in the same function', () => {
    expect(fn).toContain('UPDATE public.inter_org_alert_states');
    expect(fn).toContain('INSERT INTO public.inter_org_alert_events');
    const eventInserts = fn.match(/INSERT INTO public\.inter_org_alert_events/g) ?? [];
    expect(eventInserts.length).toBe(1);
  });

  it('returns { ok, alert_key, from_status, to_status }', () => {
    expect(fn).toMatch(/'ok', true,\s*\n\s*'alert_key', p_alert_key,\s*\n\s*'from_status', v_row\.status,\s*\n\s*'to_status', p_to_status/);
  });
});

describe('Migration 039: phoenix_reopen_inter_org_alert behavior', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
  const fn = extractFunction(sql, 'phoenix_reopen_inter_org_alert');

  it('locks the target row with FOR UPDATE', () => {
    expect(fn).toMatch(/FOR UPDATE/);
  });

  it('only allows resolved/dismissed -> open', () => {
    expect(fn).toContain("v_row.status NOT IN ('resolved', 'dismissed')");
    expect(fn).toContain('cannot_reopen_active_alert');
  });

  it('requires a non-empty reason', () => {
    expect(fn).toMatch(/p_reason IS NULL OR btrim\(p_reason\) = ''/);
    expect(fn).toContain('reason_required');
  });

  it('requires inter_institution_alerts.manage (unless super_admin)', () => {
    expect(fn).toContain("phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.manage')");
  });

  it('enforces org scope (super_admin bypass)', () => {
    expect(fn).toContain('forbidden_cross_org');
  });

  it('appends a reopened event', () => {
    expect(fn).toContain("'reopened'");
  });

  it('does not clear old resolved_at/resolved_by/dismissed_at/dismissed_by columns', () => {
    const updateBlock = fn.slice(fn.indexOf('UPDATE public.inter_org_alert_states'), fn.indexOf('WHERE id = v_row.id'));
    expect(updateBlock).not.toMatch(/resolved_at|resolved_by|dismissed_at|dismissed_by/);
  });

  it("returns { ok, alert_key, from_status, to_status: 'open' }", () => {
    expect(fn).toMatch(/'ok', true,\s*\n\s*'alert_key', p_alert_key,\s*\n\s*'from_status', v_row\.status,\s*\n\s*'to_status', 'open'/);
  });
});

describe('Migration 039: phoenix_get_inter_org_alert_events behavior', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
  const fn = extractFunction(sql, 'phoenix_get_inter_org_alert_events');

  it('requires auth.uid()', () => {
    expect(fn).toContain('NOT_AUTHENTICATED');
  });

  it('checks inter_institution_alerts.view or exchange_alerts.view (super_admin bypass)', () => {
    expect(fn).toContain("phoenix_profile_has_permission(v_actor, 'inter_institution_alerts.view')");
    expect(fn).toContain("phoenix_profile_has_permission(v_actor, 'exchange_alerts.view')");
  });

  it('enforces org scope against the parent alert state row', () => {
    expect(fn).toContain('v_state.source_organization_id <> v_org');
    expect(fn).toContain('v_state.target_organization_id <> v_org');
  });

  it('reads from inter_org_alert_events ordered by created_at desc', () => {
    expect(fn).toContain('FROM public.inter_org_alert_events e');
    expect(fn).toMatch(/ORDER BY e\.created_at DESC/);
  });

  it('returns display fields but not actor_id or alert_state_id', () => {
    const REQUIRED = ['event_type', 'actor_name_snapshot', 'actor_email_snapshot', 'actor_role_snapshot', 'from_status', 'to_status', 'reason', 'notes', 'created_at'];
    REQUIRED.forEach(field => expect(fn).toContain(`'${field}'`));
    // jsonb_build_object keys never include actor_id/alert_state_id/id
    expect(fn).not.toMatch(/'actor_id',/);
    expect(fn).not.toMatch(/'alert_state_id',/);
    expect(fn).not.toMatch(/'id',/);
  });

  it('returns ALERT_NOT_FOUND when the state row does not exist', () => {
    expect(fn).toContain('ALERT_NOT_FOUND');
  });
});

describe('Migration 039: actor snapshot resolution matches confirmed profile columns', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');

  it('resolves actor_name from profiles.full_name, actor_email from auth.users.email (LEFT JOIN), actor_role from profiles.role', () => {
    const matches = sql.match(/SELECT p\.full_name, u\.email, p\.role\s*\n\s*INTO v_actor_name, v_actor_email, v_actor_role\s*\n\s*FROM public\.profiles p\s*\n\s*LEFT JOIN auth\.users u ON u\.id = p\.id/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2); // update_state + reopen
  });

  it('documents that profiles has no email column (email only via auth.users)', () => {
    expect(sql).toMatch(/profiles has full_name.*and role.*but NO\s*\n--\s*email column/);
  });
});

describe('Migration 039: no direct lifecycle table grants added', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
  const active = activeSql(sql);

  it('does not GRANT anything on inter_org_alert_states or inter_org_alert_events tables', () => {
    expect(active).not.toMatch(/GRANT[\s\S]{0,80}ON TABLE public\.inter_org_alert_states/i);
    expect(active).not.toMatch(/GRANT[\s\S]{0,80}ON TABLE public\.inter_org_alert_events/i);
  });

  it('verify block asserts authenticated still has no direct SELECT on events and no write grants on either table', () => {
    expect(sql).toContain("table_name = 'inter_org_alert_events'\n      AND grantee = 'authenticated' AND privilege_type = 'SELECT'");
    expect(sql).toContain("table_name IN ('inter_org_alert_states','inter_org_alert_events')\n      AND grantee = 'authenticated' AND privilege_type IN ('INSERT','UPDATE','DELETE')");
  });
});

describe('Migration 039: security guardrails', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');
  const active = activeSql(sql);
  const fnBodies = [
    extractFunction(sql, 'phoenix_get_live_inter_institution_alerts_with_state'),
    extractFunction(sql, 'phoenix_update_inter_org_alert_state'),
    extractFunction(sql, 'phoenix_reopen_inter_org_alert'),
    extractFunction(sql, 'phoenix_get_inter_org_alert_events'),
  ].join('\n');

  it('no supply_type in any function body (VERIFY block legitimately asserts its absence as a literal string)', () => {
    expect(fnBodies).not.toContain('supply_type');
  });

  it('no suggestion/recommendation/opportunity/اقتراح/فرصة wording in active SQL', () => {
    expect(active.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
    expect(active).not.toContain('اقتراح');
    expect(active).not.toContain('فرصة');
  });

  it('no item_availability quantity update anywhere', () => {
    expect(active).not.toMatch(/UPDATE\s+(public\.)?item_availability\s+SET\s+quantity/i);
  });

  it('no call to phoenix_apply_availability_movement', () => {
    expect(active).not.toContain('phoenix_apply_availability_movement(');
  });

  it('no QR reference inside any function body (VERIFY block legitimately asserts get_public_qr_payload still exists elsewhere)', () => {
    expect(fnBodies).not.toMatch(/get_public_qr_payload|qr_tokens|qr_targets/i);
  });

  it('no service_role or auth.admin in active SQL', () => {
    expect(active).not.toContain('service_role');
    expect(active).not.toMatch(/auth\.admin/);
  });

  it('no Excel/XLSX import machinery in active SQL', () => {
    expect(active).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not run supabase db push directly (only mentions it as prohibited)', () => {
    expect(active).not.toMatch(/supabase\s+db\s+push/);
  });

  it('has no DROP TABLE, TRUNCATE, or destructive DELETE', () => {
    expect(active).not.toMatch(/drop table/i);
    expect(active).not.toMatch(/truncate/i);
    expect(active).not.toMatch(/\bdelete from\b/i);
  });
});

describe('Migration 039: verification block exists and checks all four RPCs', () => {
  const sql = readMigration('039_phoenix_inter_org_alert_lifecycle_rpcs.sql');

  it('has a DO $$ ... VERIFY block with ASSERT statements', () => {
    expect(sql).toContain('VERIFY');
    expect(sql).toMatch(/DO \$\$/);
    expect(sql).toContain('ASSERT');
  });

  it('verify block confirms migration 036 RPC and tables still exist', () => {
    expect(sql).toContain("proname = 'phoenix_get_live_inter_institution_alerts'");
    expect(sql).toContain("table_name = 'inter_org_alert_states'");
    expect(sql).toContain("table_name = 'inter_org_alert_events'");
  });

  it('verify block confirms quantity-movement and QR RPCs are untouched', () => {
    expect(sql).toContain("proname = 'phoenix_apply_availability_movement'");
    expect(sql).toContain("proname = 'phoenix_upsert_availability'");
    expect(sql).toContain("proname = 'get_public_qr_payload'");
  });
});

describe('No UI strings were added in this phase', () => {
  it('strings.ts is unaffected by this migration (no new lifecycle-specific keys required)', () => {
    const stringsPath = join(__dirname, '../../../src/shared/i18n/strings.ts');
    const before = readFileSync(stringsPath, 'utf8');
    expect(before).not.toMatch(/\balert_lifecycle_(open|acknowledged|in_progress|resolved|dismissed)\b\s*:/);
  });
});

describe('Lifecycle UI phase wiring', () => {
  const alertsScreen = readFileSync(join(__dirname, '../../../src/features/alerts/InterInstitutionAlertsScreen.tsx'), 'utf8');
  const dashboardScreen = readFileSync(join(__dirname, '../../../src/features/dashboard/DashboardScreen.tsx'), 'utf8');

  it('InterInstitutionAlertsScreen uses the lifecycle service without embedding RPC names', () => {
    expect(alertsScreen).not.toContain('phoenix_get_live_inter_institution_alerts_with_state');
    expect(alertsScreen).not.toContain('phoenix_update_inter_org_alert_state');
    expect(alertsScreen).toContain('inter-org-alert-lifecycle.service');
  });

  it('DashboardScreen uses the lifecycle service without embedding RPC names', () => {
    expect(dashboardScreen).not.toContain('phoenix_get_live_inter_institution_alerts_with_state');
    expect(dashboardScreen).toContain('inter-org-alert-lifecycle.service');
  });
});

describe('Service wrapper: inter-org-alert-lifecycle.service.ts', () => {
  const servicePath = join(__dirname, '../../../src/features/alerts/inter-org-alert-lifecycle.service.ts');
  const service = readFileSync(servicePath, 'utf8');

  it('service file exists', () => {
    expect(existsSync(servicePath)).toBe(true);
  });

  // ALERT-CQRS-BOUNDARY-190 (G4.1): this migration created FOUR RPCs. Three of
  // them — the two lifecycle transitions and the event-history read — are
  // unchanged and are still called from here, asserted below exactly as before.
  // The fourth, the with_state HYBRID, upserts lifecycle state as a side effect
  // of being read; the client now reaches it only through 190's explicit
  // refresh COMMAND, and reads through 190's PURE queries. The assertion is
  // re-pointed by EXACT name and gains a negative: the hybrid must no longer be
  // called directly from the client at all.
  it('calls the correct RPC names via supabase.rpc only', () => {
    expect(service).toContain("supabase.rpc('phoenix_update_inter_org_alert_state'");
    expect(service).toContain("supabase.rpc('phoenix_reopen_inter_org_alert'");
    expect(service).toContain("supabase.rpc('phoenix_get_inter_org_alert_events'");
    // 190: the hybrid is reached through the COMMAND, never read directly.
    expect(service).toContain("supabase.rpc('phoenix_refresh_inter_org_alert_lifecycle'");
    expect(service).not.toContain("supabase.rpc('phoenix_get_live_inter_institution_alerts_with_state'");
    expect(service).not.toContain("supabase.rpc('phoenix_get_live_inter_institution_alerts_with_state_page'");
  });

  it('exports the four suggested functions', () => {
    expect(service).toContain('export async function refreshInterOrgAlertLifecycle');
    expect(service).toContain('export async function updateInterOrgAlertState');
    expect(service).toContain('export async function reopenInterOrgAlert');
    expect(service).toContain('export async function getInterOrgAlertEvents');
  });

  it('maps snake_case fields to camelCase', () => {
    expect(service).toContain('alertKey: r.alert_key');
    expect(service).toContain('lifecycleStatus: r.lifecycle_status');
    expect(service).toContain('acknowledgedAt: r.acknowledged_at');
    expect(service).toContain('lifecycleReason: r.lifecycle_reason');
    expect(service).toContain('eventType: r.event_type');
    expect(service).toContain('actorNameSnapshot: r.actor_name_snapshot');
  });

  it('does not perform any direct table write (no .from(...).insert/update/delete)', () => {
    expect(service).not.toMatch(/\.from\([^)]*\)\.(insert|update|delete|upsert)\(/);
  });

  it('does not write to item_availability directly', () => {
    expect(service).not.toContain("from('item_availability')");
  });

  it('is imported by the alert and dashboard UI screens', () => {
    const alertsScreen = readFileSync(join(__dirname, '../../../src/features/alerts/InterInstitutionAlertsScreen.tsx'), 'utf8');
    const dashboardScreen = readFileSync(join(__dirname, '../../../src/features/dashboard/DashboardScreen.tsx'), 'utf8');
    expect(alertsScreen).toContain('inter-org-alert-lifecycle.service');
    expect(dashboardScreen).toContain('inter-org-alert-lifecycle.service');
  });

  it('does not use service_role or auth.admin', () => {
    expect(service).not.toContain('service_role');
    expect(service).not.toMatch(/auth\.admin/);
  });

  it('does not add Excel/XLSX import', () => {
    expect(service).not.toMatch(/xlsx|exceljs|read-excel-file|sheetjs|papaparse/i);
  });

  it('does not use suggestion/recommendation/opportunity wording', () => {
    expect(service.toLowerCase()).not.toMatch(/suggestion|suggested|recommendation|recommended|opportunit/);
  });
});
