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

describe('077 post-conditions are present for staging validation', () => {
  it('asserts nullability, retained FKs, route-free bodies, and legacy retention', () => {
    expect(norm).toContain('POSTCOND 077');
    expect(norm).toMatch(/route_id did not become nullable/);
    expect(norm).toMatch(/still references warehouse_supply_routes/);
    expect(norm).toMatch(/legacy supply-route object was removed/);
  });
});
