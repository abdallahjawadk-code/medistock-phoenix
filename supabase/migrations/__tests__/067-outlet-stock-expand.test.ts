/**
 * OUTLET-STOCK-EXPAND-067-A
 *
 * Static SQL-source tests for migration 067 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of 052–066.
 *
 * 067 gives outlets their own operational balance so item_availability can
 * become a PROJECTION rather than a source of quantity. It is the EXPAND step
 * of Expand -> Frontend Migration -> Contract, so its value depends on being
 * ADDITIVE: the most important assertions here are the NEGATIVE ones — that 067
 * does not DROP, RENAME or REVOKE anything, does not touch
 * resulting_item_availability_id, does not change the source_kind default, and
 * does not turn RBAC enforcement on.
 *
 * WHAT A STATIC TEST CAN AND CANNOT PROVE
 * ---------------------------------------
 * These tests prove the migration SOURCE contains the boundaries it must
 * contain, and that a future edit cannot quietly remove one. They do not
 * execute SQL, so they cannot prove runtime behaviour. Runtime behaviour was
 * verified separately by running the entire migration against Postgres inside a
 * transaction that was then rolled back: it applied cleanly and all of its
 * in-transaction post-conditions (part 9) passed. Those post-conditions are the
 * executable half of this file's intent, which is why several tests below assert
 * that a specific post-condition still EXISTS — deleting one would silently
 * delete the only runtime proof.
 *
 * NOTE ON SCOPE: like 060–066, this file carries NO global ceiling assertion.
 * The reviewed maximum belongs to reviewed-migration-manifest.test.ts alone.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES, isReviewedMigrationFile } from './helpers/reviewed-migrations';
// SQL-SOURCE-LEXER-A: comment stripping, literal blanking and function-body
// extraction are lexical and shared, so 067's placeholder CHECK (which contains
// the literals '-' and '--') cannot corrupt them and a CRLF checkout behaves
// exactly like an LF one.
import {
  activeSql,
  executableSql,
  normalizeSql,
  sqlFunctionSource,
} from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M067_NAME = '067_phoenix_outlet_stock_expand.sql';
const P067 = join(MIGRATIONS_DIR, M067_NAME);
const m067 = readFileSync(P067, 'utf8');

const active067 = activeSql(m067);
const norm067 = normalizeSql(active067);

/** Executable SQL with string literals blanked, so RAISE prose cannot match. */
const exec067 = executableSql(m067);

/** The body of one CREATE FUNCTION, by name — for per-RPC assertions. */
function functionBody(name: string): string {
  const src = sqlFunctionSource(m067, name);
  expect(src, `function ${name} must exist`).not.toBeNull();
  return normalizeSql(src!);
}

/** The three write RPCs 067 introduces. Every one obeys the same contract. */
const WRITE_RPCS = [
  'phoenix_receive_outlet_dispatch_line',
  'phoenix_dispense_outlet_stock',
  'phoenix_count_outlet_stock',
] as const;

// ============================================================================
// 1. Presence and registration
// ============================================================================

describe('1. migration 067 exists exactly once and is registered', () => {
  it('067_phoenix_outlet_stock_expand.sql exists', () => {
    expect(existsSync(P067)).toBe(true);
  });

  it('is the only file named 067_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('067_'))).toEqual([M067_NAME]);
  });

  it('is registered in the reviewed-migration registry by exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M067_NAME);
    expect(isReviewedMigrationFile(M067_NAME)).toBe(true);
  });

  it('is a single atomic transaction — begin ... commit', () => {
    expect(active067.trimStart().startsWith('begin;')).toBe(true);
    expect(active067.trimEnd().endsWith('commit;')).toBe(true);
  });

  it('is marked manual-apply-only', () => {
    expect(m067).toMatch(/MANUAL APPLY ONLY/);
  });
});

// ============================================================================
// 2. Rollback on failure — the whole migration, or none of it
// ============================================================================
// The single begin/commit pair IS the rollback guarantee: any failing statement
// or post-condition aborts the transaction and leaves the database untouched.

describe('2. the migration rolls back completely on failure', () => {
  it('opens exactly one transaction and closes it exactly once', () => {
    expect(active067.match(/^\s*begin;/gm)?.length).toBe(1);
    expect(active067.match(/^\s*commit;/gm)?.length).toBe(1);
  });

  it('never commits early, mid-migration', () => {
    // A second commit would let a partial 067 survive a later failure.
    const firstCommit = active067.indexOf('\ncommit;');
    expect(active067.slice(0, firstCommit)).not.toMatch(/\bcommit\s*;/);
  });

  it('contains no COMMIT/ROLLBACK inside a function body or DO block', () => {
    expect(exec067).not.toMatch(/\bROLLBACK\b/i);
  });

  it('aborts rather than proceeding when a precondition is unmet', () => {
    expect(exec067).toMatch(/RAISE EXCEPTION/);
    expect(m067).toMatch(/ABORT 067: expected 060\/061\/062 schema is absent/);
  });

  it('verifies its own preconditions before creating anything', () => {
    const guard = active067.indexOf('$guard$');
    const firstCreate = active067.indexOf('CREATE TABLE IF NOT EXISTS public.outlet_stock');
    expect(guard).toBeGreaterThan(-1);
    expect(guard).toBeLessThan(firstCreate);
  });

  it('requires 065 and 066 to be present first', () => {
    expect(m067).toMatch(/ABORT 067: migration 066 is absent/);
    expect(m067).toMatch(/ABORT 067: 065 source_kind guard is absent/);
  });
});

// ============================================================================
// 3. outlet_stock — structure, constraints, indexes
// ============================================================================

