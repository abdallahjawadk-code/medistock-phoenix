/**
 * C6-F1 / M218 FINAL — DYNAMIC proof of the capability-isolated, sealed
 * Central Needs submission architecture against a real disposable PostgreSQL.
 *
 * The rig is built through 217 first. On that chain the suite reproduces the
 * F1 defect (a privileged DRAFT -> SUBMITTED write that the canonical approve
 * then accepts), records the pre-M218 capability inventory and behaviour
 * (service_role's CREATE, TRIGGER, Central Needs DML and EXECUTE surface; the
 * lifecycle ACLs; the duplicate-submit and unauthorized-caller refusals) and
 * exercises the migration text itself: READ COMMITTED, the applier
 * preconditions, NOWAIT on all 13 Central Needs tables, the lock budget,
 * VERIFY's negative controls section by section, pre-existing untrusted
 * objects, and the fail-closed SUBMITTED precondition. Then the rest of the
 * canonical chain (exactly M218) is applied through applyMigrationSql and the
 * contract runs on the full 001..218 chain: the lifecycle matrix A1-A15, the
 * owner's attack matrix §15.1-§15.25, the sealed SUBMITTED state (every
 * mutating RPC and every direct write refused), the one-time digest (and the
 * proof that approve never re-hashes), the submit isolation check, the
 * runtime seal predicate against privilege drift, default privileges, the
 * private schema, SECURITY DEFINER search paths, the function-level submit
 * timeout, service_role compatibility, concurrency and replay.
 *
 * TRUST MODEL (FINAL): the root of trust is a true superuser and the owner of
 * the Central Needs tables. service_role, authenticated, anon and every other
 * role (BYPASSRLS or not) are untrusted: none holds a Central Needs write,
 * TRUNCATE, REFERENCES, TRIGGER or MAINTAIN, TRIGGER on any public relation,
 * or CREATE on public / phoenix_private. Tests that hand-write a PRIVATE
 * attestation, or write sealed state directly, do so as the rig superuser on
 * purpose — the root of trust — and are always rolled back.
 *
 * Every refusal names the actor and the expected SQLSTATE and message, and
 * proves no partial write: a byte-identical snapshot of the revision family,
 * its need lines and links, a zero global audit delta, and unchanged
 * per-revision evidence (status, submission gates, submit audits, approval
 * gates, approve audits, private attestations). Gated on PHOENIX_RIG_PG;
 * skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigrationSql, buildRig, migrationFiles, MIGRATIONS_DIR, rigAvailable, shimSql,
} from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const M218 = '218_phoenix_central_needs_submission_integrity_fence.sql';
/** The submit RPC's function-level statement_timeout, exactly as the migration declares it. */
const SUBMIT_TIMEOUT = (/SET statement_timeout = '([^']+)'\nAS \$\$/.exec(readFileSync(join(MIGRATIONS_DIR, M218), 'utf8')) ?? [])[1] as string;

const ORG_OWNER = '00000000-0000-0000-0000-000000218001'; // pharmacy department authority, owns every plan
const ORG_BENE_A = '00000000-0000-0000-0000-000000218002';
const ORG_BENE_B = '00000000-0000-0000-0000-000000218003';
const ORG_OTHER = '00000000-0000-0000-0000-000000218005'; // unrelated owner organization

const U_EDIT = '00000000-0000-0000-0000-000000218401';    // view/import/edit on the owner
const U_APPROVE = '00000000-0000-0000-0000-000000218402'; // view/approve on the owner
const U_VIEW = '00000000-0000-0000-0000-000000218403';    // view only
const U_NOPERM = '00000000-0000-0000-0000-000000218404';  // eligible role, no key
const U_INST = '00000000-0000-0000-0000-000000218405';    // ineligible role, every key
const U_OTHER = '00000000-0000-0000-0000-000000218406';   // every key, other organization

const ITEM_A = '00000000-0000-0000-0000-000000218801';

const PARSER_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};
const BROWSER_IDENTITY = { ...PARSER_IDENTITY, runtime: 'browser_worker' };

const PRIVATE = 'phoenix_private';
const FENCE = 'phoenix_private.central_needs_submission_gate_fence_v1';
const APPROVAL_FENCE = 'public._phoenix_central_needs_approval_gate_fence_v1';
const APPROVAL_BODY = 'phoenix_private.central_needs_approval_gate_fence_v1';
const APPROVAL_BODY_SIG = `${APPROVAL_BODY}(text, public.central_needs_plan_revisions, public.central_needs_plan_revisions)`;
const DIGEST = 'phoenix_private.central_needs_submission_state_digest_v1';
const BREACHES = 'phoenix_private.central_needs_capability_breaches_v1';
const BLOCKERS = 'public._phoenix_central_needs_review_blockers_v1';
const STORE = 'phoenix_private.central_needs_lifecycle_attestations';
const CONTRACT = 'c6-f1-final-v1';
const R2_DIGEST = 'public._phoenix_central_needs_submission_state_digest_v1';
const R2_FENCE = 'public._phoenix_central_needs_submission_gate_fence_v1';
const R2_STORE = 'public.central_needs_lifecycle_attestations';
const APPROVAL_GATE_MISSING = 'central_needs_approval_gate_missing';
const GATE_MISSING = 'central_needs_submission_gate_missing';
const PROVENANCE_MISSING = 'central_needs_submission_provenance_missing';
const SEAL_BREACHED = 'central_needs_capability_seal_breached';
const RC_REQUIRED = 'central_needs_submit_requires_read_committed';
const NOT_EDITABLE = 'plan_revision_not_editable';
const SET_LINE = 'SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[],$8,$9,$10,$11) AS result';
const SET_COLUMNS = 'SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result';
const OPEN_DRAFT = 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result';
const OPEN_CORRECTION = 'SELECT public.phoenix_central_needs_open_correction_revision($1,$2,$3,$4) AS result';
const SUBMIT = 'SELECT public.phoenix_central_needs_submit_revision($1) AS result';
const APPROVE = 'SELECT public.phoenix_central_needs_approve_revision($1) AS result';
const REJECT = 'SELECT public.phoenix_central_needs_reject_revision($1,$2) AS result';
const READINESS = 'SELECT public.phoenix_central_needs_review_readiness($1) AS result';
const REPLAY = 'SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result';
const REGISTER = 'SELECT public.phoenix_central_needs_register_import_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NULL) AS result';
const PAYLOAD_DIGEST = 'SELECT public._phoenix_central_needs_payload_digest_v1($1::jsonb) AS result';
const DIRECT_SUBMIT = `UPDATE public.central_needs_plan_revisions SET status = 'submitted' WHERE id = $1`;
const DIRECT_APPROVE = `UPDATE public.central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`;
const LIFECYCLE_SIGS = [
  'public.phoenix_central_needs_submit_revision(uuid)',
  'public.phoenix_central_needs_approve_revision(uuid)',
  'public.phoenix_central_needs_reject_revision(uuid, text)',
];
const CN_TABLES = [
  'central_needs_plans', 'central_needs_plan_revisions', 'central_needs_source_files', 'central_needs_import_sessions',
  'central_needs_source_records', 'central_needs_record_mappings', 'central_needs_field_overrides', 'central_needs_import_batches',
  'central_needs_import_batch_entries', 'central_needs_beneficiary_column_mappings', 'central_needs_beneficiary_regions',
  'central_needs_need_lines', 'central_needs_need_line_sources',
];
const CN_WRITE_PRIVS = ['INSERT', 'UPDATE', 'DELETE', 'TRUNCATE', 'REFERENCES', 'TRIGGER', 'MAINTAIN'];
/** The three Central Needs SECURITY DEFINER routines the trusted finalize-import endpoint calls as service_role. */
const SVC_KEPT = ['_phoenix_central_needs_payload_digest_v1', 'phoenix_central_needs_apply_authoritative_replay',
  'phoenix_central_needs_register_import_batch'];
/** The non-Central-Needs RPCs service_role-key runtime callers (API + edge functions) invoke. */
const SVC_RUNTIME_OTHER = [
  'public.phoenix_profile_has_permission(uuid, text)',
  'public.phoenix_admin_provision_profile(uuid, uuid, uuid, uuid, text, text, text, text, text, uuid)',
  'public.phoenix_outbox_claim_batch(text, uuid, integer)',
  'public.phoenix_outbox_mark_completed(text, uuid, uuid)',
  'public.phoenix_outbox_mark_failed(text, uuid, uuid, text, text)',
  'public.phoenix_outbox_release_lease(text, uuid, uuid)',
  'public.phoenix_admin_assign_facility_scopes(uuid, uuid, uuid[])',
];

interface Refusal { code: string; message: string; detail?: string }

/** Resolves to the database error a call was refused with; fails the test if it succeeded. */
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const denied = (rel: string) => ({ code: '42501', message: `permission denied for table ${rel}` });

type Cell = { col: number; value?: unknown };
type Row = { row: number; item?: string; decision?: 'mapped' | 'not_applicable'; cells: Cell[] };
type LineSpec = { beneficiary: string; warehouse?: string | null };
type Outcome = { ok: boolean; rows?: any[]; rowCount?: number; error?: Refusal };
/** A privileged direct-write attacker: 'fence' = the root of trust, stopped by the fences; 'privilege' = a non-root role, stopped by its privileges. */
type Attacker = readonly [string, () => Promise<unknown>, 'fence' | 'privilege'];

