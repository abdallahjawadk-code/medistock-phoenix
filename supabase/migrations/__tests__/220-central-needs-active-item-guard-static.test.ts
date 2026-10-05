/**
 * PRE3-B / M220 — STATIC guard over the active central item guard.
 *
 * Proves, from the migration text alone, the frozen shape of M220. The dynamic
 * PostgreSQL suite (220-central-needs-active-item-guard.dynamic.test.ts) is
 * the behavioural proof; this suite pins what the file may and may not do:
 *
 *   * registration and hygiene: the canonical filename, the only file above
 *     219, one BEGIN;/COMMIT;, LF only;
 *   * the activation shape: search_path pinned first and both timeouts set
 *     before the first read, the fail-closed prelude (READ COMMITTED, RLS
 *     bypass, idempotence, M218 present, the judged column, the M211
 *     disposition body and wrapper by md5 — re-derived here from the M211
 *     file — and the owner) before the NOWAIT lock, the lock before any DDL;
 *   * the exact DDL inventory: ONE function replacement (the disposition RPC),
 *     ONE new private function, ONE trigger, ONE REVOKE (the new function), no
 *     GRANT, ALTER, DROP, table, index, policy or default privilege;
 *   * the disposition RPC is the M211 definition with exactly two edits (one
 *     variable and the item check), so every other check, its order, the
 *     replay, not_applicable and the audit are byte-identical; the item check
 *     reads FOR SHARE (never FOR KEY SHARE), keeps central_item_not_found and
 *     raises central_item_not_active with a reason token, after DRAFT and
 *     before the first write;
 *   * the gate: private, SECURITY INVOKER, pinned, owner-only, judges only an
 *     entry into submitted or approved, locks FOR SHARE ORDER BY id, writes
 *     nothing, no dynamic SQL, every application object qualified;
 *   * the trigger: BEFORE UPDATE FOR EACH ROW, no column list, named to fire
 *     after both M217/M218 fences and before set_updated_at;
 *   * VERIFY re-proves all of it, with M218's frozen trigger inventory plus
 *     exactly the new trigger and M218's writer census unchanged;
 *   * VERIFY never fingerprints whole tables (the Run-3 defect: a baseline of
 *     whole tables taken before the lock made unrelated concurrent traffic
 *     fail the apply): every table the prelude or VERIFY reads is read ONLY
 *     through the write census — rows whose xmin is this transaction's id —
 *     which is byte-identical in both blocks and expects exactly the RPC, the
 *     gate and the trigger; and no statement of the file writes a row.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { executableSql, normalizeSql, stripSqlComments } from './helpers/sql-source';

const MIGRATIONS = join(__dirname, '..');
const FILENAME = '220_phoenix_central_needs_active_item_guard.sql';
const PRESENT = existsSync(join(MIGRATIONS, FILENAME));
const SQL = PRESENT ? readFileSync(join(MIGRATIONS, FILENAME), 'utf8') : '';
const CODE = stripSqlComments(SQL);
const EXEC = executableSql(SQL);
const VERIFY_AT = CODE.indexOf('DO $verify$');
const VERIFY = VERIFY_AT >= 0 ? CODE.slice(VERIFY_AT) : '';

const M211 = readFileSync(join(MIGRATIONS, '211_phoenix_central_needs_batch_and_disposition.sql'), 'utf8').replace(/\r\n/g, '\n');
const M218 = readFileSync(join(MIGRATIONS, '218_phoenix_central_needs_submission_integrity_fence.sql'), 'utf8').replace(/\r\n/g, '\n');

const DISPOSITION = 'CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_record_disposition(';
const WRAPPER = 'CREATE OR REPLACE FUNCTION public.phoenix_central_needs_set_record_mapping(';
const GATE = 'CREATE FUNCTION phoenix_private.central_needs_active_item_gate_v1()';
const TRIGGER = 'central_needs_plan_revisions_m220_active_item_gate';

const md5 = (s: string) => createHash('md5').update(s, 'utf8').digest('hex');

/** The CREATE [OR REPLACE] FUNCTION statement starting at `head` in `text`, through its closing `$$;`. */
function fnDef(text: string, head: string): string {
  const at = text.indexOf(head);
  expect(at, head).toBeGreaterThanOrEqual(0);
  const end = text.indexOf('\n$$;', at);
  expect(end, head).toBeGreaterThan(at);
  return text.slice(at, end + '\n$$;'.length);
}
/** The prosrc PostgreSQL stores for the function at `head`: the text between `AS $$` and the closing `$$`. */
function prosrc(text: string, head: string): string {
  const def = fnDef(text, head);
  const open = def.indexOf('AS $$') + 'AS $$'.length;
  return def.slice(open, def.length - '$$;'.length);
}
/** Replace `from` by `to`, requiring `from` to occur exactly once. */
function once(text: string, from: string, to: string): string {
  expect(text.split(from), from.slice(0, 80)).toHaveLength(2);
  return text.replace(from, () => to);
}

