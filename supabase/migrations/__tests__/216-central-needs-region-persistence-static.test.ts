/**
 * C4 / M216 — STATIC guard over the beneficiary-region persistence migration.
 *
 * The four behaviour-only replacements are proven VERBATIM against M213: each
 * M216 function, with its marked 216 additions removed, must be byte-identical
 * to the M213 original. Structural assertions run against comment-stripped
 * SQL so prose can never satisfy a check.
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { executableSql, stripSqlComments, sqlFunctionSource } from './helpers/sql-source';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '216_phoenix_central_needs_region_persistence.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');
const CODE = stripSqlComments(SQL);
const EXEC = executableSql(SQL);
const M213 = readFileSync(join(MIGRATIONS, '213_phoenix_central_needs_beneficiary_column_mapping.sql'), 'utf8');

const VERIFY_AT = CODE.indexOf('DO $verify$');
const IMPL = CODE.slice(0, VERIFY_AT);
const VERIFY = CODE.slice(VERIFY_AT);

/** The raw text (comments included) of one CREATE OR REPLACE FUNCTION ... $$; block. */
function rawFunction(sql: string, name: string): string {
  const start = sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`);
  expect(start, name).toBeGreaterThanOrEqual(0);
  expect(sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`, start + 1), `${name} defined twice`).toBe(-1);
  const end = sql.indexOf('\n$$;\n', start);
  return sql.slice(start, end + '\n$$;\n'.length);
}

/** Removes exactly one occurrence of `block`; fails if it is absent or repeated. */
function without(text: string, block: string, label: string): string {
  const at = text.indexOf(block);
  expect(at, `${label} present`).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(block, at + 1), `${label} unique`).toBe(-1);
  return text.slice(0, at) + text.slice(at + block.length);
}

/** The slice from `from` (inclusive) to `to` (exclusive), each unique. */
function between(text: string, from: string, to: string, label: string): string {
  const a = text.indexOf(from);
  expect(a, `${label} start`).toBeGreaterThanOrEqual(0);
  const b = text.indexOf(to, a + from.length);
  expect(b, `${label} end`).toBeGreaterThan(a);
  return text.slice(a, b);
}

const gitBlob = (content: Buffer) =>
  createHash('sha1').update(Buffer.concat([Buffer.from(`blob ${content.length}\0`), content])).digest('hex');

