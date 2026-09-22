/**
 * CN-2B CONFORMANCE (212) — STATIC guard over the migration's executable SQL.
 *
 * Asserts against SQL with comments stripped, so prose can never satisfy a
 * check, and against string-blanked SQL for negative assertions, so a phrase
 * inside a RAISE message can never masquerade as the thing it forbids.
 */
import { describe, it, expect } from 'vitest';
import { execSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeSql, executableSql } from './helpers/sql-source';
import {
  REVIEWED_MIGRATION_FILES, isReviewedMigrationFile,
  getMaximumReviewedMigrationNumber, getNextUnreviewedMigrationNumber,
} from './helpers/reviewed-migrations';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '212_phoenix_central_needs_need_lines.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');
const CODE = activeSql(SQL);
const EXEC = executableSql(SQL);

const VERIFY_AT = CODE.indexOf('DO $verify$');
const IMPL = CODE.slice(0, VERIFY_AT);
const VERIFY = CODE.slice(VERIFY_AT);

const WRITE_RPC = 'phoenix_central_needs_set_need_line';
const WRITE_SIG = 'uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text';

/** One function's executable text, from its CREATE to the end of its body. */
function fnBody(name: string): string {
  const start = IMPL.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  if (start < 0) throw new Error(`function ${name} not found`);
  const end = IMPL.indexOf('$$;', IMPL.indexOf('AS $$', start));
  return IMPL.slice(start, end);
}

describe('CN-2B/212 static — registration and file hygiene', () => {
  it('is registered at 212, immediately below CN-2B/Finding-1 corrective 213 which is now the ceiling', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files.indexOf(FILENAME)).toBe(211);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 215)).toEqual([]);
    expect(files).toHaveLength(215);
    expect(isReviewedMigrationFile(FILENAME)).toBe(true);
    // 212 is no longer last: 213 sits directly after it, and 213's own
    // static suite owns the ceiling assertions from here on. The 212 -> 213
    // relationship below is HISTORICAL and never moves; the array's LAST entry
    // is the ceiling, now the M214 readiness-RPC volatility correction.
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.indexOf(FILENAME) + 1])
      .toBe('213_phoenix_central_needs_beneficiary_column_mapping.sql');
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1])
      .toBe('215_phoenix_central_needs_governed_correction_lifecycle.sql');
    expect(getMaximumReviewedMigrationNumber()).toBe(215);
    expect(getNextUnreviewedMigrationNumber()).toBe(216);
  });

  it('edits no historical migration — it is self-contained', () => {
    // Only CREATE OR REPLACE of the shared internal blockers function is
    // permitted to reach backwards, and it is a replacement, never an edit of
    // an applied file.
    expect(VERIFY_AT).toBeGreaterThan(0);
    for (const forbidden of [
      'ALTER TABLE public.central_needs_source_records',
      'ALTER TABLE public.central_needs_plan_revisions',
      'ALTER TABLE public.central_needs_plans',
      'ALTER TABLE public.central_needs_import_sessions',
      'ALTER TABLE public.central_needs_record_mappings',
      'ALTER TABLE public.central_needs_field_overrides',
      'DROP TABLE',
      'DROP POLICY',
      'DROP CONSTRAINT',
    ]) {
      expect(EXEC, forbidden).not.toContain(forbidden);
    }
  });

  it('leaves M209, M210 and M211 byte-identical on disk', () => {
    // The same mechanism migration 062's own guard uses: if any of the three
    // reviewed Central Needs migrations had been edited rather than extended,
    // it would appear in a tracked-file diff.
    for (const f of [
      '209_phoenix_central_needs_registry.sql',
      '210_phoenix_central_needs_workflow_rpcs.sql',
      '211_phoenix_central_needs_batch_and_disposition.sql',
    ]) {
      let diff = '';
      try {
        diff = execSync(`git diff -- supabase/migrations/${f}`,
          { cwd: join(MIGRATIONS, '..', '..'), encoding: 'utf8' });
      } catch { /* a git failure must not be read as "unmodified" */ }
      expect(diff.trim(), f).toBe('');
    }
  });

  it('touches no stock, movement, suggestion or audit table definition', () => {
    for (const forbidden of [
      'ALTER TABLE public.warehouse_stock',
      'ALTER TABLE public.outlet_stock',
      'ALTER TABLE public.warehouse_transfer_request_lines',
      'ALTER TABLE public.warehouse_transfer_lines',
      'ALTER TABLE public.inventory_transfer_suggestions',
      'CREATE TABLE public.inventory_transfer_suggestions',
      'ALTER TABLE public.audit_logs',
      'CREATE TABLE public.central_needs_audit',
    ]) {
      expect(EXEC, forbidden).not.toContain(forbidden);
    }
    // It still WRITES an audit row through the canonical table.
    expect(IMPL).toContain('INSERT INTO public.audit_logs');
  });
});

