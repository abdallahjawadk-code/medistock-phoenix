/**
 * C5 v1.9 §2 / §21 — ACTIVATION REHEARSAL on a disposable LOOPBACK rig.
 *
 * Drives the real activation runbook (tools/phoenix-demo/c5-activation-runbook.mjs,
 * whose every decision is made by c5-activation-contract.mjs) against a rig built
 * through M216, applies the canonical M217 at the M217 step with applyMigrationSql
 * (exactly as the executor would, DATABASE FIRST), and then verifies and restores.
 * Production is never addressed: the rig URL must be loopback, the history table
 * is a Production-SHAPED fixture seeded inside the disposable database, and the
 * sealed M216 row is the sealed dispatch identity (never the pre-dispatch
 * fixture timestamp). Modified M217 copies exist ONLY in memory for the
 * negative controls below; the real file is never written.
 *
 * Every attack states what was attacked, by which actor, what was expected,
 * what was observed, and whether anything committed:
 *
 *   R0  the CLI end to end on the loopback adapter (preflight, stop before T0)
 *   R1  preflight refusals BEFORE T0 (H12 sha / version / fixture timestamp,
 *       H7 operator capability and org coverage, H1 runner without
 *       pg_read_all_stats) — nothing frozen
 *   R2  grant-option chain => HOLD before any DCL (H8); H3 ledger: later
 *       attempts must disposition earlier ones, every revision delta AND every
 *       H11 census delta measured against their own T0/A0/L0 (D-09); a bare
 *       --reviewed-cascade is refused and the Owner reference is sealed (D-11);
 *       the reviewed CASCADE path restores the chain exactly
 *   R3  ACL comparison is order-insensitive (text differs, set is equal)
 *   R4  straddling old approve blocked across T0: drain WAITs while it lives;
 *       bypassed, the resolution STOPs and Proof A catches it although its
 *       audit created_at < T0; failure-branch restore
 *   R5  idle-in-transaction straddler: drain WAITs, then PASSes once it ends
 *   R6  prepared transaction: invisible to pg_stat_activity, caught by H2
 *       (skipped WITH A RECORDED REASON where max_prepared_transactions = 0; D-04)
 *   R7  hidden-session guard: a runner without pg_read_all_stats reads a
 *       FALSE ZERO from the §2.3 SQL; the guard makes it HOLD, never PASS
 *   R8  failed M217 (a modified copy, rehearsal only) + the executor's
 *       terminal failure => FAILED_CLEAN proven, exact ACL0 restored, HOLD
 *   R9  simulated FAILED_PARTIAL => freeze kept, nothing restored, HOLD
 *   R12 TR-2: a straddling SUBMIT blocked across T0/F0 lands in S1 only;
 *       governed rejection; census PASS with exactly submit + reject
 *   R13 D-10: the same straddler rejected by a reviewer BEFORE S1 is not
 *       admitted — the READY census makes it a STOP BEFORE M217 (restored)
 *   R14 D-01/D-02/D-03: STOP after READY with an in-flight M217 lock, and
 *       STOP after READY without the executor's terminal state, restore
 *       NOTHING (freeze kept); a fresh evidence root never captures the frozen
 *       ACL as ACL0; the ledger carries the true ACL0 forward through two
 *       attempts and a later STOP restores it exactly
 *   R15 D-03/D-07: a lost freeze COMMIT reply and a failed post-COMMIT read
 *       are resolved from catalog truth (re-run resumes); a restore whose
 *       in-transaction result is not ACL0 rolls back and keeps the freeze
 *   R16 D-05/D-09: history and operator re-attested immediately before T0 with
 *       a bounded preflight age; the ledger is bound to one evidence root and
 *       an Owner anchor
 *   R17 TR-1 cells: an ACL0 with a PUBLIC tuple and a plain extra grantee is
 *       frozen completely (a PUBLIC-only role cannot call submit) and restored
 *       exactly
 *   R10 the full sequence (last in its world: it commits M217): governed
 *       resolution, the freeze holds across M217, a STOP after M217 is refused
 *       and routed to post-apply (D-01), a transient post-apply read error is
 *       resumed (D-08), the H13 DRAFT audits run on seeded non-empty data
 *       (TR-5), PASS, exact ACL0 restore, physically bound C5 approvals
 *   R11 (fresh rig) privileged direct edits and forged audits between READY
 *       and M217 => Proof A, Proof B (physical check) and the census => HOLD
 *   TR-1 (two fresh rigs) B2 negative controls with the complete freeze in
 *       place: a DROP FUNCTION approve + CREATE (default privileges bring
 *       service_role back) and a blanket GRANT ON ALL FUNCTIONS — M217's own
 *       VERIFY refuses them before its COMMIT (FAILED_CLEAN, restored), and
 *       applied after its VERIFY the post-apply frozen-ACL check refuses them
 *       (HOLD, nothing restored)
 *   TR-2b (fresh rig) a revision made submitted between H10 and the restore:
 *       the re-read immediately before the restore HOLDs, nothing restored
 *
 * Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrationSql, buildRig, MIGRATIONS_DIR, rigAvailable, shimSql } from '../../../tools/pg-rig/rig.mjs';
import * as C from '../../../tools/phoenix-demo/c5-activation-contract.mjs';
import * as Q from '../../../tools/phoenix-demo/c5-activation-sql.mjs';
import * as R from '../../../tools/phoenix-demo/c5-activation-runbook.mjs';

vi.setConfig({ testTimeout: 300000, hookTimeout: 600000 });

const run = rigAvailable() ? describe : describe.skip;

const RIG_DB = process.env.PHOENIX_RIG_DB || 'phoenix_rig';
const M217 = C.M217_FILENAME;
const M217_PATH = join(MIGRATIONS_DIR, M217);
const REMOTE_HISTORY_VERSION = '20260926120000';

const ORG_OWNER = '00000000-0000-0000-0000-000000217e01';
const ORG_OTHER = '00000000-0000-0000-0000-000000217e02';
const ORG_BENE = '00000000-0000-0000-0000-000000217e03';     // a care institution receiving need lines (TR-5)
const ITEM_A = '00000000-0000-0000-0000-000000217e81';
const U_EDIT = '00000000-0000-0000-0000-000000217e11';      // view/import/edit
const U_OPERATOR = '00000000-0000-0000-0000-000000217e12';  // designated governed-rejection operator (view/approve)
const U_APPROVE = '00000000-0000-0000-0000-000000217e13';   // an ordinary approver of the same organization
const U_NO_APPROVE = '00000000-0000-0000-0000-000000217e14'; // eligible role, no central_needs.approve
const U_OTHER = '00000000-0000-0000-0000-000000217e15';     // every key, the OTHER organization

const H = (c: string) => c.repeat(64);
const NODE_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8', runtime: 'node',
};
const BROWSER_IDENTITY = { ...NODE_IDENTITY, runtime: 'browser_worker' };

const OPEN_DRAFT = 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result';
const OPEN_CORRECTION = 'SELECT public.phoenix_central_needs_open_correction_revision($1,$2,$3,$4) AS result';
const SUBMIT = 'SELECT public.phoenix_central_needs_submit_revision($1) AS result';
const APPROVE = 'SELECT public.phoenix_central_needs_approve_revision($1) AS result';
const REJECT = 'SELECT public.phoenix_central_needs_reject_revision($1,$2) AS result';
const FAMILY_LOCK = 'SELECT (public._phoenix_central_needs_lock_plan_family_v1($1::uuid, $2::int)).id AS plan_id';
const REVISION_ROW_LOCK = 'SELECT id FROM public.central_needs_plan_revisions WHERE id = $1 FOR UPDATE';
const OVERRIDE = 'SELECT public.phoenix_central_needs_record_field_override($1,$2::jsonb,$3) AS result';
const SET_COLUMNS = 'SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result';
const SET_LINE = 'SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[],$8,$9,$10,$11) AS result';

const NOT_DISPATCHED = { conclusion: 'not_dispatched' };
const EXECUTOR_FAILED = { run_id: '36026915933', conclusion: 'failure' };
const EXECUTOR_SUCCEEDED = { run_id: '36026915934', conclusion: 'success' };

const sha256 = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const scratch: string[] = [];

/** Evidence always lives OUTSIDE the repository; kept only when a directory is named. */
const evidenceDir = (label: string) => {
  const keep = process.env.PHOENIX_C5_REHEARSAL_EVIDENCE_DIR;
  if (keep) {
    const d = join(keep, `${RIG_DB}-${label}-${Date.now()}`);
    mkdirSync(d, { recursive: true });
    return d;
  }
  const d = mkdtempSync(join(tmpdir(), `c5-rehearsal-${label}-`));
  scratch.push(d);
  return d;
};

/** Every sealed evidence file an attempt recorded for one step name. */
const evidence = (store: any, attemptId: string, step: string) => readdirSync(store.dir(attemptId))
  .filter((f: string) => f.endsWith(`-${step}.json`)).sort()
  .map((f: string) => JSON.parse(readFileSync(join(store.dir(attemptId), f), 'utf8')));

/** The same context with the release operator's executor terminal state (D-02). */
const withExecutor = (ctx: any, executorRun: unknown) => ({ ...ctx, options: { ...ctx.options, executorRun } });

/**
 * An I/O adapter that routes every admin query through `hook(sql, params, run, client)`:
 * `run()` executes the real query. Used ONLY to simulate transport faults the
 * runbook must survive (a lost COMMIT reply, a failed read) and to interleave a
 * privileged write at an exact point — never to change what the runbook decides.
 */
const tapIo = (base: any, hook: (sql: string, params: unknown[] | undefined, run: () => Promise<any>, c: any) => Promise<any>) => ({
  pool: base.pool,
  asUser: base.asUser,
  asAdmin: (fn: any) => base.asAdmin((c: any) => fn({ query: (sql: string, params?: unknown[]) => hook(String(sql), params, () => c.query(sql, params), c) })),
});

/** A Production-SHAPED history (172 three-digit + 44 timestamp rows through the sealed 216 row). */
function productionShapedHistory(): { version: string; name: string }[] {
  const local = readdirSync(MIGRATIONS_DIR).filter((f) => /^\d{3}_.*\.sql$/.test(f)).sort();
  const real = new Map<number, [string, string]>([
    [173, ['20260810200846', 'phoenix_database_security_surface_hardening']],
    [174, ['20260810220715', '']],
    [196, ['20260823131150', '']],
    [214, ['20260914111813', 'fix_central_needs_review_readiness_volatility']],
    [215, ['20260922153813', '']],
    [216, [C.SEALED_M216.remoteVersion, C.SEALED_M216.remoteName]],
  ]);
  const rows: { version: string; name: string }[] = [];
  for (let i = 1; i <= 172; i++) rows.push({ version: String(i).padStart(3, '0'), name: `legacy_${i}` });
  for (let canonical = 173; canonical <= 216; canonical++) {
    const filename = local.find((f) => f.startsWith(`${String(canonical).padStart(3, '0')}_`))!;
    const stem = filename.replace(/\.sql$/, '');
    const r = real.get(canonical);
    const version = r?.[0] ?? new Date(canonical < 196
      ? Date.UTC(2026, 7, 11) + (canonical - 175) * 43_200_000
      : Date.UTC(2026, 7, 24) + (canonical - 197) * 43_200_000).toISOString().replace(/[-:TZ.]/g, '').slice(0, 14);
    rows.push({ version, name: r?.[1] || stem });
  }
  return rows;
}

/** The canonical M217 bytes (shimmed exactly as the rig applies every migration). */
const canonicalM217 = () => shimSql(M217, readFileSync(M217_PATH, 'utf8'));
/** TR-1: an in-memory modified copy — `inject` placed BEFORE M217's own DO $verify$ block. */
const beforeVerify = (inject: string) => {
  const real = canonicalM217();
  const at = real.indexOf('DO $verify$');
  expect(at).toBeGreaterThan(0);
  return `${real.slice(0, at)}${inject}\n${real.slice(at)}`;
};
/** TR-1: an in-memory modified copy — `inject` placed AFTER M217's VERIFY, immediately before its COMMIT. */
const afterVerify = (inject: string) => {
  const real = canonicalM217();
  const at = real.lastIndexOf('COMMIT;');
  expect(at).toBeGreaterThan(real.indexOf('$verify$;'));
  return `${real.slice(0, at)}${inject}\n${real.slice(at)}`;
};
const DROP_CREATE_APPROVE = `DO $b2$
DECLARE d text := pg_catalog.pg_get_functiondef('${C.APPROVE_SIGNATURE}'::regprocedure);
BEGIN
  EXECUTE 'DROP FUNCTION ${C.APPROVE_SIGNATURE}';
  EXECUTE d;
END
$b2$;`;
const BLANKET_GRANT = 'GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated;';

