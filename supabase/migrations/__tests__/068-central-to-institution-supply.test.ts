/**
 * CENTRAL-TO-INSTITUTION-SUPPLY-068-A
 *
 * Static SQL-source tests for migration 068 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 052–067.
 *
 * 068 completes the movement 066 modelled but did not build: central warehouse
 * -> institution warehouse, along an approved warehouse_supply_route, so the
 * supply chain is continuous (central --068--> institution --061/067--> outlet).
 * It is the EXPAND step of Expand -> Frontend Migration -> Contract, so its
 * value depends on being ADDITIVE: the negative assertions here — that 068 does
 * not DROP/RENAME/REVOKE, does not touch item_availability or its legacy paths,
 * does not widen 060's movement_type CHECK, and does not turn RBAC enforcement
 * on — matter as much as the positive ones.
 *
 * THE STRUCTURAL FACT THIS FILE KEEPS RE-CHECKING: TRANSFERS CROSS ORGANIZATIONS
 * -------------------------------------------------------------------------
 * A central warehouse belongs to the pharmacy-department org; an institution
 * warehouse belongs to its own. 061's single-organization composite-FK pattern
 * does not apply here, so every table carries its OWN source/destination
 * organization pin. Several tests below exist only to prove that dual pinning
 * survived, since collapsing it back to one organization_id would silently
 * reintroduce a same-org assumption 068 was written to avoid.
 *
 * WHAT A STATIC TEST CAN AND CANNOT PROVE
 * ---------------------------------------
 * These tests prove the migration SOURCE contains the boundaries it must
 * contain, and that a future edit cannot quietly remove one. They do not
 * execute SQL, so they cannot prove runtime behaviour. Pre-merge validation of
 * this migration did not include execution against a disposable PostgreSQL
 * database; validation used static analysis, tests, CI, and Supabase dry-run —
 * unlike 060-067, its post-condition block (part 12) is unexecuted analysis,
 * not a proven runtime guarantee. That fact is itself asserted below so it
 * cannot be silently forgotten. This phrasing is a permanent historical
 * record of what pre-merge validation covered, not a status to flip later.
 *
 * NOTE ON SCOPE: like 060–067, this file carries NO global ceiling assertion.
 * The reviewed maximum belongs to reviewed-migration-manifest.test.ts alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES, isReviewedMigrationFile } from './helpers/reviewed-migrations';
import {
  activeSql,
  executableSql,
  normalizeSql,
  sqlFunctionSource,
} from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M068_NAME = '068_phoenix_central_to_institution_supply.sql';
const P068 = join(MIGRATIONS_DIR, M068_NAME);
const m068 = readFileSync(P068, 'utf8');

const active068 = activeSql(m068);
const norm068 = normalizeSql(active068);

/** Executable SQL with string literals blanked, so RAISE prose cannot match. */
const exec068 = executableSql(m068);

/** The body of one CREATE FUNCTION, by name — for per-RPC assertions. */
function functionBody(name: string): string {
  const src = sqlFunctionSource(m068, name);
  expect(src, `function ${name} must exist`).not.toBeNull();
  return normalizeSql(src!);
}

/** The two stock-moving RPCs 068 introduces. Every one obeys the SEND/RECEIVE
 *  contract: advisory lock, fingerprint, 68068 lock namespace. */
const WRITE_RPCS = [
  'phoenix_send_warehouse_transfer_line',
  'phoenix_receive_warehouse_transfer_line',
] as const;

/** The seven request-lifecycle RPCs 068 introduces. None moves stock, so none
 *  shares WRITE_RPCS's fingerprint/68068-lock contract — but each does write
 *  to warehouse_transfer_requests/_lines from inside its own body. */
const REQUEST_LIFECYCLE_RPCS = [
  'phoenix_create_warehouse_transfer_request',
  'phoenix_add_warehouse_transfer_request_line',
  'phoenix_update_warehouse_transfer_request_line',
  'phoenix_delete_warehouse_transfer_request_line',
  'phoenix_submit_warehouse_transfer_request',
  'phoenix_cancel_warehouse_transfer_request',
  'phoenix_review_warehouse_transfer_request',
] as const;

// ============================================================================
// 1. Presence and registration
// ============================================================================