describe('CN-2B/212 static — the relational contract v7.3 section 8.1 requires', () => {
  it('creates exactly the two new relations', () => {
    const created = [...EXEC.matchAll(/CREATE TABLE public\.([a-z_]+)/g)].map((m) => m[1]).sort();
    expect(created).toEqual(['central_needs_need_line_sources', 'central_needs_need_lines']);
  });

  it('declares the beneficiary as its own required relational dimension', () => {
    expect(IMPL).toContain('beneficiary_organization_id uuid NOT NULL REFERENCES public.organizations(id)');
    // organization_id keeps its existing meaning and is NOT repurposed.
    expect(IMPL).toContain('organization_id             uuid NOT NULL REFERENCES public.organizations(id)');
  });

  it('keeps target_warehouse_id optional, and makes the scope key NULLS NOT DISTINCT', () => {
    expect(IMPL).toMatch(/target_warehouse_id\s+uuid REFERENCES public\.warehouses\(id\)/);
    expect(IMPL).not.toMatch(/target_warehouse_id\s+uuid NOT NULL/);
    // The warehouse IS part of the key, so an explicitly warehouse-targeted
    // requirement can exist — and NULLS NOT DISTINCT is what stops two
    // institution-level lines for one material from both being accepted.
    expect(IMPL).toContain(
      'UNIQUE NULLS NOT DISTINCT\n      (plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id)');
    // A plain UNIQUE over the same columns would double count; it must not appear.
    expect(IMPL).not.toContain(
      'UNIQUE (plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id)');
    expect(IMPL).not.toContain('UNIQUE (plan_revision_id, beneficiary_organization_id, central_item_id)');
  });

  it('stores both quantities as UNCONSTRAINED numeric — a typmod would silently round', () => {
    expect(IMPL).toContain('approved_quantity           numeric NOT NULL');
    expect(IMPL).toContain('designated_quantity numeric NOT NULL');
    // The rejected earlier design, named so a future edit cannot reintroduce it.
    expect(IMPL).not.toContain('numeric(20,3)');
    expect(IMPL).not.toMatch(/numeric\(\d+\s*,\s*\d+\)/);
    expect(IMPL).toContain('CHECK (approved_quantity >= 0)');
    expect(IMPL).toContain('CHECK (designated_quantity >= 0)');
    // >= 0 does not exclude NaN, and an unconstrained numeric admits Infinity.
    expect(IMPL).toContain("CHECK (approved_quantity <> 'NaN'::numeric AND approved_quantity < 'Infinity'::numeric)");
    expect(IMPL).toContain("CHECK (designated_quantity <> 'NaN'::numeric AND designated_quantity < 'Infinity'::numeric)");
    for (const bad of ['double precision', 'real', 'float']) {
      expect(EXEC, bad).not.toContain(bad);
    }
  });

  it('makes source-record provenance mandatory and sums it to the approved quantity', () => {
    // The RPC parameter has NO default, so no call shape omits the provenance.
    expect(IMPL).toMatch(/p_quantity_sources\s+jsonb,/);
    expect(IMPL).not.toMatch(/p_quantity_sources\s+jsonb\s+DEFAULT/);
    expect(IMPL).toContain("RAISE EXCEPTION 'need_line_requires_source_lineage'");
    expect(IMPL).toContain("RAISE EXCEPTION 'need_line_quantity_provenance_mismatch'");
    // The line's total is everything it already held plus what is added.
    expect(IMPL).toContain('v_existing_sum + v_added_sum <> p_approved_quantity');
    // And the same two invariants are re-asserted at COMMIT, on both tables, so
    // they do not rest on one RPC remembering them.
    expect(IMPL).toContain('CREATE CONSTRAINT TRIGGER assert_need_line_integrity');
    expect(IMPL).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(IMPL).toContain('AFTER INSERT OR UPDATE ON public.central_needs_need_lines');
    expect(IMPL).toContain('AFTER INSERT OR UPDATE OR DELETE ON public.central_needs_need_line_sources');
  });

  it('forbids a source reviewed as one material from feeding a line for another', () => {
    expect(IMPL).toContain("RAISE EXCEPTION 'source_link_material_mismatch'");
    expect(IMPL).toContain("RAISE EXCEPTION 'need_line_material_mapping_conflict'");
    // The canonical item comes from the row's existing mapping decision.
    expect(IMPL).toContain('AND central_item_id   = p_central_item_id');
    expect(IMPL).toContain('m.central_item_id IS DISTINCT FROM v_line.central_item_id');
  });

  it('keeps a triple either institution-level or warehouse-split, never both', () => {
    expect(IMPL).toContain("RAISE EXCEPTION 'need_line_scope_mixes_institution_and_warehouse'");
    expect(IMPL).toContain('a.target_warehouse_id IS NULL');
    expect(IMPL).toContain('b.target_warehouse_id IS NOT NULL');
  });

  it('records the measured corpus evidence the cardinality was frozen from', () => {
    // The key is a decision with evidence behind it, and the evidence is written
    // down where the next reader of this migration will find it.
    expect(SQL).toContain('b00208ca019c8735790c5401dee26d986234a12279d04e0a057f278bd99eaca2');
    expect(SQL).toContain('57 workbooks, 71 sheets, 113950 source records');
    expect(SQL).toContain('58 sheets carry TWO OR MORE quantity columns');
    expect(SQL).toContain('3861 material rows carry TWO OR MORE non-zero quantity cells');
    expect(SQL).toContain('ONE ROW -> ONE LINE IS FALSE FOR THIS CORPUS');
    expect(SQL).toContain('ONE SOURCE RECORD -> AT MOST ONE NEED');
    // The claims the corrected measurement does NOT support are gone.
    expect(SQL).not.toContain('0 sheets carry ANY warehouse/store/pharmacy-section column');
    expect(SQL).not.toContain('ONE ROW -> ONE LINE         —');
  });

  it('reuses the canonical central_items unit vocabulary and invents no second catalog', () => {
    expect(IMPL).toContain("('box', 'vial', 'ampoule', 'tablet', 'bottle', 'tube', 'sachet', 'other')");
    expect(EXEC).not.toContain('CREATE TABLE public.units');
    expect(EXEC).not.toContain('CREATE TABLE public.central_needs_units');
  });

  it('makes the conversion state and the unit mutually exclusive, so NULL never means unknown', () => {
    expect(IMPL).toContain("unit_conversion_state = 'canonical'            AND approved_unit IS NOT NULL");
    expect(IMPL).toContain("unit_conversion_state = 'conversion_required'  AND approved_unit IS NULL");
  });

  it('requires a mapping reason on every line', () => {
    expect(IMPL).toContain('CHECK (btrim(mapping_reason) <> \'\')');
  });

  it('lets one source RECORD feed at most one need line, and pins provenance at cell level', () => {
    expect(IMPL).toContain('UNIQUE (source_record_id)');
    // Record-level, because one row legitimately carries several quantity cells.
    expect(IMPL).toContain('source_record_id    uuid NOT NULL');
    expect(IMPL).toContain('REFERENCES public.central_needs_source_records (id, organization_id)');
    // And there is NO row-level rule: one row may feed several lines (C1).
    expect(IMPL).not.toContain("RAISE EXCEPTION 'source_row_split_across_need_lines'");
    expect(fnBody('_phoenix_central_needs_assert_need_line_integrity_v1'))
      .not.toContain('GROUP BY r.import_session_id, r.target_entity');
  });
});

