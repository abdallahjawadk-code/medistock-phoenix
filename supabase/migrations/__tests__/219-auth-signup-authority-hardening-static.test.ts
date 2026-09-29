/**
 * AUTH-1 / M219 — STATIC guard over the sign-up authority hardening.
 *
 * Proves, from the migration text alone, the frozen shape of M219. The dynamic
 * PostgreSQL suite (219-auth-signup-authority-hardening.dynamic.test.ts) is
 * the behavioural proof; this suite pins what the file may and may not do:
 *
 *   * registration and hygiene: the canonical filename, the only file above
 *     218, one BEGIN;/COMMIT;, LF only;
 *   * the activation shape: search_path pinned first, the fail-closed prelude
 *     (idempotence, the six-role CHECK, the 091 trigger body by md5, the
 *     trigger binding, the 182 provisioning contract, the M196
 *     get_effective_permissions body by sha256, the owner) before any lock;
 *   * the exact DDL inventory: ONE ALTER TABLE on profiles (role CHECK plus
 *     the pending shape CHECK), THREE function replacements, no GRANT, REVOKE,
 *     DROP FUNCTION, trigger, policy or permission default;
 *   * phoenix_handle_new_user reads only full_name from user metadata and
 *     inserts the pending_provisioning / suspended / no-organization placeholder;
 *   * phoenix_admin_provision_profile is the M182 body with only the
 *     placeholder test changed; get_effective_permissions is the M196 body
 *     with only the NULL-organization scope predicate changed;
 *   * the authority helpers phoenix_my_role / phoenix_my_org are untouched;
 *   * VERIFY covers every contract above.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executableSql, normalizeSql, stripSqlComments } from './helpers/sql-source';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '219_phoenix_auth_signup_authority_hardening.sql';
const PRESENT = existsSync(join(MIGRATIONS, FILENAME));
const SQL = PRESENT ? readFileSync(join(MIGRATIONS, FILENAME), 'utf8') : '';
const CODE = stripSqlComments(SQL);
const EXEC = executableSql(SQL);
const VERIFY_AT = CODE.indexOf('DO $verify$');
const VERIFY = VERIFY_AT >= 0 ? CODE.slice(VERIFY_AT) : '';

const M182 = readFileSync(join(MIGRATIONS, '182_phoenix_health_center_facility_scoped_rbac.sql'), 'utf8');
const M196 = readFileSync(join(MIGRATIONS, '196_phoenix_secdef_relation_schema_qualification.sql'), 'utf8');

const PROVISION = 'CREATE OR REPLACE FUNCTION public.phoenix_admin_provision_profile(';
const HANDLE = 'CREATE OR REPLACE FUNCTION public.phoenix_handle_new_user()';
const GEP = 'CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_profile_id uuid)';
const OLD_SCOPE = 'v_target_org is distinct from v_org';
const NEW_SCOPE = 'not coalesce(v_target_org = v_org, false)';

/** The full `CREATE ... $function$ ... $function$` statement that starts with `head` (the LAST one in `text`). */
function functionStatement(text: string, head: string): string {
  const at = text.lastIndexOf(head);
  if (at < 0) return '';
  const open = text.indexOf('$function$', at);
  const close = text.indexOf('$function$', open + '$function$'.length);
  return text.slice(at, close + '$function$'.length);
}
/** The body between the dollar quotes. */
function functionBody(text: string, head: string): string {
  const stmt = functionStatement(text, head);
  const open = stmt.indexOf('$function$') + '$function$'.length;
  return stmt.slice(open, stmt.lastIndexOf('$function$'));
}
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');

