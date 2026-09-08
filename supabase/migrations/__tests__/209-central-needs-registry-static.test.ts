/**
 * CN-1A / M209 — CENTRAL NEEDS CORE REGISTRY — static contract.
 *
 * Reads the migration as TEXT. The behavioural proof (real replay, real RLS
 * enforcement, real permission grants) lives in the .dynamic suite; this file
 * guards the properties no runtime assertion can recover once the file is
 * edited: that M209 is schema/RLS/permission-only (no RPC, no parser
 * assumption, no movement/stock touch), and that it is registered correctly
 * in every migration-governance guard.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import { join } from 'path';
import {
  REVIEWED_MIGRATION_FILES, getMaximumReviewedMigrationNumber, getNextUnreviewedMigrationNumber,
  isReviewedMigrationFile,
} from './helpers/reviewed-migrations';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '209_phoenix_central_needs_registry.sql';
const SQL = readFileSync(join(MIGRATIONS, FILENAME), 'utf8');

/** Statement text with comments stripped, so prose can never satisfy a check. */
const CODE = SQL.replace(/--[^\n]*/g, ' ');
const BODY = CODE.slice(CODE.indexOf('BEGIN;'), CODE.indexOf('\nCOMMIT;'));

const TABLES = [
  'central_needs_plans',
  'central_needs_plan_revisions',
  'central_needs_source_files',
  'central_needs_import_sessions',
  'central_needs_field_overrides',
];

describe('CN-1A/209 static — registration and file hygiene', () => {
  it('is registered at 209, the new ceiling, with 210 stays absent', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files).toContain(FILENAME);
    expect(files.indexOf(FILENAME)).toBe(208);
    expect(files.filter((f) => Number(f.slice(0, 3)) > 209)).toEqual([]);
    expect(files).toHaveLength(209);
    expect(isReviewedMigrationFile(FILENAME)).toBe(true);
    expect(REVIEWED_MIGRATION_FILES[REVIEWED_MIGRATION_FILES.length - 1]).toBe(FILENAME);
    expect(getMaximumReviewedMigrationNumber()).toBe(209);
    expect(getNextUnreviewedMigrationNumber()).toBe(210);
  });

  it('carries no CR bytes — LF only', () => {
    expect(SQL.includes('\r')).toBe(false);
  });

  it('is a single transaction, never rolls itself back, no MANUAL APPLY ONLY banner', () => {
    expect(SQL).toContain('BEGIN;');
    expect(SQL.trimEnd().endsWith('COMMIT;') || SQL.includes('\nCOMMIT;\n')).toBe(true);
    expect((SQL.match(/^BEGIN;/gm) ?? []).length).toBe(1);
    expect((SQL.match(/^COMMIT;/gm) ?? []).length).toBe(1);
    expect(BODY).not.toMatch(/\bROLLBACK\b/);
    expect(SQL).not.toMatch(/MANUAL APPLY ONLY/i);
  });

  it('touches no historical migration file — self-contained', () => {
    const others = readdirSync(MIGRATIONS).filter((f) => f.endsWith('.sql') && f !== FILENAME);
    expect(others).toHaveLength(208);
  });
});

describe('CN-1A/209 static — schema shape', () => {
  it('creates exactly the five Central Needs tables, no others', () => {
    const created = [...BODY.matchAll(/CREATE TABLE public\.(\w+)/g)].map((m) => m[1]);
    expect(created.sort()).toEqual([...TABLES].sort());
  });

  it('every table has organization_id NOT NULL referencing organizations(id) ON DELETE RESTRICT', () => {
    for (const t of TABLES) {
      const start = BODY.indexOf(`CREATE TABLE public.${t}`);
      expect(start, t).toBeGreaterThan(-1);
      const end = BODY.indexOf(');', start);
      const tableBody = BODY.slice(start, end);
      expect(tableBody, t).toMatch(/organization_id\s+uuid NOT NULL REFERENCES public\.organizations\(id\) ON DELETE RESTRICT/);
    }
  });

  it('carries no sheet/row/column NOT NULL assumption anywhere — parser-independence', () => {
    expect(BODY).not.toMatch(/\bsheet_name\b/i);
    expect(BODY).not.toMatch(/\brow_number\b/i);
    expect(BODY).not.toMatch(/\bcolumn_number\b/i);
  });

  it('drops nothing — purely additive', () => {
    expect(BODY).not.toMatch(/\bDROP\s+TABLE\b/i);
    expect(BODY).not.toMatch(/\bDROP\s+COLUMN\b/i);
    expect(BODY).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(BODY).not.toMatch(/\bTRUNCATE\b/i);
    expect(BODY).not.toMatch(/\bALTER\s+TABLE\s+public\.(?!central_needs_)/i);
  });

  it('central_needs_source_files is immutable: a locked-down trigger function blocks every UPDATE', () => {
    expect(BODY).toMatch(/CREATE OR REPLACE FUNCTION public\._phoenix_central_needs_source_immutability_v1\(\)/);
    expect(BODY).toMatch(/RAISE EXCEPTION 'central_needs_source_file_immutable'/);
    expect(BODY).toMatch(/REVOKE ALL ON FUNCTION public\._phoenix_central_needs_source_immutability_v1\(\) FROM PUBLIC, anon, authenticated;/);
    expect(BODY).toMatch(/CREATE TRIGGER central_needs_source_files_immutable\s+BEFORE UPDATE ON public\.central_needs_source_files/);
  });

  it('the plan_revisions approval-pair CHECK requires an approver whenever status is approved', () => {
    expect(BODY).toMatch(/central_needs_plan_revisions_approval_pair_chk/);
    expect(BODY).toMatch(/status <> 'approved' OR approved_by IS NOT NULL/);
  });
});

