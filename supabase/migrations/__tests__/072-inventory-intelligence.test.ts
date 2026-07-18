/**
 * INVENTORY-INTELLIGENCE-072-A — Review Round 3
 *
 * Static SQL-source tests for migration 072 (manual-apply-only; no DB
 * connection), matching the convention of 044-071. Round 3 keys every
 * regression block to a mandatory review item (1..10) and adds the explicit
 * scenario list from the round-3 mandate.
 *
 * WHAT A STATIC TEST CAN AND CANNOT PROVE
 * ---------------------------------------
 * These tests prove the migration SOURCE contains the boundaries it must
 * contain, and that a future edit cannot quietly remove one. They do not
 * execute SQL, so runtime behaviour is out of scope; the file is not yet
 * applied to a disposable database (see its own header). The migration's own
 * §18 DO block carries the LIVE post-conditions that run at apply time.
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

/** Client-facing RPCs: SECURITY DEFINER + pinned path + REVOKE/GRANT pair. */
const RPCS = [
  'phoenix_inventory_scope_org',
  'phoenix_can_read_inventory_signal',
  'phoenix_inventory_fefo_batches',
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

/** Structural guard trigger functions: internal, never granted to clients. */
const GUARDS = [
  'phoenix_inventory_threshold_guard',
  'phoenix_inventory_alert_guard',
  'phoenix_inventory_suggestion_guard',
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
  it('all RPCs and guard functions exist as CREATE FUNCTION', () => {
    for (const fn of [...RPCS, ...GUARDS]) expect(sqlFunctionSource(m072, fn), fn).not.toBeNull();
  });
  it('preconditions demand the 070/071 provenance columns and the 040/041 exchange engine', () => {
    expect(active072).toMatch(/resulting_outlet_stock_id/);
    expect(active072).toMatch(/returned_quantity/);
    expect(active072).toMatch(/to_regclass\('public\.inter_org_exchange_requests'\)/);
    expect(active072).toMatch(/phoenix_create_inter_org_exchange_request\(text,uuid,uuid,uuid,integer,text,text\)/);
  });
});

// ============================================================================
// ITEM 1 — 036-041 integration: reference, not a parallel engine
// ============================================================================
describe('item 1: cross-org acceptance is anchored to the 036-041 engine', () => {
  it('suggestions carry exchange_request_id as a REAL FK to inter_org_exchange_requests', () => {
    expect(m072).toMatch(/exchange_request_id\s+uuid REFERENCES public\.inter_org_exchange_requests\(id\) ON DELETE SET NULL/);
  });
  it('a cross-org suggestion cannot be accepted without a stored exchange reference (structural CHECK)', () => {
    expect(norm072).toMatch(/inventory_suggestions_cross_org_accept_link_chk CHECK \( status <> 'accepted' OR source_organization_id = target_organization_id OR exchange_request_id IS NOT NULL \)/);
  });
  it('accept demands and validates the exchange request for cross-org rows', () => {
    const body = functionBody('phoenix_accept_inventory_transfer_suggestion');
    expect(body).toMatch(/exchange_request_required_for_cross_org_accept/);
    expect(body).toMatch(/exchange_request_not_found/);
    expect(body).toMatch(/exchange_request_organization_mismatch/);
    expect(body).toMatch(/exchange_request_material_mismatch/);
    expect(body).toMatch(/exchange_request_terminal/);
    // and rejects a spurious reference on an intra-org row
    expect(body).toMatch(/exchange_request_only_for_cross_org/);
  });
  it('NO function in 072 ever writes the 036-041 exchange tables', () => {
    for (const fn of [...RPCS, ...GUARDS]) {
      const body = functionBody(fn);
      expect(body, fn).not.toMatch(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+public\.inter_org_exchange_(requests|events)\b/i);
    }
  });
  it('does not create a parallel exchange table and documents 036-041 reuse', () => {
    expect(m072).toMatch(/036-041/);
    const created = [...active072.matchAll(/CREATE TABLE (?:IF NOT EXISTS )?public\.([a-z_]+)/gi)].map(m => m[1]);
    expect(created).not.toContain('inter_org_exchange_requests');
  });
  it('states the warehouse-level integration gap honestly instead of faking a bridge', () => {
    expect(m072).toMatch(/KNOWN INTEGRATION GAP/);
    expect(m072).toMatch(/item_availability/);
  });
});