describe('3. outlet_stock is created with its quantity invariants', () => {
  it('creates the table idempotently', () => {
    expect(norm067).toMatch(/CREATE TABLE IF NOT EXISTS public\.outlet_stock \(/);
  });

  it('is keyed to an outlet, not a warehouse', () => {
    expect(norm067).toMatch(/distribution_point_id\s+uuid NOT NULL/);
    // A warehouse column here would mean the outlet balance was still modelled
    // as warehouse stock — the exact conflation 067 exists to end.
    expect(functionBody('phoenix_project_outlet_availability')).not.toMatch(/warehouse_id/);
  });

  it('pins the outlet to its organization structurally, via composite FK', () => {
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_dp_org_fk FOREIGN KEY \(distribution_point_id, organization_id\) REFERENCES public\.distribution_points \(id, organization_id\) ON DELETE RESTRICT/,
    );
  });

  it('derives available_quantity as GENERATED ALWAYS ... STORED', () => {
    expect(norm067).toMatch(
      /available_quantity\s+integer GENERATED ALWAYS AS \(on_hand_quantity - reserved_quantity\) STORED/,
    );
  });

  it('forbids negative on-hand and negative reserved quantities', () => {
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_on_hand_nonneg_chk CHECK \(on_hand_quantity\s*>= 0\)/);
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_reserved_nonneg_chk CHECK \(reserved_quantity >= 0\)/);
  });

  it('forbids reserving more than is on hand', () => {
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_reserved_le_on_hand_chk CHECK \(reserved_quantity <= on_hand_quantity\)/,
    );
  });

  it('forbids a negative unit price', () => {
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_unit_price_chk/);
  });

  it('carries batch/lot identity with explicit absence flags, not placeholders', () => {
    expect(norm067).toMatch(/batch_number\s+text,/);
    expect(norm067).toMatch(/has_no_batch_number\s+boolean NOT NULL DEFAULT false/);
    expect(norm067).toMatch(/national_code\s+text,/);
    expect(norm067).toMatch(/has_no_national_code\s+boolean NOT NULL DEFAULT false/);
    expect(norm067).toMatch(/expiry_date\s+date,/);
  });

  it('forces each has_no_* flag to agree exactly with its field being NULL', () => {
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_has_no_national_code_chk CHECK \(has_no_national_code = \(national_code IS NULL\)\)/,
    );
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_has_no_batch_number_chk CHECK \(has_no_batch_number = \(batch_number IS NULL\)\)/,
    );
  });

  it('rejects placeholder identity literals outright', () => {
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_no_placeholder_chk/);
    for (const junk of ['N/A', 'NONE', 'بلا']) {
      expect(m067).toContain(junk);
    }
  });

  it('keeps no-batch stock from merging (Option C internal reference rule)', () => {
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_internal_ref_rule_chk/);
    expect(norm067).toMatch(/CASE WHEN has_no_batch_number THEN internal_batch_reference IS NOT NULL ELSE internal_batch_reference IS NULL END/);
  });
});

describe('3c. only approved outlet types may hold physical stock', () => {
  it('restricts point_type to the three approved network outlet types', () => {
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_point_type_approved_chk CHECK \(point_type IN \('pharmacy', 'crash_cabinet', 'rescue_cart'\)\)/,
    );
  });

  it('ties point_type to the referenced point by composite FK, not by convention', () => {
    // A CHECK cannot query another table, so without this FK the column could
    // claim 'pharmacy' while pointing at a legacy 'dispensing' outlet.
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_dp_type_fk FOREIGN KEY \(distribution_point_id, point_type\) REFERENCES public\.distribution_points \(id, point_type\) ON DELETE RESTRICT/,
    );
  });

  it('adds the composite FK target the constraint requires', () => {
    // Without UNIQUE (id, point_type) the FK above fails with ERROR 42830.
    expect(norm067).toMatch(
      /ADD CONSTRAINT distribution_points_id_point_type_uniq UNIQUE \(id, point_type\)/,
    );
  });

  it('adds that key without a DROP, keeping "067 drops nothing" mechanical', () => {
    expect(exec067).not.toMatch(/DROP CONSTRAINT/i);
    expect(norm067).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
  });

  it('refuses a legacy outlet in the RPC with a named error, not a raw violation', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    expect(body).toContain('outlet_type_not_approved_for_stock');
    expect(body).toMatch(/v_point\.point_type NOT IN \('pharmacy', 'crash_cabinet', 'rescue_cart'\)/);
  });

  it('refuses an inactive or missing destination outlet', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    expect(body).toContain('destination_outlet_inactive');
    expect(body).toContain('destination_outlet_not_found');
  });

  it('reclassifies no legacy point, and leaves the legacy types accepted', () => {
    // 067 restricts where stock may LIVE. It must not touch what
    // distribution_points itself accepts, and must not rewrite any row.
    expect(exec067).not.toMatch(/UPDATE public\.distribution_points/i);
    expect(exec067).not.toMatch(/distribution_points_point_type_check/);
    expect(m067).toContain('ABORT 067: 066 legacy point types were dropped. 067 must not reclassify.');
  });

  it('takes point_type from the resolved point, never from the caller', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    expect(body).toContain('v_point.point_type, v_line.central_item_id');
  });

  it('proves the boundary survived the migration', () => {
    expect(m067).toContain('ABORT 067: outlet_stock does not restrict stock to approved outlet types.');
    expect(m067).toContain('ABORT 067: outlet_stock.point_type is not tied to its point by composite FK.');
  });
});

describe('3d. NULL cannot split an outlet balance into duplicate rows', () => {
  it('wraps every nullable identity component in COALESCE', () => {
    // In a plain UNIQUE index NULLs compare as DISTINCT, so two "same material,
    // no batch" rows would both be accepted and the balance would silently
    // split. COALESCE sentinels make the indexed expression never-NULL, which is
    // equivalent to NULLS NOT DISTINCT but works on PG < 15 and matches 060/051.
    const idx = norm067.slice(
      norm067.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_identity_uniq'),
    );
    const decl = idx.slice(0, idx.indexOf(');') + 2);
    for (const nullable of [
      'concentration',
      'dosage_form',
      'national_code',
      'batch_number',
      'expiry_date',
      'internal_batch_reference',
    ]) {
      expect(decl, `${nullable} must be COALESCEd in the identity index`).toContain(
        `COALESCE(${nullable},`,
      );
    }
  });

  it('anchors the index on columns that are NOT NULL, needing no sentinel', () => {
    const idx = norm067.slice(
      norm067.indexOf('CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_identity_uniq'),
    );
    const decl = idx.slice(0, idx.indexOf(');') + 2);
    expect(decl).toContain('distribution_point_id,');
    expect(decl).toContain('scientific_name,');
    expect(norm067).toMatch(/distribution_point_id\s+uuid NOT NULL/);
    expect(norm067).toMatch(/scientific_name\s+text NOT NULL/);
  });

  it('proves the no-duplicate-balance property at apply time', () => {
    expect(m067).toContain(
      'ABORT 067: identity index leaves a nullable component un-COALESCEd',
    );
    expect(m067).toContain('ABORT 067: an identity anchor column became nullable.');
  });
});

