/**
 * 183 · EMERGENCY OUTLET INTEGRITY (R1.2C) — static proof.
 *
 * Source-level guards that need no database: registration, the exact object
 * inventory, the security posture of the new validator, and — the reason this
 * file is weighted the way it is — the STRUCTURAL claims that a behavioural
 * suite cannot make.
 *
 * A dynamic test can prove that an illegal outlet is refused today. It cannot
 * prove WHY that refusal will still be correct after the next migration: that
 * the matrix has exactly ONE author, that exactly ONE trigger runs it, and that
 * no future developer can quietly add a second overlapping BEFORE trigger whose
 * relative order then decides which rule wins. Those are the assertions here.
 *
 * Behavioural proof (the reachable matrix, initial provisioning, 168 parity)
 * lives in the sibling *.dynamic.test.ts and *-parity.dynamic.test.ts.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';
import { activeSql, executableSql, sqlFunctionSource } from './helpers/sql-source';

const ROOT = join(__dirname, '../../../');
const NAME = '183_phoenix_emergency_outlet_integrity.sql';
const read = (f: string) =>
  readFileSync(join(ROOT, 'supabase/migrations', f), 'utf8').replace(/\r\n?/g, '\n');

const sql = read(NAME);
const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;'));

/** Statements that run at apply time (function bodies / DO blocks stripped). */
const applyTime = code.replace(/\$([a-z_]*)\$[\s\S]*?\$\1\$/g, '\n/* body removed */\n');
/** Comments removed — absence claims must read code, not documentation. */
const bare = activeSql(code);
const applyBare = activeSql(applyTime);
/**
 * Comments removed AND string literals blanked. Required for NEGATIVE
 * assertions: 183's own VERIFY block deliberately NAMES the tables and the
 * matrix vocabulary it forbids, so reading `bare` would make those guards match
 * the guard itself rather than the schema.
 */
const executable = executableSql(code);

const fn = (name: string) => {
  const src = sqlFunctionSource(sql, name);
  expect(src, `function not found: ${name}`).toBeTruthy();
  return src!;
};

const VALIDATOR = 'phoenix_assert_active_outlet_topology_v1';
const POINT_ENTRY = 'phoenix_assert_outlet_topology_for_point_v1';
const DELEGATE = '_phoenix_health_sector_outlet_topology_guard_v1';
const TRIGGER = 'distribution_points_health_sector_topology_trg';