// ============================================================================
// ITEM 2 — cross-org quantities are derived from data, never client-supplied
// ============================================================================
describe('item 2: cross-org suggestions are fully data-derived', () => {
  const body = () => functionBody('phoenix_suggest_cross_org_inventory_transfer');

  it('takes NO quantity parameter (six params, none integer)', () => {
    const src = sqlFunctionSource(m072, 'phoenix_suggest_cross_org_inventory_transfer')!;
    const sig = src.slice(0, src.indexOf('RETURNS'));
    expect(sig).not.toMatch(/p_quantity/);
    expect(sig).not.toMatch(/integer/i);
  });
  it('requires super_admin, distinct orgs, and an active owned supply route', () => {
    expect(body()).toMatch(/cross_org_suggestion_requires_super_admin/);
    expect(body()).toMatch(/use_intra_org_suggest_for_same_org/);
    expect(body()).toMatch(/no_active_supply_route_between_warehouses/);
    expect(body()).toMatch(/sw\.organization_id = p_source_organization_id/);
    expect(body()).toMatch(/tw\.organization_id = p_target_organization_id/);
  });
  it('regression: no surplus at the source => no suggestion (no_source_surplus)', () => {
    expect(body()).toMatch(/signal_type = 'surplus'/);
    expect(body()).toMatch(/no_source_surplus/);
  });
  it('regression: no shortfall at the target => no suggestion (no_target_shortfall)', () => {
    expect(body()).toMatch(/signal_type IN \('missing', 'low_stock'\)/);
    expect(body()).toMatch(/no_target_shortfall/);
  });
  it('regression: no eligible FEFO batch => no suggestion (no_eligible_fefo_batch)', () => {
    expect(body()).toMatch(/no_eligible_fefo_batch/);
  });
  it('regression: quantity is LEAST(surplus, shortfall, batch) — never larger than any bound', () => {
    expect(body()).toMatch(/LEAST\(v_surplus, v_shortfall, v_batch_remaining\)/);
  });
  it('regression: already-committed suggestions consume the surplus, shortfall and batch (cross-org oversubscription)', () => {
    expect(body()).toMatch(/source_surplus_already_committed/);
    expect(body()).toMatch(/target_shortfall_already_covered/);
    expect(body()).toMatch(/s\.status IN \('open', 'accepted'\)/);
    expect(body()).toMatch(/s\.source_stock_id = v_batch\.stock_id/);
  });
  it('regression: takes BOTH org locks in deterministic sorted order', () => {
    expect(body()).toMatch(/LEAST\(p_source_organization_id::text, p_target_organization_id::text\)/);
    expect(body()).toMatch(/GREATEST\(p_source_organization_id::text, p_target_organization_id::text\)/);
    const locks = body().match(/pg_advisory_xact_lock/g) ?? [];
    expect(locks.length).toBe(2);
  });
  it('mints one suggestion per FEFO batch (loop over batches, expiry ASC NULLS LAST then id)', () => {
    expect(body()).toMatch(/FOR v_batch IN[\s\S]*?ORDER BY ws\.expiry_date ASC NULLS LAST, ws\.id ASC/);
  });
});

// ============================================================================
// ITEM 3 — batch-level FEFO everywhere
// ============================================================================
describe('item 3: one suggestion = one batch, FEFO-ordered, conserved', () => {
  it('suggestions carry the exact stock row (source_stock_id NOT NULL) and its snapshot', () => {
    expect(m072).toMatch(/source_stock_id\s+uuid NOT NULL/);
    expect(m072).toMatch(/source_batch_available_snapshot integer/);
  });
  it('suggestion_key embeds the batch/stock row (and the provenance line) so batches never collide', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/\|\| v_batch\.stock_id::text/);
    expect(body).toMatch(/COALESCE\(v_batch\.dispatch_line_id::text, ''\)/);
    const xbody = functionBody('phoenix_suggest_cross_org_inventory_transfer');
    expect(xbody).toMatch(/\|\| v_batch\.stock_id::text/);
  });
  it('regression: batch iteration is FEFO with the mandated total order (expiry ASC NULLS LAST, then id)', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/ORDER BY b\.expiry_date ASC NULLS LAST, b\.stock_id ASC/);
    const fefo = functionBody('phoenix_inventory_fefo_batches');
    expect(fefo).toMatch(/ORDER BY ws\.expiry_date ASC NULLS LAST, ws\.id ASC/);
    expect(fefo).toMatch(/ORDER BY os\.expiry_date ASC NULLS LAST, os\.id ASC/);
  });
  it('regression: several batches => separate suggestions (allocation loops batches inside a source)', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/FOR v_batch IN[\s\S]*?FROM _batch b/);
    expect(body).toMatch(/v_take := LEAST\(v_need_remaining, v_src_remaining, v_batch\.remaining, v_batch\.stock_remaining\)/);
  });
  it('regression: per-batch, per-source and per-target remainders are all decremented (no oversubscription, no overfill)', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/v_need_remaining := v_need_remaining - v_take/);
    expect(body).toMatch(/UPDATE _src SET remaining = remaining - v_take/);
    expect(body).toMatch(/UPDATE _batch SET remaining = remaining - v_take/);
    expect(body).toMatch(/UPDATE _stock_cap SET remaining = remaining - v_take/);
  });
  it('regression: external open/accepted suggestions consume need, source AND batch headroom before allocation', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    // three consumed-headroom subqueries over inventory_transfer_suggestions
    const consumed = body.match(/SELECT SUM\(s\.suggested_quantity\)/g) ?? [];
    expect(consumed.length).toBeGreaterThanOrEqual(4); // need, src, batch, stock_cap
    expect(body).toMatch(/s\.status IN \('open', 'accepted'\)/);
  });
  it('regression: the §9 guard enforces Σ per batch <= available for EVERY writer', () => {
    const body = functionBody('phoenix_inventory_suggestion_guard');
    expect(body).toMatch(/SELECT COALESCE\(SUM\(s\.suggested_quantity\), 0\)/);
    expect(body).toMatch(/v_committed \+ NEW\.suggested_quantity > v_available/);
    expect(body).toMatch(/guard_072_batch_oversubscribed/);
  });
  it('FEFO excludes expired, zero-available stock; quarantine lives in a separate 069 table', () => {
    const fefo = functionBody('phoenix_inventory_fefo_batches');
    expect(fefo).toMatch(/available_quantity > 0/);
    expect(fefo).toMatch(/expiry_date >= current_date/);
    expect(fefo).not.toMatch(/warehouse_quarantine_stock/);
    expect(m072).toMatch(/warehouse_quarantine_stock \(069\)/i);
  });
  it('fefo_pick returns exactly one batch (LIMIT 1 over the batches set)', () => {
    const body = functionBody('phoenix_inventory_fefo_pick');
    expect(body).toMatch(/phoenix_inventory_fefo_batches/);
    expect(body).toMatch(/LIMIT 1/);
  });
});