describe('3e. no CASCADE can delete a balance or its history', () => {
  it('uses only RESTRICT and SET NULL on the new tables', () => {
    expect(exec067).not.toMatch(/ON DELETE CASCADE/i);
  });

  it('proves it at apply time by inspecting confdeltype, not by reading the source', () => {
    expect(m067).toContain(
      'ABORT 067: a CASCADE foreign key can delete outlet balances or history.',
    );
    expect(m067).toContain('ABORT 067: the outlet_stock result link is not ON DELETE SET NULL.');
  });

  it('keeps history when an outlet or an actor goes away', () => {
    // Outlet/org deletion is RESTRICTed while stock or ledger rows exist;
    // actor deletion nulls the reference but never removes the movement.
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_movements_dp_org_fk FOREIGN KEY \(distribution_point_id, organization_id\) REFERENCES public\.distribution_points \(id, organization_id\) ON DELETE RESTRICT/,
    );
    expect(norm067).toMatch(/actor_id\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  });
});

describe('3b. outlet_stock identity uniqueness is per outlet + material + batch', () => {
  it('creates the 8-component unique identity index', () => {
    expect(norm067).toMatch(/CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_identity_uniq/);
    for (const component of [
      'distribution_point_id',
      'scientific_name',
      "COALESCE(concentration, '')",
      "COALESCE(dosage_form, '')",
      "COALESCE(national_code, '')",
      "COALESCE(batch_number, '')",
      "COALESCE(expiry_date, DATE '0001-01-01')",
      "COALESCE(internal_batch_reference, '')",
    ]) {
      expect(norm067.slice(norm067.indexOf('outlet_stock_identity_uniq'))).toContain(component);
    }
  });

  it('uses the immutable date sentinel, never expiry_date::text', () => {
    // expiry_date::text is not IMMUTABLE (it depends on DateStyle) and Postgres
    // rejects it in an index with ERROR 42P17.
    const idx = norm067.slice(norm067.indexOf('outlet_stock_identity_uniq'));
    expect(idx.slice(0, 400)).not.toMatch(/expiry_date::text/);
    expect(idx).toContain("COALESCE(expiry_date, DATE '0001-01-01')");
  });

  it('creates the lookup indexes the RPCs and policies need', () => {
    for (const idx of [
      'outlet_stock_org_idx',
      'outlet_stock_point_idx',
      'outlet_stock_sci_name_idx',
      'outlet_stock_expiry_idx',
    ]) {
      expect(norm067).toContain(idx);
    }
  });

  it('provides the (id, organization_id) composite FK target its ledger needs', () => {
    // Without this, outlet_stock_movements_stock_org_fk fails with ERROR 42830.
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_id_org_uniq UNIQUE \(id, organization_id\)/);
  });
});

// ============================================================================
// 4. outlet_stock_movements — the immutable ledger
// ============================================================================

describe('4. outlet_stock_movements records before/delta/after for both quantities', () => {
  it('creates the table idempotently', () => {
    expect(norm067).toMatch(/CREATE TABLE IF NOT EXISTS public\.outlet_stock_movements \(/);
  });

  it('carries on-hand before/delta/after', () => {
    for (const col of ['on_hand_before', 'on_hand_delta', 'on_hand_after']) {
      expect(norm067).toMatch(new RegExp(`${col}\\s+integer NOT NULL`));
    }
  });

  it('carries reserved before/delta/after', () => {
    for (const col of ['reserved_before', 'reserved_delta', 'reserved_after']) {
      expect(norm067).toMatch(new RegExp(`${col}\\s+integer NOT NULL`));
    }
  });

  it('forces the ledger arithmetic to be self-consistent', () => {
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_movements_on_hand_math_chk CHECK \(on_hand_before \+ on_hand_delta = on_hand_after\)/,
    );
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_movements_reserved_math_chk CHECK \(reserved_before \+ reserved_delta = reserved_after\)/,
    );
  });

  it('keeps every quantity non-negative at every point in history', () => {
    for (const c of [
      'outlet_stock_movements_on_hand_before_chk',
      'outlet_stock_movements_on_hand_after_chk',
      'outlet_stock_movements_reserved_before_chk',
      'outlet_stock_movements_reserved_after_chk',
    ]) {
      expect(norm067).toContain(c);
    }
  });

  it('keeps the reservation invariant true historically, not just currently', () => {
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_movements_reserved_le_on_hand_chk CHECK \(reserved_after <= on_hand_after\)/,
    );
  });

  it('has a movement_type CHECK (text + CHECK, never a Postgres enum)', () => {
    // An enum cannot be altered inside a transaction, which is why this schema
    // uses text + CHECK everywhere.
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_movements_type_chk CHECK \(movement_type IN \(/);
    expect(exec067).not.toMatch(/CREATE TYPE/i);
    for (const t of ['dispatch_receive', 'dispense', 'correction', 'reserve', 'release']) {
      expect(norm067.slice(norm067.indexOf('outlet_stock_movements_type_chk'))).toContain(t);
    }
  });

  it('records movement_type, reference_type/reference_id and a dispatch link', () => {
    expect(norm067).toMatch(/movement_type\s+text NOT NULL/);
    expect(norm067).toMatch(/reference_type\s+text/);
    expect(norm067).toMatch(/reference_id\s+uuid/);
    expect(norm067).toMatch(/dispatch_line_id\s+uuid REFERENCES public\.warehouse_dispatch_lines\(id\)/);
  });

  it('records the actor, the reason and the time', () => {
    expect(norm067).toMatch(/actor_id\s+uuid REFERENCES auth\.users\(id\)/);
    expect(norm067).toMatch(/actor_role\s+text/);
    expect(norm067).toMatch(/actor_name\s+text/);
    expect(norm067).toMatch(/reason\s+text/);
    expect(norm067).toMatch(/created_at\s+timestamptz NOT NULL DEFAULT now\(\)/);
  });

  it('snapshots identity, because the parent row identity is mutable', () => {
    for (const col of [
      'scientific_name_snapshot',
      'concentration_snapshot',
      'dosage_form_snapshot',
      'batch_number_snapshot',
      'internal_batch_reference_snapshot',
      'expiry_date_snapshot',
    ]) {
      expect(norm067).toContain(col);
    }
  });

  it('binds each movement to its outlet and organization structurally', () => {
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_movements_stock_org_fk FOREIGN KEY \(outlet_stock_id, organization_id\) REFERENCES public\.outlet_stock \(id, organization_id\)/,
    );
    expect(norm067).toMatch(
      /CONSTRAINT outlet_stock_movements_dp_org_fk FOREIGN KEY \(distribution_point_id, organization_id\) REFERENCES public\.distribution_points \(id, organization_id\)/,
    );
  });

  it('demands a reason for any correction or absolute overwrite', () => {
    expect(norm067).toContain('outlet_stock_movements_correction_reason_chk');
    expect(norm067).toContain('outlet_stock_movements_set_exact_reason_chk');
  });

  it('lets only a dispatch receipt carry a dispatch line, and forces it to', () => {
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_movements_dispatch_receive_chk/);
    expect(norm067).toMatch(
      /CASE WHEN movement_type = 'dispatch_receive' THEN dispatch_line_id IS NOT NULL ELSE dispatch_line_id IS NULL END/,
    );
  });
});

