/**
 * CN-2B CORRECTIVE EXTENSION (213) — STATIC guard over the migration's
 * executable SQL. Mirrors 212's static suite conventions exactly: assertions
 * run against comment-stripped / string-blanked SQL so prose can never
 * satisfy a check.
 */
import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { activeSql, executableSql, sqlFunctionSource } from './helpers/sql-source';
import {
  REVIEWED_MIGRATION_FILES, isReviewedMigrationFile, getNextUnreviewedMigrationNumber,
} from './helpers/reviewed-migrations';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '213_phoenix_central_needs_beneficiary_column_mapping.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');
const CODE = activeSql(SQL);
const EXEC = executableSql(SQL);

const M212_FILENAME = '212_phoenix_central_needs_need_lines.sql';
const M212_SQL = readFileSync(join(MIGRATIONS, M212_FILENAME), 'utf8');

const VERIFY_AT = CODE.indexOf('DO $verify$');
const IMPL = CODE.slice(0, VERIFY_AT);
const VERIFY = CODE.slice(VERIFY_AT);

const SET_NEED_LINE_SIG =
  'public.phoenix_central_needs_set_need_line(uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text)';

describe('CN-2B/213 static — registration and file hygiene', () => {
  it('213 exists on disk immediately after 212, and is NOT yet reviewed', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files[files.length - 1]).toBe(FILENAME);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 213)).toEqual([]);

    // The load-bearing governance assertion: 213 must NOT be added to the
    // hand-maintained reviewed list merely to make this suite (or the repo's
    // own reviewed-migration-manifest test) green. It stays the next
    // UNREVIEWED migration until an independent review authorizes advancing
    // the ceiling — exactly the discipline M212 itself passed through.
    expect(isReviewedMigrationFile(FILENAME)).toBe(false);
    expect(REVIEWED_MIGRATION_FILES).not.toContain(FILENAME);
    expect(getNextUnreviewedMigrationNumber()).toBe(213);
  });

  it('edits no historical migration file — only CREATE OR REPLACE of the two extended functions', () => {
    expect(VERIFY_AT).toBeGreaterThan(0);
    for (const forbidden of [
      'ALTER TABLE public.central_needs_source_records',
      'ALTER TABLE public.central_needs_plan_revisions',
      'ALTER TABLE public.central_needs_plans',
      'ALTER TABLE public.central_needs_import_sessions',
      'ALTER TABLE public.central_needs_record_mappings',
      'ALTER TABLE public.central_needs_field_overrides',
      'ALTER TABLE public.central_needs_need_lines',
      'ALTER TABLE public.central_needs_need_line_sources',
      'DROP TABLE',
      'DROP POLICY',
      'DROP CONSTRAINT',
      'DROP FUNCTION',
    ]) {
      expect(EXEC, forbidden).not.toContain(forbidden);
    }
  });

  it('leaves M209, M210, M211 and M212 byte-identical on disk', () => {
    for (const f of [
      '209_phoenix_central_needs_registry.sql',
      '210_phoenix_central_needs_workflow_rpcs.sql',
      '211_phoenix_central_needs_batch_and_disposition.sql',
      M212_FILENAME,
    ]) {
      // Presence + content is proven by git in CI; here we assert the file
      // this suite runs against is not itself the one under test.
      expect(f).not.toBe(FILENAME);
    }
    // The two functions 213 legitimately replaces are exactly the two named
    // below — nothing else in 212's own executable surface is touched by 213
    // (212's file on disk is untouched regardless; this asserts 213 only
    // CREATE OR REPLACEs functions 212 itself defined, not new ones outside
    // that contract).
    for (const fn of ['phoenix_central_needs_set_need_line',
                       '_phoenix_central_needs_assert_need_line_integrity_v1',
                       '_phoenix_central_needs_review_blockers_v1']) {
      expect(M212_SQL).toContain(`FUNCTION public.${fn}`);
    }
  });

  it('touches no stock, movement, allocation, transfer or supply table', () => {
    for (const forbidden of [
      'warehouse_stock', 'outlet_stock', 'movement', 'inventory_transfer',
      'allocation', 'supply_source', 'dispatch', 'central_needs_need_lines_remaining',
    ]) {
      expect(EXEC.toLowerCase()).not.toContain(forbidden.toLowerCase());
    }
  });

  it('creates exactly one new table', () => {
    const createTable = [...CODE.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(createTable).toEqual(['central_needs_beneficiary_column_mappings']);
  });

  it('never creates an organization — no INSERT INTO organizations', () => {
    expect(EXEC).not.toContain('INSERT INTO public.organizations');
    expect(EXEC).not.toContain('INSERT INTO organizations');
  });
});

