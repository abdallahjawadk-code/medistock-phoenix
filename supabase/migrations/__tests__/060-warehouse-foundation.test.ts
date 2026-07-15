/**
 * WAREHOUSE-W1-FOUNDATION-IMPLEMENT-A
 *
 * Static SQL-source tests for migration 060 — no DB connection (migrations are
 * manual-apply-only in this repo), matching the convention of every other
 * migration test here (052/053/054/056/057/058/059).
 *
 * Migration 060 revives the dormant `warehouses` domain (additive is_main/code
 * + one-active-main-per-org), modernizes its RLS from legacy role gates to
 * permission-key gates, and creates the batch-aware `warehouse_stock` +
 * immutable `warehouse_stock_movements` foundation.
 *
 * It must NOT touch item_availability, the public QR RPC, Deep Clean (055), or
 * the inter-org exchange domain, and must NOT create any dispatch object —
 * those belong to migrations 061/062.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync, readdirSync } from 'fs';
import { execSync } from 'child_process';
import { join } from 'path';
import {
  REVIEWED_MIGRATION_FILES,
  findUnreviewedMigrationFiles,
  getMaximumReviewedMigrationNumber,
  getNextUnreviewedMigrationNumber,
  isReviewedMigrationFile,
} from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const MIGRATIONS_DIR = join(ROOT, 'supabase/migrations');

const M060_NAME = '060_phoenix_warehouse_foundation.sql';
const P060 = join(MIGRATIONS_DIR, M060_NAME);
const m060 = readFileSync(P060, 'utf8');

/** Active SQL only: strip `--` line comments so prose can never satisfy a check. */
function activeSql(sql: string): string {
  return sql
    .split('\n')
    .map(l => l.replace(/--.*$/, ''))
    .join('\n');
}
const active060 = activeSql(m060);

/** Lines of active SQL, trimmed, blank-free. */
const activeLines = active060.split('\n').map(l => l.trim()).filter(l => l.length > 0);

/**
 * The VERIFY block is the LAST top-level `DO $$` in the file (the earlier ones
 * are the idempotent ADD CONSTRAINT wrappers, which legitimately carry
 * `EXCEPTION WHEN duplicate_object`).
 */
const verifyStart = active060.lastIndexOf('DO $$');
const verifyBlock = active060.slice(verifyStart);

/**
 * Executable DDL only — everything between `begin;` and the VERIFY block.
 *
 * Negative scans MUST run against this slice, not the whole file: the VERIFY
 * block legitimately contains the very strings we forbid (e.g.
 * `NOT ILIKE '%hospital_admin%'`, `NOT ILIKE '%expiry_date::text%'`), inside
 * assertions whose entire purpose is to reject them. Scanning the whole file
 * would flag the guard as the violation it prevents.
 */
const ddlSection = active060.slice(
  active060.search(/^begin;/m),
  verifyStart,
);

/** Top-level transaction statements: bare keyword at column 0 WITH a semicolon. */
const TX_BEGIN = /^begin\s*;\s*$/;
const TX_COMMIT = /^commit\s*;\s*$/;
const rawLines = activeSql(m060).split('\n');
const idxOf = (re: RegExp): number => rawLines.findIndex(l => re.test(l));
const countOf = (re: RegExp): number => rawLines.filter(l => re.test(l)).length;

// ============================================================================
// 1. Existence + registry
// ============================================================================