// ============================================================================
// 5. Idempotency and concurrency — structural, not conventional
// ============================================================================

describe('5. one request produces at most one movement', () => {
  it('enforces request idempotency with a UNIQUE index, not RPC etiquette', () => {
    expect(norm067).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_request_once_uniq ON public\.outlet_stock_movements \(reference_id\) WHERE reference_type = '[^']*' AND reference_id IS NOT NULL/,
    );
  });

  it('enforces one receipt per dispatch line with a UNIQUE index', () => {
    // Even a caller inventing a fresh request UUID cannot receive a line twice.
    expect(norm067).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS outlet_stock_movements_dispatch_line_uniq ON public\.outlet_stock_movements \(dispatch_line_id\) WHERE dispatch_line_id IS NOT NULL/,
    );
  });

  it('requires a well-formed fingerprint on every outlet_request movement', () => {
    expect(norm067).toMatch(/CONSTRAINT outlet_stock_movements_request_fingerprint_chk/);
    expect(norm067).toContain('^[0-9a-f]{64}$');
  });

  it('every write RPC computes a fingerprint over its normalized inputs', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('encode(sha256(convert_to(jsonb_build_object(');
      expect(body, rpc).toContain('request_fingerprint');
    }
  });

  it('every write RPC fails closed when a request id is replayed with new inputs', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('request_id_conflict');
      expect(body, rpc).toMatch(/request_fingerprint IS DISTINCT FROM/);
    }
  });

  it('every write RPC returns the original result on a faithful replay', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toContain("'idempotent_replay', true");
    }
  });
});

describe('5b. concurrent updates cannot interleave or invert locks', () => {
  it('every write RPC takes an advisory lock keyed on the request id', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toMatch(
        /PERFORM pg_advisory_xact_lock\(hashtextextended\(p_request_id::text, 67067\)\)/,
      );
    }
  });

  it('every write RPC locks the stock row it mutates', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toContain('FOR UPDATE');
    }
  });

  it('takes the advisory lock BEFORE any row lock, in every RPC', () => {
    // Identical ordering everywhere — including 065's warehouse RPCs — is what
    // makes lock-order inversion between the two inventory halves impossible.
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body.indexOf('pg_advisory_xact_lock'), rpc).toBeLessThan(body.indexOf('FOR UPDATE'));
    }
  });

  it('reads the balance from the locked row, never from the client', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/v_before\s*:=\s*v_stock\.on_hand_quantity/);
    }
  });
});

// ============================================================================
// 6. Negative stock, over-reservation and expired batches are refused
// ============================================================================

describe('6. the RPCs refuse to break a physical invariant', () => {
  it('dispensing cannot drive stock negative', () => {
    const body = functionBody('phoenix_dispense_outlet_stock');
    expect(body).toContain('outlet_quantity_cannot_go_negative');
    expect(body).toMatch(/IF v_after < 0 THEN/);
  });

  it('dispensing cannot strand a reservation', () => {
    expect(functionBody('phoenix_dispense_outlet_stock')).toContain('outlet_quantity_below_reserved');
  });

  it('a physical count cannot strand a reservation either', () => {
    expect(functionBody('phoenix_count_outlet_stock')).toContain('outlet_quantity_below_reserved');
  });

  it('an expired batch can never be received into an outlet', () => {
    const body = functionBody('phoenix_receive_outlet_dispatch_line');
    expect(body).toContain('expired_batch_cannot_be_received');
    expect(body).toMatch(/v_line\.expiry_date < current_date/);
  });

  it('an expired batch can never be dispensed from an outlet', () => {
    const body = functionBody('phoenix_dispense_outlet_stock');
    expect(body).toContain('expired_batch_cannot_be_dispensed');
    expect(body).toMatch(/v_stock\.expiry_date < current_date/);
  });

  it('a dispensed quantity must be positive', () => {
    expect(functionBody('phoenix_dispense_outlet_stock')).toContain('quantity_must_be_positive');
  });

  it('a counted quantity may be zero but never negative', () => {
    expect(functionBody('phoenix_count_outlet_stock')).toContain('counted_quantity_must_be_non_negative');
  });

  it('the post-conditions prove the invariants survived the migration', () => {
    expect(m067).toContain('ABORT 067: missing quantity invariant');
    expect(m067).toContain('ABORT 067: outlet_stock.available_quantity is not GENERATED');
  });
});

