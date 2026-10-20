/**
 * R1-b candidate 01 (NOT APPLIED in any real environment) — DYNAMIC rehearsal on the disposable rig.
 * F01 (Director review): the GLOBAL grant of the eight writers to `authenticated` is not an activation;
 * an authorized actor of an organization WITHOUT its own activation marker must be unable to open or
 * change a manual annual need — no marker, a marker of ANOTHER organization, and (positive) a later
 * legitimate marker of its own.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { rigAvailable } from '../../../tools/pg-rig/rig.mjs';
import { ORG, ORG_OTHER, ORG_BENE, ORG_BENE_B, U, read, refusal, helpers, buildWithCandidates, newItem, grantManualKey, type Rig } from './r1a-fixtures';

const run = rigAvailable() ? describe : describe.skip;
const F = ['R1a_01_manual_source_schema_inert.sql', 'R1a_02_authorization_closure.sql', 'R1a_03_lifecycle_relations_and_sod.sql',
  'R1a_04_manual_routines_inert.sql', 'R1a_05_blockers_digest_d27.sql'];
const P = 'public.phoenix_central_needs_';
const NOT_ACTIVATED = 'manual_intake_not_activated';

run('R1-b candidate 01 — manual activation rehearsal (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Rig;
  let item = '';
  let item2 = '';
  let year = 2060;
  const h = helpers(() => rig);
  const { admin, txAs, as } = h;

  const excelRevision = async (org: string, status: string) => {
    year += 1;
    let rev = '';
    await txAs(null, async (q) => {
      const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [org, year]);
      rev = (await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by${status === 'approved' ? ', approved_by, approved_at' : ''})
        VALUES ($1,$2,1,$3,'excel',$4${status === 'approved' ? `,'${U.checker}', now()` : ''}) RETURNING id`, [plan, org, status, U.maker]))[0].id;
    }, { replica: true });
    return rev;
  };

  /** A manual revision with ONE live line, created with triggers off (an org that was never activated cannot create it any other way). */
  const manualRevision = async (org: string, planId: string | null, revNo: number, status: 'draft' | 'approved', withLine: boolean, planYear?: number) => {
    let out = { plan: planId ?? '', rev: '', year: planYear ?? 0 };
    await txAs(null, async (q) => {
      if (!planId) {
        year += 1; out.year = year;
        out.plan = (await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [org, year]))[0].id;
      }
      out.rev = (await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by${status === 'approved' ? ', approved_by, approved_at' : ''})
        VALUES ($1,$2,$3,$4,'manual',$5${status === 'approved' ? `,'${U.checker}', now()` : ''}) RETURNING id`, [out.plan, org, revNo, status, U.maker]))[0].id;
      if (withLine) {
        const line = randomUUID();
        await q(`INSERT INTO central_needs_manual_need_events (organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, event_seq, event_kind,
                   quantity_text, approved_unit, reason, actor_id, actor_role, idempotency_key, need_line_id)
                 VALUES ($1,$2,$3,$4,$5,1,'add','10','box','fixture',$6,'central_warehouse_manager',$7,$8)`, [org, out.plan, out.rev, ORG_BENE, item, U.maker, randomUUID(), line]);
        await q(`INSERT INTO central_needs_need_lines (id, plan_revision_id, organization_id, beneficiary_organization_id, central_item_id, approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
                 VALUES ($1,$2,$3,$4,$5,10,'box','canonical','fixture',$6)`, [line, out.rev, org, ORG_BENE, item, U.maker]);
      }
    }, { replica: true });
    return out;
  };
  const lastEvent = async (rev: string) => (await admin(`SELECT id FROM central_needs_manual_need_events WHERE plan_revision_id=$1 ORDER BY event_seq DESC LIMIT 1`, [rev]))[0]?.id as string;
  const writerCount = async (org: string) => (await admin(`SELECT (SELECT count(*) FROM central_needs_manual_need_events WHERE organization_id=$1)::int e,
      (SELECT count(*) FROM central_needs_manual_coverage_acknowledgements WHERE organization_id=$1)::int a`, [org]))[0];

  beforeAll(async () => {
    rig = await buildWithCandidates(F, 1);
    item = await newItem(admin);
    item2 = await newItem(admin);
    await grantManualKey(rig, [U.maker, U.maker2]);
    await admin(`UPDATE organizations SET organization_kind='pharmacy_department_authority', institution_class=NULL WHERE id=$1`, [ORG_OTHER]).catch(() => undefined);
  }, 600_000);
  afterAll(async () => { await rig?.end(); });

  it('before R1-b the writers are not callable through the authenticated role', async () => {
    const e = await refusal(as(U.maker, `SELECT ${P}open_manual_plan_revision($1, 2097)`, [ORG]));
    expect(e.code).toBe('42501');
    await admin(read('R1b_01_manual_activation_NOT_APPLIED.sql'));
  });

  describe('F01 — an authorized actor of an organization with NO marker cannot enter or change manual needs', () => {
    it('open_manual_plan_revision: refused for an actor who holds edit + manual_need.set, nothing is written', async () => {
      year += 1;
      const before = await admin(`SELECT count(*)::int n FROM central_needs_plan_revisions WHERE organization_id=$1`, [ORG]);
      const e = await refusal(as(U.maker, `SELECT ${P}open_manual_plan_revision($1,$2)`, [ORG, year]));
      expect(e.message).toBe(NOT_ACTIVATED);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_plan_revisions WHERE organization_id=$1`, [ORG]))[0].n).toBe(before[0].n);
      expect((await admin(`SELECT count(*)::int n FROM central_needs_plans WHERE organization_id=$1 AND plan_year=$2`, [ORG, year]))[0].n).toBe(0);
    });

    it('every other entry point is refused on a (fixture) manual revision of the unactivated organization', async () => {
      const a = await manualRevision(ORG, null, 1, 'draft', true);
      const ev = await lastEvent(a.rev);
      // all fixtures first, THEN the baseline: only refused calls may happen after it
      const pred = await manualRevision(ORG, null, 1, 'approved', true);
      const succ = await manualRevision(ORG, pred.plan, 2, 'draft', false);
      const base = await writerCount(ORG);
      const calls: Array<[string, string, unknown[]]> = [
        ['add', `${P}add_manual_need_line($1,$2,$3,NULL,'5','planned need',$4,NULL,NULL)`, [a.rev, ORG_BENE_B, item2, randomUUID()]],
        ['correct', `${P}correct_manual_need_line($1,$2,$3,NULL,'20','recount',$4,$5,NULL)`, [a.rev, ORG_BENE, item, randomUUID(), ev]],
        ['void', `${P}void_manual_need_line($1,$2,$3,NULL,'mistake',$4,$5,NULL)`, [a.rev, ORG_BENE, item, randomUUID(), ev]],
      ];
      for (const [name, sql, args] of calls) {
        expect((await refusal(as(U.maker, `SELECT ${sql}`, args))).message, name).toBe(NOT_ACTIVATED);
      }
      // carry-forward: approved manual predecessor + empty manual draft successor
      expect((await refusal(as(U.maker, `SELECT ${P}carry_forward_manual_lines($1,$2)`, [succ.rev, pred.rev]))).message).toBe(NOT_ACTIVATED);
      // coverage acknowledgement: the successor omits the predecessor's scope
      const [{ d }] = await admin(`SELECT omitted_scope_digest d FROM phoenix_private.central_needs_coverage_digest_v1($1,$2)`, [succ.rev, pred.rev]);
      expect((await refusal(as(U.maker, `SELECT ${P}acknowledge_manual_coverage($1,$2,'item discontinued')`, [succ.rev, d]))).message).toBe(NOT_ACTIVATED);
      // correction opening (a new manual draft after the approved one)
      expect((await refusal(as(U.maker, `SELECT ${P}open_manual_correction_revision($1,$2,$3,'annual update')`, [ORG, pred.year, succ.rev]))).message).toMatch(/central_needs_revision_stale|plan_revision_draft_already_open|manual_intake_not_activated/);
      expect(await writerCount(ORG)).toEqual(base);
    });

    const wdSnapshot = async (rev: string) => (await admin(`SELECT
        (SELECT status FROM central_needs_plan_revisions WHERE id=$1) AS status,
        (SELECT count(*)::int FROM central_needs_revision_withdrawals WHERE plan_revision_id=$1) AS withdrawals,
        (SELECT count(*)::int FROM audit_logs WHERE entity_id=$1 AND action='central_needs.plan_revision.withdraw') AS audits,
        (SELECT count(*)::int FROM central_needs_manual_need_events WHERE plan_revision_id=$1) AS events,
        (SELECT count(*)::int FROM central_needs_need_lines WHERE plan_revision_id=$1) AS lines`, [rev]))[0];

    it('F01A withdraw_draft_revision: an independent approver cannot withdraw a MANUAL draft of an unactivated org; state, records and audit are untouched', async () => {
      const m = await manualRevision(ORG, null, 1, 'draft', true);
      const before = await wdSnapshot(m.rev);
      expect(before).toMatchObject({ status: 'draft', withdrawals: 0, audits: 0, events: 1, lines: 1 });
      const e = await refusal(as(U.checker, `SELECT ${P}withdraw_draft_revision($1,$1,'abandoned by the plan owner',NULL)`, [m.rev]));
      expect(e.message).toBe(NOT_ACTIVATED);
      expect(await wdSnapshot(m.rev)).toEqual(before);
    });

    it('F01A a direct status transition of a manual revision in an unactivated org is refused too (not only the routine path)', async () => {
      const m = await manualRevision(ORG, null, 1, 'draft', false);
      const before = await wdSnapshot(m.rev);
      for (const target of ['withdrawn', 'submitted', 'rejected']) {
        const e = await refusal(txAs(U.checker, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status=$2 WHERE id=$1`, [m.rev, target]); }, { replica: false }));
        // `submitted` is refused FIRST by the older M218 submission gate (it sorts before r1_06); either way the write is refused
        if (target === 'submitted') expect([NOT_ACTIVATED, 'central_needs_submission_gate_missing'], target).toContain(e.message);
        else expect(e.message, target).toBe(NOT_ACTIVATED);
      }
      expect(await wdSnapshot(m.rev)).toEqual(before);
    });

    it('F01A control: withdrawing an EXCEL draft stays possible before the cutover (W0 needs it) and writes exactly one withdrawal + one audit row', async () => {
      const x = await excelRevision(ORG, 'draft');
      const before = await wdSnapshot(x);
      expect(before).toMatchObject({ status: 'draft', withdrawals: 0, audits: 0 });
      const w = (await as(U.checker, `SELECT ${P}withdraw_draft_revision($1,$1,'superseded by the manual cutover',NULL) r`, [x]))[0].r;
      expect(w).toMatchObject({ ok: true, status: 'withdrawn' });
      expect(await wdSnapshot(x)).toMatchObject({ status: 'withdrawn', withdrawals: 1, audits: 1 });
    });

    it('a user who does not hold the manual key is still refused for the authorization reason, not by accident', async () => {
      const e = await refusal(as(U.viewer, `SELECT ${P}open_manual_plan_revision($1, 2096)`, [ORG]));
      expect(e.message).toMatch(/forbidden_central_needs/);
    });

    it('a marker of ANOTHER organization does not open this one', async () => {
      const pending = await excelRevision(ORG_OTHER, 'draft');
      expect((await refusal(admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG_OTHER]))).message).toBe('activation_blocked_pending_excel_revisions');
      await txAs(null, async (q) => { await q(`UPDATE central_needs_plan_revisions SET status='rejected' WHERE id=$1`, [pending]); }, { replica: true });
      const done = (await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) r`, [ORG_OTHER]))[0].r;
      expect(done).toMatchObject({ ok: true, idempotent_replay: false, inventoried_revisions: 1 });
      expect((await admin(`SELECT phoenix_cn_policy.excel_read_restriction_state($1) s`, [ORG_OTHER]))[0].s).toBe('active');
      year += 1;
      expect((await refusal(as(U.maker, `SELECT ${P}open_manual_plan_revision($1,$2)`, [ORG, year]))).message).toBe(NOT_ACTIVATED);
      // ORG_OTHER's own legitimate actor DOES pass (the organization-specific positive control)
      year += 1;
      const ok = (await as(U.other, `SELECT ${P}open_manual_plan_revision($1,$2) r`, [ORG_OTHER, year]).catch((e: Error) => ({ error: e.message })));
      expect(JSON.stringify(ok)).not.toContain(NOT_ACTIVATED);
    });

    it('the guard is fail-closed: a state function that cannot answer "active" never admits the write', async () => {
      // state is computed from the append-only marker table; with the marker table unreadable the guard still resolves
      // to anything-but-active => refusal. Emulate by asking for an organization id that does not exist.
      expect((await admin(`SELECT phoenix_cn_policy.excel_read_restriction_state($1) s`, [randomUUID()]))[0].s).toBe('inactive');
      const e = await refusal(admin(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by)
        SELECT id, organization_id, 9, 'draft', 'manual', $2 FROM central_needs_plans WHERE organization_id=$1 LIMIT 1`, [ORG, U.maker]));
      expect(e.message).toBe(NOT_ACTIVATED);   // even a superuser-session INSERT with triggers on is refused for an unmarked org
    });
  });

  describe('positive: after THIS organization carries its own marker the same actor can work', () => {
    it('ORG is activated by the owner-only routine; the whole manual flow then runs through the authenticated role', async () => {
      const done = (await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) r`, [ORG]))[0].r;
      expect(done).toMatchObject({ ok: true, idempotent_replay: false });
      year += 1;
      const o = (await as(U.maker, `SELECT ${P}open_manual_plan_revision($1,$2) r`, [ORG, year]))[0].r;
      expect(o).toMatchObject({ status: 'draft', source_mode: 'manual' });
      const a = (await as(U.maker, `SELECT ${P}add_manual_need_line($1,$2,$3,NULL,'12.5','planned need',$4,NULL,NULL) r`, [o.plan_revision_id, ORG_BENE, item, randomUUID()]))[0].r;
      expect(a).toMatchObject({ event_seq: 1, quantity_text: '12.5' });
      const c = (await as(U.maker, `SELECT ${P}correct_manual_need_line($1,$2,$3,NULL,'13','recount',$4,$5,NULL) r`, [o.plan_revision_id, ORG_BENE, item, randomUUID(), a.event_id]))[0].r;
      expect(c).toMatchObject({ event_seq: 2, quantity_text: '13' });
      expect((await as(U.maker, `SELECT count(*)::int n FROM ${P}list_manual_need_events($1)`, [o.plan_revision_id]))[0].n).toBe(2);
    });
    it('F01A positive: after the org own marker, an independent approver can withdraw a manual draft (one withdrawal row, one audit row, status withdrawn)', async () => {
      const m = await manualRevision(ORG, null, 1, 'draft', true);
      const w = (await as(U.checker, `SELECT ${P}withdraw_draft_revision($1,$1,'abandoned by the plan owner',NULL) r`, [m.rev]))[0].r;
      expect(w).toMatchObject({ ok: true, status: 'withdrawn' });
      const snap = (await admin(`SELECT (SELECT status FROM central_needs_plan_revisions WHERE id=$1) status,
        (SELECT count(*)::int FROM central_needs_revision_withdrawals WHERE plan_revision_id=$1) wd,
        (SELECT count(*)::int FROM audit_logs WHERE entity_id=$1 AND action='central_needs.plan_revision.withdraw') audits`, [m.rev]))[0];
      expect(snap).toEqual({ status: 'withdrawn', wd: 1, audits: 1 });
    });
    it('an actor without the key remains refused even in an activated organization', async () => {
      year += 1;
      expect((await refusal(as(U.viewer, `SELECT ${P}open_manual_plan_revision($1,$2)`, [ORG, year]))).message).toMatch(/forbidden_central_needs/);
    });
  });


  describe('F01B — activation versus Excel intake, two real sessions', () => {
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const makeOrg = async () => {
      const org = randomUUID(); const user = randomUUID();
      await admin(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES ($1,'R1b conc','س',$2,'pharmacy_department_authority',NULL)`, [org, 'r1b-' + org.slice(0, 8)]);
      await admin(`INSERT INTO auth.users (id, email) VALUES ($1,$2)`, [user, `r1b-${user.slice(0, 8)}@rig`]);
      await admin(`UPDATE profiles SET role='central_warehouse_manager', status='active', organization_id=$2 WHERE id=$1`, [user, org]);
      for (const k of ['view', 'import', 'edit', 'approve']) {
        await admin(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true) ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed=true`, [user, `central_needs.${k}`]);
      }
      return { org, user };
    };
    /** Resolves true once some backend is waiting on an advisory lock while running SQL that matches `like`. */
    const waitingOnAdvisory = async (like: string) => {
      for (let i = 0; i < 40; i += 1) {
        const r = await admin(`SELECT count(*)::int n FROM pg_stat_activity WHERE wait_event_type='Lock' AND wait_event='advisory' AND query ILIKE $1`, [like]);
        if (r[0].n > 0) return true;
        await sleep(100);
      }
      return false;
    };
    /** An Excel intake transaction that inserts a draft revision and then holds its transaction open until released. */
    const heldExcelInsert = (org: string, user: string) => {
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      let inserted!: () => void; const insertedP = new Promise<void>((r) => { inserted = r; });
      const done = rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        try {
          await c.query(`SELECT set_config('request.jwt.claim.sub', $1, true)`, [user]);
          const plan = (await c.query(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,2088) RETURNING id`, [org])).rows[0].id;
          await c.query(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status) VALUES ($1,$2,1,'draft')`, [plan, org]);
          inserted();
          await gate;
          await c.query('COMMIT');
          return { ok: true as const };
        } catch (e) { await c.query('ROLLBACK').catch(() => undefined); inserted(); return { ok: false as const, message: (e as Error).message }; }
      });
      return { release, insertedP, done };
    };
    const state = async (org: string) => (await admin(`SELECT
        (SELECT count(*)::int FROM central_needs_cutover_inventory WHERE organization_id=$1 AND entry_kind='activation_marker') AS markers,
        (SELECT count(*)::int FROM central_needs_plan_revisions WHERE organization_id=$1 AND source_mode='excel' AND status IN ('draft','submitted')) AS pending_excel`, [org]))[0];

    it('A. Excel insert first: activation WAITS for it, then sees the committed draft and refuses - no marker beside a pending Excel draft', async () => {
      const { org, user } = await makeOrg();
      const t1 = heldExcelInsert(org, user);
      await t1.insertedP;
      const t2 = rig.asAdmin((c: any) => c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) AS r`, [org]).then(() => ({ ok: true }), (e: Error) => ({ ok: false, message: e.message })));
      expect(await waitingOnAdvisory('%activate_manual_cutover%')).toBe(true);     // proven blocked on the shared fence, not just slow
      t1.release();
      expect(await t1.done).toEqual({ ok: true });
      expect(await t2).toMatchObject({ ok: false, message: 'activation_blocked_pending_excel_revisions' });
      expect(await state(org)).toEqual({ markers: 0, pending_excel: 1 });
    });

    it('B. Activation first: the Excel insert WAITS for the marker, then reads active and is refused - no Excel draft in an activated org', async () => {
      const { org, user } = await makeOrg();
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      let activated!: () => void; const activatedP = new Promise<void>((r) => { activated = r; });
      const t2 = rig.asAdmin(async (c: any) => {
        await c.query('BEGIN');
        await c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [org]);
        activated();
        await gate;
        await c.query('COMMIT');
      });
      await activatedP;
      const t1 = heldExcelInsert(org, user);
      expect(await waitingOnAdvisory('%central_needs_plan_revisions%')).toBe(true);
      release(); await t2;
      t1.release();
      expect(await t1.done).toMatchObject({ ok: false, message: 'excel_intake_closed_after_activation' });
      expect(await state(org)).toEqual({ markers: 1, pending_excel: 0 });
    });

    it('C. two activations of the same organization serialize: one writes the marker, the other is an idempotent replay', async () => {
      const { org } = await makeOrg();
      const call = () => rig.asAdmin((c: any) => c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) AS r`, [org]).then((r: any) => r.rows[0].r));
      const [a, b] = await Promise.all([call(), call()]);
      expect([a.idempotent_replay, b.idempotent_replay].sort()).toEqual([false, true]);
      expect((await state(org)).markers).toBe(1);
    });

    it('D. activating organization X never blocks Excel intake of organization Y (the fence is per organization)', async () => {
      const x = await makeOrg(); const y = await makeOrg();
      let release!: () => void; const gate = new Promise<void>((r) => { release = r; });
      let activated!: () => void; const activatedP = new Promise<void>((r) => { activated = r; });
      const tx = rig.asAdmin(async (c: any) => { await c.query('BEGIN'); await c.query(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [x.org]); activated(); await gate; await c.query('COMMIT'); });
      await activatedP;
      const ty = heldExcelInsert(y.org, y.user);
      await ty.insertedP; ty.release();
      expect(await ty.done).toEqual({ ok: true });      // not blocked by X's exclusive lock
      release(); await tx;
      expect(await state(y.org)).toEqual({ markers: 0, pending_excel: 1 });
    });

    it('RED proof: with the shared fence removed from the freeze guard the race is real (marker AND pending Excel draft); restoring the guard closes it', async () => {
      const { org, user } = await makeOrg();
      const [{ def }] = await admin(`SELECT pg_get_functiondef('phoenix_private.central_needs_excel_freeze_guard_v1()'::regprocedure) AS def`);
      expect(def).toContain('pg_advisory_xact_lock_shared');
      const unfenced = def.replace(/PERFORM pg_catalog\.pg_advisory_xact_lock_shared\([^;]*;/, '');
      expect(unfenced).not.toContain('pg_advisory_xact_lock_shared');
      await admin(unfenced);
      try {
        const t1 = heldExcelInsert(org, user);
        await t1.insertedP;
        const act = (await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) AS r`, [org]))[0].r;   // does NOT wait
        expect(act).toMatchObject({ ok: true, idempotent_replay: false });
        t1.release();
        expect(await t1.done).toEqual({ ok: true });
        expect(await state(org)).toEqual({ markers: 1, pending_excel: 1 });          // the violation the fence prevents
      } finally {
        await admin(def);                                                              // restore the fixed guard
      }
      const [{ def: after }] = await admin(`SELECT pg_get_functiondef('phoenix_private.central_needs_excel_freeze_guard_v1()'::regprocedure) AS def`);
      expect(after).toBe(def);
    });
  });

  it('anon and service_role never may call; the activation routine is owner-only', async () => {
    for (const role of ['anon', 'service_role']) {
      expect((await refusal(as(null, `SELECT ${P}open_manual_plan_revision($1,2095)`, [ORG], role))).code, role).toBe('42501');
    }
    for (const role of ['anon', 'authenticated', 'service_role']) {
      expect((await refusal(as(U.maker, `SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1)`, [ORG], role))).code, role).toBe('42501');
    }
  });

  it('inventory: one row per revision plus a single marker; replay is idempotent; the marker cannot be removed', async () => {
    const inv = await admin(`SELECT entry_kind FROM central_needs_cutover_inventory WHERE organization_id=$1 ORDER BY entry_kind`, [ORG_OTHER]);
    expect(inv.map((r: any) => r.entry_kind)).toEqual(['activation_marker', 'revision']);
    expect((await admin(`SELECT phoenix_private.central_needs_activate_manual_cutover_v1($1) r`, [ORG_OTHER]))[0].r).toMatchObject({ idempotent_replay: true });
    expect((await refusal(admin(`DELETE FROM central_needs_cutover_inventory WHERE organization_id=$1`, [ORG_OTHER]))).message).toBe('central_needs_append_only_relation');
  });

  it('after the marker: an Excel revision cannot be created for that organization (freeze runs before the authority gate)', async () => {
    const e = await refusal(txAs(null, async (q) => {
      const [{ id: plan }] = await q(`INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,2093) RETURNING id`, [ORG_OTHER]);
      await q(`INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode, created_by) VALUES ($1,$2,1,'draft','excel',$3)`, [plan, ORG_OTHER, U.other]);
    }, { replica: false }));
    expect(e.message).toBe('excel_intake_closed_after_activation');
    const tables = await admin(`SELECT tgrelid::regclass::text t FROM pg_trigger WHERE tgname LIKE '%r1_05_excel_freeze' ORDER BY 1`);
    expect(tables.map((r: any) => r.t)).toEqual(['central_needs_import_batches', 'central_needs_import_sessions', 'central_needs_plan_revisions', 'central_needs_source_files']);
  });

  it('my_capabilities: manual_set follows the key, excel_import_open follows the marker (per organization)', async () => {
    let c1: any; let c2: any;
    await txAs(U.maker, async (q) => {
      c1 = (await q(`SELECT * FROM ${P}my_capabilities($1,NULL)`, [ORG]))[0];
      c2 = (await q(`SELECT * FROM ${P}my_capabilities($1,NULL)`, [ORG_OTHER]))[0];
    });
    expect(c1).toMatchObject({ manual_set: true, excel_import_open: false });   // ORG activated above
    expect(c2).toMatchObject({ manual_set: false, excel_import_open: false });  // maker has no key in ORG_OTHER
  });

  it('Excel SoD stays disabled (Q-E) and the seal is clean', async () => {
    expect((await admin(`SELECT phoenix_cn_policy.excel_sod_enabled() v`))[0].v).toBe(false);
    expect(await admin(`SELECT * FROM phoenix_private.central_needs_capability_breaches_v1()`)).toEqual([]);
  });
});
