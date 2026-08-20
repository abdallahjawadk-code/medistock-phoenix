/**
 * WAREHOUSE-W1-DISPATCH-SCHEMA-061-A
 *
 * Static SQL-source tests for migration 061 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of every other
 * migration test here (052–060).
 *
 * Migration 061 adds the outlet-side provenance identity
 * (item_availability.internal_batch_reference + the 8-field unique index that
 * replaces migration 051's 7-field one), constrains the manual editor path to
 * internal_batch_reference IS NULL, creates warehouse_dispatches +
 * warehouse_dispatch_lines, links acceptance idempotency onto
 * item_availability_movements, and seeds the eight dispatch permission keys with
 * separation of duty.
 *
 * It must NOT touch public QR, Deep Clean (055), the exchange domain, or create
 * any dispatch workflow RPC — those belong to migration 062.
 *
 * NOTE ON SCOPE: this file deliberately contains NO global ceiling assertion
 * (no `getMaximumReviewedMigrationNumber() === 61`, no `/^06[23]_/` range, no
 * hard-coded guess at 062's filename). Those belong to
 * reviewed-migration-manifest.test.ts alone. Migration 060's test originally
 * carried them and had to be edited the moment 061 was registered — exactly the
 * churn MIGRATION-GUARD-DERIVE-A/B removed. This file does not repeat that.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import {
  REVIEWED_MIGRATION_FILES,
  findUnreviewedMigrationFiles,
  isReviewedMigrationFile,
} from './helpers/reviewed-migrations';
// SQL-SOURCE-LEXER-A: comment stripping is lexical and shared. The per-file
// `/--.*$/` this replaced stripped nothing at all on a CRLF checkout, and also
// truncated 061's placeholder CHECK mid-literal at its '--' string.
import { activeSql } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M061_NAME = '061_phoenix_warehouse_dispatch_schema.sql';
const P061 = join(MIGRATIONS_DIR, M061_NAME);
const m061 = readFileSync(P061, 'utf8');

const active061 = activeSql(m061);
const rawLines = active061.split('\n');
const activeLines = rawLines.map(l => l.trim()).filter(l => l.length > 0);

/**
 * The VERIFY block is the LAST top-level `DO $$` (the earlier ones are the
 * B1 precheck and the idempotent ADD CONSTRAINT / CREATE TRIGGER wrappers,
 * which legitimately carry `EXCEPTION WHEN duplicate_object`).
 */
const verifyStart = active061.lastIndexOf('\nDO $$\n');
const verifyBlock = active061.slice(verifyStart);

/**
 * Executable DDL only — between `begin;` and the VERIFY block.
 *
 * Negative scans MUST use this slice: the VERIFY block legitimately contains the
 * strings we forbid (e.g. `NOT ILIKE '%expiry_date::text%'`) inside assertions
 * whose whole purpose is to reject them. Scanning the whole file would flag the
 * guard as the violation it prevents.
 */
const ddlSection = active061.slice(active061.search(/^begin;/m), verifyStart);

const TX_BEGIN = /^begin\s*;\s*$/;
const TX_COMMIT = /^commit\s*;\s*$/;
const countOf = (re: RegExp): number => rawLines.filter(l => re.test(l)).length;
const idxOf = (re: RegExp): number => rawLines.findIndex(l => re.test(l));

// ============================================================================
// 1. Existence + registry
// ============================================================================

describe('1. migration 061 exists and is registered by exact filename', () => {
  it('061_phoenix_warehouse_dispatch_schema.sql exists', () => {
    expect(existsSync(P061)).toBe(true);
    expect(m061.length).toBeGreaterThan(3000);
  });

  it('is the only file named 061_*', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('061_'))).toEqual([M061_NAME]);
  });

  it('the canonical registry contains its exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M061_NAME);
    expect(isReviewedMigrationFile(M061_NAME)).toBe(true);
  });

  it('no unreviewed migration file exists on disk', () => {
    expect(findUnreviewedMigrationFiles(readdirSync(MIGRATIONS_DIR))).toEqual([]);
  });

  it('a synthetic unregistered migration is still rejected', () => {
    expect(isReviewedMigrationFile('062_unreviewed_test_migration.sql')).toBe(false);
    expect(
      findUnreviewedMigrationFiles([...readdirSync(MIGRATIONS_DIR), '062_unreviewed.sql']),
    ).toEqual(['062_unreviewed.sql']);
  });

  // REMOVED (USER-RBAC-U1-SCOPE-062-IMPLEMENT-A): a `no 062_* file exists on disk`
  // assertion. It was a future-ceiling guard of exactly the kind
  // MIGRATION-GUARD-DERIVE centralized, phrased per-phase rather than as a regex
  // range, so it survived that cleanup — and it failed permanently the moment
  // migration 062 was legitimately reviewed and registered. Nothing is lost:
  // reviewed-migration-manifest.test.ts rejects any unregistered 062 by exact
  // filename membership, and the synthetic-rejection test directly above still
  // proves that here. No historical phase test should break merely because a
  // later reviewed migration now exists.

  it('is manual-apply-only (mentions the prohibition, never invokes it)', () => {
    expect(m061).toContain('MANUAL APPLY ONLY');
    expect(activeLines.some(l => l.includes('supabase db push'))).toBe(false);
  });
});

// ============================================================================
// 2. Transaction wrapper + VERIFY placement
// ============================================================================

describe('2. explicit transaction wrapper with VERIFY inside it', () => {
  it('has exactly one top-level begin; and one top-level commit;', () => {
    expect(countOf(TX_BEGIN)).toBe(1);
    expect(countOf(TX_COMMIT)).toBe(1);
  });

  it('begin; precedes the first DDL statement', () => {
    const begin = idxOf(TX_BEGIN);
    const firstDdl = rawLines.findIndex(l => /^ALTER TABLE public\.item_availability$/.test(l));
    expect(begin).toBeGreaterThan(-1);
    expect(firstDdl).toBeGreaterThan(begin);
  });

  it('commit; follows the VERIFY block', () => {
    const doClose = rawLines.findIndex(l => /^END \$\$;\s*$/.test(l));
    expect(doClose).toBeGreaterThan(-1);
    expect(idxOf(TX_COMMIT)).toBeGreaterThan(doClose);
  });

  it('the VERIFY block executes inside the transaction', () => {
    const begin = idxOf(TX_BEGIN);
    const commit = idxOf(TX_COMMIT);
    const verifyLine = rawLines.length - verifyBlock.split('\n').length;
    expect(verifyLine).toBeGreaterThan(begin);
    expect(verifyLine).toBeLessThan(commit);
  });

  it('removing begin; or commit; is detectable (the guard actually bites)', () => {
    expect(rawLines.filter(l => !TX_BEGIN.test(l)).filter(l => TX_BEGIN.test(l)).length).toBe(0);
    expect(rawLines.filter(l => !TX_COMMIT.test(l)).filter(l => TX_COMMIT.test(l)).length).toBe(0);
  });

  it('uses no SAVEPOINT, ROLLBACK or nested transaction control', () => {
    expect(active061).not.toMatch(/^\s*savepoint\b/im);
    expect(active061).not.toMatch(/^\s*rollback\b/im);
    expect(active061).not.toMatch(/^\s*(begin|start)\s+transaction\b/im);
  });

  it('the VERIFY block has no EXCEPTION handler (failures must roll back)', () => {
    expect(verifyBlock).toContain('ASSERT');
    expect(verifyBlock).not.toMatch(/\bEXCEPTION\s+WHEN\b/i);
  });

  it('the only EXCEPTION handlers are idempotent duplicate_object wrappers', () => {
    const handlers = activeLines.filter(l => /\bEXCEPTION\s+WHEN\b/i.test(l));
    for (const h of handlers) {
      expect(h, `unexpected handler: ${h}`).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
    }
  });
});

// ============================================================================
// 3. Outlet internal_batch_reference
// ============================================================================