describe('1. migration 068 exists exactly once and is registered', () => {
  it('068_phoenix_central_to_institution_supply.sql exists', () => {
    expect(existsSync(P068)).toBe(true);
  });

  it('is the only file named 068_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('068_'))).toEqual([M068_NAME]);
  });

  it('is registered in the reviewed-migration registry by exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M068_NAME);
    expect(isReviewedMigrationFile(M068_NAME)).toBe(true);
  });

  it('is a single atomic transaction — begin ... commit', () => {
    expect(active068.trimStart().startsWith('begin;')).toBe(true);
    expect(active068.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('is marked manual-apply-only', () => {
    expect(m068).toMatch(/MANUAL APPLY ONLY/);
  });

  it('documents that pre-merge validation excluded execution against a disposable Postgres', () => {
    // Deliberately documenting an absence: 060-067 were each run inside a
    // rolled-back transaction (or read-only verified live) before merge. 068's
    // post-condition block is analysis only. This phrasing is permanent
    // (historical record of what pre-merge validation covered), not a status
    // to flip once the migration is eventually applied — do not delete it.
    expect(m068.replace(/^--\s?/gm, '').replace(/\s+/g, ' ')).toMatch(
      /pre-merge validation did not include execution against a disposable postgresql database; validation used static analysis, tests, ci, and supabase dry-run/i
    );
  });
});

// ============================================================================
// 2. Rollback on failure — the whole migration, or none of it
// ============================================================================

describe('2. the migration rolls back completely on failure', () => {
  it('opens exactly one transaction and closes it exactly once', () => {
    expect(active068.match(/^\s*begin;/gm)?.length).toBe(1);
    expect(active068.match(/^\s*commit;/gm)?.length).toBe(1);
  });

  it('never commits early, mid-migration', () => {
    const firstCommit = active068.indexOf('\ncommit;');
    expect(active068.slice(0, firstCommit)).not.toMatch(/\bcommit\s*;/);
  });

  it('contains no COMMIT/ROLLBACK inside a function body or DO block', () => {
    expect(exec068).not.toMatch(/\bROLLBACK\b/i);
  });

  it('verifies its preconditions before creating anything', () => {
    const guard = active068.indexOf('$guard$');
    const firstCreate = active068.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_transfer_requests');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstCreate);
  });

  it('requires 060/061/062/066/067 to be present first', () => {
    expect(m068).toContain('ABORT 068: expected 060/066 schema is absent');
    expect(m068).toContain('ABORT 068: 062 scope helper is absent');
    expect(m068).toContain('ABORT 068: migration 067 is absent');
    expect(m068).toContain('ABORT 068: warehouse_stock_id_org_uniq (061) is absent');
  });
});

// ============================================================================
// 3. Cross-organization structure — the load-bearing design decision
// ============================================================================

describe('3. every table pins BOTH sides to their own organization', () => {
  it('warehouse_transfer_requests carries independent source/destination org columns', () => {
    expect(norm068).toMatch(/source_warehouse_id\s+uuid NOT NULL/);
    expect(norm068).toMatch(/source_organization_id\s+uuid NOT NULL/);
    expect(norm068).toMatch(/destination_warehouse_id\s+uuid NOT NULL/);
    expect(norm068).toMatch(/destination_organization_id\s+uuid NOT NULL/);
  });

  it('pins the source warehouse to its OWN org via composite FK', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wtr_source_wh_org_fk FOREIGN KEY \(source_warehouse_id, source_organization_id\) REFERENCES public\.warehouses \(id, organization_id\)/,
    );
  });

  it('pins the destination warehouse to its OWN org via composite FK', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wtr_dest_wh_org_fk FOREIGN KEY \(destination_warehouse_id, destination_organization_id\) REFERENCES public\.warehouses \(id, organization_id\)/,
    );
  });

  it('warehouse_transfers repeats the same dual pinning, independently', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wt_source_wh_org_fk FOREIGN KEY \(source_warehouse_id, source_organization_id\) REFERENCES public\.warehouses \(id, organization_id\)/,
    );
    expect(norm068).toMatch(
      /CONSTRAINT wt_dest_wh_org_fk FOREIGN KEY \(destination_warehouse_id, destination_organization_id\) REFERENCES public\.warehouses \(id, organization_id\)/,
    );
  });

  it('never collapses to a single organization_id column on the header tables', () => {
    // A single shared organization_id would silently reintroduce a same-org
    // assumption. Both header tables must show the split columns instead.
    const wtrBlock = norm068.slice(
      norm068.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_transfer_requests'),
      norm068.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS wtr_dest_org_number_uniq'),
    );
    expect(wtrBlock).not.toMatch(/\borganization_id\s+uuid NOT NULL,/);
    const wtBlock = norm068.slice(
      norm068.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_transfers'),
      norm068.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS wt_source_org_number_uniq'),
    );
    expect(wtBlock).not.toMatch(/\borganization_id\s+uuid NOT NULL,/);
  });

  it('the post-conditions prove BOTH sides are pinned on both header tables', () => {
    expect(m068).toContain(
      "'wtr_source_wh_org_fk','wtr_dest_wh_org_fk','wt_source_wh_org_fk','wt_dest_wh_org_fk'",
    );
    expect(m068).toContain('ABORT 068: missing per-side organization pin');
  });
});

// ============================================================================
// 4. Route enforcement is a composite FK, not a convention
// ============================================================================

describe('4. every request and transfer is pinned to an approved supply route', () => {
  it('requests reference the route by composite FK on (route_id, source, destination)', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wtr_route_endpoints_fk FOREIGN KEY \(route_id, source_warehouse_id, destination_warehouse_id\) REFERENCES public\.warehouse_supply_routes \(id, source_warehouse_id, target_warehouse_id\)/,
    );
  });

  it('transfers reference the route the same way', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wt_route_endpoints_fk FOREIGN KEY \(route_id, source_warehouse_id, destination_warehouse_id\) REFERENCES public\.warehouse_supply_routes \(id, source_warehouse_id, target_warehouse_id\)/,
    );
  });

  it('adds the composite FK target on warehouse_supply_routes without DROP', () => {
    // Without UNIQUE (id, source, target) the FK above fails with ERROR 42830.
    expect(norm068).toMatch(
      /ADD CONSTRAINT warehouse_supply_routes_id_endpoints_uniq UNIQUE \(id, source_warehouse_id, target_warehouse_id\)/,
    );
    expect(norm068).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
  });

  it('does not reuse the 066 partial active-pair index as the FK target', () => {
    // 066's warehouse_supply_routes_active_pair_uniq is WHERE is_active — a
    // partial unique index cannot be an FK target at all, which is exactly why
    // this migration adds its own non-partial composite key instead.
    expect(norm068).not.toMatch(/REFERENCES public\.warehouse_supply_routes[^;]*active_pair/);
  });

  it('inherits 066 direction (central->institution) rather than re-declaring it', () => {
    // No new CHECK naming 'central'/'institution' should appear in 068 — the
    // guarantee comes from proving the endpoints equal the route's, and the
    // route itself is already pinned by 066.
    const newChecks = [...exec068.matchAll(/CONSTRAINT \w+_chk CHECK \(([^)]*)\)/g)].map(m => m[1]);
    for (const c of newChecks) {
      expect(c).not.toMatch(/'central'|'institution'/);
    }
  });

  it('proves 066 direction FKs still exist, since 068 depends on them', () => {
    expect(m068).toContain('warehouse_supply_routes_source_central_fk');
    expect(m068).toContain('warehouse_supply_routes_target_institution_fk');
    expect(m068).toContain("ABORT 068: 066 supply direction FKs are gone");
  });

  it('checks route is_active in the RPC, not via the FK (mutability)', () => {
    const body = functionBody('phoenix_send_warehouse_transfer_line');
    expect(body).toContain('supply_route_inactive');
    expect(body).toMatch(/IF NOT v_route\.is_active THEN/);
  });

  it('proves route-endpoint enforcement is structural, not conventional', () => {
    expect(m068).toContain(
      "ABORT 068: supply-route enforcement is not a composite FK",
    );
    expect(m068).toContain('ABORT 068: the route composite FK target is missing');
  });
});

// ============================================================================
// 5. warehouse_transfer_requests / lines — the institution asks
// ============================================================================

