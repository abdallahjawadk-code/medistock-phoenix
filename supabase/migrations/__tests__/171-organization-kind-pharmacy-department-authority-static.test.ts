/**
 * 171 · ORGANIZATION KIND + PHARMACY DEPARTMENT AUTHORITY (Stage E · E7-1
 * follow-up) — static proof.
 *
 * Source-level guards: registration, exact object inventory (1 new column +
 * 2 new CHECK constraints + 1 dropped NOT NULL + 3 new functions + 3 new
 * triggers only), preflight/verify tokens, preserved 164 CHECK, preserved
 * 170 immutability trigger, concurrency lock presence in both new guard
 * functions, and NON-GOALS (no new table, no RPC redefinition, no RLS/
 * permission change, 001-170 untouched).
 *
 * Behavioural proof lives in the sibling *.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '171_phoenix_organization_kind_pharmacy_department_authority.sql';
const read = (f: string) =>
  readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n?/g, '\n');

const sql = read(NAME);
const code = sql.slice(sql.indexOf('begin;'), sql.indexOf('\ncommit;'));
const active = activeSql(code);
const exec = executableSql(code);

const kindImmutableFnBody = (() => {
  const src = sqlFunctionSource(code, '_phoenix_organizations_kind_immutable_v1');
  expect(src).not.toBeNull();
  return src as string;
})();

const warehouseGuardFnBody = (() => {
  const src = sqlFunctionSource(code, '_phoenix_warehouses_owner_kind_guard_v1');
  expect(src).not.toBeNull();
  return src as string;
})();

const distributionPointGuardFnBody = (() => {
  const src = sqlFunctionSource(code, '_phoenix_distribution_points_owner_kind_guard_v1');
  expect(src).not.toBeNull();
  return src as string;
})();

describe('1. 171 registration and shape', () => {
  it('is registered exactly once, immediately after 170', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('170_phoenix_organization_class_and_warehouse_facility_assignment.sql');
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('begin;');
    expect(sql).toContain('\ncommit;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
  });

  it('fails closed on preconditions and verifies in-transaction', () => {
    expect(active).toContain('PREFLIGHT FAILED (171)');
    expect(active).toContain('VERIFY FAILED (171)');
  });

  it('documents a manual rollback', () => {
    expect(sql).toMatch(/ROLLBACK \(manual/);
  });

  it('preflight requires 170 to have already applied institution_class SET NOT NULL', () => {
    expect(active).toMatch(/is_nullable INTO v_col_nullable/);
    expect(active).toContain('expected 170 to have applied');
  });
});

describe('2. object inventory is EXACTLY the 171 set', () => {
  it('creates no table', () => {
    expect(active).not.toMatch(/\bCREATE\s+TABLE\b/i);
  });

  it('adds exactly one column: organizations.organization_kind', () => {
    const addColumns = active.match(/\bADD\s+COLUMN\b/gi) ?? [];
    expect(addColumns.length).toBe(1);
    expect(active).toMatch(
      /ALTER TABLE public\.organizations\s*\n\s*ADD COLUMN organization_kind text NOT NULL DEFAULT 'care_institution'/,
    );
  });

  it('drops exactly the institution_class NOT NULL constraint, nothing else', () => {
    expect(active).toMatch(
      /ALTER TABLE public\.organizations\s*\n\s*ALTER COLUMN institution_class DROP NOT NULL/,
    );
    expect(active).not.toMatch(/DROP\s+COLUMN/i);
  });

  it('preserves the existing 164 3-value institution_class CHECK unchanged, byte-identical', () => {
    expect(active).not.toMatch(/DROP\s+CONSTRAINT\s+organizations_institution_class_chk/i);
    expect(active).not.toMatch(/ADD\s+CONSTRAINT\s+organizations_institution_class_chk/i);
    expect(active).toContain(
      "CHECK ((institution_class = ANY (ARRAY[''hospital''::text, ''specialized_center''::text, ''health_sector''::text])))",
    );
  });

  it('adds no permission key and no RLS policy change', () => {
    expect(exec).not.toMatch(/INSERT\s+INTO\s+public\.permission_keys/i);
    expect(exec).not.toMatch(/INSERT\s+INTO\s+public\.role_permission_defaults/i);
    expect(active).not.toMatch(/CREATE POLICY/);
    expect(active).not.toMatch(/ALTER POLICY/);
    expect(active).not.toMatch(/ENABLE ROW LEVEL SECURITY/);
  });

  it('creates exactly three new functions with exact signatures', () => {
    const creates = active.match(/\bCREATE\s+FUNCTION\b/gi) ?? [];
    expect(creates.length).toBe(3);
    expect(active).toContain('CREATE FUNCTION public._phoenix_organizations_kind_immutable_v1()');
    expect(active).toContain('CREATE FUNCTION public._phoenix_warehouses_owner_kind_guard_v1()');
    expect(active).toContain('CREATE FUNCTION public._phoenix_distribution_points_owner_kind_guard_v1()');
  });

  it('creates no CREATE OR REPLACE of any function — no RPC redefinition', () => {
    expect(active).not.toMatch(/CREATE\s+OR\s+REPLACE\s+FUNCTION/i);
  });

  it('creates exactly three triggers', () => {
    const triggerMatches = active.match(/\bCREATE\s+TRIGGER\b/gi) ?? [];
    expect(triggerMatches.length).toBe(3);
    expect(active).toMatch(
      /CREATE TRIGGER organizations_kind_immutable_trg\s*\n\s*BEFORE UPDATE OF organization_kind ON public\.organizations/,
    );
    expect(active).toMatch(
      /CREATE TRIGGER warehouses_owner_kind_guard_trg\s*\n\s*BEFORE INSERT OR UPDATE OF organization_id, warehouse_kind ON public\.warehouses/,
    );
    expect(active).toMatch(
      /CREATE TRIGGER distribution_points_owner_kind_guard_trg\s*\n\s*BEFORE INSERT OR UPDATE OF warehouse_id ON public\.distribution_points/,
    );
  });

  it('adds exactly two new CHECK constraints (organization_kind membership, and the kind/class conditional contract)', () => {
    expect(active).toContain('organizations_organization_kind_chk');
    expect(active).toContain('organizations_kind_institution_class_chk');
    expect(active).toMatch(/CHECK \(organization_kind IN \('care_institution', 'pharmacy_department_authority'\)\)/);
  });

  it('does not invent a fourth institution_class value or a sentinel', () => {
    expect(exec).not.toMatch(/'unclassified'|'pharmacy_department'|'authority'/);
  });
});

describe('3. organization_kind immutability trigger', () => {
  it('uses the exact deterministic error token', () => {
    expect(kindImmutableFnBody).toContain('organization_kind_immutable');
  });

  it('rejects only an ACTUAL value change — a same-value UPDATE is a harmless no-op', () => {
    expect(kindImmutableFnBody).toMatch(
      /NEW\.organization_kind IS DISTINCT FROM OLD\.organization_kind/,
    );
    // No OLD-IS-NOT-NULL precondition needed (unlike 170's institution_class
    // trigger): organization_kind is NOT NULL DEFAULT, so OLD is always set.
    expect(kindImmutableFnBody).not.toMatch(/OLD\.organization_kind IS NOT NULL/);
  });

  it('is a BEFORE UPDATE OF organization_kind trigger — never fires for updates that do not touch the column', () => {
    expect(active).toMatch(/BEFORE UPDATE OF organization_kind ON public\.organizations/);
  });
});

describe('4. warehouse owner-kind guard — one-way invariant + concurrency lock', () => {
  it('uses the exact deterministic error tokens', () => {
    expect(warehouseGuardFnBody).toContain('pharmacy_department_authority_requires_central_warehouse');
    expect(warehouseGuardFnBody).toContain('pharmacy_department_authority_warehouse_has_outlets');
  });

  it('imposes the one-way invariant only for pharmacy_department_authority — never restricts care_institution', () => {
    // Early-return form: anything that is NOT pharmacy_department_authority
    // (including care_institution, and an unresolved organization_id) is let
    // through untouched before either RAISE is ever reached.
    expect(warehouseGuardFnBody).toMatch(
      /IF v_owner_kind IS DISTINCT FROM 'pharmacy_department_authority' THEN\s*\n\s*RETURN NEW;/,
    );
    // No care_institution-conditioned rejection anywhere in this function.
    expect(warehouseGuardFnBody).not.toMatch(/care_institution.*RAISE|RAISE.*care_institution/s);
  });

  it('fires on INSERT and on UPDATE of organization_id or warehouse_kind', () => {
    expect(active).toMatch(
      /BEFORE INSERT OR UPDATE OF organization_id, warehouse_kind ON public\.warehouses/,
    );
  });

  it('the existing-outlets check runs only on UPDATE (reassignment), never on INSERT', () => {
    expect(warehouseGuardFnBody).toMatch(/IF TG_OP = 'UPDATE' THEN/);
  });

  it('upgrades its own row lock to FOR UPDATE before checking for existing distribution_points — the concurrency-safe technique', () => {
    expect(warehouseGuardFnBody).toMatch(
      /PERFORM 1 FROM public\.warehouses WHERE id = NEW\.id FOR UPDATE/,
    );
    // The existence check must textually follow the lock acquisition.
    const lockIdx = warehouseGuardFnBody.indexOf('FOR UPDATE');
    const existsIdx = warehouseGuardFnBody.indexOf('EXISTS (SELECT 1 FROM public.distribution_points');
    expect(lockIdx).toBeGreaterThan(-1);
    expect(existsIdx).toBeGreaterThan(lockIdx);
  });

  it('is a no-op when neither organization_id nor warehouse_kind actually changed', () => {
    expect(warehouseGuardFnBody).toMatch(
      /NEW\.organization_id IS NOT DISTINCT FROM OLD\.organization_id\s*\n\s*AND NEW\.warehouse_kind IS NOT DISTINCT FROM OLD\.warehouse_kind/,
    );
  });
});

describe('5. distribution_points owner-kind guard — concurrency lock', () => {
  it('uses the exact deterministic error token', () => {
    expect(distributionPointGuardFnBody).toContain('pharmacy_department_authority_warehouse_no_outlets');
  });

  it('fires on INSERT and on UPDATE of warehouse_id', () => {
    expect(active).toMatch(
      /BEFORE INSERT OR UPDATE OF warehouse_id ON public\.distribution_points/,
    );
  });

  it('takes FOR SHARE on the warehouse row as its own single-table statement — the lock that conflicts with the warehouse guard\'s FOR UPDATE', () => {
    expect(distributionPointGuardFnBody).toMatch(
      /FROM public\.warehouses WHERE id = NEW\.warehouse_id\s*\n\s*FOR SHARE/,
    );
  });

  it('is a no-op when warehouse_id did not actually change', () => {
    expect(distributionPointGuardFnBody).toMatch(
      /NEW\.warehouse_id IS NOT DISTINCT FROM OLD\.warehouse_id/,
    );
  });
});

describe('6. non-goals — nothing else changes', () => {
  it('does not redefine any Migration 077 function', () => {
    expect(active).not.toMatch(/phoenix_assert_direct_supply_endpoints/);
    expect(active).not.toMatch(/phoenix_create_direct_warehouse_transfer_request/);
  });

  it('does not touch Migration 164 facility RPCs or the composite FK', () => {
    expect(active).not.toMatch(/phoenix_upsert_organization_facility/);
    expect(active).not.toMatch(/of_parent_class_fk/);
  });

  it('does not touch supply_type/purchase_origin provenance (088)', () => {
    expect(active).not.toMatch(/supply_type|purchase_origin/);
  });

  it('leaves 170\'s own institution_class immutability trigger untouched (proven by VERIFY re-checking it exists)', () => {
    expect(active).toContain('organizations_institution_class_immutable_trg');
    expect(active).not.toMatch(/DROP\s+TRIGGER\s+organizations_institution_class_immutable_trg/i);
  });
});