const OLD_ITEM_CHECK = `  IF v_item IS NOT NULL THEN
    SELECT name INTO v_item_label FROM public.central_items WHERE id = v_item;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';
    END IF;
  END IF;
`;
const NEW_ITEM_CHECK = `  IF v_item IS NOT NULL THEN
    -- 220 (PRE3-B): the mapped item must EXIST and be ACTIVE. FOR SHARE (not
    -- FOR KEY SHARE: a status change takes FOR NO KEY UPDATE, which only FOR
    -- SHARE and stronger conflict with) holds the row to transaction end, so
    -- no status change commits between this judgement and the write below; a
    -- change committed first is what this READ COMMITTED re-read returns.
    SELECT ci.name, ci.status INTO v_item_label, v_item_status
      FROM public.central_items ci
     WHERE ci.id = v_item
       FOR SHARE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';
    END IF;
    IF v_item_status IS DISTINCT FROM 'active' THEN
      RAISE EXCEPTION 'central_item_not_active' USING ERRCODE = '23514',
        DETAIL = format('central_item=%s status=%s reason=%s', v_item, v_item_status, v_item_status),
        HINT = 'Only an active central item can be mapped. Choose an active catalog item, or mark the row not applicable with a reason.';
    END IF;
  END IF;
`;

describe.runIf(PRESENT)('M220 static — active central item guard', () => {
  it('220 is the next migration after 219 and the only file above 219; LF only; one BEGIN/COMMIT', () => {
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
    expect(files.filter((f) => Number(f.slice(0, 3)) > 219)).toEqual([FILENAME]);
    expect(files.filter((f) => f.startsWith('220_'))).toEqual([FILENAME]);
    expect(SQL.includes('\r')).toBe(false);
    expect(EXEC.match(/^\s*BEGIN\s*;/gim)).toHaveLength(1);
    expect(EXEC.match(/^\s*COMMIT\s*;/gim)).toHaveLength(1);
    expect(EXEC.trimEnd().endsWith('COMMIT;')).toBe(true);
  });

  it('pins search_path first and runs the fail-closed prelude before the NOWAIT lock, and the lock before any DDL', () => {
    const searchPath = EXEC.indexOf('SET LOCAL search_path = pg_catalog, pg_temp;');
    const prelude = EXEC.indexOf('DO $prelude$');
    const lock = EXEC.indexOf('LOCK TABLE public.central_needs_plan_revisions IN SHARE ROW EXCLUSIVE MODE NOWAIT;');
    const firstDdl = EXEC.search(/CREATE OR REPLACE FUNCTION|CREATE FUNCTION|CREATE TRIGGER|REVOKE|ALTER /);
    expect(searchPath).toBeGreaterThan(0);
    expect(searchPath).toBeLessThan(prelude);
    // Both timeouts bound the prelude's reads too: set right after search_path, before the prelude.
    expect(EXEC.indexOf("SET LOCAL lock_timeout = '';")).toBeGreaterThan(searchPath);
    expect(EXEC.indexOf("SET LOCAL statement_timeout = '';")).toBeGreaterThan(EXEC.indexOf("SET LOCAL lock_timeout = '';"));
    expect(EXEC.indexOf("SET LOCAL statement_timeout = '';")).toBeLessThan(prelude);
    expect(prelude).toBeLessThan(lock);
    expect(lock).toBeLessThan(firstDdl);
    expect(EXEC.match(/SET\s+LOCAL\s+\w+/gi)?.map((s) => normalizeSql(s)))
      .toEqual(['SET LOCAL search_path', 'SET LOCAL lock_timeout', 'SET LOCAL statement_timeout']);
    expect(CODE).toContain("SET LOCAL lock_timeout = '250ms';");
    expect(CODE).toContain("SET LOCAL statement_timeout = '60s';");
    const pre = CODE.slice(CODE.indexOf('DO $prelude$'), CODE.indexOf('$prelude$;'));
    for (const needle of [
      "RAISE EXCEPTION '220_requires_read_committed'",
      "'220_precondition_failed: the applying role must bypass row-level security'",
      "RAISE EXCEPTION '220_already_applied';",
      "'220_precondition_failed: M218 (the sealed submission) is not applied'",
      "'220_precondition_failed: central_items.status is not the M001 text NOT NULL active/inactive/discontinued column'",
      "'220_precondition_failed: the disposition RPC or its wrapper has an overload or is absent'",
      "'220_precondition_failed: phoenix_central_needs_set_record_disposition is not the reviewed M211 definition'",
      "'220_precondition_failed: phoenix_central_needs_set_record_mapping is not the reviewed M211 wrapper'",
      "'220_precondition_failed: M220 must be applied by the owner of the disposition RPC, of central_needs_plan_revisions and of phoenix_private'",
      "AND p.proconfig = ARRAY['search_path=public, pg_temp']",
      "'phoenix_m220.fn_before'", "'phoenix_m220.txid'", "'phoenix_m220.preexisting'",
      'v_txid := pg_catalog.txid_current();',
      "SELECT coalesce(pg_catalog.array_agg(w.rel || '@' || w.k || '@' || w.obj), '{}'::text[])::text\n      FROM (SELECT 'pg_proc'::text AS rel",
    ]) {
      expect(pre, needle).toContain(needle);
    }
    // The md5 pins ARE the M211 bodies (LF-normalised), re-derived from the M211 file.
    const dispositionMd5 = md5(prosrc(M211, DISPOSITION));
    const wrapperMd5 = md5(prosrc(M211, WRAPPER));
    expect(pre).toContain(`pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\\r\\n', E'\\n')) = '${dispositionMd5}'`);
    expect(pre).toContain(`pg_catalog.md5(pg_catalog.replace(p.prosrc, E'\\r\\n', E'\\n')) = '${wrapperMd5}'`);
    expect([dispositionMd5, wrapperMd5]).toEqual(['4ea96f468d115bce414d7b0bf2bcf7cf', 'e71ae559b00600951180349afcae6fb3']);
  });

  it('has exactly the reviewed DDL inventory and nothing else', () => {
    expect([...EXEC.matchAll(/CREATE\s+OR\s+REPLACE\s+FUNCTION\s+([a-z0-9_.]+)\s*\(/gi)].map((m) => m[1]))
      .toEqual(['public.phoenix_central_needs_set_record_disposition']);
    expect([...EXEC.matchAll(/CREATE\s+FUNCTION\s+([a-z0-9_.]+)\s*\(/gi)].map((m) => m[1]))
      .toEqual(['phoenix_private.central_needs_active_item_gate_v1']);
    expect([...EXEC.matchAll(/CREATE\s+TRIGGER\s+([a-z_0-9]+)/gi)].map((m) => m[1])).toEqual([TRIGGER]);
    expect([...EXEC.matchAll(/^\s*REVOKE\b[^;]*;/gim)].map((m) => normalizeSql(m[0])))
      .toEqual(['REVOKE ALL ON FUNCTION phoenix_private.central_needs_active_item_gate_v1() FROM PUBLIC, anon, authenticated, service_role;']);
    expect(EXEC.match(/^\s*COMMENT\s+ON\s+(FUNCTION|TRIGGER)\s+[^\s(]+/gim)?.map((s) => normalizeSql(s))).toEqual([
      'COMMENT ON FUNCTION public.phoenix_central_needs_set_record_disposition',
      'COMMENT ON FUNCTION phoenix_private.central_needs_active_item_gate_v1',
      `COMMENT ON TRIGGER ${TRIGGER}`,
    ]);
    for (const forbidden of [/\bGRANT\b/i, /\bALTER\s+(TABLE|FUNCTION|DEFAULT|SCHEMA|ROLE|POLICY)\b/i, /\bDROP\b/i,
      /\bCREATE\s+(TABLE|INDEX|UNIQUE|POLICY|SCHEMA|TYPE|VIEW|RULE|SEQUENCE|EXTENSION|ROLE)\b/i, /\bTRUNCATE\s+(TABLE\s+)?public\./i,
      /\bINSERT\s+INTO\s+(public|phoenix_private)\.(?!central_needs_record_mappings|audit_logs)/i]) {
      expect(EXEC, String(forbidden)).not.toMatch(forbidden);
    }
    // The legacy wrapper is NOT redefined: it delegates and inherits the guard.
    expect(SQL).not.toContain(WRAPPER);
    // Only the disposition RPC is SECURITY DEFINER; the gate is SECURITY INVOKER.
    expect(EXEC.match(/SECURITY\s+DEFINER/gi)).toHaveLength(1);
    expect(EXEC.match(/SECURITY\s+INVOKER/gi)).toHaveLength(1);
  });

  it('the disposition RPC is the M211 definition with exactly one added variable and the replaced item check', () => {
    const before = fnDef(M211, DISPOSITION);
    const after = fnDef(SQL, DISPOSITION);
    let expected = once(before, '  v_item_label text;\n', '  v_item_label text;\n  v_item_status text;\n');
    expected = once(expected, OLD_ITEM_CHECK, NEW_ITEM_CHECK);
    expect(after).toBe(expected);
    // Signature, defaults, result, SECURITY DEFINER and search_path are the M211 lines verbatim.
    const head = (d: string) => d.slice(0, d.indexOf('AS $$'));
    expect(head(after)).toBe(head(before));
    expect(normalizeSql(head(after))).toBe(normalizeSql(`${DISPOSITION} p_import_session_id uuid, p_target_entity text, p_decision text, `
      + 'p_central_item_id uuid DEFAULT NULL, p_decision_reason text DEFAULT NULL ) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public, pg_temp'));
  });

  it('the item check reads FOR SHARE (never FOR KEY SHARE) after DRAFT and before the first write; not_found kept, not_active typed with a reason token', () => {
    const body = stripSqlComments(fnDef(SQL, DISPOSITION));
    const at = (needle: string) => {
      const i = body.indexOf(needle);
      expect(i, needle).toBeGreaterThan(0);
      return i;
    };
    const order = [
      at("SELECT * INTO v_session\n    FROM public.central_needs_import_sessions\n   WHERE id = p_import_session_id\n   FOR UPDATE;"),
      at("v_actor_role := public._phoenix_central_needs_guard_v1(v_session.organization_id, 'central_needs.edit');"),
      at('v_revision   := public._phoenix_central_needs_load_revision_v1(v_session.plan_revision_id);'),
      at('PERFORM public._phoenix_central_needs_assert_draft_v1(v_session.plan_revision_id, v_revision.status);'),
      at("RAISE EXCEPTION 'target_entity_not_in_import_session'"),
      at('FROM public.central_items ci\n     WHERE ci.id = v_item\n       FOR SHARE;'),
      at("RAISE EXCEPTION 'central_item_not_found' USING ERRCODE = 'P0002';"),
      at("IF v_item_status IS DISTINCT FROM 'active' THEN"),
      at("RAISE EXCEPTION 'central_item_not_active' USING ERRCODE = '23514',"),
      at('SELECT * INTO v_existing\n    FROM public.central_needs_record_mappings'),
      at("'ok', true, 'idempotent_replay', true,"),
      at('INSERT INTO public.central_needs_record_mappings ('),
      at('INSERT INTO public.audit_logs ('),
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body).toContain("DETAIL = format('central_item=%s status=%s reason=%s', v_item, v_item_status, v_item_status),");
    expect(body).not.toMatch(/FOR\s+KEY\s+SHARE/i);
    expect(body).not.toMatch(/\bexecute\b/i);
    expect(body.match(/FROM public\.central_items/g)).toHaveLength(1);
  });

  it('the gate: private, SECURITY INVOKER, pinned, owner-only; judges only entry into submitted/approved; locks FOR SHARE ORDER BY id; writes nothing', () => {
    const def = fnDef(SQL, GATE);
    const body = stripSqlComments(def);
    expect(normalizeSql(def.slice(0, def.indexOf('AS $$')))).toBe(normalizeSql(
      `${GATE} RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path = pg_catalog, pg_temp`));
    expect(normalizeSql(body)).toContain(normalizeSql(
      "IF TG_OP = 'UPDATE' AND NEW.status IN ('submitted', 'approved') AND OLD.status IS DISTINCT FROM NEW.status THEN"));
    // The lock: every referenced item (mapped dispositions of COMPLETED sessions + need lines), FOR SHARE, ORDER BY id.
    expect(normalizeSql(body)).toContain(normalizeSql(`PERFORM 1
      FROM public.central_items ci
     WHERE ci.id IN (SELECT m.central_item_id
                       FROM public.central_needs_record_mappings m
                       JOIN public.central_needs_import_sessions s ON s.id = m.import_session_id
                      WHERE s.plan_revision_id = NEW.id
                        AND s.status = 'completed'
                        AND m.decision = 'mapped'
                     UNION
                     SELECT n.central_item_id
                       FROM public.central_needs_need_lines n
                      WHERE n.plan_revision_id = NEW.id)
     ORDER BY ci.id
       FOR SHARE;`));
    // The judgement comes AFTER the lock, in its own statement (a fresh READ COMMITTED snapshot).
    const lockAt = body.indexOf('FOR SHARE;');
    const judgeAt = body.indexOf("WHERE ci.id IS NULL OR ci.status IS DISTINCT FROM 'active'");
    const raiseAt = body.indexOf("RAISE EXCEPTION 'central_needs_central_item_not_active' USING ERRCODE = '23514',");
    expect(lockAt).toBeGreaterThan(0);
    expect(judgeAt).toBeGreaterThan(lockAt);
    expect(raiseAt).toBeGreaterThan(judgeAt);
    expect(body).toContain("DETAIL = format('phase=%s revision=%s %s central_item=%s status=%s reason=%s', v_phase, NEW.id, v_bad.ref,");
    expect(body).toContain("v_phase := CASE NEW.status WHEN 'submitted' THEN 'submit' ELSE 'approve' END;");
    expect(body).toContain('RETURN NEW;');
    expect(body).not.toMatch(/FOR\s+KEY\s+SHARE/i);
    expect(body).not.toMatch(/\bexecute\b/i);
    expect(body).not.toMatch(/\b(insert\s+into|update|delete\s+from|truncate|merge\s+into)\s+/i);
    expect(body).not.toMatch(/(from|join|into|update|table)\s+(only\s+)?"?(central_needs_|central_items|audit_logs|organizations|warehouses|profiles)/i);
    expect(body).not.toMatch(/audit_logs|central_needs_lifecycle_attestations/);
    expect(CODE).toContain('REVOKE ALL ON FUNCTION phoenix_private.central_needs_active_item_gate_v1() FROM PUBLIC, anon, authenticated, service_role;');
  });

  it('the trigger: BEFORE UPDATE FOR EACH ROW, no column list, firing after both fences and before set_updated_at', () => {
    expect(normalizeSql(CODE)).toContain(normalizeSql(`CREATE TRIGGER ${TRIGGER}
      BEFORE UPDATE ON public.central_needs_plan_revisions
      FOR EACH ROW EXECUTE FUNCTION phoenix_private.central_needs_active_item_gate_v1();`));
    // PostgreSQL fires same-event triggers in name order (byte order).
    const names = ['central_needs_plan_revisions_c5_approval_gate', 'central_needs_plan_revisions_c6_submission_gate', TRIGGER, 'set_updated_at'];
    expect([...names].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)))).toEqual(names);
    expect(Buffer.compare(Buffer.from(names[1]), Buffer.from(TRIGGER))).toBe(-1);
    expect(Buffer.compare(Buffer.from(TRIGGER), Buffer.from('set_updated_at'))).toBe(-1);
  });

  it('VERIFY re-proves the RPC shape and ACL, the F2 order with the lock, the gate, the trigger, the M218 seal, census and inventory, and that nothing else changed', () => {
    expect(VERIFY.length).toBeGreaterThan(0);
    for (const needle of [
      "IS DISTINCT FROM pg_catalog.current_setting('phoenix_m220.fn_before')",
      "AND p.proconfig = ARRAY['search_path=public, pg_temp']",
      "= 'p_import_session_id uuid, p_target_entity text, p_decision text, p_central_item_id uuid, p_decision_reason text'",
      "pg_catalog.has_function_privilege('anon', v_fn, 'EXECUTE')",
      "NOT pg_catalog.has_function_privilege('authenticated', v_fn, 'EXECUTE')",
      "v_load  := pg_catalog.strpos(v_src, 'public._phoenix_central_needs_load_revision_v1(');",
      "v_draft := pg_catalog.strpos(v_src, 'public._phoenix_central_needs_assert_draft_v1(');",
      "v_lock  := pg_catalog.strpos(v_src, E'FROM public.central_items ci\\n     WHERE ci.id = v_item\\n       FOR SHARE;');",
      "v_judge := pg_catalog.strpos(v_src, 'IF v_item_status IS DISTINCT FROM ''active'' THEN');",
      'NOT (v_load < v_draft AND v_draft < v_lock AND v_lock < v_judge AND v_judge < v_write)',
      "pg_catalog.strpos(v_src, 'RAISE EXCEPTION ''central_item_not_found'' USING ERRCODE = ''P0002'';') = 0",
      "pg_catalog.strpos(v_src, 'RAISE EXCEPTION ''central_item_not_active'' USING ERRCODE = ''23514'',') = 0",
      "pg_catalog.strpos(v_src, 'FOR KEY SHARE') > 0",
      "IF v_src ~* '\\mexecute\\M' THEN",
      "= 'e71ae559b00600951180349afcae6fb3'",
      "AND p.proconfig = ARRAY['search_path=pg_catalog, pg_temp']",
      "pg_catalog.strpos(v_src, E'IF TG_OP = ''UPDATE''\\n     AND NEW.status IN (''submitted'', ''approved'')\\n     AND OLD.status IS DISTINCT FROM NEW.status THEN') = 0",
      "'VERIFY FAILED (220): the disposition RPC body is not the reviewed M220 body'",
      "'VERIFY FAILED (220): the gate body is not the reviewed M220 body'",
      "pg_catalog.strpos(v_src, E'ORDER BY ci.id\\n       FOR SHARE;') = 0",
      "pg_catalog.strpos(v_src, 'WHERE ci.id IS NULL OR ci.status IS DISTINCT FROM ''active''') = 0",
      "AND t.tgfoid = v_gate AND t.tgtype = 19 AND t.tgenabled = 'O' AND NOT t.tgisinternal",
      'AND pg_catalog.cardinality(t.tgattr::pg_catalog.int2[]) = 0)',
      "FROM phoenix_private.central_needs_capability_breaches_v1() AS b(breach);",
      "IS DISTINCT FROM ARRAY['_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay', 'phoenix_central_needs_register_import_batch']",
      "IS DISTINCT FROM ARRAY['central_needs_active_item_gate_v1', 'central_needs_approval_gate_fence_v1', 'central_needs_capability_breaches_v1',",
      "IF pg_catalog.txid_current() IS DISTINCT FROM pg_catalog.current_setting('phoenix_m220.txid')::bigint",
      "(SELECT pg_catalog.count(*) FROM pg_catalog.pg_proc p WHERE p.oid IN (v_fn, v_gate) AND p.xmin = v_xid) <> 2",
      "NOT EXISTS (SELECT 1 FROM pg_catalog.pg_trigger t WHERE t.oid = v_trig AND t.xmin = v_xid)",
      "'VERIFY FAILED (220): the disposition RPC, the gate and the trigger were not all written by this one transaction'",
      // The census filter, whole: excluded are only the rows recorded before M220 wrote (by position AND identity).
      "INTO v_code\n      FROM (SELECT 'pg_proc'::text AS rel, x.ctid::text AS k,",
      "FROM phoenix_private.central_needs_lifecycle_attestations x WHERE x.xmin = v_xid) w\n   WHERE (w.rel || '@' || w.k || '@' || w.obj) <> ALL (pg_catalog.current_setting('phoenix_m220.preexisting')::text[])\n     AND w.obj <> ALL (ARRAY[",
      "  IF v_code IS NOT NULL THEN\n    RAISE EXCEPTION 'VERIFY FAILED (220): this transaction wrote beyond the disposition RPC, the gate and its trigger: %', v_code;",
    ]) {
      expect(VERIFY, needle).toContain(needle);
    }
    // The body fingerprints VERIFY pins ARE the two bodies in this file (LF-normalised md5 of prosrc).
    expect(VERIFY).toContain(`IS DISTINCT FROM '${md5(prosrc(SQL.replace(/\r\n/g, '\n'), DISPOSITION))}' THEN`);
    expect(VERIFY).toContain(`IS DISTINCT FROM '${md5(prosrc(SQL.replace(/\r\n/g, '\n'), GATE))}' THEN`);
    expect(VERIFY.match(/pg_catalog\.md5\(pg_catalog\.replace\(p\.prosrc, E'\\r\\n', E'\\n'\)\)/g)).toHaveLength(3);
    // The trigger inventory is M218 VERIFY F7's frozen set plus exactly the new trigger, in byte order.
    const arrayAfter = (text: string, anchor: string) => {
      const at = text.indexOf(anchor);
      expect(at, anchor).toBeGreaterThan(0);
      const open = text.indexOf("IS DISTINCT FROM ARRAY[", at) + "IS DISTINCT FROM ARRAY[".length;
      const close = text.indexOf('] THEN', open);
      return [...text.slice(open, close).matchAll(/'([^']+)'/g)].map((m) => m[1]);
    };
    const frozen218 = arrayAfter(M218, 'F7. The exact trigger inventory');
    const inventory220 = arrayAfter(VERIFY, "FROM (SELECT pg_catalog.format('%s|%s|%s.%s|%s|%s|%s', c.relname, t.tgname");
    const added = `central_needs_plan_revisions|${TRIGGER}|phoenix_private.central_needs_active_item_gate_v1|19|O|0`;
    expect(frozen218).toHaveLength(16);
    expect(inventory220).toEqual([...frozen218, added].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
    // The writer census is M218 VERIFY F1's list, unchanged (the gate writes nothing).
    const census218 = arrayAfter(M218, 'F1. The writer census');
    const census220 = arrayAfter(VERIFY, "WHERE ns.nspname NOT IN ('pg_catalog', 'information_schema')");
    expect(census218).toHaveLength(15);
    expect(census220).toEqual(census218);
  });

  it('VERIFY never fingerprints whole tables: every table the prelude and VERIFY read is read only through the xmin write census', () => {
    // The Run-3 baselines of whole tables (and of whole catalogs) are gone for good.
    for (const gone of ['phoenix_m220.business', 'phoenix_m220.untouched', 'phoenix_m220.acl']) {
      expect(SQL, gone).not.toContain(gone);
    }
    const prelude = CODE.slice(CODE.indexOf('DO $prelude$'), CODE.indexOf('$prelude$;'));
    expect(prelude.length).toBeGreaterThan(0);
    // Executable text only (string literals blanked): a needle VERIFY searches for in a body is not a read.
    const preludeExec = EXEC.slice(EXEC.indexOf('DO $prelude$'), EXEC.indexOf('$prelude$;'));
    const verifyExec = EXEC.slice(EXEC.indexOf('DO $verify$'));
    for (const [label, block] of [['prelude', preludeExec], ['VERIFY', verifyExec]] as const) {
      // Every application table read names its alias and is filtered to rows THIS transaction wrote.
      const reads = [...block.matchAll(/\bFROM\s+(public|phoenix_private)\.([a-z_0-9]+)(?!\s*\(|[a-z_0-9])(\s+\w+)?(\s+WHERE\s+\w+\.xmin\s*=\s*v_xid)?/gi)];
      expect(reads.map((m) => m[2]), label).toEqual(['central_items', 'central_needs_plan_revisions', 'central_needs_import_sessions',
        'central_needs_record_mappings', 'central_needs_need_lines', 'audit_logs', 'central_needs_lifecycle_attestations']);
      for (const m of reads) expect(m[4], `${label}: ${m[0]}`).toBeTruthy();
      // No join or count over an application table anywhere in the block.
      expect(block, label).not.toMatch(/\bJOIN\s+(public|phoenix_private)\./i);
      expect(block, label).not.toMatch(/count\(\*\)\s+FROM\s+(public|phoenix_private)\./i);
      // The census' catalog reads are filtered the same way.
      const catalogReads = [...block.matchAll(/FROM pg_catalog\.(pg_[a-z_]+) x\b(\s+WHERE x\.xmin = v_xid)?/g)];
      expect(catalogReads.length, label).toBe(17);
      for (const m of catalogReads) expect(m[2], `${label}: ${m[0]}`).toBeTruthy();
    }
    // One census, byte-identical in both blocks.
    const censusOf = (block: string) => {
      const at = block.indexOf("FROM (SELECT 'pg_proc'::text AS rel");
      expect(at).toBeGreaterThan(0);
      return block.slice(at, block.indexOf(') w', at) + ') w'.length);
    };
    const census = censusOf(prelude);
    expect(censusOf(VERIFY)).toBe(census);
    expect([...census.matchAll(/FROM ([a-z_]+\.[a-z_]+) x WHERE x\.xmin = v_xid/g)].map((m) => m[1])).toEqual([
      'pg_catalog.pg_proc', 'pg_catalog.pg_trigger', 'pg_catalog.pg_description', 'pg_catalog.pg_depend', 'pg_catalog.pg_class',
      'pg_catalog.pg_attribute', 'pg_catalog.pg_attrdef', 'pg_catalog.pg_constraint', 'pg_catalog.pg_index', 'pg_catalog.pg_policy',
      'pg_catalog.pg_rewrite', 'pg_catalog.pg_type', 'pg_catalog.pg_namespace', 'pg_catalog.pg_default_acl', 'pg_catalog.pg_init_privs',
      'pg_catalog.pg_event_trigger', 'pg_catalog.pg_extension',
      'public.central_items', 'public.central_needs_plan_revisions', 'public.central_needs_import_sessions',
      'public.central_needs_record_mappings', 'public.central_needs_need_lines', 'public.audit_logs',
      'phoenix_private.central_needs_lifecycle_attestations',
    ]);
    // The key: THIS transaction's id, taken in the prelude (before the lock and every DDL), its low 32 bits as the xid.
    expect(prelude).toContain('v_xid  := (v_txid % 4294967296)::text::xid;');
    expect(VERIFY).toContain("v_xid  := (pg_catalog.current_setting('phoenix_m220.txid')::bigint % 4294967296)::text::xid;");
    // Expected writes: exactly the RPC, the gate and the trigger (definitions, comments, dependencies).
    expect(normalizeSql(VERIFY)).toContain(normalizeSql(`AND w.obj <> ALL (ARRAY[pg_catalog.format('%s:%s', 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, v_fn),
                             pg_catalog.format('%s:%s', 'pg_catalog.pg_proc'::pg_catalog.regclass::pg_catalog.oid, v_gate),
                             pg_catalog.format('%s:%s', 'pg_catalog.pg_trigger'::pg_catalog.regclass::pg_catalog.oid, v_trig)]);`));
    expect(VERIFY.match(/w\.obj <> ALL/g)).toHaveLength(1);
  });

  it('no statement of the file writes a row: DML exists only inside the replaced RPC body (its runtime write path)', () => {
    let rest = SQL.replace(/\r\n/g, '\n');
    rest = rest.replace(fnDef(rest, DISPOSITION), '').replace(fnDef(rest, GATE), '');
    const top = executableSql(rest);
    for (const dml of [/\bINSERT\s+INTO\b/i, /\bUPDATE\s+(ONLY\s+)?[a-z_."]+\s+SET\b/i, /\bDELETE\s+FROM\b/i, /\bTRUNCATE\b/i,
      /\bMERGE\s+INTO\b/i, /\bCOPY\b/i, /\bDROP\b/i, /\bSELECT\s+[^;]*\bINTO\s+(TEMP|TEMPORARY|UNLOGGED|TABLE)\b/i]) {
      expect(top, String(dml)).not.toMatch(dml);
    }
    // The only application routine the two DO blocks call is the read-only M218 seal predicate.
    const doBlocks = [['DO $prelude$', '$prelude$;'], ['DO $verify$', '$verify$;']].map(([open, close]) => {
      const at = top.indexOf(open);
      expect(at, open).toBeGreaterThan(0);
      return top.slice(at, top.indexOf(close, at + open.length));
    }).join('\n');
    const called = new Set([...doBlocks.matchAll(/\b(public|phoenix_private)\.([a-z_0-9]+)\s*\(/gi)].map((m) => `${m[1]}.${m[2]}`));
    expect([...called].sort()).toEqual(['phoenix_private.central_needs_capability_breaches_v1']);
  });
});