// ============================================================================
// ITEM 4 — outlet->warehouse feasibility is PROVEN per 071
// ============================================================================
describe('item 4: outlet return suggestions require the proven 071 chain', () => {
  it('provenance columns exist and are mandatory exactly for outlet_to_warehouse rows', () => {
    expect(m072).toMatch(/provenance_dispatch_line_id\s+uuid REFERENCES public\.warehouse_dispatch_lines\(id\) ON DELETE RESTRICT/);
    expect(m072).toMatch(/provenance_inbound_movement_id uuid REFERENCES public\.outlet_stock_movements\(id\) ON DELETE RESTRICT/);
    expect(norm072).toMatch(/inventory_suggestions_return_provenance_chk CHECK \( \(route_kind = 'outlet_to_warehouse' AND provenance_dispatch_line_id IS NOT NULL AND provenance_inbound_movement_id IS NOT NULL\) OR \(route_kind <> 'outlet_to_warehouse' AND provenance_dispatch_line_id IS NULL AND provenance_inbound_movement_id IS NULL\) \)/);
  });
  it('the 071 chain is pinned by the SAME composite-FK targets 071 uses', () => {
    expect(norm072).toMatch(/FOREIGN KEY \(provenance_dispatch_line_id, source_stock_id\) REFERENCES public\.warehouse_dispatch_lines \(id, resulting_outlet_stock_id\)/);
    expect(norm072).toMatch(/FOREIGN KEY \(provenance_inbound_movement_id, provenance_dispatch_line_id\) REFERENCES public\.outlet_stock_movements \(id, dispatch_line_id\)/);
    expect(norm072).toMatch(/FOREIGN KEY \(provenance_inbound_movement_id, source_stock_id\) REFERENCES public\.outlet_stock_movements \(id, outlet_stock_id\)/);
  });
  it('regression: outlet batches require an accepted dispatch line + dispatch_receive movement', () => {
    for (const fn of ['phoenix_inventory_fefo_batches', 'phoenix_suggest_inventory_transfers']) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/wdl\.status IN \('accepted', 'accepted_with_difference'\)/);
      expect(body, fn).toMatch(/osm\.movement_type = 'dispatch_receive'/);
      expect(body, fn).toMatch(/wdl\.resulting_outlet_stock_id = os\.id/);
    }
  });
  it('regression: the returnable cap is received_quantity - returned_quantity (071 formula)', () => {
    for (const fn of ['phoenix_inventory_fefo_batches', 'phoenix_suggest_inventory_transfers',
                      'phoenix_inventory_suggestion_guard', 'phoenix_accept_inventory_transfer_suggestion']) {
      expect(functionBody(fn), fn).toMatch(/COALESCE\(wdl\.received_quantity, 0\) - wdl\.returned_quantity/);
    }
  });
  it('regression: an outlet return with fully-consumed returnable quantity yields nothing (cap > 0 filter + guard)', () => {
    const fefo = functionBody('phoenix_inventory_fefo_batches');
    expect(fefo).toMatch(/\(COALESCE\(wdl\.received_quantity, 0\) - wdl\.returned_quantity\) > 0/);
    const guard = functionBody('phoenix_inventory_suggestion_guard');
    expect(guard).toMatch(/guard_072_exceeds_returnable_quantity/);
  });
  it('regression: a provenance-less outlet batch can never ride the return corridor', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/CONTINUE WHEN v_src\.route_kind = 'outlet_to_warehouse' AND v_batch\.dispatch_line_id IS NULL/);
  });
});

