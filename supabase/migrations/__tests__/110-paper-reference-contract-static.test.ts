/**
 * PAPER-REFERENCE-CONTRACT-STATIC — registration + discipline contract tests
 * for 110. The behavioral proof is
 * 110-paper-reference-contract.dynamic.test.ts (real Postgres, 001->110
 * replay).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { REVIEWED_MIGRATION_FILES } from './helpers/reviewed-migrations';

const ROOT = join(__dirname, '../../../');
const NAME = '110_phoenix_paper_reference_contract.sql';

const load = (name: string) => {
  const sql = readFileSync(join(ROOT, 'supabase/migrations', name), 'utf8').replace(/\r\n?/g, '\n');
  const code = sql.slice(sql.indexOf('BEGIN;'), sql.indexOf('\nCOMMIT;')).replace(/^[ \t]*--.*$/gm, '');
  return { sql, code };
};

describe('registration and manual-apply discipline', () => {
  it('110 is registered and manual-apply-only', () => {
    expect(REVIEWED_MIGRATION_FILES).toContain(NAME);
    const { sql } = load(NAME);
    expect(sql).toContain('MANUAL APPLY ONLY');
    expect(sql).toMatch(/^BEGIN;/m);
    expect(sql).toMatch(/^COMMIT;/m);
  });
});

describe('110 — paper reference contract', () => {
  const { code } = load(NAME);

  it('adds exactly one new table: phoenix_paper_references (no duplicate columns on 5 tables)', () => {
    const tables = code.match(/CREATE TABLE public\.(\w+)/g) ?? [];
    expect(tables).toEqual(['CREATE TABLE public.phoenix_paper_references']);
    // None of the pre-existing document tables are ALTERed to add paper_reference_* columns.
    expect(code).not.toMatch(/ALTER TABLE public\.warehouse_dispatches/);
    expect(code).not.toMatch(/ALTER TABLE public\.warehouse_return_requests/);
    expect(code).not.toMatch(/ALTER TABLE public\.outlet_return_requests/);
    expect(code).not.toMatch(/ALTER TABLE public\.phoenix_stock_correction_requests/);
    expect(code).not.toMatch(/ALTER TABLE public\.warehouse_stock_movements/);
  });

  it('the four required optional fields are all nullable (no NOT NULL)', () => {
    const bodyIdx = code.indexOf('CREATE TABLE public.phoenix_paper_references');
    const body = code.slice(bodyIdx, code.indexOf(');', bodyIdx));
    for (const col of ['paper_reference_number', 'paper_reference_date', 'issuing_authority', 'paper_reference_notes']) {
      const line = body.split('\n').find((l) => l.trim().startsWith(col));
      expect(line, `${col} column present`).toBeTruthy();
      expect(line).not.toMatch(/NOT NULL/);
    }
  });

  it('RLS is enabled with a SELECT-only, org-scoped policy — no direct INSERT/UPDATE/DELETE policy', () => {
    expect(code).toMatch(/ALTER TABLE public\.phoenix_paper_references ENABLE ROW LEVEL SECURITY/);
    expect(code).toMatch(/CREATE POLICY phoenix_paper_references_select_scoped[\s\S]*?FOR SELECT TO authenticated/);
    expect(code).not.toMatch(/FOR (INSERT|UPDATE|DELETE) TO authenticated/);
  });

  it('explicit REVOKE ALL from PUBLIC/anon/authenticated then a minimal SELECT-only GRANT — fail-closed posture', () => {
    expect(code).toMatch(/REVOKE ALL ON TABLE public\.phoenix_paper_references FROM PUBLIC, anon, authenticated/);
    expect(code).toMatch(/GRANT SELECT ON TABLE public\.phoenix_paper_references TO authenticated/);
  });

  it('phoenix_set_paper_reference is the only writer and is SECURITY DEFINER with a pinned search_path', () => {
    const fnIdx = code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_set_paper_reference');
    expect(fnIdx).toBeGreaterThan(-1);
    const fnBlock = code.slice(fnIdx, code.indexOf('$$;', fnIdx) + 3);
    expect(fnBlock).toMatch(/SECURITY DEFINER/);
    expect(fnBlock).toMatch(/SET search_path = public, pg_temp/);
    expect(code).toMatch(/REVOKE ALL ON FUNCTION public\.phoenix_set_paper_reference\([^)]*\) FROM PUBLIC, anon/);
    expect(code).toMatch(/GRANT EXECUTE ON FUNCTION public\.phoenix_set_paper_reference\([^)]*\) TO authenticated/);
  });

  it('the internal document-context helper is NOT granted to authenticated (cross-org oracle guard)', () => {
    expect(code).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_paper_reference_document_context\(text, uuid\) FROM PUBLIC, anon, authenticated/,
    );
    expect(code).not.toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_paper_reference_document_context[\s\S]*?TO authenticated/,
    );
  });

  it('duplicate detection is a warn (possible_duplicate in the return), never a hard unique constraint on the number', () => {
    expect(code).toMatch(/possible_duplicate/);
    expect(code).not.toMatch(/CREATE UNIQUE INDEX[\s\S]*?normalized_reference/);
  });

  it('every duplicate/search query is scoped by organization_id — no cross-org read path', () => {
    const dupBlockIdx = code.indexOf('IF v_number IS NOT NULL THEN');
    const dupBlock = code.slice(dupBlockIdx, code.indexOf('END IF;', dupBlockIdx));
    expect(dupBlock).toMatch(/pr\.organization_id = v_org/);

    const searchIdx = code.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_search_paper_reference');
    const searchBlock = code.slice(searchIdx, code.indexOf('$$;', searchIdx));
    expect(searchBlock).toMatch(/phoenix_my_role\(\) = 'super_admin' OR pr\.organization_id = v_org/);
  });

  it('editability is re-derived server-side per call (draft/pending/settable-once), not a client flag', () => {
    expect(code).toMatch(/status = 'draft'/);
    expect(code).toMatch(/status = 'pending'/);
    expect(code).toMatch(/paper_reference_locked_document_not_editable/);
  });
});