describe('5. requests name a material, never a batch', () => {
  it('requests carry no batch/expiry columns — the central warehouse picks lots at send', () => {
    const reqLinesBlock = norm068.slice(
      norm068.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_transfer_request_lines'),
      norm068.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS wtrl_request_material_uniq'),
    );
    expect(reqLinesBlock).not.toMatch(/batch_number/);
    expect(reqLinesBlock).not.toMatch(/expiry_date/);
  });

  it('one line per material per request', () => {
    expect(norm068).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS wtrl_request_material_uniq ON public\.warehouse_transfer_request_lines/,
    );
  });

  it('fulfilled_quantity can never exceed requested_quantity', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wtrl_fulfilled_le_requested_chk CHECK \(fulfilled_quantity <= requested_quantity\)/,
    );
  });

  it('requested_quantity must be positive; fulfilled_quantity non-negative', () => {
    expect(norm068).toMatch(/CONSTRAINT wtrl_requested_qty_chk\s+CHECK \(requested_quantity > 0\)/);
    expect(norm068).toMatch(/CONSTRAINT wtrl_fulfilled_qty_chk\s+CHECK \(fulfilled_quantity >= 0\)/);
  });

  it('request lines CASCADE with their header — the only cascade in 068', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wtrl_request_org_fk FOREIGN KEY \(transfer_request_id, destination_organization_id\) REFERENCES public\.warehouse_transfer_requests \(id, destination_organization_id\) ON DELETE CASCADE/,
    );
  });

  it('a request cannot supply itself', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wtr_no_self_supply CHECK \(source_warehouse_id <> destination_warehouse_id\)/,
    );
  });

  it('a request must have been requested before it leaves draft', () => {
    expect(norm068).toMatch(/CONSTRAINT wtr_requested_at_chk/);
  });

  it('the send RPC refuses to over-fulfil a request line', () => {
    const body = functionBody('phoenix_send_warehouse_transfer_line');
    expect(body).toContain('request_line_would_be_over_fulfilled');
    // Bounded by what was APPROVED by review, never by what was merely
    // requested — a partial approval is a real ceiling.
    expect(body).toMatch(
      /IF v_reqline\.fulfilled_quantity \+ p_quantity > v_reqline\.approved_quantity THEN/,
    );
    expect(body).toContain('request_line_not_approved');
  });

  it('the send RPC pins the request line to the SAME route as the send', () => {
    // Otherwise a send could satisfy a request through a different, unrelated
    // route than the one it names.
    const body = functionBody('phoenix_send_warehouse_transfer_line');
    expect(body).toMatch(/JOIN public\.warehouse_transfer_requests r ON r\.id = l\.transfer_request_id/);
    expect(body).toMatch(/WHERE l\.id = p_transfer_request_line_id AND r\.route_id = p_route_id/);
  });
});

// ============================================================================
// 6. warehouse_transfers / lines — the send, and the truck in between
// ============================================================================

describe('6. a transfer exists only because stock physically left', () => {
  it('has no draft state — the row IS the send', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wt_status_chk\s+CHECK \(status IN \('in_transit', 'partially_received', 'received'\)\)/,
    );
    expect(norm068).not.toMatch(/CONSTRAINT wt_status_chk[^)]*'draft'/);
  });

  it('has no cancelled state — un-sending is a return (069), not an UPDATE', () => {
    const wtCheck = norm068.slice(
      norm068.indexOf('CONSTRAINT wt_status_chk'),
      norm068.indexOf('CONSTRAINT wt_status_chk') + 200,
    );
    expect(wtCheck).not.toContain("'cancelled'");
  });

  it('transfer lines snapshot identity, since the parent stock row is mutable', () => {
    for (const col of [
      'scientific_name', 'trade_name', 'concentration', 'dosage_form', 'unit',
      'national_code', 'batch_number', 'internal_batch_reference',
    ]) {
      expect(norm068).toMatch(new RegExp(`${col}\\s+text`));
    }
    // expiry_date is a date, not text — snapshotted just the same.
    expect(norm068).toMatch(/expiry_date\s+date/);
  });

  it('a transfer line cannot report receiving more than was sent', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wtl_received_le_sent_chk\s+CHECK \(received_quantity IS NULL OR received_quantity <= sent_quantity\)/,
    );
  });

  it('sent_quantity must be positive', () => {
    expect(norm068).toMatch(/CONSTRAINT wtl_sent_qty_chk\s+CHECK \(sent_quantity > 0\)/);
  });

  it('the decision state machine is expressed as data (wtl_decision_chk)', () => {
    expect(norm068).toContain('wtl_decision_chk');
    for (const state of ['in_transit', 'received', 'received_with_difference', 'rejected']) {
      expect(norm068.slice(norm068.indexOf('wtl_decision_chk'))).toContain(state);
    }
  });

  it('a rejected or partial receipt must be explained', () => {
    const decisionBlock = norm068.slice(
      norm068.indexOf('CONSTRAINT wtl_decision_chk'),
      norm068.indexOf('CONSTRAINT wtl_decision_chk') + 900,
    );
    expect(decisionBlock).toMatch(/difference_reason IS NOT NULL/);
  });

  it('transfer lines CASCADE with their header, mirroring 061 dispatch lines', () => {
    expect(norm068).toMatch(
      /CONSTRAINT wtl_transfer_org_fk FOREIGN KEY \(transfer_id, source_organization_id\) REFERENCES public\.warehouse_transfers \(id, source_organization_id\) ON DELETE CASCADE/,
    );
  });

  it('the cascade cannot destroy a balance — it only reaches the intent record', () => {
    // The balance lives in warehouse_stock, never in warehouse_transfer_lines.
    // Scoped tightly to "REFERENCES public.warehouse_stock ... ON DELETE" so it
    // cannot accidentally match an unrelated CASCADE elsewhere in the file.
    expect(norm068).not.toMatch(
      /REFERENCES public\.warehouse_stock\s*\([^)]*\)\s*ON DELETE CASCADE/,
    );
  });

  it('resulting_warehouse_stock_id is retention-soft (SET NULL), not RESTRICT', () => {
    expect(norm068).toMatch(
      /resulting_warehouse_stock_id\s+uuid REFERENCES public\.warehouse_stock\(id\) ON DELETE SET NULL/,
    );
  });
});

