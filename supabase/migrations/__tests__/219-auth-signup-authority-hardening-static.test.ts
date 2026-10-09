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
 *     get_effective_permissions body by sha256, the four HC1 predecessors by
 *     md5, one definition per replaced routine, the owner) before any lock;
 *   * the exact DDL inventory: ONE ALTER TABLE on profiles (role CHECK plus
 *     the pending shape CHECK), SEVEN function replacements, no GRANT, REVOKE,
 *     DROP FUNCTION, trigger, policy or permission default;
 *   * phoenix_handle_new_user reads only full_name from user metadata and
 *     inserts the pending_provisioning / suspended / no-organization placeholder;
 *   * phoenix_admin_provision_profile is the M182 body with only the
 *     placeholder test changed; get_effective_permissions is the M196 body
 *     with only the NULL-organization scope predicate and the HC1 profile-less
 *     actor denial changed;
 *   * M219-HC1: assign_profile_role, phoenix_recycle_apply,
 *     assign_profile_permissions and reset_profile_permissions are each their
 *     reviewed predecessor (M196 / M093) with ONLY the sentinel-target fence
 *     and the profile-less actor denial (re-derived here from those files);
 *   * the authority helpers phoenix_my_role / phoenix_my_org are untouched;
 *   * VERIFY covers every contract above;
 *   * no M219 test depends on the two historical error DETAIL strings of
 *     _phoenix_profile_role_organization_guard_v1 (B2, accepted drift).
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

const M093 = readFileSync(join(MIGRATIONS, '093_phoenix_super_admin_lifecycle_guard.sql'), 'utf8');
const M182 = readFileSync(join(MIGRATIONS, '182_phoenix_health_center_facility_scoped_rbac.sql'), 'utf8');
const M196 = readFileSync(join(MIGRATIONS, '196_phoenix_secdef_relation_schema_qualification.sql'), 'utf8');

const PROVISION = 'CREATE OR REPLACE FUNCTION public.phoenix_admin_provision_profile(';
const HANDLE = 'CREATE OR REPLACE FUNCTION public.phoenix_handle_new_user()';
const GEP = 'CREATE OR REPLACE FUNCTION public.get_effective_permissions(p_profile_id uuid)';
const OLD_SCOPE = 'v_target_org is distinct from v_org';
const NEW_SCOPE = 'not coalesce(v_target_org = v_org, false)';
const HEAD_TAIL = "\n RETURNS jsonb\n LANGUAGE plpgsql\n SECURITY DEFINER\n SET search_path TO 'public', 'pg_temp'\n";

/** Replace `from` by `to`, requiring `from` to occur exactly once. */
function once(text: string, from: string, to: string): string {
  expect(text.split(from), from).toHaveLength(2);
  return text.replace(from, () => to);
}
const ACTOR_DENY =
  "  -- AUTH-1 (219-HC1): authentication alone is not authority. A caller with no\n"
  + "  -- profiles row is denied before any authority decision reads role or org.\n"
  + "  if not found then return jsonb_build_object('ok', false, 'error', 'ACTOR_PROFILE_NOT_FOUND'); end if;\n";
const PERM_GATE_OLD = "  if v_role <> 'super_admin' then\n    if not phoenix_profile_has_permission(v_actor, 'users.manage_permissions') then\n";
const PERM_GATE_NEW = "  if v_role is distinct from 'super_admin' then\n"
  + "    if coalesce(phoenix_profile_has_permission(v_actor, 'users.manage_permissions'), false) is not true then\n";
const ACTOR_SELECT = '  select role, organization_id into v_role, v_org from public.profiles where id = v_actor;\n';

/**
 * M219-HC1: every fenced routine, its predecessor source (the migration that
 * last defined it), its exact M219 head, the HC1 edits (each anchor must occur
 * exactly once) and the resulting body's sha256 (also pinned by VERIFY).
 */