describe.runIf(PRESENT)('M219 static — sign-up authority hardening', () => {
  it('219 is the next migration after 218 and the only file above 218; LF only; one BEGIN/COMMIT', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files.filter((f) => Number(f.slice(0, 3)) > 218)).toEqual([FILENAME]);
    expect(SQL.includes('\r')).toBe(false);
    expect(EXEC.match(/^\s*BEGIN\s*;/gim)).toHaveLength(1);
    expect(EXEC.match(/^\s*COMMIT\s*;/gim)).toHaveLength(1);
    expect(EXEC.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('pins search_path first and runs the fail-closed prelude before any lock or DDL', () => {
    const searchPath = EXEC.indexOf('SET LOCAL search_path = pg_catalog, pg_temp;');
    const prelude = EXEC.indexOf('DO $prelude$');
    const lock = EXEC.indexOf('LOCK TABLE public.profiles IN ACCESS EXCLUSIVE MODE;');
    const firstDdl = EXEC.search(/ALTER TABLE|CREATE OR REPLACE FUNCTION/);
    expect(searchPath).toBeGreaterThan(0);
    expect(searchPath).toBeLessThan(prelude);
    expect(prelude).toBeLessThan(lock);
    expect(lock).toBeLessThan(firstDdl);
    const pre = CODE.slice(CODE.indexOf('DO $prelude$'), CODE.indexOf('$prelude$;'));
    for (const needle of [
      "'219_already_applied'",
      "'219_precondition_failed: profiles_role_check is not the six-role 182 definition'",
      "'4c34bbc7cd5fb01205418c6287086365'",
      "'219_precondition_failed: on_auth_user_created is not the AFTER INSERT row trigger bound to phoenix_handle_new_user'",
      "or v_target_role is distinct from ''outlet_officer'' or v_target_status is distinct from ''active''",
      "'2b3bbd879c22b8ea578532dee65ee7922163cbe925c2ae2093bfa48b3bacff96'",
      "'219_precondition_failed: pending_provisioning is already in use'",
      "'219_precondition_failed: M219 must be applied by the owner of public.profiles and of every replaced function'",
    ]) {
      expect(pre, needle).toContain(needle);
    }
    expect(EXEC.match(/SET\s+LOCAL\s+\w+/gi)?.map((s) => normalizeSql(s)))
      .toEqual(['SET LOCAL search_path', 'SET LOCAL lock_timeout', 'SET LOCAL statement_timeout']);
  });

  it('has exactly the reviewed DDL inventory and nothing else', () => {
    const created = [...EXEC.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_.]+)\s*\(/gi)].map((m) => m[1]);
    expect(created).toEqual([
      'public.phoenix_handle_new_user', 'public.phoenix_admin_provision_profile', 'public.get_effective_permissions',
    ]);
    expect(EXEC.match(/ALTER\s+TABLE/gi)).toHaveLength(1);
    expect(normalizeSql(CODE)).toContain(normalizeSql(`ALTER TABLE public.profiles
      DROP CONSTRAINT profiles_role_check,
      ADD CONSTRAINT profiles_role_check CHECK (role = ANY (ARRAY[
        'super_admin'::text, 'central_warehouse_manager'::text, 'institution_admin'::text,
        'warehouse_officer'::text, 'outlet_officer'::text, 'health_center_manager'::text,
        'pending_provisioning'::text])),
      ADD CONSTRAINT profiles_pending_provisioning_shape_chk CHECK (
        role <> 'pending_provisioning' OR (status = 'suspended' AND organization_id IS NULL));`));
    for (const forbidden of [
      /\bGRANT\b/i, /\bREVOKE\b/i, /DROP\s+FUNCTION/i, /CREATE\s+(OR\s+REPLACE\s+)?TRIGGER/i, /\bPOLICY\b/i,
      /INSERT\s+INTO\s+public\.role_permission_defaults/i, /FUNCTION\s+public\.phoenix_my_role/i,
      /FUNCTION\s+public\.phoenix_my_org/i, /CREATE\s+(TABLE|SCHEMA|TYPE|INDEX)/i,
    ]) {
      expect(EXEC, String(forbidden)).not.toMatch(forbidden);
    }
  });

  it('phoenix_handle_new_user takes only a validated full_name from user metadata and inserts the pending placeholder', () => {
    const stmt = functionStatement(SQL, HANDLE);
    const body = stripSqlComments(functionBody(SQL, HANDLE));
    expect(stmt).toContain(" SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\n");
    expect(body.match(/raw_user_meta_data/g)).toHaveLength(2);
    expect(body).toContain("pg_catalog.jsonb_typeof(new.raw_user_meta_data -> 'full_name') = 'string'");
    expect(body).toContain("v_full_name := pg_catalog.btrim(new.raw_user_meta_data ->> 'full_name');");
    expect(body).toContain('pg_catalog.length(v_full_name) > 200');
    expect(body).not.toMatch(/raw_user_meta_data\s*->>?\s*'(role|status|organization_id|permissions|is_admin|is_super_admin|app_role)'/);
    expect(body).not.toMatch(/raw_app_meta_data/);
    expect(normalizeSql(body)).toContain(normalizeSql(
      "insert into public.profiles (id, full_name, role, status, organization_id) values (new.id, v_full_name, 'pending_provisioning', 'suspended', null) on conflict (id) do nothing;"));
  });

  it('phoenix_admin_provision_profile is the M182 body with only the placeholder test changed', () => {
    const m182 = normalizeSql(stripSqlComments(functionStatement(M182, PROVISION)));
    const m219 = normalizeSql(stripSqlComments(functionStatement(SQL, PROVISION)));
    expect(m182.length).toBeGreaterThan(1000);
    const expected = m182
      .replace("v_target_role is distinct from 'outlet_officer'", "v_target_role is distinct from 'pending_provisioning'")
      .replace("v_target_status is distinct from 'active'", "v_target_status is distinct from 'suspended'");
    expect(expected).not.toBe(m182);
    expect(m219).toBe(expected);
    // The requested-role allowlist is unchanged and never contains the sentinel.
    expect(m219.match(/pending_provisioning/g)).toHaveLength(1);
  });

  it('get_effective_permissions is the M196 body with only the NULL-organization scope predicate changed', () => {
    const m196Body = functionBody(M196, GEP);
    const m219Body = functionBody(SQL, GEP);
    expect(sha256(m196Body)).toBe('2b3bbd879c22b8ea578532dee65ee7922163cbe925c2ae2093bfa48b3bacff96');
    expect(m196Body.split(OLD_SCOPE)).toHaveLength(2);
    expect(m219Body).toBe(m196Body.replace(OLD_SCOPE, NEW_SCOPE));
    expect(sha256(m219Body)).toBe('8b891cb4b76947517c8d9c0ade96f8f0b0cb893d0c1730f7764c275d14ac09ec');
    expect(m219Body).not.toContain(OLD_SCOPE);
    const head = functionStatement(SQL, GEP).slice(0, functionStatement(SQL, GEP).indexOf('AS $function$'));
    expect(head).toBe(`${GEP}\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\n`);
  });

  it('VERIFY proves the constraints, the zero-authority sentinel, both bodies, unchanged properties and the untouched helpers', () => {
    expect(VERIFY).not.toBe('');
    for (const needle of [
      "'VERIFY FAILED (219): profiles_role_check is not the six business roles plus pending_provisioning'",
      "'VERIFY FAILED (219): profiles_pending_provisioning_shape_chk is missing, unvalidated or not the frozen shape'",
      "'VERIFY FAILED (219): pending_provisioning has role_permission_defaults'",
      "'VERIFY FAILED (219): phoenix_handle_new_user must read only full_name from user metadata and insert the pending placeholder'",
      "'VERIFY FAILED (219): phoenix_admin_provision_profile must accept only the pending_provisioning/suspended placeholder'",
      "'VERIFY FAILED (219): a role-assignment routine mentions pending_provisioning'",
      "'VERIFY FAILED (219): owner, SECURITY DEFINER, configuration or grants of a replaced function changed'",
      "'VERIFY FAILED (219): a client role can execute a replaced function'",
      "'VERIFY FAILED (219): on_auth_user_created binding changed'",
      "'VERIFY FAILED (219): get_effective_permissions identity, owner, security, configuration, grants, language, volatility or return type changed'",
      "'VERIFY FAILED (219): get_effective_permissions is not the M196 body with only the NULL-organization scope predicate corrected'",
      "'8b891cb4b76947517c8d9c0ade96f8f0b0cb893d0c1730f7764c275d14ac09ec'",
      "'VERIFY FAILED (219): phoenix_my_role or phoenix_my_org changed (out of AUTH-1 scope)'",
    ]) {
      expect(VERIFY, needle).toContain(needle);
    }
  });
});