function rehearsalWorld(label: string) {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 2000;
  let fileSeq = 0;
  const nextYear = () => (year += 1);
  const env = { base: [] as any[], rejectBase: [] as any[] };
  const openHeld = new Set<() => Promise<void>>();

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]), { role, commit: true });
  const service = (sql: string, params: unknown[] = []) => call(null, sql, params, 'service_role');
  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e: any) { return { code: e.code, message: e.message, detail: e.detail ?? null }; }
    return null;
  };

  /**
   * An explicitly held transaction, for deterministic interleavings. D-04: the
   * client is ALWAYS handed back — on commit/rollback, after PREPARE, if BEGIN
   * itself fails, and (through releaseHeld) in afterAll — so a failing test can
   * never leave a checked-out client that makes rig.end() hang.
   */
  const held = async (userId: string | null, role: string | null = 'authenticated') => {
    const client = await rig.pool.connect();
    let open = true;
    const finish = async (verb: string | null) => {
      if (!open) return;
      open = false;
      openHeld.delete(abandon);
      try { if (verb) await client.query(verb); } finally { client.release(); }
    };
    const abandon = () => finish('ROLLBACK').catch(() => undefined);
    openHeld.add(abandon);
    let pid: number;
    try {
      await client.query('BEGIN');
      if (role) {
        await client.query(`SET LOCAL ROLE ${role}`);
        await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
      }
      pid = (await client.query('SELECT pg_backend_pid() AS p')).rows[0].p as number;
    } catch (e) {
      await abandon();
      throw e;
    }
    return {
      pid,
      q: (sql: string, params: unknown[] = []) => client.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK').catch(() => undefined),
      /** After PREPARE TRANSACTION the session holds no transaction; just hand the client back. */
      release: () => finish(null),
    };
  };
  const releaseHeld = async () => { for (const abandon of [...openHeld]) await abandon(); };
  const waitingOnLock = async (pid: number) => {
    for (let i = 0; i < 100; i += 1) {
      const [r] = await admin(`SELECT wait_event_type FROM pg_stat_activity WHERE pid = $1`, [pid]);
      if (r?.wait_event_type === 'Lock') return true;
      await sleep(50);
    }
    return false;
  };

  const aclNow = async () => (await admin(Q.FREEZE_ACL_SQL))[0].acl;
  const aclText = async () => (await admin(Q.FREEZE_ACL_TEXT_SQL))[0].acl_text;
  const statusOf = async (id: string) => (await admin(`SELECT status FROM central_needs_plan_revisions WHERE id = $1`, [id]))[0]?.status ?? null;
  const submittedIds = async () => (await admin(`SELECT id FROM central_needs_plan_revisions WHERE status = 'submitted' ORDER BY id`)).map((r: any) => r.id);
  const lifecycleAuditIds = async (entityId: string) => (await admin(
    `SELECT id::text AS id FROM audit_logs WHERE entity_id = $1 AND action = ANY ($2::text[]) ORDER BY id`, [entityId, [...C.LIFECYCLE_AUDIT_ACTIONS]]))
    .map((r: any) => r.id);
  /** Test fixture hygiene only: every scenario starts with no submitted revision (governed reject). */
  const rejectAllSubmitted = async () => {
    for (const id of await submittedIds()) {
      const [{ organization_id: org }] = await admin(`SELECT organization_id FROM central_needs_plan_revisions WHERE id = $1`, [id]);
      await call(org === ORG_OTHER ? U_OTHER : U_APPROVE, REJECT, [id, 'rehearsal fixture hygiene']);
    }
  };
  /** Test fixture hygiene only: put the submit/approve ACL back to the rig baseline after a HOLD that kept it frozen. */
  const repairAcl = async () => {
    const now = await aclNow();
    if (C.aclSetsEqual(now, env.base)) return;
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      for (const t of C.aclSetDifference(now, env.base)) {
        if (t.grantee !== t.owner) await c.query(`REVOKE ${t.privilege} ON FUNCTION ${t.fn} FROM ${C.quoteRole(t.grantee)} CASCADE`);
      }
      for (const s of C.planRestoreStatements(C.aclSetDifference(env.base, await c.query(Q.FREEZE_ACL_SQL).then((r: any) => r.rows[0].acl)))) {
        await c.query(s);
      }
      await c.query('COMMIT');
    });
    expect(C.aclSetsEqual(await aclNow(), env.base)).toBe(true);
  };

  /** Drives a DRAFT to SUBMITTED through the REAL workflow RPCs. */
  const toSubmitted = async (revisionId: string, editor = U_EDIT) => {
    const records = [{
      targetEntity: 'sheet:0:row:5', fieldName: 'quantity',
      sourceValues: { value: 120, valueType: 'number', isFormula: false, formula: null },
      sourceProvenance: {
        fileFingerprintSha256: H('a'), originalFilename: 'needs.xls', parserVersion: '1.0.0/0.20.3',
        sheetIndex: 0, sheetName: 'Needs', sheetHidden: 'visible',
        coordinate: { row: 4, col: 2, a1: 'C5' }, extractedAt: new Date().toISOString(),
      },
    }];
    const [{ d: digest }] = await admin(`SELECT public._phoenix_central_needs_payload_digest_v1($1::jsonb) AS d`, [JSON.stringify(records)]);
    const started = await call(editor,
      `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
      [revisionId, 'needs.xls', H('a'), digest, JSON.stringify(BROWSER_IDENTITY), 1024, 'permanent/x']);
    await service(`SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result`,
      [started.import_session_id, H('a'), JSON.stringify(records), JSON.stringify(NODE_IDENTITY)]);
    await service(`SELECT public.phoenix_central_needs_register_import_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NULL) AS result`,
      [revisionId, 'file', 'container.xls', H('c'), 'permanent/container',
        JSON.stringify([{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: H('a'), importSessionId: started.import_session_id }]),
        JSON.stringify(NODE_IDENTITY), 2048, 0]);
    await call(editor, `SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result`,
      [started.import_session_id, 'sheet:0:row:5', 'not_applicable', null, 'not an annual need line']);
    const s = await call(editor, SUBMIT, [revisionId]);
    expect(s.status).toBe('submitted');
  };
  const openDraft = async (org = ORG_OWNER, editor = U_EDIT) => {
    const y = nextYear();
    return { y, rev: (await call(editor, OPEN_DRAFT, [org, y, false])).plan_revision_id as string };
  };
  const readyDraft = async () => { const d = await openDraft(); await prepareForSubmit(d.rev); return d; };
  /** Everything submit needs except the submit itself. */
  const prepareForSubmit = async (rev: string) => {
    const records = [{
      targetEntity: 'sheet:0:row:5', fieldName: 'quantity',
      sourceValues: { value: 120, valueType: 'number', isFormula: false, formula: null },
      sourceProvenance: {
        fileFingerprintSha256: H('a'), originalFilename: 'needs.xls', parserVersion: '1.0.0/0.20.3',
        sheetIndex: 0, sheetName: 'Needs', sheetHidden: 'visible', coordinate: { row: 4, col: 2, a1: 'C5' },
        extractedAt: new Date().toISOString(),
      },
    }];
    const [{ d }] = await admin(`SELECT public._phoenix_central_needs_payload_digest_v1($1::jsonb) AS d`, [JSON.stringify(records)]);
    const started = await call(U_EDIT, `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
      [rev, 'needs.xls', H('a'), d, JSON.stringify(BROWSER_IDENTITY), 1024, 'permanent/x']);
    await service(`SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result`,
      [started.import_session_id, H('a'), JSON.stringify(records), JSON.stringify(NODE_IDENTITY)]);
    await service(`SELECT public.phoenix_central_needs_register_import_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NULL) AS result`,
      [rev, 'file', 'container.xls', H('c'), 'permanent/container',
        JSON.stringify([{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: H('a'), importSessionId: started.import_session_id }]),
        JSON.stringify(NODE_IDENTITY), 2048, 0]);
    await call(U_EDIT, `SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result`,
      [started.import_session_id, 'sheet:0:row:5', 'not_applicable', null, 'not an annual need line']);
  };
  const submitted = async (org = ORG_OWNER, editor = U_EDIT) => {
    const d = await openDraft(org, editor);
    await toSubmitted(d.rev, editor);
    return d;
  };
  const approved = async () => { const s = await submitted(); await call(U_APPROVE, APPROVE, [s.rev]); return s; };

  /**
   * TR-5 evidence fixture (the house pattern of the C5 suites: sessions and
   * cells written directly, decisions made through the canonical RPCs): one
   * import session on a DRAFT, one mapped row per cell, each cell in column
   * 2, whose beneficiary is confirmed through the canonical 216 RPC.
   */
  const draftCells = async (rev: string, values: unknown[], opts: { status?: 'completed' | 'processing'; confirm?: boolean } = {}) => {
    fileSeq += 1;
    const fileHash = `${fileSeq}`.padStart(64, 'b');
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,2048) RETURNING id`, [rev, ORG_OWNER, `tr5-${fileSeq}.xlsx`, fileHash]);
    const digest = `${fileSeq}`.padStart(64, 'e');
    const status = opts.status ?? 'completed';
    const [{ id: sessionId }] = await admin(status === 'completed'
      ? `INSERT INTO central_needs_import_sessions
           (plan_revision_id, organization_id, source_file_id, status, preview_digest, authoritative_digest, parser_identity, completed_at)
         VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`
      : `INSERT INTO central_needs_import_sessions
           (plan_revision_id, organization_id, source_file_id, status, preview_digest, parser_identity)
         VALUES ($1,$2,$3,'processing',$4,$5::jsonb) RETURNING id`,
    [rev, ORG_OWNER, fileId, digest, JSON.stringify(NODE_IDENTITY)]);
    const records: string[] = [];
    for (const [i, sv] of values.entries()) {
      const row = i + 1;
      const [{ id }] = await admin(
        `INSERT INTO central_needs_source_records
           (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values, source_provenance)
         VALUES ($1,$2,$3,$4,'col:2',$5::jsonb,$6::jsonb) RETURNING id`,
        [sessionId, ORG_OWNER, row, `sheet:0:row:${row}`, JSON.stringify(sv), JSON.stringify({
          fileFingerprintSha256: fileHash, originalFilename: `tr5-${fileSeq}.xlsx`, parserVersion: '1.0.0',
          sheetIndex: 0, sheetName: 'Sheet0', sheetHidden: 'visible', coordinate: { row, col: 2, a1: `C${row + 1}` },
          extractedAt: '2026-09-26T00:00:00.000Z',
        })]);
      records.push(id);
      await admin(
        `INSERT INTO central_needs_record_mappings (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
         VALUES ($1,$2,$3,$4,'mapped',NULL)`, [sessionId, ORG_OWNER, `sheet:0:row:${row}`, ITEM_A]);
    }
    if (opts.confirm !== false) {
      await call(U_EDIT, SET_COLUMNS, [rev, JSON.stringify([{ importSessionId: sessionId, sheetIndex: 0, columnIndex: 2, beneficiaryOrganizationId: ORG_BENE }]),
        'confirmed beneficiary column']);
    }
    return { sessionId, records };
  };
  const setLine = (rev: string, recordId: string, qty: number, appliedOverrideId: string | null) =>
    call(U_EDIT, SET_LINE, [rev, ORG_BENE, ITEM_A, qty, 'designated by reviewer',
      JSON.stringify([{ sourceRecordId: recordId, designatedQuantity: String(qty), appliedOverrideId }]), [], 'box', 'canonical', null, null]);
  const override = async (recordId: string, finalValue: string, reason: string) =>
    (await call(U_EDIT, OVERRIDE, [recordId, finalValue, reason])).override_id as string;

  const executor = () => ({
    migrationFilename: M217,
    migrationSha256: sha256(readFileSync(M217_PATH)),
    expectedCurrentCeiling: '216',
    expectedNextCeiling: '217',
    remoteHistoryVersion: REMOTE_HISTORY_VERSION,
  });
  const ctxFor = (dir: string, extra: Record<string, unknown> = {}, io: any = null) => ({
    io: io ?? rig,
    store: new R.EvidenceStore(dir),
    options: { target: 'rehearsal', operatorId: U_OPERATOR, executor: executor(), migrationsDir: MIGRATIONS_DIR, ...extra },
  });
  /** preflight -> freeze -> resolve, expecting READY_FOR_M217 with no submitted revision in play. */
  const toReady = async (ctx: any) => {
    expect((await R.runPreflight(ctx)).outcome).toBe('PREFLIGHT_PASS');
    expect((await R.runFreeze(ctx)).outcome).toBe('FROZEN');
    expect((await R.runResolve(ctx)).outcome).toBe(C.READY_FOR_M217);
    return ctx.store.listAttempts().at(-1) as string;
  };

  /** The executor's M217 step, DATABASE FIRST: the (possibly modified, in-memory) file, then its history row. */
  const applyM217 = async (sqlOverride?: string) => {
    const sql = sqlOverride ?? canonicalM217();
    await rig.asAdmin(async (c: any) => {
      try {
        await applyMigrationSql(c, M217, sql);
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
    await admin(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)`,
      [REMOTE_HISTORY_VERSION, C.M217_HISTORY_NAME]);
  };

  const setup = async () => {
    C.assertActivationTarget({ rehearsalUrl: process.env.PHOENIX_RIG_PG });
    rig = await buildRig({ upTo: 216 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_OWNER}','C5-R owner','م','p217r-own','care_institution','hospital'),
        ('${ORG_OTHER}','C5-R other','ن','p217r-oth','care_institution','hospital'),
        ('${ORG_BENE}','C5-R beneficiary','ب','p217r-ben','care_institution','hospital')`);
      await c.query(`INSERT INTO central_items (id, name, name_ar, unit) VALUES ('${ITEM_A}','C5-R item','مادة','box')`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_EDIT}','p217r-edit@rig'),('${U_OPERATOR}','p217r-operator@rig'),('${U_APPROVE}','p217r-approve@rig'),
        ('${U_NO_APPROVE}','p217r-noapprove@rig'),('${U_OTHER}','p217r-other@rig')`);
      for (const [u, org] of [[U_EDIT, ORG_OWNER], [U_OPERATOR, ORG_OWNER], [U_APPROVE, ORG_OWNER], [U_NO_APPROVE, ORG_OWNER], [U_OTHER, ORG_OTHER]]) {
        await c.query(`UPDATE profiles SET role='central_warehouse_manager', status='active', organization_id=$1 WHERE id=$2`, [org, u]);
      }
      const grants: Array<[string, string[]]> = [
        [U_EDIT, ['view', 'import', 'edit']], [U_OPERATOR, ['view', 'approve']], [U_APPROVE, ['view', 'approve']],
        [U_NO_APPROVE, ['view']], [U_OTHER, ['view', 'import', 'edit', 'approve']],
      ];
      for (const [u, keys] of grants) {
        for (const k of keys) {
          await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
                           ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [u, `central_needs.${k}`]);
        }
      }
      // The Production-SHAPED history fixture (disposable database only).
      await c.query('CREATE SCHEMA IF NOT EXISTS supabase_migrations');
      await c.query('CREATE TABLE supabase_migrations.schema_migrations (version text PRIMARY KEY, name text, statements text[])');
      for (const r of productionShapedHistory()) {
        await c.query('INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)', [r.version, r.name]);
      }
    });
    env.base = await aclNow();
    env.rejectBase = (await admin(Q.REJECT_ACL_SQL))[0].acl;
  };
  const teardown = async () => {
    if (!rig) return;
    await releaseHeld();
    await rig.end();
  };

  return {
    get rig() { return rig; }, env, label,
    setup, teardown, call, service, admin, refusal, held, releaseHeld, waitingOnLock, aclNow, aclText, statusOf, submittedIds,
    lifecycleAuditIds, rejectAllSubmitted, repairAcl, toSubmitted, openDraft, readyDraft, prepareForSubmit, submitted, approved,
    draftCells, setLine, override, executor, ctxFor, toReady, applyM217, nextYear,
  };
}