describe('C4/M216 static — file hygiene and protected surface', () => {
  it('216 is the next migration after 215 and is the only file above 215', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files.filter((f) => Number(f.slice(0, 3)) >= 216)).toEqual([FILENAME]);
  });

  it('leaves M209-M215 byte-identical (git blob ids of the frozen baseline)', () => {
    const baseline: Record<string, string> = {
      '209_phoenix_central_needs_registry.sql': '9378bdaf44e6808ac9a0b0abb4ab42c6e283e9e1',
      '210_phoenix_central_needs_workflow_rpcs.sql': 'f61c5206ab843a2bc50dfae972d998700aa9f2bc',
      '211_phoenix_central_needs_batch_and_disposition.sql': '999c6c62154827bd350fea681678a1fa22d74e1e',
      '212_phoenix_central_needs_need_lines.sql': '938a6c7f8a10ff2e89cf5496b46affe43bc1db58',
      '213_phoenix_central_needs_beneficiary_column_mapping.sql': 'a465d323b2cfc9e72e43b9c577163a045c28aa6a',
      '214_phoenix_central_needs_review_readiness_volatility.sql': '2954b3bf349370a6a2701216dc89e3385873601c',
      '215_phoenix_central_needs_governed_correction_lifecycle.sql': '5f1c6bbbb2c2be46c9d7a28642c01e12b76e4c29',
    };
    for (const [file, blob] of Object.entries(baseline)) {
      expect(gitBlob(readFileSync(join(MIGRATIONS, file))), file).toBe(blob);
    }
  });

  it('is one explicit transaction with PRECONDITIONS before any object and VERIFY last', () => {
    expect(CODE.trimStart().startsWith('BEGIN;')).toBe(true);
    expect(CODE.trimEnd().endsWith('COMMIT;')).toBe(true);
    const pre = CODE.indexOf('DO $precondition$');
    expect(pre).toBeGreaterThan(0);
    expect(pre).toBeLessThan(CODE.indexOf('CREATE'));
    expect(VERIFY_AT).toBeGreaterThan(CODE.lastIndexOf('CREATE OR REPLACE FUNCTION'));
    expect(SQL).not.toMatch(/\r/);
  });

  it('creates exactly one table, and alters no existing table beyond enabling RLS on the new one', () => {
    expect([...EXEC.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1])).toEqual(['central_needs_beneficiary_regions']);
    const alters = [...EXEC.matchAll(/ALTER TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(new Set(alters)).toEqual(new Set(['central_needs_beneficiary_regions']));
    for (const forbidden of ['DROP TABLE', 'DROP POLICY', 'DROP CONSTRAINT', 'DROP FUNCTION', 'DROP TRIGGER', 'DROP INDEX',
      'ALTER FUNCTION', 'CREATE EXTENSION', 'EXCLUDE USING']) {
      expect(EXEC, forbidden).not.toContain(forbidden);
    }
  });

  it('attaches exactly four triggers: T1-T3 on the new relation and T4 — the only object — on the M213 table', () => {
    const triggers = [...EXEC.matchAll(/CREATE (CONSTRAINT )?TRIGGER (\w+)\s+(?:BEFORE|AFTER) ([A-Z ]+?) ON public\.(\w+)/g)]
      .map((m) => ({ constraint: Boolean(m[1]), name: m[2], events: m[3].trim(), table: m[4] }));
    expect(triggers).toEqual([
      { constraint: false, name: 'central_needs_beneficiary_regions_guard', events: 'INSERT OR UPDATE OR DELETE', table: 'central_needs_beneficiary_regions' },
      { constraint: true, name: 'assert_beneficiary_region_geometry', events: 'INSERT OR UPDATE', table: 'central_needs_beneficiary_regions' },
      { constraint: true, name: 'assert_beneficiary_region_grain', events: 'INSERT OR UPDATE', table: 'central_needs_beneficiary_column_mappings' },
      { constraint: true, name: 'assert_need_line_integrity', events: 'INSERT OR UPDATE OR DELETE', table: 'central_needs_beneficiary_regions' },
    ]);
    expect(EXEC.match(/DEFERRABLE INITIALLY DEFERRED/g)).toHaveLength(3);
    // Nothing else is created on the M213 table.
    expect(EXEC).not.toMatch(/(CREATE (UNIQUE )?INDEX|CREATE POLICY|ADD CONSTRAINT)[^;]*central_needs_beneficiary_column_mappings/);
    expect(EXEC).not.toMatch(/(INSERT INTO|UPDATE) public\.central_needs_beneficiary_column_mappings/);
  });

  it('touches no stock, movement, allocation, transfer or supply object and never creates an organization', () => {
    for (const forbidden of ['warehouse_stock', 'outlet_stock', 'movement', 'inventory_transfer', 'allocation',
      'supply_source', 'dispatch', 'INSERT INTO public.organizations']) {
      expect(EXEC.toLowerCase(), forbidden).not.toContain(forbidden.toLowerCase());
    }
  });

  it('does not replace submit, review_readiness, the M213 resolver, set_beneficiary_columns or any M215 function', () => {
    for (const fn of ['phoenix_central_needs_submit_revision', 'phoenix_central_needs_review_readiness',
      '_phoenix_central_needs_resolve_column_mapping_v1', 'phoenix_central_needs_set_beneficiary_columns',
      'phoenix_central_needs_open_plan_revision', 'phoenix_central_needs_open_correction_revision',
      'phoenix_central_needs_approve_revision', 'phoenix_central_needs_reject_revision',
      'phoenix_central_needs_revision_lifecycle', '_phoenix_central_needs_lock_plan_family_v1',
      '_phoenix_central_needs_human_text_v1', 'phoenix_central_needs_delete_need_line']) {
      expect(EXEC, fn).not.toMatch(new RegExp(`CREATE (OR REPLACE )?FUNCTION public\\.${fn}\\(`));
    }
    expect(EXEC).not.toContain('audit_logs ENABLE');
    expect(EXEC).not.toMatch(/ON public\.audit_logs/);
    expect(EXEC).not.toMatch(/permission_keys\s*\(/);
  });
});