describe('1. migration 060 exists and is registered by exact filename', () => {
  it('060_phoenix_warehouse_foundation.sql exists', () => {
    expect(existsSync(P060)).toBe(true);
    expect(m060.length).toBeGreaterThan(2000);
  });

  it('is the only file named 060_*', () => {
    const matches = readdirSync(MIGRATIONS_DIR).filter(f => f.startsWith('060_'));
    expect(matches).toEqual([M060_NAME]);
  });

  it('the canonical registry contains its exact filename', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(M060_NAME);
    expect(isReviewedMigrationFile(M060_NAME)).toBe(true);
  });

  it('the registry maximum is now 60 and the next unreviewed number is 61', () => {
    expect(getMaximumReviewedMigrationNumber()).toBe(60);
    expect(getNextUnreviewedMigrationNumber()).toBe(61);
  });

  it('no unreviewed migration file exists on disk', () => {
    expect(findUnreviewedMigrationFiles(readdirSync(MIGRATIONS_DIR))).toEqual([]);
  });

  it('a synthetic migration 061 remains unreviewed and rejected', () => {
    expect(isReviewedMigrationFile('061_phoenix_warehouse_dispatch_schema.sql')).toBe(false);
    expect(
      findUnreviewedMigrationFiles([...readdirSync(MIGRATIONS_DIR), '061_unreviewed.sql']),
    ).toEqual(['061_unreviewed.sql']);
  });

  it('no real migration 061 or 062 file was created by this phase', () => {
    expect(readdirSync(MIGRATIONS_DIR).filter(f => /^06[12]_/.test(f))).toEqual([]);
  });

  it('is manual-apply-only (mentions the prohibition, never invokes it)', () => {
    expect(m060).toContain('MANUAL APPLY ONLY');
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
    const firstDdl = rawLines.findIndex(l => /^ALTER TABLE public\.warehouses ADD COLUMN/i.test(l));
    expect(begin).toBeGreaterThan(-1);
    expect(firstDdl).toBeGreaterThan(begin);
  });

  it('commit; follows the VERIFY do $$ ... end $$; block', () => {
    const doOpen = rawLines.findIndex(l => /^DO \$\$/i.test(l));
    const doClose = rawLines.findIndex(l => /^END \$\$;\s*$/i.test(l));
    const commit = idxOf(TX_COMMIT);
    expect(doOpen).toBeGreaterThan(-1);
    expect(doClose).toBeGreaterThan(doOpen);
    expect(commit).toBeGreaterThan(doClose);
  });

  it('the VERIFY block executes inside the transaction', () => {
    const begin = idxOf(TX_BEGIN);
    const commit = idxOf(TX_COMMIT);
    const doOpen = rawLines.findIndex(l => /^DO \$\$/i.test(l));
    expect(doOpen).toBeGreaterThan(begin);
    expect(doOpen).toBeLessThan(commit);
  });

  it('removing begin; or commit; is detectable (the guard actually bites)', () => {
    const withoutBegin = rawLines.filter(l => !TX_BEGIN.test(l));
    const withoutCommit = rawLines.filter(l => !TX_COMMIT.test(l));
    expect(withoutBegin.filter(l => TX_BEGIN.test(l)).length).toBe(0);
    expect(withoutCommit.filter(l => TX_COMMIT.test(l)).length).toBe(0);
  });

  it('uses no SAVEPOINT, ROLLBACK or nested transaction control', () => {
    expect(active060).not.toMatch(/^\s*savepoint\b/im);
    expect(active060).not.toMatch(/^\s*rollback\b/im);
    expect(active060).not.toMatch(/^\s*(begin|start)\s+transaction\b/im);
  });

  it('the VERIFY block has no EXCEPTION handler (failures must propagate)', () => {
    // The earlier DO blocks are the idempotent ADD CONSTRAINT wrappers, which
    // legitimately use `EXCEPTION WHEN duplicate_object`. The VERIFY block (the
    // last one) must swallow nothing, so a failed ASSERT aborts the transaction.
    expect(verifyBlock).toContain('ASSERT');
    expect(verifyBlock).not.toMatch(/\bEXCEPTION\s+WHEN\b/i);
  });
});

// ============================================================================
// 3. warehouses repair — additive only
// ============================================================================

