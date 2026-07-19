/**
 * DIRECT-CENTRAL-TO-INSTITUTION-SUPPLY-077-A — static SQL contract tests.
 * CRLF-normalized, whitespace-agnostic, DB-free. Proves the migration is
 * additive, route-free on the new path, and does NOT weaken 068/072.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const ROOT = join(__dirname, '../../../');
const NAME = '077_phoenix_direct_central_to_institution_supply.sql';
const sql = readFileSync(join(ROOT, 'supabase/migrations', NAME), 'utf8').replace(/\r\n?/g, '\n');
const norm = sql.replace(/\s+/g, ' ').trim();

function fn(name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  expect(start, `${name} must be defined`).toBeGreaterThan(-1);
  const end = sql.indexOf('\n$$;', start);
  expect(end).toBeGreaterThan(start);
  return sql.slice(start, end).replace(/\s+/g, ' ');
}

const ASSERT   = fn('phoenix_assert_direct_supply_endpoints');
const CREATE   = fn('phoenix_create_direct_warehouse_transfer_request');
const SEND     = fn('phoenix_send_direct_warehouse_transfer_line');
const SUBMIT   = fn('phoenix_submit_warehouse_transfer_request');
const REVIEW   = fn('phoenix_review_warehouse_transfer_request');
const SUGGEST  = fn('phoenix_suggest_inventory_transfers');
const GUARD    = fn('phoenix_inventory_suggestion_guard');
const AUTHZ    = fn('_phoenix_authorize_transfer_request_write');
// Direct RETURN (institution -> central) + cross-org, added in the completion pass.
const RET_ASSERT     = fn('phoenix_assert_direct_return_endpoints');
const RET_REQUEST    = fn('phoenix_request_direct_warehouse_return');
const RET_RECALL     = fn('phoenix_recall_direct_warehouse_transfer');
const RET_ADD        = fn('phoenix_add_direct_warehouse_return_request_line');
const RET_ADD_LEGACY = fn('phoenix_add_warehouse_return_request_line');
const RET_SUBMIT     = fn('phoenix_submit_warehouse_return_request');
const RET_SEND       = fn('phoenix_send_direct_warehouse_return_shipment_line');
const XORG           = fn('phoenix_suggest_cross_org_inventory_transfer');

describe('077 identity, atomicity, additivity', () => {
  it('is a single transaction', () => {
    expect(norm.toLowerCase().includes('begin;')).toBe(true);
    expect(norm.toLowerCase().includes('commit;')).toBe(true);
  });
  it('is the migration numbered 077', () => {
    expect(NAME).toMatch(/^077_/);
  });
  it('never drops or truncates a real table', () => {
    expect(norm).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(norm).not.toMatch(/\bTRUNCATE\b/i);
  });
  it('fail-closed preconditions guard 068/069/072/066 presence', () => {
    expect(norm).toContain('ABORT 077');
    expect(norm).toMatch(/warehouse_transfer_requests/);
    expect(norm).toMatch(/warehouse_kind/);
  });
});

describe('077 additive schema: route_id becomes nullable, FKs retained', () => {
  it('drops NOT NULL on route_id for all four transfer/return tables', () => {
    for (const tbl of [
      'warehouse_transfer_requests', 'warehouse_transfers',
      'warehouse_return_requests', 'warehouse_return_shipments',
    ]) {
      expect(norm).toMatch(
        new RegExp(`ALTER TABLE public\\.${tbl} ALTER COLUMN route_id DROP NOT NULL`),
      );
    }
  });
  it('does NOT drop the legacy composite route FKs (kept for historical rows)', () => {
    expect(norm).not.toMatch(/DROP\s+CONSTRAINT\s+wtr_route_endpoints_fk/i);
    expect(norm).not.toMatch(/DROP\s+CONSTRAINT\s+wt_route_endpoints_fk/i);
  });
});

describe('077 keeps warehouse_supply_routes + its RPCs as legacy (no removal)', () => {
  it('never drops warehouse_supply_routes or the 075 route RPCs', () => {
    expect(norm).not.toMatch(/DROP\s+TABLE[^;]*warehouse_supply_routes/i);
    expect(norm).not.toMatch(/DROP\s+FUNCTION[^;]*phoenix_create_supply_route/i);
    expect(norm).not.toMatch(/DROP\s+FUNCTION[^;]*phoenix_set_supply_route_active/i);
  });
  it('never REVOKEs execute on the legacy route RPCs', () => {
    expect(norm).not.toMatch(/REVOKE[^;]*phoenix_create_supply_route/i);
  });
});

describe('077 direct RPCs exist and are hardened', () => {
  for (const [n, body] of [
    ['assert', ASSERT], ['create', CREATE], ['send', SEND], ['authz', AUTHZ],
  ] as const) {
    it(`${n} is SECURITY DEFINER with a fixed search_path`, () => {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toMatch(/SET search_path = public, pg_temp/);
    });
  }
  it('direct create takes source + destination directly (no route param)', () => {
    expect(CREATE).toMatch(/p_source_warehouse_id/);
    expect(CREATE).toMatch(/p_destination_organization_id/);
    expect(CREATE).toMatch(/p_destination_warehouse_id/);
    expect(CREATE).not.toMatch(/p_route_id/);
    // pins route_id NULL on the new row
    expect(CREATE).toMatch(/route_id,[^)]*\) VALUES \( NULL,/);
  });
  it('grants execute to authenticated (not anon/public) for the direct RPCs', () => {
    expect(norm).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_create_direct_warehouse_transfer_request[^;]*TO authenticated/);
    expect(norm).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_send_direct_warehouse_transfer_line[^;]*TO authenticated/);
  });
});

describe('077 the DIRECT path never consults warehouse_supply_routes', () => {
  it('direct SEND does not reference warehouse_supply_routes', () => {
    expect(SEND).not.toMatch(/warehouse_supply_routes/);
  });
  it('direct CREATE does not reference warehouse_supply_routes', () => {
    expect(CREATE).not.toMatch(/warehouse_supply_routes/);
  });
  it('the endpoint validator proves central/institution + active, not a route', () => {
    expect(ASSERT).not.toMatch(/warehouse_supply_routes/);
    expect(ASSERT).toMatch(/warehouse_kind <> 'central'/);
    expect(ASSERT).toMatch(/warehouse_kind <> 'institution'/);
    expect(ASSERT).toMatch(/status <> 'active'/);
  });
});

describe('077 direct authority: source-scoped, no permission keys invented', () => {
  it('the build phase authorizes against the SOURCE via warehouse_transfer.send', () => {
    expect(AUTHZ).toMatch(/route_id IS NULL/);
    expect(AUTHZ).toMatch(/'warehouse_transfer\.send'/);
    expect(AUTHZ).toMatch(/source_warehouse_id/);
    // legacy routed branch keeps destination-scoped warehouse_transfer.request
    expect(AUTHZ).toMatch(/'warehouse_transfer\.request'/);
  });
  it('review stays source-scoped warehouse_transfer.review for both paths', () => {
    expect(REVIEW).toMatch(/'warehouse_transfer\.review'/);
  });
  it('submit skips the route active-check only when route_id IS NULL', () => {
    expect(SUBMIT).toMatch(/route_id IS NOT NULL/);
  });
});

describe('072 intelligence: route-free feasibility, nothing weakened', () => {
  it('suggest engine no longer reads warehouse_supply_routes', () => {
    expect(SUGGEST).not.toMatch(/warehouse_supply_routes/);
  });
  it('suggestion guard no longer reads warehouse_supply_routes', () => {
    expect(GUARD).not.toMatch(/warehouse_supply_routes/);
  });
  it('central_to_institution feasibility is judged by warehouse_kind + active', () => {
    expect(SUGGEST).toMatch(/warehouse_kind = 'central' AND \w+\.status = 'active'/);
    expect(SUGGEST).toMatch(/warehouse_kind = 'institution' AND \w+\.status = 'active'/);
    expect(GUARD).toMatch(/no_active_central_institution_pairing/);
  });
  it('candidates stay alert-driven (built from _need / _src, not warehouse pairs)', () => {
    expect(SUGGEST).toMatch(/FROM public\.inventory_alerts a/);
    expect(SUGGEST).toMatch(/_need/);
    expect(SUGGEST).toMatch(/_src/);
  });
  it('recommendation-only: the suggest engine performs no stock ledger write', () => {
    expect(SUGGEST).not.toMatch(/warehouse_stock_movements/);
    expect(SUGGEST).not.toMatch(/UPDATE public\.warehouse_stock\b/);
  });
  it('the guard retains EVERY conservation / identity check from 072 (no weakening)', () => {
    // batch identity re-check under FOR SHARE
    expect(GUARD).toMatch(/guard_072_source_stock_row_mismatch/);
    // batch oversubscription
    expect(GUARD).toMatch(/guard_072_batch_oversubscribed/);
    // 071 returnable cap for outlet->warehouse
    expect(GUARD).toMatch(/guard_072_exceeds_returnable_quantity/);
    // scope->org ownership
    expect(GUARD).toMatch(/guard_072_source_scope_not_in_source_organization/);
    expect(GUARD).toMatch(/guard_072_target_scope_not_in_target_organization/);
    // 041 exchange-request reference agreement
    expect(GUARD).toMatch(/guard_072_exchange_request_mismatch/);
  });
  it('preserves the suggest return shape the frontend reads (suggestions/superseded)', () => {
    expect(SUGGEST).toMatch(/'suggestions', v_upserted/);
    expect(SUGGEST).toMatch(/'superseded', v_superseded/);
  });
});

describe('077 DIRECT RETURN lifecycle (institution -> central), route-free', () => {
  it('all direct return RPCs are SECURITY DEFINER with a fixed search_path', () => {
    for (const body of [RET_ASSERT, RET_REQUEST, RET_RECALL, RET_ADD, RET_SEND]) {
      expect(body).toContain('SECURITY DEFINER');
      expect(body).toMatch(/SET search_path = public, pg_temp/);
    }
  });
  it('the direct return BUILD/SEND path never consults warehouse_supply_routes', () => {
    for (const body of [RET_ASSERT, RET_REQUEST, RET_RECALL, RET_ADD, RET_SEND]) {
      expect(body).not.toMatch(/warehouse_supply_routes/);
    }
  });
  it('takes no route param and pins route_id NULL on the return row/shipment', () => {
    for (const body of [RET_REQUEST, RET_RECALL, RET_SEND]) {
      expect(body).not.toMatch(/p_route_id/);
    }
    // request/recall insert the return row with a literal NULL route_id
    expect(RET_REQUEST).toMatch(/route_id,[^)]*\) VALUES \( NULL,/);
    expect(RET_RECALL).toMatch(/route_id,[^)]*\) VALUES \( NULL,/);
  });
  it('derives the reverse corridor from PROVENANCE, not a route', () => {
    // an active institution source + active central destination…
    expect(RET_ASSERT).toMatch(/warehouse_kind <> 'institution'/);
    expect(RET_ASSERT).toMatch(/warehouse_kind <> 'central'/);
    expect(RET_ASSERT).toMatch(/status <> 'active'/);
    // …and a REAL direct forward transfer that connected them.
    expect(RET_ASSERT).toMatch(/no_direct_forward_provenance_between_warehouses/);
    expect(RET_ASSERT).toMatch(/tr\.route_id IS NULL/);
    // every returned line must belong to a DIRECT forward transfer on this corridor
    expect(RET_ADD).toMatch(/original_line_not_from_this_direct_corridor/);
    expect(RET_ADD).toMatch(/v_transfer\.route_id IS NOT NULL/);
  });
  it('request is institution-scoped, recall is central-scoped (separation of duty)', () => {
    expect(RET_REQUEST).toMatch(/'warehouse_transfer\.return_request'/);
    expect(RET_RECALL).toMatch(/'warehouse_transfer\.recall'/);
  });
  it('reuses the (route-free) 069 RECEIVE — no receive RPC redefined here', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_receive_warehouse_return_shipment_line/);
    expect(norm).toMatch(/the 069 return RECEIVE is missing/);
  });
});

describe('077 disabled / inactive endpoints are refused (fail-closed)', () => {
  it('forward endpoints must be active central -> active institution', () => {
    expect(ASSERT).toMatch(/source_must_be_active_central_warehouse/);
    expect(ASSERT).toMatch(/destination_must_be_active_institution_warehouse/);
  });
  it('return endpoints must be active institution -> active central', () => {
    expect(RET_ASSERT).toMatch(/source_must_be_active_institution_warehouse/);
    expect(RET_ASSERT).toMatch(/destination_must_be_active_central_warehouse/);
  });
  it('send/submit re-assert endpoints so a mid-flight deactivation cannot slip past', () => {
    expect(SEND).toMatch(/phoenix_assert_direct_supply_endpoints/);
    expect(RET_SEND).toMatch(/phoenix_assert_direct_return_endpoints/);
    expect(RET_SUBMIT).toMatch(/phoenix_assert_direct_return_endpoints/);
  });
});

describe('077 IDOR: authority is scoped to the pinned warehouse, never the caller', () => {
  it('forward send requires the stock to sit in the request source warehouse', () => {
    expect(SEND).toMatch(/stock_not_in_source_warehouse/);
    expect(SEND).toMatch(/'warehouse_transfer\.send'/);
  });
  it('a warehouse cannot be pinned to the wrong organization', () => {
    expect(ASSERT).toMatch(/destination_warehouse_not_in_named_organization/);
  });
  it('return send requires the stock to sit in the return source (institution) warehouse', () => {
    expect(RET_SEND).toMatch(/stock_not_in_source_warehouse/);
    expect(RET_SEND).toMatch(/stock_organization_mismatch/);
    expect(RET_SEND).toMatch(/'warehouse_transfer\.return_send'/);
  });
  it('return add-line rejects an original line not received at this institution', () => {
    expect(RET_ADD).toMatch(/original_line_not_at_this_institution/);
  });
});

describe('077 concurrency, idempotency, duplicate request ids', () => {
  it('both direct SEND paths take an advisory lock before row locks', () => {
    expect(SEND).toMatch(/pg_advisory_xact_lock/);
    expect(RET_SEND).toMatch(/pg_advisory_xact_lock/);
  });
  it('both direct SEND paths replay idempotently on the same request id', () => {
    expect(SEND).toMatch(/idempotent_replay', true/);
    expect(RET_SEND).toMatch(/idempotent_replay', true/);
  });
  it('a reused request id with different args is a conflict, not a double-send', () => {
    expect(SEND).toMatch(/request_id_conflict/);
    expect(SEND).toMatch(/request_fingerprint/);
    expect(RET_SEND).toMatch(/request_id_conflict/);
    expect(RET_SEND).toMatch(/request_fingerprint/);
  });
});

describe('077 insufficient stock is refused on both directions', () => {
  it('forward + return send refuse negative and below-reserved balances', () => {
    for (const body of [SEND, RET_SEND]) {
      expect(body).toMatch(/warehouse_quantity_cannot_go_negative/);
      expect(body).toMatch(/warehouse_quantity_below_reserved/);
    }
  });
  it('per-line and per-original caps are enforced on the return send', () => {
    expect(RET_SEND).toMatch(/return_line_would_be_over_fulfilled/);
    expect(RET_SEND).toMatch(/original_line_would_be_over_returned/);
  });
  it('forward send caps a line at its approved quantity', () => {
    expect(SEND).toMatch(/request_line_would_be_over_fulfilled/);
  });
});

describe('077 cross-org suggestion: route-free, isolated, recommendation-only', () => {
  it('no longer consults warehouse_supply_routes', () => {
    expect(XORG).not.toMatch(/warehouse_supply_routes/);
  });
  it('feasibility is an active central source + active institution target, org-owned', () => {
    expect(XORG).toMatch(/no_active_central_institution_pairing/);
    expect(XORG).toMatch(/warehouse_kind = 'central'\s+AND \w+\.status = 'active'/);
    expect(XORG).toMatch(/warehouse_kind = 'institution' AND \w+\.status = 'active'/);
    expect(XORG).toMatch(/sw\.organization_id = p_source_organization_id/);
    expect(XORG).toMatch(/tw\.organization_id = p_target_organization_id/);
  });
  it('stays super_admin-only and mints NO stock movement (recommendation-only)', () => {
    expect(XORG).toMatch(/cross_org_suggestion_requires_super_admin/);
    expect(XORG).not.toMatch(/warehouse_stock_movements/);
    expect(XORG).not.toMatch(/UPDATE public\.warehouse_stock\b/);
  });
});

describe('077 legacy routed rows stay valid and are never a prerequisite', () => {
  it('the legacy routed return add-line fail-closed-rejects a direct request', () => {
    expect(RET_ADD_LEGACY).toMatch(/use_direct_add_line_for_direct_return/);
    expect(RET_ADD_LEGACY).toMatch(/v_request\.route_id IS NULL/);
  });
  it('return submit only reads the route table for a legacy routed request', () => {
    expect(RET_SUBMIT).toMatch(/route_id IS NOT NULL/);
  });
  it('the legacy routed SEND (069) is left untouched (not redefined here)', () => {
    expect(sql).not.toMatch(/CREATE OR REPLACE FUNCTION public\.phoenix_send_warehouse_return_shipment_line/);
  });
  it('the legacy RETURN composite route FKs are not dropped', () => {
    expect(norm).not.toMatch(/DROP\s+CONSTRAINT\s+wrr_route_endpoints_fk/i);
    expect(norm).not.toMatch(/DROP\s+CONSTRAINT\s+wrs_route_endpoints_fk/i);
  });
});

describe('077 does not weaken 069 (returns) — caps, quarantine, no expiry-refusal', () => {
  it('the return send has NO expiry-refusal (a return is often of an expired batch)', () => {
    expect(RET_SEND).not.toMatch(/expired_batch_cannot_be_sent/);
  });
  it('post-conditions assert the route-free 069 RECEIVE is retained', () => {
    expect(norm).toMatch(/reused by the direct path/);
  });
});

describe('077 post-conditions are present for staging validation', () => {
  it('asserts nullability, retained FKs, route-free bodies, and legacy retention', () => {
    expect(norm).toContain('POSTCOND 077');
    expect(norm).toMatch(/route_id did not become nullable/);
    expect(norm).toMatch(/still references warehouse_supply_routes/);
    expect(norm).toMatch(/legacy supply-route object was removed/);
  });
  it('extends coverage to the return tables and the cross-org path', () => {
    expect(norm).toMatch(/route_id did not become nullable on the return tables/);
    expect(norm).toMatch(/a legacy RETURN route FK was dropped/);
    expect(norm).toMatch(/a direct-supply\/return RPC is missing/);
    expect(norm).toMatch(/cross-org suggest still references warehouse_supply_routes/);
  });
});