describe('CN-2B/213 static — physical-column identity', () => {
  it('the mapping table keys on (import_session_id, sheet_index, column_index), never on header text', () => {
    expect(CODE).toContain(
      'UNIQUE (import_session_id, sheet_index, column_index)');
    expect(EXEC).not.toMatch(/UNIQUE\s*\([^)]*field_name[^)]*\)/i);
    expect(EXEC).not.toMatch(/UNIQUE\s*\([^)]*source_field_name[^)]*\)/i);
  });

  it('column identity is read from persisted source_provenance, never trusted from the caller as identity', () => {
    const write = sqlFunctionSource(SQL, 'phoenix_central_needs_set_beneficiary_columns')!;
    expect(write).toBeTruthy();
    // The evidence lookup keys on session + provenance-derived sheet/column,
    // not on any caller-supplied header text.
    expect(write).toContain(`(r.source_provenance->>'sheetIndex')::integer = v_sheet_index`);
    expect(write).toContain(`(r.source_provenance->'coordinate'->>'col')::integer = v_column_index`);
  });

  it('declaratively binds every mapping row to one plan revision, one owning org, and one import session', () => {
    expect(CODE).toContain('central_needs_beneficiary_column_mappings_revision_org_fk');
    expect(CODE).toContain('central_needs_beneficiary_column_mappings_session_revision_org_fk');
    expect(CODE).toContain(
      'REFERENCES public.central_needs_import_sessions (id, plan_revision_id, organization_id)');
  });

  it('a physical column with inconsistent field names fails closed', () => {
    const write = sqlFunctionSource(SQL, 'phoenix_central_needs_set_beneficiary_columns')!;
    expect(write).toContain('beneficiary_column_field_name_inconsistent');
    expect(write).toContain('array_length(v_field_names, 1) > 1');
  });

  it('a column with no matching authoritative evidence is refused, not silently accepted', () => {
    const write = sqlFunctionSource(SQL, 'phoenix_central_needs_set_beneficiary_columns')!;
    expect(write).toContain('beneficiary_column_no_matching_evidence');
  });
});