const HC1: Array<{ name: string; predMd5: string; head: string; predecessor: () => string; edits: Array<[string, string]>; sha: string }> = [
  {
    name: 'assign_profile_role',
    predMd5: '2560b42ba8d8afcf7b33c45bb71e68c4',
    head: 'CREATE OR REPLACE FUNCTION public.assign_profile_role(p_target_id uuid, p_new_role text)',
    predecessor: () => functionBody(M196, 'CREATE OR REPLACE FUNCTION public.assign_profile_role('),
    edits: [[
      "  if not found then\n    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');\n  end if;\n",
      "  if not found then\n    return jsonb_build_object('ok', false, 'error', 'TARGET_NOT_FOUND');\n  end if;\n\n"
        + '  -- AUTH-1 (219-HC1): the internal pending_provisioning sentinel is never the\n'
        + '  -- target of this generic role RPC, whoever the actor is. It leaves its shape\n'
        + '  -- only through phoenix_admin_provision_profile (nonce, actor binding,\n'
        + '  -- freshness, Auth identity, one-shot).\n'
        + "  if v_target.role = 'pending_provisioning' then\n"
        + "    return jsonb_build_object('ok', false, 'error', 'TARGET_PENDING_PROVISIONING');\n"
        + '  end if;\n',
    ]],
    sha: '27f0dfa0bcc85a2e160578b4e82a7fd64bb457c7792999aace30a43f40208e23',
  },
  {
    name: 'phoenix_recycle_apply',
    predMd5: '35120783a910fcd29d463ccb7d9cd86e',
    head: 'CREATE OR REPLACE FUNCTION public.phoenix_recycle_apply(p_target_id uuid, p_new_full_name text, p_new_role text, '
      + 'p_new_org uuid, p_login_mode text, p_username text, p_contact_email text, p_new_email text, p_expected_version integer, '
      + 'p_correlation_id uuid DEFAULT gen_random_uuid())',
    predecessor: () => dollarBody(M093, 'create or replace function public.phoenix_recycle_apply(', '$$'),
    edits: [
      [
        "  v_is_super := (v_arole = 'super_admin' and v_astatus = 'active');\n"
          + "  v_is_inst  := (v_arole = 'institution_admin' and v_astatus = 'active');\n",
        '  -- AUTH-1 (219-HC1): authentication alone is not authority. A caller with no\n'
          + '  -- profiles row is denied here, before any role, organization or permission\n'
          + '  -- state is used; the denial is audited without an actor id, because that id\n'
          + '  -- may no longer exist in auth.users.\n'
          + '  if not found then\n'
          + "    return public._phoenix_lifecycle_deny(null, null, null, p_target_id, 'actor_profile_not_found', p_correlation_id);\n"
          + '  end if;\n'
          + "  v_is_super := coalesce(v_arole = 'super_admin' and v_astatus = 'active', false);\n"
          + "  v_is_inst  := coalesce(v_arole = 'institution_admin' and v_astatus = 'active', false);\n",
      ],
      [
        "    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_not_found', p_correlation_id);\n  end if;\n",
        "    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_not_found', p_correlation_id);\n  end if;\n"
          + '  -- AUTH-1 (219-HC1): the internal pending_provisioning sentinel is never\n'
          + '  -- recycled; it leaves its shape only through phoenix_admin_provision_profile.\n'
          + "  if v_trole = 'pending_provisioning' then\n"
          + "    return public._phoenix_lifecycle_deny(v_actor, v_arole, v_aorg, p_target_id, 'target_pending_provisioning', p_correlation_id);\n"
          + '  end if;\n',
      ],
    ],
    sha: 'c99d2e59d1209097ddbb3baa45746df36ccd2469089e835920e5f7f972adb277',
  },
  {
    name: 'assign_profile_permissions',
    predMd5: 'cdd271498787559b7be83e6f816c5586',
    head: 'CREATE OR REPLACE FUNCTION public.assign_profile_permissions(p_profile_id uuid, p_permissions jsonb)',
    predecessor: () => functionBody(M196, 'CREATE OR REPLACE FUNCTION public.assign_profile_permissions('),
    edits: [
      [ACTOR_SELECT, ACTOR_SELECT + ACTOR_DENY],
      [PERM_GATE_OLD, PERM_GATE_NEW],
      [
        "  if p_profile_id = v_actor then\n    return jsonb_build_object('ok', false, 'error', 'CANNOT_EDIT_OWN_PERMISSIONS');\n  end if;\n",
        "  if p_profile_id = v_actor then\n    return jsonb_build_object('ok', false, 'error', 'CANNOT_EDIT_OWN_PERMISSIONS');\n  end if;\n\n"
          + '  -- AUTH-1 (219-HC1): the pending_provisioning sentinel holds no authority, so\n'
          + '  -- no permission override is ever written for it, whoever the actor is.\n'
          + "  if exists (select 1 from public.profiles where id = p_profile_id and role = 'pending_provisioning') then\n"
          + "    return jsonb_build_object('ok', false, 'error', 'TARGET_PENDING_PROVISIONING');\n"
          + '  end if;\n',
      ],
      [
        "    if v_bool is true and v_role <> 'super_admin' then\n      if not phoenix_profile_has_permission(v_actor, v_key) then\n",
        "    if v_bool is true and v_role is distinct from 'super_admin' then\n"
          + '      if coalesce(phoenix_profile_has_permission(v_actor, v_key), false) is not true then\n',
      ],
    ],
    sha: '96f4d9713c47d5291883fea8133c1028d45ceceb70adf6120157cf14559126a4',
  },
  {
    name: 'reset_profile_permissions',
    predMd5: 'ef98ee9a7b589cf7fc1192e02bdfbe74',
    head: 'CREATE OR REPLACE FUNCTION public.reset_profile_permissions(p_profile_id uuid)',
    predecessor: () => functionBody(M196, 'CREATE OR REPLACE FUNCTION public.reset_profile_permissions('),
    edits: [[ACTOR_SELECT, ACTOR_SELECT + ACTOR_DENY], [PERM_GATE_OLD, PERM_GATE_NEW]],
    sha: 'eefab1082f222a81e05c68517eaebc9157c9f2da3f21d1e9515b0799247b323c',
  },
];

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
/** The body of the LAST `head` statement quoted with dollar tag `tag` (e.g. `$$`). */
function dollarBody(text: string, head: string, tag: string): string {
  const at = text.lastIndexOf(head);
  if (at < 0) return '';
  const open = text.indexOf(`as ${tag}`, at) + `as ${tag}`.length;
  return text.slice(open, text.indexOf(tag, open));
}
const sha256 = (s: string) => createHash('sha256').update(s, 'utf8').digest('hex');
const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

