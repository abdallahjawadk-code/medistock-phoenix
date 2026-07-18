/**
 * INVENTORY-INTELLIGENCE-072-A — Review Round 2
 *
 * Static SQL-source tests for migration 072 (manual-apply-only; no DB
 * connection), matching the convention of 044-071. Round 2 adds regression
 * coverage keyed to each mandatory review item (1..11).
 *
 * WHAT A STATIC TEST CAN AND CANNOT PROVE
 * ---------------------------------------
 * These tests prove the migration SOURCE contains the boundaries it must
 * contain, and that a future edit cannot quietly remove one. They do not
 * execute SQL, so runtime behaviour is out of scope; the file is not yet
 * applied to a disposable database (see its own header).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import {
  activeSql,
  executableSql,
  normalizeSql,
  sqlFunctionSource,
} from './helpers/sql-source';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M072_NAME = '072_phoenix_inventory_intelligence.sql';
const P072 = join(MIGRATIONS_DIR, M072_NAME);
const m072 = readFileSync(P072, 'utf8');

const active072 = activeSql(m072);
const norm072 = normalizeSql(active072);
const exec072 = executableSql(m072);

function functionBody(name: string): string {
  const src = sqlFunctionSource(m072, name);
  expect(src, `function ${name} must exist`).not.toBeNull();
  return normalizeSql(src!);
}

const RPCS = [
  'phoenix_inventory_scope_org',
  'phoenix_can_read_inventory_signal',
  'phoenix_inventory_fefo_pick',
  'phoenix_recompute_inventory_alerts',
  'phoenix_acknowledge_inventory_alert',
  'phoenix_resolve_inventory_alert',
  'phoenix_dismiss_inventory_alert',
  'phoenix_suggest_inventory_transfers',
  'phoenix_suggest_cross_org_inventory_transfer',
  'phoenix_accept_inventory_transfer_suggestion',
  'phoenix_reject_inventory_transfer_suggestion',
  'phoenix_upsert_inventory_threshold',
  'phoenix_purge_inventory_terminal',
] as const;

const TABLES = [
  'inventory_signal_thresholds',
  'inventory_alerts',
  'inventory_transfer_suggestions',
] as const;

const PERMISSION_KEYS = [
  'inventory.view_signals',
  'inventory.recompute',
  'inventory.manage_alerts',
  'inventory.manage_thresholds',
  'inventory.suggest_transfers',
  'inventory.act_on_suggestions',
  'inventory.purge',
] as const;

const HUMAN_ACTION_RPCS = [
  'phoenix_upsert_inventory_threshold',
  'phoenix_acknowledge_inventory_alert',
  'phoenix_resolve_inventory_alert',
  'phoenix_dismiss_inventory_alert',
  'phoenix_accept_inventory_transfer_suggestion',
  'phoenix_reject_inventory_transfer_suggestion',
  'phoenix_purge_inventory_terminal',
] as const;

// ============================================================================
// 0. Presence, registration, transaction, header
// ============================================================================
describe('0. migration 072 exists, is registered, manual-apply-only', () => {
  it('is registered in the manifest by exact name', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M072_NAME);
  });
  it('wrapped in a single begin/commit transaction', () => {
    expect(exec072.trimStart().toUpperCase().startsWith('BEGIN')).toBe(true);
    expect(exec072.trimEnd().toUpperCase().endsWith('COMMIT;')).toBe(true);
  });
  it('states manual-apply-only and NOT APPLIED', () => {
    expect(m072).toMatch(/MANUAL APPLY ONLY/);
    expect(m072).toMatch(/NOT APPLIED/);
  });
  it('creates exactly the three intelligence tables', () => {
    const created = [...active072.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z_]+)/gi)].map(m => m[1]);
    expect(created.sort()).toEqual([...TABLES].sort());
  });
  it('all RPCs exist as CREATE FUNCTION', () => {
    for (const fn of RPCS) expect(sqlFunctionSource(m072, fn), fn).not.toBeNull();
  });
});

// ============================================================================
// ITEM 1 — fail-closed authz + scope validation (no ELSE->outlet)
// ============================================================================
describe('item 1: read gate / FEFO / recompute fail closed on scope', () => {
  it('scope-org resolver has no ELSE that assumes outlet — unknown kind returns NULL', () => {
    const body = functionBody('phoenix_inventory_scope_org');
    expect(body).toMatch(/WHEN p_scope_kind = 'warehouse'/);
    expect(body).toMatch(/WHEN p_scope_kind = 'outlet'/);
    expect(body).toMatch(/ELSE NULL/);
    // the outlet branch must be gated by an explicit equality, never a fallthrough
    expect(body).not.toMatch(/ELSE\s*\(SELECT[^)]*distribution_points/i);
  });

  it('read gate requires kind in (warehouse,outlet) AND scope belongs to the org', () => {
    const body = functionBody('phoenix_can_read_inventory_signal');
    expect(body).toMatch(/p_scope_kind IN \('warehouse', 'outlet'\)/);
    expect(body).toMatch(/phoenix_inventory_scope_org\(p_scope_kind, p_scope_id\) = p_organization_id/);
  });

  it('read gate checks the permission on the EXACT scope, never (org,NULL,NULL)', () => {
    const body = functionBody('phoenix_can_read_inventory_signal');
    expect(body).toMatch(/p_scope_kind = 'warehouse' AND public\.phoenix_profile_has_scoped_permission\(\s*auth\.uid\(\), 'inventory\.view_signals', p_organization_id, p_scope_id, NULL\)/);
    expect(body).toMatch(/p_scope_kind = 'outlet' AND public\.phoenix_profile_has_scoped_permission\(\s*auth\.uid\(\), 'inventory\.view_signals', p_organization_id, NULL, p_scope_id\)/);
  });

  it('FEFO and recompute validate the scope belongs to the org before doing work', () => {
    for (const fn of ['phoenix_inventory_fefo_pick', 'phoenix_recompute_inventory_alerts']) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/scope_not_in_organization/);
      expect(body, fn).toMatch(/invalid_scope_kind/);
    }
  });

  it('recompute checks permission on the requested scope, not a blanket org grant, when a scope is given', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/'inventory\.recompute', p_organization_id, p_scope_id, NULL/);
    expect(body).toMatch(/'inventory\.recompute', p_organization_id, NULL, p_scope_id/);
  });
});

// ============================================================================
// ITEM 2 — missing is expectation-driven; no threshold => not_stocked
// ============================================================================
describe('item 2: expectation-driven missing', () => {
  it('positions are built from scope-specific expectations UNION stock, then LEFT JOIN aggregated stock', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/_thr t\s+WHERE t\.scope_id IS NOT NULL/);
    expect(body).toMatch(/LEFT JOIN _agg a/);
  });

  it('missing requires an expectation (pos.expected) + reorder_point>0 + zero on-hand', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/pos\.expected AND cfg\.reorder_point IS NOT NULL AND cfg\.reorder_point > 0\s+AND COALESCE\(a\.on_hand, 0\) = 0 THEN 'missing'/);
  });

  it('a stock position with no resolvable threshold yields no signal (not_stocked, not missing)', () => {
    // cfg is an inner LATERAL with LIMIT 1; positions without any threshold drop out,
    // and the final WHERE keeps only classified rows.
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/FROM _pos pos\s+CROSS JOIN LATERAL \(\s*SELECT thr\.reorder_point[\s\S]*?LIMIT 1\s*\) cfg/);
    expect(body).toMatch(/WHERE q\.signal_type IS NOT NULL/);
  });
});

// ============================================================================
// ITEM 3 — no oversubscription, deterministic allocation, feasible routes
// ============================================================================
describe('item 3: deterministic, non-oversubscribing, feasible-route allocation', () => {
  it('allocation is a deterministic loop ordered by priority then FEFO/id', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/FOR v_need IN\s+SELECT \* FROM _need ORDER BY prio DESC/);
    expect(body).toMatch(/ORDER BY s\.remaining DESC, s\.scope_id, s\.alert_id/);
  });

  it('source remaining headroom is decremented as it allocates (no oversubscription)', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/v_take := LEAST\(v_remaining, v_src\.remaining\)/);
    expect(body).toMatch(/UPDATE _src SET remaining = remaining - v_take/);
    expect(body).toMatch(/EXIT WHEN v_remaining <= 0/);
  });

  it('an infeasible corridor is never suggested (route_kind NULL is skipped)', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/CONTINUE WHEN v_src\.route_kind IS NULL/);
  });

  it('warehouse<->outlet feasibility uses distribution_points.warehouse_id', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/distribution_points dp[\s\S]*?dp\.warehouse_id = s\.scope_id/);
    expect(body).toMatch(/'warehouse_to_outlet'/);
    expect(body).toMatch(/'outlet_to_warehouse'/);
  });

  it('central->institution feasibility uses warehouse_supply_routes (active)', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/warehouse_supply_routes r[\s\S]*?r\.is_active/);
    expect(body).toMatch(/'central_to_institution'/);
  });

  it('route_kind is a constrained column, so no free-form corridor can be stored', () => {
    expect(m072).toMatch(/route_kind[\s\S]*?CHECK \(route_kind IN \('warehouse_to_outlet', 'outlet_to_warehouse', 'central_to_institution'\)\)/);
  });

  it('reuses 036-041 for cross-org rather than a parallel engine (documented + no new exchange table)', () => {
    expect(m072).toMatch(/036-041/);
    const created = [...active072.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z_]+)/gi)].map(m => m[1]);
    expect(created).not.toContain('inter_org_exchange_requests');
  });
});

// ============================================================================
// ITEM 4 — cross-org support with strict RLS + privileged creation
// ============================================================================
describe('item 4: cross-org pinning, RLS to source/target/super_admin only', () => {
  it('a suggestion pins BOTH source and target organization', () => {
    expect(m072).toMatch(/source_organization_id\s+uuid NOT NULL REFERENCES public\.organizations/);
    expect(m072).toMatch(/target_organization_id\s+uuid NOT NULL REFERENCES public\.organizations/);
  });

  it('suggestion RLS admits only source org, target org, or super_admin', () => {
    const policyIdx = active072.indexOf('CREATE POLICY inventory_suggestions_select_scoped');
    const policy = active072.slice(policyIdx, policyIdx + 600);
    expect(policy).toMatch(/phoenix_my_role\(\) = 'super_admin'/);
    expect(policy).toMatch(/source_organization_id, source_scope_kind, source_scope_id/);
    expect(policy).toMatch(/target_organization_id, target_scope_kind, target_scope_id/);
  });

  it('intra-org suggest never mints a cross-org row (both orgs set to p_organization_id)', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/VALUES \(\s*p_organization_id, p_organization_id,/);
  });

  it('cross-org suggestion generation requires super_admin and an active supply route', () => {
    const body = functionBody('phoenix_suggest_cross_org_inventory_transfer');
    expect(body).toMatch(/cross_org_suggestion_requires_super_admin/);
    expect(body).toMatch(/no_active_supply_route_between_warehouses/);
    expect(body).toMatch(/use_intra_org_suggest_for_same_org/);
  });
});

// ============================================================================
// ITEM 5 — FEFO one batch, excludes expired/unavailable/quarantine
// ============================================================================
describe('item 5: FEFO returns exactly one usable batch', () => {
  it('LIMIT 1, earliest expiry, NULLS LAST', () => {
    const body = functionBody('phoenix_inventory_fefo_pick');
    expect(body).toMatch(/ORDER BY .*expiry_date ASC NULLS LAST[\s\S]*?LIMIT 1/i);
  });
  it('excludes expired and zero-available stock', () => {
    const body = functionBody('phoenix_inventory_fefo_pick');
    expect(body).toMatch(/available_quantity > 0/);
    expect(body).toMatch(/expiry_date >= current_date/);
  });
  it('reads only live stock tables (quarantine lives in a separate 069 table)', () => {
    const body = functionBody('phoenix_inventory_fefo_pick');
    expect(body).not.toMatch(/warehouse_quarantine_stock/);
    expect(m072).toMatch(/warehouse_quarantine_stock \(069\)/i);
  });
});

// ============================================================================
// ITEM 6 — episode-aware lifecycle (occurrence_count / cleared_at)
// ============================================================================
describe('item 6: recurrence after clearing reopens a fresh episode', () => {
  it('inventory_alerts carries occurrence_count and cleared_at', () => {
    expect(m072).toMatch(/occurrence_count\s+integer NOT NULL DEFAULT 1/);
    expect(m072).toMatch(/cleared_at\s+timestamptz/);
  });
  it('a cleared recurrence bumps occurrence_count and reopens even from a terminal status', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/occurrence_count\s*=\s*al\.occurrence_count \+ \(CASE WHEN al\.cleared_at IS NOT NULL THEN 1 ELSE 0 END\)/);
    expect(body).toMatch(/status\s*=\s*CASE WHEN al\.cleared_at IS NOT NULL THEN 'open' ELSE al\.status END/);
  });
  it('clear detection stamps cleared_at on non-violating alerts including dismissed ones', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/cleared_at\s*=\s*now\(\)/);
    expect(body).toMatch(/a\.cleared_at IS NULL[\s\S]*?NOT EXISTS \(SELECT 1 FROM _now/);
    // no clause excludes dismissed rows from being marked cleared
    expect(body).not.toMatch(/status <> 'dismissed' IS NOT FALSE/);
  });
});

// ============================================================================
// ITEM 7 — manual, safe purge with retention, never deletes audit_logs
// ============================================================================
describe('item 7: manual retention-bounded purge', () => {
  it('purge exists, requires >= 30 days retention, and only deletes terminal rows', () => {
    const body = functionBody('phoenix_purge_inventory_terminal');
    expect(body).toMatch(/retention_must_be_at_least_30_days/);
    expect(body).toMatch(/DELETE FROM public\.inventory_alerts[\s\S]*?status IN \('resolved', 'dismissed'\)/);
    expect(body).toMatch(/DELETE FROM public\.inventory_transfer_suggestions[\s\S]*?status IN \('rejected', 'superseded', 'expired'\)/);
  });
  it('purge NEVER deletes an audit_logs row (and §17 asserts it)', () => {
    const body = functionBody('phoenix_purge_inventory_terminal');
    expect(body).not.toMatch(/DELETE FROM public\.audit_logs/);
    expect(m072).toMatch(/purge must never delete audit_logs/);
  });
  it('has no cron / scheduled dependency', () => {
    expect(exec072).not.toMatch(/pg_cron|cron\.schedule|CREATE\s+EXTENSION/i);
  });
});

// ============================================================================
// ITEM 8 — audit_logs for every human action
// ============================================================================
describe('item 8: every human action writes audit_logs', () => {
  it('each human-action RPC inserts an audit_logs row', () => {
    for (const fn of HUMAN_ACTION_RPCS) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/INSERT INTO public\.audit_logs/);
    }
  });
});

// ============================================================================
// ITEM 9 — split permissions
// ============================================================================
describe('item 9: split permissions', () => {
  it('registers all seven distinct inventory permission keys', () => {
    for (const key of PERMISSION_KEYS) expect(m072, key).toContain(`'${key}'`);
    expect(m072).toMatch(/count\(\*\) FROM public\.permission_keys WHERE key LIKE 'inventory\.%'\) < 7/);
  });
  it('threshold write uses inventory.manage_thresholds', () => {
    expect(functionBody('phoenix_upsert_inventory_threshold')).toContain("'inventory.manage_thresholds'");
  });
  it('suggestion CREATION and ACT-ON are different permissions', () => {
    expect(functionBody('phoenix_suggest_inventory_transfers')).toContain("'inventory.suggest_transfers'");
    for (const fn of ['phoenix_accept_inventory_transfer_suggestion', 'phoenix_reject_inventory_transfer_suggestion']) {
      expect(functionBody(fn), fn).toContain("'inventory.act_on_suggestions'");
    }
  });
  it('purge uses its own inventory.purge permission (flagged dangerous)', () => {
    expect(functionBody('phoenix_purge_inventory_terminal')).toContain("'inventory.purge'");
    expect(m072).toMatch(/'inventory\.purge',\s*'inventory', 'purge',[^,]*,[^,]*,\s*true\)/);
  });
});

// ============================================================================
// ITEM 10 — 048 expiry tiers with graded severity (not flat 270-day)
// ============================================================================
describe('item 10: graded expiry tiers preserved from 048', () => {
  it('alerts carry an expiry_tier constrained to the 048 vocabulary', () => {
    expect(m072).toMatch(/expiry_tier IS NULL OR expiry_tier IN \('expired', 'critical_3m', 'warning_6m', 'watch_9m'\)/);
  });
  it('recompute grades severity by 3m/6m/9m window, not a single bucket', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/interval '3 months'[\s\S]*?'critical_3m'/);
    expect(body).toMatch(/interval '6 months'[\s\S]*?'warning_6m'/);
    expect(body).toMatch(/ELSE 'watch_9m'/);
    // graded severities appear: critical/expired => high, warning => medium, watch => low
    expect(body).toMatch(/interval '6 months'\)::date\s+THEN 'medium'/);
    expect(body).toMatch(/ELSE 'low'/);
  });
  it('the near-expiry participation window stays 9 months', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/expiry_date <= \(current_date \+ interval '9 months'\)::date/);
  });
});

// ============================================================================
// Structural guards carried over from Round 1 (still required)
// ============================================================================
describe('structural: additive, advisory-only, ACL, RLS, frugal', () => {
  it('never ALTERs warehouse_stock or outlet_stock', () => {
    expect(norm072).not.toMatch(/ALTER TABLE public\.(warehouse_stock|outlet_stock)\b/i);
  });
  it('the only DROP statements are DROP POLICY', () => {
    const drops = active072.match(/\bDROP\s+(TABLE|VIEW|FUNCTION|POLICY|INDEX|TRIGGER|TYPE|SCHEMA|CONSTRAINT|SEQUENCE)\b/gi) ?? [];
    for (const d of drops) expect(d.replace(/\s+/g, ' ').toUpperCase()).toBe('DROP POLICY');
  });
  it('accept records intent only — no stock/movement/dispatch/transfer write', () => {
    const body = functionBody('phoenix_accept_inventory_transfer_suggestion');
    expect(body).toMatch(/status = 'accepted'/);
    expect(body).not.toMatch(/INSERT INTO public\.(warehouse_stock|outlet_stock|warehouse_stock_movements|outlet_stock_movements|warehouse_dispatches|warehouse_dispatch_lines|warehouse_transfers)\b/i);
    expect(body).not.toMatch(/UPDATE public\.(warehouse_stock|outlet_stock)\b/i);
  });
  it('recompute/suggest never write a physical stock table', () => {
    for (const fn of ['phoenix_recompute_inventory_alerts', 'phoenix_suggest_inventory_transfers']) {
      const body = functionBody(fn);
      expect(body, fn).not.toMatch(/INSERT INTO public\.(warehouse_stock|outlet_stock)\b/i);
      expect(body, fn).not.toMatch(/UPDATE public\.(warehouse_stock|outlet_stock)\b/i);
    }
  });
  it('signal vocabulary is exactly the five values', () => {
    expect(norm072).toMatch(/CHECK \(signal_type IN \(\s*'missing', 'low_stock', 'surplus', 'near_expiry', 'expired'\s*\)\)/);
  });
  it('dedup uniques for alerts, suggestions, thresholds', () => {
    expect(m072).toContain('inventory_alerts_alert_key_uniq');
    expect(m072).toContain('inventory_suggestions_key_uniq');
    expect(m072).toContain('inventory_thresholds_identity_uniq');
  });
  it('every RPC is SECURITY DEFINER with a pinned search_path, revoked from PUBLIC/anon, granted to authenticated only', () => {
    for (const fn of RPCS) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/SECURITY DEFINER/i);
      expect(body, fn).toMatch(/SET search_path = public, pg_temp/i);
      expect(m072, `${fn} REVOKE`).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*FROM PUBLIC, anon`));
      expect(m072, `${fn} GRANT`).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}\\([^)]*\\)\\s*TO authenticated`));
    }
  });
  it('never grants a table or function to anon or public', () => {
    expect(exec072).not.toMatch(/\bTO\s+(anon|public)\b/i);
  });
  it('authenticated has SELECT but no direct write; anon has ALL revoked', () => {
    for (const t of TABLES) {
      expect(m072).toMatch(new RegExp(`GRANT SELECT ON TABLE public\\.${t}\\s+TO authenticated`));
      expect(m072).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t}\\s+FROM authenticated`));
      expect(m072).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t}\\s+FROM anon`));
    }
  });
  it('RLS enabled on all three tables', () => {
    for (const t of TABLES) expect(m072).toMatch(new RegExp(`ALTER TABLE public\\.${t}\\s+ENABLE ROW LEVEL SECURITY`));
  });
  it('frugal: no image/blob/whatsapp column, no cron, no WhatsApp fan-out', () => {
    expect(exec072).not.toMatch(/whatsapp|twilio|sendgrid|nodemailer|smtp/i);
    expect(exec072).not.toMatch(/pg_cron|cron\.schedule/i);
  });
  it('RBAC enforcement stays OFF', () => {
    expect(norm072).not.toMatch(/rbac_enforc|permission_enforc|set_enforcement|enforcement_enabled/i);
    expect(m072).toMatch(/Enforcement stays OFF|ENFORCEMENT STAYS OFF/i);
  });
  it('every ::regprocedure cast is parenthesised (071 regression lesson)', () => {
    const bare = m072.match(/'[a-z0-9_.]+'::regprocedure/gi) ?? [];
    expect(bare, `bare-name casts: ${bare.join(', ')}`).toEqual([]);
  });
});