run('C6-F1/M218 FINAL capability-isolated sealed submission — dynamic (PostgreSQL)', { timeout: 120_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 1999;
  let fileSeq = 0;
  let orgSeq = 0;
  let roleSeq = 0;
  let aclBefore: any[] = [];
  let tableAclBefore: any[] = [];
  let svcBefore: any = null;
  let duplicateSubmitBefore: Refusal | null = null;
  let unauthorizedBefore: Record<string, Refusal> = {};
  const nextYear = () => {
    year += 1;
    if (year > 2100) throw new Error('plan_year counter exhausted (CHECK 2000-2100)');
    return year;
  };
  const nextRole = (tag: string) => { roleSeq += 1; return `p218f_${tag}_${roleSeq}_${Math.floor(Math.random() * 1e6)}`; };

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });
  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  /** Superuser transaction that is ALWAYS rolled back: a probe of a hypothetical state. */
  const probe = <T = any>(fn: (c: any) => Promise<T>): Promise<T> => rig.asAdmin(async (c: any) => {
    await c.query('BEGIN');
    try {
      return await fn(c);
    } finally {
      await c.query('ROLLBACK');
    }
  });
  /** Inside a probe: run `sql` as a fresh throwaway role (created in the probe, so it never survives). */
  const asFreshRole = async (c: any, opts: { bypassrls?: boolean; memberOf?: string | null; claim?: string | null }, sql: string, params: unknown[] = []) => {
    const role = nextRole('r');
    await c.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER ${opts.bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`);
    if (opts.memberOf) await c.query(`GRANT ${opts.memberOf} TO ${role}`);
    await c.query(`SET LOCAL ROLE ${role}`);
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [opts.claim ?? '']);
    return c.query(sql, params);
  };
  /** Outcome text of `sql` inside a rolled-back probe as the given role ('superuser' stays root). */
  const tryAs = (role: string, sql: string, params: unknown[] = [], claim: string | null = null) => probe(async (c: any) => {
    await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [claim ?? '']);
    if (role !== 'superuser') await c.query(`SET LOCAL ROLE ${role}`);
    return c.query(sql, params).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
  });

  /** An explicitly held transaction, for deterministic interleavings. `setup` runs before SET ROLE. */
  const held = async (userId: string | null, role = 'authenticated', setup: string[] = []) => {
    const client = await rig.pool.connect();
    let open = true;
    await client.query('BEGIN');
    for (const s of setup) await client.query(s);
    if (role !== 'superuser') await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    const [{ pid }] = (await client.query('SELECT pg_backend_pid() AS pid')).rows;
    const finish = async (verb: 'COMMIT' | 'ROLLBACK'): Promise<Outcome> => {
      if (!open) return { ok: true };
      open = false;
      try {
        await client.query(verb);
        return { ok: true };
      } catch (e) {
        const err = e as any;
        return { ok: false, error: { code: String(err.code), message: String(err.message), detail: err.detail } };
      } finally {
        client.release();
      }
    };
    return {
      pid: pid as number,
      q: (sql: string, params: unknown[] = []): Promise<Outcome> => client.query(sql, params).then(
        (r: any) => ({ ok: true, rows: r.rows, rowCount: r.rowCount }),
        (e: any) => ({ ok: false, error: { code: String(e.code), message: String(e.message), detail: e.detail } })),
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK'),
    };
  };

  /** Waits until `pid` is waiting on a heavyweight lock held by `by`. */
  const waitBlocked = async (pid: number, by: number) => {
    for (let i = 0; i < 200; i += 1) {
      const [row] = await admin(
        `SELECT wait_event_type, pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (row && row.wait_event_type === 'Lock' && (row.blockers as number[]).includes(by)) return;
      await sleep(50);
    }
    throw new Error(`backend ${pid} never waited on a lock held by ${by}`);
  };

  // ---- the migration text --------------------------------------------------
  const m218Text = () => readFileSync(join(MIGRATIONS_DIR, M218), 'utf8');
  const applyM218 = (c: any) => applyMigrationSql(c, M218, shimSql(M218, m218Text()));
  /** Applies M218 on one client and returns the refusal (with the transaction rolled back), or null on success. */
  const tryApplyM218 = (c: any): Promise<Refusal | null> => applyM218(c).then(() => null, async (e: any) => {
    await c.query('ROLLBACK').catch(() => undefined);
    return { code: String(e.code), message: String(e.message), detail: e.detail };
  });
  /** The M218 text exactly as on disk, WITHOUT its final COMMIT (asserted to be the last statement). */
  const m218Uncommitted = () => {
    const text = m218Text();
    const commitAt = text.lastIndexOf('COMMIT;');
    expect(text.slice(commitAt + 'COMMIT;'.length).trim()).toBe('');
    return text.slice(0, commitAt);
  };
  /** The CREATE [OR REPLACE] FUNCTION statement of `name` in `text`, through its closing `$$;`. */
  const fnDefOf = (text: string, name: string) => {
    let at = text.indexOf(`CREATE OR REPLACE FUNCTION ${name}(`);
    if (at < 0) at = text.indexOf(`CREATE FUNCTION ${name}(`);
    expect(at, name).toBeGreaterThanOrEqual(0);
    const end = text.indexOf('\n$$;\n', at);
    expect(end, name).toBeGreaterThan(at);
    return text.slice(at, end + '\n$$;'.length);
  };
  /** `text` with a re-definition of `name` (exactly one `from` -> `to`) inserted before VERIFY. */
  const redefinedBeforeVerify = (text: string, name: string, from: string, to: string) => {
    const def = fnDefOf(text, name).replace(/^CREATE FUNCTION /, 'CREATE OR REPLACE FUNCTION ');
    expect(def.split(from), `${name}: ${from}`).toHaveLength(2);
    return beforeVerify(text, `${def.replace(from, to)}\n`);
  };
  /** A copy of `text` with `sql` inserted immediately before the VERIFY block. */
  const beforeVerify = (text: string, sql: string) => {
    const at = text.indexOf('DO $verify$');
    expect(at).toBeGreaterThan(0);
    return `${text.slice(0, at)}${sql}\n\n${text.slice(at)}`;
  };
  /** A copy of `text` with exactly one occurrence of `from` replaced by `to`. */
  const replaced = (text: string, from: string, to: string) => {
    expect(text.split(from), from.slice(0, 80)).toHaveLength(2);
    return text.replace(from, to);
  };
  /**
   * REHEARSAL ONLY (never a migration path): runs `setup`, then a (possibly
   * modified) M218 text without its COMMIT, inside ONE superuser transaction
   * that is ALWAYS rolled back. Resolves to the refusal, or null when the
   * whole text ran.
   */
  const rehearseM218 = (text: string, setup: string[] = []): Promise<Refusal | null> => rig.asAdmin(async (c: any) => {
    await c.query('BEGIN');
    try {
      for (const s of setup) await c.query(s);
      return await c.query(text).then(() => null,
        (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail } as Refusal));
    } finally {
      await c.query('ROLLBACK');
    }
  });
  const m218Objects = async () => (await admin(`
    SELECT to_regnamespace('${PRIVATE}') IS NOT NULL AS private_schema,
           to_regprocedure('${FENCE}()') IS NOT NULL AS fence_fn,
           EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'central_needs_plan_revisions_c6_submission_gate') AS fence,
           position('submission_gate' IN pg_get_functiondef('public.phoenix_central_needs_submit_revision(uuid)'::regprocedure)) > 0 AS submit_gate,
           position('${PROVENANCE_MISSING}' IN pg_get_functiondef('public.phoenix_central_needs_approve_revision(uuid)'::regprocedure)) > 0 AS approve_provenance,
           to_regclass('${STORE}') IS NOT NULL AS store,
           to_regprocedure('${DIGEST}(uuid)') IS NOT NULL AS digest_fn,
           to_regprocedure('${BREACHES}()') IS NOT NULL AS breaches_fn,
           position('${APPROVAL_BODY}' IN pg_get_functiondef('${APPROVAL_FENCE}()'::regprocedure)) > 0 AS approval_fence_private,
           NOT has_schema_privilege('service_role', 'public', 'CREATE') AS svc_create_revoked,
           NOT has_table_privilege('service_role', 'public.audit_logs', 'TRIGGER') AS svc_trigger_revoked,
           NOT has_table_privilege('service_role', 'public.central_needs_need_lines', 'UPDATE') AS svc_dml_revoked`))[0];
  const NOTHING = { private_schema: false, fence_fn: false, fence: false, submit_gate: false, approve_provenance: false, store: false,
    digest_fn: false, breaches_fn: false, approval_fence_private: false, svc_create_revoked: false, svc_trigger_revoked: false,
    svc_dml_revoked: false };
  const EVERYTHING = Object.fromEntries(Object.keys(NOTHING).map((k) => [k, true]));

  /** The exact ACL of the three lifecycle RPCs: proacl text and the order-insensitive aclexplode tuple set. */
  const lifecycleAcl = () => admin(`
    SELECT p.oid::regprocedure::text AS fn, pg_get_userbyid(p.proowner) AS owner, p.proacl::text AS acl,
           (SELECT coalesce(jsonb_agg(t.x ORDER BY t.x::text), '[]'::jsonb) FROM (
              SELECT jsonb_build_object('grantee', CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END,
                                        'grantor', pg_get_userbyid(a.grantor), 'privilege', a.privilege_type,
                                        'grantable', a.is_grantable) AS x
                FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a) t) AS tuples
      FROM pg_proc p WHERE p.oid = ANY ($1::regprocedure[]) ORDER BY 1`, [LIFECYCLE_SIGS]);
  const tableAcl = () => admin(`
    SELECT c.relname AS rel, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
           (SELECT coalesce(jsonb_agg(t.x ORDER BY t.x), '[]'::jsonb) FROM (
              SELECT (CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END) || '|' || a.privilege_type
                     || '|' || pg_get_userbyid(a.grantor) || '|' || a.is_grantable AS x
                FROM aclexplode(coalesce(c.relacl, acldefault('r', c.relowner))) a) t) AS tuples
      FROM pg_class c WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f') ORDER BY 1`);
  /** service_role's capability surface (the report's BEFORE/AFTER inventory). */
  const serviceRoleSurface = async () => (await admin(`
    SELECT has_schema_privilege('service_role', 'public', 'CREATE') AS public_create,
           (SELECT coalesce(array_agg(c.relname::text ORDER BY c.relname::text), '{}') FROM pg_class c
             WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
               AND has_table_privilege('service_role', c.oid, 'TRIGGER')) AS trigger_relations,
           (SELECT coalesce(jsonb_object_agg(t, (SELECT coalesce(array_agg(p ORDER BY p), '{}') FROM unnest($1::text[]) p
                                                  WHERE has_table_privilege('service_role', ('public.' || t)::regclass, p))), '{}')
              FROM unnest($2::text[]) t) AS cn_privileges,
           (SELECT coalesce(array_agg(p.proname::text ORDER BY p.proname::text), '{}') FROM pg_proc p
             WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%central\\_needs\\_%' AND p.prosecdef
               AND has_function_privilege('service_role', p.oid, 'EXECUTE')) AS cn_definer_execute,
           (SELECT coalesce(array_agg(x ORDER BY x), '{}') FROM (
              SELECT format('%s|%s|%s', coalesce(n.nspname, '-'), d.defaclobjtype, a.privilege_type) AS x
                FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace
               CROSS JOIN LATERAL aclexplode(d.defaclacl) a WHERE a.grantee = 'service_role'::regrole) s) AS defaults`,
  [[...CN_WRITE_PRIVS, 'SELECT'], CN_TABLES]))[0];

  // ---- evidence and workflow helpers --------------------------------------
  const mkOrg = async (tag: string) => {
    orgSeq += 1;
    const [{ id }] = await admin(
      `INSERT INTO organizations (name, name_ar, code, organization_kind, institution_class)
       VALUES ($1, $1, $2, 'care_institution', 'hospital') RETURNING id`,
      [`F1 ${tag} ${orgSeq}`, `p218-${tag}-${orgSeq}`]);
    return id as string;
  };

  const provenance = (row: number, col: number, fileHash: string) => ({
    fileFingerprintSha256: fileHash, originalFilename: `needs-${fileHash.slice(0, 6)}.xlsx`, parserVersion: '1.0.0',
    sheetIndex: 0, sheetName: 'Sheet0', sheetHidden: 'visible',
    coordinate: { row, col, a1: `${String.fromCharCode(65 + (col % 26))}${row + 1}` },
    extractedAt: '2026-09-27T00:00:00.000Z',
  });

  /** One completed import session with explicit physical cells on sheet 0 (root fixture). Records keyed `${row}:${col}`. */
  async function addSession(revId: string, rows: Row[]) {
    fileSeq += 1;
    const fileHash = `${fileSeq}`.padStart(64, 'b');
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,2048) RETURNING id`, [revId, ORG_OWNER, `needs-${fileSeq}.xlsx`, fileHash]);
    const digest = `${fileSeq}`.padStart(64, 'e');
    const [{ id: sessionId }] = await admin(
      `INSERT INTO central_needs_import_sessions
         (plan_revision_id, organization_id, source_file_id, status, preview_digest, authoritative_digest, parser_identity, completed_at)
       VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`,
      [revId, ORG_OWNER, fileId, digest, JSON.stringify(PARSER_IDENTITY)]);
    const records = new Map<string, string>();
    let ordinal = 0;
    for (const row of rows) {
      const entity = `sheet:0:row:${row.row}`;
      for (const cell of row.cells) {
        ordinal += 1;
        const value = cell.value === undefined ? 10 : cell.value;
        const sv = { value, valueType: typeof value === 'number' ? 'number' : 'string', isFormula: false, formula: null };
        const [{ id }] = await admin(
          `INSERT INTO central_needs_source_records
             (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values, source_provenance)
           VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb) RETURNING id`,
          [sessionId, ORG_OWNER, ordinal, entity, `col:${cell.col}`, JSON.stringify(sv), JSON.stringify(provenance(row.row, cell.col, fileHash))]);
        records.set(`${row.row}:${cell.col}`, id);
      }
      const decision = row.decision ?? 'mapped';
      await admin(
        `INSERT INTO central_needs_record_mappings
           (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [sessionId, ORG_OWNER, entity, decision === 'mapped' ? (row.item ?? ITEM_A) : null, decision,
          decision === 'mapped' ? null : 'out of scope']);
    }
    return { sessionId, fileHash, records, rec: (row: number, col: number) => records.get(`${row}:${col}`)! };
  }

  const openDraft = async (y = nextYear()) => {
    const r = await call(U_EDIT, OPEN_DRAFT, [ORG_OWNER, y, false]);
    const [{ plan_id: planId }] = await admin(`SELECT plan_id FROM central_needs_plan_revisions WHERE id = $1`, [r.plan_revision_id]);
    return { y, rev: r.plan_revision_id as string, planId: planId as string };
  };
  const confirm = (revId: string, sessionId: string, cols: Array<[number, string]>) => call(U_EDIT, SET_COLUMNS, [revId,
    JSON.stringify(cols.map(([columnIndex, beneficiaryOrganizationId]) => ({ importSessionId: sessionId, sheetIndex: 0, columnIndex, beneficiaryOrganizationId }))),
    'confirmed beneficiary column']);
  const setLine = (revId: string, o: { beneficiary: string; qty: number; sources: unknown[]; warehouse?: string | null }) =>
    call(U_EDIT, SET_LINE, [revId, o.beneficiary, ITEM_A, o.qty, 'designated by reviewer', JSON.stringify(o.sources),
      [], 'box', 'canonical', o.warehouse ?? null, null]);
  const trustBatch = async (revId: string, sessionIds: string[]) => {
    fileSeq += 1;
    const [{ id: batchId }] = await admin(
      `INSERT INTO central_needs_import_batches
         (plan_revision_id, organization_id, container_kind, container_filename, container_sha256,
          storage_locator, accepted_entry_count, parser_identity)
       VALUES ($1,$2,'file','needs.xlsx',$3,'permanent/x',$4,$5::jsonb) RETURNING id`,
      [revId, ORG_OWNER, `${fileSeq}`.padStart(64, 'c'), sessionIds.length, JSON.stringify(PARSER_IDENTITY)]);
    for (const [i, sessionId] of sessionIds.entries()) {
      await admin(
        `INSERT INTO central_needs_import_batch_entries
           (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [batchId, revId, ORG_OWNER, i + 1, `${fileSeq}${i}`.padStart(64, 'd'), sessionId]);
    }
    return batchId as string;
  };

  /** Evidence and need lines for a DRAFT: one mapped row per line in its beneficiary's confirmed column, a trusted batch — READY. */
  const populate = async (rev: string, lines: LineSpec[]) => {
    const cols = new Map<string, number>();
    for (const l of lines) if (!cols.has(l.beneficiary)) cols.set(l.beneficiary, cols.size + 1);
    const sess = await addSession(rev, lines.map((l, i) => ({ row: i + 1, cells: [{ col: cols.get(l.beneficiary)!, value: 10 }] })));
    await confirm(rev, sess.sessionId, [...cols.entries()].map(([b, c]) => [c, b] as [number, string]));
    const lineIds: string[] = [];
    for (const [i, l] of lines.entries()) {
      const out = await setLine(rev, { beneficiary: l.beneficiary, warehouse: l.warehouse ?? null, qty: 10,
        sources: [{ sourceRecordId: sess.rec(i + 1, cols.get(l.beneficiary)!), designatedQuantity: '10', appliedOverrideId: null }] });
      lineIds.push(out.need_line_id);
    }
    const batchId = await trustBatch(rev, [sess.sessionId]);
    return { ...sess, lineIds, batchId };
  };
  /** A READY draft: readiness proven empty and ready=true by the real readiness RPC. */
  const readyDraft = async (lines: LineSpec[] = [{ beneficiary: ORG_BENE_A }]) => {
    const d = await openDraft();
    const p = await populate(d.rev, lines);
    expect(await blockers(d.rev)).toEqual([]);
    expect(await call(U_VIEW, READINESS, [d.rev])).toMatchObject({ ready: true, blockers: [] });
    return { ...d, ...p };
  };
  const submittedPlan = async (lines: LineSpec[] = [{ beneficiary: ORG_BENE_A }]) => {
    const d = await readyDraft(lines);
    expect(await call(U_EDIT, SUBMIT, [d.rev])).toEqual({ ok: true, plan_revision_id: d.rev, status: 'submitted' });
    return d;
  };
  const statuses = async (planId: string) => (await admin(
    `SELECT revision_number || ':' || status AS s FROM central_needs_plan_revisions WHERE plan_id = $1 ORDER BY revision_number`, [planId]))
    .map((r: any) => r.s);
  const blockers = (revId: string) => admin(`SELECT blocker, detail FROM ${BLOCKERS}($1)`, [revId]);

  /** The per-revision lifecycle evidence a refusal must never add to. */
  const evidence = async (rev: string) => (await admin(`
    SELECT (SELECT status FROM central_needs_plan_revisions WHERE id = $1) AS status,
           count(*) FILTER (WHERE a.action = 'central_needs.plan_revision.submission_gate')::int AS submission_gates,
           count(*) FILTER (WHERE a.action = 'central_needs.plan_revision.submit')::int AS submits,
           count(*) FILTER (WHERE a.action = 'central_needs.plan_revision.approval_gate')::int AS approval_gates,
           count(*) FILTER (WHERE a.action = 'central_needs.plan_revision.approve')::int AS approves
      FROM audit_logs a WHERE a.entity_id = $1`, [rev]))[0];

  /** The private attestations of one revision (superuser read), or null before M218 creates the store. */
  const attestations = async (rev: string): Promise<any[] | null> => {
    const [{ present }] = await admin(`SELECT to_regclass('${STORE}') IS NOT NULL AS present`);
    if (!present) return null;
    return admin(`
      SELECT a.phase, a.contract, a.actor_id, a.txid::text AS txid, a.state_digest, a.xmin::text AS xmin,
             to_jsonb(a.created_at) #>> '{}' AS ts
        FROM ${STORE} a WHERE a.plan_revision_id = $1 ORDER BY a.created_at, a.phase`, [rev]);
  };
  const attestCount = async (rev: string, phase: 'submit' | 'approve') =>
    ((await attestations(rev)) ?? []).filter((a: any) => a.phase === phase).length;
  /** The recomputed submission-state digest of one revision (superuser). */
  const digestOf = async (rev: string) => (await admin(`SELECT ${DIGEST}($1) AS d`, [rev]))[0].d as string;

  /** Every readiness-sensitive row of one revision, byte for byte (superuser read): the sealed state. */
  const sealedState = async (rev: string) => (await admin(`
    SELECT jsonb_build_object(
      'sessions', (SELECT coalesce(jsonb_agg(to_jsonb(s) ORDER BY s.id), '[]') FROM central_needs_import_sessions s WHERE s.plan_revision_id = $1),
      'files', (SELECT coalesce(jsonb_agg(to_jsonb(f) ORDER BY f.id), '[]') FROM central_needs_source_files f WHERE f.plan_revision_id = $1),
      'records', (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]') FROM central_needs_source_records r
                   WHERE r.import_session_id IN (SELECT id FROM central_needs_import_sessions WHERE plan_revision_id = $1)),
      'mappings', (SELECT coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id), '[]') FROM central_needs_record_mappings m
                    WHERE m.import_session_id IN (SELECT id FROM central_needs_import_sessions WHERE plan_revision_id = $1)),
      'overrides', (SELECT coalesce(jsonb_agg(to_jsonb(o) ORDER BY o.id), '[]') FROM central_needs_field_overrides o WHERE o.plan_revision_id = $1),
      'batches', (SELECT coalesce(jsonb_agg(to_jsonb(b) ORDER BY b.id), '[]') FROM central_needs_import_batches b WHERE b.plan_revision_id = $1),
      'entries', (SELECT coalesce(jsonb_agg(to_jsonb(e) ORDER BY e.id), '[]') FROM central_needs_import_batch_entries e WHERE e.plan_revision_id = $1),
      'columns', (SELECT coalesce(jsonb_agg(to_jsonb(c) ORDER BY c.id), '[]') FROM central_needs_beneficiary_column_mappings c WHERE c.plan_revision_id = $1),
      'regions', (SELECT coalesce(jsonb_agg(to_jsonb(g) ORDER BY g.version_id), '[]') FROM central_needs_beneficiary_regions g WHERE g.plan_revision_id = $1),
      'lines', (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id), '[]') FROM central_needs_need_lines n WHERE n.plan_revision_id = $1),
      'links', (SELECT coalesce(jsonb_agg(to_jsonb(l) ORDER BY l.id), '[]') FROM central_needs_need_line_sources l
                 WHERE l.need_line_id IN (SELECT id FROM central_needs_need_lines WHERE plan_revision_id = $1)),
      'revision', (SELECT to_jsonb(r) FROM central_needs_plan_revisions r WHERE r.id = $1)) AS s`, [rev]))[0].s;

  /** Everything a refusal must leave untouched, plus the global audit count and every private attestation. */
  async function snapshot(revId: string) {
    const [row] = await admin(`
      SELECT
        (SELECT coalesce(jsonb_agg(to_jsonb(n) ORDER BY n.id), '[]'::jsonb)
           FROM central_needs_need_lines n WHERE n.plan_revision_id = $1) AS lines,
        (SELECT coalesce(jsonb_agg(to_jsonb(ls) ORDER BY ls.id), '[]'::jsonb)
           FROM central_needs_need_line_sources ls JOIN central_needs_need_lines n ON n.id = ls.need_line_id
          WHERE n.plan_revision_id = $1) AS links,
        (SELECT coalesce(jsonb_agg(to_jsonb(r) ORDER BY r.id), '[]'::jsonb)
           FROM central_needs_plan_revisions r
          WHERE r.plan_id = (SELECT plan_id FROM central_needs_plan_revisions WHERE id = $1)) AS revisions,
        (SELECT count(*) FROM audit_logs)::int AS audit`, [revId]);
    const [{ present }] = await admin(`SELECT to_regclass('${STORE}') IS NOT NULL AS present`);
    const store = present ? (await admin(`SELECT count(*)::int AS n FROM ${STORE}`))[0].n : null;
    return { ...row, evidence: await evidence(revId), attestations: await attestations(revId), store };
  }

  /** Asserts the exact SQLSTATE and message, an unchanged final state, unchanged evidence and a zero audit delta. */
  async function refused(revId: string, action: () => Promise<unknown>, message: string, sqlstate = '23514') {
    const before = await snapshot(revId);
    const r = await refusal(action());
    expect(r.message).toBe(message);
    expect(r.code).toBe(sqlstate);
    expect(await snapshot(revId)).toEqual(before);
    return r;
  }
  /** One attacker of `attackers()`, with its expected refusal: the fence for the root of trust, the privilege for a non-root role. */
  async function refusedBy(revId: string, [who, attempt, kind]: Attacker, fenceMessage: string, table = 'central_needs_plan_revisions') {
    const expected = kind === 'fence' ? { code: '23514', message: fenceMessage } : denied(table);
    const r = await refused(revId, attempt, expected.message, expected.code);
    if (kind === 'fence') expect(r.detail, who).toBe(`revision=${revId}`);
    return r;
  }

  /** The owner of plan_revisions, for a BYPASSRLS member of the table owner (root-equivalent by inheritance). */
  const ownerIdent = async () => (await admin(
    `SELECT quote_ident(pg_get_userbyid(relowner)) AS o FROM pg_class WHERE oid = 'public.central_needs_plan_revisions'::regclass`))[0].o as string;

  /**
   * The privileged direct-write attackers: the rig superuser (with and without
   * the canonical editor's auth.uid()) and a BYPASSRLS member of the table
   * owner — both root of trust, stopped only by the fences; service_role (with
   * and without a JWT subject), a BYPASSRLS non-root role and a member of
   * service_role — untrusted, stopped by their privileges (throwaway roles are
   * created inside rolled-back probes and never survive).
   */
  const attackers = (sql: string, params: unknown[]): Attacker[] => {
    const asSuper = (claim: string | null) => rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [claim ?? '']);
        const out = await c.query(sql, params);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
    return [
      ['superuser', () => asSuper(null), 'fence'],
      ['superuser as the editor', () => asSuper(U_EDIT), 'fence'],
      ['BYPASSRLS member of the table owner as the editor', async () => probe(async (c: any) =>
        asFreshRole(c, { bypassrls: true, memberOf: await ownerIdent(), claim: U_EDIT }, sql, params)), 'fence'],
      ['service_role', () => call(null, sql, params, 'service_role'), 'privilege'],
      ['service_role as the editor', () => call(U_EDIT, sql, params, 'service_role'), 'privilege'],
      ['BYPASSRLS non-root role', () => probe((c: any) => asFreshRole(c, { bypassrls: true, claim: U_EDIT }, sql, params)), 'privilege'],
      ['member of service_role', () => probe((c: any) => asFreshRole(c, { memberOf: 'service_role', claim: U_EDIT }, sql, params)), 'privilege'],
    ];
  };

  /** The unauthorized-caller matrix of A14: [label, user, role, sql]. */
  const unauthorizedCalls = (rev: string) => [
    ['submit: no key (view only)', U_VIEW, 'authenticated', SUBMIT],
    ['submit: eligible role, no key', U_NOPERM, 'authenticated', SUBMIT],
    ['submit: ineligible role, every key', U_INST, 'authenticated', SUBMIT],
    ['submit: other organization', U_OTHER, 'authenticated', SUBMIT],
    ['submit: no identity', null, 'authenticated', SUBMIT],
    ['submit: anon', null, 'anon', SUBMIT],
    ['approve: editor without the approve key', U_EDIT, 'authenticated', APPROVE],
    ['approve: other organization', U_OTHER, 'authenticated', APPROVE],
    ['approve: no identity', null, 'authenticated', APPROVE],
    ['approve: anon', null, 'anon', APPROVE],
  ].map(([label, user, role, sql]) => ({ label: label as string, run: () => call(user as string | null, sql as string, [rev], role as string) }));

  /** Records whose provenance fingerprints `fileHash` (the finalize-import payload shape). */
  const replayRecords = (fileHash: string, entity = 'sheet:0:row:5') => ([{
    targetEntity: entity, fieldName: 'quantity',
    sourceValues: { value: 120, valueType: 'number', isFormula: false, formula: null },
    sourceProvenance: {
      fileFingerprintSha256: fileHash, originalFilename: 'needs.xls', parserVersion: '1.0.0/0.20.3',
      sheetIndex: 0, sheetName: 'Needs', sheetHidden: 'visible',
      coordinate: { row: 4, col: 2, a1: 'C5' }, extractedAt: '2026-09-27T00:00:00.000Z',
    },
  }]);
  /** The trusted finalize-import path of api/_cn2b-core/finalize-import.ts: the editor starts a session, service_role digests, replays, registers. */
  const finalizeImport = async (rev: string) => {
    fileSeq += 1;
    const fh = `${fileSeq}`.padStart(64, 'a');
    const records = replayRecords(fh);
    const digest = await call(null, PAYLOAD_DIGEST, [JSON.stringify(records)], 'service_role');
    const started = await call(U_EDIT, `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
      [rev, 'needs.xls', fh, digest, JSON.stringify(BROWSER_IDENTITY), 1024, `permanent/${fileSeq}`]);
    const session = started.import_session_id as string;
    const replayed = await call(null, REPLAY, [session, fh, JSON.stringify(records), JSON.stringify(PARSER_IDENTITY)], 'service_role');
    const registered = await call(null, REGISTER, [rev, 'file', 'needs.xls', `${fileSeq}`.padStart(64, 'f'), `permanent/${fileSeq}`,
      JSON.stringify([{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: fh, importSessionId: session }]),
      JSON.stringify(PARSER_IDENTITY), 2048, 0], 'service_role');
    return { session, fh, records, digest, replayed, registered };
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 217 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'F1 Pharmacy Dept','دائرة صحة','p218-owner','pharmacy_department_authority',NULL),
        ($2,'F1 Hospital A','مستشفى أ','p218-bene-a','care_institution','hospital'),
        ($3,'F1 Hospital B','مستشفى ب','p218-bene-b','care_institution','hospital'),
        ($4,'F1 Other Owner','جهة أخرى','p218-other','pharmacy_department_authority',NULL)`,
      [ORG_OWNER, ORG_BENE_A, ORG_BENE_B, ORG_OTHER]);
      await c.query(`INSERT INTO central_items (id, name, name_ar, unit) VALUES ($1,'F1 Item A','مادة أ','box')`, [ITEM_A]);
      await c.query(`INSERT INTO auth.users (id, email) VALUES
        ($1,'p218-edit@rig'),($2,'p218-approve@rig'),($3,'p218-view@rig'),($4,'p218-noperm@rig'),($5,'p218-inst@rig'),($6,'p218-other@rig')`,
      [U_EDIT, U_APPROVE, U_VIEW, U_NOPERM, U_INST, U_OTHER]);
      for (const [u, org, role] of [
        [U_EDIT, ORG_OWNER, 'central_warehouse_manager'], [U_APPROVE, ORG_OWNER, 'central_warehouse_manager'],
        [U_VIEW, ORG_OWNER, 'central_warehouse_manager'], [U_NOPERM, ORG_OWNER, 'central_warehouse_manager'],
        [U_INST, ORG_OWNER, 'institution_admin'], [U_OTHER, ORG_OTHER, 'central_warehouse_manager'],
      ] as const) {
        await c.query(`UPDATE profiles SET role=$1, status='active', organization_id=$2 WHERE id=$3`, [role, org, u]);
      }
      const grants: Array<[string, string[]]> = [
        [U_EDIT, ['view', 'import', 'edit']], [U_APPROVE, ['view', 'approve']], [U_VIEW, ['view']],
        [U_INST, ['view', 'import', 'edit', 'approve']], [U_OTHER, ['view', 'import', 'edit', 'approve']],
      ];
      for (const [u, keys] of grants) {
        for (const k of keys) {
          await c.query(
            `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
               ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [u, `central_needs.${k}`]);
        }
      }
    });
  }, 600000);

  afterAll(async () => { await rig?.end(); });

  // =========================================================================
  // THE 217 CHAIN, BEFORE M218 — the defect, the baseline, the migration text.
  // =========================================================================
  describe('on the 217 chain, before M218', () => {
    beforeAll(async () => {
      expect(migrationFiles().filter((f: string) => Number(f.slice(0, 3)) > 217)).toEqual([M218]);
      expect(await m218Objects()).toEqual(NOTHING);
      aclBefore = await lifecycleAcl();
      tableAclBefore = await tableAcl();
      svcBefore = await serviceRoleSurface();
    }, 60000);

    const fail = (message: string) => ({ code: 'P0001', message: `VERIFY FAILED (218): ${message}`, detail: undefined });
    /** SQL that rewrites an EXISTING routine (by its catalog definition) with one regexp substitution, failing if it does not apply. */
    const rewriteFn = (sig: string, pattern: string, replacement: string) => `DO $m$
      DECLARE d text := pg_catalog.pg_get_functiondef('${sig}'::regprocedure); n text;
      BEGIN
        n := pg_catalog.regexp_replace(d, $p$${pattern}$p$, $r$${replacement}$r$);
        IF n = d THEN RAISE EXCEPTION 'p218f rewrite of ${sig} did not apply'; END IF;
        EXECUTE n;
      END $m$;`;

    it('F1 reproduced: a privileged direct DRAFT -> SUBMITTED on an UNREADY draft, then the canonical approve APPROVES it (rolled back)', async () => {
      const d = await openDraft();
      expect((await blockers(d.rev)).map((b: any) => b.blocker)).toContain('no_finalized_import');
      const out = await probe(async (c: any) => {
        await c.query(DIRECT_SUBMIT, [d.rev]);
        await c.query('SET LOCAL ROLE authenticated');
        await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
        return (await c.query(APPROVE, [d.rev])).rows[0].result;
      });
      // Before M218 the mere value 'submitted' was proof enough: an empty, unready revision was approved.
      expect(out).toMatchObject({ ok: true, idempotent_replay: false, status: 'approved' });
      expect(await statuses(d.planId)).toEqual(['1:draft']);
    });

    it('baseline: a duplicate canonical submit is refused; the unauthorized callers are refused (recorded for A12/A14)', async () => {
      const s = await submittedPlan();
      duplicateSubmitBefore = await refusal(call(U_EDIT, SUBMIT, [s.rev]));
      expect(duplicateSubmitBefore.code).toBe('23514');
      const d = await readyDraft();
      for (const u of unauthorizedCalls(d.rev)) unauthorizedBefore[u.label] = await refusal(u.run());
      // Leave no SUBMITTED revision behind: the governed reject resolves it.
      expect(await call(U_APPROVE, REJECT, [s.rev, 'baseline fixture resolved'])).toMatchObject({ status: 'rejected' });
    });

    it('§1 capability inventory BEFORE M218: service_role holds CREATE on public, TRIGGER on every public relation, full Central Needs DML and the whole Central Needs SECURITY DEFINER surface; the default privileges re-grant it', async () => {
      expect(svcBefore.public_create).toBe(true);
      for (const t of [...CN_TABLES, 'audit_logs', 'organizations', 'warehouses', 'profiles']) {
        expect(svcBefore.trigger_relations, t).toContain(t);
      }
      for (const t of CN_TABLES) expect(svcBefore.cn_privileges[t], t).toEqual([...CN_WRITE_PRIVS, 'SELECT'].sort());
      for (const k of SVC_KEPT) expect(svcBefore.cn_definer_execute).toContain(k);
      for (const k of ['phoenix_central_needs_submit_revision', 'phoenix_central_needs_approve_revision',
        'phoenix_central_needs_reject_revision', 'phoenix_central_needs_set_need_line', '_phoenix_central_needs_load_revision_v1']) {
        expect(svcBefore.cn_definer_execute, k).toContain(k);
      }
      expect(svcBefore.defaults).toContain('public|r|TRIGGER');
      const [{ purger, anon, auth }] = await admin(`SELECT has_schema_privilege('phoenix_demo_purger', 'public', 'CREATE') AS purger,
        has_schema_privilege('anon', 'public', 'CREATE') AS anon, has_schema_privilege('authenticated', 'public', 'CREATE') AS auth`);
      expect({ purger, anon, auth }).toEqual({ purger: true, anon: false, auth: false });
    });

    it('refuses REPEATABLE READ and SERIALIZABLE with 218_requires_read_committed, applying nothing', async () => {
      for (const level of ['repeatable read', 'serializable']) {
        const r = await rig.asAdmin(async (c: any) => {
          await c.query(`SET default_transaction_isolation = '${level}'`);
          try { return await tryApplyM218(c); } finally { await c.query('RESET default_transaction_isolation'); }
        });
        expect(r, level).toMatchObject({ message: '218_requires_read_committed' });
      }
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('the applier is the root of trust: a role without BYPASSRLS, and a BYPASSRLS member of the owner that is not the owner, are refused before any lock; the owner itself reaches the NOWAIT lock', async () => {
      const owner = await ownerIdent();
      const role = nextRole('applier');
      const asApplier = (bypassrls: boolean) => rehearseM218(m218Uncommitted(), [
        `CREATE ROLE ${role} NOLOGIN NOSUPERUSER ${bypassrls ? 'BYPASSRLS' : 'NOBYPASSRLS'}`,
        `GRANT ${owner} TO ${role}`,
        `SET LOCAL ROLE ${role}`,
      ]);
      const h = await held(null, 'superuser');
      try {
        await h.q('LOCK TABLE public.central_needs_plan_revisions IN ROW EXCLUSIVE MODE');
        const t = Date.now();
        expect(await asApplier(false)).toEqual({ code: 'P0001',
          message: '218_precondition_failed: the applying role must bypass row-level security', detail: `role=${role}` });
        expect(await asApplier(true)).toEqual({ code: 'P0001',
          message: '218_precondition_failed: M218 must be applied by the owner of the Central Needs tables', detail: `role=${role}` });
        expect(Date.now() - t).toBeLessThan(5000);
        const control = await rehearseM218(m218Uncommitted());
        expect(control).toMatchObject({ code: '55P03' });
        expect(control!.message).toContain('central_needs_plan_revisions');
      } finally { await h.rollback(); }
      expect(await m218Objects()).toEqual(NOTHING);
      expect((await admin(`SELECT count(*)::int AS n FROM pg_roles WHERE rolname = $1`, [role]))[0].n).toBe(0);
    });

    it('refuses a chain without M217, without a required table or function, or with a pre-existing phoenix_private schema (rehearsals, rolled back)', async () => {
      const text = m218Uncommitted();
      const failed = (message: string, detail?: string) => ({ code: 'P0001', message: `218_precondition_failed: ${message}`, detail });
      expect(await rehearseM218(text, ['DROP TRIGGER central_needs_plan_revisions_c5_approval_gate ON public.central_needs_plan_revisions']))
        .toEqual(failed('M217 (the approval gate) is not applied'));
      expect(await rehearseM218(text, ['ALTER TABLE public.central_needs_plans RENAME TO p218_renamed_plans']))
        .toEqual(failed('table central_needs_plans is absent'));
      expect(await rehearseM218(text, ['ALTER FUNCTION public._phoenix_central_needs_review_blockers_v1(uuid) RENAME TO p218_renamed_blockers']))
        .toEqual(failed('public._phoenix_central_needs_review_blockers_v1(uuid) is absent'));
      expect(await rehearseM218(text, ['ALTER FUNCTION public._phoenix_central_needs_payload_digest_v1(jsonb) RENAME TO p218_renamed_digest']))
        .toEqual(failed('public._phoenix_central_needs_payload_digest_v1(jsonb) is absent'));
      // A squatted trusted schema is never adopted, whoever owns it.
      expect(await rehearseM218(text, ['CREATE SCHEMA phoenix_private AUTHORIZATION service_role']))
        .toEqual(failed('schema phoenix_private already exists', 'owner=service_role'));
      expect(await m218Objects()).toEqual(NOTHING);
      expect((await admin(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'central_needs_plan_revisions_c5_approval_gate'`))[0].n).toBe(1);
    });

    it('NOWAIT on every Central Needs table: an in-flight canonical submit, and an in-flight direct writer of a CHILD table only, make M218 fail at once with 55P03, applying nothing', async () => {
      const d = await readyDraft();
      const h = await held(U_EDIT);
      try {
        expect(await h.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
        const t = Date.now();
        const r = await rig.asAdmin((c: any) => tryApplyM218(c));
        expect(r).toMatchObject({ code: '55P03' });
        expect(r!.message).toContain('central_needs_plan_revisions');
        expect(Date.now() - t).toBeLessThan(5000);
      } finally { await h.rollback(); }
      // The activation race: a transaction that already passed its privilege
      // check on a child table must not commit after the revocations.
      const w = await held(null, 'superuser');
      try {
        expect(await w.q(`UPDATE public.central_needs_need_line_sources SET designated_quantity = designated_quantity WHERE false`))
          .toMatchObject({ ok: true });
        const r = await rig.asAdmin((c: any) => tryApplyM218(c));
        expect(r).toMatchObject({ code: '55P03' });
        expect(r!.message).toContain('central_needs_need_line_sources');
      } finally { await w.rollback(); }
      expect(await m218Objects()).toEqual(NOTHING);
      expect(await evidence(d.rev)).toMatchObject({ status: 'draft', submits: 0 });
    });

    it('lock budget: held open without its COMMIT, M218 holds the 13 Central Needs tables EXCLUSIVE (+ SHARE ROW EXCLUSIVE on plan_revisions for the foreign key and the trigger, SHARE on source_records for the readiness index) and its own new objects; nothing else above ACCESS SHARE, no advisory or tuple lock', async () => {
      const locks = await rig.asAdmin(async (c: any) => {
        try {
          await c.query(m218Uncommitted());
          return (await c.query(`
            SELECT l.locktype, l.mode, l.granted, n.nspname, c.relname,
                   coalesce(i.indrelid, c.oid)::regclass::text AS owner_rel
              FROM pg_locks l
              LEFT JOIN pg_class c ON c.oid = l.relation
              LEFT JOIN pg_namespace n ON n.oid = c.relnamespace
              LEFT JOIN pg_index i ON i.indexrelid = c.oid
             WHERE l.pid = pg_backend_pid()`)).rows;
        } finally {
          await c.query('ROLLBACK');
        }
      });
      expect(locks.every((l: any) => l.granted)).toBe(true);
      expect(locks.filter((l: any) => ['advisory', 'tuple'].includes(l.locktype))).toEqual([]);
      const app = locks.filter((l: any) => l.locktype === 'relation' && l.nspname === 'public');
      const on = (rel: string) => app.filter((l: any) => l.relname === rel).map((l: any) => l.mode).sort();
      for (const t of CN_TABLES) expect(on(t), t).toContain('ExclusiveLock');
      expect(on('central_needs_plan_revisions')).toContain('ShareRowExclusiveLock');
      expect(on('central_needs_source_records')).toContain('ShareLock');
      expect(on('central_needs_source_records_invalid_evidence_idx')).toContain('AccessExclusiveLock');
      expect(app.filter((l: any) => l.mode !== 'AccessShareLock'
        && !(CN_TABLES.includes(l.relname) && l.mode === 'ExclusiveLock')
        && !(l.relname === 'central_needs_plan_revisions' && l.mode === 'ShareRowExclusiveLock')
        && !(l.relname === 'central_needs_source_records' && l.mode === 'ShareLock')
        && l.relname !== 'central_needs_source_records_invalid_evidence_idx')
        .map((l: any) => `${l.relname} ${l.mode}`)).toEqual([]);
      // The new private store (and its own indexes) is locked only because it is being created.
      expect(locks.filter((l: any) => l.nspname === PRIVATE && l.owner_rel.endsWith('central_needs_lifecycle_attestations'))
        .map((l: any) => l.mode)).toContain('AccessExclusiveLock');
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('the migration text itself passes VERIFY in a rehearsal (the negative controls below are measured against it)', async () => {
      expect(await rehearseM218(m218Uncommitted())).toBeNull();
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('VERIFY A/B/C is not vacuous: root ownership, and every non-root capability — Central Needs DML (table, column, PUBLIC, inherited), TRIGGER anywhere in public, CREATE, private USAGE, API-role-owned objects, the service_role EXECUTE surface, the store ACL', async () => {
      const text = m218Uncommitted();
      const breach = (b: string) => fail(`a non-root capability remains: ${b}`);
      expect(await rehearseM218(beforeVerify(text, `CREATE ROLE p218f_a1 NOLOGIN; ALTER TABLE public.central_needs_need_lines OWNER TO p218f_a1;`)))
        .toEqual(fail('public.central_needs_need_lines is not owned by the migration owner'));
      expect(await rehearseM218(beforeVerify(text, `CREATE ROLE p218f_a3 NOLOGIN; ALTER FUNCTION ${BREACHES}() OWNER TO p218f_a3;`)))
        .toEqual(fail('phoenix_private, its store and its routines must be owned by the migration owner'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT UPDATE ON public.central_needs_need_lines TO service_role;')))
        .toEqual(breach('service_role holds UPDATE on public.central_needs_need_lines'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT UPDATE (status) ON public.central_needs_plan_revisions TO authenticated;')))
        .toEqual(breach('authenticated holds a column-level UPDATE on public.central_needs_plan_revisions'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT TRUNCATE ON public.central_needs_import_batches TO anon;')))
        .toEqual(breach('anon holds TRUNCATE on public.central_needs_import_batches'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT MAINTAIN ON public.central_needs_plans TO service_role;')))
        .toEqual(breach('service_role holds MAINTAIN on public.central_needs_plans'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT REFERENCES ON public.central_needs_source_records TO service_role;')))
        .toEqual(breach('service_role holds REFERENCES on public.central_needs_source_records'));
      expect(await rehearseM218(beforeVerify(text, `CREATE ROLE p218f_member NOLOGIN; GRANT service_role TO p218f_member;
        GRANT INSERT ON public.central_needs_need_line_sources TO service_role;`)))
        .toEqual(breach('p218f_member holds INSERT on public.central_needs_need_line_sources; service_role holds INSERT on public.central_needs_need_line_sources'));
      const viaPublic = await rehearseM218(beforeVerify(text, 'GRANT DELETE ON public.central_needs_need_lines TO PUBLIC;'));
      expect(viaPublic!.message).toMatch(/^VERIFY FAILED \(218\): a non-root capability remains: anon holds DELETE on public\.central_needs_need_lines; authenticated holds DELETE/);
      expect(viaPublic!.message).toContain('service_role holds DELETE on public.central_needs_need_lines');
      expect(await rehearseM218(beforeVerify(text, 'GRANT TRIGGER ON public.audit_logs TO authenticated;')))
        .toEqual(breach('authenticated holds TRIGGER on public.audit_logs'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT TRIGGER ON public.organizations TO service_role;')))
        .toEqual(breach('service_role holds TRIGGER on public.organizations'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT CREATE ON SCHEMA public TO service_role;')))
        .toEqual(breach('service_role holds CREATE on schema public'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT CREATE ON SCHEMA public TO phoenix_demo_purger;')))
        .toEqual(breach('phoenix_demo_purger holds CREATE on schema public'));
      expect(await rehearseM218(beforeVerify(text, `GRANT USAGE ON SCHEMA ${PRIVATE} TO service_role;`)))
        .toEqual(breach('service_role holds USAGE on schema phoenix_private'));
      expect(await rehearseM218(beforeVerify(text, `GRANT CREATE ON SCHEMA ${PRIVATE} TO authenticated;`)))
        .toEqual(breach('authenticated holds CREATE on schema phoenix_private'));
      expect(await rehearseM218(beforeVerify(text, `CREATE FUNCTION public.p218f_left_behind(text) RETURNS text LANGUAGE sql AS $f$ SELECT $1 $f$;
        ALTER FUNCTION public.p218f_left_behind(text) OWNER TO service_role;`)))
        .toEqual(breach('service_role owns routine public.p218f_left_behind'));
      // The EXECUTE surface: a lifecycle RPC re-granted, or a trusted routine lost (over-revocation), is refused.
      expect(await rehearseM218(beforeVerify(text, 'GRANT EXECUTE ON FUNCTION public.phoenix_central_needs_submit_revision(uuid) TO service_role;')))
        .toEqual(fail('service_role Central Needs SECURITY DEFINER EXECUTE is not exactly the three trusted routines'));
      expect(await rehearseM218(beforeVerify(text,
        'REVOKE EXECUTE ON FUNCTION public.phoenix_central_needs_apply_authoritative_replay(uuid, text, jsonb, jsonb) FROM service_role;')))
        .toEqual(fail('service_role Central Needs SECURITY DEFINER EXECUTE is not exactly the three trusted routines'));
      expect(await rehearseM218(beforeVerify(text, `GRANT SELECT ON ${STORE} TO service_role;`)))
        .toEqual(fail('a role other than the owner holds a privilege on the attestation store'));
      expect(await rehearseM218(beforeVerify(text, `GRANT SELECT (id) ON ${STORE} TO authenticated;`)))
        .toEqual(fail('a role other than the owner holds a privilege on the attestation store'));
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('VERIFY D is not vacuous: the private schema ACL, its exact objects, its default privileges, Data API exposure, and the store shape', async () => {
      const text = m218Uncommitted();
      expect(await rehearseM218(beforeVerify(text, `CREATE ROLE p218f_super NOLOGIN SUPERUSER; GRANT USAGE ON SCHEMA ${PRIVATE} TO p218f_super;`)))
        .toEqual(fail('a role other than the owner holds a privilege on phoenix_private'));
      expect(await rehearseM218(beforeVerify(text, `CREATE TABLE ${PRIVATE}.p218f_extra (id integer);`)))
        .toEqual(fail('phoenix_private must hold exactly the attestation store and its two indexes'));
      expect(await rehearseM218(beforeVerify(text, `CREATE FUNCTION ${PRIVATE}.p218f_extra() RETURNS integer LANGUAGE sql AS $f$ SELECT 1 $f$;`)))
        .toEqual(fail('phoenix_private must hold exactly the four security routines, one overload each'));
      expect(await rehearseM218(beforeVerify(text, `CREATE FUNCTION ${DIGEST}(text) RETURNS text LANGUAGE sql AS $f$ SELECT $1 $f$;`)))
        .toEqual(fail('phoenix_private must hold exactly the four security routines, one overload each'));
      expect(await rehearseM218(beforeVerify(text, `CREATE TYPE ${PRIVATE}.p218f_kind AS ENUM ('a');`)))
        .toEqual(fail('phoenix_private holds an unexpected object or default privilege'));
      expect(await rehearseM218(beforeVerify(text, `ALTER DEFAULT PRIVILEGES IN SCHEMA ${PRIVATE} GRANT SELECT ON TABLES TO anon;`)))
        .toEqual(fail('phoenix_private holds an unexpected object or default privilege'));
      expect(await rehearseM218(beforeVerify(text, `ALTER ROLE authenticator_p218f SET pgrst.db_schemas = 'public';`), [
        'CREATE ROLE authenticator_p218f NOLOGIN'])).toBeNull();
      expect(await rehearseM218(beforeVerify(text, `ALTER ROLE authenticator_p218f SET pgrst.db_schemas = 'public, phoenix_private';`), [
        'CREATE ROLE authenticator_p218f NOLOGIN'])).toEqual(fail('phoenix_private is configured as a Data API schema'));
      const shape = fail('the attestation store must be a FORCE-RLS table without policy, sequence or user trigger');
      expect(await rehearseM218(beforeVerify(text, `ALTER TABLE ${STORE} NO FORCE ROW LEVEL SECURITY;`))).toEqual(shape);
      expect(await rehearseM218(beforeVerify(text, `CREATE POLICY p218f_open ON ${STORE} FOR SELECT TO authenticated USING (true);`))).toEqual(shape);
      expect(await rehearseM218(beforeVerify(text, `CREATE SEQUENCE ${PRIVATE}.p218f_seq OWNED BY ${STORE}.txid;`)))
        .toEqual(fail('phoenix_private must hold exactly the attestation store and its two indexes'));
      expect(await rehearseM218(beforeVerify(text,
        `CREATE TRIGGER p218f_trg BEFORE INSERT ON ${STORE} FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();`))).toEqual(shape);
      expect(await rehearseM218(beforeVerify(text, `ALTER TABLE ${STORE} ADD CONSTRAINT p218f_extra CHECK (true);`)))
        .toEqual(fail('the attestation store constraints are not exactly the frozen set'));
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('VERIFY E is not vacuous: SECURITY INVOKER + pg_catalog, pg_temp for the private routines, their ACL, STABLE, the hardened RPC configs, the C5-pinned approval fence, every SECURITY DEFINER search path, explicit qualification', async () => {
      const text = m218Uncommitted();
      const privateShape = (sig: string) => fail(`${sig} is missing, SECURITY DEFINER, or not pinned to pg_catalog, pg_temp`);
      expect(await rehearseM218(beforeVerify(text, `ALTER FUNCTION ${DIGEST}(uuid) SECURITY DEFINER;`)))
        .toEqual(privateShape(`${DIGEST}(uuid)`));
      expect(await rehearseM218(beforeVerify(text, `ALTER FUNCTION ${FENCE}() SET search_path = public, pg_temp;`)))
        .toEqual(privateShape(`${FENCE}()`));
      expect(await rehearseM218(beforeVerify(text, `ALTER FUNCTION ${BREACHES}() RESET search_path;`)))
        .toEqual(privateShape(`${BREACHES}()`));
      expect(await rehearseM218(beforeVerify(text, `GRANT EXECUTE ON FUNCTION ${APPROVAL_BODY_SIG} TO service_role;`)))
        .toEqual(fail(`internal ${APPROVAL_BODY_SIG} carries an ACL entry for a role other than its owner`));
      expect(await rehearseM218(beforeVerify(text, `ALTER FUNCTION ${DIGEST}(uuid) VOLATILE;`)))
        .toEqual(fail('the digest, the seal predicate and the readiness predicate must be STABLE'));
      expect(await rehearseM218(beforeVerify(text, `ALTER FUNCTION ${BLOCKERS}(uuid) VOLATILE;`)))
        .toEqual(fail('the digest, the seal predicate and the readiness predicate must be STABLE'));
      const submitCfg = fail(`submit must be SECURITY DEFINER with search_path pg_catalog, pg_temp and statement_timeout ${SUBMIT_TIMEOUT}`);
      expect(await rehearseM218(beforeVerify(text, 'ALTER FUNCTION public.phoenix_central_needs_submit_revision(uuid) SET search_path = public, pg_temp;')))
        .toEqual(submitCfg);
      expect(await rehearseM218(beforeVerify(text, 'ALTER FUNCTION public.phoenix_central_needs_submit_revision(uuid) RESET statement_timeout;')))
        .toEqual(submitCfg);
      expect(await rehearseM218(beforeVerify(text, 'ALTER FUNCTION public.phoenix_central_needs_approve_revision(uuid) SET search_path = public, pg_temp;')))
        .toEqual(fail('approve must be SECURITY DEFINER with search_path pg_catalog, pg_temp'));
      expect(await rehearseM218(beforeVerify(text, `ALTER FUNCTION ${APPROVAL_FENCE}() SET search_path = pg_catalog, pg_temp;`)))
        .toEqual(fail('the M217 approval fence lost its C5-pinned shape'));
      expect(await rehearseM218(beforeVerify(text, `GRANT EXECUTE ON FUNCTION ${APPROVAL_FENCE}() TO authenticated;`)))
        .toEqual(fail('the approval fence is client-callable'));
      expect(await rehearseM218(redefinedBeforeVerify(text, APPROVAL_FENCE, 'BEGIN\n', 'BEGIN\n  PERFORM 1 FROM public.audit_logs LIMIT 1;\n')))
        .toEqual(fail('the approval fence must only delegate to the private body'));
      // The capability class: any SECURITY DEFINER routine searching a schema a non-root role can create in.
      expect(await rehearseM218(beforeVerify(text, `CREATE SCHEMA p218f_open; GRANT CREATE ON SCHEMA p218f_open TO authenticated;
        ALTER FUNCTION public._phoenix_central_needs_guard_v1(uuid, text) SET search_path = p218f_open, pg_temp;`)))
        .toEqual(fail('a SECURITY DEFINER search_path reaches a schema a non-root role can create in: public._phoenix_central_needs_guard_v1(uuid,text) searches p218f_open'));
      expect(await rehearseM218(beforeVerify(text, 'ALTER FUNCTION public._phoenix_central_needs_guard_v1(uuid, text) RESET search_path;')))
        .toEqual(fail('a SECURITY DEFINER search_path reaches a schema a non-root role can create in: public._phoenix_central_needs_guard_v1(uuid,text) has no pinned search_path'));
      expect(await rehearseM218(beforeVerify(text, `ALTER FUNCTION public._phoenix_central_needs_guard_v1(uuid, text) SET search_path = "$user", public;`)))
        .toEqual(fail('a SECURITY DEFINER search_path reaches a schema a non-root role can create in: public._phoenix_central_needs_guard_v1(uuid,text) searches $user'));
      // Explicit qualification of every application relation in the hardened bodies.
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_submit_revision',
        "  UPDATE public.central_needs_plan_revisions\n     SET status = 'submitted'", "  UPDATE central_needs_plan_revisions\n     SET status = 'submitted'")))
        .toEqual(fail('public.phoenix_central_needs_submit_revision(uuid) names an application relation without its schema'));
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('VERIFY F is not vacuous: the writer census, dynamic SQL, DRAFT-first writers, lifecycle-only writers, the DRAFT gate, foreign-key actions, views, the Central Needs trigger inventory and trigger-routine ownership', async () => {
      const text = m218Uncommitted();
      expect(await rehearseM218(beforeVerify(text, `CREATE SCHEMA p218f_w; CREATE FUNCTION p218f_w.writer() RETURNS void LANGUAGE sql
        AS $f$ UPDATE public.central_needs_need_lines SET mapping_reason = mapping_reason WHERE false $f$;`)))
        .toEqual(fail('the Central Needs writer census changed'));
      expect(await rehearseM218(beforeVerify(text, `CREATE SCHEMA p218f_w; CREATE FUNCTION p218f_w.dyn() RETURNS void LANGUAGE plpgsql
        AS $f$ BEGIN EXECUTE format('DELETE FROM %I.%I WHERE false', 'public', 'central_needs_need_lines'); END $f$;`)))
        .toEqual(fail('a routine that mentions Central Needs uses dynamic SQL'));
      expect(await rehearseM218(beforeVerify(text, rewriteFn('public.phoenix_central_needs_delete_need_line(uuid, text, uuid[])',
        'public\\._phoenix_central_needs_assert_draft_v1\\(', 'pg_catalog.num_nulls('))))
        .toEqual(fail('public.phoenix_central_needs_delete_need_line(uuid, text, uuid[]) must load the revision FOR UPDATE and assert DRAFT before its first write'));
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_approve_revision',
        "  IF v_predecessor.id IS NOT NULL THEN\n    -- APPROVED", "  DELETE FROM public.central_needs_need_line_sources WHERE false;\n  IF v_predecessor.id IS NOT NULL THEN\n    -- APPROVED")))
        .toEqual(fail('public.phoenix_central_needs_approve_revision(uuid) writes Central Needs state beyond the lifecycle'));
      expect(await rehearseM218(beforeVerify(text, rewriteFn('public._phoenix_central_needs_assert_draft_v1(uuid, text)',
        "IF p_status <> 'draft' THEN", "IF p_status NOT IN ('draft', 'submitted') THEN"))))
        .toEqual(fail('the DRAFT gate no longer refuses every non-draft revision'));
      expect(await rehearseM218(beforeVerify(text, `ALTER TABLE public.central_needs_need_lines DROP CONSTRAINT central_needs_need_lines_central_item_id_fkey,
        ADD CONSTRAINT central_needs_need_lines_central_item_id_fkey FOREIGN KEY (central_item_id) REFERENCES public.central_items (id) ON DELETE SET NULL;`)))
        .toEqual(fail('a Central Needs foreign key cascades into sealed state'));
      expect(await rehearseM218(beforeVerify(text, 'CREATE VIEW public.p218f_lines AS SELECT * FROM public.central_needs_need_lines;')))
        .toEqual(fail('a rule or view depends on a Central Needs relation'));
      expect(await rehearseM218(beforeVerify(text,
        'CREATE TRIGGER zz_extra BEFORE UPDATE ON public.central_needs_need_lines FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at();')))
        .toEqual(fail('the Central Needs trigger inventory is not exactly the frozen set'));
      expect(await rehearseM218(beforeVerify(text, 'ALTER TABLE public.central_needs_plan_revisions DISABLE TRIGGER set_updated_at;')))
        .toEqual(fail('the Central Needs trigger inventory is not exactly the frozen set'));
      for (const shape of ['AFTER UPDATE', 'BEFORE UPDATE OF status']) {
        expect(await rehearseM218(beforeVerify(text, `DROP TRIGGER central_needs_plan_revisions_c6_submission_gate ON public.central_needs_plan_revisions;
          CREATE TRIGGER central_needs_plan_revisions_c6_submission_gate ${shape} ON public.central_needs_plan_revisions
            FOR EACH ROW EXECUTE FUNCTION ${FENCE}();`)), shape)
          .toEqual(fail('the Central Needs trigger inventory is not exactly the frozen set'));
      }
      expect(await rehearseM218(beforeVerify(text, `CREATE ROLE p218f_fnowner NOLOGIN; CREATE SCHEMA p218f_t;
        CREATE FUNCTION p218f_t.trg() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$;
        ALTER FUNCTION p218f_t.trg() OWNER TO p218f_fnowner;
        CREATE TRIGGER zz_foreign BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION p218f_t.trg();`)))
        .toEqual(fail('a trigger on a public relation runs a routine the root of trust does not own'));
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('VERIFY G is not vacuous: only submit and approve write the store; each fence binding; the submit and approve orders; no re-hash at approve; no audit_logs read; the readiness callers', async () => {
      const text = m218Uncommitted();
      expect(await rehearseM218(beforeVerify(text, rewriteFn('public.phoenix_central_needs_reject_revision(uuid, text)',
        '\\nBEGIN\\n', '\nBEGIN\n  DELETE FROM phoenix_private.central_needs_lifecycle_attestations WHERE false;\n'))))
        .toEqual(fail('a routine other than submit and approve writes the attestation store'));
      for (const binding of ['\n         AND a.txid             = txid_current()', '\n         AND a.actor_id         = auth.uid()',
        '\n         AND a.created_at       = transaction_timestamp()', `\n         AND a.contract         = '${CONTRACT}'`]) {
        expect(await rehearseM218(redefinedBeforeVerify(text, FENCE, binding, '')), binding)
          .toEqual(fail(`${FENCE}() lacks ${binding.trim().replace(/^AND /, '')}`));
        expect(await rehearseM218(redefinedBeforeVerify(text, APPROVAL_BODY, binding, '')), binding)
          .toEqual(fail(`${APPROVAL_BODY_SIG} lacks ${binding.trim().replace(/^AND /, '')}`));
      }
      expect(await rehearseM218(redefinedBeforeVerify(text, FENCE, 'BEGIN\n', 'BEGIN\n  PERFORM 1 FROM public.audit_logs LIMIT 1;\n')))
        .toEqual(fail(`${FENCE}() consults audit_logs`));
      expect(await rehearseM218(redefinedBeforeVerify(text, FENCE,
        "IF TG_OP = 'UPDATE' AND OLD.status = 'draft' AND NEW.status = 'submitted' THEN", "IF NEW.status = 'submitted' THEN")))
        .toEqual(fail('the submission fence does not judge exactly DRAFT -> SUBMITTED against a SUBMIT attestation of that revision'));
      expect(await rehearseM218(redefinedBeforeVerify(text, FENCE, "a.phase            = 'submit'", "a.phase            = 'approve'")))
        .toEqual(fail('the submission fence does not judge exactly DRAFT -> SUBMITTED against a SUBMIT attestation of that revision'));
      expect(await rehearseM218(redefinedBeforeVerify(text, APPROVAL_BODY, "a.phase            = 'approve'", "a.phase            = 'submit'")))
        .toEqual(fail('the approval fence does not require an APPROVE attestation of that revision'));
      const submitOrder = fail('submit must check isolation, lock, assert DRAFT and the seal, judge readiness with the digest in one snapshot, then attest, transition and audit');
      // Readiness and the digest split into two statements (two snapshots).
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_submit_revision',
        'v_state_digest := v_blocker.state_digest;', `v_state_digest := ${DIGEST}(p_plan_revision_id);`))).toEqual(submitOrder);
      // The isolation check dropped.
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_submit_revision',
        `RAISE EXCEPTION '${RC_REQUIRED}'`, `RAISE NOTICE '${RC_REQUIRED}'`))).toEqual(submitOrder);
      // The seal predicate dropped from submit.
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_submit_revision',
        `FROM ${BREACHES}() AS x(breach)`, `FROM (SELECT NULL::text) AS x(breach) WHERE false`))).toEqual(submitOrder);
      const approveOrder = fail('approve must prove provenance and the seal before A2, and attest after A2 before the switch');
      {
        // The APPROVE attestation moved before A2.
        const def = fnDefOf(text, 'public.phoenix_central_needs_approve_revision');
        const at = def.indexOf(`INSERT INTO ${STORE} (`);
        const stmt = def.slice(at, def.indexOf(');', at) + 2);
        const moved = def.replace(stmt, '').replace('  IF v_approved = 1 THEN\n', `  ${stmt}\n  IF v_approved = 1 THEN\n`);
        expect(stmt.length).toBeGreaterThan(40);
        expect(moved).not.toBe(def);
        expect(await rehearseM218(beforeVerify(text, `${moved}\n`))).toEqual(approveOrder);
      }
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_approve_revision',
        `FROM ${BREACHES}() AS x(breach)`, `FROM (SELECT NULL::text) AS x(breach) WHERE false`))).toEqual(approveOrder);
      // The approval re-hash re-introduced.
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_approve_revision',
        '  IF v_approved = 1 THEN\n', `  PERFORM ${DIGEST}(p_plan_revision_id);\n  IF v_approved = 1 THEN\n`)))
        .toEqual(fail('approve must not re-hash the sealed submitted state'));
      // The APPROVE attestation not carrying the sealed digest.
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_approve_revision',
        `txid_current(), v_submitted_digest\n  );`, `txid_current(), repeat('0', 64)\n  );`)))
        .toEqual(fail(`approve lacks 'approve', '${CONTRACT}', v_actor, txid_current(), v_submitted_digest`));
      // A lifecycle routine reading audit_logs.
      expect(await rehearseM218(redefinedBeforeVerify(text, 'public.phoenix_central_needs_submit_revision',
        '  SELECT count(*) INTO v_completed\n', '  PERFORM 1 FROM public.audit_logs LIMIT 1;\n  SELECT count(*) INTO v_completed\n')))
        .toEqual(fail('public.phoenix_central_needs_submit_revision(uuid) reads audit_logs'));
      expect(await rehearseM218(beforeVerify(text, `CREATE SCHEMA p218f_c; CREATE FUNCTION p218f_c.calls_blockers(uuid) RETURNS bigint LANGUAGE sql
        AS $f$ SELECT count(*) FROM ${BLOCKERS}($1) $f$;`)))
        .toEqual(fail('only review_readiness and submit may call the readiness predicate'));
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('VERIFY H, names, data, locks and the catch-all fingerprints are not vacuous', async () => {
      const text = m218Uncommitted();
      expect(await rehearseM218(beforeVerify(text, 'ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT TRIGGER ON TABLES TO service_role;')))
        .toEqual(fail('a default privilege of the migration owner grants TRIGGER on future tables to a non-root role'));
      expect(await rehearseM218(beforeVerify(text, 'ALTER DEFAULT PRIVILEGES GRANT TRIGGER ON TABLES TO authenticated;')))
        .toEqual(fail('a default privilege of the migration owner grants TRIGGER on future tables to a non-root role'));
      expect(await rehearseM218(replaced(text, 'ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE TRIGGER ON TABLES FROM service_role;', '')))
        .toEqual(fail('a default privilege of the migration owner grants TRIGGER on future tables to a non-root role'));
      // §12: the readiness index — missing, or over another predicate.
      expect(await rehearseM218(beforeVerify(text, 'DROP INDEX public.central_needs_source_records_invalid_evidence_idx;')))
        .toEqual(fail('the readiness index is missing or not the frozen partial definition'));
      expect(await rehearseM218(replaced(text, "WHERE public._phoenix_central_needs_review_numeric_class_v1(source_values) = 'invalid_evidence';",
        "WHERE public._phoenix_central_needs_review_numeric_class_v1(source_values) = 'not_numeric';")))
        .toEqual(fail('the readiness index is missing or not the frozen partial definition'));
      expect(await rehearseM218(beforeVerify(text, `CREATE FUNCTION ${R2_DIGEST}(uuid) RETURNS text LANGUAGE sql AS $f$ SELECT ''::text $f$;`)))
        .toEqual(fail('an M218 security object exists in public'));
      expect(await rehearseM218(beforeVerify(text, `CREATE FUNCTION public.phoenix_central_needs_submit_revision(text) RETURNS jsonb LANGUAGE sql
        AS $f$ SELECT '{}'::jsonb $f$;`)))
        .toEqual(fail('phoenix_central_needs_submit_revision must have exactly one overload (got 2)'));
      const d = await openDraft();
      expect(await rehearseM218(beforeVerify(text, `UPDATE public.central_needs_plan_revisions SET status = 'rejected' WHERE id = '${d.rev}';`)))
        .toEqual(fail('a plan revision status changed'));
      expect(await rehearseM218(beforeVerify(text, `INSERT INTO ${STORE} (plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest)
        VALUES ('${d.rev}', '${ORG_OWNER}', 'submit', '${CONTRACT}', '${U_EDIT}', txid_current(), repeat('0', 64));`)))
        .toEqual(fail('the attestation store must start empty'));
      expect(await rehearseM218(beforeVerify(text, 'LOCK TABLE public.audit_logs IN SHARE MODE;')))
        .toEqual(fail('1 public relation lock(s) outside the lock budget'));
      expect(await rehearseM218(replaced(text, ',\n           public.central_needs_need_line_sources\n  IN EXCLUSIVE MODE NOWAIT;', '\n  IN EXCLUSIVE MODE NOWAIT;')))
        .toEqual(fail('the activation lock is not held on all 13 Central Needs tables (got 12)'));
      expect(await rehearseM218(beforeVerify(text, 'SELECT pg_advisory_xact_lock(218218);')))
        .toEqual(fail('an advisory or tuple lock is held'));
      {
        const h = await held(null, 'superuser');
        try {
          await h.q('LOCK TABLE public.warehouses IN SHARE ROW EXCLUSIVE MODE');
          expect(await rehearseM218(text)).toEqual(fail('another session holds a DDL-class lock on a public relation'));
        } finally { await h.rollback(); }
      }
      // The catch-alls: any other routine, trigger or ACL change.
      expect(await rehearseM218(beforeVerify(text, `ALTER FUNCTION public.phoenix_set_updated_at() SET work_mem = '1MB';`)))
        .toEqual(fail('a routine or trigger outside the deliberate replacements changed'));
      expect(await rehearseM218(beforeVerify(text, 'GRANT SELECT ON public.audit_logs TO anon;')))
        .toEqual(fail('an ACL entry outside the deliberate revocations changed'));
      expect(await rehearseM218(beforeVerify(text, 'REVOKE SELECT ON public.central_needs_need_lines FROM service_role;')))
        .toEqual(fail('an ACL entry outside the deliberate revocations changed'));
      expect(await rehearseM218(beforeVerify(text, 'REVOKE SELECT ON public.central_needs_need_lines FROM authenticated;')))
        .toEqual(fail('an ACL entry outside the deliberate revocations changed'));
      expect(await rehearseM218(beforeVerify(text, 'REVOKE EXECUTE ON FUNCTION public.phoenix_outbox_claim_batch(text, uuid, integer) FROM service_role;')))
        .toEqual(fail('an ACL entry outside the deliberate revocations changed'));
      expect(await m218Objects()).toEqual(NOTHING);
      expect(await statuses(d.planId)).toEqual(['1:draft']);
    });

    it('pre-existing untrusted objects and grant chains: a service_role-owned routine or trigger left in place refuses M218; TRIGGER passed on WITH GRANT OPTION, or granted to PUBLIC, is converged', async () => {
      const text = m218Uncommitted();
      const asService = (sql: string) => [`SET LOCAL ROLE service_role`, sql, 'RESET ROLE'];
      expect(await rehearseM218(text, asService(`CREATE FUNCTION public.p218f_shadow(text) RETURNS text LANGUAGE sql AS $f$ SELECT $1 $f$`)))
        .toEqual(fail('a non-root capability remains: service_role owns routine public.p218f_shadow'));
      expect(await rehearseM218(text, asService(`CREATE TRIGGER zz_svc BEFORE UPDATE ON public.central_needs_need_lines
        FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()`)))
        .toEqual(fail('the Central Needs trigger inventory is not exactly the frozen set'));
      expect(await rehearseM218(text, [
        ...asService(`CREATE FUNCTION public.p218f_audit_hook() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`),
        ...asService('CREATE TRIGGER zz_svc_audit BEFORE INSERT ON public.audit_logs FOR EACH ROW EXECUTE FUNCTION public.p218f_audit_hook()'),
      ])).toEqual(fail('a non-root capability remains: service_role owns routine public.p218f_audit_hook'));
      // A grant chain: X holds TRIGGER WITH GRANT OPTION and passed it to anon; M218 revokes both (CASCADE).
      expect(await rehearseM218(text, [
        'CREATE ROLE p218f_chain NOLOGIN',
        'GRANT TRIGGER ON public.audit_logs TO p218f_chain WITH GRANT OPTION',
        'SET LOCAL ROLE p218f_chain', 'GRANT TRIGGER ON public.audit_logs TO anon', 'RESET ROLE',
        'GRANT TRIGGER ON public.organizations TO PUBLIC',
        'GRANT CREATE ON SCHEMA public TO PUBLIC',
      ])).toBeNull();
      expect(await m218Objects()).toEqual(NOTHING);
    });

    it('fail-closed precondition: pre-existing SUBMITTED revisions (canonical and direct) refuse M218 and nothing changes; after the governed reject M218 applies', async () => {
      // One submitted by the pre-M218 canonical submit (its audit, no gate), one
      // by the F1 direct write (no audit, no gate). Neither can be adopted.
      const canonical = await submittedPlan();
      const direct = await openDraft();
      await admin(DIRECT_SUBMIT, [direct.rev]);
      const [{ submitted }] = await admin(`SELECT count(*)::int AS submitted FROM central_needs_plan_revisions WHERE status = 'submitted'`);
      expect(submitted).toBe(2);
      const before = { c: await snapshot(canonical.rev), d: await snapshot(direct.rev), acl: await lifecycleAcl(), svc: await serviceRoleSurface() };
      const r = await rig.asAdmin((c: any) => tryApplyM218(c));
      expect(r).toEqual({ code: 'P0001', message: '218_precondition_failed',
        detail: 'submitted=2 with_submit_audit=1 without_submit_audit=1' });
      // Nothing applied, nothing synthesized, nothing backdated, nothing mutated, no privilege changed.
      expect(await m218Objects()).toEqual(NOTHING);
      expect({ c: await snapshot(canonical.rev), d: await snapshot(direct.rev), acl: await lifecycleAcl(), svc: await serviceRoleSurface() })
        .toEqual(before);
      expect((await admin(`SELECT count(*)::int AS n FROM audit_logs WHERE action = 'central_needs.plan_revision.submission_gate'`))[0].n).toBe(0);
      // The rehearsal reports the same refusal and rolls back.
      expect(await rehearseM218(m218Uncommitted())).toMatchObject({ message: '218_precondition_failed' });
      // The governed resolution: the canonical reject of both.
      for (const rev of [canonical.rev, direct.rev]) {
        expect(await call(U_APPROVE, REJECT, [rev, 'resolved before the submission fence'])).toMatchObject({ status: 'rejected' });
      }
      expect(await rehearseM218(m218Uncommitted())).toBeNull();
      expect(await m218Objects()).toEqual(NOTHING);
    });
  });

  // =========================================================================
  // THE FULL CHAIN — the remaining canonical migrations (exactly M218)
  // applied through applyMigrationSql, the same replay buildRig() performs.
  // =========================================================================
  describe('on the 001..218 chain', () => {
    beforeAll(async () => {
      const rest = migrationFiles().filter((f: string) => Number(f.slice(0, 3)) > 217);
      expect(rest).toEqual([M218]);
      await rig.asAdmin(async (c: any) => {
        for (const f of rest) await applyMigrationSql(c, f, shimSql(f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
      });
      expect(await m218Objects()).toEqual(EVERYTHING);
    }, 600000);

    it('idempotence: a second application fails 218_already_applied BEFORE any lock (a held writer never trips NOWAIT)', async () => {
      const h = await held(null, 'superuser');
      try {
        await h.q('LOCK TABLE public.central_needs_plan_revisions IN ROW EXCLUSIVE MODE');
        expect(await rig.asAdmin((c: any) => tryApplyM218(c))).toMatchObject({ message: '218_already_applied' });
      } finally { await h.rollback(); }
    });

    it('§1 capability inventory AFTER M218: service_role keeps SELECT and exactly the three trusted routines; no CREATE, no TRIGGER, no Central Needs write; the TRIGGER default is gone and nothing else of its defaults changed', async () => {
      const after = await serviceRoleSurface();
      expect(after.public_create).toBe(false);
      expect(after.trigger_relations).toEqual([]);
      for (const t of CN_TABLES) expect(after.cn_privileges[t], t).toEqual(['SELECT']);
      expect(after.cn_definer_execute).toEqual([...SVC_KEPT].sort());
      expect(after.defaults).toEqual(svcBefore.defaults.filter((x: string) => x !== 'public|r|TRIGGER'));
      expect(await admin(`SELECT b FROM ${BREACHES}() AS x(b)`)).toEqual([]);
      const [{ purger }] = await admin(`SELECT has_schema_privilege('phoenix_demo_purger', 'public', 'CREATE') AS purger`);
      expect(purger).toBe(false);
    });

    // -----------------------------------------------------------------------
    // A1-A5 — the submit side
    // -----------------------------------------------------------------------
    describe('A1-A5 submission', () => {
      it('A1: UNREADY draft -> canonical submit is REFUSED by readiness, with no gate, audit, attestation or status write', async () => {
        const d = await openDraft();
        const r = await refused(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), 'plan_revision_has_no_finalized_import');
        expect(r.code).toBe('23514');
        const sess = await addSession(d.rev, [{ row: 1, cells: [{ col: 1 }] }]);
        await refused(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), 'plan_revision_has_unbatched_completed_import');
        await trustBatch(d.rev, [sess.sessionId]);
        const g = await refused(d.rev, () => call(U_EDIT, SUBMIT, [d.rev]), 'plan_revision_not_ready_for_review');
        expect(g.detail).toMatch(/^blocker=\w+ /);
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
        expect(await attestations(d.rev)).toEqual([]);
      });

      it('A2: UNREADY draft -> a direct UPDATE to submitted is REFUSED — by the fence for the root of trust, by privilege for every non-root role', async () => {
        const d = await openDraft();
        for (const a of attackers(DIRECT_SUBMIT, [d.rev])) await refusedBy(d.rev, a, GATE_MISSING);
        expect(await statuses(d.planId)).toEqual(['1:draft']);
      });

      it('A3: READY draft -> the same direct UPDATE is REFUSED — readiness alone never authorizes the transition', async () => {
        const d = await readyDraft();
        for (const a of attackers(DIRECT_SUBMIT, [d.rev])) await refusedBy(d.rev, a, GATE_MISSING);
        await refused(d.rev, () => admin(
          `UPDATE public.central_needs_plan_revisions SET status = 'submitted', updated_at = now() WHERE id = $1`, [d.rev]), GATE_MISSING);
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
        expect(await call(U_EDIT, SUBMIT, [d.rev])).toMatchObject({ ok: true, status: 'submitted' });
      });

      it('A4: READY draft -> canonical submit PASSES with the unchanged M211 result shape', async () => {
        const d = await readyDraft();
        expect(await call(U_EDIT, SUBMIT, [d.rev])).toEqual({ ok: true, plan_revision_id: d.rev, status: 'submitted' });
        expect(await statuses(d.planId)).toEqual(['1:submitted']);
      });

      it('A5: the attestation, the gate, the transition and the submit audit are ONE transaction: same txid, same xmin, same timestamp, bound to revision, owner and actor', async () => {
        const d = await readyDraft();
        const h = await held(U_EDIT);
        let txn: { txid: string; ts: string } = { txid: '', ts: '' };
        try {
          expect(await h.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          const own = await h.q(`SELECT txid_current()::text AS txid, to_jsonb(transaction_timestamp()) #>> '{}' AS ts`);
          txn = own.rows![0];
        } finally { expect(await h.commit()).toEqual({ ok: true }); }
        const xmin = String(BigInt(txn.txid) % BigInt(4294967296));
        const rows = await admin(
          `SELECT action, actor_id, actor_role, organization_id, entity_type, entity_label, payload, xmin::text AS xmin,
                  to_jsonb(created_at) #>> '{}' AS ts
             FROM audit_logs WHERE entity_id = $1 AND xmin::text = $2 ORDER BY action`, [d.rev, xmin]);
        expect(rows.map((r: any) => r.action)).toEqual(['central_needs.plan_revision.submission_gate', 'central_needs.plan_revision.submit']);
        const [gate, submit] = rows;
        expect(gate).toMatchObject({ actor_id: U_EDIT, organization_id: ORG_OWNER, entity_type: 'central_needs_plan_revision',
          entity_label: 'revision 1', ts: txn.ts });
        expect(gate.payload).toEqual({ contract: 'c6-f1-v1', txid: txn.txid, plan_id: d.planId, revision_number: 1 });
        expect(submit).toMatchObject({ actor_id: U_EDIT, organization_id: ORG_OWNER, actor_role: gate.actor_role, ts: txn.ts });
        expect(submit.payload).toMatchObject({ from_status: 'draft', to_status: 'submitted', submission_gate_txid: txn.txid,
          finalized_import_count: 1, registered_batch_count: 1 });
        expect(gate.xmin).toBe(submit.xmin);
        expect(submit.payload.revision_xmin).toBe(gate.xmin);
        const [rev] = await admin(`SELECT status, xmin::text AS xmin, to_jsonb(updated_at) #>> '{}' AS at FROM central_needs_plan_revisions WHERE id = $1`, [d.rev]);
        expect(rev).toEqual({ status: 'submitted', xmin: gate.xmin, at: txn.ts });
        const att = await attestations(d.rev);
        expect(att).toHaveLength(1);
        expect(att![0]).toMatchObject({ phase: 'submit', contract: CONTRACT, actor_id: U_EDIT, txid: txn.txid, xmin: gate.xmin, ts: txn.ts });
        expect(att![0].state_digest).toMatch(/^[0-9a-f]{64}$/);
        expect(att![0].state_digest).toBe(submit.payload.submission_state_digest);
        expect(await digestOf(d.rev)).toBe(att![0].state_digest);
      });

      it('A5/§15.21: no audit_logs row admits DRAFT -> SUBMITTED — not even the exact one, forged by the root, by service_role or by a BYPASSRLS writer', async () => {
        const d = await readyDraft();
        const statements: Array<[string, unknown[]]> = [
          [`INSERT INTO public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, payload)
            VALUES ($2, $3, 'central_needs.plan_revision.submission_gate', 'central_needs_plan_revision', $1,
                    jsonb_build_object('contract', 'c6-f1-v1', 'txid', txid_current()::text, 'plan_id', $4::uuid, 'revision_number', 1))`,
          [d.rev, ORG_OWNER, U_EDIT, d.planId]],
          [`INSERT INTO public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, payload)
            VALUES ($2, $3, 'central_needs.plan_revision.submit', 'central_needs_plan_revision', $1,
                    jsonb_build_object('contract', '${CONTRACT}', 'phase', 'submit', 'txid', txid_current()::text,
                                       'submission_gate_txid', txid_current()::text, 'to_status', 'submitted'))`,
          [d.rev, ORG_OWNER, U_EDIT]],
        ];
        const forgeThenSubmit = async (c: any) => {
          for (const [sql, params] of statements) await c.query(sql, params);
          await c.query(DIRECT_SUBMIT, [d.rev]);
        };
        const forgers: Attacker[] = [
          ['superuser as the editor', () => probe(async (c: any) => {
            await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
            await forgeThenSubmit(c);
          }), 'fence'],
          ['BYPASSRLS member of the table owner as the editor', async () => {
            const owner = await ownerIdent();
            return probe(async (c: any) => {
              const role = nextRole('forger');
              await c.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER BYPASSRLS`);
              await c.query(`GRANT ${owner} TO ${role}`);
              await c.query(`SET LOCAL ROLE ${role}`);
              await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
              await forgeThenSubmit(c);
            });
          }, 'fence'],
          // service_role still writes audit_logs (a non-Central-Needs table), but the forged rows buy it nothing.
          ['service_role as the editor', () => rig.asUser(U_EDIT, forgeThenSubmit, { role: 'service_role', commit: true }), 'privilege'],
        ];
        for (const f of forgers) await refusedBy(d.rev, f, GATE_MISSING);
        expect(await attestations(d.rev)).toEqual([]);
        const [{ ins, upd }] = await admin(`
          SELECT has_table_privilege('authenticated', 'public.audit_logs', 'INSERT')
                 OR has_any_column_privilege('authenticated', 'public.audit_logs', 'INSERT') AS ins,
                 has_table_privilege('authenticated', 'public.central_needs_plan_revisions', 'UPDATE')
                 OR has_any_column_privilege('authenticated', 'public.central_needs_plan_revisions', 'UPDATE') AS upd`);
        expect({ ins, upd }).toEqual({ ins: false, upd: false });
        expect((await refusal(call(U_EDIT, DIRECT_SUBMIT, [d.rev])))).toMatchObject({ code: '42501' });
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
      });

      it('A5: the fence admits ONLY the exact same-transaction PRIVATE SUBMIT attestation — each single wrong binding is refused (only the root of trust can even write one)', async () => {
        const d = await readyDraft();
        const other = await readyDraft();
        const attempt = (a: { phase?: string; actor?: string; txid?: string; createdAt?: string; rev?: string; claim?: string | null; digest?: string }) => probe(async (c: any) => {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [a.claim === undefined ? U_EDIT : (a.claim ?? '')]);
          const digest = a.digest ?? (await c.query(`SELECT ${DIGEST}($1) AS d`, [d.rev])).rows[0].d;
          await c.query(
            `INSERT INTO ${STORE} (plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest, created_at)
             VALUES ($1, $2, $3, '${CONTRACT}', $4, ${a.txid ?? 'txid_current()'}, $5, ${a.createdAt ?? 'transaction_timestamp()'})`,
            [a.rev ?? d.rev, ORG_OWNER, a.phase ?? 'submit', a.actor ?? U_EDIT, digest]);
          return c.query(DIRECT_SUBMIT, [d.rev]).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
        });
        const no = `23514 ${GATE_MISSING}`;
        // The superuser is the root of trust and can mint one (policy-forbidden, rolled back here).
        expect(await attempt({})).toBe('passed');
        expect(await attempt({ txid: 'txid_current() - 1' })).toBe(no);
        expect(await attempt({ actor: U_APPROVE })).toBe(no);
        expect(await attempt({ rev: other.rev })).toBe(no);
        expect(await attempt({ phase: 'approve' })).toBe(no);
        expect(await attempt({ createdAt: `transaction_timestamp() - interval '1 microsecond'` })).toBe(no);
        expect(await attempt({ claim: null })).toBe(no);
        // The digest is computed ONCE, by the canonical submit, in readiness's
        // snapshot: the fence binds the attestation, never re-hashes the state
        // (a root-written attestation is root trust by definition).
        expect(await attempt({ digest: '0'.repeat(64) })).toBe('passed');
        // service_role cannot even reach the store.
        expect(await refusal(call(U_EDIT,
          `INSERT INTO ${STORE} (plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest)
           VALUES ($1, $2, 'submit', '${CONTRACT}', $3, txid_current(), $4)`, [d.rev, ORG_OWNER, U_EDIT, '0'.repeat(64)], 'service_role')))
          .toMatchObject({ code: '42501', message: 'permission denied for schema phoenix_private' });
        expect(await attestations(d.rev)).toEqual([]);
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
      });
    });

    // -----------------------------------------------------------------------
    // A6-A10 — the approve side
    // -----------------------------------------------------------------------
    describe('A6-A10 approval', () => {
      it('A6: a privileged INSERT of a SUBMITTED revision (no canonical provenance) -> canonical approve is REFUSED before A2 and any write; service_role cannot even insert it', async () => {
        const y = nextYear();
        const [{ id: planId }] = await admin(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG_OWNER, y]);
        expect(await refusal(call(null, `INSERT INTO public.central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
          VALUES ($1,$2,1,'submitted')`, [planId, ORG_OWNER], 'service_role'))).toMatchObject(denied('central_needs_plan_revisions'));
        const [{ id: rev }] = await admin(
          `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
           VALUES ($1,$2,1,'submitted') RETURNING id`, [planId, ORG_OWNER]);
        const r = await refused(rev, () => call(U_APPROVE, APPROVE, [rev]), PROVENANCE_MISSING);
        expect(r.detail).toBe(`revision=${rev}`);
        expect(await statuses(planId)).toEqual(['1:submitted']);
        expect(await call(U_APPROVE, REJECT, [rev, 'synthetic submitted state'])).toMatchObject({ status: 'rejected' });
      });

      it('A6: STALE provenance — canonically submitted, rejected, then root rejected -> submitted: the old SUBMIT attestation never re-authorizes approval, even over the unchanged state', async () => {
        const s = await submittedPlan();
        expect(await call(U_APPROVE, REJECT, [s.rev, 'figures do not match'])).toMatchObject({ status: 'rejected' });
        await admin(DIRECT_SUBMIT, [s.rev]);
        expect(await evidence(s.rev)).toMatchObject({ status: 'submitted', submission_gates: 1, submits: 1 });
        const [att] = (await attestations(s.rev))!;
        expect(await digestOf(s.rev)).toBe(att.state_digest);
        const r = await refused(s.rev, () => call(U_APPROVE, APPROVE, [s.rev]), PROVENANCE_MISSING);
        expect(r.detail).toBe(`revision=${s.rev}`);
        expect(await call(U_APPROVE, REJECT, [s.rev, 'stale provenance resolved'])).toMatchObject({ status: 'rejected' });
      });

      it('A6: a canonically submitted revision TOUCHED afterwards by a root write fails closed (provenance is bound to its current row version)', async () => {
        const s = await submittedPlan();
        await admin(`UPDATE public.central_needs_plan_revisions SET status = status WHERE id = $1`, [s.rev]);
        await refused(s.rev, () => call(U_APPROVE, APPROVE, [s.rev]), PROVENANCE_MISSING);
        expect(await call(U_APPROVE, REJECT, [s.rev, 'touched after submission'])).toMatchObject({ status: 'rejected' });
      });

      it('A6: provenance is also bound to the stamped updated_at — a same-transaction root rewrite of it (row version unchanged) fails closed', async () => {
        const d = await readyDraft();
        const [before, after] = await rig.asAdmin(async (c: any) => {
          await c.query('BEGIN');
          try {
            await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
            await c.query(SUBMIT, [d.rev]);
            const xmin = async () => (await c.query(
              `SELECT xmin::text AS x FROM public.central_needs_plan_revisions WHERE id = $1`, [d.rev])).rows[0].x as string;
            const b = await xmin();
            await c.query(`SET LOCAL session_replication_role = replica`);
            await c.query(`UPDATE public.central_needs_plan_revisions SET updated_at = updated_at - interval '1 second' WHERE id = $1`, [d.rev]);
            const a = await xmin();
            await c.query('COMMIT');
            return [b, a];
          } catch (e) {
            await c.query('ROLLBACK');
            throw e;
          }
        });
        expect(after).toBe(before);
        const [att] = (await attestations(d.rev))!;
        expect(att).toMatchObject({ phase: 'submit', xmin: after });
        const r = await refused(d.rev, () => call(U_APPROVE, APPROVE, [d.rev]), PROVENANCE_MISSING);
        expect(r.detail).toBe(`revision=${d.rev}`);
        expect(await attestCount(d.rev, 'approve')).toBe(0);
        expect(await call(U_APPROVE, REJECT, [d.rev, 'updated_at rewritten after submission'])).toMatchObject({ status: 'rejected' });
      });

      it('A6/DELETE-REINSERT: service_role cannot delete, truncate or touch an attested revision at all; re-created by the root, it is refused — with no attestation, and with a stale attestation over identical content', async () => {
        const s = await submittedPlan();
        expect(await call(U_APPROVE, REJECT, [s.rev, 'rejected before re-creation'])).toMatchObject({ status: 'rejected' });
        const children = [
          `DELETE FROM central_needs_need_line_sources WHERE need_line_id IN (SELECT id FROM central_needs_need_lines WHERE plan_revision_id = $1)`,
          `DELETE FROM central_needs_need_lines WHERE plan_revision_id = $1`,
          `DELETE FROM central_needs_import_batch_entries WHERE plan_revision_id = $1`,
          `DELETE FROM central_needs_import_batches WHERE plan_revision_id = $1`,
          `DELETE FROM central_needs_beneficiary_column_mappings WHERE plan_revision_id = $1`,
          `DELETE FROM central_needs_record_mappings WHERE import_session_id IN (SELECT id FROM central_needs_import_sessions WHERE plan_revision_id = $1)`,
          `DELETE FROM central_needs_source_records WHERE import_session_id IN (SELECT id FROM central_needs_import_sessions WHERE plan_revision_id = $1)`,
          `DELETE FROM central_needs_import_sessions WHERE plan_revision_id = $1`,
          `DELETE FROM central_needs_source_files WHERE plan_revision_id = $1`,
        ];
        const service = (sql: string, params: unknown[] = []) => rig.asUser(null, (c: any) => c.query(sql, params), { role: 'service_role' });
        expect(await refusal(service(children[0], [s.rev]))).toMatchObject(denied('central_needs_need_line_sources'));
        expect(await refusal(service(`DELETE FROM central_needs_plan_revisions WHERE id = $1`, [s.rev])))
          .toMatchObject(denied('central_needs_plan_revisions'));
        expect(await refusal(service(`DELETE FROM ${STORE} WHERE plan_revision_id = $1`, [s.rev])))
          .toMatchObject({ code: '42501', message: 'permission denied for schema phoenix_private' });
        expect(await refusal(service(`TRUNCATE central_needs_plan_revisions CASCADE`))).toMatchObject(denied('central_needs_plan_revisions'));
        // The root deletes everything, the attestations included, and re-creates the row SUBMITTED under its old id.
        const recreated = await probe(async (c: any) => {
          for (const sql of children) await c.query(sql, [s.rev]);
          await c.query(`CREATE TEMP TABLE p218_old ON COMMIT DROP AS SELECT created_at FROM ${STORE} WHERE plan_revision_id = $1 AND phase = 'submit'`, [s.rev]);
          await c.query(`DELETE FROM ${STORE} WHERE plan_revision_id = $1`, [s.rev]);
          await c.query(`DELETE FROM central_needs_plan_revisions WHERE id = $1`, [s.rev]);
          await c.query(
            `INSERT INTO public.central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status, updated_at)
             SELECT $1, $2, $3, 1, 'submitted', o.created_at FROM p218_old o`, [s.rev, s.planId, ORG_OWNER]);
          await c.query('SET LOCAL ROLE authenticated');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
          return c.query(APPROVE, [s.rev]).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
        });
        expect(recreated).toBe(`23514 ${PROVENANCE_MISSING}`);
        // A root that bypasses the foreign key keeps the STALE attestation and re-creates only the row: only the row-version binding betrays it.
        const stale = await probe(async (c: any) => {
          await c.query(`SET LOCAL session_replication_role = replica`);
          await c.query(`DELETE FROM central_needs_plan_revisions WHERE id = $1`, [s.rev]);
          await c.query(
            `INSERT INTO public.central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status, updated_at)
             SELECT $1, $2, $3, 1, 'submitted', a.created_at FROM ${STORE} a WHERE a.plan_revision_id = $1 AND a.phase = 'submit'`,
            [s.rev, s.planId, ORG_OWNER]);
          await c.query(`SET LOCAL session_replication_role = origin`);
          const [{ same_time, same_state }] = (await c.query(
            `SELECT r.updated_at = a.created_at AS same_time, ${DIGEST}(r.id) = a.state_digest AS same_state
               FROM central_needs_plan_revisions r JOIN ${STORE} a ON a.plan_revision_id = r.id AND a.phase = 'submit' WHERE r.id = $1`,
            [s.rev])).rows;
          await c.query('SET LOCAL ROLE authenticated');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
          return { same_time, same_state,
            approve: await c.query(APPROVE, [s.rev]).then(() => 'passed', (e: any) => `${e.code} ${e.message}`) };
        });
        expect(stale).toEqual({ same_time: true, same_state: true, approve: `23514 ${PROVENANCE_MISSING}` });
        expect(await evidence(s.rev)).toMatchObject({ status: 'rejected', submission_gates: 1, submits: 1, approval_gates: 0 });
        expect(await attestCount(s.rev, 'approve')).toBe(0);
      });

      it('no false refusal: a canonical submit inside a RELEASED savepoint (row version = the subtransaction) and a later VACUUM (FREEZE) stay approvable', async () => {
        const d = await readyDraft();
        await rig.asAdmin(async (c: any) => {
          await c.query('BEGIN');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
          await c.query('SAVEPOINT s');
          await c.query(SUBMIT, [d.rev]);
          await c.query('RELEASE SAVEPOINT s');
          await c.query('COMMIT');
        });
        const [row] = await admin(`
          SELECT r.xmin::text AS row_xmin, a.xmin::text AS att_xmin, a.txid::text AS txid, s.payload->>'revision_xmin' AS recorded
            FROM central_needs_plan_revisions r
            JOIN ${STORE} a ON a.plan_revision_id = r.id AND a.phase = 'submit'
            JOIN audit_logs s ON s.entity_id = r.id AND s.action = 'central_needs.plan_revision.submit'
           WHERE r.id = $1`, [d.rev]);
        expect(row.att_xmin).toBe(row.row_xmin);
        expect(row.recorded).toBe(row.row_xmin);
        expect(String(BigInt(row.txid) % BigInt(4294967296))).not.toBe(row.row_xmin);
        await admin(`VACUUM (FREEZE) public.central_needs_plan_revisions`);
        await admin(`VACUUM (FREEZE) ${STORE}`);
        expect((await admin(`SELECT xmin::text AS x FROM central_needs_plan_revisions WHERE id = $1`, [d.rev]))[0].x).toBe(row.row_xmin);
        expect(await call(U_APPROVE, APPROVE, [d.rev])).toMatchObject({ ok: true, status: 'approved' });
        expect(await evidence(d.rev)).toEqual({ status: 'approved', submission_gates: 1, submits: 1, approval_gates: 1, approves: 1 });
      });

      it('A6: approve accepts ONLY a private SUBMIT attestation bound to the current row version — canonical-shaped audit rows alone never do; the sealed state is not re-hashed (root probes)', async () => {
        const d = await readyDraft();
        type Variant = { dropAttestation?: boolean; split?: boolean; digest?: string; mutateAfter?: boolean };
        const attempt = (v: Variant) => probe(async (c: any) => {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
          const [{ txid }] = (await c.query(`SELECT txid_current()::text AS txid`)).rows;
          const digest = v.digest ?? (await c.query(`SELECT ${DIGEST}($1) AS d`, [d.rev])).rows[0].d;
          await c.query(
            `INSERT INTO public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, payload)
             VALUES ($1,$2,'central_needs.plan_revision.submission_gate','central_needs_plan_revision',$3,
                     jsonb_build_object('contract', 'c6-f1-v1', 'txid', $4::text, 'plan_id', $5::uuid, 'revision_number', 1))`,
            [ORG_OWNER, U_EDIT, d.rev, txid, d.planId]);
          if (v.split) await c.query('SAVEPOINT a');
          await c.query(
            `INSERT INTO ${STORE} (plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest)
             VALUES ($1, $2, 'submit', '${CONTRACT}', $3, txid_current(), $4)`, [d.rev, ORG_OWNER, U_EDIT, digest]);
          if (v.split) { await c.query('RELEASE SAVEPOINT a'); await c.query('SAVEPOINT b'); }
          const fenced = await c.query(DIRECT_SUBMIT, [d.rev]).then(() => null, (e: any) => `${e.code} ${e.message}`);
          if (fenced) return fenced;
          if (v.split) await c.query('RELEASE SAVEPOINT b');
          await c.query(
            `INSERT INTO public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, payload)
             VALUES ($1,$2,'central_needs.plan_revision.submit','central_needs_plan_revision',$3,
                     jsonb_build_object('from_status','draft','to_status','submitted','submission_gate_txid',$4::text,
                       'revision_xmin', (SELECT r.xmin::text FROM public.central_needs_plan_revisions r WHERE r.id = $3),
                       'submission_state_digest', $5::text))`,
            [ORG_OWNER, U_EDIT, d.rev, txid, digest]);
          if (v.dropAttestation) await c.query(`DELETE FROM ${STORE} WHERE plan_revision_id = $1`, [d.rev]);
          if (v.mutateAfter) {
            await c.query(`UPDATE central_needs_need_lines SET mapping_reason = mapping_reason || ' (edited)' WHERE plan_revision_id = $1`, [d.rev]);
          }
          await c.query('SET LOCAL ROLE authenticated');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
          return c.query(APPROVE, [d.rev]).then((r: any) => `passed ${r.rows[0].result.status}`, (e: any) => `${e.code} ${e.message}`);
        });
        expect(await attempt({})).toBe('passed approved');
        expect(await attempt({ dropAttestation: true })).toBe(`23514 ${PROVENANCE_MISSING}`);
        expect(await attempt({ split: true })).toBe(`23514 ${PROVENANCE_MISSING}`);
        // APPROVAL_REHASH_REMOVED: the attested digest is carried, never recomputed;
        // a ROOT write after the attestation is root trust (no non-root role can make one).
        expect(await attempt({ digest: '0'.repeat(64) })).toBe('passed approved');
        expect(await attempt({ mutateAfter: true })).toBe('passed approved');
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
        expect(await attestations(d.rev)).toEqual([]);
      });

      it('A7: canonical SUBMITTED -> canonical approve PASSES; exactly one approval gate, one approve audit and one APPROVE attestation carrying the SUBMIT digest', async () => {
        const s = await submittedPlan();
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toEqual({
          ok: true, idempotent_replay: false, plan_revision_id: s.rev, status: 'approved',
          plan_id: s.planId, revision_number: 1, superseded_revision_id: null,
        });
        expect(await evidence(s.rev)).toEqual({ status: 'approved', submission_gates: 1, submits: 1, approval_gates: 1, approves: 1 });
        const att = (await attestations(s.rev))!;
        expect(att.map((a: any) => a.phase)).toEqual(['submit', 'approve']);
        expect(att[1]).toMatchObject({ contract: CONTRACT, actor_id: U_APPROVE, state_digest: att[0].state_digest });
        const [rev] = await admin(`SELECT xmin::text AS xmin, to_jsonb(approved_at) #>> '{}' AS at FROM central_needs_plan_revisions WHERE id = $1`, [s.rev]);
        expect(att[1]).toMatchObject({ xmin: rev.xmin, ts: rev.at });
      });

      it('A8: an M217 approval-time beneficiary eligibility change is still REFUSED exactly as before; provenance is judged first', async () => {
        const b = await mkOrg('elig');
        const s = await submittedPlan([{ beneficiary: b }]);
        await admin(`UPDATE organizations SET status = 'suspended' WHERE id = $1`, [b]);
        const r = await refused(s.rev, () => call(U_APPROVE, APPROVE, [s.rev]), 'central_needs_approval_eligibility_changed');
        expect(r.detail).toBe(`blocker=need_line_beneficiary_ineligible need_line=${s.lineIds[0]} beneficiary=${b} reason=inactive`);
        expect(await evidence(s.rev)).toEqual({ status: 'submitted', submission_gates: 1, submits: 1, approval_gates: 0, approves: 0 });
        await admin(`UPDATE public.central_needs_plan_revisions SET status = status WHERE id = $1`, [s.rev]);
        await refused(s.rev, () => call(U_APPROVE, APPROVE, [s.rev]), PROVENANCE_MISSING);
        expect(await call(U_APPROVE, REJECT, [s.rev, 'beneficiary suspended'])).toMatchObject({ status: 'rejected' });
      });

      it('A9/§15.22: the direct APPROVED transition is REFUSED — by the approval fence for the root (UPDATE from submitted/draft, INSERT), by privilege for service_role; a forged approval-gate audit row authorizes nothing', async () => {
        const s = await submittedPlan();
        const d = await openDraft();
        for (const rev of [s.rev, d.rev]) {
          const r = await refused(rev, () => admin(DIRECT_APPROVE, [rev, U_APPROVE]), APPROVAL_GATE_MISSING);
          expect(r.detail).toBe(`revision=${rev}`);
          await refused(rev, () => call(null, DIRECT_APPROVE, [rev, U_APPROVE], 'service_role'), denied('central_needs_plan_revisions').message, '42501');
        }
        const id = (await admin(`SELECT gen_random_uuid() AS id`))[0].id;
        await refused(d.rev, () => admin(
          `INSERT INTO public.central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status, approved_by, approved_at)
           VALUES ($1,$2,$3,2,'approved',$4,now())`, [id, d.planId, ORG_OWNER, U_APPROVE]), APPROVAL_GATE_MISSING);
        expect(await statuses(s.planId)).toEqual(['1:submitted']);
        expect(await statuses(d.planId)).toEqual(['1:draft']);
        const forgeApproval = async (c: any) => {
          await c.query(`INSERT INTO public.audit_logs (organization_id, actor_id, action, entity_type, entity_id, payload)
                         VALUES ($1,$2,'central_needs.plan_revision.approval_gate','central_needs_plan_revision',$3,
                                 jsonb_build_object('contract','c5-v1','txid', txid_current()::text, 'plan_id', $4::uuid, 'revision_number', 1))`,
          [ORG_OWNER, U_APPROVE, s.rev, s.planId]);
          await c.query(DIRECT_APPROVE, [s.rev, U_APPROVE]);
        };
        await refusedBy(s.rev, ['superuser as the approver', () => probe(async (c: any) => {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
          await forgeApproval(c);
        }), 'fence'], APPROVAL_GATE_MISSING);
        await refusedBy(s.rev, ['service_role as the approver',
          () => rig.asUser(U_APPROVE, forgeApproval, { role: 'service_role', commit: true }), 'privilege'], APPROVAL_GATE_MISSING);
        expect(await attestCount(s.rev, 'approve')).toBe(0);
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('A9: the approval fence admits ONLY the exact same-transaction PRIVATE APPROVE attestation — each single wrong binding is refused', async () => {
        const s = await submittedPlan();
        const other = await submittedPlan();
        const attempt = (a: { phase?: string; actor?: string; txid?: string; createdAt?: string; rev?: string; claim?: string | null; digest?: string }) => probe(async (c: any) => {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [a.claim === undefined ? U_APPROVE : (a.claim ?? '')]);
          const digest = a.digest ?? (await c.query(`SELECT ${DIGEST}($1) AS d`, [s.rev])).rows[0].d;
          await c.query(
            `INSERT INTO ${STORE} (plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest, created_at)
             VALUES ($1, $2, $3, '${CONTRACT}', $4, ${a.txid ?? 'txid_current()'}, $5, ${a.createdAt ?? 'transaction_timestamp()'})`,
            [a.rev ?? s.rev, ORG_OWNER, a.phase ?? 'approve', a.actor ?? U_APPROVE, digest]);
          return c.query(DIRECT_APPROVE, [s.rev, U_APPROVE]).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
        });
        const no = `23514 ${APPROVAL_GATE_MISSING}`;
        expect(await attempt({})).toBe('passed');
        expect(await attempt({ txid: 'txid_current() - 1' })).toBe(no);
        expect(await attempt({ actor: U_EDIT })).toBe(no);
        expect(await attempt({ rev: other.rev })).toBe(no);
        expect(await attempt({ phase: 'submit' })).toBe(no);
        expect(await attempt({ createdAt: `transaction_timestamp() - interval '1 microsecond'` })).toBe(no);
        expect(await attempt({ claim: null })).toBe(no);
        expect(await attempt({ digest: '0'.repeat(64) })).toBe('passed');
        expect(await attestCount(s.rev, 'approve')).toBe(0);
        expect(await statuses(s.planId)).toEqual(['1:submitted']);
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('A2 preserved (§9.5): fresh approval-time eligibility still judges external state — a beneficiary that stops being a care institution after submit is refused by M217 A2 (root-only probe, rolled back)', async () => {
        const s = await submittedPlan();
        const out = await probe(async (c: any) => {
          await c.query(`SET LOCAL session_replication_role = replica`);
          await c.query(`UPDATE public.organizations SET organization_kind = 'pharmacy_department_authority', institution_class = NULL WHERE id = $1`,
            [ORG_BENE_A]);
          await c.query(`SET LOCAL session_replication_role = origin`);
          await c.query('SET LOCAL ROLE authenticated');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
          return c.query(APPROVE, [s.rev]).then(() => null, (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail }));
        });
        expect(out).toEqual({ code: '23514', message: 'central_needs_approval_eligibility_changed',
          detail: `blocker=need_line_beneficiary_ineligible need_line=${s.lineIds[0]} beneficiary=${ORG_BENE_A} reason=not_care_institution` });
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('P3 governed: rejected, the next revision opened through the governed path, populated, submitted and approved canonically — it carries its OWN attestations; the rejected one keeps only its old SUBMIT attestation', async () => {
        const s = await submittedPlan();
        expect(await call(U_APPROVE, REJECT, [s.rev, 'figures to be corrected'])).toMatchObject({ status: 'rejected' });
        const r2 = (await call(U_EDIT, OPEN_CORRECTION, [ORG_OWNER, s.y, s.rev, 'correction after rejection'])).plan_revision_id as string;
        expect(r2).not.toBe(s.rev);
        await populate(r2, [{ beneficiary: ORG_BENE_A }]);
        expect(await call(U_EDIT, SUBMIT, [r2])).toMatchObject({ ok: true, status: 'submitted' });
        expect(await call(U_APPROVE, APPROVE, [r2])).toMatchObject({ ok: true, status: 'approved' });
        expect(await statuses(s.planId)).toEqual(['1:rejected', '2:approved']);
        expect(((await attestations(r2))!).map((a: any) => a.phase)).toEqual(['submit', 'approve']);
        expect(((await attestations(s.rev))!).map((a: any) => a.phase)).toEqual(['submit']);
      });

      it('§2: service_role is no lifecycle caller — no EXECUTE on submit, approve, reject or any Central Needs SECURITY DEFINER routine beyond the three trusted ones, under any JWT subject', async () => {
        const surface = await admin(`
          SELECT p.proname::text AS name, has_function_privilege('service_role', p.oid, 'EXECUTE') AS svc
            FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.proname LIKE '%central\\_needs\\_%' AND p.prosecdef
           ORDER BY 1`);
        expect(surface.filter((f: any) => f.svc).map((f: any) => f.name)).toEqual([...SVC_KEPT].sort());
        expect(surface.length).toBeGreaterThan(30);
        const d = await readyDraft();
        for (const [sql, params, fn] of [
          [SUBMIT, [d.rev], 'phoenix_central_needs_submit_revision'],
          [APPROVE, [d.rev], 'phoenix_central_needs_approve_revision'],
          [REJECT, [d.rev, 'x'], 'phoenix_central_needs_reject_revision'],
          [READINESS, [d.rev], 'phoenix_central_needs_review_readiness'],
          [`SELECT ${BLOCKERS}($1) AS result`, [d.rev], '_phoenix_central_needs_review_blockers_v1'],
          [`SELECT public._phoenix_central_needs_load_revision_v1($1) AS result`, [d.rev], '_phoenix_central_needs_load_revision_v1'],
        ] as const) {
          for (const claim of [null, U_EDIT, U_APPROVE]) {
            await refused(d.rev, () => call(claim, sql, [...params], 'service_role'), `permission denied for function ${fn}`, '42501');
          }
        }
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
      });

      it('A10/§15.17: a correction revision is submitted and approved canonically; the predecessor is superseded with its approval intact', async () => {
        const r1 = await submittedPlan();
        expect(await call(U_APPROVE, APPROVE, [r1.rev])).toMatchObject({ ok: true, status: 'approved' });
        const [before] = await admin(`SELECT approved_by, approved_at FROM central_needs_plan_revisions WHERE id = $1`, [r1.rev]);
        const r2 = (await call(U_EDIT, OPEN_CORRECTION, [ORG_OWNER, r1.y, r1.rev, 'annual correction'])).plan_revision_id as string;
        await populate(r2, [{ beneficiary: ORG_BENE_B }]);
        await refused(r2, () => admin(DIRECT_SUBMIT, [r2]), GATE_MISSING);
        expect(await call(U_EDIT, SUBMIT, [r2])).toMatchObject({ ok: true, status: 'submitted' });
        expect(await call(U_APPROVE, APPROVE, [r2])).toMatchObject({ ok: true, status: 'approved', superseded_revision_id: r1.rev });
        expect(await statuses(r1.planId)).toEqual(['1:superseded', '2:approved']);
        expect((await admin(`SELECT approved_by, approved_at FROM central_needs_plan_revisions WHERE id = $1`, [r1.rev]))[0]).toEqual(before);
        expect(await evidence(r2)).toEqual({ status: 'approved', submission_gates: 1, submits: 1, approval_gates: 1, approves: 1 });
        expect(((await attestations(r2))!).map((a: any) => a.phase)).toEqual(['submit', 'approve']);
        expect(((await attestations(r1.rev))!).map((a: any) => a.phase)).toEqual(['submit', 'approve']);
        const [sup] = await admin(`SELECT payload FROM audit_logs WHERE action = 'central_needs.plan_revision.supersede' AND entity_id = $1`, [r1.rev]);
        expect(sup.payload).toMatchObject({ from_status: 'approved', to_status: 'superseded', superseded_by_revision_id: r2 });
      });
    });

    // -----------------------------------------------------------------------
    // A11-A15 and §12 — concurrency, retries, atomicity, authority, ACL
    // -----------------------------------------------------------------------
    describe('A11/§12 concurrency and rollback', () => {
      it('two concurrent canonical submits: the second waits on the first and is then REFUSED; exactly one gate, one audit, one attestation', async () => {
        const d = await readyDraft();
        const a = await held(U_EDIT);
        const b = await held(U_EDIT);
        try {
          expect(await a.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          const second = b.q(SUBMIT, [d.rev]);
          await waitBlocked(b.pid, a.pid);
          expect(await a.commit()).toEqual({ ok: true });
          const out = await second;
          expect(out.ok).toBe(false);
          expect(out.error).toMatchObject({ code: duplicateSubmitBefore!.code, message: duplicateSubmitBefore!.message });
        } finally { await a.rollback(); await b.rollback(); }
        expect(await evidence(d.rev)).toEqual({ status: 'submitted', submission_gates: 1, submits: 1, approval_gates: 0, approves: 0 });
        expect(await attestCount(d.rev, 'submit')).toBe(1);
      });

      it('A11 stale readiness: a submit that waits on a concurrent edit is judged on the COMMITTED content — made unready meanwhile, it is refused, no gate', async () => {
        const d = await readyDraft();
        const e = await held(U_EDIT);
        const s = await held(U_EDIT);
        try {
          expect(await e.q('SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[]) AS result',
            [d.lineIds[0], 'removed while another submit waits', [d.rec(1, 1)]])).toMatchObject({ ok: true });
          const submitting = s.q(SUBMIT, [d.rev]);
          await waitBlocked(s.pid, e.pid);
          expect(await e.commit()).toEqual({ ok: true });
          const out = await submitting;
          expect(out.error).toMatchObject({ code: '23514', message: 'plan_revision_not_ready_for_review' });
          expect(out.error!.detail).toMatch(/^blocker=\w+ /);
        } finally { await e.rollback(); await s.rollback(); }
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
        expect((await blockers(d.rev)).length).toBeGreaterThan(0);
      });

      it('§7 the seal from the other side: a canonical edit issued while a submit is in flight WAITS on the revision lock, then is refused plan_revision_not_editable; the attested state is the state that was approved', async () => {
        const d = await readyDraft();
        const s = await held(U_EDIT);
        const e = await held(U_EDIT);
        try {
          expect(await s.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          const editing = e.q('SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[]) AS result',
            [d.lineIds[0], 'late edit', [d.rec(1, 1)]]);
          await waitBlocked(e.pid, s.pid);
          expect(await s.commit()).toEqual({ ok: true });
          expect((await editing).error).toMatchObject({ code: '23514', message: NOT_EDITABLE });
        } finally { await s.rollback(); await e.rollback(); }
        const [att] = (await attestations(d.rev))!;
        expect(await digestOf(d.rev)).toBe(att.state_digest);
        expect(await call(U_APPROVE, APPROVE, [d.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('a direct root transition FIRST is refused at once; the canonical submit then passes', async () => {
        const d = await readyDraft();
        const x = await held(U_EDIT, 'superuser');
        try {
          expect((await x.q(DIRECT_SUBMIT, [d.rev])).error).toMatchObject({ code: '23514', message: GATE_MISSING });
        } finally { await x.rollback(); }
        expect(await call(U_EDIT, SUBMIT, [d.rev])).toMatchObject({ ok: true, status: 'submitted' });
        expect(await evidence(d.rev)).toMatchObject({ status: 'submitted', submission_gates: 1, submits: 1 });
      });

      it('a direct root transition racing an in-flight canonical submit: waits; if the submit ROLLS BACK it is refused (the rolled-back attestation authorizes nothing)', async () => {
        const d = await readyDraft();
        const a = await held(U_EDIT);
        const x = await held(U_EDIT, 'superuser');
        try {
          expect(await a.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          const direct = x.q(DIRECT_SUBMIT, [d.rev]);
          await waitBlocked(x.pid, a.pid);
          expect(await a.rollback()).toEqual({ ok: true });
          expect((await direct).error).toMatchObject({ code: '23514', message: GATE_MISSING, detail: `revision=${d.rev}` });
        } finally { await a.rollback(); await x.rollback(); }
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
      });

      it('a direct root write racing an in-flight canonical submit that COMMITS can only destroy provenance, never create it: approve then fails closed', async () => {
        const d = await readyDraft();
        const a = await held(U_EDIT);
        const x = await held(null, 'superuser');
        try {
          expect(await a.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          const direct = x.q(DIRECT_SUBMIT, [d.rev]);
          await waitBlocked(x.pid, a.pid);
          expect(await a.commit()).toEqual({ ok: true });
          expect(await direct).toMatchObject({ ok: true, rowCount: 1 });
          expect(await x.commit()).toEqual({ ok: true });
        } finally { await a.rollback(); await x.rollback(); }
        await refused(d.rev, () => call(U_APPROVE, APPROVE, [d.rev]), PROVENANCE_MISSING);
        expect(await call(U_APPROVE, REJECT, [d.rev, 'provenance destroyed by a root write'])).toMatchObject({ status: 'rejected' });
      });

      it('submit racing the approval lifecycle: an approve that waits on an in-flight submit approves only the COMMITTED canonical submission', async () => {
        const d = await readyDraft();
        const a = await held(U_EDIT);
        const b = await held(U_APPROVE);
        try {
          expect(await a.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          const approving = b.q(APPROVE, [d.rev]);
          await waitBlocked(b.pid, a.pid);
          expect(await a.commit()).toEqual({ ok: true });
          const out = await approving;
          expect(out.ok).toBe(true);
          expect(out.rows![0].result).toMatchObject({ ok: true, status: 'approved', idempotent_replay: false });
          expect(await b.commit()).toEqual({ ok: true });
        } finally { await a.rollback(); await b.rollback(); }
        expect(await evidence(d.rev)).toEqual({ status: 'approved', submission_gates: 1, submits: 1, approval_gates: 1, approves: 1 });
      });

      it('submit racing the approval lifecycle: if the in-flight submit ROLLS BACK, the waiting approve is refused and nothing remains', async () => {
        const d = await readyDraft();
        const a = await held(U_EDIT);
        const b = await held(U_APPROVE);
        try {
          expect(await a.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          const approving = b.q(APPROVE, [d.rev]);
          await waitBlocked(b.pid, a.pid);
          expect(await a.rollback()).toEqual({ ok: true });
          expect((await approving).error).toMatchObject({ code: '23514', message: 'plan_revision_not_submitted' });
        } finally { await a.rollback(); await b.rollback(); }
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
      });

      it('submit racing a reject: the reject waits and judges the COMMITTED submission; the rejected revision is never approvable again', async () => {
        const d = await readyDraft();
        const a = await held(U_EDIT);
        const b = await held(U_APPROVE);
        try {
          expect(await a.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          const rejecting = b.q(REJECT, [d.rev, 'rejected while submitting']);
          await waitBlocked(b.pid, a.pid);
          expect(await a.commit()).toEqual({ ok: true });
          expect((await rejecting).rows![0].result).toMatchObject({ status: 'rejected' });
          expect(await b.commit()).toEqual({ ok: true });
        } finally { await a.rollback(); await b.rollback(); }
        await refused(d.rev, () => call(U_APPROVE, APPROVE, [d.rev]), 'plan_revision_not_submitted');
      });

      it('§15.25 rollback after attestation creation leaves NO reusable attestation: whole-transaction and savepoint rollback, other revisions, later transactions', async () => {
        const d = await readyDraft();
        const other = await readyDraft();
        const a = await held(U_EDIT, 'superuser');
        try {
          expect(await a.q(SUBMIT, [d.rev])).toMatchObject({ ok: true });
          expect((await a.q(`SELECT count(*)::int AS n FROM ${STORE} WHERE plan_revision_id = $1 AND phase = 'submit'`, [d.rev])).rows)
            .toEqual([{ n: 1 }]);
        } finally { await a.rollback(); }
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
        expect(await attestations(d.rev)).toEqual([]);
        for (const x of attackers(DIRECT_SUBMIT, [d.rev])) await refusedBy(d.rev, x, GATE_MISSING);
        const sp = await probe(async (c: any) => {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
          await c.query('SAVEPOINT s');
          await c.query(SUBMIT, [d.rev]);
          await c.query('ROLLBACK TO SAVEPOINT s');
          return c.query(DIRECT_SUBMIT, [d.rev]).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
        });
        expect(sp).toBe(`23514 ${GATE_MISSING}`);
        const cross = await probe(async (c: any) => {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
          await c.query(SUBMIT, [d.rev]);
          return c.query(DIRECT_SUBMIT, [other.rev]).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
        });
        expect(cross).toBe(`23514 ${GATE_MISSING}`);
        expect(await call(U_EDIT, SUBMIT, [d.rev])).toMatchObject({ status: 'submitted' });
        expect(await call(U_APPROVE, REJECT, [d.rev, 'reopened by a root writer'])).toMatchObject({ status: 'rejected' });
        await admin(`UPDATE public.central_needs_plan_revisions SET status = 'draft' WHERE id = $1`, [d.rev]);
        for (const x of attackers(DIRECT_SUBMIT, [d.rev])) await refusedBy(d.rev, x, GATE_MISSING);
        expect(await evidence(d.rev)).toMatchObject({ status: 'draft', submission_gates: 1, submits: 1 });
        expect(await attestCount(d.rev, 'submit')).toBe(1);
        expect(await evidence(other.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
        expect(await attestations(other.rev)).toEqual([]);
      });
    });

    describe('A12-A15 retries, atomicity, authority and ACL', () => {
      it('A12: a duplicate submit is refused exactly as before M218; a duplicate approve is the M217 idempotent replay; neither writes', async () => {
        const s = await submittedPlan();
        const dup = await refused(s.rev, () => call(U_EDIT, SUBMIT, [s.rev]), duplicateSubmitBefore!.message, duplicateSubmitBefore!.code);
        expect(dup.detail?.replace(s.rev, '<rev>')).toBe(duplicateSubmitBefore!.detail?.replace(/[0-9a-f-]{36}/, '<rev>'));
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, idempotent_replay: false });
        const before = await snapshot(s.rev);
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toEqual({ ok: true, idempotent_replay: true, plan_revision_id: s.rev, status: 'approved' });
        expect(await snapshot(s.rev)).toEqual(before);
        await refused(s.rev, () => call(U_EDIT, SUBMIT, [s.rev]), duplicateSubmitBefore!.message, duplicateSubmitBefore!.code);
      });

      it('A13: every refusal is atomic — no status write, submission gate, submit audit, approval gate, approve audit or attestation survives any of them', async () => {
        const unready = await openDraft();
        const ready = await readyDraft();
        const submitted = await submittedPlan();
        const inserted = (await admin(`SELECT gen_random_uuid() AS id`))[0].id;
        const cases: Array<[string, string, () => Promise<unknown>, string]> = [
          ['readiness refusal', unready.rev, () => call(U_EDIT, SUBMIT, [unready.rev]), 'plan_revision_has_no_finalized_import'],
          ['fence refusal (unready)', unready.rev, () => admin(DIRECT_SUBMIT, [unready.rev]), GATE_MISSING],
          ['fence refusal (ready)', ready.rev, () => admin(DIRECT_SUBMIT, [ready.rev]), GATE_MISSING],
          ['approve of a draft', ready.rev, () => call(U_APPROVE, APPROVE, [ready.rev]), 'plan_revision_not_submitted'],
          ['duplicate submit', submitted.rev, () => call(U_EDIT, SUBMIT, [submitted.rev]), duplicateSubmitBefore!.message],
          ['direct approval', submitted.rev, () => admin(DIRECT_APPROVE, [submitted.rev, U_APPROVE]), APPROVAL_GATE_MISSING],
          ['direct approved INSERT', ready.rev, () => admin(
            `INSERT INTO public.central_needs_plan_revisions (id, plan_id, organization_id, revision_number, status, approved_by, approved_at)
             VALUES ($1,$2,$3,2,'approved',$4,now())`, [inserted, ready.planId, ORG_OWNER, U_APPROVE]), APPROVAL_GATE_MISSING],
        ];
        for (const [label, rev, action, message] of cases) {
          const before = await evidence(rev);
          await refused(rev, action, message, message === duplicateSubmitBefore!.message ? duplicateSubmitBefore!.code : '23514');
          expect(await evidence(rev), label).toEqual(before);
        }
        await admin(`UPDATE public.central_needs_plan_revisions SET status = status WHERE id = $1`, [submitted.rev]);
        const e1 = await evidence(submitted.rev);
        await refused(submitted.rev, () => call(U_APPROVE, APPROVE, [submitted.rev]), PROVENANCE_MISSING);
        expect(await evidence(submitted.rev)).toEqual(e1);
        expect(e1).toMatchObject({ approval_gates: 0, approves: 0 });
        expect(await call(U_APPROVE, REJECT, [submitted.rev, 'atomicity fixture resolved'])).toMatchObject({ status: 'rejected' });
      });

      it('A14: cross-org and unauthorized callers of submit and approve are refused exactly as before M218, writing nothing', async () => {
        const d = await readyDraft();
        for (const u of unauthorizedCalls(d.rev)) {
          const before = await snapshot(d.rev);
          const r = await refusal(u.run());
          expect({ code: r.code, message: r.message }, u.label).toEqual({
            code: unauthorizedBefore[u.label].code, message: unauthorizedBefore[u.label].message });
          expect(['42501', '28000'], u.label).toContain(r.code);
          expect(await snapshot(d.rev), u.label).toEqual(before);
        }
        const s = await submittedPlan();
        for (const u of unauthorizedCalls(s.rev).filter((x) => x.label.startsWith('approve'))) {
          const before = await snapshot(s.rev);
          const r = await refusal(u.run());
          expect({ code: r.code, message: r.message }, u.label).toEqual({
            code: unauthorizedBefore[u.label].code, message: unauthorizedBefore[u.label].message });
          expect(await snapshot(s.rev), u.label).toEqual(before);
        }
        expect(await evidence(s.rev)).toEqual({ status: 'submitted', submission_gates: 1, submits: 1, approval_gates: 0, approves: 0 });
        expect(await call(U_APPROVE, REJECT, [s.rev, 'authority fixture resolved'])).toMatchObject({ status: 'rejected' });
      });

      it('A15: the ACL delta is EXACTLY the deliberate revocations — service_role EXECUTE on the lifecycle RPCs, its Central Needs writes and every TRIGGER; authenticated, anon and every other entry byte-identical', async () => {
        expect(aclBefore).toHaveLength(3);
        const after = await lifecycleAcl();
        for (const [i, a] of after.entries()) {
          const b = aclBefore[i];
          expect(a.fn).toBe(b.fn);
          expect(a.tuples, a.fn).toEqual(b.tuples.filter((t: any) => !(t.grantee === 'service_role' && t.privilege === 'EXECUTE')));
        }
        const tablesAfter = await tableAcl();
        const byRel = (rows: any[]) => new Map(rows.map((r: any) => [r.rel, r]));
        const b = byRel(tableAclBefore);
        const a = byRel(tablesAfter);
        expect([...a.keys()].filter((k) => !b.has(k))).toEqual([]);
        for (const [rel, before] of b) {
          const now = a.get(rel)!;
          expect({ rls: now.rls, forced: now.forced }, rel).toEqual({ rls: before.rls, forced: before.forced });
          const expectedRemoved = before.tuples.filter((t: string) => {
            const [grantee, priv] = t.split('|');
            if (priv === 'TRIGGER') return grantee === 'service_role' || grantee === 'PUBLIC' || grantee === 'anon' || grantee === 'authenticated';
            return grantee === 'service_role' && CN_TABLES.includes(rel) && CN_WRITE_PRIVS.includes(priv);
          });
          expect(before.tuples.filter((t: string) => !now.tuples.includes(t)), rel).toEqual(expectedRemoved);
          expect(now.tuples.filter((t: string) => !before.tuples.includes(t)), rel).toEqual([]);
        }
        expect(b.get('audit_logs').tuples.filter((t: string) => !a.get('audit_logs').tuples.includes(t)))
          .toEqual([expect.stringMatching(/^service_role\|TRIGGER\|/)]);
      });

      it('A15/R1-4: every internal routine is least-privilege — the private ones are SECURITY INVOKER behind a schema no client can use; the approval fence trigger function is not client-callable', async () => {
        const internals: Array<[string, string, string, unknown[]]> = [
          [`${FENCE}()`, 'trigger', `SELECT ${FENCE}() AS result`, []],
          [APPROVAL_BODY_SIG, 'void', `SELECT ${APPROVAL_BODY}('INSERT', NULL, NULL) AS result`, []],
          [`${DIGEST}(uuid)`, 'text', `SELECT ${DIGEST}($1) AS result`, ['00000000-0000-0000-0000-000000000000']],
          [`${BREACHES}()`, 'text', `SELECT ${BREACHES}() AS result`, []],
        ];
        for (const [sig, ret, sql, params] of internals) {
          const [p] = await admin(`SELECT prosecdef, proconfig, prorettype::regtype::text AS ret FROM pg_proc WHERE oid = '${sig}'::regprocedure`);
          expect(p, sig).toMatchObject({ prosecdef: false, ret });
          expect(p.proconfig, sig).toEqual(['search_path=pg_catalog, pg_temp']);
          for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
            const [{ ok }] = await admin(`SELECT has_function_privilege($1, '${sig}', 'EXECUTE') AS ok`, [role]);
            expect(ok, `${sig} ${role}`).toBe(false);
          }
          for (const [user, role] of [[U_EDIT, 'authenticated'], [null, 'service_role'], [null, 'anon']] as const) {
            const r = await refusal(call(user, sql, params, role));
            expect({ code: r.code, message: r.message }, `${sig} ${role}`).toEqual({ code: '42501', message: 'permission denied for schema phoenix_private' });
          }
        }
        const [w] = await admin(`SELECT prosecdef, proconfig FROM pg_proc WHERE oid = '${APPROVAL_FENCE}()'::regprocedure`);
        expect(w).toEqual({ prosecdef: true, proconfig: ['search_path=public, pg_temp'] });
        for (const [user, role] of [[U_EDIT, 'authenticated'], [null, 'service_role'], [null, 'anon']] as const) {
          const r = await refusal(call(user, `SELECT ${APPROVAL_FENCE}() AS result`, [], role));
          expect({ code: r.code, message: r.message }, role).toEqual({ code: '42501', message: 'permission denied for function _phoenix_central_needs_approval_gate_fence_v1' });
        }
        const triggers = await admin(`
          SELECT t.tgname, t.tgtype, t.tgenabled, cardinality(t.tgattr::int2[]) AS cols, t.tgfoid::regprocedure::text AS fn
            FROM pg_trigger t WHERE t.tgrelid = 'public.central_needs_plan_revisions'::regclass AND NOT t.tgisinternal ORDER BY t.tgname`);
        expect(triggers).toEqual([
          { tgname: 'central_needs_plan_revisions_c5_approval_gate', tgtype: 23, tgenabled: 'O', cols: 0, fn: '_phoenix_central_needs_approval_gate_fence_v1()' },
          { tgname: 'central_needs_plan_revisions_c6_submission_gate', tgtype: 19, tgenabled: 'O', cols: 0, fn: `${FENCE}()` },
          { tgname: 'set_updated_at', tgtype: 19, tgenabled: 'O', cols: 0, fn: 'phoenix_set_updated_at()' },
        ]);
      });
    });

    // =======================================================================
    // §4/§11 — the private trusted schema and the private attestation store
    // =======================================================================
    describe('§4/§11 the private schema and the attestation store', () => {
      it('phoenix_private: owned by the migration owner, no privilege of any kind for PUBLIC, anon, authenticated or service_role, exactly the four routines and the store, not a Data API schema', async () => {
        const [n] = await admin(`
          SELECT pg_get_userbyid(n.nspowner) AS owner,
                 pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.central_needs_plan_revisions'::regclass)) AS cn_owner,
                 (SELECT coalesce(array_agg(DISTINCT CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee)::text END), '{}')::text[]
                    FROM aclexplode(coalesce(n.nspacl, acldefault('n', n.nspowner))) a) AS grantees
            FROM pg_namespace n WHERE n.nspname = '${PRIVATE}'`);
        expect(n.owner).toBe(n.cn_owner);
        expect(n.grantees).toEqual([n.owner]);
        for (const role of ['public', 'anon', 'authenticated', 'service_role', 'phoenix_demo_purger']) {
          const [row] = await admin(`SELECT has_schema_privilege($1, '${PRIVATE}', 'USAGE') AS u, has_schema_privilege($1, '${PRIVATE}', 'CREATE') AS c`, [role]);
          expect(row, role).toEqual({ u: false, c: false });
        }
        expect((await admin(`SELECT p.oid::regprocedure::text AS f FROM pg_proc p WHERE p.pronamespace = '${PRIVATE}'::regnamespace ORDER BY 1`))
          .map((r: any) => r.f)).toEqual([
          'phoenix_private.central_needs_approval_gate_fence_v1(text,central_needs_plan_revisions,central_needs_plan_revisions)',
          'phoenix_private.central_needs_capability_breaches_v1()',
          'phoenix_private.central_needs_submission_gate_fence_v1()',
          'phoenix_private.central_needs_submission_state_digest_v1(uuid)',
        ]);
        expect((await admin(`SELECT relname FROM pg_class WHERE relnamespace = '${PRIVATE}'::regnamespace ORDER BY 1`)).map((r: any) => r.relname))
          .toEqual(['central_needs_lifecycle_attestations', 'central_needs_lifecycle_attestations_once_key', 'central_needs_lifecycle_attestations_pkey']);
        const config = readFileSync(join(MIGRATIONS_DIR, '..', 'config.toml'), 'utf8');
        const exposed = /^\s*schemas\s*=\s*\[([^\]]*)\]/m.exec(config);
        expect(exposed, 'supabase/config.toml [api] schemas').not.toBeNull();
        expect(exposed![1]).not.toContain(PRIVATE);
        expect(await admin(`SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) c WHERE c ILIKE '%${PRIVATE}%'`)).toEqual([]);
      });

      it('the store exists exactly once: an owner-held FORCE-RLS table in phoenix_private, no policy, no sequence, no trigger, the frozen shape; nothing of R1/R2 is left in public', async () => {
        const rows = await admin(`
          SELECT n.nspname, c.relkind, c.relrowsecurity, c.relforcerowsecurity, pg_get_userbyid(c.relowner) AS owner,
                 pg_get_userbyid((SELECT relowner FROM pg_class WHERE oid = 'public.central_needs_plan_revisions'::regclass)) AS revisions_owner
            FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE c.relname = 'central_needs_lifecycle_attestations'`);
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({ nspname: PRIVATE, relkind: 'r', relrowsecurity: true, relforcerowsecurity: true });
        expect(rows[0].owner).toBe(rows[0].revisions_owner);
        expect(await admin(`SELECT to_regclass('${R2_STORE}') AS s, to_regprocedure('${R2_DIGEST}(uuid)') AS d, to_regprocedure('${R2_FENCE}()') AS f`))
          .toEqual([{ s: null, d: null, f: null }]);
        expect(await admin(`SELECT polname FROM pg_policy WHERE polrelid = '${STORE}'::regclass`)).toEqual([]);
        expect(await admin(`SELECT s.relname FROM pg_depend d JOIN pg_class s ON s.oid = d.objid AND s.relkind = 'S'
                             WHERE d.refobjid = '${STORE}'::regclass`)).toEqual([]);
        expect(await admin(`SELECT tgname FROM pg_trigger WHERE tgrelid = '${STORE}'::regclass AND NOT tgisinternal`)).toEqual([]);
        expect(await admin(`SELECT attname, format_type(atttypid, atttypmod) AS type, attnotnull FROM pg_attribute
                             WHERE attrelid = '${STORE}'::regclass AND attnum > 0 AND NOT attisdropped ORDER BY attnum`)).toEqual([
          { attname: 'id', type: 'uuid', attnotnull: true },
          { attname: 'plan_revision_id', type: 'uuid', attnotnull: true },
          { attname: 'organization_id', type: 'uuid', attnotnull: true },
          { attname: 'phase', type: 'text', attnotnull: true },
          { attname: 'contract', type: 'text', attnotnull: true },
          { attname: 'actor_id', type: 'uuid', attnotnull: true },
          { attname: 'txid', type: 'bigint', attnotnull: true },
          { attname: 'state_digest', type: 'text', attnotnull: true },
          { attname: 'created_at', type: 'timestamp with time zone', attnotnull: true },
        ]);
        const constraints = await admin(`SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint
                                          WHERE conrelid = '${STORE}'::regclass AND contype IN ('p','u','f','c') ORDER BY conname`);
        expect(constraints.map((c: any) => c.conname)).toEqual([
          'central_needs_lifecycle_attestations_contract_chk', 'central_needs_lifecycle_attestations_digest_chk',
          'central_needs_lifecycle_attestations_once_key', 'central_needs_lifecycle_attestations_phase_chk',
          'central_needs_lifecycle_attestations_pkey', 'central_needs_lifecycle_attestations_revision_org_fk',
          'central_needs_lifecycle_attestations_txid_chk',
        ]);
        expect(constraints.find((c: any) => c.conname.endsWith('contract_chk')).def).toBe(`CHECK ((contract = '${CONTRACT}'::text))`);
        expect(constraints.find((c: any) => c.conname.endsWith('revision_org_fk')).def)
          .toBe('FOREIGN KEY (plan_revision_id, organization_id) REFERENCES central_needs_plan_revisions(id, organization_id) ON DELETE RESTRICT');
      });

      it('§15.23: service_role, authenticated and anon cannot touch the private attestations — every verb is refused at the schema, and no privilege exists', async () => {
        const s = await submittedPlan();
        const verbs: Array<[string, string, unknown[]]> = [
          ['SELECT', `SELECT count(*) AS result FROM ${STORE}`, []],
          ['INSERT', `INSERT INTO ${STORE} (plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest)
                      VALUES ($1, $2, 'approve', '${CONTRACT}', $3, txid_current(), $4)`, [s.rev, ORG_OWNER, U_APPROVE, '0'.repeat(64)]],
          ['UPDATE', `UPDATE ${STORE} SET txid = txid_current() WHERE plan_revision_id = $1`, [s.rev]],
          ['DELETE', `DELETE FROM ${STORE} WHERE plan_revision_id = $1`, [s.rev]],
          ['TRUNCATE', `TRUNCATE ${STORE}`, []],
          ['LOCK', `LOCK TABLE ${STORE} IN ACCESS EXCLUSIVE MODE`, []],
        ];
        for (const [user, role] of [[U_EDIT, 'authenticated'], [U_APPROVE, 'service_role'], [null, 'service_role'], [null, 'anon']] as const) {
          for (const [verb, sql, params] of verbs) {
            const before = await snapshot(s.rev);
            const r = await refusal(rig.asUser(user, (c: any) => c.query(sql, params), { role, commit: true }));
            expect({ code: r.code, message: r.message }, `${role} ${verb}`).toEqual({ code: '42501', message: 'permission denied for schema phoenix_private' });
            expect(await snapshot(s.rev), `${role} ${verb}`).toEqual(before);
          }
        }
        for (const role of ['public', 'anon', 'authenticated', 'service_role']) {
          const [row] = await admin(`
            SELECT has_table_privilege($1, '${STORE}', 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER, MAINTAIN') AS t,
                   has_any_column_privilege($1, '${STORE}', 'SELECT, INSERT, UPDATE, REFERENCES') AS c`, [role]);
          expect(row, role).toEqual({ t: false, c: false });
        }
        expect(await attestations(s.rev)).toHaveLength(1);
      });
    });

    // =======================================================================
    // §15 A — DDL and trigger authority (§3)
    // =======================================================================
    describe('§15 A DDL and trigger authority', () => {
      const TRIGGER_TARGETS = ['central_needs_plan_revisions', 'audit_logs', 'central_needs_need_lines', 'central_needs_record_mappings',
        'central_needs_beneficiary_regions', 'organizations', 'profiles', 'phoenix_outbox_events', 'warehouses'];
      const createTrigger = (t: string, replace = false) => `CREATE ${replace ? 'OR REPLACE ' : ''}TRIGGER zz_p218f_probe BEFORE UPDATE ON public.${t}
        FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()`;
      /** [label, how to become the role inside a rolled-back probe] */
      const UNTRUSTED: Array<[string, (c: any) => Promise<void>]> = [
        ['service_role', (c) => c.query('SET LOCAL ROLE service_role')],
        ['service_role as a user', async (c) => { await c.query('SET LOCAL ROLE service_role'); await c.query(`SELECT set_config('request.jwt.claim.sub', '${U_APPROVE}', true)`); }],
        ['authenticated', (c) => c.query('SET LOCAL ROLE authenticated')],
        ['anon', (c) => c.query('SET LOCAL ROLE anon')],
        ['a member of service_role', async (c) => { const r = nextRole('m'); await c.query(`CREATE ROLE ${r} NOLOGIN`); await c.query(`GRANT service_role TO ${r}`); await c.query(`SET LOCAL ROLE ${r}`); }],
        ['a member of authenticated', async (c) => { const r = nextRole('m'); await c.query(`CREATE ROLE ${r} NOLOGIN`); await c.query(`GRANT authenticated TO ${r}`); await c.query(`SET LOCAL ROLE ${r}`); }],
        ['a BYPASSRLS non-root role', async (c) => { const r = nextRole('b'); await c.query(`CREATE ROLE ${r} NOLOGIN BYPASSRLS`); await c.query(`SET LOCAL ROLE ${r}`); }],
      ];
      const as = (become: (c: any) => Promise<void>, sql: string) => probe(async (c: any) => {
        await become(c);
        return c.query(sql).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
      });

      it('§15.1: no untrusted role can CREATE anything in public or in phoenix_private (function, table, view, type, operator)', async () => {
        for (const [who, become] of UNTRUSTED) {
          for (const sql of [
            `CREATE FUNCTION public.p218f_shadow(text) RETURNS text LANGUAGE sql AS $f$ SELECT $1 $f$`,
            `CREATE TABLE public.p218f_t (id integer)`,
            `CREATE VIEW public.p218f_v AS SELECT 1 AS x`,
            `CREATE TYPE public.p218f_e AS ENUM ('a')`,
            `CREATE FUNCTION public.p218f_eq(text, text) RETURNS boolean LANGUAGE sql AS $f$ SELECT true $f$`,
          ]) {
            expect(await as(become, sql), `${who}: ${sql.slice(0, 30)}`).toBe('42501 permission denied for schema public');
          }
          expect(await as(become, `CREATE FUNCTION ${PRIVATE}.p218f_x() RETURNS integer LANGUAGE sql AS $f$ SELECT 1 $f$`), who)
            .toBe('42501 permission denied for schema phoenix_private');
        }
      });

      it('§15.2-§15.7: no untrusted role (service_role with or without a JWT subject, authenticated, anon, inherited members, a BYPASSRLS non-root role) can CREATE or CREATE OR REPLACE a trigger on plan_revisions, audit_logs or any other lifecycle-write target', async () => {
        const before = await admin(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`);
        for (const [who, become] of UNTRUSTED) {
          for (const t of TRIGGER_TARGETS) {
            for (const replace of [false, true]) {
              expect(await as(become, createTrigger(t, replace)), `${who} ${replace ? 'OR REPLACE ' : ''}${t}`)
                .toBe(`42501 permission denied for table ${t}`);
            }
          }
          // Replacing an EXISTING fence trigger is refused the same way.
          expect(await as(become, `CREATE OR REPLACE TRIGGER central_needs_plan_revisions_c6_submission_gate BEFORE UPDATE
            ON public.central_needs_plan_revisions FOR EACH ROW EXECUTE FUNCTION public.phoenix_set_updated_at()`), who)
            .toBe('42501 permission denied for table central_needs_plan_revisions');
        }
        expect(await admin(`SELECT count(*)::int AS n FROM pg_trigger WHERE NOT tgisinternal`)).toEqual(before);
      });

      it('the effective TRIGGER privilege on every public relation is held by the root of trust only (a true superuser, the relation owner, the database owner) — directly, via PUBLIC or through membership', async () => {
        const holders = await admin(`
          SELECT c.relname, r.rolname
            FROM pg_class c CROSS JOIN pg_roles r
           WHERE c.relnamespace = 'public'::regnamespace AND c.relkind IN ('r', 'p', 'v', 'm', 'f')
             AND has_table_privilege(r.oid, c.oid, 'TRIGGER')
             AND NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> c.relowner
             AND r.oid <> (SELECT datdba FROM pg_database WHERE datname = current_database())`);
        expect(holders).toEqual([]);
        const [{ pub }] = await admin(`
          SELECT count(*)::int AS pub FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a
           WHERE c.relnamespace = 'public'::regnamespace AND a.grantee = 0 AND a.privilege_type = 'TRIGGER'`);
        expect(pub).toBe(0);
      });

      it('control: the root of trust can still create in public and attach a trigger (rolled back); service_role keeps SELECT on Central Needs and its DML on every other application table (no over-revocation)', async () => {
        expect(await tryAs('superuser', createTrigger('audit_logs'))).toBe('passed');
        expect(await tryAs('superuser', `CREATE FUNCTION public.p218f_root_ok() RETURNS integer LANGUAGE sql AS $f$ SELECT 1 $f$`)).toBe('passed');
        for (const t of CN_TABLES) {
          expect((await admin(`SELECT has_table_privilege('service_role', $1, 'SELECT') AS s`, [`public.${t}`]))[0].s, t).toBe(true);
        }
        for (const t of ['audit_logs', 'organizations', 'profiles', 'warehouses', 'phoenix_outbox_events']) {
          for (const priv of ['SELECT', 'INSERT', 'UPDATE', 'DELETE']) {
            expect((await admin(`SELECT has_table_privilege('service_role', $1, $2) AS s`, [`public.${t}`, priv]))[0].s, `${t} ${priv}`).toBe(true);
          }
        }
      });
    });

    // =======================================================================
    // §15 B — direct DML (§2)
    // =======================================================================
    describe('§15 B direct Central Needs DML', () => {
      const verbSql = (t: string) => [
        ['INSERT', `INSERT INTO public.${t} (organization_id) SELECT NULL::uuid WHERE false`],
        ['UPDATE', `UPDATE public.${t} SET organization_id = organization_id WHERE false`],
        ['DELETE', `DELETE FROM public.${t} WHERE false`],
        ['TRUNCATE', `TRUNCATE public.${t}`],
        ['LOCK', `LOCK TABLE public.${t} IN SHARE MODE`],
      ] as const;

      it('§15.8-§15.11: service_role (with or without a JWT subject), authenticated, anon, a member of service_role and a BYPASSRLS non-root role are refused INSERT, UPDATE, DELETE, TRUNCATE and LOCK on EVERY Central Needs table — by privilege, before any row is judged', async () => {
        const roles: Array<[string, (c: any) => Promise<void>]> = [
          ['service_role', (c) => c.query('SET LOCAL ROLE service_role')],
          ['service_role as the editor', async (c) => { await c.query('SET LOCAL ROLE service_role'); await c.query(`SELECT set_config('request.jwt.claim.sub', '${U_EDIT}', true)`); }],
          ['authenticated', async (c) => { await c.query('SET LOCAL ROLE authenticated'); await c.query(`SELECT set_config('request.jwt.claim.sub', '${U_EDIT}', true)`); }],
          ['anon', (c) => c.query('SET LOCAL ROLE anon')],
          ['a member of service_role', async (c) => { const r = nextRole('m'); await c.query(`CREATE ROLE ${r} NOLOGIN`); await c.query(`GRANT service_role TO ${r}`); await c.query(`SET LOCAL ROLE ${r}`); }],
          ['a BYPASSRLS non-root role', async (c) => { const r = nextRole('b'); await c.query(`CREATE ROLE ${r} NOLOGIN BYPASSRLS`); await c.query(`SET LOCAL ROLE ${r}`); }],
        ];
        for (const t of CN_TABLES) {
          for (const [verb, sql] of verbSql(t)) {
            for (const [who, become] of roles) {
              // authenticated legitimately reads through RLS but writes nothing; anon has no table privilege at all.
              const out = await probe(async (c: any) => { await become(c); return c.query(sql).then(() => 'passed', (e: any) => `${e.code} ${e.message}`); });
              expect(out, `${who} ${verb} ${t}`).toBe(`42501 permission denied for table ${t}`);
            }
          }
        }
      });

      it('§15.8/§15.9/§15.10 by example, committed attempts on real rows: status to submitted/approved, need-line insert/update/delete, mapping and region writes — each refused 42501 with nothing written', async () => {
        const s = await submittedPlan();
        const d = await readyDraft();
        const service = (sql: string, params: unknown[]) => () => call(U_EDIT, sql, params, 'service_role');
        const cases: Array<[string, string, () => Promise<unknown>, string]> = [
          ['draft -> submitted', d.rev, service(DIRECT_SUBMIT, [d.rev]), 'central_needs_plan_revisions'],
          ['submitted -> approved', s.rev, service(DIRECT_APPROVE, [s.rev, U_APPROVE]), 'central_needs_plan_revisions'],
          ['need line quantity', s.rev, service(`UPDATE public.central_needs_need_lines SET approved_quantity = 12 WHERE id = $1`, [s.lineIds[0]]), 'central_needs_need_lines'],
          ['need line delete', s.rev, service(`DELETE FROM public.central_needs_need_lines WHERE id = $1`, [s.lineIds[0]]), 'central_needs_need_lines'],
          ['need line insert', d.rev, service(`INSERT INTO public.central_needs_need_lines (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id, approved_quantity, approved_unit, mapping_reason)
             VALUES ($1, $2, $3, $4, 1, 'box', 'forged')`, [d.rev, ORG_OWNER, ORG_BENE_A, ITEM_A]), 'central_needs_need_lines'],
          ['link quantity', s.rev, service(`UPDATE public.central_needs_need_line_sources SET designated_quantity = 12 WHERE need_line_id = $1`, [s.lineIds[0]]), 'central_needs_need_line_sources'],
          ['record disposition', s.rev, service(`UPDATE public.central_needs_record_mappings SET decision_reason = 'changed' WHERE import_session_id = $1`, [s.sessionId]), 'central_needs_record_mappings'],
          ['column decision', s.rev, service(`UPDATE public.central_needs_beneficiary_column_mappings SET beneficiary_organization_id = $2 WHERE plan_revision_id = $1`, [s.rev, ORG_BENE_B]), 'central_needs_beneficiary_column_mappings'],
          ['region version', s.rev, service(`INSERT INTO public.central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id, import_session_id,
             sheet_index, row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
             VALUES (gen_random_uuid(), 1, $1, $2, $3, 0, 50, 51, 7, 7, 'beneficiary', $4, 'forged region')`, [s.rev, ORG_OWNER, s.sessionId, ORG_BENE_A]), 'central_needs_beneficiary_regions'],
          ['import session status', s.rev, service(`UPDATE public.central_needs_import_sessions SET status = 'failed' WHERE id = $1`, [s.sessionId]), 'central_needs_import_sessions'],
          ['batch count', s.rev, service(`UPDATE public.central_needs_import_batches SET accepted_entry_count = accepted_entry_count + 1 WHERE plan_revision_id = $1`, [s.rev]), 'central_needs_import_batches'],
        ];
        for (const [label, rev, attempt, table] of cases) {
          const r = await refused(rev, attempt, `permission denied for table ${table}`, '42501');
          expect(r.code, label).toBe('42501');
        }
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
      });
    });

    // =======================================================================
    // §15 C — the canonical path still works (§17)
    // =======================================================================
    describe('§15 C the canonical path', () => {
      it('§15.12: the trusted finalize-import path runs as service_role on a DRAFT — payload digest, authoritative replay, batch registration (the three routines it keeps)', async () => {
        const d = await openDraft();
        const out = await finalizeImport(d.rev);
        expect(out.digest).toMatch(/^[0-9a-f]{64}$/);
        expect(out.replayed).toMatchObject({ ok: true });
        expect(out.registered).toMatchObject({ ok: true });
        const [row] = await admin(`SELECT s.status, (SELECT count(*)::int FROM central_needs_source_records r WHERE r.import_session_id = s.id) AS records,
                                          (SELECT count(*)::int FROM central_needs_import_batch_entries e WHERE e.import_session_id = s.id) AS entries
                                     FROM central_needs_import_sessions s WHERE s.id = $1`, [out.session]);
        expect(row).toEqual({ status: 'completed', records: 1, entries: 1 });
      });

      it('§15.13-§15.17: the authorized DRAFT editing RPCs, canonical submit, approve, reject and the correction lifecycle all pass', async () => {
        const d = await readyDraft([{ beneficiary: ORG_BENE_A }, { beneficiary: ORG_BENE_B }]);
        expect(await call(U_EDIT, 'SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[]) AS result',
          [d.lineIds[1], 'second line withdrawn', [d.rec(2, 2)]])).toMatchObject({ ok: true });
        expect(await call(U_EDIT, 'SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result',
          [d.sessionId, 'sheet:0:row:2', 'not_applicable', null, 'withdrawn with its line'])).toMatchObject({ ok: true });
        expect(await blockers(d.rev)).toEqual([]);
        expect(await call(U_EDIT, SUBMIT, [d.rev])).toMatchObject({ ok: true, status: 'submitted' });
        expect(await call(U_APPROVE, REJECT, [d.rev, 'one more correction'])).toMatchObject({ status: 'rejected' });
        const r2 = (await call(U_EDIT, OPEN_CORRECTION, [ORG_OWNER, d.y, d.rev, 'corrected'])).plan_revision_id as string;
        await populate(r2, [{ beneficiary: ORG_BENE_A }]);
        expect(await call(U_EDIT, SUBMIT, [r2])).toMatchObject({ ok: true, status: 'submitted' });
        expect(await call(U_APPROVE, APPROVE, [r2])).toMatchObject({ ok: true, status: 'approved' });
        expect(await statuses(d.planId)).toEqual(['1:rejected', '2:approved']);
      });
    });

    // =======================================================================
    // §15 D — the SEALED submitted state (§7)
    // =======================================================================
    describe('§15 D the sealed SUBMITTED state', () => {
      /** Every canonical mutator aimed at a SUBMITTED revision: [label, caller, role, sql, params]. */
      const mutators = (s: Awaited<ReturnType<typeof submittedPlan>>) => {
        fileSeq += 1;
        const fh = `${fileSeq}`.padStart(64, '9');
        return [
          ['start_import_session', U_EDIT, 'authenticated', `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
            [s.rev, 'late.xls', fh, 'f'.repeat(64), JSON.stringify(BROWSER_IDENTITY), 1024, 'permanent/late']],
          ['start_import_entry_session', U_EDIT, 'authenticated', `SELECT public.phoenix_central_needs_start_import_entry_session($1,$2,$3,$4,$5::jsonb,$6,$7,$8) AS result`,
            [s.rev, 'late.xls', fh, 'f'.repeat(64), JSON.stringify(BROWSER_IDENTITY), 1024, 'permanent/late', null]],
          ['set_record_disposition', U_EDIT, 'authenticated', `SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result`,
            [s.sessionId, 'sheet:0:row:1', 'not_applicable', null, 'late decision']],
          ['set_record_mapping', U_EDIT, 'authenticated', `SELECT public.phoenix_central_needs_set_record_mapping($1,$2,$3) AS result`,
            [s.sessionId, 'sheet:0:row:1', ITEM_A]],
          ['record_field_override', U_EDIT, 'authenticated', `SELECT public.phoenix_central_needs_record_field_override($1,$2::jsonb,$3,$4,$5) AS result`,
            [s.rec(1, 1), '11', 'late override', null, null]],
          ['set_beneficiary_columns', U_EDIT, 'authenticated', SET_COLUMNS,
            [s.rev, JSON.stringify([{ importSessionId: s.sessionId, sheetIndex: 0, columnIndex: 1, beneficiaryOrganizationId: ORG_BENE_B }]), 'late column']],
          ['set_beneficiary_regions', U_EDIT, 'authenticated', `SELECT public.phoenix_central_needs_set_beneficiary_regions($1,$2,$3,$4::jsonb,$5,$6::uuid[],$7::jsonb,$8) AS result`,
            [s.rev, s.sessionId, 0, JSON.stringify(BROWSER_IDENTITY), 'Sheet0', [], JSON.stringify([]), 'late region']],
          ['set_need_line', U_EDIT, 'authenticated', SET_LINE,
            [s.rev, ORG_BENE_A, ITEM_A, 12, 'late line', JSON.stringify([{ sourceRecordId: s.rec(1, 1), designatedQuantity: '12', appliedOverrideId: null }]),
              [], 'box', 'canonical', null, null]],
          ['delete_need_line', U_EDIT, 'authenticated', 'SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[]) AS result',
            [s.lineIds[0], 'late delete', [s.rec(1, 1)]]],
          ['register_import_batch (service_role)', null, 'service_role', REGISTER,
            [s.rev, 'file', 'late.xls', 'e'.repeat(64), 'permanent/late',
              JSON.stringify([{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: fh, importSessionId: s.sessionId }]),
              JSON.stringify(PARSER_IDENTITY), 2048, 0]],
          ['submit again', U_EDIT, 'authenticated', SUBMIT, [s.rev]],
        ] as Array<[string, string | null, string, string, unknown[]]>;
      };

      it('§15.18/§15.20: EVERY canonical mutator aimed at a SUBMITTED revision is refused by its DRAFT guard (plan_revision_not_editable), and the sealed state, its digest and its evidence are byte-identical afterwards', async () => {
        const s = await submittedPlan();
        const sealed = await sealedState(s.rev);
        const [att] = (await attestations(s.rev))!;
        for (const [label, user, role, sql, params] of mutators(s)) {
          const r = await refused(s.rev, () => call(user, sql, params, role), NOT_EDITABLE);
          expect(r.code, label).toBe('23514');
        }
        // A correction cannot be opened over it either (M215: the latest revision is submitted).
        const oc = await refusal(call(U_EDIT, OPEN_CORRECTION, [ORG_OWNER, s.y, s.rev, 'correction while submitted']));
        expect(oc.code).toBe('23514');
        expect(await sealedState(s.rev)).toEqual(sealed);
        expect(await digestOf(s.rev)).toBe(att.state_digest);
        expect(await evidence(s.rev)).toEqual({ status: 'submitted', submission_gates: 1, submits: 1, approval_gates: 0, approves: 0 });
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('§15.18: the session-level mutators (the service_role replay, abandon) reach the same DRAFT guard — shown on a root-planted open session of a SUBMITTED revision (rolled back)', async () => {
        const s = await submittedPlan();
        const planted = (fn: (c: any, session: string, fh: string) => Promise<unknown>) => probe(async (c: any) => {
          fileSeq += 1;
          const fh = `${fileSeq}`.padStart(64, '8');
          const records = replayRecords(fh);
          const [{ d }] = (await c.query(`SELECT public._phoenix_central_needs_payload_digest_v1($1::jsonb) AS d`, [JSON.stringify(records)])).rows;
          const [{ id: fileId }] = (await c.query(`INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
            VALUES ($1,$2,'late.xls',$3,1024) RETURNING id`, [s.rev, ORG_OWNER, fh])).rows;
          const [{ id: session }] = (await c.query(`INSERT INTO central_needs_import_sessions (plan_revision_id, organization_id, source_file_id, status, preview_digest, parser_identity)
            VALUES ($1,$2,$3,'processing',$4,$5::jsonb) RETURNING id`, [s.rev, ORG_OWNER, fileId, d, JSON.stringify(BROWSER_IDENTITY)])).rows;
          return fn(c, session, fh).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
        });
        expect(await planted(async (c: any, session: string, fh: string) => {
          await c.query('SET LOCAL ROLE service_role');
          return c.query(REPLAY, [session, fh, JSON.stringify(replayRecords(fh)), JSON.stringify(PARSER_IDENTITY)]);
        })).toBe(`23514 ${NOT_EDITABLE}`);
        expect(await planted(async (c: any, session: string) => {
          await c.query('SET LOCAL ROLE authenticated');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
          return c.query(`SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result`, [session, 'late abandon']);
        })).toBe(`23514 ${NOT_EDITABLE}`);
        // On the revision's real (completed) session they refuse earlier, writing nothing.
        const sealed = await sealedState(s.rev);
        expect((await refusal(call(null, REPLAY, [s.sessionId, s.fileHash, JSON.stringify(replayRecords(s.fileHash)), JSON.stringify(PARSER_IDENTITY)], 'service_role'))).code)
          .toBe('23514');
        expect((await refusal(call(U_EDIT, `SELECT public.phoenix_central_needs_abandon_import_session($1,$2) AS result`, [s.sessionId, 'late']))).code)
          .toBe('23514');
        expect(await sealedState(s.rev)).toEqual(sealed);
      });

      it('§15.19/§15.20: every direct write path of every non-root role into the submitted state is refused, and the sealed state is byte-identical afterwards', async () => {
        const s = await submittedPlan();
        const sealed = await sealedState(s.rev);
        const writes: Array<[string, string, unknown[]]> = [
          ['central_needs_plan_revisions', `UPDATE public.central_needs_plan_revisions SET revision_number = revision_number WHERE id = $1`, [s.rev]],
          ['central_needs_import_sessions', `UPDATE public.central_needs_import_sessions SET status = status WHERE plan_revision_id = $1`, [s.rev]],
          ['central_needs_source_files', `DELETE FROM public.central_needs_source_files WHERE plan_revision_id = $1`, [s.rev]],
          ['central_needs_source_records', `UPDATE public.central_needs_source_records SET source_values = source_values WHERE import_session_id = $1`, [s.sessionId]],
          ['central_needs_record_mappings', `DELETE FROM public.central_needs_record_mappings WHERE import_session_id = $1`, [s.sessionId]],
          ['central_needs_field_overrides', `INSERT INTO public.central_needs_field_overrides (plan_revision_id, organization_id, target_entity, field_name, final_value, override_reason, source_record_id)
             VALUES ($1, $2, 'sheet:0:row:1', 'col:1', '11'::jsonb, 'forged', $3)`, [s.rev, ORG_OWNER, s.rec(1, 1)]],
          ['central_needs_import_batches', `DELETE FROM public.central_needs_import_batches WHERE plan_revision_id = $1`, [s.rev]],
          ['central_needs_import_batch_entries', `UPDATE public.central_needs_import_batch_entries SET entry_sha256 = repeat('a', 64) WHERE plan_revision_id = $1`, [s.rev]],
          ['central_needs_beneficiary_column_mappings', `UPDATE public.central_needs_beneficiary_column_mappings SET mapping_reason = 'x' WHERE plan_revision_id = $1`, [s.rev]],
          ['central_needs_beneficiary_regions', `DELETE FROM public.central_needs_beneficiary_regions WHERE plan_revision_id = $1`, [s.rev]],
          ['central_needs_need_lines', `UPDATE public.central_needs_need_lines SET mapping_reason = 'x' WHERE plan_revision_id = $1`, [s.rev]],
          ['central_needs_need_line_sources', `DELETE FROM public.central_needs_need_line_sources WHERE need_line_id = $1`, [s.lineIds[0]]],
          ['central_needs_plans', `UPDATE public.central_needs_plans SET plan_year = plan_year WHERE id = $1`, [s.planId]],
        ];
        for (const [table, sql, params] of writes) {
          for (const role of ['service_role', 'authenticated', 'anon']) {
            const r = await refusal(call(U_EDIT, sql, params, role));
            expect({ code: r.code, message: r.message }, `${role} ${table}`).toEqual(denied(table));
          }
          const viaMember = await probe((c: any) => asFreshRole(c, { memberOf: 'service_role' }, sql, params)).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
          expect(viaMember, `member ${table}`).toBe(`42501 permission denied for table ${table}`);
          const viaBypass = await probe((c: any) => asFreshRole(c, { bypassrls: true }, sql, params)).then(() => 'passed', (e: any) => `${e.code} ${e.message}`);
          expect(viaBypass, `bypassrls ${table}`).toBe(`42501 permission denied for table ${table}`);
        }
        expect(await sealedState(s.rev)).toEqual(sealed);
        const [att] = (await attestations(s.rev))!;
        expect(await digestOf(s.rev)).toBe(att.state_digest);
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('§8/§9 the digest is computed ONCE: submit hashes the state exactly once (in readiness\'s statement), the fences never, and approve never re-hashes the corpus', async () => {
        const d = await readyDraft();
        // Pending function statistics may survive from an earlier transaction of the same backend: count the DELTA around the call.
        const calls = (c: any) => c.query(`SELECT funcname, calls::int AS calls FROM pg_stat_xact_user_functions
                                            WHERE schemaname = '${PRIVATE}' ORDER BY funcname`).then((r: any) => Object.fromEntries(r.rows.map((x: any) => [x.funcname, x.calls])));
        const delta = (before: Record<string, number>, after: Record<string, number>) =>
          Object.fromEntries(Object.keys(after).map((k) => [k, after[k] - (before[k] ?? 0)]).filter(([, v]) => v !== 0));
        const submitCalls = await probe(async (c: any) => {
          await c.query(`SET LOCAL track_functions = 'all'`);
          const before = await calls(c);
          await c.query('SET LOCAL ROLE authenticated');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
          await c.query(SUBMIT, [d.rev]);
          await c.query('RESET ROLE');
          return delta(before, await calls(c));
        });
        // Both fence bodies run once on the one status UPDATE (the approval body returns at once for a non-approved row).
        expect(submitCalls).toEqual({ central_needs_submission_state_digest_v1: 1, central_needs_capability_breaches_v1: 1,
          central_needs_submission_gate_fence_v1: 1, central_needs_approval_gate_fence_v1: 1 });
        const s = await submittedPlan();
        const approveCalls = await probe(async (c: any) => {
          await c.query(`SET LOCAL track_functions = 'all'`);
          const before = await calls(c);
          await c.query('SET LOCAL ROLE authenticated');
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
          await c.query(APPROVE, [s.rev]);
          await c.query('RESET ROLE');
          return delta(before, await calls(c));
        });
        expect(approveCalls).toEqual({ central_needs_capability_breaches_v1: 1, central_needs_approval_gate_fence_v1: 1,
          central_needs_submission_gate_fence_v1: 1 });
      });
    });

    // =======================================================================
    // G1 — submit requires READ COMMITTED
    // =======================================================================
    describe('submit isolation (the snapshot the seal rests on)', () => {
      it('a canonical submit under REPEATABLE READ or SERIALIZABLE is refused central_needs_submit_requires_read_committed (0A000) before any lock or write; under READ COMMITTED it passes', async () => {
        const d = await readyDraft();
        for (const level of ['REPEATABLE READ', 'SERIALIZABLE']) {
          const before = await snapshot(d.rev);
          const out = await rig.asAdmin(async (c: any) => {
            await c.query(`BEGIN ISOLATION LEVEL ${level}`);
            try {
              await c.query('SET LOCAL ROLE authenticated');
              await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
              return await c.query(SUBMIT, [d.rev]).then(() => null, (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail }));
            } finally { await c.query('ROLLBACK'); }
          });
          expect(out, level).toEqual({ code: '0A000', message: RC_REQUIRED, detail: `transaction_isolation=${level.toLowerCase()}` });
          expect(await snapshot(d.rev)).toEqual(before);
        }
        // A hoisted default_transaction_isolation (PostgREST applies function-level settings as transaction-scoped settings) is refused alike.
        const hoisted = await rig.asAdmin(async (c: any) => {
          await c.query(`SET default_transaction_isolation = 'repeatable read'`);
          try {
            await c.query('BEGIN');
            await c.query('SET LOCAL ROLE authenticated');
            await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_EDIT]);
            return await c.query(SUBMIT, [d.rev]).then(() => null, (e: any) => String(e.message));
          } finally { await c.query('ROLLBACK'); await c.query('RESET default_transaction_isolation'); }
        });
        expect(hoisted).toBe(RC_REQUIRED);
        expect(await call(U_EDIT, SUBMIT, [d.rev])).toMatchObject({ ok: true, status: 'submitted' });
      });
    });

    // =======================================================================
    // §9.4/§13 — the runtime seal predicate against privilege drift
    // =======================================================================
    describe('the runtime seal predicate (privilege drift)', () => {
      const drifts: Array<[string, string[], string]> = [
        ['service_role DML re-granted', ['GRANT UPDATE ON public.central_needs_need_lines TO service_role'],
          'service_role holds UPDATE on public.central_needs_need_lines'],
        ['TRIGGER on audit_logs re-granted', ['GRANT TRIGGER ON public.audit_logs TO authenticated'], 'authenticated holds TRIGGER on public.audit_logs'],
        ['CREATE on public re-granted', ['GRANT CREATE ON SCHEMA public TO service_role'], 'service_role holds CREATE on schema public'],
        ['USAGE on the private schema', [`GRANT USAGE ON SCHEMA ${PRIVATE} TO anon`], 'anon holds USAGE on schema phoenix_private'],
        ['an inherited grant', ['CREATE ROLE p218f_drift_member NOLOGIN', 'GRANT p218f_drift_member TO service_role',
          'GRANT DELETE ON public.central_needs_import_batches TO p218f_drift_member'],
          'p218f_drift_member holds DELETE on public.central_needs_import_batches'],
        ['an object left by service_role', [`CREATE FUNCTION public.p218f_drift() RETURNS integer LANGUAGE sql AS $f$ SELECT 1 $f$`,
          'ALTER FUNCTION public.p218f_drift() OWNER TO service_role'], 'service_role owns routine public.p218f_drift'],
      ];

      it('submit and approve refuse central_needs_capability_seal_breached (55000, naming the capability) while any non-root capability is re-granted, and write nothing (rolled back)', async () => {
        const d = await readyDraft();
        const s = await submittedPlan();
        for (const [label, setup, detail] of drifts) {
          for (const [rev, user, sql] of [[d.rev, U_EDIT, SUBMIT], [s.rev, U_APPROVE, APPROVE]] as const) {
            const out = await probe(async (c: any) => {
              for (const stmt of setup) await c.query(stmt);
              await c.query('SET LOCAL ROLE authenticated');
              await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user]);
              return c.query(sql, [rev]).then(() => null, (e: any) => ({ code: String(e.code), message: String(e.message), detail: e.detail }));
            });
            expect(out, `${label} ${sql}`).toEqual({ code: '55000', message: SEAL_BREACHED, detail });
          }
        }
        expect(await evidence(d.rev)).toEqual({ status: 'draft', submission_gates: 0, submits: 0, approval_gates: 0, approves: 0 });
        expect(await evidence(s.rev)).toEqual({ status: 'submitted', submission_gates: 1, submits: 1, approval_gates: 0, approves: 0 });
        // Converged again, both pass.
        expect(await call(U_EDIT, SUBMIT, [d.rev])).toMatchObject({ ok: true, status: 'submitted' });
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('the root of trust is never a breach: a superuser role, the table owner and the database owner may hold every privilege', async () => {
        const out = await probe(async (c: any) => {
          await c.query('CREATE ROLE p218f_root NOLOGIN SUPERUSER');
          await c.query('GRANT ALL ON public.central_needs_need_lines TO p218f_root');
          await c.query(`GRANT ALL ON SCHEMA ${PRIVATE} TO p218f_root`);
          await c.query('GRANT CREATE ON SCHEMA public TO p218f_root');
          return (await c.query(`SELECT count(*)::int AS n FROM ${BREACHES}()`)).rows[0].n;
        });
        expect(out).toBe(0);
      });
    });

    // =======================================================================
    // §13 — default privileges
    // =======================================================================
    describe('§13 default privileges', () => {
      it('a table the migration owner creates in public later grants service_role no TRIGGER (its other defaults stay explicit) and anon / authenticated nothing; functions keep the explicit service_role EXECUTE default', async () => {
        const out = await probe(async (c: any) => {
          await c.query('CREATE TABLE public.p218f_future (id integer)');
          await c.query('CREATE FUNCTION public.p218f_future_fn() RETURNS integer LANGUAGE sql AS $f$ SELECT 1 $f$');
          const privs = async (role: string) => (await c.query(`SELECT coalesce(array_agg(p ORDER BY p), '{}') AS p
              FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER','MAINTAIN']) p
             WHERE has_table_privilege($1, 'public.p218f_future', p)`, [role])).rows[0].p;
          const exec = async (role: string) => (await c.query(`SELECT has_function_privilege($1, 'public.p218f_future_fn()', 'EXECUTE') AS x`, [role])).rows[0].x;
          return {
            service_role: await privs('service_role'), authenticated: await privs('authenticated'), anon: await privs('anon'),
            fn: { service_role: await exec('service_role'), authenticated: await exec('authenticated'), anon: await exec('anon') },
          };
        });
        expect(out.service_role).not.toContain('TRIGGER');
        expect(out.service_role).toEqual(['DELETE', 'INSERT', 'MAINTAIN', 'REFERENCES', 'SELECT', 'TRUNCATE', 'UPDATE']);
        expect(out.authenticated).toEqual([]);
        expect(out.anon).toEqual([]);
        expect(out.fn).toEqual({ service_role: true, authenticated: false, anon: false });
        const defaults = await admin(`
          SELECT pg_get_userbyid(d.defaclrole) AS holder, coalesce(n.nspname, '-') AS schema, d.defaclobjtype AS kind,
                 CASE WHEN a.grantee = 0 THEN 'PUBLIC' ELSE pg_get_userbyid(a.grantee) END AS grantee, a.privilege_type AS priv
            FROM pg_default_acl d LEFT JOIN pg_namespace n ON n.oid = d.defaclnamespace CROSS JOIN LATERAL aclexplode(d.defaclacl) a
           WHERE a.privilege_type = 'TRIGGER'`);
        expect(defaults.filter((x: any) => x.grantee !== x.holder)).toEqual([]);
      });
    });

    // =======================================================================
    // §5 — SECURITY DEFINER search paths
    // =======================================================================
    describe('§5 SECURITY DEFINER search paths', () => {
      it('every SECURITY DEFINER routine in public and phoenix_private pins a search path, and every schema it names is creatable by the root of trust alone', async () => {
        const bad = await admin(`
          WITH cfg AS (
            SELECT p.oid, (SELECT substr(c, 13) FROM unnest(p.proconfig) c WHERE c LIKE 'search\\_path=%' LIMIT 1) AS val
              FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
             WHERE n.nspname IN ('public', '${PRIVATE}') AND p.prosecdef),
          ent AS (SELECT cfg.oid, btrim(btrim(s), '"') AS schema FROM cfg, regexp_split_to_table(cfg.val, ',') s WHERE cfg.val IS NOT NULL)
          SELECT cfg.oid::regprocedure::text AS fn, 'no search_path' AS why FROM cfg WHERE cfg.val IS NULL
          UNION ALL
          SELECT ent.oid::regprocedure::text, ent.schema FROM ent
           WHERE ent.schema NOT IN ('pg_catalog', 'pg_temp')
             AND (to_regnamespace(ent.schema) IS NULL OR EXISTS (
                   SELECT 1 FROM pg_roles r
                    WHERE NOT r.rolsuper AND r.rolname !~ '^pg_' AND r.oid <> (SELECT datdba FROM pg_database WHERE datname = current_database())
                      AND r.oid <> (SELECT nspowner FROM pg_namespace WHERE oid = to_regnamespace(ent.schema))
                      AND has_schema_privilege(r.oid, to_regnamespace(ent.schema), 'CREATE')))`);
        expect(bad).toEqual([]);
        const [{ n }] = await admin(`SELECT count(*)::int AS n FROM pg_proc p WHERE p.pronamespace = 'public'::regnamespace AND p.prosecdef`);
        expect(n).toBeGreaterThan(300);
        const hardened = await admin(`SELECT p.oid::regprocedure::text AS fn, p.prosecdef, p.proconfig FROM pg_proc p
          WHERE p.oid IN ('public.phoenix_central_needs_submit_revision(uuid)'::regprocedure, 'public.phoenix_central_needs_approve_revision(uuid)'::regprocedure)
          ORDER BY 1`);
        expect(hardened).toEqual([
          { fn: 'phoenix_central_needs_approve_revision(uuid)', prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp'] },
          { fn: 'phoenix_central_needs_submit_revision(uuid)', prosecdef: true, proconfig: ['search_path=pg_catalog, pg_temp', `statement_timeout=${SUBMIT_TIMEOUT}`] },
        ]);
      });

      it('a hostile caller session cannot redirect the hardened lifecycle: temporary objects named like the application relations are never resolved; submit and approve write the real tables', async () => {
        const d = await readyDraft();
        const hostile = async (c: any) => {
          for (const t of ['audit_logs', 'central_needs_plan_revisions', 'central_needs_need_lines', 'central_needs_lifecycle_attestations']) {
            await c.query(`CREATE TEMP TABLE ${t} (id uuid, status text, note text) ON COMMIT DROP`);
          }
        };
        const submitted = await rig.asUser(U_EDIT, async (c: any) => { await hostile(c); return (await c.query(SUBMIT, [d.rev])).rows[0].result; },
          { role: 'authenticated', commit: true });
        expect(submitted).toMatchObject({ ok: true, status: 'submitted' });
        const approved = await rig.asUser(U_APPROVE, async (c: any) => { await hostile(c); return (await c.query(APPROVE, [d.rev])).rows[0].result; },
          { role: 'authenticated', commit: true });
        expect(approved).toMatchObject({ ok: true, status: 'approved' });
        expect(await evidence(d.rev)).toEqual({ status: 'approved', submission_gates: 1, submits: 1, approval_gates: 1, approves: 1 });
        expect(((await attestations(d.rev))!).map((a: any) => a.phase)).toEqual(['submit', 'approve']);
      });
    });

    // =======================================================================
    // §12 — the function-level submit timeout
    // =======================================================================
    describe('§12 readiness performance: the invalid-evidence index', () => {
      it('is the frozen partial index over the readiness predicate\'s own expression, the planner can serve the predicate from it, and it changes no readiness answer: legacy invalid evidence is still reported (rolled back)', async () => {
        const [ix] = await admin(`SELECT i.indisvalid AS valid, i.indisready AS ready, i.indisunique AS uniq,
                                         pg_get_indexdef(i.indexrelid) AS def
                                    FROM pg_index i WHERE i.indexrelid = 'public.central_needs_source_records_invalid_evidence_idx'::regclass`);
        expect(ix).toMatchObject({ valid: true, ready: true, uniq: false });
        expect(ix.def).toMatch(/^CREATE INDEX central_needs_source_records_invalid_evidence_idx ON public\.central_needs_source_records USING btree \(import_session_id\) WHERE \((?:public\.)?_phoenix_central_needs_review_numeric_class_v1\(source_values\) = 'invalid_evidence'::text\)$/);
        const d = await readyDraft();
        const out = await probe(async (c: any) => {
          // Legacy evidence predates M217's NOT VALID CHECK: reproduce one such row (root, rolled back).
          await c.query('ALTER TABLE public.central_needs_source_records DROP CONSTRAINT central_needs_source_records_c5_value_contract');
          const [{ id }] = (await c.query(`INSERT INTO public.central_needs_source_records (import_session_id, organization_id, record_ordinal,
              target_entity, field_name, source_values) VALUES ($1, $2, 99, 'sheet:0:row:99', 'col:9', '{"value": 25}'::jsonb) RETURNING id`,
          [d.sessionId, ORG_OWNER])).rows;
          await c.query('SET LOCAL enable_seqscan = off');
          const plan = (await c.query(`EXPLAIN (COSTS OFF) SELECT 1 FROM public.central_needs_source_records r
              WHERE r.import_session_id = $1 AND public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'invalid_evidence'`,
          [d.sessionId])).rows.map((r: any) => r['QUERY PLAN']).join('\n');
          const blockers = (await c.query(`SELECT blocker, detail FROM ${BLOCKERS}($1)`, [d.rev])).rows;
          const inIndex = (await c.query(`SELECT count(*)::int AS n FROM public.central_needs_source_records r
              WHERE public._phoenix_central_needs_review_numeric_class_v1(r.source_values) = 'invalid_evidence'`)).rows[0].n;
          return { id, plan, blockers, inIndex };
        });
        expect(out.plan).toContain('central_needs_source_records_invalid_evidence_idx');
        expect(out.blockers).toContainEqual({ blocker: 'source_cell_value_contract_invalid',
          detail: `session=${d.sessionId} source_record=${out.id} reason=invalid_evidence` });
        expect(out.inIndex).toBeGreaterThanOrEqual(1);
        // Nothing survived: the ready draft is still ready.
        expect(await blockers(d.rev)).toEqual([]);
      });
    });

    describe('§12 the function-level submit timeout', () => {
      it('only submit carries a statement_timeout, and M218 set no role- or database-level timeout', async () => {
        const fns = await admin(`SELECT p.oid::regprocedure::text AS fn FROM pg_proc p, unnest(p.proconfig) c
                                  WHERE p.pronamespace IN ('public'::regnamespace, '${PRIVATE}'::regnamespace) AND c LIKE 'statement\\_timeout=%'`);
        expect(fns.map((f: any) => f.fn)).toEqual(['phoenix_central_needs_submit_revision(uuid)']);
        expect(await admin(`SELECT 1 FROM pg_db_role_setting s, unnest(s.setconfig) c WHERE c LIKE 'statement\\_timeout=%'`)).toEqual([]);
        expect(SUBMIT_TIMEOUT).toMatch(/^\d+s$/);
        expect(Number(SUBMIT_TIMEOUT.slice(0, -1))).toBeLessThanOrEqual(60);
      });

      it('a direct call cannot extend its own statement (the caller\'s timeout cancels it); the PostgREST /rpc sequence — the function\'s setting applied as a transaction-scoped setting BEFORE the call — lets a long submit finish', async () => {
        const run = async (hoist: boolean) => {
          const d = await readyDraft();
          const lock = await held(null, 'superuser');
          const caller = await held(U_EDIT, 'authenticated', [`SET LOCAL statement_timeout = '300ms'`]);
          try {
            expect(await lock.q(`LOCK TABLE ${STORE} IN ACCESS EXCLUSIVE MODE`)).toMatchObject({ ok: true });
            if (hoist) {
              const [{ v }] = await admin(`SELECT substr(c, 19) AS v FROM pg_proc p, unnest(p.proconfig) c
                WHERE p.oid = 'public.phoenix_central_needs_submit_revision(uuid)'::regprocedure AND c LIKE 'statement\\_timeout=%'`);
              expect(await caller.q(`SELECT set_config('statement_timeout', $1, true)`, [v])).toMatchObject({ ok: true });
            }
            const t = Date.now();
            const submitting = caller.q(SUBMIT, [d.rev]);
            if (hoist) {
              await waitBlocked(caller.pid, lock.pid);
              await sleep(900);
              expect(await lock.rollback()).toEqual({ ok: true });
            }
            const out = await submitting;
            const elapsed = Date.now() - t;
            await lock.rollback();
            if (!hoist) {
              expect(out.error).toMatchObject({ code: '57014', message: 'canceling statement due to statement timeout' });
              expect(await caller.rollback()).toEqual({ ok: true });
              expect(await evidence(d.rev)).toMatchObject({ status: 'draft', submits: 0 });
            } else {
              expect(out).toMatchObject({ ok: true });
              expect(elapsed).toBeGreaterThan(800);
              expect(await caller.commit()).toEqual({ ok: true });
              expect(await evidence(d.rev)).toMatchObject({ status: 'submitted', submits: 1 });
              expect(await call(U_APPROVE, REJECT, [d.rev, 'timeout fixture resolved'])).toMatchObject({ status: 'rejected' });
            }
          } finally { await lock.rollback(); await caller.rollback(); }
        };
        await run(false);
        await run(true);
      });
    });

    // =======================================================================
    // §17 — service_role compatibility outside Central Needs
    // =======================================================================
    describe('§17 service_role compatibility', () => {
      it('every non-Central-Needs RPC a service_role-key runtime caller invokes keeps its EXECUTE; the platform-invoked auth trigger routine is unchanged', async () => {
        for (const sig of SVC_RUNTIME_OTHER) {
          const [row] = await admin(`SELECT to_regprocedure($1) IS NOT NULL AS present, has_function_privilege('service_role', $1, 'EXECUTE') AS x`, [sig]);
          expect(row, sig).toEqual({ present: true, x: true });
        }
        const [h] = await admin(`SELECT p.prosecdef, pg_get_userbyid(p.proowner) AS owner, p.proconfig FROM pg_proc p
                                   WHERE p.oid = 'public.phoenix_handle_new_user()'::regprocedure`);
        expect(h).toMatchObject({ prosecdef: true, proconfig: ['search_path=public, pg_temp'] });
        expect((await admin(`SELECT count(*)::int AS n FROM profiles WHERE id = $1`, [U_EDIT]))[0].n).toBe(1);
      });

      it('service_role still reads Central Needs, writes its other application tables and creates TEMP tables — only the revoked capability classes are gone (rolled back)', async () => {
        const s = await submittedPlan();
        const out = await probe(async (c: any) => {
          await c.query('SET LOCAL ROLE service_role');
          const read = (await c.query(`SELECT count(*)::int AS n FROM public.central_needs_need_lines WHERE plan_revision_id = $1`, [s.rev])).rows[0].n;
          await c.query(`INSERT INTO public.audit_logs (organization_id, action, entity_type, payload) VALUES ($1, 'p218f.compat', 'probe', '{}'::jsonb)`, [ORG_OWNER]);
          await c.query(`UPDATE public.organizations SET updated_at = updated_at WHERE id = $1`, [ORG_OWNER]);
          await c.query(`CREATE TEMP TABLE p218f_scratch (id integer) ON COMMIT DROP`);
          return read;
        });
        expect(out).toBe(1);
      });

      it('the demo purge boundary (phoenix_demo_purger) lost only its spent CREATE on public: it still owns its routines, and holds no Central Needs privilege', async () => {
        const [row] = await admin(`SELECT pg_get_userbyid(proowner) AS owner FROM pg_proc WHERE oid = 'public._phoenix_200_demo_purge_execute(text, boolean)'::regprocedure`);
        expect(row.owner).toBe('phoenix_demo_purger');
        for (const t of CN_TABLES) {
          const [{ any }] = await admin(`SELECT has_table_privilege('phoenix_demo_purger', $1, 'SELECT, INSERT, UPDATE, DELETE, TRUNCATE, TRIGGER') AS any`, [`public.${t}`]);
          expect(any, t).toBe(false);
        }
        const [{ create, usage }] = await admin(`SELECT has_schema_privilege('phoenix_demo_purger', 'public', 'CREATE') AS create,
          has_schema_privilege('phoenix_demo_purger', 'public', 'USAGE') AS usage`);
        expect({ create, usage }).toEqual({ create: false, usage: true });
      });
    });

    // =======================================================================
    // §8 — the submission-state digest (R1 scope, computed once)
    // =======================================================================
    describe('§8 the submission-state digest', () => {
      it('is deterministic and session-independent: identical across calls and under other TimeZone, DateStyle, IntervalStyle and extra_float_digits', async () => {
        const s = await submittedPlan();
        const base = await digestOf(s.rev);
        expect(base).toMatch(/^[0-9a-f]{64}$/);
        expect(await digestOf(s.rev)).toBe(base);
        expect((await attestations(s.rev))![0].state_digest).toBe(base);
        const values = await probe(async (c: any) => {
          await c.query(`INSERT INTO central_needs_field_overrides (plan_revision_id, organization_id, target_entity, field_name,
                           previous_value, final_value, override_reason, source_record_id, created_at)
                         VALUES ($1, $2, 'sheet:0:row:1', 'col:1', '10'::jsonb, '10'::jsonb, 'probe', $3, '2026-09-27 03:04:05.678901+00')`,
          [s.rev, ORG_OWNER, s.rec(1, 1)]);
          const d = async () => (await c.query(`SELECT ${DIGEST}($1) AS d`, [s.rev])).rows[0].d as string;
          const out = [await d()];
          for (const set of [
            [`SET LOCAL TimeZone = 'Pacific/Chatham'`, `SET LOCAL DateStyle = 'SQL, DMY'`],
            [`SET LOCAL TimeZone = 'America/St_Johns'`, `SET LOCAL DateStyle = 'German, YMD'`, `SET LOCAL IntervalStyle = 'sql_standard'`],
            [`SET LOCAL extra_float_digits = 0`, `SET LOCAL TimeZone = 'UTC'`],
          ]) {
            for (const stmt of set) await c.query(stmt);
            out.push(await d());
          }
          return out;
        });
        expect(new Set(values).size).toBe(1);
        expect(values[0]).not.toBe(base);
      });

      it('covers every readiness-sensitive category: a change in each flips the digest; volatile metadata does not (root probes, rolled back)', async () => {
        const s = await submittedPlan();
        const other = await readyDraft();
        const base = await digestOf(s.rev);
        const flip = (label: string, statements: string[], expectChange = true) => probe(async (c: any) => {
          for (const sql of statements) await c.query(sql, sql.includes('$1') ? [s.rev] : []);
          const d = (await c.query(`SELECT ${DIGEST}($1) AS d`, [s.rev])).rows[0].d;
          return { label, changed: d !== base, expectChange };
        });
        const sessionsOf = `(SELECT id FROM central_needs_import_sessions WHERE plan_revision_id = $1)`;
        const linesOf = `(SELECT id FROM central_needs_need_lines WHERE plan_revision_id = $1)`;
        const results = [
          await flip('revision identity', [`UPDATE central_needs_plan_revisions SET revision_number = revision_number + 100 WHERE id = $1`]),
          await flip('session status', [`UPDATE central_needs_import_sessions SET status = 'failed' WHERE plan_revision_id = $1`]),
          await flip('session finalization evidence', [`UPDATE central_needs_import_sessions
            SET preview_digest = repeat('f', 64), authoritative_digest = repeat('f', 64) WHERE plan_revision_id = $1`]),
          await flip('new source record', [`INSERT INTO central_needs_source_records (import_session_id, organization_id, record_ordinal, target_entity,
            field_name, source_values, source_provenance) SELECT id, organization_id, 99, 'sheet:0:row:99', 'col:9',
            '{"value": 1, "valueType": "number", "isFormula": false, "formula": null}'::jsonb, NULL
            FROM central_needs_import_sessions WHERE plan_revision_id = $1`]),
          await flip('record disposition', [`UPDATE central_needs_record_mappings SET decision_reason = 'changed after submit'
            WHERE import_session_id IN ${sessionsOf}`]),
          await flip('field override', [`INSERT INTO central_needs_field_overrides (plan_revision_id, organization_id, target_entity, field_name,
            final_value, override_reason, source_record_id)
            SELECT $1, sr.organization_id, sr.target_entity, sr.field_name, '11'::jsonb, 'late override', sr.id
              FROM central_needs_source_records sr WHERE sr.import_session_id IN ${sessionsOf} LIMIT 1`]),
          await flip('trusted batch', [`UPDATE central_needs_import_batches SET accepted_entry_count = accepted_entry_count + 1 WHERE plan_revision_id = $1`]),
          await flip('batch entry', [`UPDATE central_needs_import_batch_entries SET entry_sha256 = repeat('a', 64) WHERE plan_revision_id = $1`]),
          await flip('column decision', [`UPDATE central_needs_beneficiary_column_mappings SET mapping_reason = 'changed after submit' WHERE plan_revision_id = $1`]),
          await flip('region version (root, guards off)', [`SET LOCAL session_replication_role = replica`,
            `INSERT INTO central_needs_beneficiary_regions (region_id, version_no, plan_revision_id, organization_id, import_session_id, sheet_index,
               row_start, row_end, column_start, column_end, decision, beneficiary_organization_id, decision_reason)
             SELECT gen_random_uuid(), 1, $1, organization_id, id, 0, 50, 51, 7, 7, 'beneficiary', '${ORG_BENE_A}', 'root insert'
               FROM central_needs_import_sessions WHERE plan_revision_id = $1`]),
          await flip('need line quantity', [`UPDATE central_needs_need_lines SET approved_quantity = approved_quantity + 1 WHERE plan_revision_id = $1`]),
          await flip('need line quantity scale (10 -> 10.0)', [`UPDATE central_needs_need_lines SET approved_quantity = 10.0 WHERE plan_revision_id = $1`]),
          await flip('need line rationale', [`UPDATE central_needs_need_lines SET mapping_reason = 'changed after submit' WHERE plan_revision_id = $1`]),
          await flip('need line beneficiary', [`UPDATE central_needs_need_lines SET beneficiary_organization_id = '${ORG_BENE_B}' WHERE plan_revision_id = $1`]),
          await flip('link designated quantity', [`UPDATE central_needs_need_line_sources SET designated_quantity = designated_quantity + 1
            WHERE need_line_id IN ${linesOf}`]),
          await flip('link removed', [`DELETE FROM central_needs_need_line_sources WHERE need_line_id IN ${linesOf}`]),
          await flip('override of a linked record owned by ANOTHER revision', [`INSERT INTO central_needs_field_overrides (plan_revision_id,
              organization_id, target_entity, field_name, final_value, override_reason, source_record_id)
            SELECT '${other.rev}', sr.organization_id, sr.target_entity, sr.field_name, '12'::jsonb, 'foreign-revision override', sr.id
              FROM central_needs_source_records sr JOIN central_needs_need_line_sources l ON l.source_record_id = sr.id
             WHERE l.need_line_id IN ${linesOf} LIMIT 1`]),
          await flip('need line updated_at / mapped_by', [`UPDATE central_needs_need_lines SET mapped_by = NULL WHERE plan_revision_id = $1`], false),
          await flip('link linked_at', [`UPDATE central_needs_need_line_sources SET linked_at = linked_at + interval '1 day'
            WHERE need_line_id IN ${linesOf}`], false),
          await flip('record mapping decided_at', [`UPDATE central_needs_record_mappings SET decided_at = decided_at + interval '1 day'
            WHERE import_session_id IN ${sessionsOf}`], false),
          await flip('session notes / started_at', [`UPDATE central_needs_import_sessions SET notes = 'x', started_at = started_at - interval '1 day'
            WHERE plan_revision_id = $1`], false),
          await flip('column mapping mapped_at', [`UPDATE central_needs_beneficiary_column_mappings SET mapped_at = mapped_at + interval '1 day'
            WHERE plan_revision_id = $1`], false),
        ];
        for (const r of results) expect(r.changed, r.label).toBe(r.expectChange);
        const cross = await probe(async (c: any) => {
          const [{ id }] = (await c.query(`INSERT INTO central_needs_source_records (import_session_id, organization_id, record_ordinal,
              target_entity, field_name, source_values)
            SELECT id, organization_id, 98, 'sheet:0:row:98', 'col:9', '{"value": 1, "valueType": "number", "isFormula": false, "formula": null}'::jsonb
              FROM central_needs_import_sessions WHERE plan_revision_id = $1 LIMIT 1 RETURNING id`, [s.rev])).rows;
          const before = (await c.query(`SELECT ${DIGEST}($1) AS d`, [s.rev])).rows[0].d;
          const linked = await c.query(`INSERT INTO central_needs_need_line_sources (need_line_id, organization_id, source_record_id, designated_quantity)
            VALUES ($1, $2, $3, 1)`, [other.lineIds[0], ORG_OWNER, id]);
          const after = (await c.query(`SELECT ${DIGEST}($1) AS d`, [s.rev])).rows[0].d;
          return { linked: linked.rowCount, moved: before !== after };
        });
        expect(cross).toEqual({ linked: 1, moved: true });
        expect(await digestOf(s.rev)).toBe(base);
      });

      it('NULL, empty text and zero are distinct; a timestamp keeps its era and its infinities; changes to another revision never move it', async () => {
        const s = await submittedPlan();
        const other = await submittedPlan();
        const values = await probe(async (c: any) => {
          const [{ id }] = (await c.query(`INSERT INTO central_needs_field_overrides (plan_revision_id, organization_id, target_entity, field_name,
              final_value, override_reason, source_record_id, created_at)
            VALUES ($1, $2, 'sheet:0:row:1', 'col:1', NULL, 'probe', $3, '2026-09-27 00:00:00+00') RETURNING id`,
          [s.rev, ORG_OWNER, s.rec(1, 1)])).rows;
          const out: string[] = [];
          for (const v of [null, '""', '0', 'null']) {
            await c.query(`UPDATE central_needs_field_overrides SET final_value = $2::jsonb WHERE id = $1`, [id, v]);
            out.push((await c.query(`SELECT ${DIGEST}($1) AS d`, [s.rev])).rows[0].d);
          }
          const times: string[] = [];
          for (const t of ['2026-09-27 00:00:00+00', '2026-09-27 00:00:00+00 BC', 'infinity', '-infinity']) {
            await c.query(`UPDATE central_needs_field_overrides SET created_at = $2::timestamptz WHERE id = $1`, [id, t]);
            times.push((await c.query(`SELECT ${DIGEST}($1) AS d`, [s.rev])).rows[0].d);
          }
          return { out, times };
        });
        expect(new Set(values.out).size).toBe(4);
        expect(new Set(values.times).size).toBe(4);
        expect(values.times[0]).toBe(values.out[3]);
        const base = await digestOf(s.rev);
        const unmoved = await probe(async (c: any) => {
          await c.query(`UPDATE central_needs_need_lines SET mapping_reason = 'other revision changed' WHERE plan_revision_id = $1`, [other.rev]);
          return (await c.query(`SELECT ${DIGEST}($1) AS d`, [s.rev])).rows[0].d;
        });
        expect(unmoved).toBe(base);
      });
    });

    // =======================================================================
    // §15 E — evidence: replay and old attestations
    // =======================================================================
    describe('§15 E evidence replay', () => {
      it('§15.24/§15.25: an approve rolled back leaves no APPROVE attestation and authorizes nothing later — the root is refused by the fence, service_role by privilege; the canonical approve then passes', async () => {
        const s = await submittedPlan();
        const a = await held(U_APPROVE, 'superuser');
        try {
          expect((await a.q(APPROVE, [s.rev])).rows![0].result).toMatchObject({ ok: true, status: 'approved' });
          expect((await a.q(`SELECT count(*)::int AS n FROM ${STORE} WHERE plan_revision_id = $1 AND phase = 'approve'`, [s.rev])).rows)
            .toEqual([{ n: 1 }]);
        } finally { await a.rollback(); }
        expect(await attestCount(s.rev, 'approve')).toBe(0);
        expect(await evidence(s.rev)).toMatchObject({ status: 'submitted', approval_gates: 0, approves: 0 });
        await refused(s.rev, () => admin(DIRECT_APPROVE, [s.rev, U_APPROVE]), APPROVAL_GATE_MISSING);
        await refused(s.rev, () => call(U_APPROVE, DIRECT_APPROVE, [s.rev, U_APPROVE], 'service_role'), denied('central_needs_plan_revisions').message, '42501');
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
      });

      it('§15.24: old attestations are never reusable: an old APPROVE attestation admits no later direct -> APPROVED; reject then resubmit needs a NEW SUBMIT attestation', async () => {
        const s = await submittedPlan();
        expect(await call(U_APPROVE, APPROVE, [s.rev])).toMatchObject({ ok: true, status: 'approved' });
        await admin(`UPDATE public.central_needs_plan_revisions SET status = 'superseded' WHERE id = $1`, [s.rev]);
        await refusedBy(s.rev, ['superuser as the approver', () => probe(async (c: any) => {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [U_APPROVE]);
          await c.query(`UPDATE public.central_needs_plan_revisions SET status = 'approved' WHERE id = $1`, [s.rev]);
        }), 'fence'], APPROVAL_GATE_MISSING);
        await refusedBy(s.rev, ['service_role as the approver', () => call(U_APPROVE,
          `UPDATE public.central_needs_plan_revisions SET status = 'approved' WHERE id = $1`, [s.rev], 'service_role'), 'privilege'], APPROVAL_GATE_MISSING);
        expect(await attestCount(s.rev, 'approve')).toBe(1);
        const r2 = await submittedPlan();
        expect(await call(U_APPROVE, REJECT, [r2.rev, 'send back'])).toMatchObject({ status: 'rejected' });
        await admin(`UPDATE public.central_needs_plan_revisions SET status = 'draft' WHERE id = $1`, [r2.rev]);
        for (const x of attackers(DIRECT_SUBMIT, [r2.rev])) await refusedBy(r2.rev, x, GATE_MISSING);
        expect(await attestCount(r2.rev, 'submit')).toBe(1);
        expect(await call(U_EDIT, SUBMIT, [r2.rev])).toMatchObject({ ok: true, status: 'submitted' });
        expect(await attestCount(r2.rev, 'submit')).toBe(2);
        expect(await call(U_APPROVE, APPROVE, [r2.rev])).toMatchObject({ ok: true, status: 'approved' });
      });
    });
  });
});