describe.runIf(PRESENT)('M219 static — sign-up authority hardening', () => {
  it('219 is the next migration after 218; only PRE3-B/M220 and PDA-PROC-1/M221 sit above it (the ceiling is 221); LF only; one BEGIN/COMMIT', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    // PRE3-B/M220 (active central item guard) is the reviewed successor and
    // PDA-PROC-1/M221 (pharmacy department supplementary procurement exclusion)
    // now the ceiling; its own static suite owns the ceiling assertions. The
    // 218 -> 219 -> 220 -> 221 order is exact.
    expect(files.filter((f) => Number(f.slice(0, 3)) > 218)).toEqual([FILENAME, '220_phoenix_central_needs_active_item_guard.sql',
      '221_phoenix_pharmacy_department_subpurchase_exclusion.sql']);
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
      // HC1: the four fenced routines' reviewed predecessors (LF-normalised md5).
      "pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\\r\\n', E'\\n'))",
      "WHEN 'assign_profile_role' THEN '2560b42ba8d8afcf7b33c45bb71e68c4'",
      "WHEN 'phoenix_recycle_apply' THEN '35120783a910fcd29d463ccb7d9cd86e'",
      "WHEN 'assign_profile_permissions' THEN 'cdd271498787559b7be83e6f816c5586'",
      "WHEN 'reset_profile_permissions' THEN 'ef98ee9a7b589cf7fc1192e02bdfbe74'",
      "'219_precondition_failed: assign_profile_role, phoenix_recycle_apply, assign_profile_permissions or reset_profile_permissions is not its reviewed predecessor'",
      "'219_precondition_failed: a replaced routine has an overload'",
      "'219_precondition_failed: pending_provisioning is already in use'",
      "'219_precondition_failed: M219 must be applied by the owner of public.profiles and of every replaced function'",
      "'phoenix_m219.hc1_meta'",
    ]) {
      expect(pre, needle).toContain(needle);
    }
    const preN = normalizeSql(pre);
    // TA-9: the trusted-owner guard names public.profiles and EVERY replaced routine (all seven),
    // and applies only to a non-superuser applier, which must own each of them.
    expect(preN).toContain(normalizeSql(
      "IF NOT v_super AND ( (SELECT c.relowner FROM pg_catalog.pg_class c WHERE c.oid = 'public.profiles'::regclass) <> v_me"));
    for (const sig of [
      'public.phoenix_handle_new_user()',
      'public.phoenix_admin_provision_profile(uuid,uuid,uuid,uuid,text,text,text,text,text,uuid)',
      'public.get_effective_permissions(uuid)',
      'public.assign_profile_role(uuid,text)',
      'public.phoenix_recycle_apply(uuid,text,text,uuid,text,text,text,text,integer,uuid)',
      'public.assign_profile_permissions(uuid,jsonb)',
      'public.reset_profile_permissions(uuid)',
    ]) {
      expect(preN, `owner guard for ${sig}`).toContain(normalizeSql(
        `(SELECT p.proowner FROM pg_catalog.pg_proc p WHERE p.oid = pg_catalog.to_regprocedure('${sig}')) <> v_me`));
    }
    // TA-9: the HC1 predecessor pin must match all four routines, and the overload guard all seven names.
    expect(preN).toContain(normalizeSql(
      "WHEN 'reset_profile_permissions' THEN 'ef98ee9a7b589cf7fc1192e02bdfbe74' END) <> 4 THEN"));
    expect(preN).toContain(normalizeSql(
      "'assign_profile_permissions', 'reset_profile_permissions')) <> 7 THEN"));
    expect(preN).toContain(normalizeSql(
      "AND p.prosecdef AND p.proconfig = ARRAY['search_path=public, pg_temp'] AND pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\\r\\n', E'\\n')) = CASE p.proname"));
    expect(EXEC.match(/SET\s+LOCAL\s+\w+/gi)?.map((s) => normalizeSql(s)))
      .toEqual(['SET LOCAL search_path', 'SET LOCAL lock_timeout', 'SET LOCAL statement_timeout']);
  });

  it('has exactly the reviewed DDL inventory and nothing else', () => {
    const created = [...EXEC.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z_.]+)\s*\(/gi)].map((m) => m[1]);
    expect(created).toEqual([
      'public.phoenix_handle_new_user', 'public.phoenix_admin_provision_profile', 'public.get_effective_permissions',
      'public.assign_profile_role', 'public.phoenix_recycle_apply', 'public.assign_profile_permissions',
      'public.reset_profile_permissions',
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

  it('get_effective_permissions is the M196 body with only the NULL-organization predicate and the profile-less actor denial changed', () => {
    const m196Body = functionBody(M196, GEP);
    const m219Body = functionBody(SQL, GEP);
    expect(sha256(m196Body)).toBe('2b3bbd879c22b8ea578532dee65ee7922163cbe925c2ae2093bfa48b3bacff96');
    let expected = once(m196Body, 'into v_role,v_org from public.profiles where id=v_actor;',
      "into v_role,v_org from public.profiles where id=v_actor; if not found then return jsonb_build_object('ok',false,'error','ACTOR_PROFILE_NOT_FOUND'); end if;");
    expected = once(expected, "v_role<>'super_admin' and p_profile_id<>v_actor", "v_role is distinct from 'super_admin' and p_profile_id<>v_actor");
    expected = once(expected, OLD_SCOPE, NEW_SCOPE);
    expect(m219Body).toBe(expected);
    expect(sha256(m219Body)).toBe('518141abbc8b9022a7cf0f76a721fdfab1192c07f5d496f2b667c9fb7d6254b0');
    expect(m219Body).not.toContain(OLD_SCOPE);
    // The actor is established BEFORE the target lookup and before any role or organization test.
    expect(m219Body.indexOf('ACTOR_PROFILE_NOT_FOUND')).toBeLessThan(m219Body.indexOf('TARGET_NOT_FOUND'));
    expect(m219Body.indexOf('ACTOR_PROFILE_NOT_FOUND')).toBeLessThan(m219Body.indexOf("v_role is distinct from 'super_admin'"));
    const head = functionStatement(SQL, GEP).slice(0, functionStatement(SQL, GEP).indexOf('AS $function$'));
    expect(head).toBe(`${GEP}${HEAD_TAIL}`);
  });

  it.each(HC1)('HC1: $name is its reviewed predecessor with only the sentinel fence / profile-less actor denial', (fn) => {
    const pred = fn.predecessor();
    expect(pred.length, `${fn.name} predecessor`).toBeGreaterThan(500);
    // TA-9: the prelude pins exactly this file-derived predecessor (LF), by md5.
    expect(md5(pred)).toBe(fn.predMd5);
    expect(normalizeSql(CODE.slice(CODE.indexOf('DO $prelude$'), CODE.indexOf('$prelude$;'))))
      .toContain(normalizeSql(`WHEN '${fn.name}' THEN '${fn.predMd5}'`));
    const expected = fn.edits.reduce((body, [from, to]) => once(body, from, to), pred);
    const stmtHead = `${fn.head}${HEAD_TAIL}`;
    const body = functionBody(SQL, `CREATE OR REPLACE FUNCTION public.${fn.name}(`);
    expect(body).toBe(expected);
    expect(sha256(body)).toBe(fn.sha);
    const stmt = functionStatement(SQL, `CREATE OR REPLACE FUNCTION public.${fn.name}(`);
    expect(stmt.slice(0, stmt.indexOf('AS $function$'))).toBe(stmtHead);
    // The requested-role allowlists are untouched (the body is the predecessor plus the edits
    // above), so the sentinel appears only in the one target fence (none in reset).
    expect(stripSqlComments(body).match(/'pending_provisioning'/g) ?? []).toHaveLength(fn.name === 'reset_profile_permissions' ? 0 : 1);
  });

  it('HC1: every fence and actor check sits after the authority decision it must not leak ahead of', () => {
    const body = (name: string) => stripSqlComments(functionBody(SQL, `CREATE OR REPLACE FUNCTION public.${name}(`));
    const apr = body('assign_profile_role');
    expect(apr.indexOf("'ACTOR_PROFILE_NOT_FOUND'")).toBeLessThan(apr.indexOf("'INSUFFICIENT_ROLE'"));
    expect(apr.indexOf("'INSUFFICIENT_ROLE'")).toBeLessThan(apr.indexOf("'TARGET_PENDING_PROVISIONING'"));
    const rec = body('phoenix_recycle_apply');
    expect(rec.indexOf("'actor_profile_not_found'")).toBeLessThan(rec.indexOf("'actor_not_authorized'"));
    expect(rec.indexOf("'actor_missing_permission'")).toBeLessThan(rec.indexOf("'target_pending_provisioning'"));
    expect(rec.indexOf("'target_pending_provisioning'")).toBeLessThan(rec.indexOf('update public.profiles'));
    const app = body('assign_profile_permissions');
    expect(app.indexOf("'ACTOR_PROFILE_NOT_FOUND'")).toBeLessThan(app.indexOf("'INSUFFICIENT_PERMISSION'"));
    expect(app.indexOf("'OUT_OF_SCOPE'")).toBeLessThan(app.indexOf("'TARGET_PENDING_PROVISIONING'"));
    expect(app.indexOf("'TARGET_PENDING_PROVISIONING'")).toBeLessThan(app.indexOf('insert into public.profile_permission_overrides'));
    const rpp = body('reset_profile_permissions');
    expect(rpp.indexOf("'ACTOR_PROFILE_NOT_FOUND'")).toBeLessThan(rpp.indexOf("'INSUFFICIENT_PERMISSION'"));
    expect(rpp.indexOf("'INSUFFICIENT_PERMISSION'")).toBeLessThan(rpp.indexOf('delete from public.profile_permission_overrides'));
    // No NULL-unsafe super_admin / permission gate survives in the four routines M219 now owns.
    for (const name of ['assign_profile_permissions', 'reset_profile_permissions']) {
      expect(body(name), name).not.toMatch(/v_role\s*<>\s*'super_admin'/);
      expect(body(name), name).not.toMatch(/if\s+not\s+phoenix_profile_has_permission/);
    }
    expect(stripSqlComments(functionBody(SQL, GEP))).not.toMatch(/v_role\s*<>\s*'super_admin'/);
  });

  it('VERIFY proves the constraints, the zero-authority sentinel, both bodies, unchanged properties and the untouched helpers', () => {
    expect(VERIFY).not.toBe('');
    for (const needle of [
      "'VERIFY FAILED (219): profiles_role_check is not the six business roles plus pending_provisioning'",
      "'VERIFY FAILED (219): profiles_pending_provisioning_shape_chk is missing, unvalidated or not the frozen shape'",
      "'VERIFY FAILED (219): pending_provisioning has role_permission_defaults'",
      "'VERIFY FAILED (219): phoenix_handle_new_user must read only full_name from user metadata and insert the pending placeholder'",
      "'VERIFY FAILED (219): phoenix_admin_provision_profile must accept only the pending_provisioning/suspended placeholder'",
      "'VERIFY FAILED (219): a fenced routine is not its reviewed HC1 body'",
      ...HC1.map((fn) => `${fn.name}:${fn.sha}`),
      "'VERIFY FAILED (219): identity, owner, security, configuration, grants, language, volatility or return type of a fenced routine changed'",
      "current_setting('phoenix_m219.hc1_meta', true)",
      "'VERIFY FAILED (219): owner, SECURITY DEFINER, configuration or grants of a replaced function changed'",
      "'VERIFY FAILED (219): a client role can execute a replaced function'",
      "'VERIFY FAILED (219): anon can execute a replaced authority routine'",
      "'VERIFY FAILED (219): on_auth_user_created binding changed'",
      "'VERIFY FAILED (219): get_effective_permissions identity, owner, security, configuration, grants, language, volatility or return type changed'",
      "'VERIFY FAILED (219): get_effective_permissions is not the M196 body with only the NULL-organization scope predicate and the profile-less actor denial'",
      "'518141abbc8b9022a7cf0f76a721fdfab1192c07f5d496f2b667c9fb7d6254b0'",
      "'VERIFY FAILED (219): phoenix_my_role or phoenix_my_org changed (out of AUTH-1 scope)'",
    ]) {
      expect(VERIFY, needle).toContain(needle);
    }
    // The first artifact's "no role-assignment routine mentions the sentinel" check is superseded by the HC1 fences.
    expect(VERIFY).not.toContain('a role-assignment routine mentions pending_provisioning');
  });

  it('B2: no M219 test depends on the two historical DETAIL strings of the profile role/organization guard', () => {
    // Built at run time so this file does not itself contain the strings it forbids.
    const forbidden = [
      ['an active health_center_manager is a', 'facility-scoped role and cannot be a platform profile'].join(' '),
      ['organization must be an ACTIVE care_institution', 'with institution_class=health_sector'].join(' '),
    ];
    const suites = [
      readFileSync(join(__dirname, '219-auth-signup-authority-hardening.dynamic.test.ts'), 'utf8'),
      readFileSync(join(__dirname, '219-auth-signup-authority-hardening-static.test.ts'), 'utf8'),
      SQL,
    ];
    for (const text of suites) {
      for (const s of forbidden) expect(text.includes(s)).toBe(false);
    }
  });
});