// ============================================================================
// 7. In-transit stock is DERIVED, never stored
// ============================================================================

describe('7. warehouse_stock_in_transit is a view, not a column', () => {
  it('creates a VIEW, not a table or a column on warehouse_stock', () => {
    expect(norm068).toMatch(/CREATE OR REPLACE VIEW public\.warehouse_stock_in_transit/);
    // 068 never creates outlet_stock (that is 067's table) or adds an
    // in_transit column to warehouse_stock — checked precisely in section 7's
    // "proves no in_transit column was denormalized" test below.
    expect(exec068).not.toMatch(/CREATE TABLE IF NOT EXISTS public\.outlet_stock\b/);
    expect(exec068).not.toMatch(/ALTER TABLE public\.warehouse_stock\b/);
  });

  it('is security_invoker, so it cannot become an RLS bypass', () => {
    expect(norm068).toMatch(
      /CREATE OR REPLACE VIEW public\.warehouse_stock_in_transit\s*WITH \(security_invoker = true\)/,
    );
  });

  it('sums quantity from in_transit LINES, never from a stored counter', () => {
    const viewSrc = norm068.slice(
      norm068.indexOf('CREATE OR REPLACE VIEW public.warehouse_stock_in_transit'),
      norm068.indexOf('COMMENT ON VIEW public.warehouse_stock_in_transit'),
    );
    expect(viewSrc).toContain("WHERE l.status = 'in_transit'");
    expect(viewSrc).toContain('sum(l.sent_quantity)');
  });

  it('proves no in_transit column was denormalized onto warehouse_stock', () => {
    expect(m068).toContain('ABORT 068: in-transit was denormalized onto warehouse_stock');
    expect(m068).toContain('ABORT 068: the in-transit view is not security_invoker');
  });
});

// ============================================================================
// 8. Idempotency and locking — the same contract as 065/067
// ============================================================================

describe('8. one request produces at most one movement, everywhere', () => {
  it('adds a transfer idempotency index without touching the 065 request index', () => {
    expect(norm068).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_transfer_once_uniq/,
    );
    expect(exec068).not.toMatch(/DROP INDEX/i);
  });

  it('covers BOTH new reference types with the transfer idempotency index', () => {
    const idx = norm068.slice(norm068.indexOf('warehouse_stock_movements_transfer_once_uniq'));
    expect(idx).toContain('warehouse_transfer_send');
    expect(idx).toContain('warehouse_transfer_receive');
  });

  it('one transfer line can be received at most once, independent of request id', () => {
    expect(norm068).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_movements_transfer_line_once_uniq/,
    );
  });

  it('adds a fingerprint CHECK for the new reference types, additively', () => {
    expect(norm068).toContain('warehouse_stock_movements_transfer_fingerprint_chk');
    expect(norm068).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
  });

  it('both write RPCs compute a fingerprint and fail closed on replay conflict', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('encode(sha256(convert_to(jsonb_build_object(');
      expect(body, rpc).toContain('request_fingerprint');
      expect(body, rpc).toContain('request_id_conflict');
    }
  });

  it('both write RPCs take the advisory lock BEFORE any row lock', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body.indexOf('pg_advisory_xact_lock'), rpc).toBeGreaterThan(-1);
      expect(body.indexOf('FOR UPDATE'), rpc).toBeGreaterThan(-1);
      expect(body.indexOf('pg_advisory_xact_lock'), rpc).toBeLessThan(body.indexOf('FOR UPDATE'));
    }
  });

  it('uses the SAME advisory-lock namespace convention (68068), distinct from 065/067', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toContain('68068');
    }
  });

  it('a transfer line leaves in_transit exactly once (row lock + status check)', () => {
    const body = functionBody('phoenix_receive_warehouse_transfer_line');
    expect(body).toContain('transfer_line_already_received');
    expect(body).toMatch(/IF v_line\.status <> '.*?' THEN/);
  });

  it('proves both idempotency indexes exist and the 065 contract survived', () => {
    expect(m068).toContain('ABORT 068: transfer idempotency index missing');
    expect(m068).toContain('ABORT 068: 065 request idempotency index was removed');
  });
});

// ============================================================================
// 9. Negative stock, expired batches, reserved stock, IDOR
// ============================================================================