// ============================================================================
// ITEM 5 — org-wide threshold RLS
// ============================================================================
describe('item 5: RLS reads for scope_id NULL threshold rows', () => {
  const policy = () => {
    const at = active072.indexOf('CREATE POLICY inventory_thresholds_select_scoped');
    return normalizeSql(active072.slice(at, at + 900));
  };
  it('scoped rows keep the exact-scope read gate', () => {
    expect(policy()).toMatch(/scope_id IS NOT NULL AND public\.phoenix_can_read_inventory_signal\(organization_id, scope_kind, scope_id\)/);
  });
  it('org-wide rows demand super_admin OR an org-level view_signals grant for the SAME organization', () => {
    expect(policy()).toMatch(/scope_id IS NULL AND \(public\.phoenix_my_role\(\) = 'super_admin' OR public\.phoenix_profile_has_scoped_permission\( auth\.uid\(\), 'inventory\.view_signals', organization_id, NULL, NULL\)\)/);
  });
  it('both branches are keyed to the row organization_id — a third organization matches neither', () => {
    const p = policy();
    const orgRefs = p.match(/organization_id/g) ?? [];
    expect(orgRefs.length).toBeGreaterThanOrEqual(2);
  });
  it('the migration §18 asserts the scope_id IS NULL branch is present in pg_policies', () => {
    expect(active072).toMatch(/v_qual NOT LIKE '%scope_id IS NULL%'/);
  });
});

// ============================================================================
// ITEM 6 — national_code wildcard semantics
// ============================================================================
describe('item 6: coded vs wildcard thresholds', () => {
  const body = () => functionBody('phoenix_recompute_inventory_alerts');

  it('positions split into coded (exact code) and wildcard (code NULL) sets', () => {
    expect(body()).toMatch(/coded AS \(/);
    expect(body()).toMatch(/wildcard AS \(/);
    expect(body()).toMatch(/t\.national_code IS NOT NULL/);
    expect(body()).toMatch(/t\.national_code IS NULL/);
  });
  it('regression: the wildcard aggregate SUMS all codes of the material at the scope', () => {
    expect(body()).toMatch(/SUM\(a\.on_hand\)\s+AS on_hand/);
    expect(body()).toMatch(/SUM\(a\.available\)\s+AS available/);
  });
  it('regression: codes covered by their own coded threshold are excluded from the wildcard (no duplicate signal for one fact)', () => {
    expect(body()).toMatch(/pos\.national_code IS NULL AND NOT EXISTS \(\s*SELECT 1 FROM _thr tc/);
    expect(body()).toMatch(/tc\.national_code IS NOT NULL AND tc\.national_code = a\.national_code/);
  });
  it('regression: generic threshold + coded stock cannot raise a generic missing (missing needs total on_hand = 0)', () => {
    expect(body()).toMatch(/pos\.expected AND cfg\.reorder_point IS NOT NULL AND cfg\.reorder_point > 0 AND COALESCE\(tot\.on_hand, 0\) = 0 THEN 'missing'/);
  });
  it('regression: matching is case-insensitive and deterministic (lower() on both sides, grouped)', () => {
    expect(body()).toMatch(/lower\(scientific_name\) AS sci_lower/);
    expect(body()).toMatch(/lower\(t\.scientific_name\) AS sci_lower/);
    expect(body()).toMatch(/GROUP BY scope_kind, scope_id, lower\(scientific_name\), national_code/);
  });
  it('regression: threshold resolution is exact on the code key and specific-scope beats org default', () => {
    expect(body()).toMatch(/thr\.national_code IS NOT DISTINCT FROM pos\.national_code/);
    expect(body()).toMatch(/ORDER BY \(thr\.scope_id IS NOT NULL\) DESC LIMIT 1/);
  });
  it('regression: absent stock with a scope-specific expectation still raises missing (positions come from thresholds, not stock)', () => {
    expect(body()).toMatch(/bool_or\(t\.scope_id IS NOT NULL\) AS expected/);
  });
});

// ============================================================================
// ITEM 7 — near_expiry_days implemented (option A)
// ============================================================================
describe('item 7: near_expiry_days is a real setting', () => {
  it('bounded 1..270 in the table and validated in the write RPC', () => {
    expect(norm072).toMatch(/inventory_thresholds_near_expiry_days_chk CHECK \(near_expiry_days IS NULL OR \(near_expiry_days >= 1 AND near_expiry_days <= 270\)\)/);
    expect(functionBody('phoenix_upsert_inventory_threshold')).toMatch(/near_expiry_days_out_of_range/);
  });
  it('regression: recompute resolves the EFFECTIVE window — most specific wins, NULL defaults to 270', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/t\.near_expiry_days IS NOT NULL ORDER BY \(t\.scope_id IS NOT NULL\) DESC, \(t\.national_code IS NOT NULL\) DESC LIMIT 1 \), 270\) AS eff_days/);
  });
  it('regression: expired ALWAYS surfaces; near_expiry only inside the effective window', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/s\.expiry_date < current_date OR s\.expiry_date <= \(current_date \+ win\.eff_days\)/);
  });
  it('the effective window is stored on the alert (near_expiry_days column fed by eff_days)', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/win\.eff_days, \(s\.expiry_date - current_date\)/);
    expect(body).toMatch(/near_expiry_days\s*=\s*EXCLUDED\.near_expiry_days/);
  });
  it('048 tiers and graded severities are unchanged', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/interval '3 months'[\s\S]*?'critical_3m'/);
    expect(body).toMatch(/interval '6 months'[\s\S]*?'warning_6m'/);
    expect(body).toMatch(/ELSE 'watch_9m'/);
    expect(body).toMatch(/interval '6 months'\)::date THEN 'medium'/);
    expect(body).toMatch(/ELSE 'low'/);
    expect(m072).toMatch(/expiry_tier IS NULL OR expiry_tier IN \('expired', 'critical_3m', 'warning_6m', 'watch_9m'\)/);
  });
});

