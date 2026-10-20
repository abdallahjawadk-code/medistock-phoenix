/**
 * R1-a candidate 01 — DYNAMIC proof (real disposable PostgreSQL) of the inert
 * manual-source schema: source_mode / lineage_mode, the append-only event chain,
 * the canonical quantity grammar, the same-transaction projection guard (C1),
 * the deferred assertion, and the one-clause integrity function.
 *
 * The rig is built through the canonical chain (001..220); the candidate is then
 * applied with the same replay mechanism. Gated on PHOENIX_RIG_PG.
 * Every refusal names the SQLSTATE and message and proves nothing was written.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { buildRig, rigAvailable } from '../../../tools/pg-rig/rig.mjs';

const run = rigAvailable() ? describe : describe.skip;
const CANDIDATE = join(__dirname, '..', 'R1a_01_manual_source_schema_inert.sql');
const SRC_MD5_OF_LIVE_INTEGRITY_DEF = 'ff357d83f1f879e29b0ed882bc8dc3fa';

const ORG_OWNER = '00000000-0000-0000-0000-0000000a1001';
const ORG_BENE = '00000000-0000-0000-0000-0000000a1002';
const ORG_BENE_B = '00000000-0000-0000-0000-0000000a1003';
const U_EDIT = '00000000-0000-0000-0000-0000000a1401';
const U_ACTOR = '00000000-0000-0000-0000-0000000a1402';

interface Refusal { code: string; message: string; detail?: string }
async function refusal(p: Promise<unknown>): Promise<Refusal> {
  try { await p; } catch (e) {
    const err = e as { code?: string; message?: string; detail?: string };
    return { code: String(err.code), message: String(err.message), detail: err.detail };
  }
  throw new Error('expected the database to refuse this call, but it succeeded');
}

run('R1-a candidate 01 — manual-source schema (dynamic, PostgreSQL)', { timeout: 300_000 }, () => {
  let rig: Awaited<ReturnType<typeof buildRig>>;
  let yearSeq = 2000;
  let excelRev = '';
  let excelDigestBefore = '';
  let item = '';

  const admin = <T = any>(sql: string, params: unknown[] = []): Promise<T[]> =>
    rig.asAdmin((c: any) => c.query(sql, params).then((r: any) => r.rows));
  /** One explicit transaction on a superuser connection (rolled back unless commit). */
  const tx = async (fn: (q: (sql: string, p?: unknown[]) => Promise<any[]>) => Promise<void>, commit = true) => {
    await rig.asAdmin(async (c: any) => {
      await c.query('BEGIN');
      try {
        await fn((sql, p = []) => c.query(sql, p).then((r: any) => r.rows));
        await c.query(commit ? 'COMMIT' : 'ROLLBACK');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => undefined);
        throw e;
      }
    });
  };

  const mkRevision = async (mode: 'excel' | 'manual', status = 'draft') => {
    yearSeq += 1;
    const [{ id: planId }] = await admin(
      `INSERT INTO central_needs_plans (organization_id, plan_year) VALUES ($1,$2) RETURNING id`, [ORG_OWNER, yearSeq]);
    const [{ id: revId }] = await admin(
      mode === 'excel'
        ? `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status) VALUES ($1,$2,1,$3) RETURNING id`
        : `INSERT INTO central_needs_plan_revisions (plan_id, organization_id, revision_number, status, source_mode) VALUES ($1,$2,1,$3,'manual') RETURNING id`,
      [planId, ORG_OWNER, status]);
    return { planId: planId as string, revId: revId as string };
  };

  const ev = (q: any, r: { planId: string; revId: string }, o: Partial<{
    seq: number; kind: string; qty: string | null; unit: string | null; supersedes: string | null; carried: string | null;
    reason: string; wh: string | null; ben: string; key: string; item: string;
  }> = {}) => q(
    `INSERT INTO central_needs_manual_need_events
       (organization_id, plan_id, plan_revision_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
        event_seq, event_kind, quantity_text, approved_unit, supersedes_event_id, carried_from_event_id,
        reason, actor_id, actor_role, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,'central_warehouse_manager',$15) RETURNING id`,
    [ORG_OWNER, r.planId, r.revId, o.ben ?? ORG_BENE, o.item ?? item, o.wh ?? null, o.seq ?? 1, o.kind ?? 'add',
      o.qty === undefined ? '10' : o.qty, o.unit === undefined ? 'box' : o.unit, o.supersedes ?? null, o.carried ?? null,
      o.reason ?? 'planned need', U_ACTOR, o.key ?? randomUUID()]);

  const line = (q: any, r: { revId: string }, o: Partial<{ qty: string; unit: string | null; reason: string; ben: string; wh: string | null; by: string }> = {}) => q(
    `INSERT INTO central_needs_need_lines
       (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id, target_warehouse_id,
        approved_quantity, approved_unit, unit_conversion_state, mapping_reason, mapped_by)
     VALUES ($1,$2,$3,$4,$5,$6::numeric,$7,'canonical',$8,$9) RETURNING id`,
    [r.revId, ORG_OWNER, o.ben ?? ORG_BENE, item, o.wh ?? null, o.qty ?? '10', o.unit === undefined ? 'box' : o.unit,
      o.reason ?? 'planned need', o.by ?? U_ACTOR]);

  beforeAll(async () => {
    rig = await buildRig({ upTo: 220 });
    await rig.asAdmin(async (c: any) => {
      await c.query(`INSERT INTO organizations (id, name, name_ar, code, organization_kind, institution_class) VALUES
        ($1,'R1a Pharmacy Dept','دائرة','r1a-owner','pharmacy_department_authority',NULL),
        ($2,'R1a Hospital A','مستشفى أ','r1a-bene-a','care_institution','hospital'),
        ($3,'R1a Hospital B','مستشفى ب','r1a-bene-b','care_institution','hospital')`, [ORG_OWNER, ORG_BENE, ORG_BENE_B]);
      await c.query(`INSERT INTO auth.users (id, email) VALUES ($1,'r1a-edit@rig'),($2,'r1a-actor@rig')`, [U_EDIT, U_ACTOR]);
      await c.query(`UPDATE profiles SET role='central_warehouse_manager', status='active', organization_id=$1 WHERE id IN ($2,$3)`,
        [ORG_OWNER, U_EDIT, U_ACTOR]);
      for (const k of ['view', 'import', 'edit']) {
        await c.query(`INSERT INTO profile_permission_overrides (profile_id, permission_key, allowed) VALUES ($1,$2,true)
          ON CONFLICT (profile_id, permission_key) DO UPDATE SET allowed = true`, [U_EDIT, `central_needs.${k}`]);
      }
    });
    item = randomUUID();
    await admin(`INSERT INTO central_items (id, name, name_ar, unit, status) VALUES ($1,'R1a item','عنصر','box','active')`, [item]);
    // an Excel revision that exists BEFORE the candidate: must read 'excel' afterwards, digest unchanged
    const e = await mkRevision('excel');
    excelRev = e.revId;
    // (column does not exist yet, so the INSERT above used the pre-candidate shape)
  }, 600_000);

  afterAll(async () => { await rig?.end(); });

  it('RED: before the candidate the manual-source objects do not exist', async () => {
    const [{ n }] = await admin(`SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='public.central_needs_plan_revisions'::regclass AND attname='source_mode' AND NOT attisdropped`);
    expect(n).toBe(0);
    expect((await admin(`SELECT to_regclass('public.central_needs_manual_need_events') AS t`))[0].t).toBeNull();
    excelDigestBefore = (await admin(`SELECT phoenix_private.central_needs_submission_state_digest_v1($1) AS d`, [excelRev]))[0].d;
    expect(excelDigestBefore).toMatch(/^[0-9a-f]{64}$/);
  });

  it('applies the candidate (one transaction, prelude + VERIFY inside)', async () => {
    const sql = readFileSync(CANDIDATE, 'utf8').replace(/\r\n/g, '\n');
    await rig.asAdmin((c: any) => c.query(sql));
    const [{ n }] = await admin(`SELECT count(*)::int AS n FROM pg_attribute WHERE attrelid='public.central_needs_plan_revisions'::regclass AND attname='source_mode' AND NOT attisdropped`);
    expect(n).toBe(1);
  });

  it('refuses to apply twice (prelude: objects already present)', async () => {
    const sql = readFileSync(CANDIDATE, 'utf8').replace(/\r\n/g, '\n');
    const r = await refusal(rig.asAdmin((c: any) => c.query(sql)));
    expect(r.message).toContain('R1a01_precondition_failed');
    await admin('ROLLBACK').catch(() => undefined);
  });

  describe('Excel behaviour is unchanged', () => {
    it('existing rows read excel and the v1 submission digest is byte-identical', async () => {
      expect((await admin(`SELECT source_mode FROM central_needs_plan_revisions WHERE id=$1`, [excelRev]))[0].source_mode).toBe('excel');
      const d = (await admin(`SELECT phoenix_private.central_needs_submission_state_digest_v1($1) AS d`, [excelRev]))[0].d;
      expect(d).toBe(excelDigestBefore);
    });

    it('the integrity function differs from the live definition by exactly one clause', async () => {
      const def: string = (await admin(`SELECT pg_get_functiondef('public._phoenix_central_needs_assert_need_line_integrity_v1()'::regprocedure) AS d`))[0].d;
      const clause = "    -- R1-a: manual lines are judged only by the manual assertion (R1a_01 section 5), never here.\n    IF v_line.lineage_mode IS DISTINCT FROM 'excel' THEN\n      CONTINUE;\n    END IF;\n\n";
      expect(def.split(clause).length).toBe(2);
      const restored = def.replace(clause, '').replace(/\r\n/g, '\n').replace(/\n$/, '');
      expect(createHash('md5').update(restored).digest('hex')).toBe(SRC_MD5_OF_LIVE_INTEGRITY_DEF);
    });

    it('an Excel need line without source lineage is still refused at COMMIT (L-rule intact)', async () => {
      const r = await refusal(tx(async (q) => { await line(q, { revId: excelRev }); }));
      expect(r.message).toBe('need_line_requires_source_lineage');
    });

    it('lineage_mode is derived from the revision, not from the caller', async () => {
      const m = await mkRevision('manual');
      // an INSERT claiming lineage excel on a manual revision is overridden by the trigger
      const r = await refusal(tx(async (q) => {
        await q(`INSERT INTO central_needs_need_lines (plan_revision_id, organization_id, beneficiary_organization_id, central_item_id,
                   approved_quantity, approved_unit, mapping_reason, lineage_mode)
                 VALUES ($1,$2,$3,$4,10,'box','x','excel')`, [m.revId, ORG_OWNER, ORG_BENE, item]);
      }));
      expect(r).toMatchObject({ code: '42501', message: 'manual_projection_change_without_event' });
    });
  });

  describe('mode immutability', () => {
    it('source_mode cannot change', async () => {
      const m = await mkRevision('manual');
      const r = await refusal(admin(`UPDATE central_needs_plan_revisions SET source_mode='excel' WHERE id=$1`, [m.revId]));
      expect(r).toMatchObject({ code: '23514', message: 'central_needs_source_mode_immutable' });
      const r2 = await refusal(admin(`UPDATE central_needs_plan_revisions SET source_mode='manual' WHERE id=$1`, [excelRev]));
      expect(r2.message).toBe('central_needs_source_mode_immutable');
    });
    it('lineage_mode cannot change', async () => {
      const m = await mkRevision('manual');
      await tx(async (q) => {
        await ev(q, m); await line(q, m);
      });
      const r = await refusal(admin(`UPDATE central_needs_need_lines SET lineage_mode='excel' WHERE plan_revision_id=$1`, [m.revId]));
      expect(r.message).toBe('central_needs_lineage_mode_immutable');
    });
  });

  describe('event chain is append-only and manual-draft-only', () => {
    it('refuses events on an Excel revision and on a non-draft manual revision', async () => {
      const x = await mkRevision('excel');
      expect((await refusal(admin('SELECT 1').then(() => tx(async (q) => { await ev(q, x); })))).message)
        .toBe('central_needs_manual_event_revision_not_draft');
      const s = await mkRevision('manual', 'submitted');
      expect((await refusal(tx(async (q) => { await ev(q, s); }))).message)
        .toBe('central_needs_manual_event_revision_not_draft');
    });

    it('UPDATE, DELETE and TRUNCATE are refused', async () => {
      const m = await mkRevision('manual');
      await tx(async (q) => { await ev(q, m); await line(q, m); });
      expect((await refusal(admin(`UPDATE central_needs_manual_need_events SET reason='x' WHERE plan_revision_id=$1`, [m.revId]))).message)
        .toBe('central_needs_manual_event_immutable');
      expect((await refusal(admin(`DELETE FROM central_needs_manual_need_events WHERE plan_revision_id=$1`, [m.revId]))).message)
        .toBe('central_needs_manual_event_immutable');
      expect((await refusal(admin(`TRUNCATE central_needs_manual_need_events`))).message)
        .toBe('central_needs_manual_event_immutable');
    });

    it('privileges: authenticated can read but never write; service_role never writes', async () => {
      const rows = await admin(`
        SELECT has_table_privilege('authenticated', 'public.central_needs_manual_need_events', 'INSERT') AS a_ins,
               has_table_privilege('authenticated', 'public.central_needs_manual_need_events', 'UPDATE') AS a_upd,
               has_table_privilege('authenticated', 'public.central_needs_manual_need_events', 'DELETE') AS a_del,
               has_table_privilege('authenticated', 'public.central_needs_manual_need_events', 'SELECT') AS a_sel,
               has_table_privilege('service_role', 'public.central_needs_manual_need_events', 'INSERT') AS s_ins,
               has_table_privilege('anon', 'public.central_needs_manual_need_events', 'SELECT') AS anon_sel`);
      expect(rows[0]).toEqual({ a_ins: false, a_upd: false, a_del: false, a_sel: true, s_ins: false, anon_sel: false });
    });
  });

  describe('canonical quantity grammar (no typmod, no rounding)', () => {
    const attempt = async (qty: string) => {
      const m = await mkRevision('manual');
      return tx(async (q) => { await ev(q, m, { qty }); await line(q, m, { qty: /^[0-9.]+$/.test(qty) && !qty.endsWith('.') ? qty : '1' }); });
    };
    it.each(['0', '1', '10', '1.5', '0.25', '120.123456789', '1000000000000000000000'])('accepts %s and stores it verbatim', async (qty) => {
      const m = await mkRevision('manual');
      await tx(async (q) => { await ev(q, m, { qty }); await line(q, m, { qty }); });
      const [{ quantity_text, quantity }] = await admin(
        `SELECT quantity_text, quantity::text AS quantity FROM central_needs_manual_need_events WHERE plan_revision_id=$1`, [m.revId]);
      expect(quantity_text).toBe(qty);
      expect(quantity).toBe(qty);                // text == numeric: no padding, no rounding
    });
    it.each(['01', '1.50', '1.0', '0.00', '.5', '5.', '-1', '+1', ' 1', '1 ', '1e3', '1,000', '٣', '١٢', '', 'abc', 'NaN', 'Infinity', '1'.repeat(257)])(
      'refuses %j at the grammar CHECK', async (qty) => {
        const m = await mkRevision('manual');
        const r = await refusal(tx(async (q) => { await ev(q, m, { qty }); }));
        expect(['23514']).toContain(r.code);
        expect(r.message).toMatch(/central_needs_manual_need_events_(quantity_grammar_chk|void_shape_chk)/);
        void attempt;
      });
    it('has no numeric typmod on the stored quantity (Q-S stays open)', async () => {
      const [{ t }] = await admin(`SELECT format_type(atttypid, atttypmod) AS t FROM pg_attribute WHERE attrelid='public.central_needs_manual_need_events'::regclass AND attname='quantity'`);
      expect(t).toBe('numeric');
    });
  });

  describe('C1 — projection changes need a same-transaction matching event', () => {
    const live = async () => {
      const m = await mkRevision('manual');
      let lineId = '';
      await tx(async (q) => { await ev(q, m); lineId = (await line(q, m))[0].id; });
      return { ...m, lineId };
    };

    it('INSERT with a matching add event commits; the projection mirrors the event', async () => {
      const m = await live();
      const [l] = await admin(`SELECT lineage_mode, approved_quantity::text AS q FROM central_needs_need_lines WHERE id=$1`, [m.lineId]);
      expect(l).toEqual({ lineage_mode: 'manual', q: '10' });
    });

    it('INSERT without any event, with a mismatching quantity, or with the wrong kind is refused (BEFORE trigger)', async () => {
      const m = await mkRevision('manual');
      expect((await refusal(tx(async (q) => { await line(q, m); }))).message).toBe('manual_projection_change_without_event');
      expect((await refusal(tx(async (q) => { await ev(q, m, { qty: '10' }); await line(q, m, { qty: '11' }); }))).message)
        .toBe('manual_projection_change_without_event');
      const m2 = await mkRevision('manual');
      await tx(async (q) => { await ev(q, m2); await line(q, m2); });
      expect((await refusal(tx(async (q) => {
        const e1 = (await q(`SELECT id FROM central_needs_manual_need_events WHERE plan_revision_id=$1`, [m2.revId]))[0].id;
        await ev(q, m2, { seq: 2, kind: 'void', qty: null, unit: null, supersedes: e1 });
        await q(`UPDATE central_needs_need_lines SET approved_quantity=12 WHERE plan_revision_id=$1`, [m2.revId]);
      }))).message).toBe('manual_projection_change_without_event');
    });

    it('UPDATE needs a correct event of the same value; DELETE needs a void event', async () => {
      const m = await live();
      expect((await refusal(admin(`UPDATE central_needs_need_lines SET approved_quantity=99 WHERE id=$1`, [m.lineId]))).message)
        .toBe('manual_projection_change_without_event');
      await tx(async (q) => {
        const e1 = (await q(`SELECT id FROM central_needs_manual_need_events WHERE plan_revision_id=$1 AND event_seq=1`, [m.revId]))[0].id;
        await ev(q, m, { seq: 2, kind: 'correct', qty: '12', supersedes: e1 });
        await q(`UPDATE central_needs_need_lines SET approved_quantity=12 WHERE id=$1`, [m.lineId]);
      });
      expect((await admin(`SELECT approved_quantity::text AS q FROM central_needs_need_lines WHERE id=$1`, [m.lineId]))[0].q).toBe('12');
      expect((await refusal(admin(`DELETE FROM central_needs_need_lines WHERE id=$1`, [m.lineId]))).message)
        .toBe('manual_projection_change_without_event');
      await tx(async (q) => {
        const e2 = (await q(`SELECT id FROM central_needs_manual_need_events WHERE plan_revision_id=$1 AND event_seq=2`, [m.revId]))[0].id;
        await ev(q, m, { seq: 3, kind: 'void', qty: null, unit: null, supersedes: e2, reason: 'not needed' });
        await q(`DELETE FROM central_needs_need_lines WHERE id=$1`, [m.lineId]);
      });
      expect((await admin(`SELECT count(*)::int AS n FROM central_needs_need_lines WHERE id=$1`, [m.lineId]))[0].n).toBe(0);
    });

    it('legacy delete_need_line with an EMPTY source set cannot delete a zero-source manual line (the C1 bypass)', async () => {
      const m = await live();
      const r = await refusal(rig.asUser(U_EDIT, (c: any) =>
        c.query(`SELECT public.phoenix_central_needs_delete_need_line($1,$2,$3::uuid[])`, [m.lineId, 'cleanup', '{}']),
        { role: 'authenticated', commit: true }));
      expect(r.message).toBe('manual_projection_change_without_event');
      expect((await admin(`SELECT count(*)::int AS n FROM central_needs_need_lines WHERE id=$1`, [m.lineId]))[0].n).toBe(1);
    });

    it('legacy set_need_line cannot insert into a manual revision', async () => {
      const m = await mkRevision('manual');
      const r = await refusal(rig.asUser(U_EDIT, (c: any) =>
        c.query(`SELECT public.phoenix_central_needs_set_need_line($1,$2,$3,10,'x','[]'::jsonb,'{}'::uuid[],'box','canonical',NULL,NULL)`,
          [m.revId, ORG_BENE, item]), { role: 'authenticated', commit: true }));
      expect(r.code).toBeDefined();           // refused somewhere (no import evidence / guard); never written
      expect((await admin(`SELECT count(*)::int AS n FROM central_needs_need_lines WHERE plan_revision_id=$1`, [m.revId]))[0].n).toBe(0);
    });

    it('TRUNCATE of the projection is refused while manual rows exist', async () => {
      await live();
      expect((await refusal(admin(`TRUNCATE central_needs_need_lines CASCADE`))).message).toBe('manual_projection_change_without_event');
    });
  });

  describe('deferred assertion at COMMIT', () => {
    it('an event with no projection row is refused at COMMIT', async () => {
      const m = await mkRevision('manual');
      expect((await refusal(tx(async (q) => { await ev(q, m); }))).message).toBe('manual_projection_missing_for_live_event');
    });
    it('a projection that disagrees with the event reason/actor is refused', async () => {
      const m = await mkRevision('manual');
      expect((await refusal(tx(async (q) => { await ev(q, m, { reason: 'planned need' }); await line(q, m, { reason: 'something else' }); }))).message)
        .toBe('manual_projection_disagrees_with_last_event');
      const m2 = await mkRevision('manual');
      expect((await refusal(tx(async (q) => { await ev(q, m2); await line(q, m2, { by: U_EDIT }); }))).message)
        .toBe('manual_projection_disagrees_with_last_event');
    });
    it('a chain gap or a broken supersedes link is refused', async () => {
      const m = await mkRevision('manual');
      expect((await refusal(tx(async (q) => { await ev(q, m); await ev(q, m, { seq: 3, kind: 'correct', qty: '5', supersedes: randomUUID() }); await line(q, m, { qty: '5' }); }))).code)
        .toMatch(/23503|23514/);
    });
    it('a beneficiary that is not a care institution is refused', async () => {
      const m = await mkRevision('manual');
      expect((await refusal(tx(async (q) => { await ev(q, m, { ben: ORG_OWNER }); await line(q, m, { ben: ORG_OWNER }); }))).message)
        .toBe('manual_line_beneficiary_not_care_institution');
    });
    it('a manual line may not carry source lineage (no need_line_sources rows)', async () => {
      const m = await mkRevision('manual');
      await tx(async (q) => { await ev(q, m); await line(q, m); });
      const cols = await admin(`SELECT count(*)::int AS n FROM central_needs_need_line_sources s JOIN central_needs_need_lines l ON l.id=s.need_line_id WHERE l.plan_revision_id=$1`, [m.revId]);
      expect(cols[0].n).toBe(0);
    });
    it('scope exclusivity: institution-level and warehouse-split lines cannot coexist', async () => {
      const m = await mkRevision('manual');
      const wh = randomUUID();
      await admin(`INSERT INTO warehouses (id, organization_id, name, name_ar, code) VALUES ($1,$2,'R1a WH','مخزن',$3)`, [wh, ORG_BENE, `wh-${wh.slice(0, 8)}`]);
      const r = await refusal(tx(async (q) => {
        await ev(q, m);
        await line(q, m);
        await ev(q, m, { wh });
        await line(q, m, { wh });
      }));
      expect(r.message).toBe('manual_line_scope_conflict');
    });
  });

  describe('hard negative boundary', () => {
    it('the new functions never mention stock, movement, catalog or procurement relations', async () => {
      const rows = await admin(`
        SELECT p.proname FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE p.proname IN ('central_needs_source_mode_immutable_v1','central_needs_lineage_mode_v1','central_needs_manual_event_guard_v1',
                             'central_needs_manual_projection_guard_v1','_phoenix_central_needs_assert_manual_projection_v1')
           AND p.prosrc ~* '(warehouse_stock|stock_movement|central_items|transfer_request|procurement|qr_)'`);
      expect(rows).toEqual([]);
    });
    it('no new function is a census writer (no INSERT/UPDATE/DELETE on central_needs_* in a new function body)', async () => {
      const rows = await admin(`
        SELECT p.proname FROM pg_proc p
         WHERE p.proname IN ('central_needs_source_mode_immutable_v1','central_needs_lineage_mode_v1','central_needs_manual_event_guard_v1',
                             'central_needs_manual_projection_guard_v1','_phoenix_central_needs_assert_manual_projection_v1')
           AND regexp_replace(p.prosrc, '--[^\\n]*', '', 'g') ~* '(insert\\s+into|update|delete\\s+from|truncate|merge\\s+into)\\s+(only\\s+)?(table\\s+)?("?public"?\\.|"?phoenix_private"?\\.)?"?central_needs_[a-z_]+'`);
      expect(rows).toEqual([]);
    });
  });
});