describe('9. the send RPC refuses to break a physical invariant', () => {
  const sendBody = functionBody('phoenix_send_warehouse_transfer_line');

  it('refuses to drive the source warehouse negative', () => {
    expect(sendBody).toContain('warehouse_quantity_cannot_go_negative');
  });

  it('refuses to ship reserved stock out from under a reservation', () => {
    expect(sendBody).toContain('warehouse_quantity_below_reserved');
  });

  it('refuses to ship an expired batch onward', () => {
    expect(sendBody).toContain('expired_batch_cannot_be_sent');
    expect(sendBody).toMatch(/v_stock\.expiry_date < current_date/);
  });

  it('proves the stock physically sits in the route SOURCE warehouse (IDOR)', () => {
    // Without this a caller holding a valid route could drain an unrelated
    // warehouse it happens to be separately assigned to.
    expect(sendBody).toContain('stock_not_in_route_source_warehouse');
    expect(sendBody).toMatch(
      /IF v_stock\.warehouse_id IS DISTINCT FROM v_route\.source_warehouse_id THEN/,
    );
  });

  it('authorizes via scoped permission on the SOURCE warehouse, never a role literal', () => {
    expect(sendBody).toContain('phoenix_profile_has_scoped_permission');
    expect(sendBody).toContain("'warehouse_transfer.send'");
    expect(sendBody).toMatch(/v_stock\.warehouse_id/);
    expect(sendBody).not.toMatch(/v_actor_role\s*=\s*'/);
    expect(sendBody).not.toMatch(/phoenix_my_role\(\)\s*=/);
  });

  it('is SECURITY DEFINER with pinned search_path', () => {
    expect(sendBody).toContain('SECURITY DEFINER');
    expect(sendBody).toContain('SET search_path = public, pg_temp');
  });
});

describe('9b. the receive RPC enforces separation of duty', () => {
  const recvBody = functionBody('phoenix_receive_warehouse_transfer_line');

  it('scopes authorization to the DESTINATION warehouse, taken from the transfer', () => {
    expect(recvBody).toContain('phoenix_profile_has_scoped_permission');
    expect(recvBody).toContain("'warehouse_transfer.receive'");
    expect(recvBody).toMatch(/v_transfer\.destination_warehouse_id/);
    expect(recvBody).toMatch(/v_transfer\.destination_organization_id/);
  });

  it('never derives destination scope from the caller own input', () => {
    // p_transfer_line_id is the only externally-supplied identifier; the
    // warehouse/org used for authorization must come from the resolved
    // transfer row, not from a parameter a caller could forge.
    expect(recvBody).not.toMatch(/phoenix_profile_has_scoped_permission\([^)]*p_transfer_line_id/);
  });

  it('refuses receiving more than was sent', () => {
    expect(recvBody).toContain('received_quantity_exceeds_sent');
  });

  it('refuses an unexplained difference between sent and received', () => {
    expect(recvBody).toContain('difference_reason_required');
  });

  it('refuses an expired batch on receipt too', () => {
    expect(recvBody).toContain('expired_batch_cannot_be_received');
  });

  it('treats a zero receipt as a rejection that moves no stock', () => {
    expect(recvBody).toContain('warehouse_transfer.rejected');
    expect(recvBody).toMatch(/IF p_received_quantity = 0 THEN/);
  });
});

describe('9c. separation of duty is a role default, not just an RPC check', () => {
  // norm068 has all whitespace runs collapsed to a single space, so the
  // migration's column-aligned padding must not appear in these expectations.
  it('central_warehouse_manager can send but never receive', () => {
    expect(norm068).toContain("('central_warehouse_manager', 'warehouse_transfer.send', true)");
    expect(norm068).toContain("('central_warehouse_manager', 'warehouse_transfer.receive', false)");
  });

  it('warehouse_officer can receive/request but never send', () => {
    expect(norm068).toContain("('warehouse_officer', 'warehouse_transfer.receive', true)");
    expect(norm068).toContain("('warehouse_officer', 'warehouse_transfer.send', false)");
  });

  it('outlet_officer has no access to warehouse transfers at all', () => {
    expect(norm068).toContain("('outlet_officer', 'warehouse_transfer.view', false)");
    expect(norm068).toContain("('outlet_officer', 'warehouse_transfer.send', false)");
    expect(norm068).toContain("('outlet_officer', 'warehouse_transfer.receive', false)");
  });

  it('proves separation of duty survived the migration', () => {
    expect(m068).toContain('ABORT 068: central_warehouse_manager must not receive its own shipment');
    expect(m068).toContain('ABORT 068: warehouse_officer must not send central stock');
  });

  it('every pre-existing legacy role is explicitly denied the new send/receive/request/review keys', () => {
    expect(norm068).toMatch(
      /CROSS JOIN \(VALUES \('warehouse_transfer\.send'\),\('warehouse_transfer\.receive'\),\s+\('warehouse_transfer\.request'\),\('warehouse_transfer\.review'\)\) AS k\(key\)/,
    );
  });
});

// ============================================================================
// 10. No new movement_type — the existing vocabulary is reused
// ============================================================================

describe('10. reuses 060/065 movement_type vocabulary instead of widening the CHECK', () => {
  it('never issues ALTER on warehouse_stock_movements_type_chk', () => {
    expect(exec068).not.toMatch(/warehouse_stock_movements_type_chk/);
  });

  it('send records a dispatch_send movement (060 existing type)', () => {
    const body = functionBody('phoenix_send_warehouse_transfer_line');
    expect(body).toContain("'dispatch_send'");
  });

  it('receive records an add movement (065 existing type)', () => {
    const body = functionBody('phoenix_receive_warehouse_transfer_line');
    expect(body).toMatch(/warehouse_id, 'add',/);
  });

  it('issues no DROP CONSTRAINT anywhere in the migration', () => {
    expect(exec068).not.toMatch(/DROP CONSTRAINT/i);
  });
});

// ============================================================================
// 11. RLS — two-sided by necessity, never widened beyond scope
// ============================================================================

describe('11. reads are two-sided: visible to sender AND receiver, each proving its own scope', () => {
  it('enables RLS on all four new tables', () => {
    for (const t of [
      'warehouse_transfer_requests', 'warehouse_transfer_request_lines',
      'warehouse_transfers', 'warehouse_transfer_lines',
    ]) {
      expect(norm068).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
    }
  });

  it('the shared read rule checks BOTH the source AND destination scope', () => {
    const body = functionBody('phoenix_can_read_warehouse_transfer');
    expect(body).toContain('p_source_organization_id');
    expect(body).toContain('p_destination_organization_id');
    expect(body.match(/phoenix_profile_has_scoped_permission/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it('super_admin bypasses scope entirely (platform role)', () => {
    expect(functionBody('phoenix_can_read_warehouse_transfer')).toContain(
      "phoenix_my_role() = 'super_admin'",
    );
  });

  it('gives authenticated SELECT only — never INSERT/UPDATE/DELETE', () => {
    for (const t of [
      'warehouse_transfer_requests', 'warehouse_transfer_request_lines',
      'warehouse_transfers', 'warehouse_transfer_lines',
    ]) {
      expect(norm068).toContain(`GRANT SELECT ON TABLE public.${t} TO authenticated`);
      expect(norm068).toMatch(
        new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t} FROM authenticated`),
      );
    }
  });

  it('gives anon nothing on any of the four tables or the view', () => {
    for (const t of [
      'warehouse_transfer_requests', 'warehouse_transfer_request_lines',
      'warehouse_transfers', 'warehouse_transfer_lines',
    ]) {
      expect(norm068).toContain(`REVOKE ALL ON TABLE public.${t} FROM anon`);
    }
    expect(norm068).toMatch(/REVOKE ALL ON\s+public\.warehouse_stock_in_transit FROM anon/);
  });

  it('creates no write policy on any of the four tables', () => {
    expect(norm068).not.toMatch(
      /CREATE POLICY \w+ ON public\.warehouse_transfer\w* FOR (INSERT|UPDATE|DELETE|ALL)/,
    );
  });

  it('line-level policies route through the header scope, not their own', () => {
    // Lines carry no organization columns of their own to check — they must
    // join back to the header and reuse the shared read rule.
    expect(norm068).toMatch(
      /CREATE POLICY wtrl_select_scoped\s+ON public\.warehouse_transfer_request_lines FOR SELECT TO authenticated\s+USING \(EXISTS \(\s*SELECT 1 FROM public\.warehouse_transfer_requests r/,
    );
    expect(norm068).toMatch(
      /CREATE POLICY wtl_select_scoped\s+ON public\.warehouse_transfer_lines FOR SELECT TO authenticated\s+USING \(EXISTS \(\s*SELECT 1 FROM public\.warehouse_transfers t/,
    );
  });

  it('proves anon has no access and no client write path exists', () => {
    expect(m068).toContain('ABORT 068: anon can read');
    expect(m068).toContain('VERIFY FAILED (068): authenticated holds a direct transfer write privilege');
  });
});

// ============================================================================
// 12. Backward compatibility — the heart of an expand step
// ============================================================================

describe('12. 068 breaks nothing that exists today', () => {
  it('drops nothing', () => {
    const drops = (exec068.match(/\bDROP\s+(?!POLICY)\w+/gi) ?? []).filter(Boolean);
    expect(drops).toEqual([]);
  });

  it('only drops its own new policies, and only to recreate them', () => {
    const dropped = [...exec068.matchAll(/DROP POLICY IF EXISTS (\w+)/g)].map(m => m[1]);
    expect(dropped.length).toBeGreaterThan(0);
    for (const p of dropped) {
      expect(exec068).toContain(`CREATE POLICY ${p}`);
    }
  });

  it('renames nothing', () => {
    expect(exec068).not.toMatch(/\bRENAME\b/i);
  });

  it('revokes nothing from an object it did not itself create', () => {
    const created = [
      'public.warehouse_transfer_requests',
      'public.warehouse_transfer_request_lines',
      'public.warehouse_transfers',
      'public.warehouse_transfer_lines',
      'public.warehouse_stock_in_transit',
      'public.phoenix_send_warehouse_transfer_line',
      'public.phoenix_receive_warehouse_transfer_line',
      'public.phoenix_can_read_warehouse_transfer',
      'public.phoenix_create_warehouse_transfer_request',
      'public.phoenix_add_warehouse_transfer_request_line',
      'public.phoenix_update_warehouse_transfer_request_line',
      'public.phoenix_delete_warehouse_transfer_request_line',
      'public.phoenix_submit_warehouse_transfer_request',
      'public.phoenix_cancel_warehouse_transfer_request',
      'public.phoenix_review_warehouse_transfer_request',
    ];
    const revokes = [...active068.matchAll(/REVOKE [^;]*? ON (?:TABLE |FUNCTION )?(public\.\w+)/g)].map(
      m => m[1],
    );
    expect(revokes.length).toBeGreaterThan(0);
    for (const target of revokes) {
      expect(created, `REVOKE touched a pre-existing object: ${target}`).toContain(target);
    }
  });

  it('leaves item_availability and its manual paths completely untouched', () => {
    expect(exec068).not.toMatch(/ALTER TABLE public\.item_availability/);
    expect(m068).toContain('ABORT 068: phoenix_upsert_availability lost authenticated EXECUTE');
    expect(m068).toContain('ABORT 068: source_kind default changed');
  });

  it('does not touch outlet_stock or its RPCs at all', () => {
    expect(exec068).not.toMatch(/ALTER TABLE public\.outlet_stock\b/);
    expect(exec068).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_\w*outlet\w*/);
  });

  it('touches warehouse_stock only through its RPC bodies, never via ALTER', () => {
    expect(exec068).not.toMatch(/ALTER TABLE public\.warehouse_stock\b/);
  });

  it('writes no application data and backfills no route', () => {
    // INSERT INTO warehouse_transfers/warehouse_transfer_lines DOES appear in
    // this file — inside the RPC bodies, where it runs only when a user calls
    // the function, never at migration-apply time. The backfill guarantee is
    // about migration-TIME writes, so function bodies are excluded here.
    // sqlFunctionSource is invoked on exec068 itself (already comment-stripped
    // and literal-blanked) so the extracted body is a genuine substring of it.
    let outsideFunctions = exec068;
    for (const rpc of [...WRITE_RPCS, ...REQUEST_LIFECYCLE_RPCS]) {
      const body = sqlFunctionSource(exec068, rpc);
      if (body) outsideFunctions = outsideFunctions.replace(body, '');
    }
    const inserts = [...outsideFunctions.matchAll(/INSERT INTO public\.(\w+)/g)].map(m => m[1]);
    expect(inserts).not.toContain('warehouse_supply_routes');
    expect(inserts).not.toContain('warehouse_transfers');
    expect(inserts).not.toContain('warehouse_transfer_requests');
    expect(inserts).not.toContain('warehouse_transfer_request_lines');
    // The only migration-time INSERTs are the intent-declaring Shadow Mode rows.
    // Everything else (requests, request lines, transfers, transfer lines,
    // audit_logs) happens only inside an RPC body, at call time, never here.
    expect(new Set(inserts)).toEqual(new Set(['permission_keys', 'role_permission_defaults']));
  });

  it('leaves RBAC enforcement OFF', () => {
    expect(exec068).not.toMatch(/rbac_enforcement|enforcement_enabled|SCOPED_RBAC_MODE/i);
    // 068 only adds Shadow Mode permission_keys/role_permission_defaults rows
    // (066/067's pattern) — it introduces no enforcement toggle of any kind.
    expect(m068).toMatch(/No RBAC enforcement change\. Enforcement stays OFF/);
  });

  it('the public QR path stays untouched and leaks nothing about transfers', () => {
    expect(exec068).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_public_qr_payload/);
    expect(m068).toContain('VERIFY FAILED (068): transfer data leaked into public QR');
  });
});

// ============================================================================
// 13. Deferred scope — what 068 explicitly does NOT build
// ============================================================================

describe('13. return path and cancellation are explicitly deferred to 069', () => {
  it('states the return path is deferred', () => {
    expect(m068).toMatch(/RETURN path \(institution -> central\)\. Deferred to 069/);
  });

  it('creates no return/cancel RPC for a TRANSFER (movement) — only for a still-unsent REQUEST', () => {
    // phoenix_cancel_warehouse_transfer_request cancels an institution's own
    // DRAFT/SUBMITTED request, before anything has moved — that is a real
    // RPC in 068 (section 8f). What must still not exist is any un-send of a
    // transfer/transfer-line once stock is on a truck; that is the return
    // path, deferred to 069.
    expect(exec068).not.toMatch(
      /CREATE (OR REPLACE )?FUNCTION public\.phoenix_(return|cancel)_warehouse_transfer(?!_request)/,
    );
    expect(exec068).toMatch(
      /CREATE (OR REPLACE )?FUNCTION public\.phoenix_cancel_warehouse_transfer_request/,
    );
  });

  it('has no cancelled status anywhere on warehouse_transfers', () => {
    expect(norm068.slice(
      norm068.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_transfers'),
      norm068.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS wt_source_org_number_uniq'),
    )).not.toContain("'cancelled'");
  });
});

// ============================================================================
// 14. Every RPC audits and pins search_path
// ============================================================================

describe('14. audit trail and function hygiene', () => {
  it('both write RPCs write an audit_logs row', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toContain('INSERT INTO public.audit_logs');
    }
  });

  it('both write RPCs snapshot actor role/name before writing the ledger', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toMatch(
        /SELECT p\.role, p\.full_name INTO v_actor_role, v_actor_name/,
      );
    }
  });

  it('both write RPCs are SECURITY DEFINER with a pinned search_path', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('SECURITY DEFINER');
      expect(body, rpc).toContain('SET search_path = public, pg_temp');
    }
  });

  it('no RPC uses dynamic SQL', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).not.toMatch(/EXECUTE\s+format|EXECUTE\s+'/);
    }
  });

  it('actor is taken server-side via auth.uid(), never a parameter', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toContain('auth.uid()');
    }
  });
});

// ============================================================================
// 15. The post-conditions themselves must not quietly disappear
// ============================================================================

describe('15. 068 states its own contract at apply time (unexecuted)', () => {
  it('runs a verification block inside the transaction', () => {
    expect(active068).toContain('$verify$');
    expect(active068.indexOf('$verify$')).toBeLessThan(active068.lastIndexOf('commit;'));
  });

  it('keeps every post-condition that guards a boundary in this file', () => {
    for (const assertion of [
      'ABORT 068: expected 060/066 schema is absent',
      'ABORT 068: missing per-side organization pin',
      'ABORT 068: supply-route enforcement is not a composite FK',
      'ABORT 068: transfer idempotency index missing',
      'ABORT 068: in-transit was denormalized onto warehouse_stock',
      'ABORT 068: the in-transit view is not security_invoker',
      'ABORT 068: anon can read',
      'VERIFY FAILED (068): authenticated holds a direct transfer write privilege',
      'ABORT 068: central_warehouse_manager must not receive its own shipment',
      'ABORT 068: warehouse_officer must not send central stock',
    ]) {
      expect(m068, assertion).toContain(assertion);
    }
  });

  it('checks the exact RPC signatures, so an overload cannot satisfy it', () => {
    expect(m068).toContain(
      'public.phoenix_send_warehouse_transfer_line(uuid,uuid,uuid,integer,text,uuid,text,text)',
    );
    expect(m068).toContain(
      'public.phoenix_receive_warehouse_transfer_line(uuid,uuid,integer,text,text)',
    );
  });
});

// ============================================================================
// 16. Request lifecycle — the institution asks, the central reviews
// ============================================================================

describe('16. request lifecycle RPCs exist with the full create->submit->review->send contract', () => {
  it('all seven lifecycle RPCs exist with their exact signatures', () => {
    for (const rpc of REQUEST_LIFECYCLE_RPCS) {
      expect(functionBody(rpc), rpc).toBeTruthy();
    }
    expect(m068).toContain('public.phoenix_create_warehouse_transfer_request(uuid,uuid,text,text)');
    expect(m068).toContain(
      'public.phoenix_add_warehouse_transfer_request_line(uuid,text,integer,uuid,text,text,text,text)',
    );
    expect(m068).toContain('public.phoenix_update_warehouse_transfer_request_line(uuid,integer,text)');
    expect(m068).toContain('public.phoenix_delete_warehouse_transfer_request_line(uuid)');
    expect(m068).toContain('public.phoenix_submit_warehouse_transfer_request(uuid)');
    expect(m068).toContain('public.phoenix_cancel_warehouse_transfer_request(uuid,text)');
    expect(m068).toContain('public.phoenix_review_warehouse_transfer_request(uuid,jsonb)');
  });

  it('every lifecycle RPC is SECURITY DEFINER, pinned search_path, actor via auth.uid(), and audited', () => {
    for (const rpc of REQUEST_LIFECYCLE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('SECURITY DEFINER');
      expect(body, rpc).toContain('SET search_path = public, pg_temp');
      expect(body, rpc).toContain('auth.uid()');
      expect(body, rpc).toContain('INSERT INTO public.audit_logs');
      expect(body, rpc).not.toMatch(/EXECUTE\s+format|EXECUTE\s+'/);
    }
  });

  it('CREATE proves the destination is the route\'s own target before trusting it (IDOR-safe)', () => {
    const body = functionBody('phoenix_create_warehouse_transfer_request');
    expect(body).toContain('destination_not_route_target');
    expect(body).toMatch(/IF p_destination_warehouse_id IS DISTINCT FROM v_route\.target_warehouse_id THEN/);
    expect(body).toContain('supply_route_inactive');
  });

  it('CREATE derives source org/warehouse from the route, never from a client parameter', () => {
    const body = functionBody('phoenix_create_warehouse_transfer_request');
    expect(body).not.toMatch(/p_source_organization_id|p_source_warehouse_id/);
    expect(body).toContain('v_route.source_warehouse_id');
  });

  it('line CRUD (add/update/delete) is refused once the request is no longer draft', () => {
    for (const rpc of [
      'phoenix_add_warehouse_transfer_request_line',
      'phoenix_update_warehouse_transfer_request_line',
      'phoenix_delete_warehouse_transfer_request_line',
    ] as const) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('transfer_request_not_draft');
      expect(body, rpc).toMatch(/IF v_request\.status <> 'draft' THEN/);
    }
  });

  it('SUBMIT requires an active route and at least one line, and stamps requested_by/at', () => {
    const body = functionBody('phoenix_submit_warehouse_transfer_request');
    expect(body).toContain('supply_route_inactive');
    expect(body).toContain('transfer_request_has_no_lines');
    expect(body).toContain('transfer_request_not_draft');
    expect(body).toMatch(/SET status = 'submitted', requested_by = v_actor, requested_at = now\(\)/);
  });

  it('CANCEL is refused once reviewed or sent, and requires a reason', () => {
    const body = functionBody('phoenix_cancel_warehouse_transfer_request');
    expect(body).toContain('cancellation_reason_required');
    expect(body).toContain('transfer_request_not_cancellable');
    expect(body).toMatch(/IF v_request\.status NOT IN \('draft', 'submitted'\) THEN/);
    // Cancelling a request does not silently resurrect its pending lines as
    // fulfillable — they move to 'cancelled' too, in the same transaction.
    expect(body).toMatch(
      /UPDATE public\.warehouse_transfer_request_lines\s+SET status = 'cancelled'\s+WHERE transfer_request_id = v_request\.id AND status = 'pending'/,
    );
  });

  it('REVIEW is gated by warehouse_transfer.review scoped to the SOURCE warehouse, never the requester\'s own scope', () => {
    const body = functionBody('phoenix_review_warehouse_transfer_request');
    expect(body).toContain("'warehouse_transfer.review'");
    expect(body).toMatch(
      /phoenix_profile_has_scoped_permission\(\s*v_actor, 'warehouse_transfer\.review',\s*v_request\.source_organization_id, v_request\.source_warehouse_id, NULL/,
    );
    expect(body).toContain('transfer_request_not_submitted');
  });

  it('REVIEW requires every pending line to be decided in the one call — no ambiguous partial batch', () => {
    const body = functionBody('phoenix_review_warehouse_transfer_request');
    expect(body).toContain('all_pending_lines_must_be_decided');
    expect(body).toContain('duplicate_decision_for_line');
    expect(body).toContain('decision_line_not_pending_for_request');
    expect(body).toContain('approved_quantity_exceeds_requested');
  });

  it('REVIEW locks the pending lines with FOR UPDATE before deciding them', () => {
    const body = functionBody('phoenix_review_warehouse_transfer_request');
    expect(body).toMatch(/status = 'pending'\s+FOR UPDATE/);
  });

  it('SEND can only draw against an approved request line, bounded by approved_quantity', () => {
    const body = functionBody('phoenix_send_warehouse_transfer_line');
    expect(body).toContain('request_line_not_approved');
    expect(body).toMatch(/IF v_reqline\.status NOT IN \('approved', 'partially_fulfilled'\) THEN/);
  });

  it('the request status enum includes the review outcomes, and the line enum includes approved/rejected', () => {
    expect(norm068).toMatch(
      /'draft', 'submitted', 'approved', 'partially_approved', 'rejected', 'cancelled', 'partially_fulfilled', 'fulfilled'/,
    );
    expect(norm068).toMatch(
      /'pending', 'approved', 'rejected', 'partially_fulfilled', 'fulfilled', 'cancelled'/,
    );
  });

  it('approved_quantity is structurally bounded by requested_quantity and gates fulfilled_quantity', () => {
    expect(norm068).toContain('wtrl_approved_qty_chk');
    expect(norm068).toContain('wtrl_fulfilled_le_approved_chk');
    expect(norm068).toContain('wtrl_fulfilled_requires_approval_chk');
  });

  it('reviewed_at/reviewed_by are structurally consistent with status (wtr_reviewed_at_chk)', () => {
    expect(norm068).toContain('wtr_reviewed_at_chk');
  });

  it('adds a dedicated warehouse_transfer.review permission key, distinct from .send/.request', () => {
    expect(norm068).toMatch(
      /\('warehouse_transfer\.review',\s*'warehouse_transfer',\s*'review'/,
    );
  });

  it('grants review only to central_warehouse_manager and super_admin, never the requester side', () => {
    expect(norm068).toMatch(
      /\('central_warehouse_manager', 'warehouse_transfer\.review', true\)/,
    );
    expect(norm068).toMatch(
      /\('warehouse_officer', 'warehouse_transfer\.review', false\)/,
    );
    expect(norm068).toMatch(
      /\('outlet_officer', 'warehouse_transfer\.review', false\)/,
    );
  });

  it('the post-conditions assert the requester cannot review its own request', () => {
    expect(m068).toContain('ABORT 068: warehouse_officer must not review its own request');
    expect(m068).toContain('ABORT 068: central_warehouse_manager must not open its own request');
  });

  it('CREATE/ADD/UPDATE/DELETE all authorize via warehouse_transfer.request scoped to the destination', () => {
    for (const rpc of [
      'phoenix_create_warehouse_transfer_request',
      'phoenix_add_warehouse_transfer_request_line',
      'phoenix_update_warehouse_transfer_request_line',
      'phoenix_delete_warehouse_transfer_request_line',
      'phoenix_submit_warehouse_transfer_request',
      'phoenix_cancel_warehouse_transfer_request',
    ] as const) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain("'warehouse_transfer.request'");
    }
  });

  it('DELETE LINE is a real delete (pre-submission, no history to preserve), not a status flip', () => {
    const body = functionBody('phoenix_delete_warehouse_transfer_request_line');
    expect(body).toMatch(/DELETE FROM public\.warehouse_transfer_request_lines WHERE id = v_line\.id;/);
  });

  it('none of the seven lifecycle RPCs writes to warehouse_stock_movements — they never move stock', () => {
    for (const rpc of REQUEST_LIFECYCLE_RPCS) {
      expect(functionBody(rpc), rpc).not.toContain('warehouse_stock_movements');
    }
  });

  it('all seven lifecycle RPCs are granted to authenticated and revoked from PUBLIC/anon', () => {
    for (const rpc of REQUEST_LIFECYCLE_RPCS) {
      const grantBlock = new RegExp(
        `REVOKE ALL ON FUNCTION public\\.${rpc}\\([^)]*\\)[\\s\\S]*?FROM PUBLIC, anon;[\\s\\S]*?GRANT EXECUTE ON FUNCTION public\\.${rpc}\\([^)]*\\)[\\s\\S]*?TO authenticated;`,
      );
      expect(active068, rpc).toMatch(grantBlock);
    }
  });
});