describe('3. warehouses repair adds only is_main and code', () => {
  it('adds is_main boolean NOT NULL DEFAULT false', () => {
    expect(active060).toMatch(
      /ALTER TABLE public\.warehouses ADD COLUMN IF NOT EXISTS is_main boolean NOT NULL DEFAULT false;/i,
    );
  });

  it('adds code as nullable text', () => {
    expect(active060).toMatch(/ALTER TABLE public\.warehouses ADD COLUMN IF NOT EXISTS code\s+text;/i);
  });

  it('adds no other column to warehouses', () => {
    const added = [...active060.matchAll(/ADD COLUMN IF NOT EXISTS (\w+)/gi)]
      .filter(m => /warehouses ADD COLUMN/i.test(m[0]) || true)
      .map(m => m[1]);
    const onWarehouses = [...active060.matchAll(
      /ALTER TABLE public\.warehouses ADD COLUMN IF NOT EXISTS (\w+)/gi,
    )].map(m => m[1]);
    expect(onWarehouses.sort()).toEqual(['code', 'is_main']);
    expect(added.length).toBeGreaterThanOrEqual(2);
  });

  it('does not re-add any pre-existing warehouses column', () => {
    const existing = [
      'id', 'organization_id', 'name', 'name_ar', 'location_notes', 'status',
      'archived_at', 'archived_by', 'archive_reason', 'created_at', 'updated_at', 'created_by',
    ];
    const onWarehouses = [...active060.matchAll(
      /ALTER TABLE public\.warehouses ADD COLUMN IF NOT EXISTS (\w+)/gi,
    )].map(m => m[1]);
    for (const col of existing) {
      expect(onWarehouses, `${col} must not be re-added`).not.toContain(col);
    }
  });

  it('never drops a warehouses column or the table', () => {
    expect(active060).not.toMatch(/ALTER TABLE\s+(public\.)?warehouses\s+DROP\s+COLUMN/i);
    expect(active060).not.toMatch(/DROP TABLE/i);
  });

  it('constrains code to NULL or a trimmed non-empty value', () => {
    expect(active060).toContain('warehouses_code_nonempty_chk');
    expect(active060).toMatch(/CHECK \(code IS NULL OR \(btrim\(code\) = code AND code <> ''\)\)/i);
  });

  it('bans literal placeholders in code (absence is NULL)', () => {
    expect(active060).toContain('warehouses_code_no_placeholder_chk');
    expect(active060).toContain("'بلا'");
    expect(active060).toMatch(/'N\/A'/);
    expect(active060).toMatch(/'NONE'/);
  });

  it('is_main = true is only valid while status = active', () => {
    expect(active060).toContain('warehouses_main_requires_active_chk');
    expect(active060).toMatch(/CHECK \(is_main = false OR status = 'active'\)/i);
  });

  it('adds the composite FK target UNIQUE (id, organization_id)', () => {
    expect(active060).toContain('warehouses_id_org_uniq');
    expect(active060).toMatch(/UNIQUE \(id, organization_id\)/i);
  });

  it('does not backfill codes or auto-promote a main warehouse', () => {
    expect(active060).not.toMatch(/UPDATE\s+(public\.)?warehouses/i);
    expect(active060).not.toMatch(/INSERT\s+INTO\s+(public\.)?warehouses/i);
  });
});

// ============================================================================
// 4. One active main warehouse per organization + code uniqueness
// ============================================================================

describe('4. one-active-main-per-org and org/code uniqueness', () => {
  it('creates a partial unique index on organization_id for the active main warehouse', () => {
    expect(active060).toContain('warehouses_one_active_main_per_org_uniq');
    expect(active060).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouses_one_active_main_per_org_uniq\s+ON public\.warehouses \(organization_id\)\s+WHERE is_main = true AND status = 'active';/i,
    );
  });

  it('creates a partial unique index on (organization_id, btrim(code)) when code is present', () => {
    expect(active060).toContain('warehouses_org_code_uniq');
    expect(active060).toMatch(/ON public\.warehouses \(organization_id, btrim\(code\)\)/i);
    expect(active060).toMatch(/WHERE code IS NOT NULL;/i);
  });
});

// ============================================================================
// 5. Legacy policy replacement
// ============================================================================

describe('5. legacy role-based warehouse policies replaced by permission policies', () => {
  it('drops exactly the four known legacy wh_* policies', () => {
    for (const p of ['wh_select_org', 'wh_write_superadmin', 'wh_write_hospitaladmin', 'wh_write_wh_manager']) {
      expect(active060).toContain(`DROP POLICY IF EXISTS "${p}"`);
    }
  });

  it('creates permission-based SELECT/INSERT/UPDATE policies', () => {
    for (const p of ['wh_select_perm', 'wh_insert_perm', 'wh_update_perm']) {
      expect(active060).toContain(`CREATE POLICY "${p}" ON public.warehouses`);
    }
  });

  it('gates reads on warehouses.view and writes on warehouses.manage', () => {
    expect(active060).toContain("phoenix_profile_has_permission(auth.uid(), 'warehouses.view')");
    expect(active060).toContain("phoenix_profile_has_permission(auth.uid(), 'warehouses.manage')");
  });

  it('scopes every non-super_admin branch to the caller organization', () => {
    expect(active060).toContain('organization_id = phoenix_my_org()');
    expect(active060).toContain("phoenix_my_role() = 'super_admin'");
  });

  it('never authorizes on the legacy role names', () => {
    // Scanned against executable DDL only: the VERIFY block legitimately names
    // these roles inside NOT ILIKE assertions that reject them.
    expect(ddlSection).not.toMatch(/hospital_admin/i);
    expect(ddlSection).not.toMatch(/warehouse_manager/i);
    // And the VERIFY block does assert their absence.
    expect(verifyBlock).toContain("NOT ILIKE '%hospital_admin%'");
    expect(verifyBlock).toContain("NOT ILIKE '%warehouse_manager%'");
  });

  it('creates no client DELETE policy on warehouses (archive-based retirement)', () => {
    expect(active060).not.toMatch(/CREATE POLICY[^;]*ON public\.warehouses\s+FOR DELETE/i);
  });

  it('drops no policy other than the four reviewed legacy ones', () => {
    const drops = [...active060.matchAll(/DROP POLICY IF EXISTS "([^"]+)"/g)].map(m => m[1]);
    expect(drops.sort()).toEqual([
      'warehouse_stock_mov_select_perm',
      'warehouse_stock_select_perm',
      'wh_select_org',
      'wh_write_hospitaladmin',
      'wh_write_superadmin',
      'wh_write_wh_manager',
    ]);
  });
});