// ============================================================================
// ITEM 8 — real-scope permissions (no unjustified (org, NULL, NULL))
// ============================================================================
describe('item 8: permissions are evaluated on the ACTUAL scopes', () => {
  it('regression: suggest builds the permitted-scope set with EXACT-scope checks per warehouse and outlet', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/'inventory\.suggest_transfers', p_organization_id, w\.id, NULL/);
    expect(body).toMatch(/'inventory\.suggest_transfers', p_organization_id, NULL, dp\.id/);
    expect(body).not.toMatch(/'inventory\.suggest_transfers', p_organization_id, NULL, NULL/);
  });
  it('regression: a caller with no permitted scope is rejected (central manager on an unassigned warehouse allocates nothing)', () => {
    const body = functionBody('phoenix_suggest_inventory_transfers');
    expect(body).toMatch(/IF NOT EXISTS \(SELECT 1 FROM _scopes\) THEN RAISE EXCEPTION 'not_authorized_inventory_suggest'/);
    // needs, sources and the supersede pass are all bounded by _scopes
    const scoped = body.match(/FROM _scopes sc/g) ?? [];
    expect(scoped.length).toBeGreaterThanOrEqual(4);
  });
  it('regression: accept/reject check act_on_suggestions on the suggestion source scope OR target scope — never (org, NULL, NULL)', () => {
    for (const fn of ['phoenix_accept_inventory_transfer_suggestion', 'phoenix_reject_inventory_transfer_suggestion']) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/'inventory\.act_on_suggestions', v_s\.source_organization_id, v_s\.source_scope_id, NULL/);
      expect(body, fn).toMatch(/'inventory\.act_on_suggestions', v_s\.source_organization_id, NULL, v_s\.source_scope_id/);
      expect(body, fn).toMatch(/'inventory\.act_on_suggestions', v_s\.target_organization_id, v_s\.target_scope_id, NULL/);
      expect(body, fn).toMatch(/'inventory\.act_on_suggestions', v_s\.target_organization_id, NULL, v_s\.target_scope_id/);
      expect(body, fn).not.toMatch(/act_on_suggestions', v_s\.(source|target)_organization_id, NULL, NULL/);
    }
  });
  it('org-level (org, NULL, NULL) checks remain ONLY for genuinely org-wide operations', () => {
    // org-wide recompute, org-default threshold rows, purge — and nothing else.
    expect(functionBody('phoenix_recompute_inventory_alerts')).toMatch(/'inventory\.recompute', p_organization_id, NULL, NULL/);
    expect(functionBody('phoenix_upsert_inventory_threshold')).toMatch(/p_scope_id IS NULL AND public\.phoenix_profile_has_scoped_permission\( v_actor, 'inventory\.manage_thresholds', p_organization_id, NULL, NULL\)/);
    expect(functionBody('phoenix_purge_inventory_terminal')).toMatch(/'inventory\.purge', p_organization_id, NULL, NULL/);
  });
  it('outlet_officer defaults: view only — no recompute/manage/suggest/act/purge', () => {
    expect(m072).toMatch(/'outlet_officer',\s*'inventory\.view_signals',\s*true/);
    for (const key of ['recompute', 'manage_alerts', 'manage_thresholds', 'suggest_transfers', 'act_on_suggestions', 'purge']) {
      expect(m072).toMatch(new RegExp(`'outlet_officer',\\s*'inventory\\.${key}',\\s*false`));
    }
  });
  it('read gate and alert triage stay exact-scope (from round 2, still enforced)', () => {
    const gate = functionBody('phoenix_can_read_inventory_signal');
    expect(gate).toMatch(/'inventory\.view_signals', p_organization_id, p_scope_id, NULL/);
    expect(gate).toMatch(/'inventory\.view_signals', p_organization_id, NULL, p_scope_id/);
    for (const fn of ['phoenix_acknowledge_inventory_alert', 'phoenix_resolve_inventory_alert', 'phoenix_dismiss_inventory_alert']) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/'inventory\.manage_alerts', v_a\.organization_id, v_a\.scope_id, NULL/);
      expect(body, fn).toMatch(/'inventory\.manage_alerts', v_a\.organization_id, NULL, v_a\.scope_id/);
    }
  });
});