describe('CN-1A/209 static — no RPC, no client write path', () => {
  it('defines no public RPC — only the internal immutability trigger function', () => {
    const functions = [...BODY.matchAll(/CREATE OR REPLACE FUNCTION (public\.\w+)/g)].map((m) => m[1]);
    expect(functions).toEqual(['public._phoenix_central_needs_source_immutability_v1']);
  });

  it('revokes INSERT/UPDATE/DELETE from authenticated on every table, grants only SELECT', () => {
    for (const t of TABLES) {
      expect(BODY, t).toMatch(new RegExp(`REVOKE INSERT, UPDATE, DELETE ON TABLE public\\.${t} FROM authenticated;`));
      expect(BODY, t).toMatch(new RegExp(`GRANT SELECT ON TABLE public\\.${t} TO authenticated;`));
      expect(BODY, t).not.toMatch(new RegExp(`GRANT (INSERT|UPDATE|DELETE)[^;]*ON TABLE public\\.${t}`, 'i'));
    }
  });

  it('revokes everything from anon and PUBLIC on every table', () => {
    for (const t of TABLES) {
      expect(BODY, t).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM PUBLIC;`));
      expect(BODY, t).toMatch(new RegExp(`REVOKE ALL ON TABLE public\\.${t} FROM anon;`));
    }
  });

  it('enables and forces RLS on every table', () => {
    for (const t of TABLES) {
      expect(BODY, t).toMatch(new RegExp(`ALTER TABLE public\\.${t} ENABLE ROW LEVEL SECURITY;`));
      expect(BODY, t).toMatch(new RegExp(`ALTER TABLE public\\.${t} FORCE ROW LEVEL SECURITY;`));
    }
  });

  it('every SELECT policy calls phoenix_status_center_authorized with central_needs.view — never phoenix_profile_has_scoped_permission', () => {
    for (const t of TABLES) {
      expect(BODY, t).toMatch(new RegExp(
        `CREATE POLICY ${t}_select_authorized\\s+ON public\\.${t} FOR SELECT TO authenticated\\s+USING \\(public\\.phoenix_status_center_authorized\\(organization_id, 'central_needs\\.view'\\)\\);`,
      ));
    }
    expect(BODY).not.toMatch(/phoenix_profile_has_scoped_permission/);
  });

  it('no table has an INSERT, UPDATE or DELETE policy', () => {
    expect(BODY).not.toMatch(/FOR (INSERT|UPDATE|DELETE)/);
  });
});

describe('CN-1A/209 static — permission keys, no default grants', () => {
  it('declares exactly the four central_needs.* permission keys', () => {
    const insertStart = BODY.indexOf("INSERT INTO public.permission_keys");
    expect(insertStart).toBeGreaterThan(-1);
    const insertEnd = BODY.indexOf(';', insertStart);
    const insertStatement = BODY.slice(insertStart, insertEnd);
    for (const key of ['central_needs.view', 'central_needs.import', 'central_needs.edit', 'central_needs.approve']) {
      expect(insertStatement, key).toContain(`'${key}'`);
    }
    expect(insertStatement).not.toContain('central_needs.send');
    expect(insertStatement).toContain('ON CONFLICT (key) DO NOTHING');
  });

  it('inserts no role_permission_defaults row for central_needs.* — access is opt-in only', () => {
    expect(BODY).not.toMatch(/INSERT INTO public\.role_permission_defaults/);
  });
});

describe('CN-1A/209 static — self-verification', () => {
  it('ends with a DO $verify$ block asserting tables, RLS, permission-key count and the immutability trigger', () => {
    expect(SQL).toMatch(/DO \$verify\$/);
    expect(SQL).toMatch(/VERIFY FAILED \(209\)/);
    expect(SQL).toMatch(/central_needs\.%.*must have zero default role grants|zero default role grants/);
  });
});