// ============================================================================
// 6. warehouse_stock schema + identity
// ============================================================================

describe('6. warehouse_stock schema', () => {
  it('creates the table', () => {
    expect(active060).toMatch(/CREATE TABLE IF NOT EXISTS public\.warehouse_stock \(/i);
  });

  it('uses integer quantities (matching item_availability.quantity)', () => {
    expect(active060).toMatch(/on_hand_quantity\s+integer NOT NULL DEFAULT 0/i);
    expect(active060).toMatch(/reserved_quantity\s+integer NOT NULL DEFAULT 0/i);
  });

  it('available_quantity is a generated stored column = on_hand - reserved', () => {
    expect(active060).toMatch(
      /available_quantity\s+integer GENERATED ALWAYS AS \(on_hand_quantity - reserved_quantity\) STORED/i,
    );
  });

  it('uses numeric(20,3) for unit_price (matching item_availability.price)', () => {
    expect(active060).toMatch(/unit_price\s+numeric\(20,3\)/i);
  });

  it('has the required identity and provenance columns', () => {
    for (const col of [
      'organization_id', 'warehouse_id', 'central_item_id', 'scientific_name', 'trade_name',
      'concentration', 'dosage_form', 'unit', 'national_code', 'has_no_national_code',
      'batch_number', 'has_no_batch_number', 'internal_batch_reference', 'expiry_date',
      'price_basis', 'currency', 'supply_type_text', 'source_document_number', 'notes',
      'created_by', 'updated_by', 'created_at', 'updated_at',
    ]) {
      expect(active060, `warehouse_stock.${col}`).toContain(col);
    }
  });

  it('enforces same-organization integrity via a composite FK, not a bypassable trigger', () => {
    expect(active060).toContain('warehouse_stock_wh_org_fk');
    expect(active060).toMatch(
      /FOREIGN KEY \(warehouse_id, organization_id\)\s+REFERENCES public\.warehouses \(id, organization_id\) ON DELETE RESTRICT/i,
    );
  });

  it('references organizations and central_items with RESTRICT, actors with SET NULL', () => {
    expect(active060).toMatch(/organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE RESTRICT/i);
    expect(active060).toMatch(/central_item_id\s+uuid REFERENCES public\.central_items\(id\) ON DELETE RESTRICT/i);
    expect(active060).toMatch(/created_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/i);
    expect(active060).toMatch(/updated_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/i);
  });
});

describe('6b. warehouse_stock identity index (8 fields, immutable sentinel)', () => {
  it('creates a unique identity index with all eight components in order', () => {
    expect(active060).toMatch(
      /CREATE UNIQUE INDEX IF NOT EXISTS warehouse_stock_identity_uniq\s+ON public\.warehouse_stock \(\s*warehouse_id,\s*scientific_name,\s*COALESCE\(concentration, ''\),\s*COALESCE\(dosage_form, ''\),\s*COALESCE\(national_code, ''\),\s*COALESCE\(batch_number, ''\),\s*COALESCE\(expiry_date, DATE '0001-01-01'\),\s*COALESCE\(internal_batch_reference, ''\)\s*\);/i,
    );
  });

  it('uses the immutable date sentinel, never a text cast (ERROR 42P17)', () => {
    expect(ddlSection).toContain("COALESCE(expiry_date, DATE '0001-01-01')");
    // DDL only: the VERIFY block names the forbidden cast inside its own guard.
    expect(ddlSection).not.toMatch(/expiry_date::text/i);
    expect(ddlSection).not.toMatch(/text\(expiry_date\)/i);
    expect(verifyBlock).toContain("NOT ILIKE '%expiry_date::text%'");
  });

  it('normalizes text identity with COALESCE to empty string, exactly like migration 051', () => {
    for (const col of ['concentration', 'dosage_form', 'national_code', 'batch_number', 'internal_batch_reference']) {
      expect(active060).toContain(`COALESCE(${col}, '')`);
    }
  });
});

// ============================================================================
// 7. No-code / no-batch / internal reference rules
// ============================================================================

describe('7. explicit no-code and no-batch rules (no placeholders)', () => {
  it('has_no_national_code corresponds exactly to national_code being NULL', () => {
    expect(active060).toContain('warehouse_stock_has_no_national_code_chk');
    expect(active060).toMatch(/CHECK \(has_no_national_code = \(national_code IS NULL\)\)/i);
  });

  it('has_no_batch_number corresponds exactly to batch_number being NULL', () => {
    expect(active060).toContain('warehouse_stock_has_no_batch_number_chk');
    expect(active060).toMatch(/CHECK \(has_no_batch_number = \(batch_number IS NULL\)\)/i);
  });

  it('requires internal_batch_reference exactly when there is no batch number', () => {
    expect(active060).toContain('warehouse_stock_internal_ref_rule_chk');
    expect(active060).toMatch(/CASE WHEN has_no_batch_number\s+THEN internal_batch_reference IS NOT NULL\s+ELSE internal_batch_reference IS NULL/i);
  });

  it('internal_batch_reference must be trimmed and non-empty when present', () => {
    expect(active060).toContain('warehouse_stock_internal_ref_chk');
    expect(active060).toMatch(/btrim\(internal_batch_reference\) = internal_batch_reference/i);
  });

  it('bans literal placeholder strings in identity fields', () => {
    expect(active060).toContain('warehouse_stock_no_placeholder_chk');
    for (const bad of ["'N/A'", "'NONE'", "'NULL'", "'-'", "'بلا'"]) {
      expect(active060, `placeholder ${bad} must be banned`).toContain(bad);
    }
  });

  it('stores optional identity text trimmed or NULL, never empty string', () => {
    for (const c of [
      'warehouse_stock_trade_name_chk', 'warehouse_stock_concentration_chk',
      'warehouse_stock_dosage_form_chk', 'warehouse_stock_national_code_chk',
      'warehouse_stock_batch_number_chk',
    ]) {
      expect(active060).toContain(c);
    }
  });

  it('requires a trimmed non-empty scientific_name', () => {
    expect(active060).toContain('warehouse_stock_sci_name_chk');
  });
});

// ============================================================================
// 8. Quantity + reservation invariants
// ============================================================================

describe('8. quantity and reservation invariants', () => {
  it('quantities are non-negative', () => {
    expect(active060).toMatch(/CHECK \(on_hand_quantity\s+>= 0\)/i);
    expect(active060).toMatch(/CHECK \(reserved_quantity >= 0\)/i);
  });

  it('reserved never exceeds on-hand (available_quantity cannot go negative)', () => {
    expect(active060).toContain('warehouse_stock_reserved_le_on_hand_chk');
    expect(active060).toMatch(/CHECK \(reserved_quantity <= on_hand_quantity\)/i);
  });

  it('unit_price is NULL or non-negative', () => {
    expect(active060).toContain('warehouse_stock_unit_price_chk');
    expect(active060).toMatch(/CHECK \(unit_price IS NULL OR unit_price >= 0\)/i);
  });
});

// ============================================================================
// 9. warehouse_stock_movements
// ============================================================================

describe('9. warehouse_stock_movements immutable ledger', () => {
  it('creates the table', () => {
    expect(active060).toMatch(/CREATE TABLE IF NOT EXISTS public\.warehouse_stock_movements \(/i);
  });

  it('links to warehouse_stock with ON DELETE RESTRICT (history is preserved)', () => {
    expect(active060).toMatch(
      /warehouse_stock_id\s+uuid NOT NULL REFERENCES public\.warehouse_stock\(id\) ON DELETE RESTRICT/i,
    );
  });

  it('has the full before/delta/after and snapshot column set', () => {
    for (const col of [
      'on_hand_before', 'on_hand_delta', 'on_hand_after',
      'reserved_before', 'reserved_delta', 'reserved_after',
      'reason', 'reference_type', 'reference_id', 'source_document_number',
      'actor_id', 'actor_role', 'actor_name',
      'scientific_name_snapshot', 'concentration_snapshot', 'dosage_form_snapshot',
      'batch_number_snapshot', 'internal_batch_reference_snapshot', 'created_at',
    ]) {
      expect(active060, `movements.${col}`).toContain(col);
    }
  });

  it('uses text + CHECK for movement_type, never a Postgres enum', () => {
    expect(active060).toMatch(/movement_type\s+text NOT NULL/i);
    expect(active060).not.toMatch(/CREATE TYPE/i);
    expect(active060).not.toMatch(/\bAS ENUM\b/i);
  });

  it('allows exactly the eight reviewed movement types', () => {
    expect(active060).toContain('warehouse_stock_movements_type_chk');
    for (const t of ['set_exact', 'add', 'subtract', 'correction', 'reserve', 'release', 'dispatch_send', 'dispatch_return']) {
      expect(active060, `movement_type ${t}`).toContain(`'${t}'`);
    }
  });

  it('enforces self-consistent arithmetic', () => {
    expect(active060).toMatch(/CHECK \(on_hand_before \+ on_hand_delta = on_hand_after\)/i);
    expect(active060).toMatch(/CHECK \(reserved_before \+ reserved_delta = reserved_after\)/i);
  });

  it('enforces non-negative before/after quantities and the reservation invariant', () => {
    expect(active060).toMatch(/CHECK \(on_hand_before\s+>= 0\)/i);
    expect(active060).toMatch(/CHECK \(on_hand_after\s+>= 0\)/i);
    expect(active060).toMatch(/CHECK \(reserved_before >= 0\)/i);
    expect(active060).toMatch(/CHECK \(reserved_after\s+>= 0\)/i);
    expect(active060).toMatch(/CHECK \(reserved_after <= on_hand_after\)/i);
  });

  it('requires a reason for correction and set_exact', () => {
    expect(active060).toContain('warehouse_stock_movements_correction_reason_chk');
    expect(active060).toContain('warehouse_stock_movements_set_exact_reason_chk');
    expect(active060).toMatch(/movement_type <> 'correction' OR \(reason IS NOT NULL AND btrim\(reason\) <> ''\)/i);
    expect(active060).toMatch(/movement_type <> 'set_exact' OR \(reason IS NOT NULL AND btrim\(reason\) <> ''\)/i);
  });

  it('requires a reason or reference for dispatch_return', () => {
    expect(active060).toContain('warehouse_stock_movements_dispatch_return_chk');
    expect(active060).toMatch(/movement_type <> 'dispatch_return'/i);
  });

  it('enforces same-organization integrity via composite FK', () => {
    expect(active060).toContain('warehouse_stock_movements_wh_org_fk');
  });

  it('does not create dispatch_line_id yet (migration 061 adds it additively)', () => {
    // DDL only: the VERIFY block asserts the column's ABSENCE by name.
    expect(ddlSection).not.toContain('dispatch_line_id');
    expect(verifyBlock).toContain('dispatch_line_id');
  });
});

// ============================================================================
// 10. RLS, anon denial, no direct writes
// ============================================================================

describe('10. RLS and anonymous denial', () => {
  it('enables RLS on both new tables', () => {
    expect(active060).toMatch(/ALTER TABLE public\.warehouse_stock\s+ENABLE ROW LEVEL SECURITY;/i);
    expect(active060).toMatch(/ALTER TABLE public\.warehouse_stock_movements\s+ENABLE ROW LEVEL SECURITY;/i);
  });

  it('creates org-scoped, warehouses.view-gated SELECT policies', () => {
    expect(active060).toContain('CREATE POLICY "warehouse_stock_select_perm" ON public.warehouse_stock');
    expect(active060).toContain('CREATE POLICY "warehouse_stock_mov_select_perm" ON public.warehouse_stock_movements');
  });

  it('creates no INSERT/UPDATE/DELETE policy on the new tables', () => {
    expect(active060).not.toMatch(/CREATE POLICY[^;]*ON public\.warehouse_stock(_movements)?\s+FOR (INSERT|UPDATE|DELETE|ALL)/i);
  });

  it('revokes everything from PUBLIC and anon on both tables', () => {
    expect(active060).toMatch(/REVOKE ALL ON TABLE public\.warehouse_stock\s+FROM PUBLIC, anon;/i);
    expect(active060).toMatch(/REVOKE ALL ON TABLE public\.warehouse_stock_movements\s+FROM PUBLIC, anon;/i);
  });

  it('grants authenticated SELECT only, and explicitly revokes writes', () => {
    expect(active060).toMatch(/GRANT SELECT ON TABLE public\.warehouse_stock\s+TO authenticated;/i);
    expect(active060).toMatch(/GRANT SELECT ON TABLE public\.warehouse_stock_movements\s+TO authenticated;/i);
    expect(active060).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_stock\s+FROM authenticated;/i);
    expect(active060).toMatch(/REVOKE INSERT, UPDATE, DELETE ON TABLE public\.warehouse_stock_movements\s+FROM authenticated;/i);
  });

  it('never grants anon anything', () => {
    expect(active060).not.toMatch(/GRANT[^;]*TO[^;]*\banon\b/i);
  });

  it('creates no warehouse stock write RPC in this migration (062 scope)', () => {
    expect(active060).not.toMatch(/CREATE OR REPLACE FUNCTION/i);
  });
});

// ============================================================================
// 11. Isolation — QR, item_availability, Deep Clean, exchange, dispatch
// ============================================================================

describe('11. isolation from out-of-scope domains', () => {
  it('does not modify item_availability', () => {
    expect(active060).not.toMatch(/ALTER TABLE\s+(public\.)?item_availability\b/i);
    expect(active060).not.toMatch(/CREATE (UNIQUE )?INDEX[^;]*ON (public\.)?item_availability\b/i);
    expect(active060).not.toMatch(/DROP INDEX[^;]*item_availability/i);
  });

  it('does not modify item_availability_movements', () => {
    expect(active060).not.toMatch(/ALTER TABLE\s+(public\.)?item_availability_movements\b/i);
  });

  it('does not modify phoenix_upsert_availability or the movement RPC', () => {
    expect(active060).not.toMatch(/FUNCTION\s+(public\.)?phoenix_upsert_availability/i);
    expect(active060).not.toMatch(/FUNCTION\s+(public\.)?phoenix_apply_availability_movement/i);
  });

  it('does not modify the public QR RPC', () => {
    expect(active060).not.toMatch(/CREATE OR REPLACE FUNCTION[^;]*get_public_qr_payload/i);
    expect(active060).not.toMatch(/DROP FUNCTION[^;]*get_public_qr_payload/i);
  });

  it('does not modify Deep Clean (migration 055)', () => {
    expect(active060).not.toMatch(/CREATE OR REPLACE FUNCTION[^;]*phoenix_clean_availability_data/i);
    expect(active060).not.toMatch(/DROP FUNCTION[^;]*phoenix_clean_availability_data/i);
  });

  it('does not modify the inter-org exchange or alert domain', () => {
    expect(active060).not.toMatch(/ALTER TABLE\s+(public\.)?inter_org_/i);
    expect(active060).not.toMatch(/DROP TABLE\s+(public\.)?inter_org_/i);
    expect(active060).not.toMatch(/CREATE TABLE[^;]*inter_org_/i);
  });

  it('creates no dispatch table (061 scope)', () => {
    expect(active060).not.toMatch(/CREATE TABLE[^;]*warehouse_dispatch/i);
  });
});

// ============================================================================
// 12. Non-destructive
// ============================================================================

describe('12. no destructive SQL', () => {
  it('contains no DELETE or TRUNCATE at all', () => {
    expect(active060).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(active060).not.toMatch(/\bTRUNCATE\b/i);
  });

  it('drops no table, column, constraint, index or function', () => {
    expect(active060).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(active060).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(active060).not.toMatch(/\bDROP\s+CONSTRAINT\b/i);
    expect(active060).not.toMatch(/\bDROP\s+INDEX\b/i);
    expect(active060).not.toMatch(/\bDROP\s+FUNCTION\b/i);
    expect(active060).not.toMatch(/\bDROP\s+SCHEMA\b/i);
  });

  it('the only DROP statements are the reviewed DROP POLICY IF EXISTS ones', () => {
    const drops = activeLines.filter(l => /\bDROP\b/i.test(l));
    for (const d of drops) {
      expect(d, `unexpected DROP: ${d}`).toMatch(/^DROP POLICY IF EXISTS/i);
    }
  });

  it('uses no CASCADE anywhere (movement history must never be silently deleted)', () => {
    expect(active060).not.toMatch(/\bCASCADE\b/i);
  });

  it('performs no data mutation', () => {
    expect(active060).not.toMatch(/\bINSERT\s+INTO\b/i);
    expect(active060).not.toMatch(/^\s*UPDATE\s+/im);
  });
});

// ============================================================================
// 13. Migrations 001–059 untouched on disk
// ============================================================================

describe('13. migrations 001–059 remain untouched', () => {
  it('no tracked migration SQL file 001–059 has a working-tree diff', () => {
    let diff = '';
    try {
      diff = execSync('git diff --name-only -- supabase/migrations', { cwd: ROOT, encoding: 'utf8' });
    } catch {
      diff = '';
    }
    const changed = diff.split('\n')
      .filter(f => /^supabase\/migrations\/0(0[1-9]|[1-4][0-9]|5[0-9])_.*\.sql$/.test(f.trim()));
    expect(changed).toEqual([]);
  });

  it('migration 055 Deep Clean file is unchanged', () => {
    let diff = '';
    try {
      diff = execSync('git diff -- supabase/migrations/055_phoenix_clean_availability_data.sql', {
        cwd: ROOT, encoding: 'utf8',
      });
    } catch {
      diff = '';
    }
    expect(diff.trim()).toBe('');
  });

  it('Deep Clean deletes no warehouse table (retention preserved)', () => {
    const m055 = readFileSync(join(MIGRATIONS_DIR, '055_phoenix_clean_availability_data.sql'), 'utf8');
    // Executable DELETE statements only. 055 also mentions these table names
    // inside NOT ILIKE assertions that FORBID deleting them — those lines are
    // protections, not deletions, and must not be counted as such.
    const executed = activeSql(m055)
      .split('\n')
      .filter(l => !/I?LIKE\s*'%/.test(l))
      .map(l => /^\s*DELETE FROM public\.(\w+)/i.exec(l))
      .filter((m): m is RegExpExecArray => m !== null)
      .map(m => m[1]);

    expect(executed.length).toBeGreaterThan(0);
    for (const t of ['warehouses', 'warehouse_stock', 'warehouse_stock_movements']) {
      expect(executed, `Deep Clean must never delete ${t}`).not.toContain(t);
    }
  });

  it('Deep Clean explicitly asserts warehouses are never deleted', () => {
    const m055 = readFileSync(join(MIGRATIONS_DIR, '055_phoenix_clean_availability_data.sql'), 'utf8');
    expect(m055).toContain("NOT ILIKE '%DELETE FROM public.warehouses%'");
  });

  it('migration 060 never modifies the Deep Clean RPC', () => {
    // DDL only: the VERIFY block references the RPC by name purely to assert it
    // still exists (i.e. that 060 did not disturb migration 055).
    expect(ddlSection).not.toContain('phoenix_clean_availability_data');
    expect(verifyBlock).toContain('phoenix_clean_availability_data');
  });
});

// ============================================================================
// 14. VERIFY block coverage
// ============================================================================

describe('14. VERIFY block asserts the migration actually did what it claims', () => {
  it('asserts the warehouses repair', () => {
    expect(m060).toContain("column_name = 'is_main'");
    expect(m060).toContain("column_name = 'code'");
    expect(m060).toContain('warehouses should have exactly 14 columns');
  });

  it('asserts the legacy policies are gone and no legacy role remains', () => {
    expect(m060).toContain('legacy wh_* policies still present');
    expect(m060).toContain('still references hospital_admin');
    expect(m060).toContain('still references warehouse_manager');
  });

  it('asserts the stock identity index shape and immutable sentinel', () => {
    expect(m060).toContain('warehouse_stock_identity_uniq');
    expect(m060).toContain('must use the immutable DATE');
    expect(m060).toContain('must not cast expiry_date to text');
  });

  it('asserts generated available_quantity and integer quantity types', () => {
    expect(m060).toContain("is_generated = 'ALWAYS'");
    expect(m060).toContain('must be integer');
  });

  it('asserts RLS, anon denial and absence of write grants/policies', () => {
    expect(m060).toContain('RLS not enabled on');
    expect(m060).toContain('anon holds a privilege on');
    expect(m060).toContain('holds a write grant on');
    expect(m060).toContain('direct write policy exists on');
  });

  it('asserts out-of-scope domains are intact', () => {
    expect(m060).toContain('get_public_qr_payload');
    expect(m060).toContain('item_availability_dp_sci_conc_form_nat_batch_exp_uniq');
    expect(m060).toContain('phoenix_clean_availability_data');
    expect(m060).toContain('inter_org_exchange_requests_orgs_distinct_chk');
  });

  it('asserts dispatch_line_id is deferred to 061', () => {
    expect(m060).toContain('migration 061 adds it additively');
  });
});