// ============================================================================
// 7. Receiving a dispatch exactly once
// ============================================================================

describe('7. dispatch receipt is single-use and self-consistent', () => {
  const body = functionBody('phoenix_receive_outlet_dispatch_line');

  it('refuses a line that was already decided', () => {
    expect(body).toContain('dispatch_line_already_decided');
    expect(body).toMatch(/IF v_line\.status <> '[^']*' THEN/);
  });

  it('refuses a dispatch that was never sent', () => {
    expect(body).toContain('dispatch_not_receivable');
  });

  it('refuses receiving more than was sent', () => {
    expect(body).toContain('received_quantity_exceeds_sent');
  });

  it('refuses an unexplained difference between sent and received', () => {
    expect(body).toContain('difference_reason_required');
  });

  it('records the decision on the line', () => {
    expect(body).toMatch(/UPDATE public\.warehouse_dispatch_lines SET status/);
    expect(body).toContain('received_quantity');
    expect(body).toContain('accepted_at');
  });

  it('treats a zero receipt as a rejection that moves no stock', () => {
    expect(body).toContain('outlet_stock.dispatch_rejected');
    expect(body).toMatch(/IF p_received_quantity = 0 THEN/);
  });

  it('builds outlet identity from the line snapshots, never from the caller', () => {
    // The RPC takes no identity parameters at all — only the line id, the
    // quantity and the reason. That is what makes spoofing impossible.
    expect(norm067).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_receive_outlet_dispatch_line\( p_request_id uuid, p_dispatch_line_id uuid, p_received_quantity integer, p_difference_reason text DEFAULT NULL, p_notes text DEFAULT NULL \)/,
    );
    expect(body).toMatch(/v_line\.scientific_name/);
    expect(body).toMatch(/v_line\.batch_number/);
  });
});

// ============================================================================
// 8. RLS, IDOR and the anon boundary
// ============================================================================

describe('8. authorization lives in the RPC, not in the UI', () => {
  it('every write RPC authorizes through the scoped permission helper', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toContain('phoenix_profile_has_scoped_permission');
    }
  });

  it('no RPC authorizes on a role literal', () => {
    // A role comparison would bypass assignment scope and reintroduce IDOR.
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).not.toMatch(/v_actor_role\s*=\s*'/);
      expect(body, rpc).not.toMatch(/phoenix_my_role\(\)\s*=/);
    }
  });

  it('each RPC demands the permission key that matches its operation', () => {
    expect(functionBody('phoenix_receive_outlet_dispatch_line')).toContain('outlet_stock.receive');
    expect(functionBody('phoenix_dispense_outlet_stock')).toContain('outlet_stock.dispense');
    expect(functionBody('phoenix_count_outlet_stock')).toContain('outlet_stock.count');
  });

  it('derives the outlet being authorized from server state, not from the caller', () => {
    // The IDOR gate: the scope argument comes from the locked row / the dispatch
    // header, so naming someone else's id fails the check rather than passing it.
    expect(functionBody('phoenix_dispense_outlet_stock')).toMatch(
      /phoenix_profile_has_scoped_permission\( v_actor, '[^']*', v_stock\.organization_id, NULL, v_stock\.distribution_point_id \)/,
    );
    expect(functionBody('phoenix_count_outlet_stock')).toMatch(
      /phoenix_profile_has_scoped_permission\( v_actor, '[^']*', v_stock\.organization_id, NULL, v_stock\.distribution_point_id \)/,
    );
    expect(functionBody('phoenix_receive_outlet_dispatch_line')).toMatch(
      /phoenix_profile_has_scoped_permission\( v_actor, '[^']*', v_dispatch\.organization_id, NULL, v_dispatch\.destination_distribution_point_id \)/,
    );
  });

  it('every write RPC refuses an unauthenticated or inactive actor', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('not_authenticated');
      expect(body, rpc).toContain('active_profile_required');
    }
  });

  it('every RPC is SECURITY DEFINER with a pinned search_path', () => {
    for (const rpc of [...WRITE_RPCS, 'phoenix_project_outlet_availability']) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain('SECURITY DEFINER');
      expect(body, rpc).toContain('SET search_path = public, pg_temp');
    }
  });
});