const PREPARED_GID = `${RIG_DB}_c5_rehearsal_p1`;
const LOW_RUNNER = `${RIG_DB}_c5_lowpriv_runner`;
const STATS_RUNNER = `${RIG_DB}_c5_stats_runner`;
const CHAIN_A = `${RIG_DB}_c5_chain_a`;
const CHAIN_B = `${RIG_DB}_c5_chain_b`;
const EXTRA_GRANTEE = `${RIG_DB}_c5_extra_grantee`;
const PUBLIC_ONLY = `${RIG_DB}_c5_public_only`;

run('C5 v1.9 activation rehearsal — rig through 216, M217 applied at the M217 step', () => {
  const w = rehearsalWorld('main');

  beforeAll(async () => {
    await w.setup();
    await w.admin(`DO $r$ BEGIN CREATE ROLE ${LOW_RUNNER} NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`);
    await w.admin(`DO $r$ BEGIN CREATE ROLE ${STATS_RUNNER} NOLOGIN BYPASSRLS; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`);
    await w.admin(`GRANT pg_read_all_stats TO ${STATS_RUNNER}`);
    for (const r of [LOW_RUNNER, STATS_RUNNER]) {
      await w.admin(`GRANT USAGE ON SCHEMA supabase_migrations TO ${r}`);
      await w.admin(`GRANT SELECT ON supabase_migrations.schema_migrations TO ${r}`);
    }
  });

  afterAll(async () => {
    if (w.rig) {
      await w.releaseHeld();
      for (const g of await w.admin(`SELECT gid FROM pg_prepared_xacts WHERE gid LIKE $1`, [`${RIG_DB}_c5_%`])) {
        await w.admin(`ROLLBACK PREPARED '${g.gid}'`);
      }
      for (const r of [LOW_RUNNER, STATS_RUNNER, CHAIN_B, CHAIN_A, EXTRA_GRANTEE, PUBLIC_ONLY]) {
        await w.admin(`DO $r$ BEGIN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; EXCEPTION WHEN undefined_object THEN NULL; END $r$`);
      }
      await w.teardown();
    }
    if (!process.env.PHOENIX_C5_REHEARSAL_EVIDENCE_DIR) for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  it('baseline: the loopback rig carries the Production-shaped history through the SEALED M216 row, and M217 on disk', async () => {
    const rows = await w.admin(Q.HISTORY_SQL);
    expect(rows).toHaveLength(216);
    expect(rows.filter((r: any) => r.version === C.SEALED_M216.remoteVersion)).toEqual([{ version: '20260924124100', name: '216_phoenix_central_needs_region_persistence' }]);
    expect(rows.some((r: any) => r.version === '20260923215400')).toBe(false); // the pre-dispatch fixture is never Production truth
    expect(sha256(readFileSync(join(MIGRATIONS_DIR, C.SEALED_M216.filename)))).toBe(C.SEALED_M216.sha256);
    expect(readFileSync(M217_PATH, 'utf8').length).toBeGreaterThan(0);
    // ACL0 of the rig as built: owner + authenticated + service_role (M109 default ACL), no anon/PUBLIC.
    expect(w.env.base.map((t: any) => `${t.fn}:${t.grantee}`).sort()).toEqual([
      `${C.APPROVE_SIGNATURE}:authenticated`, `${C.APPROVE_SIGNATURE}:postgres`, `${C.APPROVE_SIGNATURE}:service_role`,
      `${C.SUBMIT_SIGNATURE}:authenticated`, `${C.SUBMIT_SIGNATURE}:postgres`, `${C.SUBMIT_SIGNATURE}:service_role`,
    ]);
  });

  it('R0 the CLI end to end (loopback adapter, argument parsing, sealed evidence): preflight PASS, then an operator stop before T0', async () => {
    const url = new URL(process.env.PHOENIX_RIG_PG!);
    url.pathname = `/${RIG_DB}`;
    const dir = evidenceDir('r0');
    const ex = w.executor();
    const env = {
      PHOENIX_C5_ACTIVATION_DATABASE_URL: url.toString(),
      PHOENIX_C5_REJECT_OPERATOR_ID: U_OPERATOR,
      PHOENIX_MIGRATION_FILENAME: ex.migrationFilename,
      PHOENIX_MIGRATION_SHA256: ex.migrationSha256,
      PHOENIX_EXPECTED_CURRENT_CEILING: ex.expectedCurrentCeiling,
      PHOENIX_EXPECTED_NEXT_CEILING: ex.expectedNextCeiling,
      PHOENIX_REMOTE_HISTORY_VERSION: ex.remoteHistoryVersion,
    };
    const exitBefore = process.exitCode;
    try {
      const pre = await R.main(['--phase=preflight', `--evidence-dir=${dir}`], env);
      expect(pre.outcome).toBe('PREFLIGHT_PASS');
      expect(pre.ledger).toMatchObject({ prior_attempts: 0, owner_anchored: false });
      const stop = await R.main(['--phase=stop', `--evidence-dir=${dir}`], env);
      expect(stop.conclusion).toMatchObject({ outcome: C.REFUSED_BEFORE_T0, code: 'OPERATOR_STOP_BEFORE_T0' });
      expect(process.exitCode).toBe(exitBefore);
    } finally {
      process.exitCode = exitBefore;
    }
    const store = new R.EvidenceStore(dir);
    const [id] = store.listAttempts();
    expect(store.verifyManifest(id)).toBe(true);
    expect(store.readState(id).completed).toEqual(C.ACTIVATION_STEPS.slice(0, 4));
    expect(store.readState(id).ledger_anchor.database.database).toBe(RIG_DB);
    // nothing in the sealed evidence carries the connection string
    for (const f of readdirSync(store.dir(id))) expect(readFileSync(join(store.dir(id), f), 'utf8')).not.toMatch(/postgres(ql)?:\/\//);
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R1 preflight refuses BEFORE T0 — sha, version, fixture timestamp, operator, runner — and freezes nothing', async () => {
    const attempt = async (extra: Record<string, unknown>, io: any = null) => {
      const ctx = w.ctxFor(evidenceDir('r1'), extra, io);
      const e = await w.refusal(R.runPreflight(ctx));
      const [id] = ctx.store.listAttempts();
      const state = ctx.store.readState(id);
      expect(state.conclusion.outcome).toBe(C.REFUSED_BEFORE_T0);
      expect(state.t0).toBeUndefined();
      expect(ctx.store.verifyManifest(id)).toBe(true);
      return e;
    };
    // H12 — the executor inputs are validated before T0.
    expect((await attempt({ executor: { ...w.executor(), migrationSha256: H('0') } }))?.code).toBe('EXECUTOR_SHA256_MISMATCH');
    const stale = await attempt({ executor: { ...w.executor(), remoteHistoryVersion: C.SEALED_M216.remoteVersion } });
    expect(stale).toMatchObject({ code: 'REMOTE_HISTORY_VERSION_UNUSABLE' });
    expect((await attempt({ executor: { ...w.executor(), expectedNextCeiling: '218' } }))?.code).toBe('EXECUTOR_CEILING_MISMATCH');
    // H12 — a Production history carrying the pre-dispatch FIXTURE timestamp for 216 is not the sealed identity.
    await w.admin(`UPDATE supabase_migrations.schema_migrations SET version = '20260923215400' WHERE version = $1`, [C.SEALED_M216.remoteVersion]);
    try {
      expect((await attempt({}))?.code).toBe('M216_ROW_VERSION_MISMATCH');
    } finally {
      await w.admin(`UPDATE supabase_migrations.schema_migrations SET version = $1 WHERE version = '20260923215400'`, [C.SEALED_M216.remoteVersion]);
    }
    // H7 — an operator without central_needs.approve, and one not covering a submitted revision's owner organization.
    expect((await attempt({ operatorId: U_NO_APPROVE }))?.code).toBe('OPERATOR_LACKS_REJECT_CAPABILITY');
    const other = await w.submitted(ORG_OTHER, U_OTHER);
    expect((await attempt({}))?.code).toBe('OPERATOR_ORG_MISMATCH');
    await w.call(U_OTHER, REJECT, [other.rev, 'rehearsal hygiene']);
    // H1 — a BYPASSRLS runner WITHOUT pg_read_all_stats is refused before T0.
    const lowIo = { asUser: w.rig.asUser, asAdmin: (fn: any) => w.rig.asAdmin(async (c: any) => {
      await c.query(`SET ROLE ${LOW_RUNNER}`);
      try { return await fn(c); } finally { await c.query('RESET ROLE'); }
    }) };
    expect((await attempt({}, lowIo))?.code).toBe('RUNNER_CANNOT_SEE_ALL_SESSIONS');
    // Nothing was frozen by any refusal.
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R2 grant-option chain => HOLD before any DCL; later attempts must disposition it — revision AND census deltas (H3, D-09); the reviewed CASCADE path needs an Owner reference (D-11) and restores the chain exactly', async () => {
    await w.rejectAllSubmitted();
    await w.admin(`DO $r$ BEGIN CREATE ROLE ${CHAIN_A} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`);
    await w.admin(`DO $r$ BEGIN CREATE ROLE ${CHAIN_B} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`);
    await w.admin(`GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO ${CHAIN_A} WITH GRANT OPTION`);
    await w.rig.asAdmin(async (c: any) => {
      await c.query(`SET ROLE ${CHAIN_A}`);
      try { await c.query(`GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO ${CHAIN_B}`); } finally { await c.query('RESET ROLE'); }
    });
    const chained = await w.aclNow();
    expect(chained.some((t: any) => t.grantee === CHAIN_B && t.grantor === CHAIN_A)).toBe(true);
    const dir = evidenceDir('r2');

    // D-11: a bare --reviewed-cascade is refused before any attempt exists.
    expect((await w.refusal(R.runPreflight(w.ctxFor(dir, { reviewedCascade: true }))))?.code).toBe('CASCADE_OWNER_REFERENCE_REQUIRED');
    expect(new R.EvidenceStore(dir).listAttempts()).toEqual([]);

    // attempt 1: HOLD at the ACL0 assessment — no DCL ran.
    const a1 = w.ctxFor(dir);
    await R.runPreflight(a1);
    const h1 = await R.runFreeze(a1);
    expect(h1).toMatchObject({ outcome: C.C5_ACTIVATION_HOLD, conclusion: { stage: 'ACL0_ASSESSMENT', code: 'ACL_NON_OWNER_GRANTOR', freeze_in_place: false, freeze_state: 'NOT_IN_PLACE' } });
    expect(C.aclSetsEqual(await w.aclNow(), chained)).toBe(true);
    const id1 = a1.store.listAttempts()[0];

    // An ordinary approval lands after attempt 1's T0 — a revision delta AND two census deltas against ITS A0/L0.
    const z = await w.approved();
    const zAudits = await w.lifecycleAuditIds(z.rev);
    expect(zAudits).toHaveLength(2); // its submit audit and its approve audit

    // attempt 2: no disposition at all.
    expect((await w.refusal(R.runPreflight(w.ctxFor(dir))))?.code).toBe('PRIOR_ATTEMPT_UNDISPOSITIONED');
    // attempt 3: a disposition that does not acknowledge the measured revision delta.
    const partial = [{ attempt_id: id1, decision: 'retry after grant review', owner_reference: 'rehearsal-owner-decision-1', acknowledged_delta_ids: [] as string[] }];
    expect((await w.refusal(R.runPreflight(w.ctxFor(dir, { dispositions: partial }))))?.code).toBe('PRIOR_ATTEMPT_DELTA_UNDISPOSITIONED');
    // attempt 4: the revision delta acknowledged, the census deltas not (D-09).
    const noAudit = [{ ...partial[0], acknowledged_delta_ids: [z.rev] }];
    expect((await w.refusal(R.runPreflight(w.ctxFor(dir, { dispositions: noAudit }))))?.code).toBe('PRIOR_ATTEMPT_AUDIT_DELTA_UNDISPOSITIONED');
    // attempt 5: disposition acknowledging exactly both, Owner-reviewed CASCADE path WITH its reference.
    const full = [{ ...noAudit[0], acknowledged_audit_ids: zAudits }];
    const a5 = w.ctxFor(dir, { dispositions: full, reviewedCascade: 'rehearsal-owner-cascade-review-1' });
    expect((await R.runPreflight(a5)).outcome).toBe('PREFLIGHT_PASS');
    const f5 = await R.runFreeze(a5);
    expect(f5.outcome).toBe('FROZEN');
    const id5 = a5.store.listAttempts()[4];
    const [prior] = evidence(a5.store, id5, 'prior-attempts');
    expect(prior.measurements).toEqual([expect.objectContaining({ attempt_id: id1, delta_ids: [z.rev], audit_delta_ids: [...zAudits].sort() })]);
    const [assessment] = evidence(a5.store, id5, 'acl0-assessment');
    expect(assessment.reviewed_cascade).toEqual({ owner_reference: 'rehearsal-owner-cascade-review-1' });
    expect(assessment.assessment.acl).toMatchObject({ cascade: true });
    const [freeze] = evidence(a5.store, id5, 'acl-freeze');
    expect(freeze.statements).toContain(`REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM "${CHAIN_A}" CASCADE`);
    expect(freeze.verdict.pass).toBe(true);
    expect(freeze.frozen_acl.every((t: any) => t.grantee === t.owner)).toBe(true);
    const stop = await R.runStop(a5);
    expect(stop.conclusion).toMatchObject({ outcome: C.C5_ACTIVATION_HOLD, stage: 'STOP_BEFORE_M217', restored: true, freeze_in_place: false });
    const [restore] = evidence(a5.store, id5, 'stop-acl-restore');
    expect(restore.restore.statements).toEqual(expect.arrayContaining([`SET LOCAL ROLE "${CHAIN_A}"`, `GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO "${CHAIN_B}"`]));
    expect(restore.restore).toMatchObject({ ok: true, verified_in_transaction: true, set_equal: true });
    expect(C.aclSetsEqual(await w.aclNow(), chained)).toBe(true); // grantor included
    const ledger = a5.store.listAttempts().map((id: string) => a5.store.readState(id));
    expect(ledger.map((s: any) => s.conclusion.outcome)).toEqual([C.C5_ACTIVATION_HOLD, C.REFUSED_BEFORE_T0, C.REFUSED_BEFORE_T0, C.REFUSED_BEFORE_T0, C.C5_ACTIVATION_HOLD]);
    expect(ledger[4].prior_attempts.map((p: any) => p.attempt_id)).toEqual(ledger.slice(0, 4).map((s: any) => s.attempt_id));
    expect(new Set(ledger.map((s: any) => JSON.stringify(s.ledger_anchor))).size).toBe(1); // one database, one evidence root

    await w.admin(`REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM ${CHAIN_A} CASCADE`);
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R3 ACL comparison is order-insensitive: a REVOKE + GRANT replay reorders proacl text, the semantic set is unchanged', async () => {
    const before = await w.aclText();
    await w.admin(`REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM authenticated`);
    await w.admin(`GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO authenticated`);
    const after = await w.aclText();
    expect(after[C.SUBMIT_SIGNATURE]).not.toBe(before[C.SUBMIT_SIGNATURE]);
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R4 straddling old approve blocked across T0: drain WAITs while it lives; bypassed, STOP + Proof A catch it although its audit is older than T0', async () => {
    await w.rejectAllSubmitted();
    const a = await w.submitted();
    const B = await w.held(null, null);
    const A = await w.held(U_APPROVE);
    try {
      await B.q(FAMILY_LOCK, [ORG_OWNER, a.y]);
      const pA = A.q(APPROVE, [a.rev]);
      expect(await w.waitingOnLock(A.pid)).toBe(true);

      const ctx = w.ctxFor(evidenceDir('r4'));
      await R.runPreflight(ctx);
      const frozen = await R.runFreeze(ctx);
      expect(frozen.s0).toBe(1);
      const wait = await R.runResolve(ctx);
      expect(wait).toMatchObject({ outcome: C.DRAIN_WAIT, codes: ['DRAIN_PRE_F0_TRANSACTIONS'] });
      expect(wait.drain.pre_f0_rows.map((r: any) => r.pid)).toContain(A.pid);

      // bypass: the old approve completes after F0 (it passed its EXECUTE check before the freeze)
      await B.commit();
      const res = await pA;
      await A.commit();
      expect(res).toMatchObject({ ok: true, status: 'approved' });
      const stop = await R.runResolve(ctx);
      expect(stop.conclusion).toMatchObject({ stage: 'STOP_BEFORE_M217', restored: true, freeze_in_place: false });
      expect(stop.conclusion.reason.code).toBe('RESOLUTION_STATUS_UNEXPECTED');
      const id = ctx.store.listAttempts()[0];
      const [proofs] = evidence(ctx.store, id, 'stop-proofs');
      const delta = proofs.proof_a.deltas.find((d: any) => d.id === a.rev);
      expect(delta).toMatchObject({ kind: 'approval', from: null, to: 'approved' });
      expect(delta.evidence.approve_audits).toHaveLength(1);
      expect(delta.evidence.approve_audits[0].before_t0).toBe(true); // audit.created_at < T0, still caught
      expect(proofs.proof_b.approvals).toEqual([]);                  // a created_at-keyed proof alone would have missed it
      const [check] = evidence(ctx.store, id, 'stop-m217-check');
      expect(check.outcome).toMatchObject({ outcome: 'FAILED_CLEAN', non_commit_proven: true }); // before READY: DB-only proof
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
    } finally {
      await A.rollback();
      await B.rollback();
    }
  });

  it('R5 idle-in-transaction straddler: the drain WAITs while it is open and PASSes once it ends; READY, then operator STOP (executor never dispatched) restores', async () => {
    await w.rejectAllSubmitted();
    const c = await w.submitted();
    const Ct = await w.held(U_APPROVE);
    try {
      expect(await Ct.q(APPROVE, [c.rev])).toMatchObject({ ok: true }); // done, uncommitted, idle in transaction
      const ctx = w.ctxFor(evidenceDir('r5'));
      await R.runPreflight(ctx);
      await R.runFreeze(ctx);
      const wait = await R.runResolve(ctx);
      expect(wait.outcome).toBe(C.DRAIN_WAIT);
      expect(wait.drain.pre_f0_rows.find((r: any) => r.pid === Ct.pid)?.state).toBe('idle in transaction');
      await Ct.rollback();
      const ready = await R.runResolve(ctx);
      expect(ready).toMatchObject({ outcome: C.READY_FOR_M217, union: [c.rev] });
      expect(await w.statusOf(c.rev)).toBe('rejected');
      const stop = await R.runStop(withExecutor(ctx, NOT_DISPATCHED));
      expect(stop.conclusion).toMatchObject({ restored: true, freeze_in_place: false });
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
    } finally {
      await Ct.rollback();
    }
  });

  it('R6 a PREPARED old approve has no backend: the §2.3 SQL is blind to it, the H2 prepared-transaction guard is not (D-04: skipped with a recorded reason where prepared transactions are disabled)', async (tc) => {
    const [{ n }] = await w.admin(`SELECT current_setting('max_prepared_transactions')::int AS n`);
    if (n === 0) {
      const reason = 'R6 SKIPPED: max_prepared_transactions = 0 on this server, so PREPARE TRANSACTION is disabled and the H2 prepared-transaction '
        + 'drain guard cannot be exercised dynamically here (its decision is unit-tested in c5-activation-contract.test.ts).';
      console.warn(reason);
      tc.skip(reason);
    }
    await w.rejectAllSubmitted();
    const p = await w.submitted();
    const Pt = await w.held(U_APPROVE);
    let prepared = false;
    try {
      expect(await Pt.q(APPROVE, [p.rev])).toMatchObject({ ok: true });
      await Pt.q(`PREPARE TRANSACTION '${PREPARED_GID}'`);
      prepared = true;
    } finally {
      if (prepared) await Pt.release(); else await Pt.rollback();
    }
    try {
      const ctx = w.ctxFor(evidenceDir('r6'));
      await R.runPreflight(ctx);
      await R.runFreeze(ctx);
      const wait = await R.runResolve(ctx);
      expect(wait).toMatchObject({ outcome: C.DRAIN_WAIT, codes: ['DRAIN_PREPARED_TRANSACTIONS'] });
      expect(wait.drain.pre_f0).toBe(0);
      expect(wait.drain.prepared_rows.map((r: any) => r.gid)).toEqual([PREPARED_GID]);
      await w.admin(`ROLLBACK PREPARED '${PREPARED_GID}'`); // a recorded operator decision in the rehearsal
      expect((await R.runResolve(ctx)).outcome).toBe(C.READY_FOR_M217);
      expect(await w.statusOf(p.rev)).toBe('rejected');
      expect((await R.runStop(withExecutor(ctx, NOT_DISPATCHED))).conclusion.restored).toBe(true);
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
    } finally {
      for (const g of await w.admin(`SELECT gid FROM pg_prepared_xacts WHERE gid = $1`, [PREPARED_GID])) await w.admin(`ROLLBACK PREPARED '${g.gid}'`);
    }
  });

  it('R7 hidden-session guard: a runner without pg_read_all_stats reads a FALSE ZERO from the §2.3 SQL, and the drain HOLDs instead of PASSing', async () => {
    const S = await w.held(U_EDIT);
    try {
      await S.q('SELECT 1');
      const f0 = (await w.admin(Q.CLOCK_SQL))[0].now;
      const asRole = (role: string) => ({ asUser: w.rig.asUser, asAdmin: (fn: any) => w.rig.asAdmin(async (c: any) => {
        await c.query(`SET ROLE ${role}`);
        try { return await fn(c); } finally { await c.query('RESET ROLE'); }
      }) });
      const blind = await R.readDrain(asRole(LOW_RUNNER), f0);
      expect(blind.pre_f0_rows).toEqual([]);            // the exact contract SQL alone: a false zero
      expect(blind.hidden).toBeGreaterThan(0);
      expect(blind).toMatchObject({ pass: false, decision: 'HOLD' });
      expect(blind.codes).toContain('DRAIN_HIDDEN_SESSIONS');
      const stats = await R.readDrain(asRole(STATS_RUNNER), f0);
      expect(stats.hidden).toBe(0);
      expect(stats.pre_f0_rows.map((r: any) => r.pid)).toContain(S.pid);
      expect(stats.decision).toBe('WAIT');
      const superuser = await R.readDrain(w.rig, f0);
      expect(superuser.pre_f0_rows.map((r: any) => r.pid)).toContain(S.pid);
    } finally {
      await S.rollback();
    }
  });

  it('R8 failed M217 (a modified copy, rehearsal only) + the executor\'s terminal failure: non-commit PROVEN, exact ACL0 restored, HOLD', async () => {
    await w.rejectAllSubmitted();
    const s = await w.submitted();
    const ctx = w.ctxFor(evidenceDir('r8'));
    await R.runPreflight(ctx);
    await R.runFreeze(ctx);
    expect((await R.runResolve(ctx)).outcome).toBe(C.READY_FOR_M217);
    expect(await w.statusOf(s.rev)).toBe('rejected');
    const real = canonicalM217();
    const at = real.lastIndexOf('COMMIT;');
    const broken = `${real.slice(0, at)}DO $inject$ BEGIN RAISE EXCEPTION 'rehearsal_injected_m217_failure'; END $inject$;\n${real.slice(at)}`;
    const err = await w.refusal(w.applyM217(broken));
    expect(err?.message).toContain('rehearsal_injected_m217_failure');
    const id = ctx.store.listAttempts()[0];
    expect(C.aclSetsEqual(await w.aclNow(), ctx.store.readState(id).frozen_acl)).toBe(true); // still frozen after the rollback
    const out = await R.runPostApply(withExecutor(ctx, EXECUTOR_FAILED));
    expect(out.conclusion).toMatchObject({ stage: 'M217_FAILED_CLEAN', m217: 'FAILED_CLEAN', restored: true, freeze_in_place: false });
    const [m] = evidence(ctx.store, id, 'm217-outcome');
    expect(m.m217_state).toMatchObject({ classifier: false, lineage_helper: false, fence_function: false, fence_trigger: false, value_contract: false });
    expect(Object.values(m.m217_state.bodies).every((v) => v === false)).toBe(true);
    expect(m.m217_state.fingerprints).toEqual(ctx.store.readState(id).fingerprints0); // every replaced body is the T0 body
    expect(m.in_flight).toMatchObject({ locks: [], sessions: [], hidden: [] });
    expect(m.executor).toEqual(EXECUTOR_FAILED);
    expect(m.remote_rows.some((r: any) => r.name === C.M217_HISTORY_NAME)).toBe(false);
    const [restore] = evidence(ctx.store, id, 'failure-acl-restore');
    expect(restore.restore).toMatchObject({ ok: true, verified_in_transaction: true, set_equal: true, restored: true });
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R9 simulated FAILED_PARTIAL: one M217 object without the rest => freeze kept, nothing restored, HOLD', async () => {
    const ctx = w.ctxFor(evidenceDir('r9'));
    await R.runPreflight(ctx);
    await R.runFreeze(ctx);
    expect((await R.runResolve(ctx)).outcome).toBe(C.READY_FOR_M217);
    await w.admin(`CREATE FUNCTION public._phoenix_central_needs_approval_gate_fence_v1() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN RETURN NEW; END $f$`);
    try {
      const out = await R.runPostApply(withExecutor(ctx, EXECUTOR_FAILED));
      expect(out.conclusion).toMatchObject({ stage: 'M217_FAILED_PARTIAL', m217: 'FAILED_PARTIAL', restored: false, freeze_in_place: true });
      const id = ctx.store.listAttempts()[0];
      expect(C.aclSetsEqual(await w.aclNow(), ctx.store.readState(id).frozen_acl)).toBe(true); // nothing restored
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(false);
    } finally {
      await w.admin(`DROP FUNCTION public._phoenix_central_needs_approval_gate_fence_v1()`);
      await w.repairAcl(); // test fixture hygiene only
    }
  });

  it('R12 TR-2: a straddling SUBMIT blocked across T0 commits after F0 — S1 ≠ S0, governed rejection, and the census PASSes with exactly its submit + reject', async () => {
    await w.rejectAllSubmitted();
    const d = await w.readyDraft();
    const B = await w.held(null, null);
    const A = await w.held(U_EDIT);
    try {
      await B.q(REVISION_ROW_LOCK, [d.rev]);
      const pA = A.q(SUBMIT, [d.rev]); // passes its EXECUTE check now, then blocks on the revision row
      expect(await w.waitingOnLock(A.pid)).toBe(true);

      const ctx = w.ctxFor(evidenceDir('r12'));
      await R.runPreflight(ctx);
      const frozen = await R.runFreeze(ctx);
      expect(frozen.s0).toBe(0);
      const wait = await R.runResolve(ctx);
      expect(wait).toMatchObject({ outcome: C.DRAIN_WAIT, codes: ['DRAIN_PRE_F0_TRANSACTIONS'] });
      expect(wait.drain.pre_f0_rows.map((r: any) => r.pid)).toEqual(expect.arrayContaining([A.pid, B.pid]));

      // the submit commits AFTER the freeze (it passed EXECUTE before it)
      await B.commit();
      expect(await pA).toMatchObject({ ok: true, status: 'submitted' });
      await A.commit();
      const ready = await R.runResolve(ctx);
      expect(ready).toMatchObject({ outcome: C.READY_FOR_M217, union: [d.rev] });
      const id = ctx.store.listAttempts()[0];
      const state = ctx.store.readState(id);
      expect(state.s0).toEqual([]);
      expect(state.s1).toEqual([d.rev]);
      const [resolution] = evidence(ctx.store, id, 'resolution');
      expect(resolution.plan).toEqual([{ id: d.rev, action: 'reject' }]);
      expect(resolution.verdict.pass).toBe(true);
      expect(await w.statusOf(d.rev)).toBe('rejected');
      const [readyEvidence] = evidence(ctx.store, id, 'ready-for-m217');
      expect(readyEvidence.census).toMatchObject({ pass: true, added: 2, unexpected_added: [], straddler_pattern: [] });

      const stop = await R.runStop(withExecutor(ctx, NOT_DISPATCHED));
      expect(stop.conclusion).toMatchObject({ stage: 'STOP_BEFORE_M217', restored: true, freeze_in_place: false, census_pass: true });
      const [proofs] = evidence(ctx.store, id, 'stop-proofs');
      expect(proofs.census).toMatchObject({ pass: true, added: 2, unexpected_added: [], removed: [], changed: [] });
      const added = await w.admin(`SELECT action FROM audit_logs WHERE entity_id = $1 AND action = ANY ($2::text[]) ORDER BY action`,
        [d.rev, [...C.LIFECYCLE_AUDIT_ACTIONS]]);
      expect(added.map((r: any) => r.action)).toEqual([C.ACTION_REJECT, C.ACTION_SUBMIT]); // exactly the straddling submit + the governed reject
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
    } finally {
      await A.rollback();
      await B.rollback();
    }
  });

  it('R13 D-10: the same straddler REJECTED BY A REVIEWER before S1 is not admitted to the census — READY STOPs before M217 (restored), naming the pattern', async () => {
    await w.rejectAllSubmitted();
    const d = await w.readyDraft();
    const B = await w.held(null, null);
    const A = await w.held(U_EDIT);
    try {
      await B.q(REVISION_ROW_LOCK, [d.rev]);
      const pA = A.q(SUBMIT, [d.rev]);
      expect(await w.waitingOnLock(A.pid)).toBe(true);
      const ctx = w.ctxFor(evidenceDir('r13'));
      await R.runPreflight(ctx);
      await R.runFreeze(ctx);
      expect((await R.runResolve(ctx)).outcome).toBe(C.DRAIN_WAIT);
      await B.commit();
      await pA;
      await A.commit();
      // a reviewer on a stale screen rejects it (reject is never frozen) BEFORE the operator re-runs resolve
      await w.call(U_APPROVE, REJECT, [d.rev, 'reviewer rejects before S1']);
      const out = await R.runResolve(ctx);
      expect(out.conclusion).toMatchObject({ outcome: C.C5_ACTIVATION_HOLD, stage: 'STOP_BEFORE_M217', restored: true, freeze_in_place: false });
      expect(out.conclusion.reason).toMatchObject({ code: 'PRE_M217_PRECONDITION_FAILED', failures: ['READY_LIFECYCLE_AUDIT_DELTA'] });
      const id = ctx.store.listAttempts()[0];
      expect(ctx.store.readState(id).s1).toEqual([]);
      const [readyEvidence] = evidence(ctx.store, id, 'ready-for-m217');
      expect(readyEvidence.census.pass).toBe(false);
      expect(readyEvidence.census.straddler_pattern).toEqual([d.rev]);
      expect(readyEvidence.census.unexpected_added.map((r: any) => r.action).sort()).toEqual([C.ACTION_REJECT, C.ACTION_SUBMIT].sort());
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
    } finally {
      await A.rollback();
      await B.rollback();
    }
  });

  it('R14 D-01/D-02/D-03: a STOP after READY restores NOTHING unless non-commit is proven; a frozen ACL is never captured as ACL0; the ledger carries the true ACL0 forward and a later STOP restores it', async () => {
    await w.rejectAllSubmitted();
    const dir = evidenceDir('r14');
    const disp = (attemptId: string, o: Record<string, unknown> = {}) =>
      ({ attempt_id: attemptId, decision: 'retry', owner_reference: `rehearsal-owner-${attemptId.slice(0, 11)}`, acknowledged_delta_ids: [], acknowledged_audit_ids: [], ...o });

    // attempt 1: READY; an in-flight M217 (a backend holding the §1 EXCLUSIVE lock) — even with a terminal executor
    // failure reported, the STOP cannot prove non-commit: HOLD, NOTHING restored, freeze kept.
    const a1 = w.ctxFor(dir);
    const id1 = await w.toReady(a1);
    const frozenAcl = a1.store.readState(id1).frozen_acl;
    const L = await w.held(null, null);
    let stop1;
    try {
      await L.q('LOCK TABLE public.central_needs_plan_revisions IN EXCLUSIVE MODE');
      stop1 = await R.runStop(withExecutor(a1, EXECUTOR_FAILED));
    } finally {
      await L.rollback();
    }
    expect(stop1!.conclusion).toMatchObject({ stage: 'STOP_M217_NON_COMMIT_UNPROVEN', m217: 'UNKNOWN', restored: false, freeze_in_place: true });
    expect(stop1!.conclusion.unproven.join(' ')).toMatch(/lock\(s\) on the §1 relations/);
    expect(evidence(a1.store, id1, 'stop-acl-restore')).toEqual([]);
    expect(C.aclSetsEqual(await w.aclNow(), frozenAcl)).toBe(true);

    // a fresh evidence root (no ledger) captures the FROZEN ACL: refused as ACL0, no DCL.
    const fresh = w.ctxFor(evidenceDir('r14-fresh-root'));
    await R.runPreflight(fresh);
    const refusedFresh = await R.runFreeze(fresh);
    expect(refusedFresh.conclusion).toMatchObject({ stage: 'ACL0_ASSESSMENT', code: 'ACL0_LACKS_CLIENT_EXECUTE', freeze_in_place: 'UNKNOWN' });
    expect(C.aclSetsEqual(await w.aclNow(), frozenAcl)).toBe(true);

    // the ledger: no disposition, then one without carry-forward, are refused.
    expect((await w.refusal(R.runPreflight(w.ctxFor(dir))))?.code).toBe('PRIOR_ATTEMPT_UNDISPOSITIONED');
    expect((await w.refusal(R.runPreflight(w.ctxFor(dir, { dispositions: [disp(id1)] }))))?.code).toBe('PRIOR_ATTEMPT_FREEZE_UNRESOLVED');
    // attempt 4 carries attempt 1's ACL0 forward; READY; a STOP WITHOUT the executor's terminal state restores nothing.
    const a4 = w.ctxFor(dir, { dispositions: [disp(id1, { carry_forward_acl0: true })] });
    const id4 = await w.toReady(a4);
    const s4 = a4.store.readState(id4);
    expect(s4.inherited).toMatchObject({ from: id1 });
    expect(C.aclSetsEqual(s4.restoration_target_acl0, w.env.base)).toBe(true);
    expect(C.aclSetsEqual(s4.acl0, frozenAcl)).toBe(true); // what it CAPTURED is the frozen set, never its ACL0
    const stop4 = await R.runStop(a4);
    expect(stop4.conclusion).toMatchObject({ stage: 'STOP_M217_NON_COMMIT_UNPROVEN', restored: false, freeze_in_place: true });
    expect(stop4.conclusion.unproven).toContain('the executor terminal state was not supplied (run id + conclusion)');
    expect(C.aclSetsEqual(await w.aclNow(), frozenAcl)).toBe(true);

    // attempt 5 carries attempt 4's (i.e. attempt 1's) ACL0 forward; a STOP before READY restores it EXACTLY.
    const a5 = w.ctxFor(dir, { dispositions: [disp(id1), disp(id4, { carry_forward_acl0: true })] });
    expect((await R.runPreflight(a5)).outcome).toBe('PREFLIGHT_PASS');
    expect((await R.runFreeze(a5)).outcome).toBe('FROZEN');
    const id5 = a5.store.listAttempts().at(-1)!;
    expect(a5.store.readState(id5).inherited).toMatchObject({ from: id4 });
    const stop5 = await R.runStop(a5);
    expect(stop5.conclusion).toMatchObject({ stage: 'STOP_BEFORE_M217', restored: true, freeze_in_place: false });
    const [restore] = evidence(a5.store, id5, 'stop-acl-restore');
    expect(restore.restore.statements.length).toBeGreaterThan(0); // real GRANTs back to authenticated / service_role
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R15 D-03/D-07: freeze state from catalog truth after a lost COMMIT reply and a failed post-COMMIT read (re-run resumes); a restore whose in-transaction result is not ACL0 rolls back and keeps the freeze', async () => {
    await w.rejectAllSubmitted();
    const dir = evidenceDir('r15');

    // (a) the freeze COMMIT takes effect but its reply is "lost": catalog truth says IN_PLACE, the attempt continues.
    let lose = true;
    const lostCommit = tapIo(w.rig, async (sql, _p, run) => {
      if (sql === 'COMMIT' && lose) {
        lose = false;
        await run();
        throw Object.assign(new Error('simulated: connection lost after COMMIT'), { code: '08006' });
      }
      return run();
    });
    const a1 = w.ctxFor(dir, {}, lostCommit);
    await R.runPreflight(a1);
    expect((await R.runFreeze(a1)).outcome).toBe('FROZEN');
    const id1 = a1.store.listAttempts()[0];
    const [outcome1] = evidence(a1.store, id1, 'acl-freeze-outcome');
    expect(outcome1).toMatchObject({ committed: 'unknown', transaction: { code: 'ACL_FREEZE_COMMIT_UNKNOWN' }, freeze_truth: { state: 'IN_PLACE' } });
    const s1 = a1.store.readState(id1);
    expect(s1).toMatchObject({ freeze_committed: true, f0_source: 'fresh_read_after_commit' });
    expect(C.aclSetsEqual(s1.frozen_acl, s1.freeze_planned)).toBe(true);

    // (b) D-07: the restore's in-transaction result carries an extra grant — it is rolled back, the freeze stays.
    let spoil = true;
    const spoiledRestore = tapIo(w.rig, async (sql, _p, run, c) => {
      const out = await run();
      if (spoil && sql === `GRANT EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} TO "authenticated"`) {
        spoil = false;
        await c.query(`GRANT EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} TO anon`);
      }
      return out;
    });
    const stop1 = await R.runStop({ ...a1, io: spoiledRestore });
    expect(spoil).toBe(false);
    expect(stop1.conclusion).toMatchObject({ stage: 'STOP_BEFORE_M217', restored: false, freeze_in_place: true });
    const [restore1] = evidence(a1.store, id1, 'stop-acl-restore');
    expect(restore1.restore).toMatchObject({ ok: false, code: 'ACL_RESTORE_MISMATCH', restored: false, freeze_state_after: 'IN_PLACE' });
    expect(restore1.restore.unexpected.map((t: any) => `${t.fn}:${t.grantee}`)).toEqual([`${C.APPROVE_SIGNATURE}:anon`]);
    expect(C.aclSetsEqual(await w.aclNow(), s1.frozen_acl)).toBe(true); // nothing half-restored was committed

    // (c) attempt 2 carries attempt 1's ACL0 forward; a post-COMMIT read fails once; a re-run of freeze resumes.
    let fail = true;
    const flakyRead = tapIo(w.rig, async (sql, _p, run) => {
      if (fail && sql === Q.FREEZE_PRIVILEGES_SQL) {
        fail = false;
        throw Object.assign(new Error('simulated: transient read failure after the freeze COMMIT'), { code: '08006' });
      }
      return run();
    });
    const disp = [{ attempt_id: id1, decision: 'retry', owner_reference: 'rehearsal-owner-r15', acknowledged_delta_ids: [], acknowledged_audit_ids: [], carry_forward_acl0: true }];
    const a2 = w.ctxFor(dir, { dispositions: disp }, flakyRead);
    await R.runPreflight(a2);
    const e = await w.refusal(R.runFreeze(a2));
    expect(e?.message).toMatch(/transient read failure/);
    const id2 = a2.store.listAttempts()[1];
    const s2 = a2.store.readState(id2);
    expect(s2.freeze_committed).toBe(true);           // the commit was durable BEFORE the failing read
    expect(s2.completed.at(-1)).toBe('T0_SNAPSHOT_SEALED');
    expect((await R.runFreeze({ ...a2, io: w.rig })).outcome).toBe('FROZEN');
    expect(evidence(a2.store, id2, 'acl-freeze-resume')[0].freeze_truth.state).toBe('IN_PLACE');
    const stop2 = await R.runStop({ ...a2, io: w.rig });
    expect(stop2.conclusion).toMatchObject({ stage: 'STOP_BEFORE_M217', restored: true, freeze_in_place: false });
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R16 D-05/D-09: history and operator re-attested immediately before T0 with a bounded preflight age; the ledger is bound to one evidence root and the Owner anchor', async () => {
    await w.rejectAllSubmitted();
    const dir = evidenceDir('r16');
    const refusedBeforeT0 = async (ctx: any, code: string) => {
      expect((await w.refusal(R.runFreeze(ctx)))?.code).toBe(code);
      const id = ctx.store.listAttempts().at(-1);
      const state = ctx.store.readState(id);
      expect(state.conclusion).toMatchObject({ outcome: C.REFUSED_BEFORE_T0, stage: 'PRE_T0_RECHECK', code });
      expect(state.t0).toBeUndefined();
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
    };
    // history moved between preflight and freeze: M217 got recorded
    const a1 = w.ctxFor(dir);
    await R.runPreflight(a1);
    await w.admin(`INSERT INTO supabase_migrations.schema_migrations (version, name) VALUES ($1, $2)`, [REMOTE_HISTORY_VERSION, C.M217_HISTORY_NAME]);
    try {
      await refusedBeforeT0(a1, 'M217_ALREADY_RECORDED');
    } finally {
      await w.admin(`DELETE FROM supabase_migrations.schema_migrations WHERE version = $1`, [REMOTE_HISTORY_VERSION]);
    }
    // a revision submitted in an organization the operator does not cover, after the preflight
    const a2 = w.ctxFor(dir);
    await R.runPreflight(a2);
    const other = await w.submitted(ORG_OTHER, U_OTHER);
    try {
      await refusedBeforeT0(a2, 'OPERATOR_ORG_MISMATCH');
    } finally {
      await w.call(U_OTHER, REJECT, [other.rev, 'rehearsal hygiene']);
    }
    // a stale preflight (the bound can only be tightened: 0 s here)
    const a3 = w.ctxFor(dir, { preflightMaxAgeSeconds: 0 });
    await R.runPreflight(a3);
    await refusedBeforeT0(a3, 'PREFLIGHT_STALE');

    // D-09: the Owner anchor must match this root's ledger exactly
    const store = new R.EvidenceStore(dir);
    const ids = store.listAttempts();
    expect(ids).toHaveLength(3);
    expect((await w.refusal(R.runPreflight(w.ctxFor(dir, { ledgerExpected: { prior_attempts: 0 } }))))?.code).toBe('LEDGER_ANCHOR_MISMATCH');
    const [identity] = await w.admin(Q.DATABASE_IDENTITY_SQL);
    const [{ system_identifier: sysid }] = await w.admin(Q.SYSTEM_IDENTIFIER_SQL);
    const withRefused = store.listAttempts(); // the refused anchor attempt is itself part of the ledger now
    const digest = sha256(C.ledgerDigestInput({
      database: { database: identity.database, database_oid: identity.database_oid, system_identifier: sysid },
      priorEntries: withRefused.map((id: string) => ({ attempt_id: id, manifest_sha256: store.manifestSha256(id) })),
    }));
    const anchored = await R.runPreflight(w.ctxFor(dir, { ledgerExpected: { prior_attempts: withRefused.length, ledger_sha256: digest } }));
    expect(anchored.ledger).toEqual({ prior_attempts: 4, ledger_sha256: digest, owner_anchored: true });
    await R.runStop(w.ctxFor(dir));

    // D-09: the same ledger copied under another evidence root is refused
    const moved = evidenceDir('r16-moved');
    cpSync(dir, moved, { recursive: true });
    expect((await w.refusal(R.runPreflight(w.ctxFor(moved))))?.code).toBe('LEDGER_ROOT_MISMATCH');
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R17 TR-1 cells: an ACL0 carrying a PUBLIC tuple and a plain extra grantee is frozen completely — a PUBLIC-only role, the extra grantee, anon and authenticated cannot execute — and restored exactly', async () => {
    await w.rejectAllSubmitted();
    const d = await w.readyDraft();
    await w.admin(`DO $r$ BEGIN CREATE ROLE ${EXTRA_GRANTEE} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`);
    await w.admin(`DO $r$ BEGIN CREATE ROLE ${PUBLIC_ONLY} NOLOGIN; EXCEPTION WHEN duplicate_object THEN NULL; END $r$`);
    await w.admin(`GRANT EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} TO PUBLIC`);
    await w.admin(`GRANT EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} TO ${EXTRA_GRANTEE}`);
    const can = async (role: string, fn: string) => (await w.admin(`SELECT has_function_privilege($1, $2::regprocedure, 'EXECUTE') AS ok`, [role, fn]))[0].ok;
    try {
      const acl0 = await w.aclNow();
      expect(acl0.some((t: any) => t.fn === C.SUBMIT_SIGNATURE && t.grantee === 'PUBLIC')).toBe(true);
      expect(acl0.some((t: any) => t.fn === C.APPROVE_SIGNATURE && t.grantee === EXTRA_GRANTEE)).toBe(true);
      expect(await can(PUBLIC_ONLY, C.SUBMIT_SIGNATURE)).toBe(true); // only through PUBLIC
      const ctx = w.ctxFor(evidenceDir('r17'));
      await R.runPreflight(ctx);
      expect((await R.runFreeze(ctx)).outcome).toBe('FROZEN');
      const id = ctx.store.listAttempts()[0];
      const [freeze] = evidence(ctx.store, id, 'acl-freeze');
      expect(freeze.statements).toEqual(expect.arrayContaining([
        `REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM PUBLIC`,
        `REVOKE EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} FROM "${EXTRA_GRANTEE}"`,
      ]));
      expect(freeze.frozen_acl.every((t: any) => t.grantee === t.owner)).toBe(true);
      for (const role of [PUBLIC_ONLY, EXTRA_GRANTEE, 'anon', 'authenticated', 'service_role']) {
        for (const fn of C.FREEZE_SIGNATURES) expect(await can(role, fn), `${role} ${fn}`).toBe(false);
      }
      // ATTACK: the PUBLIC-only role actually calls submit during the freeze — refused, nothing moved
      const e = await w.refusal(w.call(U_EDIT, SUBMIT, [d.rev], PUBLIC_ONLY));
      expect(e).toMatchObject({ code: '42501' });
      expect(await w.statusOf(d.rev)).toBe('draft');
      const stop = await R.runStop(ctx);
      expect(stop.conclusion).toMatchObject({ stage: 'STOP_BEFORE_M217', restored: true, freeze_in_place: false });
      expect(C.aclSetsEqual(await w.aclNow(), acl0)).toBe(true); // PUBLIC and the extra grantee back, exactly
      expect(await can(PUBLIC_ONLY, C.SUBMIT_SIGNATURE)).toBe(true);
    } finally {
      await w.admin(`REVOKE EXECUTE ON FUNCTION ${C.SUBMIT_SIGNATURE} FROM PUBLIC`);
      await w.admin(`REVOKE EXECUTE ON FUNCTION ${C.APPROVE_SIGNATURE} FROM ${EXTRA_GRANTEE}`);
      for (const r of [EXTRA_GRANTEE, PUBLIC_ONLY]) {
        await w.admin(`DO $r$ BEGIN EXECUTE 'DROP OWNED BY ${r} CASCADE'; EXECUTE 'DROP ROLE ${r}'; EXCEPTION WHEN undefined_object THEN NULL; END $r$`);
      }
    }
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('R10 the full ordered sequence: governed resolution, freeze holds across M217, STOP refused after M217 (D-01), post-apply resumed after a transient error (D-08), DRAFT audits on seeded data (TR-5), PASS, exact ACL0 restore, physically bound C5 approvals', async () => {
    await w.rejectAllSubmitted();
    // a realistic mix: approved, superseded (+ its approved correction), rejected, drafts, two submitted
    const p = await w.approved();
    const k = (await w.call(U_EDIT, OPEN_CORRECTION, [ORG_OWNER, p.y, p.rev, 'rehearsal correction'])).plan_revision_id;
    await w.toSubmitted(k);
    await w.call(U_APPROVE, APPROVE, [k]);
    const rj = await w.submitted();
    await w.call(U_APPROVE, REJECT, [rj.rev, 'rehearsal rejected']);
    const draft = await w.readyDraft();
    const draft2 = await w.readyDraft();
    const x = await w.submitted();
    const y = await w.submitted();
    expect(await w.statusOf(p.rev)).toBe('superseded');
    // H13 fixtures through the LEGACY (pre-M217) override RPC: two overrides of one source record in ONE
    // transaction (shared created_at), and a record whose second override is queued inside the window.
    const recordOf = async (rev: string) => (await w.admin(`SELECT r.id FROM central_needs_source_records r
      JOIN central_needs_import_sessions s ON s.id = r.import_session_id WHERE s.plan_revision_id = $1 ORDER BY r.record_ordinal LIMIT 1`, [rev]))[0].id;
    const chrono = await w.readyDraft();
    const rec1 = await recordOf(chrono.rev);
    await w.rig.asUser(U_EDIT, async (c: any) => {
      await c.query(OVERRIDE, [rec1, JSON.stringify(121), 'first correction']);
      await c.query(OVERRIDE, [rec1, JSON.stringify(122), 'second correction']);
    }, { commit: true });
    const queued = await w.readyDraft();
    const rec2 = await recordOf(queued.rev);
    await w.call(U_EDIT, OVERRIDE, [rec2, JSON.stringify(130), 'before T0']);

    // TR-5 fixtures, seeded pre-T0 on the 216 chain (all SAFE at apply time, so M217's preconditions pass):
    //  pinD — an AMBIGUOUS cell ('25.0') linked through the canonical 216 set_need_line with the head override O1 pinned;
    //  natD — a NATIVE cell with overrides Oa then Ob, linked with the older Oa pinned: a legacy NON-HEAD optional pin;
    //  invD — invalid evidence ({"value":25}, no valueType) in a still-PROCESSING session (not an M217 precondition).
    const pinD = await w.openDraft();
    const pinCells = await w.draftCells(pinD.rev, [{ value: '25.0', valueType: 'string', isFormula: false, formula: null }]);
    const o1 = await w.override(pinCells.records[0], '25', 'explicit numeric reading of 25.0');
    await w.setLine(pinD.rev, pinCells.records[0], 25, o1);
    const natD = await w.openDraft();
    const natCells = await w.draftCells(natD.rev, [{ value: 10, valueType: 'number', isFormula: false, formula: null }]);
    const oa = await w.override(natCells.records[0], '10', 'first reading');
    const ob = await w.override(natCells.records[0], '10', 'second reading (a pin on the first is non-head)');
    await w.setLine(natD.rev, natCells.records[0], 10, oa);
    const invD = await w.openDraft();
    const invCells = await w.draftCells(invD.rev, [{ value: 25 }], { status: 'processing', confirm: false });

    const ctx = w.ctxFor(evidenceDir('r10'));
    await R.runPreflight(ctx);
    const frozen = await R.runFreeze(ctx);
    expect(frozen.s0).toBe(2);
    await w.call(U_EDIT, OVERRIDE, [rec2, JSON.stringify(131), 'queued inside the activation window']);
    const id = ctx.store.listAttempts()[0];
    const state0 = ctx.store.readState(id);
    expect(state0.a0.map((r: any) => `${r.id}:${r.status}`)).toEqual(expect.arrayContaining([`${p.rev}:superseded`, `${k}:approved`]));
    expect(Object.keys(state0.a0[0]).sort()).toEqual(['approved_at', 'approved_by', 'id', 'organization_id', 'plan_id', 'revision_number', 'status', 'updated_at']);
    expect(state0.frozen_acl.every((t: any) => t.grantee === t.owner)).toBe(true);
    expect(Object.keys(state0.fingerprints0).sort()).toEqual([...C.FINGERPRINT_SIGNATURES].sort());

    // ATTACK (during the freeze): every client path to submit/approve is refused; reject stays available.
    const denied = async (userId: string | null, sql: string, id2: string, role: string) => {
      const before = await w.statusOf(id2);
      const e = await w.refusal(w.call(userId, sql, [id2], role));
      expect(e).toMatchObject({ code: '42501' });
      expect(e!.message).toMatch(/permission denied for function/);
      expect(await w.statusOf(id2)).toBe(before);
    };
    await denied(U_OPERATOR, APPROVE, y.rev, 'service_role');
    await denied(U_EDIT, SUBMIT, draft.rev, 'service_role');
    await denied(null, APPROVE, y.rev, 'service_role');
    await denied(U_APPROVE, APPROVE, y.rev, 'authenticated');
    await denied(U_EDIT, SUBMIT, draft.rev, 'authenticated');
    await denied(null, SUBMIT, draft.rev, 'anon');
    await denied(null, APPROVE, y.rev, 'anon');
    await denied(null, APPROVE, y.rev, 'authenticated'); // an identity-less authenticated call
    // an ordinary approver rejects X concurrently (H6: already rejected with canonical evidence == resolved)
    await w.call(U_APPROVE, REJECT, [x.rev, 'reviewer rejects on a stale screen']);

    const ready = await R.runResolve(ctx);
    expect(ready).toMatchObject({ outcome: C.READY_FOR_M217, union: [x.rev, y.rev].sort() });
    const [resolution] = evidence(ctx.store, id, 'resolution');
    expect(resolution.plan).toEqual(expect.arrayContaining([{ id: x.rev, action: 'already_rejected' }, { id: y.rev, action: 'reject' }]));
    expect(resolution.verdict.pass).toBe(true);
    expect(await w.statusOf(y.rev)).toBe('rejected');
    const [readyEvidence] = evidence(ctx.store, id, 'ready-for-m217');
    expect(readyEvidence.verdict).toEqual({ pass: true, failures: [] });
    expect(readyEvidence.m217_outcome).toMatchObject({ outcome: 'FAILED_CLEAN', non_commit_proven: true });

    // The executor's step: M217 DATABASE FIRST (canonical bytes), then its history row.
    await w.applyM217();
    expect(C.aclSetsEqual(await w.aclNow(), state0.frozen_acl)).toBe(true); // M217 is ACL-neutral: still frozen

    // D-01 — a STOP now (even one claiming the executor was never dispatched) finds M217 in the catalog:
    // REFUSED and routed to post-apply; nothing restored, the attempt stays open, the freeze is kept.
    const stopAfter = await w.refusal(R.runStop(withExecutor(ctx, NOT_DISPATCHED)));
    expect(stopAfter?.code).toBe('STOP_M217_PRESENT');
    expect(stopAfter?.message).toMatch(/--phase=post-apply/);
    expect(ctx.store.readState(id).conclusion).toBeNull();
    expect(evidence(ctx.store, id, 'stop-acl-restore')).toEqual([]);
    expect(C.aclSetsEqual(await w.aclNow(), state0.frozen_acl)).toBe(true);

    // ATTACK (after M217, before the restore): still no client path; the fence refuses a direct approve (H11 backstop).
    await denied(U_OPERATOR, APPROVE, draft.rev, 'service_role');
    await denied(U_EDIT, SUBMIT, draft2.rev, 'service_role');
    const direct = await w.refusal(w.rig.asUser(U_OPERATOR, (c: any) =>
      c.query(`UPDATE public.central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [draft.rev, U_OPERATOR]),
    { role: 'service_role', commit: true }));
    expect(direct).toMatchObject({ code: '23514', message: 'central_needs_approval_gate_missing' });
    expect(await w.statusOf(draft.rev)).toBe('draft');

    // TR-5 — after M217 and before the post-apply read: a NEW override (the C5 RPC) makes pinD's pin non-head and
    // REQUIRED; invD's session completes (fixture shaping), exposing its legacy invalid evidence to the §7.1 audit.
    const o2 = await w.override(pinCells.records[0], '25', 'a newer reading recorded inside the window');
    await w.admin(`UPDATE central_needs_import_sessions SET status = 'completed', authoritative_digest = preview_digest, completed_at = now()
                    WHERE id = $1`, [invCells.sessionId]);

    // D-08 — a transient error on the first H10 read leaves the attempt OPEN; a re-run re-classifies and continues.
    let flaky = true;
    const flakyIo = tapIo(w.rig, async (sql, _p, run) => {
      if (flaky && sql === Q.POST_APPLY_CATALOG_SQL) {
        flaky = false;
        throw Object.assign(new Error('simulated: transient read failure during H10'), { code: '08006' });
      }
      return run();
    });
    const first = await w.refusal(R.runPostApply({ ...withExecutor(ctx, EXECUTOR_SUCCEEDED), io: flakyIo }));
    expect(first?.message).toMatch(/transient read failure during H10/);
    expect(ctx.store.readState(id)).toMatchObject({ conclusion: null, m217_outcome: { outcome: 'APPLIED' } });
    expect(ctx.store.readState(id).completed.at(-1)).toBe('M217_OUTCOME_CLASSIFIED');
    expect(C.aclSetsEqual(await w.aclNow(), state0.frozen_acl)).toBe(true);

    const out = await R.runPostApply(withExecutor(ctx, EXECUTOR_SUCCEEDED));
    expect(out).toMatchObject({ outcome: C.C5_ACTIVATION_PASS, conclusion: { restored: true, freeze_in_place: false } });
    expect(evidence(ctx.store, id, 'post-apply-resume')).toEqual([expect.objectContaining({ resumed_from: ['M217_OUTCOME_CLASSIFIED'], prior_outcome: 'APPLIED' })]);
    expect(evidence(ctx.store, id, 'm217-outcome').map((m: any) => m.outcome.outcome)).toEqual(['APPLIED', 'APPLIED']);
    const [verify] = evidence(ctx.store, id, 'post-apply-verification');
    expect(verify.verdict).toEqual({ pass: true, failures: [] });
    expect(verify.proof_a.deltas).toEqual([]);
    expect(verify.proof_b).toMatchObject({ pass: true, approvals: [], gates_at_or_after_t0: 0 });
    expect(verify.census.pass).toBe(true);
    expect(verify.census.added).toBe(2); // exactly the reject audits of X (reviewer) and Y (governed operator)
    // H13: the chronology audit names both DRAFT workflows; they HOLD at workflow level, not the activation.
    expect(verify.draft_audit.chronology).toEqual(expect.arrayContaining([
      expect.objectContaining({ source_record_id: rec1, plan_revision_id: chrono.rev, overrides: 2, shared_created_at: true }),
      expect.objectContaining({ source_record_id: rec2, plan_revision_id: queued.rev, overrides: 2, shared_created_at: false, queued_after_t0: true }),
    ]));
    // TR-5: the non-head pin audit on NON-EMPTY data — pinD required (ambiguous), natD informational (native)
    expect(verify.draft_audit.pins).toEqual(expect.arrayContaining([
      expect.objectContaining({ plan_revision_id: pinD.rev, source_record_id: pinCells.records[0], applied_override_id: o1, head_id: o2,
        evidence_class: 'ambiguous_numeric_text', required_pin: true }),
      expect.objectContaining({ plan_revision_id: natD.rev, source_record_id: natCells.records[0], applied_override_id: oa, head_id: ob,
        evidence_class: 'native_number', required_pin: false }),
    ]));
    expect(verify.draft_audit.pins).toHaveLength(2);
    // ... the full lineage audit names exactly pinD's link as binding_invalid (natD's native pin is safe)
    expect(verify.draft_audit.lineage).toEqual([expect.objectContaining({ plan_revision_id: pinD.rev, source_record_id: pinCells.records[0],
      reason: 'source_quantity_override_binding_invalid' })]);
    // ... and the invalid-evidence audit names invD's legacy record once its session completed
    expect(verify.draft_audit.invalidEvidence).toEqual([{ source_record_id: invCells.records[0], import_session_id: invCells.sessionId, plan_revision_id: invD.rev }]);
    expect(verify.draft_audit_summary).toMatchObject({ non_head_pins: 2, unsafe_required_pins: 1, unsafe_lineage_links: 1, invalid_source_evidence: 1 });
    expect(verify.draft_audit_summary.draft_workflow_holds).toEqual(expect.arrayContaining([chrono.rev, queued.rev, pinD.rev, invD.rev]));
    expect(verify.draft_audit_summary.draft_workflow_holds).not.toContain(natD.rev);
    expect(out.conclusion.draft_workflow_holds).toEqual(expect.arrayContaining([chrono.rev, queued.rev, pinD.rev, invD.rev]));
    const [restore] = evidence(ctx.store, id, 'acl-restore');
    expect(restore.restore).toMatchObject({ ok: true, verified_in_transaction: true, set_equal: true, restored: true });
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
    expect(C.aclSetsEqual((await w.admin(Q.REJECT_ACL_SQL))[0].acl, w.env.rejectBase)).toBe(true);
    const state = ctx.store.readState(id);
    expect(state.completed).toEqual([...C.ACTIVATION_STEPS]);
    expect(ctx.store.verifyManifest(id)).toBe(true);

    // After the restore: a canonical C5 approval works, and its audit is PHYSICALLY bound to its gate (H5).
    await w.call(U_EDIT, SUBMIT, [draft.rev]);
    await w.call(U_APPROVE, APPROVE, [draft.rev]);
    const rows = await w.admin(Q.PROOF_B_SQL, [state.t0]);
    const gate = rows.find((r: any) => r.action === C.ACTION_GATE && r.entity_id === draft.rev);
    const approve = rows.find((r: any) => r.action === C.ACTION_APPROVE && r.entity_id === draft.rev);
    expect(C.isPhysicalSameTransaction(gate, approve)).toBe(true);
    expect(C.evaluateProofB({ rows }).approvals).toEqual([expect.objectContaining({ entity_id: draft.rev, physical_match: true })]);
  });
});

run('C5 v1.9 activation rehearsal — privileged direct edits and forged audits (fresh rig)', () => {
  const w = rehearsalWorld('attack');
  beforeAll(async () => { await w.setup(); });
  afterAll(async () => {
    await w.teardown();
    if (!process.env.PHOENIX_C5_REHEARSAL_EVIDENCE_DIR) for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  it('R11 Proof A classifies every privileged edit made between READY and M217, the physical check exposes forged gate+approve audits, the census sees them: HOLD, freeze kept', async () => {
    const p1 = await w.approved();
    const p2 = await w.approved();
    const p3 = await w.approved();
    const p4 = await w.approved();
    const d1 = await w.readyDraft();
    const d2 = await w.readyDraft();
    // a legacy approved row with no children (deletable), and an empty plan to re-parent into — fixture shapes, pre-T0
    const legacyPlan = (await w.admin(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG_OWNER, w.nextYear()]))[0].id;
    const legacy = (await w.admin(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, approved_by, approved_at)
                                   VALUES ($1,$2,1,'approved',$3,now()) RETURNING id`, [legacyPlan, ORG_OWNER, U_APPROVE]))[0].id;
    const emptyPlan = (await w.admin(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG_OWNER, w.nextYear()]))[0].id;

    const ctx = w.ctxFor(evidenceDir('r11'));
    const id = await w.toReady(ctx); // the window as seen by the drain/resolution/READY accounting is clean
    const t0 = ctx.store.readState(id).t0;

    // ATTACK — privileged (owner-equivalent) direct edits in the gap between READY and M217 (prohibited by H11).
    await w.admin(`UPDATE central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [d1.rev, U_APPROVE]);
    await w.admin(`UPDATE central_needs_plan_revisions SET status = 'superseded' WHERE id = $1`, [p1.rev]);
    await w.admin(`UPDATE central_needs_plan_revisions SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = $1`, [p2.rev]);
    await w.admin(`DELETE FROM central_needs_plan_revisions WHERE id = $1`, [legacy]);
    await w.admin(`UPDATE central_needs_plan_revisions SET plan_id = $2 WHERE id = $1`, [p3.rev, emptyPlan]);
    await w.admin(`UPDATE central_needs_plan_revisions SET status = 'draft', approved_by = NULL, approved_at = NULL WHERE id = $1`, [p4.rev]);
    await w.admin(`UPDATE central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [p4.rev, U_APPROVE]);
    // ATTACK — service_role (PostgREST shape): direct approve, then a forged gate and a forged approve audit in
    // SEPARATE transactions with a matching payload txid and an identical created_at.
    const sr = (sql: string, params: unknown[]) => w.rig.asUser(U_APPROVE, (c: any) => c.query(sql, params), { role: 'service_role', commit: true });
    await sr(`UPDATE public.central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`, [d2.rev, U_APPROVE]);
    const forgedAt = new Date(Date.parse(t0) + 1000).toISOString();
    await sr(`INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload, created_at)
              VALUES ($1,$2,'central_warehouse_manager','central_needs.plan_revision.approval_gate','central_needs_plan_revision',$3,
                      jsonb_build_object('contract','c5-v1','txid','424242'), $4::timestamptz)`, [ORG_OWNER, U_APPROVE, d2.rev, forgedAt]);
    await sr(`INSERT INTO public.audit_logs (organization_id, actor_id, actor_role, action, entity_type, entity_id, payload, created_at)
              VALUES ($1,$2,'central_warehouse_manager','central_needs.plan_revision.approve','central_needs_plan_revision',$3,
                      jsonb_build_object('from_status','submitted','to_status','approved','approval_gate_txid','424242'), $4::timestamptz)`,
    [ORG_OWNER, U_APPROVE, d2.rev, forgedAt]);

    await w.applyM217();
    const out = await R.runPostApply(withExecutor(ctx, EXECUTOR_SUCCEEDED));
    expect(out.conclusion).toMatchObject({ outcome: C.C5_ACTIVATION_HOLD, stage: 'POST_APPLY_VERIFICATION', restored: false, freeze_in_place: true });
    expect(out.conclusion.failures).toEqual(expect.arrayContaining(['POST_APPLY_PROOF_A_DELTA', 'POST_APPLY_PROOF_B_UNMATCHED', 'POST_APPLY_LIFECYCLE_AUDIT_DELTA']));

    const [verify] = evidence(ctx.store, id, 'post-apply-verification');
    const kinds = Object.fromEntries(verify.proof_a.deltas.map((d: any) => [d.id, d.kind]));
    expect(kinds).toEqual({
      [d1.rev]: 'approval', [d2.rev]: 'approval', [p1.rev]: 'supersede', [p2.rev]: 'demotion',
      [legacy]: 'deletion', [p3.rev]: 're_parent', [p4.rev]: 'round_trip',
    });
    const forged = verify.proof_a.deltas.find((d: any) => d.id === d2.rev);
    expect(forged.evidence).toMatchObject({ payload_gate_match: true, physical_gate_match: false });
    expect(verify.proof_b.approvals).toEqual([expect.objectContaining({ entity_id: d2.rev, payload_match: true, physical_match: false })]);
    expect(verify.proof_b.unmatched).toHaveLength(1);
    expect(verify.census.unexpected_added.map((r: any) => r.action).sort()).toEqual([C.ACTION_APPROVE, C.ACTION_GATE].sort());
    // No restore: the ACL is exactly the sealed frozen ACL.
    expect(C.aclSetsEqual(await w.aclNow(), ctx.store.readState(id).frozen_acl)).toBe(true);
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(false);
  });
});

/**
 * TR-1 — the B2 negative controls, each on its own fresh rig because the
 * second attempt COMMITS a rogue M217 variant. With the complete freeze in
 * place (owner-only submit/approve ACL):
 *   attempt 1 — the rogue statement placed BEFORE M217's own VERIFY: M217
 *               refuses itself ('VERIFY FAILED (217)'), rolls back, and the
 *               post-apply proves non-commit (FAILED_CLEAN) and restores;
 *   attempt 2 — the same statement placed AFTER M217's VERIFY (a variant that
 *               would slip past a self-check): M217 commits, and the post-apply
 *               frozen-ACL equality refuses it — HOLD, NOTHING restored.
 * Rehearsal-only, in-memory modified copies; the real M217 file is never written.
 */
const negativeControl = (label: string, variant: string, inject: string, expectAcl: (acl: any[]) => void, expectFailures: string[]) =>
  run(`C5 v1.9 activation rehearsal — TR-1 B2 negative control: ${variant} (fresh rig)`, () => {
    const w = rehearsalWorld(label);
    beforeAll(async () => { await w.setup(); });
    afterAll(async () => {
      await w.teardown();
      if (!process.env.PHOENIX_C5_REHEARSAL_EVIDENCE_DIR) for (const d of scratch) rmSync(d, { recursive: true, force: true });
    });

    it(`TR-1 ${variant}: refused by M217's own VERIFY before COMMIT (FAILED_CLEAN, restored), and — injected after its VERIFY — refused by the post-apply frozen-ACL check (HOLD, nothing restored)`, async () => {
      const dir = evidenceDir(label);
      // attempt 1 — before VERIFY
      const a1 = w.ctxFor(dir);
      const id1 = await w.toReady(a1);
      const frozen1 = a1.store.readState(id1).frozen_acl;
      expect(frozen1.every((t: any) => t.grantee === t.owner)).toBe(true); // the complete freeze
      const verifyErr = await w.refusal(w.applyM217(beforeVerify(inject)));
      expect(verifyErr?.message).toMatch(/^VERIFY FAILED \(217\)/);
      expect(C.aclSetsEqual(await w.aclNow(), frozen1)).toBe(true); // rolled back: still exactly frozen
      const out1 = await R.runPostApply(withExecutor(a1, EXECUTOR_FAILED));
      expect(out1.conclusion).toMatchObject({ stage: 'M217_FAILED_CLEAN', restored: true, freeze_in_place: false });
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);

      // attempt 2 — after VERIFY: the rogue variant COMMITS
      const disp = [{ attempt_id: id1, decision: 'retry the B2 negative control', owner_reference: `rehearsal-owner-${label}`,
        acknowledged_delta_ids: [], acknowledged_audit_ids: [] }];
      const a2 = w.ctxFor(dir, { dispositions: disp });
      const id2 = await w.toReady(a2);
      const frozen2 = a2.store.readState(id2).frozen_acl;
      await w.applyM217(afterVerify(inject));
      const rogue = await w.aclNow();
      expect(C.aclSetsEqual(rogue, frozen2)).toBe(false);
      expectAcl(rogue);
      const out2 = await R.runPostApply(withExecutor(a2, EXECUTOR_SUCCEEDED));
      expect(out2.conclusion).toMatchObject({ outcome: C.C5_ACTIVATION_HOLD, stage: 'POST_APPLY_VERIFICATION', restored: false });
      expect(out2.conclusion.failures).toEqual(expect.arrayContaining(expectFailures));
      expect(out2.conclusion.freeze_in_place).toBe('UNKNOWN'); // catalog truth: neither the frozen set nor ACL0
      const [verify] = evidence(a2.store, id2, 'post-apply-verification');
      const changed = verify.verdict.failures.find((f: any) => f.code === 'POST_APPLY_ACL_FROZEN_CHANGED');
      expect(changed.detail.length).toBeGreaterThan(0);
      expect(evidence(a2.store, id2, 'acl-restore')).toEqual([]);
      expect(C.aclSetsEqual(await w.aclNow(), rogue)).toBe(true);  // nothing was restored or touched
      expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(false);
    });
  });

negativeControl('tr1-drop-create', 'DROP FUNCTION approve + CREATE (default privileges bring service_role back)', DROP_CREATE_APPROVE,
  (acl) => {
    const approve = acl.filter((t: any) => t.fn === C.APPROVE_SIGNATURE).map((t: any) => t.grantee).sort();
    expect(approve).toEqual(['postgres', 'service_role']);
  },
  ['POST_APPLY_ACL_FROZEN_CHANGED']);

negativeControl('tr1-blanket-grant', 'blanket GRANT EXECUTE ON ALL FUNCTIONS IN SCHEMA public TO authenticated', BLANKET_GRANT,
  (acl) => {
    for (const fn of C.FREEZE_SIGNATURES) expect(acl.some((t: any) => t.fn === fn && t.grantee === 'authenticated')).toBe(true);
  },
  ['POST_APPLY_ACL_FROZEN_CHANGED', 'POST_APPLY_LINEAGE_HELPER_CONTRACT', 'POST_APPLY_FENCE_FUNCTION_CONTRACT']);

run('C5 v1.9 activation rehearsal — TR-2 zero submitted re-read immediately before the restore (fresh rig)', () => {
  const w = rehearsalWorld('tr2-pre-restore');
  beforeAll(async () => { await w.setup(); });
  afterAll(async () => {
    await w.teardown();
    if (!process.env.PHOENIX_C5_REHEARSAL_EVIDENCE_DIR) for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  it('TR-2 a revision made submitted by a privileged write AFTER the H10 verification passed: the re-read immediately before the restore HOLDs, nothing restored', async () => {
    const draft = await w.readyDraft();
    const ctx = w.ctxFor(evidenceDir('tr2-pre-restore'));
    const id = await w.toReady(ctx);
    const frozen = ctx.store.readState(id).frozen_acl;
    await w.applyM217();
    // Interleave exactly between the sealed H10 verification and the pre-restore re-read.
    let injected = false;
    const interleave = tapIo(w.rig, async (sql, _p, run, c) => {
      if (!injected && sql === Q.SUBMITTED_SQL && evidence(ctx.store, id, 'post-apply-verification').length === 1) {
        injected = true;
        await c.query(`UPDATE public.central_needs_plan_revisions SET status = 'submitted' WHERE id = $1`, [draft.rev]); // privileged (H11-prohibited)
      }
      return run();
    });
    const out = await R.runPostApply({ ...withExecutor(ctx, EXECUTOR_SUCCEEDED), io: interleave });
    expect(injected).toBe(true);
    const [verify] = evidence(ctx.store, id, 'post-apply-verification');
    expect(verify.verdict).toEqual({ pass: true, failures: [] }); // H10 itself passed before the write
    expect(out.conclusion).toMatchObject({
      outcome: C.C5_ACTIVATION_HOLD, stage: 'PRE_RESTORE_ZERO_SUBMITTED', code: 'SUBMITTED_PRESENT', submitted: [draft.rev],
      restored: false, freeze_in_place: true,
    });
    expect(evidence(ctx.store, id, 'pre-restore-zero-submitted')).toEqual([expect.objectContaining({ submitted: [draft.rev] })]);
    expect(evidence(ctx.store, id, 'acl-restore')).toEqual([]);
    expect(ctx.store.readState(id).completed.at(-1)).toBe('POST_APPLY_VERIFIED');
    expect(C.aclSetsEqual(await w.aclNow(), frozen)).toBe(true);
  });
});

/**
 * A-01 — the non-commit proof races an orphaned M217 (the executor run was
 * cancelled/killed, its already-sent batch still executing server-side). The
 * classification reads happen BEFORE the restore; these tests make M217 act
 * exactly between them and the restore's GRANTs — the window no pre-read can
 * close — and prove the in-transaction exclusion lock + re-proof does.
 */
run('C5 v1.9 activation rehearsal — A-01 non-commit race at the restore (fresh rig)', () => {
  const w = rehearsalWorld('a01-restore-race');
  beforeAll(async () => { await w.setup(); });
  afterAll(async () => {
    await w.teardown();
    if (!process.env.PHOENIX_C5_REHEARSAL_EVIDENCE_DIR) for (const d of scratch) rmSync(d, { recursive: true, force: true });
  });

  it('A-01 an M217 IN FLIGHT at the restore (holding its first lock): the exclusion lock NOWAIT fails, the STOP is refused, nothing restored; once it is gone a STOP restores', async () => {
    const ctx = w.ctxFor(evidenceDir('a01-in-flight'));
    const id = await w.toReady(ctx);
    const frozen = ctx.store.readState(id).frozen_acl;
    const m217 = await w.rig.pool.connect(); // stands in for the orphan M217 backend
    let tookLock = false;
    try {
      const io = tapIo(w.rig, async (sql, _p, runIt) => {
        if (!tookLock && sql === Q.RESTORE_M217_EXCLUSION_LOCK_SQL) {
          tookLock = true;
          await m217.query('BEGIN');
          await m217.query('LOCK TABLE public.central_needs_source_records IN ACCESS EXCLUSIVE MODE');
        }
        return runIt();
      });
      const refused = await w.refusal(R.runStop({ ...withExecutor(ctx, NOT_DISPATCHED), io }));
      expect(tookLock).toBe(true);
      expect(refused?.code).toBe('STOP_M217_PRESENT');
      expect(refused?.message).toMatch(/inside the restore transaction/);
      const [rec] = evidence(ctx.store, id, 'stop-acl-restore');
      expect(rec.restore).toMatchObject({ ok: false, code: 'M217_PRESENT_AT_RESTORE', m217: 'IN_FLIGHT', restored: false });
      expect(rec.restore.error.code).toBe('55P03');
      expect(ctx.store.readState(id).conclusion).toBeNull();
      expect(C.aclSetsEqual(await w.aclNow(), frozen)).toBe(true); // the freeze is kept
    } finally {
      await m217.query('ROLLBACK').catch(() => undefined);
      m217.release();
    }
    // the in-flight backend is gone and M217 never committed: the same attempt now proves non-commit and restores
    const stop = await R.runStop(withExecutor(ctx, NOT_DISPATCHED));
    expect(stop.conclusion).toMatchObject({ stage: 'STOP_BEFORE_M217', restored: true, freeze_in_place: false });
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });

  it('A-01 an M217 that COMMITS after the FAILED_CLEAN classification and before the restore: the in-transaction re-proof sees it, the restore rolls back, post-apply then verifies and restores', async () => {
    const ctx = w.ctxFor(evidenceDir('a01-committed'));
    const id = await w.toReady(ctx);
    const frozen = ctx.store.readState(id).frozen_acl;
    let applied = false;
    const io = tapIo(w.rig, async (sql, _p, runIt) => {
      if (!applied && sql === Q.RESTORE_M217_EXCLUSION_LOCK_SQL) {
        applied = true;
        await w.applyM217(); // database first, then its history row — both committed before the restore proceeds
      }
      return runIt();
    });
    const refused = await w.refusal(R.runStop({ ...withExecutor(ctx, NOT_DISPATCHED), io }));
    expect(applied).toBe(true);
    // the pre-restore classification had proven FAILED_CLEAN (M217 absent at that moment) ...
    const [check] = evidence(ctx.store, id, 'stop-m217-check');
    expect(check.outcome).toMatchObject({ outcome: 'FAILED_CLEAN' });
    expect(check.in_flight_before).toBeTruthy();
    expect(check.in_flight_after).toBeTruthy();
    // ... and the restore still refused: M217 is APPLIED inside its transaction
    expect(refused?.code).toBe('STOP_M217_PRESENT');
    const [rec] = evidence(ctx.store, id, 'stop-acl-restore');
    expect(rec.restore).toMatchObject({ ok: false, code: 'M217_PRESENT_AT_RESTORE', m217: 'APPLIED', restored: false });
    expect(ctx.store.readState(id).conclusion).toBeNull();
    expect(C.aclSetsEqual(await w.aclNow(), frozen)).toBe(true);

    // A-05 — post-apply does not accept a never-dispatched executor as its basis
    const notDispatched = await w.refusal(R.runPostApply(withExecutor(ctx, NOT_DISPATCHED)));
    expect(notDispatched?.code).toBe('POST_APPLY_REQUIRES_EXECUTOR_RUN');
    expect(ctx.store.readState(id).conclusion).toBeNull();

    // the governed route: post-apply classifies APPLIED, verifies H10 and restores exactly ACL0
    const out = await R.runPostApply(withExecutor(ctx, EXECUTOR_SUCCEEDED));
    expect(out).toMatchObject({ outcome: C.C5_ACTIVATION_PASS, conclusion: { restored: true, freeze_in_place: false } });
    expect(C.aclSetsEqual(await w.aclNow(), w.env.base)).toBe(true);
  });
});