describe('CN-2B/212 static — independent-review corrections', () => {
  it('Q1: saving never removes provenance and never upserts over an existing scope', () => {
    const set = fnBody(WRITE_RPC);
    expect(set).not.toContain('DELETE FROM public.central_needs_need_line_sources');
    expect(set).not.toMatch(/ON CONFLICT[\s\S]*DO UPDATE/);
    expect(set).toContain("RAISE EXCEPTION 'need_line_lineage_stale'");
    expect(set).toContain("RAISE EXCEPTION 'need_line_attributes_conflict'");
    // Only the explicit correction RPC deletes a link.
    expect((IMPL.match(/DELETE FROM public\.central_needs_need_line_sources/g) ?? []).length).toBe(1);
    expect(fnBody('phoenix_central_needs_delete_need_line'))
      .toContain('DELETE FROM public.central_needs_need_line_sources');
  });

  it('Q1: both writes take a mandatory expected lineage, with no default', () => {
    expect((IMPL.match(/p_expected_source_record_ids\s+uuid\[\]/g) ?? []).length).toBe(2);
    expect(IMPL).not.toMatch(/p_expected_source_record_ids\s+uuid\[\]\s+DEFAULT/);
    expect(IMPL).toContain("RAISE EXCEPTION 'expected_source_record_ids_required'");
  });

  it('Q3: the delete RPC authorizes, requires draft and a reason, deletes links before the line, and audits', () => {
    const del = fnBody('phoenix_central_needs_delete_need_line');
    expect(del).toContain("_phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit')");
    expect(del).toContain('_phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status)');
    expect(del).toContain("RAISE EXCEPTION 'need_line_deletion_reason_required'");
    const links = del.indexOf('DELETE FROM public.central_needs_need_line_sources');
    const line = del.indexOf('DELETE FROM public.central_needs_need_lines ');
    expect(links).toBeGreaterThan(0);
    expect(line).toBeGreaterThan(links);
    expect(del).toContain("'central_needs.need_line.delete'");
    expect(del).toContain("'deletion_reason', v_reason");
    // Evidence is never touched.
    expect(del).not.toMatch(/(UPDATE|DELETE FROM) public\.central_needs_(source_records|field_overrides)/);
    expect(IMPL).toContain(
      'GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])');
  });

  it('Q2: a new routing requires an ACTIVE warehouse, and a later lifecycle change blocks review', () => {
    const bene = fnBody('_phoenix_central_needs_assert_beneficiary_v1');
    expect(bene).toContain("v_wh_status IS DISTINCT FROM 'active'");
    expect(bene).toContain("RAISE EXCEPTION 'target_warehouse_not_active'");
    const blockers = fnBody('_phoenix_central_needs_review_blockers_v1');
    expect(blockers).toContain("'need_line_target_warehouse_not_active'");
    expect(blockers).toContain("w.status IS DISTINCT FROM 'active'");
  });

  it('F4: a re-pointed link asserts BOTH the line it joins and the line it leaves', () => {
    const trg = fnBody('_phoenix_central_needs_assert_need_line_integrity_v1');
    expect(trg).toContain('OLD.need_line_id IS DISTINCT FROM NEW.need_line_id');
    expect(trg).toContain('ARRAY[NEW.need_line_id, OLD.need_line_id]');
    expect(trg).toContain('FOREACH v_line_id IN ARRAY v_line_ids');
    // A missing line skips to the next one rather than ending the assertion.
    expect(trg).not.toMatch(/IF NOT FOUND THEN\s+RETURN NULL/);
  });

  it('F5: the read emits both quantities as TEXT and is SECURITY INVOKER', () => {
    const list = fnBody('phoenix_central_needs_list_need_lines');
    expect(list).toMatch(/approved_quantity\s+text,/);
    expect(list).toContain('n.approved_quantity::text');
    expect(list).toContain("'designated_quantity', ls.designated_quantity::text");
    expect(list).toContain('SECURITY INVOKER');
    expect(list).not.toContain('SECURITY DEFINER');
  });

  it('Q4: expected uniqueness conflicts become stable domain errors; anything else re-raises', () => {
    const set = fnBody(WRITE_RPC);
    expect((set.match(/EXCEPTION WHEN unique_violation THEN/g) ?? []).length).toBe(2);
    expect(set).toContain("v_constraint = 'central_needs_need_lines_scope_key'");
    expect(set).toContain("v_constraint = 'central_needs_need_line_sources_record_key'");
    expect(set).toContain("RAISE EXCEPTION 'need_line_scope_conflict'");
    expect(set).toContain("RAISE EXCEPTION 'source_record_already_linked'");
    expect((set.match(/^\s+RAISE;$/gm) ?? []).length).toBe(2);
  });
});

