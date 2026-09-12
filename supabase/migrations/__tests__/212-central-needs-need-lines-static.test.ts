/**
 * CN-2B CONFORMANCE (212) — STATIC guard over the migration's executable SQL.
 *
 * Asserts against SQL with comments stripped, so prose can never satisfy a
 * check, and against string-blanked SQL for negative assertions, so a phrase
 * inside a RAISE message can never masquerade as the thing it forbids.
 */
import { describe, it, expect } from 'vitest';
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
const WRITE_SIG = 'uuid, uuid, uuid, numeric, text, text, text, uuid, text, jsonb';

describe('CN-2B/212 static — registration and file hygiene', () => {
  it('is registered at 212 and is now the ceiling', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files.indexOf(FILENAME)).toBe(211);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 212)).toEqual([]);
    expect(files).toHaveLength(212);
    expect(isReviewedMigrationFile(FILENAME)).toBe(true);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(FILENAME);
    expect(getMaximumReviewedMigrationNumber()).toBe(212);
    expect(getNextUnreviewedMigrationNumber()).toBe(213);
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

  it('keeps target_warehouse_id optional and out of the accounting key', () => {
    expect(IMPL).toMatch(/target_warehouse_id\s+uuid REFERENCES public\.warehouses\(id\)/);
    expect(IMPL).not.toMatch(/target_warehouse_id\s+uuid NOT NULL/);
    expect(IMPL).toContain('UNIQUE (plan_revision_id, beneficiary_organization_id, central_item_id)');
    const key = IMPL.slice(IMPL.indexOf('central_needs_need_lines_scope_key'));
    expect(key.slice(0, 160)).not.toContain('target_warehouse_id');
  });

  it('stores the approved quantity as exact numeric, never float, and never negative', () => {
    expect(IMPL).toContain('approved_quantity           numeric(20,3) NOT NULL');
    expect(IMPL).toContain('CHECK (approved_quantity >= 0)');
    for (const bad of ['double precision', 'real', 'float']) {
      expect(EXEC, bad).not.toContain(bad);
    }
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

  it('lets one source row feed at most one need line', () => {
    expect(IMPL).toContain('UNIQUE (import_session_id, target_entity)');
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
  });

  it('uses the canonical org authorization helper, never the scoped-permission one', () => {
    expect(IMPL).toContain('_phoenix_central_needs_guard_v1');
    expect(EXEC).not.toContain('phoenix_profile_has_scoped_permission');
  });

  it('pins search_path on every function it defines and keeps internals off the client', () => {
    const defs = [...EXEC.matchAll(/CREATE OR REPLACE FUNCTION public\.([a-z_0-9]+)\(/g)].map((m) => m[1]);
    expect(defs).toContain(WRITE_RPC);
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