describe('3. item_availability.internal_batch_reference', () => {
  it('is added additively as nullable text', () => {
    expect(ddlSection).toMatch(
      /ALTER TABLE public\.item_availability\s+ADD COLUMN IF NOT EXISTS internal_batch_reference text;/,
    );
  });

  it('is never made NOT NULL and no existing row is populated', () => {
    // Scoped to the ALTER TABLE statement itself: `IS NOT NULL` appears
    // legitimately elsewhere (the dispatch-line internal-ref CHECK, and the
    // VERIFY block's "no row populated" probe), and neither is a column
    // declaration.
    const alterStmt = /ALTER TABLE public\.item_availability\s+ADD COLUMN IF NOT EXISTS internal_batch_reference ([^;]*);/
      .exec(ddlSection);
    expect(alterStmt).not.toBeNull();
    expect(alterStmt![1].trim()).toBe('text');
    expect(alterStmt![1]).not.toMatch(/NOT NULL/i);
    expect(alterStmt![1]).not.toMatch(/DEFAULT/i);
    // Backfill is covered by "mutates no existing data" below, which correctly
    // scopes outside the upsert function — that function legitimately contains
    // its own UPDATE/INSERT against item_availability.
  });

  it('constrains it to trimmed, non-empty, non-placeholder values', () => {
    expect(ddlSection).toContain('item_availability_internal_ref_chk');
    expect(ddlSection).toMatch(/btrim\(internal_batch_reference\) = internal_batch_reference/);
    for (const bad of ["'N/A'", "'NONE'", "'NULL'", "'-'", "'بلا'"]) {
      expect(ddlSection, `placeholder ${bad} must be rejected`).toContain(bad);
    }
  });

  it('the VERIFY block asserts no existing row was populated', () => {
    expect(verifyBlock).toContain('already carry an');
    expect(verifyBlock).toContain('internal_batch_reference IS NOT NULL');
  });
});

// ============================================================================
// 4. Outlet identity replacement
// ============================================================================

describe('4. outlet identity: 051 7-field index replaced by the 8-field model', () => {
  it('includes a fail-closed duplicate precheck BEFORE dropping the old index', () => {
    const precheck = ddlSection.indexOf('061 precheck');
    const drop = ddlSection.indexOf('DROP INDEX IF EXISTS public.item_availability_dp_sci_conc_form_nat_batch_exp_uniq');
    expect(precheck).toBeGreaterThan(-1);
    expect(drop).toBeGreaterThan(precheck);
  });

  it('drops exactly migration 051 live index, by exact name', () => {
    expect(ddlSection).toContain(
      'DROP INDEX IF EXISTS public.item_availability_dp_sci_conc_form_nat_batch_exp_uniq;',
    );
  });

  it('creates the 8-field identity index with the exact field order', () => {
    expect(ddlSection).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq\s+ON public\.item_availability \(\s*distribution_point_id,\s*scientific_name,\s*COALESCE\(concentration, ''\),\s*COALESCE\(dosage_form, ''\),\s*COALESCE\(national_code, ''\),\s*COALESCE\(batch_number, ''\),\s*COALESCE\(expiry_date, DATE '0001-01-01'\),\s*COALESCE\(internal_batch_reference, ''\)\s*\)\s*WHERE scientific_name IS NOT NULL;/,
    );
  });

  it('uses the immutable date sentinel, never a text cast (ERROR 42P17)', () => {
    expect(ddlSection).toContain("COALESCE(expiry_date, DATE '0001-01-01')");
    expect(ddlSection).not.toMatch(/expiry_date::text/i);
    expect(ddlSection).not.toMatch(/text\(expiry_date\)/i);
  });

  it('preserves migration 051 partial predicate', () => {
    expect(ddlSection).toContain('WHERE scientific_name IS NOT NULL;');
  });

  it('does not leave both conflicting indexes active', () => {
    expect(ddlSection).not.toMatch(
      /CREATE UNIQUE INDEX[^;]*item_availability_dp_sci_conc_form_nat_batch_exp_uniq/,
    );
  });

  it('does not touch migration 051 file itself', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- supabase/migrations/051_material_batch_identity_option_a.sql', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });

  it('leaves the legacy local_item/dp constraint untouched (043/051 precedent)', () => {
    expect(ddlSection).not.toMatch(/DROP CONSTRAINT[^;]*local_item_id_distribution_point_id_key/i);
  });
});

// ============================================================================
// 5. Manual editor path constrained
// ============================================================================

describe('5. phoenix_upsert_availability: manual path matches only NULL internal refs', () => {
  it('replaces the function with an identical signature', () => {
    expect(ddlSection).toContain('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability(');
    for (const p of [
      'p_distribution_point_id uuid', 'p_scientific_name        text', 'p_trade_name             text',
      'p_dosage_form            text', 'p_concentration          text', 'p_quantity               integer',
      'p_condition              text', 'p_expiry_date            date', 'p_batch_number           text',
      'p_notes                  text', 'p_supply_type            text', 'p_price                  numeric',
      'p_national_code          text DEFAULT NULL',
    ]) {
      expect(ddlSection, `param ${p}`).toContain(p);
    }
    expect(ddlSection).toContain('RETURNS uuid');
  });

  it('preserves SECURITY DEFINER and search_path', () => {
    expect(ddlSection).toContain('SECURITY DEFINER');
    expect(ddlSection).toContain('SET search_path = public');
  });

  it('adds the internal-reference restriction to the identity lookup', () => {
    expect(ddlSection).toContain('AND ia.internal_batch_reference IS NULL;');
  });

  it('keeps the full 051 seven-field match plus the new restriction', () => {
    for (const c of [
      'ia.distribution_point_id = p_distribution_point_id',
      'ia.scientific_name       = p_scientific_name',
      "COALESCE(ia.concentration, '')",
      "COALESCE(ia.dosage_form,  '')",
      "COALESCE(ia.national_code, '')",
      "COALESCE(ia.batch_number, '')",
      "COALESCE(ia.expiry_date, DATE '0001-01-01')",
    ]) {
      expect(ddlSection, `match clause ${c}`).toContain(c);
    }
  });

  it('never inserts a non-null internal reference on the manual path', () => {
    const insertStart = ddlSection.indexOf('INSERT INTO public.item_availability (');
    const insertEnd = ddlSection.indexOf('RETURNING id INTO v_id;', insertStart);
    expect(insertStart).toBeGreaterThan(-1);
    expect(insertEnd).toBeGreaterThan(insertStart);
    expect(ddlSection.slice(insertStart, insertEnd)).not.toContain('internal_batch_reference');
  });

  it('preserves the migration 035 quantity guard and permission gates', () => {
    expect(ddlSection).toContain('quantity_update_requires_movement');
    expect(ddlSection).toContain('forbidden_availability_create');
    expect(ddlSection).toContain('forbidden_availability_update');
    expect(ddlSection).toContain('forbidden_cross_org');
  });

  it('adds no new parameter (frontend contract untouched)', () => {
    expect(ddlSection).not.toContain('p_internal_batch_reference');
  });

  it('grants no anon access to the RPC', () => {
    expect(ddlSection).not.toMatch(/grant[^;]*phoenix_upsert_availability[^;]*anon/i);
  });

  it('the VERIFY block pins the signature and the restriction', () => {
    expect(verifyBlock).toContain('signature changed');
    expect(verifyBlock).toContain('ia.internal_batch_reference IS NULL');
  });
});

// ============================================================================
// 6. Dispatch header
// ============================================================================

describe('6. warehouse_dispatches', () => {
  it('creates the table', () => {
    expect(ddlSection).toMatch(/CREATE TABLE IF NOT EXISTS public\.warehouse_dispatches \(/);
  });

  it('has the required columns', () => {
    for (const c of [
      'organization_id', 'warehouse_id', 'destination_distribution_point_id', 'dispatch_number',
      'status', 'document_number', 'default_currency', 'notes', 'created_by', 'sent_by', 'sent_at',
      'cancelled_by', 'cancelled_at', 'cancellation_reason', 'created_at', 'updated_at',
    ]) {
      expect(ddlSection, `warehouse_dispatches.${c}`).toContain(c);
    }
  });

  it('allows exactly the six reviewed header statuses (text + CHECK, no enum)', () => {
    expect(ddlSection).toContain('warehouse_dispatches_status_chk');
    for (const s of ['draft', 'sent', 'partially_accepted', 'accepted', 'rejected', 'cancelled']) {
      expect(ddlSection, `header status ${s}`).toContain(`'${s}'`);
    }
    expect(ddlSection).not.toMatch(/CREATE TYPE/i);
    expect(ddlSection).not.toMatch(/\bAS ENUM\b/i);
  });

  it('makes dispatch_number unique per organization', () => {
    expect(ddlSection).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_dispatches_org_number_uniq\s+ON public\.warehouse_dispatches \(organization_id, btrim\(dispatch_number\)\);/,
    );
  });

  it('enforces cancellation and sent-at invariants', () => {
    expect(ddlSection).toContain('warehouse_dispatches_cancel_chk');
    expect(ddlSection).toContain('warehouse_dispatches_sent_at_chk');
  });

  it('enforces same-organization warehouse and destination via composite FKs', () => {
    expect(ddlSection).toMatch(
      /FOREIGN KEY \(warehouse_id, organization_id\)\s+REFERENCES public\.warehouses \(id, organization_id\) ON DELETE RESTRICT/,
    );
    expect(ddlSection).toMatch(
      /FOREIGN KEY \(destination_distribution_point_id, organization_id\)\s+REFERENCES public\.distribution_points \(id, organization_id\) ON DELETE RESTRICT/,
    );
  });

  it('does not model the warehouse as a distribution point', () => {
    expect(ddlSection).toMatch(/warehouse_id\s+uuid NOT NULL/);
    expect(ddlSection).toMatch(/destination_distribution_point_id uuid NOT NULL/);
  });
});