describe('CN-2B/212 static — security posture', () => {
  it('enables and forces RLS on both new relations', () => {
    for (const t of ['central_needs_need_lines', 'central_needs_need_line_sources']) {
      expect(IMPL).toContain(`ALTER TABLE public.${t} ENABLE ROW LEVEL SECURITY`);
      expect(IMPL).toContain(`ALTER TABLE public.${t} FORCE ROW LEVEL SECURITY`);
      expect(IMPL).toContain(`REVOKE ALL ON TABLE public.${t} FROM PUBLIC`);
      expect(IMPL).toContain(`REVOKE ALL ON TABLE public.${t} FROM anon`);
      expect(IMPL).toContain(`REVOKE INSERT, UPDATE, DELETE ON TABLE public.${t} FROM authenticated`);
      expect(IMPL).toContain(`GRANT SELECT ON TABLE public.${t} TO authenticated`);
    }
  });

  it('authorizes reads on the OWNING organization only — the beneficiary gains nothing', () => {
    const policies = [...IMPL.matchAll(/USING \(public\.phoenix_status_center_authorized\(([a-z_]+), '([a-z_.]+)'\)\)/g)];
    expect(policies).toHaveLength(2);
    for (const p of policies) {
      expect(p[1]).toBe('organization_id');
      expect(p[2]).toBe('central_needs.view');
    }
    expect(IMPL).not.toContain("phoenix_status_center_authorized(beneficiary_organization_id");
    // M211's role-class restriction covers both new relations too.
    for (const t of ['central_needs_need_lines', 'central_needs_need_line_sources']) {
      expect(IMPL).toContain(`CREATE POLICY ${t}_role_eligible_restrictive`);
      expect(IMPL).toContain(`ON public.${t} AS RESTRICTIVE FOR ALL TO authenticated`);
    }
    expect((IMPL.match(/USING \(public\._phoenix_central_needs_role_eligible_v1\(\)\)/g) ?? []).length).toBe(2);
  });

  it('uses the canonical org authorization helper, never the scoped-permission one', () => {
    expect(IMPL).toContain('_phoenix_central_needs_guard_v1');
    expect(EXEC).not.toContain('phoenix_profile_has_scoped_permission');
  });

  it('pins search_path on every function it defines and keeps internals off the client', () => {
    const defs = [...EXEC.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)\(/g)].map((m) => m[1]);
    expect(defs).toContain(WRITE_RPC);
    expect(defs).toContain('phoenix_central_needs_delete_need_line');
    expect(defs).toContain('phoenix_central_needs_list_need_lines');
    expect(defs).toContain('_phoenix_central_needs_assert_beneficiary_v1');
    expect(defs).toContain('_phoenix_central_needs_review_blockers_v1');
    expect((EXEC.match(/SET search_path = public, pg_temp/g) ?? []).length).toBeGreaterThanOrEqual(defs.length);
    // Single-line fragments rather than multi-line spans: an assertion that
    // depends on an exact newline sequence breaks on a line-ending change
    // without the contract having changed at all.
    expect(IMPL).toContain('REVOKE ALL ON FUNCTION public._phoenix_central_needs_assert_beneficiary_v1(uuid, uuid)');
    expect(IMPL).toContain('FROM PUBLIC, anon, authenticated');
    expect(IMPL).toContain(`GRANT EXECUTE ON FUNCTION public.${WRITE_RPC}(`);
    expect(IMPL).toContain(`  ${WRITE_SIG}) TO authenticated`);
  });

  it('adds no permission key and never introduces central_needs.send', () => {
    expect(EXEC).not.toContain('INSERT INTO public.permission_keys');
    expect(EXEC).not.toContain('INSERT INTO public.role_permission_defaults');
    expect(EXEC).not.toContain("'central_needs.send'");
    expect(VERIFY).toContain('central_needs.send must never exist');
  });

  it('validates the write server-side rather than trusting the caller', () => {
    for (const check of [
      'not_authenticated', 'mapping_reason_required', 'central_item_required',
      'approved_quantity_required', 'approved_quantity_must_not_be_negative',
      'unit_conversion_state_invalid', 'canonical_unit_required',
      'conversion_required_must_not_carry_unit',
      'source_link_requires_mapped_disposition', 'source_link_session_not_in_revision',
      'beneficiary_must_be_care_institution', 'target_warehouse_not_owned_by_beneficiary',
      'target_warehouse_not_active', 'expected_source_record_ids_required', 'need_line_lineage_stale',
      'source_record_already_linked', 'need_line_scope_conflict', 'need_line_deletion_reason_required',
    ]) {
      expect(IMPL, check).toContain(check);
    }
  });

  it('refuses mapping on a non-draft revision through the canonical assertion', () => {
    expect(IMPL).toContain('_phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status)');
  });
});