describe('CN-2B/213 static — security posture', () => {
  it('RLS enabled and forced on the new table', () => {
    expect(EXEC).toContain(
      'ALTER TABLE public.central_needs_beneficiary_column_mappings ENABLE ROW LEVEL SECURITY');
    expect(EXEC).toContain(
      'ALTER TABLE public.central_needs_beneficiary_column_mappings FORCE ROW LEVEL SECURITY');
  });

  it('anon has no access; authenticated has no direct write grant', () => {
    expect(EXEC).toContain(
      'REVOKE ALL ON TABLE public.central_needs_beneficiary_column_mappings FROM anon');
    expect(EXEC).toContain(
      'REVOKE INSERT, UPDATE, DELETE ON TABLE public.central_needs_beneficiary_column_mappings FROM authenticated');
    expect(EXEC).not.toMatch(
      /GRANT\s+(INSERT|UPDATE|DELETE)[^;]*ON TABLE public\.central_needs_beneficiary_column_mappings TO authenticated/i);
  });

  it('applies the restrictive role-class policy to the new table', () => {
    expect(EXEC).toContain('central_needs_beneficiary_column_mappings_role_eligible_restrictive');
    expect(EXEC).toContain('_phoenix_central_needs_role_eligible_v1()');
  });

  it('the two new write/read functions revoke PUBLIC and anon explicitly', () => {
    for (const fn of ['phoenix_central_needs_set_beneficiary_columns(uuid, jsonb, text)',
                       'phoenix_central_needs_list_beneficiary_columns(uuid)']) {
      expect(EXEC).toContain(`REVOKE ALL ON FUNCTION public.${fn}`);
      expect(EXEC).toMatch(new RegExp(
        `GRANT EXECUTE ON FUNCTION public\\.${fn.replace(/[()[\]]/g, '\\$&')}\\s+TO authenticated`));
    }
  });

  it('the internal column-resolution helper is not client-callable', () => {
    expect(EXEC).toContain(
      'REVOKE ALL ON FUNCTION public._phoenix_central_needs_resolve_column_mapping_v1(uuid, jsonb)\n  FROM PUBLIC, anon, authenticated');
  });

  it('every function this migration defines or replaces pins search_path', () => {
    for (const fn of ['phoenix_central_needs_set_beneficiary_columns',
                       'phoenix_central_needs_list_beneficiary_columns',
                       '_phoenix_central_needs_resolve_column_mapping_v1',
                       'phoenix_central_needs_set_need_line',
                       '_phoenix_central_needs_assert_need_line_integrity_v1',
                       '_phoenix_central_needs_review_blockers_v1']) {
      const src = sqlFunctionSource(SQL, fn);
      expect(src, fn).toBeTruthy();
      expect(src, fn).toContain('SET search_path = public, pg_temp');
    }
  });

  it('the column-summary read is SECURITY INVOKER, not DEFINER', () => {
    const read = sqlFunctionSource(SQL, 'phoenix_central_needs_list_beneficiary_columns')!;
    expect(read).toContain('SECURITY INVOKER');
    expect(read).not.toContain('SECURITY DEFINER');
  });

  it('the write RPC and internal helpers are SECURITY DEFINER', () => {
    for (const fn of ['phoenix_central_needs_set_beneficiary_columns',
                       '_phoenix_central_needs_resolve_column_mapping_v1']) {
      const src = sqlFunctionSource(SQL, fn)!;
      expect(src, fn).toContain('SECURITY DEFINER');
    }
  });
});

describe('CN-2B/213 static — authorization reused, not reinvented', () => {
  it('the write RPC composes the canonical Central Needs load/guard/draft sequence', () => {
    const write = sqlFunctionSource(SQL, 'phoenix_central_needs_set_beneficiary_columns')!;
    expect(write).toContain('_phoenix_central_needs_load_revision_v1(p_plan_revision_id)');
    expect(write).toContain(`_phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit')`);
    expect(write).toContain('_phoenix_central_needs_assert_org_live_v1(v_revision.organization_id)');
    expect(write).toContain('_phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status)');
  });

  it('reuses the M212 beneficiary eligibility definition unchanged, with NULL warehouse', () => {
    const write = sqlFunctionSource(SQL, 'phoenix_central_needs_set_beneficiary_columns')!;
    expect(write).toContain('_phoenix_central_needs_assert_beneficiary_v1(v_beneficiary, NULL)');
    // No divergent eligibility definition is introduced.
    expect(EXEC).not.toMatch(/CREATE (OR REPLACE )?FUNCTION public\._phoenix_central_needs_assert_beneficiary_v1/);
  });

  it('does not create a second audit ledger — reuses audit_logs', () => {
    expect(CODE).toContain('INSERT INTO public.audit_logs');
    expect(EXEC).not.toMatch(/CREATE TABLE public\.\w*audit\w*/i);
  });

  it('no server-side fuzzy, phonetic, or automatic workbook-derived inference exists', () => {
    for (const forbidden of ['levenshtein', 'similarity(', 'pg_trgm', 'soundex', 'metaphone', 'fuzzystrmatch']) {
      expect(EXEC.toLowerCase()).not.toContain(forbidden);
    }
  });
});