describe('8b. RLS enables scoped reads and no client writes', () => {
  it('enables RLS on both new tables', () => {
    expect(norm067).toContain('ALTER TABLE public.outlet_stock ENABLE ROW LEVEL SECURITY');
    expect(norm067).toContain('ALTER TABLE public.outlet_stock_movements ENABLE ROW LEVEL SECURITY');
  });

  it('gives authenticated SELECT only — never INSERT/UPDATE/DELETE', () => {
    expect(norm067).toContain('GRANT SELECT ON TABLE public.outlet_stock TO authenticated');
    expect(norm067).toContain('GRANT SELECT ON TABLE public.outlet_stock_movements TO authenticated');
    expect(norm067).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.outlet_stock FROM authenticated/,
    );
    expect(norm067).toMatch(
      /REVOKE INSERT, UPDATE, DELETE ON TABLE public\.outlet_stock_movements FROM authenticated/,
    );
  });

  it('gives anon nothing at all', () => {
    expect(norm067).toContain('REVOKE ALL ON TABLE public.outlet_stock FROM anon');
    expect(norm067).toContain('REVOKE ALL ON TABLE public.outlet_stock_movements FROM anon');
    expect(m067).toContain('ABORT 067: anon gained access to outlet stock');
  });

  it('routes both tables through one shared read rule, so they cannot drift', () => {
    expect(norm067).toMatch(
      /CREATE POLICY outlet_stock_select_scoped ON public\.outlet_stock FOR SELECT TO authenticated USING \(public\.phoenix_can_read_outlet_stock\(organization_id, distribution_point_id\)\)/,
    );
    expect(norm067).toMatch(
      /CREATE POLICY outlet_stock_movements_select_scoped ON public\.outlet_stock_movements FOR SELECT TO authenticated USING \(public\.phoenix_can_read_outlet_stock\(organization_id, distribution_point_id\)\)/,
    );
  });

  it('the read rule defers to scope, and grants super_admin everything', () => {
    const body = functionBody('phoenix_can_read_outlet_stock');
    expect(body).toContain('phoenix_profile_has_scoped_permission');
    expect(body).toContain('outlet_stock.view');
    expect(body).toContain("phoenix_my_role() = 'super_admin'");
    expect(body).toContain('auth.uid() IS NOT NULL');
  });

  it('creates no write policy — the absent GRANT is the write boundary', () => {
    expect(norm067).not.toMatch(/CREATE POLICY \w+ ON public\.outlet_stock(_movements)? FOR (INSERT|UPDATE|DELETE|ALL)/);
    expect(m067).toContain('ABORT 067: a non-SELECT policy exists on an outlet table');
  });

  it('the projection writer is executable by no client role', () => {
    // If any client role could execute it, the 065 guard would be bypassable
    // and item_availability would become forgeable.
    expect(norm067).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_project_outlet_availability\(uuid\) FROM PUBLIC, anon, authenticated/,
    );
    expect(norm067).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_project_outlet_availability/,
    );
    expect(m067).toContain('VERIFY FAILED (067): the projection writer is executable by a client role');
  });

  it('grants the write RPCs to authenticated but never to anon', () => {
    for (const rpc of WRITE_RPCS) {
      expect(norm067, rpc).toContain(
        `GRANT EXECUTE ON FUNCTION public.${rpc}(uuid, uuid, integer, text, text) TO authenticated`,
      );
      expect(norm067, rpc).toContain(
        `REVOKE ALL ON FUNCTION public.${rpc}(uuid, uuid, integer, text, text) FROM PUBLIC, anon`,
      );
    }
  });
});

describe('8c. the public QR path stays a safe projection', () => {
  it('067 does not touch get_public_qr_payload', () => {
    expect(exec067).not.toMatch(/CREATE OR REPLACE FUNCTION public\.get_public_qr_payload/);
  });

  it('proves QR never learns outlet stock or private provenance', () => {
    expect(m067).toContain(
      'VERIFY FAILED (067): outlet stock or private provenance leaked into public QR',
    );
  });

  it('never grants anon execute on anything', () => {
    expect(norm067).not.toMatch(/GRANT EXECUTE ON FUNCTION [^;]*TO anon/);
  });
});

// ============================================================================
// 9. Backward compatibility — the heart of an expand step
// ============================================================================

