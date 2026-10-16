/**
 * OPS2-F1 v2 — CORRECTION REPLAY BINDING — DYNAMIC suite, against a real disposable Postgres replaying the
 * FULL chain (001->latest).
 *
 * A warehouse-correction request id is bound to its original requester, organization, lot and approved payload.
 * phoenix_request_warehouse_stock_correction (and the generic writer) may answer a replay ONLY after re-proving the
 * caller's CURRENT identity and scoped authority on the lot, and ONLY to the original requester with the identical
 * payload. Every other caller or payload gets request_id_conflict with no request data, or the ordinary refusal.
 * Gated on PHOENIX_RIG_PG.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;

const ORG_A = '00000000-0000-0000-0000-00000f2f2001';
const ORG_B = '00000000-0000-0000-0000-00000f2f2002';
const WH_A = '00000000-0000-0000-0000-00000f2f2101';
const WH_B = '00000000-0000-0000-0000-00000f2f2102';
const OWNER = '00000000-0000-0000-0000-00000f2f2401';   // warehouse_officer, WH_A — the original requester
const PEER = '00000000-0000-0000-0000-00000f2f2402';    // warehouse_officer, WH_A — another user, same org and lot
const FOREIGN = '00000000-0000-0000-0000-00000f2f2403'; // warehouse_officer, WH_B — another organization
const REVOKE = '00000000-0000-0000-0000-00000f2f2404';  // warehouse_officer, WH_A — loses authority mid-test
const SUSPEND = '00000000-0000-0000-0000-00000f2f2405'; // warehouse_officer, WH_A — account suspended mid-test
const UNASSIGN = '00000000-0000-0000-0000-00000f2f2406';// warehouse_officer, WH_A — assignment revoked mid-test

const CONFLICT = /^request_id_conflict$/;

run('OPS2-F1 v2 correction replay binding — dynamic', () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let SUPER = '';

  const call = (c: any, fn: string, args: any[]) =>
    c.query(`SELECT public.${fn}(${args.map((_, i) => `$${i + 1}`).join(', ')}) AS r`, args)
      .then((res: any) => res.rows[0].r);
  const as = (user: string, fn: string, args: any[]) => rig.asUser(user, (c: any) => call(c, fn, args), { commit: true });
  const refusal = async (p: Promise<unknown>) => {
    try { await p; } catch (e: any) { return { code: e.code as string, message: String(e.message), detail: String(e.detail ?? '') }; }
    throw new Error('expected a refusal, but the call succeeded');
  };
  const admin = (sql: string, params: any[] = []) => rig.asAdmin((c: any) => c.query(sql, params));
  const newLot = async (org: string, wh: string, qty: number) => {
    const id = randomUUID();
    await admin(`INSERT INTO warehouse_stock (id, organization_id, warehouse_id, scientific_name, has_no_national_code,
        has_no_batch_number, batch_number, on_hand_quantity, reserved_quantity, movement_seq)
      VALUES ($1,$2,$3,$4,true,false,$5,$6,0,0)`, [id, org, wh, `RB-${id.slice(0, 8)}`, `RB-${id.slice(0, 6)}`, qty]);
    return id;
  };
  const world = async () => (await admin(
    `SELECT (SELECT count(*)::int FROM warehouse_stock_movements) AS moves,
            (SELECT count(*)::int FROM phoenix_warehouse_correction_requests) AS requests,
            (SELECT coalesce(sum(on_hand_quantity),0)::int FROM warehouse_stock) AS stock`)).rows[0];
  type Payload = { qty: number; reason: string; doc: string | null; notes: string | null; gen?: number | null };
  const P2 = (user: string, id: string, lot: string, p: Payload) =>
    as(user, 'phoenix_request_warehouse_stock_correction', [id, lot, p.qty, p.reason, p.gen ?? null, p.doc, p.notes]);
  const P1 = (user: string, id: string, lot: string, p: Payload) =>
    as(user, 'phoenix_apply_warehouse_stock_movement_guarded', [id, lot, 'correction', p.qty, p.reason, p.gen ?? null, p.doc, p.notes]);
  const setThreshold = (org: string, t: number) => as(SUPER, 'phoenix_set_variance_approval_policy', [org, t]);
  /** A refusal that leaks nothing about the request: no ids, no status, no quantities in message or detail. */
  const expectOpaque = (r: { message: string; detail: string }, secrets: string[]) => {
    for (const s of secrets) {
      expect(r.message).not.toContain(s);
      expect(r.detail).not.toContain(s);
    }
    expect(r.message).not.toMatch(/pending|approved|rejected/);
  };

  beforeAll(async () => {
    rig = await buildRig({});
    SUPER = rig.superAdminId;
    await admin(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
      ($1,'RB A','أ','rb-a','care_institution','hospital'), ($2,'RB B','ب','rb-b','care_institution','hospital')`, [ORG_A, ORG_B]);
    await admin(`INSERT INTO warehouses (id, organization_id, name, name_ar, status, warehouse_kind, code) VALUES
      ($1,$3,'RB WH A','و أ','active','institution','rb-wa'), ($2,$4,'RB WH B','و ب','active','institution','rb-wb')`,
    [WH_A, WH_B, ORG_A, ORG_B]);
    for (const [id, org, wh] of [[OWNER, ORG_A, WH_A], [PEER, ORG_A, WH_A], [FOREIGN, ORG_B, WH_B],
      [REVOKE, ORG_A, WH_A], [SUSPEND, ORG_A, WH_A], [UNASSIGN, ORG_A, WH_A]]) {
      await admin(`INSERT INTO auth.users (id, email) VALUES ($1, $2)`, [id, `${id.slice(-4)}@rb.rig`]);
      await admin(`UPDATE profiles SET role='warehouse_officer', status='active', organization_id=$2 WHERE id=$1`, [id, org]);
      await admin(`INSERT INTO profile_scope_assignments (profile_id, organization_id, scope_type, warehouse_id, is_active)
        VALUES ($1,$2,'warehouse',$3,true)`, [id, org, wh]);
    }
  }, 600_000);

  afterAll(async () => { if (rig) await rig.end(); });

  // ── RB-1 / RB-2: legitimate replays of a queued and of a decided request ─────────────
  it('RB-1 the original requester replays a PENDING request idempotently', async () => {
    const lot = await newLot(ORG_A, WH_A, 50);
    const id = randomUUID();
    const p: Payload = { qty: 30, reason: 'count', doc: 'DOC-1', notes: 'n' };
    const q = await P2(OWNER, id, lot, p);
    expect(q).toMatchObject({ status: 'pending', requires_approval: true });
    const before = await world();
    const again = await P2(OWNER, id, lot, { ...p, reason: '  count  ', doc: ' DOC-1 ', notes: ' n ' });  // same after trim
    expect(again).toEqual({ ok: true, idempotent_replay: true, correction_request_id: q.correction_request_id,
      status: 'pending', requires_approval: true });
    expect(await world()).toEqual(before);
  });

  it('RB-2 the original requester replays an APPROVED request idempotently; nothing is applied twice', async () => {
    const lot = await newLot(ORG_A, WH_A, 50);
    const id = randomUUID();
    const p: Payload = { qty: 20, reason: 'count', doc: null, notes: null };
    const q = await P2(OWNER, id, lot, p);
    await as(SUPER, 'phoenix_approve_warehouse_stock_correction', [q.correction_request_id, null]);
    const before = await world();
    const again = await P2(OWNER, id, lot, p);
    expect(again).toMatchObject({ idempotent_replay: true, correction_request_id: q.correction_request_id, status: 'approved' });
    expect(await world()).toEqual(before);
  });

  // ── RB-3: legitimate retry after a lost response ──────────────────────────────────────
  it('RB-3 a lost-response retry of an APPLIED within-threshold request replays — even after the lot moved since', async () => {
    await setThreshold(ORG_A, 10);
    try {
      const lot = await newLot(ORG_A, WH_A, 40);
      const id = randomUUID();
      const p: Payload = { qty: 35, reason: 'count', doc: 'D', notes: null, gen: 0 };
      const first = await P2(OWNER, id, lot, p);                       // response "lost"
      expect(first).toMatchObject({ idempotent_replay: false, requires_approval: false, quantity_after: 35 });
      const retry = await P2(OWNER, id, lot, p);                       // same id, same payload, same (now stale) generation
      expect(retry).toMatchObject({ ok: true, idempotent_replay: true, movement_id: first.movement_id });
      // the lot then moves by two unrelated governed corrections (35 -> 26 -> 17), so the retry's variance (18) now
      // EXCEEDS the threshold: the retry must still be the SAME replay — never a new pending request under the same id
      await P2(PEER, randomUUID(), lot, { qty: 26, reason: 'other count', doc: null, notes: null });
      await P2(PEER, randomUUID(), lot, { qty: 17, reason: 'other count', doc: null, notes: null });
      const late = await P2(OWNER, id, lot, p);
      expect(late).toMatchObject({ ok: true, idempotent_replay: true, movement_id: first.movement_id });
      const rows = (await admin(`SELECT count(*)::int n FROM phoenix_warehouse_correction_requests WHERE underlying_request_id=$1`, [id])).rows[0];
      expect(rows.n).toBe(0);
    } finally {
      await setThreshold(ORG_A, 0);
    }
  });

  // ── RB-4 / RB-5: other users get no replay data ────────────────────────────────────────
  it('RB-4 a user of ANOTHER organization gets the ordinary refusal or an opaque conflict — never request data', async () => {
    const lotA = await newLot(ORG_A, WH_A, 50);
    const lotB = await newLot(ORG_B, WH_B, 50);
    const id = randomUUID();
    const p: Payload = { qty: 25, reason: 'count', doc: null, notes: null };
    const q = await P2(OWNER, id, lotA, p);
    const before = await world();
    const onTheirLot = await refusal(P2(FOREIGN, id, lotA, p));       // not authorized on A's lot
    expect(onTheirLot.message).toMatch(/forbidden_warehouse_stock_movement/);
    const onOwnLot = await refusal(P2(FOREIGN, id, lotB, p));         // authorized on own lot, foreign id
    expect(onOwnLot.message).toMatch(CONFLICT);
    for (const r of [onTheirLot, onOwnLot]) expectOpaque(r, [q.correction_request_id, id]);
    expect(await world()).toEqual(before);
  });

  it('RB-5 ANOTHER user of the same organization and lot gets an opaque conflict on pending, approved and applied ids', async () => {
    await setThreshold(ORG_A, 10);
    try {
      const lot = await newLot(ORG_A, WH_A, 60);
      const p: Payload = { qty: 40, reason: 'count', doc: null, notes: null };
      const pendingId = randomUUID();
      const pending = await P2(OWNER, pendingId, lot, p);
      const approvedId = randomUUID();
      const approved = await P2(OWNER, approvedId, lot, { ...p, qty: 41 });
      await as(SUPER, 'phoenix_approve_warehouse_stock_correction', [approved.correction_request_id, null]);
      const appliedId = randomUUID();
      const applied = await P2(OWNER, appliedId, lot, { ...p, qty: 45 });            // 41 -> 45 within threshold 10
      expect(applied.requires_approval).toBe(false);
      const before = await world();
      for (const [rid, qty, secret] of [[pendingId, 40, pending.correction_request_id], [approvedId, 41, approved.correction_request_id],
        [appliedId, 45, applied.movement_id]] as Array<[string, number, string]>) {
        const r = await refusal(P2(PEER, rid, lot, { ...p, qty }));
        expect(r.message).toMatch(CONFLICT);
        expectOpaque(r, [secret]);
      }
      // M222-A: the generic writer gives another actor the same direct-target refusal as an unused id.
      const viaP1 = await refusal(P1(PEER, appliedId, lot, { ...p, qty: 45 }));
      expect(viaP1.message).toBe('warehouse_correction_requires_governed_request');
      expectOpaque(viaP1, [applied.movement_id]);
      expect(await world()).toEqual(before);
    } finally {
      await setThreshold(ORG_A, 0);
    }
  });

  // ── RB-6 / RB-7: revoked, suspended or missing identities get no replay ──────────────
  it('RB-6 a requester whose authority was REVOKED (deny override, revoked assignment) gets the ordinary refusal', async () => {
    const lot = await newLot(ORG_A, WH_A, 50);
    const p: Payload = { qty: 10, reason: 'count', doc: null, notes: null };
    const idR = randomUUID();
    const qR = await P2(REVOKE, idR, lot, p);
    const idU = randomUUID();
    const qU = await P2(UNASSIGN, idU, lot, { ...p, qty: 11 });
    await as(SUPER, 'assign_profile_permissions', [REVOKE, { 'warehouse_stock.correct': false }]);
    await admin(`UPDATE profile_scope_assignments SET is_active=false, revoked_at=now(), revoked_by=$2, revoke_reason='rb'
      WHERE profile_id=$1`, [UNASSIGN, SUPER]);
    const before = await world();
    const r1 = await refusal(P2(REVOKE, idR, lot, p));
    const r2 = await refusal(P2(UNASSIGN, idU, lot, { ...p, qty: 11 }));
    for (const [r, secret] of [[r1, qR.correction_request_id], [r2, qU.correction_request_id]] as Array<[any, string]>) {
      expect(r.message).toMatch(/forbidden_warehouse_stock_movement/);
      expectOpaque(r, [secret]);
    }
    expect(await world()).toEqual(before);
  });

  it('RB-7 a SUSPENDED account and a MISSING profile get the ordinary refusal', async () => {
    const lot = await newLot(ORG_A, WH_A, 50);
    const p: Payload = { qty: 12, reason: 'count', doc: null, notes: null };
    const id = randomUUID();
    const q = await P2(SUSPEND, id, lot, p);
    await admin(`UPDATE profiles SET status='suspended' WHERE id=$1`, [SUSPEND]);
    const before = await world();
    const suspended = await refusal(P2(SUSPEND, id, lot, p));
    expect(suspended.message).toMatch(/forbidden_warehouse_stock_movement/);
    expectOpaque(suspended, [q.correction_request_id]);
    const ghost = await refusal(P2(randomUUID(), id, lot, p));        // a JWT subject with no profile at all
    expect(ghost.message).toMatch(/forbidden_warehouse_stock_movement/);
    expectOpaque(ghost, [q.correction_request_id]);
    expect(await world()).toEqual(before);
  });

  // ── RB-8: a changed payload from the authorized original requester ─────────────────────
  it('RB-8 the original requester changing ANY payload field gets request_id_conflict with zero side effects', async () => {
    await setThreshold(ORG_A, 10);
    try {
      const lot = await newLot(ORG_A, WH_A, 70);
      const otherLot = await newLot(ORG_A, WH_A, 70);
      const p: Payload = { qty: 50, reason: 'count', doc: 'DOC', notes: 'note' };
      const pendingId = randomUUID();
      const pending = await P2(OWNER, pendingId, lot, p);
      expect(pending.status).toBe('pending');
      const appliedId = randomUUID();
      const applied = await P2(OWNER, appliedId, otherLot, { ...p, qty: 65 });
      expect(applied.requires_approval).toBe(false);
      const before = await world();
      const variants: Array<[string, string, Payload]> = [
        [pendingId, lot, { ...p, qty: 51 }], [pendingId, lot, { ...p, reason: 'recount' }],
        [pendingId, lot, { ...p, doc: 'DOC-2' }], [pendingId, lot, { ...p, doc: null }],
        [pendingId, lot, { ...p, notes: 'other' }], [pendingId, otherLot, p],
        [appliedId, otherLot, { ...p, qty: 64 }], [appliedId, otherLot, { ...p, qty: 65, reason: 'x' }],
        [appliedId, lot, { ...p, qty: 65 }],
      ];
      for (const [rid, l, v] of variants) {
        const r = await refusal(P2(OWNER, rid, l, v));
        expect(r.message).toMatch(CONFLICT);
        expectOpaque(r, [pending.correction_request_id, applied.movement_id]);
      }
      expect(await world()).toEqual(before);
    } finally {
      await setThreshold(ORG_A, 0);
    }
  });

  // ── RB-9: the direct-correction bypass stays closed ───────────────────────────────────
  it('RB-9 direct correction through the generic writer is still refused for a fresh id', async () => {
    const lot = await newLot(ORG_A, WH_A, 50);
    const before = await world();
    const r = await refusal(P1(OWNER, randomUUID(), lot, { qty: 1, reason: 'direct', doc: null, notes: null }));
    expect(r.message).toMatch(/warehouse_correction_requires_governed_request/);
    expect(await world()).toEqual(before);
  });
});