describe('C4/M216 static — the version relation (B1)', () => {
  const table = between(CODE, 'CREATE TABLE public.central_needs_beneficiary_regions (', '\n);\n', 'table');

  it('carries the two identities, lineage, binding, geometry, decision and a four-column retirement stamp — nothing else', () => {
    const cols = [...table.matchAll(/^\s{2}([a-z_]+)\s+(uuid|integer|text|timestamptz)/gm)].map((m) => m[1]);
    expect(cols).toEqual(['version_id', 'region_id', 'version_no', 'supersedes_version_id', 'plan_revision_id',
      'organization_id', 'import_session_id', 'sheet_index', 'row_start', 'row_end', 'column_start', 'column_end',
      'decision', 'beneficiary_organization_id', 'decision_reason', 'decided_by', 'decided_at', 'created_at',
      'retired_at', 'retired_by', 'retirement_kind', 'retirement_reason']);
    expect(table).not.toMatch(/quantity|unit|material|warehouse|updated_at|anchor|role|sheet_name|parser/);
  });

  it('declares S1-S11 and S14-S18 exactly', () => {
    expect(table).toContain('CHECK (sheet_index >= 0)');
    expect(table).toContain('CHECK (row_start >= 0 AND row_start <= row_end AND row_end <= 1048575)');
    expect(table).toContain('CHECK (column_start >= 0 AND column_start <= column_end AND column_end <= 16383)');
    expect(table).toContain("CHECK (decision IN ('beneficiary', 'non_beneficiary'))");
    expect(table).toContain("CHECK ((decision = 'beneficiary') = (beneficiary_organization_id IS NOT NULL))");
    expect(table).toContain("CHECK (btrim(decision_reason) <> '')");
    expect(table).toContain('CHECK (version_no >= 1 AND ((version_no = 1) = (supersedes_version_id IS NULL)))');
    expect(table).toContain('UNIQUE (region_id, version_no)');
    expect(table).toContain('UNIQUE (supersedes_version_id)');
    expect(table).toMatch(/FOREIGN KEY \(supersedes_version_id, region_id, plan_revision_id, organization_id, import_session_id, sheet_index\)\s+REFERENCES public\.central_needs_beneficiary_regions\s+\(version_id, region_id, plan_revision_id, organization_id, import_session_id, sheet_index\)\s+ON DELETE RESTRICT/);
    expect(table).toMatch(/FOREIGN KEY \(plan_revision_id, organization_id\)\s+REFERENCES public\.central_needs_plan_revisions \(id, organization_id\)\s+ON DELETE RESTRICT/);
    expect(table).toMatch(/FOREIGN KEY \(import_session_id, plan_revision_id, organization_id\)\s+REFERENCES public\.central_needs_import_sessions \(id, plan_revision_id, organization_id\)\s+ON DELETE RESTRICT/);
    expect(table).toMatch(/decided_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(table).toMatch(/retired_by\s+uuid REFERENCES auth\.users\(id\) ON DELETE SET NULL/);
    expect(table).not.toMatch(/ON DELETE CASCADE/);
  });

  it('S12 and S13 are PARTIAL uniqueness over ACTIVE versions; no plain geometry uniqueness exists anywhere', () => {
    expect(IMPL).toMatch(/CREATE UNIQUE INDEX central_needs_beneficiary_regions_active_region_uidx\s+ON public\.central_needs_beneficiary_regions \(region_id\)\s+WHERE retired_at IS NULL;/);
    expect(IMPL).toMatch(/CREATE UNIQUE INDEX central_needs_beneficiary_regions_active_geometry_uidx\s+ON public\.central_needs_beneficiary_regions\s+\(import_session_id, sheet_index, row_start, row_end, column_start, column_end\)\s+WHERE retired_at IS NULL;/);
    expect(table).not.toMatch(/UNIQUE \([^)]*row_start/);
    expect(IMPL.match(/CREATE UNIQUE INDEX/g)).toHaveLength(2);
  });

  it('RLS is enabled and forced; authenticated gets SELECT only; anon and PUBLIC nothing; restrictive role policy', () => {
    expect(IMPL).toContain('ALTER TABLE public.central_needs_beneficiary_regions ENABLE ROW LEVEL SECURITY;');
    expect(IMPL).toContain('ALTER TABLE public.central_needs_beneficiary_regions FORCE ROW LEVEL SECURITY;');
    expect(IMPL).toContain('REVOKE ALL ON TABLE public.central_needs_beneficiary_regions FROM PUBLIC;');
    expect(IMPL).toContain('REVOKE ALL ON TABLE public.central_needs_beneficiary_regions FROM anon;');
    expect(IMPL).toContain('REVOKE ALL ON TABLE public.central_needs_beneficiary_regions FROM authenticated;');
    expect(IMPL.match(/GRANT [A-Z, ]+ ON TABLE public\.central_needs_beneficiary_regions TO \w+;/g))
      .toEqual(['GRANT SELECT ON TABLE public.central_needs_beneficiary_regions TO authenticated;']);
    expect(IMPL).toMatch(/CREATE POLICY central_needs_beneficiary_regions_select_authorized\s+ON public\.central_needs_beneficiary_regions FOR SELECT TO authenticated\s+USING \(public\.phoenix_status_center_authorized\(organization_id, 'central_needs\.view'\)\);/);
    expect(IMPL).toMatch(/AS RESTRICTIVE FOR ALL TO authenticated\s+USING \(public\._phoenix_central_needs_role_eligible_v1\(\)\)/);
  });
});

describe('C4/M216 static — T1 admits only the stamp and the FK actor nulling; never a delete', () => {
  const t1 = sqlFunctionSource(SQL, '_phoenix_central_needs_region_version_guard_v1')!;

  it('refuses every DELETE unconditionally, first', () => {
    expect(t1).toMatch(/IF TG_OP = 'DELETE' THEN\s+RAISE EXCEPTION 'beneficiary_region_version_immutable'/);
  });

  it('INSERT: born ACTIVE, and only on a draft revision read under FOR SHARE', () => {
    const ins = between(t1, "IF TG_OP = 'INSERT' THEN", 'RETURN NEW;', 'insert arm');
    expect(ins).toMatch(/NEW\.retired_at IS NOT NULL OR NEW\.retired_by IS NOT NULL\s+OR NEW\.retirement_kind IS NOT NULL OR NEW\.retirement_reason IS NOT NULL/);
    expect(ins.indexOf('FOR SHARE')).toBeGreaterThan(0);
    expect(ins.indexOf('FOR SHARE')).toBeLessThan(ins.indexOf("IS DISTINCT FROM 'draft'"));
  });

  it('UPDATE admits exactly two shapes, each requiring every other column unchanged; everything else raises', () => {
    const upd = t1.slice(t1.indexOf('-- UPDATE (b)') >= 0 ? t1.indexOf('(to_jsonb(NEW) - v_actor_cols)') : 0);
    expect(t1).toContain("v_actor_cols constant text[] := ARRAY['decided_by', 'retired_by'];");
    expect(t1).toContain("v_stamp_cols constant text[] := ARRAY['retired_at', 'retired_by', 'retirement_kind', 'retirement_reason'];");
    expect(upd).toContain('(to_jsonb(NEW) - v_actor_cols) = (to_jsonb(OLD) - v_actor_cols)');
    expect(upd).toContain('(to_jsonb(NEW) - v_stamp_cols) = (to_jsonb(OLD) - v_stamp_cols)');
    const stamp = between(t1, '(to_jsonb(NEW) - v_stamp_cols) = (to_jsonb(OLD) - v_stamp_cols)', 'RETURN NEW;', 'stamp arm');
    expect(stamp).toMatch(/OLD\.retired_at IS NULL AND OLD\.retired_by IS NULL\s+AND OLD\.retirement_kind IS NULL AND OLD\.retirement_reason IS NULL/);
    expect(stamp).toMatch(/NEW\.retired_at IS NOT NULL AND NEW\.retired_by IS NOT NULL\s+AND NEW\.retirement_kind IN \('replaced', 'removed'\)/);
    expect(stamp.indexOf('FOR SHARE')).toBeLessThan(stamp.indexOf("IS DISTINCT FROM 'draft'"));
    // Exactly two RETURN NEW on the UPDATE path (b, a) plus one for INSERT; the fall-through raises.
    expect(t1.match(/RETURN NEW;/g)).toHaveLength(3);
    expect(t1.trimEnd()).toMatch(/RAISE EXCEPTION 'beneficiary_region_version_immutable'[\s\S]*END;\s*\$\$$/);
    expect(t1).not.toMatch(/RETURN OLD|RETURN NULL/);
  });
});

describe('C4/M216 static — behaviour-only replacements are verbatim M213 plus marked additions', () => {
  it('blockers: branches 1-12 byte-identical; branch 13 differs ONLY by the per-cell exclusion; 14-18 appended', () => {
    const b213 = rawFunction(M213, '_phoenix_central_needs_review_blockers_v1');
    const b216 = rawFunction(SQL, '_phoenix_central_needs_review_blockers_v1');
    const branch13 = '  -- 213 (independent review finding 1). A physical column carrying NUMERIC';
    const at = b213.indexOf(branch13);
    expect(at).toBeGreaterThan(0);
    // Branches 1-12 (and the signature) are an identical prefix.
    expect(b216.slice(0, at)).toBe(b213.slice(0, at));
    // The appended branches follow M213's own spacing: a blank line, then UNION ALL.
    const appended = b216.indexOf('\n\n  UNION ALL\n  -- 216 (14).');
    expect(appended).toBeGreaterThan(at);
    const exclusion =
      "         -- 216: the ONE change to this branch — a per-cell exclusion. A cell\n" +
      "         -- leaves it only when the safe extractor (the one blocker 14 uses)\n" +
      "         -- locates its sheet and column AND that column is region-governed;\n" +
      "         -- blocker 14 then owns the cell. A cell whose coordinates cannot be\n" +
      "         -- safely extracted is never excluded.\n" +
      "         AND NOT (SELECT g.column_governed\n" +
      "                    FROM public._phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) AS g)\n";
    const branch13In216 = without(b216.slice(at, appended), exclusion, 'branch 13 exclusion');
    // M213 ends branch 13 with ");" before "$$;"; M216 continues with UNION ALL.
    expect(branch13In216 + ';\n$$;\n').toBe(b213.slice(at));
    // The exclusion sits inside branch 13's inner WHERE, before its GROUP BY.
    const inner = between(b216.slice(at), 'WHERE s.plan_revision_id = p_plan_revision_id', 'GROUP BY', 'branch 13 inner');
    expect(inner).toContain('_phoenix_central_needs_resolve_region_v1');
    // Appended in order, each over ACTIVE versions, each detail session-first.
    const tail = b216.slice(appended);
    const codes = [...tail.matchAll(/SELECT '(\w+)',/g)].map((m) => m[1]);
    expect(codes).toEqual(['beneficiary_region_cell_uncovered', 'beneficiary_region_cell_without_need_line',
      'beneficiary_region_overlap', 'beneficiary_decision_grain_conflict', 'beneficiary_region_geometry_invalid']);
    for (const d of [...tail.matchAll(/format\('([^']+)'/g)].map((m) => m[1])) {
      expect(d.startsWith('session=%s sheet=%s'), d).toBe(true);
    }
    expect(tail).toContain("format('session=%s sheet=%s column=%s uncovered_numeric_cells_on_mapped_rows=%s first_uncovered_row=%s'");
    expect(tail).toContain("format('session=%s sheet=%s row=%s column=%s region=%s target_entity=%s source_record=%s'");
    expect(tail).toContain("format('session=%s sheet=%s region=%s other_region=%s'");
    expect(tail).toContain("format('session=%s sheet=%s column=%s mapping=%s region=%s'");
    expect(tail).toContain("format('session=%s sheet=%s region=%s reason=%s'");
    // Blocker 14 uses the same resolver (same safe extractor, same governed predicate) as the exclusion.
    const b14 = between(tail, "'beneficiary_region_cell_uncovered'", 'UNION ALL', 'blocker 14');
    expect(b14).toContain('_phoenix_central_needs_resolve_region_v1(r.import_session_id, r.source_provenance) g');
    expect(b14).toContain('AND g.column_governed');
    expect(b14).toContain('AND g.covering_count = 0');
    // Cell-grain rules keep M213's numeric predicate (CSV valueType gap stays C5).
    expect(b14).toContain("r.source_values->>'valueType' = 'number'");
    expect(b14).toContain("rm.decision          = 'mapped'");
    for (const clause of tail.split('UNION ALL').slice(1)) {
      if (/beneficiary_regions/.test(clause)) expect(clause, clause.slice(0, 80)).toContain('retired_at IS NULL');
    }
  });

  it('integrity: M213 body verbatim except the region branch, the per-line region clause and the T5\' condition', () => {
    const i213 = rawFunction(M213, '_phoenix_central_needs_assert_need_line_integrity_v1');
    let i216 = rawFunction(SQL, '_phoenix_central_needs_assert_need_line_integrity_v1');
    i216 = without(i216, '  v_bad_region record;\n  v_scope_session uuid;\n  v_scope_sheet   integer;\n', 'declare');
    const region = between(i216, "  ELSIF TG_TABLE_NAME = 'central_needs_beneficiary_regions' THEN\n",
      "  ELSIF TG_OP = 'DELETE' THEN\n    v_line_ids := ARRAY[OLD.need_line_id];", 'region branch');
    i216 = without(i216, region, 'region branch');
    const perLine = between(i216, '\n    -- 216 ADDITION (b)', '  END LOOP;\n\n  RETURN NULL;', 'per-line clause');
    i216 = without(i216, perLine, 'per-line clause');
    const t5 = between(i216, "    --\n    -- 216 T5'", 'OLD.column_index) THEN\n', "T5'") + 'OLD.column_index) THEN\n';
    i216 = i216.replace(t5, "    IF TG_OP = 'DELETE' AND cardinality(v_line_ids) > 0 THEN\n");
    expect(i216).toBe(i213);

    // What each addition does.
    expect(region).toMatch(/IF TG_OP = 'UPDATE' AND NOT \(OLD\.retired_at IS NULL AND NEW\.retired_at IS NOT NULL\) THEN\s+RETURN NULL;/);
    expect(region).toContain('_phoenix_central_needs_region_linked_cell_violations_v1(v_scope_session, v_scope_sheet)');
    expect(region).toContain("RAISE EXCEPTION 'beneficiary_region_in_use'");
    expect(perLine).toContain("RAISE EXCEPTION 'beneficiary_region_mapping_conflict'");
    expect(perLine).toContain('AND g.column_governed');
    expect(t5).toContain('AND NOT public._phoenix_central_needs_region_column_covered_v1(');
    // The unchanged M213 refusal text still follows the T5' condition.
    const after = rawFunction(SQL, '_phoenix_central_needs_assert_need_line_integrity_v1');
    expect(after.slice(after.indexOf("-- 216 T5'"))).toMatch(/OLD\.column_index\) THEN\n      RAISE EXCEPTION 'beneficiary_column_mapping_in_use' USING ERRCODE = '23514',/);
  });

  it('set_need_line: identical signature; M213 body verbatim except the marked per-cell grain generalization', () => {
    const s213 = rawFunction(M213, 'phoenix_central_needs_set_need_line');
    let s216 = rawFunction(SQL, 'phoenix_central_needs_set_need_line');
    s216 = without(s216, '  v_cell         record;\n', 'declare');
    const open = between(s216, '    -- =========================================================================\n    -- 216 GENERALIZATION',
      '    -- =========================================================================\n    -- 213 ADDITION', '216 open');
    s216 = without(s216, open, '216 open');
    s216 = without(s216, '    END IF;\n    -- ========================================================= end 216 generalization\n', '216 close');
    expect(s216).toBe(s213);
    // Order inside the generalization: (i) safe extraction, (iii) grain conflict, (v-a..d), then ELSE -> M213 path.
    const order = ['cell_sheet IS NULL OR v_cell.cell_col IS NULL', "'beneficiary_column_mapping_required'",
      'IF v_cell.column_governed THEN', "'beneficiary_decision_grain_conflict'", "'beneficiary_region_required'",
      "'beneficiary_region_overlap'", "'beneficiary_region_not_beneficiary'", "'beneficiary_region_mapping_conflict'", '    ELSE\n'];
    let last = -1;
    for (const token of order) {
      const at = open.indexOf(token, last + 1);
      expect(at, token).toBeGreaterThan(last);
      last = at;
    }
    expect(open.trimEnd().endsWith('ELSE')).toBe(true);
    expect(SQL).toContain('CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_need_line(\n  p_plan_revision_id            uuid,');
  });

  it('list_beneficiary_columns: same signature, 17 columns, SECURITY INVOKER; only review_required narrowed', () => {
    const l213 = rawFunction(M213, 'phoenix_central_needs_list_beneficiary_columns');
    const l216 = rawFunction(SQL, 'phoenix_central_needs_list_beneficiary_columns');
    const original =
      "    (m.id IS NULL\n" +
      "     AND count(*) FILTER (WHERE r.source_values->>'valueType' = 'number'\n" +
      "                            AND rm.decision = 'mapped' AND s.status = 'completed') > 0) AS review_required\n";
    const narrowed = between(l216, '    -- 216: narrowed exactly as blocker branch 13', 'AS review_required\n', 'narrowed') + 'AS review_required\n';
    expect(l216.replace(narrowed, original)).toBe(l213);
    expect(l216).toContain('SECURITY INVOKER');
    // The inlined extractor is the same predicate as the helper: plain-digit JSON number, column <= 16383.
    expect(narrowed).toContain("jsonb_typeof(r.source_provenance->'sheetIndex') = 'number'");
    expect(narrowed).toContain("(r.source_provenance->>'sheetIndex') ~ '^[0-9]{1,9}$'");
    expect(narrowed).toContain("(r.source_provenance->'coordinate'->>'col') ~ '^[0-9]{1,9}$'");
    expect(narrowed).toContain("(r.source_provenance->'coordinate'->>'col')::integer <= 16383");
    expect(narrowed).toContain('v.retired_at IS NULL');
    const helper = sqlFunctionSource(SQL, '_phoenix_central_needs_safe_coordinate_v1')!;
    expect(helper).toContain("jsonb_typeof(p_value) <> 'number'");
    expect(helper).toContain("v_text !~ '^[0-9]{1,9}$'");
    expect(helper).toContain('v_text::integer > p_ceiling');
  });
});

describe('C4/M216 static — the one write RPC', () => {
  const rpc = sqlFunctionSource(SQL, 'phoenix_central_needs_set_beneficiary_regions')!;
  const SIG = 'uuid, uuid, numeric, jsonb, text, uuid[], jsonb, text';

  it('is SECURITY DEFINER with a pinned search_path, EXECUTE for authenticated only, and is the only new public function', () => {
    expect(rpc).toMatch(/RETURNS jsonb\s+LANGUAGE plpgsql\s+SECURITY DEFINER\s+SET search_path = public, pg_temp/);
    expect(IMPL).toContain(`REVOKE ALL ON FUNCTION public.phoenix_central_needs_set_beneficiary_regions(\n  ${SIG}) FROM PUBLIC, anon;`);
    expect(IMPL).toContain(`GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_set_beneficiary_regions(\n  ${SIG}) TO authenticated;`);
    const created = [...EXEC.matchAll(/CREATE OR REPLACE FUNCTION public\.(\w+)\(/g)].map((m) => m[1]);
    const publicNew = created.filter((f) => !f.startsWith('_') && ![
      'phoenix_central_needs_set_need_line', 'phoenix_central_needs_list_beneficiary_columns'].includes(f));
    expect(publicNew).toEqual(['phoenix_central_needs_set_beneficiary_regions']);
  });

  it('every internal helper is revoked from PUBLIC, anon and authenticated', () => {
    for (const helper of ['_phoenix_central_needs_safe_coordinate_v1(jsonb, integer)', '_phoenix_central_needs_m213_coordinate_v1(text)',
      '_phoenix_central_needs_resolve_region_v1(uuid, jsonb)', '_phoenix_central_needs_region_linked_cell_violations_v1(uuid, integer)',
      '_phoenix_central_needs_region_column_covered_v1(uuid, integer, integer)', '_phoenix_central_needs_region_version_guard_v1()',
      '_phoenix_central_needs_assert_region_geometry_v1()', '_phoenix_central_needs_assert_need_line_integrity_v1()',
      '_phoenix_central_needs_review_blockers_v1(uuid)']) {
      expect(IMPL.replace(/\s+/g, ' '), helper).toContain(`REVOKE ALL ON FUNCTION public.${helper} FROM PUBLIC, anon, authenticated;`);
    }
  });

  it('keeps the binding phase order 1-18, with no write before step 13', () => {
    const steps = [
      "RAISE EXCEPTION 'not_authenticated'",
      '_phoenix_central_needs_load_revision_v1(p_plan_revision_id)',
      "_phoenix_central_needs_guard_v1(v_revision.organization_id, 'central_needs.edit')",
      '_phoenix_central_needs_assert_org_live_v1(v_revision.organization_id)',
      '_phoenix_central_needs_assert_draft_v1(v_revision.id, v_revision.status)',
      'o.revision_number > v_revision.revision_number',
      '_phoenix_central_needs_human_text_v1(p_reason)',
      "'beneficiary_region_expected_ids_required'",
      "'beneficiary_region_session_not_in_revision'",
      "'beneficiary_region_parser_identity_mismatch'",
      "'beneficiary_region_sheet_mismatch'",
      'IF v_active IS DISTINCT FROM v_expected THEN',
      "'beneficiary_region_bounds_invalid'",
      "'beneficiary_region_unknown'",
      "'beneficiary_region_no_matching_evidence'",
      "'beneficiary_region_duplicate'",
      "'beneficiary_region_conversion_requires_region'",
      'DELETE FROM public.central_needs_beneficiary_column_mappings',
      'UPDATE public.central_needs_beneficiary_regions',
      'INSERT INTO public.central_needs_beneficiary_regions',
      "'beneficiary_region_overlap'",
      "'beneficiary_region_column_already_decided'",
      '_phoenix_central_needs_region_linked_cell_violations_v1(v_session.id, v_sheet)',
      'INSERT INTO public.audit_logs',
      'RETURN jsonb_build_object(',
    ];
    let last = -1;
    for (const step of steps) {
      const at = rpc.indexOf(step, last + 1);
      expect(at, step).toBeGreaterThan(last);
      last = at;
    }
    const firstWrite = rpc.indexOf('DELETE FROM public.central_needs_beneficiary_column_mappings');
    expect(rpc.slice(0, firstWrite)).not.toMatch(/\b(INSERT INTO|UPDATE public\.|DELETE FROM)\b/);
    // The only M213 write is the fenced delete; never an insert or update.
    expect(rpc).not.toMatch(/(INSERT INTO|UPDATE) public\.central_needs_beneficiary_column_mappings/);
    // Every stamp precedes every insert.
    expect(rpc.lastIndexOf('UPDATE public.central_needs_beneficiary_regions'))
      .toBeLessThan(rpc.indexOf('INSERT INTO public.central_needs_beneficiary_regions'));
  });

  it('writes no quantity, unit, material, warehouse or need-line data and never touches need lines', () => {
    expect(rpc).not.toMatch(/central_needs_need_lines|central_needs_need_line_sources|approved_quantity|central_item_id|target_warehouse_id/);
  });

  it('writes exactly the four audit actions, one row per change and per converted column', () => {
    expect(rpc).toContain("'central_needs.beneficiary_column.converted_to_regions'");
    expect(rpc).toContain("'central_needs.beneficiary_region.' || v_op");
    expect(rpc).toContain("'central_needs_beneficiary_region'");
    expect(rpc).toContain("'central_needs_beneficiary_column_mapping'");
    expect(rpc.match(/INSERT INTO public\.audit_logs/g)).toHaveLength(2);
    for (const key of ['plan_revision_id', 'import_session_id', 'sheet_index', 'operation_batch_id', 'expected_version_ids',
      'region_id', 'previous_version_id', 'new_version_id', 'previous_bounds', 'previous_decision',
      'previous_beneficiary_organization_id', 'new_bounds', 'new_decision', 'new_beneficiary_organization_id', 'reason',
      'column_index', 'retired_mapping', 'new_version_ids']) {
      expect(rpc, key).toContain(`'${key}'`);
    }
    for (const key of ['id', 'decision', 'beneficiary_organization_id', 'source_field_name', 'mapping_reason', 'mapped_by', 'mapped_at']) {
      expect(rpc, `snapshot ${key}`).toMatch(new RegExp(`'${key}', v_mapping\\.${key}`));
    }
    // No trigger writes audit.
    for (const fn of ['_phoenix_central_needs_region_version_guard_v1', '_phoenix_central_needs_assert_region_geometry_v1',
      '_phoenix_central_needs_assert_need_line_integrity_v1']) {
      expect(sqlFunctionSource(SQL, fn)!, fn).not.toContain('audit_logs');
    }
  });

  it('the M213 fence is null-safe and exact, and optional scope witnesses must equal the call scope', () => {
    expect(rpc).toContain('v_mapping.beneficiary_organization_id IS DISTINCT FROM (v_n->>\'previousBeneficiaryOrganizationId\')::uuid');
    expect(rpc).toContain('v_mapping.mapped_at IS DISTINCT FROM (v_n->>\'previousMappedAt\')::timestamptz');
    expect(rpc).toContain("(v_item->>'importSessionId')::uuid IS DISTINCT FROM p_import_session_id");
    expect(rpc).toContain("(v_item->>'sheetIndex')::numeric IS DISTINCT FROM p_sheet_index");
  });
});

describe('C4/M216 static — VERIFY', () => {
  it('asserts the contract\'s VERIFY list', () => {
    for (const needle of [
      'relrowsecurity AND relforcerowsecurity',
      "'TRUNCATE'",
      'NOT polpermissive',
      'central_needs_beneficiary_regions_active_region_uidx',
      'central_needs_beneficiary_regions_active_geometry_uidx',
      'a plain (non-partial) geometry uniqueness exists',
      'T1 missing', 'T2 missing', 'T3 missing', 'T4 missing',
      "ARRAY['assert_beneficiary_region_grain', 'assert_need_line_integrity', 'set_updated_at']",
      "current_setting('phoenix_m216.m213_surface', true)",
      'SECURITY INVOKER',
      "module = 'central_needs'",
      'migration must not create any region version',
      'review_readiness must stay VOLATILE',
    ]) {
      expect(SQL, needle).toContain(needle);
    }
    expect(VERIFY).toContain('beneficiary_column_mapping_in_use');
    expect(VERIFY).toContain('beneficiary_region_geometry_invalid');
  });
});
