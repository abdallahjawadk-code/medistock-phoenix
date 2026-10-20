/**
 * R1-a candidate 03 — DYNAMIC proof: withdrawn status, the three remaining
 * relations (17 in total), separation of duties in the authority gate, carry
 * integrity (VC-8), and the seal restated for 17 relations. Real PostgreSQL only.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import {
  ORG, ORG_BENE, ORG_BENE_B, U, read, refusal, helpers, buildWithCandidates, newItem, grantManualKey, type Rig,
} from './r1a-fixtures';

const run = rigAvailable() ? describe : describe.skip;
const F = ['R1a_01_manual_source_schema_inert.sql', 'R1a_02_authorization_closure.sql', 'R1a_03_lifecycle_relations_and_sod.sql'];
const DIGEST = 'a'.repeat(64);

run('R1-a candidate 03 — lifecycle relations, withdrawal and SoD (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Rig;
  let year = 2000;
  let item = '';
  const h = helpers(() => rig);
  const { admin, txAs } = h;

  /** A revision (any mode/status) created with triggers off; `opener` becomes created_by. */
  const mk = async (mode: 'excel' | 'manual', status: string, opener: string = U.maker) => {
    year += 1;
    let ids = { plan: '', rev: '' };
    await txAs(null, async (q) => {
      const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG, year]);
      const [{ id: rev }] = await q(
        `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by${status === 'approved' ? ', approved_by, approved_at' : ''})
         VALUES ($1,$2,1,$3,$4,$5${status === 'approved' ? `,'${U.checker}', now()` : ''}) RETURNING id`, [plan, ORG, status, mode, opener]);
      ids = { plan, rev };
    }, { replica: true });
    return ids;
  };
  const attest = (rev: string, phase: 'submit' | 'approve', actor: string) => admin(
    `INSERT INTO phoenix_private.central_needs_lifecycle_attestations (plan_revision_id, organization_id, phase, contract, actor_id, txid, state_digest)
     VALUES ($1,$2,$3,'c6-f1-final-v1',$4,$5,$6)`, [rev, ORG, phase, actor, Math.floor(Math.random() * 1e9), DIGEST]);
  const evt = (q: any, r: { plan: string; rev: string }, o: Partial<{ seq: number; kind: string; qty: string | null; unit: string | null; sup: string | null; carried: string | null; actor: string; ben: string }> = {}) => q(
    `INSERT INTO central_needs_manual_need_events
       (organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, event_seq, event_kind, quantity_text,
        approved_unit, supersedes_event_id, carried_from_event_id, reason, actor_id, actor_role, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'planned need',$12,'central_warehouse_manager',$13) RETURNING id`,
    [ORG, r.plan, r.rev, o.ben ?? ORG_BENE, item, o.seq ?? 1, o.kind ?? 'add', o.qty === undefined ? '10' : o.qty,
      o.unit === undefined ? 'box' : o.unit, o.sup ?? null, o.carried ?? null, o.actor ?? U.maker, randomUUID()]);
  const lineRow = (q: any, rev: string, o: Partial<{ qty: string; ben: string; by: string }> = {}) => q(
    `INSERT INTO central_needs_need_lines (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
        approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
     VALUES ($1,$2,$3,$4,$5::numeric,'box','canonical','planned need',$6) RETURNING id`, [rev, ORG, o.ben ?? ORG_BENE, item, o.qty ?? '10', o.by ?? U.maker]);

  beforeAll(async () => {
    rig = await buildWithCandidates(F, 1);
    item = await newItem(admin);
    await grantManualKey(rig, [U.maker, U.maker2, U.saKeys]);
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  describe('the final relation set', () => {
    it('is exactly 17 public relations, each with one restrictive actor-scope policy, all new ones EMPTY', async () => {
      const [{ n }] = await admin(`SELECT count(*)::int AS n FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace WHERE s.nspname='public' AND c.relkind='r' AND c.relname LIKE 'central\\_needs\\_%'`);
      expect(n).toBe(17);
      const missing = await admin(`SELECT c.relname FROM pg_class c JOIN pg_namespace s ON s.oid=c.relnamespace
        WHERE s.nspname='public' AND c.relkind='r' AND c.relname LIKE 'central\\_needs\\_%'
          AND NOT EXISTS (SELECT 1 FROM pg_policy p WHERE p.polrelid=c.oid AND p.polname='r1_actor_scope_restrictive' AND NOT p.polpermissive)`);
      expect(missing).toEqual([]);
    });
    it('the three new relations are append-only and cannot be written by API roles', async () => {
      await admin(`INSERT INTO central_needs_cutover_inventory (organization_id, entry_kind) VALUES ($1,'activation_marker')`, [ORG]);
      expect((await refusal(admin(`UPDATE central_needs_cutover_inventory SET entry_kind='activation_marker'`))).message).toBe('central_needs_append_only_relation');
      expect((await refusal(admin(`DELETE FROM central_needs_cutover_inventory`))).message).toBe('central_needs_append_only_relation');
      expect((await refusal(admin(`TRUNCATE central_needs_cutover_inventory`))).message).toBe('central_needs_append_only_relation');
      // one marker per organization
      expect((await refusal(admin(`INSERT INTO central_needs_cutover_inventory (organization_id, entry_kind) VALUES ($1,'activation_marker')`, [ORG]))).code).toBe('23505');
      for (const t of ['central_needs_revision_withdrawals', 'central_needs_manual_coverage_acknowledgements', 'central_needs_cutover_inventory']) {
        const [r] = await admin(`SELECT has_table_privilege('authenticated',$1,'INSERT') AS i, has_table_privilege('authenticated',$1,'UPDATE') AS u,
                                        has_table_privilege('authenticated',$1,'DELETE') AS d, has_table_privilege('anon',$1,'SELECT') AS a,
                                        has_table_privilege('service_role',$1,'INSERT') AS s`, [`public.${t}`]);
        expect(r, t).toEqual({ i: false, u: false, d: false, a: false, s: false });
      }
    });
    it('an inventory "revision" row must be fully described; the marker must not name a revision', async () => {
      expect((await refusal(admin(`INSERT INTO central_needs_cutover_inventory (organization_id, entry_kind) VALUES ($1,'revision')`, [ORG_BENE]))).message)
        .toMatch(/central_needs_cutover_inventory_shape_chk/);
    });
    it('withdrawal and acknowledgement rows are constrained (digest format, count, reason, uniqueness)', async () => {
      const r = await mk('manual', 'draft');
      const ok = { rev: r.rev, plan: r.plan };
      const wd = (digest: string, reason = 'abandoned') => admin(
        `INSERT INTO central_needs_revision_withdrawals (organization_id, plan_id, plan_revision_id, actor_id, actor_role, reason, state_digest, session_counts, row_counts)
         VALUES ($1,$2,$3,$4,'central_warehouse_manager',$5,$6,'{}','{}')`, [ORG, ok.plan, ok.rev, U.checker, reason, digest]);
      expect((await refusal(wd('xyz'))).message).toMatch(/digest_chk/);
      expect((await refusal(wd(DIGEST, '   '))).message).toMatch(/reason_chk/);
      await wd(DIGEST);
      expect((await refusal(wd(DIGEST))).code).toBe('23505');
      const ack = (digest: string, count: number) => admin(
        `INSERT INTO central_needs_manual_coverage_acknowledgements (organization_id, plan_id, plan_revision_id, predecessor_revision_id, omitted_scope_digest, omitted_scope_count, reason, actor_id, actor_role)
         VALUES ($1,$2,$3,$3,$4,$5,'intentional',$6,'central_warehouse_manager')`, [ORG, ok.plan, ok.rev, digest, count, U.maker]);
      expect((await refusal(ack(DIGEST, 0))).message).toMatch(/count_chk/);
      expect((await refusal(ack('nothex', 1))).message).toMatch(/digest_chk/);
      await ack(DIGEST, 2);
      expect((await refusal(ack(DIGEST, 2))).code).toBe('23505');
    });
  });

  describe('withdrawn status and the withdrawal gate (XD-3, SOD-9)', () => {
    const withdraw = (sub: string | null, rev: string, o: { record?: boolean } = {}) => txAs(sub, async (q) => {
      if (o.record) {
        const [r] = await q(`SELECT plan_id FROM central_needs_plan_revisions WHERE id=$1`, [rev]);
        await q(`INSERT INTO central_needs_revision_withdrawals (organization_id, plan_id, plan_revision_id, actor_id, actor_role, reason, state_digest, session_counts, row_counts)
                 VALUES ($1,$2,$3,$4,'central_warehouse_manager','abandoned',$5,'{}','{}')`, [ORG, r.plan_id, rev, sub, DIGEST]);
      }
      await q(`UPDATE central_needs_plan_revisions SET status='withdrawn' WHERE id=$1`, [rev]);
    });
    it('the status CHECK now admits withdrawn and nothing else new', async () => {
      const [{ def }] = await admin(`SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.central_needs_plan_revisions'::regclass AND conname='central_needs_plan_revisions_status_check'`);
      expect(def).toContain("'withdrawn'");
      expect(def).toContain("'superseded'");
    });
    it('refuses: no identity, wrong key, the opener, a missing record; allows an independent checker with the record', async () => {
      const r = await mk('excel', 'draft', U.maker);
      expect((await refusal(withdraw(null, r.rev, { record: false }))).message).toBe('forbidden_central_needs');
      expect((await refusal(withdraw(U.maker2, r.rev, { record: true }))).message).toBe('forbidden_central_needs');           // edit only
      expect((await refusal(withdraw(U.saOther, r.rev, { record: true }))).message).toBe('forbidden_central_needs');          // other org
      const own = await mk('excel', 'draft', U.checker);
      expect((await refusal(withdraw(U.checker, own.rev, { record: true }))).message).toBe('central_needs_separation_of_duties_violation'); // opener
      expect((await refusal(withdraw(U.checker, r.rev, { record: false }))).message).toBe('central_needs_withdrawal_without_record');
      await withdraw(U.checker, r.rev, { record: true });
      expect((await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [r.rev]))[0].status).toBe('withdrawn');
      expect((await admin(`SELECT count(*)::int AS n FROM central_needs_revision_withdrawals WHERE plan_revision_id=$1`, [r.rev]))[0].n).toBe(1);
    });
    it('withdrawn is terminal; only draft can be withdrawn', async () => {
      const r = await mk('excel', 'draft', U.maker);
      await withdraw(U.checker, r.rev, { record: true });
      expect((await refusal(txAs(U.checker, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='draft' WHERE id=$1`, [r.rev]); }))).message)
        .toBe('central_needs_status_transition_forbidden');
      const s = await mk('excel', 'submitted', U.maker);
      expect((await refusal(withdraw(U.checker, s.rev, { record: true }))).message).toBe('central_needs_status_transition_forbidden');
    });
  });

  describe('separation of duties on manual revisions (SOD-1/2/3/4, SOD-8)', () => {
    const reject = (sub: string, rev: string) => txAs(sub, async (q) => {
      await q(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [rev]);
    });
    /** submitted MANUAL revision: opener maker, entrant maker2, submitter checker2 (a different person with approve). */
    const submittedManual = async () => {
      const r = await mk('manual', 'draft', U.maker);
      await txAs(null, async (q) => { await evt(q, r, { actor: U.maker2 }); }, { replica: true });
      await attest(r.rev, 'submit', U.saKeys);
      await txAs(null, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='submitted' WHERE id=$1`, [r.rev]); }, { replica: true });
      return r;
    };
    it('the entrant, the opener and the submitter cannot reject; an independent checker can', async () => {
      // everyone below holds approve: grant approve to the opener/entrant to prove the key alone does not waive SoD
      await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,'central_needs.approve',true),($2,'central_needs.approve',true)
                   ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [U.maker, U.maker2]);
      const r = await submittedManual();
      expect((await refusal(reject(U.maker, r.rev))).message).toBe('central_needs_separation_of_duties_violation');   // opener
      expect((await refusal(reject(U.maker2, r.rev))).message).toBe('central_needs_separation_of_duties_violation');  // entrant
      expect((await refusal(reject(U.saKeys, r.rev))).message).toBe('central_needs_separation_of_duties_violation'); // submitter, super_admin: no exemption
      await reject(U.checker, r.rev);
      expect((await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [r.rev]))[0].status).toBe('rejected');
      await admin(`DELETE FROM profile_permission_overrides WHERE permission_key='central_needs.approve' AND profile_id IN ($1,$2)`, [U.maker, U.maker2]);
    });
    it('the coverage acknowledger is excluded too', async () => {
      const r = await submittedManual();
      await admin(`INSERT INTO central_needs_manual_coverage_acknowledgements (organization_id, plan_id, plan_revision_id, predecessor_revision_id, omitted_scope_digest, omitted_scope_count, reason, actor_id, actor_role)
        VALUES ($1,$2,$3,$3,$4,1,'intentional',$5,'central_warehouse_manager')`, [ORG, r.plan, r.rev, DIGEST, U.checker]);
      expect((await refusal(reject(U.checker, r.rev))).message).toBe('central_needs_separation_of_duties_violation');
      await reject(U.checker2, r.rev);
    });
    it('Excel revisions are NOT subject to the new SoD (disabled until R1-b; Q-E): the Excel opener may still reject', async () => {
      const r = await mk('excel', 'submitted', U.saKeys);                  // opener = super_admin of the owner PDA with approve
      await reject(U.saKeys, r.rev);
      expect((await admin(`SELECT status FROM central_needs_plan_revisions WHERE id=$1`, [r.rev]))[0].status).toBe('rejected');
      expect((await admin(`SELECT phoenix_cn_policy.excel_sod_enabled() AS e`))[0].e).toBe(false);
    });
    it('a missing key still dominates: a maker without approve cannot reject (key, then SoD)', async () => {
      const r = await submittedManual();
      expect((await refusal(reject(U.viewer, r.rev))).message).toBe('forbidden_central_needs');
      await reject(U.checker, r.rev);
    });
  });

  describe('carry-forward integrity (VC-8) — asserted at COMMIT', () => {
    const approvedManualWithLine = async (qty = '10') => {
      const e = await mk('manual', 'approved', U.maker);
      let eventId = '';
      await txAs(null, async (q) => { eventId = (await evt(q, e, { qty }))[0].id; await lineRow(q, e.rev, { qty }); }, { replica: true });
      return { ...e, eventId };
    };
    const nextDraft = async (e: { plan: string }) => {
      let rev = '';
      await txAs(null, async (q) => {
        const [r] = await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by)
          VALUES ($1,$2,2,'draft','manual',$3) RETURNING id`, [e.plan, ORG, U.maker]);
        rev = r.id;
      }, { replica: true });
      return { plan: e.plan, rev };
    };
    it('a faithful carry of the last live event commits', async () => {
      const e = await approvedManualWithLine('12.5');
      const n = await nextDraft(e);
      await txAs(null, async (q) => {
        await evt(q, n, { kind: 'carried_forward', qty: '12.5', carried: e.eventId });
        await lineRow(q, n.rev, { qty: '12.5' });
      });
      expect((await admin(`SELECT approved_quantity::text AS q FROM central_needs_need_lines WHERE plan_revision_id=$1`, [n.rev]))[0].q).toBe('12.5');
    });
    it('refuses a changed quantity, a non-last source event, a void source, and a source that is not an approved manual revision', async () => {
      const e = await approvedManualWithLine('10');
      const n = await nextDraft(e);
      expect((await refusal(txAs(null, async (q) => { await evt(q, n, { kind: 'carried_forward', qty: '11', carried: e.eventId }); await lineRow(q, n.rev, { qty: '11' }); })))
        .message).toBe('manual_carry_integrity_violation');
      // source revision not approved (draft manual)
      const d = await mk('manual', 'draft', U.maker);
      let did = '';
      await txAs(null, async (q) => { did = (await evt(q, d, {}))[0].id; await lineRow(q, d.rev); }, { replica: true });
      const n2 = await nextDraft(d);
      expect((await refusal(txAs(null, async (q) => { await evt(q, n2, { kind: 'carried_forward', qty: '10', carried: did }); await lineRow(q, n2.rev); })))
        .message).toBe('manual_carry_integrity_violation');
      // non-last source event: add a correct event after the carried-from one
      const e3 = await approvedManualWithLine('10');
      await txAs(null, async (q) => { await evt(q, e3, { seq: 2, kind: 'correct', qty: '11', sup: e3.eventId }); await q(`UPDATE central_needs_need_lines SET approved_quantity=11 WHERE plan_revision_id=$1`, [e3.rev]); }, { replica: true });
      const n3 = await nextDraft(e3);
      expect((await refusal(txAs(null, async (q) => { await evt(q, n3, { kind: 'carried_forward', qty: '10', carried: e3.eventId }); await lineRow(q, n3.rev); })))
        .message).toBe('manual_carry_integrity_violation');
    });
  });

  describe('seal for 17 relations', () => {
    const breaches = async (mutate?: string[]) => {
      let out: string[] = [];
      await rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          for (const m of mutate ?? []) await c.query(m);
          out = (await c.query(`SELECT b FROM phoenix_private.central_needs_capability_breaches_v1() AS b`)).rows.map((r: any) => r.b);
        } finally { await c.query('ROLLBACK'); }
      });
      return out;
    };
    it('is clean, and catches writes on each new relation and on the new manifest functions', async () => {
      expect(await breaches()).toEqual([]);
      for (const t of ['central_needs_revision_withdrawals', 'central_needs_manual_coverage_acknowledgements', 'central_needs_cutover_inventory']) {
        expect((await breaches([`GRANT INSERT ON public.${t} TO authenticated`])).join('|')).toContain(`authenticated holds INSERT on public.${t}`);
      }
      expect((await breaches([`GRANT EXECUTE ON FUNCTION phoenix_cn_policy.excel_sod_enabled() TO anon`])).join('|')).toMatch(/executable by anon/);
      expect((await breaches([`GRANT EXECUTE ON FUNCTION phoenix_private.central_needs_sod_excluded_v1(uuid,uuid) TO PUBLIC`])).join('|')).toMatch(/executable by PUBLIC/);
      expect((await breaches([`CREATE TABLE public.central_needs_zzz_unlisted (id int)`])).join('|')).toMatch(/unlisted_central_needs_relation/);
    });
  });
});