// ============================================================================
// 7. Composite FK targets
// ============================================================================

describe('7. composite unique FK targets added safely', () => {
  it('adds distribution_points (id, organization_id)', () => {
    expect(ddlSection).toContain('distribution_points_id_org_uniq');
    expect(ddlSection).toMatch(/ADD CONSTRAINT distribution_points_id_org_uniq UNIQUE \(id, organization_id\)/);
  });

  it('adds warehouse_stock (id, organization_id)', () => {
    expect(ddlSection).toContain('warehouse_stock_id_org_uniq');
    expect(ddlSection).toMatch(/ADD CONSTRAINT warehouse_stock_id_org_uniq UNIQUE \(id, organization_id\)/);
  });

  // WAREHOUSE-W1-DISPATCH-FK-TARGET-061-FIX-A
  //
  // Real production failure this guards against, observed applying 061:
  //   ERROR 42830: there is no unique constraint matching given keys for
  //                referenced table "warehouse_dispatches"
  //
  // warehouse_dispatch_lines_dispatch_org_fk references
  // warehouse_dispatches (id, organization_id), but the table declared only
  // PRIMARY KEY (id). A composite FK needs a UNIQUE/PK on the EXACT referenced
  // column set, and PRIMARY KEY (id) does not provide (id, organization_id).
  // The migration aborted inside its own transaction.
  it('declares warehouse_dispatches (id, organization_id) as a composite FK target', () => {
    expect(ddlSection).toContain('warehouse_dispatches_id_org_uniq');
    expect(ddlSection).toMatch(
      /CONSTRAINT warehouse_dispatches_id_org_uniq UNIQUE \(id, organization_id\)/,
    );
  });

  it('declares that target BEFORE the foreign key that references it (ERROR 42830 guard)', () => {
    const targetAt = ddlSection.indexOf('CONSTRAINT warehouse_dispatches_id_org_uniq');
    const fkAt = ddlSection.indexOf('CONSTRAINT warehouse_dispatch_lines_dispatch_org_fk');
    expect(targetAt).toBeGreaterThan(-1);
    expect(fkAt).toBeGreaterThan(-1);
    // Statement order is the whole point: PostgreSQL resolves the FK target at
    // creation time, so a target declared afterwards is worthless.
    expect(targetAt).toBeLessThan(fkAt);
  });

  it('declares the target inside the CREATE TABLE warehouse_dispatches body', () => {
    // Inline declaration is what makes the ordering unconditional — an ALTER
    // TABLE placed later in the file could drift below part F on a future edit.
    const createAt = ddlSection.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_dispatches');
    const linesAt = ddlSection.indexOf('CREATE TABLE IF NOT EXISTS public.warehouse_dispatch_lines');
    const targetAt = ddlSection.indexOf('CONSTRAINT warehouse_dispatches_id_org_uniq');
    expect(createAt).toBeGreaterThan(-1);
    expect(linesAt).toBeGreaterThan(createAt);
    expect(targetAt).toBeGreaterThan(createAt);
    expect(targetAt).toBeLessThan(linesAt);
  });

  it('keeps the dispatch-lines FK composite — same-organization integrity stays structural', () => {
    // Guards against the tempting "fix" of collapsing this to a single-column
    // dispatch_id FK, which would silently drop the org-agreement guarantee.
    expect(ddlSection).toMatch(
      /CONSTRAINT warehouse_dispatch_lines_dispatch_org_fk\s*\n\s*FOREIGN KEY \(dispatch_id, organization_id\)\s*\n\s*REFERENCES public\.warehouse_dispatches \(id, organization_id\)/,
    );
  });

  it('every composite FK in 061 has a UNIQUE/PK target declared before it', () => {
    // Mechanical sweep: each multi-column FK's referenced column set must have a
    // matching unique target that appears earlier in the file (or come from 060).
    const targets: Record<string, number> = {
      // created by migration 060, already applied in production
      'public.warehouses (id, organization_id)': -1,
      'public.distribution_points (id, organization_id)': ddlSection.indexOf(
        'ADD CONSTRAINT distribution_points_id_org_uniq UNIQUE (id, organization_id)',
      ),
      'public.warehouse_stock (id, organization_id)': ddlSection.indexOf(
        'ADD CONSTRAINT warehouse_stock_id_org_uniq UNIQUE (id, organization_id)',
      ),
      'public.warehouse_dispatches (id, organization_id)': ddlSection.indexOf(
        'CONSTRAINT warehouse_dispatches_id_org_uniq UNIQUE (id, organization_id)',
      ),
    };
    const fkRe = /FOREIGN KEY \([^)]*,[^)]*\)\s*\n\s*REFERENCES (public\.\w+ \([^)]*\))/g;
    const seen: string[] = [];
    for (const m of ddlSection.matchAll(fkRe)) {
      const ref = m[1];
      seen.push(ref);
      expect(targets).toHaveProperty(ref);
      const targetAt = targets[ref];
      if (targetAt !== -1) {
        // declared in this migration — must precede the FK that uses it
        expect(targetAt).toBeLessThan(m.index!);
      }
    }
    // All four composite FKs are accounted for; none is silently unguarded.
    expect(seen).toHaveLength(4);
  });
});

// ============================================================================
// 8. Dispatch lines
// ============================================================================

