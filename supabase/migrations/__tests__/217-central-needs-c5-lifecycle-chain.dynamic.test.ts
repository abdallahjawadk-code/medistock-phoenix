/**
 * C5 / M217 — the dedicated 217-CHAIN LIFECYCLE runner (contract §18).
 *
 * The chain is built only through 216. History that the C5 fence and CHECK
 * would refuse — and that Production may therefore hold from before C5 — is
 * seeded while neither exists, through the canonical RPCs wherever a canonical
 * path exists. M217 is then applied OVER that history through
 * applyMigrationSql (never a bare replay), and every assertion after it runs
 * on the 217 chain:
 *
 *   PRE  M217's activation preconditions refuse to apply over a DRAFT holding
 *        invalid evidence / an unsafe link (draft_invalid, draft_unsafe_links)
 *        and over a SUBMITTED revision (submitted) — and apply NOTHING;
 *   D    lifecycle-D: two approved historical revisions, the TARGET still DRAFT
 *        when M217 lands; submitted afterwards through the real workflow;
 *        approve is refused central_needs_lifecycle_state_ambiguous with the
 *        pinned DETAIL 'plan=<uuid> holds 2 approved revisions', with the
 *        original row counts and zero status/audit mutation;
 *   A-E  the M215 lifecycle matrix on the 217 chain through canonical RPCs:
 *        idempotent replay, not submitted, not newest, ambiguity, single
 *        predecessor supersede (now with its approval gate);
 *   FENCE the approval fence binds the replayed history: a direct privileged
 *        UPDATE to approved (superuser and service_role) of the submitted D
 *        target, of a SUPERSEDED revision and of REJECTED revisions that all
 *        predate M217 is refused central_needs_approval_gate_missing with
 *        DETAIL revision=<id> and a zero footprint (attempted attacks, never
 *        fixture writes);
 *   §7   legacy invalid evidence (valueType missing) that predates the CHECK:
 *        the §7.1 blocker exact DETAIL, completed-session and DRAFT-only
 *        gating, and §7.1 + §7.2 BOTH reported for a linked legacy source.
 *
 * Direct superuser writes appear ONLY where a test must construct a state no
 * canonical path can produce (the two-approved corruption, a revision newer
 * than a submitted one, a legacy row in a still-processing session, a
 * lifecycle regression back to DRAFT). None uses DISABLE TRIGGER,
 * session_replication_role, a direct approved insert or a hand-written gate.
 * Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  applyMigrationSql, buildRig, migrationFiles, MIGRATIONS_DIR, rigAvailable, shimSql,
} from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const M217 = '217_phoenix_central_needs_c5_safety_convergence.sql';

const ORG_A = '00000000-0000-0000-0000-000000217101';   // plan owner
const ORG_BENE = '00000000-0000-0000-0000-000000217102'; // beneficiary institution

const U_EDIT_A = '00000000-0000-0000-0000-000000217501';    // view/import/edit
const U_APPROVE_A = '00000000-0000-0000-0000-000000217502'; // view/approve
const U_VIEW_A = '00000000-0000-0000-0000-000000217503';    // view only

const ITEM_A = '00000000-0000-0000-0000-000000217901';

const H = (c: string) => c.repeat(64);
const NODE_IDENTITY = {
  contractVersion: '1.0.0', sheetjsVersion: '0.20.3',
  sheetjsTarballSha256: '8dc73fc3b00203e72d176e85b50938627c7b086e607c682e8d3c22c02bb99fe8',
  runtime: 'node',
};
const BROWSER_IDENTITY = { ...NODE_IDENTITY, runtime: 'browser_worker' };

const OPEN_CORRECTION = 'SELECT public.phoenix_central_needs_open_correction_revision($1,$2,$3,$4) AS result';
const OPEN_DRAFT = 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2,$3) AS result';
const APPROVE = 'SELECT public.phoenix_central_needs_approve_revision($1) AS result';
const REJECT = 'SELECT public.phoenix_central_needs_reject_revision($1,$2) AS result';
const SUBMIT = 'SELECT public.phoenix_central_needs_submit_revision($1) AS result';
const LINEAGE = 'public._phoenix_central_needs_quantity_lineage_violation_v1';

interface Refusal { code: string; message: string; detail?: string }

async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try {
    await p;
  } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

run('C5/M217 lifecycle chain — 216 history, then M217 — dynamic', { timeout: 120_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 2039;
  let fileSeq = 0;
  const nextYear = () => (year += 1);

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });
  const service = (sql: string, params: unknown[] = []) => call(null, sql, params, 'service_role');
  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  const statuses = async (planId: string) => (await admin(
    `SELECT revision_number || ':' || status AS s FROM central_needs_plan_revisions WHERE plan_id = $1 ORDER BY revision_number`, [planId]))
    .map((r: any) => r.s);
  const planOf = async (rev: string) => (await admin(`SELECT plan_id FROM central_needs_plan_revisions WHERE id = $1`, [rev]))[0].plan_id as string;
  const writeFootprint = async () => {
    const [row] = await admin(
      `SELECT (SELECT count(*) FROM central_needs_plan_revisions)::int AS revs,
              (SELECT count(*) FROM central_needs_plans)::int AS plans,
              (SELECT count(*) FROM audit_logs)::int AS audits,
              (SELECT count(*) FROM audit_logs WHERE action = 'central_needs.plan_revision.approval_gate')::int AS gates,
              (SELECT md5(string_agg(id::text || status || updated_at::text, ',' ORDER BY id))
                 FROM central_needs_plan_revisions) AS state`);
    return row;
  };
  const blockers = (revId: string) => admin(`SELECT blocker, detail FROM public._phoenix_central_needs_review_blockers_v1($1)`, [revId]);
  const m217Present = async () => (await admin(`
    SELECT to_regprocedure('public._phoenix_central_needs_review_numeric_class_v1(jsonb)') IS NOT NULL
        OR to_regprocedure('${LINEAGE}(uuid)') IS NOT NULL
        OR EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'central_needs_plan_revisions_c5_approval_gate')
        OR EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'central_needs_source_records_c5_value_contract') AS present`))[0].present as boolean;
  const lifecycleAcl = () => admin(`SELECT p.oid::regprocedure::text AS fn, p.proacl::text AS acl FROM pg_proc p
                                     WHERE p.proname IN ('phoenix_central_needs_submit_revision', 'phoenix_central_needs_approve_revision',
                                                         'phoenix_central_needs_reject_revision') ORDER BY 1`);

  /** Applies M217 through the rig's own apply path; returns the refusal (rolled back) or null. */
  const tryApplyM217 = () => rig.asAdmin((c: any) => applyMigrationSql(c, M217, shimSql(M217, readFileSync(join(MIGRATIONS_DIR, M217), 'utf8')))
    .then(() => null, async (e: any) => {
      await c.query('ROLLBACK').catch(() => undefined);
      return { code: String(e.code), message: String(e.message), detail: e.detail } as Refusal;
    }));

  /** Drives a DRAFT to SUBMITTED through the real workflow RPCs (M215's own path). */
  const toSubmitted = async (revisionId: string) => {
    const records = [{
      targetEntity: 'sheet:0:row:5', fieldName: 'quantity',
      sourceValues: { value: 120, valueType: 'number', isFormula: false, formula: null },
      sourceProvenance: {
        fileFingerprintSha256: H('a'), originalFilename: 'needs.xls', parserVersion: '1.0.0/0.20.3',
        sheetIndex: 0, sheetName: 'Needs', sheetHidden: 'visible',
        coordinate: { row: 4, col: 2, a1: 'C5' }, extractedAt: new Date().toISOString(),
      },
    }];
    const [{ d: digest }] = await admin(
      `SELECT public._phoenix_central_needs_payload_digest_v1($1::jsonb) AS d`, [JSON.stringify(records)]);
    const started = await call(U_EDIT_A,
      `SELECT public.phoenix_central_needs_start_import_session($1,$2,$3,$4,$5::jsonb,$6,$7) AS result`,
      [revisionId, 'needs.xls', H('a'), digest, JSON.stringify(BROWSER_IDENTITY), 1024, 'permanent/x']);
    await service(`SELECT public.phoenix_central_needs_apply_authoritative_replay($1,$2,$3::jsonb,$4::jsonb) AS result`,
      [started.import_session_id, H('a'), JSON.stringify(records), JSON.stringify(NODE_IDENTITY)]);
    await service(`SELECT public.phoenix_central_needs_register_import_batch($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,NULL) AS result`,
      [revisionId, 'file', 'container.xls', H('c'), 'permanent/container',
        JSON.stringify([{ entryOrdinal: 1, archiveEntryPath: null, entrySha256: H('a'), importSessionId: started.import_session_id }]),
        JSON.stringify(NODE_IDENTITY), 2048, 0]);
    await call(U_EDIT_A, `SELECT public.phoenix_central_needs_set_record_disposition($1,$2,$3,$4,$5) AS result`,
      [started.import_session_id, 'sheet:0:row:5', 'not_applicable', null, 'not an annual need line']);
    const s = await call(U_EDIT_A, SUBMIT, [revisionId]);
    expect(s.status).toBe('submitted');
  };

  const openDraft = async (y: number): Promise<string> => (await call(U_EDIT_A, OPEN_DRAFT, [ORG_A, y, false])).plan_revision_id as string;
  const openCorrection = (y: number, expected: string, reason: string) => call(U_EDIT_A, OPEN_CORRECTION, [ORG_A, y, expected, reason]);
  const approve = (rev: string) => call(U_APPROVE_A, APPROVE, [rev]);
  const reject = (rev: string, reason = 'figures do not match the hospital return') => call(U_APPROVE_A, REJECT, [rev, reason]);
  const approvedPlan = async () => {
    const y = nextYear();
    const rev1 = await openDraft(y);
    await toSubmitted(rev1);
    expect(await approve(rev1)).toMatchObject({ ok: true, status: 'approved', superseded_revision_id: null });
    return { y, rev1, planId: await planOf(rev1) };
  };

  /**
   * LEGACY evidence written directly (as every Central Needs suite seeds it):
   * one session holding a record whose source_values lacks valueType — the
   * pre-C5 e2e-seed shape the classifier judges invalid_evidence.
   */
  const legacySession = async (rev: string, opts: { status?: 'completed' | 'processing'; decision?: 'mapped' | 'not_applicable' } = {}) => {
    fileSeq += 1;
    const fileHash = `${fileSeq}`.padStart(64, 'b');
    const [{ id: fileId }] = await admin(
      `INSERT INTO central_needs_source_files (plan_revision_id, organization_id, original_filename, file_hash, byte_size)
       VALUES ($1,$2,$3,$4,1024) RETURNING id`, [rev, ORG_A, `legacy-${fileSeq}.xlsx`, fileHash]);
    const digest = `${fileSeq}`.padStart(64, 'e');
    const status = opts.status ?? 'completed';
    const [{ id: sessionId }] = await admin(status === 'completed'
      ? `INSERT INTO central_needs_import_sessions
           (plan_revision_id, organization_id, source_file_id, status, preview_digest, authoritative_digest, parser_identity, completed_at)
         VALUES ($1,$2,$3,'completed',$4,$4,$5::jsonb, now()) RETURNING id`
      : `INSERT INTO central_needs_import_sessions
           (plan_revision_id, organization_id, source_file_id, status, preview_digest, parser_identity)
         VALUES ($1,$2,$3,'processing',$4,$5::jsonb) RETURNING id`,
    [rev, ORG_A, fileId, digest, JSON.stringify(NODE_IDENTITY)]);
    const [{ id: recordId }] = await admin(
      `INSERT INTO central_needs_source_records
         (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values, source_provenance)
       VALUES ($1,$2,1,'sheet:0:row:1','col:2',$3::jsonb,$4::jsonb) RETURNING id`,
      [sessionId, ORG_A, JSON.stringify({ value: 25 }), JSON.stringify({
        fileFingerprintSha256: fileHash, originalFilename: `legacy-${fileSeq}.xlsx`, parserVersion: '1.0.0',
        sheetIndex: 0, sheetName: 'Sheet0', sheetHidden: 'visible', coordinate: { row: 1, col: 2, a1: 'C2' },
        extractedAt: '2025-12-01T00:00:00.000Z',
      })]);
    const decision = opts.decision ?? 'mapped';
    await admin(
      `INSERT INTO central_needs_record_mappings (import_session_id, organization_id, target_entity, central_item_id, decision, decision_reason)
       VALUES ($1,$2,'sheet:0:row:1',$3,$4,$5)`,
      [sessionId, ORG_A, decision === 'mapped' ? ITEM_A : null, decision, decision === 'mapped' ? null : 'out of scope']);
    return { sessionId, recordId };
  };
  const trustBatch = async (rev: string, sessionId: string) => {
    fileSeq += 1;
    const [{ id: batchId }] = await admin(
      `INSERT INTO central_needs_import_batches
         (plan_revision_id, organization_id, container_kind, container_filename, container_sha256,
          storage_locator, accepted_entry_count, parser_identity)
       VALUES ($1,$2,'file','legacy.xlsx',$3,'permanent/legacy',1,$4::jsonb) RETURNING id`,
      [rev, ORG_A, `${fileSeq}`.padStart(64, 'c'), JSON.stringify(NODE_IDENTITY)]);
    await admin(
      `INSERT INTO central_needs_import_batch_entries (batch_id, plan_revision_id, organization_id, entry_ordinal, entry_sha256, import_session_id)
       VALUES ($1,$2,$3,1,$4,$5)`, [batchId, rev, ORG_A, `${fileSeq}`.padStart(64, 'd'), sessionId]);
  };

  // Fixtures seeded on the 216 chain, asserted on the 217 chain.
  const fx: Record<string, any> = {};
  let aclBefore: any[] = [];

  beforeAll(async () => {
    rig = await buildRig({ upTo: 216 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','C5-CHAIN-A','أ','p217-chain-a','care_institution','hospital'),
        ('${ORG_BENE}','C5-CHAIN-BENE','ب','p217-chain-bene','care_institution','hospital')`);
      await c.query(`INSERT INTO central_items (id, name, name_ar, unit) VALUES ('${ITEM_A}','C5 chain item','مادة','box')`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_EDIT_A}','p217-chain-edit@rig'),('${U_APPROVE_A}','p217-chain-approve@rig'),('${U_VIEW_A}','p217-chain-view@rig')`);
      for (const u of [U_EDIT_A, U_APPROVE_A, U_VIEW_A]) {
        await c.query(`UPDATE profiles SET role='central_warehouse_manager',status='active',organization_id=$1 WHERE id=$2`, [ORG_A, u]);
      }
      const grants: Array<[string, string[]]> = [[U_EDIT_A, ['view', 'import', 'edit']], [U_APPROVE_A, ['view', 'approve']], [U_VIEW_A, ['view']]];
      for (const [u, keys] of grants) {
        for (const k of keys) {
          await c.query(
            `INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
               ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [u, `central_needs.${k}`]);
        }
      }
    });
    expect(await m217Present()).toBe(false);
    aclBefore = await lifecycleAcl();

    // D: Rev1 approved -> Rev2 approved (Rev1 superseded) -> Rev3 DRAFT, all canonical at 216;
    //    then the historical corruption, while no fence exists: Rev1 approved again beside Rev2.
    {
      const { y, rev1, planId } = await approvedPlan();
      const rev2 = (await openCorrection(y, rev1, 'first correction')).plan_revision_id;
      await toSubmitted(rev2);
      await approve(rev2);
      const rev3 = (await openCorrection(y, rev2, 'second correction')).plan_revision_id;
      await admin(`UPDATE central_needs_plan_revisions SET status = 'approved' WHERE id = $1`, [rev1]);
      expect(await statuses(planId)).toEqual(['1:approved', '2:approved', '3:draft']);
      fx.D = { y, planId, rev1, rev2, rev3 };
    }
    // S: a SUPERSEDED history revision reached canonically at 216 (approve, correction, approve).
    {
      const { y, rev1, planId } = await approvedPlan();
      const rev2 = (await openCorrection(y, rev1, 'correction before C5')).plan_revision_id;
      await toSubmitted(rev2);
      expect(await approve(rev2)).toMatchObject({ ok: true, status: 'approved', superseded_revision_id: rev1 });
      expect(await statuses(planId)).toEqual(['1:superseded', '2:approved']);
      fx.S = { y, planId, rev1, rev2 };
    }
    // C: the TARGET Rev1 is a DRAFT; a newer revision exists beside it (a privileged history row, never approved).
    {
      const y = nextYear();
      const rev1 = await openDraft(y);
      const planId = await planOf(rev1);
      await admin(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status)
                   VALUES ($1,$2,2,'rejected')`, [planId, ORG_A]);
      fx.C = { y, planId, rev1 };
    }
    // PZ: a DRAFT whose legacy invalid record sits in a still-PROCESSING session (not counted by precondition 2).
    {
      const y = nextYear();
      const rev = await openDraft(y);
      fx.PZ = { y, rev, ...(await legacySession(rev, { status: 'processing', decision: 'not_applicable' })) };
    }
    // PX: a DRAFT whose legacy invalid record is CONFIRMED and LINKED through the canonical 216 RPCs.
    {
      const y = nextYear();
      const rev = await openDraft(y);
      const sess = await legacySession(rev);
      await call(U_EDIT_A, `SELECT public.phoenix_central_needs_set_beneficiary_columns($1,$2::jsonb,$3) AS result`,
        [rev, JSON.stringify([{ importSessionId: sess.sessionId, sheetIndex: 0, columnIndex: 2, beneficiaryOrganizationId: ORG_BENE }]),
          'confirmed beneficiary column']);
      const line = await call(U_EDIT_A, `SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,$4,$5,$6::jsonb,$7::uuid[],$8,$9,$10,$11) AS result`,
        [rev, ORG_BENE, ITEM_A, 25, 'designated before C5',
          JSON.stringify([{ sourceRecordId: sess.recordId, designatedQuantity: '25', appliedOverrideId: null }]), [], 'box', 'canonical', null, null]);
      await trustBatch(rev, sess.sessionId);
      const [{ id: link }] = await admin(`SELECT id FROM central_needs_need_line_sources WHERE source_record_id = $1`, [sess.recordId]);
      fx.PX = { y, rev, ...sess, line: line.need_line_id as string, link: link as string };
    }
  }, 600000);

  afterAll(async () => { await rig?.end(); });

  // =========================================================================
  // PRE — M217 refuses to apply over unresolved activation preconditions.
  // =========================================================================
  describe('PRE: M217 activation preconditions over 216 history', () => {
    it('a DRAFT holding linked legacy invalid evidence: 217_precondition_failed submitted=0 draft_invalid=1 draft_unsafe_links=1, nothing applied', async () => {
      const r = await tryApplyM217();
      expect(r!.message).toMatch(/^217_precondition_failed/);
      expect(r!.detail).toBe('submitted=0 draft_invalid=1 draft_unsafe_links=1');
      expect(await m217Present()).toBe(false);
      expect(await lifecycleAcl()).toEqual(aclBefore);
    });

    it('the same revision SUBMITTED (canonically, at 216): 217_precondition_failed submitted=1 draft_invalid=0 draft_unsafe_links=0', async () => {
      expect(await call(U_EDIT_A, SUBMIT, [fx.PX.rev])).toMatchObject({ status: 'submitted' });
      const r = await tryApplyM217();
      expect(r!.message).toMatch(/^217_precondition_failed/);
      expect(r!.detail).toBe('submitted=1 draft_invalid=0 draft_unsafe_links=0');
      expect(await m217Present()).toBe(false);
    });

    it('after the governed reject, an UNLINKED legacy invalid record in a DRAFT: submitted=0 draft_invalid=1 draft_unsafe_links=0', async () => {
      expect(await reject(fx.PX.rev, 'resolved before C5 activation')).toMatchObject({ status: 'rejected' });
      const y = nextYear();
      const rev = await openDraft(y);
      const sess = await legacySession(rev, { decision: 'not_applicable' });
      fx.PY = { y, rev, ...sess };
      const r = await tryApplyM217();
      expect(r!.message).toMatch(/^217_precondition_failed/);
      expect(r!.detail).toBe('submitted=0 draft_invalid=1 draft_unsafe_links=0');
      expect(await m217Present()).toBe(false);
      // Resolved the governed way: submitted, then rejected.
      await trustBatch(rev, sess.sessionId);
      await call(U_EDIT_A, SUBMIT, [rev]);
      await reject(rev, 'resolved before C5 activation');
    });
  });

  // =========================================================================
  // THE 217 CHAIN
  // =========================================================================
  describe('on the 217 chain (M217 applied over the seeded history)', () => {
    beforeAll(async () => {
      const rest = migrationFiles().filter((f: string) => Number(f.slice(0, 3)) > 216);
      expect(rest[0]).toBe(M217);
      await rig.asAdmin(async (c: any) => {
        for (const f of rest) await applyMigrationSql(c, f, shimSql(f, readFileSync(join(MIGRATIONS_DIR, f), 'utf8')));
      });
      expect(await m217Present()).toBe(true);
    }, 600000);

    it('M217 left the history exactly as it was, and submit/approve/reject privileges identical', async () => {
      expect(await statuses(fx.D.planId)).toEqual(['1:approved', '2:approved', '3:draft']);
      expect(await statuses(fx.S.planId)).toEqual(['1:superseded', '2:approved']);
      expect(await statuses(fx.C.planId)).toEqual(['1:draft', '2:rejected']);
      expect(await lifecycleAcl()).toEqual(aclBefore);
      const r = await tryApplyM217();
      expect(r).toMatchObject({ message: '217_already_applied' });
    });

    // ---- lifecycle D ------------------------------------------------------
    it('D: the DRAFT target, submitted after 217, is refused central_needs_lifecycle_state_ambiguous "plan=<uuid> holds 2 approved revisions"', async () => {
      const { y, planId, rev3 } = fx.D;
      await toSubmitted(rev3);
      expect(await statuses(planId)).toEqual(['1:approved', '2:approved', '3:submitted']);
      const before = await writeFootprint();
      const r = await refusal(approve(rev3));
      expect(r).toEqual({ code: '23514', message: 'central_needs_lifecycle_state_ambiguous', detail: `plan=${planId} holds 2 approved revisions` });
      expect(await writeFootprint()).toEqual(before);
      expect(await statuses(planId)).toEqual(['1:approved', '2:approved', '3:submitted']);
      expect(await admin(`SELECT id FROM audit_logs WHERE entity_id = $1 AND action IN
                            ('central_needs.plan_revision.approval_gate', 'central_needs.plan_revision.approve')`, [rev3])).toEqual([]);
      // Nothing repairs the ambiguity from the side either.
      expect(await refusal(openCorrection(y, rev3, 'x'))).toMatchObject({ message: 'plan_revision_still_in_review' });
      expect(await writeFootprint()).toEqual(before);
    }, 60000);

    // ---- lifecycle A-E ----------------------------------------------------
    it('A: approving an already approved revision is an idempotent replay that writes nothing (no second gate)', async () => {
      const { rev1 } = await approvedPlan();
      const before = await writeFootprint();
      expect(await approve(rev1)).toEqual({ ok: true, idempotent_replay: true, plan_revision_id: rev1, status: 'approved' });
      expect(await writeFootprint()).toEqual(before);
    }, 60000);

    it('B: a DRAFT is refused plan_revision_not_submitted with DETAIL revision=<id> status=draft', async () => {
      const rev = await openDraft(nextYear());
      const before = await writeFootprint();
      expect(await refusal(approve(rev))).toEqual({
        code: '23514', message: 'plan_revision_not_submitted', detail: `revision=${rev} status=draft` });
      expect(await writeFootprint()).toEqual(before);
    });

    it('C: a submitted revision that is not the newest is refused central_needs_lifecycle_state_ambiguous', async () => {
      const { planId, rev1 } = fx.C;
      await toSubmitted(rev1);
      const before = await writeFootprint();
      expect(await refusal(approve(rev1))).toEqual({
        code: '23514', message: 'central_needs_lifecycle_state_ambiguous',
        detail: `submitted revision=${rev1} (revision 1) is not the newest revision of plan=${planId} (newest 2)` });
      expect(await writeFootprint()).toEqual(before);
      expect(await statuses(planId)).toEqual(['1:submitted', '2:rejected']);
    }, 60000);

    it('E: a correction approve supersedes the single predecessor atomically, with its gate, supersede and approve audits', async () => {
      const { y, rev1, planId } = await approvedPlan();
      const rev2 = (await openCorrection(y, rev1, 'final corrected quantities')).plan_revision_id;
      await toSubmitted(rev2);
      const before = await writeFootprint();
      expect(await approve(rev2)).toMatchObject({ ok: true, status: 'approved', superseded_revision_id: rev1 });
      expect(await statuses(planId)).toEqual(['1:superseded', '2:approved']);
      const after = await writeFootprint();
      expect(after.audits - before.audits).toBe(3);
      expect(after.gates - before.gates).toBe(1);
      const rows = await admin(`SELECT action, entity_id, payload FROM audit_logs WHERE entity_id IN ($1, $2) AND action IN
                                  ('central_needs.plan_revision.approval_gate', 'central_needs.plan_revision.supersede', 'central_needs.plan_revision.approve')
                                ORDER BY action`, [rev1, rev2]);
      const gate = rows.find((r: any) => r.action === 'central_needs.plan_revision.approval_gate' && r.entity_id === rev2);
      const approveRow = rows.find((r: any) => r.action === 'central_needs.plan_revision.approve' && r.entity_id === rev2);
      expect(gate).toMatchObject({ entity_id: rev2 });
      expect(approveRow.payload).toMatchObject({ predecessor_revision_id: rev1, approval_gate_txid: gate.payload.txid });
      expect(rows.find((r: any) => r.action === 'central_needs.plan_revision.supersede')).toMatchObject({ entity_id: rev1 });
    }, 60000);

    it('the fence binds the replayed history: a privileged direct approval of the D target is refused', async () => {
      const r = await refusal(admin(`UPDATE central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`,
        [fx.D.rev3, U_APPROVE_A]));
      expect(r).toEqual({ code: '23514', message: 'central_needs_approval_gate_missing', detail: `revision=${fx.D.rev3}` });
    });

    it('the fence binds pre-C5 SUPERSEDED and REJECTED history: superuser and service_role direct approvals are refused 23514 with zero footprint', async () => {
      // Resurrecting a superseded revision (or a rejected one) to 'approved' is
      // the most realistic privileged post-activation attack; both rows predate
      // the fence (canonical 216 approve/correction/approve and 216 reject).
      const targets: Array<[string, string, string]> = [
        ['superseded', fx.S.rev1, fx.S.planId], ['rejected', fx.PY.rev, await planOf(fx.PY.rev)],
        ['rejected (privileged history row)', (await admin(`SELECT id FROM central_needs_plan_revisions WHERE plan_id = $1 AND revision_number = 2`,
          [fx.C.planId]))[0].id, fx.C.planId],
      ];
      const update = `UPDATE public.central_needs_plan_revisions SET status = 'approved', approved_by = $2, approved_at = now() WHERE id = $1`;
      for (const [from, rev, planId] of targets) {
        const family = await statuses(planId);
        for (const [who, write] of [
          ['superuser', () => admin(update, [rev, U_APPROVE_A])],
          ['service_role', () => service(update, [rev, U_APPROVE_A])],
        ] as const) {
          const before = await writeFootprint();
          expect(await refusal(write()), `${who} from ${from}`).toEqual({
            code: '23514', message: 'central_needs_approval_gate_missing', detail: `revision=${rev}` });
          expect(await writeFootprint(), `${who} from ${from}`).toEqual(before);
        }
        expect(await statuses(planId), from).toEqual(family);
      }
      expect(await statuses(fx.S.planId)).toEqual(['1:superseded', '2:approved']);
    });

    // ---- §7 legacy invalid evidence -----------------------------------------
    it('the CHECK is NOT VALID: the three legacy rows survive; a new one is refused 23514', async () => {
      const legacy = await admin(`SELECT id FROM central_needs_source_records
                                   WHERE public._phoenix_central_needs_review_numeric_class_v1(source_values) = 'invalid_evidence' ORDER BY id`);
      expect(legacy.map((r: any) => r.id).sort()).toEqual([fx.PX.recordId, fx.PY.recordId, fx.PZ.recordId].sort());
      const r = await refusal(admin(
        `INSERT INTO central_needs_source_records (import_session_id, organization_id, record_ordinal, target_entity, field_name, source_values)
         VALUES ($1,$2,2,'sheet:0:row:2','col:2','{"value": 25}'::jsonb)`, [fx.PZ.sessionId, ORG_A]));
      expect(r.code).toBe('23514');
    });

    it('§7.1 is completed-session only: a legacy row in a PROCESSING session is not reported until the session completes', async () => {
      const { rev, sessionId, recordId } = fx.PZ;
      const codes = (await blockers(rev)).map((b: any) => b.blocker);
      expect(codes).toContain('import_session_still_open');
      expect(codes).not.toContain('source_cell_value_contract_invalid');
      await admin(`UPDATE central_needs_import_sessions SET status = 'completed', authoritative_digest = preview_digest, completed_at = now()
                    WHERE id = $1`, [sessionId]);
      expect((await blockers(rev)).filter((b: any) => b.blocker === 'source_cell_value_contract_invalid')).toEqual([
        { blocker: 'source_cell_value_contract_invalid', detail: `session=${sessionId} source_record=${recordId} reason=invalid_evidence` }]);
      const readiness = await call(U_VIEW_A, 'SELECT public.phoenix_central_needs_review_readiness($1) AS result', [rev]);
      expect(readiness.blockers).toContainEqual(
        { blocker: 'source_cell_value_contract_invalid', detail: `session=${sessionId} source_record=${recordId} reason=invalid_evidence` });
    });

    it('§7.1/§7.2 are DRAFT-only: a rejected revision holding legacy invalid evidence (linked or not) reports neither', async () => {
      for (const rev of [fx.PX.rev, fx.PY.rev]) {
        const codes = (await blockers(rev)).map((b: any) => b.blocker);
        expect(codes, rev).not.toContain('source_cell_value_contract_invalid');
        expect(codes, rev).not.toContain('need_line_quantity_lineage_unsafe');
      }
      const [{ reason }] = await admin(`SELECT ${LINEAGE}($1) AS reason`, [fx.PX.link]);
      expect(reason).toBeNull();
    });

    it('a linked legacy source reported as BOTH §7.1 and §7.2 once its revision is (privileged) back in DRAFT; submit refuses', async () => {
      const { rev, sessionId, recordId, line, link } = fx.PX;
      // No canonical path returns a revision to DRAFT; a privileged lifecycle regression is the only way such
      // a row can reach an editable revision after activation. The blockers must still stop it.
      await admin(`UPDATE central_needs_plan_revisions SET status = 'draft' WHERE id = $1`, [rev]);
      const [{ reason }] = await admin(`SELECT ${LINEAGE}($1) AS reason`, [link]);
      expect(reason).toBe('source_cell_value_contract_invalid');
      const bl = await blockers(rev);
      expect(bl).toContainEqual({ blocker: 'source_cell_value_contract_invalid',
        detail: `session=${sessionId} source_record=${recordId} reason=invalid_evidence` });
      expect(bl).toContainEqual({ blocker: 'need_line_quantity_lineage_unsafe',
        detail: `session=${sessionId} source_record=${recordId} need_line=${line} reason=source_cell_value_contract_invalid` });
      const before = await writeFootprint();
      const r = await refusal(call(U_EDIT_A, SUBMIT, [rev]));
      expect(r).toMatchObject({ code: '23514', message: 'plan_revision_not_ready_for_review' });
      expect(r.detail).toMatch(/^blocker=(?:source_cell_value_contract_invalid|need_line_quantity_lineage_unsafe) session=/);
      expect(await writeFootprint()).toEqual(before);
      // The legacy link can be neither re-written nor re-designated: any relevant touch is refused at COMMIT.
      const touch = await refusal(rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          await c.query(`UPDATE central_needs_need_line_sources SET designated_quantity = 25.0 + 0 WHERE id = $1`, [link]);
          await c.query(`UPDATE central_needs_need_line_sources SET applied_override_id = NULL, designated_quantity = 24 WHERE id = $1`, [link]);
          await c.query(`UPDATE central_needs_need_lines SET approved_quantity = 24 WHERE id = $1`, [line]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => undefined);
          throw e;
        }
      }));
      expect(touch).toEqual({ code: '23514', message: 'need_line_quantity_lineage_unsafe',
        detail: `session=${sessionId} source_record=${recordId} need_line=${line} reason=source_cell_value_contract_invalid` });
    });
  });
});
