/**
 * OPS2-F1 — GOVERNED WAREHOUSE CORRECTION — DYNAMIC acceptance suite, against a real
 * disposable Postgres replaying the FULL chain (001->latest).
 *
 * Invariant under test: holding warehouse_stock.correct is never unilateral approval.
 * A caller-chosen warehouse quantity target ('correction' / 'set_exact') can be posted
 * only through phoenix_request_warehouse_stock_correction within the organization's
 * variance threshold, or through phoenix_approve_warehouse_stock_correction by a
 * different, authorized person. Every other stock operation is unchanged.
 *
 * Until the OPS2-F1 migration is part of the chain, the security assertions here FAIL
 * against 001->latest (reproduction); with it they pass. Gated on PHOENIX_RIG_PG.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-00000f2f1001';   // care institution
const ORG_B = '00000000-0000-0000-0000-00000f2f1002';   // second care institution
const ORG_P = '00000000-0000-0000-0000-00000f2f1003';   // pharmacy department authority
const WH_A = '00000000-0000-0000-0000-00000f2f1101';    // institution warehouse of A
const WH_B = '00000000-0000-0000-0000-00000f2f1102';    // institution warehouse of B
const WH_P = '00000000-0000-0000-0000-00000f2f1103';    // central warehouse of P

const OFF_A = '00000000-0000-0000-0000-00000f2f1401';   // warehouse_officer, WH_A
const OFF_A2 = '00000000-0000-0000-0000-00000f2f1402';  // second warehouse_officer, WH_A
const IA_A = '00000000-0000-0000-0000-00000f2f1403';    // institution_admin, A
const OFF_B = '00000000-0000-0000-0000-00000f2f1404';   // warehouse_officer, WH_B
const CWM_P = '00000000-0000-0000-0000-00000f2f1405';   // central_warehouse_manager, WH_P
const DEL = '00000000-0000-0000-0000-00000f2f1406';     // warehouse_officer of A, delegated into WH_B
const OFF_R = '00000000-0000-0000-0000-00000f2f1407';   // warehouse_officer, WH_A — revocation subject
const OFF_S = '00000000-0000-0000-0000-00000f2f1408';   // warehouse_officer, WH_A — suspension subject

const GOVERNED = /warehouse_correction_requires_governed_request/;
const APPLIER = 'public._phoenix_apply_governed_warehouse_correction(uuid,uuid,integer,text,bigint,text,text)';
const CANONICAL = 'public.phoenix_apply_warehouse_stock_movement(uuid,uuid,text,integer,text,text,text,text)';

run('OPS2-F1 governed warehouse correction — dynamic acceptance', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let SUPER = '';

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);
  const as = (user: string, fn: string, args: any[], commit = true) =>
    rig.asUser(user, (c: any) => call(c, fn, args), { commit });
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e: any) { return { code: e.code as string, message: String(e.message) }; }
    throw new Error('expected a refusal, but the call succeeded');
  };
  const admin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));

  const newLot = async (org: string, wh: string, qty: number, central = false) => {
    const id = randomUUID();
    await admin(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code,
        has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq${central ? ', supply_type, purchase_origin' : ''})
      VALUES ($1,$2,$3,$4,true,false,$5,$6,0,0${central ? ",'purchase','central'" : ''})`,
    [id, org, wh, `OPS2F1-${id.slice(0, 8)}`, `B-${id.slice(0, 6)}`, qty]);
    return id;
  };
  const snapshot = async (lot: string) => (await admin(
    `SELECT (SELECT on_hand_quantity FROM warehouse_stock WHERE id=$1) AS qty,
            (SELECT movement_seq FROM warehouse_stock WHERE id=$1) AS seq,
            (SELECT count(*)::int FROM warehouse_stock_movements WHERE warehouse_stock_id=$1) AS moves,
            (SELECT count(*)::int FROM audit_logs WHERE entity_id=$1) AS audits,
            (SELECT count(*)::int FROM phoenix_warehouse_correction_requests WHERE warehouse_stock_id=$1) AS requests`,
    [lot])).rows[0];
  const setThreshold = (org: string, t: number) => as(SUPER, 'phoenix_set_variance_approval_policy', [org, t]);
  const P1 = (user: string, lot: string, type: string, amount: number, id = randomUUID(), reason: string | null = 'ops2f1 direct',
    gen: number | null = null, sourceDoc: string | null = null) =>
    as(user, 'phoenix_apply_warehouse_stock_movement_guarded', [id, lot, type, amount, reason, gen, sourceDoc, null]);
  const P2 = (user: string, lot: string, qty: number, id = randomUUID(), reason = 'ops2f1 count', gen: number | null = null) =>
    as(user, 'phoenix_request_warehouse_stock_correction', [id, lot, qty, reason, gen, 'OPS2F1-DOC', null]);
  const approve = (user: string, requestId: string) =>
    as(user, 'phoenix_approve_warehouse_stock_correction', [requestId, null]);

  beforeAll(async () => {
    rig = await buildRig({});
    SUPER = rig.superAdminId;
    await admin(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
      ($1,'OPS2F1 A','أ','ops2f1-a','care_institution','hospital'),
      ($2,'OPS2F1 B','ب','ops2f1-b','care_institution','hospital'),
      ($3,'OPS2F1 PDA','د','ops2f1-p','pharmacy_department_authority',NULL)`, [ORG_A, ORG_B, ORG_P]);
    await admin(`INSERT INTO warehouses (id, organization_id, name, name_ar, status, warehouse_kind, code) VALUES
      ($1,$4,'OPS2F1 WH A','و أ','active','institution','ops2f1-wa'),
      ($2,$5,'OPS2F1 WH B','و ب','active','institution','ops2f1-wb'),
      ($3,$6,'OPS2F1 Central','مركزي','active','central','ops2f1-wp')`, [WH_A, WH_B, WH_P, ORG_A, ORG_B, ORG_P]);
    const people: Array<[string, string, string, string | null]> = [
      [OFF_A, 'warehouse_officer', ORG_A, WH_A], [OFF_A2, 'warehouse_officer', ORG_A, WH_A],
      [IA_A, 'institution_admin', ORG_A, null], [OFF_B, 'warehouse_officer', ORG_B, WH_B],
      [CWM_P, 'central_warehouse_manager', ORG_P, WH_P], [DEL, 'warehouse_officer', ORG_A, WH_A],
      [OFF_R, 'warehouse_officer', ORG_A, WH_A], [OFF_S, 'warehouse_officer', ORG_A, WH_A],
    ];
    for (const [id, role, org, wh] of people) {
      await admin(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `${id.slice(-4)}@ops2f1.rig`]);
      await admin(`UPDATE profiles SET role=$2, status='active', organization_id=$3 WHERE id=$1`, [id, role, org]);
      if (wh) await admin(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ($1,$2,'warehouse',$3,true)`, [id, org, wh]);
    }
  }, 600_000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── AC-N1 / AC-N2: the generic writer never posts a caller-chosen target ──────────────
  it('AC-N1 direct correction is refused with zero delta for every holder of warehouse_stock.correct', async () => {
    const inst = await newLot(ORG_A, WH_A, 50);
    const central = await newLot(ORG_P, WH_P, 50, true);
    const cases: Array<[string, string]> = [[OFF_A, inst], [OFF_A2, inst], [SUPER, inst], [CWM_P, central], [SUPER, central]];
    for (const [user, lot] of cases) {
      const before = await snapshot(lot);
      const r = await refusal(P1(user, lot, 'correction', 7));
      expect(r.code).toBe('42501');
      expect(r.message).toMatch(GOVERNED);
      expect(await snapshot(lot)).toEqual(before);
    }
  });

  it('AC-N1 a DELEGATED holder of correct is refused on the direct path in the foreign organization', async () => {
    const grant = await as(SUPER, 'phoenix_admin_grant_delegated_scope', [DEL, ORG_B, 'warehouse', WH_B, null, false]);
    const lot = await newLot(ORG_B, WH_B, 50);
    const allowed = await rig.asUser(DEL, (c: any) => c.query(
      `SELECT public.phoenix_profile_has_scoped_permission($1,'warehouse_stock.correct',$2,$3,NULL) AS a`, [DEL, ORG_B, WH_B])
      .then((r: any) => r.rows[0].a));
    expect(allowed).toBe(true);                       // the authority genuinely exists...
    const before = await snapshot(lot);
    const r = await refusal(P1(DEL, lot, 'correction', 3));
    expect(r.message).toMatch(GOVERNED);              // ...and still cannot be used unilaterally
    expect(await snapshot(lot)).toEqual(before);
    // the governed path is open to the same delegated authority (it queues)
    const q = await P2(DEL, lot, 3);
    expect(q).toMatchObject({ ok: true, status: 'pending', requires_approval: true });
    expect((await snapshot(lot)).qty).toBe(50);
    await as(SUPER, 'phoenix_admin_revoke_delegated_scope', [grant.assignment_id, null, 'ops2f1 test complete']);
  });

  it('AC-N2 set_exact is refused on central AND institution warehouses with zero delta', async () => {
    const central = await newLot(ORG_P, WH_P, 40, true);
    const inst = await newLot(ORG_A, WH_A, 40);
    for (const [user, lot] of [[CWM_P, central], [SUPER, central], [OFF_A, inst]] as Array<[string, string]>) {
      const before = await snapshot(lot);
      const r = await refusal(P1(user, lot, 'set_exact', 12, randomUUID(), 'recount'));
      expect(r.code).toBe('42501');
      expect(r.message).toMatch(GOVERNED);
      expect(await snapshot(lot)).toEqual(before);
    }
  });

  // ── AC-N3: the internal applier is owner-only ───────────────────────────────────────
  it('AC-N3 the applier is SECURITY DEFINER, search_path-pinned, canonical-owner-owned and owner-only', async () => {
    const r = (await admin(`SELECT p.prosecdef, p.proconfig, p.proowner = c.proowner AS same_owner,
        (SELECT array_agg(DISTINCT a.grantee::regrole::text) FROM aclexplode(COALESCE(p.proacl, acldefault('f', p.proowner))) a) AS grantees,
        p.proowner::regrole::text AS owner
      FROM pg_proc p, pg_proc c WHERE p.oid = $1::regprocedure AND c.oid = $2::regprocedure`, [APPLIER, CANONICAL])).rows[0];
    expect(r.prosecdef).toBe(true);
    expect(r.proconfig).toEqual(['search_path=public, pg_temp']);
    expect(r.same_owner).toBe(true);
    expect(r.grantees).toEqual([r.owner]);
    const priv = (await admin(`SELECT has_function_privilege('anon',$1::regprocedure,'EXECUTE') AS anon,
        has_function_privilege('authenticated',$1::regprocedure,'EXECUTE') AS auth,
        has_function_privilege('service_role',$1::regprocedure,'EXECUTE') AS svc,
        has_function_privilege('public',$1::regprocedure,'EXECUTE') AS pub,
        has_function_privilege('authenticated',$2::regprocedure,'EXECUTE') AS canonical_auth,
        has_function_privilege('anon',$2::regprocedure,'EXECUTE') AS canonical_anon`, [APPLIER, CANONICAL])).rows[0];
    expect(priv).toEqual({ anon: false, auth: false, svc: false, pub: false, canonical_auth: false, canonical_anon: false });
  });

  it('AC-N3 direct external execution of the applier is denied for authenticated, anon and service_role', async () => {
    const lot = await newLot(ORG_A, WH_A, 30);
    const before = await snapshot(lot);
    for (const role of ['authenticated', 'anon', 'service_role']) {
      const r = await refusal(rig.asUser(OFF_A, (c: any) => call(c, '_phoenix_apply_governed_warehouse_correction',
        [randomUUID(), lot, 1, 'bypass', null, null, null]), { role }));
      expect(r.message).toMatch(/permission denied for function/);
    }
    expect(await snapshot(lot)).toEqual(before);
  });

  // ── AC-P1 / AC-P2: the governed workflow keeps working ────────────────────────────────
  it('AC-P1 a zero-variance governed count applies with full ledger provenance', async () => {
    const lot = await newLot(ORG_A, WH_A, 25);
    const id = randomUUID();
    const r = await P2(OFF_A, lot, 25, id, '  physical count  ');
    expect(r).toMatchObject({ ok: true, requires_approval: false, idempotent_replay: false, quantity_after: 25, quantity_delta: 0 });
    const m = (await admin(`SELECT movement_type, reason, reason_code, reference_type, reference_id, request_fingerprint,
        actor_id, actor_role, correlation_id, on_hand_before, on_hand_after FROM warehouse_stock_movements WHERE id=$1`, [r.movement_id])).rows[0];
    expect(m).toMatchObject({ movement_type: 'correction', reason: 'physical count', reason_code: 'corrected',
      reference_type: 'warehouse_request', reference_id: id, actor_id: OFF_A, actor_role: 'warehouse_officer',
      on_hand_before: 25, on_hand_after: 25 });
    expect(m.request_fingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(m.correlation_id).not.toBeNull();
    const audit = (await admin(`SELECT count(*)::int n FROM audit_logs WHERE action='warehouse_stock.correction' AND payload->>'request_id'=$1`, [id])).rows[0];
    expect(audit.n).toBe(1);
  });

  it('AC-P1 within a configured threshold the requester applies alone; the generation guard still holds', async () => {
    await setThreshold(ORG_A, 10);
    try {
      const lot = await newLot(ORG_A, WH_A, 40);
      const stale = await refusal(P2(OFF_A, lot, 33, randomUUID(), 'count', 99));
      expect(stale.code).toBe('40001');
      expect(stale.message).toMatch(/warehouse_receipt_generation_conflict/);
      expect((await snapshot(lot)).qty).toBe(40);
      const { seq } = await snapshot(lot);
      const r = await P2(OFF_A, lot, 33, randomUUID(), 'count', Number(seq));
      expect(r).toMatchObject({ ok: true, requires_approval: false, quantity_before: 40, quantity_after: 33 });
      const over = await P2(OFF_A, lot, 10);                      // variance 23 > 10 -> queued
      expect(over).toMatchObject({ status: 'pending', requires_approval: true, threshold: 10 });
      expect((await snapshot(lot)).qty).toBe(33);
    } finally {
      await setThreshold(ORG_A, 0);
    }
  });

  it('AC-P2 / AC-N4 over threshold: proposer, peer officer, institution admin and a foreign approver are refused; a different authorized person applies exactly once', async () => {
    const lot = await newLot(ORG_A, WH_A, 60);
    const underlying = randomUUID();
    const q = await P2(OFF_A, lot, 45, underlying);
    expect(q).toMatchObject({ ok: true, status: 'pending', requires_approval: true, variance: 15, threshold: 0 });
    expect((await snapshot(lot)).qty).toBe(60);
    const before = await snapshot(lot);
    expect((await refusal(approve(OFF_A, q.correction_request_id))).message).toMatch(/proposer_cannot_approve_own_correction/);
    for (const u of [OFF_A2, IA_A, CWM_P, OFF_B]) {
      expect((await refusal(approve(u, q.correction_request_id))).message).toMatch(/forbidden_correction_approval/);
    }
    expect(await snapshot(lot)).toEqual(before);
    const ok = await approve(SUPER, q.correction_request_id);
    expect(ok).toMatchObject({ ok: true, status: 'approved', quantity_before: 60, quantity_after: 45 });
    const req = (await admin(`SELECT status, applied_movement_id, decided_by FROM phoenix_warehouse_correction_requests WHERE id=$1`, [q.correction_request_id])).rows[0];
    expect(req).toMatchObject({ status: 'approved', applied_movement_id: ok.movement_id, decided_by: SUPER });
    const m = (await admin(`SELECT reference_type, reference_id, reason_code, actor_id FROM warehouse_stock_movements WHERE id=$1`, [ok.movement_id])).rows[0];
    expect(m).toMatchObject({ reference_type: 'warehouse_request', reference_id: underlying, reason_code: 'corrected', actor_id: SUPER });
    expect((await refusal(approve(SUPER, q.correction_request_id))).message).toMatch(/correction_request_not_pending/);
    expect((await snapshot(lot)).moves).toBe(before.moves + 1);
  });

  // ── AC-N4 / AC-N5: cross-organization and revoked authority ───────────────────────────
  it('AC-N4 a requester from another organization is refused with zero delta', async () => {
    const lot = await newLot(ORG_A, WH_A, 20);
    const before = await snapshot(lot);
    expect((await refusal(P2(OFF_B, lot, 19))).message).toMatch(/forbidden_warehouse_stock_movement/);
    expect((await refusal(P1(OFF_B, lot, 'correction', 19))).message).toMatch(GOVERNED);
    expect(await snapshot(lot)).toEqual(before);
  });

  it('AC-N5 revoked authority is refused on the governed path: deny override, revoked assignment, suspended profile, revoked delegation', async () => {
    const lot = await newLot(ORG_A, WH_A, 20);
    const lotB = await newLot(ORG_B, WH_B, 20);
    const before = await snapshot(lot);
    await as(SUPER, 'assign_profile_permissions', [OFF_R, { 'warehouse_stock.correct': false }]);
    expect((await refusal(P2(OFF_R, lot, 20))).message).toMatch(/forbidden_warehouse_stock_movement/);
    await admin(`UPDATE profile_scope_assignments SET is_active=false, revoked_at=now(), revoked_by=$2, revoke_reason='ops2f1'
      WHERE profile_id=$1 AND warehouse_id=$3`, [OFF_A2, SUPER, WH_A]);
    expect((await refusal(P2(OFF_A2, lot, 20))).message).toMatch(/forbidden_warehouse_stock_movement/);
    await admin(`UPDATE profiles SET status='suspended' WHERE id=$1`, [OFF_S]);
    expect((await refusal(P2(OFF_S, lot, 20))).message).toMatch(/forbidden|active_profile|permission/i);
    expect(await snapshot(lot)).toEqual(before);
    const grant = await as(SUPER, 'phoenix_admin_grant_delegated_scope', [DEL, ORG_B, 'warehouse', WH_B, null, false]);
    await as(SUPER, 'phoenix_admin_revoke_delegated_scope', [grant.assignment_id, null, 'ops2f1 revoke probe']);
    const beforeB = await snapshot(lotB);
    expect((await refusal(P2(DEL, lotB, 20))).message).toMatch(/forbidden_warehouse_stock_movement/);
    expect(await snapshot(lotB)).toEqual(beforeB);
  });

  // ── AC-R1: idempotency and request identity ──────────────────────────────────────────
  it('AC-R1 replays are safe: governed replay, generic-writer replay of an already-posted id, and payload/identity conflicts', async () => {
    await setThreshold(ORG_A, 50);
    try {
      const lot = await newLot(ORG_A, WH_A, 80);
      const id = randomUUID();
      const first = await P2(OFF_A, lot, 70, id, 'count');
      const again = await P2(OFF_A, lot, 70, id, 'count');
      expect(again).toMatchObject({ ok: true, idempotent_replay: true, movement_id: first.movement_id });
      // the generic writer answers an ALREADY-POSTED id (identical payload) with the canonical replay — no write
      const viaP1 = await P1(OFF_A, lot, 'correction', 70, id, 'count', null, 'OPS2F1-DOC');
      expect(viaP1).toMatchObject({ ok: true, idempotent_replay: true, movement_id: first.movement_id });
      // ...but never with a different payload under the same id
      expect((await refusal(P1(OFF_A, lot, 'correction', 1, id, 'count', null, 'OPS2F1-DOC'))).message).toMatch(/request_id_conflict/);
      expect((await snapshot(lot)).moves).toBe(1);
      // a queued request replays as itself
      const qid = randomUUID();
      const q = await P2(OFF_A, lot, 0, qid, 'big');
      expect(await P2(OFF_A, lot, 0, qid, 'big')).toMatchObject({ idempotent_replay: true, correction_request_id: q.correction_request_id });
      // once approved, its underlying id cannot be reused on the generic writer
      const ok = await approve(SUPER, q.correction_request_id);
      const r = await refusal(P1(OFF_A, lot, 'correction', 5, qid, 'reuse'));
      expect(r.message).toMatch(/request_id_conflict/);
      expect((await snapshot(lot)).qty).toBe(ok.quantity_after);
    } finally {
      await setThreshold(ORG_A, 0);
    }
  });

  // ── AC-P3: concurrency ───────────────────────────────────────────────────────────────
  it('AC-P3 concurrent identical governed requests post exactly one movement; concurrent direct attempts all fail', async () => {
    await setThreshold(ORG_A, 50);
    try {
      const lot = await newLot(ORG_A, WH_A, 90);
      const id = randomUUID();
      const results = await Promise.all(Array.from({ length: 6 }, () => P2(OFF_A, lot, 81, id, 'race')));
      expect(results.every((r: any) => r.ok && r.movement_id === results[0].movement_id)).toBe(true);
      expect(results.filter((r: any) => r.idempotent_replay === false)).toHaveLength(1);
      const direct = await Promise.allSettled(Array.from({ length: 6 }, () => P1(OFF_A, lot, 'correction', 1)));
      expect(direct.every((d) => d.status === 'rejected' && GOVERNED.test(String((d as any).reason?.message)))).toBe(true);
      const s = await snapshot(lot);
      expect(s).toMatchObject({ qty: 81, moves: 1 });
    } finally {
      await setThreshold(ORG_A, 0);
    }
  });

  // ── AC-O1: every other stock operation is unchanged ────────────────────────────────────
  it('AC-O1 central add/subtract still work and replay; institution add/subtract keep their 103 refusal', async () => {
    const central = await newLot(ORG_P, WH_P, 50, true);
    const addId = randomUUID();
    expect(await P1(CWM_P, central, 'add', 10, addId, null as any)).toMatchObject({ ok: true, quantity_after: 60 });
    expect(await P1(CWM_P, central, 'add', 10, addId, null as any)).toMatchObject({ ok: true, idempotent_replay: true, quantity_after: 60 });
    expect(await P1(CWM_P, central, 'subtract', 15, randomUUID(), null as any)).toMatchObject({ ok: true, quantity_after: 45 });
    const inst = await newLot(ORG_A, WH_A, 50);
    for (const t of ['add', 'subtract']) {
      const r = await refusal(P1(OFF_A, inst, t, 5, randomUUID(), null as any));
      expect(r.message).toMatch(/institution_warehouse_direct_adjustment_forbidden/);
    }
    // central set-to-target remains available through the governed path
    const q = await P2(CWM_P, central, 40);
    expect(q).toMatchObject({ ok: true, status: 'pending', requires_approval: true });
  });
});