// ════════════════════════════════════════════════════════════════════════════
// 1. REGISTRATION
// ════════════════════════════════════════════════════════════════════════════
describe('183 registration and shape', () => {
  it('exists exactly once in the registry, immediately after 182', () => {
    expect(REVIEWED_MIGRATION_FILES.filter(f => f === NAME)).toEqual([NAME]);
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(i).toBeGreaterThan(0);
    expect(REVIEWED_MIGRATION_FILES[i - 1])
      .toBe('182_phoenix_health_center_facility_scoped_rbac.sql');
  });

  it('is followed by exactly 184 then 185, and nothing beyond them', () => {
    // R1.5: 185 appended. The successor list stays EXACT and the nothing-beyond
    // regex is narrowed by exactly one number (185 -> 186), so this guard still
    // fails closed on any unreviewed migration — in particular there is
    // deliberately no 186.
    const SUCCESSORS = [
      '184_phoenix_canonical_supply_cycle.sql',
      '185_phoenix_return_quarantine_recall_parity.sql',
    ];
    const i = REVIEWED_MIGRATION_FILES.indexOf(NAME);
    expect(REVIEWED_MIGRATION_FILES.slice(i + 1)).toEqual(SUCCESSORS);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1])
      .toBe(SUCCESSORS[SUCCESSORS.length - 1]);
    expect(REVIEWED_MIGRATION_FILES.some(f => /^18[6-9]_|^19\d_|^[2-9]\d\d_/.test(f))).toBe(false);
  });

  it('is a single transaction, manual-apply only', () => {
    expect(sql).toContain('BEGIN;');
    expect(sql).toContain('\nCOMMIT;');
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/DO NOT use `supabase db push`/);
    expect([...sql.matchAll(/^BEGIN;$/gm)].length).toBe(1);
    expect([...sql.matchAll(/^COMMIT;$/gm)].length).toBe(1);
  });

  it('carries no Production identity — no UUID literal at all', () => {
    const uuids = bare.match(/'[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}'/gi) ?? [];
    expect(uuids).toEqual([]);
  });

  it('documents a manual rollback for every object it introduces or replaces', () => {
    const rollback = sql.slice(sql.indexOf('-- ROLLBACK (manual)'));
    for (const object of [DELEGATE, POINT_ENTRY, VALIDATOR,
                          'phoenix_create_initial_provisioning_dispatch']) {
      expect(rollback, object).toContain(object);
    }
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 2. PREREQUISITES — 183 refuses to apply onto a drifted chain
// ════════════════════════════════════════════════════════════════════════════
describe('183 fails closed on its prerequisites', () => {
  const preflight = () => {
    const a = bare.indexOf('DO $preflight$');
    const b = bare.indexOf('$preflight$;', a);
    expect(a, 'the preflight block must exist').toBeGreaterThan(-1);
    return bare.slice(a, b);
  };

  /** The pre-existing-ACTIVE-row scan (B2), which lives after the validator. */
  const preexisting = () => {
    const a = bare.indexOf('DO $preexisting$');
    const b = bare.indexOf('$preexisting$;', a);
    expect(a, 'the pre-existing-row scan must exist').toBeGreaterThan(-1);
    return bare.slice(a, b);
  };

  it('requires the 180, 181 and 182 objects it builds on', () => {
    for (const required of [
      'phoenix_create_initial_provisioning_dispatch',   // 180
      '_phoenix_180_delegate_create_warehouse_dispatch', // 180
      'phoenix_replenish_emergency_outlet',              // 168/180
      '_phoenix_health_sector_outlet_topology_guard_v1', // 181
      'phoenix_profile_has_facility_assignment',         // 182
    ]) expect(preflight(), required).toContain(required);
    expect(preflight()).toContain('PREREQUISITE FAILED (183)');
    expect(preflight()).toContain('180/181/182 must be applied first');
  });

  it('requires the exact columns the matrix is expressed in', () => {
    expect(preflight()).toContain('clinical_location_kind');
    expect(preflight()).toContain('organization_kind');
  });

  it('refuses to apply over an ACTIVE row the new matrix would reject', () => {
    // 183 repairs nothing. If Production already holds a violating ACTIVE
    // outlet, applying must STOP with identifying context rather than rewrite
    // somebody's operational row.
    //
    // R1.2C corrective (B2): this scan no longer lives in the $preflight$
    // block. It used to, and it re-stated part of the matrix by hand to do it —
    // which is exactly how it came to miss the two invariants 183 itself adds
    // (emergency_outlet_requires_owning_warehouse and
    // emergency_outlet_requires_active_warehouse), letting 183 install cleanly
    // over rows its own validator calls illegal. It now runs AFTER the
    // validator is created, in the same transaction, and asks THAT validator.
    expect(preexisting()).toContain('an ACTIVE outlet already violates the emergency topology matrix');
    expect(preexisting()).toContain("status = 'active'");
    expect(preexisting()).toContain('this migration never rewrites operational data');
  });

  it('the pre-existing scan routes every active row through THE validator', () => {
    expect(preexisting()).toContain(VALIDATOR);
    expect(preexisting()).toContain('PREREQUISITE FAILED (183)');
    // It must report the row, or the operator cannot act on the refusal.
    for (const field of ['distribution_point', 'type=', 'warehouse=', 'context='])
      expect(preexisting(), field).toContain(field);
  });

  it('the pre-existing scan states NO rule of its own — one author, not two', () => {
    // The defect B2 fixed was a SECOND hand-written copy of the matrix. If this
    // vocabulary reappears here, the second author is back and will drift from
    // the validator again exactly as it did before.
    //
    // The three governed POINT TYPES are excluded from this list on purpose:
    // the scan names them to bound its DOMAIN (the modern outlet regime, the
    // same set outlet_stock's CHECK uses), which is a scoping decision, not a
    // rule. No owner class, no organization kind and no clinical context —
    // every actual rule — may appear.
    for (const vocab of [
      'institution_class', 'organization_kind', 'is_main', 'facility_id',
      'pharmacy_department_authority', 'non_emergency', 'health_sector',
    ]) expect(preexisting(), vocab).not.toContain(vocab);
  });

  it('the scan bounds its domain to the modern outlet regime, explicitly', () => {
    expect(preexisting()).toContain("point_type IN ('pharmacy', 'crash_cabinet', 'rescue_cart')");
  });

  it('the scan runs after the validator exists, and inside the one transaction', () => {
    // Ordering is what makes a single authority possible; the single
    // transaction is what makes a late failure safe. `code` is by construction
    // the slice BETWEEN `BEGIN;` and `COMMIT;`, so finding the scan inside it
    // is the proof that a failure there rolls the whole migration back.
    expect(bare.indexOf('DO $preexisting$'))
      .toBeGreaterThan(bare.indexOf(`CREATE FUNCTION public.${VALIDATOR}`));
    expect(code).toContain('DO $preexisting$');
    expect(sql).toMatch(/^BEGIN;$/m);
    expect(sql).toMatch(/^COMMIT;$/m);
  });

  it('verifies in-transaction, so a failed check rolls the whole migration back', () => {
    expect(code).toContain('VERIFY FAILED (183)');
    expect(code).toContain('DO $verify$');
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 3. OBJECT INVENTORY — exactly two new functions, two forward replacements
// ════════════════════════════════════════════════════════════════════════════
describe('183 object inventory is exactly the topology set', () => {
  it('creates exactly the canonical validator and its point-addressed entry', () => {
    const created = [...bare.matchAll(/CREATE FUNCTION (public\.[a-z_0-9]+)/g)].map(m => m[1]).sort();
    expect(created).toEqual([`public.${VALIDATOR}`, `public.${POINT_ENTRY}`].sort());
  });

  it('forward-replaces exactly 181s two guards and the 180 provisioning entry point', () => {
    // R1.2C corrective (B1): the WAREHOUSE guard is forward-replaced too.
    // 'an active emergency outlet has an active owning warehouse' is a claim
    // about two rows, so guarding only distribution_points left the parent free
    // to be deactivated underneath it. 181's file is still not edited and
    // neither trigger OBJECT is touched — only the two function bodies.
    const replaced = [...bare.matchAll(/CREATE OR REPLACE FUNCTION (public\.[a-z_0-9]+)/g)]
      .map(m => m[1]).sort();
    expect(replaced).toEqual([
      `public.${DELEGATE}`,
      'public._phoenix_health_sector_warehouse_shape_guard_v1',
      'public.phoenix_create_initial_provisioning_dispatch',
    ].sort());
  });

  it('the warehouse guard closes the deactivation path for every class', () => {
    const a = bare.indexOf('CREATE OR REPLACE FUNCTION public._phoenix_health_sector_warehouse_shape_guard_v1');
    const body = bare.slice(a, bare.indexOf('$$;', a));
    // 181's health-sector contract survives verbatim and is NOT narrowed…
    expect(body).toContain('health_center_depot_deactivation_blocked_by_active_outlet');
    // …and the class that 181 returned early on is now covered.
    expect(body).toContain('emergency_outlet_warehouse_deactivation_blocked_by_active_outlet');
    // The dependency check must sit AHEAD of the early return, or the new
    // branch is dead code and the bypass silently reopens.
    expect(body.indexOf('emergency_outlet_warehouse_deactivation_blocked_by_active_outlet'))
      .toBeLessThan(body.indexOf("IF v_class IS DISTINCT FROM 'health_sector' THEN"));
    // Only a genuinely stranding dependency blocks a non-health-sector
    // deactivation — a pharmacy is legal with no warehouse at all.
    expect(body).toContain("dp.point_type IN ('crash_cabinet', 'rescue_cart')");
  });

  it('creates NO trigger, table, column, constraint, index, policy, type or sequence', () => {
    expect(applyBare).not.toMatch(/\bCREATE\s+(CONSTRAINT\s+)?TRIGGER\b/i);
    expect(applyBare).not.toMatch(/\bCREATE\s+(TABLE|SEQUENCE|TYPE|POLICY|VIEW|MATERIALIZED|UNIQUE\s+INDEX|INDEX)\b/i);
    expect(applyBare).not.toMatch(/\bALTER\s+TABLE\b/i);
    expect(applyBare).not.toMatch(/\bADD\s+(COLUMN|CONSTRAINT)\b/i);
  });

  it('drops nothing', () => {
    expect(executable).not.toMatch(/\bDROP\s+(TABLE|COLUMN|CONSTRAINT|INDEX|FUNCTION|POLICY|TRIGGER)\b/i);
  });

  it('writes no row and moves no stock — it is a boundary, not a repair', () => {
    expect(executable).not.toMatch(/INSERT INTO public\.(warehouse|outlet)_stock/i);
    expect(executable).not.toMatch(/UPDATE public\.(warehouse|outlet)_stock/i);
    expect(executable).not.toMatch(/(INSERT INTO|UPDATE|DELETE FROM)\s+public\.distribution_points/i);
    expect(executable).not.toMatch(/\bTRUNCATE\b/i);
    // The only DML anywhere is 180's own audit INSERT, preserved verbatim
    // inside the forward-replaced provisioning body.
    const dml = [...executable.matchAll(/INSERT INTO public\.([a-z_]+)/gi)].map(m => m[1]);
    expect([...new Set(dml)]).toEqual(['audit_logs']);
  });

  it('does NOT make warehouse_id globally NOT NULL', () => {
    // 021 left it nullable and 181 preserved that. 183 narrows it for the two
    // EMERGENCY point types only, inside the validator — never as a column DDL.
    expect(applyBare).not.toMatch(/ALTER\s+COLUMN\s+warehouse_id/i);
    expect(applyBare).not.toMatch(/SET\s+NOT\s+NULL/i);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE CANONICAL VALIDATOR
// ════════════════════════════════════════════════════════════════════════════
describe('183 the canonical active-outlet topology validator', () => {
  const validator = () => fn(VALIDATOR);

  it('exists at exactly one signature and returns void', () => {
    expect([...bare.matchAll(new RegExp(`CREATE FUNCTION public\\.${VALIDATOR}`, 'g'))]).toHaveLength(1);
    expect(validator()).toMatch(/RETURNS void/);
  });

  it('is SECURITY DEFINER with a hardened, pinned search_path', () => {
    expect(validator()).toContain('SECURITY DEFINER');
    expect(validator()).toMatch(/SET search_path = public, pg_temp/);
    // The in-transaction VERIFY re-proves it against the catalogue, not the file.
    expect(code).toContain("proconfig @> ARRAY['search_path=public, pg_temp']");
    expect(code).toContain('p.prosecdef');
  });

  it('is REVOKED from every client-presentable role — an invariant, not an API', () => {
    for (const f of [
      `${VALIDATOR}(uuid, uuid, text, text)`,
      `${POINT_ENTRY}(uuid)`,
    ]) {
      expect(code, f).toContain(`REVOKE ALL ON FUNCTION public.${f}\n  FROM PUBLIC, anon, authenticated;`);
    }
    // …and it is never granted back anywhere in the migration.
    expect(bare).not.toMatch(new RegExp(`GRANT[\\s\\S]{0,120}${VALIDATOR}`));
    expect(bare).not.toMatch(new RegExp(`GRANT[\\s\\S]{0,120}${POINT_ENTRY}`));
    // The VERIFY block re-proves unreachability from the catalogue.
    expect(code).toContain("has_function_privilege('authenticated'");
    expect(code).toContain("has_function_privilege('anon'");
    expect(code).toContain('the topology validator is reachable by a client role');
  });

  it('re-resolves the owner from the CATALOGUE — a caller cannot assert its class', () => {
    const v = validator();
    // The owning organization is the WAREHOUSE's when one is named; only a
    // warehouse-less outlet answers with its own organization_id.
    expect(v).toMatch(/IF p_warehouse_id IS NOT NULL THEN[\s\S]*v_owner_org := v_wh\.organization_id;/);
    expect(v).toMatch(/ELSE\s*\n\s*v_owner_org := p_organization_id;/);
    // kind and class are SELECTed, never taken as arguments.
    expect(v).toContain('SELECT o.organization_kind, o.institution_class INTO v_kind, v_class');
    expect(v).toContain('WHERE o.id = v_owner_org');
    const args = v.slice(0, v.indexOf('RETURNS void'));
    expect(args).not.toMatch(/institution_class|organization_kind/);
  });

  it('takes 181s lock order unchanged — warehouse FOR SHARE, then the org fence', () => {
    const v = validator();
    expect(v).toContain('FROM public.warehouses WHERE id = p_warehouse_id FOR SHARE');
    expect(v).toMatch(/FROM public\.organizations o[\s\S]*ORDER BY o\.id FOR SHARE/);
    expect(v).toContain('ARRAY[p_organization_id, v_owner_org]');
    expect(v.indexOf('public.warehouses')).toBeLessThan(v.indexOf('public.organizations'));
  });

  it('A · a pharmacy department authority holds no active outlet, warehouse or not', () => {
    const v = validator();
    expect(v).toContain('pharmacy_department_authority_outlet_not_permitted');
    // Keyed on the ORGANISATION KIND, so the NULL-warehouse shape 171s
    // warehouse-derived guard never sees is covered by construction.
    expect(v).toMatch(/IF v_kind = 'pharmacy_department_authority' THEN/);
    expect(v.indexOf("v_kind = 'pharmacy_department_authority'"))
      .toBeLessThan(v.indexOf("v_class = 'health_sector'"));
  });

  it('B · restates 181s health-sector rules with 181s error names verbatim', () => {
    const v = validator();
    for (const e of [
      'health_sector_outlet_requires_health_center_depot',
      'health_sector_outlet_requires_active_health_center_depot',
      'health_center_rescue_cart_not_permitted',
      'health_center_outlet_type_not_permitted',
      'health_center_crash_cabinet_requires_emergency_context',
    ]) expect(v, e).toContain(e);
    // Byte-identical to Migration 181's own file, so no error contract moves.
    const m181 = read('181_phoenix_health_sector_topology_reconciliation.sql');
    const g181 = sqlFunctionSource(m181, DELEGATE)!;
    for (const e of [
      'health_sector_outlet_requires_health_center_depot',
      'health_sector_outlet_requires_active_health_center_depot',
      'health_center_rescue_cart_not_permitted',
      'health_center_crash_cabinet_requires_emergency_context',
    ]) expect(g181, `181 must already raise ${e}`).toContain(e);
  });

  it('C · hospital and specialized centre — the branch 181 returned early on', () => {
    const v = validator();
    expect(v).toContain("IF v_class IN ('hospital', 'specialized_center') THEN");
    // A pharmacy carries no clinical-context requirement and keeps 021's
    // nullable-warehouse freedom.
    expect(v).toMatch(/IF p_point_type = 'pharmacy' THEN\s*\n\s*RETURN;/);
    // Both EMERGENCY types must name an owning, ACTIVE warehouse.
    expect(v).toContain('emergency_outlet_requires_owning_warehouse');
    expect(v).toContain('emergency_outlet_requires_active_warehouse');
    // The inversion relative to a health centre.
    expect(v).toContain('crash_cabinet_requires_non_emergency_context');
    expect(v).toContain('rescue_cart_requires_emergency_context');
    expect(v).toContain('specialized_center_rescue_cart_not_permitted');
    expect(v).toContain('outlet_type_not_permitted_for_institution_class');
  });

  it('C · the crash/rescue context requirement is asserted, never merely defaulted', () => {
    const v = validator();
    // IS DISTINCT FROM, so a NULL context is refused exactly like a wrong one —
    // the defect a plain `<>` would leave open.
    expect(v).toMatch(/p_point_type = 'crash_cabinet'\s*\n?\s*AND p_clinical_location_kind IS DISTINCT FROM 'non_emergency'/);
    expect(v).toMatch(/p_clinical_location_kind IS DISTINCT FROM 'emergency'/);
  });

  it('D · an unrecognised owner class FAILS CLOSED rather than returning', () => {
    const v = validator();
    expect(v).toContain('outlet_owner_institution_class_unsupported');
    // The last statement of the body is the refusal — there is no trailing
    // RETURN that would reinstate 181's early-return defect for a class added
    // later without revisiting this matrix.
    const tail = v.slice(v.lastIndexOf('RETURN;'));
    expect(tail).toContain('outlet_owner_institution_class_unsupported');
    expect(v.lastIndexOf('outlet_owner_institution_class_unsupported'))
      .toBeGreaterThan(v.lastIndexOf('RETURN;'));
  });

  it('the point-addressed entry re-reads the outlet as it is NOW', () => {
    const p = fn(POINT_ENTRY);
    expect(p).toContain('SELECT * INTO v_dp FROM public.distribution_points WHERE id = p_distribution_point_id');
    expect(p).toContain('distribution_point_not_found');
    expect(p).toContain(
      `PERFORM public.${VALIDATOR}(\n    v_dp.organization_id, v_dp.warehouse_id, v_dp.point_type, v_dp.clinical_location_kind)`,
    );
    expect(p).toContain('SECURITY DEFINER');
    expect(p).toMatch(/SET search_path = public, pg_temp/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 5. ONE TRIGGER, ONE MATRIX — the structural claims
// ════════════════════════════════════════════════════════════════════════════
describe('183 the distribution_points write boundary is ONE hook', () => {
  const delegate = () => fn(DELEGATE);

  it('adds NO trigger of its own — 181s trigger OBJECT is reused unchanged', () => {
    expect(applyBare).not.toMatch(/\bCREATE\s+(CONSTRAINT\s+)?TRIGGER\b/i);
    expect(executable).not.toMatch(/\bDROP\s+TRIGGER\b/i);
    expect(executable).not.toMatch(/\bALTER\s+TRIGGER\b/i);
    // Only the FUNCTION behind it is forward replaced.
    expect(bare).toContain(`CREATE OR REPLACE FUNCTION public.${DELEGATE}()`);
  });

  it('the 181 trigger keeps its name and all five topology columns', () => {
    expect(code).toContain(`t.tgname='${TRIGGER}'`);
    expect(code).toContain(
      "att.attname IN ('warehouse_id','organization_id','point_type','clinical_location_kind','status')",
    );
    expect(code).toContain('the topology trigger does not watch all five topology columns');
    // …and the migration verifies the object still exists at all.
    expect(code).toContain("Migration 181''s distribution_points topology trigger is missing");
  });

  /**
   * THE STRUCTURAL REGRESSION GUARD.
   *
   * An earlier draft of 183 added a SECOND BEFORE trigger, named to sort ahead
   * of 181's. That makes correctness depend on trigger-name collation and gives
   * one rule two runtime authors. The migration now refuses that shape outright
   * — including a future re-addition by somebody else — and this test proves the
   * refusal is present, counted exactly, and phrased so widening it is visible.
   */
  it('REGRESSION GUARD · a SECOND overlapping topology trigger is refused outright', () => {
    const v = code.slice(code.indexOf('DO $verify$'));
    expect(v).toContain("pg_get_triggerdef(t.oid) ILIKE '%topology%'");
    expect(v).toContain('NOT t.tgisinternal');
    expect(v).toContain("c.relname='distribution_points'");
    // EXACTLY one — not "at least one", which a second trigger would satisfy.
    expect(v).toMatch(/IF v_bad <> 1 THEN[\s\S]{0,240}expected exactly one distribution_points topology trigger/);
    expect(v).toContain('two overlapping BEFORE triggers reintroduce order coupling');
  });

  it('the one trigger delegates to THE canonical validator', () => {
    expect(delegate()).toContain(`PERFORM public.${VALIDATOR}(`);
    expect(delegate()).toContain(
      'NEW.organization_id, NEW.warehouse_id, NEW.point_type, NEW.clinical_location_kind',
    );
    // Re-proved from the catalogue at apply time, not just from this file.
    expect(code).toContain(`position('${VALIDATOR}' in v_def) = 0`);
    expect(code).toContain('no longer delegates to the canonical validator');
  });

  it('the delegate is THIN — it restates no matrix vocabulary of its own', () => {
    // BODY only. The function keeps its historical NAME (which contains
    // "health_sector") so 181's trigger need not be recreated, so the claim
    // here is about what the body decides, never about what it is called.
    const whole = activeSql(delegate());
    const body = whole.slice(whole.indexOf('AS $$'));
    expect(body, 'the delegate body must be locatable').toContain('BEGIN');
    for (const vocabulary of [
      'rescue_cart', 'crash_cabinet', 'pharmacy',
      'institution_class', 'organization_kind',
      'hospital', 'specialized_center', 'health_sector',
      'emergency', 'facility_id', 'warehouses', 'organizations',
    ]) expect(body, `the delegate must not mention ${vocabulary}`).not.toContain(vocabulary);
    // Its whole body is: skip non-active rows, delegate, return.
    expect(body).toContain("IF NEW.status IS DISTINCT FROM 'active' THEN");
    expect([...body.matchAll(/RAISE EXCEPTION/g)]).toHaveLength(0);
    // …and the migration itself refuses a fattened delegate at apply time.
    expect(code).toContain('the topology trigger function restates matrix vocabulary');
    expect(code).toContain('the matrix must have exactly one author');
  });

  it('history is preserved — only transitions INTO an active state are judged', () => {
    const d = delegate();
    expect(d.indexOf("NEW.status IS DISTINCT FROM 'active'"))
      .toBeLessThan(d.indexOf(`PERFORM public.${VALIDATOR}`));
    expect(d).toMatch(/IF NEW\.status IS DISTINCT FROM 'active' THEN\s*\n\s*RETURN NEW;/);
  });

  it('keeps the delegates SECURITY DEFINER and pinned search_path', () => {
    expect(delegate()).toContain('SECURITY DEFINER');
    expect(delegate()).toMatch(/SET search_path = public, pg_temp/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 6. INITIAL PROVISIONING RECHECK
// ════════════════════════════════════════════════════════════════════════════
describe('183 initial provisioning revalidates topology before it writes', () => {
  const rpc = () => fn('phoenix_create_initial_provisioning_dispatch');

  it('asserts the destinations CURRENT topology as its first statement', () => {
    const r = rpc();
    const body = r.slice(r.indexOf('BEGIN'));
    expect(body).toContain(`PERFORM public.${POINT_ENTRY}(p_destination_distribution_point_id)`);
    // …point-addressed, so a legally-created outlet that has since been rehomed
    // or retyped is judged as it is NOW, not as it was.
    expect(body).not.toContain(`PERFORM public.${VALIDATOR}(p_`);
  });

  it('runs BEFORE the delegate, so a denial writes nothing at all', () => {
    const r = rpc();
    expect(r.indexOf(POINT_ENTRY)).toBeGreaterThan(-1);
    expect(r.indexOf(POINT_ENTRY))
      .toBeLessThan(r.indexOf('_phoenix_180_delegate_create_warehouse_dispatch'));
    expect(r.indexOf(POINT_ENTRY)).toBeLessThan(r.indexOf('INSERT INTO public.audit_logs'));
    expect(r.indexOf(POINT_ENTRY)).toBeLessThan(r.indexOf('UPDATE public.warehouse_dispatches'));
    // Re-proved at apply time from the catalogue.
    expect(code).toContain('initial provisioning does not re-validate topology before creating the dispatch');
  });

  it('preserves Migration 180s contract verbatim — literal, one-shot, audit, shape', () => {
    const r = rpc();
    expect(r).toContain("'initial'");
    expect(r).toContain('is_initial_provisioning');
    expect(r).toContain('initial_provisioning_already_exists_for_outlet');
    expect(r).toContain('warehouse_dispatch.initial_provisioning_created');
    expect(r).toContain('active_profile_required');
    // The authority literal is chosen HERE and derived from no argument.
    expect(r).not.toMatch(/p_authority|p_mode|p_is_initial/);
    // Same signature as 180 — a forward replacement, never a new overload.
    expect(r).toMatch(
      /phoenix_create_initial_provisioning_dispatch\(\s*p_warehouse_id uuid,\s*p_destination_distribution_point_id uuid,\s*p_dispatch_number text,\s*p_document_number text DEFAULT NULL,\s*p_default_currency text DEFAULT NULL,\s*p_notes text DEFAULT NULL\s*\)/,
    );
    expect(code).toContain('the initial-provisioning contract from Migration 180 was not preserved');
  });

  it('leaves the ordinary dispatch writer and the replenishment RPC untouched', () => {
    // A second author of the same rule is the risk, not the fix: 168/180
    // already enforce this matrix at run time and are not rewritten here.
    expect(bare).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_replenish_emergency_outlet/);
    expect(bare).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\.phoenix_create_warehouse_dispatch/);
    expect(bare).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\._phoenix_180_delegate/);
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 7. MIGRATION 181's FILE IS NOT EDITED
// ════════════════════════════════════════════════════════════════════════════
describe('183 forward-replaces 181 without editing its file', () => {
  const m181 = read('181_phoenix_health_sector_topology_reconciliation.sql');

  it('181 still declares the guard itself, with its own inline matrix', () => {
    // A plain CREATE FUNCTION (not OR REPLACE) — 181 is the original author.
    expect(m181).toContain(`CREATE FUNCTION public.${DELEGATE}()`);
    const g = sqlFunctionSource(m181, DELEGATE)!;
    expect(g).toContain('rescue_cart');
    expect(g).toContain('crash_cabinet');
    expect(g).toContain("institution_class");
  });

  it('181 knows nothing of 183 — no forward reference was back-patched into it', () => {
    expect(m181).not.toContain(VALIDATOR);
    expect(m181).not.toContain(POINT_ENTRY);
    expect(m181).not.toContain('183');
  });

  it('181 still creates the trigger OBJECT 183 reuses', () => {
    expect(m181).toMatch(new RegExp(`CREATE TRIGGER ${TRIGGER}`));
    expect(m181).toMatch(
      /BEFORE INSERT OR UPDATE OF warehouse_id, organization_id, point_type, clinical_location_kind, status\s*\n\s*ON public\.distribution_points/,
    );
  });

  it('183 documents that the replacement is forward-only and reversible', () => {
    expect(sql).toContain('re-run Migration\n--      181');
    expect(sql).toContain("Migration 181's FILE is not edited");
  });
});

// ════════════════════════════════════════════════════════════════════════════
// 8. NON-GOALS
// ════════════════════════════════════════════════════════════════════════════
describe('183 NON-GOALS', () => {
  it('stores the matrix in NO table — one function is the only author', () => {
    for (const t of ['outlet_topology_matrix', 'emergency_outlet_matrix',
                     'distribution_point_rules', 'outlet_stock_v2']) {
      // Named only inside the VERIFY block that asserts their ABSENCE, so the
      // apply-time DDL must not mention them at all.
      expect(applyBare, t).not.toContain(t);
    }
    expect(code).toContain('a matrix or stock table was created');
    expect(code).toContain('the matrix belongs in one function, not a table');
  });

  it('creates no third stock truth and no unit domain', () => {
    for (const t of ['unit_stock', 'health_center_unit', 'pharmacy_stock',
                     'rescue_cart_stock', 'crash_cabinet_stock']) {
      expect(applyBare, t).not.toContain(t);
    }
  });

  it('touches no RLS policy, no role and no grant surface', () => {
    expect(executable).not.toMatch(/\bCREATE\s+POLICY\b|\bALTER\s+POLICY\b|\bDROP\s+POLICY\b/i);
    expect(executable).not.toMatch(/\bCREATE\s+ROLE\b|\bGRANT\s+[a-z_]+\s+TO\b/i);
    // The only privilege statements are the two REVOKEs on its own functions.
    const grants = [...executable.matchAll(/^\s*(GRANT|REVOKE)\b/gim)].map(m => m[1].toUpperCase());
    expect(grants).toEqual(['REVOKE', 'REVOKE']);
  });

  it('selects institutions structurally, never by name', () => {
    expect(bare).not.toMatch(/organizations[\s\S]{0,80}\bname\s*=/);
    expect(bare).not.toMatch(/[؀-ۿ]/); // no Arabic selector literal
  });
});