describe('CN-2B/212 static — blockers extended, never weakened', () => {
  it('reproduces every pre-212 branch verbatim and adds the new ones', () => {
    const fn = IMPL.slice(IMPL.indexOf('_phoenix_central_needs_review_blockers_v1'));
    for (const pre of [
      'no_finalized_import', 'import_session_still_open',
      'completed_session_not_in_trusted_batch', 'incomplete_trusted_batch',
      'target_entity_without_disposition',
    ]) {
      expect(fn, pre).toContain(pre);
    }
    for (const added of [
      'mapped_target_entity_without_need_line', 'need_line_unit_conversion_required',
      'need_line_warehouse_org_mismatch', 'need_line_beneficiary_ineligible',
      'need_line_target_warehouse_not_active',
    ]) {
      expect(fn, added).toContain(added);
    }
  });
});

describe('CN-2B/212 static — no backfill', () => {
  it('creates no need line and writes no row into the new relations', () => {
    // The write RPC necessarily contains an INSERT; what must not exist is a
    // migration-time backfill. The VERIFY block proves the table is empty when
    // the migration finishes, which is the assertion that actually matters.
    expect(VERIFY).toContain('migration must not create need lines');
    expect(VERIFY).toContain('FROM public.central_needs_need_lines');
    // No set-based backfill from existing evidence anywhere in the file.
    expect(EXEC).not.toMatch(/INSERT INTO public\.central_needs_need_lines[\s\S]{0,400}?SELECT[\s\S]{0,200}?FROM public\.central_needs_source_records/);
    expect(EXEC).not.toMatch(/INSERT INTO public\.central_needs_need_lines[\s\S]{0,400}?SELECT[\s\S]{0,200}?FROM public\.central_needs_record_mappings/);
  });

  it('derives nothing from workbook structure — mapping is human-authoritative', () => {
    for (const heuristic of [
      'all_institutions_annual_needs', 'individual_institution_annual_needs',
      'sheet_name', 'INSTITUTION_HEADER_HINTS',
    ]) {
      expect(EXEC, heuristic).not.toContain(heuristic);
    }
  });
});
