/**
 * DEMO-PURGE-AUTH-BOUNDARY-200 — STATIC contract of the migration SOURCE.
 *
 * Reads the committed SQL and proves the shape of the correction without a
 * database, so a structural regression is caught even where no rig is
 * available. The behavioural proof lives in the sibling .dynamic test.
 */
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const HERE = dirname(fileURLToPath(import.meta.url));
const SQL = readFileSync(
  join(HERE, '..', '200_phoenix_demo_purge_auth_boundary_correction.sql'), 'utf8');

/**
 * The migration with whole-line `--` comments removed.
 *
 * Occurrence counts and forbidden-pattern checks MUST run against executable
 * SQL, not against prose. This migration's header deliberately explains the
 * defect by quoting migration 141's own
 *     GRANT USAGE ON SCHEMA auth TO phoenix_demo_purger;
 * and names SECURITY DEFINER repeatedly while describing the design — none of
 * which is a statement. Asserting over the raw file would make the test
 * measure documentation, so that the more carefully the migration explained
 * itself the more likely it would be to fail.
 */
const CODE = SQL.split('\n').filter((l) => !/^\s*--/.test(l)).join('\n');

describe('200 demo-purge auth boundary — static', () => {
  it('is transactional', () => {
    expect(SQL).toMatch(/^\s*BEGIN;/m);
    expect(SQL.trimEnd()).toMatch(/COMMIT;$/);
  });

  it('does not edit any already-applied migration, and adds exactly one internal routine', () => {
    // The correction must be forward-only: no DROP of the public entry point,
    // and no attempt to re-run a historical migration's statements.
    expect(SQL).not.toMatch(/DROP\s+FUNCTION\s+public\.phoenix_demo_purge/i);
    const created = SQL.match(/CREATE OR REPLACE FUNCTION public\.(\w+)/g) ?? [];
    expect(created).toHaveLength(2);
    expect(created.join(' ')).toContain('_phoenix_200_demo_purge_execute');
    expect(created.join(' ')).toContain('phoenix_demo_purge');
  });

  it('keeps the public signature and result shape byte-for-byte', () => {
    expect(SQL).toMatch(
      /CREATE OR REPLACE FUNCTION public\.phoenix_demo_purge\(\s*\n?\s*p_dataset_key text,\s*\n?\s*p_dry_run\s+boolean DEFAULT true\s*\n?\)/);
    const results = SQL.match(/RETURNS TABLE\(table_name text, affected bigint, executed boolean\)/g) ?? [];
    expect(results).toHaveLength(2);   // wrapper and executor agree
  });

  it('owns the wrapper by postgres and the executor by phoenix_demo_purger', () => {
    expect(SQL).toMatch(
      /ALTER FUNCTION public\.phoenix_demo_purge\(text, boolean\)\s+OWNER TO postgres;/);
    expect(SQL).toMatch(
      /ALTER FUNCTION public\._phoenix_200_demo_purge_execute\(text, boolean\)\s*\n?\s*OWNER TO phoenix_demo_purger;/);
  });

  it('makes both routines SECURITY DEFINER with the M198-converged search_path', () => {
    // The DECLARATION form only — `SECURITY DEFINER` alone on its line. The
    // VERIFY block also names it inside a RAISE message, which is a string
    // literal, not a third definer routine.
    const secdef = CODE.match(/^SECURITY DEFINER$/gm) ?? [];
    expect(secdef).toHaveLength(2);
    const sp = CODE.match(/SET search_path TO 'public', 'pg_temp'/g) ?? [];
    expect(sp).toHaveLength(2);
  });

  it('revokes the executor from every client-facing role, service_role included', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\._phoenix_200_demo_purge_execute\(text, boolean\)\s*\n?\s*FROM PUBLIC, anon, authenticated, service_role;/);
    // The platform's default privileges re-grant service_role at CREATE time,
    // so the revoke must be asserted, not assumed.
    expect(SQL).toMatch(/ALTER DEFAULT PRIVILEGES[\s\S]{0,200}service_role/);
  });

  it('grants the executor only to the wrapper definer context', () => {
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\._phoenix_200_demo_purge_execute\(text, boolean\)\s*\n?\s*TO postgres;/);
  });

  it('preserves the public entry point ACL exactly as 140/141/143 left it', () => {
    expect(SQL).toMatch(
      /REVOKE ALL ON FUNCTION public\.phoenix_demo_purge\(text, boolean\) FROM PUBLIC, anon;/);
    expect(SQL).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.phoenix_demo_purge\(text, boolean\) TO authenticated;/);
  });

  it('keeps every caller-authorization clause in the WRAPPER only', () => {
    const wrapper = SQL.slice(SQL.indexOf('CREATE OR REPLACE FUNCTION public.phoenix_demo_purge('));
    for (const clause of ['auth.uid()', 'phoenix_my_role()', 'not_authenticated',
      'forbidden_demo_purge', 'dataset_key_required', 'invalid_demo_dataset_key']) {
      expect(wrapper).toContain(clause);
    }
  });

  it('keeps the EXECUTOR free of auth and of any caller-role check', () => {
    const start = SQL.indexOf('CREATE OR REPLACE FUNCTION public._phoenix_200_demo_purge_execute(');
    const end = SQL.indexOf('ALTER FUNCTION public._phoenix_200_demo_purge_execute');
    const executor = SQL.slice(start, end);
    expect(executor).not.toMatch(/auth\./);
    expect(executor).not.toContain('phoenix_my_role');
    expect(executor).not.toContain('forbidden_demo_purge');
    expect(executor).not.toContain('not_authenticated');
  });

  it('carries the whole purge algorithm into the executor, not a stub', () => {
    const start = SQL.indexOf('CREATE OR REPLACE FUNCTION public._phoenix_200_demo_purge_execute(');
    const end = SQL.indexOf('ALTER FUNCTION public._phoenix_200_demo_purge_execute');
    const executor = SQL.slice(start, end);
    for (const piece of ['phoenix_demo_purgeable_tables', 'phoenix_demo_manifest_row_ids',
      'phoenix_demo_detach_profiles', 'phoenix_demo_org_blockers', 'profiles:detached',
      'organizations:blocked', 'restrict_violation', 'foreign_key_violation',
      'phoenix_demo_manifest']) {
      expect(executor).toContain(piece);
    }
  });

  it('never grants any new privilege on schema auth', () => {
    // Executable SQL only: the header quotes 141's failed grant on purpose.
    expect(CODE).not.toMatch(/GRANT[^;]*ON SCHEMA auth/i);
    expect(CODE).not.toMatch(/ALTER DEFAULT PRIVILEGES[^;]*auth/i);
  });

  it('verifies its own outcome instead of trusting the statements', () => {
    expect(SQL).toMatch(/DO \$verify\$/);
    for (const assertion of [
      'wrapper owner is', 'executor owner is', 'SECURITY DEFINER',
      'search_path must be', 'references schema auth',
      'reachable by anon/authenticated', 'reachable by service_role',
      'PUBLIC grant',
    ]) {
      expect(SQL).toContain(assertion);
    }
  });

  it('fails closed on its own preconditions', () => {
    expect(SQL).toMatch(/DO \$precond\$/);
    expect(SQL).toContain('lacks USAGE on schema auth');
    expect(SQL).toContain('is not a member of phoenix_demo_purger');
  });

  it('creates no table, index, policy, sequence or business write', () => {
    for (const forbidden of [/CREATE TABLE/i, /CREATE INDEX/i, /CREATE POLICY/i,
      /CREATE SEQUENCE/i, /\bINSERT INTO\b/i, /\bUPDATE public\./i]) {
      expect(CODE).not.toMatch(forbidden);
    }
  });
});