describe('9. 067 breaks nothing that exists today', () => {
  it('drops nothing', () => {
    // DROP POLICY IF EXISTS on 067's OWN new policies is the idempotent
    // create-or-replace idiom and is not a removal of anything pre-existing.
    const drops = (exec067.match(/\bDROP\s+(?!POLICY)\w+/gi) ?? []).filter(Boolean);
    expect(drops).toEqual([]);
  });

  it('only ever drops its own policies, and only to recreate them', () => {
    const dropped = [...exec067.matchAll(/DROP POLICY IF EXISTS (\w+)/g)].map(m => m[1]);
    expect(dropped).toEqual(['outlet_stock_select_scoped', 'outlet_stock_movements_select_scoped']);
    for (const p of dropped) {
      expect(exec067).toContain(`CREATE POLICY ${p}`);
    }
  });

  it('renames nothing', () => {
    expect(exec067).not.toMatch(/\bRENAME\b/i);
  });

  it('revokes nothing from any pre-existing object', () => {
    // Every REVOKE must name an object 067 itself created.
    const created = [
      'public.outlet_stock',
      'public.outlet_stock_movements',
      'public.phoenix_receive_outlet_dispatch_line',
      'public.phoenix_dispense_outlet_stock',
      'public.phoenix_count_outlet_stock',
      'public.phoenix_project_outlet_availability',
      'public.phoenix_derive_outlet_availability_condition',
      'public.phoenix_can_read_outlet_stock',
    ];
    const revokes = [...active067.matchAll(/REVOKE [^;]*? ON (?:TABLE |FUNCTION )?(public\.\w+)/g)].map(
      m => m[1],
    );
    expect(revokes.length).toBeGreaterThan(0);
    for (const target of revokes) {
      expect(created, `REVOKE touched a pre-existing object: ${target}`).toContain(target);
    }
  });

  it('writes no contract migration: the manual path keeps its EXECUTE', () => {
    for (const fn of [
      'phoenix_upsert_availability',
      'clear_port_availability',
      'phoenix_apply_availability_movement',
    ]) {
      expect(m067, fn).toContain(`ABORT 067: ${fn} lost authenticated EXECUTE`);
    }
  });

  it('does not forbid or redefine the manual source_kind', () => {
    expect(exec067).not.toMatch(/source_kind IN \(/);
    expect(m067).toContain('ABORT 067: source_kind default changed');
  });

  it('leaves resulting_item_availability_id in place and still populated', () => {
    expect(exec067).not.toMatch(/DROP COLUMN[^;]*resulting_item_availability_id/i);
    expect(functionBody('phoenix_receive_outlet_dispatch_line')).toContain(
      'resulting_item_availability_id = v_avail_id',
    );
    expect(m067).toContain(
      'ABORT 067: resulting_item_availability_id was removed. It must survive expand.',
    );
  });

  it('adds the new dispatch-line reference as a nullable column beside it', () => {
    expect(norm067).toMatch(
      /ALTER TABLE public\.warehouse_dispatch_lines ADD COLUMN IF NOT EXISTS resulting_outlet_stock_id uuid;/,
    );
    expect(norm067).not.toMatch(/resulting_outlet_stock_id uuid NOT NULL/);
    expect(m067).toContain('ABORT 067: resulting_outlet_stock_id missing or not nullable');
  });

  it('uses ON DELETE SET NULL on the new link, so Deep Clean (055) still works', () => {
    expect(norm067).toMatch(
      /FOREIGN KEY \(resulting_outlet_stock_id\) REFERENCES public\.outlet_stock\(id\) ON DELETE SET NULL/,
    );
  });

  it('touches only the tables it must, and only additively', () => {
    const altered = [...exec067.matchAll(/ALTER TABLE public\.(\w+)/g)].map(m => m[1]);
    expect(new Set(altered)).toEqual(
      new Set([
        'outlet_stock',
        'outlet_stock_movements',
        'warehouse_dispatch_lines',
        // Gains one trivially-satisfiable UNIQUE (id, point_type) key, which is
        // the composite FK target outlet_stock needs. No column, no data change.
        'distribution_points',
      ]),
    );
    const dispatchAlters = [...exec067.matchAll(/ALTER TABLE public\.warehouse_dispatch_lines\s+([\s\S]*?);/g)]
      .map(m => m[1].replace(/\s+/g, ' ').trim());
    for (const a of dispatchAlters) {
      expect(a).toMatch(/^(ADD COLUMN IF NOT EXISTS resulting_outlet_stock_id uuid|ADD CONSTRAINT warehouse_dispatch_lines_resulting_outlet_stock_fk)/);
    }
  });

  it('only ever ADDs to a pre-existing table — never drops or alters a column', () => {
    const dpAlters = [...exec067.matchAll(/ALTER TABLE public\.distribution_points\s+([\s\S]*?);/g)]
      .map(m => m[1].replace(/\s+/g, ' ').trim());
    expect(dpAlters.length).toBeGreaterThan(0);
    for (const a of dpAlters) {
      expect(a).toMatch(/^ADD CONSTRAINT distribution_points_id_point_type_uniq UNIQUE \(id, point_type\)$/);
    }
  });

  it('writes no application data and backfills nothing', () => {
    const inserts = [...exec067.matchAll(/INSERT INTO public\.(\w+)/g)].map(m => m[1]);
    // Only role_permission_defaults (Shadow Mode intent) at migration time; the
    // rest are inside RPC bodies and run only when a user calls them.
    expect(inserts).toContain('role_permission_defaults');
    expect(inserts).not.toContain('warehouse_stock');
    expect(exec067).not.toMatch(/INSERT INTO public\.outlet_stock\s*\([\s\S]{0,200}SELECT/);
    expect(exec067).not.toMatch(/\bUPDATE public\.item_availability\b\s+SET/);
  });
});

// ============================================================================
// 10. RBAC enforcement stays OFF; role intent is additive only
// ============================================================================

describe('10. RBAC enforcement is not turned on by 067', () => {
  it('adds no permission key (066 already defined the outlet_stock module)', () => {
    expect(exec067).not.toMatch(/INSERT INTO public\.permission_keys/);
  });

  it('requires 066 to have supplied the keys it relies on', () => {
    expect(m067).toContain('ABORT 067: 066 permission keys are absent');
  });

  it('never overwrites an existing role decision', () => {
    const defaults = [...exec067.matchAll(/INSERT INTO public\.role_permission_defaults[\s\S]*?;/g)];
    expect(defaults.length).toBeGreaterThan(0);
    for (const d of defaults) {
      expect(d[0]).toContain('ON CONFLICT (role, permission_key) DO NOTHING');
    }
  });

  it('keeps a central warehouse manager out of outlet stock by default', () => {
    expect(norm067).toContain("('central_warehouse_manager', 'outlet_stock.view', false)");
    expect(m067).toContain(
      'ABORT 067: central_warehouse_manager must not hold outlet_stock.view by default',
    );
  });

  it('lets a warehouse officer see its outlets but not operate them', () => {
    expect(norm067).toContain("('warehouse_officer', 'outlet_stock.dispense', false)");
    expect(norm067).toContain("('warehouse_officer', 'outlet_stock.count', false)");
    expect(m067).toContain('ABORT 067: warehouse_officer must keep outlet_stock.view');
  });

  it('keeps outlet_officer able to operate its own outlet', () => {
    expect(m067).toContain('ABORT 067: outlet_officer lost outlet_stock.dispense');
  });

  it('separates the dangerous count permission from everyday dispensing', () => {
    expect(functionBody('phoenix_count_outlet_stock')).toContain('outlet_stock.count');
    expect(functionBody('phoenix_count_outlet_stock')).not.toContain('outlet_stock.dispense');
    expect(functionBody('phoenix_count_outlet_stock')).toContain('outlet_count_reason_required');
  });

  it('does not enable any enforcement flag or alter the RBAC mode', () => {
    expect(exec067).not.toMatch(/rbac_enforcement|enforcement_enabled|SCOPED_RBAC_MODE/i);
  });
});

// ============================================================================
// 11. item_availability becomes a projection, written only by the server
// ============================================================================

describe('11. the transitional projection is server-owned and in-transaction', () => {
  it('derives availability condition from a pure policy function', () => {
    expect(norm067).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_derive_outlet_availability_condition\( p_available_quantity integer, p_expiry_date date \)/,
    );
  });

  it('is STABLE, not IMMUTABLE, because it reads current_date', () => {
    // IMMUTABLE would let the planner fold a stale "today" into a cached plan.
    const body = functionBody('phoenix_derive_outlet_availability_condition');
    expect(body).toContain('current_date');
    expect(body).toMatch(/\bSTABLE\b/);
    expect(body).not.toMatch(/\bIMMUTABLE\b/);
  });

  it('keeps 052 precedence: quantity-zero outranks expiry', () => {
    const body = functionBody('phoenix_derive_outlet_availability_condition');
    const missing = body.indexOf("'missing'");
    const expired = body.indexOf("'expired'");
    expect(missing).toBeGreaterThan(-1);
    expect(missing).toBeLessThan(expired);
  });

  it('keeps 052 thresholds: 9 months is near_expiry, earlier than today is expired', () => {
    const body = functionBody('phoenix_derive_outlet_availability_condition');
    expect(body).toContain("interval '9 months'");
    expect(body).toContain("p_expiry_date < current_date THEN 'expired'");
  });

  it('does not invent a low_stock/surplus threshold policy', () => {
    const body = functionBody('phoenix_derive_outlet_availability_condition');
    expect(body).not.toContain('low_stock');
    expect(body).not.toContain('surplus');
  });

  it('sums every outlet_stock row sharing the projection identity', () => {
    // item_availability's identity (051) has 7 components and excludes
    // internal_batch_reference; outlet_stock's has 8 and includes it. Copying a
    // single row would under-report an outlet holding two no-batch lots.
    const body = functionBody('phoenix_project_outlet_availability');
    expect(body).toContain('COALESCE(sum(s.available_quantity), 0)');
    expect(body).not.toMatch(/v_available\s*:=\s*v_stock\.available_quantity/);
  });

  it('writes the projection through the 065 guard handshake, transaction-locally', () => {
    const body = functionBody('phoenix_project_outlet_availability');
    expect(body).toMatch(/PERFORM set_config\('phoenix\.dispatch_write', 'on', true\)/);
    expect(body).toMatch(/PERFORM set_config\('phoenix\.dispatch_write', 'off', true\)/);
  });

  it('marks projected rows as warehouse_dispatch, not manual', () => {
    expect(functionBody('phoenix_project_outlet_availability')).toContain("'warehouse_dispatch'");
  });

  it('clears 053 removal markers, since a projected row has physical stock', () => {
    const body = functionBody('phoenix_project_outlet_availability');
    expect(body).toContain('removed_at = NULL');
  });

  it('upserts on 051 identity index, with its partial predicate', () => {
    const body = functionBody('phoenix_project_outlet_availability');
    expect(body).toContain('ON CONFLICT');
    expect(body).toContain('WHERE scientific_name IS NOT NULL');
  });

  it('every write RPC refreshes the projection in its own transaction', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toContain('phoenix_project_outlet_availability');
    }
  });

  it('the client is given no way to dual-write the projection', () => {
    // The projection is refreshed only from inside the RPCs, and the writer
    // holds no EXECUTE for any client role (proved in section 8b).
    expect(norm067).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_project_outlet_availability\(uuid\) FROM PUBLIC, anon, authenticated/,
    );
  });
});