// ============================================================================
// ITEM 9 — accept revalidates against live data
// ============================================================================
describe('item 9: acceptance re-verifies everything and expires stale rows', () => {
  const body = () => functionBody('phoenix_accept_inventory_transfer_suggestion');

  it('re-verifies scope ownership', () => {
    expect(body()).toMatch(/scope_ownership_changed/);
  });
  it('regression: re-verifies the route per corridor (accept after route disabled => expired)', () => {
    expect(body()).toMatch(/warehouse_outlet_pairing_gone/);
    expect(body()).toMatch(/outlet_warehouse_pairing_gone/);
    expect(body()).toMatch(/supply_route_inactive/);
    expect(body()).toMatch(/r\.is_active/);
  });
  it('regression: re-verifies the batch (existence, material, expiry, quantity) — accept after stock change => expired', () => {
    expect(body()).toMatch(/source_batch_gone_or_expired/);
    expect(body()).toMatch(/source_batch_quantity_insufficient/);
    expect(body()).toMatch(/v_available < v_s\.suggested_quantity/);
  });
  it('regression: re-verifies the 071 returnable cap for return suggestions', () => {
    expect(body()).toMatch(/returnable_quantity_insufficient/);
  });
  it('a stale suggestion becomes expired — audited — and is NOT accepted', () => {
    expect(body()).toMatch(/SET status = 'expired', reason = v_stale/);
    expect(body()).toMatch(/'lifecycle', 'expire_on_accept', 'cause', v_stale/);
  });
  it('accept remains intent-only: no stock/movement/dispatch/transfer write', () => {
    expect(body()).toMatch(/status = 'accepted'/);
    expect(body()).not.toMatch(/INSERT INTO public\.(warehouse_stock|outlet_stock|warehouse_stock_movements|outlet_stock_movements|warehouse_dispatches|warehouse_dispatch_lines|warehouse_transfers)\b/i);
    expect(body()).not.toMatch(/UPDATE public\.(warehouse_stock|outlet_stock)\b/i);
    expect(m072).toMatch(/intent recorded; no stock moved/);
  });
});

