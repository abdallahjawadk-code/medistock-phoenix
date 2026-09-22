/**
 * C2 / M215 — DYNAMIC proof of the governed correction lifecycle against a real
 * disposable Postgres with 001->215 applied in order.
 *
 * Every revision reaches SUBMITTED through the REAL workflow RPCs (open ->
 * import session -> authoritative replay -> trusted batch -> disposition ->
 * submit); no lifecycle status is seeded by hand except where a test must
 * construct an already-ambiguous state to prove the RPCs refuse it.
 *
 *   T1  open correction           Rev1 APPROVED -> Rev1 APPROVED + Rev2 DRAFT
 *   T2  reject correction          Rev1 APPROVED + Rev2 REJECTED
 *   T3  approve correction         Rev1 SUPERSEDED + Rev2 APPROVED, atomically
 *   T4  correction after rejection Rev1 APPROVED + Rev2 REJECTED + Rev3 DRAFT
 *   T5  approve Rev3               Rev1 SUPERSEDED + Rev2 REJECTED + Rev3 APPROVED
 *   T6  stale expected revision    central_needs_revision_stale, zero writes
 *   T7  blank reason               correction_reason_required, zero writes
 *   T8  legacy open(..., true)     central_needs_governed_correction_required
 *   T9  concurrent openings        exactly one successor
 *   T10 unauthorized               denied
 *   T11 archived organization      denied
 *   T12 history read               correct lineage, zero cross-org leakage
 *   T13 new/current annual draft   unchanged
 *   Concurrency A-E and privileges.
 *
 * Gated on PHOENIX_RIG_PG; skipped when no database is configured.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-000000215001';
const ORG_B = '00000000-0000-0000-0000-000000215002';
const ORG_ARCH = '00000000-0000-0000-0000-000000215003';

const U_EDIT_A = '00000000-0000-0000-0000-000000215401';    // view/import/edit
const U_APPROVE_A = '00000000-0000-0000-0000-000000215402'; // view/approve
const U_VIEW_A = '00000000-0000-0000-0000-000000215403';    // view only
const U_NONE_A = '00000000-0000-0000-0000-000000215404';    // eligible role, no key
const U_INST_A = '00000000-0000-0000-0000-000000215405';    // ineligible role, every key
const U_ALL_B = '00000000-0000-0000-0000-000000215406';     // every key, organization B
const U_ALL_ARCH = '00000000-0000-0000-0000-000000215407';  // every key, archived organization

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
const HISTORY = 'SELECT public.phoenix_central_needs_revision_lifecycle($1,$2) AS result';

type Rev = { id: string; n: number; status: string; approved: boolean };

run('C2/M215 governed correction lifecycle — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let year = 2039;
  const nextYear = () => (year += 1);

  const call = (userId: string | null, sql: string, params: unknown[] = [], role = 'authenticated') =>
    rig.asUser(userId, (c: any) => c.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      { role, commit: true });
  const service = (sql: string, params: unknown[] = []) => call(null, sql, params, 'service_role');
  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));

  /** An explicitly held transaction, for deterministic interleavings. */
  const tx = async (userId: string | null, role = 'authenticated') => {
    const client = await rig.pool.connect();
    let open = true;
    await client.query('BEGIN');
    await client.query(`SET LOCAL ROLE ${role}`);
    await client.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [userId ?? '']);
    const finish = async (verb: 'COMMIT' | 'ROLLBACK') => {
      if (!open) return;
      open = false;
      try { await client.query(verb); } finally { client.release(); }
    };
    return {
      q: (sql: string, params: unknown[] = []) =>
        client.query(sql, params).then((r: any) => r.rows[0]?.result ?? r.rows[0]),
      commit: () => finish('COMMIT'),
      rollback: () => finish('ROLLBACK').catch(() => undefined),
    };
  };

  const revisions = async (org: string, y: number): Promise<Rev[]> =>
    (await admin(
      `SELECT r.id, r.revision_number AS n, r.status, r.approved_by IS NOT NULL AS approved
         FROM central_needs_plan_revisions r JOIN central_needs_plans p ON p.id = r.plan_id
        WHERE p.organization_id = $1 AND p.plan_year = $2 ORDER BY r.revision_number`, [org, y])) as Rev[];
  const statuses = async (org: string, y: number) => (await revisions(org, y)).map((r) => `${r.n}:${r.status}`);
  const approvedCount = async (org: string, y: number) =>
    (await revisions(org, y)).filter((r) => r.status === 'approved').length;
  const auditCount = async () => Number((await admin(`SELECT count(*)::int AS n FROM audit_logs`))[0].n);
  const writeFootprint = async () => {
    const [row] = await admin(
      `SELECT (SELECT count(*) FROM central_needs_plan_revisions)::int AS revs,
              (SELECT count(*) FROM central_needs_plans)::int AS plans,
              (SELECT count(*) FROM audit_logs)::int AS audits,
              (SELECT md5(string_agg(id::text || status || updated_at::text, ',' ORDER BY id))
                 FROM central_needs_plan_revisions) AS state`);
    return row;
  };

  /** Drives a DRAFT to SUBMITTED through the real workflow RPCs. */
  const toSubmitted = async (revisionId: string, org = ORG_A, editor = U_EDIT_A) => {
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
    const s = await call(editor, `SELECT public.phoenix_central_needs_submit_revision($1) AS result`, [revisionId]);
    expect(s.status).toBe('submitted');
    void org;
  };

  const openDraft = async (org: string, y: number, user = U_EDIT_A): Promise<string> =>
    (await call(user, OPEN_DRAFT, [org, y, false])).plan_revision_id as string;
  const openCorrection = (user: string, org: string, y: number, expected: string | null, reason: string | null) =>
    call(user, OPEN_CORRECTION, [org, y, expected, reason]);
  const approve = (rev: string, user = U_APPROVE_A) => call(user, APPROVE, [rev]);
  const reject = (rev: string, reason = 'figures do not match the hospital return', user = U_APPROVE_A) =>
    call(user, REJECT, [rev, reason]);

  /** Rev1 APPROVED through the real workflow. */
  const approvedPlan = async (org = ORG_A, editor = U_EDIT_A, approver = U_APPROVE_A) => {
    const y = nextYear();
    const rev1 = await openDraft(org, y, editor);
    await toSubmitted(rev1, org, editor);
    const a = await approve(rev1, approver);
    expect(a).toMatchObject({ ok: true, status: 'approved', superseded_revision_id: null });
    return { y, rev1 };
  };

  beforeAll(async () => {
    rig = await buildRig({ upTo: 215 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id,name,name_ar,code,organization_kind,institution_class) VALUES
        ('${ORG_A}','C2-A','أ','p215-a','care_institution','hospital'),
        ('${ORG_B}','C2-B','ب','p215-b','care_institution','hospital'),
        ('${ORG_ARCH}','C2-ARCH','ج','p215-arch','care_institution','hospital')`);
      await c.query(`INSERT INTO auth.users (id,email) VALUES
        ('${U_EDIT_A}','p215-edit-a@rig'),('${U_APPROVE_A}','p215-approve-a@rig'),('${U_VIEW_A}','p215-view-a@rig'),
        ('${U_NONE_A}','p215-none-a@rig'),('${U_INST_A}','p215-inst-a@rig'),('${U_ALL_B}','p215-all-b@rig'),
        ('${U_ALL_ARCH}','p215-all-arch@rig')`);
      for (const [u, org, role] of [
        [U_EDIT_A, ORG_A, 'central_warehouse_manager'], [U_APPROVE_A, ORG_A, 'central_warehouse_manager'],
        [U_VIEW_A, ORG_A, 'central_warehouse_manager'], [U_NONE_A, ORG_A, 'central_warehouse_manager'],
        [U_INST_A, ORG_A, 'institution_admin'], [U_ALL_B, ORG_B, 'central_warehouse_manager'],
        [U_ALL_ARCH, ORG_ARCH, 'central_warehouse_manager'],
      ] as const) {
        await c.query(`UPDATE profiles SET role=$1,status='active',organization_id=$2 WHERE id=$3`, [role, org, u]);
      }
      const grants: Array<[string, string[]]> = [
        [U_EDIT_A, ['view', 'import', 'edit']],
        [U_APPROVE_A, ['view', 'approve']],
        [U_VIEW_A, ['view']],
        [U_INST_A, ['view', 'import', 'edit', 'approve']],
        [U_ALL_B, ['view', 'import', 'edit', 'approve']],
        [U_ALL_ARCH, ['view', 'import', 'edit', 'approve']],
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

  afterAll(async () => { if (rig) await rig.end(); });

  // ── T1-T5: the lifecycle ─────────────────────────────────────────────────
  describe('T1-T5 lifecycle', () => {
    it('T1 opening a correction keeps Rev1 APPROVED and adds Rev2 DRAFT', async () => {
      const { y, rev1 } = await approvedPlan();
      const r = await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'hospital resubmitted its annual return');
      expect(r).toMatchObject({
        ok: true, revision_number: 2, status: 'draft',
        opened_after_revision_id: rev1, opened_after_status: 'approved', effective_approved_revision_id: rev1,
        correction_reason: 'hospital resubmitted its annual return',
      });
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:draft']);
      expect(await approvedCount(ORG_A, y)).toBe(1);
    });

    it('T2 rejecting a submitted correction keeps Rev1 APPROVED', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'correct the ICU quantities')).plan_revision_id;
      await toSubmitted(rev2);
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:submitted']);
      const r = await reject(rev2);
      expect(r).toMatchObject({ ok: true, status: 'rejected', effective_approved_revision_id: rev1 });
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:rejected']);
      const [audit] = await admin(
        `SELECT payload FROM audit_logs WHERE action='central_needs.plan_revision.reject' AND entity_id=$1`, [rev2]);
      expect(audit.payload).toMatchObject({ effective_approved_revision_id: rev1, from_status: 'submitted', to_status: 'rejected' });
    });

    it('T3 approving a correction supersedes Rev1 and approves Rev2 in one transaction', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'final corrected annual quantities')).plan_revision_id;
      await toSubmitted(rev2);

      // Held approval: until it commits, every other session sees the OLD state
      // (Rev1 approved, Rev2 submitted) — never a half switch.
      const t = await tx(U_APPROVE_A);
      try {
        const r = await t.q(APPROVE, [rev2]);
        expect(r).toMatchObject({ ok: true, status: 'approved', superseded_revision_id: rev1 });
        expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:submitted']);
        await t.commit();
      } finally { await t.rollback(); }
      expect(await statuses(ORG_A, y)).toEqual(['1:superseded', '2:approved']);
      expect(await approvedCount(ORG_A, y)).toBe(1);
      const r1 = (await revisions(ORG_A, y)).find((r) => r.n === 1)!;
      expect(r1.approved).toBe(true); // the historical approval of Rev1 is kept

      const rows = await admin(
        `SELECT action, entity_id, payload FROM audit_logs
          WHERE action IN ('central_needs.plan_revision.supersede','central_needs.plan_revision.approve')
            AND entity_id IN ($1,$2) ORDER BY action`, [rev1, rev2]);
      const approveRow = rows.find((x: any) => x.action === 'central_needs.plan_revision.approve' && x.entity_id === rev2);
      const supersedeRow = rows.find((x: any) => x.action === 'central_needs.plan_revision.supersede');
      expect(approveRow.payload).toMatchObject({ predecessor_revision_id: rev1, predecessor_from_status: 'approved', predecessor_to_status: 'superseded' });
      expect(supersedeRow).toMatchObject({ entity_id: rev1 });
      expect(supersedeRow.payload).toMatchObject({ superseded_by_revision_id: rev2, from_status: 'approved', to_status: 'superseded' });
    }, 30000);

    it('T3 atomicity: a failure after the supersede rolls the whole switch back', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'probe the rollback')).plan_revision_id;
      await toSubmitted(rev2);
      const before = await writeFootprint();
      // A NOT VALID check that refuses ONLY the approve audit row: the function
      // reaches it after BOTH status updates, so a partial commit would show.
      await admin(`ALTER TABLE public.audit_logs ADD CONSTRAINT c2_probe_block_approve
                     CHECK (action <> 'central_needs.plan_revision.approve') NOT VALID`);
      try {
        await expect(approve(rev2)).rejects.toMatchObject({ code: '23514' });
      } finally {
        await admin(`ALTER TABLE public.audit_logs DROP CONSTRAINT c2_probe_block_approve`);
      }
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:submitted']);
      expect(await writeFootprint()).toEqual(before);
    }, 30000);

    it('T4/T5 a correction after a rejection, then its approval', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'first attempt')).plan_revision_id;
      await toSubmitted(rev2);
      await reject(rev2);
      const o3 = await openCorrection(U_EDIT_A, ORG_A, y, rev2, 'second attempt after the rejection');
      expect(o3).toMatchObject({
        revision_number: 3, status: 'draft',
        opened_after_revision_id: rev2, opened_after_status: 'rejected', effective_approved_revision_id: rev1,
      });
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:rejected', '3:draft']);
      await toSubmitted(o3.plan_revision_id);
      const a = await approve(o3.plan_revision_id);
      expect(a).toMatchObject({ status: 'approved', superseded_revision_id: rev1 });
      expect(await statuses(ORG_A, y)).toEqual(['1:superseded', '2:rejected', '3:approved']);
      expect(await approvedCount(ORG_A, y)).toBe(1);
    }, 30000);

    it('a plan whose only revision was rejected can still be corrected, with no effective revision to keep', async () => {
      const y = nextYear();
      const rev1 = await openDraft(ORG_A, y);
      await toSubmitted(rev1);
      await reject(rev1);
      const o2 = await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'the first submission was incomplete');
      expect(o2).toMatchObject({ revision_number: 2, opened_after_status: 'rejected', effective_approved_revision_id: null });
      await toSubmitted(o2.plan_revision_id);
      expect(await approve(o2.plan_revision_id)).toMatchObject({ status: 'approved', superseded_revision_id: null });
      expect(await statuses(ORG_A, y)).toEqual(['1:rejected', '2:approved']);
    }, 30000);
  });

  // ── T6-T8: fences ────────────────────────────────────────────────────────
  describe('T6-T8 fences', () => {
    it('T6 a stale expected revision fails with central_needs_revision_stale and writes nothing', async () => {
      const { y, rev1 } = await approvedPlan();
      await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'first tab');
      const before = await writeFootprint();
      await expect(openCorrection(U_EDIT_A, ORG_A, y, rev1, 'second, stale tab'))
        .rejects.toMatchObject({ code: '23514', message: 'central_needs_revision_stale' });
      expect(await writeFootprint()).toEqual(before);
    });

    it('T6 an expected revision of another plan year is refused as a plan mismatch, writing nothing', async () => {
      const a = await approvedPlan();
      const b = await approvedPlan();
      const before = await writeFootprint();
      await expect(openCorrection(U_EDIT_A, ORG_A, a.y, b.rev1, 'wrong year'))
        .rejects.toMatchObject({ message: 'central_needs_correction_plan_mismatch' });
      await expect(openCorrection(U_EDIT_A, ORG_A, a.y, '00000000-0000-0000-0000-00000000dead', 'unknown revision'))
        .rejects.toMatchObject({ message: 'central_needs_correction_plan_mismatch' });
      expect(await writeFootprint()).toEqual(before);
    });

    it('T7 NULL, empty and whitespace-only reasons are refused and write nothing', async () => {
      const { y, rev1 } = await approvedPlan();
      const before = await writeFootprint();
      // ASCII controls, NBSP, zero-width space, RTL mark and the ideographic
      // space are all "blank" to a human: btrim() alone would let most through.
      for (const reason of [null, '', '   ', '\t\n ', '\r\n\t', ' ​‏', '　 ﻿']) {
        await expect(openCorrection(U_EDIT_A, ORG_A, y, rev1, reason))
          .rejects.toMatchObject({ code: '23514', message: 'correction_reason_required' });
      }
      await expect(openCorrection(U_EDIT_A, ORG_A, y, null, 'no expected revision'))
        .rejects.toMatchObject({ message: 'expected_latest_revision_id_required' });
      expect(await writeFootprint()).toEqual(before);
    });

    it('T7 the accepted reason is audited exactly, trimmed', async () => {
      const { y, rev1 } = await approvedPlan();
      const r = await openCorrection(U_EDIT_A, ORG_A, y, rev1, '   quantities re-counted by pharmacy   ');
      expect(r.correction_reason).toBe('quantities re-counted by pharmacy');
      const [row] = await admin(
        `SELECT actor_id, organization_id, payload FROM audit_logs
          WHERE action='central_needs.plan_revision.open_correction' AND entity_id=$1`, [r.plan_revision_id]);
      expect(row.actor_id).toBe(U_EDIT_A);
      expect(row.organization_id).toBe(ORG_A);
      expect(row.payload).toMatchObject({
        organization_id: ORG_A, plan_year: y, correction_reason: 'quantities re-counted by pharmacy',
        opened_after_revision_id: rev1, new_revision_id: r.plan_revision_id, effective_approved_revision_id: rev1,
      });
    });

    it('T8 the legacy open_plan_revision(..., true) and (..., NULL) paths fail closed with no write', async () => {
      const { y } = await approvedPlan();
      const fresh = nextYear();
      const before = await writeFootprint();
      for (const [yy, flag] of [[y, true], [y, null], [fresh, true]] as const) {
        await expect(call(U_EDIT_A, OPEN_DRAFT, [ORG_A, yy, flag]))
          .rejects.toMatchObject({ code: '23514', message: 'central_needs_governed_correction_required' });
      }
      expect(await writeFootprint()).toEqual(before);
      expect(await revisions(ORG_A, fresh)).toEqual([]);
      expect(await statuses(ORG_A, y)).toEqual(['1:approved']);
    });
  });

  // ── T9 + concurrency A-E ─────────────────────────────────────────────────
  describe('T9 / concurrency', () => {
    it('A/T9 two concurrent openings from the same expected revision create exactly one successor', async () => {
      const { y, rev1 } = await approvedPlan();
      const t1 = await tx(U_EDIT_A);
      const t2 = await tx(U_EDIT_A);
      try {
        const first = await t1.q(OPEN_CORRECTION, [ORG_A, y, rev1, 'user one']);
        let settled = false;
        const second = t2.q(OPEN_CORRECTION, [ORG_A, y, rev1, 'user two']).finally(() => { settled = true; });
        second.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 400));
        expect(settled).toBe(false); // blocked on the family lock, not racing
        await t1.commit();
        await expect(second).rejects.toMatchObject({ message: 'central_needs_revision_stale' });
        expect(first.revision_number).toBe(2);
      } finally { await t1.rollback(); await t2.rollback(); }
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:draft']);
    }, 30000);

    it('A/T9 unsynchronized parallel openings still yield exactly one successor', async () => {
      const { y, rev1 } = await approvedPlan();
      const results = await Promise.allSettled([1, 2, 3, 4].map((i) => openCorrection(U_EDIT_A, ORG_A, y, rev1, `parallel ${i}`)));
      expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
      for (const r of results.filter((x) => x.status === 'rejected') as PromiseRejectedResult[]) {
        expect(r.reason).toMatchObject({ message: 'central_needs_revision_stale' });
      }
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:draft']);
    }, 30000);

    it('B a stale browser tab gets central_needs_revision_stale and writes nothing', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'tab one')).plan_revision_id;
      await toSubmitted(rev2);
      await reject(rev2);
      const before = await writeFootprint();
      // The stale tab still believes Rev1 is the newest revision.
      await expect(openCorrection(U_EDIT_A, ORG_A, y, rev1, 'stale tab'))
        .rejects.toMatchObject({ message: 'central_needs_revision_stale' });
      expect(await writeFootprint()).toEqual(before);
    }, 30000);

    it('C approval racing a rejection of the same correction: exactly one decision wins', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'race')).plan_revision_id;
      await toSubmitted(rev2);
      const tA = await tx(U_APPROVE_A);
      const tR = await tx(U_APPROVE_A);
      try {
        await tA.q(APPROVE, [rev2]);
        const rejecting = tR.q(REJECT, [rev2, 'too late']);
        rejecting.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 300));
        await tA.commit();
        await expect(rejecting).rejects.toMatchObject({ message: 'plan_revision_not_submitted' });
      } finally { await tA.rollback(); await tR.rollback(); }
      expect(await statuses(ORG_A, y)).toEqual(['1:superseded', '2:approved']);
      expect(await approvedCount(ORG_A, y)).toBe(1);
    }, 30000);

    it('C a correction opened while an approval is in flight waits, then builds on the committed state', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'race two')).plan_revision_id;
      await toSubmitted(rev2);
      const tA = await tx(U_APPROVE_A);
      const tC = await tx(U_EDIT_A);
      try {
        await tA.q(APPROVE, [rev2]);
        const opening = tC.q(OPEN_CORRECTION, [ORG_A, y, rev2, 'after the approval']);
        opening.catch(() => undefined);
        await new Promise((r) => setTimeout(r, 300));
        await tA.commit();
        const o = await opening;
        expect(o).toMatchObject({ revision_number: 3, effective_approved_revision_id: rev2, opened_after_status: 'approved' });
        await tC.commit();
      } finally { await tA.rollback(); await tC.rollback(); }
      expect(await statuses(ORG_A, y)).toEqual(['1:superseded', '2:approved', '3:draft']);
      expect(await approvedCount(ORG_A, y)).toBe(1);
    }, 30000);

    it('C a correction cannot be opened while the newest revision is still in review', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'in review')).plan_revision_id;
      await toSubmitted(rev2);
      await expect(openCorrection(U_EDIT_A, ORG_A, y, rev2, 'too early'))
        .rejects.toMatchObject({ message: 'plan_revision_still_in_review' });
      const d = await approvedPlan();
      const draft = (await openCorrection(U_EDIT_A, ORG_A, d.y, d.rev1, 'draft open')).plan_revision_id;
      await expect(openCorrection(U_EDIT_A, ORG_A, d.y, draft, 'second draft'))
        .rejects.toMatchObject({ message: 'plan_revision_draft_already_open' });
    }, 30000);

    it('D a duplicate correction request cannot create a second next revision', async () => {
      const { y, rev1 } = await approvedPlan();
      await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'once');
      await expect(openCorrection(U_EDIT_A, ORG_A, y, rev1, 'once'))
        .rejects.toMatchObject({ message: 'central_needs_revision_stale' });
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:draft']);
    });

    it('E concurrent approvals of one correction leave exactly one approved revision', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'double click')).plan_revision_id;
      await toSubmitted(rev2);
      const results = await Promise.all([approve(rev2), approve(rev2)]);
      expect(results.filter((r: any) => r.idempotent_replay === false)).toHaveLength(1);
      expect(results.filter((r: any) => r.idempotent_replay === true)).toHaveLength(1);
      expect(await statuses(ORG_A, y)).toEqual(['1:superseded', '2:approved']);
    }, 30000);

    it('E an already-ambiguous plan (two approved) fails closed and is not repaired', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'ambiguity probe')).plan_revision_id;
      await toSubmitted(rev2);
      const rev3Row = await admin(
        `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, approved_by, approved_at)
         SELECT plan_id, organization_id, 3, 'submitted', NULL, NULL FROM central_needs_plan_revisions WHERE id = $1
         RETURNING id`, [rev1]);
      // Seed the impossible state by hand: Rev2 approved beside Rev1.
      await admin(`UPDATE central_needs_plan_revisions SET status='approved', approved_by=$2, approved_at=now() WHERE id=$1`, [rev2, U_APPROVE_A]);
      const before = await writeFootprint();
      await expect(approve(rev3Row[0].id)).rejects.toMatchObject({ message: 'central_needs_lifecycle_state_ambiguous' });
      await expect(openCorrection(U_EDIT_A, ORG_A, y, rev3Row[0].id, 'x'))
        .rejects.toMatchObject({ message: 'plan_revision_still_in_review' });
      expect(await writeFootprint()).toEqual(before);
      expect(await statuses(ORG_A, y)).toEqual(['1:approved', '2:approved', '3:submitted']);
    }, 30000);
  });

  // ── T10-T11: authorization ───────────────────────────────────────────────
  describe('T10-T11 authorization', () => {
    it('T10 callers without the edit authority cannot open a correction', async () => {
      const { y, rev1 } = await approvedPlan();
      const before = await writeFootprint();
      await expect(openCorrection(U_NONE_A, ORG_A, y, rev1, 'r')).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(openCorrection(U_VIEW_A, ORG_A, y, rev1, 'r')).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(openCorrection(U_APPROVE_A, ORG_A, y, rev1, 'r')).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(openCorrection(U_INST_A, ORG_A, y, rev1, 'r')).rejects.toMatchObject({ message: 'forbidden_central_needs_role' });
      await expect(openCorrection(U_ALL_B, ORG_A, y, rev1, 'r')).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(call(null, OPEN_CORRECTION, [ORG_A, y, rev1, 'r'])).rejects.toMatchObject({ message: 'not_authenticated' });
      await expect(call(null, OPEN_CORRECTION, [ORG_A, y, rev1, 'r'], 'anon'))
        .rejects.toMatchObject({ code: '42501', message: expect.stringContaining('permission denied for function phoenix_central_needs_open_correction_revision') });
      expect(await writeFootprint()).toEqual(before);
    });

    it('T10 approval and rejection keep central_needs.approve; edit is not enough', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'authority')).plan_revision_id;
      await toSubmitted(rev2);
      const before = await writeFootprint();
      await expect(approve(rev2, U_EDIT_A)).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(reject(rev2, 'no', U_EDIT_A)).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(approve(rev2, U_ALL_B)).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(reject(rev2, '   ')).rejects.toMatchObject({ message: 'rejection_reason_required' });
      // M210's btrim() accepted a tab/newline-only rejection reason; M215 does not.
      await expect(reject(rev2, '\t\n')).rejects.toMatchObject({ message: 'rejection_reason_required' });
      expect(await writeFootprint()).toEqual(before);
    }, 30000);

    it('T11 an archived organization cannot open, approve or reject a correction', async () => {
      const y = nextYear();
      const rev1 = await openDraft(ORG_ARCH, y, U_ALL_ARCH);
      await toSubmitted(rev1, ORG_ARCH, U_ALL_ARCH);
      await approve(rev1, U_ALL_ARCH);
      const rev2 = (await openCorrection(U_ALL_ARCH, ORG_ARCH, y, rev1, 'before archive')).plan_revision_id;
      await toSubmitted(rev2, ORG_ARCH, U_ALL_ARCH);
      await admin(`UPDATE organizations SET status='inactive' WHERE id=$1`, [ORG_ARCH]);
      const [{ archived_at }] = await admin(`SELECT archived_at FROM organizations WHERE id=$1`, [ORG_ARCH]);
      expect(archived_at).not.toBeNull();
      const before = await writeFootprint();
      const blocked = { message: 'central_needs_write_blocked_by_archived_organization' };
      await expect(approve(rev2, U_ALL_ARCH)).rejects.toMatchObject(blocked);
      await expect(reject(rev2, 'no', U_ALL_ARCH)).rejects.toMatchObject(blocked);
      await expect(openCorrection(U_ALL_ARCH, ORG_ARCH, y, rev1, 'after archive')).rejects.toMatchObject(blocked);
      await expect(call(U_ALL_ARCH, OPEN_DRAFT, [ORG_ARCH, nextYear(), false])).rejects.toMatchObject(blocked);
      expect(await writeFootprint()).toEqual(before);
      expect(await statuses(ORG_ARCH, y)).toEqual(['1:approved', '2:submitted']);
    }, 30000);
  });

  // ── T12: lifecycle history ───────────────────────────────────────────────
  describe('T12 lifecycle history read', () => {
    it('returns the full lineage of one plan and nothing from another organization', async () => {
      const { y, rev1 } = await approvedPlan();
      const rev2 = (await openCorrection(U_EDIT_A, ORG_A, y, rev1, 'first correction')).plan_revision_id;
      await toSubmitted(rev2);
      await reject(rev2, 'numbers still wrong');
      const rev3 = (await openCorrection(U_EDIT_A, ORG_A, y, rev2, 'second correction')).plan_revision_id;
      await toSubmitted(rev3);
      await approve(rev3);

      // Same plan year in organization B, with its own history.
      const b1 = await openDraft(ORG_B, y, U_ALL_B);
      await toSubmitted(b1, ORG_B, U_ALL_B);
      await approve(b1, U_ALL_B);
      await openCorrection(U_ALL_B, ORG_B, y, b1, 'organization B correction');

      const h = await call(U_VIEW_A, HISTORY, [ORG_A, y]);
      expect(h).toMatchObject({ ok: true, organization_id: ORG_A, plan_year: y, effective_revision_id: rev3 });
      expect(h.revisions.map((r: any) => `${r.revision_number}:${r.status}:${r.effective}`))
        .toEqual(['1:superseded:false', '2:rejected:false', '3:approved:true']);
      const ids = new Set([rev1, rev2, rev3]);
      for (const e of h.events) expect(ids.has(e.revision_id)).toBe(true);
      expect(h.events.map((e: any) => `${e.action.replace('central_needs.plan_revision.', '')}:${e.revision_number}`)).toEqual([
        'open:1', 'submit:1', 'approve:1',
        'open_correction:2', 'submit:2', 'reject:2',
        'open_correction:3', 'submit:3', 'supersede:1', 'approve:3',
      ]);
      const oc2 = h.events.find((e: any) => e.action.endsWith('open_correction') && e.revision_id === rev2);
      expect(oc2).toMatchObject({ reason: 'first correction', opened_after_revision_id: rev1, effective_approved_revision_id: rev1, actor_id: U_EDIT_A });
      const oc3 = h.events.find((e: any) => e.action.endsWith('open_correction') && e.revision_id === rev3);
      expect(oc3).toMatchObject({ reason: 'second correction', opened_after_revision_id: rev2, effective_approved_revision_id: rev1 });
      expect(h.events.find((e: any) => e.action.endsWith('reject'))).toMatchObject({ reason: 'numbers still wrong', revision_id: rev2 });
      expect(h.events.find((e: any) => e.action.endsWith('supersede'))).toMatchObject({ revision_id: rev1, superseded_by_revision_id: rev3 });
      expect(h.events.find((e: any) => e.action.endsWith('approve') && e.revision_id === rev3))
        .toMatchObject({ predecessor_revision_id: rev1, actor_id: U_APPROVE_A });
      expect(JSON.stringify(h)).not.toContain('organization B correction');
      expect(JSON.stringify(h)).not.toContain(b1);

      // Cross-organization and unauthorized reads are refused outright.
      await expect(call(U_ALL_B, HISTORY, [ORG_A, y])).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(call(U_NONE_A, HISTORY, [ORG_A, y])).rejects.toMatchObject({ message: 'forbidden_central_needs' });
      await expect(call(U_INST_A, HISTORY, [ORG_A, y])).rejects.toMatchObject({ message: 'forbidden_central_needs_role' });
      await expect(call(null, HISTORY, [ORG_A, y], 'anon')).rejects.toMatchObject({ code: '42501' });
      // A year without a plan is an empty answer, not an error.
      expect(await call(U_VIEW_A, HISTORY, [ORG_A, nextYear()])).toMatchObject({ ok: true, plan_id: null, revisions: [], events: [] });
    }, 60000);
  });

  // ── T13: new / current annual draft is unchanged ─────────────────────────
  describe('T13 new/current annual draft', () => {
    it('first draft, idempotent reuse, and refusal once closed or in review', async () => {
      const y = nextYear();
      const o1 = await call(U_EDIT_A, OPEN_DRAFT, [ORG_A, y, false]);
      expect(o1).toMatchObject({ ok: true, idempotent_replay: false, revision_number: 1, status: 'draft', previous_revision_id: null });
      const again = await call(U_EDIT_A, OPEN_DRAFT, [ORG_A, y, false]);
      expect(again).toMatchObject({ idempotent_replay: true, plan_revision_id: o1.plan_revision_id });
      const dflt = await call(U_EDIT_A, 'SELECT public.phoenix_central_needs_open_plan_revision($1,$2) AS result', [ORG_A, y]);
      expect(dflt).toMatchObject({ idempotent_replay: true, plan_revision_id: o1.plan_revision_id });
      await toSubmitted(o1.plan_revision_id);
      await expect(call(U_EDIT_A, OPEN_DRAFT, [ORG_A, y, false])).rejects.toMatchObject({ message: 'plan_revision_still_in_review' });
      await approve(o1.plan_revision_id);
      await expect(call(U_EDIT_A, OPEN_DRAFT, [ORG_A, y, false])).rejects.toMatchObject({ message: 'plan_revision_already_closed' });
      expect(await statuses(ORG_A, y)).toEqual(['1:approved']);
      const [row] = await admin(
        `SELECT payload FROM audit_logs WHERE action='central_needs.plan_revision.open' AND entity_id=$1`, [o1.plan_revision_id]);
      expect(row.payload).toMatchObject({ plan_year: y, revision_number: 1, previous_revision_id: null });
    }, 30000);
  });

  // ── Privileges ───────────────────────────────────────────────────────────
  describe('privileges', () => {
    const can = async (role: string, sig: string) =>
      (await admin(`SELECT has_function_privilege($1, $2, 'EXECUTE') AS ok`, [role, sig]))[0].ok as boolean;
    it('client RPCs are authenticated-only; the family lock is internal', async () => {
      for (const sig of [
        'public.phoenix_central_needs_open_correction_revision(uuid, integer, uuid, text)',
        'public.phoenix_central_needs_revision_lifecycle(uuid, integer)',
        'public.phoenix_central_needs_open_plan_revision(uuid, integer, boolean)',
        'public.phoenix_central_needs_approve_revision(uuid)',
        'public.phoenix_central_needs_reject_revision(uuid, text)',
      ]) {
        expect(await can('authenticated', sig), sig).toBe(true);
        expect(await can('anon', sig), sig).toBe(false);
      }
      const lock = 'public._phoenix_central_needs_lock_plan_family_v1(uuid, integer)';
      expect(await can('authenticated', lock)).toBe(false);
      expect(await can('anon', lock)).toBe(false);
      const [{ n }] = await admin(`SELECT count(*)::int AS n FROM pg_proc WHERE proname = 'phoenix_central_needs_open_plan_revision'`);
      expect(n).toBe(1); // same single signature as M210
    });
  });
});