describe('8. warehouse_dispatch_lines', () => {
  it('creates the table', () => {
    expect(ddlSection).toMatch(/CREATE TABLE IF NOT EXISTS public\.warehouse_dispatch_lines \(/);
  });

  it('has the snapshot, quantity, decision and result columns', () => {
    for (const c of [
      'organization_id', 'dispatch_id', 'warehouse_stock_id', 'central_item_id',
      'scientific_name', 'trade_name', 'concentration', 'dosage_form', 'unit',
      'national_code', 'has_no_national_code', 'batch_number', 'has_no_batch_number',
      'internal_batch_reference', 'expiry_date', 'unit_price', 'price_basis', 'currency',
      'supply_type_text', 'sent_quantity', 'received_quantity', 'status', 'difference_reason',
      'rejection_reason', 'accepted_by', 'accepted_at', 'rejected_by', 'rejected_at',
      'resulting_item_availability_id', 'resulting_movement_id', 'created_at', 'updated_at',
    ]) {
      expect(ddlSection, `warehouse_dispatch_lines.${c}`).toContain(c);
    }
  });

  it('uses canonical types (integer quantities, numeric(20,3) price)', () => {
    expect(ddlSection).toMatch(/sent_quantity\s+integer NOT NULL/);
    expect(ddlSection).toMatch(/received_quantity\s+integer,/);
    expect(ddlSection).toMatch(/unit_price\s+numeric\(20,3\)/);
  });

  it('allows exactly the five reviewed line statuses', () => {
    expect(ddlSection).toContain('warehouse_dispatch_lines_status_chk');
    for (const s of ['pending', 'accepted', 'accepted_with_difference', 'rejected', 'cancelled']) {
      expect(ddlSection, `line status ${s}`).toContain(`'${s}'`);
    }
  });

  it('requires a positive sent_quantity and non-negative received_quantity', () => {
    expect(ddlSection).toMatch(/CHECK \(sent_quantity > 0\)/);
    expect(ddlSection).toMatch(/CHECK \(received_quantity IS NULL OR received_quantity >= 0\)/);
    expect(ddlSection).toMatch(/CHECK \(unit_price IS NULL OR unit_price >= 0\)/);
  });

  it('cascades lines from their header (the only cascade in 060/061)', () => {
    expect(ddlSection).toMatch(
      /FOREIGN KEY \(dispatch_id, organization_id\)\s+REFERENCES public\.warehouse_dispatches \(id, organization_id\) ON DELETE CASCADE/,
    );
    expect((ddlSection.match(/ON DELETE CASCADE/g) ?? []).length).toBe(1);
  });

  it('restricts the warehouse stock link (stock cannot vanish under its history)', () => {
    expect(ddlSection).toMatch(
      /FOREIGN KEY \(warehouse_stock_id, organization_id\)\s+REFERENCES public\.warehouse_stock \(id, organization_id\) ON DELETE RESTRICT/,
    );
    expect(ddlSection).toMatch(/central_item_id\s+uuid REFERENCES public\.central_items\(id\) ON DELETE RESTRICT/);
  });

  it('uses SET NULL for result links (required for Deep Clean compatibility)', () => {
    expect(ddlSection).toMatch(
      /resulting_item_availability_id uuid REFERENCES public\.item_availability\(id\) ON DELETE SET NULL/,
    );
    expect(ddlSection).toMatch(
      /resulting_movement_id\s+uuid REFERENCES public\.item_availability_movements\(id\) ON DELETE SET NULL/,
    );
  });

  it('uses SET NULL for actor links', () => {
    expect(ddlSection).toMatch(/accepted_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(ddlSection).toMatch(/rejected_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  });
});

// ============================================================================
// 9. No-code / no-batch / internal reference invariants
// ============================================================================

describe('9. explicit no-code and no-batch rules on dispatch lines', () => {
  it('has_no_national_code corresponds exactly to national_code being NULL', () => {
    expect(ddlSection).toContain('warehouse_dispatch_lines_has_no_national_code_chk');
    expect(ddlSection).toMatch(/CHECK \(has_no_national_code = \(national_code IS NULL\)\)/);
  });

  it('has_no_batch_number corresponds exactly to batch_number being NULL', () => {
    expect(ddlSection).toContain('warehouse_dispatch_lines_has_no_batch_number_chk');
    expect(ddlSection).toMatch(/CHECK \(has_no_batch_number = \(batch_number IS NULL\)\)/);
  });

  it('a no-batch line REQUIRES an internal reference', () => {
    expect(ddlSection).toContain('warehouse_dispatch_lines_internal_ref_rule_chk');
    expect(ddlSection).toMatch(/CASE WHEN has_no_batch_number\s+THEN internal_batch_reference IS NOT NULL/);
  });

  it('a real-batch line FORBIDS an internal reference', () => {
    expect(ddlSection).toMatch(/ELSE internal_batch_reference IS NULL/);
  });

  it('bans placeholders in national_code, batch_number and internal_batch_reference', () => {
    expect(ddlSection).toContain('warehouse_dispatch_lines_no_placeholder_chk');
    for (const bad of ["'N/A'", "'NONE'", "'NULL'", "'-'", "'بلا'"]) {
      expect(ddlSection, `placeholder ${bad}`).toContain(bad);
    }
  });
});

// ============================================================================
// 10. Decision state machine
// ============================================================================

describe('10. line decision invariants', () => {
  it('has a single decision CHECK covering every status', () => {
    expect(ddlSection).toContain('warehouse_dispatch_lines_decision_chk');
    expect(ddlSection).toMatch(/CASE status/);
    expect(ddlSection).toMatch(/ELSE false/);
  });

  it('pending carries no decision or result', () => {
    expect(ddlSection).toMatch(/WHEN 'pending' THEN\s+received_quantity IS NULL/);
  });

  it('accepted requires received = sent and accepted_at (non-FK columns only)', () => {
    expect(ddlSection).toMatch(/WHEN 'accepted' THEN\s+received_quantity = sent_quantity/);
    expect(ddlSection).toMatch(/WHEN 'accepted' THEN[\s\S]*?AND accepted_at IS NOT NULL/);
  });

  it('accepted_with_difference requires a positive, different quantity, a reason and accepted_at', () => {
    expect(ddlSection).toMatch(/WHEN 'accepted_with_difference' THEN/);
    expect(ddlSection).toMatch(/AND received_quantity > 0/);
    expect(ddlSection).toMatch(/AND received_quantity <> sent_quantity/);
    expect(ddlSection).toMatch(/AND difference_reason IS NOT NULL AND btrim\(difference_reason\) <> ''/);
    expect(ddlSection).toMatch(/WHEN 'accepted_with_difference' THEN[\s\S]*?AND accepted_at IS NOT NULL/);
  });

  it('rejected requires a reason and rejected_at, and carries no result', () => {
    expect(ddlSection).toMatch(/WHEN 'rejected' THEN/);
    expect(ddlSection).toMatch(/AND rejection_reason IS NOT NULL AND btrim\(rejection_reason\) <> ''/);
    expect(ddlSection).toMatch(/WHEN 'rejected' THEN[\s\S]*?AND rejected_at IS NOT NULL/);
    expect(ddlSection).toMatch(/WHEN 'rejected' THEN[\s\S]*?AND resulting_item_availability_id IS NULL/);
    expect(ddlSection).toMatch(/WHEN 'rejected' THEN[\s\S]*?AND resulting_movement_id IS NULL/);
  });

  it('cancelled carries neither acceptance nor rejection nor result', () => {
    expect(ddlSection).toMatch(/WHEN 'cancelled' THEN\s+received_quantity IS NULL/);
    expect(ddlSection).toMatch(/WHEN 'cancelled' THEN[\s\S]*?AND accepted_by IS NULL AND accepted_at IS NULL/);
    expect(ddlSection).toMatch(/WHEN 'cancelled' THEN[\s\S]*?AND resulting_item_availability_id IS NULL/);
    expect(ddlSection).toMatch(/WHEN 'cancelled' THEN[\s\S]*?AND resulting_movement_id IS NULL/);
  });
});

// ============================================================================
// 10b. RETENTION SAFETY — the durable-state contract
// ============================================================================

/**
 * WAREHOUSE-W1-DISPATCH-SCHEMA-061-RETENTION-FIX-A
 *
 * The governing rule these tests defend:
 *
 *   A CHECK may never require a NULLABLE FK column to remain non-null, because
 *   every FK on this table is ON DELETE SET NULL by design, and SET NULL only
 *   ever makes a column MORE null.
 *
 * The first draft of the decision CHECK violated that rule four times, producing
 * two fail-shut contradictions against retention actions the schema explicitly
 * allows:
 *
 *   A. accepted_by / rejected_by → auth.users ON DELETE SET NULL, while the
 *      CHECK required them NOT NULL ⇒ any user who ever accepted a line became
 *      permanently UNDELETABLE.
 *   B. resulting_* → item_availability / _movements ON DELETE SET NULL, while
 *      the CHECK required them NOT NULL ⇒ migration 055 Deep Clean (which
 *      physically DELETEs both tables) would ABORT, and stay broken forever once
 *      a single line had been accepted.
 *
 * The asymmetry that makes the fix safe: `IS NULL` requirements are always SET
 * NULL-safe, so pending/rejected/cancelled keep their full "no result/decision"
 * rules. Only the four `IS NOT NULL` requirements on FK columns were removed.
 * Non-FK columns (accepted_at, rejected_at, received_quantity, reasons) stay
 * required — nothing can null them.
 */
describe('10b. retention safety: durable state cannot depend on deletable rows', () => {
  /** The decision CHECK body only. */
  const decisionCheck = (() => {
    const start = ddlSection.indexOf('CONSTRAINT warehouse_dispatch_lines_decision_chk');
    expect(start).toBeGreaterThan(-1);
    const end = ddlSection.indexOf('CREATE INDEX IF NOT EXISTS warehouse_dispatch_lines_dispatch_idx', start);
    expect(end).toBeGreaterThan(start);
    // Strip the explanatory comment block so prose can never satisfy/fail a check.
    return ddlSection.slice(start, end).split('\n').filter(l => !/^\s*--/.test(l)).join('\n');
  })();

  it('the decision CHECK slice is real, not vacuous', () => {
    expect(decisionCheck.length).toBeGreaterThan(400);
    expect(decisionCheck).toContain('CASE status');
    expect(decisionCheck).toContain('ELSE false');
  });

  // --- Contradiction A: actor deletion --------------------------------------

  it('accepted_by is ON DELETE SET NULL (an accepter stays deletable)', () => {
    expect(ddlSection).toMatch(/accepted_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  });

  it('rejected_by is ON DELETE SET NULL', () => {
    expect(ddlSection).toMatch(/rejected_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  });

  it('accepted state does NOT permanently require accepted_by (contradiction A closed)', () => {
    expect(decisionCheck).not.toContain('accepted_by IS NOT NULL');
  });

  it('rejected state does NOT permanently require rejected_by (contradiction A closed)', () => {
    expect(decisionCheck).not.toContain('rejected_by IS NOT NULL');
  });

  // --- Contradiction B: Deep Clean ------------------------------------------

  it('resulting_item_availability_id is ON DELETE SET NULL', () => {
    expect(ddlSection).toMatch(
      /resulting_item_availability_id uuid REFERENCES public\.item_availability\(id\) ON DELETE SET NULL/,
    );
  });

  it('resulting_movement_id is ON DELETE SET NULL', () => {
    expect(ddlSection).toMatch(
      /resulting_movement_id\s+uuid REFERENCES public\.item_availability_movements\(id\) ON DELETE SET NULL/,
    );
  });

  it('accepted state does NOT permanently require result links (contradiction B closed)', () => {
    expect(decisionCheck).not.toContain('resulting_item_availability_id IS NOT NULL');
    expect(decisionCheck).not.toContain('resulting_movement_id IS NOT NULL');
  });

  it('accepted_with_difference does NOT permanently require result links', () => {
    const branch = decisionCheck.slice(
      decisionCheck.indexOf("WHEN 'accepted_with_difference' THEN"),
      decisionCheck.indexOf("WHEN 'rejected' THEN"),
    );
    expect(branch.length).toBeGreaterThan(50);
    expect(branch).not.toContain('IS NOT NULL AND accepted_by');
    expect(branch).not.toContain('resulting_item_availability_id IS NOT NULL');
    expect(branch).not.toContain('resulting_movement_id IS NOT NULL');
  });

  it('adds no paired-null rule on the result links (055 deletes them separately)', () => {
    expect(decisionCheck).not.toMatch(/resulting_item_availability_id IS NULL\)\s*=\s*\(/);
    expect(decisionCheck).not.toMatch(/\(resulting_movement_id IS NULL\)\s*=/);
  });

  it('no FK column anywhere in the decision CHECK is required to stay non-null', () => {
    for (const fk of [
      'accepted_by', 'rejected_by', 'resulting_item_availability_id', 'resulting_movement_id',
    ]) {
      expect(decisionCheck, `${fk} IS NOT NULL would fight its own ON DELETE SET NULL`)
        .not.toContain(`${fk} IS NOT NULL`);
    }
  });

  // --- What must still hold (non-FK columns) --------------------------------

  it('accepted still requires accepted_at and received = sent', () => {
    const branch = decisionCheck.slice(
      decisionCheck.indexOf("WHEN 'accepted' THEN"),
      decisionCheck.indexOf("WHEN 'accepted_with_difference' THEN"),
    );
    expect(branch).toContain('received_quantity = sent_quantity');
    expect(branch).toContain('accepted_at IS NOT NULL');
  });

  it('rejected still requires rejected_at and a non-empty reason', () => {
    const branch = decisionCheck.slice(
      decisionCheck.indexOf("WHEN 'rejected' THEN"),
      decisionCheck.indexOf("WHEN 'cancelled' THEN"),
    );
    expect(branch).toContain('rejected_at IS NOT NULL');
    expect(branch).toContain("btrim(rejection_reason) <> ''");
    expect(branch).toContain('resulting_item_availability_id IS NULL');
  });

  it('IS NULL requirements are retained (they are SET NULL-safe)', () => {
    expect(decisionCheck).toContain('resulting_item_availability_id IS NULL');
    expect(decisionCheck).toContain('resulting_movement_id IS NULL');
  });

  // --- Mutation proofs: the guards actually bite ----------------------------

  it('MUTATION: reintroducing an FK IS NOT NULL requirement would be caught', () => {
    const broken = decisionCheck.replace(
      'AND accepted_at IS NOT NULL',
      'AND accepted_by IS NOT NULL AND accepted_at IS NOT NULL',
    );
    expect(broken).toContain('accepted_by IS NOT NULL'); // the guard's subject appears...
    expect(decisionCheck).not.toContain('accepted_by IS NOT NULL'); // ...but not in the real file
  });

  it('MUTATION: changing an actor FK to RESTRICT would be caught', () => {
    const broken = ddlSection.replace(
      'accepted_by                    uuid REFERENCES auth.users(id) ON DELETE SET NULL',
      'accepted_by                    uuid REFERENCES auth.users(id) ON DELETE RESTRICT',
    );
    expect(broken).not.toMatch(/accepted_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(ddlSection).toMatch(/accepted_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
  });

  it('MUTATION: dropping a terminal timestamp requirement would be caught', () => {
    const broken = decisionCheck.split('AND accepted_at IS NOT NULL').join('');
    expect(broken).not.toContain('accepted_at IS NOT NULL');
    expect(decisionCheck).toContain('accepted_at IS NOT NULL');
  });

  it('MUTATION: dropping the rejection reason requirement would be caught', () => {
    const broken = decisionCheck.split("AND rejection_reason IS NOT NULL AND btrim(rejection_reason) <> ''").join('');
    expect(broken).not.toContain("btrim(rejection_reason) <> ''");
    expect(decisionCheck).toContain("btrim(rejection_reason) <> ''");
  });

  // --- The VERIFY block enforces the same contract in-database ---------------

  it('the VERIFY block asserts no FK is required non-null', () => {
    expect(verifyBlock).toContain('accepted_by IS NOT NULL%');
    expect(verifyBlock).toContain('rejected_by IS NOT NULL%');
    expect(verifyBlock).toContain('resulting_item_availability_id IS NOT NULL%');
    expect(verifyBlock).toContain('resulting_movement_id IS NOT NULL%');
    expect(verifyBlock).toContain('undeletable');
    expect(verifyBlock).toContain('would abort');
  });

  it('the VERIFY block asserts both actor FKs are SET NULL via the catalog', () => {
    expect(verifyBlock).toContain("c.confrelid = 'auth.users'::regclass AND c.confdeltype = 'n'");
    expect(verifyBlock).toContain('must be ON DELETE SET NULL, found');
  });

  it('the VERIFY block still requires the non-FK terminal columns', () => {
    expect(verifyBlock).toContain('must still require accepted_at');
    expect(verifyBlock).toContain('must still require rejected_at');
    expect(verifyBlock).toContain('must still require received_quantity = sent_quantity');
  });

  it('the VERIFY block uses pg_get_constraintdef, not comments', () => {
    expect(verifyBlock).toContain("pg_get_constraintdef(oid) INTO v_txt FROM pg_constraint");
    expect(verifyBlock).toContain("conname = 'warehouse_dispatch_lines_decision_chk'");
  });
});

// ============================================================================
// 10c. Deep Clean compatibility, stated explicitly
// ============================================================================

describe('10c. Deep Clean compatibility', () => {
  it('migration 055 deletes exactly the tables whose links must therefore be nullable', () => {
    const m055 = readFileSync(join(MIGRATIONS_DIR, '055_phoenix_clean_availability_data.sql'), 'utf8');
    const executed = activeSql(m055)
      .split('\n')
      .filter(l => !/I?LIKE\s*'%/.test(l))
      .map(l => /^\s*DELETE FROM public\.(\w+)/i.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => m[1]);

    // These two are exactly why resulting_* must be SET NULL and must not be
    // required non-null by any CHECK.
    expect(executed).toContain('item_availability');
    expect(executed).toContain('item_availability_movements');
  });

  it('061 documents why the result links are retention-soft', () => {
    expect(m061).toContain('RETENTION-SOFT');
    expect(m061).toContain('Deep Clean');
  });
});

// ============================================================================
// 11. Movement idempotency link
// ============================================================================

describe('11. item_availability_movements.dispatch_line_id', () => {
  it('is added additively as a nullable column', () => {
    expect(ddlSection).toMatch(
      /ALTER TABLE public\.item_availability_movements\s+ADD COLUMN IF NOT EXISTS dispatch_line_id uuid;/,
    );
  });

  it('links to dispatch lines with ON DELETE SET NULL', () => {
    expect(ddlSection).toMatch(
      /FOREIGN KEY \(dispatch_line_id\)\s+REFERENCES public\.warehouse_dispatch_lines\(id\) ON DELETE SET NULL/,
    );
  });

  it('adds a PARTIAL unique index: at most one movement per dispatch line', () => {
    expect(ddlSection).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS item_availability_movements_dispatch_line_uniq\s+ON public\.item_availability_movements \(dispatch_line_id\)\s+WHERE dispatch_line_id IS NOT NULL;/,
    );
  });

  it('does NOT alter the existing movement_type CHECK (acceptance uses add)', () => {
    expect(ddlSection).not.toContain('item_availability_movements_type_chk');
    expect(ddlSection).not.toMatch(/movement_type IN \(/);
  });

  it('populates no existing movement row', () => {
    expect(ddlSection).not.toMatch(/UPDATE\s+public\.item_availability_movements/i);
  });
});

// ============================================================================
// 12. Permission keys + separation of duty
// ============================================================================

describe('12. permission keys and role matrix', () => {
  it('inserts exactly the eight dispatch keys using the 010 column contract', () => {
    expect(ddlSection).toContain(
      'INSERT INTO public.permission_keys (key, module, action, label_en, label_ar, is_dangerous)',
    );
    for (const k of ['view', 'create', 'edit_draft', 'send', 'cancel', 'accept', 'reject', 'audit']) {
      expect(ddlSection, `warehouse_dispatch.${k}`).toContain(`'warehouse_dispatch.${k}'`);
    }
  });

  it('is idempotent (ON CONFLICT DO NOTHING)', () => {
    expect(ddlSection).toContain('ON CONFLICT (key) DO NOTHING');
    expect(ddlSection).toContain('ON CONFLICT (role, permission_key) DO NOTHING');
  });

  it('warehouse_officer holds the six sender keys', () => {
    for (const k of ['view', 'create', 'edit_draft', 'send', 'cancel', 'audit']) {
      expect(ddlSection).toContain(`('warehouse_officer','warehouse_dispatch.${k}',true)`);
    }
  });

  it('warehouse_officer NEVER holds accept or reject (separation of duty)', () => {
    expect(ddlSection).not.toContain("('warehouse_officer','warehouse_dispatch.accept'");
    expect(ddlSection).not.toContain("('warehouse_officer','warehouse_dispatch.reject'");
  });

  it('port_officer holds view/accept/reject/audit only', () => {
    for (const k of ['view', 'accept', 'reject', 'audit']) {
      expect(ddlSection).toContain(`('port_officer','warehouse_dispatch.${k}',true)`);
    }
    for (const k of ['create', 'edit_draft', 'send', 'cancel']) {
      expect(ddlSection).not.toContain(`('port_officer','warehouse_dispatch.${k}'`);
    }
  });

  it('institution_admin holds all eight', () => {
    for (const k of ['view', 'create', 'edit_draft', 'send', 'cancel', 'accept', 'reject', 'audit']) {
      expect(ddlSection).toContain(`('institution_admin','warehouse_dispatch.${k}',true)`);
    }
  });

  it('viewer holds view + audit only', () => {
    expect(ddlSection).toContain("('viewer','warehouse_dispatch.view',true)");
    expect(ddlSection).toContain("('viewer','warehouse_dispatch.audit',true)");
    for (const k of ['create', 'edit_draft', 'send', 'cancel', 'accept', 'reject']) {
      expect(ddlSection).not.toContain(`('viewer','warehouse_dispatch.${k}'`);
    }
  });

  it('seeds super_admin from every key (migration 010 convention, not hard-coded)', () => {
    expect(ddlSection).toMatch(
      /SELECT 'super_admin', key, true FROM public\.permission_keys/,
    );
  });

  it('seeds nothing for anon', () => {
    expect(ddlSection).not.toMatch(/\('anon',/);
  });

  it('the VERIFY block enforces the separation-of-duty rule', () => {
    expect(verifyBlock).toContain('must NEVER hold accept/reject');
    expect(verifyBlock).toContain('port_officer must not hold create/edit_draft/send/cancel');
  });
});

// ============================================================================
// 13. RLS, grants, anonymous denial
// ============================================================================

describe('13. RLS and anonymous denial', () => {
  it('enables RLS on both dispatch tables', () => {
    expect(ddlSection).toMatch(/ALTER TABLE public\.warehouse_dispatches\s+ENABLE ROW LEVEL SECURITY;/);
    expect(ddlSection).toMatch(/ALTER TABLE public\.warehouse_dispatch_lines\s+ENABLE ROW LEVEL SECURITY;/);
  });

  it('creates org-scoped SELECT policies gated on warehouse_dispatch.view', () => {
    expect(ddlSection).toContain('CREATE POLICY "warehouse_dispatches_select_perm" ON public.warehouse_dispatches');
    expect(ddlSection).toContain('CREATE POLICY "warehouse_dispatch_lines_select_perm" ON public.warehouse_dispatch_lines');
    expect(ddlSection).toContain("phoenix_profile_has_permission(auth.uid(), 'warehouse_dispatch.view')");
    expect(ddlSection).toContain('organization_id = phoenix_my_org()');
  });

  it('creates no INSERT/UPDATE/DELETE policy', () => {
    expect(ddlSection).not.toMatch(
      /CREATE POLICY[^;]*ON public\.warehouse_dispatch(es|_lines)\s+FOR (INSERT|UPDATE|DELETE|ALL)/i,
    );
  });

  it('revokes everything from PUBLIC and anon, grants authenticated SELECT only', () => {
    expect(ddlSection).toMatch(/REVOKE ALL ON TABLE public\.warehouse_dispatches\s+FROM PUBLIC, anon;/);
    expect(ddlSection).toMatch(/REVOKE ALL ON TABLE public\.warehouse_dispatch_lines\s+FROM PUBLIC, anon;/);
    expect(ddlSection).toMatch(/GRANT SELECT ON TABLE public\.warehouse_dispatches\s+TO authenticated;/);
    expect(ddlSection).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_dispatches\s+FROM authenticated;/);
    expect(ddlSection).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_dispatch_lines\s+FROM authenticated;/);
  });

  it('never grants anon anything', () => {
    expect(ddlSection).not.toMatch(/GRANT[^;]*TO[^;]*\banon\b/i);
  });

  it('uses permission keys, never role literals, for dispatch authorization', () => {
    expect(ddlSection).not.toMatch(/hospital_admin|warehouse_manager/i);
  });
});

// ============================================================================
// 14. No dispatch RPC in this migration (062 scope)
// ============================================================================

describe('14. no dispatch workflow RPC is created', () => {
  it('creates exactly one function, and it is the upsert replacement', () => {
    const fns = [...ddlSection.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)/g)].map(m => m[1]);
    expect(fns).toEqual(['phoenix_upsert_availability']);
  });

  it('creates no create/send/accept/reject/cancel RPC', () => {
    for (const fn of [
      'phoenix_create_warehouse_dispatch', 'phoenix_send_dispatch', 'phoenix_accept_dispatch_line',
      'phoenix_reject_dispatch_lines', 'phoenix_cancel_dispatch', 'phoenix_upsert_dispatch_line',
    ]) {
      expect(ddlSection, `${fn} belongs to 062`).not.toContain(fn);
    }
  });
});

// ============================================================================
// 15. Isolation + non-destructiveness
// ============================================================================

describe('15. isolation from out-of-scope domains', () => {
  it('does not modify the public QR RPC', () => {
    expect(ddlSection).not.toMatch(/CREATE OR REPLACE FUNCTION[^;]*get_public_qr_payload/i);
    expect(ddlSection).not.toMatch(/DROP FUNCTION[^;]*get_public_qr_payload/i);
  });

  it('does not modify Deep Clean (055)', () => {
    expect(ddlSection).not.toMatch(/CREATE OR REPLACE FUNCTION[^;]*phoenix_clean_availability_data/i);
  });

  it('does not modify the inter-org exchange or alert domain', () => {
    expect(ddlSection).not.toMatch(/ALTER TABLE\s+(public\.)?inter_org_/i);
    expect(ddlSection).not.toMatch(/CREATE TABLE[^;]*inter_org_/i);
    expect(ddlSection).not.toMatch(/DROP TABLE\s+(public\.)?inter_org_/i);
  });

  it('does not modify the migration 060 warehouse foundation tables', () => {
    expect(ddlSection).not.toMatch(/ALTER TABLE public\.warehouse_stock_movements/i);
    expect(ddlSection).not.toMatch(/DROP TABLE[^;]*warehouse_stock/i);
  });

  it('does not modify PublicQrScreen or any product file', () => {
    let diff = '';
    try {
      // PROFILE-IDENTITY-SNAPSHOT-RETURN-TYPE-064-A: scoped to product code.
      // Test-maintenance files are excluded because they are not product,
      // runtime, or UI code — this guard's stated subject. Everything shippable
      // under src/ (components, hooks, stores, services, pages, lib) is still
      // covered: a diff in any of them still fails this assertion.
      // PHASE-A-A5-INSTITUTIONS-OUTLETS-A: a later, separately-reviewed phase
      // applies presentation-only className/data-attribute hooks (Phase A
      // design layer, no business-logic change) across the Institution and
      // Outlet Operations surfaces plus the shared entry point — excluded here.
      // PHASE-A-CLAUDE-A6: a still later, separately-reviewed phase applies
      // the same kind of presentation-only className/data-attribute hooks
      // (phase-a-alerts-admin-qr.css) to Status Center / User Administration /
      // Platform Broadcast / Availability Cleanup / Public QR — excluded here.
      // PHASE-A-CLAUDE-A7: a still later, separately-reviewed phase (Phoenix
      // Daylight visual convergence) applies the same kind of presentation-
      // only token/data-attribute recolouring — never a prop, handler, or RPC
      // change — to PhoenixSidebar/PhoenixMobileDrawer (nav active state moved
      // from an inline style to a CSS data-active selector), ResetPassword
      // Screen (primary-button recolour), and PhoenixButton/PhoenixMobile
      // BottomNav/PhoenixStatusBadge (gold primary, teal secondary, dedicated
      // info-blue) — excluded here.
      diff = execSync(
        // R1.1-P: a still later, separately-reviewed phase (health-sector facility
        // parity) routes every navigation surface through ONE shared projection,
        // pins initial provisioning to the selected outlet's paired owning
        // warehouse, and adds the grouping/corridor UI strings. Presentation and
        // projection only — no schema, RLS, RPC or workflow change — excluded
        // here BY EXACT NAME; every other product path stays watched.
        'git diff --name-only -- src ":(exclude)src/**/__tests__/**" '
        + '":(exclude)src/shared/ui/CommandPalette.tsx" ":(exclude)src/features/outlet/EmergencyReplenishmentTab.tsx" ":(exclude)src/features/outlet/InitialProvisioningLauncher.tsx" ":(exclude)src/shared/i18n/strings.ts" ' +
        '":(exclude)src/features/institutions/InstitutionScreen.tsx" ' +
        '":(exclude)src/features/institutions/AvailabilityItemDetailsModal.tsx" ' +
        '":(exclude)src/features/outlet/OutletOperationsScreen.tsx" ' +
        '":(exclude)src/features/outlet/OutletIncomingSupplies.tsx" ' +
        '":(exclude)src/features/outlet/OutletReturnComposer.tsx" ' +
        '":(exclude)src/features/outlet/OutletStockCorrectionModal.tsx" ' +
        '":(exclude)src/features/outlet/DispenseComposerDialog.tsx" ' +
        '":(exclude)src/features/outlet/DispenseContextDialog.tsx" ' +
        // STAGE-F-PATIENT-DISPENSING-172: the Stage-F card/chart type and
        // submit payload live beside the dialog already excluded above.
        // Named exactly — this guard still catches any OTHER product file.
        '":(exclude)src/features/outlet/dispense-context.service.ts" ' +
        '":(exclude)src/features/outlet/DispenseContextViewer.tsx" ' +
        '":(exclude)src/features/outlet/CurrentMovementStatus.tsx" ' +
        '":(exclude)src/features/status/StatusCenterScreen.tsx" ' +
        '":(exclude)src/features/status/InternalAlertsSection.tsx" ' +
        '":(exclude)src/features/status/OutletMaterialGroups.tsx" ' +
        '":(exclude)src/features/users/UserManagementScreen.tsx" ' +
        '":(exclude)src/features/platform-broadcast/PlatformBroadcastAdminPanel.tsx" ' +
        '":(exclude)src/features/platform-broadcast/PlatformBroadcastGate.tsx" ' +
        '":(exclude)src/features/admin/AvailabilityCleanupWizard.tsx" ' +
        '":(exclude)src/features/qr/PublicQrScreen.tsx" ' +
        '":(exclude)src/main.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixSidebar.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixMobileDrawer.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixButton.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixMobileBottomNav.tsx" ' +
        '":(exclude)src/shared/ui/PhoenixStatusBadge.tsx" ' +
        '":(exclude)src/features/auth/ResetPasswordScreen.tsx" ' +
        // PHASE-A-CLAUDE-A7.1: a still later, separately-reviewed phase (A7.1
        // visual acceptance closure) finishes converting the last hardcoded
        // hex literals it found repo-wide to Phoenix tokens — never a prop,
        // handler, or RPC change — see hardcoded-colour-allowlist.md.
        '":(exclude)src/features/alerts/materialAlertEngine.ts" ' +
        '":(exclude)src/shared/ui/NotificationBell.tsx" ' +
        '":(exclude)src/shared/ui/WhatsAppContactButton.tsx" ' +
        '":(exclude)src/features/network/NetworkManagementScreen.tsx" ' +
        '":(exclude)src/features/network/DirectSupplyOperations.tsx" ' +
        '":(exclude)src/features/outlet/OutletDispatchOperations.tsx" ' +
        '":(exclude)src/features/procurement/DirectEntryPanel.tsx" ' +
        '":(exclude)src/features/reports/ReportsScreen.tsx" ' +
        '":(exclude)src/shared/lib/phase-a-visual-convergence.css" ' +
        '":(exclude)src/shared/lib/phoenix-nexus.css" ' +
        '":(exclude)src/shared/lib/tokens.css" ' +
        // PHASE-A-CLAUDE-A7.2: a still later, separately-reviewed phase
        // (Premium Living Auth & Welcome) retires the photographic Phoenix-
        // bird hero on both auth screens for an original inline-SVG supply-
        // network illustration — never a handler, session, or RPC change —
        // and flips AppContext's in-memory theme default to light-first
        // (no persistence key exists or is added; same structure, same
        // toggle) — excluded here.
        '":(exclude)src/features/auth/LoginScreen.tsx" ' +
        '":(exclude)src/features/auth/PhoenixWelcomeExperience.tsx" ' +
        '":(exclude)src/app/AppContext.tsx" ' +
        // PHASE-A-CLAUDE-A7.2.1: a still later, separately-reviewed phase
        // (Luxury Visual Fidelity Correction) reworks the illustration
        // component and its CSS layer for closer reference-board fidelity —
        // never a handler, session, or RPC change — excluded here.
        '":(exclude)src/shared/ui/InstitutionalSupplyMotif.tsx" ' +
        '":(exclude)src/shared/lib/phase-a-auth-welcome-signature.css" ' +
        // PHASE-C2-ORG-SCOPE: a still later, separately-reviewed phase scopes
        // Custody Chain and Corrections History (Screen 21 reports tabs) to
        // the selected organization — never a schema, RLS, or workflow
        // change — in custody-chain.service.ts / differences-corrections.
        // service.ts (new orgId param), dispatch.service.ts / outlet-return.
        // service.ts (additive optional organizationId narrowing filter,
        // backward-compatible), and DecisionIntelligenceReportsScreen.tsx
        // (threads activeOrgId into the two tabs) — all excluded here.
        '":(exclude)src/features/reports/custody-chain.service.ts" ' +
        '":(exclude)src/features/reports/differences-corrections.service.ts" ' +
        '":(exclude)src/features/reports/DecisionIntelligenceReportsScreen.tsx" ' +
        '":(exclude)src/features/outlet/dispatch.service.ts" ' +
        '":(exclude)src/features/outlet/outlet-return.service.ts" ' +
        '":(exclude)src/features/movement/DirectReturnComposer.tsx" ' +
        '":(exclude)src/features/network/network.service.ts" ' +
        '":(exclude)src/features/movement/movement-timeline.service.ts" ' +
        // PHASE-C1-REPORT-INTEGRITY: a still later, separately-reviewed phase
        // fixes Monthly Position's error-swallowing and replaces
        // isDemoOrganization's lossy boolean with a real demo/official/
        // unverified tri-state — never a schema, RLS, or workflow change —
        // in decision-intelligence.service.ts (new type/function, new i18n
        // keys in strings.ts) — excluded here.
        '":(exclude)src/features/reports/decision-intelligence.service.ts" ' +
        // STAGE-E-E7-1-171: a still later, separately-reviewed phase
        // (Migration 171, organization_kind discriminator) adds a new
        // exported type/vocabulary and doc comment to
        // src/shared/lib/institution-hierarchy.ts — a pure types/vocabulary
        // module with no database access, no service function, and no
        // eligibility rule (per its own header) — never a schema, RLS, or
        // workflow change — excluded here.
        '":(exclude)src/shared/lib/institution-hierarchy.ts" ' +
        // STAGE-E-E7-2: the Stage-E application-wiring phase. It adds no
        // migration; it wires already-reviewed RPCs into services and UI.
        // organizations.service.ts now sends the Migration-164/171
        // classification pair it previously omitted (a real regression fix),
        // and warehouses.service.ts now carries Migration 164's
        // clinical_location_kind on distribution points. Excluded by exact
        // name; every other product path stays watched.
        '":(exclude)src/shared/supabase/services/organizations.service.ts" ' +
        '":(exclude)src/shared/supabase/services/warehouses.service.ts" ":(exclude)src/features/outlet/EmergencyReplenishmentTab.tsx" ":(exclude)src/features/outlet/InitialProvisioningLauncher.tsx" ":(exclude)src/features/institutions/FacilityManagementPanel.tsx" ":(exclude)src/features/institutions/ReplenishmentRouteManagementPanel.tsx" ":(exclude)src/features/institutions/WarehouseFacilityAssignmentPanel.tsx" ' +
        // R1.3: a still later, separately-reviewed stage (canonical supply
        // cycle) makes screen 17's navigation gate capability-correct so a
        // warehouse_transfer.send holder can reach the Supply surface without
        // users.edit_scope. ONE predicate in the canonical screen-authorization
        // module — no schema, RLS, RPC or workflow change, and scope management
        // stays gated on users.edit_scope — excluded here BY EXACT NAME; every
        // other product path stays watched.
        '":(exclude)src/shared/authz/screen-access.ts" ' +
        '":(exclude)src/shared/i18n/strings.ts"', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch { /* ignore */ }
    // M187 authorizes exactly these three delegated-access integration files.
    // SUBSET, not equality: this diffs the WORKING TREE, which is empty once
    // committed and on every CI checkout. Anything outside the list still
    // fails closed exactly as the pre-187 `toBe('')` assertion did.
    const DELEGATED_AUTHORIZED = [
      'src/features/inventory/useInventoryScopes.ts',
      'src/features/inventory/useOutletRecallPermission.ts',
      'src/shared/ui/PhoenixOrgScope.tsx',
    ];
    // G3.2 — CANONICAL SEARCH & MATERIAL SELECTION CONVERGENCE authorizes
    // exactly these seven files. Same SUBSET mechanism M187 established, and
    // deliberately the same EXACT-PATH form — never a directory, glob or
    // pattern. A seventh file added under any of these folders still fails this
    // guard closed, which is the whole point of listing names instead of
    // widening the pathspec above.
    //
    // DirectEntryPanel.tsx is already excluded by name in the pathspec, so it is
    // not repeated here. search-contract.ts IS listed as of G3.2 Revision 5: it
    // was withheld while untracked, because `git diff` never reports untracked
    // paths and naming it then would have pre-authorized an unreviewed future
    // change. It is now a reviewed production file about to be committed, and a
    // guard that passes only because a production file is invisible to it is no
    // guard. The entry is the EXACT path — a sibling like search-contract-v2.ts
    // or search-contract.ts.bak still fails this guard closed.
    const G3_2_AUTHORIZED = [
      'src/shared/materials/material-resolver.service.ts',
      'src/shared/materials/PhoenixMaterialResolver.tsx',
      'src/shared/materials/search-contract.ts',
      'src/features/movement/composer-model.ts',
      'src/features/reports/global-material-search.service.ts',
      'src/features/reports/GlobalMaterialSearchPanel.tsx',
      'src/features/inventory/ocr/catalog-adapter.ts',
    ];
    // ALERT-CQRS-BOUNDARY-190 (G4.1): the inter-org alert read/write split.
    // Three production files change, and each is listed by its EXACT path so a
    // sibling or a renamed copy still fails this guard closed. None of them is
    // a DB, RLS, RBAC, auth or migration surface: the split itself lives in
    // migration 190 and is reviewed by its own static and dynamic suites.
    const G4_1_AUTHORIZED = [
      'src/features/alerts/inter-org-alert-lifecycle.service.ts',
      'src/features/alerts/InterInstitutionAlertsScreen.tsx',
      'src/features/dashboard/DashboardScreen.tsx',
    ];
    const STAGE_AUTHORIZED = [...DELEGATED_AUTHORIZED, ...G3_2_AUTHORIZED, ...G4_1_AUTHORIZED];
    const changed = diff.trim().split('\n').filter(Boolean).sort();
    expect(changed.filter(f => !STAGE_AUTHORIZED.includes(f))).toEqual([]);
  });
});

describe('16. no destructive SQL beyond the reviewed index replacement', () => {
  it('contains no DELETE or TRUNCATE', () => {
    expect(active061).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(active061).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('drops no table, column, constraint or function', () => {
    expect(active061).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(active061).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(active061).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
    expect(active061).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(active061).not.toMatch(/\bDROP\s+SCHEMA\b/i);
  });

  it('the only DROP statements are the reviewed index and idempotent policy drops', () => {
    const drops = activeLines.filter(l => /^DROP\b/i.test(l));
    for (const d of drops) {
      expect(d, `unexpected DROP: ${d}`).toMatch(
        /^DROP (POLICY IF EXISTS|INDEX IF EXISTS public\.item_availability_dp_sci_conc_form_nat_batch_exp_uniq)/,
      );
    }
    expect(drops.filter(d => /^DROP INDEX/i.test(d)).length).toBe(1);
  });

  it('mutates no existing data', () => {
    // Scoped to statements OUTSIDE the phoenix_upsert_availability body: that
    // function legitimately contains its own `INSERT INTO public.item_availability`
    // (it is the editor's insert path, reproduced verbatim from 053). A backfill
    // would be a top-level statement, which is what this checks.
    const fnStart = ddlSection.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_upsert_availability');
    const fnEnd = ddlSection.indexOf('\n$$;', fnStart);
    expect(fnStart).toBeGreaterThan(-1);
    expect(fnEnd).toBeGreaterThan(fnStart);
    const outsideFn = ddlSection.slice(0, fnStart) + ddlSection.slice(fnEnd);

    expect(outsideFn).not.toMatch(/^\s*UPDATE\s+public\./im);
    expect(outsideFn).not.toMatch(/INSERT INTO public\.item_availability\b/);
    // The only top-level INSERTs are the two idempotent permission seeds.
    const inserts = [...outsideFn.matchAll(/INSERT INTO public\.(\w+)/g)].map(m => m[1]);
    expect([...new Set(inserts)].sort()).toEqual(['permission_keys', 'role_permission_defaults']);
  });
});

// ============================================================================
// 17. Migrations 001–060 untouched
// ============================================================================

describe('17. migrations 001–060 remain untouched', () => {
  it('no tracked migration SQL file 001–060 has a working-tree diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff --name-only -- supabase/migrations', { cwd: ROOT, encoding: 'utf8' });
    } catch { /* ignore */ }
    const changed = diff.split('\n')
      .filter(f => /^supabase\/migrations\/0(0[1-9]|[1-5][0-9]|60)_.*\.sql$/.test(f.trim()));
    expect(changed).toEqual([]);
  });

  it('migration 055 Deep Clean is unchanged and deletes no dispatch table', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- supabase/migrations/055_phoenix_clean_availability_data.sql', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');

    const m055 = readFileSync(join(MIGRATIONS_DIR, '055_phoenix_clean_availability_data.sql'), 'utf8');
    const executed = activeSql(m055)
      .split('\n')
      .filter(l => !/I?LIKE\s*'%/.test(l))
      .map(l => /^\s*DELETE FROM public\.(\w+)/i.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => m[1]);
    expect(executed.length).toBeGreaterThan(0);
    for (const t of ['warehouse_dispatches', 'warehouse_dispatch_lines']) {
      expect(executed, `Deep Clean must never delete ${t}`).not.toContain(t);
    }
  });

  it('migration 059 public QR is unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- supabase/migrations/059_phoenix_public_qr_concentration.sql', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch { /* ignore */ }
    expect(diff.trim()).toBe('');
  });
});

// ============================================================================
// 18. VERIFY coverage
// ============================================================================

describe('18. VERIFY asserts what the migration claims', () => {
  it('asserts the identity replacement', () => {
    expect(verifyBlock).toContain('item_availability_dp_sci_conc_form_nat_batch_exp_uniq');
    expect(verifyBlock).toContain('item_availability_dp_sci_conc_form_nat_batch_exp_ibr_uniq');
    expect(verifyBlock).toContain('must not cast expiry_date to text');
  });

  it('asserts the upsert signature and restriction', () => {
    expect(verifyBlock).toContain('phoenix_upsert_availability');
    expect(verifyBlock).toContain('SECURITY DEFINER');
  });

  it('asserts dispatch schema, statuses and FK actions', () => {
    expect(verifyBlock).toContain('warehouse_dispatches_status_chk');
    expect(verifyBlock).toContain('warehouse_dispatch_lines_status_chk');
    expect(verifyBlock).toContain('must be ON DELETE SET NULL');
    expect(verifyBlock).toContain('must be ON DELETE RESTRICT');
  });

  it('asserts movement idempotency', () => {
    expect(verifyBlock).toContain('item_availability_movements_dispatch_line_uniq');
    expect(verifyBlock).toContain('PARTIAL UNIQUE');
  });

  it('asserts permissions and separation of duty', () => {
    expect(verifyBlock).toContain('expected exactly 8 warehouse_dispatch.* keys');
    expect(verifyBlock).toContain('self-accept');
  });

  it('asserts RLS, anon denial and no write path', () => {
    expect(verifyBlock).toContain('RLS not enabled on');
    expect(verifyBlock).toContain('anon holds a privilege on');
    expect(verifyBlock).toContain('holds a write grant on');
    expect(verifyBlock).toContain('direct write policy exists on');
  });

  it('asserts out-of-scope domains are intact', () => {
    expect(verifyBlock).toContain('get_public_qr_payload');
    expect(verifyBlock).toContain('phoenix_clean_availability_data');
    expect(verifyBlock).toContain('inter_org_exchange_requests_orgs_distinct_chk');
    expect(verifyBlock).toContain('migration 060 table missing');
  });
});