// ============================================================================
// ITEM 10 — structural guards (fail-closed, bind service_role too)
// ============================================================================
describe('item 10: structural guard triggers', () => {
  it('a BEFORE INSERT OR UPDATE guard trigger exists on each new table', () => {
    expect(norm072).toMatch(/CREATE TRIGGER inventory_threshold_guard BEFORE INSERT OR UPDATE ON public\.inventory_signal_thresholds/);
    expect(norm072).toMatch(/CREATE TRIGGER inventory_alert_guard BEFORE INSERT OR UPDATE ON public\.inventory_alerts/);
    expect(norm072).toMatch(/CREATE TRIGGER inventory_suggestion_guard BEFORE INSERT OR UPDATE ON public\.inventory_transfer_suggestions/);
  });
  it('threshold/alert guards prove scope->organization ownership', () => {
    expect(functionBody('phoenix_inventory_threshold_guard')).toMatch(/guard_072_threshold_scope_not_in_organization/);
    expect(functionBody('phoenix_inventory_alert_guard')).toMatch(/guard_072_alert_scope_not_in_organization/);
  });
  it('suggestion guard proves source/target scope ownership against BOTH organizations', () => {
    const body = functionBody('phoenix_inventory_suggestion_guard');
    expect(body).toMatch(/guard_072_source_scope_not_in_source_organization/);
    expect(body).toMatch(/guard_072_target_scope_not_in_target_organization/);
  });
  it('suggestion guard proves the live route/pairing per corridor', () => {
    const body = functionBody('phoenix_inventory_suggestion_guard');
    expect(body).toMatch(/guard_072_no_warehouse_outlet_pairing/);
    expect(body).toMatch(/guard_072_no_outlet_warehouse_pairing/);
    expect(body).toMatch(/guard_072_no_active_supply_route/);
  });
  it('suggestion guard proves the batch row matches scope + material (both stock tables)', () => {
    const body = functionBody('phoenix_inventory_suggestion_guard');
    expect(body).toMatch(/guard_072_source_stock_row_mismatch/);
    expect(body).toMatch(/FROM public\.warehouse_stock ws/);
    expect(body).toMatch(/FROM public\.outlet_stock os/);
  });
  it('suggestion guard validates a stored exchange reference (orgs + material agree)', () => {
    const body = functionBody('phoenix_inventory_suggestion_guard');
    expect(body).toMatch(/guard_072_exchange_request_mismatch/);
    expect(body).toMatch(/lower\(x\.scientific_name\) = lower\(NEW\.scientific_name\)/);
  });
  it('route_kind <-> scope-kind pairing and same-org corridors are plain CHECKs (no writer can bypass)', () => {
    expect(norm072).toMatch(/inventory_suggestions_route_pairing_chk/);
    expect(norm072).toMatch(/inventory_suggestions_cross_org_route_chk CHECK \(source_organization_id = target_organization_id OR route_kind = 'central_to_institution'\)/);
  });
  it('guard functions are never granted to clients', () => {
    for (const fn of GUARDS) {
      expect(m072, fn).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${fn}\\(\\) FROM PUBLIC, anon`));
      expect(exec072, fn).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${fn}`));
    }
  });
});

// ============================================================================
// Carried-over regressions: fail-closed scope, expectation-driven missing,
// episodes, purge, audit, ACL/RLS, frugality
// ============================================================================
describe('carried over: fail-closed scope resolution and read gate', () => {
  it('scope-org resolver has no ELSE that assumes outlet — unknown kind returns NULL', () => {
    const body = functionBody('phoenix_inventory_scope_org');
    expect(body).toMatch(/WHEN p_scope_kind = 'warehouse'/);
    expect(body).toMatch(/WHEN p_scope_kind = 'outlet'/);
    expect(body).toMatch(/ELSE NULL/);
    expect(body).not.toMatch(/ELSE\s*\(SELECT[^)]*distribution_points/i);
  });
  it('read gate requires kind in (warehouse,outlet) AND scope belongs to the org', () => {
    const body = functionBody('phoenix_can_read_inventory_signal');
    expect(body).toMatch(/p_scope_kind IN \('warehouse', 'outlet'\)/);
    expect(body).toMatch(/phoenix_inventory_scope_org\(p_scope_kind, p_scope_id\) = p_organization_id/);
  });
  it('FEFO and recompute validate the scope before doing work', () => {
    for (const fn of ['phoenix_inventory_fefo_batches', 'phoenix_recompute_inventory_alerts']) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/scope_not_in_organization/);
      expect(body, fn).toMatch(/invalid_scope_kind/);
    }
  });
});

describe('carried over: expectation-driven missing + episodes', () => {
  it('missing requires an expectation and zero on-hand; stock without any threshold yields no signal', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/WHERE q\.signal_type IS NOT NULL/);
  });
  it('a cleared recurrence bumps occurrence_count and reopens even from a terminal status', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/occurrence_count\s*=\s*al\.occurrence_count \+ \(CASE WHEN al\.cleared_at IS NOT NULL THEN 1 ELSE 0 END\)/);
    expect(body).toMatch(/status\s*=\s*CASE WHEN al\.cleared_at IS NOT NULL THEN 'open' ELSE al\.status END/);
  });
  it('clear detection stamps cleared_at on non-violating alerts including dismissed ones', () => {
    const body = functionBody('phoenix_recompute_inventory_alerts');
    expect(body).toMatch(/cleared_at\s*=\s*now\(\)/);
    expect(body).toMatch(/a\.cleared_at IS NULL AND NOT EXISTS \(SELECT 1 FROM _now/);
  });
});

describe('carried over: purge + audit', () => {
  it('purge requires >= 30 days retention and only deletes terminal rows', () => {
    const body = functionBody('phoenix_purge_inventory_terminal');
    expect(body).toMatch(/retention_must_be_at_least_30_days/);
    expect(body).toMatch(/DELETE FROM public\.inventory_alerts[\s\S]*?status IN \('resolved', 'dismissed'\)/);
    expect(body).toMatch(/DELETE FROM public\.inventory_transfer_suggestions[\s\S]*?status IN \('rejected', 'superseded', 'expired'\)/);
  });
  it('purge NEVER deletes an audit_logs row (and §18 asserts it)', () => {
    const body = functionBody('phoenix_purge_inventory_terminal');
    expect(body).not.toMatch(/DELETE FROM public\.audit_logs/);
    expect(m072).toMatch(/purge must never delete audit_logs/);
  });
  it('each human-action RPC inserts an audit_logs row', () => {
    for (const fn of HUMAN_ACTION_RPCS) {
      expect(functionBody(fn), fn).toMatch(/INSERT INTO public\.audit_logs/);
    }
  });
  it('has no cron / scheduled dependency', () => {
    expect(exec072).not.toMatch(/pg_cron|cron\.schedule|CREATE\s+EXTENSION/i);
  });
});