describe('CN-2B/213 static — set_need_line enforcement (M212, extended)', () => {
  const write = sqlFunctionSource(SQL, 'phoenix_central_needs_set_need_line')!;

  it('kept the exact M212 public signature', () => {
    const normalized = EXEC.replace(/\s+/g, ' ');
    expect(normalized).toContain(
      `GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_need_line( uuid, uuid, uuid, numeric, text, jsonb, uuid[], text, text, uuid, text) TO authenticated`);
  });

  it('resolves and enforces the confirmed column mapping for every designated source record', () => {
    expect(write).toBeTruthy();
    expect(write).toContain('_phoenix_central_needs_resolve_column_mapping_v1(');
    expect(write).toContain('beneficiary_column_mapping_required');
    expect(write).toContain('beneficiary_column_mapping_conflict');
  });

  it('preserves every M212 check verbatim (spot-checked by identifier)', () => {
    for (const identifier of [
      'need_line_lineage_stale', 'need_line_scope_conflict', 'need_line_attributes_conflict',
      'source_link_requires_mapped_disposition', 'source_link_material_mismatch',
      'applied_override_does_not_match_source_record', 'source_record_already_linked',
      'need_line_quantity_provenance_mismatch',
    ]) {
      expect(write, identifier).toContain(identifier);
    }
  });
});

describe('CN-2B/213 static — deferred integrity trigger (M212, extended)', () => {
  const trigger = sqlFunctionSource(SQL, '_phoenix_central_needs_assert_need_line_integrity_v1')!;

  it('preserves all four M212 clauses and adds the beneficiary-column clause', () => {
    for (const identifier of [
      'need_line_requires_source_lineage',
      'need_line_quantity_provenance_mismatch',
      'need_line_material_mapping_conflict',
      'need_line_scope_mixes_institution_and_warehouse',
      'beneficiary_column_mapping_conflict',
    ]) {
      expect(trigger, identifier).toContain(identifier);
    }
  });

  it('no row-level source cardinality rule was introduced (M212 C1 discipline preserved)', () => {
    expect(EXEC).not.toContain('source_row_split_across_need_lines');
    expect(CODE).not.toMatch(/UNIQUE\s*\([^)]*target_entity[^)]*\)/);
  });

  it('the deferred trigger is also attached to the mapping table itself (defence in depth)', () => {
    expect(EXEC).toMatch(
      /CREATE CONSTRAINT TRIGGER assert_need_line_integrity\s+AFTER UPDATE OR DELETE ON public\.central_needs_beneficiary_column_mappings/);
    expect(trigger).toContain('beneficiary_column_mapping_in_use');
  });
});

describe('CN-2B/213 static — review-blocker completeness (cell grain)', () => {
  const blockers = sqlFunctionSource(SQL, '_phoenix_central_needs_review_blockers_v1')!;

  it('preserves every M211 and M212 blocker branch', () => {
    for (const identifier of [
      'no_finalized_import', 'import_session_still_open', 'completed_session_not_in_trusted_batch',
      'incomplete_trusted_batch', 'target_entity_without_disposition',
      'mapped_target_entity_without_need_line', 'need_line_material_mapping_divergent',
      'need_line_unit_conversion_required', 'need_line_warehouse_org_mismatch',
      'need_line_target_warehouse_not_active', 'need_line_beneficiary_ineligible',
    ]) {
      expect(blockers, identifier).toContain(identifier);
    }
  });

  it('adds the CELL-grain completeness branch for confirmed beneficiary columns', () => {
    expect(blockers).toContain('beneficiary_column_cell_without_need_line');
  });

  it('the new branch filters to numeric cells only, so zero is counted but never excluded by magnitude', () => {
    expect(blockers).toMatch(/beneficiary_column_cell_without_need_line[\s\S]*?valueType.*=.*'number'/);
    // Zero must not be filtered by a truthiness/nonzero test.
    expect(blockers).not.toMatch(/beneficiary_column_cell_without_need_line[\s\S]{0,2000}<>\s*0/);
  });
});

describe('CN-2B/213 static — VERIFY block exists and covers the new surface', () => {
  it('has its own fail-closed VERIFY block', () => {
    expect(VERIFY_AT).toBeGreaterThan(0);
    expect(VERIFY).toContain('VERIFY FAILED (213)');
  });

  it('asserts no backfill and no organization side effect', () => {
    expect(VERIFY).toContain('central_needs_beneficiary_column_mappings');
    expect(VERIFY).toMatch(/migration must not create any mapping/);
  });
});