// ============================================================================
// 12. Audit trail
// ============================================================================

describe('12. every outlet mutation is audited', () => {
  it('every write RPC writes an audit_logs row', () => {
    for (const rpc of WRITE_RPCS) {
      expect(functionBody(rpc), rpc).toContain('INSERT INTO public.audit_logs');
    }
  });

  it('every write RPC snapshots the actor role and name onto the movement', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toMatch(/SELECT p\.role, p\.full_name INTO v_actor_role, v_actor_name/);
    }
  });

  it('audits under a distinct, greppable action per operation', () => {
    expect(functionBody('phoenix_receive_outlet_dispatch_line')).toContain(
      "'outlet_stock.dispatch_receive'",
    );
    expect(functionBody('phoenix_dispense_outlet_stock')).toContain("'outlet_stock.dispense'");
    expect(functionBody('phoenix_count_outlet_stock')).toContain("'outlet_stock.count'");
  });

  it('records before/delta/after in the audit payload, not just the new value', () => {
    for (const rpc of WRITE_RPCS) {
      const body = functionBody(rpc);
      expect(body, rpc).toContain("'quantity_before'");
      expect(body, rpc).toContain("'quantity_delta'");
      expect(body, rpc).toContain("'quantity_after'");
    }
  });
});

// ============================================================================
// 13. The post-conditions themselves must not quietly disappear
// ============================================================================

describe('13. 067 proves its own contract at apply time', () => {
  it('runs a verification block inside the transaction', () => {
    expect(active067).toContain('$verify$');
    expect(active067.indexOf('$verify$')).toBeLessThan(active067.lastIndexOf('commit;'));
  });

  it('keeps every post-condition that guards a boundary in this file', () => {
    for (const assertion of [
      'ABORT 067: outlet_stock was not created',
      'ABORT 067: outlet_stock_movements was not created',
      'ABORT 067: outlet_stock.available_quantity is not GENERATED',
      'ABORT 067: outlet stock identity index missing or incomplete',
      'ABORT 067: outlet request idempotency index missing',
      'ABORT 067: one-receipt-per-dispatch-line index missing',
      'ABORT 067: anon gained access to outlet stock',
      'ABORT 067: RLS is not enabled on an outlet table',
      'ABORT 067: a non-SELECT policy exists on an outlet table',
      'VERIFY FAILED (067): authenticated holds a direct outlet write privilege',
      'VERIFY FAILED (067): the projection writer is executable by a client role',
    ]) {
      expect(m067, assertion).toContain(assertion);
    }
  });

  it('proves each RPC kept its lock/scope/idempotency/ledger/audit boundary', () => {
    for (const boundary of [
      'VERIFY FAILED (067): not SECURITY DEFINER: ',
      'VERIFY FAILED (067): no pinned search_path: ',
      'VERIFY FAILED (067): no advisory lock: ',
      'VERIFY FAILED (067): no row lock: ',
      'VERIFY FAILED (067): no scoped permission gate (IDOR): ',
      'VERIFY FAILED (067): no idempotency fingerprint: ',
      'VERIFY FAILED (067): no audit trail: ',
      'VERIFY FAILED (067): no transitional projection: ',
    ]) {
      expect(m067, boundary).toContain(boundary);
    }
  });

  it('checks the exact RPC signatures, so an overload cannot satisfy it', () => {
    for (const sig of [
      'public.phoenix_receive_outlet_dispatch_line(uuid,uuid,integer,text,text)',
      'public.phoenix_dispense_outlet_stock(uuid,uuid,integer,text,text)',
      'public.phoenix_count_outlet_stock(uuid,uuid,integer,text,text)',
    ]) {
      expect(m067, sig).toContain(sig);
    }
  });

  it('proves the expiry guards survived', () => {
    expect(m067).toContain('VERIFY FAILED (067): receive does not refuse expired batches');
    expect(m067).toContain('VERIFY FAILED (067): dispense does not refuse expired batches');
  });
});