describe('carried over: split permissions', () => {
  it('registers all seven distinct inventory permission keys', () => {
    for (const key of PERMISSION_KEYS) expect(m072, key).toContain(`'${key}'`);
    expect(m072).toMatch(/count\(\*\) FROM public\.permission_keys WHERE key LIKE 'inventory\.%'\) < 7/);
  });
  it('threshold write uses inventory.manage_thresholds; purge is its own dangerous key', () => {
    expect(functionBody('phoenix_upsert_inventory_threshold')).toContain("'inventory.manage_thresholds'");
    expect(functionBody('phoenix_purge_inventory_terminal')).toContain("'inventory.purge'");
    expect(m072).toMatch(/'inventory\.purge',\s*'inventory', 'purge',[^,]*,[^,]*,\s*true\)/);
  });
  it('suggestion CREATION and ACT-ON are different permissions', () => {
    expect(functionBody('phoenix_suggest_inventory_transfers')).toContain("'inventory.suggest_transfers'");
    for (const fn of ['phoenix_accept_inventory_transfer_suggestion', 'phoenix_reject_inventory_transfer_suggestion']) {
      expect(functionBody(fn), fn).toContain("'inventory.act_on_suggestions'");
    }
  });
});

// ============================================================================
// Structural: additive, advisory-only, ACL, RLS, third-org/anon isolation
// ============================================================================
describe('structural: additive, advisory-only, ACL, RLS, frugal', () => {
  it('never ALTERs warehouse_stock or outlet_stock', () => {
    expect(norm072).not.toMatch(/ALTER TABLE public\.(warehouse_stock|outlet_stock)\b/i);
  });
  it('the only DROP statements are DROP POLICY / DROP TRIGGER (idempotence only)', () => {
    const drops = active072.match(/\bDROP\s+(TABLE|VIEW|FUNCTION|POLICY|INDEX|TRIGGER|TYPE|SCHEMA|CONSTRAINT|SEQUENCE)\b/gi) ?? [];
    for (const d of drops) {
      expect(['DROP POLICY', 'DROP TRIGGER']).toContain(d.replace(/\s+/g, ' ').toUpperCase());
    }
  });
  it('recompute/suggest/cross-org never write a physical stock table', () => {
    for (const fn of ['phoenix_recompute_inventory_alerts', 'phoenix_suggest_inventory_transfers',
                      'phoenix_suggest_cross_org_inventory_transfer']) {
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
  it('guard trigger functions are SECURITY DEFINER with pinned search_path too', () => {
    for (const fn of GUARDS) {
      const body = functionBody(fn);
      expect(body, fn).toMatch(/SECURITY DEFINER/i);
      expect(body, fn).toMatch(/SET search_path = public, pg_temp/i);
    }
  });
  it('never grants a table or function to anon or public (anon: no read, no execute, no write path)', () => {
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
  it('suggestion RLS admits only source org, target org, or super_admin — a third organization reads nothing', () => {
    const policyIdx = active072.indexOf('CREATE POLICY inventory_suggestions_select_scoped');
    const policy = active072.slice(policyIdx, policyIdx + 600);
    expect(policy).toMatch(/phoenix_my_role\(\) = 'super_admin'/);
    expect(policy).toMatch(/source_organization_id, source_scope_kind, source_scope_id/);
    expect(policy).toMatch(/target_organization_id, target_scope_kind, target_scope_id/);
  });
  it('a third organization cannot accept either: act permission is bound to the suggestion endpoint orgs', () => {
    const body = functionBody('phoenix_accept_inventory_transfer_suggestion');
    expect(body).toMatch(/v_s\.source_organization_id/);
    expect(body).toMatch(/v_s\.target_organization_id/);
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
  it('§18 carries live post-conditions for policies, triggers, FKs, ACLs, signatures and no-stock-write proofs', () => {
    expect(active072).toMatch(/pg_policies/);
    expect(active072).toMatch(/pg_trigger/);
    expect(active072).toMatch(/has_function_privilege\('anon'/);
    expect(active072).toMatch(/moves physical stock/);
    expect(active072).toMatch(/writes the 036-041 exchange tables/);
    expect(active072).toMatch(/a client-quantity cross-org signature still exists/);
  });
});