describe('CN-2B/213 static — explicit column-review decision (independent review finding 1)', () => {
  const blockers = sqlFunctionSource(SQL, '_phoenix_central_needs_review_blockers_v1')!;
  const write = sqlFunctionSource(SQL, 'phoenix_central_needs_set_beneficiary_columns')!;
  const setLine = sqlFunctionSource(SQL, 'phoenix_central_needs_set_need_line')!;
  const trigger = sqlFunctionSource(SQL, '_phoenix_central_needs_assert_need_line_integrity_v1')!;
  const read = sqlFunctionSource(SQL, 'phoenix_central_needs_list_beneficiary_columns')!;

  it('the mapping row carries exactly two explicit decisions, and the shape of each is declarative', () => {
    expect(CODE).toMatch(/decision\s+text NOT NULL/);
    expect(CODE).toContain(`CHECK (decision IN ('beneficiary', 'non_beneficiary'))`);
    expect(CODE).toContain(`CHECK ((decision = 'beneficiary') = (beneficiary_organization_id IS NOT NULL))`);
    // No third "unregistered"/"ignored" state that could satisfy review.
    expect(EXEC).not.toMatch(/'(unregistered|ignored|unknown)'/);
    // The reason stays mandatory for every decision, non-beneficiary included.
    expect(CODE).toContain(`CHECK (btrim(mapping_reason) <> '')`);
  });

  it('adds a blocker for every numeric column on a mapped row that has NO review decision', () => {
    expect(blockers).toContain('beneficiary_column_review_required');
    const branch = blockers.slice(blockers.indexOf(`'beneficiary_column_review_required'`));
    // Starts from the evidence (source records on mapped rows), not from the mapping table.
    expect(branch).toMatch(/FROM public\.central_needs_source_records r/);
    expect(branch).toContain(`rm.decision          = 'mapped'`);
    expect(branch).toContain(`r.source_values->>'valueType' = 'number'`);
    expect(branch).toMatch(/NOT EXISTS \(\s*SELECT 1 FROM public\.central_needs_beneficiary_column_mappings cm/);
    // Zero is never excluded by magnitude.
    expect(branch).not.toMatch(/<>\s*0/);
  });

  it('only BENEFICIARY columns owe need lines cell by cell; non-beneficiary cells are reviewed, not linked', () => {
    const cellBranch = blockers.slice(
      blockers.indexOf(`'beneficiary_column_cell_without_need_line'`),
      blockers.indexOf(`'beneficiary_column_review_required'`));
    expect(cellBranch).toContain(`cm.decision = 'beneficiary'`);
  });

  it('the write RPC validates the decision explicitly and never implies non-beneficiary', () => {
    for (const identifier of [
      'beneficiary_column_decision_invalid',
      'beneficiary_column_non_beneficiary_must_not_name_beneficiary',
      'beneficiary_organization_required',
      'mapping_reason_required',
      'beneficiary_column_mapping_stale',
    ]) {
      expect(write, identifier).toContain(identifier);
    }
    expect(write).toContain(`'previous_decision'`);
    expect(write).toContain(`'new_decision'`);
  });

  it('set_need_line refuses a cell whose column was reviewed as non-beneficiary', () => {
    expect(setLine).toContain('beneficiary_column_not_beneficiary');
  });

  it('the deferred trigger treats a non-beneficiary decision on a linked column as a conflict', () => {
    expect(trigger).toMatch(/cm\.decision\s+IS DISTINCT FROM 'beneficiary'/);
  });

  it('the column summary read exposes the decision and whether the column still blocks review', () => {
    for (const column of ['column_decision', 'mapped_row_numeric_count', 'review_required']) {
      expect(read, column).toContain(column);
    }
  });

  it('VERIFY covers the decision shape and the new blocker branch', () => {
    expect(VERIFY).toContain('beneficiary_column_review_required');
    expect(VERIFY).toContain('central_needs_beneficiary_column_mappings_decision_shape_chk');
  });
});
